//! Chaos suite from the pass-1 spec — the tests the Node CLI never had.
//! Exercises the L2 supervisor against a scriptable fixture extension:
//! dead-pipe writes, SIGTERM/EOF-ignoring stops, crash loops → Failed,
//! garbage stdout, truthful stop/restart with confirmed reap.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use remux::extensions::manifest::{Display, ExtensionManifest, ServerSpec, View};
use remux::extensions::supervisor::{ExtensionCtx, ExtensionSupervisor, SupervisorConfig};
use remux::logs::{ExtensionLogs, Journal, StdTerminal};
use remux::rpc::router::{BoxFuture, ExtensionServer, ServerStatus};

#[derive(Default)]
struct TestCtx {
    broadcasts: Mutex<Vec<Value>>,
    notifications: Mutex<Vec<Value>>,
}

impl ExtensionCtx for TestCtx {
    fn broadcast(&self, message: Value) {
        self.broadcasts.lock().unwrap().push(message);
    }
    fn handle_extension_notification(&self, message: Value) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            self.notifications.lock().unwrap().push(message);
            true
        })
    }
}

impl TestCtx {
    fn states(&self) -> Vec<String> {
        self.broadcasts
            .lock()
            .unwrap()
            .iter()
            .filter(|message| message["method"] == "remux/extensions/didChangeStatus")
            .map(|message| message["params"]["state"].as_str().unwrap().to_string())
            .collect()
    }
}

