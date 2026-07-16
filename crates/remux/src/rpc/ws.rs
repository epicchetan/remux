//! WebSocket JSON-RPC server at `/ws`, ported from `cli/wsServer.cjs`.
//!
//! Frame handling follows `handleDownstreamFrame` 1:1: parse errors get an
//! error frame with a null id; responses resolve pending host→client
//! requests; `remux/clients/register` and notification-owned methods are
//! intercepted before the router; `remux/app/log` notifications become
//! journal diagnostics; everything else routes through the RPC router. The
//! notification manager reads the *full* request message (the app sends a
//! top-level `remuxContext` field), so `record_client_request` receives the
//! raw parsed frame.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::response::Response;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, Semaphore};

use crate::rpc::commands::{
    await_outcome, operation_id_hash, CommandAdmission, CommandRegistry, RpcOutcome,
};
use crate::rpc::jsonrpc::{
    error_message, is_json_rpc_request, is_json_rpc_response, parse_json_rpc_frame,
    response_message, with_json_rpc_version, JsonRpcError, EXTENSION_ERROR, INVALID_REQUEST,
};
use crate::rpc::router::{extension_id_from_method, BoxFuture, RpcResult, RpcRouter};
use crate::time::now_iso8601;

pub const REMUX_WEB_SOCKET_PATH: &str = "/ws";
pub const DEFAULT_HOST_REQUEST_TIMEOUT_MS: u64 = 1_000;
const MAX_CLIENT_OUTSTANDING_REQUESTS: usize = 64;
const DEFAULT_LANE_CAPACITY: usize = 64;
const CONTROL_LANE_CAPACITY: usize = 32;
const CONTROL_CONCURRENCY: usize = 4;
const BUSINESS_CONCURRENCY: usize = 8;
const MAX_OUTBOUND_FRAMES: usize = 256;
const CONTROL_OUTBOUND_FRAMES: usize = 32;
const BUSINESS_OUTBOUND_FRAMES: usize = MAX_OUTBOUND_FRAMES - CONTROL_OUTBOUND_FRAMES;
const MAX_OUTBOUND_BYTES: usize = 8 * 1024 * 1024;
const MAX_ROUTE_LANES: usize = 512;
const MAX_RETAINED_JOBS: usize = 256;

struct OutboundFrame {
    bytes: usize,
    message: Message,
}

enum DispatchWork {
    Notification { params: Option<Value> },
    Request { id: Value, message: Value },
}

struct DispatchJob {
    client: Arc<WsClient>,
    lane_key: String,
    method: String,
    received_at: std::time::Instant,
    work: DispatchWork,
}

#[derive(Clone, Copy)]
enum DispatchMode {
    Serial,
    ConcurrentControl,
    ConcurrentBusiness,
}

/// One connected downstream client. Shared with the notification manager,
/// which stamps `client_id`/`session_id` at registration and issues
/// host→client requests (visibility checks).
pub struct WsClient {
    outbound: mpsc::Sender<OutboundFrame>,
    control_outbound: mpsc::Sender<OutboundFrame>,
    outbound_bytes: AtomicUsize,
    disconnect: tokio::sync::Notify,
    next_request_id: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, JsonRpcError>>>>,
    registration_pending: AtomicUsize,
    registration_committed: tokio::sync::Notify,
    pub client_id: Mutex<Option<String>>,
    pub session_id: Mutex<Option<String>>,
    pub(crate) connection_id: u64,
    next_origin_id: AtomicU64,
    origins: Mutex<HashMap<String, String>>,
    active_requests: Mutex<HashMap<String, Option<Arc<tokio::sync::Notify>>>>,
    connected: AtomicBool,
    outstanding_requests: AtomicUsize,
}

impl WsClient {
    fn new(
        outbound: mpsc::Sender<OutboundFrame>,
        control_outbound: mpsc::Sender<OutboundFrame>,
        connection_id: u64,
    ) -> Arc<Self> {
        Arc::new(Self {
            outbound,
            control_outbound,
            outbound_bytes: AtomicUsize::new(0),
            disconnect: tokio::sync::Notify::new(),
            next_request_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            registration_pending: AtomicUsize::new(0),
            registration_committed: tokio::sync::Notify::new(),
            client_id: Mutex::new(None),
            session_id: Mutex::new(None),
            connection_id,
            next_origin_id: AtomicU64::new(1),
            origins: Mutex::new(HashMap::new()),
            active_requests: Mutex::new(HashMap::new()),
            connected: AtomicBool::new(true),
            outstanding_requests: AtomicUsize::new(0),
        })
    }

    pub fn send_message(&self, payload: &Value) -> bool {
        self.enqueue_message(Message::Text(payload.to_string().into()), false)
    }

    fn send_control_message(&self, payload: &Value) -> bool {
        self.enqueue_message(Message::Text(payload.to_string().into()), true)
    }

