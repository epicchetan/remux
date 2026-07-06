//! Low-level extension child process I/O.
//!
//! The structural fix for the EPIPE incident lives here: **all** stdin writes
//! go through one writer task fed by a channel. A pipe write error is logged
//! and the frame dropped — there is no code path where it can surface as an
//! unhandled event and take the runtime down. Closing the channel drops
//! `ChildStdin`, which is the stop sequence's EOF signal (and, with `cargo
//! run` manifests, the only shutdown signal that reaches the grandchild).

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::mpsc;

use crate::extensions::manifest::ServerSpec;

pub enum StdinCommand {
    Line(String),
    /// Drop ChildStdin so the extension sees EOF.
    Close,
}

pub struct SpawnedChild {
    pub child: Child,
    pub pid: u32,
    pub stdin: mpsc::UnboundedSender<StdinCommand>,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

/// Spawns the extension server process with piped stdio and `kill_on_drop`
/// (worker death takes the direct child with it — cheap insurance until full
/// L3), and starts the dedicated stdin writer task.
pub fn spawn_extension(
    spec: &ServerSpec,
    on_write_error: impl Fn(String) + Send + 'static,
) -> std::io::Result<SpawnedChild> {
    let mut child = Command::new(&spec.command)
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;

    let pid = child.id().unwrap_or_default();
    let mut stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<StdinCommand>();
    tokio::spawn(async move {
        while let Some(command) = stdin_rx.recv().await {
            match command {
                StdinCommand::Line(line) => {
                    if let Err(error) = stdin.write_all(line.as_bytes()).await {
                        on_write_error(error.to_string());
                        break;
                    }
                    if let Err(error) = stdin.flush().await {
                        on_write_error(error.to_string());
                        break;
                    }
                }
                StdinCommand::Close => break,
            }
        }
        // Dropping ChildStdin here delivers EOF.
    });

    Ok(SpawnedChild {
        child,
        pid,
        stdin: stdin_tx,
        stdout,
        stderr,
    })
}

/// Reads newline-delimited lines, invoking the callback per non-empty line;
/// resolves when the stream reaches EOF (process exit or stream error).
pub async fn read_lines<R>(reader: R, mut on_line: impl FnMut(String))
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        on_line(line);
    }
}

/// Best-effort SIGTERM by pid (SIGKILL goes through `Child::start_kill`).
pub fn send_sigterm(pid: u32) {
    let _ = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid as i32),
        nix::sys::signal::Signal::SIGTERM,
    );
}

/// Maps a wait status to `(code, signal_name)` like Node's `exit` event.
pub fn exit_parts(status: std::process::ExitStatus) -> (Option<i32>, Option<String>) {
    use std::os::unix::process::ExitStatusExt;
    let signal = status.signal().map(|signal| {
        nix::sys::signal::Signal::try_from(signal)
            .map(|signal| format!("{signal:?}"))
            .unwrap_or_else(|_| format!("signal {signal}"))
    });
    (status.code(), signal)
}
