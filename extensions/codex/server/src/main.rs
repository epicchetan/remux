mod app_notifications;
mod app_server;
mod composer_config;
mod file_resources;
mod history;
mod item_identity;
mod live_transcript;
mod models;
mod narration;
mod narration_planning;
mod narration_source_mapping;
mod operation_queue;
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
use std::sync::{Arc, Mutex, mpsc};
use std::thread;

use serde_json::{Value, json};

use crate::app_notifications::notification_for_app_server_notification;
use crate::app_server::{AppServerEvent, AppServerEventSink, AppServerRuntime};
use crate::composer_config::ComposerConfigStore;
use crate::file_resources::CodexFileResourcesServer;
use crate::live_transcript::LiveTranscriptStore;
use crate::models::CodexModelsServer;
use crate::narration::CodexNarrationServer;
use crate::operation_queue::{CodexOperationQueueServer, PendingQueueStore};
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
const MODELS_READ_METHOD: &str = "remux/codex/models/read";
const NARRATION_AUDIO_READ_METHOD: &str = "remux/codex/narration/audio/read";
const NARRATION_CANCEL_METHOD: &str = "remux/codex/narration/cancel";
const NARRATION_DIAGNOSTICS_READ_METHOD: &str = "remux/codex/narration/diagnostics/read";
const NARRATION_READ_METHOD: &str = "remux/codex/narration/resources/read";
const NARRATION_START_METHOD: &str = "remux/codex/narration/start";
const TRANSCRIPT_RESOURCES_READ_METHOD: &str = "remux/codex/transcript/resources/read";
const THREAD_RESOURCES_READ_METHOD: &str = "remux/codex/thread/resources/read";
const THREAD_COMPACT_METHOD: &str = "remux/codex/thread/compact";
const THREAD_QUEUE_REMOVE_METHOD: &str = "remux/codex/thread/queue/remove";
const THREAD_QUEUE_RUN_NOW_METHOD: &str = "remux/codex/thread/queue/run-now";
const THREAD_MESSAGE_EDIT_METHOD: &str = "remux/codex/thread/message/edit";
const THREAD_MESSAGE_FORK_METHOD: &str = "remux/codex/thread/message/fork";
const THREAD_MESSAGE_SEND_METHOD: &str = "remux/codex/thread/message/send";
const THREAD_MESSAGE_START_METHOD: &str = "remux/codex/thread/message/start";
const THREAD_TURN_INTERRUPT_METHOD: &str = "remux/codex/thread/turn/interrupt";

const CODEX_OUTPUT_QUEUE_CAPACITY: usize = 256;
const CODEX_READ_WORKERS: usize = 4;
const CODEX_READ_QUEUE_CAPACITY: usize = 64;
const CODEX_MAX_THREAD_LANES: usize = 128;
const CODEX_THREAD_LANE_CAPACITY: usize = 32;
const CODEX_SINGLETON_LANE_CAPACITY: usize = 16;

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
    let (output_tx, output_rx) = mpsc::sync_channel::<Value>(CODEX_OUTPUT_QUEUE_CAPACITY);
    spawn_stdout_writer(output_rx);
    let server = Arc::new(CodexExtensionServer::new(
        default_codex_home(),
        output_tx.clone(),
    ));
    let dispatcher = CodexRequestDispatcher::new(server, output_tx.clone());

    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(request) => dispatcher.dispatch(request),
            Err(error) => send_response(
                &output_tx,
                JsonRpcResponse::error(
                    Value::Null,
                    JsonRpcError::new(-32700, format!("Parse error: {error}")),
                ),
            )?,
        }
    }

    Ok(())
}

