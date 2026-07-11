//! Chaos suite from the pass-1 spec — the tests the Node CLI never had.
//! Exercises the L2 supervisor against a scriptable fixture extension:
//! dead-pipe writes, SIGTERM/EOF-ignoring stops, crash loops → Failed,
//! garbage stdout, truthful stop/restart with confirmed reap.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use remux::extensions::manifest::{BuildSpec, Display, ExtensionManifest, ServerSpec, View};
use remux::extensions::runstate::{read_start_ticks, sweep_orphans, RunEntry, RunRole, RunState};
use remux::extensions::supervisor::{ExtensionCtx, ExtensionSupervisor, SupervisorConfig};
use remux::logs::{ExtensionLogs, Journal, StdTerminal};
use remux::rpc::router::{BoxFuture, ExtensionServer, ServerStatus};

#[derive(Default)]
struct TestCtx {
    broadcasts: Mutex<Vec<Value>>,
    targeted: Mutex<Vec<(String, Value)>>,
    notifications: Mutex<Vec<Value>>,
    failures: Mutex<Vec<(String, String)>>,
}

impl ExtensionCtx for TestCtx {
    fn broadcast(&self, message: Value) {
        self.broadcasts.lock().unwrap().push(message);
    }
    fn send_to_origin(&self, origin: &str, message: Value) -> bool {
        self.targeted
            .lock()
            .unwrap()
            .push((origin.to_string(), message));
        true
    }
    fn handle_extension_notification(&self, message: Value) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            self.notifications.lock().unwrap().push(message);
            true
        })
    }
    fn on_extension_failed(&self, extension_id: &str, _name: &str, body: String) {
        self.failures
            .lock()
            .unwrap()
            .push((extension_id.to_string(), body));
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
    fixture_manifest_with_server(
        root,
        ServerSpec {
            transport: "stdio".to_string(),
            command: env!("CARGO_BIN_EXE_remux-fixture-ext").to_string(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            cwd: root.to_path_buf(),
            build: None,
        },
    )
}

fn fixture_manifest_with_server(root: &Path, server: ServerSpec) -> ExtensionManifest {
    ExtensionManifest {
        id: "fixture".to_string(),
        name: "Fixture".to_string(),
        root_dir: root.to_path_buf(),
        display: Display {
            icon: None,
            icon_dark: None,
            title: "Fixture".to_string(),
        },
        server: Some(server),
        views: vec![(
            "main".to_string(),
            View {
                entry: root.join("index.html"),
                route: "/viewers/fixture".to_string(),
                build: None,
                watch: None,
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
        stop_group_wait_ms: 2_000,
        build_timeout_ms: 10_000,
    }
}

struct Harness {
    supervisor: Arc<ExtensionSupervisor>,
    ctx: Arc<TestCtx>,
    root: tempfile::TempDir,
}

fn harness(args: &[&str], cfg: SupervisorConfig) -> Harness {
    harness_with_manifest(tempfile::tempdir().unwrap(), cfg, |root| {
        fixture_manifest(root, args)
    })
}

fn harness_with_manifest(
    root: tempfile::TempDir,
    cfg: SupervisorConfig,
    manifest: impl FnOnce(&Path) -> ExtensionManifest,
) -> Harness {
    let ctx = Arc::new(TestCtx::default());
    let journal = Journal::new(root.path(), 14, Arc::new(StdTerminal)).unwrap();
    let logs = ExtensionLogs::new(root.path());
    let run_state = RunState::new(root.path());
    let (supervisor, _handle) = ExtensionSupervisor::spawn(
        manifest(root.path()),
        cfg,
        ctx.clone(),
        journal,
        logs,
        run_state,
    );
    Harness {
        supervisor,
        ctx,
        root,
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
    let harness = harness(
        &["FIXTURE_EXIT_AFTER_MS=30", "FIXTURE_EXIT_CODE=7"],
        fast_config(),
    );
    let status = harness.supervisor.start(false).await;
    assert!(status.running);

    for _ in 0..200 {
        harness.supervisor.handle_notification(
            "fixture/poke".to_string(),
            Some(serde_json::json!({ "x": 1 })),
        );
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    // Crash loop runs its budget down to Failed — and the runtime (this
    // process) is still here to observe it.
    let status = wait_for_state(&harness.supervisor, "failed", 10_000).await;
    assert!(!status.running);
    assert!(status.restart_count > 0);
    assert_eq!(status.last_exit.as_ref().unwrap().code, Some(7));

    let states = harness.ctx.states();
    assert!(
        states.iter().any(|state| state == "backingOff"),
        "{states:?}"
    );
    assert!(states.iter().any(|state| state == "failed"), "{states:?}");
}

#[tokio::test]
async fn stop_kills_sigterm_and_eof_ignoring_extensions_within_budget() {
    let harness = harness(
        &["FIXTURE_IGNORE_EOF=1", "FIXTURE_IGNORE_SIGTERM=1"],
        fast_config(),
    );
    let status = harness.supervisor.start(false).await;
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
    harness.supervisor.start(false).await;

    let failed = wait_for_state(&harness.supervisor, "failed", 10_000).await;
    assert_eq!(failed.last_exit.as_ref().unwrap().code, Some(3));

    // Failed is terminal until manual intervention; a manual start spawns
    // again (and, still crashing, heads back toward backoff — not stuck).
    let restarted = harness.supervisor.start(false).await;
    assert_ne!(restarted.state, "failed");

    let states = harness.ctx.states();
    let backoffs = states.iter().filter(|state| *state == "backingOff").count();
    assert!(backoffs >= 4, "expected repeated backoff, saw {states:?}");
}

#[tokio::test]
async fn unprompted_clean_exit_lands_stopped_without_restart() {
    let harness = harness(
        &["FIXTURE_EXIT_AFTER_MS=30", "FIXTURE_EXIT_CODE=0"],
        fast_config(),
    );
    harness.supervisor.start(false).await;

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
    harness.supervisor.start(false).await;

    let result = harness
        .supervisor
        .handle_rpc("fixture/garbage".to_string(), None)
        .await
        .unwrap();
    assert_eq!(result, serde_json::json!({ "ok": true }));

    let result = harness
        .supervisor
        .handle_rpc(
            "fixture/echo".to_string(),
            Some(serde_json::json!({ "n": 1 })),
        )
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

    harness.supervisor.start(false).await;

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
    let first = harness.supervisor.start(false).await;
    let first_pid = first.pid.unwrap();

    let restarted = harness.supervisor.restart(false).await;
    let second_pid = restarted.pid.unwrap();

    assert_eq!(restarted.state, "running");
    assert_ne!(first_pid, second_pid);
    assert!(!process_alive(first_pid), "old instance must be reaped");
    assert!(process_alive(second_pid));

    // Stop rejects in-flight RPCs with the stopped message.
    let pending = tokio::spawn({
        let supervisor = harness.supervisor.clone();
        async move {
            supervisor
                .handle_rpc("fixture/block".to_string(), None)
                .await
        }
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
    let harness = harness(
        &["FIXTURE_STARTUP_NOTIFICATION=remux/notifications/request"],
        fast_config(),
    );
    harness.supervisor.start(false).await;

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
async fn targeted_extension_notifications_bypass_broadcast_and_strip_routing_metadata() {
    let harness = harness(&[], fast_config());
    harness.supervisor.start(false).await;
    harness
        .supervisor
        .handle_rpc(
            "fixture/notify".to_string(),
            Some(serde_json::json!({
                "method": "custom/targeted",
                "targetOrigin": "opaque-origin-7"
            })),
        )
        .await
        .unwrap();

    for _ in 0..100 {
        if !harness.ctx.targeted.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let targeted = harness.ctx.targeted.lock().unwrap().clone();
    assert_eq!(targeted.len(), 1, "{targeted:?}");
    assert_eq!(targeted[0].0, "opaque-origin-7");
    assert_eq!(targeted[0].1["method"], "custom/targeted");
    assert!(targeted[0].1.get("remuxTarget").is_none());
    assert!(!harness
        .ctx
        .broadcasts
        .lock()
        .unwrap()
        .iter()
        .any(|message| message["method"] == "custom/targeted"));
}

#[tokio::test]
async fn start_is_idempotent_while_running() {
    let harness = harness(&[], fast_config());
    let first = harness.supervisor.start(false).await;
    let pid = first.pid.unwrap();

    let second = harness.supervisor.start(false).await;
    assert_eq!(
        second.pid,
        Some(pid),
        "start while running must not respawn"
    );
    assert_eq!(second.state, "running");

    harness.supervisor.stop().await;
}

// ---------------------------------------------------------------------------
// Pass 2 — L3 process hygiene.
// ---------------------------------------------------------------------------

/// Pids whose /proc stat pgrp matches the given group.
fn group_members(pgid: u32) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            if !name.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            let stat = remux::monitor::parse_proc_stat(&stat)?;
            (stat.pgrp == pgid as i32).then_some(stat.pid)
        })
        .collect()
}

async fn wait_for_group_empty(pgid: u32, timeout_ms: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let members = group_members(pgid);
        if members.is_empty() {
            return;
        }
        if tokio::time::Instant::now() > deadline {
            panic!("group {pgid} still has members: {members:?}");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn crash_restart_reaps_reparented_grandchildren() {
    // The fixture spawns a `sleep 300` grandchild then crashes; the crash
    // path must SIGKILL the old process group before any respawn.
    let harness = harness(
        &[
            "FIXTURE_SPAWN_CHILD=1",
            "FIXTURE_EXIT_AFTER_MS=100",
            "FIXTURE_EXIT_CODE=5",
        ],
        fast_config(),
    );
    let first = harness.supervisor.start(false).await;
    let first_pgid = first.pid.expect("running fixture has a pid");

    // Wait until the supervisor has restarted at least once.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if harness.supervisor.status().restart_count >= 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no restart observed"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    wait_for_group_empty(first_pgid, 3_000).await;
    harness.supervisor.stop().await;
}

#[tokio::test]
async fn stop_kills_a_kill_resistant_tree_within_budget() {
    // EOF- and SIGTERM-ignoring server *with* a grandchild: the group
    // SIGKILL must take both down, and the stop RPC returns promptly.
    let harness = harness(
        &[
            "FIXTURE_IGNORE_EOF=1",
            "FIXTURE_IGNORE_SIGTERM=1",
            "FIXTURE_SPAWN_CHILD=1",
        ],
        fast_config(),
    );
    let status = harness.supervisor.start(false).await;
    let pgid = status.pid.expect("running fixture has a pid");
    // Let the grandchild spawn.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        group_members(pgid).len() >= 2,
        "expected fixture + sleep child"
    );

    let started = tokio::time::Instant::now();
    let stopped = harness.supervisor.stop().await;
    assert_eq!(stopped.state, "stopped");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    wait_for_group_empty(pgid, 1_000).await;
}

#[tokio::test]
async fn restart_storm_leaves_zero_stray_processes() {
    let harness = harness(&["FIXTURE_SPAWN_CHILD=1"], fast_config());
    let mut pgids = Vec::new();

    let status = harness.supervisor.start(false).await;
    pgids.push(status.pid.unwrap());
    for _ in 0..20 {
        let status = harness.supervisor.restart(false).await;
        assert_eq!(status.state, "running");
        pgids.push(status.pid.unwrap());
    }
    harness.supervisor.stop().await;

    for pgid in pgids {
        wait_for_group_empty(pgid, 2_000).await;
    }
}

#[tokio::test]
async fn boot_sweep_kills_recorded_groups_and_skips_stale_records() {
    use std::os::unix::process::CommandExt;

    let root = tempfile::tempdir().unwrap();
    let journal = Journal::new(root.path(), 14, Arc::new(StdTerminal)).unwrap();

    // Live decoy leading its own group — a stand-in for an orphaned
    // extension tree.
    let mut decoy = {
        let mut command = std::process::Command::new("sleep");
        command.arg("300").process_group(0);
        command.spawn().unwrap()
    };
    let decoy_pid = decoy.id();
    let decoy_ticks = read_start_ticks(decoy_pid).expect("decoy is alive");

    // Stale decoy: alive process, but recorded with mismatched start ticks —
    // the pid-reuse simulation. The sweep must skip it.
    let mut survivor = {
        let mut command = std::process::Command::new("sleep");
        command.arg("300").process_group(0);
        command.spawn().unwrap()
    };
    let survivor_pid = survivor.id();
    let survivor_ticks = read_start_ticks(survivor_pid).expect("survivor is alive");

    let run_state = RunState::new(root.path());
    run_state.record(
        "orphaned",
        RunRole::Server,
        RunEntry {
            pid: decoy_pid,
            pgid: decoy_pid,
            start_ticks: decoy_ticks,
            started_at_ms: 0,
        },
    );
    run_state.record(
        "reused-pid",
        RunRole::Watch,
        RunEntry {
            pid: survivor_pid,
            pgid: survivor_pid,
            start_ticks: survivor_ticks + 999,
            started_at_ms: 0,
        },
    );

    sweep_orphans(root.path(), &journal);

    // Matched record: killed. SIGKILL delivery is fast but not instant.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if decoy.try_wait().unwrap().is_some() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "decoy survived the sweep"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Mismatched start ticks: skipped.
    assert!(
        survivor.try_wait().unwrap().is_none(),
        "stale record must be skipped"
    );
    survivor.kill().unwrap();
    survivor.wait().unwrap();

    // The file is reset either way.
    assert!(!root.path().join(".remux/run/extensions.json").exists());
}

#[tokio::test]
async fn run_state_file_tracks_spawn_and_reap() {
    let harness = harness(&[], fast_config());
    let path = harness.root.path().join(".remux/run/extensions.json");

    let status = harness.supervisor.start(false).await;
    let document: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(document["version"], 2);
    let server = &document["extensions"]["fixture"]["server"];
    assert_eq!(server["pid"], status.pid.unwrap());
    assert_eq!(server["pgid"], status.pid.unwrap());
    assert!(server["startTicks"].as_u64().unwrap() > 0);

    harness.supervisor.stop().await;
    let document: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(document["extensions"].as_object().unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// Pass 2 — manifest build phase.
// ---------------------------------------------------------------------------

/// Manifest whose server is produced by a scripted build step: the build
/// copies a shell wrapper (which execs the fixture binary) into place.
fn build_manifest(root: &Path, build_script: &str) -> ExtensionManifest {
    let wrapper = format!(
        "#!/bin/sh\nexec {} \"$@\"\n",
        env!("CARGO_BIN_EXE_remux-fixture-ext")
    );
    std::fs::write(root.join("server-src.sh"), wrapper).unwrap();
    fixture_manifest_with_server(
        root,
        ServerSpec {
            transport: "stdio".to_string(),
            command: root.join("server-bin").to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: root.to_path_buf(),
            build: Some(BuildSpec {
                command: "sh".to_string(),
                args: vec!["-c".to_string(), build_script.to_string()],
                cwd: root.to_path_buf(),
            }),
        },
    )
}

const BUILD_OK: &str =
    "echo x >> build-count.txt && cp server-src.sh server-bin && chmod +x server-bin && echo built-ok";

fn build_count(root: &Path) -> usize {
    std::fs::read_to_string(root.join("build-count.txt"))
        .map(|content| content.lines().count())
        .unwrap_or(0)
}

#[tokio::test]
async fn missing_binary_builds_then_runs_with_build_logs() {
    let harness = harness_with_manifest(tempfile::tempdir().unwrap(), fast_config(), |root| {
        build_manifest(root, BUILD_OK)
    });

    let status = harness.supervisor.start(false).await;
    assert_eq!(status.state, "running");
    assert!(status.has_build);

    let states = harness.ctx.states();
    assert!(states.contains(&"building".to_string()), "{states:?}");

    // Build output lands in the extension-server component log with typed
    // build/stdout metadata.
    let logs = harness.supervisor.logs(100);
    assert!(
        logs.as_array().unwrap().iter().any(|line| {
            line["line"] == "built-ok"
                && line["componentId"] == "extension-server"
                && line["source"] == "build"
                && line["channel"] == "stdout"
                && line["level"].is_null()
        }),
        "{logs}"
    );

    // The built server is the fixture: RPCs round-trip.
    let result = harness
        .supervisor
        .handle_rpc(
            "fixture/echo".to_string(),
            Some(serde_json::json!({ "n": 2 })),
        )
        .await
        .unwrap();
    assert_eq!(result["params"]["n"], 2);

    // A plain restart reuses the artifact — no second build.
    let restarted = harness.supervisor.restart(false).await;
    assert_eq!(restarted.state, "running");
    assert_eq!(build_count(harness.root.path()), 1);

    // rebuild: true forces the build phase to re-run.
    let rebuilt = harness.supervisor.restart(true).await;
    assert_eq!(rebuilt.state, "running");
    assert_eq!(build_count(harness.root.path()), 2);

    harness.supervisor.stop().await;
}

#[tokio::test]
async fn failing_build_lands_failed_without_consuming_crash_budget() {
    let harness = harness_with_manifest(tempfile::tempdir().unwrap(), fast_config(), |root| {
        build_manifest(root, "echo boom >&2; exit 1")
    });

    let status = harness.supervisor.start(false).await;
    assert_eq!(status.state, "failed");
    let last_exit = status.last_exit.expect("failed build records lastExit");
    assert_eq!(last_exit.reason.as_deref(), Some("build-failed"));
    assert_eq!(last_exit.code, Some(1));

    // No crash budget consumed: the state history has no backingOff.
    let states = harness.ctx.states();
    assert!(!states.contains(&"backingOff".to_string()), "{states:?}");

    // Manual start retries the build (still failing here).
    let retried = harness.supervisor.start(false).await;
    assert_eq!(retried.state, "failed");
    let buildings = harness
        .ctx
        .states()
        .iter()
        .filter(|state| *state == "building")
        .count();
    assert_eq!(buildings, 2, "each manual start re-runs the build");

    // Failure is announced once per failed entry.
    assert_eq!(harness.ctx.failures.lock().unwrap().len(), 2);
}

// ---------------------------------------------------------------------------
// View build + watch pass.
// ---------------------------------------------------------------------------

/// Manifest with a single `main` view carrying optional build/watch jobs.
/// The entry is `dist/index.html` under the extension root.
fn view_manifest(
    root: &Path,
    server: Option<ServerSpec>,
    build: Option<&str>,
    watch: Option<&str>,
) -> ExtensionManifest {
    let job = |script: &str| BuildSpec {
        command: "sh".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
        cwd: root.to_path_buf(),
    };
    ExtensionManifest {
        id: "fixture".to_string(),
        name: "Fixture".to_string(),
        root_dir: root.to_path_buf(),
        display: Display {
            icon: None,
            icon_dark: None,
            title: "Fixture".to_string(),
        },
        server,
        views: vec![(
            "main".to_string(),
            View {
                entry: root.join("dist/index.html"),
                route: "/viewers/fixture".to_string(),
                build: build.map(job),
                watch: watch.map(job),
            },
        )],
        launchers: Vec::new(),
        file_handlers: Vec::new(),
    }
}

const VIEW_BUILD_OK: &str =
    "echo x >> view-build-count.txt && mkdir -p dist && echo bundle > dist/index.html && echo view-built";

fn view_build_count(root: &Path) -> usize {
    std::fs::read_to_string(root.join("view-build-count.txt"))
        .map(|content| content.lines().count())
        .unwrap_or(0)
}

/// Watch facet states carried by didChangeStatus broadcasts, in order.
fn watch_states(ctx: &TestCtx) -> Vec<String> {
    ctx.broadcasts
        .lock()
        .unwrap()
        .iter()
        .filter(|message| message["method"] == "remux/extensions/didChangeStatus")
        .filter_map(|message| {
            message["params"]["watch"]["state"]
                .as_str()
                .map(str::to_string)
        })
        .collect()
}

async fn wait_for<F: Fn() -> bool>(condition: F, what: &str, timeout_ms: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    while !condition() {
        if tokio::time::Instant::now() > deadline {
            panic!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn serverless_start_runs_view_build_then_lands_stopped_and_built() {
    let harness = harness_with_manifest(tempfile::tempdir().unwrap(), fast_config(), |root| {
        view_manifest(root, None, Some(VIEW_BUILD_OK), None)
    });

    let status = harness.supervisor.start(false).await;
    assert_eq!(status.state, "stopped");
    assert!(!status.running);
    assert!(!status.has_server);
    assert!(status.has_build, "view build must aggregate into hasBuild");
    assert_eq!(status.views.declared, 1);
    assert!(status.views.built);
    assert!(status.views.last_build_at_ms.is_some());
    assert_eq!(view_build_count(harness.root.path()), 1);

    // The build ran under the lifecycle Building state and settled back.
    let states = harness.ctx.states();
    assert!(states.contains(&"building".to_string()), "{states:?}");
    assert_eq!(states.last().map(String::as_str), Some("stopped"));

    // A second start with the bundle present is a no-op build-wise.
    let again = harness.supervisor.start(false).await;
    assert_eq!(again.state, "stopped");
    assert_eq!(view_build_count(harness.root.path()), 1);

    // rebuild: true is scoped to the server build — views stay untouched
    // (the manual views/build RPC is the force path).
    let rebuilt = harness.supervisor.restart(true).await;
    assert_eq!(rebuilt.state, "stopped");
    assert_eq!(view_build_count(harness.root.path()), 1);

    let logs = harness.supervisor.logs(200);
    assert!(
        logs.as_array().unwrap().iter().any(|line| {
            line["line"] == "view-built"
                && line["componentId"] == "viewer:main"
                && line["source"] == "build"
                && line["channel"] == "stdout"
                && line["level"].is_null()
        }),
        "{logs}"
    );
}

#[tokio::test]
async fn view_build_failure_lands_failed_without_consuming_crash_budget() {
    let harness = harness_with_manifest(tempfile::tempdir().unwrap(), fast_config(), |root| {
        view_manifest(root, None, Some("echo view-boom >&2; exit 1"), None)
    });

    let status = harness.supervisor.start(false).await;
    assert_eq!(status.state, "failed");
    let last_exit = status.last_exit.expect("failed build records lastExit");
    assert_eq!(last_exit.reason.as_deref(), Some("build-failed"));
    assert!(!status.views.built);

    let states = harness.ctx.states();
    assert!(!states.contains(&"backingOff".to_string()), "{states:?}");

    // Manual start retries the view build even though nothing else changed.
    let retried = harness.supervisor.start(false).await;
    assert_eq!(retried.state, "failed");
    let buildings = harness
        .ctx
        .states()
        .iter()
        .filter(|state| *state == "building")
        .count();
    assert_eq!(buildings, 2);
}

#[tokio::test]
async fn build_sequence_skips_watch_owned_views_and_logs_the_skip() {
    let harness = harness_with_manifest(tempfile::tempdir().unwrap(), fast_config(), |root| {
        view_manifest(root, None, Some(VIEW_BUILD_OK), Some("sleep 300"))
    });

    // Watch start gates on the initial build (entry missing).
    let (status, started) = harness.supervisor.watch_start().await.unwrap();
    assert!(started);
    assert_eq!(status.watch.state, "running");
    assert!(status.watch.pid.is_some());
    assert!(status.views.built, "gating build must produce the bundle");
    assert_eq!(view_build_count(harness.root.path()), 1);
    // The gating build ran under the watch facet, not the lifecycle.
    assert_eq!(status.state, "stopped");
    assert!(!harness.ctx.states().contains(&"building".to_string()));

    // A forced rebuild skips the watch-owned view instead of racing vite.
    let rebuilt = harness.supervisor.restart(true).await;
    assert_eq!(rebuilt.state, "stopped");
    assert_eq!(
        view_build_count(harness.root.path()),
        1,
        "build must be skipped"
    );
    let logs = harness.supervisor.logs(200);
    assert!(
        logs.as_array().unwrap().iter().any(|line| {
            line["line"] == "skipping: watch owns the bundle"
                && line["componentId"] == "viewer:main"
                && line["source"] == "build"
                && line["channel"].is_null()
                && line["level"] == "info"
        }),
        "{logs}"
    );

    // watch/start is idempotent while enabled.
    let (_, started_again) = harness.supervisor.watch_start().await.unwrap();
    assert!(!started_again);

    // Stop kills the sleeping watcher group and lands the facet on stopped.
    let watch_pid = status.watch.pid.unwrap();
    let (stopped, changed) = harness.supervisor.watch_stop().await;
    assert!(changed);
    assert_eq!(stopped.watch.state, "stopped");
    assert!(!process_alive(watch_pid), "watcher must be reaped");
    let (_, changed_again) = harness.supervisor.watch_stop().await;
    assert!(!changed_again, "watch/stop is idempotent");

    // didChangeStatus carried the watch transitions.
    let states = watch_states(&harness.ctx);
    assert!(states.contains(&"running".to_string()), "{states:?}");
    assert_eq!(states.last().map(String::as_str), Some("stopped"));
}

#[tokio::test]
async fn watch_not_declared_errors_and_undeclared_facet_stays_minimal() {
    let harness = harness_with_manifest(tempfile::tempdir().unwrap(), fast_config(), |root| {
        view_manifest(root, None, Some(VIEW_BUILD_OK), None)
    });

    let err = harness.supervisor.watch_start().await.unwrap_err();
    assert_eq!(err.message, "watch not declared");
    assert!(!harness.supervisor.status().watch.declared);
}

#[tokio::test]
async fn gating_build_failure_fails_the_watch_facet_and_spares_a_running_server() {
    let root = tempfile::tempdir().unwrap();
    // Entry pre-exists so the server start needs no view build; the watcher's
    // gating build only triggers after we delete the bundle.
    std::fs::create_dir_all(root.path().join("dist")).unwrap();
    std::fs::write(root.path().join("dist/index.html"), "bundle").unwrap();
    let harness = harness_with_manifest(root, fast_config(), |root| {
        view_manifest(
            root,
            Some(ServerSpec {
                transport: "stdio".to_string(),
                command: env!("CARGO_BIN_EXE_remux-fixture-ext").to_string(),
                args: Vec::new(),
                cwd: root.to_path_buf(),
                build: None,
            }),
            Some("echo gate-boom >&2; exit 1"),
            Some("sleep 300"),
        )
    });

    let status = harness.supervisor.start(false).await;
    assert_eq!(status.state, "running");
    let server_pid = status.pid.unwrap();

    std::fs::remove_file(harness.root.path().join("dist/index.html")).unwrap();
    let (status, started) = harness.supervisor.watch_start().await.unwrap();
    assert!(!started);
    assert_eq!(status.watch.state, "failed");
    // The lifecycle — and the live server — are untouched.
    assert_eq!(status.state, "running");
    assert!(status.running);
    assert_eq!(status.pid, Some(server_pid));
    assert!(process_alive(server_pid));
    assert!(
        status.last_exit.is_none(),
        "no build-failed lastExit on the lifecycle"
    );
    assert!(
        harness.ctx.failures.lock().unwrap().is_empty(),
        "no push for watch failures"
    );

    harness.supervisor.stop().await;
}

#[tokio::test]
async fn watch_crashes_restart_with_backoff_while_the_facet_stays_running() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("dist")).unwrap();
    std::fs::write(root.path().join("dist/index.html"), "bundle").unwrap();
    // Crashes twice, then stays up.
    let flaky =
        "echo x >> watch-count.txt; n=$(wc -l < watch-count.txt); if [ \"$n\" -le 2 ]; then exit 1; fi; sleep 300";
    let harness = harness_with_manifest(root, fast_config(), |root| {
        view_manifest(root, None, None, Some(flaky))
    });

    let (status, started) = harness.supervisor.watch_start().await.unwrap();
    assert!(started);
    assert_eq!(status.watch.state, "running");

    wait_for(
        || {
            let watch = harness.supervisor.status().watch;
            watch.restart_count >= 2 && watch.pid.is_some()
        },
        "watcher to settle after two crash restarts",
        10_000,
    )
    .await;

    let status = harness.supervisor.status();
    assert_eq!(status.watch.state, "running");
    assert_eq!(status.watch.restart_count, 2);
    // The extension lifecycle never budged and its crash counter is separate.
    assert_eq!(status.state, "stopped");
    assert_eq!(status.restart_count, 0);
    // The facet stayed `running` through every backoff broadcast.
    let states = watch_states(&harness.ctx);
    assert!(states.iter().all(|state| state == "running"), "{states:?}");

    harness.supervisor.watch_stop().await;
}

#[tokio::test]
async fn watch_budget_exhaustion_fails_the_facet_without_a_push() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("dist")).unwrap();
    std::fs::write(root.path().join("dist/index.html"), "bundle").unwrap();
    let harness = harness_with_manifest(root, fast_config(), |root| {
        view_manifest(root, None, None, Some("exit 1"))
    });

    let (status, started) = harness.supervisor.watch_start().await.unwrap();
    assert!(started);
    assert_eq!(status.watch.state, "running");

    wait_for(
        || harness.supervisor.status().watch.state == "failed",
        "watch crash budget to exhaust",
        10_000,
    )
    .await;

    let status = harness.supervisor.status();
    assert_eq!(status.watch.state, "failed");
    assert_eq!(status.watch.pid, None);
    // No system push — a dev watcher dying is not an ops page.
    assert!(harness.ctx.failures.lock().unwrap().is_empty());
    // Lifecycle untouched.
    assert_eq!(status.state, "stopped");

    // Manual watch/start retries from failed.
    let (status, started) = harness.supervisor.watch_start().await.unwrap();
    assert!(started);
    assert_eq!(status.watch.state, "running");
    harness.supervisor.watch_stop().await;
}

#[tokio::test]
async fn extension_stop_and_restart_leave_the_watcher_untouched() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("dist")).unwrap();
    std::fs::write(root.path().join("dist/index.html"), "bundle").unwrap();
    let harness = harness_with_manifest(root, fast_config(), |root| {
        view_manifest(
            root,
            Some(ServerSpec {
                transport: "stdio".to_string(),
                command: env!("CARGO_BIN_EXE_remux-fixture-ext").to_string(),
                args: Vec::new(),
                cwd: root.to_path_buf(),
                build: None,
            }),
            None,
            Some("sleep 300"),
        )
    });

    harness.supervisor.start(false).await;
    let (status, _) = harness.supervisor.watch_start().await.unwrap();
    let watch_pid = status.watch.pid.unwrap();
    assert!(process_alive(watch_pid));

    let restarted = harness.supervisor.restart(false).await;
    assert_eq!(restarted.state, "running");
    assert!(
        process_alive(watch_pid),
        "server restart must not kill the watcher"
    );
    assert_eq!(restarted.watch.state, "running");

    let stopped = harness.supervisor.stop().await;
    assert_eq!(stopped.state, "stopped");
    assert!(
        process_alive(watch_pid),
        "server stop must not kill the watcher"
    );
    assert_eq!(stopped.watch.state, "running");

    let (final_status, changed) = harness.supervisor.watch_stop().await;
    assert!(changed);
    assert_eq!(final_status.watch.state, "stopped");
    assert!(!process_alive(watch_pid));
}

#[tokio::test]
async fn boot_sweep_reads_v1_files_and_kills_their_groups() {
    use std::os::unix::process::CommandExt;

    let root = tempfile::tempdir().unwrap();
    let journal = Journal::new(root.path(), 14, Arc::new(StdTerminal)).unwrap();

    let mut decoy = {
        let mut command = std::process::Command::new("sleep");
        command.arg("300").process_group(0);
        command.spawn().unwrap()
    };
    let decoy_pid = decoy.id();
    let decoy_ticks = read_start_ticks(decoy_pid).expect("decoy is alive");

    // Hand-written v1 file: flat one-entry-per-id map, no roles.
    let run_dir = root.path().join(".remux/run");
    std::fs::create_dir_all(&run_dir).unwrap();
    std::fs::write(
        run_dir.join("extensions.json"),
        serde_json::json!({
            "version": 1,
            "extensions": {
                "legacy": {
                    "pid": decoy_pid,
                    "pgid": decoy_pid,
                    "startTicks": decoy_ticks,
                    "startedAtMs": 0,
                }
            }
        })
        .to_string(),
    )
    .unwrap();

    sweep_orphans(root.path(), &journal);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if decoy.try_wait().unwrap().is_some() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "v1 decoy survived the sweep"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!root.path().join(".remux/run/extensions.json").exists());
}

#[tokio::test]
async fn boot_sweep_kills_orphaned_watch_role_groups() {
    use std::os::unix::process::CommandExt;

    // The `kill -9`'d-worker scenario for a live watcher: its group is
    // recorded under the watch role and must be swept on the next boot.
    let root = tempfile::tempdir().unwrap();
    let journal = Journal::new(root.path(), 14, Arc::new(StdTerminal)).unwrap();

    let mut watcher = {
        let mut command = std::process::Command::new("sleep");
        command.arg("300").process_group(0);
        command.spawn().unwrap()
    };
    let watcher_pid = watcher.id();
    let watcher_ticks = read_start_ticks(watcher_pid).expect("watcher is alive");

    let run_state = RunState::new(root.path());
    run_state.record(
        "fixture",
        RunRole::Watch,
        RunEntry {
            pid: watcher_pid,
            pgid: watcher_pid,
            start_ticks: watcher_ticks,
            started_at_ms: 0,
        },
    );

    sweep_orphans(root.path(), &journal);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if watcher.try_wait().unwrap().is_some() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "orphaned watcher survived the sweep"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ---------------------------------------------------------------------------
// Manual build verbs (server/build + views/build RPCs).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn manual_server_build_stages_until_explicit_restart() {
    let harness = harness_with_manifest(tempfile::tempdir().unwrap(), fast_config(), |root| {
        build_manifest(root, BUILD_OK)
    });

    let started = harness.supervisor.start(false).await;
    assert_eq!(started.state, "running");
    assert!(started.has_server_build);
    let first_pid = started.pid.unwrap();
    assert_eq!(build_count(harness.root.path()), 1);

    let status = harness.supervisor.build_server().await.unwrap();
    assert_eq!(status.state, "running");
    assert_eq!(
        build_count(harness.root.path()),
        2,
        "manual build always runs"
    );
    assert_eq!(
        status.pid,
        Some(first_pid),
        "build preserves the live server"
    );
    assert!(process_alive(first_pid));

    let restarted = harness.supervisor.restart(false).await;
    let second_pid = restarted.pid.unwrap();
    assert_ne!(
        first_pid, second_pid,
        "explicit restart applies the staged build"
    );
    assert!(!process_alive(first_pid));
    assert!(process_alive(second_pid));

    harness.supervisor.stop().await;

    // Stopped server: build runs, server stays stopped.
    let status = harness.supervisor.build_server().await.unwrap();
    assert_eq!(status.state, "stopped");
    assert!(!status.running);
    assert_eq!(build_count(harness.root.path()), 3);
}

#[tokio::test]
async fn manual_server_build_failure_spares_the_running_server() {
    let root = tempfile::tempdir().unwrap();
    // First build succeeds (creates the wrapper), later ones fail.
    let flaky_build =
        "if [ -f built-once ]; then echo boom >&2; exit 1; fi; touch built-once; cp server-src.sh server-bin && chmod +x server-bin";
    let harness = harness_with_manifest(root, fast_config(), |root| {
        build_manifest(root, flaky_build)
    });

    let started = harness.supervisor.start(false).await;
    assert_eq!(started.state, "running");
    let pid = started.pid.unwrap();

    let err = harness.supervisor.build_server().await.unwrap_err();
    assert!(
        err.message.starts_with("server build failed"),
        "{}",
        err.message
    );
    // Lifecycle — and the live server — untouched; no push.
    let status = harness.supervisor.status();
    assert_eq!(status.state, "running");
    assert_eq!(status.pid, Some(pid));
    assert!(process_alive(pid));
    assert!(harness.ctx.failures.lock().unwrap().is_empty());

    harness.supervisor.stop().await;
}

#[tokio::test]
async fn manual_views_build_forces_a_rebuild_without_lifecycle_changes() {
    let harness = harness_with_manifest(tempfile::tempdir().unwrap(), fast_config(), |root| {
        view_manifest(root, None, Some(VIEW_BUILD_OK), None)
    });

    // First manual build creates the bundle from scratch.
    let status = harness.supervisor.build_views().await.unwrap();
    assert!(status.views.built);
    assert!(status.views.last_build_at_ms.is_some());
    assert_eq!(status.state, "stopped");
    assert_eq!(view_build_count(harness.root.path()), 1);

    // Bundle exists — a manual build still force-runs (unlike start).
    harness.supervisor.build_views().await.unwrap();
    assert_eq!(view_build_count(harness.root.path()), 2);
    let started = harness.supervisor.start(false).await;
    assert_eq!(started.state, "stopped");
    assert_eq!(
        view_build_count(harness.root.path()),
        2,
        "start must not rebuild"
    );

    // The lifecycle never left stopped/building territory — no failed.
    assert!(!harness.ctx.states().contains(&"failed".to_string()));
}

#[tokio::test]
async fn manual_views_build_failure_errors_and_marks_the_view_for_rebuild() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("dist")).unwrap();
    std::fs::write(root.path().join("dist/index.html"), "stale bundle").unwrap();
    let harness = harness_with_manifest(root, fast_config(), |root| {
        view_manifest(root, None, Some("echo view-boom >&2; exit 1"), None)
    });

    let err = harness.supervisor.build_views().await.unwrap_err();
    assert!(
        err.message.starts_with("view build failed"),
        "{}",
        err.message
    );
    // No lifecycle change; the stale bundle keeps serving (views.built true).
    let status = harness.supervisor.status();
    assert_eq!(status.state, "stopped");
    assert!(status.views.built, "old bundle still exists and serves");
    assert!(harness.ctx.failures.lock().unwrap().is_empty());

    // The failure marks the view: the next start re-runs its build.
    let started = harness.supervisor.start(false).await;
    assert_eq!(started.state, "failed");
    assert_eq!(
        started.last_exit.unwrap().reason.as_deref(),
        Some("build-failed")
    );
}

#[tokio::test]
async fn manual_views_build_skips_watch_owned_views() {
    let harness = harness_with_manifest(tempfile::tempdir().unwrap(), fast_config(), |root| {
        view_manifest(root, None, Some(VIEW_BUILD_OK), Some("sleep 300"))
    });

    let (_, started) = harness.supervisor.watch_start().await.unwrap();
    assert!(started);
    assert_eq!(view_build_count(harness.root.path()), 1, "gating build");

    let status = harness.supervisor.build_views().await.unwrap();
    assert_eq!(
        view_build_count(harness.root.path()),
        1,
        "watch owns the bundle"
    );
    assert_eq!(status.watch.state, "running");

    harness.supervisor.watch_stop().await;
}

#[tokio::test]
async fn build_rpcs_error_when_not_declared() {
    let harness = harness(&[], fast_config());
    let err = harness.supervisor.build_server().await.unwrap_err();
    assert_eq!(err.message, "server build not declared");
    let err = harness.supervisor.build_views().await.unwrap_err();
    assert_eq!(err.message, "view build not declared");
}

#[tokio::test]
async fn rebuild_flag_is_scoped_to_the_server_build() {
    // Server build + view build on one extension: restart(rebuild: true)
    // re-runs the server build but leaves an existing view bundle alone.
    let root = tempfile::tempdir().unwrap();
    let wrapper = format!(
        "#!/bin/sh\nexec {} \"$@\"\n",
        env!("CARGO_BIN_EXE_remux-fixture-ext")
    );
    std::fs::write(root.path().join("server-src.sh"), wrapper).unwrap();
    let harness = harness_with_manifest(root, fast_config(), |root| {
        let mut manifest = view_manifest(
            root,
            Some(ServerSpec {
                transport: "stdio".to_string(),
                command: root.join("server-bin").to_string_lossy().into_owned(),
                args: Vec::new(),
                cwd: root.to_path_buf(),
                build: Some(BuildSpec {
                    command: "sh".to_string(),
                    args: vec!["-c".to_string(), BUILD_OK.to_string()],
                    cwd: root.to_path_buf(),
                }),
            }),
            Some(VIEW_BUILD_OK),
            None,
        );
        manifest.id = "fixture".to_string();
        manifest
    });

    let started = harness.supervisor.start(false).await;
    assert_eq!(started.state, "running");
    assert_eq!(build_count(harness.root.path()), 1);
    assert_eq!(view_build_count(harness.root.path()), 1);

    let rebuilt = harness.supervisor.restart(true).await;
    assert_eq!(rebuilt.state, "running");
    assert_eq!(
        build_count(harness.root.path()),
        2,
        "rebuild forces the server build"
    );
    assert_eq!(
        view_build_count(harness.root.path()),
        1,
        "rebuild must not force view builds"
    );

    harness.supervisor.stop().await;
}
