use std::collections::{HashMap, VecDeque};
use std::env;
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

mod tmux;

const SESSION_LIST_METHOD: &str = "remux/terminal/session/list";
const SESSION_START_METHOD: &str = "remux/terminal/session/start";
const SESSION_ATTACH_METHOD: &str = "remux/terminal/session/attach";
const SESSION_WRITE_METHOD: &str = "remux/terminal/session/write";
const SESSION_RESIZE_METHOD: &str = "remux/terminal/session/resize";
const SESSION_KILL_METHOD: &str = "remux/terminal/session/kill";
const TMUX_CONTEXT_GET_METHOD: &str = "remux/terminal/tmux/context/get";
const TMUX_ACTION_METHOD: &str = "remux/terminal/tmux/action";

const SESSION_OUTPUT_NOTIFICATION: &str = "remux/terminal/session/output";
const SESSION_EXITED_NOTIFICATION: &str = "remux/terminal/session/exited";
const REMUX_NOTIFICATION_AUDIENCE_REMOVE_METHOD: &str = "remux/notifications/audience/remove";
const REMUX_NOTIFICATION_REQUEST_METHOD: &str = "remux/notifications/request";

const MAX_REPLAY_BYTES: usize = 4 * 1024 * 1024;
const MAX_REPLAY_FRAMES: usize = 10_000;
// PTY read sizing and burst coalescing. A single read already returns everything
// currently buffered (up to the buffer size), so reading large keeps the syscall
// count down. The coalescer then merges a burst of reads triggered by one
// keystroke (tab-completion, line rewrap, command output) into a single frame so
// it crosses the wire as one packet instead of a flurry.
const READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_COALESCED_BYTES: usize = 256 * 1024;
const OUTPUT_COALESCE_WINDOW: Duration = Duration::from_millis(3);
const MAX_NOTIFICATION_OSC_BYTES: usize = 16 * 1024;
const MAX_PENDING_KITTY_NOTIFICATIONS: usize = 64;
const NOTIFICATION_TITLE_MAX_CHARS: usize = 120;
const NOTIFICATION_BODY_MAX_CHARS: usize = 240;
const BELL_NOTIFICATION_MIN_INTERVAL_MS: u64 = 10_000;
const DUPLICATE_NOTIFICATION_MIN_INTERVAL_MS: u64 = 2_000;
const SHELL_INTEGRATION_ENV: &str = "REMUX_TERMINAL_SHELL_INTEGRATION";

fn main() {
    if let Err(error) = run_stdio_server() {
        eprintln!("server failed: {error}");
        std::process::exit(1);
    }
}

fn run_stdio_server() -> Result<(), String> {
    let stdin = io::stdin();
    let (output_tx, output_rx) = mpsc::channel::<Value>();
    spawn_stdout_writer(output_rx);
    let server = TerminalExtensionServer::new(output_tx.clone());

    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(request) => handle_request(&server, request),
            Err(error) => JsonRpcResponse::error(
                Value::Null,
                JsonRpcError::new(-32700, format!("Parse error: {error}")),
            ),
        };

        let response = serde_json::to_value(response).map_err(|error| error.to_string())?;
        output_tx
            .send(response)
            .map_err(|error| format!("failed to write response: {error}"))?;
    }

    server.kill_all();
    Ok(())
}

fn handle_request(server: &TerminalExtensionServer, request: JsonRpcRequest) -> JsonRpcResponse {
    let result = match request.method.as_str() {
        SESSION_LIST_METHOD => server.list_sessions(),
        SESSION_START_METHOD => server.start_session(request.params.unwrap_or(Value::Null)),
        SESSION_ATTACH_METHOD => server.attach_session(request.params.unwrap_or(Value::Null)),
        SESSION_WRITE_METHOD => server.write_session(request.params.unwrap_or(Value::Null)),
        SESSION_RESIZE_METHOD => server.resize_session(request.params.unwrap_or(Value::Null)),
        SESSION_KILL_METHOD => server.kill_session(request.params.unwrap_or(Value::Null)),
        TMUX_CONTEXT_GET_METHOD => server.tmux_context(request.params.unwrap_or(Value::Null)),
        TMUX_ACTION_METHOD => server.tmux_action(request.params.unwrap_or(Value::Null)),
        _ => {
            return JsonRpcResponse::error(
                request.id,
                JsonRpcError::new(-32601, format!("Unknown method: {}", request.method)),
            );
        }
    };

    match result {
        Ok(value) => JsonRpcResponse::result(request.id, value),
        Err(error) => JsonRpcResponse::error(request.id, JsonRpcError::new(-32000, error)),
    }
}

#[derive(Clone)]
struct TerminalExtensionServer {
    output_tx: mpsc::Sender<Value>,
    state: Arc<Mutex<TerminalState>>,
}

impl TerminalExtensionServer {
    fn new(output_tx: mpsc::Sender<Value>) -> Self {
        Self {
            output_tx,
            state: Arc::new(Mutex::new(TerminalState::default())),
        }
    }

    fn list_sessions(&self) -> Result<Value, String> {
        let state = self.lock_state()?;
        let sessions = state
            .sessions
            .values()
            .map(SessionRecord::summary)
            .collect::<Vec<_>>();

        serde_json::to_value(json!({ "sessions": sessions })).map_err(|error| error.to_string())
    }

    fn start_session(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<TerminalSessionStartParams>(params, SESSION_START_METHOD)?;
        let size = params.size();
        let cwd = resolve_cwd(params.cwd.as_deref())?;
        let shell = params
            .shell
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(default_shell);
        let session_id = params
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| self.generate_session_id());

        if let Some(response) = self.running_session_response(&session_id, size)? {
            return Ok(response);
        }

        if let Some(mut session) = self.remove_session_record(&session_id) {
            session.cleanup_shell_integration();
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|error| format!("failed to open PTY: {error}"))?;
        let portable_pty::PtyPair { master, slave } = pair;
        let mut command = CommandBuilder::new(&shell);
        command.cwd(cwd.as_os_str());
        configure_terminal_environment(&mut command);
        let shell_integration_dir = configure_shell_integration(&mut command, &shell, &session_id)?;

        let child = slave
            .spawn_command(command)
            .map_err(|error| format!("failed to spawn shell: {error}"))?;
        drop(slave);

        let pid = child.process_id();
        let tty = master
            .tty_name()
            .map(|path| path.to_string_lossy().to_string());
        let killer = child.clone_killer();
        let reader = master
            .try_clone_reader()
            .map_err(|error| format!("failed to open PTY reader: {error}"))?;
        let writer = master
            .take_writer()
            .map_err(|error| format!("failed to open PTY writer: {error}"))?;

        {
            let mut state = self.lock_state()?;
            state.sessions.insert(
                session_id.clone(),
                SessionRecord::running(SessionRecordInit {
                    cols: size.cols,
                    cwd: cwd.clone(),
                    killer,
                    master,
                    pid,
                    rows: size.rows,
                    session_id: session_id.clone(),
                    shell: shell.clone(),
                    shell_integration_dir,
                    tty: tty.clone(),
                    writer,
                }),
            );
        }

        spawn_reader_thread(
            self.state.clone(),
            self.output_tx.clone(),
            session_id.clone(),
            reader,
        );
        spawn_wait_thread(
            self.state.clone(),
            self.output_tx.clone(),
            session_id.clone(),
            child,
        );

