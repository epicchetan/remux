use serde_json::{Value, json};

pub(crate) const REMUX_NOTIFICATION_REQUEST_METHOD: &str = "remux/notifications/request";
const DEFAULT_TURN_COMPLETED_BODY: &str = "Open the thread to review the result.";
const DEFAULT_TURN_FAILED_BODY: &str = "Open the thread to review the failure.";
const THREAD_COMPACTED_BODY: &str = "Open the thread to continue.";
const NOTIFICATION_BODY_MAX_CHARS: usize = 150;

pub(crate) fn notification_for_app_server_notification(
    notification: &Value,
    projected_turn: Option<&Value>,
) -> Option<Value> {
    let method = notification.get("method").and_then(Value::as_str)?;
    match method {
        "turn/completed" => turn_completed_notification(notification, projected_turn),
        "item/completed" => completed_item_notification(notification),
        "thread/compacted" => thread_compacted_notification(notification),
        _ => None,
    }
}

fn turn_completed_notification(
    notification: &Value,
    projected_turn: Option<&Value>,
) -> Option<Value> {
    let params = notification.get("params")?;
    let thread_id = params.get("threadId").and_then(Value::as_str)?;
    let turn = params.get("turn")?;
    let turn_id = turn.get("id").and_then(Value::as_str)?;
    if thread_id.trim().is_empty() || turn_id.trim().is_empty() {
        return None;
    }

    let failed = turn.get("status").and_then(Value::as_str) == Some("failed");
    let title = if failed {
        "Codex turn failed"
    } else {
        "Codex finished"
    };
    let body = if failed {
        failed_turn_body(turn).unwrap_or_else(|| DEFAULT_TURN_FAILED_BODY.to_string())
    } else {
        completed_turn_body(turn, projected_turn)
            .unwrap_or_else(|| DEFAULT_TURN_COMPLETED_BODY.to_string())
    };

    Some(json!({
        "jsonrpc": "2.0",
        "method": REMUX_NOTIFICATION_REQUEST_METHOD,
        "params": {
            "body": body,
            "extensionId": "codex",
            "id": format!("codex:turn-completed:{thread_id}:{turn_id}"),
            "target": {
                "focusId": turn_id,
                "focusKind": "turn",
                "resourceId": thread_id,
                "resourceKind": "thread",
            },
            "title": title,
            "viewId": "main",
        },
    }))
}

fn thread_compacted_notification(notification: &Value) -> Option<Value> {
    let params = notification.get("params")?;
    let thread_id = params.get("threadId").and_then(Value::as_str)?;
    thread_compacted_notification_for_thread_id(thread_id)
}

fn completed_item_notification(notification: &Value) -> Option<Value> {
    let params = notification.get("params")?;
    let item = params.get("item")?;
    if !is_compaction_item(item) {
        return None;
    }

    let thread_id = params.get("threadId").and_then(Value::as_str)?;
    thread_compacted_notification_for_thread_id(thread_id)
}

fn thread_compacted_notification_for_thread_id(thread_id: &str) -> Option<Value> {
    if thread_id.trim().is_empty() {
        return None;
    }

    Some(json!({
        "jsonrpc": "2.0",
        "method": REMUX_NOTIFICATION_REQUEST_METHOD,
        "params": {
            "body": THREAD_COMPACTED_BODY,
            "extensionId": "codex",
            "id": format!("codex:thread-compacted:{thread_id}"),
            "target": {
                "focusId": thread_id,
                "focusKind": "thread",
                "resourceId": thread_id,
                "resourceKind": "thread",
            },
            "title": "Codex compacted context",
            "viewId": "main",
        },
    }))
}

fn completed_turn_body(raw_turn: &Value, projected_turn: Option<&Value>) -> Option<String> {
    projected_turn
        .and_then(projected_final_assistant_body)
        .or_else(|| raw_final_assistant_body(raw_turn))
}

fn projected_final_assistant_body(turn: &Value) -> Option<String> {
    let segments = turn.get("segments").and_then(Value::as_array)?;
    final_assistant_text(segments).and_then(|text| notification_preview(&text))
}

fn raw_final_assistant_body(turn: &Value) -> Option<String> {
    let items = turn.get("items").and_then(Value::as_array)?;
    final_assistant_text(items).and_then(|text| notification_preview(&text))
}

