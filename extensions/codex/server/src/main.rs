mod app_notifications;
mod app_server;
mod composer_config;
mod file_resources;
mod history;
mod item_identity;
mod live_transcript;
mod media;
mod models;
mod operation_queue;
mod projection;
mod resource_invalidations;
mod resources;
mod server;
mod structured_inference;
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

use remux_extension_rpc::Peer as ExtensionRpcPeer;
use serde_json::{Value, json};

use crate::app_notifications::notification_for_app_server_notification;
use crate::app_server::{AppServerEvent, AppServerEventSink, AppServerRuntime};
use crate::composer_config::ComposerConfigStore;
use crate::file_resources::CodexFileResourcesServer;
use crate::live_transcript::LiveTranscriptStore;
use crate::models::CodexModelsServer;
use crate::operation_queue::{CodexOperationQueueServer, PendingQueueStore};
use crate::resource_invalidations::{
    app_server_reconnected_invalidations, invalidations_for_app_server_notification,
    resources_invalidated_notification,
};
use crate::resources::{CodexTranscriptServer, ValidationOptions};
use crate::server::{JsonRpcError, JsonRpcRequest, JsonRpcResponse};
use crate::structured_inference::StructuredInferenceServer;
use crate::thread_commands::CodexThreadCommandServer;
use crate::thread_resources::CodexThreadResourcesServer;
use crate::thread_runtime::ThreadRuntimeStore;
use crate::thread_usage::ThreadUsageStore;

const FILES_METHOD: &str = "remux/codex/files";
const COMPOSER_CONFIG_READ_METHOD: &str = "remux/codex/composer/config/read";
const COMPOSER_CONFIG_WRITE_METHOD: &str = "remux/codex/composer/config/write";
const MODELS_READ_METHOD: &str = "remux/codex/models/read";
const APP_SERVER_STATUS_READ_METHOD: &str = "remux/codex/app-server/status/read";
const APP_SERVER_START_METHOD: &str = "remux/codex/app-server/start";
const APP_SERVER_STOP_METHOD: &str = "remux/codex/app-server/stop";
const APP_SERVER_RESTART_METHOD: &str = "remux/codex/app-server/restart";
const APP_SERVER_UPDATE_METHOD: &str = "remux/codex/app-server/update";
const NARRATION_AUDIO_READ_METHOD: &str = "remux/codex/narration/audio/read";
const NARRATION_CANCEL_METHOD: &str = "remux/codex/narration/cancel";
const NARRATION_DIAGNOSTICS_READ_METHOD: &str = "remux/codex/narration/diagnostics/read";
const NARRATION_READ_METHOD: &str = "remux/codex/narration/resources/read";
const NARRATION_START_METHOD: &str = "remux/codex/narration/start";
const STRUCTURED_INFERENCE_GENERATE_METHOD: &str = "remux/codex/inference/structured/generate";
const STRUCTURED_INFERENCE_CANCEL_METHOD: &str = "remux/codex/inference/structured/cancel";
const TRANSCRIPT_CAPABILITIES_READ_METHOD: &str = "remux/codex/transcript/capabilities/read";
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
    let host_rpc = ExtensionRpcPeer::new("codex", {
        let output_tx = output_tx.clone();
        move |message| {
            output_tx
                .send(message)
                .map_err(|error| format!("failed to write host RPC request: {error}"))
        }
    });
    let server = Arc::new(CodexExtensionServer::new(
        default_codex_home(),
        output_tx.clone(),
        host_rpc.clone(),
    ));
    let dispatcher = CodexRequestDispatcher::new(server, output_tx.clone());

    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }

        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(error) => {
                send_response(
                    &output_tx,
                    JsonRpcResponse::error(
                        Value::Null,
                        JsonRpcError::new(-32700, format!("Parse error: {error}")),
                    ),
                )?;
                continue;
            }
        };
        if host_rpc.resolve(&message) {
            continue;
        }
        match serde_json::from_value::<JsonRpcRequest>(message) {
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
        APP_SERVER_STATUS_READ_METHOD => Ok(server.app_server_status()),
        APP_SERVER_START_METHOD => server.app_server_start(),
        APP_SERVER_STOP_METHOD => server.app_server_stop(),
        APP_SERVER_RESTART_METHOD => server.app_server_restart(),
        APP_SERVER_UPDATE_METHOD => server.app_server_update(),
        NARRATION_AUDIO_READ_METHOD => server.proxy_narration(
            "remux/narrate/narration/audio/read",
            request.params.unwrap_or(Value::Null),
        ),
        NARRATION_CANCEL_METHOD => server.proxy_narration(
            "remux/narrate/narration/cancel",
            request.params.unwrap_or(Value::Null),
        ),
        NARRATION_DIAGNOSTICS_READ_METHOD => {
            server.proxy_narration("remux/narrate/narration/diagnostics/read", Value::Null)
        }
        NARRATION_READ_METHOD => server.proxy_narration(
            "remux/narrate/narration/resources/read",
            request.params.unwrap_or(Value::Null),
        ),
        NARRATION_START_METHOD => server.proxy_narration(
            "remux/narrate/narration/start",
            request.params.unwrap_or(Value::Null),
        ),
        STRUCTURED_INFERENCE_GENERATE_METHOD => server
            .structured_inference
            .generate(request.params.unwrap_or(Value::Null)),
        STRUCTURED_INFERENCE_CANCEL_METHOD => server
            .structured_inference
            .cancel(request.params.unwrap_or(Value::Null)),
        TRANSCRIPT_CAPABILITIES_READ_METHOD => Ok(json!({
            "limits": {
                "maxGroupRows": crate::transcript::MAX_WORK_GROUP_ROWS,
                "maxKnownTurns": crate::transcript::MAX_TRANSCRIPT_KNOWN_TURNS,
                "maxResponseBytes": 8 * 1024 * 1024,
                "maxWindowTurns": crate::transcript::MAX_TRANSCRIPT_WINDOW_TURNS,
            },
            "preferredProtocolVersion": crate::transcript::TRANSCRIPT_RENDER_PROTOCOL_VERSION,
            "projectionVersions": {
                "2": crate::transcript::TRANSCRIPT_PROJECTION_VERSION,
            },
            "protocolVersions": [1, 2],
        })),
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
    app_server_tx: mpsc::SyncSender<JsonRpcRequest>,
    config_tx: mpsc::SyncSender<JsonRpcRequest>,
    narration_tx: mpsc::SyncSender<JsonRpcRequest>,
    inference_txs: Vec<mpsc::SyncSender<JsonRpcRequest>>,
    inference_cursor: std::sync::atomic::AtomicUsize,
    output_tx: mpsc::SyncSender<Value>,
    read_txs: Vec<mpsc::SyncSender<JsonRpcRequest>>,
    read_cursor: std::sync::atomic::AtomicUsize,
    server: Arc<CodexExtensionServer>,
    thread_txs: Mutex<HashMap<String, mpsc::SyncSender<JsonRpcRequest>>>,
}

