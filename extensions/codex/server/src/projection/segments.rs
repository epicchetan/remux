use std::collections::HashMap;

use serde_json::{Value, json};

use crate::util::stable_revision_value;

use super::{RawTurn, compaction_status, item_id, merge_compaction_status, normalize_user_content};

pub(super) fn user_segment(item: &Value, is_steering: bool) -> Value {
    let content = normalize_user_content(item.get("content"));
    let id = item_id(item).unwrap_or("user");
    // The composer-assigned id travels separately from the authoritative item
    // id; viewers use it to reconcile locally tracked sends against the
    // server-authoritative row. It participates in the revision so rows
    // published before the live item merged its clientId are re-hydrated.
    let client_id = item.get("clientId").and_then(Value::as_str);
    json!({
        "clientId": client_id,
        "content": content,
        "id": id,
        "isSteering": is_steering,
        "revision": stable_revision_value(&json!(["user", id, client_id, is_steering, content])),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn user_segment_carries_client_id_and_revises_when_it_appears() {
        let without = user_segment(
            &json!({
                "content": [{ "text": "hello", "type": "text" }],
                "id": "item-1",
                "type": "userMessage",
            }),
            false,
        );
        let with = user_segment(
            &json!({
                "clientId": "client-message-1",
                "content": [{ "text": "hello", "type": "text" }],
                "id": "item-1",
                "type": "userMessage",
            }),
            false,
        );

        assert_eq!(without["clientId"], Value::Null);
        assert_eq!(with["clientId"], "client-message-1");
        assert_eq!(with["id"], "item-1");
        assert_ne!(without["revision"], with["revision"]);
    }
}
