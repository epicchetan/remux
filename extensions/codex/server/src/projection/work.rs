use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::util::truncate_text;

use super::{
    MAX_COMMAND_OUTPUT_CHARS, compact_json, compaction_status, file_kind, first_index,
    first_index_any, item_id, item_type, normalize_user_content, output_text,
};

pub(super) fn build_work_entries(items: &[Value]) -> Vec<Value> {
    let mut entries = Vec::new();
    let mut pending = Vec::new();

    fn flush_pending(entries: &mut Vec<Value>, pending: &mut Vec<Value>) {
        if pending.is_empty() {
            return;
        }
        for group in build_work_group_refs(pending) {
            let id = format!(
                "group:{}:{}",
                group.get("id").and_then(Value::as_str).unwrap_or("group"),
                group
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(Value::as_str)
                    .unwrap_or("items")
            );
            entries.push(json!({
                "group": group,
                "id": id,
                "type": "group",
            }));
        }
        pending.clear();
    }

    for item in items {
        match item_type(item) {
            Some("agentMessage") => {
                flush_pending(&mut entries, &mut pending);
                let id = item_id(item).unwrap_or("agent");
                entries.push(json!({
                    "id": id,
                    "itemId": id,
                    "type": "message",
                }));
            }
            Some("userMessage") => {
                flush_pending(&mut entries, &mut pending);
                let id = item_id(item).unwrap_or("user");
                entries.push(json!({
                    "id": id,
                    "itemId": id,
                    "type": "userMessage",
                }));
            }
            Some("contextCompaction") => {
                flush_pending(&mut entries, &mut pending);
                let id = item_id(item).unwrap_or("compaction");
                entries.push(json!({
                    "id": id,
                    "itemId": id,
                    "type": "compaction",
                }));
            }
            Some("remuxWorkSummary") => {}
            _ => pending.push(item.clone()),
        }
    }
    flush_pending(&mut entries, &mut pending);
    entries
}

pub(super) fn build_work_item(
    item: &Value,
    compaction_statuses: &HashMap<String, String>,
    turn_status: &str,
) -> Option<Value> {
    match item_type(item) {
        Some("agentMessage") => {
            let id = item_id(item).unwrap_or("agent");
            Some(json!({
                "id": id,
                "phase": item.get("phase").cloned().unwrap_or(Value::Null),
                "text": item.get("text").and_then(Value::as_str).unwrap_or(""),
                "type": "message",
            }))
        }
        Some("userMessage") => {
            let id = item_id(item).unwrap_or("user");
            Some(json!({
                "content": normalize_user_content(item.get("content")),
                "id": id,
                "type": "userMessage",
            }))
        }
        Some("contextCompaction") => {
            let id = item_id(item).unwrap_or("compaction");
            Some(json!({
                "id": id,
                "status": compaction_statuses.get(id).cloned().unwrap_or_else(|| compaction_status(turn_status)),
                "type": "compaction",
            }))
        }
        Some("commandExecution") | Some("webSearch") => work_activity(item).map(|activity| {
            let id = item_id(item).unwrap_or("activity");
            json!({
                "activity": activity,
                "id": id,
                "type": "activity",
            })
        }),
        Some("fileChange") => {
            let id = item_id(item).unwrap_or("file");
            Some(json!({
                "files": file_changes_for_item(item),
                "id": id,
                "type": "fileChanges",
            }))
        }
        Some("mcpToolCall") | Some("dynamicToolCall") | Some("hookPrompt") => {
            tool_row(item).map(|row| {
                let id = item_id(item).unwrap_or("tool");
                json!({
                    "id": id,
                    "row": row,
                    "type": "tool",
                })
            })
        }
        _ => None,
    }
}

fn build_work_group_refs(items: &[Value]) -> Vec<Value> {
    let mut groups = Vec::new();
    let files = item_ids_for_types(items, &["fileChange"]);
    if !files.is_empty() {
        groups.push((
            first_index(items, "fileChange"),
            json!({
                "id": "files",
                "itemIds": files,
                "title": "Changed files",
                "type": "files",
            }),
        ));
    }
    let activities = item_ids_for_types(items, &["commandExecution", "webSearch"]);
    if !activities.is_empty() {
        groups.push((
            first_index_any(items, &["commandExecution", "webSearch"]),
            json!({
                "id": "activity",
                "itemIds": activities,
                "title": "Activity",
                "type": "activity",
            }),
        ));
    }
    let tools = item_ids_for_types(items, &["mcpToolCall", "dynamicToolCall", "hookPrompt"]);
    if !tools.is_empty() {
        groups.push((
            first_index_any(items, &["mcpToolCall", "dynamicToolCall", "hookPrompt"]),
            json!({
                "id": "tools",
                "itemIds": tools,
                "title": "Tools",
                "type": "tools",
            }),
        ));
    }
    groups.sort_by_key(|(index, _)| *index);
    groups.into_iter().map(|(_, group)| group).collect()
}

