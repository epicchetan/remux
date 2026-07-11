//! Logging, replacing `cli/logger.cjs` and adding per-extension logs.
//!
//! Runtime journal: same JSONL event shape (`ts, level, source, runId,
//! scope?, label?, message?, detail?`) and detail-normalization caps
//! (8000-char strings, 50-element arrays, depth 5), written to
//! `.remux/logs/runtime-<runId>.jsonl` through a dedicated writer thread.
//! Intentional changes (spec §Behavior changes #5): no `current.jsonl`
//! double-write, boot-time retention by `log_retention_days`, and extension
//! stderr goes to per-extension rotated files + a 500-line ring instead of
//! the main journal.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use serde_json::{Map, Value};

use crate::rpc::ws::{DiagnosticEvent, WsClient, WsLog};
use crate::time::now_iso8601;

pub const MAX_STRING_LENGTH: usize = 8_000;
pub const MAX_ARRAY_LENGTH: usize = 50;
pub const MAX_DEPTH: usize = 5;

pub const EXTENSION_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const EXTENSION_LOG_ROTATIONS: u32 = 2;
pub const EXTENSION_LOG_RING_LINES: usize = 500;
pub const EXTENSION_LOG_FLUSH_MS: u64 = 100;

pub const LOGS_DID_APPEND_METHOD: &str = "remux/extensions/logs/didAppend";
pub const LOGS_SUBSCRIBE_METHOD: &str = "remux/extensions/logs/subscribe";
pub const LOGS_UNSUBSCRIBE_METHOD: &str = "remux/extensions/logs/unsubscribe";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalMode {
    Mirror,
    Silent,
}

#[derive(Debug, Clone)]
pub struct JournalEvent {
    pub detail: Option<Value>,
    pub label: Option<String>,
    pub level: &'static str,
    pub message: Option<String>,
    pub scope: Option<String>,
    pub source: String,
    pub terminal: TerminalMode,
    pub ts: Option<String>,
}

impl Default for JournalEvent {
    fn default() -> Self {
        Self {
            detail: None,
            label: None,
            level: "info",
            message: None,
            scope: None,
            source: "cli".to_string(),
            terminal: TerminalMode::Mirror,
            ts: None,
        }
    }
}

/// Where terminal-mirrored lines go; injectable for tests.
pub trait TerminalSink: Send + Sync {
    fn log(&self, message: &str);
    fn warn(&self, message: &str);
    fn error(&self, message: &str);
}

pub struct StdTerminal;

impl TerminalSink for StdTerminal {
    fn log(&self, message: &str) {
        println!("{message}");
    }
    fn warn(&self, message: &str) {
        eprintln!("{message}");
    }
    fn error(&self, message: &str) {
        eprintln!("{message}");
    }
}

enum WriterCommand {
    Line(String),
    Flush(std::sync::mpsc::Sender<()>),
}

pub struct Journal {
    pub logs_dir: PathBuf,
    pub run_id: String,
    pub run_path: PathBuf,
    writer: std::sync::mpsc::Sender<WriterCommand>,
    terminal: Arc<dyn TerminalSink>,
}

impl Journal {
    pub fn new(
        root_dir: &Path,
        retention_days: u32,
        terminal: Arc<dyn TerminalSink>,
    ) -> std::io::Result<Arc<Self>> {
        let logs_dir = root_dir.join(".remux/logs");
        std::fs::create_dir_all(&logs_dir)?;

        apply_retention(&logs_dir, retention_days);

        let run_id = run_id_from_iso(&now_iso8601());
        let run_path = logs_dir.join(format!("runtime-{run_id}.jsonl"));

        // Dedicated writer thread: one open append handle, drains bursts into
        // a single write. Replaces the two synchronous file opens per event.
        let (sender, receiver) = std::sync::mpsc::channel::<WriterCommand>();
        let writer_path = run_path.clone();
        std::thread::Builder::new()
            .name("remux-journal".to_string())
            .spawn(move || {
                let mut file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&writer_path)
                    .ok();
                while let Ok(command) = receiver.recv() {
                    let mut batch = String::new();
                    let mut flush_acks = Vec::new();
                    let mut queue = Some(command);
                    while let Some(command) = queue.take() {
                        match command {
                            WriterCommand::Line(line) => batch.push_str(&line),
                            WriterCommand::Flush(ack) => flush_acks.push(ack),
                        }
                        queue = receiver.try_recv().ok();
                    }
                    if let Some(file) = file.as_mut() {
                        if let Err(error) = file.write_all(batch.as_bytes()) {
                            eprintln!("[remux] failed to write log: {error}");
                        }
                        let _ = file.flush();
                    }
                    for ack in flush_acks {
                        let _ = ack.send(());
                    }
                }
            })?;