    fn enqueue_message(&self, message: Message, control: bool) -> bool {
        if !self.is_connected() {
            return false;
        }
        let bytes = match &message {
            Message::Text(text) => text.len(),
            Message::Binary(data) => data.len(),
            _ => 0,
        };
        if self
            .outbound_bytes
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |queued| {
                queued
                    .checked_add(bytes)
                    .filter(|next| *next <= MAX_OUTBOUND_BYTES)
            })
            .is_err()
        {
            self.force_disconnect();
            return false;
        }
        let outbound = if control {
            &self.control_outbound
        } else {
            &self.outbound
        };
        match outbound.try_send(OutboundFrame { bytes, message }) {
            Ok(()) => true,
            Err(_) => {
                self.outbound_bytes.fetch_sub(bytes, Ordering::SeqCst);
                self.force_disconnect();
                false
            }
        }
    }

    /// Host→client request (`remux-host:<n>` ids, default timeout 1s;
    /// visibility checks pass 500ms).
    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
        timeout_ms: u64,
    ) -> Result<Value, JsonRpcError> {
        let id = format!(
            "remux-host:{}",
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        let mut payload = serde_json::Map::new();
        payload.insert("jsonrpc".to_string(), Value::from("2.0"));
        payload.insert("id".to_string(), Value::from(id.clone()));
        payload.insert("method".to_string(), Value::from(method));
        if let Some(params) = params {
            payload.insert("params".to_string(), params);
        }

        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), sender);
        if !self.send_control_message(&Value::Object(payload)) {
            self.pending.lock().unwrap().remove(&id);
            return Err(JsonRpcError::new(
                EXTENSION_ERROR,
                format!("{method} could not be queued for the client"),
            ));
        }

        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(JsonRpcError::new(
                EXTENSION_ERROR,
                format!("{method} rejected"),
            )),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("{method} timed out"),
                ))
            }
        }
    }

    /// Resolves a pending host→client request from a downstream response.
    /// Returns false when the id is unknown (logged as unmatched).
    pub fn resolve_pending_request(&self, message: &Value) -> bool {
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            return false;
        };
        let Some(pending) = self.pending.lock().unwrap().remove(id) else {
            return false;
        };

        let outcome = match message.get("error") {
            Some(error) if !error.is_null() => Err(JsonRpcError {
                code: error
                    .get("code")
                    .and_then(Value::as_i64)
                    .unwrap_or(EXTENSION_ERROR),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Client request failed")
                    .to_string(),
                data: error.get("data").cloned(),
            }),
            _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = pending.send(outcome);
        true
    }

    pub fn reject_pending_requests(&self) {
        self.pending.lock().unwrap().clear();
    }

    fn close(&self) {
        let _ = self.enqueue_message(Message::Close(None), true);
        self.disconnect.notify_waiters();
    }

    fn mark_disconnected(&self) {
        self.connected.store(false, Ordering::SeqCst);
        let cancellations: Vec<Arc<tokio::sync::Notify>> = self
            .active_requests
            .lock()
            .unwrap()
            .drain()
            .filter_map(|(_, cancellation)| cancellation)
            .collect();
        for cancellation in cancellations {
            cancellation.notify_waiters();
        }
        self.registration_committed.notify_waiters();
    }

    fn force_disconnect(&self) {
        self.mark_disconnected();
        self.disconnect.notify_waiters();
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    fn origin_for_context(&self, context: Option<&Value>) -> String {
        let context_key = context
            .and_then(|value| serde_json::to_string(value).ok())
            .unwrap_or_else(|| "null".to_string());
        let mut origins = self.origins.lock().unwrap();
        origins
            .entry(context_key)
            .or_insert_with(|| {
                format!(
                    "remux-origin-{}-{}",
                    self.connection_id,
                    self.next_origin_id.fetch_add(1, Ordering::Relaxed)
                )
            })
            .clone()
    }

    fn owns_origin(&self, origin: &str) -> bool {
        self.origins
            .lock()
            .unwrap()
            .values()
            .any(|candidate| candidate == origin)
    }

    fn register_request(&self, id: &Value) -> bool {
        self.active_requests
            .lock()
            .unwrap()
            .insert(request_key(id), None)
            .is_none()
    }

    fn begin_request(&self, id: &Value) -> Option<Arc<tokio::sync::Notify>> {
        let key = request_key(id);
        let mut active = self.active_requests.lock().unwrap();
        let slot = active.get_mut(&key)?;
        let cancellation = Arc::new(tokio::sync::Notify::new());
        *slot = Some(cancellation.clone());
        Some(cancellation)
    }

    fn finish_request(&self, id: &Value) {
        self.active_requests
            .lock()
            .unwrap()
            .remove(&request_key(id));
    }

    fn cancel_request(&self, id: &Value) -> bool {
        let removed = self
            .active_requests
            .lock()
            .unwrap()
            .remove(&request_key(id));
        match removed {
            Some(Some(cancellation)) => {
                cancellation.notify_one();
                true
            }
            Some(None) => true,
            None => false,
        }
    }
}

fn request_key(id: &Value) -> String {
    id.to_string()
}

/// Hooks the notification manager registers with the WS layer
/// (`wsServer.cjs` `notifications` parameter).
pub trait NotificationsHook: Send + Sync {
    fn can_handle_client_request(&self, method: &str) -> bool;
    fn handle_client_request(
        &self,
        client: Arc<WsClient>,
        method: String,
        params: Option<Value>,
    ) -> BoxFuture<'_, RpcResult>;
    fn record_client_request(&self, client: &Arc<WsClient>, request: &Value, result: &Value);
    fn on_client_disconnected(&self, client: &Arc<WsClient>);
}

/// Relay hook: the git-status poller runs only while clients are connected.
pub trait ClientCountListener: Send + Sync {
    fn on_client_count_changed(&self, count: usize);
}

/// Per-client request hook for additive client-scoped methods
/// (`remux/extensions/logs/subscribe|unsubscribe`); returns `None` when the
/// method is not client-scoped.
pub trait ClientScopedRpc: Send + Sync {
    fn handle(
        &self,
        client: &Arc<WsClient>,
        method: &str,
        params: Option<&Value>,
    ) -> Option<RpcResult>;
}

#[derive(Debug, Clone)]
pub struct DiagnosticEvent {
    pub detail: Option<Value>,
    pub label: String,
    pub level: &'static str,
    pub message: String,
    pub ts: Option<String>,
}

/// Journal-facing logging contract for the WS layer (the Node `log`
/// parameter: console-shaped with an optional structured `event`).
pub trait WsLog: Send + Sync {
    fn log(&self, message: &str);
    fn warn(&self, message: &str);
    fn error(&self, message: &str);
    fn event(&self, event: DiagnosticEvent);
}

#[derive(Default)]
pub struct WsHooks {
    pub notifications: Option<Arc<dyn NotificationsHook>>,
    pub client_count: Option<Arc<dyn ClientCountListener>>,
    /// Tried in order; the first hook that recognizes the method wins.
    pub client_scoped: Vec<Arc<dyn ClientScopedRpc>>,
}

pub struct WsServer {
    clients: Mutex<Vec<Arc<WsClient>>>,
    router: Arc<RpcRouter>,
    hooks: WsHooks,
    log: Arc<dyn WsLog>,
    next_connection_id: AtomicU64,
    dispatch_lanes: Mutex<HashMap<String, mpsc::Sender<DispatchJob>>>,
    control_permits: Arc<Semaphore>,
    business_permits: Arc<Semaphore>,
    jobs: Mutex<HashMap<String, JobState>>,
    commands: CommandRegistry,
}

