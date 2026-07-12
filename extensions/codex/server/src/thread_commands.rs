use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::app_server::AppServerRuntime;
use crate::composer_config::{ComposerConfig, ComposerConfigStore};
use crate::live_transcript::LiveTranscriptStore;
use crate::resource_invalidations::{command_accepted_invalidations, send_accepted_invalidations};
use crate::resources::CodexTranscriptServer;
use crate::thread_runtime::ThreadRuntimeStore;

#[derive(Clone, Debug)]
pub(crate) struct CodexThreadCommandServer {
    app_server: Arc<dyn AppServerRequester>,
    composer_config: ComposerConfigStore,
    fork_target_validator: Arc<dyn ForkTargetValidator>,
    live_transcript: LiveTranscriptStore,
    thread_runtime: ThreadRuntimeStore,
}

pub(crate) trait AppServerRequester: Send + Sync + std::fmt::Debug {
    fn request(&self, method: &str, params: Value) -> Result<Value, String>;
}

trait ForkTargetValidator: Send + Sync + std::fmt::Debug {
    fn validate(
        &self,
        thread_id: &str,
        turn_id: &str,
        assistant_message_id: &str,
    ) -> Result<(), String>;
}

impl AppServerRequester for AppServerRuntime {
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        AppServerRuntime::request(self, method, params)
    }
}

#[derive(Debug)]
struct ProjectedTranscriptForkTargetValidator {
    live_transcript: LiveTranscriptStore,
    transcript: Mutex<CodexTranscriptServer>,
}

impl ProjectedTranscriptForkTargetValidator {
    fn new(codex_home: PathBuf, live_transcript: LiveTranscriptStore) -> Self {
        Self {
            live_transcript: live_transcript.clone(),
            transcript: Mutex::new(CodexTranscriptServer::new_with_live_transcript(
                codex_home,
                live_transcript,
            )),
        }
    }

    fn validate_transcript_response(
        response: &Value,
        turn_id: &str,
        assistant_message_id: &str,
    ) -> Result<(), String> {
        let resource = response
            .get("resources")
            .and_then(Value::as_array)
            .and_then(|resources| resources.first())
            .ok_or_else(|| "transcript turn response missing resource".to_string())?;
        if resource.get("status").and_then(Value::as_str) != Some("ok") {
            let reason = resource
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("turn_not_found");
            return Err(format!(
                "turnId {turn_id} was not found in source transcript: {reason}"
            ));
        }
        let turn = resource
            .get("value")
            .and_then(|value| value.get("turn"))
            .ok_or_else(|| "transcript turn response missing turn".to_string())?;
        validate_projected_turn(turn, turn_id, assistant_message_id)
    }

    fn validate_live_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        assistant_message_id: &str,
    ) -> Option<Result<(), String>> {
        self.live_transcript
            .projected_turn(thread_id, turn_id)
            .map(|projected| {
                validate_projected_turn(&projected.turn, turn_id, assistant_message_id)
            })
    }
}

impl ForkTargetValidator for ProjectedTranscriptForkTargetValidator {
    fn validate(
        &self,
        thread_id: &str,
        turn_id: &str,
        assistant_message_id: &str,
    ) -> Result<(), String> {
        let transcript_result = self
            .transcript
            .lock()
            .map_err(|_| "fork target transcript validator poisoned".to_string())
            .and_then(|mut transcript| {
                transcript.read_resources(json!({
                    "threadId": thread_id,
                    "requests": [
                        {
                            "type": "turn",
                            "turnId": turn_id,
                        }
                    ],
                }))
            })
            .and_then(|response| {
                Self::validate_transcript_response(&response, turn_id, assistant_message_id)
            });
        let transcript_error = match transcript_result {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };

        match self.validate_live_turn(thread_id, turn_id, assistant_message_id) {
            Some(result) => result,
            None => Err(transcript_error),
        }
    }
}

#[cfg(test)]
#[derive(Debug)]
struct AllowAllForkTargetValidator;