        Ok(json!({
            "cols": size.cols,
            "cwd": cwd.to_string_lossy(),
            "pid": pid,
            "rows": size.rows,
            "sessionId": session_id,
            "shell": shell,
            "tty": tty,
        }))
    }

    fn attach_session(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<TerminalSessionAttachParams>(params, SESSION_ATTACH_METHOD)?;
        let size = params.size();
        let mut state = self.lock_state()?;
        let session = state
            .sessions
            .get_mut(&params.session_id)
            .ok_or_else(|| format!("terminal session not found: {}", params.session_id))?;

        if session.status == SessionStatus::Running {
            session.resize(size)?;
        }

        let replay_seq = params.replay_seq.unwrap_or(0);
        let first_available_seq = session
            .replay
            .front()
            .map(|frame| frame.frame.seq)
            .unwrap_or(session.next_seq);
        let replay_truncated = replay_seq > 0 && replay_seq < first_available_seq;
        let replay = session
            .replay
            .iter()
            .filter(|frame| frame.frame.seq >= replay_seq)
            .map(|frame| frame.frame.clone())
            .collect::<Vec<_>>();

        Ok(json!({
            "exitCode": session.exit_code,
            "exitSignal": session.exit_signal,
            "nextSeq": session.next_seq,
            "replay": replay,
            "replayTruncated": replay_truncated,
            "sessionId": session.session_id,
            "status": session.status.as_str(),
        }))
    }

    fn write_session(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<TerminalSessionWriteParams>(params, SESSION_WRITE_METHOD)?;
        let bytes = BASE64
            .decode(params.data_base64.as_bytes())
            .map_err(|error| format!("invalid terminal input: {error}"))?;

        if bytes.is_empty() {
            return Ok(json!({ "ok": true }));
        }

        let mut state = self.lock_state()?;
        let session = state
            .sessions
            .get_mut(&params.session_id)
            .ok_or_else(|| format!("terminal session not found: {}", params.session_id))?;
        let writer = session
            .writer
            .as_mut()
            .ok_or_else(|| format!("terminal session is not running: {}", params.session_id))?;
        writer
            .write_all(&bytes)
            .map_err(|error| format!("failed to write terminal input: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("failed to flush terminal input: {error}"))?;

        Ok(json!({ "ok": true }))
    }

    fn resize_session(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<TerminalSessionResizeParams>(params, SESSION_RESIZE_METHOD)?;
        let size = params.size();
        let mut state = self.lock_state()?;
        let session = state
            .sessions
            .get_mut(&params.session_id)
            .ok_or_else(|| format!("terminal session not found: {}", params.session_id))?;
        session.resize(size)?;

        Ok(json!({ "ok": true }))
    }

    fn kill_session(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<TerminalSessionKillParams>(params, SESSION_KILL_METHOD)?;
        let session_id = params.session_id.clone();
        let killer = self
            .remove_session_record(&session_id)
            .and_then(|mut session| {
                session.cleanup_shell_integration();
                session.killer.take()
            });

        if let Some(mut killer) = killer {
            killer
                .kill()
                .map_err(|error| format!("failed to kill terminal session: {error}"))?;
        }

        let _ = self
            .output_tx
            .send(terminal_audience_remove_notification(&session_id));
        Ok(json!({ "ok": true }))
    }

    fn kill_all(&self) {
        let sessions = {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            state
                .sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        };

        for mut session in sessions {
            session.cleanup_shell_integration();
            if let Some(mut killer) = session.killer.take() {
                let _ = killer.kill();
            }
        }
    }

    fn running_session_response(
        &self,
        session_id: &str,
        size: PtySize,
    ) -> Result<Option<Value>, String> {
        let mut state = self.lock_state()?;
        let Some(session) = state.sessions.get_mut(session_id) else {
            return Ok(None);
        };

        if session.status != SessionStatus::Running {
            return Ok(None);
        }

        session.resize(size)?;
        Ok(Some(json!({
            "cols": session.cols,
            "cwd": session.cwd.to_string_lossy(),
            "pid": session.pid,
            "rows": session.rows,
            "sessionId": session.session_id,
            "shell": session.shell,
            "tty": session.tty,
        })))
    }

    fn tmux_context(&self, params: Value) -> Result<Value, String> {
        let params =
            parse_params::<tmux::TerminalTmuxContextParams>(params, TMUX_CONTEXT_GET_METHOD)?;
        let terminal_tty = self.session_tty(&params.session_id)?;
        let context = tmux::scan_context(&params.session_id, terminal_tty)?;

        serde_json::to_value(json!({ "context": context })).map_err(|error| error.to_string())
    }

    fn tmux_action(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<tmux::TerminalTmuxActionParams>(params, TMUX_ACTION_METHOD)?;
        let terminal_tty = self.session_tty(&params.session_id)?;
        let response = tmux::run_tmux_action(params, terminal_tty)?;

        serde_json::to_value(response).map_err(|error| error.to_string())
    }

    fn session_tty(&self, session_id: &str) -> Result<Option<String>, String> {
        let state = self.lock_state()?;
        let session = state
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("terminal session not found: {session_id}"))?;

        Ok(session.tty.clone())
    }

    fn remove_session_record(&self, session_id: &str) -> Option<SessionRecord> {
        self.state.lock().ok()?.sessions.remove(session_id)
    }

    fn generate_session_id(&self) -> String {
        let mut state = self
            .state
            .lock()
            .expect("terminal server state poisoned while generating session id");
        state.next_generated_id += 1;
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        format!("terminal:session:{millis}:{}", state.next_generated_id)
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, TerminalState>, String> {
        self.state
            .lock()
            .map_err(|_| "terminal server state is unavailable".to_string())
    }
}

#[derive(Default)]
struct TerminalState {
    next_generated_id: u64,
    sessions: HashMap<String, SessionRecord>,
}

struct SessionRecord {
    cols: u16,
    cwd: PathBuf,
    exit_code: Option<u32>,
    exit_signal: Option<String>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    last_bell_notification_at: Option<u64>,
    last_explicit_notification: Option<(String, u64)>,
    master: Option<Box<dyn MasterPty + Send>>,
    next_notification_seq: u64,
    next_seq: u64,
    notification_parser: TerminalNotificationParser,
    pid: Option<u32>,
    replay: VecDeque<ReplayFrame>,
    replay_bytes: usize,
    rows: u16,
    session_id: String,
    shell: String,
    shell_integration_dir: Option<PathBuf>,
    status: SessionStatus,
    tty: Option<String>,
    writer: Option<Box<dyn Write + Send>>,
}

struct SessionRecordInit {
    cols: u16,
    cwd: PathBuf,
    killer: Box<dyn ChildKiller + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    pid: Option<u32>,
    rows: u16,
    session_id: String,
    shell: String,
    shell_integration_dir: Option<PathBuf>,
    tty: Option<String>,
    writer: Box<dyn Write + Send>,
}

impl SessionRecord {
    fn running(init: SessionRecordInit) -> Self {
        Self {
            cols: init.cols,
            cwd: init.cwd,
            exit_code: None,
            exit_signal: None,
            killer: Some(init.killer),
            last_bell_notification_at: None,
            last_explicit_notification: None,
            master: Some(init.master),
            next_notification_seq: 1,
            next_seq: 1,
            notification_parser: TerminalNotificationParser::default(),
            pid: init.pid,
            replay: VecDeque::new(),
            replay_bytes: 0,
            rows: init.rows,
            session_id: init.session_id,
            shell: init.shell,
            shell_integration_dir: init.shell_integration_dir,
            status: SessionStatus::Running,
            tty: init.tty,
            writer: Some(init.writer),
        }
    }

    fn resize(&mut self, size: PtySize) -> Result<(), String> {
        if let Some(master) = self.master.as_ref() {
            master
                .resize(size)
                .map_err(|error| format!("failed to resize terminal session: {error}"))?;
        }

        self.cols = size.cols;
        self.rows = size.rows;
        Ok(())
    }

    fn append_output(&mut self, bytes: &[u8]) -> OutputFrame {
        let frame = OutputFrame {
            data_base64: BASE64.encode(bytes),
            seq: self.next_seq,
        };
        self.next_seq += 1;
        self.replay_bytes += bytes.len();
        self.replay.push_back(ReplayFrame {
            byte_len: bytes.len(),
            frame: frame.clone(),
        });
        self.trim_replay();
        frame
    }

    fn notification_requests_for_output(&mut self, bytes: &[u8]) -> Vec<Value> {
        let events = self.notification_parser.push(bytes);
        let mut notifications = Vec::new();
        for event in events {
            if !self.should_emit_notification(&event) {
                continue;
            }

            let notification_seq = self.next_notification_seq;
            self.next_notification_seq += 1;
            notifications.push(terminal_notification_request(
                &self.session_id,
                notification_seq,
                event,
            ));
        }
        notifications
    }

    fn should_emit_notification(&mut self, event: &TerminalNotificationEvent) -> bool {
        let now = unix_millis();
        match event {
            TerminalNotificationEvent::Bell => {
                if self.last_bell_notification_at.is_some_and(|last| {
                    now.saturating_sub(last) < BELL_NOTIFICATION_MIN_INTERVAL_MS
                }) {
                    return false;
                }

                self.last_bell_notification_at = Some(now);
                true
            }
            TerminalNotificationEvent::Message { body, title } => {
                let fingerprint = format!("{}\u{0}{}", title, body.as_deref().unwrap_or(""));
                if self.last_explicit_notification.as_ref().is_some_and(
                    |(last_fingerprint, last)| {
                        last_fingerprint == &fingerprint
                            && now.saturating_sub(*last) < DUPLICATE_NOTIFICATION_MIN_INTERVAL_MS
                    },
                ) {
                    return false;
                }

                self.last_explicit_notification = Some((fingerprint, now));
                true
            }
        }
    }

    fn mark_exited(&mut self, exit_code: Option<u32>, exit_signal: Option<String>) {
        self.exit_code = exit_code;
        self.exit_signal = exit_signal;
        self.status = SessionStatus::Exited;
        self.killer = None;
        self.master = None;
        self.writer = None;
        self.cleanup_shell_integration();
    }

    fn cleanup_shell_integration(&mut self) {
        if let Some(path) = self.shell_integration_dir.take() {
            let _ = fs::remove_dir_all(path);
        }
    }

    fn trim_replay(&mut self) {
        while self.replay.len() > MAX_REPLAY_FRAMES || self.replay_bytes > MAX_REPLAY_BYTES {
            let Some(frame) = self.replay.pop_front() else {
                break;
            };
            self.replay_bytes = self.replay_bytes.saturating_sub(frame.byte_len);
        }
    }

    fn summary(&self) -> SessionSummary {
        SessionSummary {
            cols: self.cols,
            cwd: self.cwd.to_string_lossy().to_string(),
            exit_code: self.exit_code,
            exit_signal: self.exit_signal.clone(),
            next_seq: self.next_seq,
            pid: self.pid,
            rows: self.rows,
            session_id: self.session_id.clone(),
            shell: self.shell.clone(),
            status: self.status.as_str().to_string(),
            tty: self.tty.clone(),
        }
    }
}

struct ReplayFrame {
    byte_len: usize,
    frame: OutputFrame,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputFrame {
    data_base64: String,
    seq: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    cols: u16,
    cwd: String,
    exit_code: Option<u32>,
    exit_signal: Option<String>,
    next_seq: u64,
    pid: Option<u32>,
    rows: u16,
    session_id: String,
    shell: String,
    status: String,
    tty: Option<String>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SessionStatus {
    Exited,
    Running,
}

impl SessionStatus {
    fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Exited => "exited",
            SessionStatus::Running => "running",
        }
    }
}

#[derive(Default)]
struct TerminalNotificationParser {
    kitty_notifications: HashMap<String, KittyNotificationParts>,
    state: TerminalNotificationParserState,
}

impl TerminalNotificationParser {
    fn push(&mut self, bytes: &[u8]) -> Vec<TerminalNotificationEvent> {
        let mut events = Vec::new();
        for byte in bytes {
            self.push_byte(*byte, &mut events);
        }
        events
    }

    fn push_byte(&mut self, byte: u8, events: &mut Vec<TerminalNotificationEvent>) {
        let state = std::mem::replace(&mut self.state, TerminalNotificationParserState::Ground);
        match state {
            TerminalNotificationParserState::Ground => match byte {
                0x07 => {
                    events.push(TerminalNotificationEvent::Bell);
                    self.state = TerminalNotificationParserState::Ground;
                }
                0x1b => {
                    self.state = TerminalNotificationParserState::Escape;
                }
                _ => {
                    self.state = TerminalNotificationParserState::Ground;
                }
            },
            TerminalNotificationParserState::Escape => match byte {
                b']' => {
                    self.state = TerminalNotificationParserState::Osc {
                        bytes: Vec::new(),
                        escape_pending: false,
                    };
                }
                0x07 => {
                    events.push(TerminalNotificationEvent::Bell);
                    self.state = TerminalNotificationParserState::Ground;
                }
                0x1b => {
                    self.state = TerminalNotificationParserState::Escape;
                }
                _ => {
                    self.state = TerminalNotificationParserState::Ground;
                }
            },
            TerminalNotificationParserState::Osc {
                mut bytes,
                escape_pending,
            } => {
                if escape_pending {
                    if byte == b'\\' {
                        if let Some(event) = self.parse_osc_notification(&bytes) {
                            events.push(event);
                        }
                        self.state = TerminalNotificationParserState::Ground;
                        return;
                    }

                    if !push_osc_byte(&mut bytes, 0x1b) || !push_osc_byte(&mut bytes, byte) {
                        self.state = TerminalNotificationParserState::Ground;
                        return;
                    }
                    self.state = TerminalNotificationParserState::Osc {
                        bytes,
                        escape_pending: false,
                    };
                    return;
                }

                match byte {
                    0x07 => {
                        if let Some(event) = self.parse_osc_notification(&bytes) {
                            events.push(event);
                        }
                        self.state = TerminalNotificationParserState::Ground;
                    }
                    0x1b => {
                        self.state = TerminalNotificationParserState::Osc {
                            bytes,
                            escape_pending: true,
                        };
                    }
                    _ => {
                        if push_osc_byte(&mut bytes, byte) {
                            self.state = TerminalNotificationParserState::Osc {
                                bytes,
                                escape_pending: false,
                            };
                        } else {
                            self.state = TerminalNotificationParserState::Ground;
                        }
                    }
                }
            }
        }
    }

    fn parse_osc_notification(&mut self, bytes: &[u8]) -> Option<TerminalNotificationEvent> {
        let text = String::from_utf8_lossy(bytes);
        let (command, rest) = text.split_once(';')?;
        match command {
            "9" => parse_osc9_notification(rest),
            "777" => parse_osc777_notification(rest),
            "99" => self.parse_osc99_notification(rest),
            _ => None,
        }
    }

    fn parse_osc99_notification(&mut self, rest: &str) -> Option<TerminalNotificationEvent> {
        let (metadata, payload) = rest.split_once(';')?;
        let metadata = parse_kitty_notification_metadata(metadata);
        let payload = decode_kitty_payload(payload, metadata.get("e").map(String::as_str))?;
        let payload = sanitize_notification_text(&payload, NOTIFICATION_BODY_MAX_CHARS)?;
        let part = metadata.get("p").map(String::as_str).unwrap_or("title");
        let done = metadata.get("d").map(String::as_str).unwrap_or("1") != "0";
        let notification_id = metadata
            .get("i")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);

        if let Some(notification_id) = notification_id {
            if !self.kitty_notifications.contains_key(&notification_id)
                && self.kitty_notifications.len() >= MAX_PENDING_KITTY_NOTIFICATIONS
            {
                self.kitty_notifications.clear();
            }

            let entry = self
                .kitty_notifications
                .entry(notification_id.clone())
                .or_default();
            entry.apply(part, payload);
            if !done {
                return None;
            }

            let entry = self.kitty_notifications.remove(&notification_id)?;
            return entry.into_event();
        }

        match part {
            "body" => Some(TerminalNotificationEvent::Message {
                body: Some(payload),
                title: "Terminal notification".to_string(),
            }),
            "title" | "" => Some(TerminalNotificationEvent::Message {
                body: None,
                title: truncate_notification_text(&payload, NOTIFICATION_TITLE_MAX_CHARS),
            }),
            _ => None,
        }
    }
}