#[derive(Clone)]
struct JobState {
    method: String,
    operation_id: String,
    revision: u64,
    state: &'static str,
    error: Option<String>,
    result: Option<Value>,
    abort: Option<tokio::task::AbortHandle>,
}

impl JobState {
    fn value(&self) -> Value {
        serde_json::json!({
            "error": self.error,
            "method": self.method,
            "operationId": self.operation_id,
            "result": self.result,
            "revision": self.revision,
            "state": self.state,
        })
    }
}

impl WsServer {
    pub fn new(router: Arc<RpcRouter>, hooks: WsHooks, log: Arc<dyn WsLog>) -> Arc<Self> {
        Arc::new(Self {
            clients: Mutex::new(Vec::new()),
            router,
            hooks,
            log,
            next_connection_id: AtomicU64::new(1),
            dispatch_lanes: Mutex::new(HashMap::new()),
            control_permits: Arc::new(Semaphore::new(CONTROL_CONCURRENCY)),
            business_permits: Arc::new(Semaphore::new(BUSINESS_CONCURRENCY)),
            jobs: Mutex::new(HashMap::new()),
            commands: CommandRegistry::default(),
        })
    }

    /// Router for the `/ws` upgrade; merged with the HTTP router.
    pub fn route(self: &Arc<Self>) -> axum::Router {
        axum::Router::new()
            .route(REMUX_WEB_SOCKET_PATH, axum::routing::get(upgrade_handler))
            .with_state(self.clone())
    }

    pub fn client_count(&self) -> usize {
        self.clients.lock().unwrap().len()
    }

    /// Fan-out of `withJsonRpcVersion` frames to all connected clients. A
    /// failed send means the client's writer task died; drop that client.
    pub fn broadcast(&self, message: Value) {
        let payload = with_json_rpc_version(message);
        let text = payload.to_string();
        let mut clients = self.clients.lock().unwrap();
        clients.retain(|client| client.enqueue_message(Message::Text(text.clone().into()), false));
    }

    /// Deliver one extension notification only to the downstream origin that
    /// issued the subscription request. Origins are opaque to extensions and
    /// disappear with the owning socket.
    pub fn send_to_origin(&self, origin: &str, message: Value) -> bool {
        let payload = with_json_rpc_version(message);
        let clients = self.clients.lock().unwrap();
        let Some(client) = clients.iter().find(|client| client.owns_origin(origin)) else {
            return false;
        };
        client.send_message(&payload);
        true
    }

    pub fn close(&self) {
        let clients: Vec<Arc<WsClient>> = self.clients.lock().unwrap().drain(..).collect();
        for client in clients {
            client.mark_disconnected();
            client.close();
            client.reject_pending_requests();
        }
    }

    fn remove_client(&self, client: &Arc<WsClient>) {
        client.mark_disconnected();
        let mut clients = self.clients.lock().unwrap();
        clients.retain(|candidate| !Arc::ptr_eq(candidate, client));
        let count = clients.len();
        drop(clients);
        if let Some(listener) = &self.hooks.client_count {
            listener.on_client_count_changed(count);
        }
    }

