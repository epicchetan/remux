//! Pass-3a middleware matrix (spec `docs/specs/cli-rust-port-pass-3-auth.md`):
//! the bearer layer over the merged `/ws` + HTTP router — health exemption,
//! header/cookie/query acceptance, 401 shape, the Set-Cookie hand-off, and
//! `require_auth = false`.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use remux::auth::{require_auth, AuthState};
use remux::extensions::manifest::{Display, ExtensionManifest, FileHandler, View};
use remux::http::viewer_bundles::ViewerBundleRegistry;
use remux::http::viewers::ViewerProvider;
use remux::http::{build_router, HttpState};
use remux::logs::{Journal, StdTerminal};
use remux::rpc::router::{RpcRouter, SystemHooks};
use remux::rpc::ws::{DiagnosticEvent, WsHooks, WsLog, WsServer};

const TOKEN: &str = "f00dfacecafe0123f00dfacecafe0123f00dfacecafe0123f00dfacecafe0123";

#[derive(Default)]
struct RejectLog {
    warnings: Mutex<Vec<String>>,
}

impl WsLog for RejectLog {
    fn log(&self, _message: &str) {}
    fn warn(&self, message: &str) {
        self.warnings.lock().unwrap().push(message.to_string());
    }
    fn error(&self, _message: &str) {}
    fn event(&self, _event: DiagnosticEvent) {}
}

