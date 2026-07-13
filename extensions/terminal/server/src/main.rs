use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child as StdChild, ChildStdin, Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
const SESSION_READY_METHOD: &str = "remux/terminal/session/ready";
const SESSION_DETACH_METHOD: &str = "remux/terminal/session/detach";
const SESSION_REPLAY_READ_METHOD: &str = "remux/terminal/session/replay/read";
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
const MAX_ATTACH_REPLAY_BYTES: usize = 256 * 1024;
const MAX_READY_CATCHUP_BYTES: usize = 256 * 1024;
const MAX_INPUT_CHUNK_BYTES: usize = 64 * 1024;
const SESSION_INPUT_QUEUE_CAPACITY: usize = 128;
const MAX_INPUT_STREAMS: usize = 8;
const MAX_SESSION_SUBSCRIPTIONS: usize = 8;
const INPUT_STREAM_RECONNECT_LEASE: Duration = Duration::from_secs(2 * 60);
const TERMINAL_OUTPUT_QUEUE_CAPACITY: usize = 256;
// PTY read sizing and burst coalescing. A single read already returns everything
// currently buffered (up to the buffer size), so reading large keeps the syscall
// count down. The coalescer then merges a burst of reads triggered by one
// keystroke (tab-completion, line rewrap, command output) into a single frame so
// it crosses the wire as one packet instead of a flurry.
const READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_COALESCED_BYTES: usize = 64 * 1024;
const OUTPUT_COALESCE_WINDOW: Duration = Duration::from_millis(3);
const MAX_NOTIFICATION_OSC_BYTES: usize = 16 * 1024;
const MAX_PENDING_KITTY_NOTIFICATIONS: usize = 64;
const NOTIFICATION_TITLE_MAX_CHARS: usize = 120;
const NOTIFICATION_BODY_MAX_CHARS: usize = 240;
const BELL_NOTIFICATION_MIN_INTERVAL_MS: u64 = 10_000;
const DUPLICATE_NOTIFICATION_MIN_INTERVAL_MS: u64 = 2_000;
const SHELL_INTEGRATION_ENV: &str = "REMUX_TERMINAL_SHELL_INTEGRATION";
const TMUX_CONTEXT_CACHE_FRESH_MS: u64 = 1_000;
const HEADLESS_STATE_QUEUE_CAPACITY: usize = 1_024;
const HEADLESS_STATE_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const HEADLESS_STABLE_UPTIME: Duration = Duration::from_secs(5);
const HEADLESS_MAX_RESTART_BACKOFF: Duration = Duration::from_secs(8);

fn main() {
    if let Err(error) = run_stdio_server() {
        eprintln!("server failed: {error}");
        std::process::exit(1);
    }
}

fn run_stdio_server() -> Result<(), String> {
    let stdin = io::stdin();
    let (output_tx, output_rx) = mpsc::sync_channel::<Value>(TERMINAL_OUTPUT_QUEUE_CAPACITY);
    spawn_stdout_writer(output_rx);
    let server = TerminalExtensionServer::new(output_tx.clone());

    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<JsonRpcEnvelope>(&line) {
            Ok(envelope) => {
                let request_server = server.clone();
                let request_output = output_tx.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_envelope(&request_server, envelope, &request_output)
                    {
                        eprintln!("failed to handle terminal protocol frame: {error}");
                    }
                });
            }
            Err(error) => {
                eprintln!("ignored invalid terminal protocol frame: {error}");
            }
        }
    }

    server.kill_all();
    Ok(())
}

fn handle_envelope(
    server: &TerminalExtensionServer,
    envelope: JsonRpcEnvelope,
    output_tx: &mpsc::SyncSender<Value>,
) -> Result<(), String> {
    let JsonRpcEnvelope { id, method, params } = envelope;
    if method == TMUX_ACTION_METHOD {
        match server.spawn_tmux_action(params.unwrap_or(Value::Null), id.clone(), output_tx.clone())
        {
            Ok(()) => return Ok(()),
            Err(error) => {
                respond_or_log(id, Err(JsonRpcError::new(-32000, error)), output_tx)?;
                return Ok(());
            }
        }
    }

    let result = handle_request(server, JsonRpcRequest { method, params });
    if let Some(id) = id {
        match result {
            Ok(value) => {
                send_jsonrpc_response(output_tx, JsonRpcResponse::result(id, value))?;
            }
            Err(error) => {
                send_jsonrpc_response(output_tx, JsonRpcResponse::error(id, error))?;
            }
        }
    } else if let Err(error) = result {
        eprintln!("ignored terminal notification error: {}", error.message);
    }

    Ok(())
}

fn handle_request(
    server: &TerminalExtensionServer,
    request: JsonRpcRequest,
) -> Result<Value, JsonRpcError> {
    let result = match request.method.as_str() {
        SESSION_LIST_METHOD => server.list_sessions().map_err(internal_rpc_error),
        SESSION_START_METHOD => server
            .start_session(request.params.unwrap_or(Value::Null))
            .map_err(internal_rpc_error),
        SESSION_ATTACH_METHOD => server
            .attach_session(request.params.unwrap_or(Value::Null))
            .map_err(internal_rpc_error),
        SESSION_READY_METHOD => server
            .ready_session(request.params.unwrap_or(Value::Null))
            .map_err(internal_rpc_error),
        SESSION_DETACH_METHOD => server
            .detach_session(request.params.unwrap_or(Value::Null))
            .map_err(internal_rpc_error),
        SESSION_REPLAY_READ_METHOD => server
            .read_replay(request.params.unwrap_or(Value::Null))
            .map_err(internal_rpc_error),
        SESSION_WRITE_METHOD => server
            .write_session(request.params.unwrap_or(Value::Null))
            .map_err(internal_rpc_error),
        SESSION_RESIZE_METHOD => server
            .resize_session(request.params.unwrap_or(Value::Null))
            .map_err(internal_rpc_error),
        SESSION_KILL_METHOD => server
            .kill_session(request.params.unwrap_or(Value::Null))
            .map_err(internal_rpc_error),
        TMUX_CONTEXT_GET_METHOD => server
            .tmux_context(request.params.unwrap_or(Value::Null))
            .map_err(internal_rpc_error),
        TMUX_ACTION_METHOD => Err(internal_rpc_error(
            "tmux action requests are handled asynchronously".to_string(),
        )),
        _ => {
            return Err(JsonRpcError::new(
                -32601,
                format!("Unknown method: {}", request.method),
            ));
        }
    };

    result
}

fn respond_or_log(
    id: Option<Value>,
    result: Result<Value, JsonRpcError>,
    output_tx: &mpsc::SyncSender<Value>,
) -> Result<(), String> {
    match id {
        Some(id) => {
            let response = match result {
                Ok(value) => JsonRpcResponse::result(id, value),
                Err(error) => JsonRpcResponse::error(id, error),
            };
            send_jsonrpc_response(output_tx, response)
        }
        None => {
            if let Err(error) = result {
                eprintln!("ignored terminal notification error: {}", error.message);
            }
            Ok(())
        }
    }
}

fn internal_rpc_error(message: String) -> JsonRpcError {
    JsonRpcError::new(-32000, message)
}

fn send_jsonrpc_response(
    output_tx: &mpsc::SyncSender<Value>,
    response: JsonRpcResponse,
) -> Result<(), String> {
    let response = serde_json::to_value(response).map_err(|error| error.to_string())?;
    output_tx
        .send(response)
        .map_err(|error| format!("failed to write response: {error}"))
}

#[derive(Clone)]
struct HeadlessStateWorker {
    desynced: Arc<AtomicBool>,
    next_request_id: Arc<AtomicU64>,
    pending: HeadlessPendingRequests,
    tx: mpsc::SyncSender<HeadlessWorkerCommand>,
}

struct HeadlessPendingRequest {
    sender: mpsc::Sender<Result<Value, String>>,
    worker_epoch: u64,
}

type HeadlessPendingRequests = Arc<Mutex<HashMap<u64, HeadlessPendingRequest>>>;
type HeadlessCheckpoints = Arc<Mutex<HashMap<String, Value>>>;

enum HeadlessWorkerCommand {
    Message(Value),
    Restart,
}

struct HeadlessWorkerProcess {
    child: StdChild,
    epoch: u64,
    started_at: Instant,
    stdin: ChildStdin,
}

struct HeadlessJournalEvent {
    byte_len: usize,
    message: Value,
    position: u64,
}

struct HeadlessSessionJournal {
    complete: bool,
    create: Value,
    events: VecDeque<HeadlessJournalEvent>,
    next_position: u64,
    output_bytes: usize,
}

#[derive(Debug)]
struct HeadlessSnapshot {
    cols: u16,
    data_base64: String,
    encoding: String,
    rows: u16,
    through_seq: u64,
}