#[derive(Default)]
enum TerminalNotificationParserState {
    #[default]
    Ground,
    Escape,
    Osc {
        bytes: Vec<u8>,
        escape_pending: bool,
    },
}

#[derive(Default)]
struct KittyNotificationParts {
    body: Option<String>,
    title: Option<String>,
}

impl KittyNotificationParts {
    fn apply(&mut self, part: &str, payload: String) {
        match part {
            "body" => self.body = Some(payload),
            "title" | "" => {
                self.title = Some(truncate_notification_text(
                    &payload,
                    NOTIFICATION_TITLE_MAX_CHARS,
                ))
            }
            _ => {}
        }
    }

    fn into_event(self) -> Option<TerminalNotificationEvent> {
        let title = self
            .title
            .or_else(|| self.body.clone())
            .map(|value| truncate_notification_text(&value, NOTIFICATION_TITLE_MAX_CHARS))
            .unwrap_or_else(|| "Terminal notification".to_string());
        Some(TerminalNotificationEvent::Message {
            body: self.body,
            title,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TerminalNotificationEvent {
    Bell,
    Message { title: String, body: Option<String> },
}

fn push_osc_byte(bytes: &mut Vec<u8>, byte: u8) -> bool {
    if bytes.len() >= MAX_NOTIFICATION_OSC_BYTES {
        return false;
    }

    bytes.push(byte);
    true
}

fn parse_osc9_notification(rest: &str) -> Option<TerminalNotificationEvent> {
    if rest.is_empty() || rest == "4" || rest.starts_with("4;") {
        return None;
    }

    if rest
        .split_once(';')
        .is_some_and(|(prefix, _)| prefix.chars().all(|value| value.is_ascii_digit()))
    {
        return None;
    }

    let title = sanitize_notification_text(rest, NOTIFICATION_TITLE_MAX_CHARS)?;
    Some(TerminalNotificationEvent::Message { title, body: None })
}

fn parse_osc777_notification(rest: &str) -> Option<TerminalNotificationEvent> {
    let mut parts = rest.splitn(3, ';');
    if parts.next()? != "notify" {
        return None;
    }

    let title = parts
        .next()
        .and_then(|value| sanitize_notification_text(value, NOTIFICATION_TITLE_MAX_CHARS));
    let body = parts
        .next()
        .and_then(|value| sanitize_notification_text(value, NOTIFICATION_BODY_MAX_CHARS));
    let title = title
        .or_else(|| body.clone())
        .unwrap_or_else(|| "Terminal notification".to_string());

    Some(TerminalNotificationEvent::Message { title, body })
}

fn parse_kitty_notification_metadata(metadata: &str) -> HashMap<String, String> {
    metadata
        .split(':')
        .flat_map(|part| {
            let (key, value) = part.split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }

            Some((key.to_string(), value.trim().to_string()))
        })
        .collect()
}

fn decode_kitty_payload(payload: &str, encoding: Option<&str>) -> Option<String> {
    if encoding == Some("1") {
        let bytes = BASE64.decode(payload.as_bytes()).ok()?;
        return Some(String::from_utf8_lossy(&bytes).into_owned());
    }

    Some(payload.to_string())
}

fn sanitize_notification_text(raw: &str, max_chars: usize) -> Option<String> {
    let mut sanitized = String::new();
    let mut last_was_space = true;
    for character in raw.chars() {
        if character.is_control() || character.is_whitespace() {
            if !last_was_space {
                sanitized.push(' ');
                last_was_space = true;
            }
            continue;
        }

        sanitized.push(character);
        last_was_space = false;
    }

    let sanitized = sanitized.trim();
    if sanitized.is_empty() {
        return None;
    }

    Some(truncate_notification_text(sanitized, max_chars))
}

fn truncate_notification_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn terminal_notification_request(
    session_id: &str,
    notification_seq: u64,
    event: TerminalNotificationEvent,
) -> Value {
    let (title, body) = match event {
        TerminalNotificationEvent::Bell => (
            "Terminal needs attention".to_string(),
            Some("Open the terminal to continue.".to_string()),
        ),
        TerminalNotificationEvent::Message { title, body } => (title, body),
    };

    json!({
        "jsonrpc": "2.0",
        "method": REMUX_NOTIFICATION_REQUEST_METHOD,
        "params": {
            "body": body,
            "extensionId": "terminal",
            "id": format!("terminal:notification:{session_id}:{notification_seq}"),
            "target": terminal_notification_target(session_id),
            "title": title,
            "viewId": "main",
        },
    })
}

fn terminal_audience_remove_notification(session_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": REMUX_NOTIFICATION_AUDIENCE_REMOVE_METHOD,
        "params": {
            "extensionId": "terminal",
            "target": terminal_notification_target(session_id),
            "viewId": "main",
        },
    })
}

fn terminal_notification_target(session_id: &str) -> Value {
    json!({
        "focusId": session_id,
        "focusKind": "session",
        "resourceId": session_id,
        "resourceKind": "terminalSession",
    })
}

fn spawn_reader_thread(
    state: Arc<Mutex<TerminalState>>,
    output_tx: mpsc::Sender<Value>,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
) {
    // Stage 1: block on the PTY and forward raw chunks as they arrive.
    let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
        loop {
            let bytes_read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(bytes_read) => bytes_read,
                Err(_) => break,
            };
            if chunk_tx.send(buffer[..bytes_read].to_vec()).is_err() {
                break;
            }
        }
        // Dropping chunk_tx closes the channel, letting the coalescer drain
        // anything still queued and exit.
    });

    // Stage 2: coalesce a burst of chunks into a single frame before emitting.
    // A lone keystroke echo has nothing queued behind it, so it flushes
    // immediately with no added latency; only an active burst (where more chunks
    // are already waiting) waits out the short coalescing window to merge its tail.
    thread::spawn(move || {
        while let Ok(mut acc) = chunk_rx.recv() {
            // Pull everything already queued without waiting.
            let mut bursting = false;
            while acc.len() < MAX_COALESCED_BYTES {
                match chunk_rx.try_recv() {
                    Ok(chunk) => {
                        acc.extend_from_slice(&chunk);
                        bursting = true;
                    }
                    Err(_) => break,
                }
            }

            // A burst is in progress: briefly gather its tail so it lands as one frame.
            if bursting && acc.len() < MAX_COALESCED_BYTES {
                let deadline = Instant::now() + OUTPUT_COALESCE_WINDOW;
                while acc.len() < MAX_COALESCED_BYTES {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match chunk_rx.recv_timeout(deadline - now) {
                        Ok(chunk) => acc.extend_from_slice(&chunk),
                        Err(_) => break,
                    }
                }
            }

            let (output_notification, terminal_notifications) = {
                let Ok(mut state) = state.lock() else {
                    return;
                };
                let Some(session) = state.sessions.get_mut(&session_id) else {
                    return;
                };
                let terminal_notifications = session.notification_requests_for_output(&acc);
                let frame = session.append_output(&acc);
                let output_notification = json!({
                    "jsonrpc": "2.0",
                    "method": SESSION_OUTPUT_NOTIFICATION,
                    "params": {
                        "frame": frame,
                        "sessionId": session_id,
                    },
                });
                (output_notification, terminal_notifications)
            };

            if output_tx.send(output_notification).is_err() {
                return;
            }
            for notification in terminal_notifications {
                if output_tx.send(notification).is_err() {
                    return;
                }
            }
        }
    });
}

