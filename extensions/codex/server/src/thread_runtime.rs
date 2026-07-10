use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{Value, json};

use crate::util::{stable_revision_value, value_to_text};

#[derive(Clone, Debug, Default)]
pub(crate) struct ThreadRuntimeStore {
    inner: Arc<Mutex<HashMap<String, ThreadRuntimeState>>>,
}

#[derive(Clone, Debug)]
struct ThreadRuntimeState {
    active_turn_id: Option<String>,
    active_turn_started_at: Option<Instant>,
    last_error: Option<ThreadRuntimeError>,
    status: ThreadRuntimeStatus,
}

#[derive(Clone, Debug)]
struct ThreadRuntimeError {
    codex_error_info: Option<String>,
    message: String,
    turn_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ThreadRuntimeStatus {
    Failed,
    Ready,
    Running,
    Stopping,
}

impl Default for ThreadRuntimeState {
    fn default() -> Self {
        Self {
            active_turn_id: None,
            active_turn_started_at: None,
            last_error: None,
            status: ThreadRuntimeStatus::Ready,
        }
    }
}

impl ThreadRuntimeStore {
    pub(crate) fn record_turn_accepted(&self, thread_id: &str, turn_id: Option<&str>) {
        self.update_thread(thread_id, |state| {
            if let Some(turn_id) = turn_id {
                if state.active_turn_id.as_deref() != Some(turn_id) {
                    state.active_turn_started_at = None;
                }
                state.active_turn_id = Some(turn_id.to_string());
            }
            state.last_error = None;
            state.status = ThreadRuntimeStatus::Running;
        });
    }

    pub(crate) fn record_turn_started(&self, thread_id: &str, turn_id: Option<&str>) {
        let started_at = Instant::now();
        self.update_thread(thread_id, |state| {
            if let Some(turn_id) = turn_id {
                if state.active_turn_id.as_deref() != Some(turn_id) {
                    state.active_turn_started_at = None;
                }
                state.active_turn_id = Some(turn_id.to_string());
            }
            if state.active_turn_started_at.is_none() {
                state.active_turn_started_at = Some(started_at);
            }
            state.last_error = None;
            state.status = ThreadRuntimeStatus::Running;
        });
    }

    pub(crate) fn record_turn_stopping(&self, thread_id: &str, turn_id: Option<&str>) {
        self.update_thread(thread_id, |state| {
            if let Some(turn_id) = turn_id {
                state.active_turn_id = Some(turn_id.to_string());
            }
            state.status = ThreadRuntimeStatus::Stopping;
        });
    }

    pub(crate) fn record_turn_failed(&self, thread_id: &str, turn_id: Option<&str>, error: &str) {
        self.update_thread(thread_id, |state| {
            state.active_turn_id = None;
            state.active_turn_started_at = None;
            state.last_error = Some(ThreadRuntimeError {
                codex_error_info: None,
                message: error.to_string(),
                turn_id: turn_id.map(ToOwned::to_owned),
            });
            state.status = ThreadRuntimeStatus::Failed;
        });
    }

    pub(crate) fn record_notification(&self, notification: &Value) {
        let Some(method) = notification.get("method").and_then(Value::as_str) else {
            return;
        };
        let Some(params) = notification.get("params") else {
            return;
        };
        let Some(thread_id) = thread_id_from_params(params) else {
            return;
        };
        let thread_id = thread_id.to_string();
        let turn_id = turn_id_from_params(params);

        match method {
            "turn/started" => {
                self.record_turn_started(&thread_id, turn_id);
            }
            "item/started" => {
                self.record_item_started(&thread_id, turn_id);
            }
            "turn/completed" => {
                let failed = params
                    .get("turn")
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    == Some("failed");
                if failed {
                    let error = runtime_error_from_params(params, turn_id);
                    self.update_thread(&thread_id, |state| {
                        state.active_turn_id = None;
                        state.active_turn_started_at = None;
                        state.last_error = Some(error);
                        state.status = ThreadRuntimeStatus::Failed;
                    });
                } else {
                    self.update_thread(&thread_id, |state| {
                        state.active_turn_id = None;
                        state.active_turn_started_at = None;
                        state.last_error = None;
                        state.status = ThreadRuntimeStatus::Ready;
                    });
                }
            }
            "error" => {
                let error = runtime_error_from_params(params, turn_id);
                self.update_thread(&thread_id, |state| {
                    state.active_turn_id = None;
                    state.active_turn_started_at = None;
                    state.last_error = Some(error);
                    state.status = ThreadRuntimeStatus::Failed;
                });
            }
            "thread/status/changed" => {
                if let Some(status) = params
                    .get("status")
                    .or_else(|| params.get("thread").and_then(|thread| thread.get("status")))
                    .and_then(normalize_thread_status)
                {
                    self.update_thread(&thread_id, |state| {
                        state.status = status;
                        if state.status != ThreadRuntimeStatus::Running {
                            state.active_turn_id = None;
                            state.active_turn_started_at = None;
                        }
                    });
                }
            }
            _ => {}
        }
    }

