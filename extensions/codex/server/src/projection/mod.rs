mod items;
mod segments;
mod work;

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::item_identity::{
    DiskItemIdentity, IDENTITY_ALIASES_FIELD, LegacyItemCounters, canonical_for_source_alias,
    disk_item_identity, source_aliases,
};
use crate::transcript::TurnRange;
use crate::util::{number_as_i64, payload_value, stable_revision_value, value_to_text};
use items::{
    agent_message_item, agent_message_key, complete_call_item, custom_tool_call_item,
    file_change_item, function_call_item, mcp_tool_call_item, user_message_item,
};
use segments::{assistant_segment, compaction_segment, push_compaction_segment, user_segment};
use work::{build_work_entries, build_work_item};

pub(super) const MAX_COMMAND_OUTPUT_CHARS: usize = 256 * 1024;
pub(super) const MAX_DIFF_CHARS: usize = 512 * 1024;
pub(super) const MAX_TOOL_RESULT_CHARS: usize = 256 * 1024;

const HOOK_PROMPT_CLOSE_TAG: &str = "</hook_prompt>";
const HOOK_PROMPT_OPEN_TAG: &str = "<hook_prompt";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HookPromptFragment {
    pub(crate) hook_run_id: String,
    pub(crate) text: String,
}

pub(super) fn normalize_user_content(value: Option<&Value>) -> Value {
    let parts = value.and_then(Value::as_array);
    Value::Array(
        parts
            .into_iter()
            .flatten()
            .filter_map(normalize_user_input)
            .collect(),
    )
}

fn normalize_user_input(part: &Value) -> Option<Value> {
    let kind = part.get("type").and_then(Value::as_str)?;
    match kind {
        "text" | "input_text" => Some(json!({
            "text": part.get("text").and_then(Value::as_str).unwrap_or(""),
            "text_elements": part
                .get("text_elements")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            "type": "text",
        })),
        "image" => part.get("url").and_then(Value::as_str).map(|url| {
            json!({
                "type": "image",
                "url": url,
            })
        }),
        "input_image" => part.get("image_url").and_then(Value::as_str).map(|url| {
            json!({
                "type": "image",
                "url": url,
            })
        }),
        "localImage" => part.get("path").and_then(Value::as_str).map(|path| {
            json!({
                "path": path,
                "type": "localImage",
            })
        }),
        "mention" | "skill" => {
            let name = part.get("name").and_then(Value::as_str)?;
            let path = part.get("path").and_then(Value::as_str)?;
            Some(json!({
                "name": name,
                "path": path,
                "type": kind,
            }))
        }
        _ => None,
    }
}

fn user_message_key(item: &Value) -> String {
    format!(
        "user:{}",
        stable_revision_value(item.get("content").unwrap_or(&Value::Null))
    )
}

fn hook_prompt_item(id: &str, fragments: Vec<HookPromptFragment>) -> Value {
    json!({
        "fragments": fragments
            .into_iter()
            .map(|fragment| json!({
                "hookRunId": fragment.hook_run_id,
                "text": fragment.text,
            }))
            .collect::<Vec<_>>(),
        "id": id,
        "type": "hookPrompt",
    })
}

pub(crate) fn parse_visible_hook_prompt_fragments(
    value: Option<&Value>,
) -> Option<Vec<HookPromptFragment>> {
    let mut fragments = Vec::new();
    for part in value?.as_array()? {
        let text = response_input_text(part)?;
        if let Some(fragment) = parse_hook_prompt_fragment(text) {
            fragments.push(fragment);
            continue;
        }
        if is_contextual_user_text(text) {
            continue;
        }
        return None;
    }

    if fragments.is_empty() {
        None
    } else {
        Some(fragments)
    }
}

pub(crate) fn is_contextual_user_message_content(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(response_input_text)
        .any(is_contextual_user_text)
}

fn response_input_text(part: &Value) -> Option<&str> {
    match part.get("type").and_then(Value::as_str) {
        Some("input_text" | "text") => part.get("text").and_then(Value::as_str),
        _ => None,
    }
}

fn is_contextual_user_text(text: &str) -> bool {
    let trimmed = text.trim();
    let trimmed_start = text.trim_start();
    if trimmed_start.starts_with("<turn_aborted>") {
        return true;
    }
    if matches_marked_text("<environment_context>", "</environment_context>", text)
        || matches_marked_text("<skills_instructions>", "</skills_instructions>", text)
        || matches_marked_text("<skill>", "</skill>", text)
        || matches_marked_text("<user_shell_command>", "</user_shell_command>", text)
        || matches_marked_text("<subagent_notification>", "</subagent_notification>", text)
        || matches_marked_text("<recommended_plugins>", "</recommended_plugins>", text)
        || matches_marked_text("<goal_context>", "</goal_context>", text)
    {
        return true;
    }
    if is_agents_instruction_text(text)
        || is_additional_context_text(trimmed)
        || is_internal_model_context_text(trimmed)
        || is_legacy_contextual_user_warning(trimmed)
    {
        return true;
    }
    parse_hook_prompt_fragment(text).is_some()
}

