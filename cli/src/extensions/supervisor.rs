//! L2 extension supervision: one actor task per extension owning the child
//! process and a command mailbox. Replaces `cli/extensionProcess.cjs` and
//! removes the `ctx.fatal` escalation entirely — nothing an extension does
//! can terminate the runtime.
//!
//! State machine (pass-1 spec §L2, `building` added in pass 2):
//!
//! ```text
//! Stopped ──start──▶ [Building ──built──▶] Starting ──spawned──▶ Running
//! Building ──build fails──▶ Failed (lastExit reason build-failed, no crash budget)
//! Running ──stop──▶ Stopping ──reaped──▶ Stopped
//! Running ──exit code 0 (unprompted)──▶ Stopped
//! Running ──crash──▶ BackingOff{n} ──delay──▶ Starting
//! BackingOff: 5 crashes in 60s ──▶ Failed
//! Failed ──manual start──▶ Starting
//! ```
//!
//! Pass-2 L3: children lead their own process groups; kill escalation and
//! the crash-path sweep use group signals so grandchildren die too, and every
//! live group is recorded in the run-state file for the boot orphan sweep.
//!
//! View-build-watch pass: extensions get a supervisor even without a server
//! (view builds run in `start_flow`, which then settles back to `stopped`),
//! and a `watch` sidecar — a supervised long-lived child per watched view —
//! rides a *facet* of the status (`stopped | running | failed`), never the
//! lifecycle state machine above. The facet keeps its own crash counter and
//! backoff; during backoff it stays `running` ("watch is enabled and being
//! kept alive") so the Settings toggle doesn't flap.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use tokio::sync::{mpsc, oneshot};

use crate::extensions::manifest::{BuildSpec, ExtensionManifest, ServerSpec};
use crate::extensions::process::{
    exit_parts, group_alive, harden_command, read_lines, send_sigterm, signal_group,
    spawn_extension, SpawnedChild, StdinCommand,
};
use crate::extensions::runstate::{read_start_ticks, RunEntry, RunRole, RunState};
use crate::logs::{ExtensionLogs, Journal, JournalEvent};
use crate::rpc::jsonrpc::{JsonRpcError, EXTENSION_ERROR};
use crate::rpc::router::{
    BoxFuture, ExtensionServer, LastExit, RpcResult, ServerStatus, ViewsFacet, WatchFacet,
};
use crate::time::now_ms;

pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 300_000;
pub const BACKOFF_BASE_MS: u64 = 500;
pub const BACKOFF_CAP_MS: u64 = 10_000;
pub const CRASH_BUDGET: usize = 5;
pub const CRASH_WINDOW_MS: u64 = 60_000;
pub const STOP_EOF_WAIT_MS: u64 = 2_000;
pub const STOP_TERM_WAIT_MS: u64 = 2_000;
pub const STOP_GROUP_WAIT_MS: u64 = 2_000;
pub const BUILD_TIMEOUT_MS: u64 = 600_000;
pub const BUILD_FAILED_REASON: &str = "build-failed";

pub const DID_CHANGE_STATUS_METHOD: &str = "remux/extensions/didChangeStatus";
const REMUX_NOTIFICATION_METHOD_PREFIX: &str = "remux/notifications/";

/// What the supervisor needs from the runtime: client broadcast, the
/// notification manager's first-refusal hook, and the failed-state alert
/// (system push notification; no-op default keeps test contexts small).
pub trait ExtensionCtx: Send + Sync {
    fn broadcast(&self, message: Value);
    /// Sends a notification to one opaque origin previously attached to an
    /// extension request. The default keeps fixture contexts source-compatible.
    fn send_to_origin(&self, _origin: &str, _message: Value) -> bool {
        false
    }
    fn handle_extension_notification(&self, message: Value) -> BoxFuture<'_, bool>;
    /// Fires once per `failed` entry (crash budget exhausted or build failed).
    fn on_extension_failed(&self, _extension_id: &str, _name: &str, _body: String) {}
}

#[derive(Debug, Clone, Copy)]
pub struct SupervisorConfig {
    pub request_timeout_ms: u64,
    pub backoff_base_ms: u64,
    pub backoff_cap_ms: u64,
    pub crash_budget: usize,
    pub crash_window_ms: u64,
    pub stop_eof_wait_ms: u64,
    pub stop_term_wait_ms: u64,
    pub stop_group_wait_ms: u64,
    pub build_timeout_ms: u64,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            backoff_base_ms: BACKOFF_BASE_MS,
            backoff_cap_ms: BACKOFF_CAP_MS,
            crash_budget: CRASH_BUDGET,
            crash_window_ms: CRASH_WINDOW_MS,
            stop_eof_wait_ms: STOP_EOF_WAIT_MS,
            stop_term_wait_ms: STOP_TERM_WAIT_MS,
            stop_group_wait_ms: STOP_GROUP_WAIT_MS,
            build_timeout_ms: BUILD_TIMEOUT_MS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    Stopped,
    Building,
    Starting,
    Running,
    Stopping,
    BackingOff,
    Failed,
}

impl Lifecycle {
    fn name(self) -> &'static str {
        match self {
            Lifecycle::Stopped => "stopped",
            Lifecycle::Building => "building",
            Lifecycle::Starting => "starting",
            Lifecycle::Running => "running",
            Lifecycle::Stopping => "stopping",
            Lifecycle::BackingOff => "backingOff",
            Lifecycle::Failed => "failed",
        }
    }
}

struct PendingRpc {
    method: String,
    ack: oneshot::Sender<RpcResult>,
}

type PendingMap = Arc<Mutex<HashMap<u64, PendingRpc>>>;

enum Cmd {
    Start {
        rebuild: bool,
        ack: oneshot::Sender<ServerStatus>,
    },
    Stop(oneshot::Sender<ServerStatus>),
    Restart {
        rebuild: bool,
        ack: oneshot::Sender<ServerStatus>,
    },
    WatchStart(oneshot::Sender<Result<(ServerStatus, bool), JsonRpcError>>),
    WatchStop(oneshot::Sender<(ServerStatus, bool)>),
    ServerBuild(oneshot::Sender<Result<ServerStatus, JsonRpcError>>),
    ViewsBuild(oneshot::Sender<Result<ServerStatus, JsonRpcError>>),
    /// Internal: a watch child's monitor task reporting its exit. Stale
    /// generations (bumped by every watch stop) are ignored.
    WatchChildExited {
        generation: u64,
        view_id: String,
        status: Option<std::process::ExitStatus>,
    },
    Rpc {
        method: String,
        params: Option<Value>,
        ack: oneshot::Sender<RpcResult>,
    },
    Notify {
        method: String,
        params: Option<Value>,
    },
}

pub struct ExtensionSupervisor {
    extension_id: String,
    commands: mpsc::UnboundedSender<Cmd>,
    status: Arc<Mutex<ServerStatus>>,
    logs: Arc<ExtensionLogs>,
    /// Entries of views with a declared build — `views.built` is recomputed
    /// by statting these at snapshot time so it is always fresh (a running
    /// watcher rewrites bundles behind the actor's back).
    built_entries: Vec<PathBuf>,
}