    pub(crate) fn active_turn_id(&self, thread_id: &str) -> Option<String> {
        self.inner.lock().ok().and_then(|inner| {
            inner
                .get(thread_id)
                .and_then(|state| state.active_turn_id.clone())
        })
    }

    pub(crate) fn is_busy(&self, thread_id: &str) -> bool {
        self.inner.lock().ok().is_some_and(|inner| {
            inner.get(thread_id).is_some_and(|state| {
                matches!(
                    state.status,
                    ThreadRuntimeStatus::Running | ThreadRuntimeStatus::Stopping
                )
            })
        })
    }

    pub(crate) fn is_stopping(&self, thread_id: &str) -> bool {
        self.inner.lock().ok().is_some_and(|inner| {
            inner
                .get(thread_id)
                .is_some_and(|state| state.status == ThreadRuntimeStatus::Stopping)
        })
    }

    pub(crate) fn resource_value(&self, thread_id: &str) -> Value {
        let state = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.get(thread_id).cloned())
            .unwrap_or_default();
        let active_turn_elapsed_ms = state
            .active_turn_started_at
            .map(|started_at| i64::try_from(started_at.elapsed().as_millis()).unwrap_or(i64::MAX));
        let mut value = json!({
            "activeTurnId": state.active_turn_id,
            "activeTurnElapsedMs": active_turn_elapsed_ms,
            "lastError": state.last_error.map(|error| json!({
                "codexErrorInfo": error.codex_error_info,
                "message": error.message,
                "turnId": error.turn_id,
            })),
            "status": state.status.as_str(),
            "threadId": thread_id,
        });
        let revision = stable_revision_value(&json!({
            "activeTurnId": value["activeTurnId"],
            "activeTurnTimingReady": active_turn_elapsed_ms.is_some(),
            "lastError": value["lastError"],
            "status": value["status"],
            "threadId": thread_id,
        }));
        value["revision"] = Value::String(revision);
        value
    }

    fn update_thread(&self, thread_id: &str, update: impl FnOnce(&mut ThreadRuntimeState)) {
        if thread_id.trim().is_empty() {
            return;
        }
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let state = inner.entry(thread_id.to_string()).or_default();
        update(state);
    }

    fn record_item_started(&self, thread_id: &str, turn_id: Option<&str>) {
        let started_at = Instant::now();
        self.update_thread(thread_id, |state| {
            if state.status == ThreadRuntimeStatus::Stopping {
                return;
            }
            if let Some(turn_id) = turn_id {
                if state.active_turn_id.as_deref() != Some(turn_id) {
                    state.active_turn_started_at = None;
                }
                state.active_turn_id = Some(turn_id.to_string());
            }
            if state.active_turn_started_at.is_none() {
                state.active_turn_started_at = Some(started_at);
            }
            state.last_error = None;
            state.status = ThreadRuntimeStatus::Running;
        });
    }
}

impl ThreadRuntimeStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Failed => "failed",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::Stopping => "stopping",
        }
    }
}

fn thread_id_from_params(params: &Value) -> Option<&str> {
    params
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| params.get("thread_id").and_then(Value::as_str))
        .or_else(|| {
            params
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
        })
}

fn turn_id_from_params(params: &Value) -> Option<&str> {
    params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| params.get("turn_id").and_then(Value::as_str))
        .or_else(|| {
            params
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
        })
}