fn matches_marked_text(start_marker: &str, end_marker: &str, text: &str) -> bool {
    let trimmed_start = text.trim_start();
    let starts_with_marker = trimmed_start
        .get(..start_marker.len())
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(start_marker));
    if !starts_with_marker {
        return false;
    }

    let trimmed = trimmed_start.trim_end();
    trimmed
        .get(trimmed.len().saturating_sub(end_marker.len())..)
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(end_marker))
}

fn is_agents_instruction_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("# AGENTS.md instructions")
        && trimmed.trim_end().ends_with("</INSTRUCTIONS>")
}

fn is_additional_context_text(trimmed: &str) -> bool {
    let Some(rest) = trimmed.strip_prefix("<external_") else {
        return false;
    };
    let Some((key, value_and_close)) = rest.split_once('>') else {
        return false;
    };
    !key.trim().is_empty() && value_and_close.ends_with(&format!("</external_{key}>"))
}

fn is_internal_model_context_text(trimmed: &str) -> bool {
    if matches_marked_text("<goal_context>", "</goal_context>", trimmed) {
        return true;
    }
    let Some(rest) = trimmed.strip_prefix("<codex_internal_context") else {
        return false;
    };
    let Some(rest) = rest.strip_prefix(" source=\"") else {
        return false;
    };
    let Some((source, body_and_close)) = rest.split_once("\">") else {
        return false;
    };
    is_valid_internal_context_source(source)
        && body_and_close.ends_with("</codex_internal_context>")
}

fn is_valid_internal_context_source(source: &str) -> bool {
    let mut chars = source.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && chars.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

fn is_legacy_contextual_user_warning(trimmed: &str) -> bool {
    trimmed
        .starts_with("Warning: The maximum number of unified exec processes you can keep open is")
        || trimmed.starts_with(
            "Warning: Your account was flagged for potentially high-risk cyber activity",
        )
        || (trimmed.starts_with("Warning: apply_patch was requested via ")
            && trimmed.ends_with("Use the apply_patch tool instead of exec_command."))
}

fn parse_hook_prompt_fragment(text: &str) -> Option<HookPromptFragment> {
    let trimmed = text.trim();
    let open_end = trimmed.find('>')?;
    let open_tag = &trimmed[..open_end + 1];
    if !open_tag.starts_with(HOOK_PROMPT_OPEN_TAG) || !trimmed.ends_with(HOOK_PROMPT_CLOSE_TAG) {
        return None;
    }

    let hook_run_id = xml_attribute(open_tag, "hook_run_id")?;
    if hook_run_id.trim().is_empty() {
        return None;
    }
    let body = &trimmed[open_end + 1..trimmed.len() - HOOK_PROMPT_CLOSE_TAG.len()];
    Some(HookPromptFragment {
        hook_run_id,
        text: decode_xml_entities(body),
    })
}

fn xml_attribute(tag: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}=\"");
    let start = tag.find(&prefix)? + prefix.len();
    let end = tag[start..].find('"')? + start;
    Some(decode_xml_entities(&tag[start..end]))
}

