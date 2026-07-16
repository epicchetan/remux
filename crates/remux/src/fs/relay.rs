//! Server-originated change feed for the files tab, ported from
//! `cli/fsRelay.cjs`. Three detection layers:
//!
//!   1. Non-recursive watcher per served directory (instant, listing-level).
//!   2. A `.git` watcher per known repo root (commits/stages/branch
//!      switches), with a debounced porcelain **confirm** so index churn
//!      without status change stays silent.
//!   3. A git-status poller per repo root while clients are connected — the
//!      only layer that sees worktree edits deep under unloaded directories.
//!
//! Dirty paths are debounced (250ms), then broadcast at most once per 1s
//! with a trailing send. The fs core cache is invalidated before each
//! broadcast so racing non-force reads cannot re-serve stale listings.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::fs::core::DirectoryServedEvent;
use crate::fs::git::is_path_within;
use crate::rpc::router::BoxFuture;

pub const FS_DID_CHANGE_METHOD: &str = "remux/fs/didChange";
pub const DEFAULT_DEBOUNCE_MS: u64 = 250;
pub const DEFAULT_MIN_INTERVAL_MS: u64 = 1_000;
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 2_500;
pub const DEFAULT_MAX_WATCHED_DIRECTORIES: usize = 256;
pub const DEFAULT_WATCH_IDLE_MS: u64 = 10 * 60_000;

#[derive(Debug, Clone, Copy)]
pub struct FsRelayOptions {
    pub debounce_ms: u64,
    pub min_interval_ms: u64,
    pub poll_interval_ms: u64,
    pub max_watched_directories: usize,
    pub watch_idle_ms: u64,
}

impl Default for FsRelayOptions {
    fn default() -> Self {
        Self {
            debounce_ms: DEFAULT_DEBOUNCE_MS,
            min_interval_ms: DEFAULT_MIN_INTERVAL_MS,
            poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
            max_watched_directories: DEFAULT_MAX_WATCHED_DIRECTORIES,
            watch_idle_ms: DEFAULT_WATCH_IDLE_MS,
        }
    }
}

pub trait WatcherHandle: Send {
    fn close(&mut self);
}

pub type EventCallback = Box<dyn Fn(Option<String>) + Send + Sync>;
pub type ErrorCallback = Box<dyn Fn() + Send + Sync>;
pub type WatchPathFn = Box<
    dyn Fn(&Path, EventCallback, ErrorCallback) -> Result<Box<dyn WatcherHandle>, String>
        + Send
        + Sync,
>;
pub type RunGitStatusFn = Arc<dyn Fn(PathBuf) -> BoxFuture<'static, Option<String>> + Send + Sync>;
pub type BroadcastFn = Arc<dyn Fn(Value) + Send + Sync>;
pub type InvalidateFn = Arc<dyn Fn(&[PathBuf], &[PathBuf]) + Send + Sync>;

pub struct FsRelayHooks {
    pub watch_path: WatchPathFn,
    pub run_git_status: RunGitStatusFn,
    pub warn: Arc<dyn Fn(String) + Send + Sync>,
}

struct DirectoryWatcher {
    touched_at: Instant,
    watcher: Box<dyn WatcherHandle>,
}

struct RepoState {
    confirm_scheduled: bool,
    last_status_key: Option<String>,
    watcher: Option<Box<dyn WatcherHandle>>,
}

#[derive(Default)]
struct Wiring {
    broadcast: Option<BroadcastFn>,
    invalidate: Option<InvalidateFn>,
}

struct RelayState {
    directory_watchers: HashMap<PathBuf, DirectoryWatcher>,
    repo_watchers: HashMap<PathBuf, RepoState>,
    pending_changed_paths: BTreeSet<String>,
    pending_git_dirty_roots: BTreeSet<String>,
    wiring: Wiring,
    client_count: usize,
    closed: bool,
    started: bool,
    debounce_scheduled: bool,
    trailing_scheduled: bool,
    last_broadcast_at: Option<Instant>,
    poller_running: bool,
    poll_busy: bool,
}

pub struct FsRelay {
    options: FsRelayOptions,
    hooks: FsRelayHooks,
    state: Mutex<RelayState>,
    runtime: tokio::runtime::Handle,
}

impl FsRelay {
    pub fn new(options: FsRelayOptions, hooks: FsRelayHooks) -> Arc<Self> {
        Arc::new(Self {
            options,
            hooks,
            state: Mutex::new(RelayState {
                directory_watchers: HashMap::new(),
                repo_watchers: HashMap::new(),
                pending_changed_paths: BTreeSet::new(),
                pending_git_dirty_roots: BTreeSet::new(),
                wiring: Wiring::default(),
                client_count: 0,
                closed: false,
                started: false,
                debounce_scheduled: false,
                trailing_scheduled: false,
                last_broadcast_at: None,
                poller_running: false,
                poll_busy: false,
            }),
            runtime: tokio::runtime::Handle::current(),
        })
    }

