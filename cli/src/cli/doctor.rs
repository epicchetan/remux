//! `remux doctor` checks from pass 3b.
//!
//! Checks are read-only and ordered to surface dependency failures first.

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::cli::{install, root, systemd};
use crate::config::{load_remux_config, load_runtime_values};

const LOG_WARN_BYTES: u64 = 500 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Severity {
    Ok,
    Warn,
    Fail,
}

impl Severity {
    fn as_str(self) -> &'static str {
        match self {
            Severity::Ok => "ok",
            Severity::Warn => "warn",
            Severity::Fail => "fail",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Check {
    severity: Severity,
    name: &'static str,
    message: String,
}

impl Check {
    fn ok(name: &'static str, message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Ok,
            name,
            message: message.into(),
        }
    }

    fn warn(name: &'static str, message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Warn,
            name,
            message: message.into(),
        }
    }

    fn fail(name: &'static str, message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Fail,
            name,
            message: message.into(),
        }
    }
}

pub fn run(flag_root: Option<&Path>) -> Result<i32, String> {
    let mut checks = Vec::new();
    let root_result = root::discover(flag_root);
    let root = match root_result {
        Ok(root) => {
            checks.push(check_root_config(&root));
            root
        }
        Err(error) => {
            checks.push(Check::fail("root", error));
            for name in CHECK_NAMES.iter().skip(1) {
                checks.push(Check::warn(*name, "skipped: root unavailable"));
            }
            return Ok(print_checks(checks));
        }
    };

    let systemd_info = systemd::collect_info().unwrap_or_default();
    let health = check_health_and_status(&root);
    let health_ok = matches!(health.severity, Severity::Ok);

    checks.push(check_token_file(&root));
    checks.push(check_path_remux(&root));
    checks.push(check_node_symlinks());
    checks.push(check_unit_drift());
    checks.push(check_unit_state(&systemd_info));
    checks.push(check_unit_path_tools());
    checks.push(health);
    checks.push(check_binary_stale(&systemd_info));
    checks.push(check_stray_start_processes(&systemd_info));
    checks.push(check_port_foreign(&root, health_ok, systemd_info.main_pid));
    checks.push(check_logs_size(&root));

    Ok(print_checks(checks))
}

const CHECK_NAMES: [&str; 12] = [
    "root",
    "token",
    "path-remux",
    "node-symlinks",
    "unit-drift",
    "unit-state",
    "unit-path",
    "runtime",
    "binary-stale",
    "stray-process",
    "port",
    "logs-size",
];

fn print_checks(checks: Vec<Check>) -> i32 {
    let failed = checks.iter().any(|check| check.severity == Severity::Fail);
    for check in checks {
        println!(
            "{} {}: {}",
            check.severity.as_str(),
            check.name,
            check.message
        );
    }
    if failed {
        1
    } else {
        0
    }
}

fn check_root_config(root: &Path) -> Check {
    match load_remux_config(root) {
        Ok(_) => Check::ok(
            "root",
            format!("{} discovered; config.toml parses", root.display()),
        ),
        Err(error) => Check::fail("root", error),
    }
}

fn check_token_file(root: &Path) -> Check {
    let path = root.join(crate::auth::TOKEN_RELATIVE_PATH);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Check::fail(
                "token",
                format!("{} missing; run remux token", path.display()),
            )
        }
        Err(error) => return Check::fail("token", format!("{}: {error}", path.display())),
    };
    let mode = metadata.permissions().mode() & 0o777;
    if mode == 0o600 {
        Check::ok("token", format!("{} exists with mode 0600", path.display()))
    } else {
        Check::fail(
            "token",
            format!(
                "{} mode is {mode:o}; run chmod 600 {}",
                path.display(),
                path.display()
            ),
        )
    }
}