fn decode_xml_entities(text: &str) -> String {
    text.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

#[derive(Debug, Clone)]
pub(crate) struct ProjectedTurn {
    pub(crate) details_by_segment_id: HashMap<String, Value>,
    pub(crate) raw_turn: RawTurn,
    pub(crate) turn: Value,
    pub(crate) work_items_by_id: HashMap<String, Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct RawTurn {
    pub(crate) completed_at: Option<i64>,
    pub(crate) duration_ms: Option<i64>,
    pub(crate) error: Option<Value>,
    pub(crate) id: String,
    pub(crate) items: Vec<Value>,
    pub(crate) started_at: Option<i64>,
    pub(crate) status: String,
}

#[derive(Debug, Default)]
struct DiskItemTable {
    call_id_to_item_id: HashMap<String, String>,
    id_to_index: HashMap<String, usize>,
    items: Vec<Value>,
    last_compaction_item_id: Option<String>,
    message_key_to_item_id: HashMap<String, String>,
    pending_call_outputs: HashMap<String, Vec<Value>>,
}

impl DiskItemTable {
    fn into_items(self) -> Vec<Value> {
        self.items
    }

    fn upsert_item(&mut self, item: Value) {
        self.clear_compaction_candidate();
        self.upsert_item_inner(item);
    }

    fn upsert_item_inner(&mut self, item: Value) {
        let Some(item_id) = item_id(&item).map(str::to_string) else {
            return;
        };
        if let Some(index) = self.id_to_index.get(&item_id).copied() {
            merge_disk_item(&mut self.items[index], item);
            return;
        }

        self.id_to_index.insert(item_id, self.items.len());
        self.items.push(item);
    }

    fn upsert_message(&mut self, message_key: String, item: Value) {
        self.clear_compaction_candidate();
        let Some(new_item_id) = item_id(&item).map(str::to_string) else {
            return;
        };

        if let Some(existing_item_id) = self.message_key_to_item_id.get(&message_key).cloned() {
            if let Some(index) = self.id_to_index.get(&existing_item_id).copied() {
                let target_item_id =
                    preferred_disk_item_id(&existing_item_id, &new_item_id).to_string();
                if target_item_id != existing_item_id {
                    add_identity_alias(
                        &mut self.items[index],
                        canonical_identity_alias(&existing_item_id),
                    );
                    self.items[index]["id"] = Value::String(target_item_id.clone());
                    self.id_to_index.remove(&existing_item_id);
                    self.id_to_index.insert(target_item_id.clone(), index);
                    self.message_key_to_item_id
                        .insert(message_key, target_item_id.clone());
                }
                if new_item_id != target_item_id {
                    add_identity_alias(
                        &mut self.items[index],
                        canonical_identity_alias(&new_item_id),
                    );
                }
                merge_disk_item(&mut self.items[index], item);
                return;
            }
        }

        self.message_key_to_item_id
            .insert(message_key, new_item_id.clone());
        self.upsert_item(item);
    }

    fn upsert_call_item(&mut self, call_id: Option<&str>, item: Value) {
        self.clear_compaction_candidate();
        let Some(item_id) = item_id(&item).map(str::to_string) else {
            return;
        };
        if let Some(call_id) = call_id.filter(|value| !value.trim().is_empty()) {
            if let Some(existing_item_id) = self.call_id_to_item_id.get(call_id).cloned() {
                if let Some(index) = self.id_to_index.get(&existing_item_id).copied() {
                    merge_disk_item(&mut self.items[index], item);
                    return;
                }
            }
            self.call_id_to_item_id
                .insert(call_id.to_string(), item_id.clone());
            self.upsert_item(item);
            if let Some(outputs) = self.pending_call_outputs.remove(call_id) {
                for output in outputs {
                    self.complete_call(call_id, &output);
                }
            }
            return;
        }

        self.upsert_item(item);
    }

    fn upsert_compaction(&mut self, item: Value) {
        let Some(new_item_id) = item_id(&item).map(str::to_string) else {
            return;
        };

        if let Some(existing_item_id) = self.last_compaction_item_id.clone()
            && let Some(index) = self.id_to_index.get(&existing_item_id).copied()
        {
            let target_item_id =
                preferred_disk_item_id(&existing_item_id, &new_item_id).to_string();
            if target_item_id != existing_item_id {
                add_identity_alias(
                    &mut self.items[index],
                    canonical_identity_alias(&existing_item_id),
                );
                self.items[index]["id"] = Value::String(target_item_id.clone());
                self.id_to_index.remove(&existing_item_id);
                self.id_to_index.insert(target_item_id.clone(), index);
                self.last_compaction_item_id = Some(target_item_id.clone());
            }
            if new_item_id != target_item_id {
                add_identity_alias(
                    &mut self.items[index],
                    canonical_identity_alias(&new_item_id),
                );
            }
            merge_disk_item(&mut self.items[index], item);
            return;
        }

        self.last_compaction_item_id = Some(new_item_id);
        self.upsert_item_inner(item);
    }

    fn complete_call(&mut self, call_id: &str, payload: &Value) {
        self.clear_compaction_candidate();
        let Some(item_id) = self.call_id_to_item_id.get(call_id).cloned() else {
            self.pending_call_outputs
                .entry(call_id.to_string())
                .or_default()
                .push(payload.clone());
            return;
        };
        let Some(index) = self.id_to_index.get(&item_id).copied() else {
            return;
        };
        complete_call_item(&mut self.items[index], payload);
    }

    fn upsert_existing_item(&mut self, item: Value) {
        match item_type(&item) {
            Some("agentMessage") => self.upsert_message(agent_message_key(&item), item),
            Some("userMessage") => self.upsert_message(user_message_key(&item), item),
            Some("contextCompaction") => self.upsert_compaction(item),
            Some(kind) if is_call_like_raw_item_kind(kind) => {
                let call_id = call_id_from_aliases(&item);
                self.upsert_call_item(call_id.as_deref(), item);
            }
            _ => self.upsert_item(item),
        }
    }

    fn clear_compaction_candidate(&mut self) {
        self.last_compaction_item_id = None;
    }
}

fn preferred_disk_item_id<'a>(left: &'a str, right: &'a str) -> &'a str {
    if left.contains(":legacy:") && !right.contains(":legacy:") {
        right
    } else {
        left
    }
}

fn merge_disk_item(target: &mut Value, source: Value) {
    let Some(source_object) = source.as_object() else {
        *target = source;
        return;
    };
    if !target.is_object() {
        *target = json!({});
    }
    let target_type = item_type(target).map(str::to_string);
    for (field, value) in source_object {
        if field == "id" {
            continue;
        }
        if field == IDENTITY_ALIASES_FIELD {
            merge_identity_aliases(target, value);
            continue;
        }
        if field == "status" && target_type.as_deref() == Some("contextCompaction") {
            target[field] = merge_compaction_status_value(target.get(field), value);
            continue;
        }
        if is_empty_disk_value(value) && target.get(field).is_some() {
            continue;
        }
        target[field] = value.clone();
    }
}

fn add_identity_alias(item: &mut Value, alias: String) {
    if alias.trim().is_empty() {
        return;
    }
    let mut aliases = item
        .get(IDENTITY_ALIASES_FIELD)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if aliases.iter().any(|value| value.as_str() == Some(&alias)) {
        return;
    }
    aliases.push(Value::String(alias));
    item[IDENTITY_ALIASES_FIELD] = Value::Array(aliases);
}

fn merge_identity_aliases(target: &mut Value, source_aliases: &Value) {
    let mut seen = HashSet::new();
    let mut aliases = Vec::new();
    for alias in target
        .get(IDENTITY_ALIASES_FIELD)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(source_aliases.as_array().into_iter().flatten())
        .filter_map(Value::as_str)
    {
        if seen.insert(alias.to_string()) {
            aliases.push(Value::String(alias.to_string()));
        }
    }
    if aliases.is_empty() {
        return;
    }
    target[IDENTITY_ALIASES_FIELD] = Value::Array(aliases);
}

fn canonical_identity_alias(item_id: &str) -> String {
    format!("canonical:{item_id}")
}

fn merge_compaction_status_value(existing: Option<&Value>, incoming: &Value) -> Value {
    let Some(incoming_status) = incoming.as_str() else {
        return incoming.clone();
    };
    let existing_status = existing.and_then(Value::as_str);
    if existing_status.is_some_and(is_completed_compaction_status)
        || is_completed_compaction_status(incoming_status)
    {
        return Value::String("completed".to_string());
    }
    if existing_status.is_some_and(is_cancelled_compaction_status)
        || is_cancelled_compaction_status(incoming_status)
    {
        return Value::String("cancelled".to_string());
    }
    Value::String(incoming_status.to_string())
}

fn is_completed_compaction_status(status: &str) -> bool {
    matches!(status, "completed" | "compacted")
}

fn is_cancelled_compaction_status(status: &str) -> bool {
    matches!(status, "failed" | "interrupted" | "cancelled")
}

fn call_id_from_aliases(item: &Value) -> Option<String> {
    source_aliases(item)
        .into_iter()
        .find_map(|alias| alias.strip_prefix("call:").map(str::to_string))
}

fn is_call_like_raw_item_kind(kind: &str) -> bool {
    matches!(
        kind,
        "commandExecution"
            | "dynamicToolCall"
            | "fileChange"
            | "mcpToolCall"
            | "webSearch"
            | "imageGeneration"
            | "collabAgentToolCall"
            | "subAgentActivity"
    )
}

fn is_compaction_marker(payload_type: Option<&str>, row: &Value) -> bool {
    matches!(
        payload_type,
        Some("compaction" | "context_compaction" | "context_compacted")
    ) || row.get("type").and_then(Value::as_str) == Some("compacted")
}

fn is_compaction_candidate_boundary(payload_type: Option<&str>, row: &Value) -> bool {
    if is_compaction_marker(payload_type, row) {
        return false;
    }
    if matches!(
        payload_type,
        Some("task_started" | "task_complete" | "turn_aborted" | "token_count")
    ) {
        return false;
    }
    row.get("type").and_then(Value::as_str) != Some("turn_context")
}

fn is_empty_disk_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
        _ => false,
    }
}

