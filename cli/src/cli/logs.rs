//! `remux logs` from pass 3b.
//!
//! Logs are read from disk so this command remains useful when the runtime is
//! down. Runtime JSONL gets a compact formatter by default; extension logs are
//! the flat files written by pass 1.

use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;

pub fn run(
    root: &Path,
    extension: Option<&str>,
    lines: usize,
    follow: bool,
    raw: bool,
) -> Result<i32, String> {
    let target = match extension {
        Some(id) => LogTarget::Extension(extension_log_path(root, id)?),
        None => LogTarget::Runtime(newest_runtime_log(root)?),
    };

    let offset = print_tail(&target, lines, raw)?;
    if follow {
        follow_file(&target, raw, offset)?;
    }
    Ok(0)
}

#[derive(Debug, Clone)]
enum LogTarget {
    Runtime(PathBuf),
    Extension(PathBuf),
}

impl LogTarget {
    fn path(&self) -> &Path {
        match self {
            LogTarget::Runtime(path) | LogTarget::Extension(path) => path,
        }
    }

    fn format(&self, line: &str, raw: bool) -> String {
        match self {
            LogTarget::Runtime(_) if !raw => pretty_runtime_line(line),
            _ => line.to_string(),
        }
    }
}

fn newest_runtime_log(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join(".remux/logs");
    let mut candidates = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !(name.starts_with("runtime-") && name.ends_with(".jsonl")) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        candidates.push((modified, path));
    }
    candidates
        .into_iter()
        .max_by_key(|(modified, path)| (*modified, path.clone()))
        .map(|(_, path)| path)
        .ok_or_else(|| format!("no runtime logs found in {}", dir.display()))
}

fn extension_log_path(root: &Path, extension_id: &str) -> Result<PathBuf, String> {
    let dir = root.join(".remux/logs/extensions");
    let path = dir.join(format!("{extension_id}.log"));
    if path.is_file() {
        return Ok(path);
    }
    let ids = extension_ids_in(&dir);
    if ids.is_empty() {
        Err(format!(
            "unknown extension {extension_id}; no extension logs found in {}",
            dir.display()
        ))
    } else {
        Err(format!(
            "unknown extension {extension_id}; available: {}",
            ids.join(", ")
        ))
    }
}

fn extension_ids_in(dir: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if let Some(id) = name.strip_suffix(".log") {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    ids
}

fn print_tail(target: &LogTarget, lines: usize, raw: bool) -> Result<u64, String> {
    let (tail, offset) = tail_lines(target.path(), lines)?;
    for line in tail {
        println!("{}", target.format(&line, raw));
    }
    Ok(offset)
}

fn tail_lines(path: &Path, lines: usize) -> Result<(Vec<String>, u64), String> {
    let bytes = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let offset = bytes.len() as u64;
    let source = String::from_utf8_lossy(&bytes);
    let mut out: Vec<String> = source
        .lines()
        .rev()
        .take(lines)
        .map(str::to_string)
        .collect();
    out.reverse();
    Ok((out, offset))
}

pub fn pretty_runtime_line(line: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return line.to_string();
    };
    let time = value
        .get("ts")
        .and_then(Value::as_str)
        .and_then(|ts| ts.get(11..19))
        .unwrap_or("--:--:--");
    let level = value.get("level").and_then(Value::as_str).unwrap_or("info");
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| value.get("label").and_then(Value::as_str))
        .unwrap_or("");
    let mut parts = vec![time.to_string(), level.to_string()];
    if !message.is_empty() {
        parts.push(message.to_string());
    }
    if let Some(extra) = extra_fields(&value) {
        parts.push(extra);
    }
    parts.join(" ")
}

fn extra_fields(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    let mut fields = Vec::new();
    for (key, item) in object {
        if matches!(key.as_str(), "ts" | "level" | "message" | "runId") {
            continue;
        }
        if is_empty_extra(item) {
            continue;
        }
        let rendered = match item {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        fields.push(format!("{key}={rendered}"));
    }
    if fields.is_empty() {
        None
    } else {
        Some(fields.join(" "))
    }
}

fn is_empty_extra(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(object) => object.is_empty(),
        _ => false,
    }
}

fn follow_file(target: &LogTarget, raw: bool, offset: u64) -> Result<(), String> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_signal = stop.clone();
    if let Err(error) = unsafe {
        signal_hook::low_level::register(signal_hook::consts::SIGINT, move || {
            stop_for_signal.store(true, Ordering::SeqCst);
        })
    } {
        eprintln!("remux: failed to install log follow signal handler: {error}");
    }

    let mut cursor = FollowCursor::open(target.path())?;
    cursor.seek_to(offset)?;
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(250));
        for line in cursor.read_new_lines()? {
            println!("{}", target.format(&line, raw));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    dev: u64,
    ino: u64,
    len: u64,
}

impl FileIdentity {
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            len: metadata.len(),
        }
    }
}

