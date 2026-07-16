//! Integration port of `cli/tests/fs-relay.test.js`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use remux::fs::core::DirectoryServedEvent;
use remux::fs::relay::{
    EventCallback, FsRelay, FsRelayHooks, FsRelayOptions, WatchPathFn, WatcherHandle,
    FS_DID_CHANGE_METHOD,
};

struct MockWatcher {
    closed: Arc<AtomicBool>,
}

impl WatcherHandle for MockWatcher {
    fn close(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

struct RegistryEntry {
    closed: Arc<AtomicBool>,
    on_event: EventCallback,
}

#[derive(Default)]
struct WatchRegistry {
    watchers: Mutex<HashMap<PathBuf, Arc<RegistryEntry>>>,
}

impl WatchRegistry {
    fn watch_path_fn(self: &Arc<Self>) -> WatchPathFn {
        let registry = self.clone();
        Box::new(move |target, on_event, _on_error| {
            let closed = Arc::new(AtomicBool::new(false));
            registry.watchers.lock().unwrap().insert(
                target.to_path_buf(),
                Arc::new(RegistryEntry {
                    closed: closed.clone(),
                    on_event,
                }),
            );
            Ok(Box::new(MockWatcher { closed }) as Box<dyn WatcherHandle>)
        })
    }

    fn emit(&self, target: &str, filename: Option<&str>) {
        let entry = self
            .watchers
            .lock()
            .unwrap()
            .get(Path::new(target))
            .cloned();
        if let Some(entry) = entry {
            if !entry.closed.load(Ordering::SeqCst) {
                (entry.on_event)(filename.map(str::to_string));
            }
        }
    }

    fn is_closed(&self, target: &str) -> bool {
        self.watchers
            .lock()
            .unwrap()
            .get(Path::new(target))
            .map(|entry| entry.closed.load(Ordering::SeqCst))
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, PartialEq)]
enum TestEvent {
    Status,
    Invalidate {
        paths: Vec<String>,
        under_roots: Vec<String>,
    },
    Broadcast(Value),
}

struct Harness {
    relay: Arc<FsRelay>,
    registry: Arc<WatchRegistry>,
    events: Arc<Mutex<Vec<TestEvent>>>,
    status_calls: Arc<AtomicUsize>,
}

impl Harness {
    fn broadcasts(&self) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                TestEvent::Broadcast(message) => Some(message.clone()),
                _ => None,
            })
            .collect()
    }

    fn served(&self, path: &str, repo_root: Option<&str>) {
        self.relay.on_directory_served(&DirectoryServedEvent {
            path: PathBuf::from(path),
            repo_root: repo_root.map(PathBuf::from),
        });
    }
}

fn harness_with(options: FsRelayOptions, status_outputs: Vec<&'static str>) -> Harness {
    let registry = Arc::new(WatchRegistry::default());
    let events = Arc::new(Mutex::new(Vec::new()));
    let status_calls = Arc::new(AtomicUsize::new(0));

    let status_events = events.clone();
    let status_counter = status_calls.clone();
    let hooks = FsRelayHooks {
        watch_path: registry.watch_path_fn(),
        run_git_status: Arc::new(move |_repo_root| {
            let call = status_counter.fetch_add(1, Ordering::SeqCst);
            status_events.lock().unwrap().push(TestEvent::Status);
            let output = status_outputs
                .get(call.min(status_outputs.len().saturating_sub(1)))
                .copied()
                .unwrap_or("");
            Box::pin(async move { Some(output.to_string()) })
        }),
        warn: Arc::new(|_message| {}),
    };

    let relay = FsRelay::new(options, hooks);

    let broadcast_events = events.clone();
    let invalidate_events = events.clone();
    relay.start(
        Arc::new(move |message| {
            broadcast_events
                .lock()
                .unwrap()
                .push(TestEvent::Broadcast(message));
        }),
        Arc::new(move |paths, under_roots| {
            invalidate_events
                .lock()
                .unwrap()
                .push(TestEvent::Invalidate {
                    paths: paths
                        .iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect(),
                    under_roots: under_roots
                        .iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect(),
                });
        }),
    );

    Harness {
        relay,
        registry,
        events,
        status_calls,
    }
}

fn fast_options() -> FsRelayOptions {
    FsRelayOptions {
        debounce_ms: 1,
        min_interval_ms: 1,
        poll_interval_ms: 10_000,
        ..Default::default()
    }
}

