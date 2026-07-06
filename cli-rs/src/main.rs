fn main() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("start") {
        eprintln!("Usage: remux start");
        std::process::exit(1);
    }

    // Supervisor/worker dispatch lands with runtime.rs + supervise.rs.
    eprintln!("remux: Rust runtime is not wired up yet");
    std::process::exit(1);
}
