use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

use misaki_rs::MToken;
use remux_compute::TaskContext;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::model::{InferenceOutput, KokoroModel};
use crate::timing::{join_timestamps, seconds, write_wav_bytes};
use crate::{
    KokoroStreamingRequest, StreamingCompletion, StreamingControl, StreamingGroupPlan,
    StreamingOutput, StreamingPlanFile, StreamingProgress, StreamingSegment,
};

const POLL_INTERVAL: Duration = Duration::from_millis(50);
const GROUP_PAUSE_SAMPLES: usize = 1_920;
const MAX_GROUPS: usize = 512;
const MAX_PHONEMES: usize = 500;
const MAX_IN_FLIGHT_GROUPS: usize = 16;
const SAMPLE_RATE: usize = 24_000;

pub fn synthesize_stream(
    context: TaskContext<StreamingProgress>,
    request: KokoroStreamingRequest,
) -> Result<StreamingOutput, String> {
    validate_initial_request(&request)?;
    let control_path = request.staging_dir.join("control.json");
    let control_bytes = fs::read(&control_path)
        .map_err(|error| format!("failed to read streaming control: {error}"))?;
    if sha256_hex(&control_bytes) != request.control_sha256 {
        return Err("streaming control hash mismatch".to_string());
    }
    let control: StreamingControl = serde_json::from_slice(&control_bytes)
        .map_err(|error| format!("invalid streaming control: {error}"))?;
    validate_control(&request, &control)?;

    fs::create_dir_all(request.staging_dir.join("audio"))
        .map_err(|error| format!("failed to create streaming audio directory: {error}"))?;
    fs::create_dir_all(request.staging_dir.join("segments"))
        .map_err(|error| format!("failed to create streaming segment directory: {error}"))?;
    let model_started = Instant::now();
    let model = Arc::new(KokoroModel::load(
        &request.model_dir,
        &request.model_assets,
    )?);
    context.progress(StreamingProgress::ModelLoaded {
        elapsed_ms: model_started.elapsed().as_millis() as u64,
    })?;

    let deadline = Instant::now() + Duration::from_millis(request.deadline_ms);
    let target_ids = control
        .targets
        .iter()
        .filter_map(|target| target.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let target_ids_by_block = control
        .block_ids
        .iter()
        .map(|block_id| {
            control
                .targets
                .iter()
                .filter(|target| target.get("blockId").and_then(Value::as_str) == Some(block_id))
                .filter_map(|target| target.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect::<HashSet<_>>()
        })
        .collect::<Vec<_>>();
    let concurrency = context.threads().clamp(1, MAX_IN_FLIGHT_GROUPS);
    std::thread::scope(|scope| {
        let (result_tx, result_rx) = mpsc::sync_channel(concurrency);
        let mut next_dispatch = 0usize;
        let mut next_publish = 0usize;
        let mut next_word_id = 0usize;
        let mut last_dispatched_block = None::<usize>;
        let mut active = 0usize;
        let mut total_samples = 0usize;
        let mut group_digests = Vec::new();
        let mut plan_hashes = Vec::new();
        let mut inferred = BTreeMap::<usize, (StreamingPlanFile, InferenceOutput, u64)>::new();
        let mut segments = Vec::new();
        let mut completion = None::<StreamingCompletion>;

        loop {
            if Instant::now() >= deadline {
                return Err("streaming Kokoro worker deadline exceeded".to_string());
            }

            while active < concurrency
                && completion
                    .as_ref()
                    .is_none_or(|complete| next_dispatch < complete.group_count)
            {
                let plan_path = request
                    .staging_dir
                    .join("plan")
                    .join(format!("{next_dispatch:06}.json"));
                if !plan_path.is_file() {
                    break;
                }
                let bytes = fs::read(&plan_path)
                    .map_err(|error| format!("failed to read streaming plan: {error}"))?;
                let plan: StreamingPlanFile = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("invalid streaming plan {next_dispatch}: {error}"))?;
                validate_plan(
                    &request,
                    &plan,
                    next_dispatch,
                    next_word_id,
                    last_dispatched_block,
                    &target_ids_by_block,
                    &target_ids,
                    &model,
                )?;
                next_word_id += plan.group.words.len();
                last_dispatched_block = Some(plan.group.last_block);
                plan_hashes.push(sha256_hex(&bytes));
                let sender = result_tx.clone();
                let model = model.clone();
                let index = next_dispatch;
                scope.spawn(move || {
                    let started = Instant::now();
                    let result = infer_group(&plan.group, &model)
                        .map(|inference| (plan, inference, started.elapsed().as_millis() as u64));
                    let _ = sender.send((index, result));
                });
                active += 1;
                next_dispatch += 1;
            }

            if completion.is_none() {
                let complete_path = request.staging_dir.join("complete.json");
                if complete_path.is_file() {
                    let value: StreamingCompletion =
                        serde_json::from_slice(&fs::read(&complete_path).map_err(|error| {
                            format!("failed to read streaming completion: {error}")
                        })?)
                        .map_err(|error| format!("invalid streaming completion: {error}"))?;
                    if value.group_count < next_dispatch
                        || value.group_count == 0
                        || value.group_count > request.max_groups
                        || value.last_block + 1 != control.block_ids.len()
                    {
                        return Err(
                            "streaming completion does not match the committed plan prefix"
                                .to_string(),
                        );
                    }
                    completion = Some(value);
                }
            }
            if let Some(complete) = completion.as_ref()
                && next_dispatch < complete.group_count
                && active < concurrency
                && !request
                    .staging_dir
                    .join("plan")
                    .join(format!("{next_dispatch:06}.json"))
                    .is_file()
            {
                return Err(format!(
                    "streaming completion is missing plan {next_dispatch}"
                ));
            }

            let mut made_progress = false;
            while let Ok((index, result)) = result_rx.try_recv() {
                active = active.saturating_sub(1);
                let result = result?;
                if inferred.insert(index, result).is_some() {
                    return Err(format!("duplicate inference result for group {index}"));
                }
                made_progress = true;
            }

            while let Some((plan, inference, elapsed_ms)) = inferred.remove(&next_publish) {
                let segment = synthesize_group(
                    &request,
                    &plan.group,
                    &control.block_ids,
                    &control.targets,
                    inference,
                    total_samples,
                )?;
                total_samples += segment.audio_samples;
                publish_segment(&request.staging_dir, &segment)?;
                group_digests.push(plan.group_digest);
                context.progress(StreamingProgress::SegmentReady {
                    elapsed_ms,
                    segment: segment.clone(),
                })?;
                segments.push(segment);
                next_publish += 1;
                made_progress = true;
            }

            if let Some(complete) = completion.as_ref()
                && active == 0
                && inferred.is_empty()
                && next_publish == complete.group_count
            {
                validate_completion(complete, next_publish, &group_digests)?;
                revalidate_committed_plans(&request, &plan_hashes)?;
                validate_plan_directory(&request.staging_dir.join("plan"), complete.group_count)?;
                let output = StreamingOutput {
                    duration_seconds: seconds(total_samples),
                    plan_digest: complete.plan_digest.clone(),
                    segments,
                };
                atomic_json(&request.staging_dir.join("worker-result.json"), &output)?;
                return Ok(output);
            }

            if !made_progress {
                match result_rx.recv_timeout(POLL_INTERVAL) {
                    Ok((index, result)) => {
                        active = active.saturating_sub(1);
                        let result = result?;
                        if inferred.insert(index, result).is_some() {
                            return Err(format!("duplicate inference result for group {index}"));
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) if active == 0 => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("streaming inference workers disconnected".to_string());
                    }
                }
            }
        }
    })
}

fn validate_initial_request(request: &KokoroStreamingRequest) -> Result<(), String> {
    if request.artifact_key.trim().is_empty()
        || request.control_sha256.len() != 64
        || request.deadline_ms == 0
        || request.deadline_ms > 15 * 60 * 1_000
        || request.max_groups == 0
        || request.max_groups > MAX_GROUPS
        || !request.staging_dir.is_dir()
    {
        return Err("invalid streaming Kokoro request".to_string());
    }
    Ok(())
}

fn validate_control(
    request: &KokoroStreamingRequest,
    control: &StreamingControl,
) -> Result<(), String> {
    if control.version != 1
        || control.artifact_key != request.artifact_key
        || control.source_hash != request.source_hash
        || control.targets.is_empty()
        || control.block_ids.is_empty()
        || control.block_ids.len() > 512
    {
        return Err("streaming control does not match its request".to_string());
    }
    let block_ids = control
        .block_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if block_ids.len() != control.block_ids.len() {
        return Err("streaming control contains duplicate blocks".to_string());
    }
    let mut target_ids = HashSet::new();
    for target in &control.targets {
        let id = target
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "streaming control target is missing id".to_string())?;
        if !target_ids.insert(id) {
            return Err("streaming control contains duplicate targets".to_string());
        }
        if target
            .get("blockId")
            .and_then(Value::as_str)
            .is_none_or(|block_id| !block_ids.contains(block_id))
        {
            return Err("streaming control target references an unknown block".to_string());
        }
    }
    Ok(())
}

