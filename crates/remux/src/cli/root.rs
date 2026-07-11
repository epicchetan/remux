//! Root discovery for pass 3b (`docs/specs/cli-rust-port-pass-3b-cli.md`).
//!
//! No subcommand silently adopts cwd. Explicit `--root` and supervisor-passed
//! `REMUX_ROOT` are trusted bootstrap roots; implicit discovery requires an
//! existing `.remux/` marker.

use std::path::{Path, PathBuf};

pub const REMUX_ROOT_ENV: &str = "REMUX_ROOT";
const MARKER: &str = ".remux";

#[derive(Debug, Clone)]
pub struct RootSearch {
    cwd: PathBuf,
    env_root: Option<PathBuf>,
    home: Option<PathBuf>,
}

impl RootSearch {
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            cwd: std::env::current_dir().map_err(|error| format!("cannot resolve cwd: {error}"))?,
            env_root: std::env::var(REMUX_ROOT_ENV)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            home: std::env::var_os("HOME").map(PathBuf::from),
        })
    }
}

pub fn discover(flag_root: Option<&Path>) -> Result<PathBuf, String> {
    discover_with(flag_root, &RootSearch::from_env()?)
}

pub fn discover_from_worker_env() -> Result<PathBuf, String> {
    let search = RootSearch::from_env()?;
    if let Some(root) = search.env_root.as_deref() {
        return Ok(crate::paths::resolve(root));
    }
    discover_with(None, &search)
}

pub fn discover_with(flag_root: Option<&Path>, search: &RootSearch) -> Result<PathBuf, String> {
    if let Some(root) = flag_root {
        return Ok(crate::paths::resolve(root));
    }

    if let Some(root) = search.env_root.as_deref() {
        return Ok(crate::paths::resolve(root));
    }

    let mut cursor = crate::paths::resolve(&search.cwd);
    loop {
        if cursor.join(MARKER).is_dir() {
            return Ok(cursor);
        }
        if !cursor.pop() {
            break;
        }
    }

    if let Some(home) = &search.home {
        let candidate = crate::paths::resolve(&home.join("remux"));
        if candidate.join(MARKER).is_dir() {
            return Ok(candidate);
        }
    }

    Err(discovery_error(&search.cwd, search.home.as_deref()))
}

fn discovery_error(cwd: &Path, home: Option<&Path>) -> String {
    let mut searched = vec![format!("walked up from {}", cwd.display())];
    if let Some(home) = home {
        searched.push(format!("{}", home.join("remux").display()));
    }
    format!(
        "could not find remux root (searched: {}); pass --root <dir>",
        searched.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn search(cwd: &Path, env_root: Option<&Path>, home: Option<&Path>) -> RootSearch {
        RootSearch {
            cwd: cwd.to_path_buf(),
            env_root: env_root.map(PathBuf::from),
            home: home.map(PathBuf::from),
        }
    }

    #[test]
    fn flag_wins_over_env_and_does_not_require_marker() {
        let dir = tempfile::tempdir().unwrap();
        let flag = dir.path().join("fresh");
        let env = dir.path().join("env");
        std::fs::create_dir_all(env.join(".remux")).unwrap();

        let root = discover_with(Some(&flag), &search(dir.path(), Some(&env), None)).unwrap();
        assert_eq!(root, crate::paths::resolve(&flag));
    }

    #[test]
    fn env_wins_over_walkup_and_home() {
        let dir = tempfile::tempdir().unwrap();
        let env = dir.path().join("env");
        let nested = dir.path().join("repo/a/b");
        let home = dir.path().join("home");
        std::fs::create_dir_all(env.join(".remux")).unwrap();
        std::fs::create_dir_all(nested.join(".remux")).unwrap();
        std::fs::create_dir_all(home.join("remux/.remux")).unwrap();

        let root = discover_with(None, &search(&nested, Some(&env), Some(&home))).unwrap();
        assert_eq!(root, crate::paths::resolve(&env));
    }

    #[test]
    fn walkup_stops_at_first_marker() {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path().join("repo");
        let inner = outer.join("nested");
        let cwd = inner.join("a/b");
        std::fs::create_dir_all(outer.join(".remux")).unwrap();
        std::fs::create_dir_all(inner.join(".remux")).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();

        let root = discover_with(None, &search(&cwd, None, None)).unwrap();
        assert_eq!(root, crate::paths::resolve(&inner));
    }

    #[test]
    fn home_remux_is_fallback_only_when_marked() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("other");
        let home = dir.path().join("home");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(home.join("remux/.remux")).unwrap();

        let root = discover_with(None, &search(&cwd, None, Some(&home))).unwrap();
        assert_eq!(root, crate::paths::resolve(&home.join("remux")));

        std::fs::remove_dir_all(home.join("remux/.remux")).unwrap();
        let err = discover_with(None, &search(&cwd, None, Some(&home))).unwrap_err();
        assert!(err.contains("pass --root"), "{err}");
        assert!(err.contains(&cwd.display().to_string()), "{err}");
    }
}
