//! L2 extension supervision: one actor task per extension owning the child
//! process and a command mailbox. Replaces `cli/extensionProcess.cjs` and
//! removes the `ctx.fatal` escalation entirely — nothing an extension does
//! can terminate the runtime.
//!
//! State machine (spec §L2):
//!
//! ```text
//! Stopped ──start──▶ Starting ──spawned──▶ Running
//! Running ──stop──▶ Stopping ──reaped──▶ Stopped
//! Running ──exit code 0 (unprompted)──▶ Stopped
//! Running ──crash──▶ BackingOff{n} ──delay──▶ Starting
//! BackingOff: 5 crashes in 60s ──▶ Failed
//! Failed ──manual start──▶ Starting
//! ```

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use tokio::sync::{mpsc, oneshot};

use crate::extensions::manifest::ExtensionManifest;
use crate::extensions::process::{
    exit_parts, read_lines, send_sigterm, spawn_extension, SpawnedChild, StdinCommand,
};
use crate::logs::{ExtensionLogs, Journal, JournalEvent};
use crate::rpc::jsonrpc::{JsonRpcError, EXTENSION_ERROR};
use crate::rpc::router::{BoxFuture, ExtensionServer, LastExit, RpcResult, ServerStatus};
use crate::time::now_ms;

pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 300_000;
pub const BACKOFF_BASE_MS: u64 = 500;
pub const BACKOFF_CAP_MS: u64 = 10_000;
pub const CRASH_BUDGET: usize = 5;
pub const CRASH_WINDOW_MS: u64 = 60_000;
pub const STOP_EOF_WAIT_MS: u64 = 2_000;
pub const STOP_TERM_WAIT_MS: u64 = 2_000;

pub const DID_CHANGE_STATUS_METHOD: &str = "remux/extensions/didChangeStatus";
const REMUX_NOTIFICATION_METHOD_PREFIX: &str = "remux/notifications/";

/// What the supervisor needs from the runtime: client broadcast and the
/// notification manager's first-refusal hook.
pub trait ExtensionCtx: Send + Sync {
    fn broadcast(&self, message: Value);
    fn handle_extension_notification(&self, message: Value) -> BoxFuture<'_, bool>;
}

#[derive(Debug, Clone, Copy)]
pub struct SupervisorConfig {
    pub request_timeout_ms: u64,
    pub backoff_base_ms: u64,
    pub backoff_cap_ms: u64,
    pub crash_budget: usize,
    pub crash_window_ms: u64,
    pub stop_eof_wait_ms: u64,
    pub stop_term_wait_ms: u64,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            backoff_base_ms: BACKOFF_BASE_MS,
            backoff_cap_ms: BACKOFF_CAP_MS,
            crash_budget: CRASH_BUDGET,
            crash_window_ms: CRASH_WINDOW_MS,
            stop_eof_wait_ms: STOP_EOF_WAIT_MS,
            stop_term_wait_ms: STOP_TERM_WAIT_MS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    Stopped,
    Starting,
    Running,
    Stopping,
    BackingOff,
    Failed,
}

impl Lifecycle {
    fn name(self) -> &'static str {
        match self {
            Lifecycle::Stopped => "stopped",
            Lifecycle::Starting => "starting",
            Lifecycle::Running => "running",
            Lifecycle::Stopping => "stopping",
            Lifecycle::BackingOff => "backingOff",
            Lifecycle::Failed => "failed",
        }
    }
}

struct PendingRpc {
    method: String,
    ack: oneshot::Sender<RpcResult>,
}

type PendingMap = Arc<Mutex<HashMap<u64, PendingRpc>>>;

enum Cmd {
    Start(oneshot::Sender<ServerStatus>),
    Stop(oneshot::Sender<ServerStatus>),
    Restart(oneshot::Sender<ServerStatus>),
    Rpc {
        method: String,
        params: Option<Value>,
        ack: oneshot::Sender<RpcResult>,
    },
    Notify {
        method: String,
        params: Option<Value>,
    },
}

pub struct ExtensionSupervisor {
    extension_id: String,
    commands: mpsc::UnboundedSender<Cmd>,
    status: Arc<Mutex<ServerStatus>>,
    logs: Arc<ExtensionLogs>,
}

