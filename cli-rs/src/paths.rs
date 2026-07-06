//! Node-`path`-compatible lexical path helpers.
//!
//! Manifest paths, extension roots, and viewer entries were resolved with
//! Node's `path.join`/`path.resolve` (lexical normalization, no filesystem
//! access). Rust's `Path::join` does not normalize `.`/`..`, so these helpers
//! reproduce the Node behavior for the paths that end up in catalog output,
//! process cwds, and traversal guards.

use std::path::{Path, PathBuf};

/// Lexically normalize a `/`-separated path like Node `path.normalize`:
/// collapses `//`, resolves `.` and `..` segments, drops any trailing slash
/// (except for the root), and returns `.` for an empty relative result.
pub fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();

    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => match stack.last() {
                Some(&last) if last != ".." => {
                    stack.pop();
                }
                _ if absolute => {}
                _ => stack.push(".."),
            },
            other => stack.push(other),
        }
    }

    let joined = stack.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

/// Node `path.join(left, right)` for two segments.
pub fn join(left: &str, right: &str) -> String {
    if right.is_empty() {
        return normalize(left);
    }
    if left.is_empty() {
        return normalize(right);
    }
    normalize(&format!("{left}/{right}"))
}

/// Node-style manifest path resolution: absolute values pass through,
/// relative values join against the manifest directory
/// (`cli/extensionManifest.cjs` `resolveManifestPath`).
pub fn resolve_manifest_path(root_dir: &Path, value: &str) -> PathBuf {
    if value.starts_with('/') {
        return PathBuf::from(value);
    }
    PathBuf::from(join(&root_dir.to_string_lossy(), value))
}
