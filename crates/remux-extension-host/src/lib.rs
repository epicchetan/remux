#![doc = include_str!("../README.md")]

use std::ffi::OsStr;
use std::path::Path;
use std::process::{Child, Command, Stdio};

/// Thin launch helper for a workload declared by the owning Remux extension.
pub struct WorkloadCommand {
    workload: String,
    operation: String,
    threads: Option<usize>,
    program: String,
    args: Vec<String>,
    command: Command,
}

impl WorkloadCommand {
    pub fn new(workload: impl Into<String>, program: impl Into<String>) -> Self {
        let program = program.into();
        Self {
            workload: workload.into(),
            operation: format!("operation:{}", std::process::id()),
            threads: None,
            command: Command::new(wrapper()),
            program,
            args: Vec::new(),
        }
    }

    pub fn operation(mut self, operation: impl Into<String>) -> Self {
        self.operation = operation.into();
        self
    }

    pub fn threads(mut self, threads: usize) -> Self {
        self.threads = Some(threads);
        self
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn current_dir(mut self, path: impl AsRef<Path>) -> Self {
        self.command.current_dir(path);
        self
    }

    pub fn env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        self.command.env(key, value);
        self
    }

    pub fn stdin(mut self, stdin: Stdio) -> Self {
        self.command.stdin(stdin);
        self
    }

    pub fn stdout(mut self, stdout: Stdio) -> Self {
        self.command.stdout(stdout);
        self
    }

    pub fn stderr(mut self, stderr: Stdio) -> Self {
        self.command.stderr(stderr);
        self
    }

    pub fn spawn(mut self) -> std::io::Result<Child> {
        self.command
            .args(["workload", "exec", "--workload", &self.workload])
            .args(["--operation", &self.operation]);
        if let Some(threads) = self.threads {
            self.command.args(["--threads", &threads.to_string()]);
        }
        self.command
            .arg("--")
            .arg(&self.program)
            .args(&self.args)
            .spawn()
    }
}

fn wrapper() -> String {
    std::env::var("REMUX_WORKLOAD_EXEC").unwrap_or_else(|_| "remux".to_string())
}
