mod app_notifications;
mod app_server;
mod composer_config;
mod file_resources;
mod history;
mod item_identity;
mod live_transcript;
mod projection;
mod resource_invalidations;
mod resources;
mod server;
mod thread_commands;
mod thread_composer_state;
mod thread_resources;
mod thread_runtime;
mod thread_usage;
mod transcript;
mod util;

use std::collections::HashMap;
use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::app_notifications::notification_for_app_server_notification;
use crate::app_server::{AppServerEvent, AppServerEventSink, AppServerRuntime};
use crate::composer_config::ComposerConfigStore;
use crate::file_resources::CodexFileResourcesServer;
use crate::live_transcript::LiveTranscriptStore;
use crate::resource_invalidations::{
    invalidations_for_app_server_notification, resources_invalidated_notification,
};
use crate::resources::{CodexTranscriptServer, ValidationOptions};
use crate::server::{JsonRpcError, JsonRpcRequest, JsonRpcResponse};
use crate::thread_commands::CodexThreadCommandServer;
use crate::thread_resources::CodexThreadResourcesServer;
use crate::thread_runtime::ThreadRuntimeStore;
use crate::thread_usage::ThreadUsageStore;

const FILES_METHOD: &str = "remux/codex/files";
const COMPOSER_CONFIG_READ_METHOD: &str = "remux/codex/composer/config/read";
const COMPOSER_CONFIG_WRITE_METHOD: &str = "remux/codex/composer/config/write";
const TRANSCRIPT_RESOURCES_READ_METHOD: &str = "remux/codex/transcript/resources/read";
const THREAD_RESOURCES_READ_METHOD: &str = "remux/codex/thread/resources/read";
const THREAD_COMPACT_METHOD: &str = "remux/codex/thread/compact";
const THREAD_MESSAGE_EDIT_METHOD: &str = "remux/codex/thread/message/edit";
const THREAD_MESSAGE_FORK_METHOD: &str = "remux/codex/thread/message/fork";
const THREAD_MESSAGE_SEND_METHOD: &str = "remux/codex/thread/message/send";
const THREAD_MESSAGE_START_METHOD: &str = "remux/codex/thread/message/start";
const THREAD_TURN_INTERRUPT_METHOD: &str = "remux/codex/thread/turn/interrupt";
const PREVIEW_INVALIDATE_NOTIFICATION: &str = "remux/previews/invalidate";
// Preview invalidations tell clients a thread's rendered content changed so
// they can refresh tab screenshots. Streaming updates are throttled per
// thread; turn boundaries always emit so the final state is never missed.
const PREVIEW_INVALIDATE_MIN_INTERVAL: Duration = Duration::from_millis(1_000);

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.get(1).is_some_and(|value| value == "validate") {
        if let Err(error) = run_validate(&args[2..]) {
            eprintln!("validation failed: {error}");
            std::process::exit(1);
        }
        return;
    }

    if let Err(error) = run_stdio_server() {
        eprintln!("server failed: {error}");
        std::process::exit(1);
    }
}

fn run_stdio_server() -> Result<(), String> {
    let stdin = io::stdin();
    let (output_tx, output_rx) = mpsc::channel::<Value>();
    spawn_stdout_writer(output_rx);
    let mut server = CodexExtensionServer::new(default_codex_home(), output_tx.clone());

    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(request) => handle_request(&mut server, request),
            Err(error) => JsonRpcResponse::error(
                Value::Null,
                JsonRpcError::new(-32700, format!("Parse error: {error}")),
            ),
        };

        let response = serde_json::to_value(response).map_err(|error| error.to_string())?;
        output_tx
            .send(response)
            .map_err(|error| format!("failed to write response: {error}"))?;
    }

    Ok(())
}