    /// Production hooks: `notify` non-recursive watchers and real
    /// `git status --porcelain=v1 -z --untracked-files=all` snapshots.
    pub fn production_hooks(warn: Arc<dyn Fn(String) + Send + Sync>) -> FsRelayHooks {
        FsRelayHooks {
            watch_path: Box::new(notify_watch_path),
            run_git_status: Arc::new(|repo_root| {
                Box::pin(async move {
                    let output = tokio::process::Command::new("git")
                        .args(["-C"])
                        .arg(&repo_root)
                        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
                        .output()
                        .await;
                    match output {
                        Ok(output) if output.status.success() => {
                            Some(String::from_utf8_lossy(&output.stdout).into_owned())
                        }
                        _ => None,
                    }
                })
            }),
            warn,
        }
    }

    pub fn start(self: &Arc<Self>, broadcast: BroadcastFn, invalidate: InvalidateFn) {
        let pending = {
            let mut state = self.state.lock().unwrap();
            state.wiring.broadcast = Some(broadcast);
            state.wiring.invalidate = Some(invalidate);
            state.started = true;
            !state.pending_changed_paths.is_empty() || !state.pending_git_dirty_roots.is_empty()
        };
        self.ensure_poller();
        if pending {
            self.mark_dirty(&[], &[]);
        }
    }

    pub fn close(self: &Arc<Self>) {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        state.closed = true;

        for (_, mut entry) in state.directory_watchers.drain() {
            entry.watcher.close();
        }
        for (_, mut repo) in state.repo_watchers.drain() {
            if let Some(watcher) = repo.watcher.as_mut() {
                watcher.close();
            }
        }
        state.pending_changed_paths.clear();
        state.pending_git_dirty_roots.clear();
    }

    pub fn on_client_count_changed(self: &Arc<Self>, count: usize) {
        {
            let mut state = self.state.lock().unwrap();
            state.client_count = count;
        }
        if count > 0 {
            self.ensure_poller();
        }
        // A zero count stops the poller on its next tick.
    }

    pub fn on_directory_served(self: &Arc<Self>, event: &DirectoryServedEvent) {
        if self.state.lock().unwrap().closed {
            return;
        }
        self.register_directory_watcher(&event.path);
        if let Some(repo_root) = &event.repo_root {
            self.register_repo_root(repo_root);
        }
    }

    fn register_directory_watcher(self: &Arc<Self>, directory_path: &Path) {
        {
            let mut state = self.state.lock().unwrap();
            if let Some(existing) = state.directory_watchers.get_mut(directory_path) {
                existing.touched_at = Instant::now();
                return;
            }
            self.evict_directory_watchers(&mut state);
        }

        let event_relay = self.clone();
        let event_path = directory_path.to_path_buf();
        let error_relay = self.clone();
        let error_path = directory_path.to_path_buf();
        let watcher = (self.hooks.watch_path)(
            directory_path,
            Box::new(move |_filename| {
                event_relay.on_directory_event(&event_path);
            }),
            Box::new(move || {
                error_relay.drop_directory_watcher(&error_path);
            }),
        );

        match watcher {
            Ok(watcher) => {
                self.state.lock().unwrap().directory_watchers.insert(
                    directory_path.to_path_buf(),
                    DirectoryWatcher {
                        touched_at: Instant::now(),
                        watcher,
                    },
                );
            }
            Err(error) => {
                (self.hooks.warn)(format!(
                    "[remux] fs relay could not watch {}: {error}",
                    directory_path.display()
                ));
            }
        }
    }

    fn evict_directory_watchers(&self, state: &mut RelayState) {
        if state.directory_watchers.len() < self.options.max_watched_directories {
            return;
        }

        let idle = Duration::from_millis(self.options.watch_idle_ms);
        let now = Instant::now();
        let idle_paths: Vec<PathBuf> = state
            .directory_watchers
            .iter()
            .filter(|(_, entry)| now.duration_since(entry.touched_at) > idle)
            .map(|(path, _)| path.clone())
            .collect();
        for path in idle_paths {
            if let Some(mut entry) = state.directory_watchers.remove(&path) {
                entry.watcher.close();
            }
        }

        while state.directory_watchers.len() >= self.options.max_watched_directories {
            let oldest = state
                .directory_watchers
                .iter()
                .min_by_key(|(_, entry)| entry.touched_at)
                .map(|(path, _)| path.clone());
            let Some(oldest) = oldest else { return };
            if let Some(mut entry) = state.directory_watchers.remove(&oldest) {
                entry.watcher.close();
            }
        }
    }

