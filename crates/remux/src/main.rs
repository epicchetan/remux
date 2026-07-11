//! clap entrypoint for pass 3b (`docs/specs/cli-rust-port-pass-3b-cli.md`).
//!
//! The `REMUX_WORKER` short-circuit must stay before clap parsing: worker
//! spawns are an internal supervisor contract, not part of the user CLI.

use clap::Parser;

fn main() {
    if remux::supervise::is_worker_process() {
        let rebuild = std::env::args().any(|arg| arg == "--rebuild");
        let runtime = match tokio::runtime::Runtime::new() {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("remux: failed to start async runtime: {error}");
                std::process::exit(1);
            }
        };
        match runtime.block_on(remux::runtime::run_worker(rebuild)) {
            Ok(code) => std::process::exit(code),
            Err(message) => {
                eprintln!("{message}");
                std::process::exit(1);
            }
        }
    }

    let cli = remux::cli::Cli::parse();
    std::process::exit(remux::cli::run(cli));
}
