use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::app_server::{AppServerEvent, AppServerRuntime};

const API_VERSION: u64 = 1;
const GATEWAY_VERSION: u64 = 1;
const MAX_ACTIVE_OPERATIONS: usize = 4;
const MAX_INSTRUCTIONS_BYTES: usize = 64 * 1024;
const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SCHEMA_BYTES: usize = 256 * 1024;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const TURN_TIMEOUT: Duration = Duration::from_secs(14 * 60);
const MAX_PROGRESS_DELTA_BYTES: usize = 12 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct StructuredInferenceServer {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    active: Mutex<HashMap<String, ActiveOperation>>,
    app_server: AppServerRuntime,
    context_dir: PathBuf,
    subscriptions: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    output_tx: mpsc::SyncSender<Value>,
}

#[derive(Clone, Debug, Default)]
struct ActiveOperation {
    cancel_requested: bool,
    thread_id: Option<String>,
    turn_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateParams {
    api_version: u64,
    effort: String,
    input: String,
    instructions: String,
    model: String,
    operation_id: String,
    output_schema: Value,
    service_tier: String,
    #[serde(default)]
    progress: Option<ProgressParams>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProgressParams {
    protocol_version: u64,
    request_id: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileValidateParams {
    api_version: u64,
    effort: String,
    model: String,
    service_tier: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelParams {
    operation_id: String,
}

impl StructuredInferenceServer {
    pub(crate) fn new(
        codex_home: PathBuf,
        app_server: AppServerRuntime,
        event_rx: mpsc::Receiver<AppServerEvent>,
        output_tx: mpsc::SyncSender<Value>,
    ) -> Self {
        let inner = Arc::new(Inner {
            active: Mutex::new(HashMap::new()),
            app_server,
            context_dir: codex_home
                .join("remux")
                .join("structured-inference")
                .join("context-v1"),
            subscriptions: Mutex::new(HashMap::new()),
            output_tx,
        });
        spawn_event_router(inner.clone(), event_rx);
        Self { inner }
    }

    pub(crate) fn generate(&self, params: Value) -> Result<Value, String> {
        let params: GenerateParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid structured inference params: {error}"))?;
        validate_generate_params(&params)?;
        {
            let mut active = self
                .inner
                .active
                .lock()
                .map_err(|_| "structured inference operation store poisoned".to_string())?;
            if active.contains_key(&params.operation_id) {
                return Err(format!(
                    "structured inference operation {} is already active",
                    params.operation_id
                ));
            }
            if active.len() >= MAX_ACTIVE_OPERATIONS {
                return Err("structured inference concurrency limit reached".to_string());
            }
            active.insert(params.operation_id.clone(), ActiveOperation::default());
        }

        let result = self.generate_inner(&params);
        if let Ok(mut active) = self.inner.active.lock() {
            active.remove(&params.operation_id);
        }
        result
    }

    pub(crate) fn validate_profile(&self, params: Value) -> Result<Value, String> {
        let params: ProfileValidateParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid structured inference profile params: {error}"))?;
        validate_profile_params(&params)?;
        validate_available_profile(&self.inner.app_server, &params.model, &params.service_tier)?;
        Ok(json!({
            "apiVersion": API_VERSION,
            "model": params.model,
            "serviceTier": params.service_tier,
            "effort": params.effort,
            "profileDigest": profile_digest(),
        }))
    }

    pub(crate) fn cancel(&self, params: Value) -> Result<Value, String> {
        let params: CancelParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid structured inference cancel params: {error}"))?;
        let operation = {
            let mut active = self
                .inner
                .active
                .lock()
                .map_err(|_| "structured inference operation store poisoned".to_string())?;
            active.get_mut(&params.operation_id).map(|operation| {
                operation.cancel_requested = true;
                operation.clone()
            })
        };
        if let Some(operation) = operation {
            interrupt(&self.inner.app_server, &operation);
        }
        Ok(json!({
            "operationId": params.operation_id,
            "status": "accepted",
        }))
    }

    fn generate_inner(&self, params: &GenerateParams) -> Result<Value, String> {
        self.ensure_not_cancelled(&params.operation_id)?;
        validate_available_profile(&self.inner.app_server, &params.model, &params.service_tier)?;
        self.ensure_not_cancelled(&params.operation_id)?;
        fs::create_dir_all(&self.inner.context_dir)
            .map_err(|error| format!("failed to create structured inference context: {error}"))?;
        self.ensure_not_cancelled(&params.operation_id)?;
        let thread_response = self.inner.app_server.request(
            "thread/start",
            thread_start_params(params, &self.inner.context_dir),
        )?;
        let thread_id = thread_response
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "structured inference thread/start response missing thread.id".to_string()
            })?
            .to_string();
        let event_rx = self.subscribe(&thread_id)?;
        let turn_id = match (|| {
            let cancelled = self.update_active(&params.operation_id, |active| {
                active.thread_id = Some(thread_id.clone());
            })?;
            if cancelled {
                return Err("structured inference cancelled".to_string());
            }
            let turn_response = self
                .inner
                .app_server
                .request("turn/start", turn_start_params(params, &thread_id))?;
            let turn_id = turn_response
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    "structured inference turn/start response missing turn.id".to_string()
                })?
                .to_string();
            let cancelled = self.update_active(&params.operation_id, |active| {
                active.turn_id = Some(turn_id.clone());
            })?;
            if cancelled {
                interrupt(
                    &self.inner.app_server,
                    &ActiveOperation {
                        cancel_requested: true,
                        thread_id: Some(thread_id.clone()),
                        turn_id: Some(turn_id.clone()),
                    },
                );
                return Err("structured inference cancelled".to_string());
            }
            Ok::<_, String>(turn_id)
        })() {
            Ok(turn_id) => turn_id,
            Err(error) => {
                self.unsubscribe(&thread_id);
                return Err(error);
            }
        };

        let mut progress_sequence = 0;
        let output = wait_for_output(
            &thread_id,
            &turn_id,
            event_rx,
            |delta| {
                let Some(progress) = &params.progress else {
                    return Ok(());
                };
                for delta in split_utf8(delta, MAX_PROGRESS_DELTA_BYTES) {
                    let frame = json!({
                        "jsonrpc": "2.0",
                        "method": "$/progress",
                        "params": {
                            "id": progress.request_id,
                            "sequence": progress_sequence,
                            "value": { "type": "textDelta", "delta": delta },
                        },
                    });
                    self.inner.output_tx.try_send(frame).map_err(|_| {
                        "structured inference progress output overflowed".to_string()
                    })?;
                    progress_sequence += 1;
                }
                Ok(())
            },
            || {
                self.operation_cancelled(&params.operation_id)
                    .unwrap_or(true)
            },
        );
        self.unsubscribe(&thread_id);
        let output = match output {
            Ok(output) => output,
            Err(error) => {
                interrupt(
                    &self.inner.app_server,
                    &ActiveOperation {
                        cancel_requested: false,
                        thread_id: Some(thread_id),
                        turn_id: Some(turn_id),
                    },
                );
                return Err(error);
            }
        };
        self.ensure_not_cancelled(&params.operation_id)?;
        if output.completed_text.len() > MAX_OUTPUT_BYTES {
            return Err(format!(
                "structured inference output is too large: {}>{MAX_OUTPUT_BYTES}",
                output.completed_text.len()
            ));
        }
        if params.progress.is_some() && output.delta_text != output.completed_text {
            return Err(
                "structured inference delta stream differs from completed output".to_string(),
            );
        }
        let value: Value = serde_json::from_str(&output.completed_text)
            .map_err(|error| format!("structured inference returned invalid JSON: {error}"))?;
        Ok(json!({
            "apiVersion": API_VERSION,
            "gatewayVersion": GATEWAY_VERSION,
            "model": params.model,
            "serviceTier": params.service_tier,
            "profileDigest": profile_digest(),
            "completedTextSha256": sha256_hex(output.completed_text.as_bytes()),
            "deltaTextSha256": sha256_hex(output.delta_text.as_bytes()),
            "progressFrames": progress_sequence,
            "value": value,
        }))
    }

