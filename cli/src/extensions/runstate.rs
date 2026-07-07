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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::extensions::process::signal_group;
use crate::logs::{Journal, JournalEvent, TerminalMode};

pub const RUN_STATE_RELATIVE_PATH: &str = ".remux/run/extensions.json";
pub const RUN_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEntry {
    pub pid: u32,
    pub pgid: u32,
    pub start_ticks: u64,
    pub started_at_ms: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RunStateFile {
    version: u32,
    extensions: BTreeMap<String, RunEntry>,
}

/// Shared writer for the run-state file. All mutations rewrite the whole
/// file atomically (temp file + rename) — it is tiny and rarely written.
pub struct RunState {
    path: PathBuf,
    entries: Mutex<BTreeMap<String, RunEntry>>,
}

impl RunState {
    pub fn new(root_dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            path: root_dir.join(RUN_STATE_RELATIVE_PATH),
            entries: Mutex::new(BTreeMap::new()),
        })
    }

    pub fn record(&self, extension_id: &str, entry: RunEntry) {
        let snapshot = {
            let mut entries = self.entries.lock().unwrap();
            entries.insert(extension_id.to_string(), entry);
            entries.clone()
        };
        self.persist(snapshot);
    }

    pub fn remove(&self, extension_id: &str) {
        let snapshot = {
            let mut entries = self.entries.lock().unwrap();
            entries.remove(extension_id);
            entries.clone()
        };
        self.persist(snapshot);
    }

    fn persist(&self, entries: BTreeMap<String, RunEntry>) {
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

/// Boot orphan sweep: kill every recorded group whose pid is still the same
/// process it was when recorded, then reset the file. Runs before any
/// extension spawns, so a respawned worker can never coexist with a hung
/// predecessor's extension servers.
pub fn sweep_orphans(root_dir: &Path, journal: &Journal) {
    let path = root_dir.join(RUN_STATE_RELATIVE_PATH);
    let Ok(body) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(file) = serde_json::from_str::<RunStateFile>(&body) else {
        journal.warn("[remux] ignored unparsable run-state file");
        let _ = std::fs::remove_file(&path);
        return;
    };

    for (extension_id, entry) in &file.extensions {
        let current_ticks = read_start_ticks(entry.pid);
        match current_ticks {
            Some(ticks) if ticks == entry.start_ticks => {
                signal_group(entry.pgid, nix::sys::signal::Signal::SIGKILL);
                journal.event(JournalEvent {
                    detail: Some(serde_json::json!({
                        "pid": entry.pid,
                        "pgid": entry.pgid,
                        "startedAtMs": entry.started_at_ms,
                    })),
                    label: Some("sweep:killed".to_string()),
                    level: "warn",
                    message: Some(format!(
                        "killed orphaned extension process group for {extension_id}"
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
                        "recordedStartTicks": entry.start_ticks,
                        "currentStartTicks": current_ticks,
                    })),
                    label: Some("sweep:stale".to_string()),
                    level: "info",
                    message: Some(format!("skipped stale run-state record for {extension_id}")),
                    source: format!("extension:{extension_id}"),
                    terminal: TerminalMode::Silent,
                    ..Default::default()
                });
            }
        }
    }

    let _ = std::fs::remove_file(&path);
}