fn fixture_extension(root: &std::path::Path) -> ExtensionManifest {
    let dist = root.join("viewer/dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("index.html"), "viewer").unwrap();
    std::fs::write(dist.join("assets/index.js"), "console.log('asset')").unwrap();

    ExtensionManifest {
        id: "fixture".to_string(),
        name: "Fixture".to_string(),
        root_dir: root.to_path_buf(),
        display: Display {
            icon: None,
            icon_dark: None,
            title: "Fixture".to_string(),
        },
        server: None,
        views: vec![(
            "main".to_string(),
            View {
                cache: Default::default(),
                entry: dist.join("index.html"),
                route: "/viewers/fixture".to_string(),
                build: None,
                watch: None,
            },
        )],
        launchers: Vec::new(),
        file_handlers: Vec::<FileHandler>::new(),
        workloads: Default::default(),
    }
}

struct Harness {
    addr: SocketAddr,
    log: Arc<RejectLog>,
}

/// The same assembly as `run_worker`: WS route merged with the HTTP router,
/// auth layered over both, ConnectInfo enabled.
async fn serve(root: &std::path::Path, require: bool) -> Harness {
    let extension = fixture_extension(root);
    let journal = Journal::new(root, 1, Arc::new(StdTerminal)).unwrap();
    let viewer_bundles = ViewerBundleRegistry::new(root, &[extension.clone()], journal);
    viewer_bundles.publish_all().await;
    let state = Arc::new(HttpState {
        viewer_providers: ViewerProvider::for_extension(&extension, viewer_bundles.clone()),
        viewer_bundles,
        default_extension: extension.clone(),
        extensions: vec![extension],
        invalid_extensions: Vec::new(),
        media_root: root.join(".remux/cache/media"),
    });
    let router = Arc::new(RpcRouter::new(
        Vec::new(),
        None,
        None,
        SystemHooks::default(),
    ));
    let log = Arc::new(RejectLog::default());
    let ws = WsServer::new(router, WsHooks::default(), log.clone());
    let auth_state = Arc::new(AuthState {
        token: TOKEN.to_string(),
        require_auth: require,
        log: log.clone() as Arc<dyn WsLog>,
    });
    let app = ws
        .route()
        .merge(build_router(state))
        .layer(axum::middleware::from_fn_with_state(
            auth_state,
            require_auth,
        ))
        .into_make_service_with_connect_info::<SocketAddr>();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Harness { addr, log }
}

async fn get(addr: SocketAddr, path: &str, headers: &[(&str, String)]) -> reqwest::Response {
    let mut request = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .get(format!("http://{addr}{path}"));
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    request.send().await.unwrap()
}

fn bearer() -> (&'static str, String) {
    ("authorization", format!("Bearer {TOKEN}"))
}

#[tokio::test]
async fn health_is_exempt_and_everything_else_401s_without_a_token() {
    let dir = tempfile::tempdir().unwrap();
    let harness = serve(dir.path(), true).await;

    for path in ["/healthz", "/readyz", "/health"] {
        assert_eq!(get(harness.addr, path, &[]).await.status(), 200, "{path}");
    }

    for path in [
        "/remux/extensions",
        "/remux/media/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "/viewers/fixture/",
        "/",
        "/nope",
    ] {
        let response = get(harness.addr, path, &[]).await;
        assert_eq!(response.status(), 401, "{path}");
        let body: Value = response.json().await.unwrap();
        assert_eq!(body, json!({ "error": "unauthorized" }));
    }
    assert!(
        harness
            .log
            .warnings
            .lock()
            .unwrap()
            .iter()
            .all(|w| w.starts_with("auth rejected 127.0.0.1 /")),
        "rejections journal IP + path"
    );
    assert!(
        harness
            .log
            .warnings
            .lock()
            .unwrap()
            .iter()
            .all(|w| !w.contains(TOKEN)),
        "the token never hits the journal"
    );
}

#[tokio::test]
async fn wrong_or_truncated_tokens_reject_and_bad_header_does_not_fall_through() {
    let dir = tempfile::tempdir().unwrap();
    let harness = serve(dir.path(), true).await;

    let wrong = ("authorization", format!("Bearer {}x", TOKEN));
    assert_eq!(
        get(harness.addr, "/remux/extensions", &[wrong])
            .await
            .status(),
        401
    );
    let truncated = ("authorization", format!("Bearer {}", &TOKEN[..32]));
    assert_eq!(
        get(harness.addr, "/remux/extensions", &[truncated])
            .await
            .status(),
        401
    );

    // First present source wins: a bad header with a good cookie rejects.
    let mixed = [
        ("authorization", "Bearer wrong".to_string()),
        ("cookie", format!("remux_auth={TOKEN}")),
    ];
    assert_eq!(
        get(harness.addr, "/remux/extensions", &mixed)
            .await
            .status(),
        401
    );
}

#[tokio::test]
async fn header_auth_serves_and_hands_off_a_cookie() {
    let dir = tempfile::tempdir().unwrap();
    let harness = serve(dir.path(), true).await;

    let response = get(harness.addr, "/remux/extensions", &[bearer()]).await;
    assert_eq!(response.status(), 200);
    let cookie = response
        .headers()
        .get("set-cookie")
        .expect("header auth sets the WebView hand-off cookie")
        .to_str()
        .unwrap()
        .to_string();
    assert!(
        cookie.starts_with(&format!("remux_auth={TOKEN}; ")),
        "{cookie}"
    );
    assert!(cookie.contains("HttpOnly"), "{cookie}");
    assert!(cookie.contains("SameSite=Lax"), "{cookie}");

    // Header + already-valid cookie → no re-set.
    let both = [bearer(), ("cookie", format!("remux_auth={TOKEN}"))];
    let response = get(harness.addr, "/remux/extensions", &both).await;
    assert_eq!(response.status(), 200);
    assert!(response.headers().get("set-cookie").is_none());
}

#[tokio::test]
async fn cookie_and_query_auth_serve_without_setting_cookies() {
    let dir = tempfile::tempdir().unwrap();
    let harness = serve(dir.path(), true).await;

    // The viewer-subresource path: cookie only, asset serves.
    let cookie = [("cookie", format!("a=b; remux_auth={TOKEN}"))];
    let response = get(harness.addr, "/viewers/fixture/assets/index.js", &cookie).await;
    assert_eq!(response.status(), 200);
    assert!(response.headers().get("set-cookie").is_none());

    let response = get(
        harness.addr,
        &format!("/remux/extensions?token={TOKEN}"),
        &[],
    )
    .await;
    assert_eq!(response.status(), 200);
    assert!(response.headers().get("set-cookie").is_none());
}

#[tokio::test]
async fn require_auth_off_passes_everything() {
    let dir = tempfile::tempdir().unwrap();
    let harness = serve(dir.path(), false).await;
    assert_eq!(
        get(harness.addr, "/remux/extensions", &[]).await.status(),
        200
    );
    assert!(harness.log.warnings.lock().unwrap().is_empty());
}

#[tokio::test]
async fn ws_upgrade_401s_without_a_token_and_connects_with_one() {
    let dir = tempfile::tempdir().unwrap();
    let harness = serve(dir.path(), true).await;
    let url = format!("ws://{}/ws", harness.addr);

    let error = tokio_tungstenite::connect_async(url.clone())
        .await
        .expect_err("unauthenticated upgrade must fail");
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status(), 401);
        }
        other => panic!("expected an HTTP 401 handshake error, got {other:?}"),
    }

    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "remux/system/ping",
                "remuxContract": { "kind": "query" },
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let frame = socket.next().await.unwrap().unwrap();
    let Message::Text(text) = frame else {
        panic!("expected a text frame");
    };
    let message: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(message["result"], json!({ "ok": true }));
}