fn handle_request(server: &mut CodexExtensionServer, request: JsonRpcRequest) -> JsonRpcResponse {
    let result = match request.method.as_str() {
        FILES_METHOD => server
            .files
            .read_resources(request.params.unwrap_or(Value::Null)),
        COMPOSER_CONFIG_READ_METHOD => server.composer_config.read_config(),
        COMPOSER_CONFIG_WRITE_METHOD => server
            .composer_config
            .write_config(request.params.unwrap_or(Value::Null)),
        TRANSCRIPT_RESOURCES_READ_METHOD => server
            .transcript
            .read_resources(request.params.unwrap_or(Value::Null)),
        THREAD_RESOURCES_READ_METHOD => server
            .threads
            .read_resources(request.params.unwrap_or(Value::Null)),
        THREAD_COMPACT_METHOD => server
            .thread_commands
            .compact_thread(request.params.unwrap_or(Value::Null)),
        THREAD_MESSAGE_EDIT_METHOD => server
            .thread_commands
            .edit_message(request.params.unwrap_or(Value::Null)),
        THREAD_MESSAGE_FORK_METHOD => server
            .thread_commands
            .fork_message(request.params.unwrap_or(Value::Null)),
        THREAD_MESSAGE_SEND_METHOD => server
            .thread_commands
            .send_message(request.params.unwrap_or(Value::Null)),
        THREAD_MESSAGE_START_METHOD => server
            .thread_commands
            .start_message(request.params.unwrap_or(Value::Null)),
        THREAD_TURN_INTERRUPT_METHOD => server
            .thread_commands
            .interrupt_turn(request.params.unwrap_or(Value::Null)),
        _ => {
            return JsonRpcResponse::error(
                request.id,
                JsonRpcError::new(-32601, format!("Unknown method: {}", request.method)),
            );
        }
    };

    match result {
        Ok(value) => JsonRpcResponse::result(request.id, value),
        Err(error) => JsonRpcResponse::error(request.id, JsonRpcError::new(-32000, error)),
    }
}

struct CodexExtensionServer {
    composer_config: ComposerConfigStore,
    files: CodexFileResourcesServer,
    thread_commands: CodexThreadCommandServer,
    threads: CodexThreadResourcesServer,
    transcript: CodexTranscriptServer,
}

impl CodexExtensionServer {
    fn new(codex_home: PathBuf, output_tx: mpsc::Sender<Value>) -> Self {
        let (event_sink, event_rx) = AppServerEventSink::channel();
        let composer_config =
            ComposerConfigStore::new(codex_home.join("remux").join("composer-config.json"));
        let live_transcript = LiveTranscriptStore::default();
        let thread_runtime = ThreadRuntimeStore::default();
        let thread_usage = ThreadUsageStore::default();
        spawn_app_server_event_forwarder(
            event_rx,
            output_tx,
            live_transcript.clone(),
            thread_runtime.clone(),
            thread_usage.clone(),
        );
        let app_server = AppServerRuntime::new_with_event_sink(codex_home.clone(), event_sink);
        Self {
            composer_config: composer_config.clone(),
            files: CodexFileResourcesServer::new(),
            thread_commands: CodexThreadCommandServer::new(
                app_server.clone(),
                composer_config.clone(),
                live_transcript.clone(),
                thread_runtime.clone(),
                codex_home.clone(),
            ),
            threads: CodexThreadResourcesServer::new(
                app_server,
                composer_config,
                thread_runtime,
                thread_usage,
            ),
            transcript: CodexTranscriptServer::new_with_live_transcript(
                codex_home,
                live_transcript,
            ),
        }
    }
}

fn spawn_stdout_writer(output_rx: mpsc::Receiver<Value>) {
    thread::spawn(move || {
        let mut stdout = io::stdout();
        for message in output_rx {
            if serde_json::to_writer(&mut stdout, &message).is_err() {
                break;
            }
            if stdout.write_all(b"\n").is_err() {
                break;
            }
            if stdout.flush().is_err() {
                break;
            }
        }
    });
}