        Ok(Arc::new(Self {
            logs_dir,
            run_id,
            run_path,
            writer: sender,
            terminal,
        }))
    }

    pub fn event(&self, event: JournalEvent) -> Value {
        let mut entry = Map::new();
        entry.insert(
            "ts".to_string(),
            Value::from(event.ts.clone().unwrap_or_else(now_iso8601)),
        );
        entry.insert("level".to_string(), Value::from(event.level));
        entry.insert("source".to_string(), Value::from(event.source.clone()));
        entry.insert("runId".to_string(), Value::from(self.run_id.clone()));
        if let Some(scope) = &event.scope {
            entry.insert("scope".to_string(), Value::from(scope.clone()));
        }
        if let Some(label) = &event.label {
            entry.insert("label".to_string(), Value::from(label.clone()));
        }
        if let Some(message) = &event.message {
            entry.insert("message".to_string(), Value::from(message.clone()));
        }
        if let Some(detail) = &event.detail {
            entry.insert("detail".to_string(), normalize_detail(detail, 0));
        }
        let entry = Value::Object(entry);

        let _ = self.writer.send(WriterCommand::Line(format!("{entry}\n")));

        if event.terminal != TerminalMode::Silent {
            let fallback = event.label.clone().unwrap_or_else(|| event.source.clone());
            let message = event.message.clone().unwrap_or(fallback);
            let text = match &event.detail {
                None => message,
                Some(Value::String(detail)) => format!("{message} {detail}"),
                Some(detail) => format!("{message} {}", normalize_detail(detail, 0)),
            };
            match event.level {
                "error" => self.terminal.error(&text),
                "warn" => self.terminal.warn(&text),
                _ => self.terminal.log(&text),
            }
        }

        entry
    }

    pub fn log(&self, message: &str) {
        self.console("info", message);
    }

    pub fn warn(&self, message: &str) {
        self.console("warn", message);
    }

    pub fn error(&self, message: &str) {
        self.console("error", message);
    }

    fn console(&self, level: &'static str, message: &str) {
        self.event(JournalEvent {
            label: Some("console".to_string()),
            level,
            message: Some(message.to_string()),
            ..Default::default()
        });
    }

    /// Blocks until every queued entry is on disk. Test-only aid.
    pub fn flush(&self) {
        let (sender, receiver) = std::sync::mpsc::channel();
        if self.writer.send(WriterCommand::Flush(sender)).is_ok() {
            let _ = receiver.recv_timeout(std::time::Duration::from_secs(5));
        }
    }
}

impl WsLog for Journal {
    fn log(&self, message: &str) {
        Journal::log(self, message);
    }
    fn warn(&self, message: &str) {
        Journal::warn(self, message);
    }
    fn error(&self, message: &str) {
        Journal::error(self, message);
    }
    fn event(&self, event: DiagnosticEvent) {
        Journal::event(
            self,
            JournalEvent {
                detail: event.detail,
                label: Some(event.label),
                level: event.level,
                message: Some(event.message),
                scope: None,
                source: "app".to_string(),
                terminal: TerminalMode::Mirror,
                ts: event.ts,
            },
        );
    }
}

/// Boot-time retention: delete `*.jsonl` run files older than the retention
/// window. The old CLI's `current.jsonl`/`<runId>.jsonl` naming matches the
/// same glob, so the pre-cutover backlog ages out too.
fn apply_retention(logs_dir: &Path, retention_days: u32) {
    let Ok(entries) = std::fs::read_dir(logs_dir) else {
        return;
    };
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(u64::from(retention_days) * 86_400);

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|ext| ext != "jsonl").unwrap_or(true) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
        if modified < cutoff {
            let _ = std::fs::remove_file(&path);
        }
    }
}

pub fn run_id_from_iso(iso: &str) -> String {
    iso.replace([':', '.'], "-")
}

