use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Instant;

use misaki_rs::MToken;
use remux_compute::TaskContext;
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::frontend::{EnglishFrontend, FrontendChunk};
use crate::model::KokoroModel;
use crate::{
    AlignmentHint, NarrationSegmentManifest, ScriptUnit, SynthesisOutput, SynthesisProgress,
    SynthesisRequest,
};

const SAMPLE_RATE: usize = 24_000;
const BLOCK_PAUSE_SAMPLES: usize = 1_920;
const TARGET_CHUNK_SAMPLES: usize = 15 * SAMPLE_RATE;

struct PreparedUnit {
    index: usize,
    unit: ScriptUnit,
    chunks: Vec<FrontendChunk>,
}

struct UnitResult {
    unit: ScriptUnit,
    audio: Vec<f32>,
    audio_path: Option<PathBuf>,
    timed_tokens: Vec<TimedToken>,
    inference_seconds: f64,
}

#[derive(Clone)]
struct TimedToken {
    text: String,
    spoken_start: usize,
    spoken_end: usize,
    start: f64,
    end: f64,
}

struct PreparedHint {
    spoken_start: usize,
    spoken_end: usize,
    target_ids: Vec<String>,
    origin: String,
    order: usize,
}

pub fn synthesize(
    context: TaskContext<SynthesisProgress>,
    request: SynthesisRequest,
) -> Result<SynthesisOutput, String> {
    validate_request(&request)?;
    let total_started = Instant::now();
    let session_started = Instant::now();
    let model = Arc::new(KokoroModel::load(
        &request.model_dir,
        &request.model_assets,
    )?);
    let session_seconds = session_started.elapsed().as_secs_f64();
    let g2p_started = Instant::now();
    let frontend = EnglishFrontend::new();
    let mut prepared = Vec::with_capacity(request.script.units.len());
    for (index, unit) in request.script.units.iter().cloned().enumerate() {
        let chunks = frontend
            .chunks(&unit.spoken_text)
            .map_err(|error| format!("G2P failed for block {}: {error}", unit.block_id))?;
        prepared.push(PreparedUnit {
            index,
            unit,
            chunks,
        });
    }
    let g2p_seconds = g2p_started.elapsed().as_secs_f64();
    let concurrency = context.threads().min(prepared.len()).max(1);
    let spill_dir = request.output_dir.join(".unit-spill");
    fs::create_dir_all(&spill_dir)
        .map_err(|error| format!("failed to create narration spill directory: {error}"))?;

    let audio_dir = request.output_dir.join("audio");
    fs::create_dir_all(&audio_dir)
        .map_err(|error| format!("failed to create narration audio directory: {error}"))?;
    let segment_dir = request.output_dir.join("segments");
    fs::create_dir_all(&segment_dir)
        .map_err(|error| format!("failed to create narration segment directory: {error}"))?;
    let mut chunks = Vec::new();
    let mut segments = Vec::new();
    let mut units = Vec::new();
    let mut cues = Vec::new();
    let mut raw_timing = Vec::new();
    let mut chunk_audio = Vec::new();
    let mut chunk_start_samples = 0;
    let mut total_samples = 0;
    let mut segment_unit_start = 0;
    let mut segment_cue_start = 0;
    let mut inference_seconds = 0.0;
    let mut wav_seconds = 0.0;
    let target_by_id = targets_by_id(&request.targets)?;

    run_parallel(
        prepared,
        model,
        concurrency,
        &spill_dir,
        &context,
        |result| {
            let mut result = result?;
            if let Some(path) = result.audio_path.take() {
                result.audio = read_f32(&path)?;
                fs::remove_file(path)
                    .map_err(|error| format!("failed to remove narration spill: {error}"))?;
            }
            inference_seconds += result.inference_seconds;
            let chunk_id = format!("{:03}", chunks.len());
            let unit_start_samples = total_samples;
            let unit_start = seconds(unit_start_samples);
            let unit_end = seconds(unit_start_samples + result.audio.len());
            clamp_token_times(&mut result.timed_tokens, unit_start, unit_end);
            chunk_audio.extend_from_slice(&result.audio);
            total_samples += result.audio.len();
            chunk_audio.resize(chunk_audio.len() + BLOCK_PAUSE_SAMPLES, 0.0);
            total_samples += BLOCK_PAUSE_SAMPLES;

            cues.extend(build_cues(
                &result.unit,
                &result.timed_tokens,
                &target_by_id,
                unit_start,
                unit_end,
            )?);
            raw_timing.push(json!({
                "unitId": result.unit.id,
                "tokens": result.timed_tokens.iter().map(timed_token_json).collect::<Vec<_>>(),
            }));
            units.push(json!({
                "id": result.unit.id,
                "blockId": result.unit.block_id,
                "chunkId": chunk_id,
                "end": unit_end,
                "fallbackTargetIds": result.unit.fallback_target_ids,
                "mode": result.unit.mode,
                "sentenceRanges": sentence_ranges(&result.timed_tokens, &result.unit.spoken_text, unit_start, unit_end),
                "spokenText": result.unit.spoken_text,
                "start": unit_start,
            }));
            if chunk_audio.len() >= TARGET_CHUNK_SAMPLES {
                wav_seconds += flush_chunk(
                    &audio_dir,
                    &mut chunks,
                    &mut chunk_audio,
                    chunk_start_samples,
                )?;
                let segment = publish_segment(
                    &segment_dir,
                    &chunks,
                    &units,
                    &cues,
                    segment_unit_start,
                    segment_cue_start,
                )?;
                segment_unit_start = units.len();
                segment_cue_start = cues.len();
                context.progress(SynthesisProgress::SegmentReady {
                    segment: segment.clone(),
                })?;
                segments.push(segment);
                chunk_start_samples = total_samples;
            }
            Ok(())
        },
    )?;
    if !chunk_audio.is_empty() {
        wav_seconds += flush_chunk(
            &audio_dir,
            &mut chunks,
            &mut chunk_audio,
            chunk_start_samples,
        )?;
        let segment = publish_segment(
            &segment_dir,
            &chunks,
            &units,
            &cues,
            segment_unit_start,
            segment_cue_start,
        )?;
        context.progress(SynthesisProgress::SegmentReady {
            segment: segment.clone(),
        })?;
        segments.push(segment);
    }
    fs::remove_dir(&spill_dir)
        .map_err(|error| format!("failed to remove narration spill directory: {error}"))?;
    let duration_seconds = seconds(total_samples);
    let total_seconds = total_started.elapsed().as_secs_f64();
    let manifest = json!({
        "version": 3,
        "alignmentKey": request.alignment_key,
        "artifactKey": request.artifact_key,
        "audioKey": request.audio_key,
        "chunks": chunks,
        "cues": cues,
        "durationSeconds": duration_seconds,
        "profile": request.profile,
        "rawTiming": raw_timing,
        "segments": segments,
        "scriptKey": request.script_key,
        "sourceDocumentKey": request.source_document_key,
        "sourceHash": request.source_hash,
        "synthesisMetrics": {
            "audioRealtimeFactor": duration_seconds / total_seconds.max(0.001),
            "concurrency": concurrency,
            "g2pSeconds": g2p_seconds,
            "inferenceWorkerSeconds": inference_seconds,
            "peakRssBytes": peak_rss_bytes(),
            "sessionSeconds": session_seconds,
            "totalSeconds": total_seconds,
            "unitCount": units.len(),
            "spokenCharacters": request.script.units.iter().map(|unit| unit.spoken_text.chars().count()).sum::<usize>(),
            "wavWriteSeconds": wav_seconds,
        },
        "targets": request.targets,
        "units": units,
    });
    Ok(SynthesisOutput { manifest })
}

