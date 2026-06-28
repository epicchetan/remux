use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{Value, json};

use crate::transcript::{SessionIndex, TurnRange};
use crate::util::{number_as_i64, payload_value};

pub(crate) fn build_session_index(path: &Path) -> Result<SessionIndex, String> {
    let lines = read_lines_with_offsets(path)?;
    let mut current: Option<TurnRange> = None;
    let mut rollback_hidden_turn_ids = Vec::new();
    let mut session_id = None;
    let mut turns: HashMap<String, TurnRange> = HashMap::new();
    let mut visible_turn_ids: Vec<String> = Vec::new();

    for entry in lines {
        let row = parse_row(&entry.line);
        if session_id.is_none() {
            session_id = row
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
                remember_visible_turn(&mut turns, &mut visible_turn_ids, open);
            }

            if let Some(turn_id) = payload
                .and_then(|value| value.get("turn_id"))
                .and_then(Value::as_str)
            {
                current = Some(TurnRange {
                    turn_id: turn_id.to_string(),
                    start_offset: entry.start_offset,
                    end_offset: entry.end_offset,
                    started_at: payload
                        .and_then(|value| value.get("started_at"))
                        .and_then(number_as_i64),
                    completed_at: None,
                    duration_ms: None,
                    status: "inProgress".to_string(),
                });
            }
            continue;
        }

        if payload_type == Some("thread_rolled_back") {
            if let Some(mut open) = current.take() {
                open.end_offset = entry.start_offset;
                open.status = "interrupted".to_string();
                remember_visible_turn(&mut turns, &mut visible_turn_ids, open);
            }
            let count = payload
                .and_then(|value| value.get("num_turns"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            for hidden_turn_id in truncate_visible_turns(&mut visible_turn_ids, count) {
                turns.remove(&hidden_turn_id);
                rollback_hidden_turn_ids.push(hidden_turn_id);
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
                let open = current.as_mut().expect("open turn exists");
                open.end_offset = entry.end_offset;
                apply_turn_completion(open, payload, payload_type);
                let finished = current.take().expect("open turn exists");
                remember_visible_turn(&mut turns, &mut visible_turn_ids, finished);
            } else if let Some(event_turn_id) = event_turn_id {
                update_remembered_turn_completion(
                    &mut turns,
                    event_turn_id,
                    entry.end_offset,
                    payload,
                    payload_type,
                );
            }
            continue;
        }

        let Some(open) = current.as_mut() else {
            continue;
        };
        open.end_offset = entry.end_offset;
    }

    if let Some(open) = current {
        remember_visible_turn(&mut turns, &mut visible_turn_ids, open);
    }

    Ok(SessionIndex {
        rollback_hidden_turn_ids,
        session_id,
        visible_turn_ids,
        turns,
    })
}

pub(crate) fn read_rows_range(path: &Path, range: &TurnRange) -> Result<Vec<Value>, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(range.start_offset))
        .map_err(|error| error.to_string())?;
    let len = range.end_offset.saturating_sub(range.start_offset) as usize;
    let mut buffer = vec![0; len];
    file.read_exact(&mut buffer)
        .map_err(|error| error.to_string())?;
    let text = String::from_utf8_lossy(&buffer);
    let mut rows = Vec::new();
    for line in text.lines() {
        if is_compacted_line(line) {
            rows.push(json!({ "type": "compacted" }));
            continue;
        }
        if let Ok(row) = serde_json::from_str::<Value>(line) {
            if row_belongs_to_turn(&row, &range.turn_id) {
                rows.push(row);
            }
        }
    }
    Ok(rows)
}

pub(crate) fn discover_session_files(codex_home: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for root in [
        codex_home.join("sessions"),
        codex_home.join("archived_sessions"),
    ] {
        if root.is_dir() {
            discover_session_files_recursive(&root, &mut files)?;
        }
    }
    Ok(files)
}

pub(crate) fn file_revision(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    Ok(format!("{}:{modified}", metadata.len()))
}

pub(crate) fn session_meta_id(path: &Path) -> Option<String> {
    let lines = read_lines_with_offsets(path).ok()?;
    for entry in lines.into_iter().take(20) {
        let row = parse_row(&entry.line)?;
        if let Some(id) = session_id_from_row(&row) {
            return Some(id);
        }
    }
    session_id_from_filename(path)
}

