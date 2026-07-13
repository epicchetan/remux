use std::collections::{HashMap, HashSet};
use std::env;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Instant;

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

pub(crate) const NARRATION_BASE_INSTRUCTIONS_V2: &str = "You produce speakable narration for supplied Markdown blocks.\n\nReturn only JSON matching the supplied output schema. Do not return Markdown,\ncommentary, explanations, confidence, or reasoning. Do not use tools, browse,\nread files, or refer to this task.\n\nThe input is compact JSON with version v and ordered blocks b. Each block has:\n- i: its zero-based index in this request;\n- k: p paragraph, h heading, li list item, q blockquote, c code, tb table, or d diagram;\n- m: n for pronunciation normalization or s for structural summary;\n- x: exact display text;\n- optional t: inline technical ranges with kind k and UTF-16 offsets s inclusive and e exclusive.\n\nReturn version v equal to 3 and one output segment in s for every input block,\nin the same order. Each segment has b, the unchanged input block index, and x,\nnon-empty spoken text.\n\nNever choose a mode, omit a block, merge blocks, split a block, reproduce a\nrenderer identifier, or output source alignment.\n\nFor mode n:\n- preserve the source meaning and sentence order;\n- preserve every display word outside supplied technical ranges, in the same order;\n- rewrite only technical notation inside supplied ranges and the minimum adjacent grammar required for natural speech;\n- pronounce units, symbols, URLs, identifiers, abbreviations, and inline code naturally rather than reading punctuation literally;\n- do not summarize, shorten, expand with new facts, or paraphrase ordinary prose.\n\nFor mode s:\n- produce a concise natural explanation of the complete structure and its meaning;\n- preserve material behavior, relationships, ordering, quantities, and caveats;\n- do not read Markdown syntax, code punctuation, type syntax, table separators,\n  every table cell, or every diagram edge literally;\n- keep the summary proportional to the source and do not add facts.\n\nKeep technical names recognizable while making their pronunciation natural.";

pub(crate) const COMPACT_PLAN_SCHEMA_V3_JSON: &str = r#"{"type":"object","additionalProperties":false,"required":["v","s"],"properties":{"v":{"type":"integer","enum":[3]},"s":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["b","x"],"properties":{"b":{"type":"integer"},"x":{"type":"string"}}}}}}"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PlanningServiceTier {
    Priority,
    Standard,
}

impl PlanningServiceTier {
    pub(crate) fn persisted(self) -> &'static str {
        match self {
            Self::Priority => "priority",
            Self::Standard => "standard",
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
            "id": "narrate-codex-kokoro-source-map-v1",
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

pub(crate) struct PlanningCoordinator {
    failed: AtomicBool,
    operation_ids: Mutex<HashSet<String>>,
}

impl PlanningCoordinator {
    fn new() -> Self {
        Self {
            failed: AtomicBool::new(false),
            operation_ids: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) fn register(&self, operation_id: &str) -> Result<(), String> {
        let mut operations = self
            .operation_ids
            .lock()
            .map_err(|_| "narration planning coordinator poisoned".to_string())?;
        if self.failed.load(Ordering::SeqCst) {
            return Err("narration planning cancelled after a sibling failed".to_string());
        }
        operations.insert(operation_id.to_string());
        Ok(())
    }

    pub(crate) fn unregister(&self, operation_id: &str) {
        if let Ok(mut operations) = self.operation_ids.lock() {
            operations.remove(operation_id);
        }
    }

    fn fail(&self) -> Vec<String> {
        if self.failed.swap(true, Ordering::SeqCst) {
            return Vec::new();
        }
        self.operation_ids
            .lock()
            .map(|operations| operations.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn failed(&self) -> bool {
        self.failed.load(Ordering::SeqCst)
    }
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

pub(crate) fn resolve_planning_profile() -> Result<NarrationPlanningProfile, String> {
    let requested_model = env::var("REMUX_NARRATION_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "gpt-5.6-sol".to_string());
    if requested_model != "gpt-5.6-sol" {
        return Err(format!(
            "unsupported narration model override {requested_model}; expected gpt-5.6-sol"
        ));
    }

    let requested_tier = env::var("REMUX_NARRATION_SERVICE_TIER")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let service_tier = match requested_tier.as_deref() {
        Some("priority") | None => PlanningServiceTier::Priority,
        Some("standard") => PlanningServiceTier::Standard,
        Some(other) => return Err(format!("unsupported narration service tier {other}")),
    };

    Ok(NarrationPlanningProfile {
        provider: "codex-structured-inference",
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
    let coordinator = Arc::new(PlanningCoordinator::new());
    let (result_tx, result_rx) = mpsc::channel();
    let worker_count = batches.len().min(MAX_CONCURRENT_PLANNING_BATCHES);

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let inner = inner.clone();
            let next = next.clone();
            let coordinator = coordinator.clone();
            let result_tx = result_tx.clone();
            let batches = &batches;
            let profile = profile.clone();
            scope.spawn(move || {
                loop {
                    let batch_index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(batch) = batches.get(batch_index) else {
                        break;
                    };
                    if coordinator.failed() || inner.cancelled(artifact_key) {
                        let _ =
                            result_tx.send((batch_index, Err("narration cancelled".to_string())));
                        break;
                    }
                    let result =
                        plan_batch(&inner, artifact_key, batch, targets, &profile, &coordinator);
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
                    if first_error.is_none() {
                        first_error = Some(error);
                        next.store(batches.len(), Ordering::SeqCst);
                        inner.cancel_planning_operations(coordinator.fail());
                    }
                }
            }
        }
        if let Some(error) = first_error {
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
    coordinator: &PlanningCoordinator,
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

    let completed = inner.structured_generate(
        artifact_key,
        batch.index,
        NARRATION_BASE_INSTRUCTIONS_V2,
        &compact_json,
        compact_plan_schema_v3(),
        profile,
        coordinator,
    )?;
    let completed_bytes = serde_json::to_vec(&completed)
        .map_err(|error| format!("failed to encode Codex narration response: {error}"))?;
    if completed_bytes.len() > MAX_PLANNING_RESPONSE_BYTES {
        return Err(format!(
            "narration planning response is too large: {}>{MAX_PLANNING_RESPONSE_BYTES}",
            completed_bytes.len()
        ));
    }
    let response: CompactPlanningResponse = serde_json::from_value(completed)
        .map_err(|error| format!("Codex returned invalid compact narration JSON: {error}"))?;
    let output = validate_response(response, &prepared)?;
    eprintln!(
        "[narrate] planning batch={} blocks={} request_bytes={} response_bytes={} completion_ms={}",
        batch.index,
        prepared.len(),
        compact_json.len(),
        completed_bytes.len(),
        started.elapsed().as_millis(),
    );
    Ok(output)
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

    #[test]
    fn first_planning_failure_closes_registration_and_returns_siblings_once() {
        let coordinator = PlanningCoordinator::new();
        coordinator.register("one").unwrap();
        coordinator.register("two").unwrap();
        let mut operations = coordinator.fail();
        operations.sort();
        assert_eq!(operations, vec!["one".to_string(), "two".to_string()]);
        assert!(coordinator.register("three").is_err());
        assert!(coordinator.fail().is_empty());
    }
}
