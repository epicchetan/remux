mod validate;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::history::{
    IncrementalSessionIndex, discover_session_files, file_revision, read_rows_range,
    refresh_session_index, session_meta_id,
};
use crate::live_transcript::LiveTranscriptStore;
use crate::projection::{ProjectedTurn, RawTurn, project_raw_turn, project_rows_to_raw_turn};
use crate::transcript::{
    DEFAULT_TRANSCRIPT_TAIL_TURNS, DEFAULT_WORK_GROUP_ROWS, MAX_TAIL_TURNS,
    MAX_TRANSCRIPT_KNOWN_TURNS, MAX_TRANSCRIPT_WINDOW_TURNS, MAX_WORK_GROUP_ROWS, ResourceRequest,
    ResourcesReadParams, SessionIndex, TRANSCRIPT_PROJECTION_VERSION,
    TRANSCRIPT_RENDER_PROTOCOL_VERSION, TranscriptWindowRequest, TurnRange,
};
use crate::util::stable_revision_value;

pub use crate::transcript::ValidationOptions;

const MAX_TRANSCRIPT_RESOURCE_REQUESTS: usize = 64;
const MAX_TRANSCRIPT_RESOURCE_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const TARGET_TRANSCRIPT_SYNC_RESPONSE_BYTES: usize = 6 * 1024 * 1024;

#[derive(Debug)]
pub struct CodexTranscriptServer {
    codex_home: PathBuf,
    live_transcript: LiveTranscriptStore,
    path_cache: HashMap<String, PathBuf>,
    index_cache: HashMap<PathBuf, IncrementalSessionIndex>,
    turn_cache: HashMap<String, CachedTurn>,
}

