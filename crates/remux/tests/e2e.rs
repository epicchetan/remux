//! End-to-end tests: the real `remux` binary (supervisor + worker) against a
//! fixture extension, covering the acceptance scenarios — exit-75 restart
//! round-trip and `kill -9` self-healing.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// Fixed token injected via `REMUX_AUTH_TOKEN` so the harness never depends
/// on the generated `.remux/auth-token` file.
const E2E_TOKEN: &str = "e2e-test-token-e2e-test-token-e2e-test-token-e2e-test-token-0123";

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn write_fixture_extension(root: &Path) {
    write_fixture_extension_with_server(
        root,
        json!({
            "transport": "stdio",
            "command": env!("CARGO_BIN_EXE_remux-fixture-ext"),
            "args": [],
        }),
    );
}

fn write_fixture_with_invalid_extension(root: &Path) {
    write_fixture_extension(root);
    let ext_dir = root.join("extensions/invalid");
    std::fs::create_dir_all(ext_dir.join("viewer/dist")).unwrap();
    std::fs::write(ext_dir.join("viewer/dist/index.html"), "invalid").unwrap();
    std::fs::write(
        ext_dir.join("remux-extension.json"),
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "id": "invalid",
            "resources": { "workloads": {} },
            "views": { "main": { "entry": "viewer/dist/index.html" } },
        }))
        .unwrap(),
    )
    .unwrap();
}

