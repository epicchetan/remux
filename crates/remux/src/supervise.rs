//! L1 supervisor: a std-only loop that keeps the worker alive.
//!
//! Replaces `bin/remux.js:41-60`, which only respawned on exit 75. Policy:
//! exit 75 → restart immediately (reset backoff); exit 0 → supervisor exits
//! 0; anything else (including signals) → restart after
//! `min(250ms × 2^n, 5s)`, with `n` reset once the worker stays up 60s.
//! Never gives up — the loop runs until the supervisor itself is signaled,
//! in which case the signal is forwarded and the worker gets 7s before
//! SIGKILL.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const REMUX_RESTART_EXIT_CODE: i32 = 75;
pub const WORKER_ENV: &str = "REMUX_WORKER";

/// True when this process was spawned as the worker by *its own* supervisor.
///
/// The marker carries the supervisor's PID rather than a bare `1`: shells
/// spawned inside a remux terminal session inherit the worker's environment,
/// so a user running `remux start` from one would otherwise become a bare
/// worker with no L1 supervisor above it.
pub fn is_worker_process() -> bool {
    let Ok(value) = std::env::var(WORKER_ENV) else {
        return false;
    };
    // Legacy `1` marker (inherited from a Node-era environment) is ignored;
    // only a matching parent PID counts.
    let Ok(supervisor_pid) = value.parse::<u32>() else {
        return false;
    };
    supervisor_pid > 1 && std::os::unix::process::parent_id() == supervisor_pid
}

const BACKOFF_BASE_MS: u64 = 250;
const BACKOFF_CAP_MS: u64 = 5_000;
const BACKOFF_RESET_UPTIME_MS: u64 = 60_000;
const SIGNAL_FORWARD_GRACE_MS: u64 = 7_000;
const POLL_MS: u64 = 50;

/// `rebuild` is forwarded to every worker spawn: with fresh artifacts a
/// re-run of the build phase is a fast no-op, and a crash-restarted worker
/// still honors the operator's intent.
pub fn supervise(root_dir: &Path, rebuild: bool) -> i32 {
    let guardian = match crate::config::load_remux_config(root_dir).and_then(|config| {
        let runtime = crate::config::load_runtime_values(None, None, &config)?;
        let port = config.guardian_port()?;
        Ok(crate::guardian::Guardian::start(
            root_dir,
            &runtime.host,
            port,
        ))
    }) {
        Ok(guardian) => guardian,
        Err(error) => {
            eprintln!("remux guardian configuration failed: {error}");
            crate::guardian::Guardian::start(
                root_dir,
                crate::config::DEFAULT_HOST,
                crate::config::DEFAULT_GUARDIAN_PORT,
            )
        }
    };
    let pending_signal = Arc::new(AtomicUsize::new(0));
    for signal in [signal_hook::consts::SIGINT, signal_hook::consts::SIGTERM] {
        let pending = pending_signal.clone();
        // usize::MAX is never a real signal number; 0 means "none pending".
        if let Err(error) = unsafe {
            signal_hook::low_level::register(signal, move || {
                pending.store(signal as usize, Ordering::SeqCst);
            })
        } {
            eprintln!("remux: failed to install signal handler: {error}");
        }
    }

    let exe = match crate::resource::systemd::remux_launcher_path() {
        Some(exe) => exe,
        None => {
            eprintln!("remux: cannot locate a live launcher executable");
            return 1;
        }
    };

    let mut backoff_exponent: u32 = 0;

    loop {
        let started_at = Instant::now();
        let mut command = std::process::Command::new(&exe);
        command
            .arg("start")
            .env(WORKER_ENV, std::process::id().to_string())
            .env(crate::resource::systemd::REMUX_WORKLOAD_EXEC_ENV, &exe)
            .env(crate::cli::root::REMUX_ROOT_ENV, root_dir);
        command.current_dir(root_dir);
        if rebuild {
            command.arg("--rebuild");
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                eprintln!("remux worker failed to start: {error}");
                return 1;
            }
        };
        guardian.set_worker_starting(child.id());

        let mut forwarded_at: Option<Instant> = None;
        let mut guardian_restart_requested = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(error) => {
                    eprintln!("remux: worker wait failed: {error}");
                    let _ = child.kill();
                    let _ = child.wait();
                    return 1;
                }
            }

            let signal = pending_signal.load(Ordering::SeqCst);
            if signal != 0 && forwarded_at.is_none() {
                forwarded_at = Some(Instant::now());
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(child.id() as i32),
                    nix::sys::signal::Signal::try_from(signal as i32)
                        .unwrap_or(nix::sys::signal::Signal::SIGTERM),
                );
            }
            if guardian.take_worker_restart() && !guardian_restart_requested {
                guardian_restart_requested = true;
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(child.id() as i32),
                    nix::sys::signal::Signal::SIGTERM,
                );
            }
            if let Some(at) = forwarded_at {
                if at.elapsed() > Duration::from_millis(SIGNAL_FORWARD_GRACE_MS) {
                    let _ = child.kill();
                }
            }

            std::thread::sleep(Duration::from_millis(POLL_MS));
        };

        let code = status.code();
        guardian.cleanup_ordinary_scopes();
        let uptime = started_at.elapsed();

        // Shutting down: exit with the worker's code.
        if forwarded_at.is_some() {
            return code.unwrap_or(0);
        }
        if guardian_restart_requested {
            backoff_exponent = 0;
            guardian.reset_worker_failures();
            eprintln!("remux: guardian requested worker restart");
            continue;
        }

        match code {
            Some(REMUX_RESTART_EXIT_CODE) => {
                backoff_exponent = 0;
                guardian.reset_worker_failures();
                eprintln!("remux: worker requested restart, restarting now");
                continue;
            }
            Some(0) => return 0,
            _ => {
                if uptime > Duration::from_millis(BACKOFF_RESET_UPTIME_MS) {
                    backoff_exponent = 0;
                }
                let delay = BACKOFF_CAP_MS
                    .min(BACKOFF_BASE_MS.saturating_mul(1 << backoff_exponent.min(10)));
                backoff_exponent = backoff_exponent.saturating_add(1);
                guardian.set_worker_backoff(
                    backoff_exponent,
                    crate::time::now_ms().saturating_add(delay as i64),
                );

                let description = match code {
                    Some(code) => format!("code {code}"),
                    None => describe_signal(&status),
                };
                eprintln!("remux: worker exited ({description}), restarting in {delay}ms");

                // Interruptible backoff sleep.
                let deadline = Instant::now() + Duration::from_millis(delay);
                while Instant::now() < deadline {
                    if pending_signal.load(Ordering::SeqCst) != 0 {
                        return 1;
                    }
                    std::thread::sleep(Duration::from_millis(POLL_MS));
                }
            }
        }
    }
}

fn describe_signal(status: &std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    match status.signal() {
        Some(signal) => nix::sys::signal::Signal::try_from(signal)
            .map(|signal| format!("{signal:?}"))
            .unwrap_or_else(|_| format!("signal {signal}")),
        None => "unknown".to_string(),
    }
}
