//! Extension discovery over configured roots, ported from
//! `cli/extensionRegistry.cjs`.

use std::path::{Path, PathBuf};

use crate::config::{resolve_extension_roots, RemuxConfig};
use crate::extensions::manifest::{load_extension_manifest, ExtensionManifest, MANIFEST_FILENAME};

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

/// Load every `remux-extension.json` found one directory deep under each
/// root, sorted by extension id. A manifest that fails validation aborts
/// startup (the L1 supervisor's backoff makes this recoverable-by-edit).
pub fn discover_extensions(roots: &[PathBuf]) -> Result<Vec<ExtensionManifest>, String> {
    let mut extensions = Vec::new();

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

            extensions.push(load_extension_manifest(&manifest_path)?);
        }
    }

    extensions.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(extensions)
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
        std::fs::write(
            extension_dir.join(MANIFEST_FILENAME),
            manifest.to_string(),
        )
        .unwrap();
    }

    #[test]
    fn discovers_manifests_and_ignores_folders_without_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("extensions/notes")).unwrap();
        write_manifest(&dir.path().join("extensions/codex"), "codex");

        let roots = extension_roots(None, &RemuxConfig::default(), dir.path());
        assert_eq!(roots, vec![dir.path().join("extensions")]);

        let extensions = discover_extensions(&roots).unwrap();
        assert_eq!(
            extensions.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["codex"]
        );
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

        let extensions = discover_extensions(&roots).unwrap();
        assert_eq!(
            extensions.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
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

        let extensions = discover_extensions(&roots).unwrap();
        assert_eq!(
            extensions.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
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

        let extensions = discover_extensions(&roots).unwrap();
        assert_eq!(
            extensions.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );
    }
}
