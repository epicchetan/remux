use std::collections::{HashMap, HashSet};

use serde_json::Value;

const CANONICAL_PREFIX: &str = "cxitem:v1:";
pub(crate) const IDENTITY_ALIASES_FIELD: &str = "_identityAliases";

#[derive(Debug, Clone)]
pub(crate) struct DiskItemIdentity {
    pub(crate) aliases: Vec<String>,
    pub(crate) id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ItemRekey {
    pub(crate) from: String,
    pub(crate) to: String,
}

#[derive(Debug, Default)]
pub(crate) struct ItemIdentityState {
    threads: HashMap<String, ThreadIdentityState>,
}

#[derive(Debug, Default)]
struct ThreadIdentityState {
    turns: HashMap<String, TurnIdentityState>,
}

#[derive(Debug, Default)]
struct TurnIdentityState {
    aliases: HashMap<String, String>,
    canonical_redirects: HashMap<String, String>,
    live_legacy_ordinals: HashMap<String, usize>,
}

#[derive(Debug, Default)]
pub(crate) struct LegacyItemCounters {
    ordinals: HashMap<String, usize>,
}

impl LegacyItemCounters {
    pub(crate) fn next(&mut self, kind: &str) -> usize {
        let ordinal = self.ordinals.entry(kind.to_string()).or_default();
        let current = *ordinal;
        *ordinal += 1;
        current
    }
}

impl ItemIdentityState {
    pub(crate) fn remove_turn(&mut self, thread_id: &str, turn_id: &str) {
        let Some(thread) = self.threads.get_mut(thread_id) else {
            return;
        };
        thread.turns.remove(turn_id);
    }

    pub(crate) fn canonicalize_live_item(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        item: &mut Value,
    ) -> Option<String> {
        let raw_item_id = item.get("id").and_then(Value::as_str)?.to_string();
        let kind = item_kind(item).unwrap_or("unknown");
        let canonical = self.resolve_live_id(thread_id, turn_id, kind, &raw_item_id);
        item["id"] = Value::String(canonical.clone());
        Some(canonical)
    }

    pub(crate) fn resolve_live_delta_id(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        kind: &str,
        raw_item_id: &str,
    ) -> String {
        self.resolve_live_id(thread_id, turn_id, kind, raw_item_id)
    }

    fn resolve_live_id(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        kind: &str,
        raw_item_id: &str,
    ) -> String {
        let turn = self
            .threads
            .entry(thread_id.to_string())
            .or_default()
            .turns
            .entry(turn_id.to_string())
            .or_default();
        if is_canonical_item_id(raw_item_id) {
            return follow_redirects(turn, raw_item_id);
        }
        if let Some(canonical) = turn.aliases.get(&app_alias(raw_item_id)) {
            return follow_redirects(turn, canonical);
        }
        if let Some(canonical) = turn.aliases.get(&call_alias(raw_item_id)) {
            return follow_redirects(turn, canonical);
        }
        if let Some(canonical) = turn.aliases.get(&durable_alias(raw_item_id)) {
            return follow_redirects(turn, canonical);
        }

        let canonical = if is_app_server_synthetic_id(raw_item_id) {
            let ordinal = next_live_legacy_ordinal(turn, kind);
            canonical_legacy_id(turn_id, kind, ordinal)
        } else if is_call_like_kind(kind) {
            canonical_call_id(turn_id, raw_item_id)
        } else {
            canonical_durable_item_id(turn_id, raw_item_id)
        };
        let canonical = follow_redirects(turn, &canonical);

        turn.aliases
            .insert(app_alias(raw_item_id), canonical.clone());
        if is_call_like_kind(kind) {
            turn.aliases
                .insert(call_alias(raw_item_id), canonical.clone());
        } else if !is_app_server_synthetic_id(raw_item_id) {
            turn.aliases
                .insert(durable_alias(raw_item_id), canonical.clone());
        }
        canonical
    }