impl ExtensionSupervisor {
    /// Spawns the actor task. The returned join handle is wrapped in
    /// `spawn_supervised` by the runtime — the actor dying unexpectedly is a
    /// worker-fatal condition (exit 75).
    pub fn spawn(
        extension: ExtensionManifest,
        cfg: SupervisorConfig,
        ctx: Arc<dyn ExtensionCtx>,
        journal: Arc<Journal>,
        logs: Arc<ExtensionLogs>,
        run_state: Arc<RunState>,
    ) -> (Arc<Self>, tokio::task::JoinHandle<()>) {
        let built_entries: Vec<PathBuf> = extension
            .views
            .iter()
            .filter(|(_, view)| view.build.is_some())
            .map(|(_, view)| view.entry.clone())
            .collect();
        let status = Arc::new(Mutex::new(ServerStatus {
            restartable: true,
            running: false,
            state: Lifecycle::Stopped.name().to_string(),
            pid: None,
            started_at_ms: None,
            restart_count: 0,
            last_exit: None,
            has_build: extension.has_build(),
            has_server: extension.server.is_some(),
            has_server_build: extension
                .server
                .as_ref()
                .map(|server| server.build.is_some())
                .unwrap_or(false),
            views: ViewsFacet {
                declared: built_entries.len() as u32,
                built: views_built(&built_entries),
                last_build_at_ms: None,
            },
            watch: WatchFacet {
                declared: extension
                    .views
                    .iter()
                    .any(|(_, view)| view.watch.is_some()),
                ..WatchFacet::default()
            },
        }));
        let (commands, mailbox) = mpsc::unbounded_channel();

        let supervisor = Arc::new(Self {
            extension_id: extension.id.clone(),
            commands: commands.clone(),
            status: status.clone(),
            logs: logs.clone(),
            built_entries,
        });

        let actor = Actor {
            extension,
            cfg,
            ctx,
            journal,
            logs,
            status,
            run_state,
            self_commands: commands,
            pending: Arc::new(Mutex::new(HashMap::new())),
            generation: Arc::new(AtomicU64::new(0)),
            state: Lifecycle::Stopped,
            child: None,
            stdin: None,
            pid: None,
            pgid: None,
            started_at_ms: None,
            restart_count: 0,
            last_exit: None,
            last_build_failed: false,
            failed_view_builds: HashSet::new(),
            last_view_build_at_ms: None,
            crash_times: VecDeque::new(),
            backoff_deadline: None,
            watch_enabled: false,
            watch_failed: false,
            watch_children: Vec::new(),
            watch_generation: Arc::new(AtomicU64::new(0)),
            watch_started_at_ms: None,
            watch_restart_count: 0,
            watch_crash_times: VecDeque::new(),
            watch_backoff_deadline: None,
            next_rpc_id: 1,
        };
        let handle = tokio::spawn(actor.run(mailbox));

        (supervisor, handle)
    }

    fn snapshot(&self) -> ServerStatus {
        let mut status = self.status.lock().unwrap().clone();
        status.views.built = views_built(&self.built_entries);
        status
    }

    async fn command_status(
        &self,
        make: impl FnOnce(oneshot::Sender<ServerStatus>) -> Cmd,
    ) -> ServerStatus {
        let (ack, response) = oneshot::channel();
        if self.commands.send(make(ack)).is_err() {
            return self.snapshot();
        }
        response.await.unwrap_or_else(|_| self.snapshot())
    }

    async fn command_build(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<ServerStatus, JsonRpcError>>) -> Cmd,
    ) -> Result<ServerStatus, JsonRpcError> {
        let unavailable = || {
            JsonRpcError::new(
                EXTENSION_ERROR,
                format!("extension {} is not running", self.extension_id),
            )
        };
        let (ack, response) = oneshot::channel();
        if self.commands.send(make(ack)).is_err() {
            return Err(unavailable());
        }
        response.await.unwrap_or_else(|_| Err(unavailable()))
    }
}

impl ExtensionServer for ExtensionSupervisor {
    fn start(&self, rebuild: bool) -> BoxFuture<'_, ServerStatus> {
        Box::pin(self.command_status(move |ack| Cmd::Start { rebuild, ack }))
    }

    fn stop(&self) -> BoxFuture<'_, ServerStatus> {
        Box::pin(self.command_status(Cmd::Stop))
    }

    fn restart(&self, rebuild: bool) -> BoxFuture<'_, ServerStatus> {
        Box::pin(self.command_status(move |ack| Cmd::Restart { rebuild, ack }))
    }

    fn watch_start(&self) -> BoxFuture<'_, Result<(ServerStatus, bool), JsonRpcError>> {
        Box::pin(async move {
            let unavailable = || {
                JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("extension {} is not running", self.extension_id),
                )
            };
            let (ack, response) = oneshot::channel();
            if self.commands.send(Cmd::WatchStart(ack)).is_err() {
                return Err(unavailable());
            }
            response.await.unwrap_or_else(|_| Err(unavailable()))
        })
    }

    fn watch_stop(&self) -> BoxFuture<'_, (ServerStatus, bool)> {
        Box::pin(async move {
            let (ack, response) = oneshot::channel();
            if self.commands.send(Cmd::WatchStop(ack)).is_err() {
                return (self.snapshot(), false);
            }
            response.await.unwrap_or_else(|_| (self.snapshot(), false))
        })
    }

    fn build_server(&self) -> BoxFuture<'_, Result<ServerStatus, JsonRpcError>> {
        Box::pin(self.command_build(Cmd::ServerBuild))
    }

    fn build_views(&self) -> BoxFuture<'_, Result<ServerStatus, JsonRpcError>> {
        Box::pin(self.command_build(Cmd::ViewsBuild))
    }

    fn handle_rpc(&self, method: String, params: Option<Value>) -> BoxFuture<'_, RpcResult> {
        Box::pin(async move {
            let (ack, response) = oneshot::channel();
            if self
                .commands
                .send(Cmd::Rpc { method, params, ack })
                .is_err()
            {
                return Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("extension {} is not running", self.extension_id),
                ));
            }
            response.await.unwrap_or_else(|_| {
                Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("extension {} is not running", self.extension_id),
                ))
            })
        })
    }

    fn handle_notification(&self, method: String, params: Option<Value>) {
        let _ = self.commands.send(Cmd::Notify { method, params });
    }

    fn status(&self) -> ServerStatus {
        self.snapshot()
    }

    fn logs(&self, lines: usize) -> Value {
        self.logs.snapshot(&self.extension_id, lines)
    }
}

/// A live watch child: the `Child` itself is owned by its monitor task
/// (which reaps it and reports the exit through the mailbox); the actor
/// keeps only the group handle for signalling.
struct WatchChild {
    pid: u32,
    pgid: u32,
}

struct Actor {
    extension: ExtensionManifest,
    cfg: SupervisorConfig,
    ctx: Arc<dyn ExtensionCtx>,
    journal: Arc<Journal>,
    logs: Arc<ExtensionLogs>,
    status: Arc<Mutex<ServerStatus>>,
    run_state: Arc<RunState>,
    /// Loops back into our own mailbox (watch child exit reports).
    self_commands: mpsc::UnboundedSender<Cmd>,
    pending: PendingMap,
    generation: Arc<AtomicU64>,
    state: Lifecycle,
    child: Option<tokio::process::Child>,
    stdin: Option<mpsc::UnboundedSender<StdinCommand>>,
    pid: Option<u32>,
    pgid: Option<u32>,
    started_at_ms: Option<i64>,
    restart_count: u32,
    last_exit: Option<LastExit>,
    /// Forces the next start to re-run the server build even when a stale
    /// artifact from an earlier successful build still exists.
    last_build_failed: bool,
    /// Per-view analog of `last_build_failed` (view ids).
    failed_view_builds: HashSet<String>,
    last_view_build_at_ms: Option<i64>,
    crash_times: VecDeque<std::time::Instant>,
    backoff_deadline: Option<tokio::time::Instant>,
    // Watch facet — deliberately parallel to (not shared with) the server's
    // crash/backoff bookkeeping: a flapping watcher must not eat the
    // server's crash budget or vice versa.
    watch_enabled: bool,
    watch_failed: bool,
    watch_children: Vec<(String, WatchChild)>,
    watch_generation: Arc<AtomicU64>,
    watch_started_at_ms: Option<i64>,
    watch_restart_count: u32,
    watch_crash_times: VecDeque<std::time::Instant>,
    watch_backoff_deadline: Option<tokio::time::Instant>,
    next_rpc_id: u64,
}