#[cfg(test)]
impl ForkTargetValidator for AllowAllForkTargetValidator {
    fn validate(
        &self,
        _thread_id: &str,
        _turn_id: &str,
        _assistant_message_id: &str,
    ) -> Result<(), String> {
        Ok(())
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

#[cfg(test)]
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

#[cfg(test)]
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ComposerMessagePart {
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
        codex_home: PathBuf,
    ) -> Self {
        let fork_target_validator = Arc::new(ProjectedTranscriptForkTargetValidator::new(
            codex_home,
            live_transcript.clone(),
        ));
        Self::with_requester_live_transcript_and_fork_target_validator(
            Arc::new(app_server),
            composer_config,
            live_transcript,
            thread_runtime,
            fork_target_validator,
        )
    }

    #[cfg(test)]
    pub(crate) fn with_requester(app_server: Arc<dyn AppServerRequester>) -> Self {
        Self::with_requester_live_transcript_and_fork_target_validator(
            app_server,
            ComposerConfigStore::default(),
            LiveTranscriptStore::default(),
            ThreadRuntimeStore::default(),
            Arc::new(AllowAllForkTargetValidator),
        )
    }

    #[cfg(test)]
    pub(crate) fn with_requester_and_live_transcript(
        app_server: Arc<dyn AppServerRequester>,
        composer_config: ComposerConfigStore,
        live_transcript: LiveTranscriptStore,
        thread_runtime: ThreadRuntimeStore,
    ) -> Self {
        Self::with_requester_live_transcript_and_fork_target_validator(
            app_server,
            composer_config,
            live_transcript,
            thread_runtime,
            Arc::new(AllowAllForkTargetValidator),
        )
    }

    #[cfg(test)]
    fn with_requester_and_fork_target_validator(
        app_server: Arc<dyn AppServerRequester>,
        fork_target_validator: Arc<dyn ForkTargetValidator>,
    ) -> Self {
        Self::with_requester_live_transcript_and_fork_target_validator(
            app_server,
            ComposerConfigStore::default(),
            LiveTranscriptStore::default(),
            ThreadRuntimeStore::default(),
            fork_target_validator,
        )
    }

    fn with_requester_live_transcript_and_fork_target_validator(
        app_server: Arc<dyn AppServerRequester>,
        composer_config: ComposerConfigStore,
        live_transcript: LiveTranscriptStore,
        thread_runtime: ThreadRuntimeStore,
        fork_target_validator: Arc<dyn ForkTargetValidator>,
    ) -> Self {
        Self {
            app_server,
            composer_config,
            fork_target_validator,
            live_transcript,
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
        // Editing rolls back and restarts the same thread, which cannot be
        // done underneath a running turn. Viewers gate this too; the server
        // check is authoritative.
        if let Some(active_turn_id) = self.thread_runtime.active_turn_id(&thread_id) {
            return Err(format!(
                "cannot edit a message while turn {active_turn_id} is in progress; interrupt the turn first"
            ));
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
        self.fork_target_validator
            .validate(&source_thread_id, &turn_id, &assistant_message_id)?;

        // `lastTurnId` truncates the fork by turn id inside codex, which stays
        // correct while a newer turn is still running on the source thread.
        // Counting turns here instead would race: the live turn is already
        // listed by thread/turns/list before its rollout entries are
        // guaranteed to exist in the history the fork is built from.
        let fork_response = self.app_server.request(
            "thread/fork",
            json!({
                "threadId": source_thread_id,
                "lastTurnId": turn_id,
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
        let new_turn_id = self.start_turn(&fork_thread_id, params.client_message_id, input)?;

        Ok(json!({
            "invalidations": command_accepted_invalidations(&fork_thread_id),
            "status": "accepted",
            "threadId": fork_thread_id,
            "turnId": new_turn_id,
        }))
    }

    #[cfg(test)]
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
        let mut start_params = match composer_config.as_ref() {
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

    #[cfg(test)]
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
            json!({ "threadId": thread_id.clone() }),
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
        // App-server can tear down per-thread listeners while this extension keeps running.
        // Refreshing resume before existing-thread work keeps completion events flowing.
        self.resume_thread(thread_id)?;
        Ok(())
    }

    fn resume_thread(&self, thread_id: &str) -> Result<(), String> {
        let params = json!({
            "threadId": thread_id,
            "excludeTurns": true,
        });

        self.app_server.request("thread/resume", params).map(|_| ())
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
            .record_turn_accepted(thread_id, Some(&turn_id));
        Ok(turn_id)
    }

    pub(crate) fn dispatch_queued_message(
        &self,
        thread_id: &str,
        client_message_id: Option<String>,
        parts: Vec<ComposerMessagePart>,
    ) -> Result<String, String> {
        let input = composer_parts_to_user_input(parts)?;
        self.ensure_thread_resumed(thread_id)?;
        self.start_turn(thread_id, client_message_id, input)
    }

    pub(crate) fn dispatch_queued_compaction(&self, thread_id: &str) -> Result<(), String> {
        self.ensure_thread_resumed(thread_id)?;
        self.app_server
            .request(
                "thread/compact/start",
                json!({
                    "threadId": thread_id,
                }),
            )
            .map(|_| {
                self.thread_runtime.record_turn_accepted(thread_id, None);
            })
    }

    pub(crate) fn steer_queued_message(
        &self,
        thread_id: &str,
        expected_turn_id: &str,
        client_message_id: Option<String>,
        parts: Vec<ComposerMessagePart>,
    ) -> Result<String, String> {
        let input = composer_parts_to_user_input(parts)?;
        self.ensure_thread_resumed(thread_id)?;
        let response = self.app_server.request(
            "turn/steer",
            json!({
                "expectedTurnId": expected_turn_id,
                "clientUserMessageId": client_message_id,
                "input": input,
                "threadId": thread_id,
            }),
        )?;
        response
            .get("turnId")
            .or_else(|| response.get("turn").and_then(|turn| turn.get("id")))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "turn/steer response missing turnId".to_string())
    }
}

fn validate_projected_turn(
    turn: &Value,
    turn_id: &str,
    assistant_message_id: &str,
) -> Result<(), String> {
    if projected_turn_contains_forkable_assistant_message(turn, assistant_message_id) {
        return Ok(());
    }

    Err(format!(
        "assistantMessageId {assistant_message_id} was not found in turn {turn_id}"
    ))
}

fn projected_turn_contains_forkable_assistant_message(
    turn: &Value,
    assistant_message_id: &str,
) -> bool {
    turn.get("segments")
        .and_then(Value::as_array)
        .is_some_and(|segments| {
            segments
                .iter()
                .any(|segment| is_forkable_assistant_message(segment, assistant_message_id))
        })
}

fn is_forkable_assistant_message(item: &Value, assistant_message_id: &str) -> bool {
    item.get("type").and_then(Value::as_str) == Some("assistantMessage")
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

/// Codex reserves `UserInput::Mention` for app/plugin connector targets
/// (`app://…`, `plugin://…`) and drops it from the model prompt entirely, so
/// filesystem mentions must be rendered into the text stream. Each mention
/// becomes a `text_elements` span over the literal path so viewers can keep
/// rendering it as a chip; the span survives resume because Codex rebases
/// `text_elements` onto the flattened `user_message` event text.
pub(crate) fn composer_parts_to_user_input(
    parts: Vec<ComposerMessagePart>,
) -> Result<Vec<Value>, String> {
    let mut input = Vec::new();
    let mut run = MentionTextRun::default();

    for part in parts {
        match part {
            ComposerMessagePart::Text { text } => {
                run.push_text(&text);
            }
            ComposerMessagePart::Image { data_url, .. } => {
                if data_url.trim().is_empty() {
                    continue;
                }
                run.flush_into(&mut input);
                input.push(json!({
                    "type": "image",
                    "url": data_url,
                }));
            }
            ComposerMessagePart::Mention { name, path } => {
                let path = path.trim();
                if path.is_empty() {
                    continue;
                }
                let name = name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(path);
                run.push_mention(name, path);
            }
        }
    }
    run.flush_into(&mut input);

    if input.is_empty() {
        return Err("message parts must include text, an image, or a mention".to_string());
    }

    Ok(input)
}

#[derive(Default)]
struct MentionTextRun {
    text: String,
    elements: Vec<Value>,
}

impl MentionTextRun {
    fn push_text(&mut self, text: &str) {
        self.text.push_str(text);
    }

    fn push_mention(&mut self, name: &str, path: &str) {
        // Quote paths containing whitespace so the model reads them as one
        // token, mirroring the Codex TUI file-mention insertion.
        let rendered = if path.chars().any(char::is_whitespace) && !path.contains('"') {
            format!("\"{path}\"")
        } else {
            path.to_string()
        };
        let start = self.text.len();
        self.text.push_str(&rendered);
        self.elements.push(json!({
            "byteRange": { "start": start, "end": self.text.len() },
            "placeholder": format!("@{name}"),
        }));
    }

    fn flush_into(&mut self, input: &mut Vec<Value>) {
        if self.elements.is_empty() && self.text.trim().is_empty() {
            self.text.clear();
            return;
        }
        input.push(json!({
            "type": "text",
            "text": std::mem::take(&mut self.text),
            "text_elements": std::mem::take(&mut self.elements),
        }));
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[derive(Debug)]
    struct FakeAppServer {
        calls: Mutex<Vec<(String, Value)>>,
        responses: Mutex<VecDeque<Result<Value, String>>>,
    }

    #[derive(Debug)]
    struct RecordingForkTargetValidator {
        calls: Mutex<Vec<(String, String, String)>>,
        result: Result<(), String>,
    }

    impl RecordingForkTargetValidator {
        fn accepting() -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                result: Ok(()),
            })
        }

        fn rejecting(error: &str) -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                result: Err(error.to_string()),
            })
        }

        fn calls(&self) -> Vec<(String, String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl ForkTargetValidator for RecordingForkTargetValidator {
        fn validate(
            &self,
            thread_id: &str,
            turn_id: &str,
            assistant_message_id: &str,
        ) -> Result<(), String> {
            self.calls.lock().unwrap().push((
                thread_id.to_string(),
                turn_id.to_string(),
                assistant_message_id.to_string(),
            ));
            self.result.clone()
        }
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
        assert_eq!(response["invalidations"].as_array().unwrap().len(), 6);

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
                {
                    "type": "text",
                    "text": "Hello src/main.rs",
                    "text_elements": [
                        { "byteRange": { "start": 6, "end": 17 }, "placeholder": "@main.rs" }
                    ]
                },
                { "type": "image", "url": "data:image/png;base64,aGVsbG8=" }
            ])
        );
    }

