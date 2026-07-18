use std::path::Path;

use remux_compute::TaskContext;

use crate::alignment::{AcousticRole, AcousticSymbol, PreparedNarration, prepare_speech_narration};
use crate::batch::{
    BatchDiagnostics, BatchSynthesisOutput, BatchSynthesisProgress, BatchSynthesisRequest,
    ChunkDiagnostic, HighlightMode, NarrationArtifact, NarrationAudio, NarrationBlockTiming,
    NarrationSentence, NarrationWordCue, SAMPLE_RATE, narration_document_hash,
};
use crate::model::{InferenceOutput, KokoroModel};
use crate::pronunciation::{
    KokoroVocabulary, ReviewedPronunciationPlan, count_direct_phone_patches,
};
use crate::speech::StructuralTranscriptPlan;
use crate::timing::{Pcm16WavWriter, WavFileInfo, validate_wav_file};

const SAMPLES_PER_DURATION: usize = 600;
const ALIGNMENT_LOOKAHEAD_FRAMES: i64 = 3;

#[derive(Clone, Copy, Debug)]
struct SampleRange {
    start: usize,
    end: usize,
}

struct ProjectedChunk<'a> {
    audio: &'a [f32],
    symbol_ranges: Vec<SampleRange>,
}

pub(crate) fn synthesize_batch(
    context: TaskContext<BatchSynthesisProgress>,
    request: BatchSynthesisRequest,
) -> Result<BatchSynthesisOutput, String> {
    let actual_document_hash = narration_document_hash(&request.document)?;
    if actual_document_hash != request.document_hash {
        return Err(
            "sourceSchemaInvalid: document hash does not match canonical input".to_string(),
        );
    }
    let actual_plan_sha256 = request.pronunciation_plan.sha256()?;
    if actual_plan_sha256 != request.pronunciation_plan_sha256 {
        return Err("pronunciationPlanInvalid: plan hash does not match request".to_string());
    }
    let actual_structural_plan_sha256 = request.structural_transcript_plan.sha256()?;
    if actual_structural_plan_sha256 != request.structural_transcript_plan_sha256 {
        return Err(
            "structuralTranscriptPlanInvalid: plan hash does not match request".to_string(),
        );
    }
    if request.pronunciation_plan.reviewer_profile_hash
        != request.profile.pronunciation_reviewer.profile_digest
        || request.pronunciation_plan.prompt_version
            != request.profile.pronunciation_reviewer.prompt_version
        || request.pronunciation_plan.output_schema_version
            != request.profile.pronunciation_reviewer.output_schema_version
        || request.pronunciation_plan.window_planner_version
            != request
                .profile
                .pronunciation_reviewer
                .window_planner_version
        || request.pronunciation_plan.phone_alphabet_version
            != request
                .profile
                .pronunciation_reviewer
                .phone_alphabet_version
        || request.pronunciation_plan.phone_alphabet_sha256
            != request.profile.pronunciation_reviewer.phone_alphabet_sha256
        || request.pronunciation_plan.kokoro_vocabulary_sha256
            != request
                .profile
                .pronunciation_reviewer
                .kokoro_vocabulary_sha256
        || request.pronunciation_plan.direct_phone_validator_version
            != request
                .profile
                .pronunciation_reviewer
                .direct_phone_validator_version
    {
        return Err(
            "pronunciationReviewerProfileMismatch: plan and artifact profile differ".to_string(),
        );
    }
    if request.structural_transcript_plan.generator_profile_hash
        != request.profile.structural_transcript.profile_digest
        || request.structural_transcript_plan.prompt_version
            != request.profile.structural_transcript.prompt_version
        || request.structural_transcript_plan.output_schema_version
            != request.profile.structural_transcript.output_schema_version
        || request.structural_transcript_plan.window_planner_version
            != request.profile.structural_transcript.window_planner_version
    {
        return Err(
            "structuralTranscriptProfileMismatch: plan and artifact profile differ".to_string(),
        );
    }
    let vocabulary = KokoroVocabulary::load(&request.model_dir.join("vocab.json"))?;
    let speech = prepare_speech_narration(
        &request.document,
        &request.structural_transcript_plan,
        &request.pronunciation_plan,
        &vocabulary,
    )?;
    let initially_unresolved_words = speech.initially_unresolved_words;
    let prepared = speech.prepared;
    context.progress(BatchSynthesisProgress::Planned {
        chunks: prepared.chunks.len(),
        sentences: prepared.sentences.len(),
        words: prepared.words.len(),
    })?;

    let model = KokoroModel::load(&request.model_dir, &request.model_assets)?;
    context.progress(BatchSynthesisProgress::ModelLoaded)?;

    let final_audio = request.staging_dir.join("audio.wav");
    let mut wav_writer = Pcm16WavWriter::create(&final_audio, request.max_wav_bytes)?;
    let mut total_samples = 0usize;
    let mut word_samples = vec![None::<SampleRange>; prepared.words.len()];
    let mut sentence_samples = vec![None::<SampleRange>; prepared.sentences.len()];
    let mut diagnostics = Vec::with_capacity(prepared.chunks.len());

    for (chunk_index, chunk) in prepared.chunks.iter().enumerate() {
        let phonemes = chunk
            .symbols
            .iter()
            .map(|symbol| symbol.character)
            .collect::<String>();
        model.validate_supported(&phonemes)?;
        let inference = model.infer(&phonemes)?;
        let projected = project_chunk(&inference, &chunk.symbols)?;
        let global_start = total_samples;
        apply_symbol_ranges(
            global_start,
            &chunk.symbols,
            &projected.symbol_ranges,
            &mut word_samples,
            &mut sentence_samples,
        )?;
        if let Some(last) = chunk.symbols.last() {
            extend_range_end(
                &mut sentence_samples[last.sentence],
                global_start + projected.audio.len(),
            )?;
        }
        total_samples = wav_writer.append(projected.audio)?;
        diagnostics.push(ChunkDiagnostic {
            boundary: chunk.boundary.to_string(),
            first_word: chunk.first_word,
            last_word: chunk.last_word,
            symbols: chunk.symbols.len(),
            synthetic_prosody: chunk.synthetic_prosody,
        });
        context.progress(BatchSynthesisProgress::ChunkSynthesized {
            completed: chunk_index + 1,
            total: prepared.chunks.len(),
        })?;
    }
    let sentences = build_sentences(&request, &prepared, &sentence_samples)?;
    let word_cues = build_word_cues(&request, &prepared, &word_samples, &sentence_samples)?;
    let blocks = build_block_timings(&request, &prepared, &sentence_samples)?;
    let wav = wav_writer.finish()?;

    let artifact = NarrationArtifact {
        schema_version: 4,
        artifact_key: request.artifact_key.clone(),
        document_hash: request.document_hash,
        pronunciation_plan_sha256: request.pronunciation_plan_sha256.clone(),
        structural_transcript_plan_sha256: request.structural_transcript_plan_sha256.clone(),
        offset_encoding: request.document.offset_encoding,
        audio: NarrationAudio {
            url: "audio.wav".to_string(),
            mime_type: "audio/wav".to_string(),
            sample_rate: SAMPLE_RATE,
            channels: 1,
            total_samples: wav.total_samples,
            size_bytes: usize::try_from(wav.size_bytes)
                .map_err(|_| "narrationAudioTooLarge: metadata size overflow".to_string())?,
            sha256: wav.sha256.clone(),
        },
        blocks,
        sentences,
        word_cues,
        profile: request.profile,
    };
    validate_artifact(&artifact, &request.document, &prepared, &wav)?;
    let direct_phone_patches = count_direct_phone_patches(&request.pronunciation_plan);
    Ok(BatchSynthesisOutput {
        artifact,
        diagnostics: BatchDiagnostics {
            audit_windows: request.pronunciation_plan.windows.len(),
            direct_phone_patches,
            chunks: diagnostics,
            final_unresolved_words: 0,
            initially_unresolved_words,
            pronunciation_plan_sha256: request.pronunciation_plan_sha256,
            redundant_direct_patches: request.redundant_direct_patches,
            sentences: prepared.sentences.len(),
            structural_transcript_blocks: request.structural_transcript_plan.blocks.len(),
            structural_transcript_plan_sha256: request.structural_transcript_plan_sha256,
            structural_transcript_windows: request.structural_transcript_plan.windows.len(),
            unchanged_baseline_words: prepared.words.len().saturating_sub(direct_phone_patches),
            words: prepared.words.len(),
        },
    })
}

