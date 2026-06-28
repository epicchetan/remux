use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::item_identity::{
    DiskItemIdentity, IDENTITY_ALIASES_FIELD, ItemIdentityState, ItemRekey, LegacyItemCounters,
    canonical_for_source_alias, disk_item_identity, inferred_item_kind_for_method, source_aliases,
};
use crate::projection::{
    ProjectedTurn, RawTurn, is_contextual_user_message_content,
    parse_visible_hook_prompt_fragments, project_app_server_turn, project_raw_turn,
    reconcile_raw_turn_items,
};
use crate::util::{number_as_i64, stable_revision_value};

#[derive(Clone, Debug, Default)]
pub(crate) struct LiveTranscriptStore {
    inner: Arc<Mutex<LiveTranscriptInner>>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct LiveNotificationEffect {
    pub(crate) canonical_item_id: Option<String>,
    pub(crate) rekeyed_item_ids: Vec<String>,
}

#[derive(Debug, Default)]
struct LiveTranscriptInner {
    identity: ItemIdentityState,
    threads: HashMap<String, LiveThread>,
}

#[derive(Debug, Default)]
struct LiveThread {
    turn_order: Vec<String>,
    turns: HashMap<String, LiveTurn>,
}

#[derive(Debug, Clone)]
struct LiveTurn {
    deltas: HashMap<String, LiveItemDelta>,
    turn: Value,
}

#[derive(Debug, Clone, Default)]
struct LiveItemDelta {
    indexed_fields: HashMap<String, HashMap<usize, String>>,
    item_type: String,
    replace_fields: HashMap<String, Value>,
    string_fields: HashMap<String, String>,
}

impl LiveTranscriptStore {
    pub(crate) fn record_turn(&self, thread_id: &str, turn: &Value) {
        let Some(turn_id) = turn.get("id").and_then(Value::as_str).map(str::to_string) else {
            return;
        };

        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        let mut turn = turn.clone();
        canonicalize_turn_items(&mut inner.identity, thread_id, &turn_id, &mut turn);
        let thread = inner.threads.entry(thread_id.to_string()).or_default();
        if !thread.turn_order.iter().any(|id| id == &turn_id) {
            thread.turn_order.push(turn_id.clone());
        }
        let is_full = turn.get("itemsView").and_then(Value::as_str) == Some("full");
        let live_turn = thread
            .turns
            .entry(turn_id.clone())
            .or_insert_with(|| LiveTurn::partial(&turn_id));
        if is_full {
            live_turn.turn = turn;
        } else {
            merge_turn_metadata(&mut live_turn.turn, &turn);
            if !live_turn.turn.get("items").is_some_and(Value::is_array) {
                live_turn.turn["items"] = json!([]);
            }
            let target_items_empty = live_turn
                .turn
                .get("items")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty);
            if target_items_empty {
                if let Some(items) = turn.get("items").filter(|items| items.is_array()) {
                    live_turn.turn["items"] = items.clone();
                }
            }
        }
    }

    pub(crate) fn remove_turn(&self, thread_id: &str, turn_id: &str) {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        let Some(thread) = inner.threads.get_mut(thread_id) else {
            return;
        };

        thread.turn_order.retain(|id| id != turn_id);
        thread.turns.remove(turn_id);
        inner.identity.remove_turn(thread_id, turn_id);
    }

    pub(crate) fn record_notification(&self, notification: &Value) -> LiveNotificationEffect {
        let Some(method) = notification.get("method").and_then(Value::as_str) else {
            return LiveNotificationEffect::default();
        };
        let Some(params) = notification.get("params") else {
            return LiveNotificationEffect::default();
        };
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str).or_else(|| {
            params
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
        }) else {
            return LiveNotificationEffect::default();
        };

        if let Some(turn) = params.get("turn") {
            self.record_turn(thread_id, turn);
            return LiveNotificationEffect::default();
        }