    fn subscribe(&self, thread_id: &str) -> Result<mpsc::Receiver<Value>, String> {
        let (sender, receiver) = mpsc::channel();
        let mut subscriptions = self
            .inner
            .subscriptions
            .lock()
            .map_err(|_| "structured inference subscriptions poisoned".to_string())?;
        if subscriptions.len() >= MAX_ACTIVE_OPERATIONS {
            return Err("structured inference subscription limit reached".to_string());
        }
        subscriptions.insert(thread_id.to_string(), sender);
        Ok(receiver)
    }

    fn unsubscribe(&self, thread_id: &str) {
        if let Ok(mut subscriptions) = self.inner.subscriptions.lock() {
            subscriptions.remove(thread_id);
        }
    }

    fn update_active(
        &self,
        operation_id: &str,
        update: impl FnOnce(&mut ActiveOperation),
    ) -> Result<bool, String> {
        let mut active = self
            .inner
            .active
            .lock()
            .map_err(|_| "structured inference operation store poisoned".to_string())?;
        let operation = active
            .get_mut(operation_id)
            .ok_or_else(|| "structured inference operation disappeared".to_string())?;
        update(operation);
        Ok(operation.cancel_requested)
    }

    fn operation_cancelled(&self, operation_id: &str) -> Result<bool, String> {
        let active = self
            .inner
            .active
            .lock()
            .map_err(|_| "structured inference operation store poisoned".to_string())?;
        Ok(active
            .get(operation_id)
            .is_none_or(|operation| operation.cancel_requested))
    }

