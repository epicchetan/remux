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
use remux::rpc::ws::{DiagnosticEvent, WsHooks, WsLog, WsServer};

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
            if method == "remux/terminal/fail" {
                return Err(JsonRpcError::new(-32000, "boom"));
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
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let echo = Arc::new(EchoServer {
        notifications: notifications.clone(),
    });
    let router = Arc::new(RpcRouter::new(
        vec![("terminal".to_string(), echo as Arc<dyn ExtensionServer>)],
        Some("terminal".to_string()),
        None,
        SystemHooks::default(),
    ));
    let log = Arc::new(CapturingLog::default());
    let server = WsServer::new(router, WsHooks::default(), log.clone());

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
                "method": "remux/terminal/session/write",
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
            "remux/terminal/session/write".to_string(),
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
                "method": "remux/terminal/session/list"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let response = next_text(&mut socket).await;
    assert_eq!(response["id"], json!(7));
    assert_eq!(response["result"]["echo"], json!("remux/terminal/session/list"));
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
            json!({ "jsonrpc": "2.0", "id": 1, "method": "remux/terminal/fail" })
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

    fixture
        .server
        .broadcast(json!({ "method": "remux/extensions/didChangeStatus", "params": { "state": "Running" } }));

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