fn publish_segment(
    segment_dir: &Path,
    chunks: &[Value],
    units: &[Value],
    cues: &[Value],
    unit_start: usize,
    cue_start: usize,
) -> Result<NarrationSegmentManifest, String> {
    let index = chunks
        .len()
        .checked_sub(1)
        .ok_or_else(|| "native TTS segment has no audio descriptor".to_string())?;
    let audio = chunks[index].clone();
    let id = audio
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "native TTS segment audio has no id".to_string())?
        .to_string();
    if unit_start >= units.len() {
        return Err("native TTS segment has no units".to_string());
    }
    let segment = NarrationSegmentManifest {
        index,
        audio,
        units: units[unit_start..].to_vec(),
        cues: cues[cue_start..].to_vec(),
    };
    let encoded = serde_json::to_vec_pretty(&segment)
        .map_err(|error| format!("failed to encode narration segment: {error}"))?;
    let final_path = segment_dir.join(format!("{id}.json"));
    let temporary_path = segment_dir.join(format!(".{id}.json.tmp"));
    fs::write(&temporary_path, encoded)
        .map_err(|error| format!("failed to write narration segment sidecar: {error}"))?;
    fs::rename(&temporary_path, &final_path)
        .map_err(|error| format!("failed to publish narration segment sidecar: {error}"))?;
    Ok(segment)
}