impl ExtensionSupervisor {
    /// Spawns the actor task. The returned join handle is wrapped in
    /// `spawn_supervised` by the runtime — the actor dying unexpectedly is a
    /// worker-fatal condition (exit 75).
    pub fn spawn(
        extension: ExtensionManifest,
        cfg: SupervisorConfig,
        ctx: Arc<dyn ExtensionCtx>,
        journal: Arc<Journal>,
        logs: Arc<ExtensionLogs>,
    ) -> (Arc<Self>, tokio::task::JoinHandle<()>) {
        let status = Arc::new(Mutex::new(ServerStatus {
            restartable: true,
            running: false,
            state: Lifecycle::Stopped.name().to_string(),
            pid: None,
            started_at_ms: None,
            restart_count: 0,
            last_exit: None,
        }));
        let (commands, mailbox) = mpsc::unbounded_channel();

        let supervisor = Arc::new(Self {
            extension_id: extension.id.clone(),
            commands,
            status: status.clone(),
            logs: logs.clone(),
        });

        let actor = Actor {
            extension,
            cfg,
            ctx,
            journal,
            logs,
            status,
            pending: Arc::new(Mutex::new(HashMap::new())),
            generation: Arc::new(AtomicU64::new(0)),
            state: Lifecycle::Stopped,
            child: None,
            stdin: None,
            pid: None,
            started_at_ms: None,
            restart_count: 0,
            last_exit: None,
            crash_times: VecDeque::new(),
            backoff_deadline: None,
            next_rpc_id: 1,
        };
        let handle = tokio::spawn(actor.run(mailbox));

        (supervisor, handle)
    }

    fn snapshot(&self) -> ServerStatus {
        self.status.lock().unwrap().clone()
    }

    async fn command_status(
        &self,
        make: impl FnOnce(oneshot::Sender<ServerStatus>) -> Cmd,
    ) -> ServerStatus {
        let (ack, response) = oneshot::channel();
        if self.commands.send(make(ack)).is_err() {
            return self.snapshot();
        }
        response.await.unwrap_or_else(|_| self.snapshot())
    }
}

impl ExtensionServer for ExtensionSupervisor {
    fn start(&self) -> BoxFuture<'_, ServerStatus> {
        Box::pin(self.command_status(Cmd::Start))
    }

    fn stop(&self) -> BoxFuture<'_, ServerStatus> {
        Box::pin(self.command_status(Cmd::Stop))
    }

    fn restart(&self) -> BoxFuture<'_, ServerStatus> {
        Box::pin(self.command_status(Cmd::Restart))
    }

    fn handle_rpc(&self, method: String, params: Option<Value>) -> BoxFuture<'_, RpcResult> {
        Box::pin(async move {
            let (ack, response) = oneshot::channel();
            if self
                .commands
                .send(Cmd::Rpc { method, params, ack })
                .is_err()
            {
                return Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("extension {} is not running", self.extension_id),
                ));
            }
            response.await.unwrap_or_else(|_| {
                Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("extension {} is not running", self.extension_id),
                ))
            })
        })
    }

    fn handle_notification(&self, method: String, params: Option<Value>) {
        let _ = self.commands.send(Cmd::Notify { method, params });
    }

    fn status(&self) -> ServerStatus {
        self.snapshot()
    }

    fn logs(&self, lines: usize) -> Value {
        self.logs.snapshot(&self.extension_id, lines)
    }
}

struct Actor {
    extension: ExtensionManifest,
    cfg: SupervisorConfig,
    ctx: Arc<dyn ExtensionCtx>,
    journal: Arc<Journal>,
    logs: Arc<ExtensionLogs>,
    status: Arc<Mutex<ServerStatus>>,
    pending: PendingMap,
    generation: Arc<AtomicU64>,
    state: Lifecycle,
    child: Option<tokio::process::Child>,
    stdin: Option<mpsc::UnboundedSender<StdinCommand>>,
    pid: Option<u32>,
    started_at_ms: Option<i64>,
    restart_count: u32,
    last_exit: Option<LastExit>,
    crash_times: VecDeque<std::time::Instant>,
    backoff_deadline: Option<tokio::time::Instant>,
    next_rpc_id: u64,
}

