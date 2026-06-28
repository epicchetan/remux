use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::app_server::AppServerRuntime;
use crate::composer_config::{ComposerConfigStore, observed_config_value};
use crate::thread_composer_state::read_rollout_composer_state;
use crate::thread_runtime::ThreadRuntimeStore;
use crate::thread_usage::ThreadUsageStore;
use crate::util::stable_revision_value;

#[derive(Debug)]
pub(crate) struct CodexThreadResourcesServer {
    app_server: AppServerRuntime,
    composer_config: ComposerConfigStore,
    thread_runtime: ThreadRuntimeStore,
    thread_usage: ThreadUsageStore,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadResourcesReadParams {
    requests: Vec<ThreadResourceRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ThreadResourceRequest {
    #[serde(rename = "threadComposerState", rename_all = "camelCase")]
    ThreadComposerState {
        known_revision: Option<String>,
        thread_id: String,
    },
    #[serde(rename = "threadHistory", rename_all = "camelCase")]
    ThreadHistory {
        archived: Option<bool>,
        cursor: Option<String>,
        known_revision: Option<String>,
        limit: Option<u32>,
        search_term: Option<String>,
        sort_direction: Option<String>,
        sort_key: Option<String>,
    },
    #[serde(rename = "threadSummary", rename_all = "camelCase")]
    ThreadSummary {
        known_revision: Option<String>,
        thread_id: String,
    },
    #[serde(rename = "threadRuntime", rename_all = "camelCase")]
    ThreadRuntime {
        known_revision: Option<String>,
        thread_id: String,
    },
    #[serde(rename = "threadTokenUsage", rename_all = "camelCase")]
    ThreadTokenUsage {
        known_revision: Option<String>,
        thread_id: String,
    },
}

impl CodexThreadResourcesServer {
    pub(crate) fn new(
        app_server: AppServerRuntime,
        composer_config: ComposerConfigStore,
        thread_runtime: ThreadRuntimeStore,
        thread_usage: ThreadUsageStore,
    ) -> Self {
        Self {
            app_server,
            composer_config,
            thread_runtime,
            thread_usage,
        }
    }

    pub(crate) fn read_resources(&self, params: Value) -> Result<Value, String> {
        let params: ThreadResourcesReadParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid thread resources/read params: {error}"))?;
        let mut results = Vec::new();

        for (request_index, request) in params.requests.into_iter().enumerate() {
            let result = match request {
                ThreadResourceRequest::ThreadComposerState {
                    known_revision,
                    thread_id,
                } => self.read_thread_composer_state_resource(
                    request_index,
                    thread_id,
                    known_revision,
                ),
                ThreadResourceRequest::ThreadHistory {
                    archived,
                    cursor,
                    known_revision,
                    limit,
                    search_term,
                    sort_direction,
                    sort_key,
                } => self.read_thread_history_resource(
                    request_index,
                    ThreadHistoryRequest {
                        archived,
                        cursor,
                        known_revision,
                        limit,
                        search_term,
                        sort_direction,
                        sort_key,
                    },
                ),
                ThreadResourceRequest::ThreadSummary {
                    known_revision,
                    thread_id,
                } => self.read_thread_summary_resource(request_index, thread_id, known_revision),
                ThreadResourceRequest::ThreadRuntime {
                    known_revision,
                    thread_id,
                } => self.read_thread_runtime_resource(request_index, thread_id, known_revision),
                ThreadResourceRequest::ThreadTokenUsage {
                    known_revision,
                    thread_id,
                } => {
                    self.read_thread_token_usage_resource(request_index, thread_id, known_revision)
                }
            };
            results.push(result);
        }

        Ok(json!({ "resources": results }))
    }

    fn read_thread_history_resource(
        &self,
        request_index: usize,
        request: ThreadHistoryRequest,
    ) -> Value {
        let sort_key = normalize_sort_key(request.sort_key.as_deref());
        let sort_direction = normalize_sort_direction(request.sort_direction.as_deref());
        let limit = request.limit.unwrap_or(50).clamp(1, 200);
        let archived = request.archived.unwrap_or(false);
        let cursor = request.cursor.filter(|value| !value.trim().is_empty());
        let search_term = request.search_term.filter(|value| !value.trim().is_empty());
        let key = format!(
            "threadHistory:{sort_key}:{sort_direction}:{limit}:{}:{archived}:{}",
            cursor.as_deref().unwrap_or(""),
            search_term.as_deref().unwrap_or("")
        );

        let app_response = match self.app_server.request(
            "thread/list",
            json!({
                "archived": archived,
                "cursor": cursor,
                "limit": limit,
                "sortDirection": sort_direction,
                "sortKey": sort_key,
                "searchTerm": search_term,
                "useStateDbOnly": false,
            }),
        ) {
            Ok(value) => value,
            Err(error) => return error_result(request_index, key, error),
        };

        let threads = app_response
            .get("data")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(normalize_thread_summary)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut value = json!({
            "threads": threads,
            "nextCursor": app_response.get("nextCursor").cloned().unwrap_or(Value::Null),
            "backwardsCursor": app_response.get("backwardsCursor").cloned().unwrap_or(Value::Null),
        });
        let revision = stable_revision_value(&value);
        value["revision"] = Value::String(revision.clone());

        if request.known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        ok_result(request_index, key, revision, value)
    }

    fn read_thread_summary_resource(
        &self,
        request_index: usize,
        thread_id: String,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("threadSummary:{thread_id}");
        if thread_id.trim().is_empty() {
            return missing_result(request_index, key, "thread_id_required".to_string());
        }

        let app_response = match self.app_server.request(
            "thread/read",
            json!({
                "threadId": thread_id,
                "includeTurns": false,
            }),
        ) {
            Ok(value) => value,
            Err(error) => return missing_result(request_index, key, error),
        };
        let Some(thread) = app_response.get("thread") else {
            return missing_result(request_index, key, "thread_missing".to_string());
        };
        let summary = normalize_thread_summary(thread);
        let mut value = json!({ "thread": summary });
        let revision = stable_revision_value(&value);
        value["revision"] = Value::String(revision.clone());

        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        ok_result(request_index, key, revision, value)
    }

    fn read_thread_runtime_resource(
        &self,
        request_index: usize,
        thread_id: String,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("threadRuntime:{thread_id}");
        if thread_id.trim().is_empty() {
            return missing_result(request_index, key, "thread_id_required".to_string());
        }

        let value = self.thread_runtime.resource_value(&thread_id);
        let revision = value
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        ok_result(request_index, key, revision, value)
    }

    fn read_thread_token_usage_resource(
        &self,
        request_index: usize,
        thread_id: String,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("threadTokenUsage:{thread_id}");
        if thread_id.trim().is_empty() {
            return missing_result(request_index, key, "thread_id_required".to_string());
        }

        let value = self.thread_usage.resource_value(&thread_id);
        let revision = value
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        ok_result(request_index, key, revision, value)
    }

    fn read_thread_composer_state_resource(
        &self,
        request_index: usize,
        thread_id: String,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("threadComposerState:{thread_id}");
        if thread_id.trim().is_empty() {
            return missing_result(request_index, key, "thread_id_required".to_string());
        }

        let thread = self
            .app_server
            .request(
                "thread/read",
                json!({
                    "threadId": thread_id.clone(),
                    "includeTurns": false,
                }),
            )
            .ok()
            .and_then(|response| response.get("thread").cloned());
        let rollout = thread
            .as_ref()
            .and_then(|thread| string_field(thread, "path"))
            .and_then(|path| read_rollout_composer_state(&PathBuf::from(path)).ok())
            .unwrap_or_default();

        let observed_config = rollout.observed_config;
        let _ = self
            .composer_config
            .seed_thread_config_from_observed(&thread_id, observed_config);

        let preference = match self.composer_config.read_thread_config(&thread_id) {
            Ok(value) => value.get("config").cloned().unwrap_or(Value::Null),
            Err(error) => return error_result(request_index, key, error),
        };
        let live_token_usage = self.thread_usage.snapshot(&thread_id);
        let (token_usage, token_usage_turn_id, token_usage_source) =
            if let Some(snapshot) = live_token_usage {
                (
                    snapshot.token_usage,
                    Value::String(snapshot.turn_id),
                    Value::String("live".to_string()),
                )
            } else if let Some(token_usage) = rollout.token_usage.clone() {
                (
                    token_usage,
                    rollout
                        .token_usage_turn_id
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                    Value::String("rollout".to_string()),
                )
            } else {
                (Value::Null, Value::Null, Value::String("none".to_string()))
            };
        let model = rollout
            .model
            .clone()
            .map(Value::String)
            .or_else(|| {
                thread
                    .as_ref()
                    .and_then(|thread| string_field(thread, "model"))
                    .map(Value::String)
            })
            .unwrap_or(Value::Null);
        let model_provider = rollout
            .model_provider
            .clone()
            .map(Value::String)
            .or_else(|| {
                thread
                    .as_ref()
                    .and_then(|thread| string_field(thread, "modelProvider"))
                    .map(Value::String)
            })
            .unwrap_or(Value::Null);
        let cwd = rollout
            .cwd
            .clone()
            .map(Value::String)
            .or_else(|| {
                thread
                    .as_ref()
                    .and_then(|thread| string_field(thread, "cwd"))
                    .map(Value::String)
            })
            .unwrap_or(Value::Null);
        let mut value = json!({
            "effective": {
                "cwd": cwd,
                "model": model,
                "modelContextWindow": rollout.model_context_window,
                "modelProvider": model_provider,
            },
            "lastAppliedTurnId": rollout.last_applied_turn_id,
            "observedConfig": observed_config_value(observed_config),
            "preference": preference,
            "rolloutRevision": rollout.file_revision,
            "threadId": thread_id,
            "tokenUsage": token_usage,
            "tokenUsageSource": token_usage_source,
            "tokenUsageTurnId": token_usage_turn_id,
        });
        let revision = stable_revision_value(&value);
        value["revision"] = Value::String(revision.clone());

        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        ok_result(request_index, key, revision, value)
    }
}

struct ThreadHistoryRequest {
    archived: Option<bool>,
    cursor: Option<String>,
    known_revision: Option<String>,
    limit: Option<u32>,
    search_term: Option<String>,
    sort_direction: Option<String>,
    sort_key: Option<String>,
}

fn normalize_thread_summary(thread: &Value) -> Value {
    let preview = string_field(thread, "preview").unwrap_or_default();
    let name = string_field(thread, "name");
    let title = name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            preview
                .lines()
                .next()
                .map(|value| value.chars().take(48).collect())
        })
        .filter(|value: &String| !value.is_empty())
        .unwrap_or_else(|| "Untitled thread".to_string());

