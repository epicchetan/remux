use serde_json::{Value, json};

use crate::util::{truncate_text, value_to_text};

use super::{MAX_DIFF_CHARS, MAX_TOOL_RESULT_CHARS, normalize_phase, normalize_user_content};

pub(super) fn user_message_item(payload: &Value, id: &str) -> Value {
    let mut content = Vec::new();
    if let Some(message) = payload.get("message").and_then(Value::as_str) {
        if !message.is_empty() {
            content.push(json!({ "type": "text", "text": message }));
        }
    }
    for image in payload
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        content.push(image.clone());
    }
    for image in payload
        .get("local_images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        content.push(image.clone());
    }
    for element in payload
        .get("text_elements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        content.push(element.clone());
    }

    json!({
        "content": normalize_user_content(Some(&Value::Array(content))),
        "id": id,
        "type": "userMessage",
    })
}

pub(super) fn agent_message_item(payload: &Value, id: &str) -> Value {
    json!({
        "id": id,
        "memoryCitation": payload.get("memory_citation").cloned().unwrap_or(Value::Null),
        "phase": normalize_phase(payload.get("phase")),
        "text": payload.get("message").and_then(Value::as_str).unwrap_or(""),
        "type": "agentMessage",
    })
}

pub(super) fn agent_message_key(item: &Value) -> String {
    format!(
        "{}:{}",
        item.get("phase").and_then(Value::as_str).unwrap_or("null"),
        item.get("text").and_then(Value::as_str).unwrap_or("")
    )
}

pub(super) fn function_call_item(payload: &Value, id: &str) -> Value {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    if name == "exec_command" {
        let arguments = payload
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let parsed = serde_json::from_str::<Value>(arguments).unwrap_or(Value::Null);
        return json!({
            "aggregatedOutput": "",
            "command": parsed.get("cmd").and_then(Value::as_str).unwrap_or(""),
            "commandActions": command_actions(parsed.get("cmd").and_then(Value::as_str).unwrap_or("")),
            "cwd": parsed.get("workdir").and_then(Value::as_str).unwrap_or(""),
            "durationMs": null,
            "exitCode": null,
            "id": id,
            "processId": null,
            "source": "agent",
            "status": "inProgress",
            "type": "commandExecution",
        });
    }

    json!({
        "arguments": payload.get("arguments").cloned().unwrap_or(Value::Null),
        "contentItems": [],
        "id": id,
        "namespace": null,
        "status": "inProgress",
        "success": null,
        "tool": name,
        "type": "dynamicToolCall",
    })
}

pub(super) fn custom_tool_call_item(payload: &Value, id: &str) -> Value {
    json!({
        "arguments": payload.get("input").cloned().unwrap_or(Value::Null),
        "contentItems": [],
        "id": id,
        "namespace": null,
        "status": "inProgress",
        "success": null,
        "tool": payload.get("name").and_then(Value::as_str).unwrap_or("custom_tool"),
        "type": "dynamicToolCall",
    })
}

pub(super) fn complete_call_item(item: &mut Value, payload: &Value) {
    let output = truncate_text(
        &value_to_text(payload.get("output").unwrap_or(&Value::Null)),
        MAX_TOOL_RESULT_CHARS,
    );
    match item.get("type").and_then(Value::as_str) {
        Some("commandExecution") => {
            item["aggregatedOutput"] = Value::String(output);
            item["status"] = Value::String("completed".to_string());
            item["exitCode"] = Value::Number(0.into());
        }
        Some("dynamicToolCall") => {
            item["contentItems"] = json!([{ "type": "text", "text": output }]);
            item["status"] = Value::String("completed".to_string());
            item["success"] = Value::Bool(true);
        }
        _ => {}
    }
}

pub(super) fn file_change_item(payload: &Value, id: &str) -> Value {
    let mut changes = Vec::new();
    if let Some(array) = payload.get("changes").and_then(Value::as_array) {
        for change in array {
            changes.push(json!({
                "diff": truncate_text(change.get("diff").and_then(Value::as_str).unwrap_or(""), MAX_DIFF_CHARS),
                "kind": change.get("kind").cloned().unwrap_or_else(|| json!({ "type": "update" })),
                "path": change.get("path").and_then(Value::as_str).unwrap_or(""),
            }));
        }
    } else {
        changes.push(json!({
            "diff": truncate_text(payload.get("diff").and_then(Value::as_str).unwrap_or(""), MAX_DIFF_CHARS),
            "kind": { "type": "update" },
            "path": payload.get("path").and_then(Value::as_str).unwrap_or(""),
        }));
    }

    json!({
        "changes": changes,
        "id": id,
        "status": if payload.get("success").and_then(Value::as_bool) == Some(false) { "failed" } else { "completed" },
        "type": "fileChange",
    })
}

pub(super) fn mcp_tool_call_item(payload: &Value, id: &str) -> Value {
    json!({
        "arguments": payload.get("arguments").cloned().unwrap_or(Value::Null),
        "error": payload.get("error").cloned().unwrap_or(Value::Null),
        "id": id,
        "result": payload.get("result").cloned().unwrap_or(Value::Null),
        "server": payload.get("server").and_then(Value::as_str).unwrap_or("mcp"),
        "status": if payload.get("error").is_some() { "failed" } else { "completed" },
        "tool": payload.get("tool").and_then(Value::as_str).unwrap_or("tool"),
        "type": "mcpToolCall",
    })
}

fn command_actions(command: &str) -> Vec<Value> {
    if let Some(path) = command.strip_prefix("cat ") {
        return vec![json!({ "type": "read", "path": path.trim(), "name": path.trim() })];
    }
    if let Some(path) = command.strip_prefix("ls ") {
        return vec![json!({ "type": "listFiles", "path": path.trim() })];
    }
    if command.starts_with("rg ") {
        return vec![json!({ "type": "search", "command": command })];
    }
    Vec::new()
}