pub(crate) fn project_rows_to_raw_turn(
    turn_id: &str,
    rows: &[Value],
    range: &TurnRange,
) -> RawTurn {
    let mut turn = RawTurn {
        completed_at: None,
        duration_ms: None,
        error: None,
        id: turn_id.to_string(),
        items: Vec::new(),
        started_at: None,
        status: "inProgress".to_string(),
    };
    let mut identity_counters = LegacyItemCounters::default();
    let mut table = DiskItemTable::default();

    for row in rows {
        let payload = payload_value(row).unwrap_or(row);
        let payload_type = payload.get("type").and_then(Value::as_str);
        if is_compaction_candidate_boundary(payload_type, row) {
            table.clear_compaction_candidate();
        }
        match payload_type {
            Some("task_started") => {
                turn.started_at = payload.get("started_at").and_then(number_as_i64);
            }
            Some("task_complete") => {
                turn.completed_at = payload.get("completed_at").and_then(number_as_i64);
                turn.duration_ms = payload.get("duration_ms").and_then(number_as_i64);
                turn.status = "completed".to_string();
            }
            Some("turn_aborted") => {
                turn.completed_at = payload.get("completed_at").and_then(number_as_i64);
                turn.duration_ms = payload.get("duration_ms").and_then(number_as_i64);
                turn.status = "interrupted".to_string();
                if let Some(reason) = payload.get("reason") {
                    turn.error = Some(json!({
                        "additionalDetails": null,
                        "codexErrorInfo": null,
                        "message": value_to_text(reason),
                    }));
                }
            }
            Some("user_message") => {
                let identity = disk_item_identity(
                    turn_id,
                    "userMessage",
                    payload.get("id").and_then(Value::as_str),
                    None,
                    &mut identity_counters,
                );
                let item = apply_item_identity(user_message_item(payload, &identity.id), identity);
                table.upsert_message(user_message_key(&item), item);
            }
            Some("agent_message") => {
                let identity = disk_item_identity(
                    turn_id,
                    "agentMessage",
                    payload.get("id").and_then(Value::as_str),
                    None,
                    &mut identity_counters,
                );
                let item = apply_item_identity(agent_message_item(payload, &identity.id), identity);
                table.upsert_message(agent_message_key(&item), item);
            }
            Some("message") if payload.get("role").and_then(Value::as_str) == Some("user") => {
                if let Some(fragments) = parse_visible_hook_prompt_fragments(payload.get("content"))
                {
                    let identity = disk_item_identity(
                        turn_id,
                        "hookPrompt",
                        payload.get("id").and_then(Value::as_str),
                        None,
                        &mut identity_counters,
                    );
                    let item =
                        apply_item_identity(hook_prompt_item(&identity.id, fragments), identity);
                    table.upsert_item(item);
                    continue;
                }
                if is_contextual_user_message_content(payload.get("content")) {
                    continue;
                }
                let identity = disk_item_identity(
                    turn_id,
                    "userMessage",
                    payload.get("id").and_then(Value::as_str),
                    None,
                    &mut identity_counters,
                );
                let item = apply_item_identity(
                    json!({
                        "content": normalize_user_content(payload.get("content")),
                        "id": identity.id,
                        "type": "userMessage",
                    }),
                    identity,
                );
                table.upsert_message(user_message_key(&item), item);
            }
            Some("message") if payload.get("role").and_then(Value::as_str) == Some("assistant") => {
                let text = message_content_text(payload.get("content"));
                let phase = normalize_phase(payload.get("phase"));
                if !text.trim().is_empty() {
                    let identity = disk_item_identity(
                        turn_id,
                        "agentMessage",
                        payload.get("id").and_then(Value::as_str),
                        None,
                        &mut identity_counters,
                    );
                    let item = apply_item_identity(
                        json!({
                            "id": identity.id,
                            "memoryCitation": null,
                            "phase": phase,
                            "text": text,
                            "type": "agentMessage",
                        }),
                        identity,
                    );
                    table.upsert_message(agent_message_key(&item), item);
                }
            }
            Some("function_call") => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let kind = if name == "exec_command" {
                    "commandExecution"
                } else {
                    "dynamicToolCall"
                };
                let identity = disk_item_identity(
                    turn_id,
                    kind,
                    payload.get("id").and_then(Value::as_str),
                    payload.get("call_id").and_then(Value::as_str),
                    &mut identity_counters,
                );
                let item = apply_item_identity(function_call_item(payload, &identity.id), identity);
                table.upsert_call_item(payload.get("call_id").and_then(Value::as_str), item);
            }
            Some("function_call_output") => {
                if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                    table.complete_call(call_id, payload);
                }
            }
            Some("custom_tool_call") => {
                let identity = disk_item_identity(
                    turn_id,
                    "dynamicToolCall",
                    payload.get("id").and_then(Value::as_str),
                    payload.get("call_id").and_then(Value::as_str),
                    &mut identity_counters,
                );
                let item =
                    apply_item_identity(custom_tool_call_item(payload, &identity.id), identity);
                table.upsert_call_item(payload.get("call_id").and_then(Value::as_str), item);
            }
            Some("custom_tool_call_output") => {
                if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                    table.complete_call(call_id, payload);
                }
            }
            Some("patch_apply_end") => {
                let identity = disk_item_identity(
                    turn_id,
                    "fileChange",
                    payload.get("id").and_then(Value::as_str),
                    payload.get("call_id").and_then(Value::as_str),
                    &mut identity_counters,
                );
                let item = apply_item_identity(file_change_item(payload, &identity.id), identity);
                table.upsert_call_item(payload.get("call_id").and_then(Value::as_str), item);
            }
            Some("mcp_tool_call_end") => {
                let identity = disk_item_identity(
                    turn_id,
                    "mcpToolCall",
                    payload.get("id").and_then(Value::as_str),
                    payload.get("call_id").and_then(Value::as_str),
                    &mut identity_counters,
                );
                let item = apply_item_identity(mcp_tool_call_item(payload, &identity.id), identity);
                table.upsert_call_item(payload.get("call_id").and_then(Value::as_str), item);
            }
            Some("web_search_end") => {
                let identity = disk_item_identity(
                    turn_id,
                    "webSearch",
                    payload.get("id").and_then(Value::as_str),
                    payload.get("call_id").and_then(Value::as_str),
                    &mut identity_counters,
                );
                let item = apply_item_identity(
                    json!({
                        "id": identity.id,
                        "query": payload.get("query").and_then(Value::as_str).unwrap_or(""),
                        "type": "webSearch",
                    }),
                    identity,
                );
                table.upsert_call_item(payload.get("call_id").and_then(Value::as_str), item);
            }
            Some("compaction" | "context_compaction") => {
                let identity = disk_item_identity(
                    turn_id,
                    "contextCompaction",
                    payload.get("id").and_then(Value::as_str),
                    None,
                    &mut identity_counters,
                );
                table.upsert_compaction(apply_item_identity(
                    json!({
                        "id": identity.id,
                        "status": "completed",
                        "type": "contextCompaction",
                    }),
                    identity,
                ));
            }
            Some("context_compacted") => {
                let identity = disk_item_identity(
                    turn_id,
                    "contextCompaction",
                    payload.get("id").and_then(Value::as_str),
                    None,
                    &mut identity_counters,
                );
                table.upsert_compaction(apply_item_identity(
                    json!({
                        "id": identity.id,
                        "status": "completed",
                        "type": "contextCompaction",
                    }),
                    identity,
                ));
            }
            _ => {
                if row.get("type").and_then(Value::as_str) == Some("compacted") {
                    let identity = disk_item_identity(
                        turn_id,
                        "contextCompaction",
                        row.get("id").and_then(Value::as_str),
                        None,
                        &mut identity_counters,
                    );
                    table.upsert_compaction(apply_item_identity(
                        json!({
                            "id": identity.id,
                            "status": "completed",
                            "type": "contextCompaction",
                        }),
                        identity,
                    ));
                }
            }
        }
    }

    turn.started_at = turn.started_at.or(range.started_at);
    turn.completed_at = turn.completed_at.or(range.completed_at);
    turn.duration_ms = turn.duration_ms.or(range.duration_ms);
    turn.status = range.status.clone();
    turn.items = table.into_items();
    turn
}