        let Some(turn_id) = params.get("turnId").and_then(Value::as_str).or_else(|| {
            params
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
        }) else {
            return LiveNotificationEffect::default();
        };

        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return LiveNotificationEffect::default(),
        };
        if method == "rawResponseItem/completed" {
            return record_raw_response_item_completed(&mut inner, thread_id, turn_id, params);
        }

        let mut canonical_item = None;
        let canonical_item_id = match method {
            "item/started" | "item/completed" => {
                params.get("item").cloned().and_then(|mut item| {
                    normalize_live_item_kind(&mut item);
                    let canonical = inner
                        .identity
                        .canonicalize_live_item(thread_id, turn_id, &mut item)?;
                    mark_live_item_status(method, &mut item);
                    canonical_item = Some(item);
                    Some(canonical)
                })
            }
            _ => params
                .get("itemId")
                .and_then(Value::as_str)
                .zip(inferred_item_kind_for_method(method))
                .map(|(item_id, item_kind)| {
                    inner
                        .identity
                        .resolve_live_delta_id(thread_id, turn_id, item_kind, item_id)
                }),
        };
        let thread = inner.threads.entry(thread_id.to_string()).or_default();
        let live_turn = ensure_live_turn(thread, turn_id);

        match method {
            "item/started" | "item/completed" => {
                if let Some(item) = canonical_item {
                    upsert_turn_item(&mut live_turn.turn, item);
                }
            }
            "item/agentMessage/delta" => {
                if let Some(item_id) = canonical_item_id.as_deref() {
                    append_item_string_delta(live_turn, params, item_id, "agentMessage", "text");
                }
            }
            "item/plan/delta" => {
                if let Some(item_id) = canonical_item_id.as_deref() {
                    append_item_string_delta(live_turn, params, item_id, "plan", "text");
                }
            }
            "item/commandExecution/outputDelta" => {
                if let Some(item_id) = canonical_item_id.as_deref() {
                    append_item_string_delta(
                        live_turn,
                        params,
                        item_id,
                        "commandExecution",
                        "aggregatedOutput",
                    );
                }
            }
            "item/fileChange/outputDelta" => {
                if let Some(item_id) = canonical_item_id.as_deref() {
                    append_item_string_delta(live_turn, params, item_id, "fileChange", "output");
                }
            }
            "item/fileChange/patchUpdated" => {
                if let (Some(item_id), Some(changes)) =
                    (canonical_item_id.as_deref(), params.get("changes").cloned())
                {
                    {
                        let item = ensure_turn_item(&mut live_turn.turn, item_id, "fileChange");
                        item["changes"] = changes.clone();
                    }
                    replace_item_field(live_turn, item_id, "fileChange", "changes", changes);
                }
            }
            "item/reasoning/summaryPartAdded" => {
                if let (Some(item_id), Some(summary_index)) = (
                    canonical_item_id.as_deref(),
                    params.get("summaryIndex").and_then(Value::as_u64),
                ) {
                    let item = ensure_turn_item(&mut live_turn.turn, item_id, "reasoning");
                    ensure_indexed_string(item, "summary", summary_index as usize);
                }
            }
            "item/reasoning/summaryTextDelta" => {
                if let Some(item_id) = canonical_item_id.as_deref() {
                    append_indexed_string_delta(
                        live_turn,
                        params,
                        item_id,
                        "summary",
                        "summaryIndex",
                    );
                }
            }
            "item/reasoning/textDelta" => {
                if let Some(item_id) = canonical_item_id.as_deref() {
                    append_indexed_string_delta(
                        live_turn,
                        params,
                        item_id,
                        "content",
                        "contentIndex",
                    );
                }
            }
            _ => {}
        }
        LiveNotificationEffect {
            canonical_item_id,
            rekeyed_item_ids: Vec::new(),
        }
    }

    pub(crate) fn overlay_turn_order(
        &self,
        thread_id: &str,
        disk_turn_order: &[String],
    ) -> Vec<String> {
        let inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return disk_turn_order.to_vec(),
        };
        let Some(thread) = inner.threads.get(thread_id) else {
            return disk_turn_order.to_vec();
        };

        let mut turn_order = disk_turn_order.to_vec();
        for turn_id in &thread.turn_order {
            if !turn_order.iter().any(|id| id == turn_id) {
                let Some(turn) = thread.turns.get(turn_id) else {
                    continue;
                };
                if live_turn_is_visible(turn) {
                    turn_order.push(turn_id.clone());
                }
            }
        }
        turn_order
    }

    pub(crate) fn projected_turn(&self, thread_id: &str, turn_id: &str) -> Option<ProjectedTurn> {
        self.inner.lock().ok().and_then(|inner| {
            let turn = inner.threads.get(thread_id)?.turns.get(turn_id)?;
            if live_turn_is_visible(turn) {
                project_app_server_turn(&turn.turn)
            } else {
                None
            }
        })
    }

    pub(crate) fn resolve_item_id(&self, thread_id: &str, turn_id: &str, item_id: &str) -> String {
        self.inner
            .lock()
            .ok()
            .map(|mut inner| {
                inner
                    .identity
                    .resolve_existing_item_id(thread_id, turn_id, item_id)
            })
            .unwrap_or_else(|| item_id.to_string())
    }

    pub(crate) fn apply_disk_identity(&self, thread_id: &str, raw_turn: &mut RawTurn) {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        record_raw_turn_aliases(&mut inner, thread_id, raw_turn);
        canonicalize_raw_turn_item_ids(&mut inner.identity, thread_id, raw_turn);
        reconcile_raw_turn_items(raw_turn);
        record_raw_turn_aliases(&mut inner, thread_id, raw_turn);
    }

    pub(crate) fn apply_overlay(&self, thread_id: &str, projected: ProjectedTurn) -> ProjectedTurn {
        let turn_id = projected.raw_turn.id.clone();
        let live_turn = {
            let mut inner = match self.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return projected,
            };
            let Some(thread) = inner.threads.get_mut(thread_id) else {
                return projected;
            };
            if projected.raw_turn.status != "inProgress" {
                thread.turn_order.retain(|id| id != &turn_id);
                thread.turns.remove(&turn_id);
                return projected;
            }
            thread.turns.get(&turn_id).cloned()
        };

        let Some(live_turn) = live_turn else {
            return projected;
        };
        let mut raw_turn = projected.raw_turn.clone();
        merge_live_turn_into_raw(&mut raw_turn, &live_turn);
        reconcile_raw_turn_items(&mut raw_turn);
        if let Ok(mut inner) = self.inner.lock() {
            record_raw_turn_aliases(&mut inner, thread_id, &raw_turn);
        }
        project_raw_turn(raw_turn)
    }

    pub(crate) fn revision_for_thread(
        &self,
        thread_id: &str,
        _disk_turn_order: &[String],
    ) -> Option<String> {
        let inner = self.inner.lock().ok()?;
        let thread = inner.threads.get(thread_id)?;
        let live_turns = thread
            .turn_order
            .iter()
            .filter_map(|turn_id| {
                let turn = thread.turns.get(turn_id)?;
                if _disk_turn_order.iter().any(|disk_id| disk_id == turn_id) {
                    Some(live_revision_value(turn_id, turn))
                } else if live_turn_is_visible(turn) {
                    project_app_server_turn(&turn.turn).map(|turn| turn.turn)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        if live_turns.is_empty() {
            return None;
        }

        Some(stable_revision_value(&json!(live_turns)))
    }
}

fn record_raw_turn_aliases(inner: &mut LiveTranscriptInner, thread_id: &str, raw_turn: &RawTurn) {
    let mut rekeys = Vec::new();
    for item in &raw_turn.items {
        let Some(item_id) = item_id(item) else {
            continue;
        };
        let aliases = source_aliases(item);
        rekeys.extend(inner.identity.register_disk_item_aliases(
            thread_id,
            &raw_turn.id,
            item_id,
            &aliases,
        ));
    }
    if let Some(thread) = inner.threads.get_mut(thread_id) {
        apply_rekeys_to_live_thread(thread, &raw_turn.id, &rekeys);
    }
}

fn canonicalize_raw_turn_item_ids(
    identity: &mut ItemIdentityState,
    thread_id: &str,
    raw_turn: &mut RawTurn,
) {
    let turn_id = raw_turn.id.clone();
    for item in &mut raw_turn.items {
        let Some(item_id) = item_id(item).map(str::to_string) else {
            continue;
        };
        let resolved_item_id = identity.resolve_existing_item_id(thread_id, &turn_id, &item_id);
        if resolved_item_id == item_id {
            continue;
        }
        add_identity_alias(item, canonical_identity_alias(&item_id));
        item["id"] = Value::String(resolved_item_id);
    }
}

impl LiveTurn {
    fn partial(turn_id: &str) -> Self {
        Self {
            deltas: HashMap::new(),
            turn: json!({
                "completedAt": null,
                "durationMs": null,
                "error": null,
                "id": turn_id,
                "items": [],
                "itemsView": "full",
                "startedAt": null,
                "status": "inProgress",
            }),
        }
    }
}

fn ensure_live_turn<'a>(thread: &'a mut LiveThread, turn_id: &str) -> &'a mut LiveTurn {
    if !thread.turn_order.iter().any(|id| id == turn_id) {
        thread.turn_order.push(turn_id.to_string());
    }
    thread
        .turns
        .entry(turn_id.to_string())
        .or_insert_with(|| LiveTurn::partial(turn_id))
}

