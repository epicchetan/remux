//! Integration port of `cli/tests/notifications.test.js`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use remux::notifications::{
    FetchFn, NotificationLog, NotificationManager, PushClient, PushResponse,
};
use remux::rpc::jsonrpc::JsonRpcError;
use remux::rpc::router::BoxFuture;

struct MockClient {
    visible: AtomicBool,
    visibility_checks: Mutex<Vec<Value>>,
    client_id: Mutex<Option<String>>,
    session_id: Mutex<Option<String>>,
}

impl MockClient {
    fn new(visible: bool) -> Arc<Self> {
        Arc::new(Self {
            visible: AtomicBool::new(visible),
            visibility_checks: Mutex::new(Vec::new()),
            client_id: Mutex::new(None),
            session_id: Mutex::new(None),
        })
    }
}

impl PushClient for MockClient {
    fn request_visibility(&self, intent: Value) -> BoxFuture<'_, Result<Value, JsonRpcError>> {
        Box::pin(async move {
            self.visibility_checks.lock().unwrap().push(intent);
            Ok(json!({ "visible": self.visible.load(Ordering::SeqCst) }))
        })
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

#[derive(Default)]
struct CollectingLog {
    events: Mutex<Vec<(String, Value)>>,
}

impl NotificationLog for CollectingLog {
    fn event(&self, label: &str, _level: &'static str, detail: Option<Value>, _silent: bool) {
        self.events
            .lock()
            .unwrap()
            .push((label.to_string(), detail.unwrap_or(Value::Null)));
    }
}

type PushLog = Arc<Mutex<Vec<(String, Value)>>>;

fn recording_fetch(pushes: &PushLog, response: Value) -> FetchFn {
    let pushes = pushes.clone();
    Arc::new(move |url, payload| {
        pushes.lock().unwrap().push((url, payload));
        let body = response.clone();
        Box::pin(async move {
            Ok(PushResponse {
                ok: true,
                status: 200,
                body: Some(body),
            })
        })
    })
}

struct Fixture {
    manager: Arc<NotificationManager>,
    pushes: PushLog,
    log: Arc<CollectingLog>,
    root: tempfile::TempDir,
}

fn fixture() -> Fixture {
    fixture_with_response(json!({ "data": { "id": "ticket-1", "status": "ok" } }))
}

fn fixture_with_response(response: Value) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let pushes: PushLog = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::new(CollectingLog::default());
    let manager =
        NotificationManager::new(root.path(), recording_fetch(&pushes, response), log.clone());
    Fixture {
        manager,
        pushes,
        log,
        root,
    }
}

async fn register(fixture: &Fixture, client: &Arc<MockClient>) {
    fixture
        .manager
        .handle_client_request(
            client.clone(),
            "remux/clients/register",
            Some(&json!({
                "clientId": "client-1",
                "expoPushToken": "ExponentPushToken[test]",
                "sessionId": "session-1",
            })),
        )
        .await
        .unwrap();
}

fn record_turn(fixture: &Fixture, client: &Arc<MockClient>, method: &str) {
    fixture.manager.record_client_request(
        client.as_ref(),
        &json!({ "method": method }),
        &json!({ "threadId": "thread-1", "turnId": "turn-1" }),
    );
}

fn turn_completed_intent() -> Value {
    json!({
        "method": "remux/notifications/request",
        "params": {
            "body": "Open the thread to review the result.",
            "extensionId": "codex",
            "id": "codex:turn-completed:thread-1:turn-1",
            "target": {
                "focusId": "turn-1",
                "focusKind": "turn",
                "resourceId": "thread-1",
                "resourceKind": "thread",
            },
            "title": "Codex finished",
            "viewId": "main",
        }
    })
}

fn terminal_intent(seq: &str) -> Value {
    json!({
        "method": "remux/notifications/request",
        "params": {
            "body": "Open the terminal to continue.",
            "extensionId": "terminal",
            "id": format!("terminal:notification:terminal-session-1:{seq}"),
            "target": {
                "focusId": "terminal-session-1",
                "focusKind": "session",
                "resourceId": "terminal-session-1",
                "resourceKind": "terminalSession",
            },
            "title": "Terminal needs attention",
            "viewId": "main",
        }
    })
}

#[tokio::test]
async fn pushes_turn_completion_to_the_originating_client() {
    let fixture = fixture();
    let client = MockClient::new(false);
    register(&fixture, &client).await;
    record_turn(&fixture, &client, "remux/codex/thread/message/send");

    assert!(
        fixture
            .manager
            .handle_extension_notification(&turn_completed_intent())
            .await
    );

    let pushes = fixture.pushes.lock().unwrap();
    assert_eq!(pushes.len(), 1);
    assert_eq!(pushes[0].0, "https://exp.host/--/api/v2/push/send");
    assert_eq!(
        pushes[0].1,
        json!({
            "body": "Open the thread to review the result.",
            "channelId": "remux-extension-events",
            "data": {
                "remuxNotificationIntent": {
                    "body": "Open the thread to review the result.",
                    "extensionId": "codex",
                    "id": "codex:turn-completed:thread-1:turn-1",
                    "target": {
                        "focusId": "turn-1",
                        "focusKind": "turn",
                        "handlerId": null,
                        "launch": null,
                        "originResourceKey": null,
                        "originTabId": null,
                        "resourceId": "thread-1",
                        "resourceKind": "thread",
                    },
                    "title": "Codex finished",
                    "viewId": "main",
                }
            },
            "interruptionLevel": "active",
            "priority": "high",
            "sound": "default",
            "title": "Codex finished",
            "to": "ExponentPushToken[test]",
        })
    );
}

