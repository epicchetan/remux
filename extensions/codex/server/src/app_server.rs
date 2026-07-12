use std::collections::HashMap;
use std::env;
use std::io::{BufRead, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const SOCKET_RELATIVE_PATH: &[&str] = &["app-server-control", "app-server-control.sock"];
const APP_SERVER_INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
const APP_SERVER_MANAGEMENT_TIMEOUT: Duration = Duration::from_secs(30);
const CODEX_UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
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
    codex_home: PathBuf,
    codex_command: Mutex<Option<PathBuf>>,
    command_runner: Arc<dyn CodexCommandRunner>,
    connection: Mutex<Option<AppServerConnection>>,
    events: AppServerEventSink,
    ever_connected: AtomicBool,
    next_id: AtomicU64,
    suppress_next_reconnect_event: AtomicBool,
}

#[derive(Debug, Clone)]
struct AppServerConnection {
    alive: Arc<AtomicBool>,
    pending: PendingResponses,
    shutdown: Arc<UnixStream>,
    writer_tx: mpsc::Sender<String>,
}

impl AppServerConnection {
    fn close(&self, reason: &str) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.shutdown.shutdown(std::net::Shutdown::Both);
        drain_pending(&self.pending, reason.to_string());
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AppServerEventSink {
    sender: Option<mpsc::Sender<AppServerEvent>>,
}

#[derive(Debug, Clone)]
pub(crate) enum AppServerEvent {
    Reconnected,
    Disconnected(String),
    ManagementLog {
        source: &'static str,
        channel: Option<&'static str>,
        level: Option<&'static str>,
        line: String,
    },
    Notification(Value),
    ServerRequest(Value),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexAppServerStatus {
    pub(crate) state: String,
    pub(crate) socket_path: Option<String>,
    pub(crate) managed_codex_path: Option<String>,
    pub(crate) installed_version: Option<String>,
    pub(crate) running_version: Option<String>,
    pub(crate) restart_required: bool,
    pub(crate) last_error: Option<String>,
}

impl CodexAppServerStatus {
    pub(crate) fn to_value(&self, active_turn_ids: Vec<String>) -> Value {
        json!({
            "state": self.state,
            "socketPath": self.socket_path,
            "managedCodexPath": self.managed_codex_path,
            "installedVersion": self.installed_version,
            "runningVersion": self.running_version,
            "restartRequired": self.restart_required,
            "lastError": self.last_error,
            "activeTurnIds": active_turn_ids,
        })
    }
}

#[derive(Debug)]
struct CodexCommandOutput {
    stdout: String,
    #[cfg(test)]
    stderr: String,
}

#[derive(Debug, Clone, Copy)]
enum CodexCommandChannel {
    Stdout,
    Stderr,
}

impl CodexCommandChannel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

#[derive(Debug)]
struct CodexCommandLine {
    channel: CodexCommandChannel,
    line: String,
}

trait CodexCommandRunner: std::fmt::Debug + Send + Sync {
    fn run(
        &self,
        command: &PathBuf,
        args: &[&str],
        codex_home: &PathBuf,
        timeout: Duration,
        on_line: &mut dyn FnMut(CodexCommandLine),
    ) -> Result<CodexCommandOutput, String>;
}

#[derive(Debug)]
struct ProcessCodexCommandRunner;

impl AppServerRuntime {
    pub(crate) fn new_with_event_sink(codex_home: PathBuf, events: AppServerEventSink) -> Self {
        Self::new_with_runner(codex_home, events, Arc::new(ProcessCodexCommandRunner))
    }

    fn new_with_runner(
        codex_home: PathBuf,
        events: AppServerEventSink,
        command_runner: Arc<dyn CodexCommandRunner>,
    ) -> Self {
        Self {
            inner: Arc::new(AppServerRuntimeInner {
                codex_home,
                codex_command: Mutex::new(None),
                command_runner,
                connection: Mutex::new(None),
                events,
                ever_connected: AtomicBool::new(false),
                next_id: AtomicU64::new(1),
                suppress_next_reconnect_event: AtomicBool::new(false),
            }),
        }
    }