/// Port of `normalizeDetail`: strings truncated at 8000 chars, arrays capped
/// at 50 elements, objects recursed to depth 5.
pub fn normalize_detail(value: &Value, depth: usize) -> Value {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(text) => Value::from(truncate_string(text)),
        Value::Array(items) => {
            if depth >= MAX_DEPTH {
                return Value::from("[MaxDepth]");
            }
            Value::Array(
                items
                    .iter()
                    .take(MAX_ARRAY_LENGTH)
                    .map(|item| normalize_detail(item, depth + 1))
                    .collect(),
            )
        }
        Value::Object(record) => {
            if depth >= MAX_DEPTH {
                return Value::from("[MaxDepth]");
            }
            let mut normalized = Map::new();
            for (key, item) in record {
                normalized.insert(key.clone(), normalize_detail(item, depth + 1));
            }
            Value::Object(normalized)
        }
    }
}

fn truncate_string(value: &str) -> String {
    if value.chars().count() <= MAX_STRING_LENGTH {
        return value.to_string();
    }
    let truncated: String = value.chars().take(MAX_STRING_LENGTH).collect();
    format!(
        "{truncated}... [truncated {} chars]",
        value.chars().count() - MAX_STRING_LENGTH
    )
}

// ---------------------------------------------------------------------------
// Per-extension logs: rotated files + in-memory ring + live subscriptions.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ExtensionLogLine {
    pub ts: String,
    pub stream: String,
    pub line: String,
    pub area: LogArea,
    pub component_id: String,
    pub source: LogSource,
    pub channel: Option<LogChannel>,
    pub level: Option<LogLevel>,
    pub view_id: Option<String>,
}

impl ExtensionLogLine {
    fn to_value(&self) -> Value {
        serde_json::json!({
            "ts": self.ts,
            "stream": self.stream,
            "line": self.line,
            "area": self.area.as_str(),
            "componentId": self.component_id,
            "source": self.source.as_str(),
            "channel": self.channel.map(LogChannel::as_str),
            "level": self.level.map(LogLevel::as_str),
            "viewId": self.view_id,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogArea {
    Server,
    Viewer,
}

impl LogArea {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Server => "server",
            Self::Viewer => "viewer",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogSource {
    Lifecycle,
    Process,
    Connection,
    Build,
    Watch,
    Update,
}

impl LogSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lifecycle => "lifecycle",
            Self::Process => "process",
            Self::Connection => "connection",
            Self::Build => "build",
            Self::Watch => "watch",
            Self::Update => "update",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogChannel {
    Stdout,
    Stderr,
}

impl LogChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExtensionLogMeta {
    pub area: LogArea,
    pub component_id: String,
    pub source: LogSource,
    pub channel: Option<LogChannel>,
    pub level: Option<LogLevel>,
    pub view_id: Option<String>,
    pub legacy_stream: &'static str,
}

impl ExtensionLogMeta {
    pub fn extension_server(
        source: LogSource,
        channel: Option<LogChannel>,
        level: Option<LogLevel>,
        legacy_stream: &'static str,
    ) -> Self {
        Self {
            area: LogArea::Server,
            component_id: "extension-server".to_string(),
            source,
            channel,
            level,
            view_id: None,
            legacy_stream,
        }
    }

    pub fn viewer(
        view_id: impl Into<String>,
        source: LogSource,
        channel: Option<LogChannel>,
        level: Option<LogLevel>,
        legacy_stream: &'static str,
    ) -> Self {
        let view_id = view_id.into();
        Self {
            area: LogArea::Viewer,
            component_id: format!("viewer:{view_id}"),
            source,
            channel,
            level,
            view_id: Some(view_id),
            legacy_stream,
        }
    }

    pub fn codex_app_server(
        source: LogSource,
        channel: Option<LogChannel>,
        level: Option<LogLevel>,
    ) -> Self {
        Self {
            area: LogArea::Server,
            component_id: "codex-app-server".to_string(),
            source,
            channel,
            level,
            view_id: None,
            legacy_stream: "lifecycle",
        }
    }
}

struct ExtensionLogState {
    ring: VecDeque<ExtensionLogLine>,
    file: Option<std::fs::File>,
    size: u64,
    subscribers: Vec<Weak<WsClient>>,
    pending: Vec<ExtensionLogLine>,
    flush_scheduled: bool,
}

pub struct ExtensionLogs {
    dir: PathBuf,
    states: Mutex<HashMap<String, ExtensionLogState>>,
}

impl ExtensionLogs {
    pub fn new(root_dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            dir: root_dir.join(".remux/logs/extensions"),
            states: Mutex::new(HashMap::new()),
        })
    }

    pub fn append(self: &Arc<Self>, extension_id: &str, meta: ExtensionLogMeta, line: &str) {
        let entry = ExtensionLogLine {
            ts: now_iso8601(),
            stream: meta.legacy_stream.to_string(),
            line: line.to_string(),
            area: meta.area,
            component_id: meta.component_id,
            source: meta.source,
            channel: meta.channel,
            level: meta.level,
            view_id: meta.view_id,
        };

        let mut states = self.states.lock().unwrap();
        let state = self.state_entry(&mut states, extension_id);

        // Rotated file write.
        let channel = entry
            .channel
            .map(|channel| format!(":{}", channel.as_str()))
            .unwrap_or_default();
        let file_line = format!(
            "{} [{}/{}/{}{}] {}\n",
            entry.ts,
            entry.area.as_str(),
            entry.component_id,
            entry.source.as_str(),
            channel,
            entry.line
        );
        let line_bytes = file_line.len() as u64;
        if state.size + line_bytes > EXTENSION_LOG_MAX_BYTES {
            state.file = None;
            rotate_logs(&self.dir, extension_id);
            state.file = open_extension_log(&self.dir, extension_id);
            state.size = 0;
        }
        if let Some(file) = state.file.as_mut() {
            if file.write_all(file_line.as_bytes()).is_ok() {
                state.size += line_bytes;
            }
        }

        // Ring.
        state.ring.push_back(entry.clone());
        while state.ring.len() > EXTENSION_LOG_RING_LINES {
            state.ring.pop_front();
        }

        // Live subscriptions, batched ~100ms.
        state.subscribers.retain(|weak| weak.strong_count() > 0);
        if !state.subscribers.is_empty() {
            state.pending.push(entry);
            if !state.flush_scheduled {
                state.flush_scheduled = true;
                let logs = self.clone();
                let extension_id = extension_id.to_string();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(EXTENSION_LOG_FLUSH_MS))
                        .await;
                    logs.flush_pending(&extension_id);
                });
            }
        }
    }