#[tokio::test]
async fn records_request_origin_and_enriches_delivered_intents() {
    let fixture = fixture();
    let client = MockClient::new(false);
    register(&fixture, &client).await;

    fixture.manager.record_client_request(
        client.as_ref(),
        &json!({
            "method": "remux/codex/thread/message/send",
            "remuxContext": {
                "resourceKey": "[\"codex\",\"main\",\"draft\",\"draft-1\"]",
                "tabId": "codex-tab-1",
            },
        }),
        &json!({ "threadId": "thread-1", "turnId": "turn-1" }),
    );

    assert!(
        fixture
            .manager
            .handle_extension_notification(&turn_completed_intent())
            .await
    );

    let pushes = fixture.pushes.lock().unwrap();
    assert_eq!(pushes.len(), 1);
    let delivered = &pushes[0].1["data"]["remuxNotificationIntent"];
    assert_eq!(
        delivered["target"]["originResourceKey"],
        "[\"codex\",\"main\",\"draft\",\"draft-1\"]"
    );
    assert_eq!(delivered["target"]["originTabId"], "codex-tab-1");

    let checks = client.visibility_checks.lock().unwrap();
    assert_eq!(checks.len(), 1);
    assert_eq!(
        checks[0]["target"]["originResourceKey"],
        "[\"codex\",\"main\",\"draft\",\"draft-1\"]"
    );
    assert_eq!(checks[0]["target"]["originTabId"], "codex-tab-1");
}

#[tokio::test]
async fn logs_push_body_preview_metadata() {
    let fixture = fixture();
    let client = MockClient::new(false);
    register(&fixture, &client).await;
    record_turn(&fixture, &client, "remux/codex/thread/message/send");

    fixture
        .manager
        .handle_extension_notification(&turn_completed_intent())
        .await;

    let events = fixture.log.events.lock().unwrap();
    let sent = events
        .iter()
        .find(|(label, _)| label == "notifications:push:sent")
        .expect("push sent logged");
    assert_eq!(sent.1["intent"]["title"], "Codex finished");
    assert_eq!(
        sent.1["intent"]["bodyPreview"],
        "Open the thread to review the result."
    );
    assert_eq!(sent.1["intent"]["bodyLength"], 37);
}

#[tokio::test]
async fn suppresses_push_when_originating_client_is_viewing_target() {
    let fixture = fixture();
    let client = MockClient::new(true);
    register(&fixture, &client).await;
    record_turn(&fixture, &client, "remux/codex/thread/message/send");

    assert!(
        fixture
            .manager
            .handle_extension_notification(&turn_completed_intent())
            .await
    );
    assert_eq!(fixture.pushes.lock().unwrap().len(), 0);
    let events = fixture.log.events.lock().unwrap();
    assert!(events
        .iter()
        .any(|(label, _)| label == "notifications:push:suppressed-visible"));
}

#[tokio::test]
async fn records_edit_fork_send_start_as_turn_audiences() {
    for method in [
        "remux/codex/thread/message/edit",
        "remux/codex/thread/message/fork",
        "remux/codex/thread/message/send",
        "remux/codex/thread/message/start",
    ] {
        let fixture = fixture();
        let client = MockClient::new(false);
        register(&fixture, &client).await;
        record_turn(&fixture, &client, method);

        assert!(
            fixture
                .manager
                .handle_extension_notification(&turn_completed_intent())
                .await
        );
        assert_eq!(
            fixture.pushes.lock().unwrap().len(),
            1,
            "{method} should notify"
        );
    }
}