pub(crate) fn reconcile_raw_turn_items(turn: &mut RawTurn) {
    let mut table = DiskItemTable::default();
    for item in std::mem::take(&mut turn.items) {
        table.upsert_existing_item(item);
    }
    turn.items = table.into_items();
}

pub(crate) fn project_app_server_turn(turn: &Value) -> Option<ProjectedTurn> {
    let id = turn.get("id").and_then(Value::as_str)?.to_string();
    let raw_turn = RawTurn {
        completed_at: turn.get("completedAt").and_then(crate::util::number_as_i64),
        duration_ms: turn.get("durationMs").and_then(crate::util::number_as_i64),
        error: turn.get("error").cloned().filter(|value| !value.is_null()),
        id,
        items: turn
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        started_at: turn.get("startedAt").and_then(crate::util::number_as_i64),
        status: turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("inProgress")
            .to_string(),
    };
    Some(project_raw_turn(raw_turn))
}

#[derive(Clone, Copy)]
enum WorkFlushReason {
    Boundary,
    EndOfTurn,
    FinalAssistantStarted,
}

pub(crate) fn project_raw_turn(turn: RawTurn) -> ProjectedTurn {
    let assistant_answer_ids = final_assistant_answer_ids(&turn.items);
    let compaction_statuses = compaction_statuses_for_turn(&turn);
    let mut segments = Vec::new();
    let mut details_by_segment_id = HashMap::new();
    let mut work_items_by_id = HashMap::new();
    let mut saw_primary_user_message = false;
    let mut pending_work: Vec<Value> = Vec::new();
    let mut pending_work_start_index: Option<usize> = None;

    fn flush_work(
        turn: &RawTurn,
        pending_work: &mut Vec<Value>,
        pending_work_start_index: &mut Option<usize>,
        segments: &mut Vec<Value>,
        details_by_segment_id: &mut HashMap<String, Value>,
        work_items_by_id: &mut HashMap<String, Value>,
        compaction_statuses: &HashMap<String, String>,
        reason: WorkFlushReason,
    ) {
        if pending_work.is_empty() {
            return;
        }
        let id = stable_work_segment_id(&turn.id, pending_work, *pending_work_start_index);
        let state = work_state(turn, pending_work, reason);
        let item_ids = work_item_ids(pending_work);
        let revision =
            stable_revision_value(&json!(["work", id, state, turn.duration_ms, item_ids,]));
        segments.push(json!({
            "durationMs": turn.duration_ms,
            "hasDetails": true,
            "id": id,
            "revision": revision,
            "state": state,
            "type": "work",
        }));
        let entries = build_work_entries(pending_work);
        let details_revision = stable_revision_value(&json!(["details", id, entries]));
        details_by_segment_id.insert(
            id.clone(),
            json!({
                "entries": entries,
                "itemIds": item_ids,
                "revision": details_revision,
                "segmentId": id,
            }),
        );
        for item in pending_work.iter() {
            let Some(item_id) = item_id(item) else {
                continue;
            };
            let Some(work_item) = build_work_item(item, compaction_statuses, &turn.status) else {
                continue;
            };
            let revision = stable_revision_value(&work_item);
            let resource = json!({
                "item": work_item,
                "itemId": item_id,
                "revision": revision,
            });
            work_items_by_id.insert(item_id.to_string(), resource.clone());
            for alias in source_aliases(item) {
                let Some(alias_id) = canonical_for_source_alias(&turn.id, &alias) else {
                    continue;
                };
                work_items_by_id.entry(alias_id).or_insert(resource.clone());
            }
        }
        pending_work.clear();
        *pending_work_start_index = None;
    }

    for (item_index, item) in turn.items.iter().enumerate() {
        match item_type(item) {
            Some("userMessage") => {
                if !saw_primary_user_message {
                    saw_primary_user_message = true;
                    flush_work(
                        &turn,
                        &mut pending_work,
                        &mut pending_work_start_index,
                        &mut segments,
                        &mut details_by_segment_id,
                        &mut work_items_by_id,
                        &compaction_statuses,
                        WorkFlushReason::Boundary,
                    );
                    segments.push(user_segment(item));
                } else if !pending_work.is_empty()
                    || has_upcoming_work_item(&turn.items, item, &assistant_answer_ids)
                {
                    if pending_work.is_empty() {
                        pending_work_start_index = Some(item_index);
                    }
                    pending_work.push(item.clone());
                } else {
                    flush_work(
                        &turn,
                        &mut pending_work,
                        &mut pending_work_start_index,
                        &mut segments,
                        &mut details_by_segment_id,
                        &mut work_items_by_id,
                        &compaction_statuses,
                        WorkFlushReason::Boundary,
                    );
                    segments.push(user_segment(item));
                }
            }
            Some("contextCompaction") => {
                if !pending_work.is_empty()
                    || has_upcoming_work_item(&turn.items, item, &assistant_answer_ids)
                {
                    if pending_work.is_empty() {
                        pending_work_start_index = Some(item_index);
                    }
                    pending_work.push(item.clone());
                } else {
                    flush_work(
                        &turn,
                        &mut pending_work,
                        &mut pending_work_start_index,
                        &mut segments,
                        &mut details_by_segment_id,
                        &mut work_items_by_id,
                        &compaction_statuses,
                        WorkFlushReason::Boundary,
                    );
                    push_compaction_segment(
                        &mut segments,
                        compaction_segment(item, &turn, &compaction_statuses),
                    );
                }
            }
            Some("agentMessage")
                if item_id(item).is_some_and(|id| assistant_answer_ids.contains(id)) =>
            {
                flush_work(
                    &turn,
                    &mut pending_work,
                    &mut pending_work_start_index,
                    &mut segments,
                    &mut details_by_segment_id,
                    &mut work_items_by_id,
                    &compaction_statuses,
                    WorkFlushReason::FinalAssistantStarted,
                );
                let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                if !text.trim().is_empty() {
                    segments.push(assistant_segment(item));
                }
            }
            Some("reasoning") => {}
            _ => {
                if pending_work.is_empty() {
                    pending_work_start_index = Some(item_index);
                }
                pending_work.push(item.clone());
            }
        }
    }
    flush_work(
        &turn,
        &mut pending_work,
        &mut pending_work_start_index,
        &mut segments,
        &mut details_by_segment_id,
        &mut work_items_by_id,
        &compaction_statuses,
        WorkFlushReason::EndOfTurn,
    );

    let revision = stable_revision_value(&json!([
        "turn",
        turn.id,
        turn.status,
        turn.started_at,
        turn.completed_at,
        turn.duration_ms,
        segments,
    ]));
    let projected = json!({
        "completedAt": turn.completed_at,
        "durationMs": turn.duration_ms,
        "error": turn.error,
        "id": turn.id,
        "revision": revision,
        "segments": segments,
        "startedAt": turn.started_at,
        "status": turn.status,
    });

    ProjectedTurn {
        details_by_segment_id,
        raw_turn: turn,
        turn: projected,
        work_items_by_id,
    }
}