async fn delay(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

#[tokio::test]
async fn broadcasts_served_directory_events_with_repo_rollup_and_invalidates_first() {
    let harness = harness_with(fast_options(), vec![""]);
    harness.served("/repo/src", Some("/repo"));

    harness.registry.emit("/repo/src", None);
    delay(50).await;

    let broadcasts = harness.broadcasts();
    assert_eq!(broadcasts.len(), 1);
    assert_eq!(broadcasts[0]["method"], FS_DID_CHANGE_METHOD);
    assert_eq!(
        broadcasts[0]["params"],
        json!({ "changedPaths": ["/repo/src"], "gitDirtyRoots": ["/repo"] })
    );

    let events = harness.events.lock().unwrap().clone();
    let invalidate_index = events
        .iter()
        .position(|event| matches!(event, TestEvent::Invalidate { .. }))
        .expect("invalidate happened");
    let broadcast_index = events
        .iter()
        .position(|event| matches!(event, TestEvent::Broadcast(_)))
        .expect("broadcast happened");
    assert!(
        invalidate_index < broadcast_index,
        "invalidate must precede broadcast"
    );
    assert_eq!(
        events[invalidate_index],
        TestEvent::Invalidate {
            paths: vec!["/repo/src".to_string()],
            under_roots: vec!["/repo".to_string()],
        }
    );

    harness.relay.close();
}

#[tokio::test]
async fn throttles_broadcasts_with_a_merged_trailing_send() {
    let harness = harness_with(
        FsRelayOptions {
            min_interval_ms: 200,
            ..fast_options()
        },
        vec![""],
    );
    harness.served("/repo/a", None);
    harness.served("/repo/b", None);

    harness.registry.emit("/repo/a", None);
    delay(60).await;
    assert_eq!(harness.broadcasts().len(), 1);

    harness.registry.emit("/repo/a", None);
    harness.registry.emit("/repo/b", None);
    delay(60).await;
    assert_eq!(harness.broadcasts().len(), 1, "second burst is throttled");

    delay(250).await;
    let broadcasts = harness.broadcasts();
    assert_eq!(
        broadcasts.len(),
        2,
        "trailing send fires after the interval"
    );
    assert_eq!(
        broadcasts[1]["params"]["changedPaths"],
        json!(["/repo/a", "/repo/b"])
    );

    harness.relay.close();
}

#[tokio::test]
async fn evicts_the_least_recently_touched_directory_watcher_over_the_cap() {
    let harness = harness_with(
        FsRelayOptions {
            max_watched_directories: 2,
            ..fast_options()
        },
        vec![""],
    );
    harness.served("/d1", None);
    delay(5).await;
    harness.served("/d2", None);
    delay(5).await;
    harness.served("/d3", None);

    assert!(harness.registry.is_closed("/d1"), "oldest watcher evicted");
    assert!(!harness.registry.is_closed("/d2"));
    assert!(!harness.registry.is_closed("/d3"));

    harness.relay.close();
}

#[tokio::test]
async fn maps_git_head_index_events_to_git_dirty_roots_only_after_a_status_confirm() {
    let harness = harness_with(fast_options(), vec![" M src/a.ts\0", ""]);
    harness.served("/repo", Some("/repo"));
    delay(30).await;
    assert_eq!(
        harness.status_calls.load(Ordering::SeqCst),
        1,
        "baseline is seeded at registration"
    );

    harness.registry.emit("/repo/.git", Some("index.lock"));
    delay(50).await;
    assert_eq!(harness.broadcasts().len(), 0, "index.lock churn is ignored");

    harness.registry.emit("/repo/.git", Some("HEAD"));
    delay(50).await;

    let broadcasts = harness.broadcasts();
    assert_eq!(broadcasts.len(), 1);
    assert_eq!(
        broadcasts[0]["params"],
        json!({ "changedPaths": [], "gitDirtyRoots": ["/repo"] })
    );

    harness.relay.close();
}

#[tokio::test]
async fn git_confirm_stays_silent_when_the_status_snapshot_is_unchanged() {
    let harness = harness_with(fast_options(), vec![" M src/a.ts\0"]);
    harness.served("/repo", Some("/repo"));
    delay(30).await;

    harness.registry.emit("/repo/.git", Some("HEAD"));
    delay(50).await;
    assert_eq!(
        harness.broadcasts().len(),
        0,
        "snapshot matches the seeded baseline"
    );

    harness.registry.emit("/repo/.git", Some("HEAD"));
    delay(50).await;
    assert_eq!(
        harness.broadcasts().len(),
        0,
        "unchanged snapshot never emits"
    );

    harness.relay.close();
}

#[tokio::test]
async fn poller_is_gated_on_clients_and_diffs_snapshots_into_changed_directories() {
    let harness = harness_with(
        FsRelayOptions {
            poll_interval_ms: 20,
            ..fast_options()
        },
        vec!["?? src/new.ts\0", "?? src/new.ts\0 M lib/util.js\0"],
    );
    harness.served("/repo", Some("/repo"));

    delay(100).await;
    assert_eq!(
        harness.status_calls.load(Ordering::SeqCst),
        1,
        "only the baseline seed runs with zero clients"
    );

    harness.relay.on_client_count_changed(1);
    delay(150).await;

    let broadcasts = harness.broadcasts();
    assert!(
        harness.status_calls.load(Ordering::SeqCst) >= 2,
        "poller runs while a client is connected"
    );
    assert_eq!(
        broadcasts.len(),
        1,
        "only the diff against the seeded baseline emits"
    );
    assert_eq!(
        broadcasts[0]["params"],
        json!({ "changedPaths": ["/repo/lib"], "gitDirtyRoots": ["/repo"] })
    );

    harness.relay.close();
}

#[tokio::test]
async fn close_is_idempotent_and_silences_all_layers() {
    let harness = harness_with(fast_options(), vec![""]);
    harness.served("/repo/src", Some("/repo"));
    harness.relay.on_client_count_changed(1);

    harness.relay.close();
    harness.relay.close();

    harness.registry.emit("/repo/src", None);
    harness.registry.emit("/repo/.git", Some("HEAD"));
    delay(50).await;

    assert_eq!(harness.broadcasts().len(), 0);
    assert!(harness.registry.is_closed("/repo/src"));
}
