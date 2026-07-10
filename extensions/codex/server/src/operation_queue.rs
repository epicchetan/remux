use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::resource_invalidations::{
    command_accepted_invalidations, send_accepted_invalidations,
    thread_operation_queue_invalidation,
};
use crate::thread_commands::{
    CodexThreadCommandServer, ComposerMessagePart, composer_parts_to_user_input,
};
use crate::thread_runtime::ThreadRuntimeStore;

static ENTRY_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Default)]
pub(crate) struct PendingQueueStore {
    inner: Arc<Mutex<HashMap<String, ThreadPendingQueue>>>,
}

#[derive(Clone, Debug)]
pub(crate) struct CodexOperationQueueServer {
    commands: CodexThreadCommandServer,
    driving_threads: Arc<Mutex<HashSet<String>>>,
    runtime: ThreadRuntimeStore,
    store: PendingQueueStore,
}

#[derive(Clone, Debug, Default)]
struct ThreadPendingQueue {
    entries: VecDeque<PendingQueueEntry>,
    revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PendingQueueEntry {
    Message {
        client_message_id: String,
        created_at: u64,
        id: String,
        parts: Vec<ComposerMessagePart>,
        preview: PendingMessagePreview,
    },
    Compact {
        created_at: u64,
        id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingMessagePreview {
    attachment_count: usize,
    mention_count: usize,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadMessageSubmitParams {
    client_message_id: Option<String>,
    parts: Vec<ComposerMessagePart>,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCompactParams {
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueEntryMutationParams {
    operation_id: String,
    thread_id: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct QueueNotificationEffect {
    pub(crate) invalidated: bool,
    pub(crate) suppress_completion_notification: bool,
}

#[derive(Clone, Debug, Default)]
struct DriveEffect {
    changed: bool,
    started: bool,
    turn_id: Option<String>,
}

impl PendingQueueStore {
    pub(crate) fn new(legacy_root: PathBuf) -> Self {
        // The simplified queue is intentionally process-local. Abandon state
        // from the durable operation-queue implementation instead of trying
        // to recover prompts or expose stale running/error entries.
        let _ = fs::remove_dir_all(legacy_root);
        Self::default()
    }

    fn append(&self, thread_id: &str, entry: PendingQueueEntry) -> Result<String, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "pending queue store poisoned".to_string())?;
        let queue = inner.entry(thread_id.to_string()).or_default();
        if queue
            .entries
            .iter()
            .any(|current| current.id() == entry.id())
        {
            return Ok(queue.revision.to_string());
        }
        queue.entries.push_back(entry);
        bump(queue);
        Ok(queue.revision.to_string())
    }

    fn pop_front(&self, thread_id: &str) -> Option<PendingQueueEntry> {
        let mut inner = self.inner.lock().ok()?;
        let queue = inner.get_mut(thread_id)?;
        let entry = queue.entries.pop_front()?;
        bump(queue);
        Some(entry)
    }

    fn entry(&self, thread_id: &str, entry_id: &str) -> Option<PendingQueueEntry> {
        self.inner.lock().ok().and_then(|inner| {
            inner
                .get(thread_id)
                .and_then(|queue| queue.entries.iter().find(|entry| entry.id() == entry_id))
                .cloned()
        })
    }

    fn remove(&self, thread_id: &str, entry_id: &str) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let Some(queue) = inner.get_mut(thread_id) else {
            return false;
        };
        let before = queue.entries.len();
        queue.entries.retain(|entry| entry.id() != entry_id);
        if queue.entries.len() == before {
            return false;
        }
        bump(queue);
        true
    }

    fn clear(&self, thread_id: &str) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let Some(queue) = inner.get_mut(thread_id) else {
            return false;
        };
        if queue.entries.is_empty() {
            return false;
        }
        queue.entries.clear();
        bump(queue);
        true
    }

    fn clear_all(&self) -> Vec<String> {
        let Ok(mut inner) = self.inner.lock() else {
            return Vec::new();
        };
        let mut changed = Vec::new();
        for (thread_id, queue) in inner.iter_mut() {
            if queue.entries.is_empty() {
                continue;
            }
            queue.entries.clear();
            bump(queue);
            changed.push(thread_id.clone());
        }
        changed
    }

    fn contains(&self, thread_id: &str, entry_id: &str) -> bool {
        self.entry(thread_id, entry_id).is_some()
    }

    fn has_entries(&self, thread_id: &str) -> bool {
        self.inner.lock().ok().is_some_and(|inner| {
            inner
                .get(thread_id)
                .is_some_and(|queue| !queue.entries.is_empty())
        })
    }

    fn revision(&self, thread_id: &str) -> String {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.get(thread_id).map(|queue| queue.revision))
            .unwrap_or(0)
            .to_string()
    }

    fn resource_value(&self, thread_id: &str) -> Value {
        let queue = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.get(thread_id).cloned())
            .unwrap_or_default();
        let entries = queue
            .entries
            .iter()
            .map(PendingQueueEntry::resource_value)
            .collect::<Vec<_>>();
        json!({
            "entries": entries,
            "revision": queue.revision.to_string(),
            "threadId": thread_id,
        })
    }
}

impl PendingQueueEntry {
    fn id(&self) -> &str {
        match self {
            Self::Message { id, .. } | Self::Compact { id, .. } => id,
        }
    }

