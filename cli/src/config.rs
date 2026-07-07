//! `.remux/config.toml` loading, replacing `cli/config.cjs`.
//!
//! Behavior change vs the Node CLI (spec §Behavior changes #6): full TOML
//! syntax is accepted; unknown keys are still rejected via
//! `deny_unknown_fields`. `extensionRoots` stays accepted as an alias for
//! `extension_roots`. `log_retention_days` is new in pass 1.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::paths;

pub const CONFIG_RELATIVE_PATH: &str = ".remux/config.toml";
pub const DEFAULT_HOST: &str = "0.0.0.0";
pub const DEFAULT_PORT: u16 = 48123;
pub const DEFAULT_LOG_RETENTION_DAYS: u32 = 14;
pub const DEFAULT_RESOURCE_POLL_SECONDS: u32 = 5;
pub const DEFAULT_WATCHDOG_STALE_SECONDS: u32 = 30;

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemuxConfig {
    pub host: Option<String>,
    pub port: Option<i64>,
    #[serde(alias = "extensionRoots")]
    pub extension_roots: Option<Vec<String>>,
    pub log_retention_days: Option<u32>,
    /// Pass-2 additive: resource sampler cadence.
    pub resource_poll_seconds: Option<u32>,
    /// Pass-2 additive: worker hang watchdog staleness; 0 disables.
    pub watchdog_stale_seconds: Option<u32>,
    /// Pass-2 additive: per-extension RSS alert ceiling; absent/0 disables.
    pub extension_memory_ceiling_mb: Option<u32>,
}

impl RemuxConfig {
    pub fn log_retention_days(&self) -> u32 {
        self.log_retention_days.unwrap_or(DEFAULT_LOG_RETENTION_DAYS)
    }

    pub fn resource_poll_seconds(&self) -> u32 {
        self.resource_poll_seconds
            .filter(|seconds| *seconds > 0)
            .unwrap_or(DEFAULT_RESOURCE_POLL_SECONDS)
    }

    pub fn watchdog_stale_seconds(&self) -> u32 {
        self.watchdog_stale_seconds
            .unwrap_or(DEFAULT_WATCHDOG_STALE_SECONDS)
    }

    pub fn extension_memory_ceiling_mb(&self) -> u32 {
        self.extension_memory_ceiling_mb.unwrap_or(0)
    }
}

pub fn load_remux_config(root_dir: &Path) -> Result<RemuxConfig, String> {
    let config_path = root_dir.join(CONFIG_RELATIVE_PATH);
    let source = match std::fs::read_to_string(&config_path) {
        Ok(source) => source,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RemuxConfig::default())
        }
        Err(err) => return Err(format!("{}: {err}", config_path.display())),
    };
    parse_remux_config_toml(&source, &config_path.to_string_lossy())
}

pub fn parse_remux_config_toml(source: &str, config_path: &str) -> Result<RemuxConfig, String> {
    let config: RemuxConfig =
        toml::from_str(source).map_err(|err| format!("{config_path}: {err}"))?;
    validate_config(&config, config_path)?;
    Ok(config)
}

fn validate_config(config: &RemuxConfig, config_path: &str) -> Result<(), String> {
    if let Some(roots) = &config.extension_roots {
        if roots.iter().any(|root| root.trim().is_empty()) {
            return Err(format!(
                "{config_path}: extension_roots must be an array of non-empty strings"
            ));
        }
    }
    Ok(())
}

pub fn resolve_extension_roots(roots: &[String], root_dir: &Path) -> Vec<PathBuf> {
    roots
        .iter()
        .map(|candidate| paths::resolve_manifest_path(root_dir, candidate))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeValues {
    pub host: String,
    pub port: u16,
}

/// Port of `loadRuntimeValues` (`cli/start.cjs:131-136`): `REMUX_HOST` (JS
/// truthiness — empty string falls through) over config over `0.0.0.0`;
/// `REMUX_PORT` (`??` — set-but-empty still wins and then fails validation)
/// over config `port` over 48123, with the error named after whichever source
/// supplied the value.
pub fn load_runtime_values(
    env_host: Option<&str>,
    env_port: Option<&str>,
    config: &RemuxConfig,
) -> Result<RuntimeValues, String> {
    let host = match env_host {
        Some(host) if !host.is_empty() => host.to_string(),
        _ => match &config.host {
            Some(host) if !host.is_empty() => host.clone(),
            _ => DEFAULT_HOST.to_string(),
        },
    };

    let port = match (env_port, config.port) {
        (Some(raw), _) => parse_port_str(raw, "REMUX_PORT")?,
        (None, Some(value)) => parse_port_number(value, "port")?,
        (None, None) => DEFAULT_PORT,
    };

    Ok(RuntimeValues { host, port })
}

fn parse_port_str(value: &str, name: &str) -> Result<u16, String> {
    let invalid = || format!("Invalid {name} value: {value}");
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(invalid());
    }
    let parsed: i64 = trimmed.parse().map_err(|_| invalid())?;
    port_in_range(parsed).ok_or_else(invalid)
}

fn parse_port_number(value: i64, name: &str) -> Result<u16, String> {
    port_in_range(value).ok_or_else(|| format!("Invalid {name} value: {value}"))
}