impl Actor {
    async fn run(mut self, mut mailbox: mpsc::UnboundedReceiver<Cmd>) {
        loop {
            let backoff_deadline = self.backoff_deadline;
            tokio::select! {
                command = mailbox.recv() => {
                    match command {
                        Some(command) => self.handle_command(command).await,
                        None => break,
                    }
                }
                status = async { self.child.as_mut().expect("guarded").wait().await },
                    if self.child.is_some() =>
                {
                    self.handle_unprompted_exit(status.ok()).await;
                }
                _ = tokio::time::sleep_until(backoff_deadline.unwrap_or_else(tokio::time::Instant::now)),
                    if backoff_deadline.is_some() =>
                {
                    self.backoff_deadline = None;
                    self.restart_count += 1;
                    self.spawn_child();
                }
            }
        }

        // Mailbox closed: runtime shutdown path stops extensions explicitly;
        // kill_on_drop covers anything still alive.
    }

    async fn handle_command(&mut self, command: Cmd) {
        match command {
            Cmd::Start(ack) => {
                match self.state {
                    // Idempotent when already up (extensionProcess.cjs:19-23).
                    Lifecycle::Running | Lifecycle::Starting => {}
                    _ => {
                        self.backoff_deadline = None;
                        self.spawn_child();
                    }
                }
                let _ = ack.send(self.current_status());
            }
            Cmd::Stop(ack) => {
                self.journal_lifecycle("extension:stop", None, "info");
                self.stop_child().await;
                let _ = ack.send(self.current_status());
            }
            Cmd::Restart(ack) => {
                self.journal_lifecycle("extension:restart", None, "info");
                self.journal_lifecycle("extension:stop", None, "info");
                self.stop_child().await;
                self.spawn_child();
                let _ = ack.send(self.current_status());
            }
            Cmd::Rpc { method, params, ack } => self.handle_rpc(method, params, ack),
            Cmd::Notify { method, params } => self.handle_notify(method, params),
        }
    }