pub fn validate_batch_artifact(
    document: &crate::batch::NarrationDocument,
    plan: &ReviewedPronunciationPlan,
    structural_plan: &StructuralTranscriptPlan,
    artifact: &NarrationArtifact,
    wav_path: &Path,
    max_wav_bytes: u64,
) -> Result<(), String> {
    let plan_sha256 = plan.sha256()?;
    if artifact.pronunciation_plan_sha256 != plan_sha256 {
        return Err("pronunciationPlanInvalid: artifact plan hash mismatch".to_string());
    }
    let structural_plan_sha256 = structural_plan.sha256()?;
    if artifact.structural_transcript_plan_sha256 != structural_plan_sha256 {
        return Err("structuralTranscriptPlanInvalid: artifact plan hash mismatch".to_string());
    }
    let speech =
        prepare_speech_narration(document, structural_plan, plan, &KokoroVocabulary::pinned())?;
    let prepared = speech.prepared;
    let wav = validate_wav_file(wav_path, max_wav_bytes)?;
    validate_artifact(artifact, document, &prepared, &wav)
}

fn project_chunk<'a>(
    inference: &'a InferenceOutput,
    symbols: &[AcousticSymbol],
) -> Result<ProjectedChunk<'a>, String> {
    if inference.duration.len() != symbols.len() + 2 {
        return Err(format!(
            "durationCardinalityMismatch: {} durations for {} symbols",
            inference.duration.len(),
            symbols.len()
        ));
    }
    if inference.duration.iter().any(|duration| *duration <= 0) {
        return Err("durationProjectionInvalid: duration values must be positive".to_string());
    }
    if inference.waveform.iter().any(|sample| !sample.is_finite()) {
        return Err(
            "durationProjectionInvalid: chunk waveform contains non-finite samples".to_string(),
        );
    }
    let duration_samples = inference
        .duration
        .iter()
        .try_fold(0usize, |total, duration| {
            usize::try_from(*duration)
                .ok()
                .and_then(|value| value.checked_mul(SAMPLES_PER_DURATION))
                .and_then(|value| total.checked_add(value))
        })
        .ok_or_else(|| "durationProjectionInvalid: duration sample count overflow".to_string())?;
    if duration_samples != inference.waveform.len() {
        return Err(format!(
            "durationProjectionInvalid: duration samples {duration_samples} != waveform {}",
            inference.waveform.len()
        ));
    }

    let bos = inference.duration[0];
    let trim_start = usize::try_from((bos - ALIGNMENT_LOOKAHEAD_FRAMES).max(0))
        .ok()
        .and_then(|value| value.checked_mul(SAMPLES_PER_DURATION))
        .ok_or_else(|| "durationProjectionInvalid: BOS trim overflow".to_string())?;
    let trim_end = inference.duration[..inference.duration.len() - 1]
        .iter()
        .try_fold(0usize, |total, duration| {
            usize::try_from(*duration)
                .ok()
                .and_then(|value| value.checked_mul(SAMPLES_PER_DURATION))
                .and_then(|value| total.checked_add(value))
        })
        .ok_or_else(|| "durationProjectionInvalid: EOS trim overflow".to_string())?;
    if trim_start >= trim_end || trim_end > inference.waveform.len() {
        return Err("durationProjectionInvalid: model padding trim is invalid".to_string());
    }

    let mut cursor = 0usize;
    let mut symbol_ranges = Vec::with_capacity(symbols.len());
    for duration in &inference.duration[1..inference.duration.len() - 1] {
        let samples = usize::try_from(*duration)
            .ok()
            .and_then(|value| value.checked_mul(SAMPLES_PER_DURATION))
            .ok_or_else(|| "durationProjectionInvalid: symbol duration overflow".to_string())?;
        let end = cursor
            .checked_add(samples)
            .ok_or_else(|| "durationProjectionInvalid: symbol end overflow".to_string())?;
        symbol_ranges.push(SampleRange { start: cursor, end });
        cursor = end;
    }
    if cursor > trim_end - trim_start {
        return Err(
            "durationProjectionInvalid: symbol timing exceeds retained waveform".to_string(),
        );
    }
    Ok(ProjectedChunk {
        audio: &inference.waveform[trim_start..trim_end],
        symbol_ranges,
    })
}