fn port_in_range(value: i64) -> Option<u16> {
    if (1..=65535).contains(&value) {
        Some(value as u16)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_runtime_values_and_extension_roots() {
        let config = parse_remux_config_toml(
            "\nhost = \"127.0.0.1\"\nport = 5999\nextension_roots = [\"extensions\", \"/home/ubuntu\"]\n",
            CONFIG_RELATIVE_PATH,
        )
        .unwrap();
        assert_eq!(
            config,
            RemuxConfig {
                host: Some("127.0.0.1".to_string()),
                port: Some(5999),
                extension_roots: Some(vec![
                    "extensions".to_string(),
                    "/home/ubuntu".to_string()
                ]),
                ..Default::default()
            }
        );
    }

    #[test]
    fn accepts_camel_case_extension_roots() {
        let config =
            parse_remux_config_toml("extensionRoots = [\"extensions\"]", CONFIG_RELATIVE_PATH)
                .unwrap();
        assert_eq!(
            config.extension_roots,
            Some(vec!["extensions".to_string()])
        );
    }

    #[test]
    fn rejects_unknown_keys_and_unknown_sections() {
        let err = parse_remux_config_toml("extensions = []", CONFIG_RELATIVE_PATH).unwrap_err();
        assert!(err.contains("unknown field `extensions`"), "{err}");

        let err =
            parse_remux_config_toml("[runtime]\nport = 1", CONFIG_RELATIVE_PATH).unwrap_err();
        assert!(err.contains("unknown field `runtime`"), "{err}");
    }

    #[test]
    fn rejects_empty_extension_roots_entries() {
        let err = parse_remux_config_toml("extension_roots = [\"\"]", CONFIG_RELATIVE_PATH)
            .unwrap_err();
        assert!(
            err.contains("extension_roots must be an array of non-empty strings"),
            "{err}"
        );
    }

    #[test]
    fn accepts_full_toml_syntax() {
        let config = parse_remux_config_toml(
            "# comment\nhost = \"a\" # trailing\nlog_retention_days = 3",
            CONFIG_RELATIVE_PATH,
        )
        .unwrap();
        assert_eq!(config.host.as_deref(), Some("a"));
        assert_eq!(config.log_retention_days(), 3);
        assert_eq!(RemuxConfig::default().log_retention_days(), 14);
    }

    #[test]
    fn pass2_keys_parse_with_defaults() {
        let config = parse_remux_config_toml(
            "resource_poll_seconds = 2\nwatchdog_stale_seconds = 0\nextension_memory_ceiling_mb = 512",
            CONFIG_RELATIVE_PATH,
        )
        .unwrap();
        assert_eq!(config.resource_poll_seconds(), 2);
        assert_eq!(config.watchdog_stale_seconds(), 0, "0 disables the watchdog");
        assert_eq!(config.extension_memory_ceiling_mb(), 512);

        let defaults = RemuxConfig::default();
        assert_eq!(defaults.resource_poll_seconds(), 5);
        assert_eq!(defaults.watchdog_stale_seconds(), 30);
        assert_eq!(defaults.extension_memory_ceiling_mb(), 0);

        // 0 poll cadence falls back to the default rather than spinning.
        let zero_poll =
            parse_remux_config_toml("resource_poll_seconds = 0", CONFIG_RELATIVE_PATH).unwrap();
        assert_eq!(zero_poll.resource_poll_seconds(), 5);
    }

    #[test]
    fn loads_config_from_remux_dir_when_present() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".remux")).unwrap();
        std::fs::write(root.path().join(".remux/config.toml"), "port = 48124\n").unwrap();

        let config = load_remux_config(root.path()).unwrap();
        assert_eq!(config.port, Some(48124));

        let missing = load_remux_config(&root.path().join("nope")).unwrap();
        assert_eq!(missing, RemuxConfig::default());
    }

    #[test]
    fn resolves_relative_roots_from_runtime_root() {
        let roots = resolve_extension_roots(
            &["extensions".to_string(), "/tmp/ext".to_string()],
            Path::new("/repo/remux"),
        );
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/repo/remux/extensions"),
                PathBuf::from("/tmp/ext")
            ]
        );
    }

    #[test]
    fn runtime_values_precedence_matches_start_cjs() {
        let config = RemuxConfig {
            host: Some("10.0.0.1".to_string()),
            port: Some(5000),
            ..Default::default()
        };

        let values = load_runtime_values(Some("127.0.0.1"), Some("6000"), &config).unwrap();
        assert_eq!(values.host, "127.0.0.1");
        assert_eq!(values.port, 6000);

        let values = load_runtime_values(None, None, &config).unwrap();
        assert_eq!(values.host, "10.0.0.1");
        assert_eq!(values.port, 5000);

        let values = load_runtime_values(Some(""), None, &RemuxConfig::default()).unwrap();
        assert_eq!(values.host, "0.0.0.0");
        assert_eq!(values.port, 48123);

        // REMUX_PORT set-but-empty still wins over config and fails validation.
        let err = load_runtime_values(None, Some(""), &config).unwrap_err();
        assert_eq!(err, "Invalid REMUX_PORT value: ");

        let bad_config = RemuxConfig {
            port: Some(99999),
            ..Default::default()
        };
        let err = load_runtime_values(None, None, &bad_config).unwrap_err();
        assert_eq!(err, "Invalid port value: 99999");
    }
}
