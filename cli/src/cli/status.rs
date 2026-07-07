//! `remux status` for pass 3b.
//!
//! The CLI reads systemd state locally and fetches the runtime snapshot from
//! the authenticated loopback `/api/status` endpoint using the same token
//! resolution order as the worker.

use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::cli::systemd::{self, SystemdInfo};
use crate::config::{load_remux_config, load_runtime_values};

#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeStatus {
    Ok(Value),
    Unauthorized,
    Unreachable(String),
}

pub fn run(root: &Path, json: bool) -> Result<i32, String> {
    let systemd = systemd::collect_info()?;
    let runtime = fetch_runtime_status(root)?;
    let stale = systemd
        .main_pid
        .map(systemd::main_pid_exe_deleted)
        .unwrap_or(false);

    if json {
        println!("{}", render_json(&systemd, &runtime, stale));
    } else {
        print!("{}", render_human(&systemd, &runtime, stale));
    }
    Ok(0)
}

pub fn fetch_runtime_status(root: &Path) -> Result<RuntimeStatus, String> {
    let config = load_remux_config(root)?;
    let runtime = load_runtime_values(None, None, &config)?;
    let token =
        crate::auth::resolve_token(std::env::var("REMUX_AUTH_TOKEN").ok().as_deref(), root)?.token;
    let url = format!("http://127.0.0.1:{}/api/status", runtime.port);
    let tokio = tokio::runtime::Runtime::new()
        .map_err(|error| format!("failed to start async runtime: {error}"))?;
    tokio.block_on(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| format!("failed to build HTTP client: {error}"))?;
        let response = client.get(&url).bearer_auth(token).send().await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                return Ok(RuntimeStatus::Unreachable(format!(
                    "runtime not reachable at :{} ({error})",
                    runtime.port
                )))
            }
        };
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Ok(RuntimeStatus::Unauthorized);
        }
        if !response.status().is_success() {
            return Ok(RuntimeStatus::Unreachable(format!(
                "runtime returned HTTP {} at :{}",
                response.status().as_u16(),
                runtime.port
            )));
        }
        response
            .json::<Value>()
            .await
            .map(RuntimeStatus::Ok)
            .map_err(|error| format!("invalid /api/status response: {error}"))
    })
}

pub fn render_json(systemd: &SystemdInfo, runtime: &RuntimeStatus, stale: bool) -> Value {
    let mut object = match runtime {
        RuntimeStatus::Ok(Value::Object(object)) => object.clone(),
        RuntimeStatus::Ok(other) => {
            let mut object = Map::new();
            object.insert("runtime".to_string(), other.clone());
            object
        }
        RuntimeStatus::Unauthorized => {
            let mut object = Map::new();
            object.insert("runtimeError".to_string(), Value::from("unauthorized"));
            object
        }
        RuntimeStatus::Unreachable(message) => {
            let mut object = Map::new();
            object.insert("runtimeError".to_string(), Value::from(message.clone()));
            object
        }
    };
    object.insert("systemd".to_string(), systemd.to_json());
    object.insert("binaryStale".to_string(), Value::from(stale));
    Value::Object(object)
}

pub fn render_human(systemd: &SystemdInfo, runtime: &RuntimeStatus, stale: bool) -> String {
    let mut out = String::new();
    out.push_str("systemd\n");
    if !systemd.installed {
        out.push_str("  unit: not installed (run remux install for background service)\n");
    } else {
        out.push_str(&format!(
            "  unit: installed at {}\n",
            systemd.unit_path.display()
        ));
        out.push_str(&format!("  enabled: {}\n", yes_no_unknown(systemd.enabled)));
        out.push_str(&format!("  active: {}\n", yes_no_unknown(systemd.active)));
        out.push_str(&format!("  linger: {}\n", yes_no_unknown(systemd.linger)));
        out.push_str(&format!(
            "  main pid: {}\n",
            systemd
                .main_pid
                .map(|pid| pid.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ));
        for note in &systemd.notes {
            out.push_str(&format!("  note: {note}\n"));
        }
    }

    match runtime {
        RuntimeStatus::Ok(payload) => {
            let payload = status_with_resource_rows(payload.clone());
            out.push_str("runtime\n");
            out.push_str(&format!("  version: {}\n", text(&payload, "version")));
            out.push_str(&format!("  pid: {}\n", number(&payload, "pid")));
            out.push_str(&format!(
                "  uptime: {}\n",
                duration_ms(payload.get("uptimeMs"))
            ));
            out.push_str(&format!(
                "  auth: {}\n",
                if payload
                    .get("requireAuth")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
                {
                    "on"
                } else {
                    "off"
                }
            ));
            if let Some(resources) = payload.get("resources") {
                render_resources(&mut out, resources);
            }
            if let Some(extensions) = payload
                .get("extensions")
                .and_then(|value| value.get("extensions"))
                .and_then(Value::as_array)
            {
                render_extensions(&mut out, extensions);
            }
        }
        RuntimeStatus::Unauthorized => {
            out.push_str("runtime\n");
            out.push_str("  token mismatch -- is REMUX_AUTH_TOKEN or the token file stale?\n");
            out.push_str("  hint: remux logs\n");
        }
        RuntimeStatus::Unreachable(message) => {
            out.push_str("runtime\n");
            out.push_str(&format!("  {message}\n"));
            out.push_str("  hint: remux logs\n");
        }
    }

    if stale {
        out.push_str("warning: binary rebuilt since start -- run 'remux restart' to pick it up\n");
    }
    out
}

fn yes_no_unknown(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "yes",
        Some(false) => "no",
        None => "unknown",
    }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("unknown")
}

