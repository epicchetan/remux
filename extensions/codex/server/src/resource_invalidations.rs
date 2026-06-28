use std::collections::HashSet;

use serde_json::{Value, json};

pub(crate) const RESOURCES_INVALIDATED_METHOD: &str = "remux/codex/resources/invalidated";

const DEFAULT_THREAD_HISTORY_KEY: &str = "threadHistory:updated_at:desc:50::false:";

pub(crate) fn send_accepted_invalidations(thread_id: &str) -> Vec<Value> {
    vec![
        thread_history_invalidation("sendAccepted"),
        thread_composer_state_invalidation(thread_id, "sendAccepted"),
        thread_runtime_invalidation(thread_id, "sendAccepted"),
        thread_summary_invalidation(thread_id, "sendAccepted"),
        thread_transcript_invalidation(thread_id, "sendAccepted"),
    ]
}

pub(crate) fn command_accepted_invalidations(thread_id: &str) -> Vec<Value> {
    vec![
        thread_history_invalidation("commandAccepted"),
        thread_composer_state_invalidation(thread_id, "commandAccepted"),
        thread_runtime_invalidation(thread_id, "commandAccepted"),
        thread_summary_invalidation(thread_id, "commandAccepted"),
        thread_transcript_invalidation(thread_id, "commandAccepted"),
    ]
}

pub(crate) fn invalidations_for_app_server_notification(
    notification: &Value,
    canonical_item_id: Option<&str>,
    rekeyed_item_ids: &[String],
) -> Vec<Value> {
    let Some(method) = notification.get("method").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(thread_id) = notification
        .get("params")
        .and_then(thread_id_from_params)
        .filter(|value| !value.trim().is_empty())
    else {
        return Vec::new();
    };

    let mut invalidations = Vec::new();
    let mut seen = HashSet::new();

    if invalidates_thread_history(method) {
        push_unique(
            &mut invalidations,
            &mut seen,
            thread_history_invalidation("appServerEvent"),
        );
        push_unique(
            &mut invalidations,
            &mut seen,
            thread_summary_invalidation(thread_id, "appServerEvent"),
        );
    }

    if invalidates_thread_runtime(method) {
        push_unique(
            &mut invalidations,
            &mut seen,
            thread_runtime_invalidation(thread_id, "appServerEvent"),
        );
    }

    if invalidates_thread_composer_state(method) {
        push_unique(
            &mut invalidations,
            &mut seen,
            thread_composer_state_invalidation(thread_id, "appServerEvent"),
        );
    }

    if invalidates_thread_token_usage(method) {
        push_unique(
            &mut invalidations,
            &mut seen,
            thread_token_usage_invalidation(thread_id, "appServerEvent"),
        );
    }

    if invalidates_turn(method)
        && let Some(turn_id) = notification.get("params").and_then(turn_id_from_params)
    {
        push_unique(
            &mut invalidations,
            &mut seen,
            turn_invalidation(thread_id, turn_id, "appServerEvent"),
        );
    }

    if invalidates_thread_transcript(method) || !rekeyed_item_ids.is_empty() {
        push_unique(
            &mut invalidations,
            &mut seen,
            thread_transcript_invalidation(thread_id, "appServerEvent"),
        );
    }

    if invalidates_work_item(method) {
        if let (Some(turn_id), Some(item_id)) = (
            notification.get("params").and_then(turn_id_from_params),
            notification.get("params").and_then(item_id_from_params),
        ) {
            push_unique(
                &mut invalidations,
                &mut seen,
                work_item_invalidation(
                    thread_id,
                    turn_id,
                    canonical_item_id.unwrap_or(item_id),
                    "appServerEvent",
                ),
            );
        }
    }

    if !rekeyed_item_ids.is_empty()
        && let Some(turn_id) = notification.get("params").and_then(turn_id_from_params)
    {
        for item_id in rekeyed_item_ids {
            push_unique(
                &mut invalidations,
                &mut seen,
                work_item_invalidation(thread_id, turn_id, item_id, "appServerEvent"),
            );
        }
    }

    invalidations
}

pub(crate) fn resources_invalidated_notification(invalidations: Vec<Value>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": RESOURCES_INVALIDATED_METHOD,
        "params": {
            "invalidations": invalidations,
        },
    })
}

fn thread_history_invalidation(reason: &str) -> Value {
    json!({
        "key": DEFAULT_THREAD_HISTORY_KEY,
        "reason": reason,
        "type": "threadHistory",
    })
}

fn thread_summary_invalidation(thread_id: &str, reason: &str) -> Value {
    json!({
        "key": format!("threadSummary:{thread_id}"),
        "reason": reason,
        "threadId": thread_id,
        "type": "threadSummary",
    })
}