impl Actor {
    async fn run(mut self, mut mailbox: mpsc::UnboundedReceiver<Cmd>) {
        loop {
            let backoff_deadline = self.backoff_deadline;
            let watch_backoff_deadline = self.watch_backoff_deadline;
            tokio::select! {
                command = mailbox.recv() => {
                    match command {
                        Some(command) => self.handle_command(command).await,
                        None => break,
                    }
                }
                status = async { self.child.as_mut().expect("guarded").wait().await },
                    if self.child.is_some() =>
                {
                    self.handle_unprompted_exit(status.ok()).await;
                }
                _ = tokio::time::sleep_until(backoff_deadline.unwrap_or_else(tokio::time::Instant::now)),
                    if backoff_deadline.is_some() =>
                {
                    self.backoff_deadline = None;
                    self.restart_count += 1;
                    self.start_flow(false).await;
                }
                _ = tokio::time::sleep_until(watch_backoff_deadline.unwrap_or_else(tokio::time::Instant::now)),
                    if watch_backoff_deadline.is_some() =>
                {
                    self.watch_backoff_deadline = None;
                    self.watch_restart_count += 1;
                    self.spawn_watch_children();
                }
            }
        }

        // Mailbox closed: runtime shutdown path stops extensions explicitly;
        // kill_on_drop covers anything still alive.
    }

    async fn handle_command(&mut self, command: Cmd) {
        match command {
            Cmd::Start { rebuild, ack } => {
                match self.state {
                    // Idempotent when already up (extensionProcess.cjs:19-23).
                    Lifecycle::Running | Lifecycle::Starting => {}
                    _ => {
                        self.backoff_deadline = None;
                        self.start_flow(rebuild).await;
                    }
                }
                let _ = ack.send(self.current_status());
            }
            Cmd::Stop(ack) => {
                self.journal_lifecycle("extension:stop", None, "info");
                self.stop_child().await;
                let _ = ack.send(self.current_status());
            }
            Cmd::Restart { rebuild, ack } => {
                self.journal_lifecycle("extension:restart", None, "info");
                self.journal_lifecycle("extension:stop", None, "info");
                self.stop_child().await;
                self.start_flow(rebuild).await;
                let _ = ack.send(self.current_status());
            }
            Cmd::WatchStart(ack) => {
                let result = self.handle_watch_start().await;
                let _ = ack.send(result);
            }
            Cmd::WatchStop(ack) => {
                let stopped = self.stop_watchers().await;
                let _ = ack.send((self.current_status(), stopped));
            }
            Cmd::WatchChildExited {
                generation,
                view_id,
                status,
            } => self.handle_watch_child_exited(generation, &view_id, status),
            Cmd::ServerBuild(ack) => {
                let result = self.handle_server_build().await;
                let _ = ack.send(result);
            }
            Cmd::ViewsBuild(ack) => {
                let result = self.handle_views_build().await;
                let _ = ack.send(result);
            }
            Cmd::Rpc { method, params, ack } => self.handle_rpc(method, params, ack),
            Cmd::Notify { method, params } => self.handle_notify(method, params),
        }
    }

    /// Build (when needed) then spawn — or, with no server, settle back to
    /// `stopped` after the view builds (the app renders serverless rows from
    /// the build/watch facets, not a fake `running`). Builds run inline in
    /// the actor, so start/restart RPCs block through `building` like every
    /// other state.
    ///
    /// Sequence: server build first (it gates the spawn, so it fails fastest
    /// where it matters), then view builds in manifest order, then spawn.
    async fn start_flow(&mut self, rebuild: bool) {
        let server = self.extension.server.clone();
        if let Some(server) = &server {
            if let Some(build) = server.build.clone() {
                let artifact = if std::path::Path::new(&server.command).is_absolute() {
                    std::path::PathBuf::from(&server.command)
                } else {
                    server.cwd.join(&server.command)
                };
                let needed = rebuild || self.last_build_failed || !artifact.exists();
                if needed && !self.run_server_build(&build).await {
                    return;
                }
            }
        }
        if !self.run_view_builds().await {
            return;
        }
        match &server {
            Some(server) => self.spawn_child(server),
            None => self.set_state(Lifecycle::Stopped),
        }
    }

    /// Runs the `server.build` phase. Failure lands `failed` with `lastExit`
    /// reason `build-failed` and does NOT consume crash budget — builds are
    /// deterministic; retry is manual.
    async fn run_server_build(&mut self, build: &BuildSpec) -> bool {
        self.set_state(Lifecycle::Building);
        match self.exec_build(build).await {
            Ok(()) => {
                self.last_build_failed = false;
                true
            }
            Err((code, signal, message)) => {
                self.last_build_failed = true;
                self.fail_build(code, signal, &message);
                false
            }
        }
    }

    /// Runs each declared view build (manifest order) that is needed: entry
    /// missing or that view's last build failed. The `rebuild` flag does NOT
    /// reach here — forcing a view build is the manual `views/build` RPC's
    /// job; `rebuild` is scoped to the server binary. Views whose watcher is
    /// enabled are skipped — the watcher owns that dist; racing it produces
    /// torn bundles. Any failure aborts the sequence with the same
    /// `failed`/`build-failed` landing as a server build.
    async fn run_view_builds(&mut self) -> bool {
        for (view_id, view) in self.extension.views.clone() {
            let Some(build) = &view.build else {
                continue;
            };
            if self.watch_enabled && view.watch.is_some() {
                self.append_build_log(&format!(
                    "skipping view {view_id}: watch owns the bundle"
                ));
                continue;
            }
            let needed = self.failed_view_builds.contains(&view_id) || !view.entry.exists();
            if !needed {
                continue;
            }
            self.set_state(Lifecycle::Building);
            match self.exec_build(build).await {
                Ok(()) => {
                    self.failed_view_builds.remove(&view_id);
                    self.last_view_build_at_ms = Some(now_ms());
                }
                Err((code, signal, message)) => {
                    self.failed_view_builds.insert(view_id);
                    self.fail_build(code, signal, &message);
                    return false;
                }
            }
        }
        true
    }

