use std::collections::{HashMap, HashSet};
use std::env;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::narration::{NarrationInner, NarrationSourceBlock};

pub(crate) const NARRATION_CONTEXT_PROFILE_VERSION: &str = "1";
pub(crate) const NARRATION_BASE_INSTRUCTIONS_VERSION: &str = "2";
pub(crate) const NARRATION_PROMPT_VERSION: &str = "6";
pub(crate) const NARRATION_PLANNING_CONTRACT_VERSION: u64 = 3;
pub(crate) const NARRATION_SOURCE_MAPPING_VERSION: &str = "6";
pub(crate) const NARRATION_ACOUSTIC_TIMING_PROVIDER_VERSION: &str = "kokoro-native-v1";
pub(crate) const MAX_PLANNING_BATCH_BLOCKS: usize = 20;
pub(crate) const MAX_PLANNING_BATCH_UTF16: usize = 4_000;
pub(crate) const MAX_CONCURRENT_PLANNING_BATCHES: usize = 3;
const MAX_PLANNING_SEGMENT_BYTES: usize = 16 * 1024;
const MAX_PLANNING_RESPONSE_BYTES: usize = 256 * 1024;
const PLANNING_TIMEOUT: Duration = Duration::from_secs(240);

pub(crate) const NARRATION_BASE_INSTRUCTIONS_V2: &str = "You produce speakable narration for supplied Markdown blocks.\n\nReturn only JSON matching the supplied output schema. Do not return Markdown,\ncommentary, explanations, confidence, or reasoning. Do not use tools, browse,\nread files, or refer to this task.\n\nThe input is compact JSON with version v and ordered blocks b. Each block has:\n- i: its zero-based index in this request;\n- k: p paragraph, h heading, li list item, q blockquote, c code, tb table, or d diagram;\n- m: n for pronunciation normalization or s for structural summary;\n- x: exact display text;\n- optional t: inline technical ranges with kind k and UTF-16 offsets s inclusive and e exclusive.\n\nReturn version v equal to 3 and one output segment in s for every input block,\nin the same order. Each segment has b, the unchanged input block index, and x,\nnon-empty spoken text.\n\nNever choose a mode, omit a block, merge blocks, split a block, reproduce a\nrenderer identifier, or output source alignment.\n\nFor mode n:\n- preserve the source meaning and sentence order;\n- preserve every display word outside supplied technical ranges, in the same order;\n- rewrite only technical notation inside supplied ranges and the minimum adjacent grammar required for natural speech;\n- pronounce units, symbols, URLs, identifiers, abbreviations, and inline code naturally rather than reading punctuation literally;\n- do not summarize, shorten, expand with new facts, or paraphrase ordinary prose.\n\nFor mode s:\n- produce a concise natural explanation of the complete structure and its meaning;\n- preserve material behavior, relationships, ordering, quantities, and caveats;\n- do not read Markdown syntax, code punctuation, type syntax, table separators,\n  every table cell, or every diagram edge literally;\n- keep the summary proportional to the source and do not add facts.\n\nKeep technical names recognizable while making their pronunciation natural.";

pub(crate) const COMPACT_PLAN_SCHEMA_V3_JSON: &str = r#"{"type":"object","additionalProperties":false,"required":["v","s"],"properties":{"v":{"type":"integer","enum":[3]},"s":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["b","x"],"properties":{"b":{"type":"integer"},"x":{"type":"string"}}}}}}"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PlanningServiceTier {
    Priority,
    Standard,
}