    pub(crate) fn daemon_status(&self) -> CodexAppServerStatus {
        match self.run_codex_command(
            &["app-server", "daemon", "version"],
            APP_SERVER_MANAGEMENT_TIMEOUT,
            "lifecycle",
            false,
        ) {
            Ok(output) => {
                let status = parse_daemon_status(&output.stdout, None, self.socket_path());
                if let Some(path) = status.managed_codex_path.as_deref()
                    && let Ok(mut command) = self.inner.codex_command.lock()
                {
                    *command = Some(PathBuf::from(path));
                }
                status
            }
            Err(error) => {
                CodexAppServerStatus {
                    state: "failed".to_string(),
                    socket_path: Some(self.socket_path().to_string_lossy().into_owned()),
                    managed_codex_path: self.inner.codex_command.lock().ok().and_then(|command| {
                        command.as_ref().map(|path| path.display().to_string())
                    }),
                    installed_version: None,
                    running_version: None,
                    restart_required: false,
                    last_error: Some(error),
                }
            }
        }
    }

    pub(crate) fn daemon_start(&self) -> Result<CodexAppServerStatus, String> {
        self.emit_management_log("lifecycle", None, Some("info"), "starting");
        self.start_app_server()?;
        self.disconnect_connection("app-server reconnecting");
        self.inner
            .suppress_next_reconnect_event
            .store(true, Ordering::SeqCst);
        if let Err(error) = self.ensure_connected() {
            self.inner
                .suppress_next_reconnect_event
                .store(false, Ordering::SeqCst);
            return Err(error);
        }
        Ok(self.daemon_status())
    }

    pub(crate) fn daemon_stop(&self) -> Result<CodexAppServerStatus, String> {
        self.emit_management_log("lifecycle", None, Some("info"), "stopping");
        // Close our client first so the reader treats the EOF as intentional
        // and does not race the explicit Stop with automatic reconnect.
        self.disconnect_connection("app-server stopping");
        self.run_codex_command(
            &["app-server", "daemon", "stop"],
            APP_SERVER_MANAGEMENT_TIMEOUT,
            "lifecycle",
            true,
        )?;
        self.emit_management_log("lifecycle", None, Some("info"), "stopped");
        Ok(self.daemon_status())
    }

    pub(crate) fn daemon_restart(&self) -> Result<CodexAppServerStatus, String> {
        self.emit_management_log("lifecycle", None, Some("info"), "restarting");
        // Suppress both the intentional disconnect and the reconnect event;
        // the management caller reconciles synchronously after this returns.
        self.disconnect_connection("app-server restarting");
        self.inner
            .suppress_next_reconnect_event
            .store(true, Ordering::SeqCst);
        if let Err(error) = self.run_codex_command(
            &["app-server", "daemon", "restart"],
            APP_SERVER_MANAGEMENT_TIMEOUT,
            "lifecycle",
            true,
        ) {
            self.inner
                .suppress_next_reconnect_event
                .store(false, Ordering::SeqCst);
            return Err(error);
        }
        if let Err(error) = self.ensure_connected() {
            self.inner
                .suppress_next_reconnect_event
                .store(false, Ordering::SeqCst);
            return Err(error);
        }
        self.emit_management_log("lifecycle", None, Some("info"), "reconnected");
        Ok(self.daemon_status())
    }

    pub(crate) fn update_codex(&self) -> Result<CodexAppServerStatus, String> {
        self.emit_management_log("update", None, Some("info"), "checking for update");
        self.run_codex_command(&["update"], CODEX_UPDATE_TIMEOUT, "update", true)?;
        self.emit_management_log("update", None, Some("info"), "update completed");
        Ok(self.daemon_status())
    }

    pub(crate) fn management_log(
        &self,
        source: &'static str,
        level: Option<&'static str>,
        line: &str,
    ) {
        self.emit_management_log(source, None, level, line);
    }

    pub(crate) fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let timeout = app_server_request_timeout(method)
            .ok_or_else(|| format!("unregistered app-server RPC policy: {method}"))?;
        debug_log(format_args!(
            "[codex:app-server] request begin method={method} timeout_ms={}",
            timeout.as_millis()
        ));
        let value = self.request_once(method, params, timeout)?;
        debug_log(format_args!(
            "[codex:app-server] request ok method={method} summary={}",
            summarize_app_server_value(&value)
        ));
        Ok(value)
    }

    pub(crate) fn reconnect(&self) -> Result<(), String> {
        self.ensure_connected().map(|_| ())
    }

