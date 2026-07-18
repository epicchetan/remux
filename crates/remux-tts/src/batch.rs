use std::collections::HashMap;
use std::path::PathBuf;

use remux_compute::{Task, TaskContext};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::batch_artifact::synthesize_batch;
use crate::pronunciation::ReviewedPronunciationPlan;
use crate::speech::StructuralTranscriptPlan;

pub const BATCH_TASK_NAME: &str = "tts.kokoro.batch-alignment";
pub const BATCH_TASK_VERSION: u32 = 4;
pub const SAMPLE_RATE: usize = 24_000;
pub const MAX_CHUNK_SYMBOLS: usize = 450;

pub fn narration_document_hash(document: &NarrationDocument) -> Result<String, String> {
    let encoded = serde_json::to_vec(document)
        .map_err(|error| format!("failed to encode narration document: {error}"))?;
    Ok(format!("sha256-{:x}", Sha256::digest(encoded)))
}

pub struct KokoroBatchSynthesis;

impl Task for KokoroBatchSynthesis {
    const NAME: &'static str = BATCH_TASK_NAME;
    const VERSION: u32 = BATCH_TASK_VERSION;
    type Input = BatchSynthesisRequest;
    type Progress = BatchSynthesisProgress;
    type Output = BatchSynthesisOutput;

    fn run(
        context: TaskContext<Self::Progress>,
        input: Self::Input,
    ) -> Result<Self::Output, String> {
        synthesize_batch(context, input)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchSynthesisRequest {
    pub artifact_key: String,
    pub document: NarrationDocument,
    pub document_hash: String,
    pub model_assets: HashMap<String, String>,
    pub model_dir: PathBuf,
    pub profile: NarrationProfile,
    pub pronunciation_plan: ReviewedPronunciationPlan,
    pub pronunciation_plan_sha256: String,
    pub structural_transcript_plan: StructuralTranscriptPlan,
    pub structural_transcript_plan_sha256: String,
    pub redundant_direct_patches: usize,
    pub max_wav_bytes: u64,
    pub staging_dir: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BatchSynthesisProgress {
    Planned {
        chunks: usize,
        sentences: usize,
        words: usize,
    },
    ModelLoaded,
    ChunkSynthesized {
        completed: usize,
        total: usize,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchSynthesisOutput {
    pub artifact: NarrationArtifact,
    pub diagnostics: BatchDiagnostics,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchDiagnostics {
    pub audit_windows: usize,
    pub direct_phone_patches: usize,
    pub chunks: Vec<ChunkDiagnostic>,
    pub final_unresolved_words: usize,
    pub initially_unresolved_words: usize,
    pub pronunciation_plan_sha256: String,
    pub redundant_direct_patches: usize,
    pub sentences: usize,
    pub structural_transcript_blocks: usize,
    pub structural_transcript_plan_sha256: String,
    pub structural_transcript_windows: usize,
    pub unchanged_baseline_words: usize,
    pub words: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChunkDiagnostic {
    pub boundary: String,
    pub first_word: usize,
    pub last_word: usize,
    pub symbols: usize,
    pub synthetic_prosody: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrationDocument {
    pub schema_version: u32,
    pub offset_encoding: OffsetEncoding,
    pub blocks: Vec<NarrationBlock>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum OffsetEncoding {
    #[serde(rename = "utf16CodeUnit")]
    Utf16CodeUnit,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrationBlock {
    pub id: String,
    pub kind: NarrationBlockKind,
    pub text: String,
    pub highlight_mode: HighlightMode,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NarrationBlockKind {
    Paragraph,
    Heading,
    ListItem,
    Blockquote,
    Code,
    Table,
    Diagram,
}

impl NarrationBlockKind {
    pub fn structural(self) -> bool {
        matches!(self, Self::Code | Self::Table | Self::Diagram)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HighlightMode {
    Text,
    Block,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrationArtifact {
    pub schema_version: u32,
    pub artifact_key: String,
    pub document_hash: String,
    pub pronunciation_plan_sha256: String,
    pub structural_transcript_plan_sha256: String,
    pub offset_encoding: OffsetEncoding,
    pub audio: NarrationAudio,
    pub blocks: Vec<NarrationBlockTiming>,
    pub sentences: Vec<NarrationSentence>,
    pub word_cues: Vec<NarrationWordCue>,
    pub profile: NarrationProfile,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrationAudio {
    pub url: String,
    pub mime_type: String,
    pub sample_rate: usize,
    pub channels: usize,
    pub total_samples: usize,
    pub size_bytes: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrationBlockTiming {
    pub block_id: String,
    pub start_sample: usize,
    pub end_sample: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrationSentence {
    pub id: String,
    pub block_id: String,
    pub text_start: usize,
    pub text_end: usize,
    pub start_sample: usize,
    pub end_sample: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrationWordCue {
    pub sentence_id: String,
    pub block_id: String,
    pub text_start: usize,
    pub text_end: usize,
    pub start_sample: usize,
    pub end_sample: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrationProfile {
    pub phonemizer: String,
    pub pronunciation_reviewer: PronunciationReviewerProfile,
    pub structural_transcript: StructuralTranscriptProfile,
    pub source_mapper_version: u32,
    pub word_segmenter_version: u32,
    pub sentence_version: u32,
    pub planner_version: u32,
    pub timing_version: u32,
    pub synthesizer_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PronunciationReviewerProfile {
    pub model: String,
    pub service_tier: String,
    pub effort: String,
    pub profile_digest: String,
    pub prompt_version: u32,
    pub output_schema_version: u32,
    pub window_planner_version: u32,
    pub phone_alphabet_version: u32,
    pub phone_alphabet_sha256: String,
    pub kokoro_vocabulary_sha256: String,
    pub direct_phone_validator_version: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructuralTranscriptProfile {
    pub model: String,
    pub service_tier: String,
    pub effort: String,
    pub profile_digest: String,
    pub prompt_version: u32,
    pub output_schema_version: u32,
    pub window_planner_version: u32,
}