    fn ensure_not_cancelled(&self, operation_id: &str) -> Result<(), String> {
        if self.operation_cancelled(operation_id)? {
            Err("structured inference cancelled".to_string())
        } else {
            Ok(())
        }
    }
}

fn validate_generate_params(params: &GenerateParams) -> Result<(), String> {
    if params.api_version != API_VERSION {
        return Err(format!(
            "unsupported structured inference API version {}",
            params.api_version
        ));
    }
    if params.operation_id.trim().is_empty() || params.operation_id.len() > 1024 {
        return Err("structured inference operationId is invalid".to_string());
    }
    if params.model != "gpt-5.6-sol" {
        return Err("structured inference currently requires gpt-5.6-sol".to_string());
    }
    if params.service_tier != "priority" {
        return Err(
            "structured inference currently requires the priority service tier".to_string(),
        );
    }
    if params.effort != "low" {
        return Err("structured inference currently requires low effort".to_string());
    }
    if let Some(progress) = &params.progress {
        if progress.protocol_version != 1
            || (!progress.request_id.is_string() && !progress.request_id.is_number())
        {
            return Err("structured inference progress contract is invalid".to_string());
        }
    }
    for (name, value, limit) in [
        (
            "instructions",
            params.instructions.as_str(),
            MAX_INSTRUCTIONS_BYTES,
        ),
        ("input", params.input.as_str(), MAX_INPUT_BYTES),
    ] {
        if value.trim().is_empty() || value.len() > limit {
            return Err(format!("structured inference {name} is invalid"));
        }
    }
    let schema_bytes = serde_json::to_vec(&params.output_schema)
        .map_err(|error| format!("failed to encode structured inference schema: {error}"))?;
    if !params.output_schema.is_object() || schema_bytes.len() > MAX_SCHEMA_BYTES {
        return Err("structured inference outputSchema is invalid".to_string());
    }
    Ok(())
}