    fn drop_directory_watcher(self: &Arc<Self>, directory_path: &Path) {
        let entry = self
            .state
            .lock()
            .unwrap()
            .directory_watchers
            .remove(directory_path);
        if let Some(mut entry) = entry {
            entry.watcher.close();
        }
    }

    fn on_directory_event(self: &Arc<Self>, directory_path: &Path) {
        let repo_root = {
            let mut state = self.state.lock().unwrap();
            if let Some(entry) = state.directory_watchers.get_mut(directory_path) {
                entry.touched_at = Instant::now();
            }
            repo_root_for_path(&state, directory_path)
        };

        let changed = vec![directory_path.to_path_buf()];
        let roots: Vec<PathBuf> = repo_root.into_iter().collect();
        self.mark_dirty(&changed, &roots);
    }

    fn register_repo_root(self: &Arc<Self>, repo_root: &Path) {
        {
            let mut state = self.state.lock().unwrap();
            if state.repo_watchers.contains_key(repo_root) {
                return;
            }
            state.repo_watchers.insert(
                repo_root.to_path_buf(),
                RepoState {
                    confirm_scheduled: false,
                    last_status_key: None,
                    watcher: None,
                },
            );
        }

        let git_dir_path = repo_root.join(".git");
        let event_relay = self.clone();
        let event_root = repo_root.to_path_buf();
        let error_relay = self.clone();
        let error_root = repo_root.to_path_buf();
        let watcher = (self.hooks.watch_path)(
            &git_dir_path,
            Box::new(move |filename| {
                if filename.is_none()
                    || filename.as_deref() == Some("HEAD")
                    || filename.as_deref() == Some("index")
                {
                    event_relay.schedule_git_confirm(&event_root);
                }
            }),
            Box::new(move || {
                if let Some(repo) = error_relay
                    .state
                    .lock()
                    .unwrap()
                    .repo_watchers
                    .get_mut(&error_root)
                {
                    repo.watcher = None;
                }
            }),
        );

        match watcher {
            Ok(watcher) => {
                if let Some(repo) = self.state.lock().unwrap().repo_watchers.get_mut(repo_root) {
                    repo.watcher = Some(watcher);
                }
            }
            Err(error) => {
                (self.hooks.warn)(format!(
                    "[remux] fs relay could not watch {}: {error}",
                    git_dir_path.display()
                ));
            }
        }

        // Seed the status baseline at registration so layers 2/3 can diff
        // against the state the client just saw, not against whenever the
        // first poll runs.
        let relay = self.clone();
        let root = repo_root.to_path_buf();
        self.runtime.spawn(async move {
            if relay.state.lock().unwrap().closed {
                return;
            }
            let output = (relay.hooks.run_git_status)(root.clone()).await;
            if let Some(output) = output {
                let mut state = relay.state.lock().unwrap();
                if let Some(repo) = state.repo_watchers.get_mut(&root) {
                    if repo.last_status_key.is_none() {
                        repo.last_status_key = Some(output);
                    }
                }
            }
        });
    }

    /// Layer-2 confirm for a `.git` event: only emit when the porcelain
    /// snapshot actually changed, so index churn without status impact stays
    /// silent.
    fn schedule_git_confirm(self: &Arc<Self>, repo_root: &Path) {
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            let Some(repo) = state.repo_watchers.get_mut(repo_root) else {
                return;
            };
            if repo.confirm_scheduled {
                return;
            }
            repo.confirm_scheduled = true;
        }

