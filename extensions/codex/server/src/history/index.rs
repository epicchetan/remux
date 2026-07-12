use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use crate::transcript::{SessionIndex, TurnRange};
use crate::util::{number_as_i64, payload_value};

use super::reader::{
    FileIdentity, LineEntry, boundary_fingerprint, file_identity_and_len, fnv1a64, scan_from,
};
use super::{session_id_from_filename, session_id_from_row};

const INDEX_SCHEMA_VERSION: u32 = 1;
const TURN_HASH_OFFSET: u64 = 0xcbf29ce484222325;

#[derive(Debug, Clone)]
pub(crate) struct IncrementalSessionIndex {
    pub(crate) boundary_fingerprint: u64,
    pub(crate) file_identity: FileIdentity,
    pub(crate) index: SessionIndex,
    pub(crate) parsed_len: u64,
    pub(crate) scanned_len: u64,
    pub(crate) schema_version: u32,
    pub(crate) trailing_partial_line: Vec<u8>,
}

pub(crate) fn build_session_index(path: &Path) -> Result<SessionIndex, String> {
    Ok(rebuild(path)?.index)
}

pub(crate) fn refresh_session_index(
    path: &Path,
    cached: Option<IncrementalSessionIndex>,
) -> Result<IncrementalSessionIndex, String> {
    let Some(mut cached) = cached else {
        return rebuild(path);
    };
    let (identity, len) = file_identity_and_len(path)?;
    if cached.schema_version != INDEX_SCHEMA_VERSION
        || cached.file_identity != identity
        || len < cached.scanned_len
        || boundary_fingerprint(path, cached.scanned_len)? != cached.boundary_fingerprint
    {
        return rebuild(path);
    }
    if len == cached.scanned_len {
        return Ok(cached);
    }

    let chunk = scan_from(
        path,
        cached.scanned_len,
        cached.parsed_len,
        &cached.trailing_partial_line,
    )?;
    apply_lines(path, &mut cached.index, &chunk.lines);
    cached.scanned_len = chunk.scanned_len;
    cached.parsed_len = chunk.parsed_len;
    cached.trailing_partial_line = chunk.trailing_partial_line;
    cached.boundary_fingerprint = boundary_fingerprint(path, cached.scanned_len)?;
    Ok(cached)
}

fn rebuild(path: &Path) -> Result<IncrementalSessionIndex, String> {
    let (file_identity, _) = file_identity_and_len(path)?;
    let chunk = scan_from(path, 0, 0, &[])?;
    let mut index = SessionIndex {
        rollback_hidden_turn_ids: Vec::new(),
        session_id: None,
        visible_turn_ids: Vec::new(),
        turns: HashMap::new(),
    };
    apply_lines(path, &mut index, &chunk.lines);
    if index.session_id.is_none() {
        index.session_id = session_id_from_filename(path);
    }
    Ok(IncrementalSessionIndex {
        boundary_fingerprint: boundary_fingerprint(path, chunk.scanned_len)?,
        file_identity,
        index,
        parsed_len: chunk.parsed_len,
        scanned_len: chunk.scanned_len,
        schema_version: INDEX_SCHEMA_VERSION,
        trailing_partial_line: chunk.trailing_partial_line,
    })
}

