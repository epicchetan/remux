use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::http::{header, HeaderMap, HeaderValue, Request, Response, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::routing::{any, get};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use remux::auth::{require_auth, AuthState};
use remux::extensions::manifest::{
    Display, ExtensionManifest, GatewaySpec, ServerSpec, View, MIN_GATEWAY_MAX_REQUEST_BODY_BYTES,
};
use remux::http::extension_gateways::ExtensionGatewayRegistry;
use remux::http::viewer_bundles::ViewerBundleRegistry;
use remux::http::viewers::ViewerProvider;
use remux::http::{build_router, compression_layer, HttpState};
use remux::logs::{Journal, StdTerminal};
use remux::rpc::ws::WsLog;
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

const TOKEN: &str = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const GENERATION: u64 = 7;

fn fixture_extension(root: &std::path::Path) -> ExtensionManifest {
    let dist = root.join("viewer/dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "gateway fixture").unwrap();
    ExtensionManifest {
        id: "fixture-gateway".to_string(),
        name: "Gateway fixture".to_string(),
        root_dir: root.to_path_buf(),
        display: Display {
            icon: None,
            icon_dark: None,
            title: "Gateway fixture".to_string(),
        },
        server: Some(ServerSpec {
            transport: "stdio".to_string(),
            command: "fixture".to_string(),
            args: Vec::new(),
            cwd: root.to_path_buf(),
            build: None,
        }),
        gateway: Some(GatewaySpec {
            transport: "http+websocket".to_string(),
            max_request_body_bytes: MIN_GATEWAY_MAX_REQUEST_BODY_BYTES,
        }),
        views: vec![(
            "main".to_string(),
            View {
                cache: Default::default(),
                entry: dist.join("index.html"),
                host_chrome: Default::default(),
                route: "/viewers/fixture-gateway".to_string(),
                build: None,
                watch: None,
            },
        )],
        launchers: Vec::new(),
        file_handlers: Vec::new(),
        workloads: Default::default(),
    }
}

async fn inspect(request: Request<Body>) -> Response<Body> {
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or_default().to_string();
    let authorization = request.headers().contains_key(header::AUTHORIZATION);
    let cookie = request.headers().contains_key(header::COOKIE);
    let forwarded = request.headers().contains_key("x-forwarded-for");
    let generation = request
        .headers()
        .get("x-remux-extension-generation")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = to_bytes(request.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::json!({
                "method": method,
                "path": path,
                "query": query,
                "authorization": authorization,
                "cookie": cookie,
                "forwarded": forwarded,
                "generation": generation,
                "bodyBytes": body.len(),
            })
            .to_string(),
        ))
        .unwrap()
}

async fn redirect() -> Response<Body> {
    Response::builder()
        .status(StatusCode::TEMPORARY_REDIRECT)
        .header(header::LOCATION, "/inspect?from=redirect")
        .header(header::SET_COOKIE, "upstream_secret=must-not-escape")
        .body(Body::empty())
        .unwrap()
}

async fn bad_redirect() -> Response<Body> {
    Response::builder()
        .status(StatusCode::TEMPORARY_REDIRECT)
        .header(header::LOCATION, "http://127.0.0.1:65535/private")
        .body(Body::empty())
        .unwrap()
}

async fn websocket(upgrade: WebSocketUpgrade, headers: HeaderMap, uri: Uri) -> Response<Body> {
    let credentials_seen = headers.contains_key(header::AUTHORIZATION)
        || headers.contains_key(header::COOKIE)
        || headers.contains_key("x-forwarded-for");
    let mut response = upgrade
        .on_upgrade(|mut socket| async move {
            while let Some(Ok(message)) = socket.next().await {
                if matches!(message, Message::Close(_)) {
                    break;
                }
                if socket.send(message).await.is_err() {
                    break;
                }
            }
        })
        .into_response();
    response.headers_mut().insert(
        "x-fixture-browser-credentials-seen",
        HeaderValue::from_static(if credentials_seen { "true" } else { "false" }),
    );
    if let Some(generation) = headers.get("x-remux-extension-generation") {
        response
            .headers_mut()
            .insert("x-fixture-generation", generation.clone());
    }
    if let Some(query) = uri.query() {
        response.headers_mut().insert(
            "x-fixture-query",
            HeaderValue::from_str(query).expect("fixture query header"),
        );
    }
    response
}

async fn start_private_bridge(socket_path: &std::path::Path) -> tokio::task::JoinHandle<()> {
    let listener = tokio::net::UnixListener::bind(socket_path).unwrap();
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let app = Router::new()
        .route("/inspect", any(inspect))
        .route("/redirect", get(redirect))
        .route("/bad-redirect", get(bad_redirect))
        .route(
            "/plain",
            get(|| async { "uncompressed gateway payload ".repeat(128) }),
        )
        .route("/ws", get(websocket));
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    })
}