fn apply_symbol_ranges(
    global_start: usize,
    symbols: &[AcousticSymbol],
    ranges: &[SampleRange],
    word_samples: &mut [Option<SampleRange>],
    sentence_samples: &mut [Option<SampleRange>],
) -> Result<(), String> {
    if symbols.len() != ranges.len() {
        return Err("durationCardinalityMismatch: projected symbol ranges differ".to_string());
    }
    for (symbol, range) in symbols.iter().zip(ranges) {
        if symbol.role == AcousticRole::Lexical && symbol.word.is_none() {
            return Err(
                "artifactAlignmentInvalid: lexical symbol has no source-word owner".to_string(),
            );
        }
        let global = SampleRange {
            start: global_start + range.start,
            end: global_start + range.end,
        };
        let sentence = sentence_samples
            .get_mut(symbol.sentence)
            .ok_or_else(|| "artifactAlignmentInvalid: symbol sentence is invalid".to_string())?;
        extend_range(sentence, global);
        if let Some(word) = symbol.word {
            let word = word_samples
                .get_mut(word)
                .ok_or_else(|| "artifactAlignmentInvalid: symbol word is invalid".to_string())?;
            extend_range(word, global);
        }
    }
    Ok(())
}

fn extend_range(target: &mut Option<SampleRange>, value: SampleRange) {
    match target {
        Some(target) => {
            target.start = target.start.min(value.start);
            target.end = target.end.max(value.end);
        }
        None => *target = Some(value),
    }
}