fn handle_request(server: &CodexExtensionServer, request: JsonRpcRequest) -> JsonRpcResponse {
    let result = match request.method.as_str() {
        FILES_METHOD => server
            .files
            .read_resources(request.params.unwrap_or(Value::Null)),
        COMPOSER_CONFIG_READ_METHOD => server.composer_config.read_config(),
        COMPOSER_CONFIG_WRITE_METHOD => server
            .composer_config
            .write_config(request.params.unwrap_or(Value::Null)),
        MODELS_READ_METHOD => server.models.read_models(),
        NARRATION_AUDIO_READ_METHOD => server
            .narration
            .read_audio(request.params.unwrap_or(Value::Null)),
        NARRATION_CANCEL_METHOD => server
            .narration
            .cancel(request.params.unwrap_or(Value::Null)),
        NARRATION_DIAGNOSTICS_READ_METHOD => server.narration.read_diagnostics(),
        NARRATION_READ_METHOD => server.narration.read(request.params.unwrap_or(Value::Null)),
        NARRATION_START_METHOD => server
            .narration
            .start(request.params.unwrap_or(Value::Null)),
        TRANSCRIPT_RESOURCES_READ_METHOD => server
            .transcript
            .lock()
            .map_err(|_| "transcript store poisoned".to_string())
            .and_then(|mut transcript| {
                transcript.read_resources(request.params.unwrap_or(Value::Null))
            }),
        THREAD_RESOURCES_READ_METHOD => server
            .threads
            .read_resources(request.params.unwrap_or(Value::Null)),
        THREAD_COMPACT_METHOD => server
            .operation_queue
            .submit_compact(request.params.unwrap_or(Value::Null)),
        THREAD_QUEUE_REMOVE_METHOD => server
            .operation_queue
            .remove(request.params.unwrap_or(Value::Null)),
        THREAD_QUEUE_RUN_NOW_METHOD => server
            .operation_queue
            .run_now(request.params.unwrap_or(Value::Null)),
        THREAD_MESSAGE_EDIT_METHOD => {
            let params = request.params.unwrap_or(Value::Null);
            server
                .operation_queue
                .ensure_direct_mutation_allowed(&params)
                .and_then(|_| server.thread_commands.edit_message(params))
        }
        THREAD_MESSAGE_FORK_METHOD => {
            let params = request.params.unwrap_or(Value::Null);
            server
                .operation_queue
                .ensure_direct_mutation_allowed(&params)
                .and_then(|_| server.thread_commands.fork_message(params))
        }
        THREAD_MESSAGE_SEND_METHOD => server
            .operation_queue
            .submit_message(request.params.unwrap_or(Value::Null)),
        THREAD_MESSAGE_START_METHOD => server
            .thread_commands
            .start_message(request.params.unwrap_or(Value::Null)),
        THREAD_TURN_INTERRUPT_METHOD => server
            .operation_queue
            .interrupt(request.params.unwrap_or(Value::Null)),
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

struct CodexRequestDispatcher {
    config_tx: mpsc::SyncSender<JsonRpcRequest>,
    narration_tx: mpsc::SyncSender<JsonRpcRequest>,
    output_tx: mpsc::SyncSender<Value>,
    read_txs: Vec<mpsc::SyncSender<JsonRpcRequest>>,
    read_cursor: std::sync::atomic::AtomicUsize,
    server: Arc<CodexExtensionServer>,
    thread_txs: Mutex<HashMap<String, mpsc::SyncSender<JsonRpcRequest>>>,
}

impl CodexRequestDispatcher {
    fn new(server: Arc<CodexExtensionServer>, output_tx: mpsc::SyncSender<Value>) -> Self {
        let config_tx = spawn_request_worker(
            "codex-config",
            CODEX_SINGLETON_LANE_CAPACITY,
            server.clone(),
            output_tx.clone(),
        );
        let narration_tx = spawn_request_worker(
            "codex-narration",
            CODEX_SINGLETON_LANE_CAPACITY,
            server.clone(),
            output_tx.clone(),
        );
        let read_txs = (0..CODEX_READ_WORKERS)
            .map(|index| {
                spawn_request_worker(
                    &format!("codex-read-{index}"),
                    CODEX_READ_QUEUE_CAPACITY / CODEX_READ_WORKERS,
                    server.clone(),
                    output_tx.clone(),
                )
            })
            .collect();
        Self {
            config_tx,
            narration_tx,
            output_tx,
            read_txs,
            read_cursor: std::sync::atomic::AtomicUsize::new(0),
            server,
            thread_txs: Mutex::new(HashMap::new()),
        }
    }

    fn dispatch(&self, request: JsonRpcRequest) {
        let method = request.method.clone();
        let tx = match method.as_str() {
            COMPOSER_CONFIG_WRITE_METHOD => self.config_tx.clone(),
            NARRATION_START_METHOD | NARRATION_CANCEL_METHOD => self.narration_tx.clone(),
            FILES_METHOD
            | COMPOSER_CONFIG_READ_METHOD
            | MODELS_READ_METHOD
            | NARRATION_AUDIO_READ_METHOD
            | NARRATION_DIAGNOSTICS_READ_METHOD
            | NARRATION_READ_METHOD
            | TRANSCRIPT_RESOURCES_READ_METHOD
            | THREAD_RESOURCES_READ_METHOD => {
                let index = self
                    .read_cursor
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                    % self.read_txs.len();
                self.read_txs[index].clone()
            }
            THREAD_COMPACT_METHOD
            | THREAD_QUEUE_REMOVE_METHOD
            | THREAD_QUEUE_RUN_NOW_METHOD
            | THREAD_MESSAGE_EDIT_METHOD
            | THREAD_MESSAGE_FORK_METHOD
            | THREAD_MESSAGE_SEND_METHOD
            | THREAD_MESSAGE_START_METHOD
            | THREAD_TURN_INTERRUPT_METHOD => {
                let key = request
                    .params
                    .as_ref()
                    .and_then(|params| params.get("threadId"))
                    .and_then(Value::as_str)
                    .unwrap_or("__new_thread__")
                    .to_string();
                let mut lanes = self
                    .thread_txs
                    .lock()
                    .expect("Codex thread lanes available");
                if let Some(tx) = lanes.get(&key) {
                    tx.clone()
                } else if lanes.len() < CODEX_MAX_THREAD_LANES {
                    let tx = spawn_request_worker(
                        &format!("codex-thread-{}", lanes.len() + 1),
                        CODEX_THREAD_LANE_CAPACITY,
                        self.server.clone(),
                        self.output_tx.clone(),
                    );
                    lanes.insert(key, tx.clone());
                    tx
                } else {
                    let response = JsonRpcResponse::error(
                        request.id,
                        JsonRpcError::new(-32001, "Codex thread lane limit reached".to_string()),
                    );
                    let _ = send_response(&self.output_tx, response);
                    return;
                }
            }
            _ => {
                let response = JsonRpcResponse::error(
                    request.id,
                    JsonRpcError::new(-32601, format!("Unknown method: {method}")),
                );
                let _ = send_response(&self.output_tx, response);
                return;
            }
        };

        if let Err(error) = tx.try_send(request) {
            let request = match error {
                mpsc::TrySendError::Full(request) | mpsc::TrySendError::Disconnected(request) => {
                    request
                }
            };
            let response = JsonRpcResponse::error(
                request.id,
                JsonRpcError::new(
                    -32001,
                    format!("Codex request lane busy: {}", request.method),
                ),
            );
            let _ = send_response(&self.output_tx, response);
        }
    }
}

fn spawn_request_worker(
    name: &str,
    capacity: usize,
    server: Arc<CodexExtensionServer>,
    output_tx: mpsc::SyncSender<Value>,
) -> mpsc::SyncSender<JsonRpcRequest> {
    let (tx, rx) = mpsc::sync_channel::<JsonRpcRequest>(capacity);
    thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            for request in rx {
                let response = handle_request(&server, request);
                if send_response(&output_tx, response).is_err() {
                    break;
                }
            }
        })
        .expect("failed to spawn Codex request worker");
    tx
}