    fn request_once(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
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

        match response_rx.recv_timeout(timeout) {
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
        let deadline = Instant::now() + APP_SERVER_INITIALIZE_TIMEOUT;
        if let Ok(connection) = self.connect_and_initialize_runtime(Duration::from_secs(2)) {
            debug_log(format_args!(
                "[codex:app-server] connected existing runtime"
            ));
            self.emit_management_log(
                "connection",
                None,
                Some("info"),
                "connected existing daemon",
            );
            self.emit_reconnected_if_needed();
            return Ok(connection);
        }

        self.emit_management_log("connection", None, Some("info"), "starting daemon");
        self.start_app_server()?;
        let mut last_error = String::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match self.connect_and_initialize_runtime(remaining.min(Duration::from_secs(2))) {
                Ok(connection) => {
                    debug_log(format_args!("[codex:app-server] connected started runtime"));
                    self.emit_management_log(
                        "connection",
                        None,
                        Some("info"),
                        "connected started daemon",
                    );
                    self.emit_reconnected_if_needed();
                    return Ok(connection);
                }
                Err(error) => {
                    last_error = error;
                    thread::sleep(remaining.min(Duration::from_millis(100)));
                }
            }
        }

        Err(format!("failed to connect to app-server: {last_error}"))
    }

    fn connect_and_initialize_runtime(
        &self,
        timeout: Duration,
    ) -> Result<AppServerConnection, String> {
        let mut socket = UnixWebSocket::connect(self.socket_path(), timeout)?;
        self.initialize_socket(&mut socket)?;
        socket
            .stream
            .set_read_timeout(None)
            .map_err(|error| error.to_string())?;

        let shutdown = Arc::new(
            socket
                .stream
                .try_clone()
                .map_err(|error| error.to_string())?,
        );
        let (reader, writer) = socket.split()?;
        let pending: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let (writer_tx, writer_rx) = mpsc::channel::<String>();

        spawn_app_server_writer(
            writer,
            writer_rx,
            alive.clone(),
            pending.clone(),
            self.inner.events.clone(),
        );
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
            shutdown,
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
        self.run_codex_command(
            &["app-server", "daemon", "start"],
            APP_SERVER_MANAGEMENT_TIMEOUT,
            "lifecycle",
            true,
        )
        .map(|_| ())
    }

    fn run_codex_command(
        &self,
        args: &[&str],
        timeout: Duration,
        source: &'static str,
        emit_output: bool,
    ) -> Result<CodexCommandOutput, String> {
        let selected = self
            .inner
            .codex_command
            .lock()
            .map_err(|_| "codex command lock poisoned".to_string())?
            .clone();
        let candidates = selected
            .map(|command| vec![command])
            .unwrap_or_else(codex_command_candidates);
        let mut errors = Vec::new();
        for candidate in candidates {
            let mut on_line = |entry: CodexCommandLine| {
                if emit_output {
                    self.emit_management_log(
                        source,
                        Some(entry.channel.as_str()),
                        None,
                        &entry.line,
                    );
                }
            };
            match self.inner.command_runner.run(
                &candidate,
                args,
                &self.inner.codex_home,
                timeout,
                &mut on_line,
            ) {
                Ok(output) => {
                    if let Ok(mut selected) = self.inner.codex_command.lock() {
                        *selected = Some(candidate);
                    }
                    return Ok(output);
                }
                Err(error) if error.starts_with("spawn failed:") => {
                    errors.push(format!("{}: {error}", candidate.display()));
                }
                Err(error) if error.starts_with("Remux workload launcher unavailable:") => {
                    self.emit_management_log(source, None, Some("error"), &error);
                    return Err(error);
                }
                Err(error) => {
                    let error = format!("Codex command failed: {}: {error}", candidate.display());
                    self.emit_management_log(source, None, Some("error"), &error);
                    return Err(error);
                }
            }
        }
        let error = format!("Codex command failed: {}", errors.join("; "));
        self.emit_management_log(source, None, Some("error"), &error);
        Err(error)
    }

    fn emit_management_log(
        &self,
        source: &'static str,
        channel: Option<&'static str>,
        level: Option<&'static str>,
        line: &str,
    ) {
        self.inner.events.emit(AppServerEvent::ManagementLog {
            source,
            channel,
            level,
            line: line.to_string(),
        });
    }

    fn emit_reconnected_if_needed(&self) {
        let was_connected = self.inner.ever_connected.swap(true, Ordering::SeqCst);
        let suppressed = self
            .inner
            .suppress_next_reconnect_event
            .swap(false, Ordering::SeqCst);
        if was_connected && !suppressed {
            self.inner.events.emit(AppServerEvent::Reconnected);
        }
    }