    fn resource_value(&self) -> Value {
        match self {
            Self::Message {
                created_at,
                id,
                preview,
                ..
            } => json!({
                "createdAt": created_at,
                "id": id,
                "kind": "message",
                "preview": {
                    "attachmentCount": preview.attachment_count,
                    "mentionCount": preview.mention_count,
                    "text": preview.text,
                },
            }),
            Self::Compact { created_at, id } => json!({
                "createdAt": created_at,
                "id": id,
                "kind": "compact",
            }),
        }
    }
}

impl CodexOperationQueueServer {
    pub(crate) fn new(
        store: PendingQueueStore,
        commands: CodexThreadCommandServer,
        runtime: ThreadRuntimeStore,
    ) -> Self {
        Self {
            commands,
            driving_threads: Arc::new(Mutex::new(HashSet::new())),
            runtime,
            store,
        }
    }

    pub(crate) fn resource_value(&self, thread_id: &str) -> Value {
        self.store.resource_value(thread_id)
    }

    pub(crate) fn submit_message(&self, params: Value) -> Result<Value, String> {
        let params: ThreadMessageSubmitParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid thread message/send params: {error}"))?;
        let thread_id = required(&params.thread_id, "threadId")?;
        if self.runtime.is_stopping(&thread_id) {
            return Err(
                "the active turn is stopping; wait before sending another message".to_string(),
            );
        }
        composer_parts_to_user_input(params.parts.clone())?;
        let client_message_id = params
            .client_message_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(next_message_id);

        if !self.runtime.is_busy(&thread_id) && !self.store.has_entries(&thread_id) {
            let turn_id = self.commands.dispatch_queued_message(
                &thread_id,
                Some(client_message_id),
                params.parts,
            )?;
            return Ok(json!({
                "delivery": "sent",
                "invalidations": send_accepted_invalidations(&thread_id),
                "status": "accepted",
                "threadId": thread_id,
                "turnId": turn_id,
            }));
        }

        let entry_id = next_entry_id("message");
        self.store.append(
            &thread_id,
            PendingQueueEntry::Message {
                client_message_id,
                created_at: now_ms(),
                id: entry_id.clone(),
                preview: message_preview(&params.parts),
                parts: params.parts,
            },
        )?;
        let drive = self.drive_if_idle(&thread_id);
        let requested_sent = drive.started && !self.store.contains(&thread_id, &entry_id);
        Ok(json!({
            "delivery": if requested_sent { "sent" } else { "queued" },
            "invalidations": [thread_operation_queue_invalidation(&thread_id, "commandAccepted")],
            "status": "accepted",
            "threadId": thread_id,
            "turnId": if requested_sent { drive.turn_id } else { None },
        }))
    }

