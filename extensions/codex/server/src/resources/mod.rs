mod validate;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::history::{
    build_session_index, discover_session_files, file_revision, read_rows_range, session_meta_id,
};
use crate::live_transcript::LiveTranscriptStore;
use crate::projection::{ProjectedTurn, RawTurn, project_raw_turn, project_rows_to_raw_turn};
use crate::transcript::{
    MAX_TAIL_TURNS, ResourceRequest, ResourcesReadParams, SessionIndex, TurnRange,
};
use crate::util::stable_revision_value;

pub use crate::transcript::ValidationOptions;

const MAX_TRANSCRIPT_RESOURCE_REQUESTS: usize = 64;
const MAX_TRANSCRIPT_RESOURCE_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub struct CodexTranscriptServer {
    codex_home: PathBuf,
    live_transcript: LiveTranscriptStore,
    path_cache: HashMap<String, PathBuf>,
    index_cache: HashMap<PathBuf, CachedIndex>,
    turn_cache: HashMap<String, CachedTurn>,
}

#[derive(Debug, Clone)]
struct CachedIndex {
    file_revision: String,
    index: SessionIndex,
}

#[derive(Debug, Clone)]
struct CachedTurn {
    file_revision: String,
    range: TurnRange,
    turn: ProjectedTurn,
}

impl CodexTranscriptServer {
    pub fn new(codex_home: PathBuf) -> Self {
        Self::new_with_live_transcript(codex_home, LiveTranscriptStore::default())
    }

    pub(crate) fn new_with_live_transcript(
        codex_home: PathBuf,
        live_transcript: LiveTranscriptStore,
    ) -> Self {
        Self {
            codex_home,
            live_transcript,
            path_cache: HashMap::new(),
            index_cache: HashMap::new(),
            turn_cache: HashMap::new(),
        }
    }

    pub fn read_resources(&mut self, params: Value) -> Result<Value, String> {
        let params: ResourcesReadParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid resources/read params: {error}"))?;
        if params.requests.len() > MAX_TRANSCRIPT_RESOURCE_REQUESTS {
            return Err(format!(
                "too many transcript resource requests: {}>{MAX_TRANSCRIPT_RESOURCE_REQUESTS}",
                params.requests.len()
            ));
        }
        if params.thread_id.trim().is_empty() {
            return Err("threadId is required".to_string());
        }

        let path = self.resolve_thread_path(&params.thread_id)?;
        let file_revision = file_revision(&path)?;
        let index = self.session_index(&path, &file_revision)?.clone();
        for hidden_turn_id in &index.rollback_hidden_turn_ids {
            self.live_transcript
                .remove_turn(&params.thread_id, hidden_turn_id);
        }
        let mut results = Vec::new();

        for (request_index, request) in params.requests.into_iter().enumerate() {
            let result = match request {
                ResourceRequest::ThreadTranscript {
                    known_revision,
                    include_tail_turns,
                } => self.read_thread_transcript_resource(
                    &params.thread_id,
                    &path,
                    &file_revision,
                    &index,
                    request_index,
                    known_revision,
                    include_tail_turns,
                ),
                ResourceRequest::Turn {
                    turn_id,
                    known_revision,
                } => self.read_turn_resource(
                    &params.thread_id,
                    &path,
                    &file_revision,
                    &index,
                    request_index,
                    &turn_id,
                    known_revision,
                ),
                ResourceRequest::WorkDetails {
                    turn_id,
                    segment_id,
                    known_revision,
                } => self.read_work_details_resource(
                    &params.thread_id,
                    &path,
                    &file_revision,
                    &index,
                    request_index,
                    &turn_id,
                    &segment_id,
                    known_revision,
                ),
                ResourceRequest::WorkItem {
                    turn_id,
                    item_id,
                    known_revision,
                } => self.read_work_item_resource(
                    &params.thread_id,
                    &path,
                    &file_revision,
                    &index,
                    request_index,
                    &turn_id,
                    &item_id,
                    known_revision,
                ),
            };
            results.push(result);
        }

        let response = json!({
            "threadId": params.thread_id,
            "resources": results,
        });
        let encoded_len = serde_json::to_vec(&response)
            .map_err(|error| format!("failed to encode transcript resources response: {error}"))?
            .len();
        if encoded_len > MAX_TRANSCRIPT_RESOURCE_RESPONSE_BYTES {
            return Err(format!(
                "transcript resources response is too large: {encoded_len}>{MAX_TRANSCRIPT_RESOURCE_RESPONSE_BYTES}"
            ));
        }
        Ok(response)
    }