fn live_turn_is_visible(turn: &LiveTurn) -> bool {
    if !turn.deltas.is_empty() {
        return true;
    }

    if turn
        .turn
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
    {
        return true;
    }

    turn.turn.get("error").is_some_and(|error| !error.is_null())
}

fn canonicalize_turn_items(
    identity: &mut ItemIdentityState,
    thread_id: &str,
    turn_id: &str,
    turn: &mut Value,
) {
    let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
        return;
    };
    for item in items {
        let _ = identity.canonicalize_live_item(thread_id, turn_id, item);
    }
}

fn record_raw_response_item_completed(
    inner: &mut LiveTranscriptInner,
    thread_id: &str,
    turn_id: &str,
    params: &Value,
) -> LiveNotificationEffect {
    let Some(identity) = params
        .get("item")
        .and_then(|item| raw_response_item_identity(turn_id, item))
    else {
        return LiveNotificationEffect::default();
    };
    let rekeys = inner.identity.register_disk_item_aliases(
        thread_id,
        turn_id,
        &identity.id,
        &identity.aliases,
    );
    if let Some(thread) = inner.threads.get_mut(thread_id) {
        apply_rekeys_to_live_thread(thread, turn_id, &rekeys);
    }
    LiveNotificationEffect {
        canonical_item_id: Some(identity.id),
        rekeyed_item_ids: rekey_targets(&rekeys),
    }
}