    /// Runs one build job under the shared pgroup/log/run-state plumbing.
    /// Deliberately does NOT touch the lifecycle state — callers decide
    /// whether this build runs under `building` (start flow) or under the
    /// watch facet (gating build), where the server may be `running` the
    /// whole time.
    async fn exec_build(
        &mut self,
        build: &BuildSpec,
    ) -> Result<(), (Option<i32>, Option<String>, String)> {
        self.journal_lifecycle(
            "extension:build",
            Some(serde_json::json!({
                "command": build.command,
                "args": build.args,
                "cwd": build.cwd.to_string_lossy(),
            })),
            "info",
        );
        self.append_build_log(&format!(
            "starting: {} {}",
            build.command,
            build.args.join(" ")
        ));

        let mut command = tokio::process::Command::new(&build.command);
        command
            .args(&build.args)
            .current_dir(&build.cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = match harden_command(&mut command).spawn() {
            Ok(child) => child,
            Err(error) => {
                self.append_build_log(&format!("spawn failed: {error}"));
                return Err((None, None, format!("build spawn failed: {error}")));
            }
        };

        let pid = child.id().unwrap_or_default();
        self.run_state.record(
            &self.extension.id,
            RunRole::Build,
            RunEntry {
                pid,
                pgid: pid,
                start_ticks: read_start_ticks(pid).unwrap_or(0),
                started_at_ms: now_ms(),
            },
        );

        // Stream both pipes into the extension log ring with the [build]
        // prefix — build errors are readable from the phone.
        for stream in [
            child.stdout.take().map(BuildPipe::Stdout),
            child.stderr.take().map(BuildPipe::Stderr),
        ]
        .into_iter()
        .flatten()
        {
            let logs = self.logs.clone();
            let extension_id = self.extension.id.clone();
            tokio::spawn(async move {
                let append = move |line: String| {
                    if !line.trim().is_empty() {
                        logs.append(&extension_id, "build", &format!("[build] {line}"));
                    }
                };
                match stream {
                    BuildPipe::Stdout(pipe) => read_lines(pipe, append).await,
                    BuildPipe::Stderr(pipe) => read_lines(pipe, append).await,
                }
            });
        }

        let timeout = std::time::Duration::from_millis(self.cfg.build_timeout_ms);
        let status = match tokio::time::timeout(timeout, child.wait()).await {
            Ok(status) => status.ok(),
            Err(_) => {
                signal_group(pid, nix::sys::signal::Signal::SIGKILL);
                let _ = child.wait().await;
                self.run_state.remove(&self.extension.id, RunRole::Build);
                self.append_build_log(&format!(
                    "timed out after {}ms",
                    self.cfg.build_timeout_ms
                ));
                return Err((None, None, "build timed out".to_string()));
            }
        };
        self.run_state.remove(&self.extension.id, RunRole::Build);

        let (code, signal) = status.map(exit_parts).unwrap_or((None, None));
        if signal.is_none() && code == Some(0) {
            self.append_build_log("completed");
            self.journal_lifecycle("extension:build-done", None, "info");
            return Ok(());
        }

        self.append_build_log(&format!("failed {}", exit_summary(code, &signal)));
        Err((code, signal, "build failed".to_string()))
    }

    fn fail_build(&mut self, code: Option<i32>, signal: Option<String>, message: &str) {
        self.journal_lifecycle(
            "extension:build-failed",
            Some(serde_json::json!({ "code": code, "signal": signal, "message": message })),
            "error",
        );
        self.last_exit = Some(LastExit {
            code,
            signal,
            at: now_ms(),
            reason: Some(BUILD_FAILED_REASON.to_string()),
        });
        self.set_state(Lifecycle::Failed);
        self.ctx.on_extension_failed(
            &self.extension.id,
            &self.extension.display.title,
            format!("{message} — see extension logs"),
        );
    }

    fn append_build_log(&self, message: &str) {
        self.logs
            .append(&self.extension.id, "build", &format!("[build] {message}"));
    }

    fn append_watch_log(&self, message: &str) {
        self.logs
            .append(&self.extension.id, "watch", &format!("[watch] {message}"));
    }

    /// `watch/start`: gate on a one-shot view build when the entry is
    /// missing (so the first page load never races vite's initial compile),
    /// then spawn one supervised child per watched view. The gating build
    /// runs under the watch *facet*, not the lifecycle `Building` state —
    /// the server may be `running` while it happens and `running: state ==
    /// Running` must stay truthful. It still runs inline in the actor, so
    /// other commands queue behind it (same mailbox semantics as a rebuild).
    async fn handle_watch_start(&mut self) -> Result<(ServerStatus, bool), JsonRpcError> {
        let watched: Vec<(String, crate::extensions::manifest::View)> = self
            .extension
            .views
            .iter()
            .filter(|(_, view)| view.watch.is_some())
            .cloned()
            .collect();
        if watched.is_empty() {
            return Err(JsonRpcError::new(EXTENSION_ERROR, "watch not declared"));
        }
        if self.watch_enabled {
            // Idempotent: already enabled (live or in backoff).
            return Ok((self.current_status(), false));
        }

        for (view_id, view) in &watched {
            let Some(build) = &view.build else {
                continue;
            };
            if view.entry.exists() && !self.failed_view_builds.contains(view_id) {
                continue;
            }
            match self.exec_build(build).await {
                Ok(()) => {
                    self.failed_view_builds.remove(view_id);
                    self.last_view_build_at_ms = Some(now_ms());
                }
                Err((code, signal, message)) => {
                    // Watch-facet failure only: the extension lifecycle (and
                    // a running server) stays untouched.
                    self.failed_view_builds.insert(view_id.clone());
                    self.watch_failed = true;
                    self.journal_lifecycle(
                        "extension:watch-build-failed",
                        Some(serde_json::json!({
                            "code": code,
                            "signal": signal,
                            "message": message,
                            "view": view_id,
                        })),
                        "error",
                    );
                    self.append_watch_log(&format!(
                        "start aborted: initial build of view {view_id} failed"
                    ));
                    self.broadcast_status();
                    return Ok((self.current_status(), false));
                }
            }
        }

        self.watch_enabled = true;
        self.watch_failed = false;
        self.watch_restart_count = 0;
        self.watch_crash_times.clear();
        self.watch_started_at_ms = Some(now_ms());
        self.spawn_watch_children();
        Ok((self.current_status(), true))
    }

    /// Manual server build (`server/build` RPC): the build runs while any
    /// live server keeps serving (cargo swaps the artifact under it — the
    /// running binary's inode persists), then the server restarts into the
    /// new build. Build failure is a plain error: the lifecycle — and a
    /// running server — stays untouched, and there is no push (the user is
    /// looking at the screen). `last_build_failed` still flips so the next
    /// start re-runs the build.
    async fn handle_server_build(&mut self) -> Result<ServerStatus, JsonRpcError> {
        let Some(server) = self.extension.server.clone() else {
            return Err(JsonRpcError::new(
                EXTENSION_ERROR,
                "server build not declared",
            ));
        };
        let Some(build) = server.build.clone() else {
            return Err(JsonRpcError::new(
                EXTENSION_ERROR,
                "server build not declared",
            ));
        };

        match self.exec_build(&build).await {
            Ok(()) => {
                self.last_build_failed = false;
                match self.state {
                    Lifecycle::Running | Lifecycle::Starting => {
                        self.journal_lifecycle("extension:restart", None, "info");
                        self.journal_lifecycle("extension:stop", None, "info");
                        self.stop_child().await;
                        self.spawn_child(&server);
                    }
                    // A successful build resolves an earlier build failure.
                    Lifecycle::Failed => self.set_state(Lifecycle::Stopped),
                    _ => {}
                }
                Ok(self.current_status())
            }
            Err((code, signal, message)) => {
                self.last_build_failed = true;
                self.journal_lifecycle(
                    "extension:build-failed",
                    Some(serde_json::json!({
                        "code": code,
                        "signal": signal,
                        "message": message,
                    })),
                    "error",
                );
                Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!(
                        "server build failed ({}) — see extension logs",
                        exit_summary(code, &signal)
                    ),
                ))
            }
        }
    }

    /// Manual view build (`views/build` RPC): force-runs every declared view
    /// build in manifest order, skipping watch-owned views. Same contract as
    /// `handle_server_build`: failure is an error, never a lifecycle change —
    /// the previously built bundle keeps serving.
    async fn handle_views_build(&mut self) -> Result<ServerStatus, JsonRpcError> {
        let declared: Vec<(String, crate::extensions::manifest::View)> = self
            .extension
            .views
            .iter()
            .filter(|(_, view)| view.build.is_some())
            .cloned()
            .collect();
        if declared.is_empty() {
            return Err(JsonRpcError::new(EXTENSION_ERROR, "view build not declared"));
        }

        for (view_id, view) in declared {
            let build = view.build.as_ref().expect("filtered");
            if self.watch_enabled && view.watch.is_some() {
                self.append_build_log(&format!(
                    "skipping view {view_id}: watch owns the bundle"
                ));
                continue;
            }
            match self.exec_build(build).await {
                Ok(()) => {
                    self.failed_view_builds.remove(&view_id);
                    self.last_view_build_at_ms = Some(now_ms());
                }
                Err((code, signal, message)) => {
                    self.failed_view_builds.insert(view_id.clone());
                    self.journal_lifecycle(
                        "extension:build-failed",
                        Some(serde_json::json!({
                            "code": code,
                            "signal": signal,
                            "message": message,
                            "view": view_id,
                        })),
                        "error",
                    );
                    return Err(JsonRpcError::new(
                        EXTENSION_ERROR,
                        format!(
                            "view build failed ({}) — see extension logs",
                            exit_summary(code, &signal)
                        ),
                    ));
                }
            }
        }

        // A successful build resolves a serverless build-failed landing.
        if self.state == Lifecycle::Failed && self.extension.server.is_none() {
            self.set_state(Lifecycle::Stopped);
        } else {
            self.broadcast_status(); // views.built / lastBuildAtMs changed
        }
        Ok(self.current_status())
    }

    /// Spawns a supervised child for every watched view that doesn't already
    /// have one (backoff restarts respawn only the dead ones). Broadcasts
    /// the status afterwards — every watch transition is a `didChangeStatus`.
    fn spawn_watch_children(&mut self) {
        if !self.watch_enabled {
            return;
        }
        let generation = self.watch_generation.load(Ordering::SeqCst);
        let specs: Vec<(String, BuildSpec)> = self
            .extension
            .views
            .iter()
            .filter(|(view_id, view)| {
                view.watch.is_some()
                    && !self.watch_children.iter().any(|(id, _)| id == view_id)
            })
            .map(|(view_id, view)| (view_id.clone(), view.watch.clone().expect("filtered")))
            .collect();

        for (view_id, spec) in specs {
            self.journal_lifecycle(
                "extension:watch-start",
                Some(serde_json::json!({
                    "view": view_id,
                    "command": spec.command,
                    "args": spec.args,
                    "cwd": spec.cwd.to_string_lossy(),
                })),
                "info",
            );
            self.append_watch_log(&format!(
                "starting: {} {}",
                spec.command,
                spec.args.join(" ")
            ));

            let mut command = tokio::process::Command::new(&spec.command);
            command
                .args(&spec.args)
                .current_dir(&spec.cwd)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            let mut child = match harden_command(&mut command).spawn() {
                Ok(child) => child,
                Err(error) => {
                    self.append_watch_log(&format!("spawn failed: {error}"));
                    self.journal_lifecycle(
                        "extension:watch-error",
                        Some(serde_json::json!({ "message": error.to_string() })),
                        "error",
                    );
                    self.record_watch_crash();
                    continue;
                }
            };

            let pid = child.id().unwrap_or_default();
            self.run_state.record(
                &self.extension.id,
                RunRole::Watch,
                RunEntry {
                    pid,
                    pgid: pid,
                    start_ticks: read_start_ticks(pid).unwrap_or(0),
                    started_at_ms: now_ms(),
                },
            );

            // Both pipes stream into the ring as the `watch` stream; the
            // generation guard mutes readers that outlive a watch stop.
            for stream in [
                child.stdout.take().map(BuildPipe::Stdout),
                child.stderr.take().map(BuildPipe::Stderr),
            ]
            .into_iter()
            .flatten()
            {
                let logs = self.logs.clone();
                let extension_id = self.extension.id.clone();
                let generations = self.watch_generation.clone();
                tokio::spawn(async move {
                    let append = move |line: String| {
                        if line.trim().is_empty() {
                            return;
                        }
                        if generations.load(Ordering::SeqCst) != generation {
                            return;
                        }
                        logs.append(&extension_id, "watch", &format!("[watch] {line}"));
                    };
                    match stream {
                        BuildPipe::Stdout(pipe) => read_lines(pipe, append).await,
                        BuildPipe::Stderr(pipe) => read_lines(pipe, append).await,
                    }
                });
            }

            // The monitor task owns the Child: it reaps the exit and reports
            // it through the mailbox so the actor never blocks on a watcher.
            let sender = self.self_commands.clone();
            let exited_view = view_id.clone();
            tokio::spawn(async move {
                let status = child.wait().await.ok();
                let _ = sender.send(Cmd::WatchChildExited {
                    generation,
                    view_id: exited_view,
                    status,
                });
            });

            self.watch_children.push((view_id, WatchChild { pid, pgid: pid }));
        }
        self.broadcast_status();
    }

    fn handle_watch_child_exited(
        &mut self,
        generation: u64,
        view_id: &str,
        status: Option<std::process::ExitStatus>,
    ) {
        if generation != self.watch_generation.load(Ordering::SeqCst) {
            return; // Stale: this child belonged to a stopped watch session.
        }
        let Some(index) = self.watch_children.iter().position(|(id, _)| id == view_id)
        else {
            return;
        };
        let (_, child) = self.watch_children.remove(index);
        // Crash-path sweep: grandchildren (vite under npm) survive the direct
        // child's death — kill the group before any respawn.
        signal_group(child.pgid, nix::sys::signal::Signal::SIGKILL);
        if self.watch_children.is_empty() {
            self.run_state.remove(&self.extension.id, RunRole::Watch);
        }

        let (code, signal) = status.map(exit_parts).unwrap_or((None, None));
        self.journal_lifecycle(
            "extension:watch-exit",
            Some(serde_json::json!({ "code": code, "signal": signal, "view": view_id })),
            "warn",
        );
        self.append_watch_log(&format!("exited {}", exit_summary(code, &signal)));

        if !self.watch_enabled {
            self.broadcast_status();
            return;
        }
        // A watcher is a keep-alive service: any unprompted exit (clean or
        // not) goes through the crash/backoff path.
        self.record_watch_crash();
    }

    /// Watch analog of `record_crash`, on its own counter. Budget exhaustion
    /// lands the *facet* on `failed` — journal event and broadcast, but no
    /// system push (a dev watcher dying is not an ops page). During backoff
    /// the facet stays `running`: watch is enabled and being kept alive.
    fn record_watch_crash(&mut self) {
        let now = std::time::Instant::now();
        let window = std::time::Duration::from_millis(self.cfg.crash_window_ms);
        self.watch_crash_times.push_back(now);
        while let Some(first) = self.watch_crash_times.front() {
            if now.duration_since(*first) > window {
                self.watch_crash_times.pop_front();
            } else {
                break;
            }
        }

        let crashes = self.watch_crash_times.len();
        if crashes >= self.cfg.crash_budget {
            self.journal_lifecycle(
                "extension:watch-failed",
                Some(serde_json::json!({
                    "crashes": crashes,
                    "windowMs": self.cfg.crash_window_ms,
                })),
                "error",
            );
            self.append_watch_log(&format!(
                "failed: crash budget exceeded ({crashes} crashes)"
            ));
            self.watch_backoff_deadline = None;
            self.watch_crash_times.clear();
            self.watch_enabled = false;
            self.watch_failed = true;
            self.watch_started_at_ms = None;
            self.broadcast_status();
            return;
        }

        let exponent = crashes.saturating_sub(1).min(10) as u32;
        let delay_ms = self
            .cfg
            .backoff_cap_ms
            .min(self.cfg.backoff_base_ms.saturating_mul(1 << exponent));
        self.journal_lifecycle(
            "extension:watch-backoff",
            Some(serde_json::json!({ "crashes": crashes, "delayMs": delay_ms })),
            "warn",
        );
        self.watch_backoff_deadline =
            Some(tokio::time::Instant::now() + std::time::Duration::from_millis(delay_ms));
        self.broadcast_status();
    }

    /// `watch/stop`: EOF is meaningless to vite, so the escalation is
    /// SIGTERM (group) → SIGKILL (group) with a confirmed reap — the server
    /// escalation minus the EOF step. Returns whether anything was stopped.
    async fn stop_watchers(&mut self) -> bool {
        let was_enabled = self.watch_enabled;
        self.watch_backoff_deadline = None;
        self.watch_enabled = false;
        self.watch_failed = false;
        // Invalidate monitor tasks and pipe readers of this session.
        self.watch_generation.fetch_add(1, Ordering::SeqCst);

        let children = std::mem::take(&mut self.watch_children);
        if children.is_empty() {
            self.watch_started_at_ms = None;
            if was_enabled {
                self.journal_lifecycle("extension:watch-stop", None, "info");
                self.append_watch_log("stopped");
            }
            self.broadcast_status();
            return was_enabled;
        }

        self.journal_lifecycle("extension:watch-stop", None, "info");
        for (_, child) in &children {
            signal_group(child.pgid, nix::sys::signal::Signal::SIGTERM);
        }
        let any_alive = |children: &[(String, WatchChild)]| {
            children.iter().any(|(_, child)| group_alive(child.pgid))
        };
        let term_deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis(self.cfg.stop_term_wait_ms);
        while any_alive(&children) && tokio::time::Instant::now() < term_deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        for (_, child) in &children {
            signal_group(child.pgid, nix::sys::signal::Signal::SIGKILL);
        }
        let kill_deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis(self.cfg.stop_group_wait_ms);
        while any_alive(&children) && tokio::time::Instant::now() < kill_deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        if any_alive(&children) {
            self.journal_lifecycle(
                "extension:watch-group-lingering",
                Some(serde_json::json!({
                    "pgids": children.iter().map(|(_, child)| child.pgid).collect::<Vec<_>>(),
                })),
                "warn",
            );
        }
        self.run_state.remove(&self.extension.id, RunRole::Watch);
        self.watch_started_at_ms = None;
        self.append_watch_log("stopped");
        self.broadcast_status();
        true
    }

    fn handle_rpc(&mut self, method: String, params: Option<Value>, ack: oneshot::Sender<RpcResult>) {
        let stdin = match (&self.stdin, self.state) {
            (Some(stdin), Lifecycle::Running) => stdin.clone(),
            _ => {
                let _ = ack.send(Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("extension {} is not running", self.extension.id),
                )));
                return;
            }
        };

        let id = self.next_rpc_id;
        self.next_rpc_id += 1;

        let mut message = Map::new();
        message.insert("jsonrpc".to_string(), Value::from("2.0"));
        message.insert("id".to_string(), Value::from(id));
        message.insert("method".to_string(), Value::from(method.clone()));
        if let Some(params) = params {
            message.insert("params".to_string(), params);
        }

        self.pending
            .lock()
            .unwrap()
            .insert(id, PendingRpc { method: method.clone(), ack });

        // Timeout: reject with the same -32000 "<method> timed out".
        let pending = self.pending.clone();
        let timeout_ms = self.cfg.request_timeout_ms;
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)).await;
            if let Some(entry) = pending.lock().unwrap().remove(&id) {
                let _ = entry.ack.send(Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("{method} timed out"),
                )));
            }
        });

        let line = format!("{}\n", Value::Object(message));
        let _ = stdin.send(StdinCommand::Line(line));
    }

    fn handle_notify(&mut self, method: String, params: Option<Value>) {
        let Some(stdin) = self.stdin.as_ref().filter(|_| self.state == Lifecycle::Running)
        else {
            return;
        };
        let mut message = Map::new();
        message.insert("jsonrpc".to_string(), Value::from("2.0"));
        message.insert("method".to_string(), Value::from(method));
        if let Some(params) = params {
            message.insert("params".to_string(), params);
        }
        let _ = stdin.send(StdinCommand::Line(format!("{}\n", Value::Object(message))));
    }

    fn spawn_child(&mut self, server: &ServerSpec) {
        self.set_state(Lifecycle::Starting);
        self.journal_lifecycle(
            "extension:start",
            Some(serde_json::json!({
                "args": server.args,
                "command": server.command,
                "cwd": server.cwd.to_string_lossy(),
            })),
            "info",
        );
        self.logs
            .append(&self.extension.id, "lifecycle", "starting");

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;

        let journal = self.journal.clone();
        let extension_id = self.extension.id.clone();
        let spawned = spawn_extension(server, move |error| {
            journal.warn(&format!(
                "[remux] failed to write to extension {extension_id}: {error}"
            ));
        });

        match spawned {
            Ok(SpawnedChild {
                child,
                pid,
                pgid,
                stdin,
                stdout,
                stderr,
            }) => {
                self.child = Some(child);
                self.stdin = Some(stdin);
                self.pid = Some(pid);
                self.pgid = Some(pgid);
                self.started_at_ms = Some(now_ms());
                self.run_state.record(
                    &self.extension.id,
                    RunRole::Server,
                    RunEntry {
                        pid,
                        pgid,
                        start_ticks: read_start_ticks(pid).unwrap_or(0),
                        started_at_ms: now_ms(),
                    },
                );
                self.spawn_stdout_reader(stdout, generation);
                self.spawn_stderr_reader(stderr, generation);
                self.set_state(Lifecycle::Running);
            }
            Err(error) => {
                // Spawn failure counts as a crash — BackingOff (or Failed on
                // budget), never runtime-fatal (was: fatal).
                self.journal_lifecycle(
                    "extension:error",
                    Some(serde_json::json!({ "message": error.to_string() })),
                    "error",
                );
                self.logs.append(
                    &self.extension.id,
                    "lifecycle",
                    &format!("spawn failed: {error}"),
                );
                self.record_crash();
            }
        }
    }

    async fn handle_unprompted_exit(&mut self, status: Option<std::process::ExitStatus>) {
        let (code, signal) = status.map(exit_parts).unwrap_or((None, None));
        let clean = signal.is_none() && code.unwrap_or(0) == 0;
        self.journal_lifecycle(
            "extension:exit",
            Some(serde_json::json!({ "code": code, "signal": signal, "stopping": false })),
            if clean { "info" } else { "error" },
        );
        self.logs.append(
            &self.extension.id,
            "lifecycle",
            &format!("exited {}", exit_summary(code, &signal)),
        );

        self.reject_pending(&format!("extension {} exited", self.extension.id));
        self.child = None;
        self.stdin = None;
        self.pid = None;
        // Crash-path sweep: the direct child is reaped, but grandchildren
        // (helpers, PTY shells) survive its death — kill the group before any
        // respawn so instances can never overlap.
        if let Some(pgid) = self.pgid.take() {
            signal_group(pgid, nix::sys::signal::Signal::SIGKILL);
        }
        self.run_state.remove(&self.extension.id, RunRole::Server);
        self.started_at_ms = None;
        self.last_exit = Some(LastExit {
            code,
            signal,
            at: now_ms(),
            reason: None,
        });
        self.generation.fetch_add(1, Ordering::SeqCst);

        if clean {
            // Unprompted clean exit -> Stopped, no restart (spec: behavior
            // change #4 — was a silent not-running).
            self.set_state(Lifecycle::Stopped);
            return;
        }
        self.record_crash();
    }

    fn record_crash(&mut self) {
        let now = std::time::Instant::now();
        let window = std::time::Duration::from_millis(self.cfg.crash_window_ms);
        self.crash_times.push_back(now);
        while let Some(first) = self.crash_times.front() {
            if now.duration_since(*first) > window {
                self.crash_times.pop_front();
            } else {
                break;
            }
        }

        let crashes = self.crash_times.len();
        if crashes >= self.cfg.crash_budget {
            let tail = self.logs.snapshot(&self.extension.id, 10);
            self.journal_lifecycle(
                "extension:failed",
                Some(serde_json::json!({
                    "crashes": crashes,
                    "windowMs": self.cfg.crash_window_ms,
                    "stderrTail": tail,
                })),
                "error",
            );
            self.logs.append(
                &self.extension.id,
                "lifecycle",
                &format!("failed: crash budget exceeded ({crashes} crashes)"),
            );
            self.backoff_deadline = None;
            self.crash_times.clear();
            self.set_state(Lifecycle::Failed);
            let last_stderr = last_stderr_line(&self.logs.snapshot(&self.extension.id, 50))
                .unwrap_or_else(|| format!("{crashes} crashes in 60s"));
            self.ctx.on_extension_failed(
                &self.extension.id,
                &self.extension.display.title,
                format!("{last_stderr} · {} restarts", self.restart_count),
            );
            return;
        }

        let exponent = crashes.saturating_sub(1).min(10) as u32;
        let delay_ms = self
            .cfg
            .backoff_cap_ms
            .min(self.cfg.backoff_base_ms.saturating_mul(1 << exponent));
        self.journal_lifecycle(
            "extension:backoff",
            Some(serde_json::json!({ "crashes": crashes, "delayMs": delay_ms })),
            "warn",
        );
        self.backoff_deadline =
            Some(tokio::time::Instant::now() + std::time::Duration::from_millis(delay_ms));
        self.set_state(Lifecycle::BackingOff);
    }

    /// EOF → SIGTERM (group) → SIGKILL (group) with confirmed reap, then a
    /// group-empty check. Returns only after the direct child is gone, so
    /// restart can never overlap two instances and the reported status is
    /// truthful. Group signals make the escalation reach grandchildren — the
    /// EOF-first step stays because it is the polite path both real servers
    /// honor (and lets them run their own child cleanup).
    async fn stop_child(&mut self) {
        self.backoff_deadline = None;
        self.reject_pending(&format!("extension {} stopped", self.extension.id));

        // Close the stdin channel and drop ChildStdin -> the extension sees
        // EOF.
        if let Some(stdin) = self.stdin.take() {
            let _ = stdin.send(StdinCommand::Close);
        }

        let Some(mut child) = self.child.take() else {
            self.pid = None;
            self.pgid = None;
            self.started_at_ms = None;
            self.set_state(Lifecycle::Stopped);
            return;
        };
        self.set_state(Lifecycle::Stopping);
        self.logs.append(&self.extension.id, "lifecycle", "stopping");

        let eof_wait = std::time::Duration::from_millis(self.cfg.stop_eof_wait_ms);
        let term_wait = std::time::Duration::from_millis(self.cfg.stop_term_wait_ms);

        let status = match tokio::time::timeout(eof_wait, child.wait()).await {
            Ok(status) => status.ok(),
            Err(_) => {
                match (self.pgid, self.pid) {
                    (Some(pgid), _) => signal_group(pgid, nix::sys::signal::Signal::SIGTERM),
                    (None, Some(pid)) => send_sigterm(pid),
                    (None, None) => {}
                }
                match tokio::time::timeout(term_wait, child.wait()).await {
                    Ok(status) => status.ok(),
                    Err(_) => {
                        if let Some(pgid) = self.pgid {
                            signal_group(pgid, nix::sys::signal::Signal::SIGKILL);
                        }
                        let _ = child.start_kill();
                        child.wait().await.ok()
                    }
                }
            }
        };

        // The direct child is reaped; make sure the rest of its group is too.
        // SIGKILL to a drained group is a no-op, so this is safe on the
        // polite path — and it is what makes restart storms leave zero strays.
        if let Some(pgid) = self.pgid {
            signal_group(pgid, nix::sys::signal::Signal::SIGKILL);
            let deadline = tokio::time::Instant::now()
                + std::time::Duration::from_millis(self.cfg.stop_group_wait_ms);
            while group_alive(pgid) && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            if group_alive(pgid) {
                self.journal_lifecycle(
                    "extension:group-lingering",
                    Some(serde_json::json!({ "pgid": pgid })),
                    "warn",
                );
            }
        }
        self.run_state.remove(&self.extension.id, RunRole::Server);

        let (code, signal) = status.map(exit_parts).unwrap_or((None, None));
        self.journal_lifecycle(
            "extension:exit",
            Some(serde_json::json!({ "code": code, "signal": signal, "stopping": true })),
            "info",
        );
        self.logs.append(
            &self.extension.id,
            "lifecycle",
            &format!("stopped {}", exit_summary(code, &signal)),
        );
        self.last_exit = Some(LastExit {
            code,
            signal,
            at: now_ms(),
            reason: None,
        });
        self.pid = None;
        self.pgid = None;
        self.started_at_ms = None;
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.set_state(Lifecycle::Stopped);
    }

    fn spawn_stdout_reader(&self, stdout: tokio::process::ChildStdout, generation: u64) {
        let pending = self.pending.clone();
        let generations = self.generation.clone();
        let ctx = self.ctx.clone();
        let journal = self.journal.clone();
        let extension_id = self.extension.id.clone();

        tokio::spawn(async move {
            let (line_tx, mut line_rx) = mpsc::unbounded_channel::<String>();
            let reader = tokio::spawn(async move {
                read_lines(stdout, move |line| {
                    let _ = line_tx.send(line);
                })
                .await;
            });

            while let Some(line) = line_rx.recv().await {
                if generations.load(Ordering::SeqCst) != generation {
                    break;
                }
                handle_protocol_line(&line, &extension_id, &pending, &ctx, &journal).await;
            }
            let _ = reader.await;
        });
    }

    fn spawn_stderr_reader(&self, stderr: tokio::process::ChildStderr, generation: u64) {
        let logs = self.logs.clone();
        let generations = self.generation.clone();
        let extension_id = self.extension.id.clone();

        tokio::spawn(async move {
            read_lines(stderr, move |line| {
                if line.trim().is_empty() {
                    return;
                }
                if generations.load(Ordering::SeqCst) != generation {
                    return;
                }
                logs.append(&extension_id, "stderr", &line);
            })
            .await;
        });
    }

    fn reject_pending(&self, message: &str) {
        let entries: Vec<PendingRpc> = {
            let mut pending = self.pending.lock().unwrap();
            pending.drain().map(|(_, entry)| entry).collect()
        };
        for entry in entries {
            let _ = entry
                .ack
                .send(Err(JsonRpcError::new(EXTENSION_ERROR, message)));
        }
    }

    fn current_status(&self) -> ServerStatus {
        let built_entries: Vec<PathBuf> = self
            .extension
            .views
            .iter()
            .filter(|(_, view)| view.build.is_some())
            .map(|(_, view)| view.entry.clone())
            .collect();
        ServerStatus {
            restartable: true,
            running: self.state == Lifecycle::Running,
            state: self.state.name().to_string(),
            pid: self.pid,
            started_at_ms: self.started_at_ms,
            restart_count: self.restart_count,
            last_exit: self.last_exit.clone(),
            has_build: self.extension.has_build(),
            has_server: self.extension.server.is_some(),
            has_server_build: self
                .extension
                .server
                .as_ref()
                .map(|server| server.build.is_some())
                .unwrap_or(false),
            views: ViewsFacet {
                declared: built_entries.len() as u32,
                built: views_built(&built_entries),
                last_build_at_ms: self.last_view_build_at_ms,
            },
            watch: WatchFacet {
                declared: self
                    .extension
                    .views
                    .iter()
                    .any(|(_, view)| view.watch.is_some()),
                state: if self.watch_failed {
                    "failed"
                } else if self.watch_enabled {
                    "running"
                } else {
                    "stopped"
                }
                .to_string(),
                pid: self.watch_children.first().map(|(_, child)| child.pid),
                started_at_ms: self.watch_started_at_ms,
                restart_count: self.watch_restart_count,
            },
        }
    }

    fn set_state(&mut self, state: Lifecycle) {
        self.state = state;
        self.broadcast_status();
    }

    /// Publishes the current status to the shared snapshot and as a
    /// `didChangeStatus` broadcast. Watch-facet transitions call this
    /// directly — they change the status without a lifecycle transition.
    fn broadcast_status(&self) {
        let status = self.current_status();
        *self.status.lock().unwrap() = status.clone();

        let mut params = Map::new();
        params.insert(
            "extensionId".to_string(),
            Value::from(self.extension.id.clone()),
        );
        status.append_to(&mut params);
        self.ctx.broadcast(serde_json::json!({
            "method": DID_CHANGE_STATUS_METHOD,
            "params": params,
        }));
    }

    fn journal_lifecycle(&self, label: &str, detail: Option<Value>, level: &'static str) {
        self.journal.event(JournalEvent {
            detail,
            label: Some(label.to_string()),
            level,
            source: format!("extension:{}", self.extension.id),
            ..Default::default()
        });
    }
}