fn thread_runtime_invalidation(thread_id: &str, reason: &str) -> Value {
    json!({
        "key": format!("threadRuntime:{thread_id}"),
        "reason": reason,
        "threadId": thread_id,
        "type": "threadRuntime",
    })
}

fn thread_composer_state_invalidation(thread_id: &str, reason: &str) -> Value {
    json!({
        "key": format!("threadComposerState:{thread_id}"),
        "reason": reason,
        "threadId": thread_id,
        "type": "threadComposerState",
    })
}

fn thread_token_usage_invalidation(thread_id: &str, reason: &str) -> Value {
    json!({
        "key": format!("threadTokenUsage:{thread_id}"),
        "reason": reason,
        "threadId": thread_id,
        "type": "threadTokenUsage",
    })
}

fn thread_transcript_invalidation(thread_id: &str, reason: &str) -> Value {
    json!({
        "key": format!("threadTranscript:{thread_id}"),
        "reason": reason,
        "threadId": thread_id,
        "type": "threadTranscript",
    })
}

fn turn_invalidation(thread_id: &str, turn_id: &str, reason: &str) -> Value {
    json!({
        "key": format!("turn:{thread_id}:{turn_id}"),
        "reason": reason,
        "threadId": thread_id,
        "turnId": turn_id,
        "type": "turn",
    })
}

fn work_item_invalidation(thread_id: &str, turn_id: &str, item_id: &str, reason: &str) -> Value {
    json!({
        "itemId": item_id,
        "key": format!("workItem:{thread_id}:{turn_id}:{item_id}"),
        "reason": reason,
        "threadId": thread_id,
        "turnId": turn_id,
        "type": "workItem",
    })
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

fn item_id_from_params(params: &Value) -> Option<&str> {
    params
        .get("itemId")
        .and_then(Value::as_str)
        .or_else(|| params.get("item_id").and_then(Value::as_str))
        .or_else(|| {
            params
                .get("item")
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str)
        })
}

fn invalidates_thread_runtime(method: &str) -> bool {
    matches!(
        method,
        "turn/started" | "turn/completed" | "item/started" | "thread/status/changed" | "error"
    )
}

fn invalidates_thread_composer_state(method: &str) -> bool {
    matches!(
        method,
        "thread/tokenUsage/updated"
            | "turn/started"
            | "turn/completed"
            | "model/rerouted"
            | "thread/compacted"
    )
}

fn invalidates_thread_token_usage(method: &str) -> bool {
    method == "thread/tokenUsage/updated"
}

fn invalidates_thread_history(method: &str) -> bool {
    matches!(
        method,
        "thread/started"
            | "thread/status/changed"
            | "thread/archived"
            | "thread/deleted"
            | "thread/unarchived"
            | "thread/closed"
            | "thread/name/updated"
            | "thread/goal/updated"
            | "thread/goal/cleared"
            | "thread/settings/updated"
            | "thread/tokenUsage/updated"
            | "turn/started"
            | "turn/completed"
    )
}

fn invalidates_thread_transcript(method: &str) -> bool {
    matches!(
        method,
        "turn/started"
            | "turn/completed"
            | "turn/diff/updated"
            | "turn/plan/updated"
            | "item/started"
            | "item/completed"
            | "rawResponseItem/completed"
            | "item/commandExecution/terminalInteraction"
            | "item/reasoning/summaryPartAdded"
            | "thread/compacted"
            | "model/rerouted"
            | "turn/moderationMetadata"
            | "warning"
            | "guardianWarning"
            | "error"
    )
}

fn invalidates_turn(method: &str) -> bool {
    matches!(method, "item/agentMessage/delta")
}

fn invalidates_work_item(method: &str) -> bool {
    matches!(
        method,
        "item/started"
            | "item/completed"
            | "item/agentMessage/delta"
            | "item/plan/delta"
            | "item/commandExecution/outputDelta"
            | "item/fileChange/outputDelta"
            | "item/fileChange/patchUpdated"
            | "item/mcpToolCall/progress"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/summaryPartAdded"
            | "item/reasoning/textDelta"
    )
}