fn extend_range_end(target: &mut Option<SampleRange>, end: usize) -> Result<(), String> {
    let target = target
        .as_mut()
        .ok_or_else(|| "artifactAlignmentInvalid: sentence has no symbol samples".to_string())?;
    if end < target.end {
        return Err("durationProjectionInvalid: sentence tail moved backwards".to_string());
    }
    target.end = end;
    Ok(())
}

fn build_sentences(
    request: &BatchSynthesisRequest,
    prepared: &PreparedNarration,
    samples: &[Option<SampleRange>],
) -> Result<Vec<NarrationSentence>, String> {
    prepared
        .sentences
        .iter()
        .zip(samples)
        .map(|(sentence, samples)| {
            let samples = samples.ok_or_else(|| {
                format!(
                    "artifactAlignmentInvalid: sentence {} has no samples",
                    sentence.id
                )
            })?;
            let (text_start, text_end) = public_sentence_range(&request.document, sentence)?;
            Ok(NarrationSentence {
                id: sentence.id.clone(),
                block_id: request.document.blocks[sentence.block].id.clone(),
                text_start,
                text_end,
                start_sample: samples.start,
                end_sample: samples.end,
            })
        })
        .collect()
}

fn build_word_cues(
    request: &BatchSynthesisRequest,
    prepared: &PreparedNarration,
    word_samples: &[Option<SampleRange>],
    sentence_samples: &[Option<SampleRange>],
) -> Result<Vec<NarrationWordCue>, String> {
    let mut output = Vec::new();
    for (word_index, word) in prepared.words.iter().enumerate() {
        if request.document.blocks[word.block].highlight_mode == HighlightMode::Block {
            continue;
        }
        let samples = word_samples[word_index].ok_or_else(|| {
            format!(
                "artifactAlignmentInvalid: source word {:?} has no samples",
                word.text
            )
        })?;
        let sentence = &prepared.sentences[word.sentence];
        let sentence_range = sentence_samples[word.sentence]
            .ok_or_else(|| "artifactAlignmentInvalid: word sentence has no samples".to_string())?;
        if samples.start < sentence_range.start || samples.end > sentence_range.end {
            return Err("artifactAlignmentInvalid: word timing exceeds its sentence".to_string());
        }
        output.push(NarrationWordCue {
            sentence_id: sentence.id.clone(),
            block_id: request.document.blocks[word.block].id.clone(),
            text_start: word.utf16_start.value(),
            text_end: word.utf16_end.value(),
            start_sample: samples.start,
            end_sample: samples.end,
        });
    }
    Ok(output)
}