    #[test]
    fn starts_new_thread_then_sends_first_message() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-new" } })),
            Ok(json!({ "turn": { "id": "turn-new" } })),
            Ok(json!({ "thread": { "id": "thread-new" } })),
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
        assert_eq!(calls.len(), 4);
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
        assert_eq!(calls[2].0, "thread/resume");
        assert_eq!(calls[2].1["threadId"], "thread-new");
        assert_eq!(calls[3].0, "turn/start");
        assert_eq!(calls[3].1["threadId"], "thread-new");
    }

    #[test]
    fn starts_new_thread_with_client_config() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-new" } })),
            Ok(json!({ "turn": { "id": "turn-new" } })),
            Ok(json!({ "thread": { "id": "thread-new" } })),
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
        assert_eq!(calls.len(), 4);
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
        assert_eq!(calls[2].0, "thread/resume");
        assert_eq!(calls[2].1["threadId"], "thread-new");
        assert_eq!(calls[3].0, "turn/start");
        assert_eq!(calls[3].1["threadId"], "thread-new");
        assert_eq!(calls[3].1["effort"], "xhigh");
        assert_eq!(calls[3].1["serviceTier"], "priority");
        assert_eq!(calls[3].1["approvalPolicy"], "never");
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
    fn rejects_edit_while_a_turn_is_in_progress() {
        let app_server = FakeAppServer::new(vec![]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());
        server
            .thread_runtime
            .record_turn_started("thread-1", Some("turn-live"));

        let error = server
            .edit_message(json!({
                "threadId": "thread-1",
                "turnId": "turn-old",
                "userMessageId": "user-old",
                "clientMessageId": "client-edit",
                "parts": [{ "type": "text", "text": "Edited prompt" }]
            }))
            .unwrap_err();

        assert_eq!(
            error,
            "cannot edit a message while turn turn-live is in progress; interrupt the turn first"
        );
        assert!(app_server.calls().is_empty());
    }

    #[test]
    fn forks_from_assistant_message_then_starts_turn() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
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
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "thread/resume");
        assert_eq!(calls[1].0, "thread/fork");
        assert_eq!(calls[1].1["threadId"], "thread-1");
        assert_eq!(calls[1].1["lastTurnId"], "turn-target");
        assert_eq!(calls[1].1["excludeTurns"], true);
        assert_eq!(calls[1].1["persistExtendedHistory"], false);
        assert_eq!(calls[2].0, "turn/start");
        assert_eq!(calls[2].1["threadId"], "thread-fork");
        assert_eq!(calls[2].1["clientUserMessageId"], "client-fork");
        assert_eq!(
            calls[2].1["input"],
            json!([{ "type": "text", "text": "Continue differently", "text_elements": [] }])
        );
    }

    #[test]
    fn forks_while_source_thread_turn_is_in_progress() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({ "thread": { "id": "thread-fork" } })),
            Ok(json!({ "turn": { "id": "turn-new" } })),
        ]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());
        server
            .thread_runtime
            .record_turn_started("thread-1", Some("turn-live"));

        let response = server
            .fork_message(json!({
                "threadId": "thread-1",
                "turnId": "turn-target",
                "assistantMessageId": "assistant-target",
                "clientMessageId": "client-fork",
                "parts": [{ "type": "text", "text": "Branch while running" }]
            }))
            .unwrap();

        assert_eq!(response["status"], "accepted");
        assert_eq!(response["threadId"], "thread-fork");
        let calls = app_server.calls();
        // Truncation happens by turn id inside codex, so the running turn on
        // the source thread never enters the arithmetic.
        assert_eq!(calls[1].0, "thread/fork");
        assert_eq!(calls[1].1["lastTurnId"], "turn-target");
    }

    #[test]
    fn forks_using_projected_assistant_message_id_when_app_server_item_id_differs() {
        let validator = RecordingForkTargetValidator::accepting();
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({ "thread": { "id": "thread-fork" } })),
            Ok(json!({ "turn": { "id": "turn-new" } })),
        ]);
        let server = CodexThreadCommandServer::with_requester_and_fork_target_validator(
            app_server.clone(),
            validator.clone(),
        );

        let projected_assistant_id =
            "cxitem:v1:turn-target:id:msg_0c2fa199e980d76e016a415275301c819c933511afd5b56fec";
        let response = server
            .fork_message(json!({
                "threadId": "thread-1",
                "turnId": "turn-target",
                "assistantMessageId": projected_assistant_id,
                "clientMessageId": "client-fork",
                "parts": [{ "type": "text", "text": "Continue differently" }]
            }))
            .unwrap();

        assert_eq!(response["threadId"], "thread-fork");
        assert_eq!(response["turnId"], "turn-new");
        assert_eq!(
            validator.calls(),
            vec![(
                "thread-1".to_string(),
                "turn-target".to_string(),
                projected_assistant_id.to_string()
            )]
        );

        let calls = app_server.calls();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[1].0, "thread/fork");
        assert_eq!(calls[1].1["lastTurnId"], "turn-target");
    }

    #[test]
    fn fork_target_validator_error_prevents_fork() {
        let validator = RecordingForkTargetValidator::rejecting(
            "assistantMessageId projected-assistant was not found in turn turn-target",
        );
        let app_server = FakeAppServer::new(vec![Ok(json!({ "thread": { "id": "thread-1" } }))]);
        let server = CodexThreadCommandServer::with_requester_and_fork_target_validator(
            app_server.clone(),
            validator,
        );

        let error = server
            .fork_message(json!({
                "threadId": "thread-1",
                "turnId": "turn-target",
                "assistantMessageId": "projected-assistant",
                "parts": [{ "type": "text", "text": "Continue differently" }]
            }))
            .unwrap_err();

        assert_eq!(
            error,
            "assistantMessageId projected-assistant was not found in turn turn-target"
        );
        let calls = app_server.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "thread/resume");
    }

    #[test]
    fn projected_turn_forkability_uses_transcript_assistant_segments() {
        let turn = json!({
            "id": "turn-1",
            "segments": [
                {
                    "id": "work-1",
                    "type": "work"
                },
                {
                    "id": "assistant-commentary",
                    "phase": "commentary",
                    "text": "Not a final answer",
                    "type": "assistantMessage"
                },
                {
                    "id": "assistant-empty",
                    "phase": "final_answer",
                    "text": "   ",
                    "type": "assistantMessage"
                },
                {
                    "id": "assistant-final",
                    "phase": "final_answer",
                    "text": "Final answer",
                    "type": "assistantMessage"
                }
            ]
        });

        assert!(projected_turn_contains_forkable_assistant_message(
            &turn,
            "assistant-final"
        ));
        assert!(!projected_turn_contains_forkable_assistant_message(
            &turn,
            "assistant-commentary"
        ));
        assert!(!projected_turn_contains_forkable_assistant_message(
            &turn,
            "assistant-empty"
        ));
        assert!(!projected_turn_contains_forkable_assistant_message(
            &turn, "missing"
        ));
    }

    #[test]
    fn projected_transcript_validator_falls_back_to_live_turn_when_rollout_file_is_missing() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let codex_home = std::env::temp_dir().join(format!(
            "remux-codex-fork-validator-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&codex_home).unwrap();
        let live_transcript = LiveTranscriptStore::default();
        live_transcript.record_turn(
            "thread-live",
            &json!({
                "id": "turn-live",
                "itemsView": "full",
                "status": "completed",
                "items": [
                    {
                        "id": "assistant-live",
                        "phase": "final_answer",
                        "text": "Live answer",
                        "type": "agentMessage"
                    }
                ]
            }),
        );
        let projected_assistant_id = live_transcript
            .projected_turn("thread-live", "turn-live")
            .and_then(|projected| {
                projected
                    .turn
                    .get("segments")
                    .and_then(Value::as_array)
                    .and_then(|segments| {
                        segments.iter().find_map(|segment| {
                            (segment.get("type").and_then(Value::as_str)
                                == Some("assistantMessage"))
                            .then(|| segment.get("id").and_then(Value::as_str))
                            .flatten()
                        })
                    })
                    .map(str::to_string)
            })
            .unwrap();
        let validator =
            ProjectedTranscriptForkTargetValidator::new(codex_home.clone(), live_transcript);

        validator
            .validate("thread-live", "turn-live", &projected_assistant_id)
            .unwrap();
        assert_eq!(
            validator
                .validate("thread-live", "turn-live", "missing-assistant")
                .unwrap_err(),
            "assistantMessageId missing-assistant was not found in turn turn-live"
        );

        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn forks_from_historical_assistant_message_by_turn_id_truncation() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
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
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "thread/resume");
        // Later turns are dropped by codex through lastTurnId truncation, so
        // there is no rollback arithmetic on the forked thread.
        assert_eq!(calls[1].0, "thread/fork");
        assert_eq!(calls[1].1["lastTurnId"], "turn-1");
        assert_eq!(calls[2].0, "turn/start");
        assert_eq!(calls[2].1["threadId"], "thread-fork");
        assert_eq!(calls[2].1["clientUserMessageId"], "client-fork");
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
    fn refreshes_thread_resume_before_each_existing_thread_turn() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({ "thread": { "id": "thread-1" } })),
            Ok(json!({ "turn": { "id": "turn-1" } })),
            Ok(json!({ "thread": { "id": "thread-1" } })),
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
        assert_eq!(
            methods,
            vec!["thread/resume", "turn/start", "thread/resume", "turn/start"]
        );
    }

    #[test]
    fn does_not_retry_resume_after_application_error() {
        let app_server = FakeAppServer::new(vec![Err(
            "thread/resume failed: missing field `persistExtendedHistory`".to_string(),
        )]);
        let server = CodexThreadCommandServer::with_requester(app_server.clone());

        let error = server
            .send_message(json!({
                "threadId": "thread-1",
                "parts": [{ "type": "text", "text": "hello" }]
            }))
            .unwrap_err();

        let calls = app_server.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "thread/resume");
        assert_eq!(calls[0].1.get("persistExtendedHistory"), None);
        assert!(error.contains("persistExtendedHistory"));
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
            vec![json!({
                "type": "text",
                "text": "src/lib.rs",
                "text_elements": [
                    { "byteRange": { "start": 0, "end": 10 }, "placeholder": "@src/lib.rs" }
                ]
            })]
        );
    }

    #[test]
    fn mention_renders_between_text_parts_as_single_text_input() {
        let input = composer_parts_to_user_input(vec![
            ComposerMessagePart::Text {
                text: "Please review ".to_string(),
            },
            ComposerMessagePart::Mention {
                name: Some("App.tsx".to_string()),
                path: "viewer/App.tsx".to_string(),
            },
            ComposerMessagePart::Text {
                text: " before sending".to_string(),
            },
        ])
        .unwrap();

        assert_eq!(
            input,
            vec![json!({
                "type": "text",
                "text": "Please review viewer/App.tsx before sending",
                "text_elements": [
                    { "byteRange": { "start": 14, "end": 28 }, "placeholder": "@App.tsx" }
                ]
            })]
        );
    }

    #[test]
    fn mention_path_with_whitespace_is_quoted() {
        let input = composer_parts_to_user_input(vec![ComposerMessagePart::Mention {
            name: Some("notes.md".to_string()),
            path: "my docs/notes.md".to_string(),
        }])
        .unwrap();

        assert_eq!(
            input,
            vec![json!({
                "type": "text",
                "text": "\"my docs/notes.md\"",
                "text_elements": [
                    { "byteRange": { "start": 0, "end": 18 }, "placeholder": "@notes.md" }
                ]
            })]
        );
    }

    #[test]
    fn mention_byte_ranges_use_utf8_offsets() {
        let input = composer_parts_to_user_input(vec![
            ComposerMessagePart::Text {
                text: "héllo ".to_string(),
            },
            ComposerMessagePart::Mention {
                name: Some("lib.rs".to_string()),
                path: "src/lib.rs".to_string(),
            },
        ])
        .unwrap();

        // "héllo " is 7 bytes in UTF-8 (é is 2 bytes).
        assert_eq!(
            input,
            vec![json!({
                "type": "text",
                "text": "héllo src/lib.rs",
                "text_elements": [
                    { "byteRange": { "start": 7, "end": 17 }, "placeholder": "@lib.rs" }
                ]
            })]
        );
    }

    #[test]
    fn image_between_mentions_splits_text_runs() {
        let input = composer_parts_to_user_input(vec![
            ComposerMessagePart::Mention {
                name: Some("a.rs".to_string()),
                path: "src/a.rs".to_string(),
            },
            ComposerMessagePart::Image {
                data_url: "data:image/png;base64,aGVsbG8=".to_string(),
                mime_type: None,
                name: None,
            },
            ComposerMessagePart::Mention {
                name: Some("b.rs".to_string()),
                path: "src/b.rs".to_string(),
            },
        ])
        .unwrap();

        assert_eq!(
            input,
            vec![
                json!({
                    "type": "text",
                    "text": "src/a.rs",
                    "text_elements": [
                        { "byteRange": { "start": 0, "end": 8 }, "placeholder": "@a.rs" }
                    ]
                }),
                json!({ "type": "image", "url": "data:image/png;base64,aGVsbG8=" }),
                json!({
                    "type": "text",
                    "text": "src/b.rs",
                    "text_elements": [
                        { "byteRange": { "start": 0, "end": 8 }, "placeholder": "@b.rs" }
                    ]
                }),
            ]
        );
    }

    #[test]
    fn whitespace_only_parts_without_mentions_are_rejected() {
        let error = composer_parts_to_user_input(vec![ComposerMessagePart::Text {
            text: "   ".to_string(),
        }])
        .unwrap_err();

        assert_eq!(
            error,
            "message parts must include text, an image, or a mention"
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