    json!({
        "archived": bool_field(thread, "archived").unwrap_or(false),
        "createdAt": number_field(thread, "createdAt").unwrap_or(0),
        "cwd": nullable_string_field(thread, "cwd"),
        "id": string_field(thread, "id").unwrap_or_default(),
        "modelProvider": nullable_string_field(thread, "modelProvider"),
        "name": nullable_string_field(thread, "name"),
        "path": nullable_string_field(thread, "path"),
        "preview": preview,
        "sessionId": nullable_string_field(thread, "sessionId"),
        "source": thread.get("source").cloned().unwrap_or(Value::Null),
        "status": thread.get("status").cloned().unwrap_or(Value::Null),
        "title": title,
        "updatedAt": number_field(thread, "updatedAt").unwrap_or(0),
    })
}

fn normalize_sort_key(value: Option<&str>) -> &'static str {
    match value {
        Some("created_at") | Some("createdAt") => "created_at",
        Some("recency_at") | Some("recencyAt") => "recency_at",
        Some("updated_at") | Some("updatedAt") => "updated_at",
        _ => "updated_at",
    }
}

fn normalize_sort_direction(value: Option<&str>) -> &'static str {
    match value {
        Some("asc") => "asc",
        _ => "desc",
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn nullable_string_field(value: &Value, key: &str) -> Value {
    string_field(value, key)
        .map(Value::String)
        .unwrap_or(Value::Null)
}

fn bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn number_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn ok_result(request_index: usize, key: String, revision: String, value: Value) -> Value {
    json!({
        "requestIndex": request_index,
        "key": key,
        "status": "ok",
        "revision": revision,
        "value": value,
    })
}

fn not_modified_result(request_index: usize, key: String, revision: String) -> Value {
    json!({
        "requestIndex": request_index,
        "key": key,
        "status": "notModified",
        "revision": revision,
    })
}

fn missing_result(request_index: usize, key: String, reason: String) -> Value {
    json!({
        "requestIndex": request_index,
        "key": key,
        "status": "missing",
        "reason": reason,
    })
}

fn error_result(request_index: usize, key: String, reason: String) -> Value {
    json!({
        "requestIndex": request_index,
        "key": key,
        "status": "error",
        "reason": reason,
    })
}