    fn handle_rpc(&mut self, method: String, params: Option<Value>, ack: oneshot::Sender<RpcResult>) {
        let stdin = match (&self.stdin, self.state) {
            (Some(stdin), Lifecycle::Running) => stdin.clone(),
            _ => {
                let _ = ack.send(Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("extension {} is not running", self.extension.id),
                )));
                return;
            }
        };

        let id = self.next_rpc_id;
        self.next_rpc_id += 1;

        let mut message = Map::new();
        message.insert("jsonrpc".to_string(), Value::from("2.0"));
        message.insert("id".to_string(), Value::from(id));
        message.insert("method".to_string(), Value::from(method.clone()));
        if let Some(params) = params {
            message.insert("params".to_string(), params);
        }

        self.pending
            .lock()
            .unwrap()
            .insert(id, PendingRpc { method: method.clone(), ack });

        // Timeout: reject with the same -32000 "<method> timed out".
        let pending = self.pending.clone();
        let timeout_ms = self.cfg.request_timeout_ms;
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)).await;
            if let Some(entry) = pending.lock().unwrap().remove(&id) {
                let _ = entry.ack.send(Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("{method} timed out"),
                )));
            }
        });

        let line = format!("{}\n", Value::Object(message));
        let _ = stdin.send(StdinCommand::Line(line));
    }

    fn handle_notify(&mut self, method: String, params: Option<Value>) {
        let Some(stdin) = self.stdin.as_ref().filter(|_| self.state == Lifecycle::Running)
        else {
            return;
        };
        let mut message = Map::new();
        message.insert("jsonrpc".to_string(), Value::from("2.0"));
        message.insert("method".to_string(), Value::from(method));
        if let Some(params) = params {
            message.insert("params".to_string(), params);
        }
        let _ = stdin.send(StdinCommand::Line(format!("{}\n", Value::Object(message))));
    }

    fn spawn_child(&mut self) {
        let Some(server) = self.extension.server.clone() else {
            return;
        };

        self.set_state(Lifecycle::Starting);
        self.journal_lifecycle(
            "extension:start",
            Some(serde_json::json!({
                "args": server.args,
                "command": server.command,
                "cwd": server.cwd.to_string_lossy(),
            })),
            "info",
        );
        self.logs
            .append(&self.extension.id, "lifecycle", "starting");

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;

        let journal = self.journal.clone();
        let extension_id = self.extension.id.clone();
        let spawned = spawn_extension(&server, move |error| {
            journal.warn(&format!(
                "[remux] failed to write to extension {extension_id}: {error}"
            ));
        });

        match spawned {
            Ok(SpawnedChild {
                child,
                pid,
                stdin,
                stdout,
                stderr,
            }) => {
                self.child = Some(child);
                self.stdin = Some(stdin);
                self.pid = Some(pid);
                self.started_at_ms = Some(now_ms());
                self.spawn_stdout_reader(stdout, generation);
                self.spawn_stderr_reader(stderr, generation);
                self.set_state(Lifecycle::Running);
            }
            Err(error) => {
                // Spawn failure counts as a crash — BackingOff (or Failed on
                // budget), never runtime-fatal (was: fatal).
                self.journal_lifecycle(
                    "extension:error",
                    Some(serde_json::json!({ "message": error.to_string() })),
                    "error",
                );
                self.logs.append(
                    &self.extension.id,
                    "lifecycle",
                    &format!("spawn failed: {error}"),
                );
                self.record_crash();
            }
        }
    }

    async fn handle_unprompted_exit(&mut self, status: Option<std::process::ExitStatus>) {
        let (code, signal) = status.map(exit_parts).unwrap_or((None, None));
        let clean = signal.is_none() && code.unwrap_or(0) == 0;
        self.journal_lifecycle(
            "extension:exit",
            Some(serde_json::json!({ "code": code, "signal": signal, "stopping": false })),
            if clean { "info" } else { "error" },
        );
        self.logs.append(
            &self.extension.id,
            "lifecycle",
            &format!("exited code={code:?} signal={signal:?}"),
        );

        self.reject_pending(&format!("extension {} exited", self.extension.id));
        self.child = None;
        self.stdin = None;
        self.pid = None;
        self.started_at_ms = None;
        self.last_exit = Some(LastExit {
            code,
            signal,
            at: now_ms(),
        });
        self.generation.fetch_add(1, Ordering::SeqCst);

        if clean {
            // Unprompted clean exit -> Stopped, no restart (spec: behavior
            // change #4 — was a silent not-running).
            self.set_state(Lifecycle::Stopped);
            return;
        }
        self.record_crash();
    }

    fn record_crash(&mut self) {
        let now = std::time::Instant::now();
        let window = std::time::Duration::from_millis(self.cfg.crash_window_ms);
        self.crash_times.push_back(now);
        while let Some(first) = self.crash_times.front() {
            if now.duration_since(*first) > window {
                self.crash_times.pop_front();
            } else {
                break;
            }
        }

        let crashes = self.crash_times.len();
        if crashes >= self.cfg.crash_budget {
            let tail = self.logs.snapshot(&self.extension.id, 10);
            self.journal_lifecycle(
                "extension:failed",
                Some(serde_json::json!({
                    "crashes": crashes,
                    "windowMs": self.cfg.crash_window_ms,
                    "stderrTail": tail,
                })),
                "error",
            );
            self.logs.append(
                &self.extension.id,
                "lifecycle",
                &format!("failed: crash budget exceeded ({crashes} crashes)"),
            );
            self.backoff_deadline = None;
            self.crash_times.clear();
            self.set_state(Lifecycle::Failed);
            return;
        }

        let exponent = crashes.saturating_sub(1).min(10) as u32;
        let delay_ms = self
            .cfg
            .backoff_cap_ms
            .min(self.cfg.backoff_base_ms.saturating_mul(1 << exponent));
        self.journal_lifecycle(
            "extension:backoff",
            Some(serde_json::json!({ "crashes": crashes, "delayMs": delay_ms })),
            "warn",
        );
        self.backoff_deadline =
            Some(tokio::time::Instant::now() + std::time::Duration::from_millis(delay_ms));
        self.set_state(Lifecycle::BackingOff);
    }

    /// EOF → SIGTERM → SIGKILL with confirmed reap. Returns only after the
    /// direct child is gone, so restart can never overlap two instances and
    /// the reported status is truthful.
    async fn stop_child(&mut self) {
        self.backoff_deadline = None;
        self.reject_pending(&format!("extension {} stopped", self.extension.id));

        // Close the stdin channel and drop ChildStdin -> the extension sees
        // EOF. With `cargo run`, stdin passes through to the binary, so EOF
        // reaches the grandchild — which SIGTERM to cargo does not.
        if let Some(stdin) = self.stdin.take() {
            let _ = stdin.send(StdinCommand::Close);
        }

        let Some(mut child) = self.child.take() else {
            self.pid = None;
            self.started_at_ms = None;
            self.set_state(Lifecycle::Stopped);
            return;
        };
        self.set_state(Lifecycle::Stopping);
        self.logs.append(&self.extension.id, "lifecycle", "stopping");

        let eof_wait = std::time::Duration::from_millis(self.cfg.stop_eof_wait_ms);
        let term_wait = std::time::Duration::from_millis(self.cfg.stop_term_wait_ms);

        let status = match tokio::time::timeout(eof_wait, child.wait()).await {
            Ok(status) => status.ok(),
            Err(_) => {
                if let Some(pid) = self.pid {
                    send_sigterm(pid);
                }
                match tokio::time::timeout(term_wait, child.wait()).await {
                    Ok(status) => status.ok(),
                    Err(_) => {
                        let _ = child.start_kill();
                        child.wait().await.ok()
                    }
                }
            }
        };

        let (code, signal) = status.map(exit_parts).unwrap_or((None, None));
        self.journal_lifecycle(
            "extension:exit",
            Some(serde_json::json!({ "code": code, "signal": signal, "stopping": true })),
            "info",
        );
        self.logs.append(
            &self.extension.id,
            "lifecycle",
            &format!("stopped code={code:?} signal={signal:?}"),
        );
        self.last_exit = Some(LastExit {
            code,
            signal,
            at: now_ms(),
        });
        self.pid = None;
        self.started_at_ms = None;
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.set_state(Lifecycle::Stopped);
    }

    fn spawn_stdout_reader(&self, stdout: tokio::process::ChildStdout, generation: u64) {
        let pending = self.pending.clone();
        let generations = self.generation.clone();
        let ctx = self.ctx.clone();
        let journal = self.journal.clone();
        let extension_id = self.extension.id.clone();

        tokio::spawn(async move {
            let (line_tx, mut line_rx) = mpsc::unbounded_channel::<String>();
            let reader = tokio::spawn(async move {
                read_lines(stdout, move |line| {
                    let _ = line_tx.send(line);
                })
                .await;
            });

            while let Some(line) = line_rx.recv().await {
                if generations.load(Ordering::SeqCst) != generation {
                    break;
                }
                handle_protocol_line(&line, &extension_id, &pending, &ctx, &journal).await;
            }
            let _ = reader.await;
        });
    }

    fn spawn_stderr_reader(&self, stderr: tokio::process::ChildStderr, generation: u64) {
        let logs = self.logs.clone();
        let generations = self.generation.clone();
        let extension_id = self.extension.id.clone();

        tokio::spawn(async move {
            read_lines(stderr, move |line| {
                if line.trim().is_empty() {
                    return;
                }
                if generations.load(Ordering::SeqCst) != generation {
                    return;
                }
                logs.append(&extension_id, "stderr", &line);
            })
            .await;
        });
    }

    fn reject_pending(&self, message: &str) {
        let entries: Vec<PendingRpc> = {
            let mut pending = self.pending.lock().unwrap();
            pending.drain().map(|(_, entry)| entry).collect()
        };
        for entry in entries {
            let _ = entry
                .ack
                .send(Err(JsonRpcError::new(EXTENSION_ERROR, message)));
        }
    }

    fn current_status(&self) -> ServerStatus {
        ServerStatus {
            restartable: true,
            running: self.state == Lifecycle::Running,
            state: self.state.name().to_string(),
            pid: self.pid,
            started_at_ms: self.started_at_ms,
            restart_count: self.restart_count,
            last_exit: self.last_exit.clone(),
        }
    }

    fn set_state(&mut self, state: Lifecycle) {
        self.state = state;
        let status = self.current_status();
        *self.status.lock().unwrap() = status.clone();

        let mut params = Map::new();
        params.insert(
            "extensionId".to_string(),
            Value::from(self.extension.id.clone()),
        );
        status.append_to(&mut params);
        self.ctx.broadcast(serde_json::json!({
            "method": DID_CHANGE_STATUS_METHOD,
            "params": params,
        }));
    }

    fn journal_lifecycle(&self, label: &str, detail: Option<Value>, level: &'static str) {
        self.journal.event(JournalEvent {
            detail,
            label: Some(label.to_string()),
            level,
            source: format!("extension:{}", self.extension.id),
            ..Default::default()
        });
    }
}

