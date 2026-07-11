//! `.remux/run/extensions.json` — the persistent record of live extension
//! process groups, and the boot-time orphan sweep that consumes it.
//!
//! PDEATHSIG covers the direct child of a dying worker; this file covers
//! everything PDEATHSIG cannot: grandchildren that re-parented and whole
//! extension trees left behind by a `kill -9`'d worker. Each spawn writes a
//! record (pid, pgid, start ticks); each confirmed reap removes it. On boot,
//! before any extension spawns, records whose pid is still alive *and* whose
//! `/proc/<pid>/stat` start ticks match get their group SIGKILLed — the
//! start-ticks match is the pid-reuse guard.
//!
//! v2 (view-build-watch pass): entries are role-keyed per extension —
//! `server`, `build`, and `watch` groups can coexist, so one slot per id
//! (v1) is no longer enough. The reader still accepts v1 files (bare entries
//! read as `{ "server": entry }`); the sweep deletes the file afterwards and
//! the first `record` of the new run writes v2.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::extensions::process::signal_group;
use crate::logs::{Journal, JournalEvent, TerminalMode};

pub const RUN_STATE_RELATIVE_PATH: &str = ".remux/run/extensions.json";
pub const RUN_STATE_VERSION: u32 = 2;

/// Which process group of an extension a run-state entry tracks. One slot
/// per role: an extension has at most one live server, one build, and one
/// watch group at a time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunRole {
    Server,
    Build,
    Watch,
}

impl RunRole {
    pub fn as_str(self) -> &'static str {
        match self {
            RunRole::Server => "server",
            RunRole::Build => "build",
            RunRole::Watch => "watch",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEntry {
    pub pid: u32,
    pub pgid: u32,
    pub start_ticks: u64,
    pub started_at_ms: i64,
}

type RoleMap = BTreeMap<String, RunEntry>;

#[derive(Debug, Default, Serialize, Deserialize)]
struct RunStateFile {
    version: u32,
    extensions: BTreeMap<String, RoleMap>,
}

/// Migration shim: a v1 file's extension value is a bare `RunEntry`; v2 is a
/// role map. The two shapes are structurally unambiguous.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ExtensionRecord {
    Entry(RunEntry),
    Roles(RoleMap),
}

#[derive(Debug, Deserialize)]
struct RunStateFileCompat {
    #[allow(dead_code)]
    version: u32,
    extensions: BTreeMap<String, ExtensionRecord>,
}

impl ExtensionRecord {
    fn into_roles(self) -> RoleMap {
        match self {
            ExtensionRecord::Roles(roles) => roles,
            ExtensionRecord::Entry(entry) => {
                BTreeMap::from([(RunRole::Server.as_str().to_string(), entry)])
            }
        }
    }
}

/// Shared writer for the run-state file. All mutations rewrite the whole
/// file atomically (temp file + rename) — it is tiny and rarely written.
pub struct RunState {
    path: PathBuf,
    entries: Mutex<BTreeMap<String, RoleMap>>,
}

impl RunState {
    pub fn new(root_dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            path: root_dir.join(RUN_STATE_RELATIVE_PATH),
            entries: Mutex::new(BTreeMap::new()),
        })
    }

    pub fn record(&self, extension_id: &str, role: RunRole, entry: RunEntry) {
        let snapshot = {
            let mut entries = self.entries.lock().unwrap();
            entries
                .entry(extension_id.to_string())
                .or_default()
                .insert(role.as_str().to_string(), entry);
            entries.clone()
        };
        self.persist(snapshot);
    }

    pub fn remove(&self, extension_id: &str, role: RunRole) {
        let snapshot = {
            let mut entries = self.entries.lock().unwrap();
            if let Some(roles) = entries.get_mut(extension_id) {
                roles.remove(role.as_str());
                if roles.is_empty() {
                    entries.remove(extension_id);
                }
            }
            entries.clone()
        };
        self.persist(snapshot);
    }

    fn persist(&self, entries: BTreeMap<String, RoleMap>) {
        let file = RunStateFile {
            version: RUN_STATE_VERSION,
            extensions: entries,
        };
        let Ok(body) = serde_json::to_string_pretty(&file) else {
            return;
        };
        let Some(dir) = self.path.parent() else {
            return;
        };
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        let temp = self.path.with_extension("json.tmp");
        if std::fs::write(&temp, body).is_ok() {
            let _ = std::fs::rename(&temp, &self.path);
        }
    }
}

/// Reads `/proc/<pid>/stat` field 22 (process start time in clock ticks).
/// `None` when the process is gone or the file is unparsable.
pub fn read_start_ticks(pid: u32) -> Option<u64> {
    let content = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    crate::monitor::parse_proc_stat(&content).map(|stat| stat.start_ticks)
}

