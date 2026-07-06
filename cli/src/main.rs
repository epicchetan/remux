//! `remux start` entrypoint. Without `REMUX_WORKER=1` this process is the L1
//! supervisor; with it, the runtime worker.

fn main() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("start") {
        eprintln!("Usage: remux start");
        std::process::exit(1);
    }

    if remux::supervise::is_worker_process() {
        let runtime = match tokio::runtime::Runtime::new() {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("remux: failed to start async runtime: {error}");
                std::process::exit(1);
            }
        };
        match runtime.block_on(remux::runtime::run_worker()) {
            Ok(code) => std::process::exit(code),
            Err(message) => {
                eprintln!("{message}");
                std::process::exit(1);
            }
        }
    }

    std::process::exit(remux::supervise::supervise());
}