fn validate_profile_params(params: &ProfileValidateParams) -> Result<(), String> {
    if params.api_version != API_VERSION
        || params.model != "gpt-5.6-sol"
        || params.service_tier != "priority"
        || params.effort != "low"
    {
        return Err(
            "structured inference profile is not the required Sol Priority profile".to_string(),
        );
    }
    Ok(())
}

fn validate_available_profile(
    app_server: &AppServerRuntime,
    model_id: &str,
    service_tier: &str,
) -> Result<(), String> {
    let response =
        app_server.request("model/list", json!({ "includeHidden": true, "limit": 100 }))?;
    let model = response
        .get("data")
        .and_then(Value::as_array)
        .and_then(|models| {
            models.iter().find(|model| {
                model.get("model").and_then(Value::as_str) == Some(model_id)
                    || model.get("id").and_then(Value::as_str) == Some(model_id)
            })
        })
        .ok_or_else(|| format!("structured inference model {model_id} is unavailable"))?;
    if service_tier == "priority" {
        let supports_priority = model
            .get("serviceTiers")
            .and_then(Value::as_array)
            .is_some_and(|tiers| {
                tiers
                    .iter()
                    .any(|tier| tier.get("id").and_then(Value::as_str) == Some("priority"))
            })
            || model
                .get("additionalSpeedTiers")
                .and_then(Value::as_array)
                .is_some_and(|tiers| tiers.iter().any(|tier| tier.as_str() == Some("priority")));
        if !supports_priority {
            return Err("gpt-5.6-sol does not advertise the priority service tier".to_string());
        }
    }
    Ok(())
}

fn profile_digest() -> String {
    sha256_hex(b"remux-structured-profile-v1\0gpt-5.6-sol\0priority\0low\0none\0ephemeral\0read-only\0no-tools")
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn split_utf8(text: &str, max_bytes: usize) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + max_bytes).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&text[start..end]);
        start = end;
    }
    chunks
}

fn thread_start_params(params: &GenerateParams, context_dir: &std::path::Path) -> Value {
    json!({
        "model": params.model,
        "serviceTier": if params.service_tier == "priority" { json!("priority") } else { Value::Null },
        "baseInstructions": params.instructions,
        "approvalPolicy": "never",
        "cwd": context_dir,
        "config": {
            "features": {
                "shell_tool": false,
                "unified_exec": false,
                "code_mode": false,
                "standalone_web_search": false,
                "multi_agent": false,
                "multi_agent_v2": false,
                "apps": false,
                "enable_mcp_apps": false,
                "tool_suggest": false,
                "plugins": false,
                "remote_plugin": false,
                "image_generation": false
            },
            "web_search": "disabled",
            "skills": {
                "include_instructions": false,
                "bundled": { "enabled": false }
            }
        },
        "dynamicTools": [],
        "environments": [],
        "ephemeral": true,
        "experimentalRawEvents": false,
        "persistExtendedHistory": false,
        "sandbox": "read-only",
        "serviceName": "remux-structured-inference"
    })
}

fn turn_start_params(params: &GenerateParams, thread_id: &str) -> Value {
    json!({
        "threadId": thread_id,
        "serviceTier": if params.service_tier == "priority" { json!("priority") } else { Value::Null },
        "effort": params.effort,
        "summary": "none",
        "input": [{ "type": "text", "text": params.input, "text_elements": [] }],
        "outputSchema": params.output_schema,
    })
}

#[derive(Debug)]
struct CompletedOutput {
    completed_text: String,
    delta_text: String,
}