fn send_response(
    output_tx: &mpsc::SyncSender<Value>,
    response: JsonRpcResponse,
) -> Result<(), String> {
    let response = serde_json::to_value(response).map_err(|error| error.to_string())?;
    output_tx
        .send(response)
        .map_err(|error| format!("failed to write response: {error}"))
}

struct CodexExtensionServer {
    composer_config: ComposerConfigStore,
    files: CodexFileResourcesServer,
    models: CodexModelsServer,
    narration: CodexNarrationServer,
    operation_queue: CodexOperationQueueServer,
    thread_commands: CodexThreadCommandServer,
    threads: CodexThreadResourcesServer,
    transcript: Mutex<CodexTranscriptServer>,
}

impl CodexExtensionServer {
    fn new(codex_home: PathBuf, output_tx: mpsc::SyncSender<Value>) -> Self {
        let (event_sink, event_rx) = AppServerEventSink::channel();
        let (narration_event_sink, narration_event_rx) = AppServerEventSink::channel();
        let composer_config =
            ComposerConfigStore::new(codex_home.join("remux").join("composer-config.json"));
        let live_transcript = LiveTranscriptStore::default();
        let thread_runtime = ThreadRuntimeStore::default();
        let thread_usage = ThreadUsageStore::default();
        let app_server = AppServerRuntime::new_with_event_sink(codex_home.clone(), event_sink);
        let narration_app_server =
            AppServerRuntime::new_with_event_sink(codex_home.clone(), narration_event_sink);
        let thread_commands = CodexThreadCommandServer::new(
            app_server.clone(),
            composer_config.clone(),
            live_transcript.clone(),
            thread_runtime.clone(),
            codex_home.clone(),
        );
        let operation_queue = CodexOperationQueueServer::new(
            PendingQueueStore::new(codex_home.join("remux").join("operation-queue")),
            thread_commands.clone(),
            thread_runtime.clone(),
        );
        spawn_app_server_event_forwarder(
            event_rx,
            output_tx.clone(),
            live_transcript.clone(),
            thread_runtime.clone(),
            thread_usage.clone(),
            operation_queue.clone(),
        );
        Self {
            composer_config: composer_config.clone(),
            files: CodexFileResourcesServer::new(),
            models: CodexModelsServer::new(app_server.clone()),
            narration: CodexNarrationServer::new(
                codex_home.clone(),
                narration_app_server,
                narration_event_rx,
                output_tx,
                live_transcript.clone(),
            ),
            operation_queue: operation_queue.clone(),
            thread_commands,
            threads: CodexThreadResourcesServer::new(
                app_server,
                composer_config,
                operation_queue,
                thread_runtime,
                thread_usage,
            ),
            transcript: Mutex::new(CodexTranscriptServer::new_with_live_transcript(
                codex_home,
                live_transcript,
            )),
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
    output_tx: mpsc::SyncSender<Value>,
    live_transcript: LiveTranscriptStore,
    thread_runtime: ThreadRuntimeStore,
    thread_usage: ThreadUsageStore,
    operation_queue: CodexOperationQueueServer,
) {
    thread::spawn(move || {
        for event in event_rx {
            let notification = match event {
                AppServerEvent::Notification(notification) => notification,
                AppServerEvent::Disconnected(_) => {
                    let invalidations = operation_queue
                        .clear_all()
                        .into_iter()
                        .map(|thread_id| {
                            crate::resource_invalidations::thread_operation_queue_invalidation(
                                &thread_id,
                                "appServerEvent",
                            )
                        })
                        .collect::<Vec<_>>();
                    if !invalidations.is_empty() {
                        let _ = output_tx.send(resources_invalidated_notification(invalidations));
                    }
                    continue;
                }
                AppServerEvent::ServerRequest(_) => continue,
            };
            let live_effect = live_transcript.record_notification(&notification);
            thread_runtime.record_notification(&notification);
            thread_usage.record_notification(&notification);
            let queue_effect = operation_queue.record_notification(&notification);
            let mut invalidations = invalidations_for_app_server_notification(
                &notification,
                live_effect.canonical_item_id.as_deref(),
                &live_effect.rekeyed_item_ids,
            );
            if queue_effect.invalidated
                && let Some(thread_id) = notification
                    .get("params")
                    .and_then(|params| params.get("threadId"))
                    .and_then(Value::as_str)
            {
                invalidations.push(
                    crate::resource_invalidations::thread_operation_queue_invalidation(
                        thread_id,
                        "appServerEvent",
                    ),
                );
            }
            let projected_turn = completed_turn_target(&notification)
                .and_then(|(thread_id, turn_id)| live_transcript.projected_turn(thread_id, turn_id))
                .map(|projected| projected.turn);
            if !queue_effect.suppress_completion_notification
                && let Some(notification_intent) =
                    notification_for_app_server_notification(&notification, projected_turn.as_ref())
            {
                let _ = output_tx.send(notification_intent);
            }

            if !invalidations.is_empty() {
                let _ = output_tx.send(resources_invalidated_notification(invalidations));
            }
        }
    });
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