fn validate_request(request: &SynthesisRequest) -> Result<(), String> {
    if request.script.units.is_empty() {
        return Err("native TTS requires at least one script unit".to_string());
    }
    if request.targets.is_empty() {
        return Err("native TTS requires source targets".to_string());
    }
    for unit in &request.script.units {
        if unit.id.trim().is_empty()
            || unit.block_id.trim().is_empty()
            || unit.spoken_text.trim().is_empty()
            || unit.fallback_target_ids.is_empty()
        {
            return Err("native TTS received an incomplete script unit".to_string());
        }
    }
    Ok(())
}

fn run_parallel(
    prepared: Vec<PreparedUnit>,
    model: Arc<KokoroModel>,
    concurrency: usize,
    spill_dir: &Path,
    context: &TaskContext<SynthesisProgress>,
    mut consume: impl FnMut(Result<UnitResult, String>) -> Result<(), String>,
) -> Result<(), String> {
    let total = prepared.len();
    let prepared = Arc::new(prepared);
    let next = Arc::new(AtomicUsize::new(0));
    let (sender, receiver) = mpsc::sync_channel(concurrency);
    let mut consumed = 0;
    let mut consume_error = None;
    thread::scope(|scope| {
        for _ in 0..concurrency {
            let prepared = prepared.clone();
            let model = model.clone();
            let next = next.clone();
            let sender = sender.clone();
            scope.spawn(move || {
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(unit) = prepared.get(index) else {
                        break;
                    };
                    if sender
                        .send((unit.index, synthesize_unit(unit, &model)))
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
        drop(sender);
        let mut buffered = BTreeMap::new();
        let mut next_flush = 0;
        let mut completed = 0;
        while let Ok((index, result)) = receiver.recv() {
            completed += 1;
            let _ = context.progress(SynthesisProgress::Units { completed, total });
            let mut result = result;
            if index != next_flush
                && let Ok(value) = result.as_mut()
                && !value.audio.is_empty()
            {
                let path = spill_dir.join(format!("{index:05}.f32"));
                if let Err(error) = write_f32(&path, &value.audio) {
                    result = Err(error);
                } else {
                    value.audio.clear();
                    value.audio_path = Some(path);
                }
            }
            buffered.insert(index, result);
            while let Some(result) = buffered.remove(&next_flush) {
                if consume_error.is_none() {
                    if let Err(error) = consume(result) {
                        consume_error = Some(error);
                        next.store(total, Ordering::SeqCst);
                    }
                }
                consumed += 1;
                next_flush += 1;
            }
        }
    });
    if let Some(error) = consume_error {
        return Err(error);
    }
    if consumed != total {
        return Err(format!(
            "native TTS worker returned {} of {total} units",
            consumed
        ));
    }
    Ok(())
}

fn synthesize_unit(unit: &PreparedUnit, model: &KokoroModel) -> Result<UnitResult, String> {
    let started = Instant::now();
    let mut audio = Vec::new();
    let mut timed_tokens = Vec::new();
    let mut spoken_cursor = 0;
    for chunk in &unit.chunks {
        let mut tokens = chunk.tokens.clone();
        for token in &mut tokens {
            if let Some(phonemes) = token.phonemes.as_mut() {
                model.retain_supported(phonemes);
            }
        }
        let phonemes = tokens
            .iter()
            .map(|token| {
                let mut phonemes = token.phonemes.clone().unwrap_or_default();
                if !token.whitespace.is_empty() {
                    phonemes.push(' ');
                }
                phonemes
            })
            .collect::<String>()
            .trim()
            .to_string();
        let output = model.infer(&phonemes)?;
        join_timestamps(&mut tokens, &output.duration);
        let result_offset = seconds(audio.len());
        for token in tokens {
            let Some(start) = token.start_ts else {
                continue;
            };
            let Some(end) = token.end_ts else {
                continue;
            };
            if token.text.trim().is_empty() {
                continue;
            }
            let (source_start, source_end, next_cursor) =
                locate_text_span(&unit.unit.spoken_text, &token.text, spoken_cursor);
            spoken_cursor = next_cursor;
            timed_tokens.push(TimedToken {
                text: token.text,
                spoken_start: utf16_offset(&unit.unit.spoken_text, source_start),
                spoken_end: utf16_offset(&unit.unit.spoken_text, source_end),
                start: result_offset + start,
                end: result_offset + end,
            });
        }
        audio.extend(output.waveform);
    }
    Ok(UnitResult {
        unit: unit.unit.clone(),
        audio,
        audio_path: None,
        timed_tokens,
        inference_seconds: started.elapsed().as_secs_f64(),
    })
}

fn join_timestamps(tokens: &mut [MToken], duration: &[i64]) {
    if tokens.is_empty() || duration.len() < 3 {
        return;
    }
    let mut left = 2 * (duration[0] - 3).max(0);
    let mut right = left;
    let mut index = 1;
    for token in tokens {
        if index >= duration.len() - 1 {
            break;
        }
        let phoneme_count = token
            .phonemes
            .as_deref()
            .map(str::chars)
            .map(Iterator::count)
            .unwrap_or(0);
        if phoneme_count == 0 {
            if !token.whitespace.is_empty() && index + 1 < duration.len() {
                index += 1;
                left = right + duration[index];
                right = left + duration[index];
                index += 1;
            }
            continue;
        }
        let end = index + phoneme_count;
        if end >= duration.len() {
            break;
        }
        token.start_ts = Some(left as f64 / 80.0);
        let token_duration = duration[index..end].iter().sum::<i64>();
        let space_duration = if token.whitespace.is_empty() {
            0
        } else {
            duration[end]
        };
        left = right + 2 * token_duration + space_duration;
        token.end_ts = Some(left as f64 / 80.0);
        right = left + space_duration;
        index = end + usize::from(!token.whitespace.is_empty());
    }
}

fn targets_by_id(targets: &[Value]) -> Result<HashMap<String, Value>, String> {
    let mut result = HashMap::new();
    for target in targets {
        let id = target
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "native TTS target is missing id".to_string())?;
        result.insert(id.to_string(), target.clone());
    }
    Ok(result)
}

fn build_cues(
    unit: &ScriptUnit,
    tokens: &[TimedToken],
    targets: &HashMap<String, Value>,
    unit_start: f64,
    unit_end: f64,
) -> Result<Vec<Value>, String> {
    if unit.mode == "summary" {
        return Ok(vec![json!({
            "id": format!("{}/cue/block", unit.id),
            "unitId": unit.id,
            "start": unit_start,
            "end": unit_end,
            "spokenStart": 0,
            "spokenEnd": unit.spoken_text.encode_utf16().count(),
            "targetIds": unit.fallback_target_ids,
            "granularity": "block",
            "origin": "fallback",
            "confidence": 0.65,
        })]);
    }
    let hints = prepare_hints(&unit.alignment_hints, &unit.spoken_text, targets)?;
    let mut cues = Vec::new();
    let mut previous: Option<(Vec<String>, String, String, f64)> = None;
    for (index, token) in tokens.iter().enumerate() {
        let hint = hints
            .iter()
            .filter(|hint| {
                hint.spoken_end > token.spoken_start && hint.spoken_start < token.spoken_end
            })
            .min_by_key(|hint| {
                (
                    usize::from(target_granularity(&hint.target_ids, targets) != "word"),
                    hint.spoken_end - hint.spoken_start,
                    hint.order,
                )
            });
        let (target_ids, granularity, origin, confidence) = if let Some(hint) = hint {
            let granularity = target_granularity(&hint.target_ids, targets).to_string();
            let confidence = if hint.origin == "sourceWord" {
                0.98
            } else {
                0.9
            };
            let current = (
                hint.target_ids.clone(),
                granularity,
                hint.origin.clone(),
                confidence,
            );
            previous = Some(current.clone());
            current
        } else if !token.text.chars().any(char::is_alphanumeric) {
            previous
                .clone()
                .unwrap_or_else(|| fallback_cue(unit, targets))
        } else {
            fallback_cue(unit, targets)
        };
        cues.push(json!({
            "id": format!("{}/cue/{index}", unit.id),
            "unitId": unit.id,
            "start": token.start,
            "end": token.end,
            "spokenStart": token.spoken_start,
            "spokenEnd": token.spoken_end,
            "targetIds": target_ids,
            "granularity": granularity,
            "origin": origin,
            "confidence": confidence,
        }));
    }
    if cues.is_empty() {
        cues.push(json!({
            "id": format!("{}/cue/fallback", unit.id),
            "unitId": unit.id,
            "start": unit_start,
            "end": unit_end,
            "spokenStart": 0,
            "spokenEnd": unit.spoken_text.encode_utf16().count(),
            "targetIds": unit.fallback_target_ids,
            "granularity": "block",
            "origin": "fallback",
            "confidence": 0.4,
        }));
    }
    Ok(cues)
}

fn fallback_cue(
    unit: &ScriptUnit,
    targets: &HashMap<String, Value>,
) -> (Vec<String>, String, String, f64) {
    (
        unit.fallback_target_ids.clone(),
        target_granularity(&unit.fallback_target_ids, targets).to_string(),
        "fallback".to_string(),
        0.45,
    )
}

fn prepare_hints(
    hints: &[AlignmentHint],
    spoken_text: &str,
    targets: &HashMap<String, Value>,
) -> Result<Vec<PreparedHint>, String> {
    let mut cursor = 0;
    let mut prepared = Vec::with_capacity(hints.len());
    for (order, hint) in hints.iter().enumerate() {
        let relative = spoken_text[cursor..]
            .find(&hint.spoken_text)
            .ok_or_else(|| "native TTS received an unmatched alignment hint".to_string())?;
        let start = cursor + relative;
        let end = start + hint.spoken_text.len();
        if hint.target_ids.is_empty() || hint.target_ids.iter().any(|id| !targets.contains_key(id))
        {
            return Err("native TTS alignment hint references an unknown target".to_string());
        }
        let origin = hint.origin.clone().unwrap_or_else(|| {
            if target_granularity(&hint.target_ids, targets) == "word" {
                "sourceWord".to_string()
            } else {
                "sourceSemantic".to_string()
            }
        });
        prepared.push(PreparedHint {
            spoken_start: utf16_offset(spoken_text, start),
            spoken_end: utf16_offset(spoken_text, end),
            target_ids: hint.target_ids.clone(),
            origin,
            order,
        });
        cursor = end;
    }
    Ok(prepared)
}

fn target_granularity<'a>(ids: &[String], targets: &'a HashMap<String, Value>) -> &'a str {
    let mut has_text = false;
    let mut all_words = true;
    for id in ids {
        let Some(target) = targets.get(id) else {
            continue;
        };
        if target.get("kind").and_then(Value::as_str) == Some("textRange") {
            has_text = true;
            all_words &= target.get("role").and_then(Value::as_str) == Some("word");
        }
    }
    if !has_text {
        "block"
    } else if all_words {
        "word"
    } else {
        "expression"
    }
}

