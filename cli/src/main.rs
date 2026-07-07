//! `remux start` entrypoint. Without `REMUX_WORKER=1` this process is the L1
//! supervisor; with it, the runtime worker.

fn main() {
    let usage = || -> ! {
        eprintln!("Usage: remux start [--rebuild]");
        std::process::exit(1);
    };

    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("start") {
        usage();
    }
    let rebuild = match args.next().as_deref() {
        None => false,
        Some("--rebuild") => true,
        Some(_) => usage(),
    };
    if args.next().is_some() {
        usage();
    }

    if remux::supervise::is_worker_process() {
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

    std::process::exit(remux::supervise::supervise(rebuild));
}