fn wait_for_output(
    thread_id: &str,
    turn_id: &str,
    event_rx: mpsc::Receiver<Value>,
    mut on_delta: impl FnMut(&str) -> Result<(), String>,
    mut cancelled: impl FnMut() -> bool,
) -> Result<CompletedOutput, String> {
    let started = Instant::now();
    let mut completed_text = None;
    let mut completed_messages = 0;
    let mut delta_text = String::new();
    loop {
        if cancelled() {
            return Err("structured inference cancelled".to_string());
        }
        if started.elapsed() > TURN_TIMEOUT {
            return Err("structured inference timed out".to_string());
        }
        let notification = match event_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(notification) => notification,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("structured inference event stream closed".to_string());
            }
        };
        let method = notification
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if method == "app-server/disconnected" {
            return Err("structured inference app server disconnected".to_string());
        }
        let params = notification.get("params").unwrap_or(&Value::Null);
        if params.get("threadId").and_then(Value::as_str) != Some(thread_id) {
            continue;
        }
        match method {
            "item/agentMessage/delta"
                if params.get("turnId").and_then(Value::as_str) == Some(turn_id) =>
            {
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "structured inference delta is missing text".to_string())?;
                if delta_text.len().saturating_add(delta.len()) > MAX_OUTPUT_BYTES {
                    return Err("structured inference delta stream is too large".to_string());
                }
                on_delta(delta)?;
                delta_text.push_str(delta);
            }
            "item/completed" if params.get("turnId").and_then(Value::as_str) == Some(turn_id) => {
                let item = params.get("item").unwrap_or(&Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                    completed_messages += 1;
                    completed_text = item.get("text").and_then(Value::as_str).map(str::to_string);
                }
            }
            "turn/completed" => {
                let turn = params.get("turn").unwrap_or(&Value::Null);
                if turn.get("id").and_then(Value::as_str) != Some(turn_id) {
                    continue;
                }
                if turn.get("status").and_then(Value::as_str) != Some("completed") {
                    return Err(turn
                        .get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("structured inference failed")
                        .to_string());
                }
                if completed_messages != 1 {
                    return Err(format!(
                        "structured inference completed with {completed_messages} authoritative agent messages"
                    ));
                }
                let completed_text = completed_text
                    .filter(|text| !text.is_empty())
                    .ok_or_else(|| "structured inference completed without output".to_string())?;
                return Ok(CompletedOutput {
                    completed_text,
                    delta_text,
                });
            }
            _ => {}
        }
    }
}

fn interrupt(app_server: &AppServerRuntime, operation: &ActiveOperation) {
    if let (Some(thread_id), Some(turn_id)) = (&operation.thread_id, &operation.turn_id) {
        let _ = app_server.request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        );
    }
}