async fn handle_protocol_line(
    line: &str,
    extension_id: &str,
    pending: &PendingMap,
    ctx: &Arc<dyn ExtensionCtx>,
    journal: &Arc<Journal>,
) {
    if line.trim().is_empty() {
        return;
    }

    let message: Value = match serde_json::from_str(line) {
        Ok(message) => message,
        Err(_) => {
            journal.warn(&format!(
                "[remux] ignored invalid protocol line from extension {extension_id}"
            ));
            return;
        }
    };

    if is_extension_response(&message) {
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return;
        };
        let Some(entry) = pending.lock().unwrap().remove(&id) else {
            return;
        };
        match message.get("error") {
            Some(error) if !error.is_null() => {
                let _ = entry.ack.send(Err(error_from_response(error, &entry.method)));
            }
            _ => {
                let _ = entry
                    .ack
                    .send(Ok(message.get("result").cloned().unwrap_or(Value::Null)));
            }
        }
        return;
    }

    if message.get("method").and_then(Value::as_str).is_some() {
        let normalized = normalize_extension_notification(message, extension_id);
        let method = normalized
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if method.starts_with(REMUX_NOTIFICATION_METHOD_PREFIX) {
            // Offer to the notification manager first; broadcast only when
            // unhandled.
            let handled = ctx.handle_extension_notification(normalized.clone()).await;
            if !handled {
                ctx.broadcast(normalized);
            }
            return;
        }
        ctx.broadcast(normalized);
    }
}

