//! Pass 3b CLI surface from `docs/specs/cli-rust-port-pass-3b-cli.md`.
//!
//! The binary owns clap parsing; this module keeps the root-aware subcommand
//! implementations together so they can share systemd, install, log, and
//! status helpers without expanding `main.rs` back into a dispatcher.

pub mod doctor;
pub mod install;
pub mod logs;
pub mod root;
pub mod status;
pub mod systemd;
pub mod workload;

use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "remux", about = "Manage the Remux runtime")]
pub struct Cli {
    /// Remux repository/runtime root.
    #[arg(long, global = true, value_name = "DIR")]
    pub root: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Start the runtime, delegating to systemd when installed.
    Start {
        /// Run the L1 supervisor in this terminal.
        #[arg(long)]
        foreground: bool,
        /// Force extension server rebuilds on worker start.
        #[arg(long)]
        rebuild: bool,
    },
    /// Stop the installed systemd user service.
    Stop,
    /// Restart the installed systemd user service, picking up a fresh binary.
    Restart,
    /// Show systemd, runtime, resource, and extension status.
    Status {
        /// Emit one JSON object for scripts.
        #[arg(long)]
        json: bool,
    },
    /// Read runtime or extension log files directly.
    Logs {
        /// Extension id. Omit for the newest runtime JSONL log.
        extension: Option<String>,
        /// Number of lines to print before following.
        #[arg(short = 'n', default_value_t = 100)]
        lines: usize,
        /// Continue polling and printing appended lines.
        #[arg(short = 'f', long)]
        follow: bool,
        /// Print runtime JSONL without pretty formatting.
        #[arg(long)]
        raw: bool,
    },
    /// Run read-only diagnostics.
    Doctor,
    /// Install the PATH symlink and systemd user unit.
    Install,
    /// Print the bearer token used for pairing.
    Token,
    /// Run a declared extension workload in its managed resource scope.
    Workload {
        #[command(subcommand)]
        command: WorkloadCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum WorkloadCommand {
    /// Print resource capacity available to extension workloads.
    Capacity,
    /// List active and recently completed workload scopes.
    Status {
        #[arg(long)]
        extension: Option<String>,
    },
    /// Freeze a running workload operation.
    Pause { operation: String },
    /// Thaw a frozen workload operation.
    Resume { operation: String },
    /// Stop a workload operation and its descendants.
    Stop { operation: String },
    /// Replace this process with a command in a declared workload scope.
    Exec {
        #[arg(long)]
        workload: String,
        #[arg(long)]
        operation: String,
        #[arg(long)]
        threads: Option<usize>,
        #[arg(last = true, required = true)]
        command: Vec<String>,
    },
}

pub fn run(cli: Cli) -> i32 {
    match run_inner(cli) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("remux: {message}");
            1
        }
    }
}

fn run_inner(cli: Cli) -> Result<i32, String> {
    match cli.command {
        Command::Start {
            foreground,
            rebuild,
        } => {
            let root = root::discover(cli.root.as_deref())?;
            start(root, foreground, rebuild)
        }
        Command::Stop => {
            let root = root::discover(cli.root.as_deref())?;
            systemd::stop(&root)
        }
        Command::Restart => {
            let root = root::discover(cli.root.as_deref())?;
            systemd::restart(&root)
        }
        Command::Status { json } => {
            let root = root::discover(cli.root.as_deref())?;
            status::run(&root, json)
        }
        Command::Logs {
            extension,
            lines,
            follow,
            raw,
        } => {
            let root = root::discover(cli.root.as_deref())?;
            logs::run(&root, extension.as_deref(), lines, follow, raw)
        }
        Command::Doctor => doctor::run(cli.root.as_deref()),
        Command::Install => {
            let root = root::discover(cli.root.as_deref())?;
            install::run(&root)
        }
        Command::Token => {
            let root = root::discover(cli.root.as_deref())?;
            let token = crate::auth::token_command(&root)?;
            println!("{token}");
            Ok(0)
        }
        Command::Workload { command } => match command {
            WorkloadCommand::Capacity => workload::capacity(),
            WorkloadCommand::Status { extension } => workload::status(extension.as_deref()),
            WorkloadCommand::Pause { operation } => workload::control(&operation, "freeze"),
            WorkloadCommand::Resume { operation } => workload::control(&operation, "thaw"),
            WorkloadCommand::Stop { operation } => workload::control(&operation, "stop"),
            WorkloadCommand::Exec {
                workload,
                operation,
                threads,
                command,
            } => workload::exec(&workload, &operation, threads, &command),
        },
    }
}

fn start(root: PathBuf, foreground: bool, rebuild: bool) -> Result<i32, String> {
    match decide_start_mode(foreground, rebuild, systemd::unit_path()?.exists())? {
        StartMode::Foreground => Ok(crate::supervise::supervise(&root, rebuild)),
        StartMode::Delegate => systemd::start(&root),
        StartMode::ForegroundWithInstallHint => {
            println!(
                "remux install sets up the background systemd user service; running in foreground"
            );
            Ok(crate::supervise::supervise(&root, rebuild))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartMode {
    Foreground,
    Delegate,
    ForegroundWithInstallHint,
}

fn decide_start_mode(
    foreground: bool,
    rebuild: bool,
    unit_exists: bool,
) -> Result<StartMode, String> {
    if foreground {
        return Ok(StartMode::Foreground);
    }
    if unit_exists {
        if rebuild {
            return Err("--rebuild needs --foreground; extension builds also rerun automatically when binaries are missing, and Settings -> Restart rebuilds changed sources".to_string());
        }
        return Ok(StartMode::Delegate);
    }
    Ok(StartMode::ForegroundWithInstallHint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn parses_subcommands_and_global_root() {
        let cli =
            Cli::try_parse_from(["remux", "--root", "/tmp/remux", "status", "--json"]).unwrap();
        assert_eq!(cli.root, Some(PathBuf::from("/tmp/remux")));
        assert!(matches!(cli.command, Command::Status { json: true }));

        let cli = Cli::try_parse_from([
            "remux", "logs", "terminal", "-n", "12", "-f", "--raw", "--root", "/repo",
        ])
        .unwrap();
        assert_eq!(cli.root, Some(PathBuf::from("/repo")));
        match cli.command {
            Command::Logs {
                extension,
                lines,
                follow,
                raw,
            } => {
                assert_eq!(extension.as_deref(), Some("terminal"));
                assert_eq!(lines, 12);
                assert!(follow);
                assert!(raw);
            }
            other => panic!("unexpected command: {other:?}"),
        }

        let cli = Cli::try_parse_from(["remux", "start", "--foreground", "--rebuild"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Start {
                foreground: true,
                rebuild: true
            }
        ));
    }

    #[test]
    fn start_mode_rejects_rebuild_only_when_delegating() {
        assert_eq!(
            decide_start_mode(true, true, true).unwrap(),
            StartMode::Foreground
        );
        assert_eq!(
            decide_start_mode(true, false, true).unwrap(),
            StartMode::Foreground
        );
        assert_eq!(
            decide_start_mode(false, false, true).unwrap(),
            StartMode::Delegate
        );
        assert_eq!(
            decide_start_mode(false, false, false).unwrap(),
            StartMode::ForegroundWithInstallHint
        );
        assert!(decide_start_mode(false, true, true)
            .unwrap_err()
            .contains("--rebuild needs --foreground"));
        assert_eq!(
            decide_start_mode(false, true, false).unwrap(),
            StartMode::ForegroundWithInstallHint
        );
    }
}
