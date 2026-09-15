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
        gateway: None,
        views: vec![(
            "main".to_string(),
            View {
                cache: ViewCachePolicy::Immutable,
                entry: dist.join("index.html"),
                host_chrome: Default::default(),
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
    serve_fixture_with_cap(root, remux::config::DEFAULT_MAX_UPLOAD_BYTES).await
}

async fn serve_fixture_with_cap(root: &std::path::Path, cap: u64) -> (SocketAddr, String) {
    let extension = fixture_extension(root);
    let journal = Journal::new(root, 1, Arc::new(StdTerminal)).unwrap();
    let viewer_bundles = ViewerBundleRegistry::new(root, std::slice::from_ref(&extension), journal);
    viewer_bundles.publish_all().await;
    let revision = viewer_bundles.current("codex", "main").unwrap().revision;
    let extension_gateways = remux::http::extension_gateways::ExtensionGatewayRegistry::new(
        root,
        std::slice::from_ref(&extension),
    )
    .unwrap();
    let state = Arc::new(HttpState {
        raw_files: remux::http::raw_files::RawFileService::new(
            remux::fs::core::FsCore::new(root),
            cap,
        ),
        viewer_providers: ViewerProvider::for_extension(&extension, viewer_bundles.clone()),
        viewer_bundles,
        default_extension: extension.clone(),
        extensions: vec![extension],
        invalid_extensions: Vec::new(),
        media_root: root.join(".remux/cache/media"),
        extension_gateways,
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
                            "hostChrome": "none",
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

fn raw_url(addr: SocketAddr, path: &std::path::Path) -> String {
    let mut url = reqwest::Url::parse(&format!("http://{addr}/remux/fs/raw")).unwrap();
    url.query_pairs_mut()
        .append_pair("path", &path.to_string_lossy());
    url.into()
}

fn assert_raw_headers(response: &reqwest::Response) {
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    // PDFs are the one type WebKit draws with a plugin; the sandbox header
    // would blank them, so they carry nosniff only.
    let pdf = response
        .headers()
        .get("content-type")
        .is_some_and(|value| value.to_str().unwrap().starts_with("application/pdf"));
    if pdf {
        assert!(response.headers().get("content-security-policy").is_none());
    } else {
        assert_eq!(response.headers()["content-security-policy"], "sandbox");
    }
    assert_eq!(response.headers()["cache-control"], "private, no-cache");
    assert!(response.headers().get("content-encoding").is_none());
}

#[tokio::test]
async fn raw_get_head_ranges_etags_and_dispositions() {
    let root = tempfile::tempdir().unwrap();
    let (addr, _) = serve_fixture(root.path()).await;
    let client = reqwest::Client::new();
    let path = root.path().join("space é.txt");
    let content = "0123456789".repeat(400);
    std::fs::write(&path, &content).unwrap();
    let url = raw_url(addr, &path);
    let response = client
        .get(&url)
        .header("accept-encoding", "br, gzip")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_raw_headers(&response);
    assert_eq!(response.headers()["content-length"], "4000");
    assert_eq!(response.headers()["accept-ranges"], "bytes");
    assert_eq!(response.headers()["content-type"], "text/plain");
    assert_eq!(
        response.headers()["content-disposition"],
        "attachment; filename*=UTF-8''space%20%C3%A9.txt"
    );
    assert!(response.headers().contains_key("last-modified"));
    let etag = response.headers()["etag"].to_str().unwrap().to_owned();
    let stat = remux::fs::core::FsCore::new(root.path())
        .handle_rpc("remux/fs/stat", Some(&json!({"path":path})))
        .await
        .unwrap();
    assert_eq!(etag, format!("\"{}\"", stat["version"].as_str().unwrap()));
    assert_eq!(response.text().await.unwrap(), content);
    for method in [reqwest::Method::GET, reqwest::Method::HEAD] {
        let response = client
            .request(method, &url)
            .header("if-none-match", &etag)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 304);
        assert_raw_headers(&response);
        assert!(response.bytes().await.unwrap().is_empty());
    }
    let response = client.head(&url).send().await.unwrap();
    assert_raw_headers(&response);
    assert_eq!(response.headers()["content-length"], "4000");
    assert!(response.bytes().await.unwrap().is_empty());
    for (range, expected_range, expected) in [
        ("bytes=2-5", "bytes 2-5/4000", "2345"),
        ("bytes=-4", "bytes 3996-3999/4000", "6789"),
        ("bytes=3997-", "bytes 3997-3999/4000", "789"),
    ] {
        let response = client
            .get(&url)
            .header("range", range)
            .header("accept-encoding", "gzip")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 206);
        assert_raw_headers(&response);
        assert_eq!(response.headers()["content-range"], expected_range);
        assert_eq!(
            response.headers()["content-length"],
            expected.len().to_string()
        );
        assert_eq!(response.text().await.unwrap(), expected);
    }
    for range in ["bytes=4000-", "bytes=3-2", "bytes=0-1,4-5", "bytes=-0"] {
        let response = client
            .get(&url)
            .header("range", range)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 416);
        assert_raw_headers(&response);
        assert_eq!(response.headers()["content-range"], "bytes */4000");
    }
    for (ext, inline) in [
        ("html", false),
        ("svg", false),
        ("xml", false),
        ("png", true),
        ("pdf", true),
        ("mp3", true),
        ("mp4", true),
        ("woff2", true),
    ] {
        let path = root.path().join(format!("fixture.{ext}"));
        std::fs::write(&path, "fixture").unwrap();
        let url = raw_url(addr, &path);
        let response = client.get(&url).send().await.unwrap();
        assert_raw_headers(&response);
        assert!(response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with(if inline { "inline;" } else { "attachment;" }));
        let response = client
            .get(format!("{url}&download=1"))
            .send()
            .await
            .unwrap();
        assert_raw_headers(&response);
        assert!(response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment;"));
    }
    std::fs::write(&path, "changed").unwrap();
    let response = client
        .get(&url)
        .header("if-none-match", &etag)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_ne!(response.headers()["etag"], etag);
}

#[tokio::test]
async fn raw_paths_symlinks_special_files_and_error_headers() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let (addr, _) = serve_fixture(root.path()).await;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap();
    let target = root.path().join("target");
    std::fs::write(&target, b"%PDF-1.7").unwrap();
    let link = root.path().join("link");
    symlink(&target, &link).unwrap();
    let response = client.get(raw_url(addr, &link)).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "application/pdf");
    assert_raw_headers(&response);
    assert_eq!(response.text().await.unwrap(), "%PDF-1.7");
    let fifo = root.path().join("fifo");
    nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::S_IRUSR).unwrap();
    for (path, status) in [
        (fifo.as_path(), 400),
        (root.path(), 400),
        (&root.path().join("missing"), 404),
        (std::path::Path::new("/dev/null"), 400),
    ] {
        let response = client.get(raw_url(addr, path)).send().await.unwrap();
        assert_eq!(response.status(), status);
        assert_raw_headers(&response);
    }
    for suffix in ["", "?path=", "?path=relative", "?path=%00"] {
        let response = client
            .get(format!("http://{addr}/remux/fs/raw{suffix}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        assert_raw_headers(&response);
    }
    let response = client.post(raw_url(addr, &target)).send().await.unwrap();
    assert_eq!(response.status(), 405);
    assert_raw_headers(&response);
    let empty = root.path().join("empty");
    std::fs::write(&empty, "").unwrap();
    let response = client
        .get(raw_url(addr, &empty))
        .header("range", "bytes=0-")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 416);
    assert_eq!(response.headers()["content-range"], "bytes */0");
}

#[tokio::test]
async fn raw_upload_create_conflict_versions_limit_and_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let (addr, _) = serve_fixture_with_cap(root.path(), 3 * 1024 * 1024).await;
    let client = reqwest::Client::new();
    let path = root.path().join("upload.txt");
    let url = raw_url(addr, &path);
    let response = client.put(&url).body("first").send().await.unwrap();
    assert_eq!(response.status(), 201);
    assert_raw_headers(&response);
    let descriptor: serde_json::Value = response.json().await.unwrap();
    assert_eq!(descriptor["sizeBytes"], 5);
    assert_eq!(descriptor["path"], path.to_str().unwrap());
    let version = descriptor["version"].as_str().unwrap();
    for expected in [None, Some("\"stale\""), Some(version)] {
        let mut request = client.put(&url).body("conflict");
        if let Some(expected) = expected {
            request = request.header("if-match", expected);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), 409);
        assert_raw_headers(&response);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
    }
    let response = client
        .put(&url)
        .header("if-match", format!("\"{version}\""))
        .body("second")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_raw_headers(&response);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
    let response = client
        .put(format!("{url}&overwrite=1"))
        .body("replace")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "replace");
    let oversized = root.path().join("oversized");
    let response = client
        .put(raw_url(addr, &oversized))
        .body(vec![0; 3 * 1024 * 1024 + 1])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 413);
    assert_raw_headers(&response);
    assert!(!oversized.exists());
    let large = root.path().join("large");
    let response = client
        .put(raw_url(addr, &large))
        .body(vec![0; 3 * 1024 * 1024])
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        201,
        "route accepts bodies above axum's default 2 MiB limit"
    );
    assert_eq!(std::fs::metadata(large).unwrap().len(), 3 * 1024 * 1024);
    let response = client
        .put(raw_url(addr, &root.path().join("missing/file")))
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    assert_raw_headers(&response);
    let response = client
        .put(format!("{}&overwrite=1", raw_url(addr, root.path())))
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    assert_raw_headers(&response);
    assert_no_upload_temps(root.path());
}

fn assert_no_upload_temps(root: &std::path::Path) {
    assert!(!std::fs::read_dir(root).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".remux-upload-")));
}

#[tokio::test]
async fn raw_upload_disconnect_cleans_partial_temp_and_requires_length() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let root = tempfile::tempdir().unwrap();
    let (addr, _) = serve_fixture(root.path()).await;
    let path = root.path().join("aborted");
    let url = reqwest::Url::parse(&raw_url(addr, &path)).unwrap();
    let request_target = format!("{}?{}", url.path(), url.query().unwrap());
    let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
    socket.write_all(format!("PUT {request_target} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: 10000\r\n\r\npartial").as_bytes()).await.unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if std::fs::read_dir(root.path()).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".remux-upload-")
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "upload should start"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    drop(socket);
    loop {
        if !std::fs::read_dir(root.path()).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".remux-upload-")
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "upload temp should be removed after disconnect"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(!path.exists());
    let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
    socket
        .write_all(
            format!("PUT {request_target} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).await.unwrap();
    assert!(response.starts_with("HTTP/1.1 411"), "{response}");
    assert!(response.contains("content-security-policy: sandbox"));
    assert_no_upload_temps(root.path());
}
