//! Integration port of `cli/tests/http-server.test.js`: health, catalog shape,
//! root redirect, icon variants + dark→light fallback, viewer serving, 404.

use std::net::SocketAddr;
use std::sync::Arc;

use serde_json::json;

use remux::extensions::manifest::{
    Display, ExtensionManifest, FileHandler, Launcher, View,
};
use remux::http::viewers::ViewerProvider;
use remux::http::{build_router, HttpState};

fn fixture_extension(root: &std::path::Path) -> ExtensionManifest {
    let light_icon = root.join("light.png");
    let dark_icon = root.join("dark.png");
    std::fs::write(&light_icon, "LIGHT-ICON").unwrap();
    std::fs::write(&dark_icon, "DARK-ICON").unwrap();

    let dist = root.join("viewer/dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("index.html"), "viewer").unwrap();
    std::fs::write(dist.join("assets/index.js"), "console.log('asset')").unwrap();

    ExtensionManifest {
        id: "codex".to_string(),
        name: "Codex".to_string(),
        root_dir: root.to_path_buf(),
        display: Display {
            icon: Some(light_icon.clone()),
            icon_dark: Some(dark_icon),
            title: "Codex Mobile".to_string(),
        },
        server: None,
        views: vec![(
            "main".to_string(),
            View {
                entry: dist.join("index.html"),
                route: "/viewers/codex".to_string(),
                build: None,
                watch: None,
            },
        )],
        launchers: vec![
            Launcher {
                icon: Some(light_icon.clone()),
                icon_dark: Some(root.join("dark.png")),
                id: "new-chat".to_string(),
                label: "New Chat".to_string(),
                route: None,
                view: "main".to_string(),
                view_route: "/viewers/codex".to_string(),
            },
            Launcher {
                icon: Some(light_icon),
                icon_dark: None,
                id: "plain".to_string(),
                label: "Plain".to_string(),
                route: None,
                view: "main".to_string(),
                view_route: "/viewers/codex".to_string(),
            },
        ],
        file_handlers: Vec::<FileHandler>::new(),
    }
}

async fn serve_fixture(root: &std::path::Path) -> SocketAddr {
    let extension = fixture_extension(root);
    let state = Arc::new(HttpState {
        viewer_providers: vec![ViewerProvider::new(&extension)],
        default_extension: extension.clone(),
        extensions: vec![extension],
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, build_router(state)).await.unwrap();
    });
    addr
}

async fn get(addr: SocketAddr, path: &str) -> reqwest::Response {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .get(format!("http://{addr}{path}"))
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn serves_health_catalog_redirect_icons_viewers_and_404() {
    let dir = tempfile::tempdir().unwrap();
    let addr = serve_fixture(dir.path()).await;

    let health = get(addr, "/health").await;
    assert_eq!(health.status(), 200);
    assert_eq!(
        health.json::<serde_json::Value>().await.unwrap(),
        json!({ "ok": true, "defaultExtension": "codex", "service": "remux" })
    );

    let catalog = get(addr, "/remux/extensions").await;
    assert_eq!(catalog.status(), 200);
    assert_eq!(
        catalog.json::<serde_json::Value>().await.unwrap(),
        json!({
            "defaultExtensionId": "codex",
            "extensions": [
                {
                    "display": {
                        "iconDarkUrl": "/remux/extensions/codex/icon?format=png&variant=dark",
                        "iconUrl": "/remux/extensions/codex/icon?format=png",
                        "title": "Codex Mobile",
                    },
                    "fileHandlers": [],
                    "id": "codex",
                    "launchers": [
                        {
                            "extensionId": "codex",
                            "iconDarkUrl": "/remux/extensions/codex/icon?format=png&kind=launcher&id=new-chat&variant=dark",
                            "iconUrl": "/remux/extensions/codex/icon?format=png&kind=launcher&id=new-chat",
                            "id": "new-chat",
                            "label": "New Chat",
                            "route": null,
                            "view": "main",
                        },
                        {
                            "extensionId": "codex",
                            "iconDarkUrl": null,
                            "iconUrl": "/remux/extensions/codex/icon?format=png&kind=launcher&id=plain",
                            "id": "plain",
                            "label": "Plain",
                            "route": null,
                            "view": "main",
                        },
                    ],
                    "name": "Codex",
                    "views": { "main": { "route": "/viewers/codex" } },
                }
            ],
            "service": "remux",
        })
    );

    let root = get(addr, "/").await;
    assert_eq!(root.status(), 302);
    assert_eq!(
        root.headers().get("location").unwrap(),
        "/viewers/codex/"
    );

    let icon = get(addr, "/remux/extensions/codex/icon").await;
    assert_eq!(icon.status(), 200);
    assert_eq!(
        icon.headers().get("content-type").unwrap(),
        "image/png"
    );
    assert_eq!(icon.headers().get("cache-control").unwrap(), "no-cache");
    assert_eq!(icon.text().await.unwrap(), "LIGHT-ICON");

    let dark = get(addr, "/remux/extensions/codex/icon?variant=dark").await;
    assert_eq!(dark.text().await.unwrap(), "DARK-ICON");

    let launcher_dark = get(
        addr,
        "/remux/extensions/codex/icon?kind=launcher&id=new-chat&variant=dark",
    )
    .await;
    assert_eq!(launcher_dark.text().await.unwrap(), "DARK-ICON");

    // A dark request for an entry without iconDark falls back to the light icon.
    let fallback = get(
        addr,
        "/remux/extensions/codex/icon?kind=launcher&id=plain&variant=dark",
    )
    .await;
    assert_eq!(fallback.text().await.unwrap(), "LIGHT-ICON");

    let viewer = get(addr, "/viewers/codex/").await;
    assert_eq!(viewer.status(), 200);
    assert_eq!(viewer.text().await.unwrap(), "viewer");

    // Deep links (SPA) fall back to the entry; real assets serve directly.
    let spa = get(addr, "/viewers/codex/threads/123").await;
    assert_eq!(spa.status(), 200);
    assert_eq!(spa.text().await.unwrap(), "viewer");

    let asset = get(addr, "/viewers/codex/assets/index.js").await;
    assert_eq!(asset.status(), 200);
    assert_eq!(
        asset.headers().get("content-type").unwrap(),
        "text/javascript; charset=utf-8"
    );

    // Traversal attempts fall back to the entry rather than escaping.
    let traversal = get(addr, "/viewers/codex/../../../etc/passwd").await;
    assert!(traversal.status() == 200 || traversal.status() == 404);
    if traversal.status() == 200 {
        assert_eq!(traversal.text().await.unwrap(), "viewer");
    }

    let missing = get(addr, "/missing").await;
    assert_eq!(missing.status(), 404);
    assert_eq!(missing.text().await.unwrap(), "Not found.");

    let missing_icon = get(addr, "/remux/extensions/unknown/icon").await;
    assert_eq!(missing_icon.status(), 404);
    assert_eq!(missing_icon.text().await.unwrap(), "Not found.");
}