    pub(crate) fn submit_compact(&self, params: Value) -> Result<Value, String> {
        let params: ThreadCompactParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid thread compact params: {error}"))?;
        let thread_id = required(&params.thread_id, "threadId")?;
        if self.runtime.is_stopping(&thread_id) {
            return Err("the active turn is stopping; wait before compacting".to_string());
        }

        if !self.runtime.is_busy(&thread_id) && !self.store.has_entries(&thread_id) {
            self.commands.dispatch_queued_compaction(&thread_id)?;
            return Ok(json!({
                "delivery": "sent",
                "invalidations": command_accepted_invalidations(&thread_id),
                "status": "accepted",
                "threadId": thread_id,
            }));
        }

        let entry_id = next_entry_id("compact");
        self.store.append(
            &thread_id,
            PendingQueueEntry::Compact {
                created_at: now_ms(),
                id: entry_id.clone(),
            },
        )?;
        let drive = self.drive_if_idle(&thread_id);
        let requested_sent = drive.started && !self.store.contains(&thread_id, &entry_id);
        Ok(json!({
            "delivery": if requested_sent { "sent" } else { "queued" },
            "invalidations": [thread_operation_queue_invalidation(&thread_id, "commandAccepted")],
            "status": "accepted",
            "threadId": thread_id,
        }))
    }

    pub(crate) fn remove(&self, params: Value) -> Result<Value, String> {
        let params: QueueEntryMutationParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid queue/remove params: {error}"))?;
        let thread_id = required(&params.thread_id, "threadId")?;
        validate_id(&params.operation_id)?;
        self.store.remove(&thread_id, &params.operation_id);
        Ok(self.mutation_response(&thread_id, "accepted"))
    }

    pub(crate) fn run_now(&self, params: Value) -> Result<Value, String> {
        let params: QueueEntryMutationParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid queue/run-now params: {error}"))?;
        let thread_id = required(&params.thread_id, "threadId")?;
        validate_id(&params.operation_id)?;
        let Some(PendingQueueEntry::Message {
            client_message_id,
            parts,
            ..
        }) = self.store.entry(&thread_id, &params.operation_id)
        else {
            return Ok(self.mutation_response(&thread_id, "retained"));
        };
        let Some(turn_id) = self.runtime.active_turn_id(&thread_id) else {
            self.drive_if_idle(&thread_id);
            let status = if self.store.contains(&thread_id, &params.operation_id) {
                "retained"
            } else {
                "accepted"
            };
            return Ok(self.mutation_response(&thread_id, status));
        };
        if self.runtime.is_stopping(&thread_id) {
            return Ok(self.mutation_response(&thread_id, "retained"));
        }
        match self.commands.steer_queued_message(
            &thread_id,
            &turn_id,
            Some(client_message_id),
            parts,
        ) {
            Ok(_) => {
                self.store.remove(&thread_id, &params.operation_id);
                Ok(self.mutation_response(&thread_id, "accepted"))
            }
            Err(_) => Ok(self.mutation_response(&thread_id, "retained")),
        }
    }

    pub(crate) fn interrupt(&self, params: Value) -> Result<Value, String> {
        let thread_id = params
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| "threadId is required".to_string())?
            .to_string();
        let changed = self.store.clear(&thread_id);
        let mut response = self.commands.interrupt_turn(params)?;
        if changed {
            response["invalidations"]
                .as_array_mut()
                .ok_or_else(|| "interrupt response invalidations missing".to_string())?
                .push(thread_operation_queue_invalidation(
                    &thread_id,
                    "commandAccepted",
                ));
        }
        Ok(response)
    }