    async fn handle_socket(self: Arc<Self>, socket: WebSocket, remote: Option<String>) {
        let (outbound_tx, mut outbound_rx) =
            mpsc::channel::<OutboundFrame>(BUSINESS_OUTBOUND_FRAMES);
        let (control_outbound_tx, mut control_outbound_rx) =
            mpsc::channel::<OutboundFrame>(CONTROL_OUTBOUND_FRAMES);
        let client = WsClient::new(
            outbound_tx,
            control_outbound_tx,
            self.next_connection_id.fetch_add(1, Ordering::Relaxed),
        );

        {
            let mut clients = self.clients.lock().unwrap();
            clients.push(client.clone());
            let count = clients.len();
            drop(clients);
            if let Some(listener) = &self.hooks.client_count {
                listener.on_client_count_changed(count);
            }
        }
        self.log.log(&format!(
            "[remux] websocket opened {}",
            remote.as_deref().unwrap_or("unknown-remote")
        ));

        use futures_util::{SinkExt, StreamExt};
        let (mut sink, mut stream) = socket.split();

        let client_for_writer = client.clone();
        let writer = tokio::spawn(async move {
            loop {
                let frame = tokio::select! {
                    biased;
                    frame = control_outbound_rx.recv() => frame,
                    frame = outbound_rx.recv() => frame,
                };
                let Some(frame) = frame else {
                    break;
                };
                client_for_writer
                    .outbound_bytes
                    .fetch_sub(frame.bytes, Ordering::SeqCst);
                let closing = matches!(frame.message, Message::Close(_));
                if sink.send(frame.message).await.is_err() || closing {
                    break;
                }
            }
        });

        let mut close_code = String::from("(unknown)");
        let mut close_reason = String::new();
        loop {
            let frame = tokio::select! {
                _ = client.disconnect.notified() => break,
                frame = stream.next() => frame,
            };
            let Some(frame) = frame else {
                break;
            };
            match frame {
                Ok(Message::Text(text)) => {
                    self.handle_downstream_frame(&client, text.as_str());
                }
                Ok(Message::Binary(data)) => {
                    let text = String::from_utf8_lossy(&data).into_owned();
                    self.handle_downstream_frame(&client, &text);
                }
                Ok(Message::Close(frame)) => {
                    if let Some(frame) = frame {
                        close_code = frame.code.to_string();
                        close_reason = frame.reason.to_string();
                    }
                    break;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }

        self.remove_client(&client);
        client.reject_pending_requests();
        if let Some(notifications) = &self.hooks.notifications {
            notifications.on_client_disconnected(&client);
        }
        self.log.log(&format!(
            "[remux] websocket closed code={close_code} reason={}",
            if close_reason.is_empty() {
                "(empty)"
            } else {
                close_reason.as_str()
            }
        ));
        writer.abort();
    }

    fn handle_downstream_frame(self: &Arc<Self>, client: &Arc<WsClient>, frame: &str) {
        let parsed = parse_json_rpc_frame(frame);
        if let Some(error) = parsed.error {
            client.send_control_message(&error_message(&parsed.id, &error));
            return;
        }
        let Some(message) = parsed.message else {
            return;
        };

        if is_json_rpc_response(&message) {
            if !client.resolve_pending_request(&message) {
                self.log.warn(&format!(
                    "[remux] ignored unmatched downstream response: {}",
                    message.get("id").cloned().unwrap_or(Value::Null)
                ));
            }
            return;
        }

        if !is_json_rpc_request(&message) {
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                if method == "remux/app/log" {
                    log_app_diagnostic(message.get("params"), self.log.as_ref());
                    return;
                }
                if method == "$/cancelRequest" {
                    if let Some(id) = message.get("params").and_then(|params| params.get("id")) {
                        if client.cancel_request(id) {
                            self.log.log(&format!(
                                "[remux] rpc canceled connection={} id={id}",
                                client.connection_id
                            ));
                        }
                    }
                    return;
                }
                if !is_downstream_notification_method(method) {
                    self.log.warn(&format!(
                        "[remux] rejected notification for must-ack method={method}"
                    ));
                    return;
                }
                self.enqueue_dispatch(
                    client,
                    method.to_string(),
                    DispatchWork::Notification {
                        params: message.get("params").cloned(),
                    },
                );
                return;
            }

            client.send_control_message(&error_message(
                &parsed.id,
                &JsonRpcError::new(INVALID_REQUEST, "Invalid request"),
            ));
            return;
        }

        let method = message
            .get("method")
            .and_then(Value::as_str)
            .expect("validated request")
            .to_string();
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        if !valid_remux_contract(message.get("remuxContract")) {
            client.send_control_message(&error_message(
                &id,
                &JsonRpcError::new(INVALID_REQUEST, "Invalid or missing remuxContract"),
            ));
            return;
        }
        self.enqueue_dispatch(client, method, DispatchWork::Request { id, message });
    }

    fn enqueue_dispatch(
        self: &Arc<Self>,
        client: &Arc<WsClient>,
        method: String,
        work: DispatchWork,
    ) {
        let is_request = matches!(&work, DispatchWork::Request { .. });
        let is_registration = is_request && method == "remux/clients/register";
        if is_registration {
            client.registration_pending.fetch_add(1, Ordering::SeqCst);
        }
        if is_request
            && client
                .outstanding_requests
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                    (count < MAX_CLIENT_OUTSTANDING_REQUESTS).then_some(count + 1)
                })
                .is_err()
        {
            if let DispatchWork::Request { id, .. } = &work {
                client.send_control_message(&error_message(id, &server_busy_error(&method)));
            }
            if is_registration {
                complete_registration_barrier(client);
            }
            return;
        }
        if let DispatchWork::Request { id, .. } = &work {
            if !client.register_request(id) {
                client.outstanding_requests.fetch_sub(1, Ordering::SeqCst);
                client.send_control_message(&error_message(
                    id,
                    &JsonRpcError::new(INVALID_REQUEST, "Duplicate request id"),
                ));
                if is_registration {
                    complete_registration_barrier(client);
                }
                return;
            }
        }

