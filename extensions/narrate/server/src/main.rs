mod narration;
mod planning;
mod source_mapping;
mod synthesis_profile;
mod util;

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, mpsc};

use remux_compute::Registry as ComputeRegistry;
use remux_extension_rpc::Peer as ExtensionRpcPeer;
use remux_tts::KokoroSynthesis;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::narration::NarrationServer;

const START_METHOD: &str = "remux/narrate/narration/start";
const READ_METHOD: &str = "remux/narrate/narration/resources/read";
const AUDIO_READ_METHOD: &str = "remux/narrate/narration/audio/read";
const CANCEL_METHOD: &str = "remux/narrate/narration/cancel";
const DIAGNOSTICS_READ_METHOD: &str = "remux/narrate/narration/diagnostics/read";
const OUTPUT_QUEUE_CAPACITY: usize = 256;

#[derive(Debug, Deserialize)]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

fn main() {
    let compute = match ComputeRegistry::new().register::<KokoroSynthesis>() {
        Ok(compute) => compute,
        Err(error) => {
            eprintln!("compute registration failed: {error}");
            std::process::exit(1);
        }
    };
    match compute.dispatch_worker_if_requested() {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            eprintln!("compute worker failed: {error}");
            std::process::exit(1);
        }
    }
    if let Err(error) = run(compute) {
        eprintln!("server failed: {error}");
        std::process::exit(1);
    }
}

fn run(compute: ComputeRegistry) -> Result<(), String> {
    let (output_tx, output_rx) = mpsc::sync_channel::<Value>(OUTPUT_QUEUE_CAPACITY);
    spawn_stdout_writer(output_rx);
    let host_rpc = ExtensionRpcPeer::new("narrate", {
        let output_tx = output_tx.clone();
        move |message| {
            output_tx
                .send(message)
                .map_err(|error| format!("failed to write host RPC request: {error}"))
        }
    });
    let server = Arc::new(NarrationServer::new(
        remux_root(),
        codex_home(),
        output_tx.clone(),
        host_rpc.clone(),
        compute,
    ));
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(error) => {
                send_error(
                    &output_tx,
                    Value::Null,
                    -32700,
                    format!("Parse error: {error}"),
                )?;
                continue;
            }
        };
        if host_rpc.resolve(&message) {
            continue;
        }
        let request: Request = match serde_json::from_value(message) {
            Ok(request) => request,
            Err(error) => {
                send_error(
                    &output_tx,
                    Value::Null,
                    -32600,
                    format!("Invalid request: {error}"),
                )?;
                continue;
            }
        };
        let server = server.clone();
        let output_tx = output_tx.clone();
        std::thread::spawn(move || {
            let result = match request.method.as_str() {
                START_METHOD => server.start(request.params.unwrap_or(Value::Null)),
                READ_METHOD => server.read(request.params.unwrap_or(Value::Null)),
                AUDIO_READ_METHOD => server.read_audio(request.params.unwrap_or(Value::Null)),
                CANCEL_METHOD => server.cancel(request.params.unwrap_or(Value::Null)),
                DIAGNOSTICS_READ_METHOD => server.read_diagnostics(),
                _ => {
                    let _ = send_error(
                        &output_tx,
                        request.id,
                        -32601,
                        format!("Unknown method: {}", request.method),
                    );
                    return;
                }
            };
            let message = match result {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": request.id, "result": result }),
                Err(error) => json!({
                    "jsonrpc": "2.0",
                    "id": request.id,
                    "error": { "code": -32000, "message": error },
                }),
            };
            let _ = output_tx.send(message);
        });
    }
    Ok(())
}

fn send_error(
    output_tx: &mpsc::SyncSender<Value>,
    id: Value,
    code: i64,
    message: String,
) -> Result<(), String> {
    output_tx
        .send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }))
        .map_err(|error| error.to_string())
}

fn spawn_stdout_writer(output_rx: mpsc::Receiver<Value>) {
    std::thread::spawn(move || {
        let mut stdout = io::stdout();
        for message in output_rx {
            if serde_json::to_writer(&mut stdout, &message).is_err()
                || stdout.write_all(b"\n").is_err()
                || stdout.flush().is_err()
            {
                break;
            }
        }
    });
}

fn remux_root() -> PathBuf {
    std::env::var_os("REMUX_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}
