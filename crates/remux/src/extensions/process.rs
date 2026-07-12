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
use crate::resource::{ResourceClass, ResourcePlacement};

const MAX_EXTENSION_LINE_BYTES: usize = 16 * 1024 * 1024;

pub enum StdinCommand {
    Line(String),
    /// Drop ChildStdin so the extension sees EOF.
    Close,
}

pub struct SpawnedChild {
    pub child: Child,
    pub pid: u32,
    /// Process-group id — equals `pid` because the child is spawned as a
    /// group leader (`process_group(0)`). Group signals reach grandchildren.
    pub pgid: u32,
    pub stdin: mpsc::Sender<StdinCommand>,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

/// L3 spawn hardening shared by server and build processes: the child leads
/// a fresh process group (so kill escalation can reach grandchildren) and
/// takes `PDEATHSIG(SIGKILL)` (so an abrupt worker death kills the direct
/// child even without `kill_on_drop` running).
pub fn harden_command(command: &mut Command) -> &mut Command {
    command.process_group(0);
    unsafe {
        command.pre_exec(|| {
            nix::sys::prctl::set_pdeathsig(nix::sys::signal::Signal::SIGKILL)
                .map_err(std::io::Error::from)
        });
    }
    command
}

/// Spawns the extension server process with piped stdio, `kill_on_drop`, and
/// the L3 hardening above, and starts the dedicated stdin writer task.
pub fn spawn_extension(
    spec: &ServerSpec,
    placement: &ResourcePlacement,
    media_dir: Option<&std::path::Path>,
    on_write_error: impl Fn(String) + Send + 'static,
) -> std::io::Result<SpawnedChild> {
    let mut command =
        placement.configure_command(&spec.command, &spec.args, &spec.cwd, ResourceClass::Server);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(media_dir) = media_dir {
        command.env("REMUX_MEDIA_DIR", media_dir);
    }
    let mut child = harden_command(&mut command).spawn()?;

    let pid = child.id().unwrap_or_default();
    let mut stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let (stdin_tx, mut stdin_rx) = mpsc::channel::<StdinCommand>(128);
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
        pgid: pid,
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
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        let available = match reader.fill_buf().await {
            Ok(available) => available,
            Err(_) => return,
        };
        if available.is_empty() {
            if !line.is_empty() {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if let Ok(text) = String::from_utf8(std::mem::take(&mut line)) {
                    on_line(text);
                }
            }
            return;
        }

        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if line.len().saturating_add(newline) > MAX_EXTENSION_LINE_BYTES {
                return;
            }
            line.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Ok(text) = String::from_utf8(std::mem::take(&mut line)) {
                on_line(text);
            } else {
                return;
            }
            continue;
        }

        if line.len().saturating_add(available.len()) > MAX_EXTENSION_LINE_BYTES {
            return;
        }
        let consumed = available.len();
        line.extend_from_slice(available);
        reader.consume(consumed);
    }
}

/// Best-effort SIGTERM by pid (SIGKILL goes through `Child::start_kill`).
pub fn send_sigterm(pid: u32) {
    let _ = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid as i32),
        nix::sys::signal::Signal::SIGTERM,
    );
}

/// Best-effort group signal. Refuses pgid ≤ 1 and our own group — a stale or
/// corrupt pgid must never fan out to the session or the runtime itself.
pub fn signal_group(pgid: u32, signal: nix::sys::signal::Signal) {
    if !group_signal_allowed(pgid) {
        return;
    }
    let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pgid as i32), signal);
}

/// True while any member of the group is alive (signal-0 probe).
pub fn group_alive(pgid: u32) -> bool {
    if !group_signal_allowed(pgid) {
        return false;
    }
    nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pgid as i32), None).is_ok()
}

fn group_signal_allowed(pgid: u32) -> bool {
    pgid > 1
        && pgid != std::process::id()
        && nix::unistd::getpgrp() != nix::unistd::Pid::from_raw(pgid as i32)
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