    fn disconnect_connection(&self, reason: &str) {
        if let Ok(mut connection) = self.inner.connection.lock() {
            if let Some(connection) = connection.take() {
                connection.close(reason);
            }
        }
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
}

fn app_server_request_timeout(method: &str) -> Option<Duration> {
    let seconds = match method {
        "model/list" | "thread/list" | "thread/read" | "thread/resume" | "thread/rollback"
        | "turn/steer" | "turn/interrupt" => 10,
        "thread/turns/list" => 5,
        "thread/start" | "thread/fork" | "turn/start" | "thread/compact/start" => 15,
        _ => return None,
    };
    Some(Duration::from_secs(seconds))
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
            AppServerEvent::Reconnected => {}
            AppServerEvent::Disconnected(reason) => {
                let _ = reason;
            }
            AppServerEvent::ManagementLog {
                source,
                channel,
                level,
                line,
            } => {
                let _ = (source, channel, level, line);
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
                connection.close("app-server runtime stopped");
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
                    let was_alive = alive.swap(false, Ordering::SeqCst);
                    drain_pending(&pending, error.clone());
                    if was_alive {
                        events.emit(AppServerEvent::Disconnected(error));
                    }
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
    events: AppServerEventSink,
) {
    thread::spawn(move || {
        while alive.load(Ordering::SeqCst) {
            let message = match writer_rx.recv() {
                Ok(message) => message,
                Err(_) => break,
            };
            if let Err(error) = writer.send_text(&message) {
                let was_alive = alive.swap(false, Ordering::SeqCst);
                drain_pending(&pending, error.clone());
                if was_alive {
                    events.emit(AppServerEvent::Disconnected(error));
                }
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

impl CodexCommandRunner for ProcessCodexCommandRunner {
    fn run(
        &self,
        command: &PathBuf,
        args: &[&str],
        codex_home: &PathBuf,
        timeout: Duration,
        on_line: &mut dyn FnMut(CodexCommandLine),
    ) -> Result<CodexCommandOutput, String> {
        let mut process = if let Ok(wrapper) = env::var("REMUX_WORKLOAD_EXEC") {
            let wrapper_path = PathBuf::from(&wrapper);
            if wrapper_path.components().count() > 1 && !wrapper_path.is_file() {
                return Err(format!(
                    "Remux workload launcher unavailable: {}",
                    wrapper_path.display(),
                ));
            }
            let operation = format!("codex-app-server:{}", args.join("-"));
            let mut process = Command::new(wrapper);
            process.args([
                "workload",
                "exec",
                "--workload",
                "app-server",
                "--operation",
                &operation,
                "--",
            ]);
            process.arg(command).args(args);
            process
        } else {
            let mut process = Command::new(command);
            process.args(args);
            process
        };
        let mut child = process
            .env("CODEX_HOME", codex_home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("spawn failed: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex command stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Codex command stderr unavailable".to_string())?;
        let (line_tx, line_rx) = mpsc::channel::<CodexCommandLine>();
        let stdout_reader =
            spawn_command_pipe_reader(stdout, CodexCommandChannel::Stdout, line_tx.clone());
        let stderr_reader =
            spawn_command_pipe_reader(stderr, CodexCommandChannel::Stderr, line_tx.clone());
        drop(line_tx);

        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut record_line = |entry: CodexCommandLine| {
            let output = match entry.channel {
                CodexCommandChannel::Stdout => &mut stdout,
                CodexCommandChannel::Stderr => &mut stderr,
            };
            output.push_str(&entry.line);
            output.push('\n');
            on_line(entry);
        };

        let deadline = Instant::now() + timeout;
        let status = loop {
            while let Ok(entry) = line_rx.try_recv() {
                record_line(entry);
            }
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(50));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(format!("command timed out after {}ms", timeout.as_millis()));
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(format!("command wait failed: {error}"));
                }
            }
        };
        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
        while let Ok(entry) = line_rx.try_recv() {
            record_line(entry);
        }
        let status = status?;
        if !status.success() {
            return Err(format!(
                "command exited code={}{}",
                status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                if stderr.trim().is_empty() {
                    String::new()
                } else {
                    format!(": {}", stderr.trim())
                }
            ));
        }
        Ok(CodexCommandOutput {
            stdout,
            #[cfg(test)]
            stderr,
        })
    }
}

fn spawn_command_pipe_reader(
    pipe: impl Read + Send + 'static,
    channel: CodexCommandChannel,
    sender: mpsc::Sender<CodexCommandLine>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in std::io::BufReader::new(pipe).lines().map_while(Result::ok) {
            if !line.trim().is_empty() && sender.send(CodexCommandLine { channel, line }).is_err() {
                break;
            }
        }
    })
}

fn parse_daemon_status(
    stdout: &str,
    last_error: Option<String>,
    fallback_socket_path: PathBuf,
) -> CodexAppServerStatus {
    let value = serde_json::from_str::<Value>(stdout.trim()).unwrap_or(Value::Null);
    let installed_version = value
        .get("cliVersion")
        .and_then(Value::as_str)
        .map(str::to_string);
    let running_version = value
        .get("appServerVersion")
        .and_then(Value::as_str)
        .map(str::to_string);
    let state = match value.get("status").and_then(Value::as_str) {
        Some("running") => "running",
        Some("starting") => "starting",
        Some("stopping") => "stopping",
        Some("failed") => "failed",
        _ => "stopped",
    }
    .to_string();
    CodexAppServerStatus {
        state,
        socket_path: value
            .get("socketPath")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| Some(fallback_socket_path.to_string_lossy().into_owned())),
        managed_codex_path: value
            .get("managedCodexPath")
            .and_then(Value::as_str)
            .map(str::to_string),
        restart_required: installed_version.is_some()
            && running_version.is_some()
            && installed_version != running_version,
        installed_version,
        running_version,
        last_error,
    }
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
    fn connect(path: PathBuf, timeout: Duration) -> Result<Self, String> {
        let mut stream = UnixStream::connect(&path)
            .map_err(|error| format!("failed to connect {}: {error}", path.display()))?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(timeout))
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
    use std::collections::VecDeque;

    #[derive(Debug)]
    struct MockCommandRunner {
        calls: Mutex<Vec<Vec<String>>>,
        outputs: Mutex<VecDeque<Result<CodexCommandOutput, String>>>,
    }

    impl MockCommandRunner {
        fn new(outputs: Vec<Result<CodexCommandOutput, String>>) -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                outputs: Mutex::new(outputs.into()),
            })
        }
    }