    fn read_thread_transcript_resource(
        &mut self,
        thread_id: &str,
        path: &Path,
        file_revision: &str,
        index: &SessionIndex,
        request_index: usize,
        known_revision: Option<String>,
        include_tail_turns: Option<usize>,
    ) -> Value {
        let turn_order = self
            .live_transcript
            .overlay_turn_order(thread_id, &index.visible_turn_ids);
        let live_revision = self
            .live_transcript
            .revision_for_thread(thread_id, &index.visible_turn_ids);
        let revision = stable_revision_value(&json!({
            "kind": "threadTranscript",
            "fileRevision": file_revision,
            "liveRevision": live_revision,
            "turnOrder": turn_order,
        }));
        let key = format!("threadTranscript:{thread_id}");
        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        let mut value = json!({
            "sessionId": index.session_id,
            "threadId": thread_id,
            "revision": revision,
            "turnOrder": turn_order,
        });

        if let Some(limit) = include_tail_turns {
            let capped = limit.min(MAX_TAIL_TURNS);
            let start = turn_order.len().saturating_sub(capped);
            let mut turns = Vec::new();
            for turn_id in &turn_order[start..] {
                if let Ok(turn) =
                    self.project_turn_or_live(thread_id, path, file_revision, index, turn_id)
                {
                    turns.push(turn.turn);
                }
            }
            value["turns"] = Value::Array(turns);
        }

        ok_result(
            request_index,
            key,
            value["revision"].as_str().unwrap_or("").to_string(),
            value,
        )
    }

