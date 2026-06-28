use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

const SOCKET_RELATIVE_PATH: &[&str] = &["app-server-control", "app-server-control.sock"];
const APP_SERVER_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const DIAGNOSTIC_MAX_JSON_CHARS: usize = 6000;
const DIAGNOSTIC_MAX_STRING_CHARS: usize = 500;
const DIAGNOSTIC_MAX_ARRAY_ITEMS: usize = 20;
const DIAGNOSTIC_MAX_DEPTH: usize = 8;

type PendingResponses = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

#[derive(Debug, Clone)]
pub(crate) struct AppServerRuntime {
    inner: Arc<AppServerRuntimeInner>,
}

#[derive(Debug)]
struct AppServerRuntimeInner {
    app_server_process: Mutex<Option<Child>>,
    codex_home: PathBuf,
    connection: Mutex<Option<AppServerConnection>>,
    events: AppServerEventSink,
    next_id: AtomicU64,
}

#[derive(Debug, Clone)]
struct AppServerConnection {
    alive: Arc<AtomicBool>,
    pending: PendingResponses,
    writer_tx: mpsc::Sender<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct AppServerEventSink {
    sender: Option<mpsc::Sender<AppServerEvent>>,
}

#[derive(Debug, Clone)]
pub(crate) enum AppServerEvent {
    Disconnected(String),
    Notification(Value),
    ServerRequest(Value),
}

impl AppServerRuntime {
    pub(crate) fn new_with_event_sink(codex_home: PathBuf, events: AppServerEventSink) -> Self {
        Self {
            inner: Arc::new(AppServerRuntimeInner {
                app_server_process: Mutex::new(None),
                codex_home,
                connection: Mutex::new(None),
                events,
                next_id: AtomicU64::new(1),
            }),
        }
    }

    pub(crate) fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        debug_log(format_args!(
            "[codex:app-server] request begin method={method}"
        ));
        match self.request_once(method, params.clone()) {
            Ok(value) => {
                debug_log(format_args!(
                    "[codex:app-server] request ok method={method} summary={}",
                    summarize_app_server_value(&value)
                ));
                Ok(value)
            }
            Err(first_error) => {
                eprintln!(
                    "[codex:app-server] request failed method={method} error={first_error}; retrying"
                );
                self.clear_connection();
                self.request_once(method, params).map_err(|second_error| {
                    eprintln!(
                        "[codex:app-server] request retry failed method={method} error={second_error}"
                    );
                    format!("{first_error}; retry failed: {second_error}")
                })
            }
        }
    }