/// Boot orphan sweep: kill every recorded group (any role) whose pid is
/// still the same process it was when recorded, then reset the file. Runs
/// before any extension spawns, so a respawned worker can never coexist
/// with a hung predecessor's extension servers, builds, or watchers.
pub fn sweep_orphans(root_dir: &Path, journal: &Journal) {
    let path = root_dir.join(RUN_STATE_RELATIVE_PATH);
    let Ok(body) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(file) = serde_json::from_str::<RunStateFileCompat>(&body) else {
        journal.warn("[remux] ignored unparsable run-state file");
        let _ = std::fs::remove_file(&path);
        return;
    };

    for (extension_id, record) in file.extensions {
        for (role, entry) in record.into_roles() {
            sweep_entry(journal, &extension_id, &role, &entry);
        }
    }

    let _ = std::fs::remove_file(&path);
}

fn sweep_entry(journal: &Journal, extension_id: &str, role: &str, entry: &RunEntry) {
    let current_ticks = read_start_ticks(entry.pid);
    match current_ticks {
        Some(ticks) if ticks == entry.start_ticks => {
            signal_group(entry.pgid, nix::sys::signal::Signal::SIGKILL);
            journal.event(JournalEvent {
                detail: Some(serde_json::json!({
                    "pid": entry.pid,
                    "pgid": entry.pgid,
                    "role": role,
                    "startedAtMs": entry.started_at_ms,
                })),
                label: Some("sweep:killed".to_string()),
                level: "warn",
                message: Some(format!(
                    "killed orphaned extension process group for {extension_id} ({role})"
                )),
                source: format!("extension:{extension_id}"),
                ..Default::default()
            });
        }
        _ => {
            journal.event(JournalEvent {
                detail: Some(serde_json::json!({
                    "pid": entry.pid,
                    "pgid": entry.pgid,
                    "role": role,
                    "recordedStartTicks": entry.start_ticks,
                    "currentStartTicks": current_ticks,
                })),
                label: Some("sweep:stale".to_string()),
                level: "info",
                message: Some(format!(
                    "skipped stale run-state record for {extension_id} ({role})"
                )),
                source: format!("extension:{extension_id}"),
                terminal: TerminalMode::Silent,
                ..Default::default()
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_extension_records_read_as_server_role() {
        let raw = serde_json::json!({
            "version": 1,
            "extensions": {
                "codex": { "pid": 10, "pgid": 10, "startTicks": 5, "startedAtMs": 1 }
            }
        });
        let file: RunStateFileCompat = serde_json::from_value(raw).unwrap();
        let roles = file
            .extensions
            .into_iter()
            .next()
            .map(|(_, record)| record.into_roles())
            .unwrap();
        assert_eq!(roles.len(), 1);
        assert_eq!(roles["server"].pid, 10);
    }

    #[test]
    fn v2_round_trips_per_role_and_remove_leaves_siblings_intact() {
        let root = tempfile::tempdir().unwrap();
        let run_state = RunState::new(root.path());
        let entry = |pid: u32| RunEntry {
            pid,
            pgid: pid,
            start_ticks: 7,
            started_at_ms: 3,
        };

        run_state.record("codex", RunRole::Server, entry(11));
        run_state.record("codex", RunRole::Watch, entry(12));
        run_state.record("editor", RunRole::Build, entry(13));

        let path = root.path().join(RUN_STATE_RELATIVE_PATH);
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(document["version"], 2);
        assert_eq!(document["extensions"]["codex"]["server"]["pid"], 11);
        assert_eq!(document["extensions"]["codex"]["watch"]["pid"], 12);
        assert_eq!(document["extensions"]["editor"]["build"]["pid"], 13);

        // Removing one role leaves the sibling; the reader accepts its own
        // output (v2 round-trip).
        run_state.remove("codex", RunRole::Server);
        let body = std::fs::read_to_string(&path).unwrap();
        let compat: RunStateFileCompat = serde_json::from_str(&body).unwrap();
        let codex = match &compat.extensions["codex"] {
            ExtensionRecord::Roles(roles) => roles,
            ExtensionRecord::Entry(_) => panic!("v2 record parsed as v1"),
        };
        assert!(!codex.contains_key("server"));
        assert_eq!(codex["watch"].pid, 12);

        // Removing the last role drops the extension key entirely.
        run_state.remove("editor", RunRole::Build);
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(document["extensions"]
            .as_object()
            .unwrap()
            .get("editor")
            .is_none());
    }
}