fn validate_plan(
    request: &KokoroStreamingRequest,
    plan: &StreamingPlanFile,
    expected_index: usize,
    expected_word_id: usize,
    previous_last_block: Option<usize>,
    target_ids_by_block: &[HashSet<String>],
    target_ids: &HashSet<String>,
    model: &KokoroModel,
) -> Result<(), String> {
    let valid_first_block = valid_group_block_progress(previous_last_block, plan.group.first_block);
    if plan.version != 1
        || plan.artifact_key != request.artifact_key
        || plan.group.index != expected_index
        || plan.group.first_word_id != expected_word_id
        || !valid_first_block
        || plan.group.first_block > plan.group.last_block
        || plan.group.last_block >= target_ids_by_block.len()
        || plan.group.block_target_ids.len() != plan.group.last_block - plan.group.first_block + 1
        || plan.group.words.is_empty()
        || plan.group.words.len() > 1_024
    {
        return Err(format!(
            "streaming plan {expected_index} has invalid identity"
        ));
    }
    let encoded_group = serde_json::to_vec(&plan.group)
        .map_err(|error| format!("failed to encode streaming group: {error}"))?;
    if sha256_hex(&encoded_group) != plan.group_digest {
        return Err(format!("streaming plan {expected_index} digest mismatch"));
    }
    let mut expected_word_id = plan.group.first_word_id;
    let mut phoneme_count = 0usize;
    let allowed_group_targets = target_ids_by_block[plan.group.first_block..=plan.group.last_block]
        .iter()
        .flatten()
        .collect::<HashSet<_>>();
    for word in &plan.group.words {
        if word.id != expected_word_id || word.text.trim().is_empty() || word.phonemes.is_empty() {
            return Err(format!(
                "streaming plan {expected_index} has invalid word ids"
            ));
        }
        if word.source_block < plan.group.first_block || word.source_block > plan.group.last_block {
            return Err(format!(
                "streaming plan {expected_index} has an invalid source block"
            ));
        }
        expected_word_id += 1;
        phoneme_count += word.phonemes.chars().count() + usize::from(word.whitespace_after);
        if word.target_ids.is_empty()
            || word.target_ids.iter().any(|target_id| {
                !target_ids.contains(target_id) || !allowed_group_targets.contains(target_id)
            })
        {
            return Err(format!(
                "streaming plan {expected_index} has invalid targets"
            ));
        }
        model.validate_supported(&word.phonemes)?;
    }
    for (offset, plan_targets) in plan.group.block_target_ids.iter().enumerate() {
        let plan_targets = plan_targets.iter().collect::<HashSet<_>>();
        let expected_targets = &target_ids_by_block[plan.group.first_block + offset];
        if plan_targets.len() != expected_targets.len()
            || expected_targets
                .iter()
                .any(|target| !plan_targets.contains(target))
        {
            return Err(format!(
                "streaming plan {expected_index} has invalid block targets"
            ));
        }
    }
    if phoneme_count == 0 || phoneme_count > MAX_PHONEMES {
        return Err(format!(
            "streaming plan {expected_index} exceeds its phoneme budget"
        ));
    }
    Ok(())
}

