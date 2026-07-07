//! Push notification manager, ported 1:1 from `cli/notifications.cjs` —
//! including its extension-specific correlation tables (codex turn/compact
//! methods, terminal session start/attach/kill) with `once`/`target`
//! audience lifetimes. That hardcoded knowledge is acknowledged debt, not to
//! be redesigned in this pass.
//!
//! `.remux/notifications/clients.json` keeps its exact version-1 format so
//! push tokens survive the cutover.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

use crate::rpc::jsonrpc::JsonRpcError;
use crate::rpc::router::{BoxFuture, RpcResult};
use crate::time::{now_iso8601, now_ms};

pub const CLIENT_REGISTER_METHOD: &str = "remux/clients/register";
pub const NOTIFICATION_AUDIENCE_REMOVE_METHOD: &str = "remux/notifications/audience/remove";
pub const NOTIFICATION_REQUEST_METHOD: &str = "remux/notifications/request";
pub const VISIBILITY_CHECK_METHOD: &str = "remux/notifications/visibility/check";
pub const NOTIFICATION_DATA_KEY: &str = "remuxNotificationIntent";
pub const NOTIFICATION_CHANNEL_ID: &str = "remux-extension-events";
pub const VISIBILITY_CHECK_TIMEOUT_MS: u64 = 500;
pub const EXPO_PUSH_SEND_URL: &str = "https://exp.host/--/api/v2/push/send";

const CODEX_COMPACT_REQUEST_METHOD: &str = "remux/codex/thread/compact";
const TERMINAL_SESSION_ATTACH_METHOD: &str = "remux/terminal/session/attach";
const TERMINAL_SESSION_KILL_METHOD: &str = "remux/terminal/session/kill";
const TERMINAL_SESSION_START_METHOD: &str = "remux/terminal/session/start";

const CODEX_TURN_REQUEST_METHODS: [&str; 4] = [
    "remux/codex/thread/message/edit",
    "remux/codex/thread/message/fork",
    "remux/codex/thread/message/send",
    "remux/codex/thread/message/start",
];

/// The slice of a WS client the manager needs; `WsClient` implements it, and
/// tests substitute mocks.
pub trait PushClient: Send + Sync {
    fn request_visibility(&self, intent: Value) -> BoxFuture<'_, Result<Value, JsonRpcError>>;
    fn identity(&self) -> (Option<String>, Option<String>);
    fn set_identity(&self, client_id: &str, session_id: &str);
}

impl PushClient for crate::rpc::ws::WsClient {
    fn request_visibility(&self, intent: Value) -> BoxFuture<'_, Result<Value, JsonRpcError>> {
        Box::pin(self.request(
            VISIBILITY_CHECK_METHOD,
            Some(intent),
            VISIBILITY_CHECK_TIMEOUT_MS,
        ))
    }

    fn identity(&self) -> (Option<String>, Option<String>) {
        (
            self.client_id.lock().unwrap().clone(),
            self.session_id.lock().unwrap().clone(),
        )
    }

    fn set_identity(&self, client_id: &str, session_id: &str) {
        *self.client_id.lock().unwrap() = Some(client_id.to_string());
        *self.session_id.lock().unwrap() = Some(session_id.to_string());
    }
}