    pub(crate) fn ensure_direct_mutation_allowed(&self, params: &Value) -> Result<(), String> {
        let thread_id = params
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| "threadId is required".to_string())?;
        if self.store.has_entries(thread_id) {
            return Err(
                "edit and fork are unavailable while this thread has pending queue entries"
                    .to_string(),
            );
        }
        Ok(())
    }

    pub(crate) fn record_notification(&self, notification: &Value) -> QueueNotificationEffect {
        let Some(method) = notification.get("method").and_then(Value::as_str) else {
            return QueueNotificationEffect::default();
        };
        let Some(params) = notification.get("params") else {
            return QueueNotificationEffect::default();
        };
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return QueueNotificationEffect::default();
        };

        match method {
            "turn/completed" => {
                let status = params
                    .get("turn")
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                if status == "completed" {
                    let drive = self.drive_if_idle(thread_id);
                    return QueueNotificationEffect {
                        invalidated: drive.changed,
                        suppress_completion_notification: drive.started,
                    };
                }
                QueueNotificationEffect {
                    invalidated: self.store.clear(thread_id),
                    suppress_completion_notification: false,
                }
            }
            "error" => QueueNotificationEffect {
                invalidated: self.store.clear(thread_id),
                suppress_completion_notification: false,
            },
            "thread/status/changed"
                if params
                    .get("status")
                    .and_then(|status| status.get("type"))
                    .and_then(Value::as_str)
                    == Some("systemError") =>
            {
                QueueNotificationEffect {
                    invalidated: self.store.clear(thread_id),
                    suppress_completion_notification: false,
                }
            }
            _ => QueueNotificationEffect::default(),
        }
    }

    pub(crate) fn clear_all(&self) -> Vec<String> {
        self.store.clear_all()
    }

    fn drive_if_idle(&self, thread_id: &str) -> DriveEffect {
        if self.runtime.is_busy(thread_id) {
            return DriveEffect::default();
        }
        let Ok(mut driving_threads) = self.driving_threads.lock() else {
            return DriveEffect::default();
        };
        if !driving_threads.insert(thread_id.to_string()) {
            return DriveEffect::default();
        }
        drop(driving_threads);
        let effect = self.drive_claimed_thread(thread_id);
        if let Ok(mut driving_threads) = self.driving_threads.lock() {
            driving_threads.remove(thread_id);
        }
        if !effect.started && self.store.has_entries(thread_id) && !self.runtime.is_busy(thread_id)
        {
            return self.drive_if_idle(thread_id);
        }
        effect
    }

    fn drive_claimed_thread(&self, thread_id: &str) -> DriveEffect {
        if self.runtime.is_busy(thread_id) {
            return DriveEffect::default();
        }
        let Some(entry) = self.store.pop_front(thread_id) else {
            return DriveEffect::default();
        };
        let result = match entry {
            PendingQueueEntry::Message {
                client_message_id,
                parts,
                ..
            } => self
                .commands
                .dispatch_queued_message(thread_id, Some(client_message_id), parts)
                .map(Some),
            PendingQueueEntry::Compact { .. } => self
                .commands
                .dispatch_queued_compaction(thread_id)
                .map(|_| None),
        };
        if result.is_err() {
            self.store.clear(thread_id);
        }
        DriveEffect {
            changed: true,
            started: result.is_ok(),
            turn_id: result.ok().flatten(),
        }
    }

    fn mutation_response(&self, thread_id: &str, status: &str) -> Value {
        json!({
            "invalidations": [thread_operation_queue_invalidation(thread_id, "commandAccepted")],
            "queueRevision": self.store.revision(thread_id),
            "status": status,
            "threadId": thread_id,
        })
    }
}

fn bump(queue: &mut ThreadPendingQueue) {
    queue.revision = queue.revision.saturating_add(1);
}

fn required(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{field} is required"));
    }
    Ok(value.to_string())
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 {
        return Err("operationId is invalid".to_string());
    }
    Ok(())
}

fn message_preview(parts: &[ComposerMessagePart]) -> PendingMessagePreview {
    let mut text = String::new();
    let mut attachment_count = 0;
    let mut mention_count = 0;
    for part in parts {
        match part {
            ComposerMessagePart::Text { text: value } => text.push_str(value),
            ComposerMessagePart::Image { .. } => attachment_count += 1,
            ComposerMessagePart::Mention { name, path } => {
                mention_count += 1;
                if !text.is_empty() && !text.ends_with(char::is_whitespace) {
                    text.push(' ');
                }
                text.push('@');
                text.push_str(name.as_deref().unwrap_or(path));
            }
        }
    }
    PendingMessagePreview {
        attachment_count,
        mention_count,
        text: text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(180)
            .collect(),
    }
}

