use serde::{Deserialize, Serialize};

use crate::batch::NarrationDocument;
use crate::pronunciation::{canonical_sha256, sha256_prefixed};

pub const STRUCTURAL_TRANSCRIPT_PLAN_SCHEMA_VERSION: u32 = 2;
pub const STRUCTURAL_TRANSCRIPT_PROMPT_VERSION: u32 = 2;
pub const STRUCTURAL_TRANSCRIPT_OUTPUT_SCHEMA_VERSION: u32 = 2;
pub const STRUCTURAL_TRANSCRIPT_WINDOW_PLANNER_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructuralTranscriptWindowRecord {
    pub window_id: u32,
    pub input_sha256: String,
    pub output_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructuralTranscriptBlock {
    pub block_id: String,
    pub transcript: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructuralTranscriptPlan {
    pub schema_version: u32,
    pub source_document_hash: String,
    pub generator_profile_hash: String,
    pub prompt_version: u32,
    pub output_schema_version: u32,
    pub window_planner_version: u32,
    pub windows: Vec<StructuralTranscriptWindowRecord>,
    pub blocks: Vec<StructuralTranscriptBlock>,
}

impl StructuralTranscriptPlan {
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(self)
            .map_err(|error| format!("failed to encode structural transcript plan: {error}"))
    }

    pub fn sha256(&self) -> Result<String, String> {
        Ok(sha256_prefixed(&self.canonical_bytes()?))
    }

    pub fn validate_versions(&self) -> Result<(), String> {
        if self.schema_version != STRUCTURAL_TRANSCRIPT_PLAN_SCHEMA_VERSION
            || self.prompt_version != STRUCTURAL_TRANSCRIPT_PROMPT_VERSION
            || self.output_schema_version != STRUCTURAL_TRANSCRIPT_OUTPUT_SCHEMA_VERSION
            || self.window_planner_version != STRUCTURAL_TRANSCRIPT_WINDOW_PLANNER_VERSION
        {
            return Err("structuralTranscriptPlanInvalid: version mismatch".to_string());
        }
        if self
            .windows
            .iter()
            .enumerate()
            .any(|(index, window)| window.window_id as usize != index)
        {
            return Err(
                "structuralTranscriptPlanInvalid: window ids are not contiguous".to_string(),
            );
        }
        if self.blocks.iter().any(|block| {
            block.block_id.trim().is_empty()
                || block.transcript.trim().is_empty()
                || block.transcript.contains('\0')
        }) {
            return Err("structuralTranscriptPlanInvalid: invalid block transcript".to_string());
        }
        Ok(())
    }
}

pub fn structural_transcript_plan_hash(plan: &StructuralTranscriptPlan) -> Result<String, String> {
    plan.sha256()
}

pub fn structural_transcript_input_hash(value: &impl Serialize) -> Result<String, String> {
    canonical_sha256(value)
}

pub fn empty_structural_transcript_plan(
    document: &NarrationDocument,
    generator_profile_hash: &str,
) -> Result<StructuralTranscriptPlan, String> {
    Ok(StructuralTranscriptPlan {
        schema_version: STRUCTURAL_TRANSCRIPT_PLAN_SCHEMA_VERSION,
        source_document_hash: crate::batch::narration_document_hash(document)?,
        generator_profile_hash: generator_profile_hash.to_string(),
        prompt_version: STRUCTURAL_TRANSCRIPT_PROMPT_VERSION,
        output_schema_version: STRUCTURAL_TRANSCRIPT_OUTPUT_SCHEMA_VERSION,
        window_planner_version: STRUCTURAL_TRANSCRIPT_WINDOW_PLANNER_VERSION,
        windows: Vec::new(),
        blocks: Vec::new(),
    })
}