        let (lane_key, mode) = dispatch_lane(client, &method, &work);
        let Some(sender) = self.dispatch_sender(lane_key.clone(), mode) else {
            if is_request {
                client.outstanding_requests.fetch_sub(1, Ordering::SeqCst);
                if let DispatchWork::Request { id, .. } = &work {
                    client.finish_request(id);
                    client.send_control_message(&error_message(id, &server_busy_error(&method)));
                }
                if is_registration {
                    complete_registration_barrier(client);
                }
            } else {
                self.log.warn(&format!(
                    "[remux] dropped notification because route lane limit was reached method={method}"
                ));
            }
            return;
        };
        let job = DispatchJob {
            client: client.clone(),
            lane_key: lane_key.clone(),
            method: method.clone(),
            received_at: std::time::Instant::now(),
            work,
        };
        if let Err(error) = sender.try_send(job) {
            let job = error.into_inner();
            if is_request {
                job.client
                    .outstanding_requests
                    .fetch_sub(1, Ordering::SeqCst);
                if let DispatchWork::Request { id, .. } = &job.work {
                    job.client.finish_request(id);
                    job.client
                        .send_control_message(&error_message(id, &server_busy_error(&method)));
                }
                if is_registration {
                    complete_registration_barrier(&job.client);
                }
            } else {
                self.log.warn(&format!(
                    "[remux] dropped overloaded notification method={method} lane={lane_key}"
                ));
            }
        }
    }

    fn dispatch_sender(
        self: &Arc<Self>,
        lane_key: String,
        mode: DispatchMode,
    ) -> Option<mpsc::Sender<DispatchJob>> {
        let mut lanes = self.dispatch_lanes.lock().unwrap();
        if let Some(sender) = lanes.get(&lane_key) {
            return Some(sender.clone());
        }
        if lanes.len() >= MAX_ROUTE_LANES {
            self.log.warn(&format!(
                "[remux] route lane limit reached limit={MAX_ROUTE_LANES} lane={lane_key}"
            ));
            return None;
        }

        let capacity = if matches!(mode, DispatchMode::ConcurrentControl) {
            CONTROL_LANE_CAPACITY
        } else {
            DEFAULT_LANE_CAPACITY
        };
        let (sender, mut receiver) = mpsc::channel::<DispatchJob>(capacity);
        lanes.insert(lane_key, sender.clone());
        drop(lanes);

        let server = self.clone();
        tokio::spawn(async move {
            while let Some(job) = receiver.recv().await {
                match mode {
                    DispatchMode::Serial => server.clone().execute_dispatch(job).await,
                    DispatchMode::ConcurrentControl | DispatchMode::ConcurrentBusiness => {
                        let permits = if matches!(mode, DispatchMode::ConcurrentControl) {
                            server.control_permits.clone()
                        } else {
                            server.business_permits.clone()
                        };
                        let Ok(permit) = permits.acquire_owned().await else {
                            break;
                        };
                        let server = server.clone();
                        tokio::spawn(async move {
                            server.execute_dispatch(job).await;
                            drop(permit);
                        });
                    }
                }
            }
        });
        Some(sender)
    }

    async fn execute_dispatch(self: Arc<Self>, job: DispatchJob) {
        let is_request = matches!(&job.work, DispatchWork::Request { .. });
        let is_registration = is_request && job.method == "remux/clients/register";
        let method = job.method.clone();
        let lane_key = job.lane_key.clone();
        let slow_threshold_ms = dispatch_slow_threshold_ms(&method, &job.work);
        let queue_ms = job.received_at.elapsed().as_millis();
        if queue_ms >= 250 {
            self.log.warn(&format!(
                "[remux] rpc queue delay method={method} lane={lane_key} queue_ms={queue_ms}"
            ));
        }
        let execution_started = std::time::Instant::now();
        if !is_registration {
            loop {
                let notified = job.client.registration_committed.notified();
                if job.client.registration_pending.load(Ordering::SeqCst) == 0
                    || !job.client.is_connected()
                {
                    break;
                }
                notified.await;
            }
        }
        if job.client.is_connected() {
            match job.work {
                DispatchWork::Notification { params } => {
                    self.router.handle_notification(&job.method, params);
                }
                DispatchWork::Request { id, message } => {
                    self.clone()
                        .handle_request_message(
                            job.client.clone(),
                            message,
                            job.method,
                            id,
                            job.received_at,
                        )
                        .await;
                }
            }
        }
        if is_request {
            job.client
                .outstanding_requests
                .fetch_sub(1, Ordering::SeqCst);
        }
        if is_registration {
            complete_registration_barrier(&job.client);
        }
        let execution_ms = execution_started.elapsed().as_millis();
        if execution_ms >= u128::from(slow_threshold_ms) {
            self.log.warn(&format!(
                "[remux] rpc:slow method={method} lane={lane_key} execution_ms={execution_ms} threshold_ms={slow_threshold_ms}"
            ));
        }
    }

    async fn handle_request_message(
        self: Arc<Self>,
        client: Arc<WsClient>,
        message: Value,
        method: String,
        id: Value,
        received_at: std::time::Instant,
    ) {
        let Some(cancellation) = client.begin_request(&id) else {
            return;
        };
        if let Some(operation_id) = durable_command_operation_id(&message).map(str::to_string) {
            self.clone()
                .handle_durable_command(client.clone(), message, method, operation_id, id.clone())
                .await;
            client.finish_request(&id);
            return;
        }
        if message
            .get("remuxContract")
            .and_then(|contract| contract.get("kind"))
            .and_then(Value::as_str)
            == Some("job-start")
            && method != "remux/narrate/narration/start"
        {
            self.clone()
                .start_job(client.clone(), message, method, id.clone())
                .await;
            client.finish_request(&id);
            return;
        }
        let server = self.clone();
        let request_client = client.clone();
        let request_id = id.clone();
        tokio::select! {
            _ = cancellation.notified() => {
                self.log.log(&format!(
                    "[remux] rpc cancellation completed connection={} method={method} id={id}",
                    client.connection_id
                ));
            }
            _ = server.handle_request_message_uncancelled(
                request_client,
                message,
                method.clone(),
                request_id,
                received_at,
            ) => {}
        }
        client.finish_request(&id);
    }

    async fn handle_durable_command(
        self: Arc<Self>,
        client: Arc<WsClient>,
        message: Value,
        method: String,
        operation_id: String,
        id: Value,
    ) {
        let admission = self
            .commands
            .admit(&method, &operation_id, message.get("params"));
        let operation_id_hash = operation_id_hash(&operation_id);
        let execution_started = std::time::Instant::now();
        let outcome = match admission {
            Err(error) => {
                self.log.event(DiagnosticEvent {
                    detail: Some(serde_json::json!({
                        "admission": if error.data.as_ref().and_then(|data| data.get("detail")).and_then(Value::as_str) == Some("operation_id_conflict") {
                            "conflict"
                        } else {
                            "capacity-rejected"
                        },
                        "connectionGeneration": client.connection_id,
                        "method": &method,
                        "operationIdHash": &operation_id_hash,
                    })),
                    label: "rpc:durable-command".to_string(),
                    level: "warn",
                    message: "durable command rejected".to_string(),
                    ts: None,
                });
                RpcOutcome::Error(error)
            }
            Ok(CommandAdmission::Replay {
                completed,
                receiver,
            }) => {
                self.log.event(DiagnosticEvent {
                    detail: Some(serde_json::json!({
                        "admission": if completed { "replayed" } else { "joined" },
                        "connectionGeneration": client.connection_id,
                        "method": &method,
                        "operationIdHash": &operation_id_hash,
                    })),
                    label: "rpc:durable-command".to_string(),
                    level: "info",
                    message: "durable command replay".to_string(),
                    ts: None,
                });
                match await_outcome(receiver).await {
                    Ok(outcome) => outcome,
                    Err(error) => RpcOutcome::Error(error),
                }
            }
            Ok(CommandAdmission::Execute(execution)) => {
                self.log.event(DiagnosticEvent {
                    detail: Some(serde_json::json!({
                        "admission": "new",
                        "connectionGeneration": client.connection_id,
                        "method": &method,
                        "operationIdHash": &operation_id_hash,
                    })),
                    label: "rpc:durable-command".to_string(),
                    level: "info",
                    message: "durable command admitted".to_string(),
                    ts: None,
                });
                let outcome = match self
                    .execute_routed_request(&client, &message, &method)
                    .await
                {
                    Ok(result) => {
                        if let Some(notifications) = &self.hooks.notifications {
                            notifications.record_client_request(&client, &message, &result);
                        }
                        RpcOutcome::Result(result)
                    }
                    Err(error) => RpcOutcome::Error(error),
                };
                let (outcome, retained_bytes) = self.commands.complete(execution, outcome);
                self.log.event(DiagnosticEvent {
                    detail: Some(serde_json::json!({
                        "connectionGeneration": client.connection_id,
                        "executionMs": execution_started.elapsed().as_millis(),
                        "method": &method,
                        "operationIdHash": &operation_id_hash,
                        "retainedBytes": retained_bytes,
                    })),
                    label: "rpc:durable-command-completed".to_string(),
                    level: "info",
                    message: "durable command completed".to_string(),
                    ts: None,
                });
                outcome
            }
        };

        match outcome {
            RpcOutcome::Result(result) => {
                client.send_control_message(&response_message(&id, result));
            }
            RpcOutcome::Error(error) => {
                client.send_control_message(&error_message(&id, &error));
            }
        }
    }

    async fn execute_routed_request(
        &self,
        client: &Arc<WsClient>,
        message: &Value,
        method: &str,
    ) -> RpcResult {
        let params = message.get("params");
        let handled_by_notifications = self
            .hooks
            .notifications
            .as_ref()
            .map(|notifications| notifications.can_handle_client_request(method))
            .unwrap_or(false);

        if handled_by_notifications {
            return self
                .hooks
                .notifications
                .as_ref()
                .expect("checked above")
                .handle_client_request(client.clone(), method.to_string(), params.cloned())
                .await;
        }

        let routed_params = if self.router.routes_to_extension(method) {
            let origin = client.origin_for_context(message.get("remuxContext"));
            let viewer_key = message
                .get("remuxContext")
                .map(Value::to_string)
                .unwrap_or_else(|| origin.clone());
            params_with_origin(params, origin, viewer_key)
        } else {
            params.cloned()
        };
        self.router
            .handle_request(method, routed_params.as_ref())
            .await
    }

    async fn start_job(
        self: Arc<Self>,
        client: Arc<WsClient>,
        message: Value,
        method: String,
        request_id: Value,
    ) {
        let Some(operation_id) = message
            .get("remuxContract")
            .and_then(|contract| contract.get("operationId"))
            .and_then(Value::as_str)
            .filter(|operation_id| !operation_id.is_empty())
            .map(str::to_string)
        else {
            client.send_control_message(&error_message(
                &request_id,
                &JsonRpcError::new(INVALID_REQUEST, "job-start requires operationId"),
            ));
            return;
        };

        let admission = {
            let mut jobs = self.jobs.lock().unwrap();
            if let Some(existing) = jobs.get(&operation_id) {
                Some((false, existing.revision))
            } else {
                if jobs.len() >= MAX_RETAINED_JOBS {
                    let terminal = jobs
                        .iter()
                        .find(|(_, job)| matches!(job.state, "completed" | "failed" | "canceled"))
                        .map(|(operation_id, _)| operation_id.clone());
                    if let Some(terminal) = terminal {
                        jobs.remove(&terminal);
                    }
                }
                if jobs.len() >= MAX_RETAINED_JOBS {
                    None
                } else {
                    jobs.insert(
                        operation_id.clone(),
                        JobState {
                            method: method.clone(),
                            operation_id: operation_id.clone(),
                            revision: 1,
                            state: "accepted",
                            error: None,
                            result: None,
                            abort: None,
                        },
                    );
                    Some((true, 1))
                }
            }
        };
        let Some((accepted, revision)) = admission else {
            client.send_control_message(&error_message(
                &request_id,
                &server_busy_error("remux/jobs"),
            ));
            return;
        };
        client.send_control_message(&response_message(
            &request_id,
            serde_json::json!({
                "accepted": accepted,
                "operationId": operation_id.clone(),
                "revision": revision,
            }),
        ));
        if !accepted {
            return;
        }

        self.broadcast_job(&operation_id);
        let server = self.clone();
        let operation_for_task = operation_id.clone();
        let task = tokio::spawn(async move {
            server.update_job(&operation_for_task, "running", None, None);
            let params = message.get("params");
            let routed_params = if server.router.routes_to_extension(&method) {
                let origin = client.origin_for_context(message.get("remuxContext"));
                let viewer_key = message
                    .get("remuxContext")
                    .map(Value::to_string)
                    .unwrap_or_else(|| origin.clone());
                params_with_origin(params, origin, viewer_key)
            } else {
                params.cloned()
            };
            match server
                .router
                .handle_request(&method, routed_params.as_ref())
                .await
            {
                Ok(result) => {
                    server.update_job(&operation_for_task, "completed", None, Some(result))
                }
                Err(error) => {
                    server.update_job(&operation_for_task, "failed", Some(error.message), None)
                }
            }
        });
        if let Some(job) = self.jobs.lock().unwrap().get_mut(&operation_id) {
            if !matches!(job.state, "completed" | "failed" | "canceled") {
                job.abort = Some(task.abort_handle());
            }
        }
    }

    fn update_job(
        &self,
        operation_id: &str,
        state: &'static str,
        error: Option<String>,
        result: Option<Value>,
    ) {
        if let Some(job) = self.jobs.lock().unwrap().get_mut(operation_id) {
            job.revision = job.revision.saturating_add(1);
            job.state = state;
            job.error = error;
            job.result = result;
            if matches!(state, "completed" | "failed" | "canceled") {
                job.abort = None;
            }
        }
        self.broadcast_job(operation_id);
    }

    fn broadcast_job(&self, operation_id: &str) {
        let job = self.jobs.lock().unwrap().get(operation_id).cloned();
        if let Some(job) = job {
            self.broadcast(serde_json::json!({
                "method": "remux/jobs/didChange",
                "params": job.value(),
            }));
        }
    }

    async fn handle_request_message_uncancelled(
        self: Arc<Self>,
        client: Arc<WsClient>,
        message: Value,
        method: String,
        id: Value,
        _received_at: std::time::Instant,
    ) {
        let params = message.get("params");

        if method == "remux/jobs/read" {
            let operation_id = params
                .and_then(|params| params.get("operationId"))
                .and_then(Value::as_str);
            let result = operation_id
                .and_then(|operation_id| self.jobs.lock().unwrap().get(operation_id).cloned())
                .map(|job| job.value())
                .unwrap_or(Value::Null);
            client.send_control_message(&response_message(&id, result));
            return;
        }
        if method == "remux/jobs/cancel" {
            let operation_id = params
                .and_then(|params| params.get("operationId"))
                .and_then(Value::as_str);
            let abort = operation_id.and_then(|operation_id| {
                self.jobs
                    .lock()
                    .unwrap()
                    .get_mut(operation_id)
                    .and_then(|job| job.abort.take())
            });
            let accepted = abort.is_some();
            if let Some(abort) = abort {
                abort.abort();
                if let Some(operation_id) = operation_id {
                    self.update_job(operation_id, "canceled", None, None);
                }
            }
            client.send_control_message(&response_message(
                &id,
                serde_json::json!({
                    "accepted": accepted,
                    "operationId": operation_id,
                }),
            ));
            return;
        }

        for client_scoped in &self.hooks.client_scoped {
            if let Some(result) = client_scoped.handle(&client, &method, params) {
                match result {
                    Ok(result) => {
                        client.send_control_message(&response_message(&id, result));
                    }
                    Err(error) => {
                        client.send_control_message(&error_message(&id, &error));
                    }
                }
                return;
            }
        }

        let result = self
            .execute_routed_request(&client, &message, &method)
            .await;

        match result {
            Ok(result) => {
                if let Some(notifications) = &self.hooks.notifications {
                    notifications.record_client_request(&client, &message, &result);
                }
                client.send_control_message(&response_message(&id, result));
            }
            Err(error) => {
                client.send_control_message(&error_message(&id, &error));
            }
        }
    }
}