        let relay = self.clone();
        let root = repo_root.to_path_buf();
        let debounce = Duration::from_millis(self.options.debounce_ms);
        self.runtime.spawn(async move {
            tokio::time::sleep(debounce).await;
            if let Some(repo) = relay.state.lock().unwrap().repo_watchers.get_mut(&root) {
                repo.confirm_scheduled = false;
            }
            relay.confirm_git_dirty(&root).await;
        });
    }

    async fn confirm_git_dirty(self: &Arc<Self>, repo_root: &Path) {
        {
            let state = self.state.lock().unwrap();
            if state.closed || !state.repo_watchers.contains_key(repo_root) {
                return;
            }
        }

        let Some(output) = (self.hooks.run_git_status)(repo_root.to_path_buf()).await else {
            return;
        };

        let changed = {
            let mut state = self.state.lock().unwrap();
            let Some(repo) = state.repo_watchers.get_mut(repo_root) else {
                return;
            };
            let changed = match &repo.last_status_key {
                None => true,
                Some(last) => last != &output,
            };
            repo.last_status_key = Some(output);
            changed
        };

        if changed {
            self.mark_dirty(&[], &[repo_root.to_path_buf()]);
        }
    }

    fn ensure_poller(self: &Arc<Self>) {
        {
            let mut state = self.state.lock().unwrap();
            if !state.started || state.closed || state.client_count == 0 || state.poller_running {
                return;
            }
            state.poller_running = true;
        }

        let relay = self.clone();
        let interval = Duration::from_millis(self.options.poll_interval_ms);
        self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                {
                    let mut state = relay.state.lock().unwrap();
                    if state.closed || state.client_count == 0 {
                        state.poller_running = false;
                        return;
                    }
                }
                relay.poll_repo_roots().await;
            }
        });
    }

    async fn poll_repo_roots(self: &Arc<Self>) {
        {
            let mut state = self.state.lock().unwrap();
            if state.poll_busy || state.closed {
                return;
            }
            state.poll_busy = true;
        }

        let roots: Vec<PathBuf> = self
            .state
            .lock()
            .unwrap()
            .repo_watchers
            .keys()
            .cloned()
            .collect();

        for repo_root in roots {
            if self.state.lock().unwrap().closed {
                break;
            }
            let Some(output) = (self.hooks.run_git_status)(repo_root.clone()).await else {
                continue;
            };

            let diff = {
                let mut state = self.state.lock().unwrap();
                let Some(repo) = state.repo_watchers.get_mut(&repo_root) else {
                    continue;
                };
                match repo.last_status_key.take() {
                    None => {
                        repo.last_status_key = Some(output);
                        None
                    }
                    Some(last) if last == output => {
                        repo.last_status_key = Some(last);
                        None
                    }
                    Some(last) => {
                        repo.last_status_key = Some(output.clone());
                        Some(changed_status_directories(&repo_root, &last, &output))
                    }
                }
            };

            if let Some(changed_paths) = diff {
                self.mark_dirty(&changed_paths, &[repo_root]);
            }
        }

        self.state.lock().unwrap().poll_busy = false;
    }

    fn mark_dirty(self: &Arc<Self>, changed_paths: &[PathBuf], git_dirty_roots: &[PathBuf]) {
        let schedule = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            for path in changed_paths {
                state
                    .pending_changed_paths
                    .insert(path.to_string_lossy().into_owned());
            }
            for root in git_dirty_roots {
                state
                    .pending_git_dirty_roots
                    .insert(root.to_string_lossy().into_owned());
            }
            if state.pending_changed_paths.is_empty() && state.pending_git_dirty_roots.is_empty() {
                return;
            }
            if state.debounce_scheduled {
                false
            } else {
                state.debounce_scheduled = true;
                true
            }
        };

        if schedule {
            let relay = self.clone();
            let debounce = Duration::from_millis(self.options.debounce_ms);
            self.runtime.spawn(async move {
                tokio::time::sleep(debounce).await;
                relay.state.lock().unwrap().debounce_scheduled = false;
                relay.flush_dirty();
            });
        }
    }

    fn flush_dirty(self: &Arc<Self>) {
        let (changed_paths, git_dirty_roots, broadcast, invalidate) = {
            let mut state = self.state.lock().unwrap();
            if state.closed || state.wiring.broadcast.is_none() {
                return;
            }
            if state.pending_changed_paths.is_empty() && state.pending_git_dirty_roots.is_empty() {
                return;
            }

            let now = Instant::now();
            if let Some(last) = state.last_broadcast_at {
                let min_interval = Duration::from_millis(self.options.min_interval_ms);
                let elapsed = now.duration_since(last);
                if elapsed < min_interval {
                    if !state.trailing_scheduled {
                        state.trailing_scheduled = true;
                        let relay = self.clone();
                        let wait = min_interval - elapsed;
                        self.runtime.spawn(async move {
                            tokio::time::sleep(wait).await;
                            relay.state.lock().unwrap().trailing_scheduled = false;
                            relay.flush_dirty();
                        });
                    }
                    return;
                }
            }

            let changed_paths: Vec<String> = std::mem::take(&mut state.pending_changed_paths)
                .into_iter()
                .collect();
            let git_dirty_roots: Vec<String> = std::mem::take(&mut state.pending_git_dirty_roots)
                .into_iter()
                .collect();
            state.last_broadcast_at = Some(now);
            (
                changed_paths,
                git_dirty_roots,
                state.wiring.broadcast.clone().expect("checked above"),
                state.wiring.invalidate.clone(),
            )
        };

        // Cache invalidation runs before each broadcast — the stale-read
        // race guard (`fsRelay.cjs:341-353`).
        if let Some(invalidate) = invalidate {
            let paths: Vec<PathBuf> = changed_paths.iter().map(PathBuf::from).collect();
            let roots: Vec<PathBuf> = git_dirty_roots.iter().map(PathBuf::from).collect();
            invalidate(&paths, &roots);
        }

        broadcast(serde_json::json!({
            "method": FS_DID_CHANGE_METHOD,
            "params": {
                "changedPaths": changed_paths,
                "gitDirtyRoots": git_dirty_roots,
            },
        }));
    }
}