fn is_extension_response(message: &Value) -> bool {
    let Some(record) = message.as_object() else {
        return false;
    };
    let id_ok = record
        .get("id")
        .map(|id| id.is_string() || id.is_number())
        .unwrap_or(false);
    id_ok
        && !record.get("method").map(Value::is_string).unwrap_or(false)
        && (record.contains_key("result") || record.contains_key("error"))
}

fn error_from_response(error: &Value, method: &str) -> JsonRpcError {
    let code = error.get("code").and_then(Value::as_i64).unwrap_or(EXTENSION_ERROR);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Unknown JSON-RPC error");
    JsonRpcError {
        code,
        message: format!("{method} failed: {message}"),
        data: error.get("data").cloned(),
    }
}

/// `remux/notifications/*` methods get `extensionId` injected into params
/// (`normalizeExtensionNotification`, `extensionProcess.cjs:266-278`).
pub fn normalize_extension_notification(message: Value, extension_id: &str) -> Value {
    let method_is_notification = message
        .get("method")
        .and_then(Value::as_str)
        .map(|method| method.starts_with(REMUX_NOTIFICATION_METHOD_PREFIX))
        .unwrap_or(false);
    if !method_is_notification {
        return message;
    }

    match message {
        Value::Object(mut record) => {
            let mut params = match record.remove("params") {
                Some(Value::Object(params)) => params,
                _ => Map::new(),
            };
            params.insert("extensionId".to_string(), Value::from(extension_id));
            record.insert("params".to_string(), Value::Object(params));
            Value::Object(record)
        }
        other => other,
    }
}