#[derive(Debug, Clone)]
struct CachedTurn {
    range: TurnRange,
    raw_turn: RawTurn,
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
                ResourceRequest::TranscriptSync {
                    protocol_version,
                    projection_version,
                    window,
                    known_thread_revision,
                    known_turns,
                } => self.read_transcript_sync_resource(
                    &params.thread_id,
                    &path,
                    &file_revision,
                    &index,
                    request_index,
                    protocol_version,
                    &projection_version,
                    window,
                    known_thread_revision,
                    known_turns,
                ),
                ResourceRequest::WorkGroup {
                    protocol_version,
                    turn_id,
                    segment_id,
                    group_id,
                    cursor,
                    limit,
                    known_revision,
                } => self.read_work_group_resource(
                    &params.thread_id,
                    &path,
                    &file_revision,
                    &index,
                    request_index,
                    protocol_version,
                    &turn_id,
                    &segment_id,
                    &group_id,
                    cursor,
                    limit,
                    known_revision,
                ),
                ResourceRequest::WorkEntryDetail {
                    protocol_version,
                    turn_id,
                    segment_id,
                    group_id,
                    row_id,
                    known_revision,
                } => self.read_work_entry_detail_resource(
                    &params.thread_id,
                    &path,
                    &file_revision,
                    &index,
                    request_index,
                    protocol_version,
                    &turn_id,
                    &segment_id,
                    &group_id,
                    &row_id,
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

    #[allow(clippy::too_many_arguments)]
    fn read_transcript_sync_resource(
        &mut self,
        thread_id: &str,
        path: &Path,
        file_revision: &str,
        index: &SessionIndex,
        request_index: usize,
        protocol_version: u8,
        projection_version: &str,
        window: TranscriptWindowRequest,
        _known_thread_revision: Option<String>,
        known_turns: Vec<crate::transcript::KnownTurnRevision>,
    ) -> Value {
        let key = format!("transcriptSync:{thread_id}");
        if protocol_version != TRANSCRIPT_RENDER_PROTOCOL_VERSION
            || projection_version != TRANSCRIPT_PROJECTION_VERSION
        {
            return error_result(request_index, key, "unsupportedProtocolVersion".to_string());
        }
        if known_turns.len() > MAX_TRANSCRIPT_KNOWN_TURNS {
            return error_result(request_index, key, "tooManyKnownTurns".to_string());
        }

        let turn_order = self
            .live_transcript
            .overlay_turn_order(thread_id, &index.visible_turn_ids);
        let Some((mut start, mut end, anchor)) = resolve_window(&turn_order, &window) else {
            return missing_result(request_index, key, "turn_not_found".to_string());
        };
        let known = known_turns
            .iter()
            .map(|known| (known.turn_id.as_str(), known.render_revision.as_str()))
            .collect::<HashMap<_, _>>();
        let removed_turn_ids = known_turns
            .iter()
            .filter(|known| !turn_order.iter().any(|turn_id| turn_id == &known.turn_id))
            .map(|known| known.turn_id.clone())
            .collect::<Vec<_>>();

        let mut projected_results = Vec::new();
        for turn_id in &turn_order[start..end] {
            projected_results.push(self.render_turn_result(
                thread_id,
                path,
                file_revision,
                index,
                turn_id,
                known.get(turn_id.as_str()).copied(),
            ));
        }

        let active_turn_id = turn_order.last().and_then(|turn_id| {
            self.project_turn_or_live(thread_id, path, file_revision, index, turn_id)
                .ok()
                .filter(|projected| {
                    projected.render_frame.get("status").and_then(Value::as_str)
                        == Some("inProgress")
                })
                .map(|_| turn_id.clone())
        });
        let thread_revision = stable_revision_value(&json!({
            "activeTurnId": active_turn_id,
            "kind": "transcriptThreadV2",
            "sessionId": index.session_id,
            "turnOrder": turn_order,
        }));

        loop {
            let window_turn_ids = turn_order[start..end].to_vec();
            let result_offset = start.saturating_sub(
                resolve_window(&turn_order, &window)
                    .map(|v| v.0)
                    .unwrap_or(start),
            );
            let result_end = result_offset + window_turn_ids.len();
            let turns = projected_results
                .get(result_offset..result_end)
                .unwrap_or(&[])
                .to_vec();
            let value = json!({
                "activeTurnId": active_turn_id,
                "projectionVersion": TRANSCRIPT_PROJECTION_VERSION,
                "protocolVersion": TRANSCRIPT_RENDER_PROTOCOL_VERSION,
                "removedTurnIds": removed_turn_ids,
                "sessionId": index.session_id,
                "threadId": thread_id,
                "threadRevision": thread_revision,
                "turnOrder": turn_order,
                "turns": turns,
                "window": {
                    "endIndexExclusive": end,
                    "hasEarlier": start > 0,
                    "hasLater": end < turn_order.len(),
                    "startIndex": start,
                    "turnIds": window_turn_ids,
                },
            });
            let encoded = serde_json::to_vec(&value)
                .map(|bytes| bytes.len())
                .unwrap_or(usize::MAX);
            if encoded <= TARGET_TRANSCRIPT_SYNC_RESPONSE_BYTES || end.saturating_sub(start) <= 1 {
                let revision = stable_revision_value(&json!([
                    TRANSCRIPT_RENDER_PROTOCOL_VERSION,
                    TRANSCRIPT_PROJECTION_VERSION,
                    thread_revision,
                    start,
                    end,
                    value.get("turns"),
                ]));
                return ok_result(request_index, key, revision, value);
            }

            let left_distance = anchor.saturating_sub(start);
            let right_distance = end.saturating_sub(1).saturating_sub(anchor);
            if left_distance >= right_distance && start < anchor {
                start += 1;
            } else if end > anchor + 1 {
                end -= 1;
            } else {
                break;
            }
        }

        error_result(request_index, key, "frameTooLarge".to_string())
    }

    fn render_turn_result(
        &mut self,
        thread_id: &str,
        path: &Path,
        file_revision: &str,
        index: &SessionIndex,
        turn_id: &str,
        known_revision: Option<&str>,
    ) -> Value {
        match self.project_turn_or_live(thread_id, path, file_revision, index, turn_id) {
            Ok(projected) => {
                let revision = projected
                    .render_frame
                    .get("renderRevision")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if known_revision == Some(revision.as_str()) {
                    json!({
                        "renderRevision": revision,
                        "status": "notModified",
                        "turnId": turn_id,
                    })
                } else if serde_json::to_vec(&projected.render_frame)
                    .map(|bytes| bytes.len() > MAX_TRANSCRIPT_RESOURCE_RESPONSE_BYTES)
                    .unwrap_or(true)
                {
                    json!({
                        "code": "frameTooLarge",
                        "message": "turn render frame exceeds the transcript response limit",
                        "status": "error",
                        "turnId": turn_id,
                    })
                } else {
                    json!({
                        "frame": projected.render_frame,
                        "renderRevision": revision,
                        "status": "ok",
                        "turnId": turn_id,
                    })
                }
            }
            Err(error) => json!({
                "code": "projectionFailed",
                "message": error,
                "status": "error",
                "turnId": turn_id,
            }),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn read_work_group_resource(
        &mut self,
        thread_id: &str,
        path: &Path,
        file_revision: &str,
        index: &SessionIndex,
        request_index: usize,
        protocol_version: u8,
        turn_id: &str,
        segment_id: &str,
        group_id: &str,
        cursor: Option<String>,
        limit: Option<usize>,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("workGroup:{thread_id}:{turn_id}:{segment_id}:{group_id}");
        if protocol_version != TRANSCRIPT_RENDER_PROTOCOL_VERSION {
            return error_result(request_index, key, "unsupportedProtocolVersion".to_string());
        }
        if cursor.is_some() && known_revision.is_some() {
            return error_result(request_index, key, "knownRevisionWithCursor".to_string());
        }
        let projected =
            match self.project_turn_or_live(thread_id, path, file_revision, index, turn_id) {
                Ok(projected) => projected,
                Err(error) => return missing_result(request_index, key, error),
            };
        let resource_key = format!("{segment_id}:{group_id}");
        let Some(group) = projected.work_groups_by_key.get(&resource_key) else {
            return missing_result(request_index, key, "group_not_found".to_string());
        };
        let revision = group
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if cursor.is_none() && known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }
        let offset = match cursor.as_deref() {
            Some(cursor) => match parse_group_cursor(cursor, &revision) {
                Some(offset) => offset,
                None => return error_result(request_index, key, "staleCursor".to_string()),
            },
            None => 0,
        };
        let limit = limit
            .unwrap_or(DEFAULT_WORK_GROUP_ROWS)
            .clamp(1, MAX_WORK_GROUP_ROWS);
        let rows = group
            .get("rows")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if offset > rows.len() {
            return error_result(request_index, key, "staleCursor".to_string());
        }
        let end = (offset + limit).min(rows.len());
        let value = json!({
            "groupId": group_id,
            "layoutRevision": group.get("layoutRevision").cloned().unwrap_or(Value::Null),
            "nextCursor": (end < rows.len()).then(|| group_cursor(&revision, end)),
            "revision": revision,
            "rows": rows[offset..end],
            "segmentId": segment_id,
            "threadId": thread_id,
            "title": group.get("title").cloned().unwrap_or_else(|| json!("Tools")),
            "turnId": turn_id,
            "type": group.get("type").cloned().unwrap_or_else(|| json!("tools")),
        });
        ok_result(request_index, key, revision, value)
    }

    #[allow(clippy::too_many_arguments)]
    fn read_work_entry_detail_resource(
        &mut self,
        thread_id: &str,
        path: &Path,
        file_revision: &str,
        index: &SessionIndex,
        request_index: usize,
        protocol_version: u8,
        turn_id: &str,
        segment_id: &str,
        group_id: &str,
        row_id: &str,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("workEntryDetail:{thread_id}:{turn_id}:{segment_id}:{group_id}:{row_id}");
        if protocol_version != TRANSCRIPT_RENDER_PROTOCOL_VERSION {
            return error_result(request_index, key, "unsupportedProtocolVersion".to_string());
        }
        let projected =
            match self.project_turn_or_live(thread_id, path, file_revision, index, turn_id) {
                Ok(projected) => projected,
                Err(error) => return missing_result(request_index, key, error),
            };
        let resource_key = format!("{segment_id}:{group_id}:{row_id}");
        let Some(detail) = projected.entry_details_by_key.get(&resource_key) else {
            return missing_result(request_index, key, "entry_detail_not_found".to_string());
        };
        let revision = detail
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }
        let detail_value = detail.get("detail").cloned().unwrap_or(Value::Null);
        let returned_bytes = serde_json::to_vec(&detail_value)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        let value = json!({
            "detail": detail_value,
            "groupId": group_id,
            "layoutRevision": detail.get("layoutRevision").cloned().unwrap_or(Value::Null),
            "revision": revision,
            "rowId": row_id,
            "segmentId": segment_id,
            "threadId": thread_id,
            "truncation": {
                "originalBytes": returned_bytes,
                "returnedBytes": returned_bytes,
                "truncated": false,
            },
            "turnId": turn_id,
        });
        ok_result(request_index, key, revision, value)
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

    fn session_index(
        &mut self,
        path: &Path,
        _file_revision: &str,
    ) -> Result<&SessionIndex, String> {
        let cached = self.index_cache.remove(path);
        let refreshed = refresh_session_index(path, cached)?;
        self.index_cache.insert(path.to_path_buf(), refreshed);
        if self.index_cache.len() > 8 {
            let evict = self
                .index_cache
                .keys()
                .find(|candidate| candidate.as_path() != path)
                .cloned();
            if let Some(evict) = evict {
                self.index_cache.remove(&evict);
            }
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
        _file_revision: &str,
        index: &SessionIndex,
        turn_id: &str,
    ) -> Result<ProjectedTurn, String> {
        let range = index
            .turns
            .get(turn_id)
            .ok_or_else(|| "turn_not_found".to_string())?;
        let cache_key = format!("{}:{turn_id}", path.display());
        if let Some(cached) = self.turn_cache.get(&cache_key) {
            if cached.range == *range {
                return Ok(self.project_disk_turn(thread_id, cached.raw_turn.clone()));
            }
        }

        let rows = read_rows_range(path, range)?;
        let raw_turn = project_rows_to_raw_turn(turn_id, &rows, range);
        let projected = self.project_disk_turn(thread_id, raw_turn.clone());
        self.turn_cache.insert(
            cache_key,
            CachedTurn {
                range: range.clone(),
                raw_turn,
            },
        );
        if self.turn_cache.len() > 512 {
            let evict = self.turn_cache.keys().next().cloned();
            if let Some(evict) = evict {
                self.turn_cache.remove(&evict);
            }
        }
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

fn error_result(request_index: usize, key: String, reason: String) -> Value {
    json!({
        "key": key,
        "reason": reason,
        "requestIndex": request_index,
        "status": "error",
    })
}

fn resolve_window(
    turn_order: &[String],
    request: &TranscriptWindowRequest,
) -> Option<(usize, usize, usize)> {
    if turn_order.is_empty() {
        return match request {
            TranscriptWindowRequest::Tail { .. } => Some((0, 0, 0)),
            _ => None,
        };
    }

    match request {
        TranscriptWindowRequest::Tail { count } => {
            let count = count
                .unwrap_or(DEFAULT_TRANSCRIPT_TAIL_TURNS)
                .clamp(1, MAX_TRANSCRIPT_WINDOW_TURNS);
            let end = turn_order.len();
            Some((end.saturating_sub(count), end, end - 1))
        }
        TranscriptWindowRequest::Around {
            turn_id,
            before,
            after,
        } => {
            let anchor = turn_order
                .iter()
                .position(|candidate| candidate == turn_id)?;
            let mut start = anchor.saturating_sub(*before);
            let mut end = (anchor + after.saturating_add(1)).min(turn_order.len());
            while end.saturating_sub(start) > MAX_TRANSCRIPT_WINDOW_TURNS {
                let left_distance = anchor.saturating_sub(start);
                let right_distance = end.saturating_sub(1).saturating_sub(anchor);
                if left_distance >= right_distance && start < anchor {
                    start += 1;
                } else if end > anchor + 1 {
                    end -= 1;
                } else {
                    break;
                }
            }
            Some((start, end, anchor))
        }
        TranscriptWindowRequest::Range {
            start_turn_id,
            end_turn_id,
        } => {
            let requested_start = turn_order
                .iter()
                .position(|candidate| candidate == start_turn_id)?;
            let requested_end = turn_order
                .iter()
                .position(|candidate| candidate == end_turn_id)?;
            if requested_start > requested_end {
                return None;
            }
            let end = requested_end + 1;
            let start = requested_start.max(end.saturating_sub(MAX_TRANSCRIPT_WINDOW_TURNS));
            Some((start, end, requested_end))
        }
    }
}

fn group_cursor(revision: &str, offset: usize) -> String {
    format!("{revision}.{offset}")
}

fn parse_group_cursor(cursor: &str, revision: &str) -> Option<usize> {
    let (cursor_revision, offset) = cursor.rsplit_once('.')?;
    (cursor_revision == revision)
        .then(|| offset.parse::<usize>().ok())
        .flatten()
}
