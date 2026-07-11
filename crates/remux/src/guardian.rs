use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

pub struct Guardian {
    root: PathBuf,
    worker_pid: AtomicU32,
    restart_worker: AtomicBool,
    protecting: AtomicBool,
    operations: Mutex<HashSet<String>>,
}

impl Guardian {
    pub fn start(root: &Path, host: &str, port: u16) -> Arc<Self> {
        let guardian = Arc::new(Self {
            root: root.to_path_buf(),
            worker_pid: AtomicU32::new(0),
            restart_worker: AtomicBool::new(false),
            protecting: AtomicBool::new(false),
            operations: Mutex::new(HashSet::new()),
        });
        let server = guardian.clone();
        let address = format!("{host}:{port}");
        std::thread::Builder::new()
            .name("remux-guardian-http".to_string())
            .spawn(move || match TcpListener::bind(&address) {
                Ok(listener) => {
                    for stream in listener.incoming() {
                        match stream {
                            Ok(stream) => server.handle(stream),
                            Err(error) => eprintln!("remux guardian accept failed: {error}"),
                        }
                    }
                }
                Err(error) => eprintln!("remux guardian failed to bind {address}: {error}"),
            })
            .ok();
        if std::env::var("REMUX_RESOURCE_GOVERNANCE").as_deref() == Ok("1") {
            let monitor = guardian.clone();
            std::thread::Builder::new()
                .name("remux-guardian-pressure".to_string())
                .spawn(move || loop {
                    monitor.sample_protection();
                    std::thread::sleep(std::time::Duration::from_millis(250));
                })
                .ok();
        }
        guardian
    }

    pub fn set_worker_pid(&self, pid: u32) {
        self.worker_pid.store(pid, Ordering::SeqCst);
    }

    pub fn take_worker_restart(&self) -> bool {
        self.restart_worker.swap(false, Ordering::SeqCst)
    }

    pub fn cleanup_ordinary_scopes(&self) {
        for unit in list_units("remux-ext-*") {
            let _ = systemctl(&["stop", &unit]);
        }
        for unit in list_units("remux-workload-*") {
            if !unit.contains("-persistent-") {
                let _ = systemctl(&["stop", &unit]);
            }
        }
    }

    fn handle(&self, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
        let mut buffer = [0_u8; 16 * 1024];
        let Ok(length) = stream.read(&mut buffer) else {
            return;
        };
        let request = String::from_utf8_lossy(&buffer[..length]);
        let mut lines = request.lines();
        let Some(request_line) = lines.next() else {
            return;
        };
        let mut request_parts = request_line.split_whitespace();
        let method = request_parts.next().unwrap_or("");
        let path = request_parts.next().unwrap_or("");
        let headers = lines
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect::<std::collections::HashMap<_, _>>();

        if path == "/healthz" && method == "GET" {
            respond(&mut stream, 200, serde_json::json!({ "ok": true }));
            return;
        }
        if !self.authorized(headers.get("authorization").map(String::as_str)) {
            respond(
                &mut stream,
                401,
                serde_json::json!({ "error": "unauthorized" }),
            );
            return;
        }

        if method == "GET" && path == "/control/v1/status" {
            let capabilities = crate::resource::systemd::effective_capabilities();
            respond(
                &mut stream,
                200,
                serde_json::json!({
                    "protected": capabilities.protected_mode,
                    "protecting": self.protecting.load(Ordering::SeqCst),
                    "reasons": capabilities.reasons,
                    "workerHeartbeatAgeMs": self.heartbeat_age_ms(),
                    "workerPid": nonzero(self.worker_pid.load(Ordering::SeqCst)),
                }),
            );
            return;
        }
        if method == "GET" && path == "/control/v1/extensions" {
            respond(
                &mut stream,
                200,
                serde_json::json!({ "extensions": self.extensions() }),
            );
            return;
        }
        if method != "POST" {
            respond(
                &mut stream,
                404,
                serde_json::json!({ "error": "not found" }),
            );
            return;
        }
        let Some(operation_id) = headers
            .get("x-remux-operation-id")
            .filter(|value| !value.trim().is_empty())
        else {
            respond(
                &mut stream,
                400,
                serde_json::json!({ "error": "x-remux-operation-id required" }),
            );
            return;
        };
        if !self.operations.lock().unwrap().insert(operation_id.clone()) {
            respond(
                &mut stream,
                200,
                serde_json::json!({ "ok": true, "replayed": true }),
            );
            return;
        }

        let result = self.mutate(path);
        match result {
            Ok(()) => respond(&mut stream, 200, serde_json::json!({ "ok": true })),
            Err(error) => respond(&mut stream, 500, serde_json::json!({ "error": error })),
        }
    }