    pub(crate) fn register_disk_item_aliases(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        canonical_item_id: &str,
        aliases: &[String],
    ) -> Vec<ItemRekey> {
        let turn = self
            .threads
            .entry(thread_id.to_string())
            .or_default()
            .turns
            .entry(turn_id.to_string())
            .or_default();
        let target = follow_redirects(turn, canonical_item_id);
        let mut rekeys = Vec::new();
        for alias in expanded_source_aliases(aliases) {
            if let Some(canonical_alias) = alias
                .strip_prefix("canonical:")
                .filter(|value| is_canonical_item_id(value))
            {
                let existing = follow_redirects(turn, canonical_alias);
                if existing != target {
                    redirect_canonical(turn, &existing, &target, &mut rekeys);
                }
                turn.aliases.insert(alias.clone(), target.clone());
                continue;
            }
            if let Some(existing) = turn.aliases.get(&alias).cloned() {
                let existing = follow_redirects(turn, &existing);
                if existing != target {
                    redirect_canonical(turn, &existing, &target, &mut rekeys);
                }
            }
            turn.aliases.insert(alias.clone(), target.clone());
        }
        dedupe_rekeys(rekeys)
    }

    pub(crate) fn resolve_existing_item_id(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        item_id: &str,
    ) -> String {
        let Some(thread) = self.threads.get_mut(thread_id) else {
            return item_id.to_string();
        };
        let Some(turn) = thread.turns.get_mut(turn_id) else {
            return item_id.to_string();
        };
        if is_canonical_item_id(item_id) {
            return follow_redirects(turn, item_id);
        }
        for alias in [
            app_alias(item_id),
            call_alias(item_id),
            durable_alias(item_id),
        ] {
            if let Some(canonical) = turn.aliases.get(&alias) {
                return follow_redirects(turn, canonical);
            }
        }
        item_id.to_string()
    }
}

pub(crate) fn canonical_disk_item_id(
    turn_id: &str,
    kind: &str,
    durable_item_id: Option<&str>,
    call_id: Option<&str>,
    counters: &mut LegacyItemCounters,
) -> String {
    if is_call_like_kind(kind)
        && let Some(call_id) = call_id.filter(|id| !id.trim().is_empty())
    {
        return canonical_call_id(turn_id, call_id);
    }

    if let Some(item_id) = durable_item_id.filter(|id| !id.trim().is_empty()) {
        if is_canonical_item_id(item_id) {
            return item_id.to_string();
        }
        if !is_app_server_synthetic_id(item_id) {
            return canonical_durable_item_id(turn_id, item_id);
        }
    }

    if let Some(call_id) = call_id.filter(|id| !id.trim().is_empty()) {
        return canonical_call_id(turn_id, call_id);
    }

    let ordinal = counters.next(kind);
    canonical_legacy_id(turn_id, kind, ordinal)
}

pub(crate) fn disk_item_identity(
    turn_id: &str,
    kind: &str,
    durable_item_id: Option<&str>,
    call_id: Option<&str>,
    counters: &mut LegacyItemCounters,
) -> DiskItemIdentity {
    let id = canonical_disk_item_id(turn_id, kind, durable_item_id, call_id, counters);
    let mut aliases = Vec::new();
    if let Some(item_id) = durable_item_id.filter(|value| !value.trim().is_empty())
        && !is_app_server_synthetic_id(item_id)
        && !is_canonical_item_id(item_id)
    {
        aliases.push(durable_alias(item_id));
    }
    if let Some(call_id) = call_id.filter(|value| !value.trim().is_empty()) {
        aliases.push(call_alias(call_id));
    }
    aliases.retain(|alias| canonical_for_source_alias(turn_id, alias).as_deref() != Some(&id));
    aliases.dedup();
    DiskItemIdentity { aliases, id }
}

pub(crate) fn canonical_durable_item_id(turn_id: &str, item_id: &str) -> String {
    format!("{CANONICAL_PREFIX}{turn_id}:id:{item_id}")
}

pub(crate) fn canonical_call_id(turn_id: &str, call_id: &str) -> String {
    format!("{CANONICAL_PREFIX}{turn_id}:call:{call_id}")
}

pub(crate) fn canonical_legacy_id(turn_id: &str, kind: &str, ordinal: usize) -> String {
    format!("{CANONICAL_PREFIX}{turn_id}:legacy:{kind}:{ordinal}")
}

pub(crate) fn is_canonical_item_id(item_id: &str) -> bool {
    item_id.starts_with(CANONICAL_PREFIX)
}

pub(crate) fn is_call_like_kind(kind: &str) -> bool {
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

pub(crate) fn inferred_item_kind_for_method(method: &str) -> Option<&'static str> {
    match method {
        "item/agentMessage/delta" => Some("agentMessage"),
        "item/plan/delta" => Some("plan"),
        "item/commandExecution/outputDelta" | "item/commandExecution/terminalInteraction" => {
            Some("commandExecution")
        }
        "item/fileChange/outputDelta" | "item/fileChange/patchUpdated" => Some("fileChange"),
        "item/mcpToolCall/progress" => Some("mcpToolCall"),
        "item/reasoning/summaryPartAdded"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/textDelta" => Some("reasoning"),
        _ => None,
    }
}

pub(crate) fn source_aliases(item: &Value) -> Vec<String> {
    item.get(IDENTITY_ALIASES_FIELD)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

pub(crate) fn canonical_for_source_alias(turn_id: &str, alias: &str) -> Option<String> {
    let (kind, value) = alias.split_once(':')?;
    match kind {
        "canonical" if is_canonical_item_id(value) => Some(value.to_string()),
        "id" => Some(canonical_durable_item_id(turn_id, value)),
        "call" => Some(canonical_call_id(turn_id, value)),
        _ => None,
    }
}

fn next_live_legacy_ordinal(turn: &mut TurnIdentityState, kind: &str) -> usize {
    let ordinal = turn
        .live_legacy_ordinals
        .entry(kind.to_string())
        .or_default();
    let current = *ordinal;
    *ordinal += 1;
    current
}

fn follow_redirects(turn: &TurnIdentityState, item_id: &str) -> String {
    let mut current = item_id.to_string();
    let mut seen = HashSet::new();
    while seen.insert(current.clone()) {
        let Some(next) = turn.canonical_redirects.get(&current) else {
            break;
        };
        if next == &current {
            break;
        }
        current = next.clone();
    }
    current
}

fn redirect_canonical(
    turn: &mut TurnIdentityState,
    from: &str,
    to: &str,
    rekeys: &mut Vec<ItemRekey>,
) {
    let from = follow_redirects(turn, from);
    let to = follow_redirects(turn, to);
    if from == to {
        return;
    }
    turn.canonical_redirects.insert(from.clone(), to.clone());
    for canonical in turn.aliases.values_mut() {
        if *canonical == from {
            *canonical = to.clone();
        }
    }
    for canonical in turn.canonical_redirects.values_mut() {
        if *canonical == from {
            *canonical = to.clone();
        }
    }
    rekeys.push(ItemRekey { from, to });
}

fn expanded_source_aliases(aliases: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut expanded = Vec::new();
    for alias in aliases {
        push_alias(&mut expanded, &mut seen, alias.clone());
        let Some((kind, value)) = alias.split_once(':') else {
            continue;
        };
        match kind {
            "id" | "call" => {
                push_alias(&mut expanded, &mut seen, app_alias(value));
                push_alias(&mut expanded, &mut seen, durable_alias(value));
                push_alias(&mut expanded, &mut seen, call_alias(value));
            }
            "app" => {
                push_alias(&mut expanded, &mut seen, durable_alias(value));
                push_alias(&mut expanded, &mut seen, call_alias(value));
            }
            _ => {}
        }
    }
    expanded
}

fn push_alias(aliases: &mut Vec<String>, seen: &mut HashSet<String>, alias: String) {
    if seen.insert(alias.clone()) {
        aliases.push(alias);
    }
}

fn dedupe_rekeys(rekeys: Vec<ItemRekey>) -> Vec<ItemRekey> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for rekey in rekeys {
        if rekey.from == rekey.to {
            continue;
        }
        if seen.insert((rekey.from.clone(), rekey.to.clone())) {
            deduped.push(rekey);
        }
    }
    deduped
}

fn is_app_server_synthetic_id(item_id: &str) -> bool {
    let Some(suffix) = item_id.strip_prefix("item-") else {
        return false;
    };
    !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
}

fn item_kind(item: &Value) -> Option<&str> {
    item.get("type").and_then(Value::as_str)
}

fn app_alias(item_id: &str) -> String {
    format!("app:{item_id}")
}

fn durable_alias(item_id: &str) -> String {
    format!("id:{item_id}")
}

fn call_alias(call_id: &str) -> String {
    format!("call:{call_id}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn disk_legacy_ordinals_are_kind_scoped_and_reproducible() {
        let mut counters = LegacyItemCounters::default();

        assert_eq!(
            canonical_disk_item_id("turn-1", "agentMessage", None, None, &mut counters),
            "cxitem:v1:turn-1:legacy:agentMessage:0"
        );
        assert_eq!(
            canonical_disk_item_id("turn-1", "userMessage", None, None, &mut counters),
            "cxitem:v1:turn-1:legacy:userMessage:0"
        );
        assert_eq!(
            canonical_disk_item_id("turn-1", "agentMessage", None, None, &mut counters),
            "cxitem:v1:turn-1:legacy:agentMessage:1"
        );
    }

    #[test]
    fn live_synthetic_ids_are_aliases_to_legacy_ordinals() {
        let mut state = ItemIdentityState::default();

        let first = state.resolve_live_delta_id("thread", "turn", "agentMessage", "item-2");
        let second = state.resolve_live_delta_id("thread", "turn", "agentMessage", "item-2");
        let next = state.resolve_live_delta_id("thread", "turn", "agentMessage", "item-3");

        assert_eq!(first, "cxitem:v1:turn:legacy:agentMessage:0");
        assert_eq!(second, first);
        assert_eq!(next, "cxitem:v1:turn:legacy:agentMessage:1");
    }

    #[test]
    fn live_call_like_ids_use_call_identity() {
        let mut state = ItemIdentityState::default();
        let mut item = json!({
            "aggregatedOutput": "",
            "id": "call-1",
            "type": "commandExecution"
        });

        let canonical = state
            .canonicalize_live_item("thread", "turn", &mut item)
            .expect("canonical id");

        assert_eq!(canonical, "cxitem:v1:turn:call:call-1");
        assert_eq!(item["id"], json!("cxitem:v1:turn:call:call-1"));
    }

    #[test]
    fn disk_call_alias_can_resolve_future_live_call_events_to_durable_id() {
        let mut counters = LegacyItemCounters::default();
        let identity = disk_item_identity(
            "turn",
            "commandExecution",
            Some("fc-1"),
            Some("call-1"),
            &mut counters,
        );
        let mut state = ItemIdentityState::default();
        state.register_disk_item_aliases("thread", "turn", &identity.id, &identity.aliases);

        assert_eq!(identity.id, "cxitem:v1:turn:call:call-1");
        assert_eq!(
            state.resolve_live_delta_id("thread", "turn", "commandExecution", "call-1"),
            "cxitem:v1:turn:call:call-1"
        );
    }

    #[test]
    fn disk_alias_registration_rekeys_live_provisional_call_identity() {
        let mut state = ItemIdentityState::default();
        let provisional = state.resolve_live_delta_id("thread", "turn", "commandExecution", "fc-1");
        assert_eq!(provisional, "cxitem:v1:turn:call:fc-1");

        let rekeys = state.register_disk_item_aliases(
            "thread",
            "turn",
            "cxitem:v1:turn:call:cmd-1",
            &[durable_alias("fc-1")],
        );

        assert_eq!(
            rekeys,
            vec![ItemRekey {
                from: "cxitem:v1:turn:call:fc-1".to_string(),
                to: "cxitem:v1:turn:call:cmd-1".to_string(),
            }]
        );
        assert_eq!(
            state.resolve_live_delta_id("thread", "turn", "commandExecution", "fc-1"),
            "cxitem:v1:turn:call:cmd-1"
        );
        assert_eq!(
            state.resolve_existing_item_id("thread", "turn", "cxitem:v1:turn:call:fc-1"),
            "cxitem:v1:turn:call:cmd-1"
        );
    }

    #[test]
    fn canonical_alias_registration_redirects_stale_item_id() {
        let mut state = ItemIdentityState::default();
        let legacy = "cxitem:v1:turn:legacy:agentMessage:0";
        let durable = "cxitem:v1:turn:id:msg-1";

        let rekeys = state.register_disk_item_aliases(
            "thread",
            "turn",
            durable,
            &[format!("canonical:{legacy}")],
        );

        assert_eq!(
            rekeys,
            vec![ItemRekey {
                from: legacy.to_string(),
                to: durable.to_string(),
            }]
        );
        assert_eq!(
            state.resolve_existing_item_id("thread", "turn", legacy),
            durable
        );
    }
}