fn check_path_remux(root: &Path) -> Check {
    let path = std::env::var("PATH").unwrap_or_default();
    let Some(found) = install::find_on_path("remux", &path) else {
        return Check::fail("path-remux", "remux not found on PATH; run remux install");
    };
    let expected = root.join("target/release/remux");
    match symlink_target(&found) {
        Some(target) if target == expected => Check::ok(
            "path-remux",
            format!("{} -> {}", found.display(), expected.display()),
        ),
        Some(target) => Check::fail(
            "path-remux",
            format!(
                "{} points to {}; run remux install",
                found.display(),
                target.display()
            ),
        ),
        None => Check::fail(
            "path-remux",
            format!(
                "{} is not the install symlink; run remux install",
                found.display()
            ),
        ),
    }
}

fn symlink_target(link: &Path) -> Option<PathBuf> {
    let target = std::fs::read_link(link).ok()?;
    if target.is_absolute() {
        Some(target)
    } else {
        Some(link.parent().unwrap_or_else(|| Path::new("/")).join(target))
    }
}

fn check_node_symlinks() -> Check {
    let local_bin = match systemd::local_bin_dir() {
        Ok(path) => path,
        Err(error) => return Check::fail("node-symlinks", error),
    };
    let mut missing = Vec::new();
    for name in ["node", "npm"] {
        let path = local_bin.join(name);
        let is_valid = std::fs::symlink_metadata(&path)
            .map(|metadata| metadata.file_type().is_symlink() && path.exists())
            .unwrap_or(false);
        if !is_valid {
            missing.push(name);
        }
    }
    if missing.is_empty() {
        Check::ok(
            "node-symlinks",
            format!("{} node/npm are present", local_bin.display()),
        )
    } else {
        Check::fail(
            "node-symlinks",
            format!(
                "missing or dangling {}; run remux install from a login shell",
                missing.join(", ")
            ),
        )
    }
}

fn check_unit_drift() -> Check {
    match systemd::installed_unit_source() {
        Ok(Some(source)) if systemd::unit_matches_embedded(&source) => {
            Check::ok("unit-drift", "installed unit matches embedded copy")
        }
        Ok(Some(_)) => Check::warn("unit-drift", "installed unit differs; run remux install"),
        Ok(None) => Check::warn("unit-drift", "unit not installed; run remux install"),
        Err(error) => Check::fail("unit-drift", error),
    }
}

fn check_unit_state(info: &systemd::SystemdInfo) -> Check {
    if !info.installed {
        return Check::fail("unit-state", "unit not installed; run remux install");
    }
    let mut missing = Vec::new();
    if info.enabled != Some(true) {
        missing.push("enable the unit");
    }
    if info.active != Some(true) {
        missing.push("start the unit");
    }
    if info.linger != Some(true) {
        missing.push("enable linger");
    }
    if missing.is_empty() {
        Check::ok("unit-state", "unit enabled, active, and linger on")
    } else {
        Check::fail(
            "unit-state",
            format!("{}; run remux install then remux start", missing.join(", ")),
        )
    }
}

fn check_unit_path_tools() -> Check {
    let unit = match systemd::installed_unit_source() {
        Ok(Some(source)) => source,
        Ok(None) => return Check::fail("unit-path", "unit not installed; run remux install"),
        Err(error) => return Check::fail("unit-path", error),
    };
    let home = match systemd::home_dir() {
        Ok(home) => home,
        Err(error) => return Check::fail("unit-path", error),
    };
    let Some(path_env) = unit_environment_path(&unit, &home) else {
        return Check::fail(
            "unit-path",
            "unit has no Environment=PATH; run remux install",
        );
    };
    let missing: Vec<&str> = ["node", "npm", "cargo"]
        .into_iter()
        .filter(|binary| install::find_on_path(binary, &path_env).is_none())
        .collect();
    if missing.is_empty() {
        Check::ok("unit-path", "node, npm, and cargo resolve on the unit PATH")
    } else {
        Check::fail(
            "unit-path",
            format!(
                "unit PATH missing {}; run remux install from a login shell",
                missing.join(", ")
            ),
        )
    }
}

