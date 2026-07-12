mod index;
mod reader;

use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{Value, json};

use crate::transcript::{SessionIndex, TurnRange};
use crate::util::payload_value;

pub(crate) use index::{IncrementalSessionIndex, refresh_session_index};

pub(crate) fn build_session_index(path: &Path) -> Result<SessionIndex, String> {
    index::build_session_index(path)
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
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(20) {
        let row = serde_json::from_str::<Value>(&line.ok()?).ok()?;
        if let Some(id) = session_id_from_row(&row) {
            return Some(id);
        }
    }
    session_id_from_filename(path)
}

fn is_compacted_line(line: &str) -> bool {
    line.contains("\"type\"") && line.contains("\"compacted\"")
}

pub(super) fn session_id_from_row(row: &Value) -> Option<String> {
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

pub(super) fn session_id_from_filename(path: &Path) -> Option<String> {
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