impl PlanningServiceTier {
    fn persisted(self) -> &'static str {
        match self {
            Self::Priority => "priority",
            Self::Standard => "standard",
        }
    }

    fn wire(self) -> Value {
        match self {
            Self::Priority => json!("priority"),
            Self::Standard => Value::Null,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NarrationPlanningProfile {
    pub(crate) provider: &'static str,
    pub(crate) model: String,
    pub(crate) service_tier: PlanningServiceTier,
    pub(crate) effort: &'static str,
    pub(crate) reasoning_summary: &'static str,
    pub(crate) context_profile_version: &'static str,
    pub(crate) base_instructions_version: &'static str,
    pub(crate) prompt_version: &'static str,
    pub(crate) contract_version: u64,
}

impl NarrationPlanningProfile {
    pub(crate) fn provider_descriptor(&self, synthesizer: Value) -> Value {
        json!({
            "id": "codex-kokoro-source-map-v4",
            "scriptGenerator": {
                "provider": self.provider,
                "model": self.model,
                "serviceTier": self.service_tier.persisted(),
                "effort": self.effort,
                "reasoningSummary": self.reasoning_summary,
                "contextProfileVersion": self.context_profile_version,
                "baseInstructionsVersion": self.base_instructions_version,
                "promptVersion": self.prompt_version,
                "contractVersion": self.contract_version,
            },
            "sourceMapper": {
                "provider": "remux-monotonic-lcs",
                "algorithmVersion": NARRATION_SOURCE_MAPPING_VERSION,
            },
            "acousticTiming": {
                "provider": "kokoro-native",
                "algorithmVersion": "1",
            },
            "synthesizer": synthesizer,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PlanningTurnIdentity {
    pub(crate) batch_index: usize,
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
}

#[derive(Clone, Debug)]
pub(crate) struct PlannedSegment {
    pub(crate) alignment_hints: Vec<Value>,
    pub(crate) block_id: String,
    pub(crate) mode: &'static str,
    pub(crate) spoken_text: String,
}

#[derive(Clone, Debug)]
struct PlanningBatch {
    blocks: Vec<NarrationSourceBlock>,
    index: usize,
    source_start: usize,
}

#[derive(Debug, Serialize)]
struct CompactPlanningRequest {
    #[serde(rename = "v")]
    version: u64,
    #[serde(rename = "b")]
    blocks: Vec<CompactPlanningBlock>,
}

#[derive(Debug, Serialize)]
struct CompactPlanningBlock {
    #[serde(rename = "i")]
    index: usize,
    #[serde(rename = "k")]
    kind: &'static str,
    #[serde(rename = "m")]
    mode: &'static str,
    #[serde(rename = "x")]
    display_text: String,
    #[serde(rename = "t")]
    #[serde(skip_serializing_if = "Vec::is_empty")]
    targets: Vec<Value>,
}

#[derive(Debug)]
struct PreparedCompactBlock {
    block: NarrationSourceBlock,
    compact: CompactPlanningBlock,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompactPlanningResponse {
    #[serde(rename = "v")]
    version: u64,
    #[serde(rename = "s")]
    segments: Vec<CompactPlanningSegment>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompactPlanningSegment {
    #[serde(rename = "b")]
    block: usize,
    #[serde(rename = "x")]
    spoken_text: String,
}

pub(crate) fn resolve_planning_profile(
    inner: &NarrationInner,
) -> Result<NarrationPlanningProfile, String> {
    let requested_model = env::var("REMUX_NARRATION_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "gpt-5.6-sol".to_string());
    if requested_model != "gpt-5.6-sol" {
        return Err(format!(
            "unsupported narration model override {requested_model}; expected gpt-5.6-sol"
        ));
    }

    let response =
        inner.app_server_request("model/list", json!({ "includeHidden": true, "limit": 100 }))?;
    let requested_tier = env::var("REMUX_NARRATION_SERVICE_TIER")
        .ok()
        .filter(|value| !value.trim().is_empty());
    resolve_profile_from_catalog(&response, requested_model, requested_tier.as_deref())
}

fn resolve_profile_from_catalog(
    response: &Value,
    requested_model: String,
    requested_tier: Option<&str>,
) -> Result<NarrationPlanningProfile, String> {
    let model = response
        .get("data")
        .and_then(Value::as_array)
        .and_then(|models| {
            models.iter().find(|model| {
                model.get("model").and_then(Value::as_str) == Some(requested_model.as_str())
                    || model.get("id").and_then(Value::as_str) == Some(requested_model.as_str())
            })
        })
        .ok_or_else(|| "narration planning requires gpt-5.6-sol".to_string())?;
    let supports_priority = model
        .get("serviceTiers")
        .and_then(Value::as_array)
        .is_some_and(|tiers| {
            tiers
                .iter()
                .any(|tier| tier.get("id").and_then(Value::as_str) == Some("priority"))
        })
        || model
            .get("additionalSpeedTiers")
            .and_then(Value::as_array)
            .is_some_and(|tiers| tiers.iter().any(|tier| tier.as_str() == Some("priority")));
    let service_tier = match requested_tier {
        Some("priority") if supports_priority => PlanningServiceTier::Priority,
        Some("priority") => {
            return Err("gpt-5.6-sol does not advertise the priority service tier".to_string());
        }
        Some("standard") | None if !supports_priority => PlanningServiceTier::Standard,
        Some("standard") => PlanningServiceTier::Standard,
        None => PlanningServiceTier::Priority,
        Some(other) => return Err(format!("unsupported narration service tier {other}")),
    };

    Ok(NarrationPlanningProfile {
        provider: "codex-app-server",
        model: requested_model,
        service_tier,
        effort: "low",
        reasoning_summary: "none",
        context_profile_version: NARRATION_CONTEXT_PROFILE_VERSION,
        base_instructions_version: NARRATION_BASE_INSTRUCTIONS_VERSION,
        prompt_version: NARRATION_PROMPT_VERSION,
        contract_version: NARRATION_PLANNING_CONTRACT_VERSION,
    })
}

pub(crate) fn plan_transformed_blocks(
    inner: &Arc<NarrationInner>,
    artifact_key: &str,
    blocks: &[NarrationSourceBlock],
    targets: &[Value],
    profile: &NarrationPlanningProfile,
) -> Result<HashMap<String, PlannedSegment>, String> {
    if blocks.is_empty() {
        return Ok(HashMap::new());
    }
    let started = Instant::now();
    let batches = partition_blocks(blocks);
    let next = Arc::new(AtomicUsize::new(0));
    let (result_tx, result_rx) = mpsc::channel();
    let worker_count = batches.len().min(MAX_CONCURRENT_PLANNING_BATCHES);

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let inner = inner.clone();
            let next = next.clone();
            let result_tx = result_tx.clone();
            let batches = &batches;
            let profile = profile.clone();
            scope.spawn(move || {
                loop {
                    let batch_index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(batch) = batches.get(batch_index) else {
                        break;
                    };
                    if inner.cancelled(artifact_key) {
                        let _ =
                            result_tx.send((batch_index, Err("narration cancelled".to_string())));
                        break;
                    }
                    let result = plan_batch(&inner, artifact_key, batch, targets, &profile);
                    let failed = result.is_err();
                    let _ = result_tx.send((batch_index, result));
                    if failed {
                        break;
                    }
                }
            });
        }
        drop(result_tx);

        let mut results = vec![None; batches.len()];
        let mut first_error = None;
        for (batch_index, result) in result_rx {
            match result {
                Ok(value) => results[batch_index] = Some(value),
                Err(error) => {
                    first_error.get_or_insert(error);
                    next.store(batches.len(), Ordering::SeqCst);
                    inner.interrupt_planning_turns(artifact_key);
                }
            }
        }
        if let Some(error) = first_error {
            inner.interrupt_planning_turns(artifact_key);
            return Err(error);
        }

        let mut output = HashMap::new();
        let mut expected_source_start = 0;
        for (batch, result) in batches.iter().zip(results) {
            if batch.source_start != expected_source_start {
                return Err("narration planning batches are not contiguous".to_string());
            }
            let result =
                result.ok_or_else(|| "narration planning batch did not complete".to_string())?;
            if result.len() != batch.blocks.len() {
                return Err("narration planning batch coverage mismatch".to_string());
            }
            for segment in result {
                if output.insert(segment.block_id.clone(), segment).is_some() {
                    return Err("narration planning duplicated a source block".to_string());
                }
            }
            expected_source_start += batch.blocks.len();
        }
        if expected_source_start != blocks.len() {
            return Err("narration planning did not cover every source block".to_string());
        }
        inner.record_narration_diagnostic(json!({
            "phase": "planning",
            "batchCount": batches.len(),
            "completionMs": started.elapsed().as_millis(),
            "maxConcurrentBatches": worker_count,
            "model": profile.model,
            "serviceTier": profile.service_tier.persisted(),
            "transformedBlockCount": blocks.len(),
        }));
        Ok(output)
    })
}

fn partition_blocks(blocks: &[NarrationSourceBlock]) -> Vec<PlanningBatch> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    let mut current_utf16 = 0;
    let mut source_start = 0;
    for block in blocks {
        let block_utf16 = block.display_text.encode_utf16().count();
        if !current.is_empty()
            && (current.len() >= MAX_PLANNING_BATCH_BLOCKS
                || current_utf16 + block_utf16 > MAX_PLANNING_BATCH_UTF16)
        {
            let index = batches.len();
            let batch_len = current.len();
            batches.push(PlanningBatch {
                blocks: std::mem::take(&mut current),
                index,
                source_start,
            });
            source_start += batch_len;
            current_utf16 = 0;
        }
        current_utf16 += block_utf16;
        current.push(block.clone());
    }
    if !current.is_empty() {
        batches.push(PlanningBatch {
            blocks: current,
            index: batches.len(),
            source_start,
        });
    }
    batches
}

fn plan_batch(
    inner: &Arc<NarrationInner>,
    artifact_key: &str,
    batch: &PlanningBatch,
    targets: &[Value],
    profile: &NarrationPlanningProfile,
) -> Result<Vec<PlannedSegment>, String> {
    let started = Instant::now();
    let prepared = batch
        .blocks
        .iter()
        .enumerate()
        .map(|(index, block)| prepare_block(index, block, targets))
        .collect::<Result<Vec<_>, _>>()?;
    let request = CompactPlanningRequest {
        version: NARRATION_PLANNING_CONTRACT_VERSION,
        blocks: prepared
            .iter()
            .map(|prepared| CompactPlanningBlock {
                index: prepared.compact.index,
                kind: prepared.compact.kind,
                mode: prepared.compact.mode,
                display_text: prepared.compact.display_text.clone(),
                targets: prepared.compact.targets.clone(),
            })
            .collect(),
    };
    let compact_json = serde_json::to_string(&request)
        .map_err(|error| format!("failed to encode compact narration request: {error}"))?;

    let context_dir = inner.planning_context_directory()?;
    let thread_response =
        inner.app_server_request("thread/start", thread_start_params(profile, &context_dir))?;
    let thread_id = thread_response
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "narration thread/start response missing thread.id".to_string())?
        .to_string();
    let (event_rx, _subscription) = inner.subscribe_to_planning_thread(&thread_id)?;
    let turn_response = inner.app_server_request(
        "turn/start",
        turn_start_params(profile, &thread_id, &compact_json),
    )?;
    let turn_id = turn_response
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "narration turn/start response missing turn.id".to_string())?
        .to_string();
    inner.record_planning_turn(
        artifact_key,
        PlanningTurnIdentity {
            batch_index: batch.index,
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
        },
    );

    let completed = wait_for_plan(inner, artifact_key, &thread_id, &turn_id, event_rx)?;
    if completed.len() > MAX_PLANNING_RESPONSE_BYTES {
        return Err(format!(
            "narration planning response is too large: {}>{MAX_PLANNING_RESPONSE_BYTES}",
            completed.len()
        ));
    }
    let response: CompactPlanningResponse = serde_json::from_str(&completed)
        .map_err(|error| format!("Codex returned invalid compact narration JSON: {error}"))?;
    let output = validate_response(response, &prepared)?;
    eprintln!(
        "[codex:narration] planning batch={} blocks={} request_bytes={} response_bytes={} completion_ms={}",
        batch.index,
        prepared.len(),
        compact_json.len(),
        completed.len(),
        started.elapsed().as_millis(),
    );
    Ok(output)
}

fn thread_start_params(profile: &NarrationPlanningProfile, context_dir: &std::path::Path) -> Value {
    json!({
        "model": profile.model,
        "serviceTier": profile.service_tier.wire(),
        "baseInstructions": NARRATION_BASE_INSTRUCTIONS_V2,
        "approvalPolicy": "never",
        "cwd": context_dir,
        "config": {
            "features": {
                "shell_tool": false,
                "unified_exec": false,
                "code_mode": false,
                "standalone_web_search": false,
                "multi_agent": false,
                "multi_agent_v2": false,
                "apps": false,
                "enable_mcp_apps": false,
                "tool_suggest": false,
                "plugins": false,
                "remote_plugin": false,
                "image_generation": false
            },
            "web_search": "disabled",
            "skills": {
                "include_instructions": false,
                "bundled": { "enabled": false }
            }
        },
        "dynamicTools": [],
        "environments": [],
        "ephemeral": true,
        "experimentalRawEvents": false,
        "persistExtendedHistory": false,
        "sandbox": "read-only",
        "serviceName": "remux-narration"
    })
}

fn turn_start_params(
    profile: &NarrationPlanningProfile,
    thread_id: &str,
    compact_json: &str,
) -> Value {
    json!({
        "threadId": thread_id,
        "serviceTier": profile.service_tier.wire(),
        "effort": profile.effort,
        "summary": profile.reasoning_summary,
        "input": [{ "type": "text", "text": compact_json, "text_elements": [] }],
        "outputSchema": compact_plan_schema_v3(),
    })
}

fn prepare_block(
    index: usize,
    block: &NarrationSourceBlock,
    targets: &[Value],
) -> Result<PreparedCompactBlock, String> {
    let mode = if matches!(block.kind.as_str(), "code" | "table" | "diagram") {
        "s"
    } else {
        "n"
    };
    let kind = match block.kind.as_str() {
        "paragraph" => "p",
        "heading" => "h",
        "listItem" => "li",
        "blockquote" => "q",
        "code" => "c",
        "table" => "tb",
        "diagram" => "d",
        other => return Err(format!("unsupported narration block kind {other}")),
    };
    let mut compact_targets = Vec::new();
    for target in targets
        .iter()
        .filter(|target| target.get("blockId").and_then(Value::as_str) == Some(block.id.as_str()))
    {
        let compact = match target.get("kind").and_then(Value::as_str) {
            Some("textRange") => {
                let compact_kind = match target.get("role").and_then(Value::as_str) {
                    Some("expression") => "expr",
                    Some("inlineCode") => "code",
                    Some("link") => "link",
                    _ => continue,
                };
                json!({
                    "k": compact_kind,
                    "s": required_usize(target, "displayStart")?,
                    "e": required_usize(target, "displayEnd")?,
                })
            }
            _ => continue,
        };
        compact_targets.push(compact);
    }

    Ok(PreparedCompactBlock {
        block: block.clone(),
        compact: CompactPlanningBlock {
            index,
            kind,
            mode,
            display_text: block.display_text.clone(),
            targets: compact_targets,
        },
    })
}

fn validate_response(
    response: CompactPlanningResponse,
    blocks: &[PreparedCompactBlock],
) -> Result<Vec<PlannedSegment>, String> {
    if response.version != NARRATION_PLANNING_CONTRACT_VERSION {
        return Err("unsupported compact narration response version".to_string());
    }
    if response.segments.len() != blocks.len() {
        return Err(format!(
            "compact narration segment count mismatch: {}!={}",
            response.segments.len(),
            blocks.len()
        ));
    }
    let mut output = Vec::with_capacity(blocks.len());
    let mut seen = HashSet::new();
    for (index, (segment, prepared)) in response.segments.into_iter().zip(blocks).enumerate() {
        if segment.block != index || !seen.insert(segment.block) {
            return Err(format!(
                "compact narration reordered or duplicated segment {}",
                segment.block
            ));
        }
        if segment.spoken_text.is_empty()
            || segment.spoken_text.trim() != segment.spoken_text
            || segment.spoken_text.len() > MAX_PLANNING_SEGMENT_BYTES
        {
            return Err(format!(
                "compact narration segment {index} has invalid spoken text"
            ));
        }
        output.push(PlannedSegment {
            alignment_hints: Vec::new(),
            block_id: prepared.block.id.clone(),
            mode: if prepared.compact.mode == "n" {
                "normalized"
            } else {
                "summary"
            },
            spoken_text: segment.spoken_text,
        });
    }
    Ok(output)
}

fn wait_for_plan(
    inner: &NarrationInner,
    artifact_key: &str,
    thread_id: &str,
    turn_id: &str,
    event_rx: mpsc::Receiver<Value>,
) -> Result<String, String> {
    let started = Instant::now();
    let mut completed_text: Option<String> = None;
    let mut completed_messages = 0;
    let mut _first_delta_ms = None;
    loop {
        if inner.cancelled(artifact_key) {
            return Err("narration cancelled".to_string());
        }
        if started.elapsed() > PLANNING_TIMEOUT {
            return Err("narration planning timed out".to_string());
        }
        let notification = match event_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(notification) => notification,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("narration app-server event stream closed".to_string());
            }
        };
        let method = notification
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = notification.get("params").unwrap_or(&Value::Null);
        if params.get("threadId").and_then(Value::as_str) != Some(thread_id) {
            continue;
        }
        match method {
            "item/agentMessage/delta"
                if params.get("turnId").and_then(Value::as_str) == Some(turn_id) =>
            {
                _first_delta_ms.get_or_insert_with(|| started.elapsed().as_millis());
            }
            "item/completed" if params.get("turnId").and_then(Value::as_str) == Some(turn_id) => {
                let item = params.get("item").unwrap_or(&Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                    completed_messages += 1;
                    completed_text = item.get("text").and_then(Value::as_str).map(str::to_string);
                }
            }
            "turn/completed" => {
                let turn = params.get("turn").unwrap_or(&Value::Null);
                if turn.get("id").and_then(Value::as_str) != Some(turn_id) {
                    continue;
                }
                if turn.get("status").and_then(Value::as_str) != Some("completed") {
                    return Err(turn
                        .get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("narration planning failed")
                        .to_string());
                }
                if completed_messages != 1 {
                    return Err(format!(
                        "narration planning completed with {completed_messages} authoritative agent messages"
                    ));
                }
                return completed_text
                    .filter(|text| !text.is_empty())
                    .ok_or_else(|| {
                        "narration planning completed without authoritative output".to_string()
                    });
            }
            "app-server/disconnected" => {
                return Err("narration app-server disconnected".to_string());
            }
            _ => {}
        }
    }
}

fn compact_plan_schema_v3() -> Value {
    serde_json::from_str(COMPACT_PLAN_SCHEMA_V3_JSON)
        .expect("COMPACT_PLAN_SCHEMA_V3_JSON must remain valid")
}

fn required_usize(value: &Value, field: &str) -> Result<usize, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("narration target is missing {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(service_tier: PlanningServiceTier) -> NarrationPlanningProfile {
        NarrationPlanningProfile {
            provider: "codex-app-server",
            model: "gpt-5.6-sol".to_string(),
            service_tier,
            effort: "low",
            reasoning_summary: "none",
            context_profile_version: "1",
            base_instructions_version: "2",
            prompt_version: "6",
            contract_version: 3,
        }
    }

    fn block(index: usize, text: &str) -> NarrationSourceBlock {
        NarrationSourceBlock {
            display_text: text.to_string(),
            id: format!("md:{index}"),
            inline_ranges: Vec::new(),
            kind: "paragraph".to_string(),
            needs_transform: true,
            path: index.to_string(),
            target_ids: vec![format!("md:{index}/target/block")],
        }
    }

    #[test]
    fn prompt_and_schema_are_versioned_static_bytes() {
        assert!(NARRATION_BASE_INSTRUCTIONS_V2.starts_with("You produce speakable narration"));
        assert!(NARRATION_BASE_INSTRUCTIONS_V2.ends_with("pronunciation natural."));
        let schema = compact_plan_schema_v3();
        assert_eq!(schema["properties"]["v"]["enum"], json!([3]));
        assert!(!COMPACT_PLAN_SCHEMA_V3_JSON.contains("blockId"));
        assert!(!COMPACT_PLAN_SCHEMA_V3_JSON.contains("\"a\""));
    }

    #[test]
    fn app_server_params_are_isolated_and_do_not_prefix_compact_json() {
        let profile = profile(PlanningServiceTier::Priority);
        let thread = thread_start_params(&profile, std::path::Path::new("/neutral"));
        assert_eq!(thread["baseInstructions"], NARRATION_BASE_INSTRUCTIONS_V2);
        assert_eq!(thread["serviceTier"], "priority");
        assert_eq!(thread["cwd"], "/neutral");
        assert_eq!(thread["dynamicTools"], json!([]));
        assert_eq!(thread["environments"], json!([]));
        assert_eq!(thread["config"]["features"]["shell_tool"], false);
        assert_eq!(thread["config"]["features"]["multi_agent"], false);
        assert_eq!(thread["config"]["skills"]["include_instructions"], false);
        assert!(thread.get("developerInstructions").is_none());

        let turn = turn_start_params(&profile, "thread-1", "{\"v\":3,\"b\":[]}");
        assert_eq!(turn["effort"], "low");
        assert_eq!(turn["summary"], "none");
        assert_eq!(turn["input"][0]["text"], "{\"v\":3,\"b\":[]}");
        assert_eq!(turn["input"][0]["text_elements"], json!([]));
    }

    #[test]
    fn partitions_at_block_and_utf16_limits() {
        let blocks = (0..21)
            .map(|index| block(index, "word"))
            .collect::<Vec<_>>();
        let batches = partition_blocks(&blocks);
        assert_eq!(
            batches
                .iter()
                .map(|batch| batch.blocks.len())
                .collect::<Vec<_>>(),
            vec![20, 1]
        );

        let unicode = "😀".repeat(2_001);
        let batches = partition_blocks(&[block(0, &unicode), block(1, "tail")]);
        assert_eq!(
            batches
                .iter()
                .map(|batch| batch.blocks.len())
                .collect::<Vec<_>>(),
            vec![1, 1]
        );
    }

    #[test]
    fn compact_request_omits_empty_targets_and_target_indexes() {
        let prose = block(0, "Read Arc<T> now");
        let empty = prepare_block(0, &prose, &[]).unwrap();
        let encoded = serde_json::to_value(&empty.compact).unwrap();
        assert!(encoded.get("t").is_none());

        let prepared = prepare_block(
            0,
            &prose,
            &[json!({
                "blockId": "md:0",
                "displayEnd": 11,
                "displayStart": 5,
                "id": "md:0/target/expression/5-11",
                "kind": "textRange",
                "role": "expression",
            })],
        )
        .unwrap();
        let encoded = serde_json::to_value(&prepared.compact).unwrap();
        assert_eq!(encoded["t"], json!([{ "e": 11, "k": "expr", "s": 5 }]));
        assert!(encoded["t"][0].get("i").is_none());
    }

    #[test]
    fn structural_segments_have_no_alignment_associations() {
        let mut summary = block(0, "name | value");
        summary.kind = "table".to_string();
        let prepared = vec![prepare_block(0, &summary, &[]).unwrap()];
        let output = validate_response(
            CompactPlanningResponse {
                version: 3,
                segments: vec![CompactPlanningSegment {
                    block: 0,
                    spoken_text: "The table compares names and values.".to_string(),
                }],
            },
            &prepared,
        )
        .unwrap();
        assert_eq!(output[0].mode, "summary");
        assert!(output[0].alignment_hints.is_empty());
    }

    #[test]
    fn catalog_resolution_prefers_priority_and_falls_back_before_dispatch() {
        let priority = resolve_profile_from_catalog(
            &json!({ "data": [{
                "model": "gpt-5.6-sol",
                "serviceTiers": [{ "id": "priority" }]
            }] }),
            "gpt-5.6-sol".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(priority.service_tier, PlanningServiceTier::Priority);

        let standard = resolve_profile_from_catalog(
            &json!({ "data": [{ "model": "gpt-5.6-sol", "serviceTiers": [] }] }),
            "gpt-5.6-sol".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(standard.service_tier, PlanningServiceTier::Standard);
    }

    #[test]
    fn catalog_resolution_rejects_missing_sol() {
        let error = resolve_profile_from_catalog(
            &json!({ "data": [{ "model": "gpt-5.6" }] }),
            "gpt-5.6-sol".to_string(),
            None,
        )
        .unwrap_err();
        assert!(error.contains("requires gpt-5.6-sol"));
    }
}
