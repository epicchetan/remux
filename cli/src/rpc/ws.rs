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
                if extension_execution_budget_ms(method, &message).is_some() {
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
        if matches!(
            extension_id_from_method(&method),
            Some("codex" | "terminal")
        ) && extension_execution_budget_ms(&method, &message).is_none()
        {
            client.send_control_message(&error_message(
                &id,
                &JsonRpcError::method_not_found(&method),
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

        let (lane_key, mode) = dispatch_lane(client, &method, &work);
        let Some(sender) = self.dispatch_sender(lane_key.clone(), mode) else {
            if is_request {
                client.outstanding_requests.fetch_sub(1, Ordering::SeqCst);
                if let DispatchWork::Request { id, .. } = &work {
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
        if execution_ms >= 5_000 {
            self.log.warn(&format!(
                "[remux] slow rpc method={method} lane={lane_key} execution_ms={execution_ms}"
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
        let params = message.get("params");

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

        let handled_by_notifications = self
            .hooks
            .notifications
            .as_ref()
            .map(|notifications| notifications.can_handle_client_request(&method))
            .unwrap_or(false);

        let result = if handled_by_notifications {
            let notifications = self.hooks.notifications.as_ref().expect("checked above");
            notifications
                .handle_client_request(client.clone(), method.clone(), params.cloned())
                .await
        } else {
            let routed_params = if self.router.routes_to_extension(&method) {
                let origin = client.origin_for_context(message.get("remuxContext"));
                let viewer_key = message
                    .get("remuxContext")
                    .map(Value::to_string)
                    .unwrap_or_else(|| origin.clone());
                let timeout_ms = extension_execution_budget_ms(&method, &message)
                    .map(|budget_ms| {
                        budget_ms.saturating_sub(
                            received_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                        )
                    })
                    .unwrap_or(30_000)
                    .max(1);
                params_with_origin_and_deadline(params, origin, viewer_key, timeout_ms)
            } else {
                params.cloned()
            };
            self.router
                .handle_request(&method, routed_params.as_ref())
                .await
        };

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
        if matches!(
            method,
            "remux/codex/files"
                | "remux/codex/composer/config/read"
                | "remux/codex/models/read"
                | "remux/codex/narration/audio/read"
                | "remux/codex/narration/resources/read"
                | "remux/codex/thread/resources/read"
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
        if matches!(
            method,
            "remux/codex/narration/start" | "remux/codex/narration/cancel"
        ) {
            return (
                "extension:codex:narration".to_string(),
                DispatchMode::Serial,
            );
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

fn params_with_origin_and_deadline(
    params: Option<&Value>,
    origin: String,
    viewer_key: String,
    execution_timeout_ms: u64,
) -> Option<Value> {
    match params {
        Some(Value::Object(params)) => {
            let mut params = params.clone();
            params.insert("_remuxOrigin".to_string(), Value::from(origin));
            params.insert("_remuxViewerKey".to_string(), Value::from(viewer_key));
            params.insert(
                "_remuxExecutionTimeoutMs".to_string(),
                Value::from(execution_timeout_ms),
            );
            Some(Value::Object(params))
        }
        Some(other) => Some(other.clone()),
        None => {
            let mut params = serde_json::Map::new();
            params.insert("_remuxOrigin".to_string(), Value::from(origin));
            params.insert("_remuxViewerKey".to_string(), Value::from(viewer_key));
            params.insert(
                "_remuxExecutionTimeoutMs".to_string(),
                Value::from(execution_timeout_ms),
            );
            Some(Value::Object(params))
        }
    }
}

fn extension_execution_budget_ms(method: &str, message: &Value) -> Option<u64> {
    let runtime_cap = match method {
        "remux/codex/composer/config/read"
        | "remux/codex/narration/resources/read"
        | "remux/codex/narration/cancel"
        | "remux/codex/thread/queue/remove" => 3_000,
        "remux/codex/composer/config/write" => 5_000,
        "remux/codex/files" | "remux/codex/narration/audio/read" => 60_000,
        "remux/codex/models/read"
        | "remux/codex/narration/start"
        | "remux/codex/thread/turn/interrupt" => 15_000,
        "remux/codex/thread/resources/read" => 20_000,
        "remux/codex/transcript/resources/read"
        | "remux/codex/thread/message/send"
        | "remux/codex/thread/compact" => 30_000,
        "remux/codex/thread/message/start" | "remux/codex/thread/message/edit" => 45_000,
        "remux/codex/thread/message/fork" => 90_000,
        "remux/codex/thread/queue/run-now" => 30_000,
        "remux/terminal/session/list"
        | "remux/terminal/session/detach"
        | "remux/terminal/session/write"
        | "remux/terminal/session/resize"
        | "remux/terminal/session/kill"
        | "remux/terminal/tmux/context/get" => 3_000,
        "remux/terminal/session/start" | "remux/terminal/session/attach" => 10_000,
        "remux/terminal/session/replay/read" => 5_000,
        "remux/terminal/tmux/action" => 15_000,
        _ => return None,
    };
    let caller_remaining = message
        .get("remuxPolicy")
        .and_then(|policy| policy.get("remainingMs"))
        .and_then(Value::as_u64)
        .unwrap_or(runtime_cap);
    Some(runtime_cap.min(caller_remaining))
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

    #[test]
    fn runtime_policy_caps_caller_claimed_extension_deadline() {
        let message = serde_json::json!({
            "remuxPolicy": { "name": "forged", "remainingMs": 999_999 },
        });
        assert_eq!(
            extension_execution_budget_ms("remux/terminal/session/write", &message),
            Some(3_000),
        );
        let short = serde_json::json!({
            "remuxPolicy": { "remainingMs": 750 },
        });
        assert_eq!(
            extension_execution_budget_ms("remux/terminal/session/write", &short),
            Some(750),
        );
    }

    #[test]
    fn runtime_policy_rejects_unregistered_extension_methods() {
        assert_eq!(
            extension_execution_budget_ms("remux/codex/new-unknown-method", &Value::Null),
            None,
        );
    }
}