fn spawn_event_router(inner: Arc<Inner>, event_rx: mpsc::Receiver<AppServerEvent>) {
    thread::spawn(move || {
        for event in event_rx {
            match event {
                AppServerEvent::Notification(notification) => {
                    let thread_id = notification
                        .get("params")
                        .and_then(|params| params.get("threadId"))
                        .and_then(Value::as_str)
                        .or_else(|| {
                            notification
                                .get("params")
                                .and_then(|params| params.get("thread"))
                                .and_then(|thread| thread.get("id"))
                                .and_then(Value::as_str)
                        });
                    if let Some(sender) = thread_id.and_then(|thread_id| {
                        inner
                            .subscriptions
                            .lock()
                            .ok()
                            .and_then(|subscriptions| subscriptions.get(thread_id).cloned())
                    }) {
                        let _ = sender.send(notification);
                    }
                }
                AppServerEvent::Disconnected(reason) => {
                    let notification = json!({
                        "method": "app-server/disconnected",
                        "params": { "reason": reason },
                    });
                    if let Ok(subscriptions) = inner.subscriptions.lock() {
                        for sender in subscriptions.values() {
                            let _ = sender.send(notification.clone());
                        }
                    }
                }
                AppServerEvent::Reconnected
                | AppServerEvent::ManagementLog { .. }
                | AppServerEvent::ServerRequest(_) => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::AppServerEventSink;

    fn valid_params() -> GenerateParams {
        GenerateParams {
            api_version: 1,
            effort: "low".to_string(),
            input: "{\"value\":1}".to_string(),
            instructions: "Return JSON.".to_string(),
            model: "gpt-5.6-sol".to_string(),
            operation_id: "fixture:1".to_string(),
            output_schema: json!({ "type": "object" }),
            service_tier: "priority".to_string(),
            progress: None,
        }
    }

    #[test]
    fn validates_the_closed_gateway_profile() {
        assert!(validate_generate_params(&valid_params()).is_ok());
        let mut params = valid_params();
        params.effort = "high".to_string();
        assert!(validate_generate_params(&params).is_err());
        let mut params = valid_params();
        params.output_schema = Value::Null;
        assert!(validate_generate_params(&params).is_err());
        let mut params = valid_params();
        params.service_tier = "standard".to_string();
        assert!(validate_generate_params(&params).is_err());
    }

    #[test]
    fn forwards_only_exact_turn_deltas_and_preserves_the_completed_text() {
        let (sender, receiver) = mpsc::channel();
        for notification in [
            json!({
                "method": "item/agentMessage/delta",
                "params": { "threadId": "thread", "turnId": "other", "delta": "ignored" },
            }),
            json!({
                "method": "item/agentMessage/delta",
                "params": { "threadId": "thread", "turnId": "turn", "delta": "{\"v\":" },
            }),
            json!({
                "method": "item/agentMessage/delta",
                "params": { "threadId": "thread", "turnId": "turn", "delta": "4}" },
            }),
            json!({
                "method": "item/completed",
                "params": {
                    "threadId": "thread",
                    "turnId": "turn",
                    "item": { "type": "agentMessage", "text": "{\"v\":4}" },
                },
            }),
            json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "thread",
                    "turn": { "id": "turn", "status": "completed" },
                },
            }),
        ] {
            sender.send(notification).unwrap();
        }
        let mut deltas = String::new();
        let output = wait_for_output(
            "thread",
            "turn",
            receiver,
            |delta| {
                deltas.push_str(delta);
                Ok(())
            },
            || false,
        )
        .unwrap();
        assert_eq!(deltas, "{\"v\":4}");
        assert_eq!(output.delta_text, output.completed_text);
    }

    #[test]
    fn splits_progress_on_utf8_boundaries() {
        assert_eq!(split_utf8("ab😀cd", 4), ["ab", "😀", "cd"]);
    }

    #[test]
    fn wait_observes_cancellation_without_an_app_server_event() {
        let (_sender, receiver) = mpsc::channel();
        assert_eq!(
            wait_for_output("thread", "turn", receiver, |_| Ok(()), || true).unwrap_err(),
            "structured inference cancelled"
        );
    }

    #[test]
    fn cancellation_is_remembered_before_thread_and_turn_ids_exist() {
        let (sink, receiver) = AppServerEventSink::channel();
        let server = StructuredInferenceServer::new(
            PathBuf::from("/tmp/remux-structured-inference-test"),
            AppServerRuntime::new_with_event_sink(
                PathBuf::from("/tmp/remux-structured-inference-test"),
                sink,
            ),
            receiver,
            mpsc::sync_channel(1).0,
        );
        server
            .inner
            .active
            .lock()
            .unwrap()
            .insert("fixture".to_string(), ActiveOperation::default());
        server.cancel(json!({ "operationId": "fixture" })).unwrap();
        assert!(server.operation_cancelled("fixture").unwrap());
        assert!(
            server
                .update_active("fixture", |operation| {
                    operation.thread_id = Some("late-thread".to_string());
                })
                .unwrap()
        );
    }

    #[test]
    fn wait_observes_global_app_server_disconnects() {
        let (sender, receiver) = mpsc::channel();
        sender
            .send(json!({
                "method": "app-server/disconnected",
                "params": { "reason": "fixture" },
            }))
            .unwrap();
        assert_eq!(
            wait_for_output("thread", "turn", receiver, |_| Ok(()), || false).unwrap_err(),
            "structured inference app server disconnected"
        );
    }
}