fn fixture_manifest(root: &Path, args: &[&str]) -> ExtensionManifest {
    ExtensionManifest {
        id: "fixture".to_string(),
        name: "Fixture".to_string(),
        root_dir: root.to_path_buf(),
        display: Display {
            icon: None,
            icon_dark: None,
            title: "Fixture".to_string(),
        },
        server: Some(ServerSpec {
            transport: "stdio".to_string(),
            command: env!("CARGO_BIN_EXE_remux-fixture-ext").to_string(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            cwd: root.to_path_buf(),
        }),
        views: vec![(
            "main".to_string(),
            View {
                entry: root.join("index.html"),
                route: "/viewers/fixture".to_string(),
            },
        )],
        launchers: Vec::new(),
        file_handlers: Vec::new(),
    }
}

fn fast_config() -> SupervisorConfig {
    SupervisorConfig {
        request_timeout_ms: 500,
        backoff_base_ms: 40,
        backoff_cap_ms: 160,
        crash_budget: 5,
        crash_window_ms: 60_000,
        stop_eof_wait_ms: 400,
        stop_term_wait_ms: 400,
    }
}

struct Harness {
    supervisor: Arc<ExtensionSupervisor>,
    ctx: Arc<TestCtx>,
    _root: tempfile::TempDir,
}

fn harness(args: &[&str], cfg: SupervisorConfig) -> Harness {
    let root = tempfile::tempdir().unwrap();
    let ctx = Arc::new(TestCtx::default());
    let journal = Journal::new(root.path(), 14, Arc::new(StdTerminal)).unwrap();
    let logs = ExtensionLogs::new(root.path());
    let (supervisor, _handle) = ExtensionSupervisor::spawn(
        fixture_manifest(root.path(), args),
        cfg,
        ctx.clone(),
        journal,
        logs,
    );
    Harness {
        supervisor,
        ctx,
        _root: root,
    }
}

async fn wait_for_state(
    supervisor: &Arc<ExtensionSupervisor>,
    expected: &str,
    timeout_ms: u64,
) -> ServerStatus {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let status = supervisor.status();
        if status.state == expected {
            return status;
        }
        if tokio::time::Instant::now() > deadline {
            panic!(
                "timed out waiting for state {expected}; current: {}",
                status.state
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn process_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[tokio::test]
async fn incident_regression_write_to_dead_pipe_never_kills_the_runtime() {
    // The fixture dies 30ms in while we spam notifications straight into the
    // dying pipe. In the Node CLI this was the EPIPE crash class that took
    // the whole runtime down.
    let harness = harness(&["FIXTURE_EXIT_AFTER_MS=30", "FIXTURE_EXIT_CODE=7"], fast_config());
    let status = harness.supervisor.start().await;
    assert!(status.running);

    for _ in 0..200 {
        harness
            .supervisor
            .handle_notification("fixture/poke".to_string(), Some(serde_json::json!({ "x": 1 })));
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    // Crash loop runs its budget down to Failed — and the runtime (this
    // process) is still here to observe it.
    let status = wait_for_state(&harness.supervisor, "failed", 10_000).await;
    assert!(!status.running);
    assert!(status.restart_count > 0);
    assert_eq!(status.last_exit.as_ref().unwrap().code, Some(7));

    let states = harness.ctx.states();
    assert!(states.iter().any(|state| state == "backingOff"), "{states:?}");
    assert!(states.iter().any(|state| state == "failed"), "{states:?}");
}

#[tokio::test]
async fn stop_kills_sigterm_and_eof_ignoring_extensions_within_budget() {
    let harness = harness(&["FIXTURE_IGNORE_EOF=1", "FIXTURE_IGNORE_SIGTERM=1"], fast_config());
    let status = harness.supervisor.start().await;
    let pid = status.pid.expect("running fixture has a pid");
    assert!(process_alive(pid));

    let started = tokio::time::Instant::now();
    let stopped = harness.supervisor.stop().await;
    let elapsed = started.elapsed();

    // EOF wait (400ms) + SIGTERM wait (400ms) + SIGKILL: well under the
    // production ~4s worst case, and the response is truthful only after
    // the reap.
    assert_eq!(stopped.state, "stopped");
    assert!(!stopped.running);
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    assert!(!process_alive(pid), "SIGKILL must have reaped the child");
    assert_eq!(
        stopped.last_exit.as_ref().unwrap().signal.as_deref(),
        Some("SIGKILL")
    );
}

#[tokio::test]
async fn crash_on_start_loops_through_backoff_to_failed_and_manual_start_recovers() {
    let harness = harness(&["FIXTURE_CRASH_ON_START=1"], fast_config());
    harness.supervisor.start().await;

    let failed = wait_for_state(&harness.supervisor, "failed", 10_000).await;
    assert_eq!(failed.last_exit.as_ref().unwrap().code, Some(3));

    // Failed is terminal until manual intervention; a manual start spawns
    // again (and, still crashing, heads back toward backoff — not stuck).
    let restarted = harness.supervisor.start().await;
    assert_ne!(restarted.state, "failed");

    let states = harness.ctx.states();
    let backoffs = states.iter().filter(|state| *state == "backingOff").count();
    assert!(backoffs >= 4, "expected repeated backoff, saw {states:?}");
}

#[tokio::test]
async fn unprompted_clean_exit_lands_stopped_without_restart() {
    let harness = harness(&["FIXTURE_EXIT_AFTER_MS=30", "FIXTURE_EXIT_CODE=0"], fast_config());
    harness.supervisor.start().await;

    let status = wait_for_state(&harness.supervisor, "stopped", 5_000).await;
    assert_eq!(status.last_exit.as_ref().unwrap().code, Some(0));
    assert_eq!(status.restart_count, 0);

    // No respawn after a clean exit.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(harness.supervisor.status().state, "stopped");
}

#[tokio::test]
async fn garbage_stdout_lines_are_skipped_and_later_rpc_still_correlates() {
    let harness = harness(&[], fast_config());
    harness.supervisor.start().await;

    let result = harness
        .supervisor
        .handle_rpc("fixture/garbage".to_string(), None)
        .await
        .unwrap();
    assert_eq!(result, serde_json::json!({ "ok": true }));

    let result = harness
        .supervisor
        .handle_rpc("fixture/echo".to_string(), Some(serde_json::json!({ "n": 1 })))
        .await
        .unwrap();
    assert_eq!(result["echo"], "fixture/echo");
    assert_eq!(result["params"]["n"], 1);
}

#[tokio::test]
async fn rpc_timeouts_and_error_responses_keep_node_shapes() {
    let harness = harness(&[], fast_config());

    // Not running yet.
    let err = harness
        .supervisor
        .handle_rpc("fixture/echo".to_string(), None)
        .await
        .unwrap_err();
    assert_eq!(err.code, -32000);
    assert_eq!(err.message, "extension fixture is not running");

    harness.supervisor.start().await;

    let err = harness
        .supervisor
        .handle_rpc("fixture/block".to_string(), None)
        .await
        .unwrap_err();
    assert_eq!(err.code, -32000);
    assert_eq!(err.message, "fixture/block timed out");

    let err = harness
        .supervisor
        .handle_rpc("fixture/fail".to_string(), None)
        .await
        .unwrap_err();
    assert_eq!(err.code, -32001);
    assert_eq!(err.message, "fixture/fail failed: fixture failure");
}

#[tokio::test]
async fn restart_yields_exactly_one_live_child() {
    let harness = harness(&[], fast_config());
    let first = harness.supervisor.start().await;
    let first_pid = first.pid.unwrap();

    let restarted = harness.supervisor.restart().await;
    let second_pid = restarted.pid.unwrap();

    assert_eq!(restarted.state, "running");
    assert_ne!(first_pid, second_pid);
    assert!(!process_alive(first_pid), "old instance must be reaped");
    assert!(process_alive(second_pid));

    // Stop rejects in-flight RPCs with the stopped message.
    let pending = tokio::spawn({
        let supervisor = harness.supervisor.clone();
        async move { supervisor.handle_rpc("fixture/block".to_string(), None).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let stopped = harness.supervisor.stop().await;
    assert_eq!(stopped.state, "stopped");
    assert!(!process_alive(second_pid));
    let err = pending.await.unwrap().unwrap_err();
    assert_eq!(err.message, "extension fixture stopped");
}

#[tokio::test]
async fn notifications_inject_extension_id_and_broadcast_when_not_notification_scoped() {
    let harness = harness(&["FIXTURE_STARTUP_NOTIFICATION=remux/notifications/request"], fast_config());
    harness.supervisor.start().await;

    // remux/notifications/* goes to the manager first, with extensionId
    // injected into params.
    for _ in 0..100 {
        if !harness.ctx.notifications.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let captured = harness.ctx.notifications.lock().unwrap().clone();
    assert_eq!(captured.len(), 1, "{captured:?}");
    assert_eq!(captured[0]["method"], "remux/notifications/request");
    assert_eq!(captured[0]["params"]["extensionId"], "fixture");
    assert_eq!(captured[0]["params"]["from"], "fixture");

    // Non-notification methods broadcast as-is (no injection).
    harness
        .supervisor
        .handle_rpc(
            "fixture/notify".to_string(),
            Some(serde_json::json!({ "method": "custom/event" })),
        )
        .await
        .unwrap();
    for _ in 0..100 {
        let found = harness
            .ctx
            .broadcasts
            .lock()
            .unwrap()
            .iter()
            .any(|message| message["method"] == "custom/event");
        if found {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let broadcasts = harness.ctx.broadcasts.lock().unwrap();
    let custom = broadcasts
        .iter()
        .find(|message| message["method"] == "custom/event")
        .expect("custom/event broadcast");
    assert_eq!(custom["params"], serde_json::json!({ "intent": "test" }));
}

#[tokio::test]
async fn start_is_idempotent_while_running() {
    let harness = harness(&[], fast_config());
    let first = harness.supervisor.start().await;
    let pid = first.pid.unwrap();

    let second = harness.supervisor.start().await;
    assert_eq!(second.pid, Some(pid), "start while running must not respawn");
    assert_eq!(second.state, "running");

    harness.supervisor.stop().await;
}
