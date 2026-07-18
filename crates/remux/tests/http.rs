//! Integration port of `cli/tests/http-server.test.js`: health, catalog shape,
//! root redirect, icon variants + dark→light fallback, viewer serving, 404.

use std::net::SocketAddr;
use std::sync::Arc;

use remux::extensions::manifest::{
    Display, ExtensionManifest, FileHandler, Launcher, View, ViewCachePolicy,
};
use remux::http::viewer_bundles::ViewerBundleRegistry;
use remux::http::viewers::ViewerProvider;
use remux::http::{build_router, compression_layer, HttpState};
use remux::logs::{Journal, StdTerminal};
use serde_json::json;
use sha2::{Digest, Sha256};

fn fixture_extension(root: &std::path::Path) -> ExtensionManifest {
    let light_icon = root.join("light.png");
    let dark_icon = root.join("dark.png");
    std::fs::write(&light_icon, "LIGHT-ICON").unwrap();
    std::fs::write(&dark_icon, "DARK-ICON").unwrap();

    let dist = root.join("viewer/dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("index.html"), "viewer").unwrap();
    std::fs::write(
        dist.join("assets/index.js"),
        format!("console.log('asset');/*{}*/", "x".repeat(2048)),
    )
    .unwrap();

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
                cache: ViewCachePolicy::Immutable,
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
        workloads: Default::default(),
    }
}

async fn serve_fixture(root: &std::path::Path) -> (SocketAddr, String) {
    let extension = fixture_extension(root);
    let journal = Journal::new(root, 1, Arc::new(StdTerminal)).unwrap();
    let viewer_bundles = ViewerBundleRegistry::new(root, &[extension.clone()], journal);
    viewer_bundles.publish_all().await;
    let revision = viewer_bundles.current("codex", "main").unwrap().revision;
    let state = Arc::new(HttpState {
        viewer_providers: ViewerProvider::for_extension(&extension, viewer_bundles.clone()),
        viewer_bundles,
        default_extension: extension.clone(),
        extensions: vec![extension],
        invalid_extensions: Vec::new(),
        media_root: root.join(".remux/cache/media"),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, build_router(state).layer(compression_layer()))
            .await
            .unwrap();
    });
    (addr, revision)
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

async fn get_gzip(addr: SocketAddr, path: &str) -> reqwest::Response {
    reqwest::Client::builder()
        .no_brotli()
        .no_gzip()
        .build()
        .unwrap()
        .get(format!("http://{addr}{path}"))
        .header("accept-encoding", "gzip")
        .send()
        .await
        .unwrap()
}

async fn request(
    addr: SocketAddr,
    method: reqwest::Method,
    path: &str,
    headers: &[(&str, &str)],
) -> reqwest::Response {
    let client = reqwest::Client::builder().build().unwrap();
    let mut request = client.request(method, format!("http://{addr}{path}"));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request.send().await.unwrap()
}

