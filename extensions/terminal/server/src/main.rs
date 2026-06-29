use std::collections::{HashMap, VecDeque};
use std::env;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

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

const MAX_REPLAY_BYTES: usize = 4 * 1024 * 1024;
const MAX_REPLAY_FRAMES: usize = 10_000;

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

        self.remove_session_record(&session_id);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|error| format!("failed to open PTY: {error}"))?;
        let portable_pty::PtyPair { master, slave } = pair;
        let mut command = CommandBuilder::new(&shell);
        command.cwd(cwd.as_os_str());
        configure_terminal_environment(&mut command);

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
        let killer = self
            .remove_session_record(&params.session_id)
            .and_then(|mut session| session.killer.take());

        if let Some(mut killer) = killer {
            killer
                .kill()
                .map_err(|error| format!("failed to kill terminal session: {error}"))?;
        }

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
    master: Option<Box<dyn MasterPty + Send>>,
    next_seq: u64,
    pid: Option<u32>,
    replay: VecDeque<ReplayFrame>,
    replay_bytes: usize,
    rows: u16,
    session_id: String,
    shell: String,
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
            master: Some(init.master),
            next_seq: 1,
            pid: init.pid,
            replay: VecDeque::new(),
            replay_bytes: 0,
            rows: init.rows,
            session_id: init.session_id,
            shell: init.shell,
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

    fn mark_exited(&mut self, exit_code: Option<u32>, exit_signal: Option<String>) {
        self.exit_code = exit_code;
        self.exit_signal = exit_signal;
        self.status = SessionStatus::Exited;
        self.killer = None;
        self.master = None;
        self.writer = None;
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

fn spawn_reader_thread(
    state: Arc<Mutex<TerminalState>>,
    output_tx: mpsc::Sender<Value>,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            let bytes_read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(bytes_read) => bytes_read,
                Err(_) => break,
            };

            let notification = {
                let Ok(mut state) = state.lock() else {
                    break;
                };
                let Some(session) = state.sessions.get_mut(&session_id) else {
                    break;
                };
                let frame = session.append_output(&buffer[..bytes_read]);
                json!({
                    "jsonrpc": "2.0",
                    "method": SESSION_OUTPUT_NOTIFICATION,
                    "params": {
                        "frame": frame,
                        "sessionId": session_id,
                    },
                })
            };

            if output_tx.send(notification).is_err() {
                break;
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

        let notification = {
            let Ok(mut state) = state.lock() else {
                return;
            };
            let Some(session) = state.sessions.get_mut(&session_id) else {
                return;
            };
            session.mark_exited(exit_code, exit_signal.clone());
            json!({
                "jsonrpc": "2.0",
                "method": SESSION_EXITED_NOTIFICATION,
                "params": {
                    "exitCode": exit_code,
                    "exitSignal": exit_signal,
                    "sessionId": session_id,
                },
            })
        };

        let _ = output_tx.send(notification);
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
    use std::path::Path;
    use std::sync::mpsc::{self, Receiver};
    use std::time::{Duration, Instant};

    use base64::Engine;
    use serde_json::{Value, json};

    use portable_pty::CommandBuilder;

    use super::{
        BASE64, SESSION_EXITED_NOTIFICATION, SESSION_OUTPUT_NOTIFICATION, TerminalExtensionServer,
        clamp_u16, configure_terminal_environment, pty_size,
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