pub fn unit_environment_path(unit: &str, home: &Path) -> Option<String> {
    for line in unit.lines() {
        let line = line.trim();
        let Some(value) = line.strip_prefix("Environment=PATH=") else {
            continue;
        };
        return Some(value.replace("%h", &home.to_string_lossy()));
    }
    None
}

fn check_health_and_status(root: &Path) -> Check {
    let config = match load_remux_config(root) {
        Ok(config) => config,
        Err(error) => return Check::fail("runtime", error),
    };
    let runtime = match load_runtime_values(None, None, &config) {
        Ok(runtime) => runtime,
        Err(error) => return Check::fail("runtime", error),
    };
    let token = match read_status_token(root) {
        Ok(token) => token,
        Err(error) => return Check::fail("runtime", error),
    };
    let tokio = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            return Check::fail("runtime", format!("failed to start async runtime: {error}"))
        }
    };
    tokio.block_on(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                return Check::fail("runtime", format!("failed to build HTTP client: {error}"))
            }
        };
        let health = client
            .get(format!("http://127.0.0.1:{}/healthz", runtime.port))
            .send()
            .await;
        match health {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => {
                return Check::fail(
                    "runtime",
                    format!("/healthz returned HTTP {}", response.status().as_u16()),
                )
            }
            Err(error) => {
                return Check::fail(
                    "runtime",
                    format!("daemon down at :{} ({error})", runtime.port),
                )
            }
        }
        let status = client
            .get(format!("http://127.0.0.1:{}/api/status", runtime.port))
            .bearer_auth(token)
            .send()
            .await;
        match status {
            Ok(response) if response.status().is_success() => Check::ok(
                "runtime",
                "/healthz and authenticated /api/status reachable",
            ),
            Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => Check::fail(
                "runtime",
                "token mismatch; check REMUX_AUTH_TOKEN or .remux/auth-token",
            ),
            Ok(response) => Check::fail(
                "runtime",
                format!("/api/status returned HTTP {}", response.status().as_u16()),
            ),
            Err(error) => Check::fail("runtime", format!("/api/status failed: {error}")),
        }
    })
}

fn read_status_token(root: &Path) -> Result<String, String> {
    if let Ok(token) = std::env::var("REMUX_AUTH_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return Ok(token);
        }
    }
    let path = root.join(crate::auth::TOKEN_RELATIVE_PATH);
    std::fs::read_to_string(&path)
        .map(|token| token.trim().to_string())
        .map_err(|error| format!("{}: {error}; run remux token", path.display()))
        .and_then(|token| {
            if token.is_empty() {
                Err(format!("{} is empty; run remux token", path.display()))
            } else {
                Ok(token)
            }
        })
}

fn check_binary_stale(info: &systemd::SystemdInfo) -> Check {
    let Some(pid) = info.main_pid else {
        return Check::warn("binary-stale", "MainPID unknown; start the unit");
    };
    if systemd::main_pid_exe_deleted(pid) {
        Check::warn(
            "binary-stale",
            "binary rebuilt since start; run remux restart",
        )
    } else {
        Check::ok("binary-stale", "running supervisor binary is current")
    }
}

fn check_stray_start_processes(info: &systemd::SystemdInfo) -> Check {
    if !info.installed {
        return Check::warn(
            "stray-process",
            "unit not installed; skipped stray process scan",
        );
    }
    let Some(main_pid) = info.main_pid else {
        return Check::warn(
            "stray-process",
            "MainPID unknown; skipped stray process scan",
        );
    };
    let mut strays = Vec::new();
    for pid in proc_pids() {
        if pid == std::process::id() {
            continue;
        }
        let cmdline = read_cmdline(pid);
        if !looks_like_remux_start(&cmdline) {
            continue;
        }
        if !is_unit_tree_pid(pid, main_pid) {
            strays.push(pid);
        }
    }
    if strays.is_empty() {
        Check::ok(
            "stray-process",
            "no remux start process beyond the unit supervisor and worker",
        )
    } else {
        Check::warn(
            "stray-process",
            format!(
                "found stray remux start pid(s) {}; stop them",
                join_pids(&strays)
            ),
        )
    }
}