fn build_block_timings(
    request: &BatchSynthesisRequest,
    prepared: &PreparedNarration,
    sentence_samples: &[Option<SampleRange>],
) -> Result<Vec<NarrationBlockTiming>, String> {
    let mut output = Vec::new();
    for (block_index, block) in request.document.blocks.iter().enumerate() {
        let mut range = None;
        for (sentence_index, sentence) in prepared.sentences.iter().enumerate() {
            if sentence.block == block_index {
                let samples = sentence_samples[sentence_index].ok_or_else(|| {
                    "artifactAlignmentInvalid: block sentence has no samples".to_string()
                })?;
                extend_range(&mut range, samples);
            }
        }
        if let Some(range) = range {
            output.push(NarrationBlockTiming {
                block_id: block.id.clone(),
                start_sample: range.start,
                end_sample: range.end,
            });
        }
    }
    Ok(output)
}

fn validate_artifact(
    artifact: &NarrationArtifact,
    document: &crate::batch::NarrationDocument,
    prepared: &PreparedNarration,
    wav: &WavFileInfo,
) -> Result<(), String> {
    if artifact.schema_version != 4
        || artifact.document_hash != narration_document_hash(document)?
        || artifact.offset_encoding != document.offset_encoding
        || artifact.audio.sha256 != wav.sha256
        || artifact.audio.sample_rate != SAMPLE_RATE
        || artifact.audio.channels != 1
        || artifact.audio.total_samples == 0
        || artifact.audio.url != "audio.wav"
        || artifact.audio.mime_type != "audio/wav"
        || artifact.audio.size_bytes as u64 != wav.size_bytes
        || artifact.audio.total_samples != wav.total_samples
        || artifact.audio.size_bytes != artifact.audio.total_samples * 2 + 44
    {
        return Err("wavSampleCountMismatch: narration audio metadata is inconsistent".to_string());
    }
    if artifact.sentences.len() != prepared.sentences.len()
        || artifact
            .sentences
            .windows(2)
            .any(|pair| pair[0].end_sample > pair[1].start_sample)
        || artifact
            .word_cues
            .windows(2)
            .any(|pair| pair[0].end_sample > pair[1].start_sample)
    {
        return Err("artifactAlignmentInvalid: public timing is not ordered".to_string());
    }
    let expected_words = prepared
        .words
        .iter()
        .filter(|word| document.blocks[word.block].highlight_mode == HighlightMode::Text)
        .collect::<Vec<_>>();
    if artifact.word_cues.len() != expected_words.len() {
        return Err("artifactAlignmentInvalid: public word count is invalid".to_string());
    }
    for (actual, expected) in artifact.sentences.iter().zip(&prepared.sentences) {
        let block = &document.blocks[expected.block];
        let (expected_start, expected_end) = public_sentence_range(document, expected)?;
        if actual.id != expected.id
            || actual.block_id != block.id
            || actual.text_start != expected_start
            || actual.text_end != expected_end
            || !valid_utf16_range(&block.text, actual.text_start, actual.text_end)
        {
            return Err("artifactAlignmentInvalid: sentence source range changed".to_string());
        }
        let has_words = artifact
            .word_cues
            .iter()
            .any(|word| word.sentence_id == actual.id);
        if has_words != (block.highlight_mode == HighlightMode::Text) {
            return Err("artifactAlignmentInvalid: sentence highlight mode is invalid".to_string());
        }
    }
    for (actual, expected) in artifact.word_cues.iter().zip(expected_words) {
        let block = &document.blocks[expected.block];
        let sentence = &artifact.sentences[expected.sentence];
        if actual.sentence_id != sentence.id
            || actual.block_id != block.id
            || actual.text_start != expected.utf16_start.value()
            || actual.text_end != expected.utf16_end.value()
            || !valid_utf16_range(&block.text, actual.text_start, actual.text_end)
            || actual.start_sample < sentence.start_sample
            || actual.end_sample > sentence.end_sample
        {
            return Err("artifactAlignmentInvalid: word source range changed".to_string());
        }
    }
    let expected_blocks = document
        .blocks
        .iter()
        .enumerate()
        .filter(|(index, _)| {
            prepared
                .sentences
                .iter()
                .any(|sentence| sentence.block == *index)
        })
        .collect::<Vec<_>>();
    if artifact.blocks.len() != expected_blocks.len() {
        return Err("artifactAlignmentInvalid: public block count is invalid".to_string());
    }
    for (actual, (block_index, expected)) in artifact.blocks.iter().zip(expected_blocks) {
        let mut sentences = artifact
            .sentences
            .iter()
            .filter(|sentence| sentence.block_id == expected.id);
        let first = sentences
            .next()
            .ok_or_else(|| "artifactAlignmentInvalid: block has no sentence".to_string())?;
        let last = sentences.next_back().unwrap_or(first);
        if actual.block_id != expected.id
            || actual.start_sample != first.start_sample
            || actual.end_sample != last.end_sample
            || prepared
                .sentences
                .iter()
                .all(|sentence| sentence.block != block_index)
        {
            return Err("artifactAlignmentInvalid: block timing is invalid".to_string());
        }
    }
    if artifact.sentences.iter().any(|sentence| {
        sentence.text_start >= sentence.text_end
            || sentence.start_sample >= sentence.end_sample
            || sentence.end_sample > artifact.audio.total_samples
    }) || artifact.word_cues.iter().any(|word| {
        word.text_start >= word.text_end
            || word.start_sample >= word.end_sample
            || word.end_sample > artifact.audio.total_samples
    }) {
        return Err("artifactAlignmentInvalid: public range is invalid".to_string());
    }
    Ok(())
}

