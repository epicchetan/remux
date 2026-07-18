use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

use remux_extension_rpc::Peer as ExtensionRpcPeer;
use remux_tts::{
    NarrationBlockKind, NarrationDocument, STRUCTURAL_TRANSCRIPT_OUTPUT_SCHEMA_VERSION,
    STRUCTURAL_TRANSCRIPT_PLAN_SCHEMA_VERSION, STRUCTURAL_TRANSCRIPT_PROMPT_VERSION,
    STRUCTURAL_TRANSCRIPT_WINDOW_PLANNER_VERSION, StructuralTranscriptBlock,
    StructuralTranscriptPlan, StructuralTranscriptWindowRecord, canonical_sha256,
    empty_structural_transcript_plan, validate_structural_transcript_plan,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::inference_gate::InferenceGate;
use crate::pronunciation_audit::{
    REVIEWER_EFFORT, REVIEWER_MODEL, REVIEWER_PROFILE_DIGEST, REVIEWER_SERVICE_TIER,
};

pub(crate) const MAX_TRANSCRIPT_CORE_BLOCKS: usize = 20;
pub(crate) const MAX_TRANSCRIPT_CORE_UTF16: usize = 4_000;
pub(crate) const MAX_TRANSCRIPT_CONTEXT_UTF16: usize = 1_024;
pub(crate) const MAX_TRANSCRIPT_INPUT_BYTES: usize = 96 * 1024;
pub(crate) const MAX_TRANSCRIPT_CONCURRENCY: usize = 3;
pub(crate) const TRANSCRIPT_WINDOW_TIMEOUT: Duration = Duration::from_secs(240);

const GENERATE_METHOD: &str = "remux/codex/inference/structured/generate";
const CANCEL_METHOD: &str = "remux/codex/inference/structured/cancel";
const PROMPT: &str = include_str!("../prompts/structural-transcript-v2.txt");
const OUTPUT_SCHEMA: &str = include_str!("../schemas/structural-transcript-output-v2.json");

type TranscriptPredicate = Arc<dyn Fn() -> bool + Send + Sync>;
type RegisterOperation = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;
type UnregisterOperation = Arc<dyn Fn(&str) + Send + Sync>;
type WindowCompleted = Arc<dyn Fn(usize, usize) + Send + Sync>;

#[derive(Clone)]
pub(crate) struct TranscriptCallbacks {
    pub(crate) cancelled: TranscriptPredicate,
    pub(crate) deadline_exceeded: TranscriptPredicate,
    pub(crate) register_operation: RegisterOperation,
    pub(crate) unregister_operation: UnregisterOperation,
    pub(crate) window_completed: WindowCompleted,
}

pub(crate) struct StructuralTranscriptResult {
    pub(crate) plan: StructuralTranscriptPlan,
    pub(crate) plan_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptInput {
    version: u32,
    window_id: u32,
    context: Vec<TranscriptContext>,
    blocks: Vec<TranscriptInputBlock>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptContext {
    role: &'static str,
    block_id: String,
    kind: &'static str,
    text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptInputBlock {
    block_id: String,
    kind: &'static str,
    text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptOutput {
    version: u32,
    window_id: u32,
    blocks: Vec<StructuralTranscriptBlock>,
}

#[derive(Clone, Debug)]
struct TranscriptWindow {
    input: TranscriptInput,
    input_sha256: String,
}

#[derive(Debug)]
struct WindowResult {
    window_id: usize,
    operation_id: String,
    result: Result<ValidatedWindow, String>,
}

#[derive(Clone, Debug)]
struct ValidatedWindow {
    output_sha256: String,
    blocks: Vec<StructuralTranscriptBlock>,
}

pub(crate) fn structural_transcript_profile_descriptor() -> Value {
    json!({
        "model": REVIEWER_MODEL,
        "serviceTier": REVIEWER_SERVICE_TIER,
        "effort": REVIEWER_EFFORT,
        "profileDigest": REVIEWER_PROFILE_DIGEST,
        "promptVersion": STRUCTURAL_TRANSCRIPT_PROMPT_VERSION,
        "outputSchemaVersion": STRUCTURAL_TRANSCRIPT_OUTPUT_SCHEMA_VERSION,
        "windowPlannerVersion": STRUCTURAL_TRANSCRIPT_WINDOW_PLANNER_VERSION,
    })
}

pub(crate) fn run_structural_transcript(
    host_rpc: &ExtensionRpcPeer,
    artifact_key: &str,
    document: &NarrationDocument,
    gate: InferenceGate,
    callbacks: TranscriptCallbacks,
) -> Result<StructuralTranscriptResult, String> {
    if (callbacks.cancelled)() {
        return Err("narration cancelled".to_string());
    }
    let windows = build_windows(document)?;
    let total = windows.len();
    (callbacks.window_completed)(0, total);
    if windows.is_empty() {
        let plan = empty_structural_transcript_plan(document, REVIEWER_PROFILE_DIGEST)?;
        return Ok(StructuralTranscriptResult {
            plan_sha256: plan.sha256()?,
            plan,
        });
    }
    let schema: Value = serde_json::from_str(OUTPUT_SCHEMA)
        .map_err(|error| format!("invalid checked-in structural transcript schema: {error}"))?;
    let windows = Arc::new(windows);
    let (result_tx, result_rx) = mpsc::channel::<WindowResult>();
    let mut queued = (0..total).collect::<VecDeque<_>>();
    let mut active = HashMap::<usize, thread::JoinHandle<()>>::new();
    let mut validated = BTreeMap::<usize, ValidatedWindow>::new();
    let mut first_error = None::<String>;

    while validated.len() < total && first_error.is_none() {
        if (callbacks.cancelled)() {
            first_error = Some("narration cancelled".to_string());
            break;
        }
        if (callbacks.deadline_exceeded)() {
            first_error = Some("narration job deadline exceeded".to_string());
            break;
        }
        while active.len() < MAX_TRANSCRIPT_CONCURRENCY && !queued.is_empty() {
            let window_id = queued.pop_front().unwrap();
            let operation_id = format!("narration:{artifact_key}:transcript:{window_id}");
            if let Err(error) = (callbacks.register_operation)(&operation_id) {
                first_error = Some(error);
                break;
            }
            let host_rpc = host_rpc.clone();
            let result_tx = result_tx.clone();
            let windows = windows.clone();
            let schema = schema.clone();
            let gate = gate.clone();
            let cancelled = callbacks.cancelled.clone();
            let deadline_exceeded = callbacks.deadline_exceeded.clone();
            let thread_operation_id = operation_id.clone();
            let handle = thread::spawn(move || {
                let result = gate
                    .acquire(cancelled.as_ref(), deadline_exceeded.as_ref())
                    .and_then(|_permit| {
                        invoke_window(&host_rpc, &thread_operation_id, &windows[window_id], schema)
                    });
                let _ = result_tx.send(WindowResult {
                    window_id,
                    operation_id: thread_operation_id,
                    result,
                });
            });
            active.insert(window_id, handle);
        }
        if first_error.is_some() {
            break;
        }
        match result_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(completed) => {
                if let Some(handle) = active.remove(&completed.window_id) {
                    let _ = handle.join();
                }
                (callbacks.unregister_operation)(&completed.operation_id);
                match completed.result {
                    Ok(result) => {
                        validated.insert(completed.window_id, result);
                        (callbacks.window_completed)(validated.len(), total);
                    }
                    Err(error) => first_error = Some(error),
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                first_error =
                    Some("structuralTranscriptFailed: transcript workers disconnected".to_string())
            }
        }
    }

    if let Some(error) = first_error {
        for window_id in active.keys().copied().collect::<Vec<_>>() {
            cancel_operation(
                host_rpc,
                &format!("narration:{artifact_key}:transcript:{window_id}"),
            );
        }
        for (window_id, handle) in active {
            let _ = handle.join();
            (callbacks.unregister_operation)(&format!(
                "narration:{artifact_key}:transcript:{window_id}"
            ));
        }
        return Err(error);
    }

    let mut records = Vec::with_capacity(total);
    let mut blocks = Vec::new();
    for (window_id, window) in windows.iter().enumerate() {
        let result = validated
            .remove(&window_id)
            .ok_or_else(|| "structuralTranscriptFailed: window result missing".to_string())?;
        records.push(StructuralTranscriptWindowRecord {
            window_id: window_id as u32,
            input_sha256: window.input_sha256.clone(),
            output_sha256: result.output_sha256,
        });
        blocks.extend(result.blocks);
    }
    let plan = StructuralTranscriptPlan {
        schema_version: STRUCTURAL_TRANSCRIPT_PLAN_SCHEMA_VERSION,
        source_document_hash: remux_tts::narration_document_hash(document)?,
        generator_profile_hash: REVIEWER_PROFILE_DIGEST.to_string(),
        prompt_version: STRUCTURAL_TRANSCRIPT_PROMPT_VERSION,
        output_schema_version: STRUCTURAL_TRANSCRIPT_OUTPUT_SCHEMA_VERSION,
        window_planner_version: STRUCTURAL_TRANSCRIPT_WINDOW_PLANNER_VERSION,
        windows: records,
        blocks,
    };
    plan.validate_versions()?;
    validate_structural_transcript_plan(document, &plan)?;
    Ok(StructuralTranscriptResult {
        plan_sha256: plan.sha256()?,
        plan,
    })
}

pub(crate) fn validate_cached_structural_transcript_plan(
    document: &NarrationDocument,
    plan: &StructuralTranscriptPlan,
) -> Result<(), String> {
    plan.validate_versions()?;
    if plan.generator_profile_hash != REVIEWER_PROFILE_DIGEST {
        return Err("structuralTranscriptBaselineDrift: cached profile changed".to_string());
    }
    let windows = build_windows(document)?;
    if windows.len() != plan.windows.len() {
        return Err("structuralTranscriptPlanInvalid: cached window count changed".to_string());
    }
    let mut block_cursor = 0usize;
    for (window, record) in windows.iter().zip(&plan.windows) {
        if record.window_id != window.input.window_id || record.input_sha256 != window.input_sha256
        {
            return Err("structuralTranscriptPlanInvalid: cached input hash changed".to_string());
        }
        let count = window.input.blocks.len();
        let end = block_cursor.saturating_add(count);
        let blocks = plan
            .blocks
            .get(block_cursor..end)
            .ok_or_else(|| "structuralTranscriptPlanInvalid: cached blocks missing".to_string())?
            .to_vec();
        let output = TranscriptOutput {
            version: 2,
            window_id: window.input.window_id,
            blocks,
        };
        let validated = validate_output(window, output)?;
        if validated.output_sha256 != record.output_sha256 {
            return Err("structuralTranscriptPlanInvalid: cached output hash changed".to_string());
        }
        block_cursor = end;
    }
    if block_cursor != plan.blocks.len() {
        return Err("structuralTranscriptPlanInvalid: cached block count changed".to_string());
    }
    validate_structural_transcript_plan(document, plan)?;
    Ok(())
}

fn invoke_window(
    host_rpc: &ExtensionRpcPeer,
    operation_id: &str,
    window: &TranscriptWindow,
    schema: Value,
) -> Result<ValidatedWindow, String> {
    let input = serde_json::to_string(&window.input)
        .map_err(|error| format!("failed to encode structural transcript input: {error}"))?;
    let response = host_rpc
        .request(
            GENERATE_METHOD,
            Some(json!({
                "apiVersion": 1,
                "model": REVIEWER_MODEL,
                "serviceTier": REVIEWER_SERVICE_TIER,
                "effort": REVIEWER_EFFORT,
                "operationId": operation_id,
                "instructions": PROMPT,
                "input": input,
                "outputSchema": schema,
            })),
            TRANSCRIPT_WINDOW_TIMEOUT,
        )
        .map_err(|error| format!("structuralTranscriptFailed: {error}"))?;
    validate_gateway_envelope(&response)?;
    let output: TranscriptOutput = serde_json::from_value(
        response
            .get("value")
            .cloned()
            .ok_or_else(|| "structuralTranscriptFailed: response missing value".to_string())?,
    )
    .map_err(|error| format!("structuralTranscriptInvalid: {error}"))?;
    validate_output(window, output)
}

fn validate_output(
    window: &TranscriptWindow,
    output: TranscriptOutput,
) -> Result<ValidatedWindow, String> {
    if output.version != 2 || output.window_id != window.input.window_id {
        return Err("structuralTranscriptInvalid: output window identity mismatch".to_string());
    }
    let expected_ids = window
        .input
        .blocks
        .iter()
        .map(|block| block.block_id.as_str())
        .collect::<Vec<_>>();
    let actual_ids = output
        .blocks
        .iter()
        .map(|block| block.block_id.as_str())
        .collect::<Vec<_>>();
    if actual_ids != expected_ids {
        return Err(
            "structuralTranscriptInvalid: output blocks changed identity or order".to_string(),
        );
    }

    for block in &output.blocks {
        if block.transcript.len() > 64 * 1024
            || block.transcript.trim().is_empty()
            || block.transcript.contains('\0')
            || !block.transcript.chars().any(char::is_alphanumeric)
        {
            return Err(
                "structuralTranscriptTooLarge: one transcript is empty or exceeds 64 KiB"
                    .to_string(),
            );
        }
    }
    Ok(ValidatedWindow {
        output_sha256: canonical_sha256(&output)?,
        blocks: output.blocks,
    })
}

fn build_windows(document: &NarrationDocument) -> Result<Vec<TranscriptWindow>, String> {
    let structural = document
        .blocks
        .iter()
        .enumerate()
        .filter(|(_, block)| block.kind.structural())
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut windows = Vec::new();
    let mut cursor = 0usize;
    while cursor < structural.len() {
        let start = cursor;
        let mut utf16 = 0usize;
        while cursor < structural.len() {
            let block_utf16 = document.blocks[structural[cursor]]
                .text
                .encode_utf16()
                .count();
            let next_blocks = cursor + 1 - start;
            let oversized_single = cursor == start;
            if !oversized_single
                && (next_blocks > MAX_TRANSCRIPT_CORE_BLOCKS
                    || utf16 + block_utf16 > MAX_TRANSCRIPT_CORE_UTF16)
            {
                break;
            }
            utf16 += block_utf16;
            cursor += 1;
        }
        let indices = &structural[start..cursor];
        let input = TranscriptInput {
            version: 2,
            window_id: windows.len() as u32,
            context: build_context(
                document,
                *indices.first().unwrap(),
                *indices.last().unwrap(),
            ),
            blocks: indices
                .iter()
                .map(|index| {
                    let block = &document.blocks[*index];
                    TranscriptInputBlock {
                        block_id: block.id.clone(),
                        kind: block_kind(block.kind),
                        text: block.text.clone(),
                    }
                })
                .collect(),
        };
        let bytes = serde_json::to_vec(&input)
            .map_err(|error| format!("failed to encode structural transcript window: {error}"))?;
        if bytes.len() > MAX_TRANSCRIPT_INPUT_BYTES {
            return Err(format!(
                "structuralTranscriptInputTooLarge: window {} is {} bytes",
                input.window_id,
                bytes.len()
            ));
        }
        windows.push(TranscriptWindow {
            input_sha256: canonical_sha256(&input)?,
            input,
        });
    }
    Ok(windows)
}

fn build_context(
    document: &NarrationDocument,
    first_block: usize,
    last_block: usize,
) -> Vec<TranscriptContext> {
    let mut candidates = Vec::<(&'static str, usize, bool)>::new();
    if let Some((index, _)) = document.blocks[..first_block]
        .iter()
        .enumerate()
        .rev()
        .find(|(_, block)| block.kind == NarrationBlockKind::Heading)
    {
        candidates.push(("heading", index, true));
    }
    if first_block > 0 {
        candidates.push(("previous", first_block - 1, true));
    }
    if last_block + 1 < document.blocks.len() {
        candidates.push(("next", last_block + 1, false));
    }
    let mut remaining = MAX_TRANSCRIPT_CONTEXT_UTF16;
    let mut output = Vec::new();
    for (role, index, keep_tail) in candidates {
        if remaining == 0 {
            break;
        }
        let block = &document.blocks[index];
        let text = trim_context(&block.text, remaining, keep_tail);
        let used = text.encode_utf16().count();
        if used == 0 {
            continue;
        }
        remaining = remaining.saturating_sub(used);
        output.push(TranscriptContext {
            role,
            block_id: block.id.clone(),
            kind: block_kind(block.kind),
            text,
        });
    }
    output
}

fn trim_context(text: &str, max_utf16: usize, keep_tail: bool) -> String {
    if text.encode_utf16().count() <= max_utf16 {
        return text.to_string();
    }
    let characters = text.char_indices().collect::<Vec<_>>();
    if keep_tail {
        let mut used = 0usize;
        let mut start = text.len();
        for (index, character) in characters.into_iter().rev() {
            if used + character.len_utf16() > max_utf16 {
                break;
            }
            used += character.len_utf16();
            start = index;
        }
        text[start..].trim().to_string()
    } else {
        let mut used = 0usize;
        let mut end = 0usize;
        for (index, character) in characters {
            if used + character.len_utf16() > max_utf16 {
                break;
            }
            used += character.len_utf16();
            end = index + character.len_utf8();
        }
        text[..end].trim().to_string()
    }
}

fn block_kind(kind: NarrationBlockKind) -> &'static str {
    match kind {
        NarrationBlockKind::Paragraph => "paragraph",
        NarrationBlockKind::Heading => "heading",
        NarrationBlockKind::ListItem => "listItem",
        NarrationBlockKind::Blockquote => "blockquote",
        NarrationBlockKind::Code => "code",
        NarrationBlockKind::Table => "table",
        NarrationBlockKind::Diagram => "diagram",
    }
}

fn validate_gateway_envelope(response: &Value) -> Result<(), String> {
    let digest = response
        .get("profileDigest")
        .and_then(Value::as_str)
        .map(|digest| {
            if digest.starts_with("sha256-") {
                digest.to_string()
            } else {
                format!("sha256-{digest}")
            }
        });
    if response.get("model").and_then(Value::as_str) != Some(REVIEWER_MODEL)
        || response.get("serviceTier").and_then(Value::as_str) != Some(REVIEWER_SERVICE_TIER)
        || response
            .get("effort")
            .and_then(Value::as_str)
            .is_some_and(|effort| effort != REVIEWER_EFFORT)
        || digest.as_deref() != Some(REVIEWER_PROFILE_DIGEST)
    {
        return Err("structuralTranscriptProfileMismatch: live profile changed".to_string());
    }
    Ok(())
}

fn cancel_operation(host_rpc: &ExtensionRpcPeer, operation_id: &str) {
    let _ = host_rpc.request(
        CANCEL_METHOD,
        Some(json!({ "operationId": operation_id })),
        Duration::from_secs(5),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use remux_tts::{HighlightMode, NarrationBlock, OffsetEncoding};

    fn structural_document(blocks: usize) -> NarrationDocument {
        NarrationDocument {
            schema_version: 1,
            offset_encoding: OffsetEncoding::Utf16CodeUnit,
            blocks: (0..blocks)
                .map(|index| NarrationBlock {
                    id: format!("md:{index}"),
                    kind: if index % 2 == 0 {
                        NarrationBlockKind::Code
                    } else {
                        NarrationBlockKind::Table
                    },
                    text: "hello world".to_string(),
                    highlight_mode: HighlightMode::Block,
                })
                .collect(),
        }
    }

    #[test]
    fn windows_are_bounded_and_cover_blocks_once() {
        let document = structural_document(21);
        let windows = build_windows(&document).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].input.blocks.len(), 20);
        assert_eq!(windows[1].input.blocks.len(), 1);
    }

    #[test]
    fn strict_schema_has_items_at_every_array_level() {
        let schema: Value = serde_json::from_str(OUTPUT_SCHEMA).unwrap();
        assert!(schema["properties"]["blocks"]["items"].is_object());
        assert!(schema["properties"]["blocks"]["items"]["properties"]["transcript"].is_object());
        assert!(PROMPT.contains("Do not emit phonemes"));
    }

    #[test]
    fn output_must_preserve_block_order() {
        let document = structural_document(1);
        let window = build_windows(&document).unwrap().remove(0);
        let output = TranscriptOutput {
            version: 2,
            window_id: 0,
            blocks: vec![StructuralTranscriptBlock {
                block_id: "wrong".to_string(),
                transcript: "It loads the model.".to_string(),
            }],
        };
        assert!(validate_output(&window, output).is_err());
    }

    #[test]
    fn output_is_text_only_and_rejects_empty_speech() {
        let document = structural_document(1);
        let window = build_windows(&document).unwrap().remove(0);
        let empty = TranscriptOutput {
            version: 2,
            window_id: 0,
            blocks: vec![StructuralTranscriptBlock {
                block_id: "md:0".to_string(),
                transcript: "...".to_string(),
            }],
        };
        assert!(validate_output(&window, empty).is_err());
        let spoken = TranscriptOutput {
            version: 2,
            window_id: 0,
            blocks: vec![StructuralTranscriptBlock {
                block_id: "md:0".to_string(),
                transcript: "It loads the model.".to_string(),
            }],
        };
        validate_output(&window, spoken).unwrap();
    }
}