fn runtime_error_from_params(params: &Value, turn_id: Option<&str>) -> ThreadRuntimeError {
    let source = params
        .get("error")
        .or_else(|| params.get("turn").and_then(|turn| turn.get("error")))
        .unwrap_or(params);
    ThreadRuntimeError {
        codex_error_info: string_field(source, "codexErrorInfo")
            .or_else(|| string_field(source, "code"))
            .or_else(|| string_field(params, "codexErrorInfo")),
        message: string_field(source, "message")
            .or_else(|| {
                source
                    .get("error")
                    .and_then(|error| string_field(error, "message"))
            })
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| value_to_text(source)),
        turn_id: turn_id.map(ToOwned::to_owned),
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn normalize_thread_status(value: &Value) -> Option<ThreadRuntimeStatus> {
    if let Some(status) = value.as_str() {
        return normalize_thread_status_string(status);
    }

    match value.get("type").and_then(Value::as_str) {
        Some("active") => Some(ThreadRuntimeStatus::Running),
        Some("idle" | "notLoaded") => Some(ThreadRuntimeStatus::Ready),
        Some("systemError") => Some(ThreadRuntimeStatus::Failed),
        _ => None,
    }
}

fn normalize_thread_status_string(value: &str) -> Option<ThreadRuntimeStatus> {
    match value {
        "running" | "inProgress" | "in_progress" => Some(ThreadRuntimeStatus::Running),
        "failed" | "error" => Some(ThreadRuntimeStatus::Failed),
        "stopping" | "interrupting" => Some(ThreadRuntimeStatus::Stopping),
        "ready" | "idle" | "completed" => Some(ThreadRuntimeStatus::Ready),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn records_context_window_errors_from_notifications() {
        let store = ThreadRuntimeStore::default();
        store.record_turn_started("thread-1", Some("turn-1"));
        store.record_notification(&json!({
            "method": "error",
            "params": {
                "threadId": "thread-1",
                "error": {
                    "codexErrorInfo": "contextWindowExceeded",
                    "message": "Codex ran out of room"
                }
            }
        }));

        let value = store.resource_value("thread-1");
        assert_eq!(value["status"], json!("failed"));
        assert_eq!(value["activeTurnId"], Value::Null);
        assert_eq!(
            value["lastError"]["codexErrorInfo"],
            json!("contextWindowExceeded")
        );
        assert_eq!(
            value["lastError"]["message"],
            json!("Codex ran out of room")
        );
    }

    #[test]
    fn clears_error_when_next_turn_starts() {
        let store = ThreadRuntimeStore::default();
        store.record_turn_failed("thread-1", Some("turn-1"), "failed");
        store.record_turn_started("thread-1", Some("turn-2"));

        let value = store.resource_value("thread-1");
        assert_eq!(value["status"], json!("running"));
        assert_eq!(value["activeTurnId"], json!("turn-2"));
        assert_eq!(value["lastError"], Value::Null);
    }

    #[test]
    fn exposes_elapsed_time_only_after_the_turn_started_notification() {
        let store = ThreadRuntimeStore::default();
        store.record_turn_accepted("thread-1", Some("turn-1"));

        let accepted = store.resource_value("thread-1");
        assert_eq!(accepted["activeTurnElapsedMs"], Value::Null);

        store.record_notification(&json!({
            "method": "turn/started",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "startedAt": 1_700_000_000
                }
            }
        }));

        let running = store.resource_value("thread-1");
        assert!(running["activeTurnElapsedMs"].as_i64().is_some());
        assert_ne!(running["revision"], accepted["revision"]);

        store.record_notification(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "completed"
                }
            }
        }));

        let completed = store.resource_value("thread-1");
        assert_eq!(completed["activeTurnElapsedMs"], Value::Null);
        assert_eq!(completed["activeTurnId"], Value::Null);
    }

    #[test]
    fn item_started_without_turn_id_preserves_active_turn() {
        let store = ThreadRuntimeStore::default();
        store.record_turn_started("thread-1", Some("turn-1"));
        store.record_notification(&json!({
            "method": "item/started",
            "params": { "threadId": "thread-1" }
        }));

        let value = store.resource_value("thread-1");
        assert_eq!(value["status"], json!("running"));
        assert_eq!(value["activeTurnId"], json!("turn-1"));
    }

    #[test]
    fn item_started_does_not_clear_stopping_status() {
        let store = ThreadRuntimeStore::default();
        store.record_turn_started("thread-1", Some("turn-1"));
        store.record_turn_stopping("thread-1", Some("turn-1"));
        store.record_notification(&json!({
            "method": "item/started",
            "params": { "threadId": "thread-1" }
        }));

        let value = store.resource_value("thread-1");
        assert_eq!(value["status"], json!("stopping"));
        assert_eq!(value["activeTurnId"], json!("turn-1"));
    }

    #[test]
    fn thread_status_changed_reads_top_level_active_status() {
        let store = ThreadRuntimeStore::default();
        store.record_turn_started("thread-1", Some("turn-1"));
        store.record_notification(&json!({
            "method": "thread/status/changed",
            "params": {
                "threadId": "thread-1",
                "status": { "type": "active", "activeFlags": [] }
            }
        }));

        let value = store.resource_value("thread-1");
        assert_eq!(value["status"], json!("running"));
        assert_eq!(value["activeTurnId"], json!("turn-1"));
    }

    #[test]
    fn thread_status_changed_reads_top_level_idle_status() {
        let store = ThreadRuntimeStore::default();
        store.record_turn_started("thread-1", Some("turn-1"));
        store.record_notification(&json!({
            "method": "thread/status/changed",
            "params": {
                "threadId": "thread-1",
                "status": { "type": "idle" }
            }
        }));

        let value = store.resource_value("thread-1");
        assert_eq!(value["status"], json!("ready"));
        assert_eq!(value["activeTurnId"], Value::Null);
    }
}