fn valid_group_block_progress(previous_last_block: Option<usize>, first_block: usize) -> bool {
    previous_last_block.map_or(first_block == 0, |previous| {
        first_block == previous || first_block == previous + 1
    })
}

fn group_phonemes(group: &StreamingGroupPlan) -> String {
    group
        .words
        .iter()
        .map(|word| {
            format!(
                "{}{}",
                word.phonemes,
                if word.whitespace_after { " " } else { "" }
            )
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn infer_group(group: &StreamingGroupPlan, model: &KokoroModel) -> Result<InferenceOutput, String> {
    model.infer(&group_phonemes(group))
}

fn synthesize_group(
    request: &KokoroStreamingRequest,
    group: &StreamingGroupPlan,
    block_ids: &[String],
    targets: &[Value],
    mut inference: InferenceOutput,
    start_samples: usize,
) -> Result<StreamingSegment, String> {
    let mut tokens = group
        .words
        .iter()
        .map(|word| {
            let mut token = MToken::new(
                word.text.clone(),
                String::new(),
                if word.whitespace_after {
                    " ".to_string()
                } else {
                    String::new()
                },
            );
            token.phonemes = Some(word.phonemes.clone());
            token
        })
        .collect::<Vec<_>>();
    join_timestamps(&mut tokens, &inference.duration);
    let spoken_offsets = spoken_offsets(group)?;
    let group_start = seconds(start_samples);
    let speech_samples = inference.waveform.len();
    let speech_end = seconds(start_samples + speech_samples);
    inference
        .waveform
        .resize(inference.waveform.len() + GROUP_PAUSE_SAMPLES, 0.0);
    let group_end = seconds(start_samples + inference.waveform.len());

    let mut cues = Vec::new();
    for (index, (token, word)) in tokens.iter().zip(&group.words).enumerate() {
        let start = group_start + token.start_ts.unwrap_or(0.0);
        let end = (group_start + token.end_ts.unwrap_or(speech_end - group_start))
            .max(start)
            .min(speech_end);
        cues.push(json!({
            "id": format!("group:{}/cue/{index}", group.index),
            "unitId": format!("group:{}:block:{}", group.index, word.source_block),
            "start": start,
            "end": end,
            "spokenStart": spoken_offsets[index].0,
            "spokenEnd": spoken_offsets[index].1,
            "targetIds": word.target_ids,
            "granularity": cue_granularity(&word.target_ids, targets),
            "origin": word.mapping_origin,
            "confidence": 1.0,
        }));
    }
    let units = units_from_group(group, block_ids, &cues, group_start, speech_end);
    let id = format!("{:06}", group.index);
    let audio_path = request.staging_dir.join("audio").join(format!("{id}.wav"));
    let wav = write_wav_bytes(&inference.waveform)?;
    atomic_bytes(&audio_path, &wav)?;
    let audio = json!({
        "id": id,
        "start": group_start,
        "end": group_end,
        "sampleRate": SAMPLE_RATE,
        "sizeBytes": wav.len(),
    });
    Ok(StreamingSegment {
        index: group.index,
        audio,
        audio_samples: inference.waveform.len(),
        cues,
        group: json!({
            "id": format!("group:{}", group.index),
            "index": group.index,
            "firstBlockId": block_ids[group.first_block],
            "lastBlockId": block_ids[group.last_block],
            "spokenText": group.spoken_text,
            "start": group_start,
            "end": group_end,
            "chunkId": id,
        }),
        units,
    })
}

fn cue_granularity(target_ids: &[String], targets: &[Value]) -> &'static str {
    let roles = targets
        .iter()
        .filter(|target| {
            target
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| target_ids.iter().any(|target_id| target_id == id))
        })
        .filter_map(|target| target.get("role").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    if roles
        .iter()
        .any(|role| matches!(*role, "expression" | "inlineCode" | "link"))
    {
        "expression"
    } else if roles.contains("word") {
        "word"
    } else {
        "block"
    }
}

fn spoken_offsets(group: &StreamingGroupPlan) -> Result<Vec<(usize, usize)>, String> {
    let mut cursor = 0;
    group
        .words
        .iter()
        .map(|word| {
            let relative = group.spoken_text[cursor..]
                .find(&word.text)
                .ok_or_else(|| "streaming group word is absent from spoken text".to_string())?;
            let start = cursor + relative;
            let end = start + word.text.len();
            cursor = end;
            Ok((
                group.spoken_text[..start].encode_utf16().count(),
                group.spoken_text[..end].encode_utf16().count(),
            ))
        })
        .collect()
}

fn units_from_group(
    group: &StreamingGroupPlan,
    block_ids: &[String],
    cues: &[Value],
    group_start: f64,
    group_end: f64,
) -> Vec<Value> {
    (group.first_block..=group.last_block)
        .map(|block| {
            let matching = cues
                .iter()
                .filter(|cue| {
                    cue.get("unitId").and_then(Value::as_str)
                        == Some(format!("group:{}:block:{block}", group.index).as_str())
                })
                .collect::<Vec<_>>();
            let fallback_target_ids = &group.block_target_ids[block - group.first_block];
            json!({
                "id": format!("group:{}:block:{block}", group.index),
                "blockId": block_ids[block],
                "chunkId": format!("{:06}", group.index),
                "fallbackTargetIds": fallback_target_ids,
                "start": matching.first().and_then(|cue| cue.get("start")).and_then(Value::as_f64).unwrap_or(group_start),
                "end": matching.last().and_then(|cue| cue.get("end")).and_then(Value::as_f64).unwrap_or(group_end),
            })
        })
        .collect()
}

fn publish_segment(staging: &Path, segment: &StreamingSegment) -> Result<(), String> {
    atomic_json(
        &staging
            .join("segments")
            .join(format!("{:06}.json", segment.index)),
        segment,
    )
}

fn validate_completion(
    complete: &StreamingCompletion,
    next_index: usize,
    group_digests: &[String],
) -> Result<(), String> {
    if complete.version != 1
        || complete.group_count != next_index
        || complete.group_count == 0
        || complete.plan_digest != plan_digest(group_digests)
        || complete.completed_text_digest.len() != 64
    {
        return Err("streaming completion does not match committed plans".to_string());
    }
    Ok(())
}

fn revalidate_committed_plans(
    request: &KokoroStreamingRequest,
    plan_hashes: &[String],
) -> Result<(), String> {
    for (index, expected_hash) in plan_hashes.iter().enumerate() {
        let path = request
            .staging_dir
            .join("plan")
            .join(format!("{index:06}.json"));
        let bytes = fs::read(&path)
            .map_err(|error| format!("failed to re-read streaming plan {index}: {error}"))?;
        if sha256_hex(&bytes) != *expected_hash {
            return Err(format!("streaming plan {index} changed after publication"));
        }
    }
    Ok(())
}

fn validate_plan_directory(plan_dir: &Path, group_count: usize) -> Result<(), String> {
    let entries = fs::read_dir(plan_dir)
        .map_err(|error| format!("failed to inspect streaming plans: {error}"))?;
    let mut plans = HashSet::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to inspect streaming plan: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name.contains(".tmp-") {
            continue;
        }
        if !entry.path().is_file() || !name.ends_with(".json") || name.len() != 11 {
            return Err(format!(
                "streaming spool contains unexpected plan entry {name}"
            ));
        }
        let index = name[..6]
            .parse::<usize>()
            .map_err(|_| format!("streaming spool contains invalid plan entry {name}"))?;
        if name != format!("{index:06}.json") || !plans.insert(index) {
            return Err(format!(
                "streaming spool contains invalid plan entry {name}"
            ));
        }
    }
    if plans.len() != group_count || (0..group_count).any(|index| !plans.contains(&index)) {
        return Err("streaming spool plan indices are incomplete".to_string());
    }
    Ok(())
}

pub fn group_digest(group: &StreamingGroupPlan) -> Result<String, String> {
    serde_json::to_vec(group)
        .map(|bytes| sha256_hex(&bytes))
        .map_err(|error| format!("failed to encode streaming group: {error}"))
}

pub fn plan_digest(group_digests: &[String]) -> String {
    let mut digest = Sha256::new();
    for value in group_digests {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

pub fn atomic_json(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to encode {}: {error}", path.display()))?;
    atomic_bytes(path, &bytes)
}

pub fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    if path.exists() {
        return Err(format!(
            "refusing to overwrite immutable {}",
            path.display()
        ));
    }
    let temporary = parent.join(format!(
        ".{}.tmp-{}-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("spool"),
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("failed to create {}: {error}", temporary.display()))?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync {}: {error}", temporary.display()))?;
        drop(file);
        fs::rename(&temporary, path)
            .map_err(|error| format!("failed to publish {}: {error}", path.display()))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("failed to sync {}: {error}", parent.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MappingOrigin, PronunciationOrigin, StreamingWordPlan};

    fn group() -> StreamingGroupPlan {
        StreamingGroupPlan {
            block_target_ids: vec![vec!["block:0".to_string()]],
            index: 0,
            first_block: 0,
            last_block: 0,
            first_word_id: 0,
            spoken_text: "Hello".to_string(),
            words: vec![StreamingWordPlan {
                id: 0,
                text: "Hello".to_string(),
                phonemes: "həlO".to_string(),
                whitespace_after: false,
                target_ids: vec!["word:0".to_string()],
                source_block: 0,
                mapping_origin: MappingOrigin::SourceWord,
                pronunciation_origin: PronunciationOrigin::GoldCorpus,
            }],
        }
    }

    #[test]
    fn immutable_atomic_publication_refuses_overwrite() {
        let directory = std::env::temp_dir().join(format!(
            "remux-streaming-atomic-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let path = directory.join("plan/000000.json");
        atomic_bytes(&path, b"one").unwrap();
        assert!(atomic_bytes(&path, b"two").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"one");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn plan_digest_is_ordered_and_group_digest_is_stable() {
        let digest = group_digest(&group()).unwrap();
        assert_eq!(digest.len(), 64);
        assert_ne!(
            plan_digest(&[digest.clone()]),
            plan_digest(&[digest.clone(), digest])
        );
    }

    #[test]
    fn completion_requires_the_exact_committed_prefix() {
        let digest = group_digest(&group()).unwrap();
        let valid = StreamingCompletion {
            version: 1,
            group_count: 1,
            last_block: 0,
            plan_digest: plan_digest(std::slice::from_ref(&digest)),
            completed_text_digest: "a".repeat(64),
        };
        assert!(validate_completion(&valid, 1, &[digest]).is_ok());
        assert!(validate_completion(&valid, 0, &[]).is_err());
    }

    #[test]
    fn group_phonemes_preserve_punctuation_and_word_spacing() {
        let mut value = group();
        value.words[0].phonemes = "həlO,".to_string();
        value.words[0].whitespace_after = true;
        value.words.push(StreamingWordPlan {
            id: 1,
            text: "world".to_string(),
            phonemes: "wɜɹld!".to_string(),
            whitespace_after: false,
            target_ids: vec!["word:1".to_string()],
            source_block: 0,
            mapping_origin: MappingOrigin::SourceWord,
            pronunciation_origin: PronunciationOrigin::GoldCorpus,
        });
        assert_eq!(group_phonemes(&value), "həlO, wɜɹld!");
    }

    #[test]
    fn acoustic_groups_may_repeat_only_the_previous_last_block() {
        assert!(valid_group_block_progress(None, 0));
        assert!(valid_group_block_progress(Some(0), 0));
        assert!(valid_group_block_progress(Some(0), 1));
        assert!(valid_group_block_progress(Some(4), 4));
        assert!(valid_group_block_progress(Some(4), 5));
        assert!(!valid_group_block_progress(None, 1));
        assert!(!valid_group_block_progress(Some(0), 2));
        assert!(!valid_group_block_progress(Some(4), 3));
    }

    #[test]
    fn cue_granularity_uses_target_metadata_not_id_spelling() {
        let targets = vec![
            json!({ "id": "opaque-a", "kind": "textRange", "role": "word" }),
            json!({ "id": "opaque-b", "kind": "textRange", "role": "inlineCode" }),
            json!({ "id": "opaque-c", "kind": "block" }),
        ];
        assert_eq!(cue_granularity(&["opaque-a".to_string()], &targets), "word");
        assert_eq!(
            cue_granularity(&["opaque-a".to_string(), "opaque-b".to_string()], &targets),
            "expression"
        );
        assert_eq!(
            cue_granularity(&["opaque-c".to_string()], &targets),
            "block"
        );
    }

    #[test]
    fn plan_directory_requires_an_exact_numbered_prefix() {
        let directory = std::env::temp_dir().join(format!(
            "remux-streaming-plans-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        atomic_bytes(&directory.join("000000.json"), b"zero").unwrap();
        atomic_bytes(&directory.join(".000001.json.tmp-test"), b"partial").unwrap();
        assert!(validate_plan_directory(&directory, 1).is_ok());
        atomic_bytes(&directory.join("000002.json"), b"extra").unwrap();
        assert!(validate_plan_directory(&directory, 1).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