fn clamp_token_times(tokens: &mut [TimedToken], unit_start: f64, unit_end: f64) {
    let mut previous_start = unit_start;
    let mut previous_end = unit_start;
    for token in tokens {
        token.start = (unit_start + token.start)
            .clamp(unit_start, unit_end)
            .max(previous_start);
        token.end = (unit_start + token.end)
            .clamp(unit_start, unit_end)
            .max(token.start)
            .max(previous_end);
        previous_start = token.start;
        previous_end = token.end;
    }
}

fn timed_token_json(token: &TimedToken) -> Value {
    json!({
        "text": token.text,
        "spokenStart": token.spoken_start,
        "spokenEnd": token.spoken_end,
        "start": token.start,
        "end": token.end,
    })
}

fn sentence_ranges(
    tokens: &[TimedToken],
    spoken_text: &str,
    unit_start: f64,
    unit_end: f64,
) -> Vec<Value> {
    if tokens.is_empty() {
        return vec![json!({
            "start": unit_start,
            "end": unit_end,
            "spokenStart": 0,
            "spokenEnd": spoken_text.encode_utf16().count(),
        })];
    }
    let mut ranges = Vec::new();
    let mut first = 0;
    for (index, token) in tokens.iter().enumerate() {
        if ends_sentence(&token.text) {
            ranges.push(sentence_range(&tokens[first], token));
            first = index + 1;
        }
    }
    if first < tokens.len() {
        ranges.push(sentence_range(&tokens[first], tokens.last().unwrap()));
    }
    ranges
}

