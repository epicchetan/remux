use std::collections::HashMap;

use serde::{Deserialize, Serialize};
pub(crate) const MAX_TAIL_TURNS: usize = 200;

#[derive(Debug, Clone)]
pub(crate) struct SessionIndex {
    pub(crate) rollback_hidden_turn_ids: Vec<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) visible_turn_ids: Vec<String>,
    pub(crate) turns: HashMap<String, TurnRange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TurnRange {
    pub(crate) turn_id: String,
    pub(crate) start_offset: u64,
    pub(crate) end_offset: u64,
    pub(crate) started_at: Option<i64>,
    pub(crate) completed_at: Option<i64>,
    pub(crate) duration_ms: Option<i64>,
    pub(crate) status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourcesReadParams {
    pub(crate) thread_id: String,
    pub(crate) requests: Vec<ResourceRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum ResourceRequest {
    #[serde(rename = "threadTranscript", rename_all = "camelCase")]
    ThreadTranscript {
        known_revision: Option<String>,
        include_tail_turns: Option<usize>,
    },
    #[serde(rename = "turn", rename_all = "camelCase")]
    Turn {
        turn_id: String,
        known_revision: Option<String>,
    },
    #[serde(rename = "workDetails", rename_all = "camelCase")]
    WorkDetails {
        turn_id: String,
        segment_id: String,
        known_revision: Option<String>,
    },
    #[serde(rename = "workItem", rename_all = "camelCase")]
    WorkItem {
        turn_id: String,
        item_id: String,
        known_revision: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub(crate) codex_home: String,
    pub(crate) scanned_files: usize,
    pub(crate) threads_with_turns: usize,
    pub(crate) turns_checked: usize,
    pub(crate) work_details_checked: usize,
    pub(crate) duplicate_segment_failures: usize,
    pub(crate) duplicate_message_warnings: usize,
    pub(crate) invalid_user_input_failures: usize,
    pub(crate) missing_work_details_failures: usize,
    pub(crate) rollback_hidden_turn_failures: usize,
    pub(crate) errors: Vec<String>,
}

pub struct ValidationOptions {
    pub limit: usize,
}
