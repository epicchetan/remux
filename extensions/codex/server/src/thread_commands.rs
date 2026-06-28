use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::app_server::AppServerRuntime;
use crate::composer_config::{ComposerConfig, ComposerConfigStore};
use crate::live_transcript::LiveTranscriptStore;
use crate::resource_invalidations::{command_accepted_invalidations, send_accepted_invalidations};
use crate::thread_runtime::ThreadRuntimeStore;

#[derive(Debug)]
pub(crate) struct CodexThreadCommandServer {
    app_server: Arc<dyn AppServerRequester>,
    composer_config: ComposerConfigStore,
    live_transcript: LiveTranscriptStore,
    resumed_thread_ids: Mutex<HashSet<String>>,
    thread_runtime: ThreadRuntimeStore,
}

trait AppServerRequester: Send + Sync + std::fmt::Debug {
    fn request(&self, method: &str, params: Value) -> Result<Value, String>;
}

impl AppServerRequester for AppServerRuntime {
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        AppServerRuntime::request(self, method, params)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadMessageEditParams {
    client_message_id: Option<String>,
    parts: Vec<ComposerMessagePart>,
    thread_id: String,
    turn_id: String,
    user_message_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadMessageForkParams {
    assistant_message_id: String,
    client_message_id: Option<String>,
    parts: Vec<ComposerMessagePart>,
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadMessageSendParams {
    client_message_id: Option<String>,
    parts: Vec<ComposerMessagePart>,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadMessageStartParams {
    client_message_id: Option<String>,
    composer_config: Option<ComposerConfig>,
    cwd: String,
    parts: Vec<ComposerMessagePart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCompactParams {
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadTurnInterruptParams {
    thread_id: String,
    turn_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ComposerMessagePart {
    Text {
        text: String,
    },
    Image {
        #[serde(rename = "dataUrl")]
        data_url: String,
        #[allow(dead_code)]
        #[serde(rename = "mimeType")]
        mime_type: Option<String>,
        #[allow(dead_code)]
        name: Option<String>,
    },
    Mention {
        name: Option<String>,
        path: String,
    },
}

impl CodexThreadCommandServer {
    pub(crate) fn new(
        app_server: AppServerRuntime,
        composer_config: ComposerConfigStore,
        live_transcript: LiveTranscriptStore,
        thread_runtime: ThreadRuntimeStore,
    ) -> Self {
        Self::with_requester_and_live_transcript(
            Arc::new(app_server),
            composer_config,
            live_transcript,
            thread_runtime,
        )
    }

    #[cfg(test)]
    fn with_requester(app_server: Arc<dyn AppServerRequester>) -> Self {
        Self::with_requester_and_live_transcript(
            app_server,
            ComposerConfigStore::default(),
            LiveTranscriptStore::default(),
            ThreadRuntimeStore::default(),
        )
    }

    fn with_requester_and_live_transcript(
        app_server: Arc<dyn AppServerRequester>,
        composer_config: ComposerConfigStore,
        live_transcript: LiveTranscriptStore,
        thread_runtime: ThreadRuntimeStore,
    ) -> Self {
        Self {
            app_server,
            composer_config,
            live_transcript,
            resumed_thread_ids: Mutex::new(HashSet::new()),
            thread_runtime,
        }
    }

    pub(crate) fn edit_message(&self, params: Value) -> Result<Value, String> {
        let params: ThreadMessageEditParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid thread message/edit params: {error}"))?;
        let thread_id = params.thread_id.trim().to_string();
        if thread_id.is_empty() {
            return Err("threadId is required".to_string());
        }
        let turn_id = params.turn_id.trim().to_string();
        if turn_id.is_empty() {
            return Err("turnId is required".to_string());
        }
        if params.user_message_id.trim().is_empty() {
            return Err("userMessageId is required".to_string());
        }

        let input = composer_parts_to_user_input(params.parts)?;
        self.ensure_thread_resumed(&thread_id)?;

        self.app_server.request(
            "thread/rollback",
            json!({
                "threadId": thread_id.clone(),
                "numTurns": 1,
            }),
        )?;
        self.live_transcript.remove_turn(&thread_id, &turn_id);

        let new_turn_id = self.start_turn(&thread_id, params.client_message_id, input)?;

        Ok(json!({
            "invalidations": command_accepted_invalidations(&thread_id),
            "status": "accepted",
            "threadId": thread_id,
            "turnId": new_turn_id,
        }))
    }

    pub(crate) fn fork_message(&self, params: Value) -> Result<Value, String> {
        let params: ThreadMessageForkParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid thread message/fork params: {error}"))?;
        let source_thread_id = params.thread_id.trim().to_string();
        if source_thread_id.is_empty() {
            return Err("threadId is required".to_string());
        }
        let turn_id = params.turn_id.trim().to_string();
        if turn_id.is_empty() {
            return Err("turnId is required".to_string());
        }
        let assistant_message_id = params.assistant_message_id.trim().to_string();
        if assistant_message_id.is_empty() {
            return Err("assistantMessageId is required".to_string());
        }

        let input = composer_parts_to_user_input(params.parts)?;
        self.ensure_thread_resumed(&source_thread_id)?;
        let fork_target =
            self.resolve_fork_target(&source_thread_id, &turn_id, &assistant_message_id)?;

        let fork_response = self.app_server.request(
            "thread/fork",
            json!({
                "threadId": source_thread_id,
                "excludeTurns": true,
                "persistExtendedHistory": false,
            }),
        )?;
        let fork_thread_id = fork_response
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "thread/fork response missing thread.id".to_string())?
            .to_string();
        if let Ok(config) = self.composer_config.config_for_thread(&source_thread_id) {
            let _ = self
                .composer_config
                .seed_thread_config(&fork_thread_id, config);
        }
        if fork_target.rollback_turns_after > 0 {
            self.app_server.request(
                "thread/rollback",
                json!({
                    "threadId": fork_thread_id.clone(),
                    "numTurns": fork_target.rollback_turns_after,
                }),
            )?;
        }
        self.mark_thread_resumed(&fork_thread_id)?;

        let new_turn_id = self.start_turn(&fork_thread_id, params.client_message_id, input)?;

        Ok(json!({
            "invalidations": command_accepted_invalidations(&fork_thread_id),
            "status": "accepted",
            "threadId": fork_thread_id,
            "turnId": new_turn_id,
        }))
    }

    pub(crate) fn send_message(&self, params: Value) -> Result<Value, String> {
        let params: ThreadMessageSendParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid thread message/send params: {error}"))?;
        let thread_id = params.thread_id.trim().to_string();
        if thread_id.is_empty() {
            return Err("threadId is required".to_string());
        }

        let input = composer_parts_to_user_input(params.parts)?;
        self.ensure_thread_resumed(&thread_id)?;

        let turn_id = self.start_turn(&thread_id, params.client_message_id, input)?;

        Ok(json!({
            "invalidations": send_accepted_invalidations(&thread_id),
            "status": "accepted",
            "threadId": thread_id,
            "turnId": turn_id,
        }))
    }

    pub(crate) fn start_message(&self, params: Value) -> Result<Value, String> {
        let params: ThreadMessageStartParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid thread message/start params: {error}"))?;
        let cwd = params.cwd.trim().to_string();
        if cwd.is_empty() {
            return Err("cwd is required".to_string());
        }

        let input = composer_parts_to_user_input(params.parts)?;
        let composer_config = params.composer_config;
        let mut start_params = match composer_config {
            Some(config) => self.composer_config.thread_start_params_for_config(config),
            None => self.composer_config.thread_start_params()?,
        };
        start_params.insert("cwd".to_string(), json!(cwd));
        start_params.insert("experimentalRawEvents".to_string(), json!(false));
        start_params.insert("persistExtendedHistory".to_string(), json!(false));
        let response = self
            .app_server
            .request("thread/start", Value::Object(start_params))?;
        let thread_id = response
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "thread/start response missing thread.id".to_string())?
            .to_string();
        self.mark_thread_resumed(&thread_id)?;
        if let Some(config) = composer_config {
            let _ = self.composer_config.seed_thread_config(&thread_id, config);
        }

        let turn_id = self.start_turn(&thread_id, params.client_message_id, input)?;

        Ok(json!({
            "invalidations": send_accepted_invalidations(&thread_id),
            "status": "accepted",
            "threadId": thread_id,
            "turnId": turn_id,
        }))
    }

    pub(crate) fn compact_thread(&self, params: Value) -> Result<Value, String> {
        let params: ThreadCompactParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid thread compact params: {error}"))?;
        let thread_id = params.thread_id.trim().to_string();
        if thread_id.is_empty() {
            return Err("threadId is required".to_string());
        }

        self.ensure_thread_resumed(&thread_id)?;
        self.app_server.request(
            "thread/compact/start",
            json!({
                "threadId": thread_id.clone(),
            }),
        )?;

        Ok(json!({
            "invalidations": command_accepted_invalidations(&thread_id),
            "status": "accepted",
            "threadId": thread_id,
        }))
    }

    pub(crate) fn interrupt_turn(&self, params: Value) -> Result<Value, String> {
        let params: ThreadTurnInterruptParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid thread turn/interrupt params: {error}"))?;
        let thread_id = params.thread_id.trim().to_string();
        if thread_id.is_empty() {
            return Err("threadId is required".to_string());
        }
        let turn_id = params
            .turn_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| self.thread_runtime.active_turn_id(&thread_id))
            .ok_or_else(|| "turnId is required when no active turn is known".to_string())?;

        self.app_server.request(
            "turn/interrupt",
            json!({
                "threadId": thread_id.clone(),
                "turnId": turn_id.clone(),
            }),
        )?;
        self.thread_runtime
            .record_turn_stopping(&thread_id, Some(&turn_id));

        Ok(json!({
            "invalidations": command_accepted_invalidations(&thread_id),
            "status": "accepted",
            "threadId": thread_id,
            "turnId": turn_id,
        }))
    }

    fn ensure_thread_resumed(&self, thread_id: &str) -> Result<(), String> {
        {
            let resumed = self
                .resumed_thread_ids
                .lock()
                .map_err(|_| "resumed thread registry poisoned".to_string())?;
            if resumed.contains(thread_id) {
                return Ok(());
            }
        }

        self.resume_thread(thread_id)?;
        self.mark_thread_resumed(thread_id)?;
        Ok(())
    }

    fn mark_thread_resumed(&self, thread_id: &str) -> Result<(), String> {
        let mut resumed = self
            .resumed_thread_ids
            .lock()
            .map_err(|_| "resumed thread registry poisoned".to_string())?;
        resumed.insert(thread_id.to_string());
        Ok(())
    }

    fn resume_thread(&self, thread_id: &str) -> Result<(), String> {
        let params = json!({
            "threadId": thread_id,
            "excludeTurns": true,
        });

        match self.app_server.request("thread/resume", params) {
            Ok(_) => Ok(()),
            Err(first_error) if should_retry_legacy_resume(&first_error) => self
                .app_server
                .request(
                    "thread/resume",
                    json!({
                        "threadId": thread_id,
                        "excludeTurns": true,
                        "persistExtendedHistory": false,
                    }),
                )
                .map(|_| ())
                .map_err(|second_error| {
                    format!("{first_error}; legacy resume retry failed: {second_error}")
                }),
            Err(error) => Err(error),
        }
    }

    fn resolve_fork_target(
        &self,
        thread_id: &str,
        turn_id: &str,
        assistant_message_id: &str,
    ) -> Result<ForkTarget, String> {
        let response = self.app_server.request(
            "thread/read",
            json!({
                "threadId": thread_id,
                "includeTurns": true,
            }),
        )?;
        fork_target_from_thread_read(&response, turn_id, assistant_message_id)
    }

    fn start_turn(
        &self,
        thread_id: &str,
        client_message_id: Option<String>,
        input: Vec<Value>,
    ) -> Result<String, String> {
        let mut start_params = self
            .composer_config
            .turn_start_params_for_thread(thread_id)?;
        start_params.insert("threadId".to_string(), json!(thread_id));
        start_params.insert("clientUserMessageId".to_string(), json!(client_message_id));
        start_params.insert("input".to_string(), json!(input));

        let response = match self
            .app_server
            .request("turn/start", Value::Object(start_params))
        {
            Ok(response) => response,
            Err(error) => {
                self.thread_runtime
                    .record_turn_failed(thread_id, None, &error);
                return Err(error);
            }
        };
        let turn_id = response
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "turn/start response missing turn.id".to_string())?
            .to_string();
        if let Some(turn) = response.get("turn") {
            self.live_transcript.record_turn(thread_id, turn);
        }
        self.thread_runtime
            .record_turn_started(thread_id, Some(&turn_id));
        Ok(turn_id)
    }
}

#[derive(Debug, Eq, PartialEq)]
struct ForkTarget {
    rollback_turns_after: usize,
}

fn fork_target_from_thread_read(
    response: &Value,
    turn_id: &str,
    assistant_message_id: &str,
) -> Result<ForkTarget, String> {
    let turns = response
        .get("thread")
        .and_then(|thread| thread.get("turns"))
        .and_then(Value::as_array)
        .ok_or_else(|| "thread/read response missing thread.turns".to_string())?;
    let turn_index = turns
        .iter()
        .position(|turn| turn.get("id").and_then(Value::as_str) == Some(turn_id))
        .ok_or_else(|| format!("turnId {turn_id} was not found in source thread"))?;
    let turn = &turns[turn_index];
    if !turn_contains_forkable_assistant_message(turn, assistant_message_id) {
        return Err(format!(
            "assistantMessageId {assistant_message_id} was not found in turn {turn_id}"
        ));
    }

    Ok(ForkTarget {
        rollback_turns_after: turns.len().saturating_sub(turn_index + 1),
    })
}

fn turn_contains_forkable_assistant_message(turn: &Value, assistant_message_id: &str) -> bool {
    turn.get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| is_forkable_assistant_message(item, assistant_message_id))
        })
}