impl HeadlessStateWorker {
    fn spawn() -> Result<Self, String> {
        if cfg!(test) {
            return Err("disabled in tests".to_string());
        }

        let worker_path = terminal_extension_root().join("state-worker/dist/main.mjs");
        if !worker_path.is_file() {
            return Err(format!(
                "state worker bundle is missing: {}",
                worker_path.display()
            ));
        }

        let pending = Arc::new(Mutex::new(HashMap::<u64, HeadlessPendingRequest>::new()));
        let checkpoints = Arc::new(Mutex::new(HashMap::new()));
        let desynced = Arc::new(AtomicBool::new(false));
        let next_worker_epoch = Arc::new(AtomicU64::new(1));
        let initial_process = spawn_headless_worker_process(
            &worker_path,
            pending.clone(),
            checkpoints.clone(),
            next_worker_epoch.fetch_add(1, Ordering::Relaxed),
        )?;
        let (tx, rx) = mpsc::sync_channel::<HeadlessWorkerCommand>(HEADLESS_STATE_QUEUE_CAPACITY);
        let manager_pending = pending.clone();
        let manager_desynced = desynced.clone();
        let manager_next_worker_epoch = next_worker_epoch.clone();
        thread::spawn(move || {
            let mut process = Some(initial_process);
            let mut journals = HashMap::<String, HeadlessSessionJournal>::new();
            let mut restart_failures = 0_u32;
            let mut retry_after = Instant::now();
            for command in rx {
                if manager_desynced.swap(false, Ordering::AcqRel) {
                    for journal in journals.values_mut() {
                        journal.complete = false;
                    }
                    if let Ok(mut checkpoint_values) = checkpoints.lock() {
                        checkpoint_values.clear();
                    }
                    stop_headless_worker(&mut process, &manager_pending);
                    restart_failures = restart_failures.saturating_add(1);
                    retry_after = Instant::now() + headless_restart_backoff(restart_failures);
                }
                match command {
                    HeadlessWorkerCommand::Restart => {
                        stop_headless_worker(&mut process, &manager_pending);
                        restart_failures = restart_failures.saturating_add(1);
                        retry_after = Instant::now() + headless_restart_backoff(restart_failures);
                    }
                    HeadlessWorkerCommand::Message(mut message) => {
                        update_headless_journal(&mut journals, &checkpoints, &mut message);
                        let request_id = message.get("id").and_then(Value::as_u64);

                        let worker_exited = process
                            .as_mut()
                            .is_some_and(|worker| worker.child.try_wait().ok().flatten().is_some());
                        if worker_exited {
                            let stable = process.as_ref().is_some_and(|worker| {
                                worker.started_at.elapsed() >= HEADLESS_STABLE_UPTIME
                            });
                            stop_headless_worker(&mut process, &manager_pending);
                            restart_failures = if stable {
                                1
                            } else {
                                restart_failures.saturating_add(1)
                            };
                            retry_after =
                                Instant::now() + headless_restart_backoff(restart_failures);
                        }

                        if process.as_ref().is_some_and(|worker| {
                            worker.started_at.elapsed() >= HEADLESS_STABLE_UPTIME
                        }) {
                            restart_failures = 0;
                        }

                        let mut restored_now = false;
                        if process.is_none() && Instant::now() >= retry_after {
                            restored_now = restart_headless_worker(
                                &worker_path,
                                &manager_pending,
                                &checkpoints,
                                &journals,
                                &manager_next_worker_epoch,
                                &mut process,
                            );
                            if !restored_now {
                                restart_failures = restart_failures.saturating_add(1);
                                retry_after =
                                    Instant::now() + headless_restart_backoff(restart_failures);
                            }
                        }

                        if restored_now && request_id.is_none() {
                            continue;
                        }

                        let Some(worker) = process.as_mut() else {
                            if let Some(id) = request_id {
                                fail_headless_pending_request(
                                    &manager_pending,
                                    id,
                                    "headless state worker is restarting",
                                );
                            }
                            continue;
                        };
                        if let Some(id) = request_id {
                            assign_headless_pending_epoch(&manager_pending, id, worker.epoch);
                        }
                        if write_headless_message(&mut worker.stdin, &message).is_err() {
                            if let Some(id) = request_id {
                                fail_headless_pending_request(
                                    &manager_pending,
                                    id,
                                    "headless state worker write failed",
                                );
                            }
                            stop_headless_worker(&mut process, &manager_pending);
                            restart_failures = restart_failures.saturating_add(1);
                            retry_after =
                                Instant::now() + headless_restart_backoff(restart_failures);
                        }
                    }
                }
            }
            stop_headless_worker(&mut process, &manager_pending);
        });

        Ok(Self {
            desynced,
            next_request_id: Arc::new(AtomicU64::new(0)),
            pending,
            tx,
        })
    }

    fn create(&self, session_id: &str, generation: u64, size: PtySize) {
        self.notify(json!({
            "type": "create",
            "sessionId": session_id,
            "generation": generation,
            "cols": size.cols,
            "rows": size.rows,
        }));
    }

    fn drop_session(&self, session_id: &str, generation: u64) {
        self.notify(json!({
            "type": "drop",
            "sessionId": session_id,
            "generation": generation,
        }));
    }

    fn output(&self, session_id: &str, generation: u64, frame: &OutputFrame) {
        self.notify(json!({
            "type": "output",
            "sessionId": session_id,
            "generation": generation,
            "seq": frame.seq,
            "dataBase64": frame.data_base64,
        }));
    }

    fn resize(&self, session_id: &str, generation: u64, size: PtySize) {
        self.notify(json!({
            "type": "resize",
            "sessionId": session_id,
            "generation": generation,
            "cols": size.cols,
            "rows": size.rows,
        }));
    }

    fn snapshot(&self, session_id: &str, generation: u64) -> Result<HeadlessSnapshot, String> {
        let response = self.request(json!({
            "type": "snapshot",
            "sessionId": session_id,
            "generation": generation,
        }))?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("headless snapshot failed")
                .to_string());
        }
        Ok(HeadlessSnapshot {
            cols: response
                .get("cols")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .ok_or_else(|| "headless snapshot is missing cols".to_string())?,
            data_base64: response
                .get("dataBase64")
                .and_then(Value::as_str)
                .ok_or_else(|| "headless snapshot is missing data".to_string())?
                .to_string(),
            encoding: response
                .get("encoding")
                .and_then(Value::as_str)
                .ok_or_else(|| "headless snapshot is missing encoding".to_string())?
                .to_string(),
            rows: response
                .get("rows")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .ok_or_else(|| "headless snapshot is missing rows".to_string())?,
            through_seq: response
                .get("throughSeq")
                .and_then(Value::as_u64)
                .ok_or_else(|| "headless snapshot is missing throughSeq".to_string())?,
        })
    }

    fn notify(&self, message: Value) {
        if let Err(error) = self.tx.try_send(HeadlessWorkerCommand::Message(message)) {
            self.desynced.store(true, Ordering::Release);
            eprintln!("headless state worker queue is unavailable: {error}");
        }
    }

    fn request(&self, mut message: Value) -> Result<Value, String> {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed) + 1;
        message
            .as_object_mut()
            .ok_or_else(|| "headless state request must be an object".to_string())?
            .insert("id".to_string(), json!(id));
        let (response_tx, response_rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "headless state request lock is poisoned".to_string())?
            .insert(
                id,
                HeadlessPendingRequest {
                    sender: response_tx,
                    worker_epoch: 0,
                },
            );
        if let Err(error) = self.tx.try_send(HeadlessWorkerCommand::Message(message)) {
            self.desynced.store(true, Ordering::Release);
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(format!("headless state worker write failed: {error}"));
        }
        match response_rx.recv_timeout(HEADLESS_STATE_REQUEST_TIMEOUT) {
            Ok(response) => response,
            Err(error) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                let _ = self.tx.try_send(HeadlessWorkerCommand::Restart);
                Err(format!("headless state worker timed out: {error}"))
            }
        }
    }
}

fn spawn_headless_worker_process(
    worker_path: &Path,
    pending: HeadlessPendingRequests,
    checkpoints: HeadlessCheckpoints,
    epoch: u64,
) -> Result<HeadlessWorkerProcess, String> {
    let mut child = ProcessCommand::new("node")
        .arg(worker_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("failed to start {}: {error}", worker_path.display()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "headless state worker stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "headless state worker stdout is unavailable".to_string())?;
    thread::spawn(move || {
        let reader = io::BufReader::new(stdout);
        for line in reader.lines() {
            let response = match line {
                Ok(line) => match serde_json::from_str::<Value>(&line) {
                    Ok(response) => response,
                    Err(error) => {
                        eprintln!("ignored invalid headless state response: {error}");
                        continue;
                    }
                },
                Err(error) => {
                    eprintln!("headless state worker read failed: {error}");
                    break;
                }
            };
            if response.get("type").and_then(Value::as_str) == Some("checkpoint") {
                let session_id = response.get("sessionId").and_then(Value::as_str);
                let generation = response.get("generation").and_then(Value::as_u64);
                if let (Some(session_id), Some(generation)) = (session_id, generation)
                    && let Ok(mut checkpoints) = checkpoints.lock()
                {
                    let key = format!("{session_id}:{generation}");
                    let position = response
                        .get("journalPosition")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let current_position = checkpoints
                        .get(&key)
                        .and_then(|checkpoint| checkpoint.get("journalPosition"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    if position >= current_position {
                        checkpoints.insert(key, response);
                    }
                }
                continue;
            }
            let Some(id) = response.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let sender = pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&id));
            if let Some(pending_request) = sender {
                let _ = pending_request.sender.send(Ok(response));
            }
        }
        fail_headless_pending_epoch(
            &pending,
            epoch,
            "headless state worker exited before responding",
        );
    });
    Ok(HeadlessWorkerProcess {
        child,
        epoch,
        started_at: Instant::now(),
        stdin,
    })
}

fn write_headless_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, message)
        .map_err(|error| format!("failed to encode headless state message: {error}"))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("failed to write headless state message: {error}"))
}