fn apply_lines(path: &Path, index: &mut SessionIndex, lines: &[LineEntry]) {
    let mut current = index
        .visible_turn_ids
        .last()
        .and_then(|turn_id| index.turns.get(turn_id))
        .filter(|range| range.status == "inProgress")
        .cloned();

    for entry in lines {
        let row = parse_row(&entry.bytes);
        if index.session_id.is_none() {
            index.session_id = row
                .as_ref()
                .and_then(session_id_from_row)
                .or_else(|| session_id_from_filename(path));
        }
        let payload = row.as_ref().and_then(payload_value);
        let payload_type = payload
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str);

        if payload_type == Some("task_started") {
            if let Some(mut open) = current.take() {
                open.end_offset = entry.start_offset;
                open.status = "interrupted".to_string();
                remember_visible_turn(index, open);
            }
            if let Some(turn_id) = payload
                .and_then(|value| value.get("turn_id"))
                .and_then(Value::as_str)
            {
                let mut range = TurnRange {
                    turn_id: turn_id.to_string(),
                    start_offset: entry.start_offset,
                    end_offset: entry.end_offset,
                    content_hash: TURN_HASH_OFFSET,
                    started_at: payload
                        .and_then(|value| value.get("started_at"))
                        .and_then(number_as_i64),
                    completed_at: None,
                    duration_ms: None,
                    status: "inProgress".to_string(),
                };
                hash_line(&mut range, &entry.bytes);
                remember_visible_turn(index, range.clone());
                current = Some(range);
            }
            continue;
        }

        if payload_type == Some("thread_rolled_back") {
            if let Some(mut open) = current.take() {
                open.end_offset = entry.start_offset;
                open.status = "interrupted".to_string();
                remember_visible_turn(index, open);
            }
            let count = payload
                .and_then(|value| value.get("num_turns"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let hidden = truncate_visible_turns(&mut index.visible_turn_ids, count);
            for turn_id in hidden {
                index.turns.remove(&turn_id);
                index.rollback_hidden_turn_ids.push(turn_id);
            }
            continue;
        }

        if matches!(payload_type, Some("task_complete") | Some("turn_aborted")) {
            let event_turn_id = payload
                .and_then(|value| value.get("turn_id"))
                .and_then(Value::as_str);
            if current
                .as_ref()
                .is_some_and(|open| event_turn_id == Some(open.turn_id.as_str()))
            {
                let mut open = current.take().expect("open turn exists");
                open.end_offset = entry.end_offset;
                hash_line(&mut open, &entry.bytes);
                apply_turn_completion(&mut open, payload, payload_type);
                remember_visible_turn(index, open);
            } else if let Some(turn_id) = event_turn_id
                && let Some(range) = index.turns.get_mut(turn_id)
            {
                range.end_offset = range.end_offset.max(entry.end_offset);
                hash_line(range, &entry.bytes);
                apply_turn_completion(range, payload, payload_type);
            }
            continue;
        }

        if let Some(open) = current.as_mut() {
            open.end_offset = entry.end_offset;
            hash_line(open, &entry.bytes);
            remember_visible_turn(index, open.clone());
        }
    }
}

fn parse_row(bytes: &[u8]) -> Option<Value> {
    if bytes.windows(11).any(|window| window == b"\"compacted\"") {
        return Some(serde_json::json!({ "type": "compacted" }));
    }
    serde_json::from_slice(bytes).ok()
}

fn remember_visible_turn(index: &mut SessionIndex, range: TurnRange) {
    if !index.visible_turn_ids.contains(&range.turn_id) {
        index.visible_turn_ids.push(range.turn_id.clone());
    }
    index.turns.insert(range.turn_id.clone(), range);
}

fn apply_turn_completion(
    range: &mut TurnRange,
    payload: Option<&Value>,
    payload_type: Option<&str>,
) {
    range.completed_at = payload
        .and_then(|value| value.get("completed_at"))
        .and_then(number_as_i64);
    range.duration_ms = payload
        .and_then(|value| value.get("duration_ms"))
        .and_then(number_as_i64);
    range.status = if payload_type == Some("turn_aborted") {
        "interrupted".to_string()
    } else {
        "completed".to_string()
    };
}

fn hash_line(range: &mut TurnRange, bytes: &[u8]) {
    range.content_hash = fnv1a64(range.content_hash, bytes);
    range.content_hash = fnv1a64(range.content_hash, b"\n");
}

fn truncate_visible_turns(turn_ids: &mut Vec<String>, count: usize) -> Vec<String> {
    if count == 0 {
        return Vec::new();
    }
    let next_len = turn_ids.len().saturating_sub(count);
    turn_ids.split_off(next_len)
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn append_advances_without_rebuilding_completed_turns() {
        let path = temp_path();
        fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"one\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"one\"}}\n",
            ),
        )
        .unwrap();
        let first = refresh_session_index(&path, None).unwrap();
        let original = first.index.turns["one"].clone();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_started\",\"turn_id\":\"two\"}}}}"
        )
        .unwrap();

        let second = refresh_session_index(&path, Some(first)).unwrap();
        assert_eq!(second.index.turns["one"], original);
        assert_eq!(second.index.visible_turn_ids, vec!["one", "two"]);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn partial_line_is_parsed_once_after_completion() {
        let path = temp_path();
        fs::write(
            &path,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread\"}}\n{\"type\":\"event_msg\"",
        )
        .unwrap();
        let first = refresh_session_index(&path, None).unwrap();
        assert!(!first.trailing_partial_line.is_empty());
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            ",\"payload\":{{\"type\":\"task_started\",\"turn_id\":\"one\"}}}}"
        )
        .unwrap();
        let second = refresh_session_index(&path, Some(first)).unwrap();
        assert_eq!(second.index.visible_turn_ids, vec!["one"]);
        assert!(second.trailing_partial_line.is_empty());
        let _ = fs::remove_file(path);
    }

    fn temp_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "remux-codex-index-{}-{}.jsonl",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }
}