fn sentence_range(first: &TimedToken, last: &TimedToken) -> Value {
    json!({
        "start": first.start,
        "end": last.end,
        "spokenStart": first.spoken_start,
        "spokenEnd": last.spoken_end,
    })
}

fn ends_sentence(value: &str) -> bool {
    value
        .trim_end_matches(['"', '\'', '”', '’', ')'])
        .ends_with(['.', '!', '?', '…'])
}

fn locate_text_span(text: &str, token: &str, cursor: usize) -> (usize, usize, usize) {
    if let Some(relative) = text[cursor..].find(token) {
        let start = cursor + relative;
        let end = start + token.len();
        return (start, end, end);
    }
    let stripped = token.trim();
    if let Some(relative) = (!stripped.is_empty())
        .then(|| text[cursor..].find(stripped))
        .flatten()
    {
        let start = cursor + relative;
        let end = start + stripped.len();
        return (start, end, end);
    }
    let (normalized_text, source_map) = normalized_char_map(text);
    let normalized_token = normalized_char_map(token).0;
    if !normalized_token.is_empty() {
        let normalized_cursor = source_map
            .iter()
            .position(|offset| *offset >= cursor)
            .unwrap_or(source_map.len());
        if let Some(relative) = normalized_text[normalized_cursor..].find(&normalized_token) {
            let start = normalized_cursor + relative;
            let end = start + normalized_token.len();
            if let (Some(source_start), Some(source_end)) =
                (source_map.get(start), source_map.get(end.saturating_sub(1)))
            {
                let source_end = next_char_boundary(text, *source_end);
                return (*source_start, source_end, source_end);
            }
        }
    }
    let start = cursor.min(text.len());
    let end = (start + stripped.len()).min(text.len());
    (start, end, end)
}