fn item_ids_for_types(items: &[Value], kinds: &[&str]) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for item in items
        .iter()
        .filter(|item| item_type(item).is_some_and(|kind| kinds.contains(&kind)))
    {
        let Some(id) = item_id(item) else {
            continue;
        };
        if seen.insert(id.to_string()) {
            ids.push(Value::String(id.to_string()));
        }
    }
    ids
}

fn file_changes_for_item(item: &Value) -> Vec<Value> {
    let mut result = Vec::new();
    for change in item
        .get("changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let diff = change.get("diff").and_then(Value::as_str).unwrap_or("");
        let kind = file_kind(change.get("kind"));
        result.push(json!({
            "additions": diff.lines().filter(|line| line.starts_with('+') && !line.starts_with("+++")).count(),
            "deletions": diff.lines().filter(|line| line.starts_with('-') && !line.starts_with("---")).count(),
            "diff": diff,
            "id": format!("{}:{}", item_id(item).unwrap_or("file"), change.get("path").and_then(Value::as_str).unwrap_or("")),
            "kind": kind,
            "path": change.get("path").and_then(Value::as_str).unwrap_or(""),
            "status": item.get("status").and_then(Value::as_str).unwrap_or("completed"),
        }));
    }
    result
}

fn work_activity(item: &Value) -> Option<Value> {
    match item_type(item) {
        Some("commandExecution") => Some(json!({
            "command": item.get("command").cloned().unwrap_or(Value::Null),
            "detail": item.get("cwd").cloned().unwrap_or(Value::Null),
            "durationMs": item.get("durationMs").cloned().unwrap_or(Value::Null),
            "exitCode": item.get("exitCode").cloned().unwrap_or(Value::Null),
            "id": item_id(item).unwrap_or("command"),
            "kind": "command",
            "output": truncate_text(item.get("aggregatedOutput").and_then(Value::as_str).unwrap_or(""), MAX_COMMAND_OUTPUT_CHARS),
            "path": null,
            "status": item.get("status").and_then(Value::as_str).unwrap_or("completed"),
            "text": format!("Ran {}", item.get("command").and_then(Value::as_str).unwrap_or("command")),
        })),
        Some("webSearch") => Some(json!({
            "command": null,
            "detail": item.get("query").cloned().unwrap_or(Value::Null),
            "durationMs": null,
            "exitCode": null,
            "id": item_id(item).unwrap_or("web-search"),
            "kind": "webSearch",
            "output": null,
            "path": null,
            "status": "completed",
            "text": format!("Searched web for {}", item.get("query").and_then(Value::as_str).unwrap_or("")),
        })),
        _ => None,
    }
}

fn tool_row(item: &Value) -> Option<Value> {
    match item_type(item) {
        Some("mcpToolCall") => Some(json!({
            "category": "generic",
            "detail": compact_json(item.get("arguments")),
            "id": item_id(item).unwrap_or("mcp"),
            "label": format!("Ran {}", item.get("tool").and_then(Value::as_str).unwrap_or("tool")),
            "media": [],
            "result": compact_json(item.get("result")).or_else(|| compact_json(item.get("error"))),
            "status": item.get("status").and_then(Value::as_str).unwrap_or("completed"),
        })),
        Some("dynamicToolCall") => Some(json!({
            "category": "generic",
            "detail": compact_json(item.get("arguments")),
            "id": item_id(item).unwrap_or("tool"),
            "label": format!("Ran {}", item.get("tool").and_then(Value::as_str).unwrap_or("tool")),
            "media": [],
            "result": output_text(item.get("contentItems")),
            "status": item.get("status").and_then(Value::as_str).unwrap_or("completed"),
        })),
        Some("hookPrompt") => Some(json!({
            "category": "generic",
            "detail": item
                .get("fragments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|fragment| fragment.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            "id": item_id(item).unwrap_or("hook"),
            "label": "Ran hook",
            "media": [],
            "result": null,
            "status": "completed",
        })),
        _ => None,
    }
}
