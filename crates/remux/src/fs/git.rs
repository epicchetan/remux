//! Git helpers for the fs core, ported from the git half of
//! `cli/core/fs.cjs`: repo-root discovery, porcelain v1 `-z` parsing, status
//! classification, descendant aggregation, and the boundary-safe
//! `isPathWithin` contract.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::paths;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitStatus {
    pub staged: bool,
    pub status: &'static str,
}

impl GitStatus {
    pub fn to_value(self) -> serde_json::Value {
        serde_json::json!({ "staged": self.staged, "status": self.status })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub relative_path: String,
    pub git: GitStatus,
}

#[derive(Debug, Default)]
pub struct IndexedGitStatus {
    pub repo_root: PathBuf,
    pub entries: Vec<StatusEntry>,
    pub exact_by_path: HashMap<String, Vec<GitStatus>>,
    pub descendant_by_directory_path: HashMap<String, Vec<GitStatus>>,
}

pub async fn git_repo_root(target_path: &Path) -> Option<PathBuf> {
    let output = tokio::process::Command::new("git")
        .args(["-C"])
        .arg(target_path)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let repo_root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if repo_root.is_empty() {
        None
    } else {
        Some(paths::resolve(Path::new(&repo_root)))
    }
}

pub async fn git_status_entries(repo_root: &Path) -> Vec<StatusEntry> {
    let output = tokio::process::Command::new("git")
        .args(["-C"])
        .arg(repo_root)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .output()
        .await;
    match output {
        Ok(output) if output.status.success() => {
            parse_git_porcelain(&String::from_utf8_lossy(&output.stdout))
        }
        _ => Vec::new(),
    }
}

/// Porcelain v1 `-z` records: `XY <path>`, with the rename/copy source path
/// as a separate following record that must be skipped.
pub fn parse_git_porcelain(output: &str) -> Vec<StatusEntry> {
    let records: Vec<&str> = output.split('\0').filter(|record| !record.is_empty()).collect();
    let mut entries = Vec::new();

    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        let chars: Vec<char> = record.chars().collect();
        if chars.len() < 4 {
            continue;
        }

        let index_status = chars[0];
        let worktree_status = chars[1];
        let relative_path = normalize_git_path(&record[record.char_indices().nth(3).map(|(i, _)| i).unwrap_or(3)..]);
        if let Some(git) = git_status_from_porcelain(index_status, worktree_status) {
            if !relative_path.is_empty() {
                entries.push(StatusEntry {
                    git,
                    relative_path,
                });
            }
        }

        if index_status == 'R' || index_status == 'C' {
            index += 1;
        }
    }

    entries
}

pub fn index_git_status(entries: Vec<StatusEntry>, repo_root: PathBuf) -> IndexedGitStatus {
    let mut exact_by_path: HashMap<String, Vec<GitStatus>> = HashMap::new();
    let mut descendant_by_directory_path: HashMap<String, Vec<GitStatus>> = HashMap::new();

    for entry in &entries {
        exact_by_path
            .entry(entry.relative_path.clone())
            .or_default()
            .push(entry.git);

        let mut parent = posix_dirname(&entry.relative_path);
        while !parent.is_empty() && parent != "." {
            descendant_by_directory_path
                .entry(parent.clone())
                .or_default()
                .push(entry.git);
            parent = posix_dirname(&parent);
        }
    }

    IndexedGitStatus {
        repo_root,
        entries,
        exact_by_path,
        descendant_by_directory_path,
    }
}

fn posix_dirname(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".to_string(),
        Some(index) => path[..index].to_string(),
        None => ".".to_string(),
    }
}

/// Status classification table (`gitStatusFromPorcelain`).
pub fn git_status_from_porcelain(index_status: char, worktree_status: char) -> Option<GitStatus> {
    if index_status == '!' && worktree_status == '!' {
        return None;
    }

    let staged = index_status != ' ' && index_status != '?' && index_status != '!';
    if index_status == 'U'
        || worktree_status == 'U'
        || (index_status == 'A' && worktree_status == 'A')
        || (index_status == 'D' && worktree_status == 'D')
    {
        return Some(GitStatus {
            staged,
            status: "conflicted",
        });
    }
    if index_status == '?' && worktree_status == '?' {
        return Some(GitStatus {
            staged: false,
            status: "untracked",
        });
    }
    if index_status == 'A' || worktree_status == 'A' {
        return Some(GitStatus {
            staged,
            status: "added",
        });
    }
    if index_status == 'D' || worktree_status == 'D' {
        return Some(GitStatus {
            staged,
            status: "deleted",
        });
    }
    if index_status == 'R' || worktree_status == 'R' {
        return Some(GitStatus {
            staged,
            status: "renamed",
        });
    }
    if index_status == 'M'
        || worktree_status == 'M'
        || index_status == 'T'
        || worktree_status == 'T'
    {
        return Some(GitStatus {
            staged,
            status: "modified",
        });
    }

    None
}