fn next_message_id() -> String {
    next_entry_id("message-client")
}

fn next_entry_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        now_ms(),
        ENTRY_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::composer_config::ComposerConfigStore;
    use crate::live_transcript::LiveTranscriptStore;
    use crate::thread_commands::AppServerRequester;

    #[derive(Debug, Default)]
    struct FakeAppServer {
        calls: Mutex<Vec<String>>,
        fail_steer: Mutex<bool>,
        turn_counter: AtomicU64,
    }

    impl AppServerRequester for FakeAppServer {
        fn request(&self, method: &str, _params: Value) -> Result<Value, String> {
            self.calls.lock().unwrap().push(method.to_string());
            match method {
                "thread/resume" => Ok(json!({ "thread": { "id": "thread-1" } })),
                "turn/start" => {
                    let id = self.turn_counter.fetch_add(1, Ordering::Relaxed) + 1;
                    Ok(json!({
                        "turn": {
                            "error": null,
                            "id": format!("turn-{id}"),
                            "items": [],
                            "status": "inProgress",
                        }
                    }))
                }
                "thread/compact/start" => Ok(json!({})),
                "turn/steer" if *self.fail_steer.lock().unwrap() => {
                    Err("expected active turn mismatch".to_string())
                }
                "turn/steer" => Ok(json!({ "turnId": "turn-active" })),
                "turn/interrupt" => Ok(json!({})),
                _ => Err(format!("unexpected method {method}")),
            }
        }
    }

    fn test_server() -> (CodexOperationQueueServer, Arc<FakeAppServer>) {
        let app_server = Arc::new(FakeAppServer::default());
        let runtime = ThreadRuntimeStore::default();
        let commands = CodexThreadCommandServer::with_requester_and_live_transcript(
            app_server.clone(),
            ComposerConfigStore::default(),
            LiveTranscriptStore::default(),
            runtime.clone(),
        );
        (
            CodexOperationQueueServer::new(PendingQueueStore::default(), commands, runtime),
            app_server,
        )
    }

    fn message_params(text: &str) -> Value {
        json!({
            "clientMessageId": next_message_id(),
            "parts": [{ "text": text, "type": "text" }],
            "threadId": "thread-1",
        })
    }

    fn started_notification(turn_id: &str) -> Value {
        json!({
            "method": "turn/started",
            "params": { "threadId": "thread-1", "turn": { "id": turn_id } }
        })
    }

    fn completed_notification(turn_id: &str, status: &str) -> Value {
        json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": { "id": turn_id, "status": status }
            }
        })
    }

    #[test]
    fn idle_message_sends_directly_without_entering_queue() {
        let (server, _) = test_server();
        let response = server.submit_message(message_params("direct")).unwrap();
        assert_eq!(response["delivery"], "sent");
        assert!(
            server.resource_value("thread-1")["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn idle_compaction_starts_directly_without_entering_queue() {
        let (server, app_server) = test_server();
        let response = server
            .submit_compact(json!({ "threadId": "thread-1" }))
            .unwrap();
        assert_eq!(response["delivery"], "sent");
        assert!(
            server.resource_value("thread-1")["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            app_server.calls.lock().unwrap().as_slice(),
            ["thread/resume", "thread/compact/start"]
        );
    }

    #[test]
    fn active_message_stays_pending_until_completion_then_leaves_before_start() {
        let (server, app_server) = test_server();
        let started = started_notification("turn-active");
        server.runtime.record_notification(&started);
        let response = server.submit_message(message_params("next")).unwrap();
        assert_eq!(response["delivery"], "queued");
        assert_eq!(
            server.resource_value("thread-1")["entries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let completed = completed_notification("turn-active", "completed");
        server.runtime.record_notification(&completed);
        let effect = server.record_notification(&completed);
        assert!(effect.suppress_completion_notification);
        assert!(
            server.resource_value("thread-1")["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            app_server.calls.lock().unwrap().as_slice(),
            ["thread/resume", "turn/start"]
        );
    }

    #[test]
    fn message_compact_message_runs_fifo_without_exposing_accepted_work() {
        let (server, _) = test_server();
        let started = started_notification("turn-active");
        server.runtime.record_notification(&started);
        server.submit_message(message_params("one")).unwrap();
        server
            .submit_compact(json!({ "threadId": "thread-1" }))
            .unwrap();
        server.submit_message(message_params("two")).unwrap();

        let completed = completed_notification("turn-active", "completed");
        server.runtime.record_notification(&completed);
        server.record_notification(&completed);
        let resource = server.resource_value("thread-1");
        assert_eq!(resource["entries"].as_array().unwrap().len(), 2);
        assert_eq!(resource["entries"][0]["kind"], "compact");

        let first_completed = completed_notification("turn-1", "completed");
        server.runtime.record_notification(&first_completed);
        server.record_notification(&first_completed);
        let resource = server.resource_value("thread-1");
        assert_eq!(resource["entries"].as_array().unwrap().len(), 1);
        assert_eq!(resource["entries"][0]["kind"], "message");

        let compact_completed = completed_notification("compact-turn", "completed");
        server.runtime.record_notification(&compact_completed);
        server.record_notification(&compact_completed);
        assert!(
            server.resource_value("thread-1")["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn interrupted_turn_clears_pending_entries_without_error_state() {
        let (server, _) = test_server();
        let started = started_notification("turn-active");
        server.runtime.record_notification(&started);
        server.submit_message(message_params("discard me")).unwrap();
        server
            .submit_compact(json!({ "threadId": "thread-1" }))
            .unwrap();

        let completed = completed_notification("turn-active", "interrupted");
        server.runtime.record_notification(&completed);
        let effect = server.record_notification(&completed);
        assert!(effect.invalidated);
        assert!(
            server.resource_value("thread-1")["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn interrupt_command_clears_pending_entries_immediately() {
        let (server, _) = test_server();
        let started = started_notification("turn-active");
        server.runtime.record_notification(&started);
        server.submit_message(message_params("discard me")).unwrap();

        let response = server
            .interrupt(json!({
                "threadId": "thread-1",
                "turnId": "turn-active",
            }))
            .unwrap();
        assert!(
            response["invalidations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| {
                    value.get("type").and_then(Value::as_str) == Some("threadOperationQueue")
                })
        );
        assert!(
            server.resource_value("thread-1")["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn send_now_removes_only_after_successful_steer() {
        let (server, app_server) = test_server();
        let started = started_notification("turn-active");
        server.runtime.record_notification(&started);
        server.submit_message(message_params("steer me")).unwrap();
        let entry_id = server.resource_value("thread-1")["entries"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();

        *app_server.fail_steer.lock().unwrap() = true;
        let retained = server
            .run_now(json!({
                "operationId": entry_id,
                "threadId": "thread-1",
            }))
            .unwrap();
        assert_eq!(retained["status"], "retained");
        assert_eq!(
            server.resource_value("thread-1")["entries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        *app_server.fail_steer.lock().unwrap() = false;
        let accepted = server
            .run_now(json!({
                "operationId": entry_id,
                "threadId": "thread-1",
            }))
            .unwrap();
        assert_eq!(accepted["status"], "accepted");
        assert!(
            server.resource_value("thread-1")["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn startup_deletes_legacy_durable_queue_state() {
        let root = std::env::temp_dir().join(format!(
            "remux-pending-queue-cleanup-{}-{}",
            std::process::id(),
            ENTRY_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("messages")).unwrap();
        fs::write(root.join("index.json"), b"stale").unwrap();
        fs::write(root.join("messages").join("message.json"), b"stale").unwrap();

        let store = PendingQueueStore::new(root.clone());
        assert!(!root.exists());
        assert!(
            store.resource_value("thread-1")["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
