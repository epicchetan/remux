mod corpus;
mod frontend;
mod model;
mod streaming_artifact;
mod timing;

use std::collections::HashMap;
use std::path::PathBuf;

use remux_compute::{Task, TaskContext};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use corpus::{
    CorpusCompatibility, CorpusHint, CorpusOrigin, CorpusResolution, MisakiCorpus,
    normalize_phonemes, validate_phonemes,
};
pub use frontend::{EnglishG2p, EnglishG2pOutput, EnglishG2pToken};
pub use streaming_artifact::{atomic_json, group_digest, plan_digest, synthesize_stream};

pub const STREAMING_TASK_NAME: &str = "tts.kokoro.streaming";
pub const STREAMING_TASK_VERSION: u32 = 7;

pub struct KokoroStreamingSynthesis;

impl Task for KokoroStreamingSynthesis {
    const NAME: &'static str = STREAMING_TASK_NAME;
    const VERSION: u32 = STREAMING_TASK_VERSION;
    type Input = KokoroStreamingRequest;
    type Progress = StreamingProgress;
    type Output = StreamingOutput;

    fn run(
        context: TaskContext<Self::Progress>,
        input: Self::Input,
    ) -> Result<Self::Output, String> {
        synthesize_stream(context, input)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KokoroStreamingRequest {
    pub artifact_key: String,
    pub control_sha256: String,
    pub deadline_ms: u64,
    pub max_groups: usize,
    pub model_assets: HashMap<String, String>,
    pub model_dir: PathBuf,
    pub source_hash: String,
    pub staging_dir: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamingControl {
    pub version: u64,
    pub artifact_key: String,
    pub source_hash: String,
    pub profile: Value,
    pub block_ids: Vec<String>,
    pub targets: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamingPlanFile {
    pub version: u64,
    pub artifact_key: String,
    pub group_digest: String,
    pub group: StreamingGroupPlan,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamingGroupPlan {
    pub block_target_ids: Vec<Vec<String>>,
    pub index: usize,
    pub first_block: usize,
    pub last_block: usize,
    pub first_word_id: usize,
    pub spoken_text: String,
    pub words: Vec<StreamingWordPlan>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamingWordPlan {
    pub id: usize,
    pub text: String,
    pub phonemes: String,
    pub whitespace_after: bool,
    pub target_ids: Vec<String>,
    pub source_block: usize,
    pub mapping_origin: MappingOrigin,
    pub pronunciation_origin: PronunciationOrigin,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MappingOrigin {
    SourceWord,
    SourceSemantic,
    SummaryBlock,
    BlockFallback,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PronunciationOrigin {
    GoldCorpus,
    SilverCorpus,
    CompoundCorpus,
    LocalG2p,
    ReviewedLexicon,
    SolAudioAlias,
    SolTranscriptReplacement,
    SolSummary,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamingCompletion {
    pub version: u64,
    pub group_count: usize,
    pub last_block: usize,
    pub plan_digest: String,
    pub completed_text_digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamingProgress {
    ModelLoaded {
        elapsed_ms: u64,
    },
    SegmentReady {
        elapsed_ms: u64,
        segment: StreamingSegment,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamingSegment {
    pub index: usize,
    pub audio: Value,
    pub audio_samples: usize,
    pub cues: Vec<Value>,
    pub group: Value,
    pub units: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamingOutput {
    pub duration_seconds: f64,
    pub plan_digest: String,
    pub segments: Vec<StreamingSegment>,
}