fn raw_response_item_identity(turn_id: &str, item: &Value) -> Option<DiskItemIdentity> {
    let kind = raw_response_item_kind(item)?;
    let durable_item_id = item.get("id").and_then(Value::as_str);
    let call_id = item.get("call_id").and_then(Value::as_str);
    if durable_item_id.is_none_or(|id| id.trim().is_empty())
        && call_id.is_none_or(|id| id.trim().is_empty())
    {
        return None;
    }
    let mut counters = LegacyItemCounters::default();
    Some(disk_item_identity(
        turn_id,
        kind,
        durable_item_id,
        call_id,
        &mut counters,
    ))
}

fn raw_response_item_kind(item: &Value) -> Option<&'static str> {
    match item.get("type").and_then(Value::as_str)? {
        "message" if item.get("role").and_then(Value::as_str) == Some("user") => match (
            parse_visible_hook_prompt_fragments(item.get("content")).is_some(),
            is_contextual_user_message_content(item.get("content")),
        ) {
            (true, _) => Some("hookPrompt"),
            (_, true) => None,
            _ => Some("userMessage"),
        },
        "message" if item.get("role").and_then(Value::as_str) == Some("assistant") => {
            Some("agentMessage")
        }
        "reasoning" => Some("reasoning"),
        "local_shell_call" => Some("commandExecution"),
        "function_call" if item.get("name").and_then(Value::as_str) == Some("exec_command") => {
            Some("commandExecution")
        }
        "function_call" | "custom_tool_call" | "tool_search_call" => Some("dynamicToolCall"),
        "web_search_call" => Some("webSearch"),
        "image_generation_call" => Some("imageGeneration"),
        "compaction" | "context_compaction" => Some("contextCompaction"),
        _ => None,
    }
}

fn mark_live_item_status(method: &str, item: &mut Value) {
    if item.get("type").and_then(Value::as_str) != Some("contextCompaction") {
        return;
    }
    item["status"] = Value::String(
        if method == "item/completed" {
            "completed"
        } else {
            "inProgress"
        }
        .to_string(),
    );
}

fn normalize_live_item_kind(item: &mut Value) {
    if matches!(
        item.get("type").and_then(Value::as_str),
        Some("compaction" | "context_compaction")
    ) {
        item["type"] = Value::String("contextCompaction".to_string());
    }
}

fn apply_rekeys_to_live_thread(thread: &mut LiveThread, turn_id: &str, rekeys: &[ItemRekey]) {
    if rekeys.is_empty() {
        return;
    }
    let Some(live_turn) = thread.turns.get_mut(turn_id) else {
        return;
    };
    for rekey in rekeys {
        rekey_live_turn(live_turn, &rekey.from, &rekey.to);
    }
}

fn rekey_live_turn(live_turn: &mut LiveTurn, from: &str, to: &str) {
    if from == to {
        return;
    }
    if let Some(delta) = live_turn.deltas.remove(from) {
        let target = live_turn.deltas.entry(to.to_string()).or_default();
        merge_live_delta(target, delta);
    }
    rekey_live_turn_items(live_turn, from, to);
}

