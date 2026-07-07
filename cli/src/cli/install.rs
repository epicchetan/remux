//! `remux install` for pass 3b.
//!
//! Installation is idempotent: home-scoped symlinks point at the release
//! binary and the invoking shell's node/npm/npx, the embedded unit is written
//! to the user unit directory, linger and enable are requested, and a running
//! service is never restarted.

use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use crate::cli::systemd;

pub fn run(root: &Path) -> Result<i32, String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("cannot resolve own executable: {error}"))?;
    if current_exe.to_string_lossy().contains("/target/debug/") {
        println!(
            "warn current binary is a debug build; install still targets {}",
            release_binary(root).display()
        );
    }

    let local_bin = systemd::local_bin_dir()?;
    ensure_dir(&local_bin)?;

    refresh_symlink(&local_bin.join("remux"), &release_binary(root), "remux")?;
    for binary in ["node", "npm", "npx"] {
        match find_on_path_skipping_local_bin(binary, &local_bin) {
            Some(target) => refresh_symlink(&local_bin.join(binary), &target, binary)?,
            None => println!("skipped {binary}: not found on PATH"),
        }
    }

    let unit_changed = write_unit()?;
    if unit_changed {
        run_or_print("systemctl", &["--user", "daemon-reload"]);
    }

    match systemd::current_user() {
        Some(user) => run_or_print("loginctl", &["enable-linger", &user]),
        None => println!("skipped linger: USER is not set"),
    }
    run_or_print("systemctl", &["--user", "enable", systemd::SERVICE_NAME]);

    let info = systemd::collect_info().unwrap_or_default();
    let stale = info
        .main_pid
        .map(systemd::main_pid_exe_deleted)
        .unwrap_or(false);
    if unit_changed || stale {
        println!("run 'remux restart' to apply");
    }

    Ok(0)
}

fn release_binary(root: &Path) -> PathBuf {
    root.join("target/release/remux")
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| format!("{}: {error}", path.display()))
}

fn refresh_symlink(link: &Path, target: &Path, label: &str) -> Result<(), String> {
    let current = match std::fs::read_link(link) {
        Ok(existing) => Some(if existing.is_absolute() {
            existing
        } else {
            link.parent()
                .unwrap_or_else(|| Path::new("/"))
                .join(existing)
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) if std::fs::symlink_metadata(link).is_ok() => {
            println!(
                "skipped: {} exists and is not a symlink; refusing to replace",
                link.display()
            );
            return Ok(());
        }
        Err(error) => return Err(format!("{}: {error}", link.display())),
    };
    if current.as_deref() == Some(target) && !is_dangling(link) {
        println!(
            "unchanged {label}: {} -> {}",
            link.display(),
            target.display()
        );
        return Ok(());
    }

    let existed = link.exists() || std::fs::symlink_metadata(link).is_ok();
    match std::fs::remove_file(link) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("{}: {error}", link.display())),
    }
    symlink(target, link)
        .map_err(|error| format!("{} -> {}: {error}", link.display(), target.display()))?;
    let action = if existed { "updated" } else { "created" };
    println!(
        "{action} {label}: {} -> {}",
        link.display(),
        target.display()
    );
    Ok(())
}

fn is_dangling(link: &Path) -> bool {
    std::fs::symlink_metadata(link).is_ok() && !link.exists()
}

fn write_unit() -> Result<bool, String> {
    let path = systemd::unit_path()?;
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let embedded = systemd::embedded_unit();
    match std::fs::read_to_string(&path) {
        Ok(existing) if existing == embedded => {
            println!("unchanged unit: {}", path.display());
            Ok(false)
        }
        Ok(_) => {
            std::fs::write(&path, embedded)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            println!("updated unit: {}", path.display());
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::write(&path, embedded)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            println!("created unit: {}", path.display());
            Ok(true)
        }
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

fn run_or_print(program: &str, args: &[&str]) {
    match systemd::run_inherited(program, args) {
        Ok(()) => println!(
            "ok {}",
            std::iter::once(program)
                .chain(args.iter().copied())
                .collect::<Vec<_>>()
                .join(" ")
        ),
        Err(message) => println!("error: {message}"),
    }
}

pub fn find_on_path(binary: &str, path_env: &str) -> Option<PathBuf> {
    for dir in path_env.split(':').filter(|part| !part.is_empty()) {
        let candidate = Path::new(dir).join(binary);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn find_on_path_skipping_local_bin(binary: &str, local_bin: &Path) -> Option<PathBuf> {
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(':').filter(|part| !part.is_empty()) {
        let dir_path = Path::new(dir);
        if dir_path == local_bin {
            continue;
        }
        let candidate = dir_path.join(binary);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

pub fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn path_lookup_finds_executable() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("node");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            find_on_path("node", &dir.path().to_string_lossy()),
            Some(bin)
        );
        assert_eq!(find_on_path("npm", &dir.path().to_string_lossy()), None);
    }

    #[test]
    fn refresh_symlink_refuses_to_replace_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("remux");
        let target = dir.path().join("target");
        std::fs::write(&link, "keep").unwrap();
        std::fs::write(&target, "target").unwrap();

        refresh_symlink(&link, &target, "remux").unwrap();

        assert_eq!(std::fs::read_to_string(&link).unwrap(), "keep");
        assert!(std::fs::read_link(&link).is_err());
    }
}
