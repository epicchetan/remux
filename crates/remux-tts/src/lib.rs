mod artifact;
mod frontend;
mod model;

use std::collections::HashMap;
use std::path::PathBuf;

use remux_compute::{Task, TaskContext};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use artifact::synthesize;

pub const TASK_NAME: &str = "tts.kokoro.synthesize";
pub const TASK_VERSION: u32 = 2;

pub struct KokoroSynthesis;

impl Task for KokoroSynthesis {
    const NAME: &'static str = TASK_NAME;
    const VERSION: u32 = TASK_VERSION;
    type Input = SynthesisRequest;
    type Progress = SynthesisProgress;
    type Output = SynthesisOutput;

    fn run(
        context: TaskContext<Self::Progress>,
        input: Self::Input,
    ) -> Result<Self::Output, String> {
        synthesize(context, input)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisRequest {
    pub alignment_key: String,
    pub artifact_key: String,
    pub audio_key: String,
    pub model_assets: HashMap<String, String>,
    pub model_dir: PathBuf,
    pub output_dir: PathBuf,
    pub profile: Value,
    pub script: Script,
    pub script_key: String,
    pub source_document_key: String,
    pub source_hash: String,
    pub targets: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub units: Vec<ScriptUnit>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptUnit {
    pub alignment_hints: Vec<AlignmentHint>,
    pub block_id: String,
    pub display_text: String,
    pub fallback_target_ids: Vec<String>,
    pub id: String,
    pub mode: String,
    pub spoken_text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentHint {
    pub origin: Option<String>,
    pub spoken_text: String,
    pub target_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisProgress {
    pub completed: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SynthesisOutput {
    pub manifest: Value,
}