fn merge_live_delta(target: &mut LiveItemDelta, source: LiveItemDelta) {
    if (target.item_type.is_empty() || target.item_type == "unknown")
        && !source.item_type.is_empty()
    {
        target.item_type = source.item_type;
    }
    for (field, source_text) in source.string_fields {
        let target_text = target.string_fields.entry(field).or_default();
        let existing = target_text.clone();
        *target_text = merge_streamed_text(&source_text, &existing);
    }
    for (field, source_values) in source.indexed_fields {
        let target_values = target.indexed_fields.entry(field).or_default();
        for (index, source_text) in source_values {
            let target_text = target_values.entry(index).or_default();
            let existing = target_text.clone();
            *target_text = merge_streamed_text(&source_text, &existing);
        }
    }
    for (field, value) in source.replace_fields {
        target.replace_fields.entry(field).or_insert(value);
    }
}

fn rekey_live_turn_items(live_turn: &mut LiveTurn, from: &str, to: &str) {
    let Some(items) = live_turn
        .turn
        .get_mut("items")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    let from_index = items
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(from));
    let to_index = items
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(to));
    match (from_index, to_index) {
        (Some(from_index), Some(to_index)) if from_index != to_index => {
            let source = items.remove(from_index);
            let target_index = if from_index < to_index {
                to_index.saturating_sub(1)
            } else {
                to_index
            };
            if let Some(target) = items.get_mut(target_index) {
                merge_rekeyed_item_snapshot(target, &source);
            }
        }
        (Some(from_index), _) => {
            items[from_index]["id"] = Value::String(to.to_string());
        }
        _ => {}
    }
}

fn merge_rekeyed_item_snapshot(target: &mut Value, source: &Value) {
    let Some(source_object) = source.as_object() else {
        return;
    };
    if !target.is_object() {
        *target = json!({});
    }
    for (field, value) in source_object {
        if field == "id" || is_placeholder_value(value) {
            continue;
        }
        match (target.get(field).and_then(Value::as_str), value.as_str()) {
            (Some(existing), Some(incoming)) => {
                target[field] = Value::String(merge_streamed_text(incoming, existing));
            }
            _ if target.get(field).is_none_or(is_placeholder_value) => {
                target[field] = value.clone();
            }
            _ => {}
        }
    }
}

fn rekey_targets(rekeys: &[ItemRekey]) -> Vec<String> {
    let mut targets = Vec::new();
    for rekey in rekeys {
        if !targets.iter().any(|target| target == &rekey.to) {
            targets.push(rekey.to.clone());
        }
    }
    targets
}

fn upsert_turn_item(turn: &mut Value, item: Value) {
    let Some(item_id) = item.get("id").and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    let items = ensure_items(turn);
    if let Some(existing) = items
        .iter_mut()
        .find(|existing| existing.get("id").and_then(Value::as_str) == Some(item_id.as_str()))
    {
        *existing = item;
    } else {
        items.push(item);
    }
}

fn append_item_string_delta(
    live_turn: &mut LiveTurn,
    params: &Value,
    item_id: &str,
    item_type: &str,
    field: &str,
) {
    let Some(delta) = params.get("delta").and_then(Value::as_str) else {
        return;
    };
    let item = ensure_turn_item(&mut live_turn.turn, item_id, item_type);
    append_string_field(item, field, delta);
    append_delta_string_field(live_turn, item_id, item_type, field, delta);
}

fn append_indexed_string_delta(
    live_turn: &mut LiveTurn,
    params: &Value,
    item_id: &str,
    field: &str,
    index_field: &str,
) {
    let Some(delta) = params.get("delta").and_then(Value::as_str) else {
        return;
    };
    let Some(index) = params.get(index_field).and_then(Value::as_u64) else {
        return;
    };
    let item = ensure_turn_item(&mut live_turn.turn, item_id, "reasoning");
    append_indexed_string_field(item, field, index as usize, delta);
    append_delta_indexed_string_field(
        live_turn,
        item_id,
        "reasoning",
        field,
        index as usize,
        delta,
    );
}

fn ensure_turn_item<'a>(turn: &'a mut Value, item_id: &str, item_type: &str) -> &'a mut Value {
    let items = ensure_items(turn);
    let index = items
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(item_id))
        .unwrap_or_else(|| {
            items.push(minimal_item(item_id, item_type));
            items.len() - 1
        });
    &mut items[index]
}