fn is_unit_tree_pid(pid: u32, main_pid: u32) -> bool {
    is_unit_tree_pid_with(pid, main_pid, read_ppid)
}

fn is_unit_tree_pid_with(
    pid: u32,
    main_pid: u32,
    read_parent: impl Fn(u32) -> Option<u32>,
) -> bool {
    pid == main_pid || read_parent(pid) == Some(main_pid)
}

fn looks_like_remux_start(cmdline: &[String]) -> bool {
    if cmdline.len() < 2 {
        return false;
    }
    let exe = Path::new(&cmdline[0])
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    exe == "remux" && cmdline.iter().any(|arg| arg == "start")
}

fn check_port_foreign(root: &Path, health_ok: bool, main_pid: Option<u32>) -> Check {
    let config = match load_remux_config(root) {
        Ok(config) => config,
        Err(error) => return Check::fail("port", error),
    };
    let runtime = match load_runtime_values(None, None, &config) {
        Ok(runtime) => runtime,
        Err(error) => return Check::fail("port", error),
    };
    if health_ok {
        return Check::ok("port", format!(":{} is held by the daemon", runtime.port));
    }
    match listening_pids(runtime.port) {
        Ok(pids) if pids.is_empty() => Check::ok(
            "port",
            format!(":{} is free while daemon is down", runtime.port),
        ),
        Ok(pids) => {
            let filtered: Vec<u32> = pids
                .into_iter()
                .filter(|pid| {
                    main_pid
                        .map(|main_pid| !is_unit_tree_pid(*pid, main_pid))
                        .unwrap_or(true)
                })
                .collect();
            if filtered.is_empty() {
                Check::ok("port", format!(":{} is held by remux", runtime.port))
            } else {
                Check::fail(
                    "port",
                    format!(
                        ":{} held by foreign pid(s) {}",
                        runtime.port,
                        join_pids(&filtered)
                    ),
                )
            }
        }
        Err(error) => Check::warn("port", error),
    }
}

fn check_logs_size(root: &Path) -> Check {
    let dir = root.join(".remux/logs");
    let bytes = dir_size(&dir).unwrap_or(0);
    if bytes <= LOG_WARN_BYTES {
        Check::ok("logs-size", format!("{} under 500 MB", dir.display()))
    } else {
        Check::warn(
            "logs-size",
            format!(
                "{} is {}; check log retention",
                dir.display(),
                format_bytes(bytes)
            ),
        )
    }
}

fn dir_size(path: &Path) -> Result<u64, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let mut total = 0;
    let entries =
        std::fs::read_dir(path).map_err(|error| format!("{}: {error}", path.display()))?;
    for entry in entries.flatten() {
        total += dir_size(&entry.path()).unwrap_or(0);
    }
    Ok(total)
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{bytes}B")
    }
}

fn proc_pids() -> Vec<u32> {
    let mut pids = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if let Ok(pid) = name.parse::<u32>() {
                pids.push(pid);
            }
        }
    }
    pids
}

fn read_cmdline(pid: u32) -> Vec<String> {
    let Ok(bytes) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
        return Vec::new();
    };
    bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .filter_map(|part| String::from_utf8(part.to_vec()).ok())
        .collect()
}

fn read_ppid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_proc_stat_ppid(&stat)
}

fn parse_proc_stat_ppid(content: &str) -> Option<u32> {
    let after_comm = &content[content.rfind(')')? + 1..];
    let fields: Vec<&str> = after_comm.split_whitespace().collect();
    fields.get(1)?.parse().ok()
}

