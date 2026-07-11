//! Scriptable fixture extension server for integration/chaos tests.
//!
//! Speaks newline-delimited JSON-RPC on stdio. Behaviors are selected by
//! environment variables:
//!
//! - `FIXTURE_EXIT_AFTER_MS` (+ optional `FIXTURE_EXIT_CODE`): exit after N ms.
//! - `FIXTURE_CRASH_ON_START=1`: exit(3) immediately.
//! - `FIXTURE_IGNORE_EOF=1`: keep running after stdin EOF.
//! - `FIXTURE_IGNORE_SIGTERM=1`: ignore SIGTERM.
//! - `FIXTURE_STDERR=<text>`: write a stderr line at startup.
//! - `FIXTURE_SPAM_NOTIFICATIONS=1`: emit notifications continuously.
//! - `FIXTURE_STARTUP_NOTIFICATION=<method>`: emit one notification at boot.
//! - `FIXTURE_SPAWN_CHILD=1`: spawn a long-lived grandchild (`sleep 300`) and
//!   print `child:<pid>` to stderr — the L3 group-kill test subject.
//!
//! Methods: `fixture/echo` (echoes params), `fixture/block` (never responds),
//! `fixture/crash` (exits with `params.code`), `fixture/stderr` (writes
//! `params.line` to stderr), `fixture/garbage` (emits invalid stdout lines,
//! then responds).

use std::io::{BufRead, Write};

fn env_flag(name: &str) -> bool {
    std::env::var(name).map(|value| value == "1").unwrap_or(false)
}

fn emit(message: serde_json::Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{message}");
    let _ = stdout.flush();
}

fn main() {
    // Behaviors are usually passed as KEY=VALUE args (manifests carry args,
    // not env) and promoted to env vars here.
    for arg in std::env::args().skip(1) {
        if let Some((key, value)) = arg.split_once('=') {
            std::env::set_var(key, value);
        }
    }

    if env_flag("FIXTURE_CRASH_ON_START") {
        eprintln!("fixture: crashing on start");
        std::process::exit(3);
    }

    if env_flag("FIXTURE_IGNORE_SIGTERM") {
        unsafe {
            let _ = nix::sys::signal::signal(
                nix::sys::signal::Signal::SIGTERM,
                nix::sys::signal::SigHandler::SigIgn,
            );
        }
    }

    if let Ok(line) = std::env::var("FIXTURE_STDERR") {
        eprintln!("{line}");
    }

    if env_flag("FIXTURE_SPAWN_CHILD") {
        match std::process::Command::new("sleep").arg("300").spawn() {
            Ok(child) => eprintln!("child:{}", child.id()),
            Err(error) => eprintln!("child-spawn-failed:{error}"),
        }
    }

    if let Ok(ms) = std::env::var("FIXTURE_EXIT_AFTER_MS") {
        let ms: u64 = ms.parse().unwrap_or(0);
        let code: i32 = std::env::var("FIXTURE_EXIT_CODE")
            .ok()
            .and_then(|code| code.parse().ok())
            .unwrap_or(1);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            std::process::exit(code);
        });
    }

    if let Ok(method) = std::env::var("FIXTURE_STARTUP_NOTIFICATION") {
        emit(serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": { "from": "fixture" },
        }));
    }

    if env_flag("FIXTURE_SPAM_NOTIFICATIONS") {
        std::thread::spawn(|| loop {
            emit(serde_json::json!({
                "jsonrpc": "2.0",
                "method": "fixture/spam",
                "params": { "at": "now" },
            }));
            std::thread::sleep(std::time::Duration::from_millis(1));
        });
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let id = message.get("id").cloned();
        let method = message
            .get("method")
            .and_then(|method| method.as_str())
            .unwrap_or_default()
            .to_string();
        let params = message.get("params").cloned();

        match method.as_str() {
            "fixture/block" => {}
            "fixture/crash" => {
                let code = params
                    .as_ref()
                    .and_then(|params| params.get("code"))
                    .and_then(|code| code.as_i64())
                    .unwrap_or(9) as i32;
                std::process::exit(code);
            }
            "fixture/stderr" => {
                let text = params
                    .as_ref()
                    .and_then(|params| params.get("line"))
                    .and_then(|line| line.as_str())
                    .unwrap_or("fixture stderr");
                eprintln!("{text}");
                if let Some(id) = id {
                    emit(serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "ok": true } }));
                }
            }
            "fixture/garbage" => {
                println!("this is not json");
                println!("{{\"partial\":");
                if let Some(id) = id {
                    emit(serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "ok": true } }));
                }
            }
            "fixture/fail" => {
                if let Some(id) = id {
                    emit(serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32001, "message": "fixture failure" },
                    }));
                }
            }
            "fixture/notify" => {
                let mut notification = serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": params
                        .as_ref()
                        .and_then(|params| params.get("method"))
                        .and_then(|method| method.as_str())
                        .unwrap_or("remux/notifications/request"),
                    "params": { "intent": "test" },
                });
                if let Some(origin) = params
                    .as_ref()
                    .and_then(|params| params.get("targetOrigin"))
                    .and_then(|origin| origin.as_str())
                {
                    notification["remuxTarget"] = serde_json::json!({ "origin": origin });
                }
                emit(notification);
                if let Some(id) = id {
                    emit(serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "sent": true } }));
                }
            }
            _ => {
                if let Some(id) = id {
                    emit(serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "echo": method, "params": params },
                    }));
                }
            }
        }
    }

    // stdin EOF: exit like the real servers, unless told to misbehave.
    if env_flag("FIXTURE_IGNORE_EOF") {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    }
}
