//! systemd/user-service helpers for pass 3b.
//!
//! Shell-outs always preserve stderr in the surfaced error and never panic.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

pub const SERVICE_NAME: &str = "remux";
pub const UNIT_NAME: &str = "remux.service";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SystemdInfo {
    pub unit_path: PathBuf,
    pub installed: bool,
    pub enabled: Option<bool>,
    pub active: Option<bool>,
    pub linger: Option<bool>,
    pub main_pid: Option<u32>,
    pub notes: Vec<String>,
}

impl SystemdInfo {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert(
            "unitPath".to_string(),
            Value::from(self.unit_path.to_string_lossy().into_owned()),
        );
        object.insert("installed".to_string(), Value::from(self.installed));
        object.insert(
            "enabled".to_string(),
            self.enabled.map(Value::from).unwrap_or(Value::Null),
        );
        object.insert(
            "active".to_string(),
            self.active.map(Value::from).unwrap_or(Value::Null),
        );
        object.insert(
            "linger".to_string(),
            self.linger.map(Value::from).unwrap_or(Value::Null),
        );
        object.insert(
            "mainPid".to_string(),
            self.main_pid.map(Value::from).unwrap_or(Value::Null),
        );
        object.insert(
            "notes".to_string(),
            Value::Array(self.notes.iter().cloned().map(Value::from).collect()),
        );
        Value::Object(object)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandFailure {
    pub program: String,
    pub args: Vec<String>,
    pub status: Option<i32>,
    pub stderr: String,
}

impl CommandFailure {
    pub fn message(&self) -> String {
        let command = std::iter::once(self.program.as_str())
            .chain(self.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        let status = self
            .status
            .map(|code| format!("exit {code}"))
            .unwrap_or_else(|| "terminated by signal".to_string());
        let stderr = if self.stderr.trim().is_empty() {
            "<no stderr>".to_string()
        } else {
            self.stderr.trim().to_string()
        };
        format!("{command} failed ({status}): {stderr}")
    }
}

pub fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}

pub fn local_bin_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".local/bin"))
}

pub fn unit_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".config/systemd/user").join(UNIT_NAME))
}

pub fn unit_path_for(name: &str) -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".config/systemd/user").join(name))
}

pub fn unit_installed() -> Result<bool, String> {
    Ok(unit_path()?.exists())
}

pub fn collect_info() -> Result<SystemdInfo, String> {
    let unit_path = unit_path()?;
    let installed = unit_path.exists();
    let mut info = SystemdInfo {
        unit_path,
        installed,
        ..SystemdInfo::default()
    };
    if !installed {
        info.notes.push(
            "unit not installed; run remux install for background service management".to_string(),
        );
        return Ok(info);
    }

    info.enabled = match run_output("systemctl", &["--user", "is-enabled", SERVICE_NAME]) {
        Ok(output) => Some(output.trim() == "enabled"),
        Err(error) => {
            info.notes.push(error.message());
            None
        }
    };
    info.active = match run_output("systemctl", &["--user", "is-active", SERVICE_NAME]) {
        Ok(output) => Some(output.trim() == "active"),
        Err(error) => {
            info.notes.push(error.message());
            None
        }
    };
    info.main_pid = match run_output(
        "systemctl",
        &["--user", "show", SERVICE_NAME, "-p", "MainPID", "--value"],
    ) {
        Ok(output) => output.trim().parse::<u32>().ok().filter(|pid| *pid > 0),
        Err(error) => {
            info.notes.push(error.message());
            None
        }
    };
    info.linger = match current_user()
        .ok_or_else(|| "USER is not set".to_string())
        .and_then(|user| {
            run_output("loginctl", &["show-user", &user, "-p", "Linger"])
                .map_err(|error| error.message())
        }) {
        Ok(output) => Some(output.trim() == "Linger=yes"),
        Err(message) => {
            info.notes.push(message);
            None
        }
    };

    Ok(info)
}