fn listening_pids(port: u16) -> Result<Vec<u32>, String> {
    let inodes = listening_socket_inodes(port)?;
    if inodes.is_empty() {
        return Ok(Vec::new());
    }
    let mut pids = HashSet::new();
    for pid in proc_pids() {
        let fd_dir = format!("/proc/{pid}/fd");
        let Ok(entries) = std::fs::read_dir(fd_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(target) = std::fs::read_link(entry.path()) else {
                continue;
            };
            let target = target.to_string_lossy();
            let Some(inode) = target
                .strip_prefix("socket:[")
                .and_then(|rest| rest.strip_suffix(']'))
            else {
                continue;
            };
            if inodes.contains(inode) {
                pids.insert(pid);
            }
        }
    }
    let mut pids: Vec<u32> = pids.into_iter().collect();
    pids.sort();
    Ok(pids)
}

fn listening_socket_inodes(port: u16) -> Result<HashSet<String>, String> {
    let mut inodes = HashSet::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let source = std::fs::read_to_string(path).map_err(|error| format!("{path}: {error}"))?;
        for line in source.lines().skip(1) {
            if let Some(inode) = parse_proc_net_tcp_line(line, port) {
                inodes.insert(inode);
            }
        }
    }
    Ok(inodes)
}

fn parse_proc_net_tcp_line(line: &str, port: u16) -> Option<String> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    let local = fields.get(1)?;
    let state = fields.get(3)?;
    if *state != "0A" {
        return None;
    }
    let (_, raw_port) = local.rsplit_once(':')?;
    let parsed = u16::from_str_radix(raw_port, 16).ok()?;
    if parsed != port {
        return None;
    }
    Some(fields.get(9)?.to_string())
}

fn join_pids(pids: &[u32]) -> String {
    pids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_check_fails_loose_permissions() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(crate::auth::TOKEN_RELATIVE_PATH);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "token\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let check = check_token_file(root.path());
        assert_eq!(check.severity, Severity::Fail);
        assert!(check.message.contains("chmod 600"), "{}", check.message);
    }

    #[test]
    fn node_symlink_probe_detects_dangling_paths() {
        let root = tempfile::tempdir().unwrap();
        let node = root.path().join("node");
        std::os::unix::fs::symlink(root.path().join("missing"), &node).unwrap();
        assert!(std::fs::symlink_metadata(&node).is_ok());
        assert!(!node.exists());
    }

    #[test]
    fn parses_unit_environment_path_and_detects_missing_tool() {
        let home = PathBuf::from("/home/test");
        let path = unit_environment_path(
            "ExecStart=x\nEnvironment=PATH=%h/.local/bin:/usr/bin\n",
            &home,
        )
        .unwrap();
        assert_eq!(path, "/home/test/.local/bin:/usr/bin");
        assert!(install::find_on_path("definitely-missing-remux-tool", &path).is_none());
    }

    #[test]
    fn parses_proc_net_tcp_listeners() {
        let line = "  46: 0100007F:BCFB 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1 0000000000000000 100 0 0 10 0";
        assert_eq!(
            parse_proc_net_tcp_line(line, 0xBCFB),
            Some("12345".to_string())
        );
        assert_eq!(parse_proc_net_tcp_line(line, 1234), None);
    }

    #[test]
    fn parses_ppid_from_proc_stat() {
        let stat = "123 (remux start) S 456 123 123 0 -1 0 0 0 0 0 1 2 0 0 20 0 1 0 99 0 0";
        assert_eq!(parse_proc_stat_ppid(stat), Some(456));
    }

    #[test]
    fn command_line_classifier_finds_remux_start() {
        assert!(looks_like_remux_start(&[
            "/home/me/.local/bin/remux".to_string(),
            "start".to_string(),
            "--foreground".to_string(),
        ]));
        assert!(!looks_like_remux_start(&[
            "remux".to_string(),
            "doctor".to_string(),
        ]));
    }

    #[test]
    fn unit_tree_pid_allows_main_and_direct_worker_only() {
        let ppid = |pid| match pid {
            8 => Some(7),
            9 => Some(8),
            _ => None,
        };
        assert!(is_unit_tree_pid_with(7, 7, ppid));
        assert!(is_unit_tree_pid_with(8, 7, ppid));
        assert!(!is_unit_tree_pid_with(9, 7, ppid));
    }
}