fn spawn_wait_thread(
    state: Arc<Mutex<TerminalState>>,
    output_tx: mpsc::Sender<Value>,
    session_id: String,
    mut child: Box<dyn Child + Send + Sync>,
) {
    thread::spawn(move || {
        let status = child.wait();
        let (exit_code, exit_signal) = match status {
            Ok(status) => (
                Some(status.exit_code()),
                status.signal().map(ToOwned::to_owned),
            ),
            Err(error) => (Some(1), Some(error.to_string())),
        };

        let notifications = {
            let Ok(mut state) = state.lock() else {
                return;
            };
            let Some(session) = state.sessions.get_mut(&session_id) else {
                return;
            };
            session.mark_exited(exit_code, exit_signal.clone());
            vec![
                json!({
                    "jsonrpc": "2.0",
                    "method": SESSION_EXITED_NOTIFICATION,
                    "params": {
                        "exitCode": exit_code,
                        "exitSignal": exit_signal,
                        "sessionId": session_id.clone(),
                    },
                }),
                terminal_audience_remove_notification(&session_id),
            ]
        };

        for notification in notifications {
            let _ = output_tx.send(notification);
        }
    });
}

fn spawn_stdout_writer(output_rx: mpsc::Receiver<Value>) {
    thread::spawn(move || {
        let mut stdout = io::stdout();
        for message in output_rx {
            if serde_json::to_writer(&mut stdout, &message).is_err() {
                break;
            }
            if stdout.write_all(b"\n").is_err() {
                break;
            }
            if stdout.flush().is_err() {
                break;
            }
        }
    });
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionStartParams {
    cols: Option<u32>,
    cwd: Option<String>,
    pixel_height: Option<u32>,
    pixel_width: Option<u32>,
    rows: Option<u32>,
    session_id: Option<String>,
    shell: Option<String>,
}

impl TerminalSessionStartParams {
    fn size(&self) -> PtySize {
        pty_size(self.cols, self.rows, self.pixel_width, self.pixel_height)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionAttachParams {
    cols: Option<u32>,
    replay_seq: Option<u64>,
    rows: Option<u32>,
    session_id: String,
}

impl TerminalSessionAttachParams {
    fn size(&self) -> PtySize {
        pty_size(self.cols, self.rows, None, None)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionWriteParams {
    data_base64: String,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionResizeParams {
    cols: Option<u32>,
    pixel_height: Option<u32>,
    pixel_width: Option<u32>,
    rows: Option<u32>,
    session_id: String,
}

impl TerminalSessionResizeParams {
    fn size(&self) -> PtySize {
        pty_size(self.cols, self.rows, self.pixel_width, self.pixel_height)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionKillParams {
    session_id: String,
}

fn pty_size(
    cols: Option<u32>,
    rows: Option<u32>,
    pixel_width: Option<u32>,
    pixel_height: Option<u32>,
) -> PtySize {
    PtySize {
        cols: clamp_u16(cols.unwrap_or(80), 2, 500),
        rows: clamp_u16(rows.unwrap_or(24), 2, 200),
        pixel_width: clamp_u16(pixel_width.unwrap_or(0), 0, u16::MAX),
        pixel_height: clamp_u16(pixel_height.unwrap_or(0), 0, u16::MAX),
    }
}

fn clamp_u16(value: u32, min: u16, max: u16) -> u16 {
    value.clamp(u32::from(min), u32::from(max)) as u16
}

fn resolve_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let cwd = match cwd.map(str::trim).filter(|value| !value.is_empty()) {
        Some(cwd) => PathBuf::from(cwd),
        None => env::current_dir().map_err(|error| format!("failed to read cwd: {error}"))?,
    };
    if !cwd.is_dir() {
        return Err(format!(
            "terminal cwd is not a directory: {}",
            cwd.display()
        ));
    }

    cwd.canonicalize()
        .map_err(|error| format!("failed to resolve terminal cwd: {error}"))
}

fn default_shell() -> String {
    env::var("SHELL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "cmd.exe".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
}

fn configure_terminal_environment(command: &mut CommandBuilder) {
    command.env_remove("TMUX");
    command.env_remove("TMUX_PANE");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("REMUX_TERMINAL", "1");
}

fn configure_shell_integration(
    command: &mut CommandBuilder,
    shell: &str,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    if env::var(SHELL_INTEGRATION_ENV).ok().as_deref() == Some("0") {
        return Ok(None);
    }

    match shell_basename(shell).as_deref() {
        Some("bash") => configure_bash_integration(command, session_id),
        Some("zsh") => configure_zsh_integration(command, session_id),
        Some("fish") => configure_fish_integration(command, session_id),
        _ => Ok(None),
    }
}

fn configure_bash_integration(
    command: &mut CommandBuilder,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let dir = prepare_shell_integration_dir(session_id)?;
    let script_path = dir.join("remux.bash");
    let init_path = dir.join("bash-init");
    fs::write(&script_path, BASH_INTEGRATION_SCRIPT)
        .map_err(|error| format!("failed to write bash integration: {error}"))?;
    fs::write(
        &init_path,
        r#"if [ -n "${HOME:-}" ] && [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
if [ -r "${REMUX_SHELL_INTEGRATION_SCRIPT:-}" ]; then
  . "$REMUX_SHELL_INTEGRATION_SCRIPT"
fi
"#,
    )
    .map_err(|error| format!("failed to write bash init file: {error}"))?;

    command.arg("--init-file");
    command.arg(&init_path);
    command.env(SHELL_INTEGRATION_ENV, "1");
    command.env("REMUX_SHELL_INTEGRATION_SCRIPT", &script_path);
    Ok(Some(dir))
}

fn configure_zsh_integration(
    command: &mut CommandBuilder,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let dir = prepare_shell_integration_dir(session_id)?;
    let script_path = dir.join("remux.zsh");
    let zdotdir = dir.join("zdotdir");
    fs::create_dir_all(&zdotdir)
        .map_err(|error| format!("failed to create zsh integration dir: {error}"))?;
    fs::write(&script_path, ZSH_INTEGRATION_SCRIPT)
        .map_err(|error| format!("failed to write zsh integration: {error}"))?;
    fs::write(
        zdotdir.join(".zshrc"),
        r#"if [[ -n "${REMUX_ORIGINAL_ZDOTDIR:-}" && -r "${REMUX_ORIGINAL_ZDOTDIR}/.zshrc" ]]; then
  source "${REMUX_ORIGINAL_ZDOTDIR}/.zshrc"
fi
if [[ -r "${REMUX_SHELL_INTEGRATION_SCRIPT:-}" ]]; then
  source "${REMUX_SHELL_INTEGRATION_SCRIPT}"
fi
"#,
    )
    .map_err(|error| format!("failed to write zsh init file: {error}"))?;

    let original_zdotdir = env::var("ZDOTDIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| env::var("HOME").ok());
    command.env(SHELL_INTEGRATION_ENV, "1");
    command.env("REMUX_SHELL_INTEGRATION_SCRIPT", &script_path);
    if let Some(original_zdotdir) = original_zdotdir {
        command.env("REMUX_ORIGINAL_ZDOTDIR", original_zdotdir);
    }
    command.env("ZDOTDIR", &zdotdir);
    Ok(Some(dir))
}

fn configure_fish_integration(
    command: &mut CommandBuilder,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let dir = prepare_shell_integration_dir(session_id)?;
    let script_path = dir.join("remux.fish");
    fs::write(&script_path, FISH_INTEGRATION_SCRIPT)
        .map_err(|error| format!("failed to write fish integration: {error}"))?;

    command.arg("--init-command");
    command.arg(format!("source {}", fish_escape_path(&script_path)));
    command.env(SHELL_INTEGRATION_ENV, "1");
    command.env("REMUX_SHELL_INTEGRATION_SCRIPT", &script_path);
    Ok(Some(dir))
}

fn prepare_shell_integration_dir(session_id: &str) -> Result<PathBuf, String> {
    let safe_session_id = session_id
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || value == '-' || value == '_' {
                value
            } else {
                '-'
            }
        })
        .collect::<String>();
    let millis = unix_millis();
    let dir = env::temp_dir().join(format!(
        "remux-terminal-shell-{}-{}-{safe_session_id}",
        std::process::id(),
        millis,
    ));
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create shell integration dir: {error}"))?;
    Ok(dir)
}

fn shell_basename(shell: &str) -> Option<String> {
    Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.trim_start_matches('-').to_ascii_lowercase())
}

fn fish_escape_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    format!("'{}'", raw.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

const BASH_INTEGRATION_SCRIPT: &str = r#"
if [ -n "${__REMUX_TERMINAL_SHELL_INTEGRATION_LOADED:-}" ]; then
  return
fi
__REMUX_TERMINAL_SHELL_INTEGRATION_LOADED=1
__remux_command_running=0

__remux_emit_osc633() {
  printf '\033]633;%s\a' "$1"
}

__remux_prompt_command() {
  local __remux_status="$1"
  if [ "${__remux_command_running:-0}" = "1" ]; then
    __remux_emit_osc633 "D;${__remux_status}"
    __remux_command_running=0
  fi
  __remux_emit_osc633 "P;Cwd=${PWD}"
}

__remux_prompt_command_wrapper() {
  local __remux_status="$?"
  __remux_in_prompt=1
  __remux_prompt_command "$__remux_status"
  __remux_in_prompt=0
}

__remux_preexec() {
  local __remux_command="${BASH_COMMAND:-}"
  case "$__remux_command" in
    __remux_*|local\ __remux_*|PROMPT_COMMAND=*|trap\ *|return\ *|'')
      return
      ;;
  esac
  if [ "${__remux_in_prompt:-0}" = "1" ] || [ "${__remux_command_running:-0}" = "1" ]; then
    return
  fi
  __remux_command_running=1
  __remux_emit_osc633 "E;${__remux_command}"
  __remux_emit_osc633 "C"
}

if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare \-[^=]*a'; then
  PROMPT_COMMAND=(__remux_prompt_command_wrapper "${PROMPT_COMMAND[@]}")
elif [ -n "${PROMPT_COMMAND:-}" ]; then
  PROMPT_COMMAND="__remux_prompt_command_wrapper; ${PROMPT_COMMAND}"
else
  PROMPT_COMMAND="__remux_prompt_command_wrapper"
fi
trap '__remux_preexec' DEBUG
"#;

const ZSH_INTEGRATION_SCRIPT: &str = r#"
if [[ -n "${__REMUX_TERMINAL_SHELL_INTEGRATION_LOADED:-}" ]]; then
  return
fi
__REMUX_TERMINAL_SHELL_INTEGRATION_LOADED=1
__remux_command_running=0

__remux_emit_osc633() {
  printf '\033]633;%s\a' "$1"
}

__remux_preexec() {
  __remux_command_running=1
  __remux_emit_osc633 "E;$1"
  __remux_emit_osc633 "C"
}

__remux_precmd() {
  local __remux_status="$?"
  if [[ "${__remux_command_running:-0}" == "1" ]]; then
    __remux_emit_osc633 "D;${__remux_status}"
    __remux_command_running=0
  fi
  __remux_emit_osc633 "P;Cwd=${PWD}"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __remux_preexec
add-zsh-hook precmd __remux_precmd
"#;

const FISH_INTEGRATION_SCRIPT: &str = r#"
if set -q __REMUX_TERMINAL_SHELL_INTEGRATION_LOADED
  return
end
set -g __REMUX_TERMINAL_SHELL_INTEGRATION_LOADED 1
set -g __remux_command_running 0

function __remux_emit_osc633
  printf '\033]633;%s\a' "$argv[1]"
end

function __remux_preexec --on-event fish_preexec
  set -g __remux_command_running 1
  __remux_emit_osc633 "E;$argv[1]"
  __remux_emit_osc633 "C"
end

function __remux_postexec --on-event fish_postexec
  set -l __remux_status $status
  if set -q __remux_command_running; and test "$__remux_command_running" = 1
    __remux_emit_osc633 "D;$__remux_status"
    set -g __remux_command_running 0
  end
  __remux_emit_osc633 "P;Cwd=$PWD"
end

function __remux_prompt --on-event fish_prompt
  __remux_emit_osc633 "P;Cwd=$PWD"
end
"#;

fn parse_params<T>(params: Value, method: &str) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(params).map_err(|error| format!("Invalid {method} params: {error}"))
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: Value,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

impl JsonRpcResponse {
    fn result(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Value, error: JsonRpcError) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

impl JsonRpcError {
    fn new(code: i64, message: String) -> Self {
        Self { code, message }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::sync::mpsc::{self, Receiver};
    use std::time::{Duration, Instant};

    use base64::Engine;
    use serde_json::{Value, json};

    use portable_pty::CommandBuilder;

    use super::{
        BASE64, REMUX_NOTIFICATION_REQUEST_METHOD, SESSION_EXITED_NOTIFICATION,
        SESSION_OUTPUT_NOTIFICATION, SHELL_INTEGRATION_ENV, TerminalExtensionServer,
        TerminalNotificationEvent, TerminalNotificationParser, clamp_u16,
        configure_shell_integration, configure_terminal_environment, pty_size,
    };

    #[test]
    fn pty_size_clamps_to_supported_terminal_bounds() {
        let size = pty_size(Some(900), Some(1), Some(u32::MAX), Some(12));

        assert_eq!(size.cols, 500);
        assert_eq!(size.rows, 2);
        assert_eq!(size.pixel_width, u16::MAX);
        assert_eq!(size.pixel_height, 12);
    }

    #[test]
    fn clamp_u16_uses_inclusive_bounds() {
        assert_eq!(clamp_u16(0, 2, 10), 2);
        assert_eq!(clamp_u16(7, 2, 10), 7);
        assert_eq!(clamp_u16(11, 2, 10), 10);
    }

    #[test]
    fn terminal_notification_parser_emits_bell_outside_osc() {
        let mut parser = TerminalNotificationParser::default();

        assert_eq!(parser.push(b"\x07"), vec![TerminalNotificationEvent::Bell]);
        assert_eq!(
            parser.push(b"\x1b]9;Build complete\x07"),
            vec![TerminalNotificationEvent::Message {
                body: None,
                title: "Build complete".to_string(),
            }]
        );
    }

    #[test]
    fn terminal_notification_parser_handles_split_osc9() {
        let mut parser = TerminalNotificationParser::default();

        assert!(parser.push(b"\x1b]9;Codex").is_empty());
        assert_eq!(
            parser.push(b" finished\x1b\\"),
            vec![TerminalNotificationEvent::Message {
                body: None,
                title: "Codex finished".to_string(),
            }]
        );
        assert!(parser.push(b"\x1b]9;4;50\x1b\\").is_empty());
    }

    #[test]
    fn terminal_notification_parser_handles_osc777_notify() {
        let mut parser = TerminalNotificationParser::default();

        assert_eq!(
            parser.push(b"\x1b]777;notify;Tests finished;Open the terminal\x1b\\"),
            vec![TerminalNotificationEvent::Message {
                body: Some("Open the terminal".to_string()),
                title: "Tests finished".to_string(),
            }]
        );
    }

    #[test]
    fn terminal_notification_parser_handles_kitty_title_and_body() {
        let mut parser = TerminalNotificationParser::default();

        assert!(
            parser
                .push(b"\x1b]99;i=1:d=0;Claude paused\x1b\\")
                .is_empty()
        );
        assert_eq!(
            parser.push(b"\x1b]99;i=1:p=body;Permission required\x1b\\"),
            vec![TerminalNotificationEvent::Message {
                body: Some("Permission required".to_string()),
                title: "Claude paused".to_string(),
            }]
        );
    }

    #[test]
    fn terminal_notification_request_targets_session() {
        let request = super::terminal_notification_request(
            "session-1",
            7,
            TerminalNotificationEvent::Message {
                body: Some("Open the terminal".to_string()),
                title: "Done".to_string(),
            },
        );

        assert_eq!(
            request.get("method").and_then(Value::as_str),
            Some(REMUX_NOTIFICATION_REQUEST_METHOD)
        );
        assert_eq!(request["params"]["id"], "terminal:notification:session-1:7");
        assert_eq!(request["params"]["title"], "Done");
        assert_eq!(request["params"]["body"], "Open the terminal");
        assert_eq!(
            request["params"]["target"],
            json!({
                "focusId": "session-1",
                "focusKind": "session",
                "resourceId": "session-1",
                "resourceKind": "terminalSession",
            })
        );
    }

    #[test]
    fn terminal_environment_does_not_inherit_host_tmux() {
        let mut command = CommandBuilder::new("/bin/sh");
        command.env("TMUX", "/tmp/tmux-1000/default,123,0");
        command.env("TMUX_PANE", "%1");

        configure_terminal_environment(&mut command);

        assert!(command.get_env("TMUX").is_none());
        assert!(command.get_env("TMUX_PANE").is_none());
        assert_eq!(
            command.get_env("TERM").and_then(|value| value.to_str()),
            Some("xterm-256color")
        );
        assert_eq!(
            command
                .get_env("COLORTERM")
                .and_then(|value| value.to_str()),
            Some("truecolor")
        );
        assert_eq!(
            command
                .get_env("REMUX_TERMINAL")
                .and_then(|value| value.to_str()),
            Some("1")
        );
    }

    #[test]
    fn recognized_shells_get_generated_shell_integration() {
        let shells = [
            ("/bin/bash", "--init-file"),
            ("/bin/zsh", ""),
            ("/usr/bin/fish", "--init-command"),
        ];

        for (shell, expected_arg) in shells {
            let mut command = CommandBuilder::new(shell);
            let dir = configure_shell_integration(
                &mut command,
                shell,
                &format!("test-{}", shell.replace('/', "-")),
            )
            .expect("expected shell integration to configure")
            .expect("expected recognized shell to get an integration dir");

            assert_eq!(
                command
                    .get_env(SHELL_INTEGRATION_ENV)
                    .and_then(|value| value.to_str()),
                Some("1")
            );
            if !expected_arg.is_empty() {
                assert!(
                    command
                        .get_argv()
                        .iter()
                        .any(|value| value.to_str() == Some(expected_arg)),
                    "expected argv for {shell:?} to include {expected_arg:?}: {:?}",
                    command.get_argv()
                );
            }
            assert!(
                dir.exists(),
                "expected generated integration directory to exist for {shell}"
            );

            fs::remove_dir_all(dir).expect("expected test integration dir cleanup");
        }
    }

    #[test]
    fn pty_session_runs_commands_and_replays_output() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, output_rx) = test_server();
        let session_id = "terminal-test-run-replay";

        start_test_session(&server, session_id, shell, 80, 24);
        write_text(&server, session_id, "printf 'remux-terminal-ok'\r");

        read_until_output(&output_rx, session_id, "remux-terminal-ok");

        let attached = server
            .attach_session(json!({
                "cols": 80,
                "replaySeq": 1,
                "rows": 24,
                "sessionId": session_id,
            }))
            .expect("expected attach to running test session");

        assert_eq!(attached["sessionId"], session_id);
        assert_eq!(attached["status"], "running");
        assert_eq!(attached["replayTruncated"], false);
        assert!(
            replay_text(&attached).contains("remux-terminal-ok"),
            "expected replay to include command output: {attached:?}"
        );

        server.kill_all();
    }

    #[test]
    fn pty_session_emits_remux_notification_for_osc9() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, output_rx) = test_server();
        let session_id = "terminal-test-notification";

        start_test_session(&server, session_id, shell, 80, 24);
        write_text(
            &server,
            session_id,
            "printf '\\033]9;Remux terminal notify\\007'\r",
        );

        let notification = wait_for_terminal_notification(&output_rx, session_id);
        assert_eq!(
            notification.get("method").and_then(Value::as_str),
            Some(REMUX_NOTIFICATION_REQUEST_METHOD)
        );
        assert_eq!(notification["params"]["title"], "Remux terminal notify");
        assert_eq!(notification["params"]["target"]["resourceId"], session_id);

        server.kill_all();
    }

    #[test]
    fn pty_resize_is_visible_to_shell() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, output_rx) = test_server();
        let session_id = "terminal-test-resize";

        start_test_session(&server, session_id, shell, 80, 24);
        server
            .resize_session(json!({
                "cols": 101,
                "rows": 33,
                "sessionId": session_id,
            }))
            .expect("expected resize to succeed");
        write_text(
            &server,
            session_id,
            "stty size; printf '\\nresize-done\\n'\r",
        );

        let output = read_until_output(&output_rx, session_id, "resize-done\r\n");
        assert!(
            output.contains("33 101"),
            "expected stty to report resized rows and cols, got: {output:?}"
        );

        server.kill_all();
    }

    #[test]
    fn killing_session_removes_it_from_writable_state() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, _output_rx) = test_server();
        let session_id = "terminal-test-kill";

        start_test_session(&server, session_id, shell, 80, 24);
        server
            .kill_session(json!({ "sessionId": session_id }))
            .expect("expected kill to succeed");

        let error = server
            .write_session(json!({
                "dataBase64": BASE64.encode(b"echo after-kill\r"),
                "sessionId": session_id,
            }))
            .expect_err("expected write to killed session to fail");
        assert!(
            error.contains("terminal session not found"),
            "expected not-found error, got: {error}"
        );
    }

    #[test]
    fn normal_shell_exit_records_exited_state() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, output_rx) = test_server();
        let session_id = "terminal-test-exit";

        start_test_session(&server, session_id, shell, 80, 24);
        write_text(&server, session_id, "exit 7\r");

        let exit = wait_for_exit(&output_rx, session_id);
        assert_eq!(exit.0, Some(7));

        let attached = server
            .attach_session(json!({
                "cols": 80,
                "rows": 24,
                "sessionId": session_id,
            }))
            .expect("expected attach to exited session to succeed");
        assert_eq!(attached["status"], "exited");
        assert_eq!(attached["exitCode"], 7);

        server.kill_all();
    }

    #[test]
    fn unknown_session_requests_return_errors() {
        let (server, _output_rx) = test_server();

        let attach_error = server
            .attach_session(json!({
                "sessionId": "missing-session",
            }))
            .expect_err("expected missing attach to fail");
        assert!(attach_error.contains("terminal session not found"));

        let write_error = server
            .write_session(json!({
                "dataBase64": BASE64.encode(b"x"),
                "sessionId": "missing-session",
            }))
            .expect_err("expected missing write to fail");
        assert!(write_error.contains("terminal session not found"));
    }

    fn test_server() -> (TerminalExtensionServer, Receiver<Value>) {
        let (output_tx, output_rx) = mpsc::channel();
        (TerminalExtensionServer::new(output_tx), output_rx)
    }

    fn test_shell() -> Option<&'static str> {
        if cfg!(windows) {
            return None;
        }

        if Path::new("/bin/sh").is_file() {
            Some("/bin/sh")
        } else {
            None
        }
    }

    fn start_test_session(
        server: &TerminalExtensionServer,
        session_id: &str,
        shell: &str,
        cols: u32,
        rows: u32,
    ) -> Value {
        server
            .start_session(json!({
                "cols": cols,
                "cwd": env!("CARGO_MANIFEST_DIR"),
                "rows": rows,
                "sessionId": session_id,
                "shell": shell,
            }))
            .expect("expected test PTY session to start")
    }

    fn write_text(server: &TerminalExtensionServer, session_id: &str, text: &str) {
        server
            .write_session(json!({
                "dataBase64": BASE64.encode(text.as_bytes()),
                "sessionId": session_id,
            }))
            .expect("expected write to test session to succeed");
    }

    fn read_until_output(output_rx: &Receiver<Value>, session_id: &str, expected: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut collected = String::new();

        loop {
            let now = Instant::now();
            if now >= deadline {
                panic!("timed out waiting for {expected:?}; collected output: {collected:?}");
            }

            let message = output_rx
                .recv_timeout(deadline.saturating_duration_since(now))
                .expect("expected terminal output notification");
            if let Some(text) = output_text(&message, session_id) {
                collected.push_str(&text);
                if collected.contains(expected) {
                    return collected;
                }
            }
        }
    }

    fn wait_for_exit(
        output_rx: &Receiver<Value>,
        session_id: &str,
    ) -> (Option<u32>, Option<String>) {
        let deadline = Instant::now() + Duration::from_secs(5);

        loop {
            let now = Instant::now();
            if now >= deadline {
                panic!("timed out waiting for exit notification");
            }

            let message = output_rx
                .recv_timeout(deadline.saturating_duration_since(now))
                .expect("expected terminal exit notification");
            if message.get("method").and_then(Value::as_str) != Some(SESSION_EXITED_NOTIFICATION) {
                continue;
            }

            let Some(params) = message.get("params") else {
                continue;
            };
            if params.get("sessionId").and_then(Value::as_str) != Some(session_id) {
                continue;
            }

            let exit_code = params
                .get("exitCode")
                .and_then(Value::as_u64)
                .map(|value| value as u32);
            let exit_signal = params
                .get("exitSignal")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            return (exit_code, exit_signal);
        }
    }

    fn wait_for_terminal_notification(output_rx: &Receiver<Value>, session_id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);

        loop {
            let now = Instant::now();
            if now >= deadline {
                panic!("timed out waiting for terminal notification");
            }

            let message = output_rx
                .recv_timeout(deadline.saturating_duration_since(now))
                .expect("expected terminal notification");
            if message.get("method").and_then(Value::as_str)
                != Some(REMUX_NOTIFICATION_REQUEST_METHOD)
            {
                continue;
            }

            let Some(params) = message.get("params") else {
                continue;
            };
            if params
                .get("target")
                .and_then(|target| target.get("resourceId"))
                .and_then(Value::as_str)
                == Some(session_id)
            {
                return message;
            }
        }
    }

    fn replay_text(attached: &Value) -> String {
        attached
            .get("replay")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|frame| {
                frame
                    .get("dataBase64")
                    .and_then(Value::as_str)
                    .and_then(|data| BASE64.decode(data.as_bytes()).ok())
            })
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .collect::<String>()
    }

    fn output_text(message: &Value, session_id: &str) -> Option<String> {
        if message.get("method").and_then(Value::as_str) != Some(SESSION_OUTPUT_NOTIFICATION) {
            return None;
        }

        let params = message.get("params")?;
        if params.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            return None;
        }

        let data = params
            .get("frame")?
            .get("dataBase64")?
            .as_str()
            .and_then(|data| BASE64.decode(data.as_bytes()).ok())?;

        Some(String::from_utf8_lossy(&data).into_owned())
    }
}