#[tokio::test]
async fn treats_codex_turn_audiences_as_one_shot() {
    let fixture = fixture();
    let client = MockClient::new(false);
    register(&fixture, &client).await;
    record_turn(&fixture, &client, "remux/codex/thread/message/send");

    assert!(
        fixture
            .manager
            .handle_extension_notification(&turn_completed_intent())
            .await
    );
    assert!(
        fixture
            .manager
            .handle_extension_notification(&turn_completed_intent())
            .await
    );
    assert_eq!(fixture.pushes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn keeps_terminal_session_audiences_until_kill_or_extension_release() {
    let fixture = fixture();
    let client = MockClient::new(false);
    register(&fixture, &client).await;

    fixture.manager.record_client_request(
        client.as_ref(),
        &json!({ "method": "remux/terminal/session/start" }),
        &json!({ "sessionId": "terminal-session-1", "status": "running" }),
    );

    assert!(fixture.manager.handle_extension_notification(&terminal_intent("1")).await);
    assert!(fixture.manager.handle_extension_notification(&terminal_intent("2")).await);
    assert_eq!(fixture.pushes.lock().unwrap().len(), 2);

    // Kill removes the audience.
    fixture.manager.record_client_request(
        client.as_ref(),
        &json!({
            "method": "remux/terminal/session/kill",
            "params": { "sessionId": "terminal-session-1" },
        }),
        &json!({ "ok": true }),
    );
    assert!(fixture.manager.handle_extension_notification(&terminal_intent("3")).await);
    assert_eq!(fixture.pushes.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn removes_terminal_audiences_from_extension_release() {
    let fixture = fixture();
    let client = MockClient::new(false);
    register(&fixture, &client).await;

    fixture.manager.record_client_request(
        client.as_ref(),
        &json!({ "method": "remux/terminal/session/attach" }),
        &json!({ "sessionId": "terminal-session-1", "status": "running" }),
    );

    let release = json!({
        "method": "remux/notifications/audience/remove",
        "params": {
            "extensionId": "terminal",
            "target": {
                "focusId": "terminal-session-1",
                "focusKind": "session",
                "resourceId": "terminal-session-1",
                "resourceKind": "terminalSession",
            },
            "viewId": "main",
        }
    });
    assert!(fixture.manager.handle_extension_notification(&release).await);
    assert!(fixture.manager.handle_extension_notification(&terminal_intent("1")).await);
    assert_eq!(fixture.pushes.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn persists_clients_json_v1_and_clears_token_on_device_not_registered() {
    let fixture = fixture_with_response(json!({
        "data": {
            "status": "error",
            "details": { "error": "DeviceNotRegistered" },
        }
    }));
    let client = MockClient::new(false);
    register(&fixture, &client).await;

    let store_path = fixture.root.path().join(".remux/notifications/clients.json");
    let stored: Value =
        serde_json::from_str(&std::fs::read_to_string(&store_path).unwrap()).unwrap();
    assert_eq!(stored["version"], 1);
    assert_eq!(
        stored["clients"]["client-1"]["expoPushToken"],
        "ExponentPushToken[test]"
    );
    assert!(stored["clients"]["client-1"]["updatedAt"].is_string());

    record_turn(&fixture, &client, "remux/codex/thread/message/send");
    fixture
        .manager
        .handle_extension_notification(&turn_completed_intent())
        .await;

    // Ticket error with DeviceNotRegistered clears the persisted token.
    let stored: Value =
        serde_json::from_str(&std::fs::read_to_string(&store_path).unwrap()).unwrap();
    assert_eq!(stored["clients"]["client-1"]["expoPushToken"], Value::Null);
    let events = fixture.log.events.lock().unwrap();
    assert!(events
        .iter()
        .any(|(label, _)| label == "notifications:push:ticket-error"));
}

#[tokio::test]
async fn persisted_tokens_survive_manager_restarts() {
    let root = tempfile::tempdir().unwrap();
    let pushes: PushLog = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::new(CollectingLog::default());
    let response = json!({ "data": { "id": "ticket-1", "status": "ok" } });

    {
        let manager = NotificationManager::new(
            root.path(),
            recording_fetch(&pushes, response.clone()),
            log.clone(),
        );
        let client = MockClient::new(false);
        manager
            .handle_client_request(
                client.clone(),
                "remux/clients/register",
                Some(&json!({
                    "clientId": "client-1",
                    "expoPushToken": "ExponentPushToken[test]",
                    "sessionId": "session-1",
                })),
            )
            .await
            .unwrap();
    }

    // A new manager (fresh process) loads the same store — the cutover
    // continuity guarantee for push tokens.
    let manager =
        NotificationManager::new(root.path(), recording_fetch(&pushes, response), log.clone());
    let client = MockClient::new(false);
    manager
        .handle_client_request(
            client.clone(),
            "remux/clients/register",
            Some(&json!({ "clientId": "client-1", "sessionId": "session-2" })),
        )
        .await
        .unwrap();
    manager.record_client_request(
        client.as_ref(),
        &json!({ "method": "remux/codex/thread/message/send" }),
        &json!({ "threadId": "thread-1", "turnId": "turn-1" }),
    );
    manager
        .handle_extension_notification(&turn_completed_intent())
        .await;

    let pushes = pushes.lock().unwrap();
    assert_eq!(pushes.len(), 1, "token from disk should still deliver");
    assert_eq!(pushes[0].1["to"], "ExponentPushToken[test]");
}

#[tokio::test]
async fn intents_without_audience_are_owned_but_not_pushed() {
    let fixture = fixture();
    assert!(
        fixture
            .manager
            .handle_extension_notification(&turn_completed_intent())
            .await
    );
    assert_eq!(fixture.pushes.lock().unwrap().len(), 0);
    {
        let events = fixture.log.events.lock().unwrap();
        assert!(events
            .iter()
            .any(|(label, _)| label == "notifications:intent:no-audience"));
    }

    // Non-notification methods are not owned.
    assert!(
        !fixture
            .manager
            .handle_extension_notification(&json!({ "method": "remux/codex/turn/started" }))
            .await
    );
}
