use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::util::stable_revision_value;

#[derive(Clone, Debug, Default)]
pub(crate) struct ThreadUsageStore {
    inner: Arc<Mutex<HashMap<String, ThreadUsageState>>>,
}

#[derive(Clone, Debug)]
struct ThreadUsageState {
    token_usage: Value,
    turn_id: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ThreadUsageSnapshot {
    pub(crate) token_usage: Value,
    pub(crate) turn_id: String,
}

impl ThreadUsageStore {
    pub(crate) fn record_notification(&self, notification: &Value) {
        if notification.get("method").and_then(Value::as_str) != Some("thread/tokenUsage/updated") {
            return;
        }
        let Some(params) = notification.get("params") else {
            return;
        };
        let Some(thread_id) = params
            .get("threadId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            return;
        };
        let Some(turn_id) = params
            .get("turnId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            return;
        };
        let Some(token_usage) = params.get("tokenUsage").and_then(normalize_token_usage) else {
            return;
        };

        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.insert(
            thread_id.to_string(),
            ThreadUsageState {
                token_usage,
                turn_id: turn_id.to_string(),
            },
        );
    }

    pub(crate) fn resource_value(&self, thread_id: &str) -> Value {
        let mut value = match self.snapshot(thread_id) {
            Some(state) => json!({
                "threadId": thread_id,
                "tokenUsage": state.token_usage,
                "turnId": state.turn_id,
            }),
            None => json!({
                "threadId": thread_id,
                "tokenUsage": null,
                "turnId": null,
            }),
        };
        let revision = stable_revision_value(&value);
        value["revision"] = Value::String(revision);
        value
    }

    pub(crate) fn snapshot(&self, thread_id: &str) -> Option<ThreadUsageSnapshot> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.get(thread_id).cloned())
            .map(|state| ThreadUsageSnapshot {
                token_usage: state.token_usage,
                turn_id: state.turn_id,
            })
    }
}

fn normalize_token_usage(value: &Value) -> Option<Value> {
    Some(json!({
        "last": normalize_token_usage_breakdown(value.get("last")?)?,
        "modelContextWindow": normalize_optional_number(value.get("modelContextWindow")?)?,
        "total": normalize_token_usage_breakdown(value.get("total")?)?,
    }))
}

fn normalize_token_usage_breakdown(value: &Value) -> Option<Value> {
    Some(json!({
        "cachedInputTokens": normalize_number(value.get("cachedInputTokens")?)?,
        "inputTokens": normalize_number(value.get("inputTokens")?)?,
        "outputTokens": normalize_number(value.get("outputTokens")?)?,
        "reasoningOutputTokens": normalize_number(value.get("reasoningOutputTokens")?)?,
        "totalTokens": normalize_number(value.get("totalTokens")?)?,
    }))
}

fn normalize_optional_number(value: &Value) -> Option<Value> {
    if value.is_null() {
        return Some(Value::Null);
    }
    normalize_number(value).map(Value::from)
}

fn normalize_number(value: &Value) -> Option<i64> {
    let number = value.as_i64()?;
    (number >= 0).then_some(number)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn records_token_usage_notifications() {
        let store = ThreadUsageStore::default();
        store.record_notification(&json!({
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "tokenUsage": token_usage(1000),
            },
        }));

        let value = store.resource_value("thread-1");
        assert_eq!(value["threadId"], json!("thread-1"));
        assert_eq!(value["turnId"], json!("turn-1"));
        assert_eq!(value["tokenUsage"]["last"]["inputTokens"], json!(1000));
        assert!(value["revision"].is_string());
    }

    #[test]
    fn ignores_malformed_token_usage_notifications() {
        let store = ThreadUsageStore::default();
        store.record_notification(&json!({
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "tokenUsage": {
                    "last": { "inputTokens": -1 },
                },
            },
        }));

        let value = store.resource_value("thread-1");
        assert_eq!(value["threadId"], json!("thread-1"));
        assert_eq!(value["turnId"], Value::Null);
        assert_eq!(value["tokenUsage"], Value::Null);
    }

    fn token_usage(input_tokens: i64) -> Value {
        json!({
            "last": {
                "cachedInputTokens": 100,
                "inputTokens": input_tokens,
                "outputTokens": 25,
                "reasoningOutputTokens": 5,
                "totalTokens": input_tokens + 30,
            },
            "modelContextWindow": 2000,
            "total": {
                "cachedInputTokens": 100,
                "inputTokens": input_tokens,
                "outputTokens": 25,
                "reasoningOutputTokens": 5,
                "totalTokens": input_tokens + 30,
            },
        })
    }
}