fn ensure_items(turn: &mut Value) -> &mut Vec<Value> {
    if !turn.get("items").is_some_and(Value::is_array) {
        turn["items"] = json!([]);
    }
    turn.get_mut("items")
        .and_then(Value::as_array_mut)
        .expect("items should be an array")
}

fn append_string_field(item: &mut Value, field: &str, delta: &str) {
    let mut text = item
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    text.push_str(delta);
    item[field] = Value::String(text);
}

fn append_indexed_string_field(item: &mut Value, field: &str, index: usize, delta: &str) {
    let entry = ensure_indexed_string(item, field, index);
    let mut text = entry.as_str().unwrap_or("").to_string();
    text.push_str(delta);
    *entry = Value::String(text);
}

fn ensure_indexed_string<'a>(item: &'a mut Value, field: &str, index: usize) -> &'a mut Value {
    if !item.get(field).is_some_and(Value::is_array) {
        item[field] = json!([]);
    }
    let values = item
        .get_mut(field)
        .and_then(Value::as_array_mut)
        .expect("field should be an array");
    while values.len() <= index {
        values.push(Value::String(String::new()));
    }
    if !values[index].is_string() {
        values[index] = Value::String(String::new());
    }
    &mut values[index]
}

fn minimal_item(item_id: &str, item_type: &str) -> Value {
    match item_type {
        "agentMessage" => json!({
            "id": item_id,
            "memoryCitation": null,
            "phase": null,
            "text": "",
            "type": "agentMessage",
        }),
        "plan" => json!({
            "id": item_id,
            "text": "",
            "type": "plan",
        }),
        "reasoning" => json!({
            "content": [],
            "id": item_id,
            "summary": [],
            "type": "reasoning",
        }),
        "commandExecution" => json!({
            "aggregatedOutput": "",
            "command": "",
            "commandActions": [],
            "cwd": null,
            "durationMs": null,
            "exitCode": null,
            "id": item_id,
            "processId": null,
            "source": "agent",
            "status": "inProgress",
            "type": "commandExecution",
        }),
        "fileChange" => json!({
            "changes": [],
            "id": item_id,
            "status": "inProgress",
            "type": "fileChange",
        }),
        _ => json!({
            "id": item_id,
            "type": item_type,
        }),
    }
}

fn merge_turn_metadata(target: &mut Value, source: &Value) {
    for field in ["completedAt", "durationMs", "error", "startedAt", "status"] {
        if let Some(value) = source.get(field) {
            target[field] = value.clone();
        }
    }
    if let Some(items_view) = source.get("itemsView") {
        target["itemsView"] = items_view.clone();
    }
}

fn append_delta_string_field(
    live_turn: &mut LiveTurn,
    item_id: &str,
    item_type: &str,
    field: &str,
    delta: &str,
) {
    let entry = live_item_delta_mut(live_turn, item_id, item_type);
    entry
        .string_fields
        .entry(field.to_string())
        .or_default()
        .push_str(delta);
}

fn append_delta_indexed_string_field(
    live_turn: &mut LiveTurn,
    item_id: &str,
    item_type: &str,
    field: &str,
    index: usize,
    delta: &str,
) {
    let entry = live_item_delta_mut(live_turn, item_id, item_type);
    entry
        .indexed_fields
        .entry(field.to_string())
        .or_default()
        .entry(index)
        .or_default()
        .push_str(delta);
}

fn replace_item_field(
    live_turn: &mut LiveTurn,
    item_id: &str,
    item_type: &str,
    field: &str,
    value: Value,
) {
    let entry = live_item_delta_mut(live_turn, item_id, item_type);
    entry.replace_fields.insert(field.to_string(), value);
}

fn live_item_delta_mut<'a>(
    live_turn: &'a mut LiveTurn,
    item_id: &str,
    item_type: &str,
) -> &'a mut LiveItemDelta {
    let entry = live_turn.deltas.entry(item_id.to_string()).or_default();
    if entry.item_type.is_empty() || entry.item_type == "unknown" {
        entry.item_type = item_type.to_string();
    }
    entry
}

