//! Integration port of `cli/tests/ws-server.test.js`, plus request/response
//! round-trip and host→client request coverage.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use remux::rpc::jsonrpc::JsonRpcError;
use remux::rpc::router::{
    BoxFuture, ExtensionServer, RpcResult, RpcRouter, ServerStatus, SystemHooks,
};
use remux::rpc::ws::{DiagnosticEvent, NotificationsHook, WsClient, WsHooks, WsLog, WsServer};

type NotificationLog = Arc<Mutex<Vec<(String, Option<Value>)>>>;

#[derive(Default)]
struct CapturingLog {
    messages: Mutex<Vec<String>>,
    warnings: Mutex<Vec<String>>,
    events: Mutex<Vec<DiagnosticEvent>>,
}

impl WsLog for CapturingLog {
    fn log(&self, message: &str) {
        self.messages.lock().unwrap().push(message.to_string());
    }
    fn warn(&self, message: &str) {
        self.warnings.lock().unwrap().push(message.to_string());
    }
    fn error(&self, message: &str) {
        self.messages.lock().unwrap().push(message.to_string());
    }
    fn event(&self, event: DiagnosticEvent) {
        self.messages.lock().unwrap().push(event.message.clone());
        self.events.lock().unwrap().push(event);
    }
}

struct EchoServer {
    notifications: NotificationLog,
}

impl ExtensionServer for EchoServer {
    fn start(&self, _rebuild: bool) -> BoxFuture<'_, ServerStatus> {
        Box::pin(async { self.status() })
    }
    fn stop(&self) -> BoxFuture<'_, ServerStatus> {
        Box::pin(async { self.status() })
    }
    fn restart(&self, _rebuild: bool) -> BoxFuture<'_, ServerStatus> {
        Box::pin(async { self.status() })
    }
    fn handle_rpc(&self, method: String, params: Option<Value>) -> BoxFuture<'_, RpcResult> {
        Box::pin(async move {
            if params
                .as_ref()
                .and_then(|params| params.get("testFail"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                return Err(JsonRpcError::new(-32000, "boom"));
            }
            if params
                .as_ref()
                .and_then(|params| params.get("testSlow"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            Ok(json!({ "echo": method, "params": params }))
        })
    }
    fn handle_notification(&self, method: String, params: Option<Value>) {
        self.notifications.lock().unwrap().push((method, params));
    }
    fn status(&self) -> ServerStatus {
        ServerStatus {
            restartable: true,
            running: true,
            state: "Running".to_string(),
            pid: None,
            started_at_ms: None,
            restart_count: 0,
            last_exit: None,
            has_build: false,
            has_server: true,
            has_server_build: false,
            views: remux::rpc::router::ViewsFacet::default(),
            watch: remux::rpc::router::WatchFacet::default(),
        }
    }
    fn logs(&self, _lines: usize) -> Value {
        json!([])
    }
}

struct Fixture {
    addr: SocketAddr,
    log: Arc<CapturingLog>,
    notifications: NotificationLog,
    server: Arc<WsServer>,
}

async fn start_fixture() -> Fixture {
    start_fixture_with_hooks(WsHooks::default()).await
}

async fn start_fixture_with_hooks(hooks: WsHooks) -> Fixture {
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let echo = Arc::new(EchoServer {
        notifications: notifications.clone(),
    });
    let router = Arc::new(RpcRouter::new(
        vec![
            (
                "terminal".to_string(),
                echo.clone() as Arc<dyn ExtensionServer>,
            ),
            ("ledger".to_string(), echo as Arc<dyn ExtensionServer>),
        ],
        Some("terminal".to_string()),
        None,
        SystemHooks::default(),
    ));
    let log = Arc::new(CapturingLog::default());
    let server = WsServer::new(router, hooks, log.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = server
        .route()
        .into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    Fixture {
        addr,
        log,
        notifications,
        server,
    }
}

struct HostRoundTripHook;

impl NotificationsHook for HostRoundTripHook {
    fn can_handle_client_request(&self, method: &str) -> bool {
        method == "remux/test/host-roundtrip"
    }

    fn handle_client_request(
        &self,
        client: Arc<WsClient>,
        _method: String,
        _params: Option<Value>,
    ) -> BoxFuture<'_, RpcResult> {
        Box::pin(async move {
            let result = client
                .request(
                    "remux/test/client-check",
                    Some(json!({ "visible": true })),
                    500,
                )
                .await?;
            Ok(json!({ "clientResult": result }))
        })
    }

    fn record_client_request(&self, _client: &Arc<WsClient>, _request: &Value, _result: &Value) {}

    fn on_client_disconnected(&self, _client: &Arc<WsClient>) {}
}

struct DelayedRegistrationHook;

impl NotificationsHook for DelayedRegistrationHook {
    fn can_handle_client_request(&self, method: &str) -> bool {
        method == "remux/clients/register"
    }

    fn handle_client_request(
        &self,
        _client: Arc<WsClient>,
        _method: String,
        _params: Option<Value>,
    ) -> BoxFuture<'_, RpcResult> {
        Box::pin(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            Ok(json!({ "registered": true }))
        })
    }

    fn record_client_request(&self, _client: &Arc<WsClient>, _request: &Value, _result: &Value) {}

    fn on_client_disconnected(&self, _client: &Arc<WsClient>) {}
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(addr: SocketAddr) -> WsStream {
    let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .unwrap();
    socket
}