fn number(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_i64)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn render_resources(out: &mut String, resources: &Value) {
    out.push_str("resources\n");
    if let Some(runtime) = resources.get("runtime") {
        out.push_str(&format!(
            "  runtime: rss={} cpu={:.1}%\n",
            bytes(runtime.get("rssBytes")),
            runtime
                .get("cpuPercent")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        ));
    }
    if let Some(system) = resources.get("system") {
        out.push_str(&format!(
            "  system: load1={} mem_available={}\n",
            system.get("load1").and_then(Value::as_f64).unwrap_or(0.0),
            bytes(system.get("memAvailableBytes"))
        ));
    }
}

fn render_extensions(out: &mut String, extensions: &[Value]) {
    out.push_str("extensions\n");
    out.push_str(
        "  id                 state       pid      uptime     restarts watch      rss        cpu\n",
    );
    for extension in extensions {
        let id = extension
            .get("extensionId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let state = extension
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let pid = extension
            .get("pid")
            .and_then(Value::as_u64)
            .map(|pid| pid.to_string())
            .unwrap_or_else(|| "-".to_string());
        let uptime = duration_ms(extension.get("uptimeMs"));
        let restarts = extension
            .get("restartCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let watch = extension
            .get("watch")
            .and_then(|watch| watch.get("state"))
            .and_then(Value::as_str)
            .unwrap_or("-");
        let resources = extension_resources(extension);
        out.push_str(&format!(
            "  {id:<18} {state:<11} {pid:<8} {uptime:<10} {restarts:<8} {watch:<10} {:<10} {:.1}%\n",
            bytes(resources.and_then(|value| value.get("rssBytes"))),
            resources
                .and_then(|value| value.get("cpuPercent"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        ));
    }
}

fn extension_resources(extension: &Value) -> Option<&Value> {
    extension.get("__resources")
}

fn duration_ms(value: Option<&Value>) -> String {
    let Some(ms) = value.and_then(Value::as_u64) else {
        return "-".to_string();
    };
    let seconds = ms / 1000;
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let seconds = seconds % 60;
    if hours > 0 {
        format!("{hours}h{minutes:02}m")
    } else if minutes > 0 {
        format!("{minutes}m{seconds:02}s")
    } else {
        format!("{seconds}s")
    }
}

fn bytes(value: Option<&Value>) -> String {
    let bytes = value.and_then(Value::as_u64).unwrap_or(0);
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1}GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes}B")
    }
}

/// Joins the two `/api/status` arrays for human rendering only. The JSON
/// surface stays raw.
pub fn status_with_resource_rows(mut payload: Value) -> Value {
    let Some(resource_rows) = payload
        .get("resources")
        .and_then(|resources| resources.get("extensions"))
        .and_then(Value::as_array)
        .cloned()
    else {
        return payload;
    };
    let Some(extensions) = payload
        .get_mut("extensions")
        .and_then(|status| status.get_mut("extensions"))
        .and_then(Value::as_array_mut)
    else {
        return payload;
    };
    for extension in extensions {
        let Some(id) = extension.get("extensionId").and_then(Value::as_str) else {
            continue;
        };
        if let Some(resources) = resource_rows
            .iter()
            .find(|row| row.get("extensionId").and_then(Value::as_str) == Some(id))
        {
            if let Some(object) = extension.as_object_mut() {
                object.insert("__resources".to_string(), resources.clone());
            }
        }
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_json_payload_plus_systemd_and_staleness() {
        let info = SystemdInfo {
            installed: true,
            enabled: Some(true),
            active: Some(true),
            main_pid: Some(12),
            ..SystemdInfo::default()
        };
        let rendered = render_json(
            &info,
            &RuntimeStatus::Ok(serde_json::json!({ "version": "0.1.0", "pid": 99 })),
            true,
        );
        assert_eq!(rendered["version"], "0.1.0");
        assert_eq!(rendered["systemd"]["mainPid"], 12);
        assert_eq!(rendered["binaryStale"], true);
    }

    #[test]
    fn renders_human_unauthorized_hint() {
        let rendered = render_human(&SystemdInfo::default(), &RuntimeStatus::Unauthorized, false);
        assert!(rendered.contains("token mismatch"), "{rendered}");
        assert!(rendered.contains("remux logs"), "{rendered}");
    }

    #[test]
    fn formats_durations_and_bytes() {
        assert_eq!(duration_ms(Some(&Value::from(65_000))), "1m05s");
        assert_eq!(bytes(Some(&Value::from(2 * 1024 * 1024))), "2.0MB");
    }
}
