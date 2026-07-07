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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::response::Response;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::rpc::jsonrpc::{
    error_message, is_json_rpc_request, is_json_rpc_response, parse_json_rpc_frame,
    response_message, with_json_rpc_version, JsonRpcError, EXTENSION_ERROR, INVALID_REQUEST,
};
use crate::rpc::router::{BoxFuture, RpcResult, RpcRouter};
use crate::time::now_iso8601;

pub const REMUX_WEB_SOCKET_PATH: &str = "/ws";
pub const DEFAULT_HOST_REQUEST_TIMEOUT_MS: u64 = 1_000;

/// One connected downstream client. Shared with the notification manager,
/// which stamps `client_id`/`session_id` at registration and issues
/// host→client requests (visibility checks).
pub struct WsClient {
    outbound: mpsc::UnboundedSender<Message>,
    next_request_id: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, JsonRpcError>>>>,
    pub client_id: Mutex<Option<String>>,
    pub session_id: Mutex<Option<String>>,
}

impl WsClient {
    fn new(outbound: mpsc::UnboundedSender<Message>) -> Arc<Self> {
        Arc::new(Self {
            outbound,
            next_request_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            client_id: Mutex::new(None),
            session_id: Mutex::new(None),
        })
    }

    pub fn send_message(&self, payload: &Value) {
        let _ = self.outbound.send(Message::Text(payload.to_string().into()));
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
        self.send_message(&Value::Object(payload));

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
                code: error.get("code").and_then(Value::as_i64).unwrap_or(EXTENSION_ERROR),
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
        let _ = self.outbound.send(Message::Close(None));
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
}

impl WsServer {
    pub fn new(router: Arc<RpcRouter>, hooks: WsHooks, log: Arc<dyn WsLog>) -> Arc<Self> {
        Arc::new(Self {
            clients: Mutex::new(Vec::new()),
            router,
            hooks,
            log,
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
        clients.retain(|client| {
            client
                .outbound
                .send(Message::Text(text.clone().into()))
                .is_ok()
        });
    }

    pub fn close(&self) {
        let clients: Vec<Arc<WsClient>> = self.clients.lock().unwrap().drain(..).collect();
        for client in clients {
            client.close();
            client.reject_pending_requests();
        }
    }

    fn remove_client(&self, client: &Arc<WsClient>) {
        let mut clients = self.clients.lock().unwrap();
        clients.retain(|candidate| !Arc::ptr_eq(candidate, client));
        let count = clients.len();
        drop(clients);
        if let Some(listener) = &self.hooks.client_count {
            listener.on_client_count_changed(count);
        }
    }

    async fn handle_socket(self: Arc<Self>, socket: WebSocket, remote: Option<String>) {
        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Message>();
        let client = WsClient::new(outbound_tx);

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

        let writer = tokio::spawn(async move {
            while let Some(message) = outbound_rx.recv().await {
                let closing = matches!(message, Message::Close(_));
                if sink.send(message).await.is_err() || closing {
                    break;
                }
            }
        });

        let mut close_code = String::from("(unknown)");
        let mut close_reason = String::new();
        while let Some(frame) = stream.next().await {
            match frame {
                Ok(Message::Text(text)) => {
                    self.handle_downstream_frame(&client, text.as_str()).await;
                }
                Ok(Message::Binary(data)) => {
                    let text = String::from_utf8_lossy(&data).into_owned();
                    self.handle_downstream_frame(&client, &text).await;
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

    async fn handle_downstream_frame(&self, client: &Arc<WsClient>, frame: &str) {
        let parsed = parse_json_rpc_frame(frame);
        if let Some(error) = parsed.error {
            client.send_message(&error_message(&parsed.id, &error));
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
                self.router
                    .handle_notification(method, message.get("params").cloned());
                return;
            }

            client.send_message(&error_message(
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
        let params = message.get("params");
        let id = message.get("id").cloned().unwrap_or(Value::Null);

        for client_scoped in &self.hooks.client_scoped {
            if let Some(result) = client_scoped.handle(client, &method, params) {
                match result {
                    Ok(result) => client.send_message(&response_message(&id, result)),
                    Err(error) => client.send_message(&error_message(&id, &error)),
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
            self.router.handle_request(&method, params).await
        };

        match result {
            Ok(result) => {
                if let Some(notifications) = &self.hooks.notifications {
                    notifications.record_client_request(client, &message, &result);
                }
                client.send_message(&response_message(&id, result));
            }
            Err(error) => {
                client.send_message(&error_message(&id, &error));
            }
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