fn spawn_app_server_event_forwarder(
    event_rx: mpsc::Receiver<AppServerEvent>,
    output_tx: mpsc::Sender<Value>,
    live_transcript: LiveTranscriptStore,
    thread_runtime: ThreadRuntimeStore,
    thread_usage: ThreadUsageStore,
) {
    thread::spawn(move || {
        let mut preview_invalidated_at: HashMap<String, Instant> = HashMap::new();
        for event in event_rx {
            let AppServerEvent::Notification(notification) = event else {
                continue;
            };
            let live_effect = live_transcript.record_notification(&notification);
            thread_runtime.record_notification(&notification);
            thread_usage.record_notification(&notification);
            let invalidations = invalidations_for_app_server_notification(
                &notification,
                live_effect.canonical_item_id.as_deref(),
                &live_effect.rekeyed_item_ids,
            );
            let projected_turn = completed_turn_target(&notification)
                .and_then(|(thread_id, turn_id)| live_transcript.projected_turn(thread_id, turn_id))
                .map(|projected| projected.turn);
            if let Some(notification_intent) =
                notification_for_app_server_notification(&notification, projected_turn.as_ref())
            {
                let _ = output_tx.send(notification_intent);
            }

            if !invalidations.is_empty() {
                let preview_threads = preview_invalidation_threads(
                    &invalidations,
                    is_turn_boundary(&notification),
                    &mut preview_invalidated_at,
                );
                let _ = output_tx.send(resources_invalidated_notification(invalidations));
                for thread_id in preview_threads {
                    let _ = output_tx.send(preview_invalidate_notification(&thread_id));
                }
            }
        }
    });
}

fn is_turn_boundary(notification: &Value) -> bool {
    matches!(
        notification.get("method").and_then(Value::as_str),
        Some("turn/started" | "turn/completed" | "turn/failed" | "turn/aborted")
    )
}

fn preview_invalidation_threads(
    invalidations: &[Value],
    turn_boundary: bool,
    invalidated_at: &mut HashMap<String, Instant>,
) -> Vec<String> {
    let now = Instant::now();
    let mut thread_ids = Vec::new();
    for invalidation in invalidations {
        let Some(thread_id) = invalidation.get("threadId").and_then(Value::as_str) else {
            continue;
        };
        if thread_ids.iter().any(|seen| seen == thread_id) {
            continue;
        }

        let due = turn_boundary
            || invalidated_at
                .get(thread_id)
                .is_none_or(|at| now.duration_since(*at) >= PREVIEW_INVALIDATE_MIN_INTERVAL);
        if due {
            invalidated_at.insert(thread_id.to_owned(), now);
            thread_ids.push(thread_id.to_owned());
        }
    }

    thread_ids
}

fn preview_invalidate_notification(thread_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": PREVIEW_INVALIDATE_NOTIFICATION,
        "params": {
            "resourceId": thread_id,
            "resourceKind": "thread",
            "viewId": "main",
        },
    })
}

fn completed_turn_target(notification: &Value) -> Option<(&str, &str)> {
    if notification.get("method").and_then(Value::as_str) != Some("turn/completed") {
        return None;
    }

    let params = notification.get("params")?;
    let thread_id = params.get("threadId").and_then(Value::as_str)?;
    let turn_id = params
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)?;
    Some((thread_id, turn_id))
}

fn run_validate(args: &[String]) -> Result<(), String> {
    let mut codex_home = default_codex_home();
    let mut limit = 100usize;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--codex-home" => {
                index += 1;
                let value = args.get(index).ok_or("--codex-home requires a value")?;
                codex_home = PathBuf::from(value);
            }
            "--limit" => {
                index += 1;
                let value = args.get(index).ok_or("--limit requires a value")?;
                limit = value.parse::<usize>().map_err(|error| error.to_string())?;
            }
            "--help" | "-h" => {
                println!("usage: remux-codex-server validate [--codex-home PATH] [--limit N]");
                return Ok(());
            }
            unknown => return Err(format!("unknown validate argument: {unknown}")),
        }
        index += 1;
    }

    let mut server = CodexTranscriptServer::new(codex_home);
    let report = server.validate_real_transcripts(ValidationOptions { limit })?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!(report)).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn default_codex_home() -> PathBuf {
    if let Ok(value) = env::var("CODEX_HOME") {
        if !value.is_empty() {
            return PathBuf::from(value);
        }
    }

    if let Ok(home) = env::var("HOME") {
        return PathBuf::from(home).join(".codex");
    }

    PathBuf::from(".codex")
}