fn durable_command_operation_id(message: &Value) -> Option<&str> {
    let contract = message.get("remuxContract")?;
    (contract.get("kind").and_then(Value::as_str) == Some("command"))
        .then(|| contract.get("operationId").and_then(Value::as_str))
        .flatten()
}

fn dispatch_lane(client: &WsClient, method: &str, work: &DispatchWork) -> (String, DispatchMode) {
    if matches!(method, "remux/system/ping" | "remux/system/info") {
        return (
            "control:liveness".to_string(),
            DispatchMode::ConcurrentControl,
        );
    }
    if matches!(
        method,
        "remux/clients/register"
            | "remux/system/resources/subscribe"
            | "remux/system/resources/unsubscribe"
            | "remux/extensions/logs/subscribe"
            | "remux/extensions/logs/unsubscribe"
    ) {
        return (
            format!("control:connection:{}", client.connection_id),
            DispatchMode::Serial,
        );
    }
    if matches!(
        method,
        "remux/system/resources" | "remux/extensions/status" | "remux/extensions/logs"
    ) {
        return (
            "control:snapshots".to_string(),
            DispatchMode::ConcurrentControl,
        );
    }
    if method == "remux/system/restart" {
        return ("control:restart".to_string(), DispatchMode::Serial);
    }
    if method.starts_with("remux/fs/") {
        return (
            "core:filesystem".to_string(),
            DispatchMode::ConcurrentBusiness,
        );
    }
    if method.starts_with("remux/narrate/narration/") {
        let mode = if matches!(
            method,
            "remux/narrate/narration/audio/read"
                | "remux/narrate/narration/resources/read"
                | "remux/narrate/narration/diagnostics/read"
        ) {
            DispatchMode::ConcurrentBusiness
        } else {
            DispatchMode::Serial
        };
        return ("extension:narrate:narration".to_string(), mode);
    }
    if matches!(
        method,
        "remux/extensions/start"
            | "remux/extensions/stop"
            | "remux/extensions/restart"
            | "remux/extensions/watch/start"
            | "remux/extensions/watch/stop"
            | "remux/extensions/server/build"
            | "remux/extensions/views/build"
    ) {
        let extension_id = dispatch_params(work)
            .and_then(|params| params.get("extensionId"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return (format!("extension:{extension_id}"), DispatchMode::Serial);
    }
    if method.starts_with("remux/codex/") {
        let params = dispatch_params(work);
        if method == "remux/codex/app-server/status/read" {
            return (
                "extension:codex:app-server-status".to_string(),
                DispatchMode::ConcurrentBusiness,
            );
        }
        if matches!(
            method,
            "remux/codex/app-server/start"
                | "remux/codex/app-server/stop"
                | "remux/codex/app-server/restart"
                | "remux/codex/app-server/update"
        ) {
            return (
                "extension:codex:app-server-management".to_string(),
                DispatchMode::Serial,
            );
        }
        if matches!(
            method,
            "remux/codex/files"
                | "remux/codex/composer/config/read"
                | "remux/codex/models/read"
                | "remux/codex/thread/resources/read"
                | "remux/codex/transcript/capabilities/read"
                | "remux/codex/transcript/resources/read"
        ) {
            return (
                "extension:codex:reads".to_string(),
                DispatchMode::ConcurrentBusiness,
            );
        }
        if method == "remux/codex/composer/config/write" {
            return ("extension:codex:config".to_string(), DispatchMode::Serial);
        }
        let thread_id = params
            .and_then(|params| params.get("threadId"))
            .and_then(Value::as_str)
            .unwrap_or("__new_thread__");
        return (
            format!("extension:codex:thread:{thread_id}"),
            DispatchMode::Serial,
        );
    }
    if method.starts_with("remux/terminal/") {
        let params = dispatch_params(work);
        if matches!(
            method,
            "remux/terminal/session/list" | "remux/terminal/tmux/context/get"
        ) {
            return (
                "extension:terminal:reads".to_string(),
                DispatchMode::ConcurrentBusiness,
            );
        }
        let session_id = params
            .and_then(|params| params.get("sessionId"))
            .and_then(Value::as_str)
            .unwrap_or("__new_session__");
        let generation = params
            .and_then(|params| params.get("sessionGeneration"))
            .and_then(Value::as_u64)
            .map(|generation| generation.to_string())
            .unwrap_or_else(|| "pending".to_string());
        return (
            format!("extension:terminal:session:{session_id}:{generation}"),
            DispatchMode::Serial,
        );
    }
    if let Some(extension_id) = extension_id_from_method(method) {
        return (format!("extension:{extension_id}"), DispatchMode::Serial);
    }
    ("extension:default".to_string(), DispatchMode::Serial)
}

fn dispatch_params(work: &DispatchWork) -> Option<&Value> {
    match work {
        DispatchWork::Notification { params } => params.as_ref(),
        DispatchWork::Request { message, .. } => message.get("params"),
    }
}

fn is_downstream_notification_method(method: &str) -> bool {
    matches!(method, "remux/terminal/session/input-preview")
}

fn valid_remux_contract(contract: Option<&Value>) -> bool {
    let Some(contract) = contract.and_then(Value::as_object) else {
        return false;
    };
    match contract.get("kind").and_then(Value::as_str) {
        Some("query" | "subscription") => contract
            .get("resourceKey")
            .is_none_or(|value| value.is_string()),
        Some("command") => {
            contract
                .get("operationId")
                .is_none_or(|value| value.is_string())
                && contract
                    .get("preconditionRevision")
                    .is_none_or(|value| value.is_number())
        }
        Some("job-start") => contract
            .get("operationId")
            .and_then(Value::as_str)
            .is_some_and(|operation_id| !operation_id.is_empty()),
        _ => false,
    }
}

fn dispatch_slow_threshold_ms(method: &str, work: &DispatchWork) -> u64 {
    if method.starts_with("remux/system/") || method.starts_with("remux/clients/") {
        return 500;
    }
    let kind = match work {
        DispatchWork::Request { message, .. } => message
            .get("remuxContract")
            .and_then(|contract| contract.get("kind"))
            .and_then(Value::as_str),
        DispatchWork::Notification { .. } => None,
    };
    match kind {
        Some("query" | "subscription") => 2_000,
        Some("job-start") => 10_000,
        _ => 5_000,
    }
}

fn server_busy_error(method: &str) -> JsonRpcError {
    JsonRpcError {
        code: EXTENSION_ERROR,
        message: format!("Server busy handling {method}"),
        data: Some(serde_json::json!({
            "kind": "queue-full",
            "retryable": method.starts_with("remux/fs/") || method.ends_with("/read"),
        })),
    }
}

fn complete_registration_barrier(client: &WsClient) {
    let previous = client.registration_pending.fetch_sub(1, Ordering::SeqCst);
    if previous <= 1 {
        client.registration_pending.store(0, Ordering::SeqCst);
        client.registration_committed.notify_waiters();
    }
}

fn params_with_origin(params: Option<&Value>, origin: String, viewer_key: String) -> Option<Value> {
    match params {
        Some(Value::Object(params)) => {
            let mut params = params.clone();
            params.insert("_remuxOrigin".to_string(), Value::from(origin));
            params.insert("_remuxViewerKey".to_string(), Value::from(viewer_key));
            Some(Value::Object(params))
        }
        Some(other) => Some(other.clone()),
        None => {
            let mut params = serde_json::Map::new();
            params.insert("_remuxOrigin".to_string(), Value::from(origin));
            params.insert("_remuxViewerKey".to_string(), Value::from(viewer_key));
            Some(Value::Object(params))
        }
    }
}

async fn upgrade_handler(
    State(server): State<Arc<WsServer>>,
    ConnectInfo(remote): ConnectInfo<std::net::SocketAddr>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let remote = Some(remote.ip().to_string());
    upgrade.on_upgrade(move |socket| server.handle_socket(socket, remote))
}

fn log_app_diagnostic(params: Option<&Value>, log: &dyn WsLog) {
    let record = params.and_then(Value::as_object);
    let label = record
        .and_then(|record| record.get("label"))
        .and_then(Value::as_str);

    let Some(label) = label else {
        log.event(DiagnosticEvent {
            detail: None,
            label: "invalid-diagnostic-payload".to_string(),
            level: "warn",
            message: "[remux:app] invalid diagnostic payload".to_string(),
            ts: None,
        });
        return;
    };

    let record = record.expect("label implies record");
    let timestamp = record
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(now_iso8601);
    let detail = record.get("detail").cloned();
    let detail_suffix = match &detail {
        None => String::new(),
        Some(Value::String(text)) => format!(" {text}"),
        Some(value) => format!(" {value}"),
    };

    log.event(DiagnosticEvent {
        message: format!("[remux:app] {timestamp} {label}{detail_suffix}"),
        detail,
        label: label.to_string(),
        level: "info",
        ts: Some(timestamp),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outbound_frame_saturation_disconnects_instead_of_growing() {
        let (sender, _receiver) = mpsc::channel(1);
        let (control_sender, _control_receiver) = mpsc::channel(1);
        let client = WsClient::new(sender, control_sender, 1);
        assert!(client.send_message(&serde_json::json!({ "ok": 1 })));
        assert!(!client.send_message(&serde_json::json!({ "ok": 2 })));
        assert!(!client.is_connected());
    }

    #[test]
    fn outbound_byte_budget_disconnects_oversized_frame() {
        let (sender, _receiver) = mpsc::channel(2);
        let (control_sender, _control_receiver) = mpsc::channel(1);
        let client = WsClient::new(sender, control_sender, 1);
        let payload = Value::from("x".repeat(MAX_OUTBOUND_BYTES + 1));
        assert!(!client.send_message(&payload));
        assert!(!client.is_connected());
    }

    #[test]
    fn control_response_capacity_is_reserved_from_business_frames() {
        let (sender, _receiver) = mpsc::channel(1);
        let (control_sender, _control_receiver) = mpsc::channel(1);
        let client = WsClient::new(sender, control_sender, 1);
        assert!(client.send_message(&serde_json::json!({ "event": 1 })));
        assert!(client.send_control_message(&serde_json::json!({ "id": 1, "result": true })));
        assert!(client.is_connected());
    }

    #[tokio::test]
    async fn request_cancellation_removes_active_request() {
        let (sender, _receiver) = mpsc::channel(1);
        let (control_sender, _control_receiver) = mpsc::channel(1);
        let client = WsClient::new(sender, control_sender, 1);
        let id = serde_json::json!(42);
        assert!(client.register_request(&id));
        let cancellation = client.begin_request(&id).expect("registered");
        assert!(client.cancel_request(&id));
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(10),
            cancellation.notified(),
        )
        .await
        .is_ok());
        assert!(!client.cancel_request(&id));
    }

    #[test]
    fn extension_origin_params_do_not_inject_a_deadline() {
        let params =
            params_with_origin(None, "origin".to_string(), "viewer".to_string()).expect("params");
        assert_eq!(params["_remuxOrigin"], "origin");
        assert_eq!(params["_remuxViewerKey"], "viewer");
        assert!(params.get("_remuxExecutionTimeoutMs").is_none());
    }
}