#[derive(Debug)]
struct LineEntry {
    start_offset: u64,
    end_offset: u64,
    line: String,
}

fn read_lines_with_offsets(path: &Path) -> Result<Vec<LineEntry>, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    let mut start = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let end = index + 1;
        entries.push(LineEntry {
            start_offset: start as u64,
            end_offset: end as u64,
            line: strip_line_endings(&bytes[start..index]),
        });
        start = end;
    }
    if start < bytes.len() {
        entries.push(LineEntry {
            start_offset: start as u64,
            end_offset: bytes.len() as u64,
            line: strip_line_endings(&bytes[start..]),
        });
    }
    Ok(entries)
}

fn parse_row(line: &str) -> Option<Value> {
    if is_compacted_line(line) {
        return Some(json!({ "type": "compacted" }));
    }
    serde_json::from_str::<Value>(line).ok()
}

fn is_compacted_line(line: &str) -> bool {
    line.contains("\"type\"") && line.contains("\"compacted\"")
}

fn strip_line_endings(bytes: &[u8]) -> String {
    let mut value = String::from_utf8_lossy(bytes).to_string();
    if value.ends_with('\r') {
        value.pop();
    }
    value
}

fn session_id_from_row(row: &Value) -> Option<String> {
    if row.get("type").and_then(Value::as_str) == Some("session_meta") {
        if let Some(id) = row
            .get("payload")
            .and_then(|payload| payload.get("id"))
            .and_then(Value::as_str)
        {
            return Some(id.to_string());
        }
        if let Some(id) = row.get("id").and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    None
}

fn session_id_from_filename(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let without_ext = name.strip_suffix(".jsonl").unwrap_or(name);
    if let Some(index) = without_ext.find("019") {
        return Some(without_ext[index..].to_string());
    }
    None
}

fn discover_session_files_recursive(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            discover_session_files_recursive(&path, files)?;
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            files.push(path);
        }
    }
    Ok(())
}

fn remember_visible_turn(
    turns: &mut HashMap<String, TurnRange>,
    visible_turn_ids: &mut Vec<String>,
    range: TurnRange,
) {
    if !visible_turn_ids.contains(&range.turn_id) {
        visible_turn_ids.push(range.turn_id.clone());
    }
    turns.insert(range.turn_id.clone(), range);
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

fn update_remembered_turn_completion(
    turns: &mut HashMap<String, TurnRange>,
    turn_id: &str,
    end_offset: u64,
    payload: Option<&Value>,
    payload_type: Option<&str>,
) {
    let Some(range) = turns.get_mut(turn_id) else {
        return;
    };
    range.end_offset = range.end_offset.max(end_offset);
    apply_turn_completion(range, payload, payload_type);
}

fn row_belongs_to_turn(row: &Value, turn_id: &str) -> bool {
    row_turn_id(row).is_none_or(|row_turn_id| row_turn_id == turn_id)
}

fn row_turn_id(row: &Value) -> Option<&str> {
    let payload = payload_value(row).unwrap_or(row);
    payload
        .get("turn_id")
        .and_then(Value::as_str)
        .or_else(|| payload.get("turnId").and_then(Value::as_str))
        .or_else(|| {
            payload
                .get("internal_chat_message_metadata_passthrough")
                .and_then(|metadata| metadata.get("turn_id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            payload
                .get("metadata")
                .and_then(|metadata| metadata.get("turn_id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            payload
                .get("item")
                .and_then(|item| item.get("turn_id").or_else(|| item.get("turnId")))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            payload
                .get("item")
                .and_then(|item| item.get("internal_chat_message_metadata_passthrough"))
                .and_then(|metadata| metadata.get("turn_id"))
                .and_then(Value::as_str)
        })
}

fn truncate_visible_turns(visible_turn_ids: &mut Vec<String>, count: usize) -> Vec<String> {
    if count == 0 {
        return Vec::new();
    }
    let next_len = visible_turn_ids.len().saturating_sub(count);
    visible_turn_ids.split_off(next_len)
}