impl CodexRequestDispatcher {
    fn new(server: Arc<CodexExtensionServer>, output_tx: mpsc::SyncSender<Value>) -> Self {
        let app_server_tx = spawn_request_worker(
            "codex-app-server-management",
            CODEX_SINGLETON_LANE_CAPACITY,
            server.clone(),
            output_tx.clone(),
        );
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
        let inference_txs = (0..4)
            .map(|index| {
                spawn_request_worker(
                    &format!("codex-structured-inference-{index}"),
                    2,
                    server.clone(),
                    output_tx.clone(),
                )
            })
            .collect();
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
            app_server_tx,
            config_tx,
            inference_txs,
            inference_cursor: std::sync::atomic::AtomicUsize::new(0),
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
            APP_SERVER_START_METHOD
            | APP_SERVER_STOP_METHOD
            | APP_SERVER_RESTART_METHOD
            | APP_SERVER_UPDATE_METHOD => self.app_server_tx.clone(),
            COMPOSER_CONFIG_WRITE_METHOD => self.config_tx.clone(),
            NARRATION_START_METHOD | NARRATION_CANCEL_METHOD => self.narration_tx.clone(),
            STRUCTURED_INFERENCE_GENERATE_METHOD => {
                let index = self
                    .inference_cursor
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                    % self.inference_txs.len();
                self.inference_txs[index].clone()
            }
            STRUCTURED_INFERENCE_CANCEL_METHOD => self.app_server_tx.clone(),
            FILES_METHOD
            | COMPOSER_CONFIG_READ_METHOD
            | MODELS_READ_METHOD
            | APP_SERVER_STATUS_READ_METHOD
            | NARRATION_AUDIO_READ_METHOD
            | NARRATION_DIAGNOSTICS_READ_METHOD
            | NARRATION_READ_METHOD
            | TRANSCRIPT_CAPABILITIES_READ_METHOD
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
    app_server: AppServerRuntime,
    composer_config: ComposerConfigStore,
    files: CodexFileResourcesServer,
    live_transcript: LiveTranscriptStore,
    host_rpc: ExtensionRpcPeer,
    models: CodexModelsServer,
    structured_inference: StructuredInferenceServer,
    operation_queue: CodexOperationQueueServer,
    output_tx: mpsc::SyncSender<Value>,
    thread_commands: CodexThreadCommandServer,
    thread_runtime: ThreadRuntimeStore,
    thread_usage: ThreadUsageStore,
    threads: CodexThreadResourcesServer,
    transcript: Mutex<CodexTranscriptServer>,
}

impl CodexExtensionServer {
    fn new(
        codex_home: PathBuf,
        output_tx: mpsc::SyncSender<Value>,
        host_rpc: ExtensionRpcPeer,
    ) -> Self {
        let (event_sink, event_rx) = AppServerEventSink::channel();
        let (inference_event_sink, inference_event_rx) = AppServerEventSink::channel();
        let composer_config =
            ComposerConfigStore::new(codex_home.join("remux").join("composer-config.json"));
        let live_transcript = LiveTranscriptStore::default();
        let thread_runtime = ThreadRuntimeStore::default();
        let thread_usage = ThreadUsageStore::default();
        let app_server = AppServerRuntime::new_with_event_sink(codex_home.clone(), event_sink);
        let inference_app_server =
            AppServerRuntime::new_with_event_sink(codex_home.clone(), inference_event_sink);
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
            app_server.clone(),
            live_transcript.clone(),
            thread_runtime.clone(),
            thread_usage.clone(),
            operation_queue.clone(),
        );
        let server = Self {
            app_server: app_server.clone(),
            composer_config: composer_config.clone(),
            files: CodexFileResourcesServer::new(),
            live_transcript: live_transcript.clone(),
            host_rpc,
            models: CodexModelsServer::new(app_server.clone()),
            structured_inference: StructuredInferenceServer::new(
                codex_home.clone(),
                inference_app_server,
                inference_event_rx,
            ),
            operation_queue: operation_queue.clone(),
            output_tx: output_tx.clone(),
            thread_commands,
            thread_runtime: thread_runtime.clone(),
            thread_usage: thread_usage.clone(),
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
        };
        match server.reconcile_app_server() {
            Ok(thread_ids) => server.publish_reconciliation_invalidations(&thread_ids),
            Err(error) => server.app_server.management_log(
                "connection",
                Some("warn"),
                &format!("initial reconciliation failed: {error}"),
            ),
        }
        server
    }