    fn request_once(&self, method: &str, params: Value) -> Result<Value, String> {
        let connection = self.ensure_connected()?;
        if !connection.alive.load(Ordering::SeqCst) {
            return Err("app-server connection is closed".to_string());
        }

        let id = self.next_request_id();
        debug_log(format_args!(
            "[codex:app-server] dispatch id={id} method={method} params={}",
            summarize_app_server_value(&params)
        ));
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let request = serde_json::to_string(&request).map_err(|error| error.to_string())?;
        let (response_tx, response_rx) = mpsc::channel();
        connection
            .pending
            .lock()
            .map_err(|_| "app-server pending map poisoned".to_string())?
            .insert(id, response_tx);

        if let Err(error) = connection.writer_tx.send(request) {
            let _ = connection
                .pending
                .lock()
                .map(|mut pending| pending.remove(&id));
            connection.alive.store(false, Ordering::SeqCst);
            return Err(format!("failed to send app-server request: {error}"));
        }

        match response_rx.recv_timeout(APP_SERVER_REQUEST_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = connection
                    .pending
                    .lock()
                    .map(|mut pending| pending.remove(&id));
                eprintln!("[codex:app-server] timeout id={id} method={method}");
                Err(format!("{method} timed out"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = connection
                    .pending
                    .lock()
                    .map(|mut pending| pending.remove(&id));
                Err("app-server response channel closed".to_string())
            }
        }
    }

    fn ensure_connected(&self) -> Result<AppServerConnection, String> {
        let mut connection_guard = self
            .inner
            .connection
            .lock()
            .map_err(|_| "app-server connection lock poisoned".to_string())?;
        if let Some(connection) = connection_guard.as_ref() {
            if connection.alive.load(Ordering::SeqCst) {
                return Ok(connection.clone());
            }
        }

        *connection_guard = None;
        let connection = self.connect_or_start()?;
        *connection_guard = Some(connection.clone());
        Ok(connection)
    }

    fn connect_or_start(&self) -> Result<AppServerConnection, String> {
        if let Ok(connection) = self.connect_and_initialize_runtime() {
            debug_log(format_args!(
                "[codex:app-server] connected existing runtime"
            ));
            return Ok(connection);
        }

        eprintln!("[codex:app-server] starting runtime");
        self.start_app_server()?;
        let mut last_error = String::new();
        for _ in 0..50 {
            match self.connect_and_initialize_runtime() {
                Ok(connection) => {
                    debug_log(format_args!("[codex:app-server] connected started runtime"));
                    return Ok(connection);
                }
                Err(error) => {
                    last_error = error;
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }

        Err(format!("failed to connect to app-server: {last_error}"))
    }

    fn connect_and_initialize_runtime(&self) -> Result<AppServerConnection, String> {
        let mut socket = UnixWebSocket::connect(self.socket_path())?;
        self.initialize_socket(&mut socket)?;
        socket
            .stream
            .set_read_timeout(None)
            .map_err(|error| error.to_string())?;

        let (reader, writer) = socket.split()?;
        let pending: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let (writer_tx, writer_rx) = mpsc::channel::<String>();

        spawn_app_server_writer(writer, writer_rx, alive.clone(), pending.clone());
        spawn_app_server_reader(
            reader,
            writer_tx.clone(),
            alive.clone(),
            pending.clone(),
            self.inner.events.clone(),
        );

        Ok(AppServerConnection {
            alive,
            pending,
            writer_tx,
        })
    }

    fn initialize_socket(&self, socket: &mut UnixWebSocket) -> Result<(), String> {
        let id = self.next_request_id();
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "capabilities": {
                    "experimentalApi": true
                },
                "clientInfo": {
                    "name": "remux_codex_extension",
                    "title": "Remux Codex Extension",
                    "version": "0.1.0"
                }
            }
        });
        socket.send_text(&serde_json::to_string(&request).map_err(|error| error.to_string())?)?;

        loop {
            let message = socket.read_text()?;
            let value: Value = serde_json::from_str(&message).map_err(|error| error.to_string())?;
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(error_message(error, "initialize failed"));
            }
            break;
        }

        socket.send_text(
            &serde_json::to_string(&json!({
                "jsonrpc": "2.0",
                "method": "initialized",
            }))
            .map_err(|error| error.to_string())?,
        )?;
        Ok(())
    }

    fn start_app_server(&self) -> Result<(), String> {
        let mut process_guard = self
            .inner
            .app_server_process
            .lock()
            .map_err(|_| "app-server process lock poisoned".to_string())?;
        if process_guard.is_some() {
            return Ok(());
        }

        let mut errors = Vec::new();
        for candidate in codex_command_candidates() {
            match self.spawn_app_server(&candidate) {
                Ok(child) => {
                    debug_log(format_args!(
                        "[codex:app-server] spawned command={}",
                        candidate.display()
                    ));
                    *process_guard = Some(child);
                    return Ok(());
                }
                Err(error) => errors.push(format!("{}: {error}", candidate.display())),
            }
        }

        Err(format!(
            "failed to start codex app-server using known codex commands: {}",
            errors.join("; ")
        ))
    }

    fn spawn_app_server(&self, command: &PathBuf) -> Result<Child, std::io::Error> {
        Command::new(command)
            .args(["app-server", "--listen", "unix://"])
            .env("CODEX_HOME", &self.inner.codex_home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
    }

    fn socket_path(&self) -> PathBuf {
        let mut path = self.inner.codex_home.clone();
        for component in SOCKET_RELATIVE_PATH {
            path.push(component);
        }
        path
    }

    fn next_request_id(&self) -> u64 {
        self.inner.next_id.fetch_add(1, Ordering::SeqCst)
    }

    fn clear_connection(&self) {
        if let Ok(mut connection) = self.inner.connection.lock() {
            if let Some(connection) = connection.take() {
                connection.alive.store(false, Ordering::SeqCst);
                drain_pending(
                    &connection.pending,
                    "app-server connection reset".to_string(),
                );
            }
        }
    }
}

impl Default for AppServerEventSink {
    fn default() -> Self {
        Self { sender: None }
    }
}

impl AppServerEventSink {
    pub(crate) fn channel() -> (Self, mpsc::Receiver<AppServerEvent>) {
        let (sender, receiver) = mpsc::channel();
        (
            Self {
                sender: Some(sender),
            },
            receiver,
        )
    }

