use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

use remux_extension_rpc::Peer as ExtensionRpcPeer;
use remux_tts::{
    AUDIT_WINDOW_PLANNER_VERSION, BaselineNarration, BaselinePhoneState, BaselineUnresolvedReason,
    DIRECT_PHONE_ALPHABET_VERSION, DIRECT_PHONE_VALIDATOR_VERSION,
    KOKORO_REVIEW_LEXICAL_ALPHABET_V1, KokoroVocabulary, NarrationBlockKind, NarrationDocument,
    PRONUNCIATION_OUTPUT_SCHEMA_VERSION, PRONUNCIATION_PLAN_SCHEMA_VERSION,
    PRONUNCIATION_PROMPT_VERSION, PronunciationPatchKind, PronunciationWindowRecord,
    ReviewedPronunciationPatch, ReviewedPronunciationPlan, SourceWordId, apply_pronunciation_plan,
    canonical_sha256, direct_phone_alphabet_sha256, validate_direct_phone_string, word_fingerprint,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::inference_gate::InferenceGate;

pub(crate) const REVIEWER_MODEL: &str = "gpt-5.6-sol";
pub(crate) const REVIEWER_SERVICE_TIER: &str = "priority";
pub(crate) const REVIEWER_EFFORT: &str = "low";
pub(crate) const REVIEWER_PROFILE_DIGEST: &str =
    "sha256-498e383cb5c7b7bc1dfe68df5667d8475156e67190d949e3b90029f52cf4a59c";

pub(crate) const MAX_AUDIT_CORE_WORDS: usize = 500;
pub(crate) const MAX_AUDIT_CORE_UTF16: usize = 4_000;
pub(crate) const MAX_AUDIT_CORE_BLOCKS: usize = 20;
pub(crate) const MAX_AUDIT_CONTEXT_UTF16: usize = 1_024;
pub(crate) const MAX_AUDIT_INPUT_BYTES: usize = 96 * 1024;
pub(crate) const MAX_AUDIT_CONCURRENCY: usize = 3;
pub(crate) const AUDIT_WINDOW_TIMEOUT: Duration = Duration::from_secs(240);

const GENERATE_METHOD: &str = "remux/codex/inference/structured/generate";
const PROFILE_METHOD: &str = "remux/codex/inference/structured/profile/validate";
const CANCEL_METHOD: &str = "remux/codex/inference/structured/cancel";
const PROMPT: &str = include_str!("../prompts/pronunciation-audit-v4.txt");
const OUTPUT_SCHEMA: &str = include_str!("../schemas/pronunciation-audit-output-v4.json");

type AuditPredicate = Arc<dyn Fn() -> bool + Send + Sync>;
type RegisterOperation = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;
type UnregisterOperation = Arc<dyn Fn(&str) + Send + Sync>;
type WindowCompleted = Arc<dyn Fn(usize, usize) + Send + Sync>;

#[derive(Clone)]
pub(crate) struct AuditCallbacks {
    pub(crate) cancelled: AuditPredicate,
    pub(crate) deadline_exceeded: AuditPredicate,
    pub(crate) register_operation: RegisterOperation,
    pub(crate) unregister_operation: UnregisterOperation,
    pub(crate) window_completed: WindowCompleted,
}

pub(crate) struct AuditResult {
    pub(crate) plan: ReviewedPronunciationPlan,
    pub(crate) plan_sha256: String,
    pub(crate) redundant_direct_patches: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditInput {
    version: u32,
    window_id: u32,
    phone_alphabet_version: u32,
    allowed_phone_symbols: &'static str,
    context: Vec<AuditContext>,
    core: Vec<AuditCore>,
    words: Vec<AuditWord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditContext {
    role: &'static str,
    block_id: String,
    text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditCore {
    block_id: String,
    kind: &'static str,
    text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditWord {
    word_id: SourceWordId,
    block_id: String,
    sentence_id: String,
    text: String,
    baseline: AuditBaseline,
    tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditBaseline {
    status: &'static str,
    phones: String,
    reason: Option<&'static str>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuditOutput {
    version: u32,
    window_id: u32,
    phoneme_patches: Vec<AuditPhonemePatch>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuditPhonemePatch {
    word_id: SourceWordId,
    phones: String,
}

#[derive(Clone, Debug)]
struct AuditUnit {
    block: usize,
    first_word: usize,
    last_word: usize,
    byte_start: usize,
    byte_end: usize,
}

#[derive(Clone, Debug)]
struct AuditWindow {
    fingerprints: BTreeMap<SourceWordId, remux_tts::SourceWordFingerprint>,
    input: AuditInput,
    input_sha256: String,
    word_ids: BTreeSet<SourceWordId>,
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
    patches: Vec<ReviewedPronunciationPatch>,
    redundant_direct_patches: usize,
}

pub(crate) fn reviewer_profile_descriptor(kokoro_vocabulary_sha256: &str) -> Value {
    json!({
        "model": REVIEWER_MODEL,
        "serviceTier": REVIEWER_SERVICE_TIER,
        "effort": REVIEWER_EFFORT,
        "profileDigest": REVIEWER_PROFILE_DIGEST,
        "promptVersion": PRONUNCIATION_PROMPT_VERSION,
        "outputSchemaVersion": PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
        "windowPlannerVersion": AUDIT_WINDOW_PLANNER_VERSION,
        "phoneAlphabetVersion": DIRECT_PHONE_ALPHABET_VERSION,
        "phoneAlphabetSha256": direct_phone_alphabet_sha256(),
        "kokoroVocabularySha256": kokoro_vocabulary_sha256,
        "directPhoneValidatorVersion": DIRECT_PHONE_VALIDATOR_VERSION,
    })
}

pub(crate) fn run_pronunciation_audit(
    host_rpc: &ExtensionRpcPeer,
    artifact_key: &str,
    document: &NarrationDocument,
    baseline: &BaselineNarration,
    vocabulary: &KokoroVocabulary,
    gate: InferenceGate,
    callbacks: AuditCallbacks,
) -> Result<AuditResult, String> {
    if (callbacks.cancelled)() {
        return Err("narration cancelled".to_string());
    }
    if (callbacks.deadline_exceeded)() {
        return Err("narration job deadline exceeded".to_string());
    }
    validate_live_profile(host_rpc)?;
    if (callbacks.cancelled)() {
        return Err("narration cancelled".to_string());
    }
    if (callbacks.deadline_exceeded)() {
        return Err("narration job deadline exceeded".to_string());
    }
    let windows = build_audit_windows(document, baseline, vocabulary)?;
    let total = windows.len();
    (callbacks.window_completed)(0, total);
    let schema: Value = serde_json::from_str(OUTPUT_SCHEMA)
        .map_err(|error| format!("invalid checked-in pronunciation schema: {error}"))?;
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
        while active.len() < MAX_AUDIT_CONCURRENCY && !queued.is_empty() {
            if (callbacks.cancelled)() {
                first_error = Some("narration cancelled".to_string());
                break;
            }
            if (callbacks.deadline_exceeded)() {
                first_error = Some("narration job deadline exceeded".to_string());
                break;
            }
            let window_id = queued.pop_front().unwrap();
            let operation_id = format!("narration:{artifact_key}:audit:{window_id}");
            if let Err(error) = (callbacks.register_operation)(&operation_id) {
                first_error = Some(error);
                break;
            }
            let host_rpc = host_rpc.clone();
            let result_tx = result_tx.clone();
            let windows = windows.clone();
            let vocabulary = vocabulary.clone();
            let schema = schema.clone();
            let gate = gate.clone();
            let cancelled = callbacks.cancelled.clone();
            let deadline_exceeded = callbacks.deadline_exceeded.clone();
            let thread_operation_id = operation_id.clone();
            let handle = thread::spawn(move || {
                let result = gate
                    .acquire(cancelled.as_ref(), deadline_exceeded.as_ref())
                    .and_then(|_permit| {
                        invoke_window(
                            &host_rpc,
                            &thread_operation_id,
                            &windows[window_id],
                            &vocabulary,
                            schema,
                        )
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
        let completed = result_rx
            .recv_timeout(Duration::from_millis(100))
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => "".to_string(),
                mpsc::RecvTimeoutError::Disconnected => {
                    "pronunciationReviewFailed: audit workers disconnected".to_string()
                }
            });
        match completed {
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
            Err(error) if error.is_empty() => {
                if (callbacks.cancelled)() {
                    first_error = Some("narration cancelled".to_string());
                } else if (callbacks.deadline_exceeded)() {
                    first_error = Some("narration job deadline exceeded".to_string());
                }
            }
            Err(error) => first_error = Some(error),
        }
    }

    if let Some(error) = first_error {
        for window_id in active.keys().copied().collect::<Vec<_>>() {
            let operation_id = format!("narration:{artifact_key}:audit:{window_id}");
            cancel_operation(host_rpc, &operation_id);
        }
        for (window_id, handle) in active {
            let _ = handle.join();
            let operation_id = format!("narration:{artifact_key}:audit:{window_id}");
            (callbacks.unregister_operation)(&operation_id);
        }
        return Err(error);
    }
    if (callbacks.deadline_exceeded)() {
        return Err("narration job deadline exceeded".to_string());
    }

    let mut plan_windows = Vec::with_capacity(total);
    let mut patches = Vec::new();
    let mut redundant_direct_patches = 0usize;
    for (window_id, window) in windows.iter().enumerate() {
        let result = validated
            .remove(&window_id)
            .ok_or_else(|| "pronunciationReviewFailed: window result missing".to_string())?;
        plan_windows.push(PronunciationWindowRecord {
            window_id: window_id as u32,
            input_sha256: window.input_sha256.clone(),
            output_sha256: result.output_sha256,
        });
        redundant_direct_patches += result.redundant_direct_patches;
        patches.extend(result.patches);
    }
    patches.sort_by_key(|patch| patch.target.word_id);
    let plan = ReviewedPronunciationPlan {
        schema_version: PRONUNCIATION_PLAN_SCHEMA_VERSION,
        document_hash: baseline.document_hash.clone(),
        baseline_hash: baseline.baseline_hash.clone(),
        reviewer_profile_hash: REVIEWER_PROFILE_DIGEST.to_string(),
        prompt_version: PRONUNCIATION_PROMPT_VERSION,
        output_schema_version: PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
        window_planner_version: AUDIT_WINDOW_PLANNER_VERSION,
        phone_alphabet_version: DIRECT_PHONE_ALPHABET_VERSION,
        phone_alphabet_sha256: direct_phone_alphabet_sha256(),
        kokoro_vocabulary_sha256: vocabulary.sha256().to_string(),
        direct_phone_validator_version: DIRECT_PHONE_VALIDATOR_VERSION,
        windows: plan_windows,
        patches,
    };
    plan.validate_versions()?;
    apply_pronunciation_plan(baseline.clone(), &plan, vocabulary)?;
    let plan_sha256 = plan.sha256()?;
    Ok(AuditResult {
        plan,
        plan_sha256,
        redundant_direct_patches,
    })
}

fn invoke_window(
    host_rpc: &ExtensionRpcPeer,
    operation_id: &str,
    window: &AuditWindow,
    vocabulary: &KokoroVocabulary,
    schema: Value,
) -> Result<ValidatedWindow, String> {
    let input = serde_json::to_string(&window.input)
        .map_err(|error| format!("failed to encode pronunciation audit input: {error}"))?;
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
            AUDIT_WINDOW_TIMEOUT,
        )
        .map_err(|error| format!("pronunciationReviewFailed: {error}"))?;
    validate_gateway_envelope(&response)?;
    let output: AuditOutput = serde_json::from_value(
        response
            .get("value")
            .cloned()
            .ok_or_else(|| "pronunciationReviewFailed: response missing value".to_string())?,
    )
    .map_err(|error| format!("pronunciationReviewInvalid: {error}"))?;
    validate_output(window, output, vocabulary)
}

fn validate_output(
    window: &AuditWindow,
    output: AuditOutput,
    vocabulary: &KokoroVocabulary,
) -> Result<ValidatedWindow, String> {
    if output.version != 4 || output.window_id != window.input.window_id {
        return Err("pronunciationReviewInvalid: output window identity mismatch".to_string());
    }
    if !strictly_increasing(output.phoneme_patches.iter().map(|patch| patch.word_id)) {
        return Err("pronunciationReviewInvalid: output ids are not strictly ordered".to_string());
    }
    let mut seen = HashSet::new();
    let mut patches = Vec::new();
    let mut effective_phoneme_patches = Vec::new();
    let mut redundant_direct_patches = 0usize;
    for direct in &output.phoneme_patches {
        if !seen.insert(direct.word_id) || !window.word_ids.contains(&direct.word_id) {
            return Err(
                "pronunciationReviewInvalid: direct-phone id is duplicate or out of window"
                    .to_string(),
            );
        }
        let word = window_word(window, direct.word_id)?;
        validate_direct_phone_string(&direct.phones, vocabulary)?;
        if word.baseline.status == "resolved" && direct.phones == word.baseline.phones {
            redundant_direct_patches += 1;
            continue;
        }
        effective_phoneme_patches.push(direct.clone());
        patches.push(ReviewedPronunciationPatch::new(
            output.window_id,
            window_fingerprint(window, direct.word_id)?,
            PronunciationPatchKind::DirectPhones {
                phones: direct.phones.clone(),
            },
        )?);
    }
    patches.sort_by_key(|patch| patch.target.word_id);
    let effective_output = AuditOutput {
        version: output.version,
        window_id: output.window_id,
        phoneme_patches: effective_phoneme_patches,
    };
    Ok(ValidatedWindow {
        output_sha256: canonical_sha256(&effective_output)?,
        patches,
        redundant_direct_patches,
    })
}

fn window_fingerprint(
    window: &AuditWindow,
    word_id: SourceWordId,
) -> Result<remux_tts::SourceWordFingerprint, String> {
    window
        .fingerprints
        .get(&word_id)
        .cloned()
        .ok_or_else(|| "pronunciationReviewInvalid: fingerprint missing".to_string())
}

fn window_word(window: &AuditWindow, word_id: SourceWordId) -> Result<&AuditWord, String> {
    window
        .input
        .words
        .iter()
        .find(|word| word.word_id == word_id)
        .ok_or_else(|| "pronunciationReviewInvalid: unknown word id".to_string())
}

fn strictly_increasing(values: impl Iterator<Item = SourceWordId>) -> bool {
    let mut previous = None;
    for value in values {
        if previous.is_some_and(|previous| previous >= value) {
            return false;
        }
        previous = Some(value);
    }
    true
}

fn validate_live_profile(host_rpc: &ExtensionRpcPeer) -> Result<(), String> {
    let response = host_rpc
        .request(
            PROFILE_METHOD,
            Some(json!({
                "apiVersion": 1,
                "model": REVIEWER_MODEL,
                "serviceTier": REVIEWER_SERVICE_TIER,
                "effort": REVIEWER_EFFORT,
            })),
            Duration::from_secs(30),
        )
        .map_err(|error| format!("pronunciationReviewerUnavailable: {error}"))?;
    validate_gateway_envelope(&response)
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
        return Err("pronunciationReviewerProfileMismatch: live profile changed".to_string());
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

fn build_audit_windows(
    document: &NarrationDocument,
    baseline: &BaselineNarration,
    _vocabulary: &KokoroVocabulary,
) -> Result<Vec<AuditWindow>, String> {
    let mut units = build_units(document, baseline)?;
    loop {
        let mut windows = Vec::new();
        let mut cursor = 0usize;
        let mut restarted = false;
        while cursor < units.len() {
            let start = cursor;
            let mut end = cursor;
            let mut accepted = None;
            while end < units.len() {
                if end > start && forced_window_boundary(document, &units[end - 1], &units[end]) {
                    break;
                }
                let candidate_units = &units[start..=end];
                if !core_bounds(candidate_units, baseline) {
                    break;
                }
                let candidate =
                    make_window(windows.len() as u32, document, baseline, &units, start, end)?;
                let bytes = serde_json::to_vec(&candidate.input)
                    .map_err(|error| format!("failed to encode audit window: {error}"))?;
                if bytes.len() > MAX_AUDIT_INPUT_BYTES {
                    break;
                }
                accepted = Some(candidate);
                end += 1;
            }
            if let Some(window) = accepted {
                cursor = start;
                while cursor < units.len()
                    && units[cursor].last_word <= window.input.words.last().unwrap().word_id.index()
                {
                    cursor += 1;
                }
                windows.push(window);
                continue;
            }
            let unit = units[start].clone();
            if unit.first_word == unit.last_word {
                return Err(
                    "sourceWordAuditTooLarge: one source word exceeds audit input limits"
                        .to_string(),
                );
            }
            let (left, right) = split_unit(document, baseline, &unit)?;
            units.splice(start..=start, [left, right]);
            restarted = true;
            break;
        }
        if restarted {
            continue;
        }
        validate_window_partition(&windows, baseline.words.len())?;
        return Ok(windows);
    }
}

fn build_units(
    document: &NarrationDocument,
    baseline: &BaselineNarration,
) -> Result<Vec<AuditUnit>, String> {
    let mut output = Vec::new();
    for sentence in &baseline.sentences {
        let mut start = sentence.first_word;
        while start <= sentence.last_word {
            let mut end = start;
            while end < sentence.last_word
                && end + 1 - start < MAX_AUDIT_CORE_WORDS
                && baseline.words[end + 1].utf16_end.value()
                    - baseline.words[start].utf16_start.value()
                    <= MAX_AUDIT_CORE_UTF16
            {
                end += 1;
            }
            if end < sentence.last_word {
                end = strongest_boundary(document, baseline, start, end, sentence.last_word);
            }
            output.push(unit_for_range(document, baseline, sentence, start, end)?);
            start = end + 1;
        }
    }
    Ok(output)
}

fn unit_for_range(
    document: &NarrationDocument,
    baseline: &BaselineNarration,
    sentence: &remux_tts::SourceSentence,
    first_word: usize,
    last_word: usize,
) -> Result<AuditUnit, String> {
    let block = sentence.block;
    let text = &document.blocks[block].text;
    let byte_start = if first_word == sentence.first_word {
        utf16_to_byte(text, sentence.utf16_start.value())?
    } else {
        baseline.words[first_word].byte_start.value()
    };
    let byte_end = if last_word == sentence.last_word {
        utf16_to_byte(text, sentence.utf16_end.value())?
    } else {
        baseline.words[last_word].byte_end.value()
    };
    Ok(AuditUnit {
        block,
        first_word,
        last_word,
        byte_start,
        byte_end,
    })
}

fn split_unit(
    document: &NarrationDocument,
    baseline: &BaselineNarration,
    unit: &AuditUnit,
) -> Result<(AuditUnit, AuditUnit), String> {
    let target = unit.first_word + (unit.last_word - unit.first_word) / 2;
    let cut = strongest_boundary(
        document,
        baseline,
        unit.first_word,
        target,
        unit.last_word - 1,
    );
    let left = AuditUnit {
        block: unit.block,
        first_word: unit.first_word,
        last_word: cut,
        byte_start: unit.byte_start,
        byte_end: baseline.words[cut].byte_end.value(),
    };
    let right = AuditUnit {
        block: unit.block,
        first_word: cut + 1,
        last_word: unit.last_word,
        byte_start: baseline.words[cut + 1].byte_start.value(),
        byte_end: unit.byte_end,
    };
    Ok((left, right))
}

fn strongest_boundary(
    document: &NarrationDocument,
    baseline: &BaselineNarration,
    start: usize,
    preferred_end: usize,
    maximum_end: usize,
) -> usize {
    let end = preferred_end.min(maximum_end).max(start);
    let mut best = (0u8, end);
    for index in start..=end {
        if index >= baseline.words.len() - 1
            || baseline.words[index].block != baseline.words[index + 1].block
        {
            continue;
        }
        let block = baseline.words[index].block;
        let separator = &document.blocks[block].text
            [baseline.words[index].byte_end.value()..baseline.words[index + 1].byte_start.value()];
        let next = baseline.words[index + 1].text.to_ascii_lowercase();
        let score = if separator.contains('\n') && document.blocks[block].kind.structural() {
            5
        } else if separator.contains([';', ':']) {
            4
        } else if separator.contains([',', '—', '–']) {
            3
        } else if matches!(
            next.as_str(),
            "and" | "as" | "because" | "but" | "however" | "if" | "or" | "so" | "when" | "while"
        ) {
            2
        } else {
            1
        };
        if score > best.0 || (score == best.0 && index > best.1) {
            best = (score, index);
        }
    }
    best.1
}

fn core_bounds(units: &[AuditUnit], baseline: &BaselineNarration) -> bool {
    let Some(first) = units.first() else {
        return false;
    };
    let last = units.last().unwrap();
    let words = last.last_word + 1 - first.first_word;
    let utf16 = units
        .iter()
        .map(|unit| {
            baseline.words[unit.last_word].utf16_end.value()
                - baseline.words[unit.first_word].utf16_start.value()
        })
        .sum::<usize>();
    let blocks = units
        .iter()
        .map(|unit| unit.block)
        .collect::<HashSet<_>>()
        .len();
    words <= MAX_AUDIT_CORE_WORDS
        && utf16 <= MAX_AUDIT_CORE_UTF16
        && blocks <= MAX_AUDIT_CORE_BLOCKS
}

fn forced_window_boundary(
    document: &NarrationDocument,
    left: &AuditUnit,
    right: &AuditUnit,
) -> bool {
    left.block != right.block
        && (document.blocks[left.block].kind.structural()
            || document.blocks[right.block].kind.structural())
}

#[allow(clippy::too_many_arguments)]
fn make_window(
    window_id: u32,
    document: &NarrationDocument,
    baseline: &BaselineNarration,
    all_units: &[AuditUnit],
    start: usize,
    end: usize,
) -> Result<AuditWindow, String> {
    let units = &all_units[start..=end];
    let mut core = Vec::with_capacity(units.len());
    for unit in units {
        core.push(AuditCore {
            block_id: document.blocks[unit.block].id.clone(),
            kind: block_kind(document.blocks[unit.block].kind),
            text: document.blocks[unit.block].text[unit.byte_start..unit.byte_end].to_string(),
        });
    }
    let mut words = Vec::new();
    let mut fingerprints = BTreeMap::new();
    let mut word_ids = BTreeSet::new();
    for index in units.first().unwrap().first_word..=units.last().unwrap().last_word {
        let word = &baseline.words[index];
        fingerprints.insert(word.id, word_fingerprint(word, &baseline.block_ids)?);
        word_ids.insert(word.id);
        words.push(AuditWord {
            word_id: word.id,
            block_id: document.blocks[word.block].id.clone(),
            sentence_id: baseline.sentences[word.sentence].id.clone(),
            text: word.text.clone(),
            baseline: AuditBaseline {
                status: if word.baseline.resolved() {
                    "resolved"
                } else {
                    "unresolved"
                },
                phones: word.baseline.joined_phones(),
                reason: match &word.baseline {
                    BaselinePhoneState::Resolved { .. } => None,
                    BaselinePhoneState::Unresolved { reason, .. } => Some(match reason {
                        BaselineUnresolvedReason::MissingPhones => "missingPhones",
                        BaselineUnresolvedReason::UnresolvedMarker => "unresolvedMarker",
                        BaselineUnresolvedReason::UnsupportedSymbol => "unsupportedSymbol",
                    }),
                },
            },
            tags: word.tags.clone(),
        });
    }
    let input = AuditInput {
        version: 4,
        window_id,
        phone_alphabet_version: DIRECT_PHONE_ALPHABET_VERSION,
        allowed_phone_symbols: KOKORO_REVIEW_LEXICAL_ALPHABET_V1,
        context: build_context(document, all_units, start, end),
        core,
        words,
    };
    let input_sha256 = canonical_sha256(&input)?;
    Ok(AuditWindow {
        fingerprints,
        input,
        input_sha256,
        word_ids,
    })
}

fn build_context(
    document: &NarrationDocument,
    units: &[AuditUnit],
    start: usize,
    end: usize,
) -> Vec<AuditContext> {
    let first_block = units[start].block;
    let mut candidates = Vec::<(&'static str, usize, String, bool)>::new();
    if let Some((block, heading)) = document.blocks[..first_block]
        .iter()
        .enumerate()
        .rev()
        .find(|(_, block)| block.kind == NarrationBlockKind::Heading)
    {
        candidates.push(("heading", block, heading.text.clone(), true));
    }
    if start > 0 {
        let unit = &units[start - 1];
        candidates.push((
            "previous",
            unit.block,
            document.blocks[unit.block].text[unit.byte_start..unit.byte_end].to_string(),
            true,
        ));
    }
    if end + 1 < units.len() {
        let unit = &units[end + 1];
        candidates.push((
            "next",
            unit.block,
            document.blocks[unit.block].text[unit.byte_start..unit.byte_end].to_string(),
            false,
        ));
    }
    let mut remaining = MAX_AUDIT_CONTEXT_UTF16;
    let mut context = Vec::new();
    for (role, block, text, tail) in candidates {
        if remaining == 0 {
            break;
        }
        let text = trim_context(&text, remaining, tail);
        let used = text.encode_utf16().count();
        if used == 0 {
            continue;
        }
        remaining = remaining.saturating_sub(used);
        context.push(AuditContext {
            role,
            block_id: document.blocks[block].id.clone(),
            text,
        });
    }
    context
}

fn trim_context(text: &str, max_utf16: usize, keep_tail: bool) -> String {
    if text.encode_utf16().count() <= max_utf16 {
        return text.to_string();
    }
    if keep_tail {
        let mut used = 0usize;
        let mut start = text.len();
        for (index, character) in text.char_indices().rev() {
            if used + character.len_utf16() > max_utf16 {
                break;
            }
            used += character.len_utf16();
            start = index;
        }
        text[start..]
            .trim_start_matches(|character: char| !character.is_whitespace())
            .trim()
            .to_string()
    } else {
        let mut used = 0usize;
        let mut end = 0usize;
        for (index, character) in text.char_indices() {
            if used + character.len_utf16() > max_utf16 {
                break;
            }
            used += character.len_utf16();
            end = index + character.len_utf8();
        }
        text[..end]
            .trim_end_matches(|character: char| !character.is_whitespace())
            .trim()
            .to_string()
    }
}

fn validate_window_partition(windows: &[AuditWindow], words: usize) -> Result<(), String> {
    let actual = windows
        .iter()
        .flat_map(|window| window.input.words.iter().map(|word| word.word_id.index()))
        .collect::<Vec<_>>();
    if actual != (0..words).collect::<Vec<_>>()
        || windows.iter().enumerate().any(|(index, window)| {
            window.input.window_id as usize != index || window.input.words.is_empty()
        })
    {
        return Err(
            "pronunciationAuditPlanInvalid: windows do not partition source words".to_string(),
        );
    }
    Ok(())
}

fn utf16_to_byte(text: &str, wanted: usize) -> Result<usize, String> {
    if wanted == 0 {
        return Ok(0);
    }
    let mut utf16 = 0usize;
    for (byte, character) in text.char_indices() {
        if utf16 == wanted {
            return Ok(byte);
        }
        utf16 += character.len_utf16();
    }
    if utf16 == wanted {
        Ok(text.len())
    } else {
        Err("pronunciationAuditPlanInvalid: invalid UTF-16 boundary".to_string())
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

pub(crate) fn validate_cached_plan(
    document: &NarrationDocument,
    baseline: &BaselineNarration,
    vocabulary: &KokoroVocabulary,
    plan: &ReviewedPronunciationPlan,
) -> Result<(), String> {
    plan.validate_versions()?;
    if plan.document_hash != baseline.document_hash
        || plan.baseline_hash != baseline.baseline_hash
        || plan.reviewer_profile_hash != REVIEWER_PROFILE_DIGEST
        || plan.kokoro_vocabulary_sha256 != vocabulary.sha256()
    {
        return Err("pronunciationBaselineDrift: cached plan identity changed".to_string());
    }
    let windows = build_audit_windows(document, baseline, vocabulary)?;
    if windows.len() != plan.windows.len() {
        return Err("pronunciationPlanInvalid: cached window count changed".to_string());
    }
    for (window, record) in windows.iter().zip(&plan.windows) {
        if record.window_id != window.input.window_id || record.input_sha256 != window.input_sha256
        {
            return Err("pronunciationPlanInvalid: cached input hash changed".to_string());
        }
        let output = output_from_plan(record.window_id, plan);
        validate_output(window, output.clone(), vocabulary)?;
        if canonical_sha256(&output)? != record.output_sha256 {
            return Err("pronunciationPlanInvalid: cached output hash changed".to_string());
        }
    }
    apply_pronunciation_plan(baseline.clone(), plan, vocabulary)?;
    Ok(())
}

fn output_from_plan(window_id: u32, plan: &ReviewedPronunciationPlan) -> AuditOutput {
    let mut phoneme_patches = Vec::new();
    for patch in plan
        .patches
        .iter()
        .filter(|patch| patch.window_id == window_id)
    {
        match &patch.correction {
            PronunciationPatchKind::DirectPhones { phones } => {
                phoneme_patches.push(AuditPhonemePatch {
                    word_id: patch.target.word_id,
                    phones: phones.clone(),
                })
            }
        }
    }
    AuditOutput {
        version: 4,
        window_id,
        phoneme_patches,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use remux_tts::{
        HighlightMode, KOKORO_REVIEW_LEXICAL_ALPHABET_V1, NarrationBlock, OffsetEncoding,
        prepare_baseline,
    };

    fn document(words: usize) -> NarrationDocument {
        NarrationDocument {
            schema_version: 1,
            offset_encoding: OffsetEncoding::Utf16CodeUnit,
            blocks: vec![NarrationBlock {
                id: "md:0".to_string(),
                kind: NarrationBlockKind::Paragraph,
                text: (0..words)
                    .map(|index| format!("word{index}"))
                    .collect::<Vec<_>>()
                    .join(" ")
                    + ".",
                highlight_mode: HighlightMode::Text,
            }],
        }
    }

    #[test]
    fn short_document_produces_one_full_word_window() {
        let document = document(20);
        let baseline = prepare_baseline(&document).unwrap();
        let windows =
            build_audit_windows(&document, &baseline, &KokoroVocabulary::pinned()).unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].input.words.len(), 20);
        assert_eq!(
            windows[0].input.allowed_phone_symbols,
            KOKORO_REVIEW_LEXICAL_ALPHABET_V1
        );
        assert_eq!(
            windows[0].input.phone_alphabet_version,
            DIRECT_PHONE_ALPHABET_VERSION
        );
    }

    #[test]
    fn unresolved_misaki_output_is_preserved_for_sol_repair() {
        let document = NarrationDocument {
            schema_version: 1,
            offset_encoding: OffsetEncoding::Utf16CodeUnit,
            blocks: vec![NarrationBlock {
                id: "md:35".to_string(),
                kind: NarrationBlockKind::Code,
                text: "The response was rewritten.".to_string(),
                highlight_mode: HighlightMode::Block,
            }],
        };
        let baseline = prepare_baseline(&document).unwrap();
        let window = build_audit_windows(&document, &baseline, &KokoroVocabulary::pinned())
            .unwrap()
            .remove(0);
        let rewritten = window
            .input
            .words
            .iter()
            .find(|word| word.text == "rewritten")
            .unwrap();
        assert_eq!(rewritten.baseline.status, "unresolved");
        assert_eq!(rewritten.baseline.reason, Some("unsupportedSymbol"));
        assert!(rewritten.baseline.phones.contains('\u{0329}'));
    }

    #[test]
    fn word_bound_splits_without_duplication() {
        let document = document(501);
        let baseline = prepare_baseline(&document).unwrap();
        let windows =
            build_audit_windows(&document, &baseline, &KokoroVocabulary::pinned()).unwrap();
        assert!(windows.len() >= 2);
        validate_window_partition(&windows, 501).unwrap();
    }

    #[test]
    fn strict_output_schema_keeps_array_items() {
        let schema: Value = serde_json::from_str(OUTPUT_SCHEMA).unwrap();
        assert_eq!(schema["properties"]["version"]["type"], "integer");
        assert!(schema["properties"]["phonemePatches"]["items"].is_object());
        let expected_pattern = format!("^[{0}]+(?: [{0}]+)*$", KOKORO_REVIEW_LEXICAL_ALPHABET_V1);
        assert_eq!(
            schema["properties"]["phonemePatches"]["items"]["properties"]["phones"]["pattern"],
            expected_pattern
        );
        assert!(PROMPT.contains("input.allowedPhoneSymbols"));
        assert!(
            serde_json::from_str::<AuditOutput>(include_str!(
                "../schemas/fixtures/pronunciation-audit-output-v4.valid.json"
            ))
            .is_ok()
        );
        assert!(
            serde_json::from_str::<AuditOutput>(include_str!(
                "../schemas/fixtures/pronunciation-audit-output-v4.invalid.json"
            ))
            .is_err()
        );
    }

    #[test]
    fn pronunciation_request_does_not_subscribe_to_raw_text_progress() {
        let document = document(3);
        let vocabulary = KokoroVocabulary::pinned();
        let baseline = prepare_baseline(&document).unwrap();
        let window = build_audit_windows(&document, &baseline, &vocabulary)
            .unwrap()
            .remove(0);
        let window_id = window.input.window_id;
        let peer_slot = Arc::new(std::sync::Mutex::new(None::<ExtensionRpcPeer>));
        let requested_progress = Arc::new(std::sync::Mutex::new(false));
        let peer = ExtensionRpcPeer::new("pronunciation-progress-regression", {
            let peer_slot = peer_slot.clone();
            let requested_progress = requested_progress.clone();
            move |request| {
                let peer = peer_slot.lock().unwrap().clone().unwrap();
                let progress = request["params"].get("progress").is_some();
                *requested_progress.lock().unwrap() = progress;
                if progress {
                    for sequence in 0..300 {
                        peer.resolve(&json!({
                            "jsonrpc": "2.0",
                            "method": "$/progress",
                            "params": {
                                "id": request["id"],
                                "sequence": sequence,
                                "value": { "type": "textDelta", "delta": "x" },
                            },
                        }));
                    }
                }
                peer.resolve(&json!({
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "result": {
                        "model": REVIEWER_MODEL,
                        "serviceTier": REVIEWER_SERVICE_TIER,
                        "effort": REVIEWER_EFFORT,
                        "profileDigest": REVIEWER_PROFILE_DIGEST,
                        "progressFrames": if progress { 300 } else { 0 },
                        "value": {
                            "version": 4,
                            "windowId": window_id,
                            "phonemePatches": [],
                        },
                    },
                }));
                Ok(())
            }
        });
        *peer_slot.lock().unwrap() = Some(peer.clone());

        let schema = serde_json::from_str(OUTPUT_SCHEMA).unwrap();
        let result = invoke_window(&peer, "operation", &window, &vocabulary, schema).unwrap();
        assert!(!*requested_progress.lock().unwrap());
        assert!(result.patches.is_empty());
    }

    #[test]
    fn sparse_output_applies_direct_phones_and_round_trips_as_a_cached_plan() {
        let document = NarrationDocument {
            schema_version: 1,
            offset_encoding: OffsetEncoding::Utf16CodeUnit,
            blocks: vec![NarrationBlock {
                id: "md:0".to_string(),
                kind: NarrationBlockKind::Paragraph,
                text: "Sol parses HTMLAudioElement.".to_string(),
                highlight_mode: HighlightMode::Text,
            }],
        };
        let vocabulary = KokoroVocabulary::pinned();
        let baseline = prepare_baseline(&document).unwrap();
        let windows = build_audit_windows(&document, &baseline, &vocabulary).unwrap();
        let sol = windows[0]
            .input
            .words
            .iter()
            .find(|word| word.text == "Sol")
            .unwrap();
        let html = windows[0]
            .input
            .words
            .iter()
            .find(|word| word.text == "HTMLAudioElement")
            .unwrap();
        let output = AuditOutput {
            version: 4,
            window_id: 0,
            phoneme_patches: vec![
                AuditPhonemePatch {
                    word_id: sol.word_id,
                    phones: "sˈoʊl".to_string(),
                },
                AuditPhonemePatch {
                    word_id: html.word_id,
                    phones: "ˌeɪtʃ tˌiː ˌɛm ˈɛl ˈɔːdioʊ ˈɛləmənt".to_string(),
                },
            ],
        };
        let validated = validate_output(&windows[0], output, &vocabulary).unwrap();
        let plan = ReviewedPronunciationPlan {
            schema_version: PRONUNCIATION_PLAN_SCHEMA_VERSION,
            document_hash: baseline.document_hash.clone(),
            baseline_hash: baseline.baseline_hash.clone(),
            reviewer_profile_hash: REVIEWER_PROFILE_DIGEST.to_string(),
            prompt_version: PRONUNCIATION_PROMPT_VERSION,
            output_schema_version: PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
            window_planner_version: AUDIT_WINDOW_PLANNER_VERSION,
            phone_alphabet_version: DIRECT_PHONE_ALPHABET_VERSION,
            phone_alphabet_sha256: direct_phone_alphabet_sha256(),
            kokoro_vocabulary_sha256: vocabulary.sha256().to_string(),
            direct_phone_validator_version: DIRECT_PHONE_VALIDATOR_VERSION,
            windows: vec![PronunciationWindowRecord {
                window_id: 0,
                input_sha256: windows[0].input_sha256.clone(),
                output_sha256: validated.output_sha256,
            }],
            patches: validated.patches,
        };
        validate_cached_plan(&document, &baseline, &vocabulary, &plan).unwrap();
        remux_tts::apply_pronunciation_plan(baseline, &plan, &vocabulary).unwrap();
    }

    #[test]
    fn resolved_baseline_no_effect_is_canonically_omitted() {
        let document = document(1);
        let vocabulary = KokoroVocabulary::pinned();
        let baseline = prepare_baseline(&document).unwrap();
        let window = build_audit_windows(&document, &baseline, &vocabulary)
            .unwrap()
            .remove(0);
        let word = &window.input.words[0];
        assert_eq!(word.baseline.status, "resolved");
        let validated = validate_output(
            &window,
            AuditOutput {
                version: 4,
                window_id: 0,
                phoneme_patches: vec![AuditPhonemePatch {
                    word_id: word.word_id,
                    phones: word.baseline.phones.clone(),
                }],
            },
            &vocabulary,
        )
        .unwrap();
        assert!(validated.patches.is_empty());
        assert_eq!(validated.redundant_direct_patches, 1);
        assert_eq!(
            validated.output_sha256,
            canonical_sha256(&AuditOutput {
                version: 4,
                window_id: 0,
                phoneme_patches: Vec::new(),
            })
            .unwrap()
        );
    }
}
