use std::env;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::thread;
use std::time::Duration;

use remux_compute::{ComputeError, Registry, Task, TaskContext, TaskOptions};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
struct Input {
    mode: String,
    value: u64,
}

#[derive(Deserialize, Serialize)]
struct Progress {
    threads: usize,
    value: u64,
}

#[derive(Deserialize, Serialize)]
struct Output {
    value: u64,
}

struct FixtureTask;

impl Task for FixtureTask {
    const NAME: &'static str = "fixture.process-boundary";
    const VERSION: u32 = 1;
    type Input = Input;
    type Progress = Progress;
    type Output = Output;

    fn run(
        context: TaskContext<Self::Progress>,
        input: Self::Input,
    ) -> Result<Self::Output, String> {
        context.progress(Progress {
            threads: context.threads(),
            value: input.value,
        })?;
        match input.mode.as_str() {
            "ok" => Ok(Output {
                value: input.value * 2,
            }),
            "error" => Err("fixture task error".to_string()),
            "panic" => panic!("fixture task panic"),
            "sleep" => loop {
                thread::sleep(Duration::from_secs(1));
            },
            mode => Err(format!("unknown fixture mode {mode}")),
        }
    }
}

fn main() {
    if env::args().nth(1).as_deref() == Some("workload") {
        exec_wrapped_program();
    }
    let registry = Registry::new().register::<FixtureTask>().unwrap();
    match registry.dispatch_worker_if_requested() {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            eprintln!("fixture worker failed: {error}");
            std::process::exit(1);
        }
    }
    let scenario = env::args().nth(2).unwrap_or_else(|| "ok".to_string());
    let mut task = registry
        .spawn::<FixtureTask>(
            TaskOptions::new("fixture", format!("fixture:{scenario}")),
            Input {
                mode: scenario.clone(),
                value: 21,
            },
        )
        .unwrap();
    let progress = task.recv_progress().unwrap().unwrap();
    assert_eq!(progress.value, 21);
    assert_eq!(progress.threads, 3);
    match scenario.as_str() {
        "ok" => {
            let output = task.wait().unwrap();
            assert_eq!(output.value, 42);
            println!("ok");
        }
        "error" => {
            assert!(
                matches!(task.wait(), Err(ComputeError::Task(message)) if message == "fixture task error")
            );
            println!("error");
        }
        "panic" => {
            assert!(matches!(
                task.wait(),
                Err(ComputeError::WorkerExited { stderr, .. }) if stderr.contains("fixture task panic")
            ));
            println!("panic");
        }
        "sleep" => {
            task.cancel().unwrap();
            println!("cancel");
        }
        _ => unreachable!(),
    }
}

fn exec_wrapped_program() -> ! {
    let args = env::args_os().collect::<Vec<_>>();
    let separator = args
        .iter()
        .position(|argument| argument == "--")
        .expect("workload wrapper requires --");
    let program = args
        .get(separator + 1)
        .expect("workload wrapper requires a program");
    let error = Command::new(program).args(&args[separator + 2..]).exec();
    panic!("failed to exec fixture worker: {error}");
}