    fn emit(&self, event: AppServerEvent) {
        match &event {
            AppServerEvent::Disconnected(reason) => {
                let _ = reason;
            }
            AppServerEvent::Notification(notification)
            | AppServerEvent::ServerRequest(notification) => {
                let _ = notification;
            }
        }

        if let Some(sender) = &self.sender {
            let _ = sender.send(event);
        }
    }
}

impl Drop for AppServerRuntimeInner {
    fn drop(&mut self) {
        if let Ok(mut connection) = self.connection.lock() {
            if let Some(connection) = connection.take() {
                connection.alive.store(false, Ordering::SeqCst);
                drain_pending(
                    &connection.pending,
                    "app-server runtime stopped".to_string(),
                );
            }
        }

        if let Ok(mut process) = self.app_server_process.lock() {
            if let Some(mut child) = process.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn spawn_app_server_reader(
    mut reader: UnixWebSocketReader,
    writer_tx: mpsc::Sender<String>,
    alive: Arc<AtomicBool>,
    pending: PendingResponses,
    events: AppServerEventSink,
) {
    thread::spawn(move || {
        while alive.load(Ordering::SeqCst) {
            let message = match reader.read_text() {
                Ok(message) => message,
                Err(error) => {
                    alive.store(false, Ordering::SeqCst);
                    drain_pending(&pending, error.clone());
                    events.emit(AppServerEvent::Disconnected(error));
                    break;
                }
            };
            let value = match serde_json::from_str::<Value>(&message) {
                Ok(value) => value,
                Err(error) => {
                    events.emit(AppServerEvent::Notification(json!({
                        "method": "app-server/malformed",
                        "params": { "error": error.to_string() },
                    })));
                    continue;
                }
            };
            route_app_server_message(value, &pending, &events, Some(&writer_tx));
        }
    });
}

fn spawn_app_server_writer(
    mut writer: UnixWebSocketWriter,
    writer_rx: mpsc::Receiver<String>,
    alive: Arc<AtomicBool>,
    pending: PendingResponses,
) {
    thread::spawn(move || {
        while alive.load(Ordering::SeqCst) {
            let message = match writer_rx.recv() {
                Ok(message) => message,
                Err(_) => break,
            };
            if let Err(error) = writer.send_text(&message) {
                alive.store(false, Ordering::SeqCst);
                drain_pending(&pending, error);
                break;
            }
        }
    });
}

fn route_app_server_message(
    value: Value,
    pending: &PendingResponses,
    events: &AppServerEventSink,
    writer_tx: Option<&mpsc::Sender<String>>,
) {
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        if value.get("method").and_then(Value::as_str).is_some() {
            eprintln!(
                "[codex:app-server] server-request id={id} summary={}",
                summarize_app_server_value(&value)
            );
            debug_log(format_args!(
                "[codex:app-server] server-request payload={}",
                diagnostic_json(&value)
            ));
            events.emit(AppServerEvent::ServerRequest(value.clone()));
            if let Some(writer_tx) = writer_tx {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32601,
                        "message": "server requests are not supported by remux-codex-server yet"
                    }
                });
                let _ = writer_tx.send(response.to_string());
            }
            return;
        }

        let sender = pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&id));
        if let Some(sender) = sender {
            let result = if let Some(error) = value.get("error") {
                eprintln!(
                    "[codex:app-server] response error id={id} error={}",
                    error_message(error, "app-server request failed")
                );
                debug_log(format_args!(
                    "[codex:app-server] response error payload={}",
                    diagnostic_json(error)
                ));
                Err(error_message(error, "app-server request failed"))
            } else {
                debug_log(format_args!(
                    "[codex:app-server] response ok id={id} summary={}",
                    summarize_app_server_value(value.get("result").unwrap_or(&Value::Null))
                ));
                Ok(value.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = sender.send(result);
        }
        return;
    }

    if value.get("method").and_then(Value::as_str).is_some() {
        let method = value.get("method").and_then(Value::as_str).unwrap_or("-");
        debug_log(format_args!(
            "[codex:app-server] notification summary={}",
            summarize_app_server_value(&value)
        ));
        if method == "error" || is_failed_turn_completed(&value) {
            eprintln!(
                "[codex:app-server] notification payload={}",
                diagnostic_json(&value)
            );
        }
        events.emit(AppServerEvent::Notification(value));
    }
}

fn debug_log(args: std::fmt::Arguments<'_>) {
    if app_server_debug_enabled() {
        eprintln!("{args}");
    }
}