    fn flush_pending(&self, extension_id: &str) {
        let (lines, subscribers) = {
            let mut states = self.states.lock().unwrap();
            let Some(state) = states.get_mut(extension_id) else {
                return;
            };
            state.flush_scheduled = false;
            let lines: Vec<Value> = state
                .pending
                .drain(..)
                .map(|line| line.to_value())
                .collect();
            (lines, state.subscribers.clone())
        };
        if lines.is_empty() {
            return;
        }

        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": LOGS_DID_APPEND_METHOD,
            "params": { "extensionId": extension_id, "lines": lines },
        });
        for weak in subscribers {
            if let Some(client) = weak.upgrade() {
                client.send_message(&notification);
            }
        }
    }

    pub fn snapshot(&self, extension_id: &str, lines: usize) -> Value {
        let states = self.states.lock().unwrap();
        let Some(state) = states.get(extension_id) else {
            return Value::Array(Vec::new());
        };
        let skip = state.ring.len().saturating_sub(lines);
        Value::Array(
            state
                .ring
                .iter()
                .skip(skip)
                .map(|line| line.to_value())
                .collect(),
        )
    }

    pub fn subscribe(&self, extension_id: &str, client: &Arc<WsClient>) {
        let mut states = self.states.lock().unwrap();
        let state = self.state_entry(&mut states, extension_id);
        state.subscribers.retain(|weak| weak.strong_count() > 0);
        if !state
            .subscribers
            .iter()
            .any(|weak| weak.as_ptr() == Arc::as_ptr(client))
        {
            state.subscribers.push(Arc::downgrade(client));
        }
    }

    pub fn unsubscribe(&self, extension_id: &str, client: &Arc<WsClient>) {
        let mut states = self.states.lock().unwrap();
        if let Some(state) = states.get_mut(extension_id) {
            state
                .subscribers
                .retain(|weak| weak.strong_count() > 0 && weak.as_ptr() != Arc::as_ptr(client));
        }
    }

    fn state_entry<'a>(
        &self,
        states: &'a mut HashMap<String, ExtensionLogState>,
        extension_id: &str,
    ) -> &'a mut ExtensionLogState {
        states.entry(extension_id.to_string()).or_insert_with(|| {
            let _ = std::fs::create_dir_all(&self.dir);
            let file = open_extension_log(&self.dir, extension_id);
            let size = file
                .as_ref()
                .and_then(|file| file.metadata().ok())
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            ExtensionLogState {
                ring: VecDeque::new(),
                file,
                size,
                subscribers: Vec::new(),
                pending: Vec::new(),
                flush_scheduled: false,
            }
        })
    }
}