fn public_sentence_range(
    document: &crate::batch::NarrationDocument,
    sentence: &crate::alignment::SourceSentence,
) -> Result<(usize, usize), String> {
    let block = &document.blocks[sentence.block];
    if block.highlight_mode == HighlightMode::Text {
        return Ok((sentence.utf16_start.value(), sentence.utf16_end.value()));
    }
    let start_bytes = block.text.len() - block.text.trim_start_matches(char::is_whitespace).len();
    let end_bytes = block.text.trim_end_matches(char::is_whitespace).len();
    if start_bytes >= end_bytes {
        return Err("artifactAlignmentInvalid: structural source block is empty".to_string());
    }
    Ok((
        block.text[..start_bytes].encode_utf16().count(),
        block.text[..end_bytes].encode_utf16().count(),
    ))
}

fn valid_utf16_range(text: &str, start: usize, end: usize) -> bool {
    if start >= end {
        return false;
    }
    let mut boundaries = vec![0usize];
    let mut cursor = 0usize;
    for character in text.chars() {
        cursor += character.len_utf16();
        boundaries.push(cursor);
    }
    end <= cursor
        && boundaries.binary_search(&start).is_ok()
        && boundaries.binary_search(&end).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alignment::{AcousticRole, AcousticSymbol, prepare_baseline};
    use crate::batch::{
        HighlightMode, NarrationBlock, NarrationBlockKind, NarrationDocument, OffsetEncoding,
    };

    #[test]
    fn duration_projection_is_exact_and_trims_model_padding() {
        let symbols = (0..2)
            .map(|word| AcousticSymbol {
                character: if word == 0 { 'a' } else { 'b' },
                sentence: 0,
                word: Some(word),
                role: AcousticRole::Lexical,
            })
            .collect::<Vec<_>>();
        let inference = InferenceOutput {
            waveform: vec![0.0; (10 + 2 + 3 + 8) * SAMPLES_PER_DURATION],
            duration: vec![10, 2, 3, 8],
        };
        let projected = project_chunk(&inference, &symbols).unwrap();
        assert_eq!(projected.audio.len(), (2 + 3 + 3) * SAMPLES_PER_DURATION);
        assert_eq!(projected.symbol_ranges[0].start, 0);
        assert_eq!(projected.symbol_ranges[0].end, 2 * SAMPLES_PER_DURATION);
        assert_eq!(projected.symbol_ranges[1].end, 5 * SAMPLES_PER_DURATION);
        assert_eq!(
            projected.audio.len() - projected.symbol_ranges[1].end,
            3 * SAMPLES_PER_DURATION,
        );
    }

    #[test]
    fn separator_duration_creates_a_gap_between_word_cues() {
        let symbols = vec![
            AcousticSymbol {
                character: 'a',
                sentence: 0,
                word: Some(0),
                role: AcousticRole::Lexical,
            },
            AcousticSymbol {
                character: ' ',
                sentence: 0,
                word: None,
                role: AcousticRole::Separator,
            },
            AcousticSymbol {
                character: 'b',
                sentence: 0,
                word: Some(1),
                role: AcousticRole::Lexical,
            },
        ];
        let inference = InferenceOutput {
            waveform: vec![0.0; (10 + 2 + 3 + 4 + 8) * SAMPLES_PER_DURATION],
            duration: vec![10, 2, 3, 4, 8],
        };
        let projected = project_chunk(&inference, &symbols).unwrap();
        let mut words = vec![None, None];
        let mut sentences = vec![None];
        apply_symbol_ranges(
            0,
            &symbols,
            &projected.symbol_ranges,
            &mut words,
            &mut sentences,
        )
        .unwrap();
        assert_eq!(words[0].unwrap().end, 2 * SAMPLES_PER_DURATION);
        assert_eq!(words[1].unwrap().start, 5 * SAMPLES_PER_DURATION);
        assert_eq!(sentences[0].unwrap().end, 9 * SAMPLES_PER_DURATION);
    }

    #[test]
    fn structural_public_sentence_owns_the_trimmed_source_block() {
        let document = NarrationDocument {
            schema_version: 1,
            offset_encoding: OffsetEncoding::Utf16CodeUnit,
            blocks: vec![NarrationBlock {
                id: "md:0".to_string(),
                kind: NarrationBlockKind::Code,
                text: "  foo();  ".to_string(),
                highlight_mode: HighlightMode::Block,
            }],
        };
        let baseline = prepare_baseline(&document).unwrap();
        assert_eq!(
            public_sentence_range(&document, &baseline.sentences[0]).unwrap(),
            (2, 8)
        );
    }
}