pub(super) fn item_type(item: &Value) -> Option<&str> {
    item.get("type").and_then(Value::as_str)
}

pub(super) fn item_id(item: &Value) -> Option<&str> {
    item.get("id").and_then(Value::as_str)
}

fn apply_item_identity(mut item: Value, identity: DiskItemIdentity) -> Value {
    if !identity.aliases.is_empty() {
        item[IDENTITY_ALIASES_FIELD] = Value::Array(
            identity
                .aliases
                .into_iter()
                .map(Value::String)
                .collect::<Vec<_>>(),
        );
    }
    item
}

pub(super) fn is_final_answer(item: &Value) -> bool {
    matches!(
        item.get("phase").and_then(Value::as_str),
        Some("final_answer") | None
    ) || item.get("phase").is_some_and(Value::is_null)
}

pub(super) fn compaction_status(turn_status: &str) -> String {
    match turn_status {
        "inProgress" => "compacting".to_string(),
        "interrupted" | "failed" => "cancelled".to_string(),
        _ => "compacted".to_string(),
    }
}

pub(super) fn merge_compaction_status(left: &str, right: &str) -> &'static str {
    if left == "compacting" || right == "compacting" {
        "compacting"
    } else if left == "cancelled" || right == "cancelled" {
        "cancelled"
    } else {
        "compacted"
    }
}