/// `remux/extensions/logs/subscribe|unsubscribe` are client-scoped: the
/// subscription lives and dies with the WebSocket.
impl crate::rpc::ws::ClientScopedRpc for ExtensionLogs {
    fn handle(
        &self,
        client: &Arc<WsClient>,
        method: &str,
        params: Option<&Value>,
    ) -> Option<crate::rpc::router::RpcResult> {
        if method != LOGS_SUBSCRIBE_METHOD && method != LOGS_UNSUBSCRIBE_METHOD {
            return None;
        }

        let extension_id = params
            .and_then(|params| params.get("extensionId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let Some(extension_id) = extension_id else {
            return Some(Err(crate::rpc::jsonrpc::JsonRpcError::new(
                crate::rpc::jsonrpc::INVALID_PARAMS,
                format!("Invalid {method} params"),
            )));
        };

        if method == LOGS_SUBSCRIBE_METHOD {
            self.subscribe(extension_id, client);
        } else {
            self.unsubscribe(extension_id, client);
        }
        Some(Ok(serde_json::json!({ "ok": true })))
    }
}

fn open_extension_log(dir: &Path, extension_id: &str) -> Option<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{extension_id}.log")))
        .ok()
}

fn rotate_logs(dir: &Path, extension_id: &str) {
    let base = dir.join(format!("{extension_id}.log"));
    let _ = std::fs::remove_file(dir.join(format!("{extension_id}.log.{EXTENSION_LOG_ROTATIONS}")));
    for index in (1..EXTENSION_LOG_ROTATIONS).rev() {
        let from = dir.join(format!("{extension_id}.log.{index}"));
        let to = dir.join(format!("{extension_id}.log.{}", index + 1));
        let _ = std::fs::rename(from, to);
    }
    let _ = std::fs::rename(&base, dir.join(format!("{extension_id}.log.1")));
}

#[cfg(test)]
mod tests {
    use super::*;

    struct CapturingTerminal {
        lines: Mutex<Vec<(String, String)>>,
    }

    impl TerminalSink for CapturingTerminal {
        fn log(&self, message: &str) {
            self.lines
                .lock()
                .unwrap()
                .push(("log".to_string(), message.to_string()));
        }
        fn warn(&self, message: &str) {
            self.lines
                .lock()
                .unwrap()
                .push(("warn".to_string(), message.to_string()));
        }
        fn error(&self, message: &str) {
            self.lines
                .lock()
                .unwrap()
                .push(("error".to_string(), message.to_string()));
        }
    }

    fn read_jsonl(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn journal_writes_structured_run_log_and_mirrors_terminal() {
        let root = tempfile::tempdir().unwrap();
        let terminal = Arc::new(CapturingTerminal {
            lines: Mutex::new(Vec::new()),
        });
        let journal = Journal::new(root.path(), 14, terminal.clone()).unwrap();

        journal.event(JournalEvent {
            detail: Some(serde_json::json!({ "nested": { "ok": true } })),
            label: Some("test:event".to_string()),
            source: "test".to_string(),
            terminal: TerminalMode::Silent,
            ..Default::default()
        });
        Journal::warn(&journal, "visible warning");
        journal.flush();

        let entries = read_jsonl(&journal.run_path);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["label"], "test:event");
        assert_eq!(entries[0]["source"], "test");
        assert_eq!(entries[0]["runId"], Value::from(journal.run_id.clone()));
        assert_eq!(
            entries[0]["detail"],
            serde_json::json!({ "nested": { "ok": true } })
        );
        assert_eq!(entries[1]["level"], "warn");
        assert_eq!(entries[1]["message"], "visible warning");
        assert_eq!(
            *terminal.lines.lock().unwrap(),
            vec![("warn".to_string(), "visible warning".to_string())]
        );

        // No current.jsonl double-write.
        assert!(!journal.logs_dir.join("current.jsonl").exists());
        // Run file uses the runtime- prefix and the [:.] -> '-' run id format.
        let name = journal
            .run_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(name.starts_with("runtime-"), "{name}");
        assert!(!name.contains(':') && name.ends_with("Z.jsonl"), "{name}");
    }

