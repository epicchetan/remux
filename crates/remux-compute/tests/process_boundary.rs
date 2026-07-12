use std::process::Command;

fn run_scenario(scenario: &str) {
    let executable = env!("CARGO_BIN_EXE_remux-compute-fixture");
    let output = Command::new(executable)
        .args(["host", scenario])
        .env("REMUX_WORKLOAD_EXEC", executable)
        .env("REMUX_WORKLOAD_THREADS", "3")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "scenario {scenario} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected = if scenario == "sleep" {
        "cancel"
    } else {
        scenario
    };
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), expected);
}

#[test]
fn same_binary_task_round_trips_typed_progress_and_output() {
    run_scenario("ok");
}

#[test]
fn same_binary_task_preserves_task_errors() {
    run_scenario("error");
}

#[test]
fn same_binary_task_reports_panics_from_stderr() {
    run_scenario("panic");
}

#[test]
fn same_binary_task_can_be_cancelled() {
    run_scenario("sleep");
}