fn normalized_char_map(value: &str) -> (String, Vec<usize>) {
    let mut normalized = String::new();
    let mut offsets = Vec::new();
    for (offset, character) in value.char_indices() {
        for candidate in character.to_string().nfkd().flat_map(char::to_lowercase) {
            if candidate.is_alphanumeric() {
                normalized.push(candidate);
                for _ in 0..candidate.len_utf8() {
                    offsets.push(offset);
                }
            }
        }
    }
    (normalized, offsets)
}

fn next_char_boundary(value: &str, start: usize) -> usize {
    start
        + value[start..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(0)
}

fn utf16_offset(value: &str, byte_offset: usize) -> usize {
    value[..byte_offset.min(value.len())].encode_utf16().count()
}

fn flush_chunk(
    audio_dir: &Path,
    chunks: &mut Vec<Value>,
    audio: &mut Vec<f32>,
    start_samples: usize,
) -> Result<f64, String> {
    let started = Instant::now();
    let id = format!("{:03}", chunks.len());
    let path = audio_dir.join(format!("{id}.wav"));
    write_wav(&path, audio)?;
    let size = fs::metadata(&path)
        .map_err(|error| format!("failed to inspect narration WAV: {error}"))?
        .len();
    chunks.push(json!({
        "id": id,
        "start": seconds(start_samples),
        "end": seconds(start_samples + audio.len()),
        "sampleRate": SAMPLE_RATE,
        "sizeBytes": size,
    }));
    audio.clear();
    Ok(started.elapsed().as_secs_f64())
}

fn write_wav(path: &Path, audio: &[f32]) -> Result<(), String> {
    let data_size = audio
        .len()
        .checked_mul(2)
        .and_then(|size| u32::try_from(size).ok())
        .ok_or_else(|| "narration WAV is too large".to_string())?;
    let mut file = BufWriter::new(
        File::create(path).map_err(|error| format!("failed to create narration WAV: {error}"))?,
    );
    file.write_all(b"RIFF")
        .and_then(|_| file.write_all(&(36 + data_size).to_le_bytes()))
        .and_then(|_| file.write_all(b"WAVEfmt "))
        .and_then(|_| file.write_all(&16_u32.to_le_bytes()))
        .and_then(|_| file.write_all(&1_u16.to_le_bytes()))
        .and_then(|_| file.write_all(&1_u16.to_le_bytes()))
        .and_then(|_| file.write_all(&(SAMPLE_RATE as u32).to_le_bytes()))
        .and_then(|_| file.write_all(&((SAMPLE_RATE * 2) as u32).to_le_bytes()))
        .and_then(|_| file.write_all(&2_u16.to_le_bytes()))
        .and_then(|_| file.write_all(&16_u16.to_le_bytes()))
        .and_then(|_| file.write_all(b"data"))
        .and_then(|_| file.write_all(&data_size.to_le_bytes()))
        .map_err(|error| format!("failed to write narration WAV header: {error}"))?;
    for sample in audio {
        let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        file.write_all(&pcm.to_le_bytes())
            .map_err(|error| format!("failed to write narration WAV samples: {error}"))?;
    }
    Ok(())
}

fn write_f32(path: &Path, audio: &[f32]) -> Result<(), String> {
    let mut file =
        File::create(path).map_err(|error| format!("failed to create narration spill: {error}"))?;
    for sample in audio {
        file.write_all(&sample.to_le_bytes())
            .map_err(|error| format!("failed to write narration spill: {error}"))?;
    }
    Ok(())
}

fn read_f32(path: &Path) -> Result<Vec<f32>, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| format!("failed to read narration spill: {error}"))?;
    if bytes.len() % 4 != 0 {
        return Err("narration spill is truncated".to_string());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

fn seconds(samples: usize) -> f64 {
    samples as f64 / SAMPLE_RATE as f64
}

fn peak_rss_bytes() -> u64 {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                line.strip_prefix("VmHWM:")
                    .and_then(|value| value.split_whitespace().next())
                    .and_then(|value| value.parse::<u64>().ok())
                    .map(|kilobytes| kilobytes * 1024)
            })
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_segments_are_complete_immutable_sidecars() {
        let directory = std::env::temp_dir().join(format!(
            "remux-tts-segment-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let chunks = vec![json!({
            "id": "000",
            "start": 0.0,
            "end": 1.0,
            "sampleRate": SAMPLE_RATE,
            "sizeBytes": 48_044,
        })];
        let units = vec![json!({ "id": "unit:one", "chunkId": "000" })];
        let cues = vec![json!({ "id": "unit:one/cue/0", "unitId": "unit:one" })];
        let segment = publish_segment(&directory, &chunks, &units, &cues, 0, 0).unwrap();
        assert_eq!(segment.index, 0);
        assert_eq!(segment.audio, chunks[0]);
        assert_eq!(segment.units, units);
        assert_eq!(segment.cues, cues);
        let sidecar: NarrationSegmentManifest =
            serde_json::from_slice(&fs::read(directory.join("000.json")).unwrap()).unwrap();
        assert_eq!(sidecar.index, segment.index);
        assert_eq!(sidecar.audio, segment.audio);
        assert_eq!(sidecar.units, segment.units);
        assert_eq!(sidecar.cues, segment.cues);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn duration_join_is_monotonic_and_accounts_for_spaces() {
        let mut first = MToken::new("hello".to_string(), "NN".to_string(), " ".to_string());
        first.phonemes = Some("abc".to_string());
        let mut second = MToken::new("world".to_string(), "NN".to_string(), String::new());
        second.phonemes = Some("de".to_string());
        let mut tokens = vec![first, second];
        join_timestamps(&mut tokens, &[4, 1, 2, 3, 1, 4, 5, 2]);
        assert_eq!(tokens[0].start_ts, Some(0.025));
        assert_eq!(tokens[0].end_ts, Some(0.1875));
        assert_eq!(tokens[1].start_ts, Some(0.1875));
        assert_eq!(tokens[1].end_ts, Some(0.425));
    }

    #[test]
    fn normalized_token_spans_map_back_to_unicode_source() {
        let text = "Café — it’s ready";
        let (cafe_start, cafe_end, cursor) = locate_text_span(text, "Cafe", 0);
        assert_eq!(&text[cafe_start..cafe_end], "Café");
        let (contraction_start, contraction_end, _) = locate_text_span(text, "it's", cursor);
        assert_eq!(&text[contraction_start..contraction_end], "it’s");
        assert_eq!(utf16_offset(text, contraction_start), 7);
    }

    #[test]
    fn sentence_ranges_cover_every_timed_token() {
        let tokens = vec![
            TimedToken {
                text: "First.".to_string(),
                spoken_start: 0,
                spoken_end: 6,
                start: 0.0,
                end: 0.5,
            },
            TimedToken {
                text: "Second!".to_string(),
                spoken_start: 7,
                spoken_end: 14,
                start: 0.5,
                end: 1.0,
            },
        ];
        let ranges = sentence_ranges(&tokens, "First. Second!", 0.0, 1.0);
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0]["spokenStart"], 0);
        assert_eq!(ranges[0]["spokenEnd"], 6);
        assert_eq!(ranges[1]["spokenStart"], 7);
        assert_eq!(ranges[1]["spokenEnd"], 14);
    }
}