#[tokio::test]
async fn serves_health_catalog_redirect_icons_viewers_and_404() {
    let dir = tempfile::tempdir().unwrap();
    let (addr, revision) = serve_fixture(dir.path()).await;
    let versioned_route = format!("/viewers/codex/_bundle/{revision}");
    let media_hash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    let media_dir = dir
        .path()
        .join(".remux/cache/media/sha256")
        .join(&media_hash[..2]);
    std::fs::create_dir_all(&media_dir).unwrap();
    std::fs::write(media_dir.join(format!("{media_hash}.blob")), b"hello").unwrap();
    std::fs::write(
        media_dir.join(format!("{media_hash}.json")),
        json!({
            "schemaVersion": 1,
            "sha256": media_hash,
            "mimeType": "image/png",
            "sizeBytes": 5,
            "createdAtMs": 1,
            "lastAccessAtMs": 1,
        })
        .to_string(),
    )
    .unwrap();
    // This is intentionally response-sized: the transport must handle the
    // class of WAV that previously overflowed the 8 MiB WebSocket frame cap.
    const WAV_SIZE: usize = 12_751_244;
    let mut wav = vec![0u8; WAV_SIZE];
    wav[0..4].copy_from_slice(b"RIFF");
    wav[4..8].copy_from_slice(&((WAV_SIZE - 8) as u32).to_le_bytes());
    wav[8..12].copy_from_slice(b"WAVE");
    wav[12..16].copy_from_slice(b"fmt ");
    wav[16..20].copy_from_slice(&16u32.to_le_bytes());
    wav[20..22].copy_from_slice(&1u16.to_le_bytes());
    wav[22..24].copy_from_slice(&1u16.to_le_bytes());
    wav[24..28].copy_from_slice(&24_000u32.to_le_bytes());
    wav[28..32].copy_from_slice(&(24_000u32 * 2).to_le_bytes());
    wav[32..34].copy_from_slice(&2u16.to_le_bytes());
    wav[34..36].copy_from_slice(&16u16.to_le_bytes());
    wav[36..40].copy_from_slice(b"data");
    wav[40..44].copy_from_slice(&((WAV_SIZE - 44) as u32).to_le_bytes());
    let audio_hash = format!("{:x}", Sha256::digest(&wav));
    let audio_dir = dir
        .path()
        .join(".remux/cache/media/sha256")
        .join(&audio_hash[..2]);
    std::fs::create_dir_all(&audio_dir).unwrap();
    std::fs::write(audio_dir.join(format!("{audio_hash}.blob")), &wav).unwrap();
    std::fs::write(
        audio_dir.join(format!("{audio_hash}.json")),
        json!({
            "schemaVersion": 1,
            "sha256": audio_hash,
            "mimeType": "audio/wav",
            "sizeBytes": wav.len(),
            "createdAtMs": 1,
            "lastAccessAtMs": 1,
        })
        .to_string(),
    )
    .unwrap();

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
            "invalidExtensions": [],
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
                    "views": {
                        "main": {
                            "entryUrl": format!("/viewers/codex/_bundle/{revision}/"),
                            "revision": revision.clone(),
                            "route": "/viewers/codex",
                        }
                    },
                }
            ],
            "service": "remux",
        })
    );

    let root = get(addr, "/").await;
    assert_eq!(root.status(), 302);
    assert_eq!(root.headers().get("location").unwrap(), "/viewers/codex/");

    let icon = get(addr, "/remux/extensions/codex/icon").await;
    assert_eq!(icon.status(), 200);
    assert_eq!(icon.headers().get("content-type").unwrap(), "image/png");
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
    assert_eq!(asset.headers().get("cache-control").unwrap(), "no-cache");
    assert!(asset.headers().get("etag").is_some());

    let versioned_asset = get(addr, &format!("{versioned_route}/assets/index.js")).await;
    assert_eq!(versioned_asset.status(), 200);
    assert_eq!(
        versioned_asset.headers().get("cache-control").unwrap(),
        "private, max-age=31536000, immutable"
    );
    assert!(versioned_asset
        .text()
        .await
        .unwrap()
        .starts_with("console.log('asset')"));

    let compressed = get_gzip(addr, &format!("{versioned_route}/assets/index.js")).await;
    assert_eq!(
        compressed.headers().get("content-encoding").unwrap(),
        "gzip"
    );
    assert_eq!(compressed.headers().get("vary").unwrap(), "accept-encoding");

    let missing_versioned_asset = get(addr, &format!("{versioned_route}/assets/missing.js")).await;
    assert_eq!(missing_versioned_asset.status(), 404);

    let unavailable = get(addr, "/viewers/codex/_bundle/sha256-deadbeef/").await;
    assert_eq!(unavailable.status(), 404);
    assert_eq!(
        unavailable.json::<serde_json::Value>().await.unwrap()["error"]["code"],
        "viewer_revision_unavailable"
    );

    let media = get(addr, &format!("/remux/media/sha256/{media_hash}")).await;
    assert_eq!(media.status(), 200);
    assert_eq!(media.headers().get("content-type").unwrap(), "image/png");
    assert_eq!(media.headers().get("content-length").unwrap(), "5");
    assert_eq!(
        media.headers().get("cache-control").unwrap(),
        "private, max-age=31536000, immutable"
    );
    assert_eq!(media.bytes().await.unwrap().as_ref(), b"hello");

    let audio_path = format!("/remux/media/sha256/{audio_hash}");
    let audio = get_gzip(addr, &audio_path).await;
    assert_eq!(audio.status(), 200);
    assert_eq!(audio.headers().get("content-type").unwrap(), "audio/wav");
    assert_eq!(audio.headers().get("accept-ranges").unwrap(), "bytes");
    assert!(audio.headers().get("content-encoding").is_none());
    assert_eq!(audio.bytes().await.unwrap().len(), wav.len());

    let audio_head = request(addr, reqwest::Method::HEAD, &audio_path, &[]).await;
    assert_eq!(audio_head.status(), 200);
    assert_eq!(
        audio_head.headers().get("content-length").unwrap(),
        wav.len().to_string().as_str()
    );
    assert!(audio_head.bytes().await.unwrap().is_empty());

    let audio_range = request(
        addr,
        reqwest::Method::GET,
        &audio_path,
        &[("range", "bytes=0-43")],
    )
    .await;
    assert_eq!(audio_range.status(), 206);
    assert_eq!(
        audio_range.headers().get("content-range").unwrap(),
        format!("bytes 0-43/{}", wav.len()).as_str()
    );
    assert_eq!(audio_range.bytes().await.unwrap().as_ref(), &wav[..44]);

    let invalid_range = request(
        addr,
        reqwest::Method::GET,
        &audio_path,
        &[("range", "bytes=99999999-100000000")],
    )
    .await;
    assert_eq!(invalid_range.status(), 416);
    assert_eq!(
        invalid_range.headers().get("content-range").unwrap(),
        format!("bytes */{}", wav.len()).as_str()
    );

    let invalid_media = get(addr, "/remux/media/sha256/ABC").await;
    assert_eq!(invalid_media.status(), 404);

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