    fn app_server_status(&self) -> Value {
        self.app_server
            .daemon_status()
            .to_value(self.thread_runtime.active_turn_ids())
    }

    fn proxy_narration(&self, method: &str, params: Value) -> Result<Value, String> {
        self.host_rpc
            .request(
                method,
                (!params.is_null()).then_some(params),
                std::time::Duration::from_secs(300),
            )
            .map_err(|error| format!("Narrate service request failed: {error}"))
    }

    fn app_server_start(&self) -> Result<Value, String> {
        self.app_server.daemon_start()?;
        let thread_ids = self.reconcile_app_server()?;
        self.publish_reconciliation_invalidations(&thread_ids);
        Ok(self
            .app_server
            .daemon_status()
            .to_value(self.thread_runtime.active_turn_ids()))
    }

    fn app_server_stop(&self) -> Result<Value, String> {
        let thread_ids = self.ensure_app_server_idle()?;
        let status = self.app_server.daemon_stop()?;
        self.live_transcript.clear();
        self.thread_runtime.clear();
        self.thread_usage.clear();
        self.publish_reconciliation_invalidations(&thread_ids);
        Ok(status.to_value(Vec::new()))
    }

    fn app_server_restart(&self) -> Result<Value, String> {
        self.ensure_app_server_idle()?;
        self.app_server.daemon_restart()?;
        let thread_ids = self.reconcile_app_server()?;
        self.publish_reconciliation_invalidations(&thread_ids);
        Ok(self
            .app_server
            .daemon_status()
            .to_value(self.thread_runtime.active_turn_ids()))
    }

    fn app_server_update(&self) -> Result<Value, String> {
        self.app_server
            .update_codex()
            .map(|status| status.to_value(self.thread_runtime.active_turn_ids()))
    }

    fn ensure_app_server_idle(&self) -> Result<Vec<String>, String> {
        let thread_ids = self.reconcile_app_server()?;
        self.publish_reconciliation_invalidations(&thread_ids);
        let active = self.thread_runtime.active_turn_ids();
        if active.is_empty() {
            Ok(thread_ids)
        } else {
            Err(format!(
                "Codex App Server has {} active turn{}; finish or interrupt before restarting",
                active.len(),
                if active.len() == 1 { "" } else { "s" }
            ))
        }
    }