fn merge_live_turn_into_raw(raw_turn: &mut RawTurn, live_turn: &LiveTurn) {
    merge_live_metadata_into_raw(raw_turn, &live_turn.turn);

    let mut live_compaction_ordinal = 0;
    for item in live_turn
        .turn
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let compaction_ordinal = if item_type(item) == Some("contextCompaction") {
            let ordinal = live_compaction_ordinal;
            live_compaction_ordinal += 1;
            Some(ordinal)
        } else {
            None
        };
        merge_live_item_snapshot(
            raw_turn,
            item,
            live_turn.deltas.get(item_id(item).unwrap_or("")),
            compaction_ordinal,
        );
    }

    for (item_id, delta) in &live_turn.deltas {
        apply_live_item_delta(raw_turn, item_id, delta);
    }
}

fn merge_live_metadata_into_raw(raw_turn: &mut RawTurn, live_turn: &Value) {
    if let Some(status) = live_turn.get("status").and_then(Value::as_str) {
        raw_turn.status = status.to_string();
    }
    if let Some(started_at) = live_turn.get("startedAt").and_then(number_as_i64) {
        raw_turn.started_at = Some(started_at);
    }
    if let Some(completed_at) = live_turn.get("completedAt").and_then(number_as_i64) {
        raw_turn.completed_at = Some(completed_at);
    }
    if let Some(duration_ms) = live_turn.get("durationMs").and_then(number_as_i64) {
        raw_turn.duration_ms = Some(duration_ms);
    }
    if let Some(error) = live_turn.get("error").filter(|value| !value.is_null()) {
        raw_turn.error = Some(error.clone());
    }
}

fn merge_live_item_snapshot(
    raw_turn: &mut RawTurn,
    live_item: &Value,
    delta: Option<&LiveItemDelta>,
    compaction_ordinal: Option<usize>,
) {
    let Some(live_item_id) = item_id(live_item) else {
        return;
    };
    let live_item_type = item_type(live_item).unwrap_or("unknown");
    if let Some(index) = raw_turn.items.iter().position(|item| {
        item_id(item) == Some(live_item_id)
            || item_has_canonical_alias(raw_turn, item, live_item_id)
    }) {
        merge_item_snapshot_fields(&mut raw_turn.items[index], live_item, delta);
        return;
    }

    if live_item_type == "contextCompaction"
        && merge_live_compaction_by_occurrence(raw_turn, live_item, delta, compaction_ordinal)
    {
        return;
    }

    if live_item_type == "userMessage" && raw_has_item_type(raw_turn, "userMessage") {
        return;
    }

    raw_turn.items.push(live_item.clone());
}

fn merge_live_compaction_by_occurrence(
    raw_turn: &mut RawTurn,
    live_item: &Value,
    delta: Option<&LiveItemDelta>,
    compaction_ordinal: Option<usize>,
) -> bool {
    let Some(ordinal) = compaction_ordinal else {
        return false;
    };
    let Some(live_item_id) = item_id(live_item) else {
        return false;
    };
    if live_item_id.contains(":legacy:") {
        return false;
    }
    let Some(index) = nth_compaction_index(raw_turn, ordinal) else {
        return false;
    };
    let Some(existing_item_id) = item_id(&raw_turn.items[index]).map(str::to_string) else {
        return false;
    };
    if !existing_item_id.contains(":legacy:") {
        return false;
    }

    add_identity_alias(
        &mut raw_turn.items[index],
        canonical_identity_alias(&existing_item_id),
    );
    raw_turn.items[index]["id"] = Value::String(live_item_id.to_string());
    merge_item_snapshot_fields(&mut raw_turn.items[index], live_item, delta);
    true
}

fn nth_compaction_index(raw_turn: &RawTurn, ordinal: usize) -> Option<usize> {
    raw_turn
        .items
        .iter()
        .enumerate()
        .filter(|(_, item)| item_type(item) == Some("contextCompaction"))
        .nth(ordinal)
        .map(|(index, _)| index)
}

fn merge_item_snapshot_fields(
    existing: &mut Value,
    live_item: &Value,
    delta: Option<&LiveItemDelta>,
) {
    let Some(live_object) = live_item.as_object() else {
        *existing = live_item.clone();
        return;
    };
    if !existing.is_object() {
        *existing = json!({});
    }
    let existing_type = item_type(existing).map(str::to_string);

    for (field, value) in live_object {
        if field == "id" {
            continue;
        }
        if field == "status" && existing_type.as_deref() == Some("contextCompaction") {
            existing[field] = merge_compaction_status_value(existing.get(field), value);
            continue;
        }
        if field_has_delta(delta, field) {
            continue;
        }
        if is_placeholder_value(value) && existing.get(field).is_some() {
            continue;
        }
        existing[field] = value.clone();
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

fn field_has_delta(delta: Option<&LiveItemDelta>, field: &str) -> bool {
    delta.is_some_and(|delta| {
        delta.string_fields.contains_key(field)
            || delta.indexed_fields.contains_key(field)
            || delta.replace_fields.contains_key(field)
    })
}

fn is_placeholder_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
        _ => false,
    }
}