/// Worst-status-wins ranking with `staged` OR-ed across entries
/// (`summarizeGitStatuses`).
pub fn summarize_git_statuses(statuses: &[GitStatus]) -> Option<GitStatus> {
    let best = statuses
        .iter()
        .min_by_key(|status| git_status_rank(status.status))?;
    Some(GitStatus {
        staged: statuses.iter().any(|status| status.staged),
        status: best.status,
    })
}

fn git_status_rank(status: &str) -> u8 {
    match status {
        "conflicted" => 0,
        "added" | "untracked" => 1,
        "modified" | "renamed" => 2,
        "deleted" => 3,
        _ => 4,
    }
}

/// Path containment with the root itself included: `is_path_within(x, x)` is
/// true. Boundary-safe: `/repo2` is not within `/repo`. (The macOS
/// `/var`↔`/private/var` candidate trick was dropped — Linux host — but the
/// contract and tests keep the function shape.)
pub fn is_path_within(root_path: &Path, target_path: &Path) -> bool {
    let root = paths::resolve(root_path);
    let target = paths::resolve(target_path);
    if target == root {
        return true;
    }
    let root_text = root.to_string_lossy();
    let prefix = if root_text.ends_with('/') {
        root_text.into_owned()
    } else {
        format!("{root_text}/")
    };
    target.to_string_lossy().starts_with(&prefix)
}

pub fn relative_git_path(repo_root: &Path, entry_path: &Path) -> Option<String> {
    let root = paths::resolve(repo_root);
    let entry = paths::resolve(entry_path);
    let root_text = root.to_string_lossy();
    let entry_text = entry.to_string_lossy();
    let prefix = if root_text.ends_with('/') {
        root_text.into_owned()
    } else {
        format!("{root_text}/")
    };
    let relative = entry_text.strip_prefix(&prefix)?;
    if relative.is_empty() {
        return None;
    }
    Some(normalize_git_path(relative))
}

pub fn normalize_git_path(value: &str) -> String {
    value.trim_start_matches('/').trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_parsing_handles_renames_and_classification() {
        let output = "M  staged.txt\0 M modified.txt\0?? untracked.txt\0R  new-name.txt\0old-name.txt\0A  added.txt\0 D deleted.txt\0UU conflicted.txt\0";
        let entries = parse_git_porcelain(output);
        let by_path: HashMap<&str, GitStatus> = entries
            .iter()
            .map(|entry| (entry.relative_path.as_str(), entry.git))
            .collect();

        assert_eq!(by_path["staged.txt"], GitStatus { staged: true, status: "modified" });
        assert_eq!(by_path["modified.txt"], GitStatus { staged: false, status: "modified" });
        assert_eq!(by_path["untracked.txt"], GitStatus { staged: false, status: "untracked" });
        assert_eq!(by_path["new-name.txt"], GitStatus { staged: true, status: "renamed" });
        // Rename source record is skipped, not misparsed as a status record.
        assert!(!by_path.contains_key("old-name.txt"));
        assert_eq!(by_path["added.txt"], GitStatus { staged: true, status: "added" });
        assert_eq!(by_path["deleted.txt"], GitStatus { staged: false, status: "deleted" });
        assert_eq!(by_path["conflicted.txt"], GitStatus { staged: true, status: "conflicted" });
    }

    #[test]
    fn descendant_aggregation_walks_every_parent() {
        let entries = parse_git_porcelain("?? a/b/c/file.txt\0");
        let indexed = index_git_status(entries, PathBuf::from("/repo"));
        assert!(indexed.descendant_by_directory_path.contains_key("a"));
        assert!(indexed.descendant_by_directory_path.contains_key("a/b"));
        assert!(indexed.descendant_by_directory_path.contains_key("a/b/c"));
        assert!(!indexed.descendant_by_directory_path.contains_key("."));
    }

    #[test]
    fn summarize_ranks_worst_status_and_ors_staged() {
        let statuses = [
            GitStatus { staged: false, status: "modified" },
            GitStatus { staged: true, status: "untracked" },
        ];
        assert_eq!(
            summarize_git_statuses(&statuses),
            Some(GitStatus { staged: true, status: "untracked" })
        );
        assert_eq!(summarize_git_statuses(&[]), None);
    }

    #[test]
    fn is_path_within_keeps_the_boundary_contract() {
        assert!(is_path_within(Path::new("/repo"), Path::new("/repo")));
        assert!(is_path_within(Path::new("/repo"), Path::new("/repo/src/main.rs")));
        assert!(!is_path_within(Path::new("/repo"), Path::new("/repo2")));
        assert!(!is_path_within(Path::new("/repo"), Path::new("/")));
    }

    #[test]
    fn relative_git_path_rejects_outside_paths() {
        assert_eq!(
            relative_git_path(Path::new("/repo"), Path::new("/repo/src/a.txt")),
            Some("src/a.txt".to_string())
        );
        assert_eq!(relative_git_path(Path::new("/repo"), Path::new("/repo")), None);
        assert_eq!(relative_git_path(Path::new("/repo"), Path::new("/other/a.txt")), None);
    }
}