    fn reconcile_app_server(&self) -> Result<Vec<String>, String> {
        reconcile_app_server_state(
            &self.app_server,
            &self.live_transcript,
            &self.thread_runtime,
            &self.thread_usage,
        )
    }

    fn publish_reconciliation_invalidations(&self, thread_ids: &[String]) {
        let invalidations = reconciliation_invalidations(thread_ids);
        if !invalidations.is_empty() {
            let _ = self
                .output_tx
                .send(resources_invalidated_notification(invalidations));
        }
    }
}

fn reconcile_app_server_state(
    app_server: &AppServerRuntime,
    live_transcript: &LiveTranscriptStore,
    thread_runtime: &ThreadRuntimeStore,
    thread_usage: &ThreadUsageStore,
) -> Result<Vec<String>, String> {
    let response = app_server.request(
        "thread/list",
        json!({
            "archived": false,
            "limit": 100,
            "sortDirection": "desc",
            "sortKey": "updated_at",
            "useStateDbOnly": false,
        }),
    )?;
    live_transcript.clear();
    thread_runtime.clear();
    thread_usage.clear();
    let mut all_threads = Vec::new();
    let mut active_threads = Vec::new();
    for thread in response
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(thread_id) = thread.get("id").and_then(Value::as_str) else {
            continue;
        };
        all_threads.push(thread_id.to_string());
        if !thread_status_is_active(thread.get("status")) {
            continue;
        }
        active_threads.push(thread_id.to_string());
        let detail = app_server.request(
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": true }),
        )?;
        let full_thread = detail.get("thread").unwrap_or(thread);
        let turns = full_thread
            .get("turns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for turn in &turns {
            live_transcript.record_turn(thread_id, turn);
        }
        let active_turn_id = turns
            .iter()
            .rev()
            .find(|turn| turn_status_is_active(turn.get("status")))
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .or_else(|| full_thread.get("activeTurnId").and_then(Value::as_str));
        thread_runtime.record_turn_started(thread_id, active_turn_id);
    }
    live_transcript.set_authoritative_active_threads(&active_threads);
    app_server.management_log(
        "connection",
        Some("info"),
        &format!(
            "reconciled {} active thread{}",
            active_threads.len(),
            if active_threads.len() == 1 { "" } else { "s" }
        ),
    );
    Ok(all_threads)
}

fn thread_status_is_active(status: Option<&Value>) -> bool {
    status.and_then(Value::as_str) == Some("active")
        || status
            .and_then(Value::as_object)
            .and_then(|status| status.get("type"))
            .and_then(Value::as_str)
            == Some("active")
}

fn turn_status_is_active(status: Option<&Value>) -> bool {
    matches!(
        status.and_then(Value::as_str),
        Some("inProgress" | "running" | "active")
    )
}

fn reconciliation_invalidations(thread_ids: &[String]) -> Vec<Value> {
    app_server_reconnected_invalidations(thread_ids)
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
    app_server: AppServerRuntime,
    live_transcript: LiveTranscriptStore,
    thread_runtime: ThreadRuntimeStore,
    thread_usage: ThreadUsageStore,
    operation_queue: CodexOperationQueueServer,
) {
    thread::spawn(move || {
        for event in event_rx {
            let notification = match event {
                AppServerEvent::Reconnected => {
                    match reconcile_app_server_state(
                        &app_server,
                        &live_transcript,
                        &thread_runtime,
                        &thread_usage,
                    ) {
                        Ok(thread_ids) => {
                            let invalidations = reconciliation_invalidations(&thread_ids);
                            if !invalidations.is_empty() {
                                let _ = output_tx
                                    .send(resources_invalidated_notification(invalidations));
                            }
                        }
                        Err(error) => app_server.management_log(
                            "connection",
                            Some("error"),
                            &format!("reconciliation failed: {error}"),
                        ),
                    }
                    continue;
                }
                AppServerEvent::Notification(notification) => notification,
                AppServerEvent::Disconnected(reason) => {
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
                    app_server.management_log(
                        "connection",
                        Some("warn"),
                        &format!("disconnected: {reason}; reconnecting"),
                    );
                    if let Err(error) = app_server.reconnect() {
                        app_server.management_log(
                            "connection",
                            Some("error"),
                            &format!("automatic reconnect failed: {error}"),
                        );
                    }
                    continue;
                }
                AppServerEvent::ManagementLog {
                    source,
                    channel,
                    level,
                    line,
                } => {
                    let _ = output_tx.send(json!({
                        "jsonrpc": "2.0",
                        "method": "remux/extension/managementLog",
                        "params": {
                            "componentId": "codex-app-server",
                            "source": source,
                            "channel": channel,
                            "level": level,
                            "line": line,
                        }
                    }));
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