fn assign_headless_pending_epoch(pending: &HeadlessPendingRequests, id: u64, epoch: u64) {
    if let Ok(mut pending) = pending.lock()
        && let Some(request) = pending.get_mut(&id)
    {
        request.worker_epoch = epoch;
    }
}

fn fail_headless_pending_request(pending: &HeadlessPendingRequests, id: u64, message: &str) {
    let request = pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&id));
    if let Some(request) = request {
        let _ = request.sender.send(Err(message.to_string()));
    }
}

fn fail_headless_pending_epoch(pending: &HeadlessPendingRequests, epoch: u64, message: &str) {
    let requests = pending
        .lock()
        .map(|mut pending| {
            let ids = pending
                .iter()
                .filter(|(_, request)| request.worker_epoch == epoch)
                .map(|(id, _)| *id)
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for request in requests {
        let _ = request.sender.send(Err(message.to_string()));
    }
}

fn stop_headless_worker(
    process: &mut Option<HeadlessWorkerProcess>,
    pending: &HeadlessPendingRequests,
) {
    if let Some(mut worker) = process.take() {
        fail_headless_pending_epoch(
            pending,
            worker.epoch,
            "headless state worker restarted before responding",
        );
        let _ = worker.child.kill();
        let _ = worker.child.wait();
    }
}

fn headless_restart_backoff(failure_count: u32) -> Duration {
    let shift = failure_count.saturating_sub(1).min(5);
    let millis = 250_u64.saturating_mul(1_u64 << shift);
    Duration::from_millis(millis).min(HEADLESS_MAX_RESTART_BACKOFF)
}

fn restart_headless_worker(
    worker_path: &Path,
    pending: &HeadlessPendingRequests,
    checkpoints: &HeadlessCheckpoints,
    journals: &HashMap<String, HeadlessSessionJournal>,
    next_worker_epoch: &AtomicU64,
    process: &mut Option<HeadlessWorkerProcess>,
) -> bool {
    stop_headless_worker(process, pending);
    let Ok(mut worker) = spawn_headless_worker_process(
        worker_path,
        pending.clone(),
        checkpoints.clone(),
        next_worker_epoch.fetch_add(1, Ordering::Relaxed),
    ) else {
        return false;
    };
    let checkpoint_values = checkpoints
        .lock()
        .map(|checkpoints| checkpoints.clone())
        .unwrap_or_default();
    for (key, journal) in journals {
        let checkpoint = checkpoint_values.get(key);
        if !journal.complete && checkpoint.is_none() {
            continue;
        }
        let checkpoint_position = checkpoint
            .and_then(|checkpoint| checkpoint.get("journalPosition"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let events_after_checkpoint = journal
            .events
            .iter()
            .filter(|event| event.position > checkpoint_position)
            .collect::<Vec<_>>();
        let replay_is_contiguous = if checkpoint.is_some() {
            events_after_checkpoint
                .first()
                .map(|event| event.position == checkpoint_position.saturating_add(1))
                .unwrap_or(journal.next_position == checkpoint_position)
        } else {
            journal.complete
        };
        if !replay_is_contiguous {
            continue;
        }
        if write_headless_message(&mut worker.stdin, &journal.create).is_err() {
            let _ = worker.child.kill();
            let _ = worker.child.wait();
            return false;
        }
        let checkpoint_through = checkpoint
            .and_then(|checkpoint| checkpoint.get("throughSeq"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if let Some(checkpoint) = checkpoint {
            let restore = json!({
                "type": "restore",
                "sessionId": checkpoint.get("sessionId"),
                "generation": checkpoint.get("generation"),
                "cols": checkpoint.get("cols"),
                "rows": checkpoint.get("rows"),
                "journalPosition": checkpoint_position,
                "throughSeq": checkpoint_through,
                "encoding": checkpoint.get("encoding"),
                "dataBase64": checkpoint.get("dataBase64"),
            });
            if write_headless_message(&mut worker.stdin, &restore).is_err() {
                let _ = worker.child.kill();
                let _ = worker.child.wait();
                return false;
            }
        }
        for event in events_after_checkpoint {
            if write_headless_message(&mut worker.stdin, &event.message).is_err() {
                let _ = worker.child.kill();
                let _ = worker.child.wait();
                return false;
            }
        }
    }
    *process = Some(worker);
    true
}

fn update_headless_journal(
    journals: &mut HashMap<String, HeadlessSessionJournal>,
    checkpoints: &HeadlessCheckpoints,
    message: &mut Value,
) {
    let Some(kind) = message
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let Some(session_id) = message
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let Some(generation) = message.get("generation").and_then(Value::as_u64) else {
        return;
    };
    let key = format!("{session_id}:{generation}");
    match kind.as_str() {
        "create" => {
            if let Ok(mut checkpoints) = checkpoints.lock() {
                checkpoints.remove(&key);
            }
            journals.insert(
                key,
                HeadlessSessionJournal {
                    complete: true,
                    create: message.clone(),
                    events: VecDeque::new(),
                    next_position: 0,
                    output_bytes: 0,
                },
            );
        }
        "drop" => {
            if let Ok(mut checkpoints) = checkpoints.lock() {
                checkpoints.remove(&key);
            }
            journals.remove(&key);
        }
        "output" | "resize" => {
            let Some(journal) = journals.get_mut(&key) else {
                return;
            };
            journal.next_position = journal.next_position.saturating_add(1);
            if let Some(record) = message.as_object_mut() {
                record.insert("journalPosition".to_string(), json!(journal.next_position));
            }
            let byte_len = if kind == "output" {
                message
                    .get("dataBase64")
                    .and_then(Value::as_str)
                    .map(|data| data.len().saturating_mul(3) / 4)
                    .unwrap_or(0)
            } else {
                0
            };
            journal.output_bytes = journal.output_bytes.saturating_add(byte_len);
            journal.events.push_back(HeadlessJournalEvent {
                byte_len,
                message: message.clone(),
                position: journal.next_position,
            });
            while journal.output_bytes > MAX_REPLAY_BYTES
                || journal.events.len() > MAX_REPLAY_FRAMES.saturating_mul(2)
            {
                let Some(removed) = journal.events.pop_front() else {
                    break;
                };
                journal.output_bytes = journal.output_bytes.saturating_sub(removed.byte_len);
                journal.complete = false;
            }
        }
        _ => {}
    }
}

fn terminal_extension_root() -> PathBuf {
    env::var("REMUX_EXTENSION_ROOT")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf()
        })
}

#[derive(Clone)]
struct TerminalExtensionServer {
    headless: Option<HeadlessStateWorker>,
    output_tx: mpsc::SyncSender<Value>,
    state: Arc<Mutex<TerminalState>>,
    tmux_cache: Arc<Mutex<TmuxCacheState>>,
}

impl TerminalExtensionServer {
    fn new(output_tx: mpsc::SyncSender<Value>) -> Self {
        Self {
            headless: HeadlessStateWorker::spawn()
                .map_err(|error| {
                    eprintln!("terminal headless state is unavailable: {error}");
                    error
                })
                .ok(),
            output_tx,
            state: Arc::new(Mutex::new(TerminalState::default())),
            tmux_cache: Arc::new(Mutex::new(TmuxCacheState::default())),
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
        let remux_origin = params.remux_origin.clone();
        let operation_id = params.operation_id.trim();
        if operation_id.is_empty() || operation_id.len() > 1024 {
            return Err("terminal start operationId must be 1..1024 bytes".to_string());
        }
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

        if let Some(response) = self.running_session_response(
            &session_id,
            size,
            params.remux_viewer_key.as_deref(),
            remux_origin.as_deref(),
            operation_id,
        )? {
            return Ok(response);
        }

        if let Some(mut session) = self.remove_session_record(&session_id) {
            if let Some(headless) = self.headless.as_ref() {
                headless.drop_session(&session.session_id, session.generation);
            }
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

        let (session_generation, input_stream_id, next_input_seq, subscription_token) = {
            let mut state = self.lock_state()?;
            state.next_session_generation += 1;
            let session_generation = state.next_session_generation;
            let mut session = SessionRecord::running(SessionRecordInit {
                cols: size.cols,
                cwd: cwd.clone(),
                generation: session_generation,
                killer,
                master,
                pid,
                rows: size.rows,
                session_id: session_id.clone(),
                shell: shell.clone(),
                shell_integration_dir,
                tty: tty.clone(),
                writer,
            });
            let subscription_boundary = session.next_seq;
            let subscription_token = session.subscribe_pending(
                params.remux_viewer_key.as_deref(),
                remux_origin.as_deref(),
                subscription_boundary,
            )?;
            let (input_stream_id, next_input_seq) = session.allocate_input_stream(None)?;
            session
                .start_operations
                .insert(operation_id.to_string(), input_stream_id.clone());
            state.sessions.insert(session_id.clone(), session);
            (
                session_generation,
                input_stream_id,
                next_input_seq,
                subscription_token,
            )
        };

        if let Some(headless) = self.headless.as_ref() {
            headless.create(&session_id, session_generation, size);
        }

        let reader_drained = spawn_reader_thread(
            self.state.clone(),
            self.output_tx.clone(),
            self.headless.clone(),
            session_id.clone(),
            session_generation,
            reader,
        );
        spawn_wait_thread(
            self.state.clone(),
            self.output_tx.clone(),
            session_id.clone(),
            session_generation,
            child,
            reader_drained,
        );

        Ok(json!({
            "cols": size.cols,
            "cwd": cwd.to_string_lossy(),
            "pid": pid,
            "rows": size.rows,
            "sessionId": session_id,
            "sessionGeneration": session_generation,
            "shell": shell,
            "tty": tty,
            "inputStreamId": input_stream_id,
            "nextInputSeq": next_input_seq,
            "firstAvailableSeq": 1,
            "nextOutputSeq": 1,
            "catchupEndSeq": 1,
            "subscriptionToken": subscription_token,
        }))
    }

    fn attach_session(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<TerminalSessionAttachParams>(params, SESSION_ATTACH_METHOD)?;
        let size = params.size();
        let (generation, incremental_through) = {
            let mut state = self.lock_state()?;
            let session = state
                .sessions
                .get_mut(&params.session_id)
                .ok_or_else(|| format!("terminal session not found: {}", params.session_id))?;

            if let Some(expected_generation) = params.session_generation
                && expected_generation != session.generation
            {
                return Err(format!(
                    "stale terminal session generation: expected {}, current {}",
                    expected_generation, session.generation
                ));
            }

            if session.status == SessionStatus::Running {
                session.resize(size)?;
                if let Some(headless) = self.headless.as_ref() {
                    headless.resize(&params.session_id, session.generation, size);
                }
            }

            let first_available_seq = session
                .replay
                .front()
                .map(|frame| frame.frame.seq)
                .unwrap_or(session.next_seq);
            let requested_through = params
                .client_state
                .as_ref()
                .filter(|state| state.valid)
                .map(|state| state.through_seq)
                .or_else(|| params.replay_seq.filter(|seq| *seq > 0).map(|seq| seq - 1));
            let incremental_through = requested_through.filter(|through| {
                if *through >= session.next_seq || through.saturating_add(1) < first_available_seq {
                    return false;
                }
                session
                    .replay
                    .iter()
                    .filter(|frame| frame.frame.seq > *through)
                    .map(|frame| frame.byte_len)
                    .sum::<usize>()
                    <= MAX_ATTACH_REPLAY_BYTES
            });
            (session.generation, incremental_through)
        };

        // A fresh or invalid client gets an authoritative terminal snapshot.
        // The request is ordered behind all prior output/resize messages in the
        // worker, so throughSeq is an exact boundary for the raw replay tail.
        let snapshot = if incremental_through.is_none() {
            self.headless
                .as_ref()
                .and_then(|headless| headless.snapshot(&params.session_id, generation).ok())
        } else {
            None
        };

        let mut state = self.lock_state()?;
        let session = state
            .sessions
            .get_mut(&params.session_id)
            .ok_or_else(|| format!("terminal session not found: {}", params.session_id))?;
        if session.generation != generation {
            return Err(format!(
                "stale terminal session generation: expected {generation}, current {}",
                session.generation
            ));
        }

        let first_available_seq = session
            .replay
            .front()
            .map(|frame| frame.frame.seq)
            .unwrap_or(session.next_seq);
        let (restore, replay_from, replay_truncated) = if let Some(through_seq) =
            incremental_through.filter(|through| {
                through.saturating_add(1) >= first_available_seq && *through < session.next_seq
            }) {
            (
                json!({ "kind": "incremental", "throughSeq": through_seq }),
                through_seq.saturating_add(1),
                false,
            )
        } else if let Some(snapshot) = snapshot
            && snapshot.through_seq < session.next_seq
            && snapshot.through_seq.saturating_add(1) >= first_available_seq
        {
            let through_seq = snapshot.through_seq;
            (
                json!({
                    "kind": "snapshot",
                    "cols": snapshot.cols,
                    "rows": snapshot.rows,
                    "throughSeq": through_seq,
                    "encoding": snapshot.encoding,
                    "dataBase64": snapshot.data_base64,
                }),
                through_seq.saturating_add(1),
                false,
            )
        } else if first_available_seq <= 1 {
            (json!({ "kind": "reset", "throughSeq": 0 }), 1, false)
        } else {
            (
                json!({
                    "kind": "unavailable",
                    "throughSeq": first_available_seq.saturating_sub(1),
                }),
                first_available_seq,
                true,
            )
        };
        let catchup_end_seq = session.next_seq;
        let replay_page = collect_replay_page(
            session,
            replay_from,
            catchup_end_seq,
            MAX_ATTACH_REPLAY_BYTES,
        );
        let subscription_token = session.subscribe_pending(
            params.remux_viewer_key.as_deref(),
            params.remux_origin.as_deref(),
            catchup_end_seq,
        )?;
        let (input_stream_id, next_input_seq) =
            session.allocate_input_stream(params.input_stream_id.as_deref())?;

        Ok(json!({
            "exitCode": session.exit_code,
            "exitSignal": session.exit_signal,
            "nextSeq": session.next_seq,
            "nextOutputSeq": session.next_seq,
            "firstAvailableSeq": first_available_seq,
            "nextInputSeq": next_input_seq,
            "inputStreamId": input_stream_id,
            "restore": restore,
            "replay": replay_page.frames,
            "replayComplete": replay_page.complete,
            "replayNextSeq": replay_page.next_seq,
            "replayTruncated": replay_truncated,
            "catchupEndSeq": catchup_end_seq,
            "subscriptionToken": subscription_token,
            "sessionId": session.session_id,
            "sessionGeneration": session.generation,
            "status": session.status.as_str(),
        }))
    }

    fn detach_session(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<TerminalSessionDetachParams>(params, SESSION_DETACH_METHOD)?;
        let mut state = self.lock_state()?;
        let session = state
            .sessions
            .get_mut(&params.session_id)
            .ok_or_else(|| format!("terminal session not found: {}", params.session_id))?;
        if session.generation != params.session_generation {
            return Err(format!(
                "stale terminal session generation: expected {}, current {}",
                params.session_generation, session.generation
            ));
        }
        if let Some(key) = params
            .remux_viewer_key
            .as_deref()
            .or(params.remux_origin.as_deref())
        {
            session.subscriptions.remove(key);
        }
        session.input_streams.remove(&params.input_stream_id);
        Ok(json!({
            "ok": true,
            "sessionGeneration": session.generation,
        }))
    }

    fn ready_session(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<TerminalSessionReadyParams>(params, SESSION_READY_METHOD)?;
        let mut state = self.lock_state()?;
        let session = state
            .sessions
            .get_mut(&params.session_id)
            .ok_or_else(|| format!("terminal session not found: {}", params.session_id))?;
        if session.generation != params.session_generation {
            return Ok(json!({ "ok": false, "reason": "stale-subscription" }));
        }
        let Some((subscription_key, subscription)) = session
            .subscriptions
            .iter()
            .find(|(_, subscription)| subscription.token == params.subscription_token)
            .map(|(key, subscription)| (key.clone(), subscription))
        else {
            return Ok(json!({ "ok": false, "reason": "stale-subscription" }));
        };
        if subscription.active {
            return Ok(json!({ "ok": true, "nextOutputSeq": subscription.next_seq }));
        }
        if params
            .remux_origin
            .as_deref()
            .is_some_and(|origin| origin != subscription.origin)
        {
            return Ok(json!({ "ok": false, "reason": "stale-subscription" }));
        }
        if params.through_seq.saturating_add(1) != subscription.catchup_end_seq {
            return Ok(json!({ "ok": false, "reason": "gap" }));
        }
        let first_available_seq = session
            .replay
            .front()
            .map(|frame| frame.frame.seq)
            .unwrap_or(session.next_seq);
        if subscription.next_seq < first_available_seq {
            return Ok(json!({ "ok": false, "reason": "gap" }));
        }
        let replay_page = collect_replay_page(
            session,
            subscription.next_seq,
            session.next_seq,
            MAX_READY_CATCHUP_BYTES,
        );
        if !replay_page.complete {
            return Ok(json!({ "ok": false, "reason": "catchup-too-large" }));
        }
        let origin = subscription.origin.clone();
        let origin_set = HashSet::from([origin]);
        for frame in replay_page.frames {
            let notification = json!({
                "jsonrpc": "2.0",
                "method": SESSION_OUTPUT_NOTIFICATION,
                "params": {
                    "frame": frame,
                    "sessionId": params.session_id,
                    "sessionGeneration": params.session_generation,
                },
            });
            for targeted in target_for_origins(notification, &origin_set) {
                self.output_tx
                    .send(targeted)
                    .map_err(|error| format!("failed to activate terminal output: {error}"))?;
            }
        }
        if session.status == SessionStatus::Exited {
            let exited = json!({
                "jsonrpc": "2.0",
                "method": SESSION_EXITED_NOTIFICATION,
                "params": {
                    "exitCode": session.exit_code,
                    "exitSignal": session.exit_signal,
                    "sessionId": params.session_id,
                    "sessionGeneration": params.session_generation,
                },
            });
            for targeted in target_for_origins(exited, &origin_set) {
                self.output_tx
                    .send(targeted)
                    .map_err(|error| format!("failed to activate terminal exit: {error}"))?;
            }
        }
        if let Some(subscription) = session.subscriptions.get_mut(&subscription_key) {
            subscription.next_seq = session.next_seq;
            subscription.active = true;
        }
        Ok(json!({ "ok": true, "nextOutputSeq": session.next_seq }))
    }

    fn read_replay(&self, params: Value) -> Result<Value, String> {
        let params =
            parse_params::<TerminalSessionReplayReadParams>(params, SESSION_REPLAY_READ_METHOD)?;
        let state = self.lock_state()?;
        let session = state
            .sessions
            .get(&params.session_id)
            .ok_or_else(|| format!("terminal session not found: {}", params.session_id))?;
        if session.generation != params.session_generation {
            return Err(format!(
                "stale terminal session generation: expected {}, current {}",
                params.session_generation, session.generation
            ));
        }
        let first_available_seq = session
            .replay
            .front()
            .map(|frame| frame.frame.seq)
            .unwrap_or(session.next_seq);
        let truncated = params.from_seq > 0 && params.from_seq < first_available_seq;
        let from_seq = params.from_seq.max(first_available_seq);
        let max_bytes = params.max_bytes.unwrap_or(256 * 1024).clamp(1, 256 * 1024);
        let to_seq_exclusive = params
            .to_seq_exclusive
            .unwrap_or(session.next_seq)
            .min(session.next_seq)
            .max(from_seq);
        let replay_page = collect_replay_page(session, from_seq, to_seq_exclusive, max_bytes);
        Ok(json!({
            "complete": replay_page.complete,
            "firstAvailableSeq": first_available_seq,
            "frames": replay_page.frames,
            "nextSeq": replay_page.next_seq,
            "sessionGeneration": session.generation,
            "sessionId": session.session_id,
            "toSeqExclusive": to_seq_exclusive,
            "truncated": truncated,
        }))
    }

    fn write_session(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<TerminalSessionWriteParams>(params, SESSION_WRITE_METHOD)?;
        let bytes = BASE64
            .decode(params.data_base64.as_bytes())
            .map_err(|error| format!("invalid terminal input: {error}"))?;

        if bytes.len() > MAX_INPUT_CHUNK_BYTES {
            return Err(format!(
                "terminal input chunk is too large: {}>{MAX_INPUT_CHUNK_BYTES}",
                bytes.len()
            ));
        }

        let mut state = self.lock_state()?;
        let session = state
            .sessions
            .get_mut(&params.session_id)
            .ok_or_else(|| format!("terminal session not found: {}", params.session_id))?;
        if params.session_generation != session.generation {
            return Err(format!(
                "stale terminal session generation: expected {}, current {}",
                params.session_generation, session.generation
            ));
        }
        let input_stream = session
            .input_streams
            .get_mut(&params.input_stream_id)
            .ok_or_else(|| {
                format!(
                    "terminal input stream is not active: {}",
                    params.input_stream_id
                )
            })?;
        input_stream.last_seen = Instant::now();
        if params.input_seq < input_stream.next_seq {
            return Ok(json!({
                "acceptedInputSeq": params.input_seq,
                "duplicate": true,
                "nextInputSeq": input_stream.next_seq,
                "ok": true,
                "sessionGeneration": session.generation,
            }));
        }
        if params.input_seq > input_stream.next_seq {
            return Err(format!(
                "terminal input sequence gap: expectedInputSeq={}, received={}",
                input_stream.next_seq, params.input_seq
            ));
        }
        let writer = session
            .writer_tx
            .as_ref()
            .ok_or_else(|| format!("terminal session is not running: {}", params.session_id))?;
        if !bytes.is_empty() {
            writer.try_send(bytes).map_err(|error| match error {
                mpsc::TrySendError::Full(_) => "terminal input queue is full".to_string(),
                mpsc::TrySendError::Disconnected(_) => {
                    format!("terminal session is not running: {}", params.session_id)
                }
            })?;
        }
        input_stream.next_seq += 1;

        Ok(json!({
            "acceptedInputSeq": params.input_seq,
            "duplicate": false,
            "nextInputSeq": input_stream.next_seq,
            "ok": true,
            "sessionGeneration": session.generation,
        }))
    }

    fn resize_session(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<TerminalSessionResizeParams>(params, SESSION_RESIZE_METHOD)?;
        let size = params.size();
        let mut state = self.lock_state()?;
        let session = state
            .sessions
            .get_mut(&params.session_id)
            .ok_or_else(|| format!("terminal session not found: {}", params.session_id))?;
        if params.session_generation != session.generation {
            return Err(format!(
                "stale terminal session generation: expected {}, current {}",
                params.session_generation, session.generation
            ));
        }
        session.resize(size)?;
        if let Some(headless) = self.headless.as_ref() {
            headless.resize(&params.session_id, session.generation, size);
        }

        Ok(json!({ "ok": true, "sessionGeneration": session.generation }))
    }

    fn kill_session(&self, params: Value) -> Result<Value, String> {
        let params = parse_params::<TerminalSessionKillParams>(params, SESSION_KILL_METHOD)?;
        let session_id = params.session_id.clone();
        let killer = {
            let mut state = self.lock_state()?;
            let Some(session) = state.sessions.get(&session_id) else {
                return Ok(json!({ "ok": true, "sessionGeneration": params.session_generation }));
            };
            if session.generation != params.session_generation {
                return Err(format!(
                    "stale terminal session generation: expected {}, current {}",
                    params.session_generation, session.generation
                ));
            }
            state.sessions.remove(&session_id).and_then(|mut session| {
                if let Some(headless) = self.headless.as_ref() {
                    headless.drop_session(&session.session_id, session.generation);
                }
                session.cleanup_shell_integration();
                session.killer.take()
            })
        };

        if let Some(mut killer) = killer {
            killer
                .kill()
                .map_err(|error| format!("failed to kill terminal session: {error}"))?;
        }

        let _ = self
            .output_tx
            .send(terminal_audience_remove_notification(&session_id));
        Ok(json!({ "ok": true, "sessionGeneration": params.session_generation }))
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
            if let Some(headless) = self.headless.as_ref() {
                headless.drop_session(&session.session_id, session.generation);
            }
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
        viewer_key: Option<&str>,
        remux_origin: Option<&str>,
        operation_id: &str,
    ) -> Result<Option<Value>, String> {
        let mut state = self.lock_state()?;
        let Some(session) = state.sessions.get_mut(session_id) else {
            return Ok(None);
        };

        if session.status != SessionStatus::Running {
            return Ok(None);
        }

        session.resize(size)?;
        if let Some(headless) = self.headless.as_ref() {
            headless.resize(session_id, session.generation, size);
        }
        let subscription_boundary = session.next_seq;
        let subscription_token =
            session.subscribe_pending(viewer_key, remux_origin, subscription_boundary)?;
        let requested_stream = session.start_operations.get(operation_id).cloned();
        let (input_stream_id, next_input_seq) =
            session.allocate_input_stream(requested_stream.as_deref())?;
        session
            .start_operations
            .insert(operation_id.to_string(), input_stream_id.clone());
        Ok(Some(json!({
            "cols": session.cols,
            "cwd": session.cwd.to_string_lossy(),
            "pid": session.pid,
            "rows": session.rows,
            "sessionId": session.session_id,
            "sessionGeneration": session.generation,
            "shell": session.shell,
            "tty": session.tty,
            "inputStreamId": input_stream_id,
            "nextInputSeq": next_input_seq,
            "firstAvailableSeq": session.replay.front().map(|frame| frame.frame.seq).unwrap_or(session.next_seq),
            "nextOutputSeq": session.next_seq,
            "catchupEndSeq": subscription_boundary,
            "subscriptionToken": subscription_token,
        })))
    }

    fn tmux_context(&self, params: Value) -> Result<Value, String> {
        let params =
            parse_params::<tmux::TerminalTmuxContextParams>(params, TMUX_CONTEXT_GET_METHOD)?;
        let terminal_tty = self.session_tty(&params.session_id)?;
        let context = self.cached_tmux_context(params.session_id, terminal_tty);

        serde_json::to_value(json!({ "context": context })).map_err(|error| error.to_string())
    }

    fn spawn_tmux_action(
        &self,
        params: Value,
        response_id: Option<Value>,
        output_tx: mpsc::SyncSender<Value>,
    ) -> Result<(), String> {
        let params = parse_params::<tmux::TerminalTmuxActionParams>(params, TMUX_ACTION_METHOD)?;
        let session_id = params.session_id.clone();
        let terminal_tty = self.session_tty(&params.session_id)?;
        let cache = self.tmux_cache.clone();

        thread::spawn(move || {
            let result = tmux::run_tmux_action(params, terminal_tty)
                .and_then(|response| {
                    if let Some(context) = response.context.clone() {
                        update_tmux_context_cache(&cache, &session_id, context);
                    }
                    serde_json::to_value(response).map_err(|error| error.to_string())
                })
                .map_err(internal_rpc_error);
            let _ = respond_or_log(response_id, result, &output_tx);
        });

        Ok(())
    }

    fn cached_tmux_context(
        &self,
        session_id: String,
        terminal_tty: Option<String>,
    ) -> tmux::TmuxContext {
        let now = unix_millis();
        let cached = self
            .tmux_cache
            .lock()
            .ok()
            .and_then(|state| state.contexts.get(&session_id).cloned())
            .filter(|context| context.terminal_tty == terminal_tty);

        let fresh = cached.as_ref().is_some_and(|context| {
            now.saturating_sub(context.generated_at) <= TMUX_CONTEXT_CACHE_FRESH_MS
        });
        if !fresh {
            self.schedule_tmux_context_refresh(session_id.clone(), terminal_tty.clone());
        }

        cached.unwrap_or_else(|| empty_tmux_context(&session_id, terminal_tty, now))
    }

    fn schedule_tmux_context_refresh(&self, session_id: String, terminal_tty: Option<String>) {
        let should_spawn = {
            let Ok(mut state) = self.tmux_cache.lock() else {
                return;
            };
            state.refreshes.insert(session_id.clone())
        };

        if !should_spawn {
            return;
        }

        let cache = self.tmux_cache.clone();
        thread::spawn(move || {
            // The guard clears the in-flight marker on every exit path, including a
            // panic in scan_context, so one failed scan can't wedge future refreshes.
            let _refresh_guard = TmuxRefreshGuard {
                cache: cache.clone(),
                session_id: session_id.clone(),
            };
            match tmux::scan_context(&session_id, terminal_tty) {
                Ok(context) => {
                    if let Ok(mut state) = cache.lock() {
                        state.contexts.insert(session_id.clone(), context);
                    }
                }
                Err(error) => {
                    eprintln!("failed to refresh tmux context: {error}");
                }
            }
        });
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
    next_session_generation: u64,
    sessions: HashMap<String, SessionRecord>,
}

#[derive(Default)]
struct TmuxCacheState {
    contexts: HashMap<String, tmux::TmuxContext>,
    refreshes: HashSet<String>,
}

struct TmuxRefreshGuard {
    cache: Arc<Mutex<TmuxCacheState>>,
    session_id: String,
}

impl Drop for TmuxRefreshGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.cache.lock() {
            state.refreshes.remove(&self.session_id);
        }
    }
}

struct SessionRecord {
    cols: u16,
    cwd: PathBuf,
    exit_code: Option<u32>,
    exit_signal: Option<String>,
    generation: u64,
    input_streams: HashMap<String, InputStreamState>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    last_bell_notification_at: Option<u64>,
    last_explicit_notification: Option<(String, u64)>,
    master: Option<Box<dyn MasterPty + Send>>,
    next_notification_seq: u64,
    next_input_stream_id: u64,
    next_subscription_id: u64,
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
    start_operations: HashMap<String, String>,
    subscriptions: HashMap<String, TerminalSubscription>,
    tty: Option<String>,
    writer_tx: Option<mpsc::SyncSender<Vec<u8>>>,
}

struct SessionRecordInit {
    cols: u16,
    cwd: PathBuf,
    generation: u64,
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

struct InputStreamState {
    last_seen: Instant,
    next_seq: u64,
}

struct TerminalSubscription {
    active: bool,
    catchup_end_seq: u64,
    next_seq: u64,
    origin: String,
    token: String,
}

impl SessionRecord {
    fn running(init: SessionRecordInit) -> Self {
        let (writer_tx, writer_rx) = mpsc::sync_channel(SESSION_INPUT_QUEUE_CAPACITY);
        spawn_session_writer(init.writer, writer_rx);
        Self {
            cols: init.cols,
            cwd: init.cwd,
            exit_code: None,
            exit_signal: None,
            generation: init.generation,
            input_streams: HashMap::new(),
            killer: Some(init.killer),
            last_bell_notification_at: None,
            last_explicit_notification: None,
            master: Some(init.master),
            next_notification_seq: 1,
            next_input_stream_id: 0,
            next_subscription_id: 0,
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
            start_operations: HashMap::new(),
            subscriptions: HashMap::new(),
            tty: init.tty,
            writer_tx: Some(writer_tx),
        }
    }

    fn allocate_input_stream(&mut self, requested: Option<&str>) -> Result<(String, u64), String> {
        self.input_streams
            .retain(|_, stream| stream.last_seen.elapsed() < INPUT_STREAM_RECONNECT_LEASE);
        if let Some(requested) = requested
            && let Some(next) = self.input_streams.get_mut(requested)
        {
            next.last_seen = Instant::now();
            return Ok((requested.to_string(), next.next_seq));
        }
        // A viewer can legitimately return after the reconnect lease. Give it
        // a fresh producer identity instead of making every subsequent attach
        // retry the same permanently expired stream.
        if self.input_streams.len() >= MAX_INPUT_STREAMS {
            return Err(format!(
                "TerminalInputStreamLimit: session {} already has {MAX_INPUT_STREAMS} input streams",
                self.session_id
            ));
        }
        self.next_input_stream_id += 1;
        let stream_id = format!(
            "terminal-input:{}:{}",
            self.generation, self.next_input_stream_id
        );
        self.input_streams.insert(
            stream_id.clone(),
            InputStreamState {
                last_seen: Instant::now(),
                next_seq: 1,
            },
        );
        Ok((stream_id, 1))
    }

    fn subscribe_pending(
        &mut self,
        viewer_key: Option<&str>,
        origin: Option<&str>,
        next_seq: u64,
    ) -> Result<Option<String>, String> {
        if let Some(origin) = origin.filter(|origin| !origin.is_empty()) {
            let key = viewer_key
                .filter(|key| !key.is_empty())
                .unwrap_or(origin)
                .to_string();
            if !self.subscriptions.contains_key(&key)
                && self.subscriptions.len() >= MAX_SESSION_SUBSCRIPTIONS
            {
                return Err(format!(
                    "TerminalSubscriptionLimit: session {} already has {MAX_SESSION_SUBSCRIPTIONS} subscriptions",
                    self.session_id
                ));
            }
            self.next_subscription_id += 1;
            let token = format!(
                "terminal-subscription:{}:{}:{}",
                self.generation,
                self.next_subscription_id,
                unix_millis(),
            );
            self.subscriptions.insert(
                key,
                TerminalSubscription {
                    active: false,
                    catchup_end_seq: next_seq,
                    next_seq,
                    origin: origin.to_string(),
                    token: token.clone(),
                },
            );
            return Ok(Some(token));
        }
        Ok(None)
    }

    fn active_origins(&self) -> HashSet<String> {
        self.subscriptions
            .iter()
            .filter(|(_, subscription)| subscription.active)
            .map(|(_, subscription)| subscription.origin.clone())
            .collect()
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
            session_generation: self.generation,
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
        self.writer_tx = None;
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
            session_generation: self.generation,
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

struct ReplayPage {
    complete: bool,
    frames: Vec<OutputFrame>,
    next_seq: u64,
}

fn collect_replay_page(
    session: &SessionRecord,
    from_seq: u64,
    to_seq_exclusive: u64,
    max_bytes: usize,
) -> ReplayPage {
    let mut bytes = 0usize;
    let mut frames = Vec::new();
    for replay in session
        .replay
        .iter()
        .filter(|replay| replay.frame.seq >= from_seq && replay.frame.seq < to_seq_exclusive)
    {
        if !frames.is_empty() && bytes.saturating_add(replay.byte_len) > max_bytes {
            break;
        }
        bytes = bytes.saturating_add(replay.byte_len);
        frames.push(replay.frame.clone());
    }
    let next_seq = frames
        .last()
        .map(|frame| frame.seq.saturating_add(1))
        .unwrap_or(from_seq);
    ReplayPage {
        complete: next_seq >= to_seq_exclusive,
        frames,
        next_seq,
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputFrame {
    data_base64: String,
    session_generation: u64,
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
    session_generation: u64,
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

fn target_for_origins(message: Value, origins: &HashSet<String>) -> Vec<Value> {
    if origins.is_empty() {
        return vec![message];
    }
    origins
        .iter()
        .map(|origin| {
            let mut message = message.clone();
            if let Some(record) = message.as_object_mut() {
                record.insert("remuxTarget".to_string(), json!({ "origin": origin }));
            }
            message
        })
        .collect()
}

fn spawn_session_writer(mut writer: Box<dyn Write + Send>, input_rx: mpsc::Receiver<Vec<u8>>) {
    thread::spawn(move || {
        for bytes in input_rx {
            if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });
}

fn spawn_reader_thread(
    state: Arc<Mutex<TerminalState>>,
    output_tx: mpsc::SyncSender<Value>,
    headless: Option<HeadlessStateWorker>,
    session_id: String,
    session_generation: u64,
    mut reader: Box<dyn Read + Send>,
) -> mpsc::Receiver<()> {
    let (drained_tx, drained_rx) = mpsc::channel();
    // Stage 1: block on the PTY and forward raw chunks as they arrive.
    let (chunk_tx, chunk_rx) = mpsc::sync_channel::<Vec<u8>>(64);
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

            let (output_notifications, terminal_notifications) = {
                let Ok(mut state) = state.lock() else {
                    return;
                };
                let Some(session) = state.sessions.get_mut(&session_id) else {
                    return;
                };
                if session.generation != session_generation {
                    return;
                }
                let terminal_notifications = session.notification_requests_for_output(&acc);
                let frame = session.append_output(&acc);
                if let Some(headless) = headless.as_ref() {
                    // Keep state-emulator ordering under the same lock used by
                    // resize. Otherwise an attach could enqueue RESIZE between
                    // assigning this frame's sequence and forwarding its bytes.
                    headless.output(&session_id, session_generation, &frame);
                }
                let active_origins = session.active_origins();
                let output_notification = json!({
                    "jsonrpc": "2.0",
                    "method": SESSION_OUTPUT_NOTIFICATION,
                    "params": {
                        "frame": frame,
                        "sessionId": session_id,
                        "sessionGeneration": session_generation,
                    },
                });
                let output_notifications = if session.subscriptions.is_empty() {
                    vec![output_notification]
                } else if active_origins.is_empty() {
                    Vec::new()
                } else {
                    target_for_origins(output_notification, &active_origins)
                };
                (output_notifications, terminal_notifications)
            };

            for output_notification in output_notifications {
                if output_tx.send(output_notification).is_err() {
                    return;
                }
            }
            for notification in terminal_notifications {
                if output_tx.send(notification).is_err() {
                    return;
                }
            }
        }
        let _ = drained_tx.send(());
    });
    drained_rx
}

fn spawn_wait_thread(
    state: Arc<Mutex<TerminalState>>,
    output_tx: mpsc::SyncSender<Value>,
    session_id: String,
    session_generation: u64,
    mut child: Box<dyn Child + Send + Sync>,
    reader_drained: mpsc::Receiver<()>,
) {
    thread::spawn(move || {
        let status = child.wait();
        // wait(2) may complete before the PTY master has drained the child's
        // final teardown bytes. Give the reader/coalescer a bounded chance to
        // publish sequences such as DECRST 1049 before announcing exit.
        let _ = reader_drained.recv_timeout(Duration::from_secs(1));
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
            if session.generation != session_generation {
                return;
            }
            let origins = session.active_origins();
            let has_subscriptions = !session.subscriptions.is_empty();
            session.mark_exited(exit_code, exit_signal.clone());
            let exited = json!({
                "jsonrpc": "2.0",
                "method": SESSION_EXITED_NOTIFICATION,
                "params": {
                    "exitCode": exit_code,
                    "exitSignal": exit_signal,
                    "sessionId": session_id.clone(),
                    "sessionGeneration": session_generation,
                },
            });
            let mut notifications = if !has_subscriptions {
                vec![exited]
            } else if origins.is_empty() {
                Vec::new()
            } else {
                target_for_origins(exited, &origins)
            };
            notifications.push(terminal_audience_remove_notification(&session_id));
            notifications
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
    operation_id: String,
    rows: Option<u32>,
    #[serde(rename = "_remuxOrigin")]
    remux_origin: Option<String>,
    #[serde(rename = "_remuxViewerKey")]
    remux_viewer_key: Option<String>,
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
    client_state: Option<TerminalClientState>,
    cols: Option<u32>,
    input_stream_id: Option<String>,
    replay_seq: Option<u64>,
    rows: Option<u32>,
    #[serde(rename = "_remuxOrigin")]
    remux_origin: Option<String>,
    #[serde(rename = "_remuxViewerKey")]
    remux_viewer_key: Option<String>,
    session_id: String,
    session_generation: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionReadyParams {
    #[serde(rename = "_remuxOrigin")]
    remux_origin: Option<String>,
    session_id: String,
    session_generation: u64,
    subscription_token: String,
    through_seq: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalClientState {
    through_seq: u64,
    valid: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionDetachParams {
    input_stream_id: String,
    #[serde(rename = "_remuxOrigin")]
    remux_origin: Option<String>,
    #[serde(rename = "_remuxViewerKey")]
    remux_viewer_key: Option<String>,
    session_id: String,
    session_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionReplayReadParams {
    from_seq: u64,
    max_bytes: Option<usize>,
    session_id: String,
    session_generation: u64,
    to_seq_exclusive: Option<u64>,
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
    input_seq: u64,
    input_stream_id: String,
    session_id: String,
    session_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionResizeParams {
    cols: Option<u32>,
    pixel_height: Option<u32>,
    pixel_width: Option<u32>,
    rows: Option<u32>,
    session_id: String,
    session_generation: u64,
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
    session_generation: u64,
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

fn empty_tmux_context(
    session_id: &str,
    terminal_tty: Option<String>,
    generated_at: u64,
) -> tmux::TmuxContext {
    tmux::TmuxContext {
        mode: tmux::TmuxMode::None,
        terminal_session_id: session_id.to_string(),
        terminal_tty,
        current_client: None,
        sockets: Vec::new(),
        generated_at,
    }
}

fn update_tmux_context_cache(
    cache: &Arc<Mutex<TmuxCacheState>>,
    session_id: &str,
    context: tmux::TmuxContext,
) {
    let Ok(mut state) = cache.lock() else {
        return;
    };

    state.contexts.insert(session_id.to_string(), context);
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
struct JsonRpcEnvelope {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Debug)]
struct JsonRpcRequest {
    method: String,
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
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;
    use std::sync::mpsc::{self, Receiver};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use base64::Engine;
    use serde_json::{Value, json};

    use portable_pty::CommandBuilder;

    use super::{
        BASE64, INPUT_STREAM_RECONNECT_LEASE, JsonRpcEnvelope, REMUX_NOTIFICATION_REQUEST_METHOD,
        SESSION_EXITED_NOTIFICATION, SESSION_OUTPUT_NOTIFICATION, SESSION_START_METHOD,
        SESSION_WRITE_METHOD, SHELL_INTEGRATION_ENV, TERMINAL_OUTPUT_QUEUE_CAPACITY,
        TerminalExtensionServer, TerminalNotificationEvent, TerminalNotificationParser, clamp_u16,
        configure_shell_integration, configure_terminal_environment, handle_envelope,
        headless_restart_backoff, pty_size, update_headless_journal,
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
    fn headless_journal_assigns_a_total_order_to_output_and_resize() {
        let mut journals = HashMap::new();
        let checkpoints = Arc::new(Mutex::new(HashMap::new()));
        let mut create = json!({
            "type": "create",
            "sessionId": "journal-test",
            "generation": 1,
            "cols": 80,
            "rows": 24,
        });
        update_headless_journal(&mut journals, &checkpoints, &mut create);

        let mut resize = json!({
            "type": "resize",
            "sessionId": "journal-test",
            "generation": 1,
            "cols": 100,
            "rows": 30,
        });
        update_headless_journal(&mut journals, &checkpoints, &mut resize);
        let mut output = json!({
            "type": "output",
            "sessionId": "journal-test",
            "generation": 1,
            "seq": 1,
            "dataBase64": "eA==",
        });
        update_headless_journal(&mut journals, &checkpoints, &mut output);

        assert_eq!(resize["journalPosition"], 1);
        assert_eq!(output["journalPosition"], 2);
        let journal = journals.get("journal-test:1").unwrap();
        assert_eq!(journal.next_position, 2);
        assert_eq!(journal.events[0].position, 1);
        assert_eq!(journal.events[1].position, 2);
    }

    #[test]
    fn headless_restart_backoff_is_bounded() {
        assert_eq!(headless_restart_backoff(1), Duration::from_millis(250));
        assert_eq!(headless_restart_backoff(2), Duration::from_millis(500));
        assert_eq!(headless_restart_backoff(99), Duration::from_secs(8));
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
            let integration_path = command
                .get_env("REMUX_SHELL_INTEGRATION_SCRIPT")
                .expect("shell integration path should be exported");
            let integration = fs::read_to_string(integration_path)
                .expect("generated shell integration should be readable");
            assert!(
                !integration.contains("__remux_reset_terminal_modes"),
                "shell integration should leave mode recovery to the terminal emulator"
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
    fn idless_session_write_writes_to_pty_without_response() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, output_rx) = test_server();
        let session_id = "terminal-test-idless-write";

        start_test_session(&server, session_id, shell, 80, 24);
        let (session_generation, input_stream_id, input_seq) =
            session_input_protocol(&server, session_id);
        let output_tx = server.output_tx.clone();
        handle_envelope(
            &server,
            JsonRpcEnvelope {
                id: None,
                method: SESSION_WRITE_METHOD.to_string(),
                params: Some(json!({
                    "dataBase64": BASE64.encode(b"printf 'idless-write-ok'\r"),
                    "inputSeq": input_seq,
                    "inputStreamId": input_stream_id,
                    "sessionId": session_id,
                    "sessionGeneration": session_generation,
                })),
            },
            &output_tx,
        )
        .expect("expected id-less write notification to be handled");

        read_until_output_without_response(&output_rx, session_id, "idless-write-ok");
        server.kill_all();
    }

    #[test]
    fn start_response_is_admitted_before_early_targeted_output() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, output_rx) = test_server();
        let output_tx = server.output_tx.clone();
        handle_envelope(
            &server,
            JsonRpcEnvelope {
                id: Some(json!(91)),
                method: SESSION_START_METHOD.to_string(),
                params: Some(json!({
                    "_remuxOrigin": "test-origin",
                    "cols": 80,
                    "cwd": env!("CARGO_MANIFEST_DIR"),
                    "operationId": "response-barrier-start",
                    "rows": 24,
                    "sessionId": "terminal-test-response-barrier",
                    "shell": shell,
                })),
            },
            &output_tx,
        )
        .expect("start envelope succeeds");

        let first = output_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("start response arrives");
        assert_eq!(first["id"], 91, "early output overtook the start response");
        server.kill_all();
    }

    #[test]
    fn ready_delivers_the_post_attach_tail_before_activating_subscription() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, output_rx) = test_server();
        let session_id = "terminal-test-ready-tail";
        let started = start_test_session(&server, session_id, shell, 80, 24);
        let generation = started["sessionGeneration"].as_u64().unwrap();

        let attached = server
            .attach_session(json!({
                "_remuxOrigin": "ready-test-origin",
                "cols": 80,
                "rows": 24,
                "sessionGeneration": generation,
                "sessionId": session_id,
            }))
            .expect("attach should create a pending subscription");
        let catchup_end = attached["catchupEndSeq"].as_u64().unwrap();
        let token = attached["subscriptionToken"].as_str().unwrap();
        {
            let mut state = server.lock_state().unwrap();
            let session = state.sessions.get_mut(session_id).unwrap();
            let frame = session.append_output(b"after-attach");
            assert_eq!(frame.seq, catchup_end);
        }

        let ready = server
            .ready_session(json!({
                "_remuxOrigin": "ready-test-origin",
                "sessionId": session_id,
                "sessionGeneration": generation,
                "subscriptionToken": token,
                "throughSeq": catchup_end - 1,
            }))
            .expect("ready should deliver the catchup tail");
        assert_eq!(ready["ok"], true);
        assert_eq!(ready["nextOutputSeq"], catchup_end + 1);

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let message = output_rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("ready catchup notification should arrive");
            if message["params"]["frame"]["seq"] == catchup_end {
                assert_eq!(message["remuxTarget"]["origin"], "ready-test-origin");
                break;
            }
        }
        server.kill_all();
    }

    #[test]
    fn replay_pages_stay_pinned_to_the_requested_boundary() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, _output_rx) = test_server();
        let session_id = "terminal-test-fixed-replay-boundary";
        let started = start_test_session(&server, session_id, shell, 80, 24);
        let generation = started["sessionGeneration"].as_u64().unwrap();
        let (from_seq, boundary) = {
            let mut state = server.lock_state().unwrap();
            let session = state.sessions.get_mut(session_id).unwrap();
            let from_seq = session.next_seq;
            session.append_output(b"one");
            session.append_output(b"two");
            session.append_output(b"three");
            (from_seq, session.next_seq)
        };

        let first = server
            .read_replay(json!({
                "fromSeq": from_seq,
                "maxBytes": 1,
                "sessionId": session_id,
                "sessionGeneration": generation,
                "toSeqExclusive": boundary,
            }))
            .unwrap();
        assert_eq!(first["frames"].as_array().unwrap().len(), 1);
        assert_eq!(first["complete"], false);
        let second_from = first["nextSeq"].as_u64().unwrap();

        {
            let mut state = server.lock_state().unwrap();
            state
                .sessions
                .get_mut(session_id)
                .unwrap()
                .append_output(b"outside-boundary");
        }
        let second = server
            .read_replay(json!({
                "fromSeq": second_from,
                "maxBytes": 64,
                "sessionId": session_id,
                "sessionGeneration": generation,
                "toSeqExclusive": boundary,
            }))
            .unwrap();
        assert_eq!(second["complete"], true);
        assert!(
            second["frames"]
                .as_array()
                .unwrap()
                .iter()
                .all(|frame| frame["seq"].as_u64().unwrap() < boundary)
        );
        server.kill_all();
    }

    #[test]
    fn tmux_context_returns_empty_context_without_waiting_for_scan() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, _output_rx) = test_server();
        let session_id = "terminal-test-tmux-cache";

        start_test_session(&server, session_id, shell, 80, 24);
        let started_at = Instant::now();
        let response = server
            .tmux_context(json!({ "sessionId": session_id }))
            .expect("expected tmux context request to return");

        assert!(
            started_at.elapsed() < Duration::from_millis(100),
            "expected first tmux context response to avoid waiting for scan"
        );
        assert_eq!(response["context"]["terminalSessionId"], session_id);
        assert_eq!(response["context"]["mode"], "none");
        assert_eq!(
            response["context"]["sockets"].as_array().map(Vec::len),
            Some(0)
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
        let (session_generation, _, _) = session_input_protocol(&server, session_id);
        server
            .resize_session(json!({
                "cols": 101,
                "rows": 33,
                "sessionId": session_id,
                "sessionGeneration": session_generation,
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
        let (session_generation, input_stream_id, input_seq) =
            session_input_protocol(&server, session_id);
        server
            .kill_session(json!({
                "sessionId": session_id,
                "sessionGeneration": session_generation,
            }))
            .expect("expected kill to succeed");

        let error = server
            .write_session(json!({
                "dataBase64": BASE64.encode(b"echo after-kill\r"),
                "inputSeq": input_seq,
                "inputStreamId": input_stream_id,
                "sessionId": session_id,
                "sessionGeneration": session_generation,
            }))
            .expect_err("expected write to killed session to fail");
        assert!(
            error.contains("terminal session not found"),
            "expected not-found error, got: {error}"
        );
    }

    #[test]
    fn terminal_input_is_generation_checked_sequenced_and_deduplicated() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, _output_rx) = test_server();
        let session_id = "terminal-test-input-sequence";
        let started = start_test_session(&server, session_id, shell, 80, 24);
        let generation = started["sessionGeneration"].as_u64().unwrap();
        let stream_id = started["inputStreamId"].as_str().unwrap();

        let accepted = server
            .write_session(json!({
                "dataBase64": "",
                "inputSeq": 1,
                "inputStreamId": stream_id,
                "sessionId": session_id,
                "sessionGeneration": generation,
            }))
            .unwrap();
        assert_eq!(accepted["nextInputSeq"], 2);
        assert_eq!(accepted["duplicate"], false);

        let duplicate = server
            .write_session(json!({
                "dataBase64": "",
                "inputSeq": 1,
                "inputStreamId": stream_id,
                "sessionId": session_id,
                "sessionGeneration": generation,
            }))
            .unwrap();
        assert_eq!(duplicate["nextInputSeq"], 2);
        assert_eq!(duplicate["duplicate"], true);

        let gap = server
            .write_session(json!({
                "dataBase64": "",
                "inputSeq": 3,
                "inputStreamId": stream_id,
                "sessionId": session_id,
                "sessionGeneration": generation,
            }))
            .unwrap_err();
        assert!(gap.contains("expectedInputSeq=2"));

        let stale = server
            .write_session(json!({
                "dataBase64": "",
                "inputSeq": 2,
                "inputStreamId": stream_id,
                "sessionId": session_id,
                "sessionGeneration": generation + 1,
            }))
            .unwrap_err();
        assert!(stale.contains("stale terminal session generation"));
        server.kill_all();
    }

    #[test]
    fn attach_replaces_an_expired_input_stream() {
        let Some(shell) = test_shell() else {
            return;
        };
        let (server, _output_rx) = test_server();
        let session_id = "terminal-test-expired-input";
        let started = start_test_session(&server, session_id, shell, 80, 24);
        let generation = started["sessionGeneration"].as_u64().unwrap();
        let expired_stream = started["inputStreamId"].as_str().unwrap().to_string();

        {
            let mut state = server.lock_state().unwrap();
            state
                .sessions
                .get_mut(session_id)
                .unwrap()
                .input_streams
                .get_mut(&expired_stream)
                .unwrap()
                .last_seen = Instant::now() - INPUT_STREAM_RECONNECT_LEASE - Duration::from_secs(1);
        }

        let attached = server
            .attach_session(json!({
                "cols": 80,
                "inputStreamId": expired_stream,
                "rows": 24,
                "sessionGeneration": generation,
                "sessionId": session_id,
            }))
            .expect("expired streams should be replaced during attach");
        assert_ne!(attached["inputStreamId"], expired_stream);
        assert_eq!(attached["nextInputSeq"], 1);
        server.kill_all();
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
                "inputSeq": 1,
                "inputStreamId": "missing-input-stream",
                "sessionId": "missing-session",
                "sessionGeneration": 1,
            }))
            .expect_err("expected missing write to fail");
        assert!(write_error.contains("terminal session not found"));
    }

    fn test_server() -> (TerminalExtensionServer, Receiver<Value>) {
        let (output_tx, output_rx) = mpsc::sync_channel(TERMINAL_OUTPUT_QUEUE_CAPACITY);
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
                "operationId": format!("test-start-{session_id}"),
                "rows": rows,
                "sessionId": session_id,
                "shell": shell,
            }))
            .expect("expected test PTY session to start")
    }

    fn write_text(server: &TerminalExtensionServer, session_id: &str, text: &str) {
        let (session_generation, input_stream_id, input_seq) =
            session_input_protocol(server, session_id);
        server
            .write_session(json!({
                "dataBase64": BASE64.encode(text.as_bytes()),
                "inputSeq": input_seq,
                "inputStreamId": input_stream_id,
                "sessionId": session_id,
                "sessionGeneration": session_generation,
            }))
            .expect("expected write to test session to succeed");
    }

    fn session_input_protocol(
        server: &TerminalExtensionServer,
        session_id: &str,
    ) -> (u64, String, u64) {
        let state = server.state.lock().expect("terminal test state available");
        let session = state
            .sessions
            .get(session_id)
            .expect("terminal test session exists");
        let (input_stream_id, input_seq) = session
            .input_streams
            .iter()
            .next()
            .expect("terminal test input stream exists");
        (
            session.generation,
            input_stream_id.clone(),
            input_seq.next_seq,
        )
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

    fn read_until_output_without_response(
        output_rx: &Receiver<Value>,
        session_id: &str,
        expected: &str,
    ) -> String {
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
            assert!(
                !message.get("result").is_some() && !message.get("error").is_some(),
                "id-less write unexpectedly emitted a response: {message:?}",
            );
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