    #[test]
    fn normalize_detail_applies_caps() {
        let long = "x".repeat(MAX_STRING_LENGTH + 5);
        let normalized = normalize_detail(&Value::from(long), 0);
        let text = normalized.as_str().unwrap();
        assert!(text.ends_with("... [truncated 5 chars]"));

        let big_array = Value::Array(vec![Value::from(1); 60]);
        assert_eq!(
            normalize_detail(&big_array, 0).as_array().unwrap().len(),
            MAX_ARRAY_LENGTH
        );

        let mut deep = serde_json::json!("leaf");
        for _ in 0..6 {
            deep = serde_json::json!({ "next": deep });
        }
        let normalized = normalize_detail(&deep, 0);
        let mut cursor = &normalized;
        for _ in 0..MAX_DEPTH {
            cursor = &cursor["next"];
        }
        assert_eq!(cursor, &Value::from("[MaxDepth]"));
    }

    #[test]
    fn retention_deletes_old_run_files_including_legacy_names() {
        let root = tempfile::tempdir().unwrap();
        let logs_dir = root.path().join(".remux/logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        let old_file = logs_dir.join("current.jsonl");
        std::fs::write(&old_file, "old").unwrap();
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(20 * 86_400);
        set_mtime(&old_file, old_time);
        let fresh_file = logs_dir.join("2026-07-06T00-00-00-000Z.jsonl");
        std::fs::write(&fresh_file, "fresh").unwrap();
        let keep_file = logs_dir.join("notes.txt");
        std::fs::write(&keep_file, "keep").unwrap();
        set_mtime(&keep_file, old_time);

        let terminal: Arc<dyn TerminalSink> = Arc::new(StdTerminal);
        let _journal = Journal::new(root.path(), 14, terminal).unwrap();

        assert!(!old_file.exists());
        assert!(fresh_file.exists());
        assert!(keep_file.exists(), "non-jsonl files are untouched");
    }

    fn set_mtime(path: &Path, time: std::time::SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(
            std::fs::FileTimes::new()
                .set_accessed(time)
                .set_modified(time),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn extension_logs_ring_snapshot_and_rotation() {
        let root = tempfile::tempdir().unwrap();
        let logs = ExtensionLogs::new(root.path());

        for index in 0..(EXTENSION_LOG_RING_LINES + 10) {
            logs.append(
                "codex",
                ExtensionLogMeta::extension_server(
                    LogSource::Process,
                    Some(LogChannel::Stderr),
                    None,
                    "stderr",
                ),
                &format!("line {index}"),
            );
        }

        let snapshot = logs.snapshot("codex", 3);
        let lines = snapshot.as_array().unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(
            lines[2]["line"],
            format!("line {}", EXTENSION_LOG_RING_LINES + 9)
        );
        assert_eq!(lines[2]["stream"], "stderr");
        assert_eq!(lines[2]["area"], "server");
        assert_eq!(lines[2]["componentId"], "extension-server");
        assert_eq!(lines[2]["source"], "process");
        assert_eq!(lines[2]["channel"], "stderr");
        assert!(lines[2]["level"].is_null());

        let full = logs.snapshot("codex", 10_000);
        assert_eq!(full.as_array().unwrap().len(), EXTENSION_LOG_RING_LINES);

        assert!(root
            .path()
            .join(".remux/logs/extensions/codex.log")
            .exists());

        // Rotation: force by writing oversized lines.
        let big = "y".repeat(1024 * 1024);
        for _ in 0..7 {
            logs.append(
                "bulky",
                ExtensionLogMeta::viewer(
                    "main",
                    LogSource::Watch,
                    Some(LogChannel::Stdout),
                    None,
                    "watch",
                ),
                &big,
            );
        }
        let dir = root.path().join(".remux/logs/extensions");
        assert!(dir.join("bulky.log").exists());
        assert!(dir.join("bulky.log.1").exists());
        // Never more rotations than configured.
        assert!(!dir
            .join(format!("bulky.log.{}", EXTENSION_LOG_ROTATIONS + 1))
            .exists());

        let text = std::fs::read_to_string(dir.join("codex.log")).unwrap();
        assert!(text.contains("[server/extension-server/process:stderr]"));
    }
}
