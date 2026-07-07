//! Chaos suite from the pass-1 spec — the tests the Node CLI never had.
//! Exercises the L2 supervisor against a scriptable fixture extension:
//! dead-pipe writes, SIGTERM/EOF-ignoring stops, crash loops → Failed,
//! garbage stdout, truthful stop/restart with confirmed reap.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use remux::extensions::manifest::{BuildSpec, Display, ExtensionManifest, ServerSpec, View};
use remux::extensions::runstate::{read_start_ticks, sweep_orphans, RunEntry, RunState};
use remux::extensions::supervisor::{ExtensionCtx, ExtensionSupervisor, SupervisorConfig};
use remux::logs::{ExtensionLogs, Journal, StdTerminal};
use remux::rpc::router::{BoxFuture, ExtensionServer, ServerStatus};

#[derive(Default)]
struct TestCtx {
    broadcasts: Mutex<Vec<Value>>,
    notifications: Mutex<Vec<Value>>,
    failures: Mutex<Vec<(String, String)>>,
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
    run_state: Arc<RunState>,
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
        run_state.clone(),
    );
    Harness {
        supervisor,
        ctx,
        run_state,
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
    let harness = harness(&["FIXTURE_EXIT_AFTER_MS=30", "FIXTURE_EXIT_CODE=7"], fast_config());
    let status = harness.supervisor.start(false).await;
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
    let harness = harness(&["FIXTURE_EXIT_AFTER_MS=30", "FIXTURE_EXIT_CODE=0"], fast_config());
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
async fn start_is_idempotent_while_running() {
    let harness = harness(&[], fast_config());
    let first = harness.supervisor.start(false).await;
    let pid = first.pid.unwrap();

    let second = harness.supervisor.start(false).await;
    assert_eq!(second.pid, Some(pid), "start while running must not respawn");
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
        &["FIXTURE_SPAWN_CHILD=1", "FIXTURE_EXIT_AFTER_MS=100", "FIXTURE_EXIT_CODE=5"],
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
        assert!(tokio::time::Instant::now() < deadline, "no restart observed");
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
        &["FIXTURE_IGNORE_EOF=1", "FIXTURE_IGNORE_SIGTERM=1", "FIXTURE_SPAWN_CHILD=1"],
        fast_config(),
    );
    let status = harness.supervisor.start(false).await;
    let pgid = status.pid.expect("running fixture has a pid");
    // Let the grandchild spawn.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(group_members(pgid).len() >= 2, "expected fixture + sleep child");

    let started = tokio::time::Instant::now();
    let stopped = harness.supervisor.stop().await;
    assert_eq!(stopped.state, "stopped");
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
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
        RunEntry {
            pid: decoy_pid,
            pgid: decoy_pid,
            start_ticks: decoy_ticks,
            started_at_ms: 0,
        },
    );
    run_state.record(
        "reused-pid",
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
        assert!(tokio::time::Instant::now() < deadline, "decoy survived the sweep");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Mismatched start ticks: skipped.
    assert!(survivor.try_wait().unwrap().is_none(), "stale record must be skipped");
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
    assert_eq!(document["version"], 1);
    assert_eq!(document["extensions"]["fixture"]["pid"], status.pid.unwrap());
    assert_eq!(document["extensions"]["fixture"]["pgid"], status.pid.unwrap());
    assert!(document["extensions"]["fixture"]["startTicks"].as_u64().unwrap() > 0);

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
    let wrapper = format!("#!/bin/sh\nexec {} \"$@\"\n", env!("CARGO_BIN_EXE_remux-fixture-ext"));
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

    // Build output lands in the extension log ring with the [build] prefix.
    let logs = harness.supervisor.logs(100);
    let lines: Vec<String> = logs
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line["line"].as_str().unwrap().to_string())
        .collect();
    assert!(
        lines.iter().any(|line| line == "[build] built-ok"),
        "{lines:?}"
    );

    // The built server is the fixture: RPCs round-trip.
    let result = harness
        .supervisor
        .handle_rpc("fixture/echo".to_string(), Some(serde_json::json!({ "n": 2 })))
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