fn push_unique(invalidations: &mut Vec<Value>, seen: &mut HashSet<String>, invalidation: Value) {
    let key = invalidation
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let kind = invalidation
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let dedupe_key = format!("{kind}:{key}");
    if seen.insert(dedupe_key) {
        invalidations.push(invalidation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_accepted_invalidates_thread_resources() {
        let invalidations = send_accepted_invalidations("thread-1");

        assert_eq!(invalidations.len(), 5);
        assert_eq!(invalidations[0]["type"], "threadHistory");
        assert_eq!(invalidations[1]["key"], "threadComposerState:thread-1");
        assert_eq!(invalidations[2]["key"], "threadRuntime:thread-1");
        assert_eq!(invalidations[3]["key"], "threadSummary:thread-1");
        assert_eq!(invalidations[4]["key"], "threadTranscript:thread-1");
    }

    #[test]
    fn turn_started_invalidates_history_summary_and_transcript() {
        let invalidations = invalidations_for_app_server_notification(
            &json!({
                "method": "turn/started",
                "params": { "threadId": "thread-2" },
            }),
            None,
            &[],
        );

        assert_eq!(invalidations.len(), 5);
        assert!(
            invalidations
                .iter()
                .any(|value| value["type"] == "threadHistory")
        );
        assert!(
            invalidations
                .iter()
                .any(|value| value["type"] == "threadSummary")
        );
        assert!(
            invalidations
                .iter()
                .any(|value| value["type"] == "threadRuntime")
        );
        assert!(
            invalidations
                .iter()
                .any(|value| value["type"] == "threadComposerState")
        );
        assert!(
            invalidations
                .iter()
                .any(|value| value["type"] == "threadTranscript")
        );
    }

    #[test]
    fn token_usage_update_invalidates_usage_resource() {
        let invalidations = invalidations_for_app_server_notification(
            &json!({
                "method": "thread/tokenUsage/updated",
                "params": { "threadId": "thread-usage", "turnId": "turn-1" },
            }),
            None,
            &[],
        );

        assert!(
            invalidations
                .iter()
                .any(|value| value["key"] == "threadTokenUsage:thread-usage")
        );
    }

    #[test]
    fn agent_message_delta_invalidates_turn_and_work_item() {
        let invalidations = invalidations_for_app_server_notification(
            &json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "agent-1",
                    "threadId": "thread-3",
                    "turnId": "turn-1"
                },
            }),
            None,
            &[],
        );

        assert_eq!(
            invalidations,
            vec![
                turn_invalidation("thread-3", "turn-1", "appServerEvent"),
                work_item_invalidation("thread-3", "turn-1", "agent-1", "appServerEvent"),
            ]
        );
    }

    #[test]
    fn command_output_delta_invalidates_work_item() {
        let invalidations = invalidations_for_app_server_notification(
            &json!({
                "method": "item/commandExecution/outputDelta",
                "params": {
                    "itemId": "cmd-1",
                    "threadId": "thread-3",
                    "turnId": "turn-1"
                },
            }),
            None,
            &[],
        );

        assert_eq!(
            invalidations,
            vec![work_item_invalidation(
                "thread-3",
                "turn-1",
                "cmd-1",
                "appServerEvent"
            )]
        );
    }

    #[test]
    fn work_item_invalidation_uses_canonical_item_id_when_available() {
        let invalidations = invalidations_for_app_server_notification(
            &json!({
                "method": "item/commandExecution/outputDelta",
                "params": {
                    "itemId": "cmd-1",
                    "threadId": "thread-3",
                    "turnId": "turn-1"
                },
            }),
            Some("cxitem:v1:turn-1:call:cmd-1"),
            &[],
        );

        assert_eq!(
            invalidations,
            vec![work_item_invalidation(
                "thread-3",
                "turn-1",
                "cxitem:v1:turn-1:call:cmd-1",
                "appServerEvent"
            )]
        );
    }

    #[test]
    fn rekeyed_items_invalidate_transcript_and_target_work_item() {
        let invalidations = invalidations_for_app_server_notification(
            &json!({
                "method": "rawResponseItem/completed",
                "params": {
                    "item": {
                        "call_id": "cmd-1",
                        "id": "fc-1",
                        "name": "exec_command",
                        "type": "function_call"
                    },
                    "threadId": "thread-3",
                    "turnId": "turn-1"
                },
            }),
            Some("cxitem:v1:turn-1:call:cmd-1"),
            &["cxitem:v1:turn-1:call:cmd-1".to_string()],
        );

        assert_eq!(
            invalidations,
            vec![
                thread_transcript_invalidation("thread-3", "appServerEvent"),
                work_item_invalidation(
                    "thread-3",
                    "turn-1",
                    "cxitem:v1:turn-1:call:cmd-1",
                    "appServerEvent"
                ),
            ]
        );
    }

    #[test]
    fn error_invalidates_runtime_and_transcript() {
        let invalidations = invalidations_for_app_server_notification(
            &json!({
                "method": "error",
                "params": { "threadId": "thread-4" },
            }),
            None,
            &[],
        );

        assert_eq!(
            invalidations,
            vec![
                thread_runtime_invalidation("thread-4", "appServerEvent"),
                thread_transcript_invalidation("thread-4", "appServerEvent"),
            ]
        );
    }
}