fn final_assistant_text(items: &[Value]) -> Option<String> {
    let last_work_item_index = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            if is_work_item(item) {
                Some(index)
            } else {
                None
            }
        })
        .last();

    let text_after_work = items.iter().enumerate().rev().find_map(|(index, item)| {
        if is_assistant_message_item(item)
            && is_final_answer(item)
            && last_work_item_index.is_none_or(|work_index| index > work_index)
        {
            item_text(item)
        } else {
            None
        }
    });

    text_after_work.or_else(|| {
        items.iter().rev().find_map(|item| {
            if is_assistant_message_item(item) && is_final_answer(item) {
                item_text(item)
            } else {
                None
            }
        })
    })
}

fn is_work_item(item: &Value) -> bool {
    match item_type(item) {
        Some("userMessage") | Some("contextCompaction") | Some("reasoning") => false,
        Some("message") if item.get("role").and_then(Value::as_str) == Some("user") => false,
        _ if is_compaction_item(item) => false,
        _ if is_assistant_message_item(item) && is_final_answer(item) => false,
        _ => true,
    }
}

fn item_type(item: &Value) -> Option<&str> {
    item.get("type").and_then(Value::as_str)
}

fn is_assistant_message_item(item: &Value) -> bool {
    item_type(item) == Some("assistantMessage")
        || item_type(item) == Some("agentMessage")
        || (item_type(item) == Some("message")
            && item.get("role").and_then(Value::as_str) == Some("assistant"))
}

fn is_final_answer(item: &Value) -> bool {
    matches!(
        item.get("phase").and_then(Value::as_str),
        Some("final_answer") | None
    ) || item.get("phase").is_some_and(Value::is_null)
}

fn is_compaction_item(item: &Value) -> bool {
    matches!(
        item_type(item),
        Some("compaction" | "context_compaction" | "contextCompaction")
    )
}

fn item_text(item: &Value) -> Option<String> {
    message_content_text(item.get("text"))
        .or_else(|| message_content_text(item.get("message")))
        .or_else(|| message_content_text(item.get("content")))
        .or_else(|| message_content_text(item.get("output")))
        .filter(|text| !text.trim().is_empty())
}

fn message_content_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(items)) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("input_text").and_then(Value::as_str))
                        .or_else(|| item.get("output_text").and_then(Value::as_str))
                        .or_else(|| item.get("content").and_then(Value::as_str))
                })
                .collect::<Vec<_>>()
                .join("");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

fn failed_turn_body(turn: &Value) -> Option<String> {
    [
        turn.get("error"),
        turn.get("lastError"),
        turn.get("failure"),
        turn.get("statusDetails"),
    ]
    .into_iter()
    .find_map(failure_text)
    .and_then(|text| notification_preview(&text))
}

fn failure_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Object(object)) => ["message", "reason", "error", "details"]
            .into_iter()
            .find_map(|key| failure_text(object.get(key))),
        _ => None,
    }
}

fn notification_preview(text: &str) -> Option<String> {
    let markdown_text = strip_fenced_code_blocks(text);
    let cleaned = markdown_text
        .lines()
        .map(strip_markdown_line_prefix)
        .map(strip_markdown_markers)
        .collect::<Vec<_>>()
        .join(" ");
    let collapsed = collapse_whitespace(&cleaned);
    if collapsed.is_empty() {
        return None;
    }

    Some(truncate_preview(&collapsed, NOTIFICATION_BODY_MAX_CHARS))
}

fn strip_fenced_code_blocks(text: &str) -> String {
    let mut output = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            output.push(line);
        }
    }
    output.join("\n")
}

fn strip_markdown_line_prefix(line: &str) -> &str {
    let mut trimmed = line.trim();
    while trimmed.starts_with('#') || trimmed.starts_with('>') {
        trimmed = trimmed[1..].trim_start();
    }

    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = trimmed.strip_prefix(marker) {
            return rest.trim_start();
        }
    }

    if let Some((digits, rest)) = trimmed.split_once(". ")
        && !digits.is_empty()
        && digits.chars().all(|character| character.is_ascii_digit())
    {
        return rest.trim_start();
    }

    trimmed
}