pub(super) fn normalize_phase(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn message_content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("input_text").and_then(Value::as_str))
                    .unwrap_or("")
            })
            .collect::<Vec<_>>()
            .join(""),
        Some(other) => value_to_text(other),
        None => String::new(),
    }
}

pub(super) fn file_kind(value: Option<&Value>) -> &'static str {
    match value
        .and_then(|kind| kind.get("type"))
        .and_then(Value::as_str)
    {
        Some("add") => "added",
        Some("delete") => "deleted",
        Some("update") if value.and_then(|kind| kind.get("move_path")).is_some() => "moved",
        _ => "edited",
    }
}

pub(super) fn compact_json(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Null) | None => None,
        Some(value) => Some(crate::util::truncate_text(
            &serde_json::to_string(value).unwrap_or_default(),
            MAX_TOOL_RESULT_CHARS,
        )),
    }
}

pub(super) fn output_text(value: Option<&Value>) -> Option<String> {
    let array = value?.as_array()?;
    let text = array
        .iter()
        .map(|item| item.get("text").and_then(Value::as_str).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("");
    if text.is_empty() {
        None
    } else {
        Some(crate::util::truncate_text(&text, MAX_TOOL_RESULT_CHARS))
    }
}

pub(super) fn first_index(items: &[Value], target: &str) -> usize {
    items
        .iter()
        .position(|item| item_type(item) == Some(target))
        .unwrap_or(usize::MAX)
}

pub(super) fn first_index_any(items: &[Value], targets: &[&str]) -> usize {
    items
        .iter()
        .position(|item| item_type(item).is_some_and(|kind| targets.contains(&kind)))
        .unwrap_or(usize::MAX)
}

fn final_assistant_answer_ids(items: &[Value]) -> HashSet<String> {
    let mut last_work_item_index: isize = -1;
    for (index, item) in items.iter().enumerate() {
        match item_type(item) {
            Some("userMessage") | Some("contextCompaction") => {}
            Some("agentMessage") if is_final_answer(item) => {}
            Some("reasoning") => {}
            _ => last_work_item_index = index as isize,
        }
    }

    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            if item_type(item) == Some("agentMessage")
                && is_final_answer(item)
                && (index as isize) > last_work_item_index
            {
                item_id(item).map(str::to_string)
            } else {
                None
            }
        })
        .collect()
}