pub trait NotificationLog: Send + Sync {
    fn event(&self, label: &str, level: &'static str, detail: Option<Value>, silent: bool);
}

impl NotificationLog for crate::logs::Journal {
    fn event(&self, label: &str, level: &'static str, detail: Option<Value>, silent: bool) {
        crate::logs::Journal::event(
            self,
            crate::logs::JournalEvent {
                detail,
                label: Some(label.to_string()),
                level,
                terminal: if silent {
                    crate::logs::TerminalMode::Silent
                } else {
                    crate::logs::TerminalMode::Mirror
                },
                ..Default::default()
            },
        );
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PushResponse {
    pub ok: bool,
    pub status: u16,
    pub body: Option<Value>,
}

pub type FetchFn =
    Arc<dyn Fn(String, Value) -> BoxFuture<'static, Result<PushResponse, String>> + Send + Sync>;

pub fn production_fetch() -> FetchFn {
    let client = reqwest::Client::new();
    Arc::new(move |url, payload| {
        let client = client.clone();
        Box::pin(async move {
            let response = client
                .post(&url)
                .header("accept", "application/json")
                .header("content-type", "application/json")
                .body(payload.to_string())
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let ok = response.status().is_success();
            let status = response.status().as_u16();
            let bytes = response.bytes().await.map_err(|error| error.to_string())?;
            let body = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .or_else(|| String::from_utf8(bytes.to_vec()).ok().map(Value::from));
            Ok(PushResponse { ok, status, body })
        })
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lifetime {
    Once,
    Target,
}

#[derive(Debug, Clone)]
struct Audience {
    client_id: String,
    #[allow(dead_code)]
    created_at: i64,
    lifetime: Lifetime,
    origin_resource_key: Option<String>,
    origin_tab_id: Option<String>,
    #[allow(dead_code)]
    session_id: Option<String>,
    target: Value,
}

struct SessionState {
    client: Arc<dyn PushClient>,
    session_id: String,
}

struct ClientState {
    #[allow(dead_code)]
    client_id: String,
    expo_push_token: Option<String>,
    sessions: HashMap<String, SessionState>,
    updated_at: Option<String>,
}

pub struct NotificationManager {
    store_path: PathBuf,
    fetch: FetchFn,
    log: Arc<dyn NotificationLog>,
    clients: Mutex<HashMap<String, ClientState>>,
    audiences: Mutex<HashMap<String, HashMap<String, Audience>>>,
}

impl NotificationManager {
    pub fn new(root_dir: &Path, fetch: FetchFn, log: Arc<dyn NotificationLog>) -> Arc<Self> {
        let store_path = root_dir.join(".remux/notifications/clients.json");
        let clients = load_persisted_clients(&store_path);
        Arc::new(Self {
            store_path,
            fetch,
            log,
            clients: Mutex::new(clients),
            audiences: Mutex::new(HashMap::new()),
        })
    }

    pub fn can_handle_client_request(&self, method: &str) -> bool {
        method == CLIENT_REGISTER_METHOD
    }

    pub async fn handle_client_request(
        &self,
        client: Arc<dyn PushClient>,
        method: &str,
        params: Option<&Value>,
    ) -> RpcResult {
        if method != CLIENT_REGISTER_METHOD {
            return Err(JsonRpcError::internal(format!("Method not found: {method}")));
        }

        let registration = parse_client_registration(params)
            .ok_or_else(|| JsonRpcError::internal("Invalid client registration params"))?;
        self.register_client_session(client, registration);
        Ok(serde_json::json!({ "ok": true }))
    }

    fn register_client_session(&self, client: Arc<dyn PushClient>, registration: Registration) {
        let has_token = {
            let mut clients = self.clients.lock().unwrap();
            let state = clients
                .entry(registration.client_id.clone())
                .or_insert_with(|| ClientState {
                    client_id: registration.client_id.clone(),
                    expo_push_token: None,
                    sessions: HashMap::new(),
                    updated_at: None,
                });

            if let Some(token) = &registration.expo_push_token {
                state.expo_push_token = Some(token.clone());
                state.updated_at = Some(now_iso8601());
            }

            // Re-registration under a new identity releases the old session.
            let (previous_client_id, previous_session_id) = client.identity();
            if let (Some(previous_client_id), Some(previous_session_id)) =
                (previous_client_id, previous_session_id)
            {
                if previous_client_id != registration.client_id
                    || previous_session_id != registration.session_id
                {
                    if let Some(previous) = clients.get_mut(&previous_client_id) {
                        previous.sessions.remove(&previous_session_id);
                    }
                }
            }

            client.set_identity(&registration.client_id, &registration.session_id);
            let state = clients
                .get_mut(&registration.client_id)
                .expect("inserted above");
            state.sessions.insert(
                registration.session_id.clone(),
                SessionState {
                    client,
                    session_id: registration.session_id.clone(),
                },
            );
            state.expo_push_token.is_some()
        };

        if registration.expo_push_token.is_some() {
            self.persist_clients();
        }

        self.log.event(
            "notifications:client:registered",
            "info",
            Some(serde_json::json!({
                "appState": registration.app_state,
                "clientId": registration.client_id,
                "hasExpoPushToken": has_token,
                "sessionId": registration.session_id,
                "target": registration.active_target,
            })),
            true,
        );
    }

    pub fn on_client_disconnected(&self, client: &dyn PushClient) {
        let (client_id, session_id) = client.identity();
        let (Some(client_id), Some(session_id)) = (client_id, session_id) else {
            return;
        };

        if let Some(state) = self.clients.lock().unwrap().get_mut(&client_id) {
            state.sessions.remove(&session_id);
        }
        self.log.event(
            "notifications:client:disconnected",
            "info",
            Some(serde_json::json!({ "clientId": client_id, "sessionId": session_id })),
            true,
        );
    }

    pub fn record_client_request(&self, client: &dyn PushClient, request: &Value, result: &Value) {
        let (Some(client_id), session_id) = client.identity() else {
            return;
        };

        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let Some(change) = audience_change_for_client_request(method, request, result) else {
            return;
        };

        match change {
            AudienceChange::Remove { target } => {
                self.remove_notification_audiences(method, &target);
            }
            AudienceChange::Record { lifetime, target } => {
                let origin = parse_remux_context(request.get("remuxContext"));
                self.record_notification_audience(
                    &client_id,
                    session_id.as_deref(),
                    lifetime,
                    method,
                    origin,
                    target,
                );
            }
        }
    }

    fn record_notification_audience(
        &self,
        client_id: &str,
        session_id: Option<&str>,
        lifetime: Lifetime,
        method: &str,
        origin: (Option<String>, Option<String>),
        target: Value,
    ) {
        let Some(key) = audience_key_for_target(&target) else {
            return;
        };

        let audience = Audience {
            client_id: client_id.to_string(),
            created_at: now_ms(),
            lifetime,
            origin_resource_key: origin.0.clone(),
            origin_tab_id: origin.1.clone(),
            session_id: session_id.map(str::to_string),
            target: target.clone(),
        };
        self.audiences
            .lock()
            .unwrap()
            .entry(key)
            .or_default()
            .insert(client_id.to_string(), audience);

        self.log.event(
            "notifications:audience:recorded",
            "info",
            Some(serde_json::json!({
                "clientId": client_id,
                "lifetime": match lifetime {
                    Lifetime::Once => "once",
                    Lifetime::Target => "target",
                },
                "method": method,
                "origin": { "resourceKey": origin.0, "tabId": origin.1 },
                "sessionId": session_id,
                "target": target,
            })),
            true,
        );
    }

    fn remove_notification_audiences(&self, reason: &str, target: &Value) {
        let mut audiences = self.audiences.lock().unwrap();
        let keys = audience_removal_keys(&audiences, target);
        let mut removed = 0;
        for key in keys {
            if let Some(bucket) = audiences.remove(&key) {
                removed += bucket.len();
            }
        }
        drop(audiences);

        self.log.event(
            "notifications:audience:removed",
            "info",
            Some(serde_json::json!({ "reason": reason, "removed": removed, "target": target })),
            true,
        );
    }

    /// Returns true when the notification was owned by the manager (whether
    /// or not a push went out); false lets the caller broadcast it.
    pub async fn handle_extension_notification(&self, message: &Value) -> bool {
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params");

        if method == NOTIFICATION_AUDIENCE_REMOVE_METHOD {
            let Some(target) = parse_notification_audience_target(params) else {
                self.log.event(
                    "notifications:audience-remove:invalid",
                    "warn",
                    params.cloned(),
                    false,
                );
                return true;
            };
            self.remove_notification_audiences("extension", &target);
            return true;
        }

        if method != NOTIFICATION_REQUEST_METHOD {
            return false;
        }

        let Some(intent) = parse_notification_intent(params) else {
            self.log.event(
                "notifications:intent:invalid",
                "warn",
                params.cloned(),
                false,
            );
            return true;
        };

        let audience_key = audience_key_for_intent(&intent);
        let delivery: Vec<Audience> = {
            let audiences = self.audiences.lock().unwrap();
            audience_key
                .as_ref()
                .and_then(|key| audiences.get(key))
                .map(|bucket| bucket.values().cloned().collect())
                .unwrap_or_default()
        };

        if delivery.is_empty() {
            self.log.event(
                "notifications:intent:no-audience",
                "info",
                Some(notification_log_detail(&intent)),
                false,
            );
            return true;
        }

        let key = audience_key.expect("delivery non-empty implies key");
        for audience in delivery {
            if audience.lifetime == Lifetime::Once {
                if let Some(bucket) = self.audiences.lock().unwrap().get_mut(&key) {
                    bucket.remove(&audience.client_id);
                }
            }
            self.deliver_notification(&audience, &intent).await;
        }
        {
            let mut audiences = self.audiences.lock().unwrap();
            if audiences.get(&key).map(HashMap::is_empty).unwrap_or(false) {
                audiences.remove(&key);
            }
        }
        true
    }

    async fn deliver_notification(&self, audience: &Audience, intent: &Value) {
        let (token, session_clients) = {
            let clients = self.clients.lock().unwrap();
            let Some(state) = clients.get(&audience.client_id) else {
                self.log.event(
                    "notifications:push:no-token",
                    "info",
                    Some(serde_json::json!({
                        "audience": { "clientId": audience.client_id },
                        "intent": notification_log_detail(intent),
                    })),
                    false,
                );
                return;
            };
            let Some(token) = state.expo_push_token.clone() else {
                self.log.event(
                    "notifications:push:no-token",
                    "info",
                    Some(serde_json::json!({
                        "audience": { "clientId": audience.client_id },
                        "intent": notification_log_detail(intent),
                    })),
                    false,
                );
                return;
            };
            let sessions: Vec<(String, Arc<dyn PushClient>)> = state
                .sessions
                .values()
                .map(|session| (session.session_id.clone(), session.client.clone()))
                .collect();
            (token, sessions)
        };

        let delivered_intent = intent_for_audience(intent, audience);

        if self
            .is_client_viewing_intent(&audience.client_id, &session_clients, &delivered_intent)
            .await
        {
            self.log.event(
                "notifications:push:suppressed-visible",
                "info",
                Some(notification_log_detail(&delivered_intent)),
                true,
            );
            return;
        }

        self.send_expo_push(&audience.client_id, &token, &delivered_intent)
            .await;
    }

    async fn is_client_viewing_intent(
        &self,
        client_id: &str,
        sessions: &[(String, Arc<dyn PushClient>)],
        intent: &Value,
    ) -> bool {
        if sessions.is_empty() {
            return false;
        }

        let checks = sessions.iter().map(|(session_id, client)| {
            let intent = intent.clone();
            async move {
                match client.request_visibility(intent).await {
                    Ok(result) => result.get("visible").and_then(Value::as_bool) == Some(true),
                    Err(error) => {
                        self.log.event(
                            "notifications:visibility-check:failed",
                            "info",
                            Some(serde_json::json!({
                                "clientId": client_id,
                                "error": error.message,
                                "sessionId": session_id,
                            })),
                            true,
                        );
                        false
                    }
                }
            }
        });
        let results = futures_util::future::join_all(checks).await;
        results.into_iter().any(|visible| visible)
    }

    /// Operational alert to **all** registered clients with push tokens, with
    /// no is-viewing suppression — there is no tab target to be "viewing".
    /// The app opens Settings when `data.kind == "system"`.
    pub async fn notify_system(&self, title: &str, body: &str, reason: &str, extension_id: &str) {
        let recipients: Vec<(String, String)> = {
            let clients = self.clients.lock().unwrap();
            clients
                .iter()
                .filter_map(|(client_id, state)| {
                    state
                        .expo_push_token
                        .clone()
                        .map(|token| (client_id.clone(), token))
                })
                .collect()
        };

        let data = serde_json::json!({
            "kind": "system",
            "reason": reason,
            "extensionId": extension_id,
        });
        let log_detail = serde_json::json!({
            "kind": "system",
            "reason": reason,
            "extensionId": extension_id,
            "title": title,
        });

        if recipients.is_empty() {
            self.log.event(
                "notifications:system:no-recipients",
                "info",
                Some(log_detail),
                false,
            );
            return;
        }

        for (client_id, token) in recipients {
            let mut payload = Map::new();
            payload.insert("body".to_string(), Value::from(body));
            payload.insert("channelId".to_string(), Value::from(NOTIFICATION_CHANNEL_ID));
            payload.insert("data".to_string(), data.clone());
            payload.insert("interruptionLevel".to_string(), Value::from("active"));
            payload.insert("priority".to_string(), Value::from("high"));
            payload.insert("sound".to_string(), Value::from("default"));
            payload.insert("title".to_string(), Value::from(title));
            payload.insert("to".to_string(), Value::from(token.as_str()));
            self.dispatch_expo_push(&client_id, Value::Object(payload), log_detail.clone())
                .await;
        }
    }

    async fn send_expo_push(&self, client_id: &str, token: &str, intent: &Value) {
        let mut payload = Map::new();
        if let Some(body) = intent.get("body").and_then(Value::as_str) {
            payload.insert("body".to_string(), Value::from(body));
        }
        payload.insert("channelId".to_string(), Value::from(NOTIFICATION_CHANNEL_ID));
        payload.insert(
            "data".to_string(),
            serde_json::json!({ NOTIFICATION_DATA_KEY: intent }),
        );
        payload.insert("interruptionLevel".to_string(), Value::from("active"));
        payload.insert("priority".to_string(), Value::from("high"));
        payload.insert("sound".to_string(), Value::from("default"));
        payload.insert("title".to_string(), intent.get("title").cloned().unwrap_or(Value::Null));
        payload.insert("to".to_string(), Value::from(token));

        self.dispatch_expo_push(client_id, Value::Object(payload), notification_log_detail(intent))
            .await;
    }

    /// Shared Expo send + ticket handling (DeviceNotRegistered clears the
    /// stored token) for intent and system pushes.
    async fn dispatch_expo_push(&self, client_id: &str, payload: Value, log_detail: Value) {
        let response = (self.fetch)(EXPO_PUSH_SEND_URL.to_string(), payload).await;

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                self.log.event(
                    "notifications:push:failed",
                    "warn",
                    Some(serde_json::json!({
                        "body": error,
                        "intent": log_detail,
                        "status": null,
                    })),
                    false,
                );
                return;
            }
        };

        if !response.ok {
            self.log.event(
                "notifications:push:failed",
                "warn",
                Some(serde_json::json!({
                    "body": response.body,
                    "intent": log_detail,
                    "status": response.status,
                })),
                false,
            );
            return;
        }

        let ticket = response.body.as_ref().and_then(|body| {
            let data = body.get("data")?;
            if let Some(array) = data.as_array() {
                array.first().cloned()
            } else {
                Some(data.clone())
            }
        });

        if let Some(ticket) = &ticket {
            if ticket.get("status").and_then(Value::as_str) == Some("error") {
                let device_not_registered = ticket
                    .get("details")
                    .and_then(|details| details.get("error"))
                    .and_then(Value::as_str)
                    == Some("DeviceNotRegistered");
                if device_not_registered {
                    if let Some(state) = self.clients.lock().unwrap().get_mut(client_id) {
                        state.expo_push_token = None;
                        state.updated_at = Some(now_iso8601());
                    }
                    self.persist_clients();
                }
                self.log.event(
                    "notifications:push:ticket-error",
                    "warn",
                    Some(serde_json::json!({
                        "intent": log_detail,
                        "ticket": ticket,
                    })),
                    false,
                );
                return;
            }
        }

        self.log.event(
            "notifications:push:sent",
            "info",
            Some(serde_json::json!({
                "intent": log_detail,
                "ticket": ticket,
            })),
            true,
        );
    }

    fn persist_clients(&self) {
        let clients = self.clients.lock().unwrap();
        let mut serialized = Map::new();
        for (client_id, state) in clients.iter() {
            serialized.insert(
                client_id.clone(),
                serde_json::json!({
                    "expoPushToken": state.expo_push_token,
                    "updatedAt": state.updated_at,
                }),
            );
        }
        drop(clients);

        let mut document = Map::new();
        document.insert("clients".to_string(), Value::Object(serialized));
        document.insert("version".to_string(), Value::from(1));

        if let Some(parent) = self.store_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(
            &self.store_path,
            serde_json::to_string_pretty(&Value::Object(document)).unwrap_or_default(),
        );
    }
}

struct Registration {
    active_target: Option<Value>,
    app_state: String,
    client_id: String,
    expo_push_token: Option<String>,
    #[allow(dead_code)]
    platform: String,
    session_id: String,
}

fn parse_client_registration(value: Option<&Value>) -> Option<Registration> {
    let record = value?.as_object()?;
    let client_id = required_string(record.get("clientId"))?;
    let session_id = required_string(record.get("sessionId"))?;

    Some(Registration {
        active_target: parse_browser_resource_target(record.get("activeTarget")),
        app_state: optional_string(record.get("appState")).unwrap_or_else(|| "unknown".to_string()),
        client_id,
        expo_push_token: optional_string(record.get("expoPushToken")),
        platform: optional_string(record.get("platform")).unwrap_or_else(|| "unknown".to_string()),
        session_id,
    })
}

enum AudienceChange {
    Record { lifetime: Lifetime, target: Value },
    Remove { target: Value },
}

fn audience_change_for_client_request(
    method: &str,
    request: &Value,
    result: &Value,
) -> Option<AudienceChange> {
    if CODEX_TURN_REQUEST_METHODS.contains(&method) {
        let thread_id = required_string(result.get("threadId"))?;
        let turn_id = required_string(result.get("turnId"))?;
        return Some(AudienceChange::Record {
            lifetime: Lifetime::Once,
            target: serde_json::json!({
                "extensionId": "codex",
                "focusId": turn_id,
                "focusKind": "turn",
                "resourceId": thread_id,
                "resourceKind": "thread",
                "viewId": "main",
            }),
        });
    }

    if method == CODEX_COMPACT_REQUEST_METHOD {
        let thread_id = required_string(result.get("threadId"))?;
        return Some(AudienceChange::Record {
            lifetime: Lifetime::Once,
            target: serde_json::json!({
                "extensionId": "codex",
                "focusId": thread_id,
                "focusKind": "thread",
                "resourceId": thread_id,
                "resourceKind": "thread",
                "viewId": "main",
            }),
        });
    }

    if method == TERMINAL_SESSION_START_METHOD || method == TERMINAL_SESSION_ATTACH_METHOD {
        let session_id = required_string(result.get("sessionId"))?;
        let status = optional_string(result.get("status"));
        if status.as_deref() == Some("exited") {
            return None;
        }
        return Some(AudienceChange::Record {
            lifetime: Lifetime::Target,
            target: terminal_notification_target(&session_id),
        });
    }

    if method == TERMINAL_SESSION_KILL_METHOD {
        let session_id =
            required_string(request.get("params").and_then(|params| params.get("sessionId")))?;
        return Some(AudienceChange::Remove {
            target: terminal_notification_target(&session_id),
        });
    }

    None
}

fn terminal_notification_target(session_id: &str) -> Value {
    serde_json::json!({
        "extensionId": "terminal",
        "focusId": session_id,
        "focusKind": "session",
        "resourceId": session_id,
        "resourceKind": "terminalSession",
        "viewId": "main",
    })
}

/// Adds the audience's origin onto the delivered intent (`intentForAudience`).
fn intent_for_audience(intent: &Value, audience: &Audience) -> Value {
    let mut delivered = intent.clone();
    if let Some(target) = delivered
        .as_object_mut()
        .and_then(|record| record.get_mut("target"))
        .and_then(Value::as_object_mut)
    {
        target.insert(
            "originResourceKey".to_string(),
            audience
                .origin_resource_key
                .as_deref()
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        target.insert(
            "originTabId".to_string(),
            audience
                .origin_tab_id
                .as_deref()
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
    }
    delivered
}

/// Normalized intent shape from `parseNotificationIntent` — key order matches
/// the Node literal so push payloads serialize identically.
fn parse_notification_intent(value: Option<&Value>) -> Option<Value> {
    let record = value?.as_object()?;
    let id = required_string(record.get("id"))?;
    let extension_id = required_string(record.get("extensionId"))?;
    let title = required_string(record.get("title"))?;

    let empty = Map::new();
    let target = record
        .get("target")
        .and_then(Value::as_object)
        .unwrap_or(&empty);

    let mut normalized_target = Map::new();
    for key in [
        "focusId",
        "focusKind",
        "handlerId",
        "launch",
        "originResourceKey",
        "originTabId",
        "resourceId",
        "resourceKind",
    ] {
        normalized_target.insert(
            key.to_string(),
            optional_string(target.get(key)).map(Value::from).unwrap_or(Value::Null),
        );
    }

    let mut intent = Map::new();
    intent.insert(
        "body".to_string(),
        optional_string(record.get("body")).map(Value::from).unwrap_or(Value::Null),
    );
    intent.insert("extensionId".to_string(), Value::from(extension_id));
    intent.insert("id".to_string(), Value::from(id));
    intent.insert("target".to_string(), Value::Object(normalized_target));
    intent.insert("title".to_string(), Value::from(title));
    intent.insert(
        "viewId".to_string(),
        Value::from(optional_string(record.get("viewId")).unwrap_or_else(|| "main".to_string())),
    );
    Some(Value::Object(intent))
}

fn parse_remux_context(value: Option<&Value>) -> (Option<String>, Option<String>) {
    let Some(record) = value.and_then(Value::as_object) else {
        return (None, None);
    };
    (
        optional_string(record.get("resourceKey")),
        optional_string(record.get("tabId")),
    )
}

fn parse_notification_audience_target(value: Option<&Value>) -> Option<Value> {
    let record = value?.as_object()?;
    let extension_id = required_string(record.get("extensionId"))?;

    let empty = Map::new();
    let target = record
        .get("target")
        .and_then(Value::as_object)
        .unwrap_or(&empty);

    let mut normalized = Map::new();
    normalized.insert("extensionId".to_string(), Value::from(extension_id));
    for key in ["focusId", "focusKind", "handlerId", "launch", "resourceId", "resourceKind"] {
        normalized.insert(
            key.to_string(),
            optional_string(target.get(key)).map(Value::from).unwrap_or(Value::Null),
        );
    }
    normalized.insert(
        "viewId".to_string(),
        Value::from(optional_string(record.get("viewId")).unwrap_or_else(|| "main".to_string())),
    );
    Some(Value::Object(normalized))
}

fn parse_browser_resource_target(value: Option<&Value>) -> Option<Value> {
    let record = value?.as_object()?;
    let extension_id = required_string(record.get("extensionId"))?;

    Some(serde_json::json!({
        "extensionId": extension_id,
        "handlerId": optional_string(record.get("handlerId")),
        "launch": optional_string(record.get("launch")),
        "resourceId": optional_string(record.get("resourceId")),
        "resourceKind": optional_string(record.get("resourceKind")),
        "viewId": optional_string(record.get("viewId")).unwrap_or_else(|| "main".to_string()),
    }))
}

/// 8-part audience key (`notifications.cjs:676-698`).
fn audience_key(
    extension_id: Option<&str>,
    view_id: Option<&str>,
    target: Option<&Value>,
) -> Option<String> {
    let extension_id = extension_id.filter(|id| !id.is_empty())?;
    let target = target.and_then(Value::as_object)?;
    let field = |key: &str| {
        target
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let resource_kind = field("resourceKind")?;
    let resource_id = field("resourceId")?;
    let focus_kind = field("focusKind")?;
    let focus_id = field("focusId")?;

    Some(
        [
            extension_id.to_string(),
            view_id
                .filter(|view| !view.is_empty())
                .unwrap_or("main")
                .to_string(),
            field("handlerId").unwrap_or_default(),
            field("launch").unwrap_or_default(),
            resource_kind,
            resource_id,
            focus_kind,
            focus_id,
        ]
        .join(":"),
    )
}

fn audience_key_for_intent(intent: &Value) -> Option<String> {
    audience_key(
        intent.get("extensionId").and_then(Value::as_str),
        intent.get("viewId").and_then(Value::as_str),
        intent.get("target"),
    )
}

/// Audience-record targets carry extensionId/viewId inline with the target
/// fields (`recordNotificationAudience` builds the key from `target`).
fn audience_key_for_target(target: &Value) -> Option<String> {
    audience_key(
        target.get("extensionId").and_then(Value::as_str),
        target.get("viewId").and_then(Value::as_str),
        Some(target),
    )
}

/// Exact-key removal when the target fully identifies an audience; otherwise
/// every bucket whose target shares the tab target (extension/view/handler/
/// launch/resource) is removed (`notificationAudienceRemovalKeys`).
fn audience_removal_keys(
    audiences: &HashMap<String, HashMap<String, Audience>>,
    target: &Value,
) -> Vec<String> {
    if let Some(exact) = audience_key_for_target(target) {
        return if audiences.contains_key(&exact) {
            vec![exact]
        } else {
            Vec::new()
        };
    }

    audiences
        .iter()
        .filter(|(_, bucket)| {
            bucket
                .values()
                .next()
                .map(|audience| targets_share_tab_target(&audience.target, target))
                .unwrap_or(false)
        })
        .map(|(key, _)| key.clone())
        .collect()
}

fn targets_share_tab_target(left: &Value, right: &Value) -> bool {
    let string = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let view = |value: &Value| string(value, "viewId").unwrap_or_else(|| "main".to_string());

    string(left, "extensionId") == string(right, "extensionId")
        && view(left) == view(right)
        && string(left, "handlerId") == string(right, "handlerId")
        && string(left, "launch") == string(right, "launch")
        && string(left, "resourceKind") == string(right, "resourceKind")
        && string(left, "resourceId") == string(right, "resourceId")
}

fn notification_log_detail(intent: &Value) -> Value {
    let body = intent.get("body").and_then(Value::as_str);
    let target = intent.get("target").cloned().unwrap_or(Value::Null);
    serde_json::json!({
        "bodyLength": body.map(|body| body.chars().count()).unwrap_or(0),
        "bodyPreview": body.map(|body| body.chars().take(120).collect::<String>()),
        "extensionId": intent.get("extensionId"),
        "focusId": target.get("focusId"),
        "focusKind": target.get("focusKind"),
        "id": intent.get("id"),
        "resourceId": target.get("resourceId"),
        "resourceKind": target.get("resourceKind"),
        "title": intent.get("title"),
        "viewId": intent.get("viewId"),
    })
}

fn load_persisted_clients(store_path: &Path) -> HashMap<String, ClientState> {
    let Ok(source) = std::fs::read_to_string(store_path) else {
        return HashMap::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&source) else {
        return HashMap::new();
    };
    if parsed.get("version").and_then(Value::as_i64) != Some(1) {
        return HashMap::new();
    }
    let Some(clients) = parsed.get("clients").and_then(Value::as_object) else {
        return HashMap::new();
    };

    clients
        .iter()
        .filter_map(|(client_id, client)| {
            let record = client.as_object()?;
            Some((
                client_id.clone(),
                ClientState {
                    client_id: client_id.clone(),
                    expo_push_token: optional_string(record.get("expoPushToken")),
                    sessions: HashMap::new(),
                    updated_at: optional_string(record.get("updatedAt")),
                },
            ))
        })
        .collect()
}

fn required_string(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    required_string(value)
}

// ---------------------------------------------------------------------------
// WS-layer adapter.
// ---------------------------------------------------------------------------

impl crate::rpc::ws::NotificationsHook for NotificationManager {
    fn can_handle_client_request(&self, method: &str) -> bool {
        NotificationManager::can_handle_client_request(self, method)
    }

    fn handle_client_request(
        &self,
        client: Arc<crate::rpc::ws::WsClient>,
        method: String,
        params: Option<Value>,
    ) -> BoxFuture<'_, RpcResult> {
        Box::pin(async move {
            let client: Arc<dyn PushClient> = client;
            NotificationManager::handle_client_request(self, client, &method, params.as_ref())
                .await
        })
    }

    fn record_client_request(
        &self,
        client: &Arc<crate::rpc::ws::WsClient>,
        request: &Value,
        result: &Value,
    ) {
        NotificationManager::record_client_request(self, client.as_ref(), request, result);
    }

    fn on_client_disconnected(&self, client: &Arc<crate::rpc::ws::WsClient>) {
        NotificationManager::on_client_disconnected(self, client.as_ref());
    }
}