    impl CodexCommandRunner for MockCommandRunner {
        fn run(
            &self,
            _command: &PathBuf,
            args: &[&str],
            _codex_home: &PathBuf,
            _timeout: Duration,
            on_line: &mut dyn FnMut(CodexCommandLine),
        ) -> Result<CodexCommandOutput, String> {
            self.calls
                .lock()
                .unwrap()
                .push(args.iter().map(|arg| (*arg).to_string()).collect());
            let result = self
                .outputs
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err("missing mock output".to_string()));
            if let Ok(output) = &result {
                for line in output.stdout.lines().filter(|line| !line.trim().is_empty()) {
                    on_line(CodexCommandLine {
                        channel: CodexCommandChannel::Stdout,
                        line: line.to_string(),
                    });
                }
                for line in output.stderr.lines().filter(|line| !line.trim().is_empty()) {
                    on_line(CodexCommandLine {
                        channel: CodexCommandChannel::Stderr,
                        line: line.to_string(),
                    });
                }
            }
            result
        }
    }

    fn runtime_with_runner(
        runner: Arc<dyn CodexCommandRunner>,
        events: AppServerEventSink,
    ) -> AppServerRuntime {
        let runtime = AppServerRuntime::new_with_runner(
            PathBuf::from("/tmp/remux-codex-app-server-test-home"),
            events,
            runner,
        );
        *runtime.inner.codex_command.lock().unwrap() = Some(PathBuf::from("/fake/codex"));
        runtime
    }

    fn output(stdout: &str, stderr: &str) -> Result<CodexCommandOutput, String> {
        Ok(CodexCommandOutput {
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
        })
    }

    #[test]
    fn every_used_business_method_has_a_bounded_policy() {
        for method in [
            "model/list",
            "thread/list",
            "thread/read",
            "thread/turns/list",
            "thread/resume",
            "thread/start",
            "thread/rollback",
            "thread/fork",
            "turn/start",
            "turn/steer",
            "thread/compact/start",
            "turn/interrupt",
        ] {
            let timeout = app_server_request_timeout(method)
                .unwrap_or_else(|| panic!("missing policy for {method}"));
            assert!(timeout <= Duration::from_secs(15));
        }
        assert!(app_server_request_timeout("unknown/mutation").is_none());
    }

    #[test]
    fn daemon_status_parses_installed_and_running_versions() {
        let runner = MockCommandRunner::new(vec![output(
            r#"{"status":"running","managedCodexPath":"/managed/codex","socketPath":"/tmp/codex.sock","cliVersion":"0.145.0","appServerVersion":"0.144.0"}"#,
            "",
        )]);
        let runtime = runtime_with_runner(runner.clone(), AppServerEventSink::default());

        let status = runtime.daemon_status();

        assert_eq!(status.state, "running");
        assert_eq!(status.installed_version.as_deref(), Some("0.145.0"));
        assert_eq!(status.running_version.as_deref(), Some("0.144.0"));
        assert!(status.restart_required);
        assert_eq!(
            runner.calls.lock().unwrap().as_slice(),
            &[vec![
                "app-server".to_string(),
                "daemon".to_string(),
                "version".to_string()
            ]]
        );
    }

    #[test]
    fn update_never_restarts_and_emits_typed_output() {
        let runner = MockCommandRunner::new(vec![
            output("installed 0.145.0\n", "download warning\n"),
            output(
                r#"{"status":"running","cliVersion":"0.145.0","appServerVersion":"0.144.0"}"#,
                "",
            ),
        ]);
        let (events, receiver) = AppServerEventSink::channel();
        let runtime = runtime_with_runner(runner.clone(), events);

        let status = runtime.update_codex().unwrap();

        assert!(status.restart_required);
        let calls = runner.calls.lock().unwrap().clone();
        assert_eq!(calls[0], vec!["update"]);
        assert_eq!(calls[1], vec!["app-server", "daemon", "version"]);
        assert!(
            !calls
                .iter()
                .any(|call| call.contains(&"restart".to_string()))
        );
        let events = receiver.try_iter().collect::<Vec<_>>();
        assert!(events.iter().any(|event| matches!(
            event,
            AppServerEvent::ManagementLog {
                source: "update",
                channel: Some("stdout"),
                line,
                ..
            } if line == "installed 0.145.0"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            AppServerEvent::ManagementLog {
                source: "update",
                channel: Some("stderr"),
                line,
                ..
            } if line == "download warning"
        )));
        let output_index = events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    AppServerEvent::ManagementLog {
                        source: "update",
                        channel: Some("stdout"),
                        line,
                        ..
                    } if line == "installed 0.145.0"
                )
            })
            .unwrap();
        let completed_index = events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    AppServerEvent::ManagementLog {
                        source: "update",
                        channel: None,
                        line,
                        ..
                    } if line == "update completed"
                )
            })
            .unwrap();
        assert!(output_index < completed_index);
    }

    #[test]
    fn executed_management_failure_is_not_retried_with_another_binary() {
        let runner = MockCommandRunner::new(vec![
            Err("command exited code=1: update failed".to_string()),
            output("unexpected retry", ""),
        ]);
        let runtime = AppServerRuntime::new_with_runner(
            PathBuf::from("/tmp/remux-codex-app-server-test-home"),
            AppServerEventSink::default(),
            runner.clone(),
        );

        assert!(runtime.update_codex().is_err());
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn unavailable_workload_launcher_is_reported_once_without_blame_on_codex() {
        let runner = MockCommandRunner::new(vec![
            Err("Remux workload launcher unavailable: /tmp/remux (deleted)".to_string()),
            output("unexpected retry", ""),
        ]);
        let runtime = AppServerRuntime::new_with_runner(
            PathBuf::from("/tmp/remux-codex-app-server-test-home"),
            AppServerEventSink::default(),
            runner.clone(),
        );

        let error = runtime.update_codex().unwrap_err();
        assert_eq!(
            error,
            "Remux workload launcher unavailable: /tmp/remux (deleted)"
        );
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn dropping_runtime_does_not_run_daemon_stop() {
        let runner = MockCommandRunner::new(Vec::new());
        let runtime = runtime_with_runner(runner.clone(), AppServerEventSink::default());
        drop(runtime);
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn lazy_start_uses_daemon_manager_not_foreground_listen() {
        let runner = MockCommandRunner::new(vec![output("", "")]);
        let runtime = runtime_with_runner(runner.clone(), AppServerEventSink::default());

        runtime.start_app_server().unwrap();

        assert_eq!(
            runner.calls.lock().unwrap().as_slice(),
            &[vec![
                "app-server".to_string(),
                "daemon".to_string(),
                "start".to_string()
            ]]
        );
    }

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