fn app_server_debug_enabled() -> bool {
    env::var("REMUX_CODEX_DEBUG")
        .ok()
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

fn summarize_app_server_value(value: &Value) -> String {
    if let Some(method) = value.get("method").and_then(Value::as_str) {
        let params = value.get("params").unwrap_or(&Value::Null);
        return format!(
            "method={method} threadId={} turnId={} status={}",
            json_string(params.get("threadId")),
            json_string(params.get("turn").and_then(|turn| turn.get("id"))),
            json_string(params.get("turn").and_then(|turn| turn.get("status")))
        );
    }

    if let Some(turn) = value.get("turn") {
        return format!(
            "turnId={} status={} itemCount={}",
            json_string(turn.get("id")),
            json_string(turn.get("status")),
            turn.get("items")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0)
        );
    }

    if let Some(thread) = value.get("thread") {
        return format!(
            "threadId={} status={}",
            json_string(thread.get("id")),
            json_string(thread.get("status"))
        );
    }

    match value {
        Value::Object(map) => format!("keys={}", map.keys().cloned().collect::<Vec<_>>().join(",")),
        Value::Array(values) => format!("arrayLen={}", values.len()),
        Value::Null => "null".to_string(),
        _ => value.to_string(),
    }
}

fn json_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("-")
        .to_string()
}

fn is_failed_turn_completed(value: &Value) -> bool {
    value.get("method").and_then(Value::as_str) == Some("turn/completed")
        && value
            .get("params")
            .and_then(|params| params.get("turn"))
            .and_then(|turn| turn.get("status"))
            .and_then(Value::as_str)
            == Some("failed")
}

fn diagnostic_json(value: &Value) -> String {
    let sanitized = sanitize_diagnostic_value(value, 0);
    let serialized = serde_json::to_string(&sanitized)
        .unwrap_or_else(|error| format!("serialization failed: {error}"));
    truncate_chars(&serialized, DIAGNOSTIC_MAX_JSON_CHARS)
}

fn sanitize_diagnostic_value(value: &Value, depth: usize) -> Value {
    if depth >= DIAGNOSTIC_MAX_DEPTH {
        return Value::String("[max-depth]".to_string());
    }

    match value {
        Value::Array(values) => {
            let mut sanitized = values
                .iter()
                .take(DIAGNOSTIC_MAX_ARRAY_ITEMS)
                .map(|value| sanitize_diagnostic_value(value, depth + 1))
                .collect::<Vec<_>>();
            if values.len() > DIAGNOSTIC_MAX_ARRAY_ITEMS {
                sanitized.push(Value::String(format!(
                    "[{} more items]",
                    values.len() - DIAGNOSTIC_MAX_ARRAY_ITEMS
                )));
            }
            Value::Array(sanitized)
        }
        Value::Object(map) => {
            let mut sanitized = serde_json::Map::new();
            for (key, value) in map {
                sanitized.insert(
                    key.clone(),
                    sanitize_diagnostic_field(key, value, depth + 1),
                );
            }
            Value::Object(sanitized)
        }
        Value::String(value) => Value::String(sanitize_diagnostic_string(value)),
        _ => value.clone(),
    }
}

fn sanitize_diagnostic_field(key: &str, value: &Value, depth: usize) -> Value {
    let lower_key = key.to_ascii_lowercase();
    if lower_key.contains("dataurl") || lower_key.contains("base64") {
        return Value::String("[redacted-large-data]".to_string());
    }
    if lower_key == "url" {
        if let Some(value) = value.as_str() {
            if value.starts_with("data:") {
                return Value::String("[redacted-data-url]".to_string());
            }
        }
    }

    sanitize_diagnostic_value(value, depth)
}

fn sanitize_diagnostic_string(value: &str) -> String {
    if value.starts_with("data:") {
        return "[redacted-data-url]".to_string();
    }

    truncate_chars(value, DIAGNOSTIC_MAX_STRING_CHARS)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...[truncated]")
    } else {
        truncated
    }
}

fn drain_pending(pending: &PendingResponses, reason: String) {
    let pending = match pending.lock() {
        Ok(mut pending) => std::mem::take(&mut *pending),
        Err(_) => return,
    };

    for (_, sender) in pending {
        let _ = sender.send(Err(reason.clone()));
    }
}

fn error_message(error: &Value, fallback: &str) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

