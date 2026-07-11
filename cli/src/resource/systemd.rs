use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use sha1::{Digest, Sha1};
use tokio::process::Command;

use super::topology::{CpuTopology, ResourceCapabilities};

static NEXT_SCOPE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceClass {
    Server,
    Interactive,
    Persistent,
    Background,
    Build,
    Watch,
    Research,
}

impl ResourceClass {
    fn weight(self) -> u16 {
        match self {
            Self::Server | Self::Interactive => 100,
            Self::Persistent => 80,
            Self::Background | Self::Build => 20,
            Self::Watch => 10,
            Self::Research => 5,
        }
    }

    fn nice(self) -> i8 {
        match self {
            Self::Background | Self::Build | Self::Watch => 10,
            Self::Research => 15,
            _ => 0,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Server => "server",
            Self::Interactive => "interactive",
            Self::Persistent => "persistent",
            Self::Background => "background",
            Self::Build => "build",
            Self::Watch => "watch",
            Self::Research => "research",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResourcePlacement {
    extension_id: String,
    extension_root: String,
    slice: String,
    enabled: bool,
    requested: bool,
    capabilities: ResourceCapabilities,
    topology: CpuTopology,
}

impl ResourcePlacement {
    pub fn for_extension(extension_id: &str, extension_root: &Path) -> Self {
        let requested = std::env::var("REMUX_RESOURCE_GOVERNANCE").as_deref() == Ok("1");
        let manager_available = systemd_user_manager_available();
        let enabled = requested && manager_available;
        let topology = CpuTopology::detect();
        let mut capabilities = ResourceCapabilities::detect(manager_available);
        if !requested {
            capabilities.protected_mode = false;
            capabilities
                .reasons
                .push("resource governance was not requested for this runtime".to_string());
        }
        let extension_root = extension_root
            .canonicalize()
            .unwrap_or_else(|_| extension_root.to_path_buf())
            .to_string_lossy()
            .into_owned();
        let slice = extension_slice_name(extension_id, &extension_root);
        let mut placement = Self {
            extension_id: extension_id.to_string(),
            extension_root,
            slice,
            enabled,
            requested,
            capabilities,
            topology,
        };
        if enabled {
            if let Err(error) = placement.ensure_parent() {
                placement.enabled = false;
                placement.capabilities.protected_mode = false;
                placement
                    .capabilities
                    .reasons
                    .push(format!("resource slice activation failed: {error}"));
            }
        }
        placement
    }

    pub fn capabilities(&self) -> &ResourceCapabilities {
        &self.capabilities
    }

    pub fn configure_command(
        &self,
        program: &str,
        args: &[String],
        cwd: &Path,
        class: ResourceClass,
    ) -> Command {
        let mut command = if self.enabled {
            let scope = format!(
                "remux-ext-{}-{}-{}",
                sanitize(&self.extension_id),
                class.label(),
                NEXT_SCOPE_ID.fetch_add(1, Ordering::Relaxed),
            );
            let mut command = Command::new("systemd-run");
            command.args([
                "--user",
                "--scope",
                "--quiet",
                "--collect",
                &format!("--unit={scope}"),
                &format!("--slice={}", self.slice),
                &format!("--property=CPUWeight={}", class.weight()),
                &format!("--property=Nice={}", class.nice()),
                "--",
                program,
            ]);
            command.args(args);
            command
        } else if self.requested && !self.topology.allowed_extension_cpus.is_empty() {
            let mut command = Command::new("taskset");
            command.args([
                "-c",
                &self.topology.allowed_extension_cpus,
                "nice",
                "-n",
                &class.nice().to_string(),
                program,
            ]);
            command.args(args);
            command
        } else {
            let mut command = Command::new(program);
            command.args(args);
            command
        };
        command
            .current_dir(cwd)
            .env("REMUX_EXTENSION_ID", &self.extension_id)
            .env("REMUX_EXTENSION_ROOT", &self.extension_root)
            .env(
                "REMUX_RESOURCE_PROTECTED",
                if self.capabilities.protected_mode {
                    "1"
                } else {
                    "0"
                },
            );
        if let Ok(executable) = std::env::current_exe() {
            command.env("REMUX_WORKLOAD_EXEC", executable);
        }
        command
    }

    fn ensure_parent(&self) -> Result<(), String> {
        systemctl_ok(&["start", "remux-extensions.slice"])?;
        systemctl_ok(&["start", &self.slice])?;
        systemctl_ok(&[
            "set-property",
            "--runtime",
            &self.slice,
            "CPUWeight=100",
            "CPUAccounting=yes",
            "MemoryAccounting=yes",
            "TasksAccounting=yes",
        ])?;
        if !self.topology.allowed_extension_cpus.is_empty() {
            systemctl_ok(&[
                "set-property",
                "--runtime",
                "remux-extensions.slice",
                &format!("AllowedCPUs={}", self.topology.allowed_extension_cpus),
            ])?;
        }
        Ok(())
    }
}

pub fn extension_slice_name(extension_id: &str, canonical_root: &str) -> String {
    let mut digest = Sha1::new();
    digest.update(canonical_root.as_bytes());
    let hash = format!("{:x}", digest.finalize());
    format!(
        "remux-extensions-{}-{}.slice",
        sanitize(extension_id),
        &hash[..8]
    )
}

fn sanitize(value: &str) -> String {
    let escaped = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    escaped.trim_matches('-').to_string()
}

pub fn systemd_user_manager_available() -> bool {
    std::process::Command::new("systemctl")
        .args(["--user", "show-environment"])
        .output()
        .is_ok_and(|output| output.status.success())
}

pub fn protected_mode_active() -> bool {
    let capabilities = ResourceCapabilities::detect(systemd_user_manager_available());
    if !capabilities.protected_mode {
        return false;
    }
    if !systemctl_ok(&["is-active", "--quiet", "remux.service"]).is_ok()
        || !systemctl_ok(&["is-active", "--quiet", "remux-extensions.slice"]).is_ok()
    {
        return false;
    }
    std::process::Command::new("systemctl")
        .args([
            "--user",
            "show",
            "remux-extensions.slice",
            "--property=AllowedCPUs",
            "--value",
        ])
        .output()
        .is_ok_and(|output| {
            output.status.success() && !String::from_utf8_lossy(&output.stdout).trim().is_empty()
        })
}

pub fn effective_capabilities() -> ResourceCapabilities {
    let mut capabilities = ResourceCapabilities::detect(systemd_user_manager_available());
    if capabilities.protected_mode && !protected_mode_active() {
        capabilities.protected_mode = false;
        capabilities
            .reasons
            .push("resource slices are not active with an AllowedCPUs reservation".to_string());
    }
    capabilities
}

fn systemctl_ok(args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .map_err(|error| format!("systemctl failed to start: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            format!("systemctl {} failed", args.join(" "))
        } else {
            detail
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_slice_is_readable_stable_and_root_specific() {
        let first = extension_slice_name("Ledger Dev", "/tmp/ledger");
        assert!(first.starts_with("remux-extensions-ledger-dev-"));
        assert_eq!(first, extension_slice_name("Ledger Dev", "/tmp/ledger"));
        assert_ne!(first, extension_slice_name("Ledger Dev", "/tmp/ledger-two"));
    }
}