fn apply_live_item_delta(raw_turn: &mut RawTurn, item_id: &str, delta: &LiveItemDelta) {
    let item = ensure_raw_item(raw_turn, item_id, &delta.item_type);
    for (field, text_delta) in &delta.string_fields {
        merge_string_field(item, field, text_delta);
    }
    for (field, value) in &delta.replace_fields {
        item[field] = value.clone();
    }
    for (field, indexed_deltas) in &delta.indexed_fields {
        for (index, text_delta) in indexed_deltas {
            merge_indexed_string_field(item, field, *index, text_delta);
        }
    }
}

fn merge_string_field(item: &mut Value, field: &str, delta: &str) {
    let existing = item
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    item[field] = Value::String(merge_streamed_text(&existing, delta));
}

fn merge_indexed_string_field(item: &mut Value, field: &str, index: usize, delta: &str) {
    let entry = ensure_indexed_string(item, field, index);
    let existing = entry.as_str().unwrap_or("").to_string();
    *entry = Value::String(merge_streamed_text(&existing, delta));
}

fn merge_streamed_text(existing: &str, delta: &str) -> String {
    if delta.is_empty() || existing.ends_with(delta) || existing.starts_with(delta) {
        return existing.to_string();
    }
    if existing.is_empty() || delta.starts_with(existing) {
        return delta.to_string();
    }

    let max_overlap = existing.len().min(delta.len());
    for overlap in (1..=max_overlap).rev() {
        if !existing.is_char_boundary(existing.len() - overlap) || !delta.is_char_boundary(overlap)
        {
            continue;
        }
        if existing[existing.len() - overlap..] == delta[..overlap] {
            return format!("{}{}", existing, &delta[overlap..]);
        }
    }
    format!("{existing}{delta}")
}

fn ensure_raw_item<'a>(
    raw_turn: &'a mut RawTurn,
    target_item_id: &str,
    item_type: &str,
) -> &'a mut Value {
    let index = raw_turn
        .items
        .iter()
        .position(|item| {
            item_id(item) == Some(target_item_id)
                || item_has_canonical_alias(raw_turn, item, target_item_id)
        })
        .unwrap_or_else(|| {
            raw_turn.items.push(minimal_item(target_item_id, item_type));
            raw_turn.items.len() - 1
        });
    &mut raw_turn.items[index]
}

fn item_has_canonical_alias(raw_turn: &RawTurn, item: &Value, target_item_id: &str) -> bool {
    source_aliases(item).into_iter().any(|alias| {
        canonical_for_source_alias(&raw_turn.id, &alias).as_deref() == Some(target_item_id)
    })
}

fn item_id(item: &Value) -> Option<&str> {
    item.get("id").and_then(Value::as_str)
}

fn item_type(item: &Value) -> Option<&str> {
    item.get("type").and_then(Value::as_str)
}

fn raw_has_item_type(raw_turn: &RawTurn, target: &str) -> bool {
    raw_turn
        .items
        .iter()
        .any(|item| item_type(item) == Some(target))
}

fn live_revision_value(turn_id: &str, turn: &LiveTurn) -> Value {
    let mut deltas = serde_json::Map::new();
    for (item_id, delta) in &turn.deltas {
        deltas.insert(item_id.clone(), live_delta_value(delta));
    }
    json!({
        "deltas": Value::Object(deltas),
        "turn": turn.turn,
        "turnId": turn_id,
    })
}

fn live_delta_value(delta: &LiveItemDelta) -> Value {
    let mut indexed_fields = serde_json::Map::new();
    for (field, values) in &delta.indexed_fields {
        let mut indexed_values = serde_json::Map::new();
        for (index, value) in values {
            indexed_values.insert(index.to_string(), Value::String(value.clone()));
        }
        indexed_fields.insert(field.clone(), Value::Object(indexed_values));
    }
    json!({
        "indexedFields": Value::Object(indexed_fields),
        "itemType": delta.item_type,
        "replaceFields": delta.replace_fields,
        "stringFields": delta.string_fields,
    })
}
