//! Extension discovery over configured roots, ported from
//! `cli/extensionRegistry.cjs`.

use std::path::{Path, PathBuf};

use crate::config::{resolve_extension_roots, RemuxConfig};
use crate::extensions::manifest::{load_extension_manifest, ExtensionManifest, MANIFEST_FILENAME};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidExtension {
    pub id: Option<String>,
    pub manifest_path: PathBuf,
    pub error: String,
}

#[derive(Debug, Default)]
pub struct ExtensionDiscovery {
    pub valid: Vec<ExtensionManifest>,
    pub invalid: Vec<InvalidExtension>,
}

/// Root resolution precedence (`extensionRegistry.cjs:38-50`):
/// `REMUX_EXTENSION_ROOTS` (`:`-separated, taken verbatim) overrides config
/// roots entirely; config roots resolve against `root_dir`; default is
/// `<root_dir>/extensions`.
pub fn extension_roots(
    env_roots: Option<&str>,
    config: &RemuxConfig,
    root_dir: &Path,
) -> Vec<PathBuf> {
    if let Some(raw) = env_roots {
        if !raw.trim().is_empty() {
            return raw
                .split(':')
                .filter(|candidate| !candidate.is_empty())
                .map(PathBuf::from)
                .collect();
        }
    }

    if let Some(roots) = &config.extension_roots {
        if !roots.is_empty() {
            return resolve_extension_roots(roots, root_dir);
        }
    }

    vec![root_dir.join("extensions")]
}

/// Load every `remux-extension.json` found one directory deep under each root.
/// Invalid manifests are quarantined in the report rather than aborting core
/// startup: extension isolation begins at discovery, before an extension actor
/// or process exists.
pub fn discover_extensions(roots: &[PathBuf]) -> ExtensionDiscovery {
    let mut discovery = ExtensionDiscovery::default();

    for extensions_dir in roots {
        let entries = match std::fs::read_dir(extensions_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let is_dir = entry
                .file_type()
                .map(|file_type| file_type.is_dir())
                .unwrap_or(false);
            if !is_dir {
                continue;
            }

            let manifest_path = entry.path().join(MANIFEST_FILENAME);
            if !manifest_path.exists() {
                continue;
            }

            match load_extension_manifest(&manifest_path) {
                Ok(extension) => discovery.valid.push(extension),
                Err(error) => discovery.invalid.push(InvalidExtension {
                    id: manifest_id(&manifest_path),
                    manifest_path,
                    error,
                }),
            }
        }
    }

    discovery
        .valid
        .sort_by(|left, right| left.id.cmp(&right.id));
    discovery.invalid.sort_by(|left, right| {
        left.id
            .as_deref()
            .cmp(&right.id.as_deref())
            .then_with(|| left.manifest_path.cmp(&right.manifest_path))
    });
    discovery
}

fn manifest_id(manifest_path: &Path) -> Option<String> {
    let source = std::fs::read_to_string(manifest_path).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&source).ok()?;
    manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_manifest(extension_dir: &Path, id: &str) {
        std::fs::create_dir_all(extension_dir).unwrap();
        let manifest = json!({
            "version": 1,
            "id": id,
            "views": { "main": { "entry": "viewer/dist/index.html" } }
        });
        std::fs::write(extension_dir.join(MANIFEST_FILENAME), manifest.to_string()).unwrap();
    }

    #[test]
    fn discovers_manifests_and_ignores_folders_without_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("extensions/notes")).unwrap();
        write_manifest(&dir.path().join("extensions/codex"), "codex");

        let roots = extension_roots(None, &RemuxConfig::default(), dir.path());
        assert_eq!(roots, vec![dir.path().join("extensions")]);

        let discovery = discover_extensions(&roots);
        assert_eq!(
            discovery
                .valid
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["codex"]
        );
        assert!(discovery.invalid.is_empty());
    }

    #[test]
    fn env_roots_override_config_roots() {
        let dir = tempfile::tempdir().unwrap();
        let env_root = dir.path().join("env");
        let config_root = dir.path().join("config");
        write_manifest(&env_root.join("env-extension"), "env-extension");
        write_manifest(&config_root.join("config-extension"), "config-extension");

        let config = RemuxConfig {
            extension_roots: Some(vec![config_root.to_string_lossy().into_owned()]),
            ..Default::default()
        };

        let env_value = env_root.to_string_lossy().into_owned();
        let roots = extension_roots(Some(&env_value), &config, dir.path());
        assert_eq!(roots, vec![env_root.clone()]);

        let discovery = discover_extensions(&roots);
        assert_eq!(
            discovery
                .valid
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["env-extension"]
        );
    }

    #[test]
    fn config_roots_resolve_relative_to_root_dir_and_sort_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("one");
        let second = dir.path().join("two");
        write_manifest(&first.join("beta"), "beta");
        write_manifest(&second.join("alpha"), "alpha");

        let config = RemuxConfig {
            extension_roots: Some(vec![
                "one".to_string(),
                second.to_string_lossy().into_owned(),
            ]),
            ..Default::default()
        };

        let roots = extension_roots(None, &config, dir.path());
        assert_eq!(roots, vec![first, second]);

        let discovery = discover_extensions(&roots);
        assert_eq!(
            discovery
                .valid
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );
    }

    #[test]
    fn multi_value_env_roots_split_on_path_delimiter() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("one");
        let second = dir.path().join("two");
        write_manifest(&first.join("beta"), "beta");
        write_manifest(&second.join("alpha"), "alpha");

        let env_value = format!("{}:{}", first.display(), second.display());
        let roots = extension_roots(Some(&env_value), &RemuxConfig::default(), dir.path());
        assert_eq!(roots, vec![first, second]);

        let discovery = discover_extensions(&roots);
        assert_eq!(
            discovery
                .valid
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );
    }

    #[test]
    fn quarantines_invalid_manifest_without_hiding_valid_extensions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("extensions");
        write_manifest(&root.join("codex"), "codex");
        std::fs::create_dir_all(root.join("narrate")).unwrap();
        std::fs::write(
            root.join("narrate").join(MANIFEST_FILENAME),
            json!({
                "version": 1,
                "id": "narrate",
                "resources": { "workloads": {} },
                "views": { "main": { "entry": "viewer/dist/index.html" } }
            })
            .to_string(),
        )
        .unwrap();

        let discovery = discover_extensions(&[root]);
        assert_eq!(
            discovery
                .valid
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["codex"]
        );
        assert_eq!(discovery.invalid.len(), 1);
        assert_eq!(discovery.invalid[0].id.as_deref(), Some("narrate"));
        assert!(discovery.invalid[0]
            .error
            .contains("resources requires version 2"));
    }
}