fn is_forkable_assistant_message(item: &Value, assistant_message_id: &str) -> bool {
    item.get("type").and_then(Value::as_str) == Some("agentMessage")
        && item.get("id").and_then(Value::as_str) == Some(assistant_message_id)
        && item
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
        && matches!(
            item.get("phase").and_then(Value::as_str),
            None | Some("final_answer")
        )
}

fn composer_parts_to_user_input(parts: Vec<ComposerMessagePart>) -> Result<Vec<Value>, String> {
    let mut input = Vec::new();

    for part in parts {
        match part {
            ComposerMessagePart::Text { text } => {
                if text.trim().is_empty() {
                    continue;
                }
                push_text_input(&mut input, text);
            }
            ComposerMessagePart::Image { data_url, .. } => {
                if data_url.trim().is_empty() {
                    continue;
                }
                input.push(json!({
                    "type": "image",
                    "url": data_url,
                }));
            }
            ComposerMessagePart::Mention { name, path } => {
                let path = path.trim().to_string();
                if path.is_empty() {
                    continue;
                }
                input.push(json!({
                    "type": "mention",
                    "name": name
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| path.clone()),
                    "path": path,
                }));
            }
        }
    }

    if input.is_empty() {
        return Err("message parts must include text, an image, or a mention".to_string());
    }

    Ok(input)
}

