//! End-to-end tests: the real `remux` binary (supervisor + worker) against a
//! fixture extension, covering the acceptance scenarios — exit-75 restart
//! round-trip and `kill -9` self-healing.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn write_fixture_extension(root: &Path) {
    let ext_dir = root.join("extensions/fixture");
    let dist = ext_dir.join("viewer/dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<h1>fixture viewer</h1>").unwrap();

    let manifest = json!({
        "version": 1,
        "id": "fixture",
        "name": "Fixture",
        "launchers": [ { "id": "open", "label": "Open" } ],
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

struct Runtime {
    supervisor: Child,
    port: u16,
    root: tempfile::TempDir,
}

impl Runtime {
    fn start() -> Self {
        let root = tempfile::tempdir().unwrap();
        write_fixture_extension(root.path());
        let port = free_port();

        let supervisor = Command::new(env!("CARGO_BIN_EXE_remux"))
            .arg("start")
            .current_dir(root.path())
            // Hermetic: a stray REMUX_WORKER in the invoking environment
            // would turn the supervisor into a bare worker.
            .env_remove("REMUX_WORKER")
            .env_remove("REMUX_EXTENSION_ROOTS")
            .env("REMUX_HOST", "127.0.0.1")
            .env("REMUX_PORT", port.to_string())
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
    let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    socket
}

async fn ws_request(socket: &mut Ws, id: u64, method: &str, params: Option<Value>) -> Value {
    let mut frame = json!({ "jsonrpc": "2.0", "id": id, "method": method });
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

#[tokio::test]
async fn boots_serves_catalog_and_runs_the_fixture_extension() {
    let runtime = Runtime::start();
    let health = runtime.wait_for_health(Duration::from_secs(30)).await;
    assert_eq!(
        health,
        json!({ "ok": true, "defaultExtension": "fixture", "service": "remux" })
    );

    let catalog: Value = reqwest::get(format!("{}/remux/extensions", runtime.base_url()))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(catalog["defaultExtensionId"], "fixture");
    assert_eq!(catalog["extensions"][0]["id"], "fixture");

    let viewer = reqwest::get(format!("{}/viewers/fixture/", runtime.base_url()))
        .await
        .unwrap();
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