fn write_fixture_extension_with_server(root: &Path, server: Value) {
    let ext_dir = root.join("extensions/fixture");
    let dist = ext_dir.join("viewer/dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<h1>fixture viewer</h1>").unwrap();

    let manifest = json!({
        "version": 1,
        "id": "fixture",
        "name": "Fixture",
        "launchers": [ { "id": "open", "label": "Open" } ],
        "server": server,
        "views": { "main": { "entry": "viewer/dist/index.html" } },
    });
    std::fs::write(
        ext_dir.join("remux-extension.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
}

fn write_cross_extension_fixtures(root: &Path) {
    for id in ["caller", "target"] {
        let ext_dir = root.join("extensions").join(id);
        let dist = ext_dir.join("viewer/dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), format!("<h1>{id}</h1>")).unwrap();
        let manifest = json!({
            "version": 1,
            "id": id,
            "name": id,
            "launchers": if id == "caller" { json!([{ "id": "open", "label": "Open" }]) } else { json!([]) },
            "server": {
                "transport": "stdio",
                "command": env!("CARGO_BIN_EXE_remux-fixture-ext"),
                "args": [],
            },
            "views": { "main": { "entry": "viewer/dist/index.html" } },
        });
        std::fs::write(
            ext_dir.join("remux-extension.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }
}

/// Build-phase manifest: the binary is missing at boot and produced by a
/// scripted build step (a wrapper that execs the fixture binary).
fn write_build_fixture_extension(root: &Path) {
    let ext_dir = root.join("extensions/fixture");
    std::fs::create_dir_all(&ext_dir).unwrap();
    std::fs::write(
        ext_dir.join("server-src.sh"),
        format!(
            "#!/bin/sh\nexec {} \"$@\"\n",
            env!("CARGO_BIN_EXE_remux-fixture-ext")
        ),
    )
    .unwrap();
    write_fixture_extension_with_server(
        root,
        json!({
            "transport": "stdio",
            "command": ext_dir.join("server-bin").to_string_lossy(),
            "args": [],
            "build": {
                "command": "sh",
                "args": ["-c", "cp server-src.sh server-bin && chmod +x server-bin"],
                "cwd": ".",
            },
        }),
    );
}

fn write_watch_fixture_extension(root: &Path) {
    let ext_dir = root.join("extensions/fixture");
    let dist = ext_dir.join("viewer/dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<h1>watch fixture</h1>").unwrap();

    let manifest = json!({
        "version": 1,
        "id": "fixture",
        "name": "Fixture",
        "launchers": [ { "id": "open", "label": "Open" } ],
        "views": {
            "main": {
                "entry": "viewer/dist/index.html",
                "watch": {
                    "command": env!("CARGO_BIN_EXE_remux-fixture-ext"),
                    "args": [ "FIXTURE_IGNORE_EOF=1" ],
                    "cwd": "."
                }
            }
        }
    });
    std::fs::write(
        ext_dir.join("remux-extension.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
}

struct Runtime {
    supervisor: Child,
    port: u16,
    root: tempfile::TempDir,
}

impl Runtime {
    fn start() -> Self {
        Self::start_with(write_fixture_extension)
    }

    fn start_with(write_extension: fn(&Path)) -> Self {
        let root = tempfile::tempdir().unwrap();
        write_extension(root.path());
        let port = free_port();

        let supervisor = Command::new(env!("CARGO_BIN_EXE_remux"))
            .arg("--root")
            .arg(root.path())
            .arg("start")
            .arg("--foreground")
            .current_dir(root.path())
            // Hermetic: a stray REMUX_WORKER in the invoking environment
            // would turn the supervisor into a bare worker.
            .env_remove("REMUX_WORKER")
            .env_remove("REMUX_WORKLOAD_EXEC")
            .env_remove("REMUX_RESOURCE_GOVERNANCE")
            .env_remove("REMUX_EXTENSION_ROOTS")
            .env("REMUX_HOST", "127.0.0.1")
            .env("REMUX_PORT", port.to_string())
            .env("REMUX_AUTH_TOKEN", E2E_TOKEN)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        Self {
            supervisor,
            port,
            root,
        }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    async fn wait_for_health(&self, timeout: Duration) -> Value {
        let deadline = Instant::now() + timeout;
        let client = reqwest::Client::new();
        loop {
            if let Ok(response) = client
                .get(format!("{}/health", self.base_url()))
                .timeout(Duration::from_millis(500))
                .send()
                .await
            {
                if response.status() == 200 {
                    return response.json().await.unwrap();
                }
            }
            assert!(
                Instant::now() < deadline,
                "runtime did not become healthy in time"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn worker_pids(&self) -> Vec<u32> {
        let output = Command::new("pgrep")
            .args(["-P", &self.supervisor.id().to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect()
    }

    fn shutdown(mut self) {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(self.supervisor.id() as i32),
            nix::sys::signal::Signal::SIGTERM,
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(Some(_)) = self.supervisor.try_wait() {
                break;
            }
            if Instant::now() > deadline {
                let _ = self.supervisor.kill();
                let _ = self.supervisor.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(self.root);
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn ws_connect(port: u16) -> Ws {
    let mut request = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {E2E_TOKEN}").parse().unwrap(),
    );
    let (socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket
}

/// Authenticated GET against the runtime.
async fn http_get(url: String) -> reqwest::Response {
    reqwest::Client::new()
        .get(url)
        .header("authorization", format!("Bearer {E2E_TOKEN}"))
        .send()
        .await
        .unwrap()
}

async fn ws_request(socket: &mut Ws, id: u64, method: &str, params: Option<Value>) -> Value {
    let mut frame = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "remuxContract": { "kind": "query" },
    });
    if let Some(params) = params {
        frame["params"] = params;
    }
    socket
        .send(Message::Text(frame.to_string().into()))
        .await
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let frame = tokio::time::timeout(remaining, socket.next())
            .await
            .expect("timed out waiting for response")
            .expect("socket closed")
            .expect("socket error");
        if let Message::Text(text) = frame {
            let message: Value = serde_json::from_str(&text).unwrap();
            if message.get("id") == Some(&json!(id)) {
                return message;
            }
        }
    }
}

fn runtime_log_contains(root: &Path, needle: &str) -> bool {
    let dir = root.join(".remux/logs");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("runtime-") || !name.ends_with(".jsonl") {
            continue;
        }
        if std::fs::read_to_string(&path)
            .map(|body| body.contains(needle))
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

async fn wait_for_runtime_log(root: &Path, needle: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if runtime_log_contains(root, needle) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "runtime log never contained {needle}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn boots_serves_catalog_and_runs_the_fixture_extension() {
    let runtime = Runtime::start();
    let health = runtime.wait_for_health(Duration::from_secs(30)).await;
    assert_eq!(
        health,
        json!({ "ok": true, "defaultExtension": "fixture", "service": "remux" })
    );

    // Auth is enforced end-to-end: unauthenticated HTTP 401s and the
    // unauthenticated WS handshake is refused before upgrade.
    let unauthenticated = reqwest::get(format!("{}/remux/extensions", runtime.base_url()))
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), 401);
    let unauthenticated_status = reqwest::get(format!("{}/api/status", runtime.base_url()))
        .await
        .unwrap();
    assert_eq!(unauthenticated_status.status(), 401);
    let refused =
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/ws", runtime.port)).await;
    assert!(refused.is_err(), "unauthenticated ws connect must fail");

    let catalog: Value = http_get(format!("{}/remux/extensions", runtime.base_url()))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(catalog["defaultExtensionId"], "fixture");
    assert_eq!(catalog["extensions"][0]["id"], "fixture");

    let viewer = http_get(format!("{}/viewers/fixture/", runtime.base_url())).await;
    assert_eq!(viewer.status(), 200);
    assert_eq!(viewer.text().await.unwrap(), "<h1>fixture viewer</h1>");

    let mut socket = ws_connect(runtime.port).await;
    let ping = ws_request(&mut socket, 1, "remux/system/ping", None).await;
    assert_eq!(ping["result"], json!({ "ok": true }));

    // Extension RPC round-trips through the stdio bridge.
    let echo = ws_request(
        &mut socket,
        2,
        "remux/fixture/echo",
        Some(json!({ "n": 42 })),
    )
    .await;
    assert_eq!(echo["result"]["echo"], "remux/fixture/echo");
    assert_eq!(echo["result"]["params"]["n"], 42);

    let status = ws_request(&mut socket, 3, "remux/extensions/status", None).await;
    let extensions = status["result"]["extensions"].as_array().unwrap();
    assert_eq!(extensions.len(), 1);
    assert_eq!(extensions[0]["extensionId"], "fixture");
    assert_eq!(extensions[0]["running"], json!(true));
    assert_eq!(extensions[0]["state"], "running");
    assert!(extensions[0]["pid"].is_number());

    let http_status: Value = http_get(format!("{}/api/status", runtime.base_url()))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(http_status["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(http_status["requireAuth"], json!(true));
    assert_eq!(http_status["host"], "127.0.0.1");
    assert_eq!(http_status["port"], runtime.port);
    assert_eq!(http_status["extensions"], status["result"]);

    // Stop/start block until truthful.
    let stopped = ws_request(
        &mut socket,
        4,
        "remux/extensions/stop",
        Some(json!({ "extensionId": "fixture" })),
    )
    .await;
    assert_eq!(stopped["result"]["running"], json!(false));
    assert_eq!(stopped["result"]["stopped"], json!(true));

    let started = ws_request(
        &mut socket,
        5,
        "remux/extensions/start",
        Some(json!({ "extensionId": "fixture" })),
    )
    .await;
    assert_eq!(started["result"]["running"], json!(true));

    // Extension logs RPC is live.
    let logs = ws_request(
        &mut socket,
        6,
        "remux/extensions/logs",
        Some(json!({ "extensionId": "fixture" })),
    )
    .await;
    assert!(logs["result"]["lines"].is_array());

    runtime.shutdown();
}

#[tokio::test]
async fn invalid_extension_is_quarantined_without_blocking_runtime_boot() {
    let runtime = Runtime::start_with(write_fixture_with_invalid_extension);
    runtime.wait_for_health(Duration::from_secs(30)).await;

    let catalog: Value = http_get(format!("{}/remux/extensions", runtime.base_url()))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(catalog["extensions"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["extensions"][0]["id"], "fixture");
    assert_eq!(catalog["invalidExtensions"][0]["id"], "invalid");
    assert!(catalog["invalidExtensions"][0]["error"]
        .as_str()
        .is_some_and(|error| error.contains("resources requires version 2")));

    runtime.shutdown();
}

#[tokio::test]
async fn extension_servers_can_call_other_extension_servers() {
    let runtime = Runtime::start_with(write_cross_extension_fixtures);
    runtime.wait_for_health(Duration::from_secs(30)).await;
    let mut socket = ws_connect(runtime.port).await;

    let direct = ws_request(&mut socket, 99, "remux/caller/echo", None).await;
    assert_eq!(direct["result"]["echo"], "remux/caller/echo");

    let response = ws_request(
        &mut socket,
        1,
        "remux/caller/call",
        Some(json!({
            "method": "remux/target/echo",
            "params": { "value": 42 },
        })),
    )
    .await;
    assert_eq!(response["result"]["echo"], "remux/target/echo");
    assert_eq!(response["result"]["params"]["value"], 42);

    let error = ws_request(
        &mut socket,
        2,
        "remux/caller/call",
        Some(json!({ "method": "remux/target/fail" })),
    )
    .await;
    assert_eq!(error["error"]["code"], -32001);
    assert!(error["error"]["message"]
        .as_str()
        .is_some_and(|message| message.contains("fixture failure")));

    let builtin = ws_request(
        &mut socket,
        3,
        "remux/caller/call",
        Some(json!({ "method": "remux/system/info" })),
    )
    .await;
    assert_eq!(builtin["error"]["code"], -32601);

    let stopped = ws_request(
        &mut socket,
        4,
        "remux/extensions/stop",
        Some(json!({ "extensionId": "target" })),
    )
    .await;
    assert_eq!(stopped["result"]["running"], false);
    let unavailable = ws_request(
        &mut socket,
        5,
        "remux/caller/call",
        Some(json!({ "method": "remux/target/echo" })),
    )
    .await;
    assert!(unavailable["error"]["message"]
        .as_str()
        .is_some_and(|message| message.contains("target") && message.contains("not running")));

    let started = ws_request(
        &mut socket,
        6,
        "remux/extensions/start",
        Some(json!({ "extensionId": "target" })),
    )
    .await;
    assert_eq!(started["result"]["running"], true);
    let after_restart = ws_request(
        &mut socket,
        7,
        "remux/caller/call",
        Some(json!({ "method": "remux/target/echo" })),
    )
    .await;
    assert_eq!(after_restart["result"]["echo"], "remux/target/echo");

    runtime.shutdown();
}

#[tokio::test]
async fn system_restart_round_trips_with_exit_75() {
    let runtime = Runtime::start();
    runtime.wait_for_health(Duration::from_secs(30)).await;
    let old_workers = runtime.worker_pids();
    assert_eq!(old_workers.len(), 1);

    let mut socket = ws_connect(runtime.port).await;
    let restart = ws_request(&mut socket, 1, "remux/system/restart", None).await;
    assert_eq!(
        restart["result"],
        json!({ "restartable": true, "restarting": true })
    );

    // The worker exits 75; the supervisor restarts it and the port rebinds.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let workers = runtime.worker_pids();
        if workers.len() == 1 && workers != old_workers {
            break;
        }
        assert!(Instant::now() < deadline, "worker did not restart");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    runtime.wait_for_health(Duration::from_secs(30)).await;

    // A fresh client can reconnect and the fixture extension respawned.
    let mut socket = ws_connect(runtime.port).await;
    let status = ws_request(&mut socket, 1, "remux/extensions/status", None).await;
    assert_eq!(status["result"]["extensions"][0]["running"], json!(true));

    runtime.shutdown();
}

#[tokio::test]
async fn kill_dash_nine_of_the_worker_self_heals() {
    let runtime = Runtime::start();
    runtime.wait_for_health(Duration::from_secs(30)).await;

    let workers = runtime.worker_pids();
    assert_eq!(workers.len(), 1);
    let old_worker = workers[0];

    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(old_worker as i32),
        nix::sys::signal::Signal::SIGKILL,
    )
    .unwrap();

    // Supervisor respawns within backoff; port rebinds; clients reconnect;
    // the fixture extension is respawned. No SSH required.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let workers = runtime.worker_pids();
        if workers.len() == 1 && workers[0] != old_worker {
            break;
        }
        assert!(Instant::now() < deadline, "worker did not respawn");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    runtime.wait_for_health(Duration::from_secs(30)).await;

    let mut socket = ws_connect(runtime.port).await;
    let status = ws_request(&mut socket, 1, "remux/extensions/status", None).await;
    assert_eq!(status["result"]["extensions"][0]["running"], json!(true));
    assert_eq!(status["result"]["extensions"][0]["extensionId"], "fixture");

    runtime.shutdown();
}

#[tokio::test]
async fn boots_through_the_build_phase_and_serves_resources() {
    let runtime = Runtime::start_with(|root| {
        write_build_fixture_extension(root);
        // Fast sampler cadence for the didSample assertions below.
        std::fs::create_dir_all(root.join(".remux")).unwrap();
        std::fs::write(
            root.join(".remux/config.toml"),
            "resource_poll_seconds = 1\n",
        )
        .unwrap();
    });
    runtime.wait_for_health(Duration::from_secs(30)).await;

    // The extension came up through `building` on the real assembly path.
    let mut socket = ws_connect(runtime.port).await;
    let status = ws_request(&mut socket, 1, "remux/extensions/status", None).await;
    let extension = &status["result"]["extensions"][0];
    assert_eq!(extension["state"], "running");
    assert_eq!(extension["hasBuild"], json!(true));

    // Build lines are visible over the logs RPC.
    let logs = ws_request(
        &mut socket,
        2,
        "remux/extensions/logs",
        Some(json!({ "extensionId": "fixture" })),
    )
    .await;
    let lines = logs["result"]["lines"].as_array().unwrap();
    assert!(
        lines.iter().any(|line| line["stream"] == "build"),
        "{lines:?}"
    );

    // Resource snapshot has the documented shape with a live extension.
    // Samples are periodic; the first tick can race the extension spawn, so
    // poll until a sample reflects the running process group.
    let mut request_id = 3;
    let sample = loop {
        let resources = ws_request(&mut socket, request_id, "remux/system/resources", None).await;
        request_id += 1;
        let sample = resources["result"].clone();
        if sample["extensions"][0]["processCount"]
            .as_u64()
            .unwrap_or(0)
            >= 1
        {
            break sample;
        }
        assert!(
            request_id < 13,
            "no sample caught the running extension: {sample}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    assert!(sample["sampledAtMs"].as_i64().unwrap() > 0);
    assert!(sample["system"]["memTotalBytes"].as_u64().unwrap() > 0);
    assert!(sample["system"]["diskTotalBytes"].as_u64().unwrap() > 0);
    assert!(sample["runtime"]["rssBytes"].as_u64().unwrap() > 0);
    let extension = &sample["extensions"][0];
    assert_eq!(extension["extensionId"], "fixture");
    assert!(extension["rssBytes"].as_u64().unwrap() > 0, "{extension}");

    // didSample pushes flow while subscribed and stop after unsubscribe.
    let subscribed = ws_request(&mut socket, 100, "remux/system/resources/subscribe", None).await;
    assert_eq!(subscribed["result"], json!({ "ok": true }));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let frame = tokio::time::timeout(remaining, socket.next())
            .await
            .expect("no didSample before the deadline")
            .unwrap()
            .unwrap();
        if let Message::Text(text) = frame {
            let message: Value = serde_json::from_str(&text).unwrap();
            if message["method"] == "remux/system/resources/didSample" {
                assert!(message["params"]["sampledAtMs"].as_i64().unwrap() > 0);
                break;
            }
        }
    }
    let unsubscribed =
        ws_request(&mut socket, 101, "remux/system/resources/unsubscribe", None).await;
    assert_eq!(unsubscribed["result"], json!({ "ok": true }));
    // Drain anything already in flight, then expect silence for > one tick.
    tokio::time::sleep(Duration::from_millis(200)).await;
    loop {
        match tokio::time::timeout(Duration::from_millis(1_500), socket.next()).await {
            Err(_) => break, // silence — unsubscribed
            Ok(Some(Ok(Message::Text(text)))) => {
                let message: Value = serde_json::from_str(&text).unwrap();
                assert_ne!(
                    message["method"], "remux/system/resources/didSample",
                    "push after unsubscribe"
                );
            }
            Ok(_) => {}
        }
    }

    runtime.shutdown();
}

#[tokio::test]
async fn watch_role_resources_and_memory_ceiling_alert_are_visible() {
    let runtime = Runtime::start_with(|root| {
        write_watch_fixture_extension(root);
        std::fs::create_dir_all(root.join(".remux")).unwrap();
        std::fs::write(
            root.join(".remux/config.toml"),
            "resource_poll_seconds = 1\nextension_memory_ceiling_mb = 1\n",
        )
        .unwrap();
    });
    runtime.wait_for_health(Duration::from_secs(30)).await;

    let mut socket = ws_connect(runtime.port).await;
    let started = ws_request(
        &mut socket,
        1,
        "remux/extensions/watch/start",
        Some(json!({ "extensionId": "fixture" })),
    )
    .await;
    assert_eq!(started["result"]["started"], json!(true));
    assert_eq!(started["result"]["watch"]["state"], "running");

    let mut request_id = 2;
    let sample = loop {
        let resources = ws_request(&mut socket, request_id, "remux/system/resources", None).await;
        request_id += 1;
        let sample = resources["result"].clone();
        let watch = &sample["extensions"][0]["roles"]["watch"];
        if watch["processCount"].as_u64().unwrap_or(0) >= 1
            && watch["rssBytes"].as_u64().unwrap_or(0) > 0
        {
            break sample;
        }
        assert!(
            request_id < 20,
            "watch role never appeared in resources: {sample}"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    };
    let extension = &sample["extensions"][0];
    let watch = &extension["roles"]["watch"];
    assert!(extension["processCount"].as_u64().unwrap() >= watch["processCount"].as_u64().unwrap());
    assert!(extension["rssBytes"].as_u64().unwrap() >= watch["rssBytes"].as_u64().unwrap());

    wait_for_runtime_log(
        runtime.root.path(),
        "resources:memory-ceiling",
        Duration::from_secs(10),
    )
    .await;

    let _ = ws_request(
        &mut socket,
        request_id,
        "remux/extensions/watch/stop",
        Some(json!({ "extensionId": "fixture" })),
    )
    .await;
    runtime.shutdown();
}

#[tokio::test]
async fn sigterm_shuts_the_whole_tree_down_and_frees_the_port() {
    let runtime = Runtime::start();
    runtime.wait_for_health(Duration::from_secs(30)).await;
    let port = runtime.port;
    let supervisor_pid = runtime.supervisor.id();

    let started = Instant::now();
    runtime.shutdown();
    assert!(
        started.elapsed() < Duration::from_secs(9),
        "shutdown must respect the 5s worker deadline + 7s supervisor grace"
    );

    // No supervisor, no worker, port free.
    assert!(!PathBuf::from(format!("/proc/{supervisor_pid}")).exists());
    let rebind = std::net::TcpListener::bind(("127.0.0.1", port));
    assert!(rebind.is_ok(), "port should be free after shutdown");
}