fn strip_markdown_markers(line: &str) -> String {
    line.chars()
        .filter(|character| !matches!(character, '`' | '*' | '[' | ']'))
        .collect()
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }

    let mut cutoff = 0;
    let mut last_sentence_boundary = None;
    let mut last_word_boundary = None;
    for (char_index, (byte_index, character)) in text.char_indices().enumerate() {
        if char_index >= max_chars {
            break;
        }
        cutoff = byte_index + character.len_utf8();
        if matches!(character, '.' | '!' | '?') && char_index >= 80 {
            last_sentence_boundary = Some(cutoff);
        }
        if character.is_whitespace() && char_index >= 80 {
            last_word_boundary = Some(byte_index);
        }
    }

    let cutoff = last_sentence_boundary
        .or(last_word_boundary)
        .unwrap_or(cutoff);
    format!("{}...", text[..cutoff].trim_end())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{
        REMUX_NOTIFICATION_REQUEST_METHOD,
        notification_for_app_server_notification as notification_for_app_server_notification_with_projected,
    };

    fn notification_for_app_server_notification(notification: &Value) -> Option<Value> {
        notification_for_app_server_notification_with_projected(notification, None)
    }

    #[test]
    fn emits_notification_intent_for_completed_turn() {
        let notification = notification_for_app_server_notification(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "completed"
                }
            }
        }))
        .expect("notification intent");

        assert_eq!(notification["method"], REMUX_NOTIFICATION_REQUEST_METHOD);
        assert_eq!(notification["params"]["extensionId"], "codex");
        assert_eq!(
            notification["params"]["id"],
            "codex:turn-completed:thread-1:turn-1"
        );
        assert_eq!(
            notification["params"]["target"],
            json!({
                "focusId": "turn-1",
                "focusKind": "turn",
                "resourceId": "thread-1",
                "resourceKind": "thread",
            })
        );
    }

    #[test]
    fn uses_final_assistant_answer_as_completed_turn_body() {
        let notification = notification_for_app_server_notification(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [
                        {
                            "text": "run output",
                            "type": "commandExecution"
                        },
                        {
                            "phase": "final_answer",
                            "text": "Implemented the cleanup.\n\n```ts\nconst hidden = true;\n```\n\n- Restart the host to pick it up.",
                            "type": "agentMessage"
                        }
                    ],
                    "status": "completed"
                }
            }
        }))
        .expect("notification intent");

        assert_eq!(
            notification["params"]["body"],
            "Implemented the cleanup. Restart the host to pick it up."
        );
    }

    #[test]
    fn uses_projected_assistant_message_as_completed_turn_body() {
        let notification = notification_for_app_server_notification_with_projected(
            &json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-1",
                        "items": [],
                        "status": "completed"
                    }
                }
            }),
            Some(&json!({
                "segments": [
                    {
                        "type": "userMessage"
                    },
                    {
                        "state": "completed",
                        "type": "work"
                    },
                    {
                        "phase": "final_answer",
                        "text": "The server assembled this response from the live transcript.",
                        "type": "assistantMessage"
                    }
                ],
                "status": "completed",
                "turnId": "turn-1"
            })),
        )
        .expect("notification intent");

        assert_eq!(
            notification["params"]["body"],
            "The server assembled this response from the live transcript."
        );
    }

    #[test]
    fn projected_assistant_message_wins_over_raw_turn_body() {
        let notification = notification_for_app_server_notification_with_projected(
            &json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-1",
                        "items": [
                            {
                                "phase": "final_answer",
                                "text": "Raw fallback text.",
                                "type": "agentMessage"
                            }
                        ],
                        "status": "completed"
                    }
                }
            }),
            Some(&json!({
                "segments": [
                    {
                        "phase": "final_answer",
                        "text": "Projected transcript text.",
                        "type": "assistantMessage"
                    }
                ],
                "status": "completed",
                "turnId": "turn-1"
            })),
        )
        .expect("notification intent");

        assert_eq!(notification["params"]["body"], "Projected transcript text.");
    }

    #[test]
    fn falls_back_to_raw_body_when_projected_turn_has_no_answer_text() {
        let notification = notification_for_app_server_notification_with_projected(
            &json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-1",
                        "items": [
                            {
                                "phase": "final_answer",
                                "text": "Raw fallback still works.",
                                "type": "agentMessage"
                            }
                        ],
                        "status": "completed"
                    }
                }
            }),
            Some(&json!({
                "segments": [
                    {
                        "phase": "final_answer",
                        "text": "",
                        "type": "assistantMessage"
                    }
                ],
                "status": "completed",
                "turnId": "turn-1"
            })),
        )
        .expect("notification intent");

        assert_eq!(notification["params"]["body"], "Raw fallback still works.");
    }

    #[test]
    fn uses_raw_assistant_message_as_completed_turn_body() {
        let notification = notification_for_app_server_notification(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [
                        {
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "thinking out loud"
                                }
                            ],
                            "role": "assistant",
                            "type": "message"
                        },
                        {
                            "name": "exec_command",
                            "type": "function_call"
                        },
                        {
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "The notification now uses the final answer preview."
                                }
                            ],
                            "role": "assistant",
                            "type": "message"
                        }
                    ],
                    "status": "completed"
                }
            }
        }))
        .expect("notification intent");

        assert_eq!(
            notification["params"]["body"],
            "The notification now uses the final answer preview."
        );
    }

    #[test]
    fn reads_output_text_content_for_completed_turn_body() {
        let notification = notification_for_app_server_notification(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [
                        {
                            "content": [
                                {
                                    "output_text": "Preview from output_text content."
                                }
                            ],
                            "role": "assistant",
                            "type": "message"
                        }
                    ],
                    "status": "completed"
                }
            }
        }))
        .expect("notification intent");

        assert_eq!(
            notification["params"]["body"],
            "Preview from output_text content."
        );
    }

    #[test]
    fn falls_back_when_completed_turn_has_no_answer_text() {
        let notification = notification_for_app_server_notification(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "status": "completed"
                }
            }
        }))
        .expect("notification intent");

        assert_eq!(
            notification["params"]["body"],
            "Open the thread to review the result."
        );
    }

    #[test]
    fn uses_failed_turn_reason_when_available() {
        let notification = notification_for_app_server_notification(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "error": {
                        "message": "The model request timed out."
                    },
                    "id": "turn-1",
                    "status": "failed"
                }
            }
        }))
        .expect("notification intent");

        assert_eq!(notification["params"]["title"], "Codex turn failed");
        assert_eq!(
            notification["params"]["body"],
            "The model request timed out."
        );
    }

    #[test]
    fn emits_notification_intent_for_thread_compaction() {
        let notification = notification_for_app_server_notification(&json!({
            "method": "thread/compacted",
            "params": {
                "threadId": "thread-1"
            }
        }))
        .expect("notification intent");

        assert_eq!(notification["method"], REMUX_NOTIFICATION_REQUEST_METHOD);
        assert_eq!(notification["params"]["extensionId"], "codex");
        assert_eq!(
            notification["params"]["id"],
            "codex:thread-compacted:thread-1"
        );
        assert_eq!(notification["params"]["title"], "Codex compacted context");
        assert_eq!(
            notification["params"]["target"],
            json!({
                "focusId": "thread-1",
                "focusKind": "thread",
                "resourceId": "thread-1",
                "resourceKind": "thread",
            })
        );
    }

    #[test]
    fn emits_notification_intent_for_completed_compaction_item() {
        let notification = notification_for_app_server_notification(&json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "id": "cmp-1",
                    "type": "compaction"
                },
                "threadId": "thread-1",
                "turnId": "turn-1"
            }
        }))
        .expect("notification intent");

        assert_eq!(notification["method"], REMUX_NOTIFICATION_REQUEST_METHOD);
        assert_eq!(
            notification["params"]["id"],
            "codex:thread-compacted:thread-1"
        );
        assert_eq!(notification["params"]["title"], "Codex compacted context");
        assert_eq!(
            notification["params"]["target"],
            json!({
                "focusId": "thread-1",
                "focusKind": "thread",
                "resourceId": "thread-1",
                "resourceKind": "thread",
            })
        );
    }

    #[test]
    fn emits_notification_intent_for_completed_context_compaction_item() {
        let notification = notification_for_app_server_notification(&json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "id": "cmp-1",
                    "type": "context_compaction"
                },
                "threadId": "thread-1",
                "turnId": "turn-1"
            }
        }))
        .expect("notification intent");

        assert_eq!(
            notification["params"]["id"],
            "codex:thread-compacted:thread-1"
        );
    }

    #[test]
    fn ignores_non_turn_completion_notifications() {
        assert!(
            notification_for_app_server_notification(&json!({
                "method": "item/completed",
                "params": {
                    "item": {
                        "id": "message-1",
                        "type": "agentMessage"
                    },
                    "threadId": "thread-1"
                }
            }))
            .is_none()
        );
    }
}