enum BuildPipe {
    Stdout(tokio::process::ChildStdout),
    Stderr(tokio::process::ChildStderr),
}

/// True when every declared view entry exists (fresh stat). False with no
/// declared entries — the facet is `null`-equivalent at `declared: 0`.
fn views_built(entries: &[PathBuf]) -> bool {
    !entries.is_empty() && entries.iter().all(|entry| entry.exists())
}

/// Exit status for user-facing log lines: `code=0`, `signal=SIGKILL`, or
/// `status unknown` (never the raw `Option` debug form).
fn exit_summary(code: Option<i32>, signal: &Option<String>) -> String {
    match (signal, code) {
        (Some(signal), _) => format!("signal={signal}"),
        (None, Some(code)) => format!("code={code}"),
        (None, None) => "status unknown".to_string(),
    }
}

/// Last stderr line from an `ExtensionLogs::snapshot` array — the push
/// notification body for failed extensions.
fn last_stderr_line(snapshot: &Value) -> Option<String> {
    snapshot
        .as_array()?
        .iter()
        .rev()
        .find(|entry| entry.get("stream").and_then(Value::as_str) == Some("stderr"))
        .and_then(|entry| entry.get("line").and_then(Value::as_str))
        .map(str::to_string)
}

async fn handle_protocol_line(
    line: &str,
    extension_id: &str,
    pending: &PendingMap,
    ctx: &Arc<dyn ExtensionCtx>,
    journal: &Arc<Journal>,
) {
    if line.trim().is_empty() {
        return;
    }

    let message: Value = match serde_json::from_str(line) {
        Ok(message) => message,
        Err(_) => {
            journal.warn(&format!(
                "[remux] ignored invalid protocol line from extension {extension_id}"
            ));
            return;
        }
    };

    if is_extension_response(&message) {
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return;
        };
        let Some(entry) = pending.lock().unwrap().remove(&id) else {
            return;
        };
        match message.get("error") {
            Some(error) if !error.is_null() => {
                let _ = entry.ack.send(Err(error_from_response(error, &entry.method)));
            }
            _ => {
                let _ = entry
                    .ack
                    .send(Ok(message.get("result").cloned().unwrap_or(Value::Null)));
            }
        }
        return;
    }

    if message.get("method").and_then(Value::as_str).is_some() {
        let (target_origin, message) = take_extension_target(message);
        let normalized = normalize_extension_notification(message, extension_id);
        if let Some(origin) = target_origin {
            let _ = ctx.send_to_origin(&origin, normalized);
            return;
        }
        let method = normalized
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if method.starts_with(REMUX_NOTIFICATION_METHOD_PREFIX) {
            // Offer to the notification manager first; broadcast only when
            // unhandled.
            let handled = ctx.handle_extension_notification(normalized.clone()).await;
            if !handled {
                ctx.broadcast(normalized);
            }
            return;
        }
        ctx.broadcast(normalized);
    }
}