fn push_text_input(input: &mut Vec<Value>, text: String) {
    if let Some(previous) = input.last_mut() {
        if previous.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(previous_text) = previous.get("text").and_then(Value::as_str) {
                let mut merged = previous_text.to_string();
                merged.push_str(&text);
                previous["text"] = Value::String(merged);
                return;
            }
        }
    }

    input.push(json!({
        "type": "text",
        "text": text,
        "text_elements": [],
    }));
}

fn should_retry_legacy_resume(error: &str) -> bool {
    error.contains("persistExtendedHistory")
        || (error.contains("missing field") && error.contains("thread/resume"))
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    #[derive(Debug)]
    struct FakeAppServer {
        calls: Mutex<Vec<(String, Value)>>,
        responses: Mutex<VecDeque<Result<Value, String>>>,
    }

    impl FakeAppServer {
        fn new(responses: Vec<Result<Value, String>>) -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                responses: Mutex::new(VecDeque::from(responses)),
            })
        }

        fn calls(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl AppServerRequester for FakeAppServer {
        fn request(&self, method: &str, params: Value) -> Result<Value, String> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err("missing fake response".to_string()))
        }
    }

    #[test]
    fn sends_existing_thread_message_after_resuming_thread() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({ "turn": { "id": "turn-1" } })),
        ]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());

        let response = server
            .send_message(json!({
                "threadId": "thread-1",
                "clientMessageId": "client-1",
                "parts": [
                    { "type": "text", "text": "Hello " },
                    { "type": "mention", "name": "main.rs", "path": "src/main.rs" },
                    { "type": "image", "dataUrl": "data:image/png;base64,aGVsbG8=", "mimeType": "image/png", "name": "image.png" }
                ]
            }))
            .unwrap();

        assert_eq!(response["status"], "accepted");
        assert_eq!(response["turnId"], "turn-1");
        assert_eq!(response["invalidations"].as_array().unwrap().len(), 5);

        let calls = app_server.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "thread/resume");
        assert_eq!(calls[0].1["threadId"], "thread-1");
        assert_eq!(calls[0].1["excludeTurns"], true);
        assert_eq!(calls[1].0, "turn/start");
        assert_eq!(calls[1].1["threadId"], "thread-1");
        assert_eq!(calls[1].1["clientUserMessageId"], "client-1");
        assert_eq!(calls[1].1["effort"], "high");
        assert_eq!(calls[1].1["approvalsReviewer"], "auto_review");
        assert_eq!(
            calls[1].1["input"],
            json!([
                { "type": "text", "text": "Hello ", "text_elements": [] },
                { "type": "mention", "name": "main.rs", "path": "src/main.rs" },
                { "type": "image", "url": "data:image/png;base64,aGVsbG8=" }
            ])
        );
    }

    #[test]
    fn starts_new_thread_then_sends_first_message() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-new" } })),
            Ok(json!({ "turn": { "id": "turn-new" } })),
            Ok(json!({ "turn": { "id": "turn-followup" } })),
        ]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());

        let response = server
            .start_message(json!({
                "cwd": "/tmp/project",
                "clientMessageId": "client-new",
                "parts": [{ "type": "text", "text": "Start here" }]
            }))
            .unwrap();
        server
            .send_message(json!({
                "threadId": "thread-new",
                "parts": [{ "type": "text", "text": "Follow up" }]
            }))
            .unwrap();

        assert_eq!(response["status"], "accepted");
        assert_eq!(response["threadId"], "thread-new");
        assert_eq!(response["turnId"], "turn-new");

        let calls = app_server.calls();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "thread/start");
        assert_eq!(calls[0].1["cwd"], "/tmp/project");
        assert_eq!(calls[0].1["effort"], "high");
        assert_eq!(calls[0].1["approvalsReviewer"], "auto_review");
        assert_eq!(calls[0].1["experimentalRawEvents"], false);
        assert_eq!(calls[0].1["persistExtendedHistory"], false);
        assert_eq!(calls[1].0, "turn/start");
        assert_eq!(calls[1].1["threadId"], "thread-new");
        assert_eq!(calls[1].1["clientUserMessageId"], "client-new");
        assert_eq!(calls[1].1["effort"], "high");
        assert_eq!(calls[1].1["approvalsReviewer"], "auto_review");
        assert_eq!(calls[2].0, "turn/start");
    }

    #[test]
    fn starts_new_thread_with_client_config() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-new" } })),
            Ok(json!({ "turn": { "id": "turn-new" } })),
            Ok(json!({ "turn": { "id": "turn-followup" } })),
        ]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());

        server
            .start_message(json!({
                "cwd": "/tmp/project",
                "clientMessageId": "client-new",
                "composerConfig": {
                    "intelligence": "xhigh",
                    "reviewMode": "full-access",
                    "speed": "fast",
                },
                "parts": [{ "type": "text", "text": "Start here" }]
            }))
            .unwrap();
        server
            .send_message(json!({
                "threadId": "thread-new",
                "parts": [{ "type": "text", "text": "Follow up" }]
            }))
            .unwrap();

        let calls = app_server.calls();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "thread/start");
        assert_eq!(calls[0].1["cwd"], "/tmp/project");
        assert_eq!(calls[0].1["effort"], "xhigh");
        assert_eq!(calls[0].1["serviceTier"], "priority");
        assert_eq!(calls[0].1["approvalPolicy"], "never");
        assert_eq!(calls[0].1["sandbox"], "danger-full-access");
        assert_eq!(calls[1].0, "turn/start");
        assert_eq!(calls[1].1["threadId"], "thread-new");
        assert_eq!(calls[1].1["effort"], "xhigh");
        assert_eq!(calls[1].1["serviceTier"], "priority");
        assert_eq!(calls[1].1["approvalPolicy"], "never");
        assert_eq!(
            calls[1].1["sandboxPolicy"],
            json!({ "type": "dangerFullAccess" })
        );
        assert_eq!(calls[2].0, "turn/start");
        assert_eq!(calls[2].1["threadId"], "thread-new");
        assert_eq!(calls[2].1["effort"], "xhigh");
        assert_eq!(calls[2].1["serviceTier"], "priority");
        assert_eq!(calls[2].1["approvalPolicy"], "never");
    }

    #[test]
    fn edits_latest_user_message_by_rolling_back_then_starting_turn() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({ "turn": { "id": "turn-new" } })),
        ]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());

        let response = server
            .edit_message(json!({
                "threadId": "thread-1",
                "turnId": "turn-old",
                "userMessageId": "user-old",
                "clientMessageId": "client-edit",
                "parts": [{ "type": "text", "text": "Edited prompt" }]
            }))
            .unwrap();

        assert_eq!(response["status"], "accepted");
        assert_eq!(response["threadId"], "thread-1");
        assert_eq!(response["turnId"], "turn-new");
        assert_eq!(response["invalidations"][0]["reason"], "commandAccepted");

        let calls = app_server.calls();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "thread/resume");
        assert_eq!(calls[1].0, "thread/rollback");
        assert_eq!(calls[1].1["threadId"], "thread-1");
        assert_eq!(calls[1].1["numTurns"], 1);
        assert_eq!(calls[2].0, "turn/start");
        assert_eq!(calls[2].1["threadId"], "thread-1");
        assert_eq!(calls[2].1["clientUserMessageId"], "client-edit");
        assert_eq!(
            calls[2].1["input"],
            json!([{ "type": "text", "text": "Edited prompt", "text_elements": [] }])
        );
    }

    #[test]
    fn forks_from_assistant_message_then_starts_turn() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({
                "thread": {
                    "id": "thread-1",
                    "turns": [
                        {
                            "id": "turn-target",
                            "items": [
                                {
                                    "id": "assistant-target",
                                    "phase": null,
                                    "text": "Original response",
                                    "type": "agentMessage"
                                }
                            ]
                        }
                    ]
                }
            })),
            Ok(json!({ "thread": { "id": "thread-fork" } })),
            Ok(json!({ "turn": { "id": "turn-new" } })),
        ]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());

        let response = server
            .fork_message(json!({
                "threadId": "thread-1",
                "turnId": "turn-target",
                "assistantMessageId": "assistant-target",
                "clientMessageId": "client-fork",
                "parts": [{ "type": "text", "text": "Continue differently" }]
            }))
            .unwrap();

        assert_eq!(response["status"], "accepted");
        assert_eq!(response["threadId"], "thread-fork");
        assert_eq!(response["turnId"], "turn-new");

        let calls = app_server.calls();
        assert_eq!(calls.len(), 4);
        assert_eq!(calls[0].0, "thread/resume");
        assert_eq!(calls[1].0, "thread/read");
        assert_eq!(calls[1].1["threadId"], "thread-1");
        assert_eq!(calls[1].1["includeTurns"], true);
        assert_eq!(calls[2].0, "thread/fork");
        assert_eq!(calls[2].1["threadId"], "thread-1");
        assert_eq!(calls[2].1["excludeTurns"], true);
        assert_eq!(calls[2].1["persistExtendedHistory"], false);
        assert_eq!(calls[3].0, "turn/start");
        assert_eq!(calls[3].1["threadId"], "thread-fork");
        assert_eq!(calls[3].1["clientUserMessageId"], "client-fork");
        assert_eq!(
            calls[3].1["input"],
            json!([{ "type": "text", "text": "Continue differently", "text_elements": [] }])
        );
    }

    #[test]
    fn forks_from_historical_assistant_message_by_rolling_back_the_clone() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({
                "thread": {
                    "id": "thread-1",
                    "turns": [
                        {
                            "id": "turn-1",
                            "items": [
                                {
                                    "id": "assistant-1",
                                    "phase": null,
                                    "text": "Earlier response",
                                    "type": "agentMessage"
                                }
                            ]
                        },
                        {
                            "id": "turn-2",
                            "items": [
                                {
                                    "id": "assistant-2",
                                    "phase": null,
                                    "text": "Later response",
                                    "type": "agentMessage"
                                }
                            ]
                        },
                        {
                            "id": "turn-3",
                            "items": [
                                {
                                    "id": "assistant-3",
                                    "phase": null,
                                    "text": "Latest response",
                                    "type": "agentMessage"
                                }
                            ]
                        }
                    ]
                }
            })),
            Ok(json!({ "thread": { "id": "thread-fork" } })),
            Ok(json!({ "thread": { "id": "thread-fork" } })),
            Ok(json!({ "turn": { "id": "turn-new" } })),
        ]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());

        let response = server
            .fork_message(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "assistantMessageId": "assistant-1",
                "clientMessageId": "client-fork",
                "parts": [{ "type": "text", "text": "Branch from earlier" }]
            }))
            .unwrap();

        assert_eq!(response["threadId"], "thread-fork");
        assert_eq!(response["turnId"], "turn-new");

        let calls = app_server.calls();
        assert_eq!(calls.len(), 5);
        assert_eq!(calls[0].0, "thread/resume");
        assert_eq!(calls[1].0, "thread/read");
        assert_eq!(calls[2].0, "thread/fork");
        assert_eq!(calls[3].0, "thread/rollback");
        assert_eq!(calls[3].1["threadId"], "thread-fork");
        assert_eq!(calls[3].1["numTurns"], 2);
        assert_eq!(calls[4].0, "turn/start");
        assert_eq!(calls[4].1["threadId"], "thread-fork");
        assert_eq!(calls[4].1["clientUserMessageId"], "client-fork");
    }

    #[test]
    fn applies_server_owned_config_to_turn_start() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({ "turn": { "id": "turn-1" } })),
        ]);
        let composer_config = ComposerConfigStore::default();
        composer_config
            .write_config(json!({
                "intelligence": "xhigh",
                "reviewMode": "full-access",
                "speed": "fast",
            }))
            .unwrap();
        let server = CodexThreadCommandServer::with_requester_and_live_transcript(
            app_server.clone(),
            composer_config,
            LiveTranscriptStore::default(),
            ThreadRuntimeStore::default(),
        );

        server
            .send_message(json!({
                "threadId": "thread-1",
                "parts": [{ "type": "text", "text": "hello" }]
            }))
            .unwrap();

        let calls = app_server.calls();
        assert_eq!(calls[1].0, "turn/start");
        assert_eq!(calls[1].1["effort"], "xhigh");
        assert_eq!(calls[1].1["serviceTier"], "priority");
        assert_eq!(calls[1].1["approvalPolicy"], "never");
        assert_eq!(
            calls[1].1["sandboxPolicy"],
            json!({ "type": "dangerFullAccess" })
        );
    }

    #[test]
    fn compacts_existing_thread_after_resuming_thread() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({})),
        ]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());

        let response = server
            .compact_thread(json!({
                "threadId": "thread-1",
            }))
            .unwrap();

        assert_eq!(response["status"], "accepted");
        assert_eq!(response["threadId"], "thread-1");
        assert_eq!(response["invalidations"][0]["reason"], "commandAccepted");

        let calls = app_server.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "thread/resume");
        assert_eq!(calls[0].1["threadId"], "thread-1");
        assert_eq!(calls[1].0, "thread/compact/start");
        assert_eq!(calls[1].1, json!({ "threadId": "thread-1" }));
    }

    #[test]
    fn interrupts_active_turn_when_turn_id_is_omitted() {
        let runtime = ThreadRuntimeStore::default();
        runtime.record_turn_started("thread-1", Some("turn-1"));
        let app_server = FakeAppServer::new(vec![Ok(json!({}))]);
        let server = CodexThreadCommandServer::with_requester_and_live_transcript(
            app_server.clone(),
            ComposerConfigStore::default(),
            LiveTranscriptStore::default(),
            runtime.clone(),
        );

        let response = server
            .interrupt_turn(json!({
                "threadId": "thread-1"
            }))
            .unwrap();

        assert_eq!(response["status"], "accepted");
        assert_eq!(response["threadId"], "thread-1");
        assert_eq!(response["turnId"], "turn-1");
        assert_eq!(runtime.resource_value("thread-1")["status"], "stopping");

        let calls = app_server.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "turn/interrupt");
        assert_eq!(calls[0].1["threadId"], "thread-1");
        assert_eq!(calls[0].1["turnId"], "turn-1");
    }

    #[test]
    fn rejects_empty_messages() {
        let app_server = FakeAppServer::new(Vec::new());
        let server = CodexThreadCommandServer::with_requester(app_server.clone());

        let error = server
            .send_message(json!({
                "threadId": "thread-1",
                "parts": [{ "type": "text", "text": "   " }]
            }))
            .unwrap_err();

        assert!(error.contains("message parts"));
        assert!(app_server.calls().is_empty());
    }

    #[test]
    fn resumes_each_thread_once_per_runtime() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({ "turn": { "id": "turn-1" } })),
            Ok(json!({ "turn": { "id": "turn-2" } })),
        ]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());

        server
            .send_message(json!({
                "threadId": "thread-1",
                "parts": [{ "type": "text", "text": "one" }]
            }))
            .unwrap();
        server
            .send_message(json!({
                "threadId": "thread-1",
                "parts": [{ "type": "text", "text": "two" }]
            }))
            .unwrap();

        let methods = app_server
            .calls()
            .into_iter()
            .map(|call| call.0)
            .collect::<Vec<_>>();
        assert_eq!(methods, vec!["thread/resume", "turn/start", "turn/start"]);
    }

    #[test]
    fn retries_resume_with_legacy_persist_field_for_older_app_server() {
        let app_server = FakeAppServer::new(vec![
            Err("thread/resume failed: missing field `persistExtendedHistory`".to_string()),
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({ "turn": { "id": "turn-1" } })),
        ]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());

        server
            .send_message(json!({
                "threadId": "thread-1",
                "parts": [{ "type": "text", "text": "hello" }]
            }))
            .unwrap();

        let calls = app_server.calls();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "thread/resume");
        assert_eq!(calls[0].1.get("persistExtendedHistory"), None);
        assert_eq!(calls[1].0, "thread/resume");
        assert_eq!(calls[1].1["persistExtendedHistory"], false);
        assert_eq!(calls[2].0, "turn/start");
    }

    #[test]
    fn mention_without_name_uses_path_as_name() {
        let input = composer_parts_to_user_input(vec![ComposerMessagePart::Mention {
            name: None,
            path: "src/lib.rs".to_string(),
        }])
        .unwrap();

        assert_eq!(
            input,
            vec![json!({ "type": "mention", "name": "src/lib.rs", "path": "src/lib.rs" })]
        );
    }

    #[test]
    fn send_records_returned_turn_in_live_transcript_store() {
        let live = LiveTranscriptStore::default();
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({
                "turn": {
                    "completedAt": null,
                    "durationMs": null,
                    "error": null,
                    "id": "turn-1",
                    "items": [
                        {
                            "content": [
                                { "type": "text", "text": "hello", "text_elements": [] }
                            ],
                            "id": "user-1",
                            "type": "userMessage"
                        }
                    ],
                    "startedAt": 1,
                    "status": "inProgress"
                }
            })),
        ]);
        let server = CodexThreadCommandServer::with_requester_and_live_transcript(
            app_server,
            ComposerConfigStore::default(),
            live.clone(),
            ThreadRuntimeStore::default(),
        );

        server
            .send_message(json!({
                "threadId": "thread-1",
                "parts": [{ "type": "text", "text": "hello" }]
            }))
            .unwrap();

        let turn = live
            .projected_turn("thread-1", "turn-1")
            .expect("live turn should be recorded");
        assert_eq!(
            turn.turn["segments"][0]["content"][0]["text"],
            json!("hello")
        );
    }
}