fn codex_command_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(value) = env::var("CODEX_BIN") {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }

    candidates.push(PathBuf::from("codex"));

    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join("codex"));
        }
    }

    if let Ok(home) = env::var("HOME") {
        if !home.trim().is_empty() {
            candidates.push(PathBuf::from(home).join(".local/bin/codex"));
        }
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));
    candidates.push(PathBuf::from("/usr/local/bin/codex"));
    candidates
}

#[derive(Debug)]
struct UnixWebSocket {
    stream: UnixStream,
}

#[derive(Debug)]
struct UnixWebSocketReader {
    stream: UnixStream,
}

#[derive(Debug)]
struct UnixWebSocketWriter {
    stream: UnixStream,
}

impl UnixWebSocket {
    fn connect(path: PathBuf) -> Result<Self, String> {
        let mut stream = UnixStream::connect(&path)
            .map_err(|error| format!("failed to connect {}: {error}", path.display()))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(30)))
            .map_err(|error| error.to_string())?;
        stream
            .write_all(
                b"GET /rpc HTTP/1.1\r\n\
Host: localhost\r\n\
Upgrade: websocket\r\n\
Connection: Upgrade\r\n\
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
Sec-WebSocket-Version: 13\r\n\
\r\n",
            )
            .map_err(|error| error.to_string())?;

        let mut response = Vec::new();
        let mut buffer = [0u8; 1];
        while !response.ends_with(b"\r\n\r\n") {
            stream
                .read_exact(&mut buffer)
                .map_err(|error| error.to_string())?;
            response.push(buffer[0]);
            if response.len() > 8192 {
                return Err("websocket handshake response too large".to_string());
            }
        }
        let response = String::from_utf8_lossy(&response);
        if !response.starts_with("HTTP/1.1 101") && !response.starts_with("HTTP/1.0 101") {
            return Err(format!(
                "websocket handshake failed: {}",
                response.lines().next().unwrap_or("empty response")
            ));
        }

        Ok(Self { stream })
    }

    fn send_text(&mut self, text: &str) -> Result<(), String> {
        send_frame(&mut self.stream, 0x1, text.as_bytes())
    }

    fn read_text(&mut self) -> Result<String, String> {
        read_text_frame(&mut self.stream, |stream, payload| {
            send_frame(stream, 0xA, payload)
        })
    }

    fn split(self) -> Result<(UnixWebSocketReader, UnixWebSocketWriter), String> {
        let writer = self.stream.try_clone().map_err(|error| error.to_string())?;
        Ok((
            UnixWebSocketReader {
                stream: self.stream,
            },
            UnixWebSocketWriter { stream: writer },
        ))
    }
}

impl UnixWebSocketReader {
    fn read_text(&mut self) -> Result<String, String> {
        read_text_frame(&mut self.stream, |stream, payload| {
            send_frame(stream, 0xA, payload)
        })
    }
}

impl UnixWebSocketWriter {
    fn send_text(&mut self, text: &str) -> Result<(), String> {
        send_frame(&mut self.stream, 0x1, text.as_bytes())
    }
}

fn read_text_frame(
    stream: &mut UnixStream,
    mut on_ping: impl FnMut(&mut UnixStream, &[u8]) -> Result<(), String>,
) -> Result<String, String> {
    loop {
        let (opcode, payload) = read_frame(stream)?;
        match opcode {
            0x1 => return String::from_utf8(payload).map_err(|error| error.to_string()),
            0x2 => return String::from_utf8(payload).map_err(|error| error.to_string()),
            0x8 => return Err("app-server websocket closed".to_string()),
            0x9 => on_ping(stream, &payload)?,
            0xA => {}
            _ => {}
        }
    }
}