async fn next_text(socket: &mut WsStream) -> Value {
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(1), socket.next())
            .await
            .expect("timed out waiting for frame")
            .expect("socket closed")
            .expect("socket error")
        {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("unexpected frame: {other:?}"),
        }
    }
}

#[tokio::test]
async fn logs_app_diagnostics_without_routing_them_as_rpc_requests() {
    let fixture = start_fixture().await;
    let mut socket = connect(fixture.addr).await;

    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "method": "remux/app/log",
                "params": {
                    "detail": { "state": "background" },
                    "label": "app:state:change",
                    "timestamp": "2026-06-20T00:00:00.000Z",
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    // Wait for the diagnostic to be logged.
    for _ in 0..50 {
        if fixture
            .log
            .messages
            .lock()
            .unwrap()
            .iter()
            .any(|message| message.contains("[remux:app]"))
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    assert!(fixture.log.warnings.lock().unwrap().is_empty());
    let messages = fixture.log.messages.lock().unwrap();
    assert!(
        messages.iter().any(|message| {
            message.contains("[remux:app] 2026-06-20T00:00:00.000Z app:state:change")
                && message.contains("\"state\":\"background\"")
        }),
        "{messages:?}"
    );
    assert!(fixture.notifications.lock().unwrap().is_empty());
}

#[tokio::test]
async fn routes_downstream_notifications_without_sending_a_response() {
    let fixture = start_fixture().await;
    let mut socket = connect(fixture.addr).await;

    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "method": "remux/terminal/session/input-preview",
                "params": { "dataBase64": "YQ==", "sessionId": "session-1" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    for _ in 0..50 {
        if !fixture.notifications.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    assert_eq!(
        fixture.notifications.lock().unwrap().clone(),
        vec![(
            "remux/terminal/session/input-preview".to_string(),
            Some(json!({ "dataBase64": "YQ==", "sessionId": "session-1" }))
        )]
    );

    // No response frame should arrive for a notification; a subsequent request
    // must be the next (and only) response.
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "remux/terminal/session/list",
                "remuxContract": { "kind": "query" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let response = next_text(&mut socket).await;
    assert_eq!(response["id"], json!(7));
    assert_eq!(
        response["result"]["echo"],
        json!("remux/terminal/session/list")
    );
    assert!(fixture.log.warnings.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rejects_notifications_for_must_ack_methods() {
    let fixture = start_fixture().await;
    let mut socket = connect(fixture.addr).await;
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "method": "remux/terminal/session/write",
                "params": { "dataBase64": "YQ==", "sessionId": "session-1" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(fixture.notifications.lock().unwrap().is_empty());
    assert!(fixture
        .log
        .warnings
        .lock()
        .unwrap()
        .iter()
        .any(|warning| warning.contains("must-ack method=remux/terminal/session/write")));
}

#[tokio::test]
async fn job_start_acks_immediately_and_exposes_terminal_state() {
    let fixture = start_fixture().await;
    let mut socket = connect(fixture.addr).await;
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": 71,
                "method": "remux/terminal/session/list",
                "remuxContract": { "kind": "job-start", "operationId": "test-job-71" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    let admission = next_text(&mut socket).await;
    assert_eq!(admission["id"], 71);
    assert_eq!(admission["result"]["accepted"], true);
    assert_eq!(admission["result"]["operationId"], "test-job-71");

    let mut completed = false;
    for _ in 0..6 {
        let event = next_text(&mut socket).await;
        if event["method"] == "remux/jobs/didChange" && event["params"]["state"] == "completed" {
            completed = true;
            break;
        }
    }
    assert!(completed);

    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": 72,
                "method": "remux/jobs/read",
                "params": { "operationId": "test-job-71" },
                "remuxContract": { "kind": "query", "resourceKey": "job:test-job-71" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let snapshot = next_text(&mut socket).await;
    assert_eq!(snapshot["result"]["state"], "completed");
}

#[tokio::test]
async fn registration_is_a_barrier_for_later_extension_work() {
    let fixture = start_fixture_with_hooks(WsHooks {
        notifications: Some(Arc::new(DelayedRegistrationHook)),
        ..WsHooks::default()
    })
    .await;
    let mut socket = connect(fixture.addr).await;
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0", "id": 1, "method": "remux/clients/register",
                "remuxContract": { "kind": "subscription" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0", "id": 2, "method": "remux/terminal/session/list",
                "remuxContract": { "kind": "query" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    assert_eq!(next_text(&mut socket).await["id"], json!(1));
    assert_eq!(next_text(&mut socket).await["id"], json!(2));
}

#[tokio::test]
async fn slow_business_request_does_not_block_same_socket_control_request() {
    let fixture = start_fixture().await;
    let mut socket = connect(fixture.addr).await;

    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "remux/terminal/tmux/action",
                "remuxContract": { "kind": "command" },
                "params": { "testSlow": true }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0", "id": 2, "method": "remux/system/ping",
                "remuxContract": { "kind": "query" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    let fast = tokio::time::timeout(
        std::time::Duration::from_millis(150),
        next_text(&mut socket),
    )
    .await
    .expect("ping was blocked behind slow business RPC");
    assert_eq!(fast["id"], json!(2));
    assert_eq!(fast["result"], json!({ "ok": true }));

    let slow = next_text(&mut socket).await;
    assert_eq!(slow["id"], json!(1));
    assert_eq!(slow["result"]["echo"], json!("remux/terminal/tmux/action"));
}

#[tokio::test]
async fn slow_extension_does_not_block_another_extension_lane() {
    let fixture = start_fixture().await;
    let mut socket = connect(fixture.addr).await;

    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": 11,
                "method": "remux/terminal/tmux/action",
                "remuxContract": { "kind": "command" },
                "params": { "testSlow": true }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0", "id": 12, "method": "remux/ledger/read",
                "remuxContract": { "kind": "query" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    let fast = tokio::time::timeout(
        std::time::Duration::from_millis(150),
        next_text(&mut socket),
    )
    .await
    .expect("ledger was blocked behind terminal");
    assert_eq!(fast["id"], json!(12));
    assert_eq!(fast["result"]["echo"], json!("remux/ledger/read"));

    let slow = next_text(&mut socket).await;
    assert_eq!(slow["id"], json!(11));
}

#[tokio::test]
async fn host_request_response_is_consumed_while_app_request_is_pending() {
    let fixture = start_fixture_with_hooks(WsHooks {
        notifications: Some(Arc::new(HostRoundTripHook)),
        ..WsHooks::default()
    })
    .await;
    let mut socket = connect(fixture.addr).await;

    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0", "id": 8, "method": "remux/test/host-roundtrip",
                "remuxContract": { "kind": "query" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    let host_request = next_text(&mut socket).await;
    assert_eq!(host_request["method"], json!("remux/test/client-check"));
    let host_id = host_request["id"].clone();
    socket
        .send(Message::Text(
            json!({ "jsonrpc": "2.0", "id": host_id, "result": { "visible": true } })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();

    let response = next_text(&mut socket).await;
    assert_eq!(response["id"], json!(8));
    assert_eq!(response["result"]["clientResult"]["visible"], json!(true));
    assert!(fixture.log.warnings.lock().unwrap().is_empty());
}

#[tokio::test]
async fn responds_with_errors_for_parse_failures_and_rpc_errors() {
    let fixture = start_fixture().await;
    let mut socket = connect(fixture.addr).await;

    socket
        .send(Message::Text("{".to_string().into()))
        .await
        .unwrap();
    let parse_error = next_text(&mut socket).await;
    assert_eq!(
        parse_error,
        json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": { "code": -32700, "message": "Parse error" }
        })
    );

    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "remux/terminal/session/list",
                "remuxContract": { "kind": "query" },
                "params": { "testFail": true }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let error = next_text(&mut socket).await;
    assert_eq!(
        error,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": { "code": -32000, "message": "boom" }
        })
    );

    // Method-less non-requests get an invalid request error.
    socket
        .send(Message::Text(json!({ "hello": 1 }).to_string().into()))
        .await
        .unwrap();
    let invalid = next_text(&mut socket).await;
    assert_eq!(invalid["error"]["code"], json!(-32600));
}

#[tokio::test]
async fn broadcast_adds_jsonrpc_version_and_reaches_clients() {
    let fixture = start_fixture().await;
    let mut socket = connect(fixture.addr).await;

    // Wait for registration before broadcasting.
    for _ in 0..50 {
        if fixture.server.client_count() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    fixture.server.broadcast(
        json!({ "method": "remux/extensions/didChangeStatus", "params": { "state": "Running" } }),
    );

    let frame = next_text(&mut socket).await;
    assert_eq!(
        frame,
        json!({
            "jsonrpc": "2.0",
            "method": "remux/extensions/didChangeStatus",
            "params": { "state": "Running" }
        })
    );
}

#[tokio::test]
async fn extension_origins_are_opaque_stable_and_target_one_downstream_context() {
    let fixture = start_fixture().await;
    let mut first = connect(fixture.addr).await;
    let mut second = connect(fixture.addr).await;

    first
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": 41,
                "method": "remux/terminal/session/attach",
                "remuxContract": { "kind": "subscription" },
                "params": { "projection": "bars:1m" },
                "remuxContext": { "tabId": "tab-a", "resourceKey": "replay-a" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let response = next_text(&mut first).await;
    let origin = response["result"]["params"]["_remuxOrigin"]
        .as_str()
        .expect("origin injected into extension params")
        .to_string();
    assert!(origin.starts_with("remux-origin-"));

    first
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": 42,
                "method": "remux/terminal/session/attach",
                "remuxContract": { "kind": "subscription" },
                "params": {},
                "remuxContext": { "tabId": "tab-a", "resourceKey": "replay-a" }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let repeated = next_text(&mut first).await;
    assert_eq!(
        repeated["result"]["params"]["_remuxOrigin"],
        Value::from(origin.clone())
    );

    assert!(fixture.server.send_to_origin(
        &origin,
        json!({ "method": "remux/terminal/projections/frame", "params": { "seq": 1 } })
    ));
    assert_eq!(
        next_text(&mut first).await,
        json!({
            "jsonrpc": "2.0",
            "method": "remux/terminal/projections/frame",
            "params": { "seq": 1 }
        })
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), second.next())
            .await
            .is_err(),
        "unrelated socket must not receive a targeted extension frame"
    );
}