    fn read_turn_resource(
        &mut self,
        thread_id: &str,
        path: &Path,
        file_revision: &str,
        index: &SessionIndex,
        request_index: usize,
        turn_id: &str,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("turn:{thread_id}:{turn_id}");
        let projected =
            match self.project_turn_or_live(thread_id, path, file_revision, index, turn_id) {
                Ok(projected) => projected,
                Err(error) => return missing_result(request_index, key, error),
            };
        let revision = projected
            .turn
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        let layout_revision = stable_revision_value(&json!({
            "kind": "turnLayout",
            "segments": projected.turn.get("segments"),
        }));
        let value = json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "revision": revision,
            "layoutRevision": layout_revision,
            "turn": projected.turn,
        });
        ok_result(request_index, key, revision, value)
    }

    fn read_work_details_resource(
        &mut self,
        thread_id: &str,
        path: &Path,
        file_revision: &str,
        index: &SessionIndex,
        request_index: usize,
        turn_id: &str,
        segment_id: &str,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("workDetails:{thread_id}:{turn_id}:{segment_id}");
        let projected =
            match self.project_turn_or_live(thread_id, path, file_revision, index, turn_id) {
                Ok(projected) => projected,
                Err(error) => return missing_result(request_index, key, error),
            };
        let details = match projected.details_by_segment_id.get(segment_id) {
            Some(details) => details.clone(),
            None => return missing_result(request_index, key, "segment_not_found".to_string()),
        };
        let revision = details
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        let value = json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "segmentId": segment_id,
            "revision": revision,
            "details": details,
        });
        ok_result(request_index, key, revision, value)
    }

    fn read_work_item_resource(
        &mut self,
        thread_id: &str,
        path: &Path,
        file_revision: &str,
        index: &SessionIndex,
        request_index: usize,
        turn_id: &str,
        item_id: &str,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("workItem:{thread_id}:{turn_id}:{item_id}");
        let projected =
            match self.project_turn_or_live(thread_id, path, file_revision, index, turn_id) {
                Ok(projected) => projected,
                Err(error) => return missing_result(request_index, key, error),
            };
        let resolved_item_id = self
            .live_transcript
            .resolve_item_id(thread_id, turn_id, item_id);
        let item = match projected
            .work_items_by_id
            .get(&resolved_item_id)
            .or_else(|| projected.work_items_by_id.get(item_id))
        {
            Some(item) => item.clone(),
            None => return missing_result(request_index, key, "item_not_found".to_string()),
        };
        let resource_item_id = item
            .get("itemId")
            .and_then(Value::as_str)
            .unwrap_or(resolved_item_id.as_str())
            .to_string();
        let revision = item
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        let value = json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "itemId": resource_item_id,
            "revision": revision,
            "item": item.get("item").cloned().unwrap_or(Value::Null),
        });
        ok_result(request_index, key, revision, value)
    }

    fn resolve_thread_path(&mut self, thread_id: &str) -> Result<PathBuf, String> {
        if let Some(path) = self.path_cache.get(thread_id) {
            if path.is_file() {
                return Ok(path.clone());
            }
        }

        let files = discover_session_files(&self.codex_home)?;
        for path in &files {
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(thread_id))
            {
                self.path_cache.insert(thread_id.to_string(), path.clone());
                return Ok(path.clone());
            }
        }

        for path in files {
            if session_meta_id(&path).as_deref() == Some(thread_id) {
                self.path_cache.insert(thread_id.to_string(), path.clone());
                return Ok(path);
            }
        }

        Err("thread_not_found".to_string())
    }

    fn session_index(&mut self, path: &Path, file_revision: &str) -> Result<&SessionIndex, String> {
        let rebuild = self
            .index_cache
            .get(path)
            .map(|cached| cached.file_revision != file_revision)
            .unwrap_or(true);

        if rebuild {
            let index = build_session_index(path)?;
            self.index_cache.insert(
                path.to_path_buf(),
                CachedIndex {
                    file_revision: file_revision.to_string(),
                    index,
                },
            );
        }

        self.index_cache
            .get(path)
            .map(|cached| &cached.index)
            .ok_or_else(|| "index_not_available".to_string())
    }

    fn project_turn(
        &mut self,
        thread_id: &str,
        path: &Path,
        file_revision: &str,
        index: &SessionIndex,
        turn_id: &str,
    ) -> Result<ProjectedTurn, String> {
        let range = index
            .turns
            .get(turn_id)
            .ok_or_else(|| "turn_not_found".to_string())?;
        let cache_key = format!(
            "{}:{}:{}:{}",
            path.display(),
            turn_id,
            range.start_offset,
            range.end_offset
        );
        if let Some(cached) = self.turn_cache.get(&cache_key) {
            if cached.file_revision == file_revision && cached.range == *range {
                return Ok(self.project_disk_turn(thread_id, cached.turn.raw_turn.clone()));
            }
        }

        let rows = read_rows_range(path, range)?;
        let raw_turn = project_rows_to_raw_turn(turn_id, &rows, range);
        let projected = self.project_disk_turn(thread_id, raw_turn);
        self.turn_cache.insert(
            cache_key,
            CachedTurn {
                file_revision: file_revision.to_string(),
                range: range.clone(),
                turn: projected.clone(),
            },
        );
        Ok(projected)
    }

    fn project_disk_turn(&mut self, thread_id: &str, mut raw_turn: RawTurn) -> ProjectedTurn {
        self.live_transcript
            .apply_disk_identity(thread_id, &mut raw_turn);
        project_raw_turn(raw_turn)
    }

    fn project_turn_or_live(
        &mut self,
        thread_id: &str,
        path: &Path,
        file_revision: &str,
        index: &SessionIndex,
        turn_id: &str,
    ) -> Result<ProjectedTurn, String> {
        match self.project_turn(thread_id, path, file_revision, index, turn_id) {
            Ok(projected) => Ok(self.live_transcript.apply_overlay(thread_id, projected)),
            Err(error) => self
                .live_transcript
                .projected_turn(thread_id, turn_id)
                .ok_or(error),
        }
    }
}

fn ok_result(request_index: usize, key: String, revision: String, value: Value) -> Value {
    json!({
        "key": key,
        "requestIndex": request_index,
        "revision": revision,
        "status": "ok",
        "value": value,
    })
}

fn not_modified_result(request_index: usize, key: String, revision: String) -> Value {
    json!({
        "key": key,
        "requestIndex": request_index,
        "revision": revision,
        "status": "notModified",
    })
}

fn missing_result(request_index: usize, key: String, reason: String) -> Value {
    json!({
        "key": key,
        "reason": reason,
        "requestIndex": request_index,
        "status": "missing",
    })
}
