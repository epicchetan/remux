use std::collections::HashMap;

use serde_json::{Value, json};

use crate::util::stable_revision_value;

use super::{RawTurn, compaction_status, item_id, merge_compaction_status, normalize_user_content};

pub(super) fn user_segment(item: &Value) -> Value {
    let content = normalize_user_content(item.get("content"));
    let id = item_id(item).unwrap_or("user");
    json!({
        "content": content,
        "id": id,
        "revision": stable_revision_value(&json!(["user", id, content])),
        "type": "userMessage",
    })
}

pub(super) fn assistant_segment(item: &Value) -> Value {
    let id = item_id(item).unwrap_or("agent");
    json!({
        "id": id,
        "phase": item.get("phase").cloned().unwrap_or(Value::Null),
        "revision": stable_revision_value(&json!(["assistant", id, item.get("phase"), item.get("text")])),
        "text": item.get("text").and_then(Value::as_str).unwrap_or(""),
        "type": "assistantMessage",
    })
}

pub(super) fn compaction_segment(
    item: &Value,
    turn: &RawTurn,
    statuses: &HashMap<String, String>,
) -> Value {
    let id = item_id(item).unwrap_or("compaction");
    let status = statuses
        .get(id)
        .cloned()
        .unwrap_or_else(|| compaction_status(&turn.status));
    json!({
        "id": id,
        "revision": stable_revision_value(&json!(["compaction", id, status])),
        "status": status,
        "type": "compaction",
    })
}

pub(super) fn push_compaction_segment(segments: &mut Vec<Value>, segment: Value) {
    if let Some(last) = segments.last_mut() {
        if last.get("type").and_then(Value::as_str) == Some("compaction") {
            let merged = merge_compaction_status(
                last.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("compacted"),
                segment
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("compacted"),
            );
            last["status"] = Value::String(merged.to_string());
            last["revision"] = Value::String(stable_revision_value(last));
            return;
        }
    }
    segments.push(segment);
}