fn repo_root_for_path(state: &RelayState, target_path: &Path) -> Option<PathBuf> {
    let mut best: Option<PathBuf> = None;
    for repo_root in state.repo_watchers.keys() {
        if is_path_within(repo_root, target_path) {
            let better = best
                .as_ref()
                .map(|current| repo_root.as_os_str().len() > current.as_os_str().len())
                .unwrap_or(true);
            if better {
                best = Some(repo_root.clone());
            }
        }
    }
    best
}

/// Directories whose listings may differ between two porcelain snapshots:
/// the containing directory of every entry that appeared, disappeared, or
/// changed status (rename records contribute both sides).
pub fn changed_status_directories(
    repo_root: &Path,
    before_output: &str,
    after_output: &str,
) -> Vec<PathBuf> {
    let before = parse_porcelain_records(before_output);
    let after = parse_porcelain_records(after_output);
    let mut changed: BTreeSet<PathBuf> = BTreeSet::new();

    for (record, relative_paths) in &before {
        if !after.contains_key(record) {
            add_record_directories(&mut changed, repo_root, relative_paths);
        }
    }
    for (record, relative_paths) in &after {
        if !before.contains_key(record) {
            add_record_directories(&mut changed, repo_root, relative_paths);
        }
    }

    changed.into_iter().collect()
}

fn add_record_directories(
    target: &mut BTreeSet<PathBuf>,
    repo_root: &Path,
    relative_paths: &[String],
) {
    for relative_path in relative_paths {
        let relative_dir = match relative_path.rfind('/') {
            Some(index) => &relative_path[..index],
            None => ".",
        };
        if relative_dir == "." {
            target.insert(repo_root.to_path_buf());
        } else {
            target.insert(repo_root.join(relative_dir));
        }
    }
}

/// Porcelain v1 `-z` records: `XY path` NUL-terminated; rename/copy records
/// are followed by the original path as a bare NUL-terminated token.
pub fn parse_porcelain_records(output: &str) -> HashMap<String, Vec<String>> {
    let tokens: Vec<&str> = output
        .split('\0')
        .filter(|token| !token.is_empty())
        .collect();
    let mut records = HashMap::new();

    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        let chars: Vec<char> = token.chars().collect();
        if chars.len() < 4 || chars[2] != ' ' {
            continue;
        }

        let index_status = chars[0];
        let mut relative_paths = vec![token[3..].to_string()];
        if (index_status == 'R' || index_status == 'C') && index < tokens.len() {
            relative_paths.push(tokens[index].to_string());
            index += 1;
        }

        let key = format!(
            "{token}\0{}",
            relative_paths.get(1).map(String::as_str).unwrap_or("")
        );
        records.insert(key, relative_paths);
    }

    records
}

// ---------------------------------------------------------------------------
// Production watcher backend (notify, non-recursive).
// ---------------------------------------------------------------------------

struct NotifyHandle {
    watcher: Option<notify::RecommendedWatcher>,
}

impl WatcherHandle for NotifyHandle {
    fn close(&mut self) {
        self.watcher = None;
    }
}

fn notify_watch_path(
    target: &Path,
    on_event: EventCallback,
    on_error: ErrorCallback,
) -> Result<Box<dyn WatcherHandle>, String> {
    use notify::Watcher;

    let mut watcher = notify::recommended_watcher(
        move |result: Result<notify::Event, notify::Error>| match result {
            Ok(event) => {
                if event.paths.is_empty() {
                    on_event(None);
                } else {
                    for path in &event.paths {
                        on_event(
                            path.file_name()
                                .map(|name| name.to_string_lossy().into_owned()),
                        );
                    }
                }
            }
            Err(_) => on_error(),
        },
    )
    .map_err(|error| error.to_string())?;

    watcher
        .watch(target, notify::RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;

    Ok(Box::new(NotifyHandle {
        watcher: Some(watcher),
    }))
}