fn has_upcoming_work_item(
    items: &[Value],
    current_item: &Value,
    assistant_answer_ids: &HashSet<String>,
) -> bool {
    let Some(start) = items
        .iter()
        .position(|item| std::ptr::eq(item, current_item))
    else {
        return false;
    };
    for item in &items[start + 1..] {
        match item_type(item) {
            Some("userMessage") => return false,
            Some("agentMessage")
                if item_id(item).is_some_and(|id| assistant_answer_ids.contains(id)) =>
            {
                return false;
            }
            Some("reasoning") => {}
            Some("contextCompaction") => {}
            _ => return true,
        }
    }
    false
}

fn compaction_statuses_for_turn(turn: &RawTurn) -> HashMap<String, String> {
    let mut statuses = HashMap::new();
    for (index, item) in turn.items.iter().enumerate() {
        if item_type(item) != Some("contextCompaction") {
            continue;
        }
        if let Some(id) = item_id(item) {
            let status = compaction_item_status(turn, item, index);
            statuses.insert(id.to_string(), status);
        }
    }
    statuses
}

fn compaction_item_status(turn: &RawTurn, item: &Value, index: usize) -> String {
    let has_later_material = has_later_material_item(&turn.items, index);
    match item.get("status").and_then(Value::as_str) {
        Some("completed" | "compacted") => "compacted".to_string(),
        Some("failed" | "interrupted" | "cancelled") => "cancelled".to_string(),
        Some("inProgress" | "running" | "compacting")
            if turn.status == "inProgress" && !has_later_material =>
        {
            "compacting".to_string()
        }
        _ if has_later_material => "compacted".to_string(),
        _ => compaction_status(&turn.status),
    }
}

fn has_later_material_item(items: &[Value], start_index: usize) -> bool {
    for item in &items[start_index + 1..] {
        if matches!(
            item_type(item),
            Some("reasoning") | Some("remuxWorkSummary")
        ) {
            continue;
        }
        return true;
    }
    false
}

fn stable_work_segment_id(turn_id: &str, items: &[Value], first_index: Option<usize>) -> String {
    let first = items
        .first()
        .and_then(item_id)
        .map(str::to_string)
        .unwrap_or_else(|| format!("index:{}", first_index.unwrap_or(0)));
    format!("{turn_id}:work:{first}")
}

fn work_item_ids(items: &[Value]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for id in items.iter().filter_map(item_id) {
        if seen.insert(id.to_string()) {
            ids.push(id.to_string());
        }
    }
    ids
}

fn work_state(turn: &RawTurn, items: &[Value], reason: WorkFlushReason) -> &'static str {
    if turn.status == "interrupted" {
        return "interrupted";
    }
    if turn.status == "failed" {
        return "failed";
    }
    if items
        .iter()
        .any(|item| item.get("status").and_then(Value::as_str) == Some("inProgress"))
    {
        return "running";
    }
    if turn.status == "inProgress" && matches!(reason, WorkFlushReason::EndOfTurn) {
        return "running";
    }
    "completed"
}