async fn start_remux(
    root: &std::path::Path,
    extension: &ExtensionManifest,
    registry: ExtensionGatewayRegistry,
    journal: Arc<Journal>,
) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let viewer_bundles = ViewerBundleRegistry::new(root, &[extension.clone()], journal.clone());
    let state = Arc::new(HttpState {
        viewer_providers: ViewerProvider::for_extension(extension, viewer_bundles.clone()),
        viewer_bundles,
        default_extension: extension.clone(),
        extensions: vec![extension.clone()],
        invalid_extensions: Vec::new(),
        media_root: root.join(".remux/cache/media"),
        extension_gateways: registry,
    });
    let auth = Arc::new(AuthState {
        token: TOKEN.to_string(),
        require_auth: true,
        log: journal as Arc<dyn WsLog>,
    });
    let app = build_router(state)
        .layer(axum::middleware::from_fn_with_state(auth, require_auth))
        .layer(compression_layer())
        .into_make_service_with_connect_info::<SocketAddr>();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (address, task)
}

fn authorized_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

#[tokio::test]
async fn authenticated_http_and_websocket_gateway_is_generation_fenced() {
    let root = tempfile::tempdir().unwrap();
    let extension = fixture_extension(root.path());
    let registry = ExtensionGatewayRegistry::new(root.path(), &[extension.clone()]).unwrap();
    let socket_path = registry
        .prepare_generation(&extension.id, GENERATION)
        .unwrap()
        .unwrap();
    let journal = Journal::new(root.path(), 1, Arc::new(StdTerminal)).unwrap();
    let (address, remux_task) =
        start_remux(root.path(), &extension, registry.clone(), journal).await;
    let origin = format!("http://{address}");
    let mount = "/remux/extensions/fixture-gateway/gateway";
    let client = authorized_client();

    let unauthorized = client
        .get(format!("{origin}{mount}/inspect"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let before_ready = client
        .get(format!("{origin}{mount}/inspect"))
        .header(header::COOKIE, format!("remux_auth={TOKEN}"))
        .send()
        .await
        .unwrap();
    assert_eq!(before_ready.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(before_ready.headers()[header::RETRY_AFTER], "1");

    let private_task = start_private_bridge(&socket_path).await;
    registry
        .activate_generation(&extension.id, GENERATION)
        .unwrap();

    let inspected_response = client
        .post(format!(
            "{origin}{mount}/inspect?token=browser-secret&x=hello%20world"
        ))
        .header(
            header::COOKIE,
            format!("remux_auth={TOKEN}; browser_secret=must-not-cross"),
        )
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .header("x-forwarded-for", "203.0.113.9")
        .body("streamed-body")
        .send()
        .await
        .unwrap();
    assert_eq!(
        inspected_response.headers()["x-remux-extension-generation"],
        GENERATION.to_string()
    );
    let inspected: Value = inspected_response
        .json()
        .await
        .unwrap();
    assert_eq!(inspected["method"], "POST");
    assert_eq!(inspected["path"], "/inspect");
    assert_eq!(inspected["query"], "x=hello+world");
    assert_eq!(inspected["authorization"], false);
    assert_eq!(inspected["cookie"], false);
    assert_eq!(inspected["forwarded"], false);
    assert_eq!(inspected["generation"], GENERATION.to_string());
    assert_eq!(inspected["bodyBytes"], 13);

    let redirect = client
        .get(format!("{origin}{mount}/redirect"))
        .header(header::COOKIE, format!("remux_auth={TOKEN}"))
        .send()
        .await
        .unwrap();
    assert_eq!(redirect.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        redirect.headers()[header::LOCATION],
        "/remux/extensions/fixture-gateway/gateway/inspect?from=redirect"
    );
    assert!(!redirect.headers().contains_key(header::SET_COOKIE));

    let bad_redirect = client
        .get(format!("{origin}{mount}/bad-redirect"))
        .header(header::COOKIE, format!("remux_auth={TOKEN}"))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_redirect.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(
        bad_redirect.json::<Value>().await.unwrap()["error"],
        "extension_gateway_invalid_redirect"
    );

    let plain = client
        .get(format!("{origin}{mount}/plain"))
        .header(header::COOKIE, format!("remux_auth={TOKEN}"))
        .header(header::ACCEPT_ENCODING, "gzip")
        .send()
        .await
        .unwrap();
    assert!(!plain.headers().contains_key(header::CONTENT_ENCODING));

    let oversized = client
        .post(format!("{origin}{mount}/inspect"))
        .header(header::COOKIE, format!("remux_auth={TOKEN}"))
        .body(vec![b'x'; MIN_GATEWAY_MAX_REQUEST_BODY_BYTES as usize + 1])
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let mut websocket_request =
        format!("ws://{address}{mount}/ws?wsTicket=fixture-ticket&token=browser-secret")
            .into_client_request()
            .unwrap();
    websocket_request.headers_mut().insert(
        header::COOKIE,
        format!("remux_auth={TOKEN}").parse().unwrap(),
    );
    websocket_request
        .headers_mut()
        .insert("x-forwarded-for", "203.0.113.10".parse().unwrap());
    let (mut socket, handshake) = tokio_tungstenite::connect_async(websocket_request)
        .await
        .unwrap();
    assert_eq!(
        handshake.headers()["x-fixture-browser-credentials-seen"],
        "false"
    );
    assert_eq!(handshake.headers()["x-fixture-generation"], "7");
    assert_eq!(
        handshake.headers()["x-remux-extension-generation"],
        "7"
    );
    assert_eq!(
        handshake.headers()["x-fixture-query"],
        "wsTicket=fixture-ticket"
    );
    socket
        .send(tokio_tungstenite::tungstenite::Message::Binary(
            vec![0, 1, 2, 255].into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        socket.next().await.unwrap().unwrap(),
        tokio_tungstenite::tungstenite::Message::Binary(vec![0, 1, 2, 255].into())
    );

    registry.retire_generation(&extension.id, GENERATION);
    let close = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("generation retirement closes the WebSocket")
        .expect("close frame")
        .expect("valid close frame");
    let tokio_tungstenite::tungstenite::Message::Close(Some(close)) = close else {
        panic!("expected close frame, got {close:?}");
    };
    assert_eq!(close.code, CloseCode::Restart);
    assert_eq!(close.reason, "service restart");

    assert!(
        socket_path.exists(),
        "socket remains until child reap cleanup"
    );
    registry.cleanup_generation(&extension.id, GENERATION);
    assert!(!socket_path.exists());
    let after_retire = client
        .get(format!("{origin}{mount}/inspect"))
        .header(header::COOKIE, format!("remux_auth={TOKEN}"))
        .send()
        .await
        .unwrap();
    assert_eq!(after_retire.status(), StatusCode::SERVICE_UNAVAILABLE);

    private_task.abort();
    remux_task.abort();
}