fn take_extension_target(message: Value) -> (Option<String>, Value) {
    match message {
        Value::Object(mut record) => {
            let origin = record.remove("remuxTarget").and_then(|target| {
                target
                    .get("origin")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            (origin, Value::Object(record))
        }
        other => (None, other),
    }
}

fn is_extension_response(message: &Value) -> bool {
    let Some(record) = message.as_object() else {
        return false;
    };
    let id_ok = record
        .get("id")
        .map(|id| id.is_string() || id.is_number())
        .unwrap_or(false);
    id_ok
        && !record.get("method").map(Value::is_string).unwrap_or(false)
        && (record.contains_key("result") || record.contains_key("error"))
}

fn error_from_response(error: &Value, method: &str) -> JsonRpcError {
    let code = error.get("code").and_then(Value::as_i64).unwrap_or(EXTENSION_ERROR);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Unknown JSON-RPC error");
    JsonRpcError {
        code,
        message: format!("{method} failed: {message}"),
        data: error.get("data").cloned(),
    }
}

/// `remux/notifications/*` methods get `extensionId` injected into params
/// (`normalizeExtensionNotification`, `extensionProcess.cjs:266-278`).
pub fn normalize_extension_notification(message: Value, extension_id: &str) -> Value {
    let method_is_notification = message
        .get("method")
        .and_then(Value::as_str)
        .map(|method| method.starts_with(REMUX_NOTIFICATION_METHOD_PREFIX))
        .unwrap_or(false);
    if !method_is_notification {
        return message;
    }

    match message {
        Value::Object(mut record) => {
            let mut params = match record.remove("params") {
                Some(Value::Object(params)) => params,
                _ => Map::new(),
            };
            params.insert("extensionId".to_string(), Value::from(extension_id));
            record.insert("params".to_string(), Value::Object(params));
            Value::Object(record)
        }
        other => other,
    }
}