fn send_frame(stream: &mut UnixStream, opcode: u8, payload: &[u8]) -> Result<(), String> {
    let mut frame = Vec::new();
    frame.push(0x80 | (opcode & 0x0f));
    if payload.len() <= 125 {
        frame.push(0x80 | payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }

    let mask = [0x52, 0x4d, 0x58, 0x21];
    frame.extend_from_slice(&mask);
    for (index, byte) in payload.iter().enumerate() {
        frame.push(byte ^ mask[index % mask.len()]);
    }
    stream.write_all(&frame).map_err(|error| error.to_string())
}

fn read_frame(stream: &mut UnixStream) -> Result<(u8, Vec<u8>), String> {
    let mut header = [0u8; 2];
    stream
        .read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    let opcode = header[0] & 0x0f;
    let masked = header[1] & 0x80 != 0;
    let mut len = (header[1] & 0x7f) as u64;
    if len == 126 {
        let mut extended = [0u8; 2];
        stream
            .read_exact(&mut extended)
            .map_err(|error| error.to_string())?;
        len = u16::from_be_bytes(extended) as u64;
    } else if len == 127 {
        let mut extended = [0u8; 8];
        stream
            .read_exact(&mut extended)
            .map_err(|error| error.to_string())?;
        len = u64::from_be_bytes(extended);
    }

    let mut mask = [0u8; 4];
    if masked {
        stream
            .read_exact(&mut mask)
            .map_err(|error| error.to_string())?;
    }

    if len > 128 * 1024 * 1024 {
        return Err("app-server websocket frame too large".to_string());
    }
    let mut payload = vec![0u8; len as usize];
    stream
        .read_exact(&mut payload)
        .map_err(|error| error.to_string())?;
    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % mask.len()];
        }
    }
    Ok((opcode, payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_response_to_matching_pending_request() {
        let (pending, receiver) = pending_map_with_request(7);
        let events = AppServerEventSink::default();

        route_app_server_message(
            json!({ "jsonrpc": "2.0", "id": 7, "result": { "ok": true } }),
            &pending,
            &events,
            None,
        );

        assert_eq!(receiver.recv().unwrap().unwrap(), json!({ "ok": true }));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn routes_notification_to_event_sink_without_touching_pending_requests() {
        let (events, receiver) = AppServerEventSink::channel();
        let pending = pending_map_with_request(9).0;

        route_app_server_message(
            json!({ "jsonrpc": "2.0", "method": "turn/started", "params": { "threadId": "t" } }),
            &pending,
            &events,
            None,
        );

        let AppServerEvent::Notification(notification) = receiver.recv().unwrap() else {
            panic!("expected notification event");
        };
        assert_eq!(notification["method"], "turn/started");
        assert!(pending.lock().unwrap().contains_key(&9));
    }

    #[test]
    fn routes_error_response_to_waiter() {
        let (pending, receiver) = pending_map_with_request(11);
        let events = AppServerEventSink::default();

        route_app_server_message(
            json!({
                "jsonrpc": "2.0",
                "id": 11,
                "error": { "code": -32000, "message": "boom" }
            }),
            &pending,
            &events,
            None,
        );

        assert_eq!(receiver.recv().unwrap().unwrap_err(), "boom");
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn routes_server_request_to_event_sink_and_error_response() {
        let (events, receiver) = AppServerEventSink::channel();
        let pending = pending_map_with_request(3).0;
        let (writer_tx, writer_rx) = mpsc::channel();

        route_app_server_message(
            json!({ "jsonrpc": "2.0", "id": 99, "method": "tool/request", "params": {} }),
            &pending,
            &events,
            Some(&writer_tx),
        );

        let AppServerEvent::ServerRequest(request) = receiver.recv().unwrap() else {
            panic!("expected server request event");
        };
        assert_eq!(request["method"], "tool/request");
        let response: Value = serde_json::from_str(&writer_rx.recv().unwrap()).unwrap();
        assert_eq!(response["id"], 99);
        assert_eq!(response["error"]["code"], -32601);
        assert!(pending.lock().unwrap().contains_key(&3));
    }

    #[test]
    fn drain_pending_resolves_all_waiters_with_error() {
        let pending: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
        let (left_tx, left_rx) = mpsc::channel();
        let (right_tx, right_rx) = mpsc::channel();
        pending.lock().unwrap().insert(1, left_tx);
        pending.lock().unwrap().insert(2, right_tx);

        drain_pending(&pending, "gone".to_string());

        assert_eq!(left_rx.recv().unwrap().unwrap_err(), "gone");
        assert_eq!(right_rx.recv().unwrap().unwrap_err(), "gone");
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn event_sink_forwards_disconnect_reason() {
        let (events, receiver) = AppServerEventSink::channel();

        events.emit(AppServerEvent::Disconnected("closed".to_string()));

        let AppServerEvent::Disconnected(reason) = receiver.recv().unwrap() else {
            panic!("expected disconnected event");
        };
        assert_eq!(reason, "closed");
    }

    fn pending_map_with_request(
        id: u64,
    ) -> (PendingResponses, mpsc::Receiver<Result<Value, String>>) {
        let pending: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = mpsc::channel();
        pending.lock().unwrap().insert(id, sender);
        (pending, receiver)
    }
}