pub fn start(_root: &Path) -> Result<i32, String> {
    let already_active = collect_info()
        .ok()
        .and_then(|info| info.active)
        .unwrap_or(false);
    run_inherited("systemctl", &["--user", "start", SERVICE_NAME])?;
    if already_active {
        println!("already running");
    } else {
        println!("started");
    }
    Ok(0)
}

pub fn stop(_root: &Path) -> Result<i32, String> {
    if !unit_installed()? {
        return Err(
            "systemd user unit is not installed; stop a foreground runtime with Ctrl-C".to_string(),
        );
    }
    run_inherited("systemctl", &["--user", "stop", SERVICE_NAME])?;
    println!("stopped");
    Ok(0)
}

pub fn restart(_root: &Path) -> Result<i32, String> {
    if !unit_installed()? {
        return Err(
            "systemd user unit is not installed; a foreground runtime is stopped with Ctrl-C"
                .to_string(),
        );
    }
    run_inherited("systemctl", &["--user", "restart", SERVICE_NAME])?;
    println!("restarted");
    Ok(0)
}

pub fn run_inherited(program: &str, args: &[&str]) -> Result<(), String> {
    match std::process::Command::new(program).args(args).output() {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => Err(CommandFailure {
            program: program.to_string(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            status: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
        .message()),
        Err(error) => Err(format!(
            "{} failed to start: {error}",
            std::iter::once(program)
                .chain(args.iter().copied())
                .collect::<Vec<_>>()
                .join(" ")
        )),
    }
}

pub fn run_output(program: &str, args: &[&str]) -> Result<String, CommandFailure> {
    match std::process::Command::new(program).args(args).output() {
        Ok(output) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(output) => Err(CommandFailure {
            program: program.to_string(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            status: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }),
        Err(error) => Err(CommandFailure {
            program: program.to_string(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            status: None,
            stderr: error.to_string(),
        }),
    }
}

pub fn current_user() -> Option<String> {
    std::env::var("USER")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn main_pid_exe_deleted(pid: u32) -> bool {
    let Ok(target) = std::fs::read_link(format!("/proc/{pid}/exe")) else {
        return false;
    };
    exe_link_deleted_text(&target.to_string_lossy())
}

pub fn exe_link_deleted_text(value: &str) -> bool {
    value.ends_with(" (deleted)")
}

pub fn installed_unit_source() -> Result<Option<String>, String> {
    let path = unit_path()?;
    match std::fs::read_to_string(&path) {
        Ok(source) => Ok(Some(source)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

pub fn embedded_unit() -> &'static str {
    include_str!("../../../../deploy/systemd/remux.service")
}

pub fn embedded_static_units() -> [(&'static str, &'static str); 4] {
    [
        (UNIT_NAME, embedded_unit()),
        (
            "remux.slice",
            include_str!("../../../../deploy/systemd/remux.slice"),
        ),
        (
            "remux-core.slice",
            include_str!("../../../../deploy/systemd/remux-core.slice"),
        ),
        (
            "remux-extensions.slice",
            include_str!("../../../../deploy/systemd/remux-extensions.slice"),
        ),
    ]
}

pub fn unit_matches_embedded(source: &str) -> bool {
    source == embedded_unit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_deleted_proc_exe_text() {
        assert!(exe_link_deleted_text("/tmp/remux (deleted)"));
        assert!(!exe_link_deleted_text("/tmp/remux"));
    }

    #[test]
    fn command_failure_includes_stderr() {
        let failure = CommandFailure {
            program: "systemctl".to_string(),
            args: vec![
                "--user".to_string(),
                "start".to_string(),
                "remux".to_string(),
            ],
            status: Some(1),
            stderr: "no bus".to_string(),
        };
        let message = failure.message();
        assert!(
            message.contains("systemctl --user start remux"),
            "{message}"
        );
        assert!(message.contains("no bus"), "{message}");
    }

    #[test]
    fn compares_unit_drift_byte_for_byte() {
        assert!(unit_matches_embedded(embedded_unit()));
        assert!(!unit_matches_embedded(
            &embedded_unit().replace("Restart=always", "Restart=no")
        ));
    }
}