pub fn should_reopen(previous: FileIdentity, current: FileIdentity, offset: u64) -> bool {
    previous.dev != current.dev || previous.ino != current.ino || current.len < offset
}

struct FollowCursor {
    path: PathBuf,
    file: std::fs::File,
    identity: FileIdentity,
    offset: u64,
    pending: String,
}

impl FollowCursor {
    fn open(path: &Path) -> Result<Self, String> {
        let file =
            std::fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let identity = FileIdentity::from_metadata(
            &file
                .metadata()
                .map_err(|error| format!("{}: {error}", path.display()))?,
        );
        Ok(Self {
            path: path.to_path_buf(),
            file,
            identity,
            offset: 0,
            pending: String::new(),
        })
    }

    fn seek_to(&mut self, offset: u64) -> Result<(), String> {
        self.offset = self
            .file
            .seek(SeekFrom::Start(offset))
            .map_err(|error| format!("{}: {error}", self.path.display()))?;
        Ok(())
    }

    fn reopen(&mut self) -> Result<(), String> {
        self.file = std::fs::File::open(&self.path)
            .map_err(|error| format!("{}: {error}", self.path.display()))?;
        self.identity = FileIdentity::from_metadata(
            &self
                .file
                .metadata()
                .map_err(|error| format!("{}: {error}", self.path.display()))?,
        );
        self.offset = 0;
        self.pending.clear();
        Ok(())
    }

    fn read_new_lines(&mut self) -> Result<Vec<String>, String> {
        let metadata = std::fs::metadata(&self.path)
            .map_err(|error| format!("{}: {error}", self.path.display()))?;
        let current = FileIdentity::from_metadata(&metadata);
        if should_reopen(self.identity, current, self.offset) {
            self.reopen()?;
        }
        self.file
            .seek(SeekFrom::Start(self.offset))
            .map_err(|error| format!("{}: {error}", self.path.display()))?;
        let mut chunk = Vec::new();
        self.file
            .read_to_end(&mut chunk)
            .map_err(|error| format!("{}: {error}", self.path.display()))?;
        self.offset = self
            .file
            .stream_position()
            .map_err(|error| format!("{}: {error}", self.path.display()))?;
        if chunk.is_empty() {
            return Ok(Vec::new());
        }
        self.pending.push_str(&String::from_utf8_lossy(&chunk));
        let mut lines = Vec::new();
        while let Some(index) = self.pending.find('\n') {
            let line = self.pending[..index].trim_end_matches('\r').to_string();
            lines.push(line);
            self.pending = self.pending[index + 1..].to_string();
        }
        Ok(lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn pretty_prints_runtime_jsonl() {
        let line = r#"{"ts":"2026-07-07T12:34:56.000Z","level":"warn","message":"hello","runId":"r","label":"console","detail":{"x":1}}"#;
        assert_eq!(
            pretty_runtime_line(line),
            r#"12:34:56 warn hello label=console detail={"x":1}"#
        );
        assert_eq!(pretty_runtime_line("not json"), "not json");
    }

    #[test]
    fn extension_unknown_lists_available_ids() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(".remux/logs/extensions");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("terminal.log"), "").unwrap();
        std::fs::write(dir.join("terminal.log.1"), "").unwrap();
        std::fs::write(dir.join("editor.log"), "").unwrap();

        let err = extension_log_path(root.path(), "codex").unwrap_err();
        assert!(err.contains("editor, terminal"), "{err}");
    }

    #[test]
    fn tail_lines_tolerates_invalid_utf8_and_returns_byte_offset() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("extension.log");
        std::fs::write(&path, b"ok\nbad:\xff\n").unwrap();

        let (lines, offset) = tail_lines(&path, 10).unwrap();

        assert_eq!(offset, 9);
        assert_eq!(lines[0], "ok");
        assert!(lines[1].starts_with("bad:"));
    }

    #[test]
    fn follow_cursor_starts_at_tail_offset_without_dropping_appends() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runtime.log");
        std::fs::write(&path, b"first\n").unwrap();
        let (_, offset) = tail_lines(&path, 10).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"second\n")
            .unwrap();

        let mut cursor = FollowCursor::open(&path).unwrap();
        cursor.seek_to(offset).unwrap();

        assert_eq!(cursor.read_new_lines().unwrap(), vec!["second".to_string()]);
    }

    #[test]
    fn follow_reopens_on_inode_change_or_truncation() {
        let old = FileIdentity {
            dev: 1,
            ino: 10,
            len: 100,
        };
        assert!(should_reopen(
            old,
            FileIdentity {
                dev: 1,
                ino: 11,
                len: 5
            },
            100
        ));
        assert!(should_reopen(
            old,
            FileIdentity {
                dev: 1,
                ino: 10,
                len: 20
            },
            100
        ));
        assert!(!should_reopen(
            old,
            FileIdentity {
                dev: 1,
                ino: 10,
                len: 120
            },
            100
        ));
    }
}