    fn authorized(&self, authorization: Option<&str>) -> bool {
        let Ok(token) = std::fs::read_to_string(self.root.join(crate::auth::TOKEN_RELATIVE_PATH))
        else {
            return false;
        };
        authorization
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|candidate| candidate == token.trim())
    }

    fn mutate(&self, path: &str) -> Result<(), String> {
        match path {
            "/control/v1/worker/restart" => {
                self.restart_worker.store(true, Ordering::SeqCst);
                Ok(())
            }
            "/control/v1/protection/engage" => {
                freeze_matching(true)?;
                self.protecting.store(true, Ordering::SeqCst);
                Ok(())
            }
            "/control/v1/protection/release" => {
                freeze_matching(false)?;
                self.protecting.store(false, Ordering::SeqCst);
                Ok(())
            }
            _ => {
                let Some(rest) = path.strip_prefix("/control/v1/extensions/") else {
                    return Err("unknown guardian operation".to_string());
                };
                let Some((extension, action)) = rest.split_once('/') else {
                    return Err("invalid extension operation".to_string());
                };
                if extension.is_empty()
                    || !extension
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                {
                    return Err("invalid extension id".to_string());
                }
                let units = list_units(&format!("remux-extensions-{extension}-*.slice"));
                for unit in units {
                    match action {
                        "pause" => systemctl(&["freeze", &unit])?,
                        "resume" => systemctl(&["thaw", &unit])?,
                        "stop" => systemctl(&["stop", &unit])?,
                        "restart" => {
                            systemctl(&["stop", &unit])?;
                            self.restart_worker.store(true, Ordering::SeqCst);
                        }
                        _ => return Err("unknown extension operation".to_string()),
                    }
                }
                Ok(())
            }
        }
    }

    fn extensions(&self) -> Vec<serde_json::Value> {
        let Ok(config) = crate::config::load_remux_config(&self.root) else {
            return Vec::new();
        };
        let roots = crate::extensions::discovery::extension_roots(None, &config, &self.root);
        let Ok(extensions) = crate::extensions::discovery::discover_extensions(&roots) else {
            return Vec::new();
        };
        let active = list_units("remux-extensions-*.slice");
        extensions
            .into_iter()
            .map(|extension| {
                let canonical = extension
                    .root_dir
                    .canonicalize()
                    .unwrap_or(extension.root_dir)
                    .to_string_lossy()
                    .into_owned();
                let unit =
                    crate::resource::systemd::extension_slice_name(&extension.id, &canonical);
                serde_json::json!({
                    "active": active.iter().any(|candidate| candidate == &unit),
                    "id": extension.id,
                    "name": extension.name,
                    "unit": unit,
                })
            })
            .collect()
    }

    fn heartbeat_age_ms(&self) -> Option<i64> {
        let heartbeat = std::fs::read_to_string(self.root.join(".remux/worker-heartbeat"))
            .ok()?
            .trim()
            .parse::<i64>()
            .ok()?;
        Some(crate::time::now_ms().saturating_sub(heartbeat))
    }

    fn sample_protection(&self) {
        let heartbeat_age = self.heartbeat_age_ms().unwrap_or(i64::MAX);
        let pressured = cpu_pressure_avg10().is_some_and(|pressure| pressure >= 10.0);
        if heartbeat_age >= 1_500 && pressured && !self.protecting.swap(true, Ordering::SeqCst) {
            let _ = freeze_matching(true);
            eprintln!("remux guardian: protection engaged heartbeat_age_ms={heartbeat_age}");
        } else if heartbeat_age < 750 && self.protecting.swap(false, Ordering::SeqCst) {
            let _ = freeze_matching(false);
            eprintln!("remux guardian: protection released");
        }
    }
}

fn freeze_matching(freeze: bool) -> Result<(), String> {
    for pattern in [
        "remux-ext-*-background-*",
        "remux-ext-*-build-*",
        "remux-ext-*-research-*",
        "remux-workload-*-background-*",
        "remux-workload-*-research-*",
    ] {
        for unit in list_units(pattern) {
            systemctl(&[if freeze { "freeze" } else { "thaw" }, &unit])?;
        }
    }
    Ok(())
}

fn list_units(pattern: &str) -> Vec<String> {
    let Ok(output) = std::process::Command::new("systemctl")
        .args([
            "--user",
            "list-units",
            pattern,
            "--all",
            "--no-legend",
            "--plain",
        ])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split_whitespace().next().map(str::to_string))
        .collect()
}

fn systemctl(args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .map_err(|error| format!("systemctl failed to start: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn respond(stream: &mut TcpStream, status: u16, body: serde_json::Value) {
    let body = body.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn nonzero(value: u32) -> Option<u32> {
    (value > 0).then_some(value)
}

fn cpu_pressure_avg10() -> Option<f64> {
    let source = std::fs::read_to_string("/proc/pressure/cpu").ok()?;
    let some = source.lines().find(|line| line.starts_with("some "))?;
    some.split_whitespace()
        .find_map(|field| field.strip_prefix("avg10="))?
        .parse()
        .ok()
}
