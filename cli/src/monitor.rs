//! Resource monitoring: a `/proc`-based sampler feeding the
//! `remux/system/resources*` RPCs and the optional memory-ceiling alert.
//!
//! No dependencies beyond `nix` (statvfs): per-extension numbers come from
//! scanning `/proc/*/stat` for process-group members (extensions lead their
//! own groups — L3), system numbers from `/proc/loadavg` + `/proc/meminfo` +
//! `statvfs`. Parsers are pure functions over file contents so they unit-test
//! without `/proc`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

use serde_json::{Map, Value};

use crate::rpc::router::{ExtensionServer, RpcResult};
use crate::rpc::ws::{ClientScopedRpc, WsClient};
use crate::time::now_ms;

pub const RESOURCES_METHOD: &str = "remux/system/resources";
pub const RESOURCES_SUBSCRIBE_METHOD: &str = "remux/system/resources/subscribe";
pub const RESOURCES_UNSUBSCRIBE_METHOD: &str = "remux/system/resources/unsubscribe";
pub const RESOURCES_DID_SAMPLE_METHOD: &str = "remux/system/resources/didSample";

pub const DEFAULT_RESOURCE_POLL_SECONDS: u32 = 5;
pub const MEMORY_ALERT_THROTTLE_MS: u64 = 3_600_000;

// ---------------------------------------------------------------------------
// Pure /proc parsers.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcStat {
    pub pid: u32,
    /// Field 5: process group id.
    pub pgrp: i32,
    /// Fields 14 + 15: user + system CPU time in clock ticks.
    pub cpu_ticks: u64,
    /// Field 22: process start time in clock ticks since boot (pid-reuse guard).
    pub start_ticks: u64,
}

/// Parses `/proc/<pid>/stat`. The comm field (2) can contain spaces and
/// parentheses, so fields are counted from the *last* `)`.
pub fn parse_proc_stat(content: &str) -> Option<ProcStat> {
    let pid: u32 = content.split_whitespace().next()?.parse().ok()?;
    let after_comm = &content[content.rfind(')')? + 1..];
    // after_comm tokens are fields 3.. (1-based): token[i] is field i+3.
    let fields: Vec<&str> = after_comm.split_whitespace().collect();
    let field = |n: usize| fields.get(n - 3).copied();
    let utime: u64 = field(14)?.parse().ok()?;
    let stime: u64 = field(15)?.parse().ok()?;
    Some(ProcStat {
        pid,
        pgrp: field(5)?.parse().ok()?,
        cpu_ticks: utime + stime,
        start_ticks: field(22)?.parse().ok()?,
    })
}

/// Parses `/proc/<pid>/statm`: field 2 is resident pages.
pub fn parse_statm_resident_pages(content: &str) -> Option<u64> {
    content.split_whitespace().nth(1)?.parse().ok()
}

/// Parses `/proc/loadavg` into (load1, load5, load15).
pub fn parse_loadavg(content: &str) -> Option<(f64, f64, f64)> {
    let mut parts = content.split_whitespace();
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemInfo {
    pub total_bytes: u64,
    pub available_bytes: u64,
}

/// Parses `/proc/meminfo` (`MemTotal`/`MemAvailable`, kB units).
pub fn parse_meminfo(content: &str) -> Option<MemInfo> {
    let mut total = None;
    let mut available = None;
    for line in content.lines() {
        let mut parts = line.split_whitespace();
        match parts.next() {
            Some("MemTotal:") => total = parts.next()?.parse::<u64>().ok(),
            Some("MemAvailable:") => available = parts.next()?.parse::<u64>().ok(),
            _ => {}
        }
    }
    Some(MemInfo {
        total_bytes: total? * 1024,
        available_bytes: available? * 1024,
    })
}

// ---------------------------------------------------------------------------
// Sampler.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct MemoryAlert {
    pub extension_id: String,
    pub rss_bytes: u64,
    pub ceiling_bytes: u64,
}

struct GroupUsage {
    process_count: u32,
    cpu_ticks: u64,
    rss_bytes: u64,
}

pub struct ResourceMonitor {
    workspace_dir: PathBuf,
    servers: Vec<(String, Arc<dyn ExtensionServer>)>,
    latest: Mutex<Value>,
    subscribers: Mutex<Vec<Weak<WsClient>>>,
    /// Previous (cpu_ticks, at) per key ("runtime" or extension id) for CPU
    /// deltas. Cleared per key when the target restarts (ticks go backwards).
    prev_cpu: Mutex<HashMap<String, (u64, Instant)>>,
    started_at: Instant,
    ticks_per_second: f64,
    page_size: u64,
    memory_ceiling_bytes: u64,
    last_memory_alert: Mutex<HashMap<String, Instant>>,
    on_memory_alert: Box<dyn Fn(MemoryAlert) + Send + Sync>,
}

impl ResourceMonitor {
    pub fn new(
        workspace_dir: PathBuf,
        servers: Vec<(String, Arc<dyn ExtensionServer>)>,
        memory_ceiling_mb: u32,
        on_memory_alert: Box<dyn Fn(MemoryAlert) + Send + Sync>,
    ) -> Arc<Self> {
        let ticks_per_second = nix::unistd::sysconf(nix::unistd::SysconfVar::CLK_TCK)
            .ok()
            .flatten()
            .map(|ticks| ticks as f64)
            .unwrap_or(100.0);
        let page_size = nix::unistd::sysconf(nix::unistd::SysconfVar::PAGE_SIZE)
            .ok()
            .flatten()
            .map(|size| size as u64)
            .unwrap_or(4096);
        Arc::new(Self {
            workspace_dir,
            servers,
            latest: Mutex::new(Value::Null),
            subscribers: Mutex::new(Vec::new()),
            prev_cpu: Mutex::new(HashMap::new()),
            started_at: Instant::now(),
            ticks_per_second,
            page_size,
            memory_ceiling_bytes: u64::from(memory_ceiling_mb) * 1024 * 1024,
            last_memory_alert: Mutex::new(HashMap::new()),
            on_memory_alert,
        })
    }

    /// Starts the sampling loop. Always on — it also feeds the memory
    /// guardrail — and cheap: a handful of `/proc` reads per tick.
    pub fn start(self: &Arc<Self>, poll_seconds: u32) {
        let monitor = self.clone();
        let interval = std::time::Duration::from_secs(u64::from(poll_seconds.max(1)));
        tokio::spawn(async move {
            loop {
                monitor.tick();
                tokio::time::sleep(interval).await;
            }
        });
    }

    /// The latest sample (`remux/system/resources`).
    pub fn latest(&self) -> Value {
        let latest = self.latest.lock().unwrap().clone();
        if latest.is_null() {
            // First request can beat the first tick; sample inline.
            return self.sample();
        }
        latest
    }

    pub fn tick(&self) {
        let sample = self.sample();
        *self.latest.lock().unwrap() = sample.clone();
        self.push_sample(&sample);
        self.check_memory_ceiling(&sample);
    }

    fn push_sample(&self, sample: &Value) {
        let subscribers: Vec<Arc<WsClient>> = {
            let mut subscribers = self.subscribers.lock().unwrap();
            subscribers.retain(|weak| weak.strong_count() > 0);
            subscribers.iter().filter_map(Weak::upgrade).collect()
        };
        if subscribers.is_empty() {
            return;
        }
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": RESOURCES_DID_SAMPLE_METHOD,
            "params": sample,
        });
        for client in subscribers {
            client.send_message(&notification);
        }
    }

    fn check_memory_ceiling(&self, sample: &Value) {
        if self.memory_ceiling_bytes == 0 {
            return;
        }
        let Some(extensions) = sample.get("extensions").and_then(Value::as_array) else {
            return;
        };
        for extension in extensions {
            let rss = extension
                .get("rssBytes")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if rss <= self.memory_ceiling_bytes {
                continue;
            }
            let Some(extension_id) = extension.get("extensionId").and_then(Value::as_str) else {
                continue;
            };
            {
                let mut alerts = self.last_memory_alert.lock().unwrap();
                let throttled = alerts
                    .get(extension_id)
                    .map(|at| {
                        at.elapsed() < std::time::Duration::from_millis(MEMORY_ALERT_THROTTLE_MS)
                    })
                    .unwrap_or(false);
                if throttled {
                    continue;
                }
                alerts.insert(extension_id.to_string(), Instant::now());
            }
            (self.on_memory_alert)(MemoryAlert {
                extension_id: extension_id.to_string(),
                rss_bytes: rss,
                ceiling_bytes: self.memory_ceiling_bytes,
            });
        }
    }

    fn sample(&self) -> Value {
        let now = Instant::now();
        let sampled_at_ms = now_ms();

        // One /proc pass: every readable process' stat, grouped later.
        let mut all: Vec<ProcStat> = Vec::new();
        if let Ok(entries) = std::fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if !name.bytes().all(|byte| byte.is_ascii_digit()) {
                    continue;
                }
                let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                    continue;
                };
                if let Some(stat) = parse_proc_stat(&stat) {
                    all.push(stat);
                }
            }
        }

        let own_pid = std::process::id();
        let runtime_usage = self.usage_for(&all, |stat| stat.pid == own_pid);

        let mut extensions = Vec::new();
        for (extension_id, server) in &self.servers {
            let status = server.status();
            let mut entry = Map::new();
            entry.insert("extensionId".to_string(), Value::from(extension_id.clone()));
            entry.insert("state".to_string(), Value::from(status.state.clone()));
            entry.insert(
                "pid".to_string(),
                status.pid.map(Value::from).unwrap_or(Value::Null),
            );
            entry.insert("restartCount".to_string(), Value::from(status.restart_count));
            entry.insert(
                "uptimeMs".to_string(),
                status
                    .started_at_ms
                    .map(|started| Value::from((sampled_at_ms - started).max(0)))
                    .unwrap_or(Value::Null),
            );

            let usage = status
                .pid
                .map(|pid| self.usage_for(&all, |stat| stat.pgrp == pid as i32))
                .unwrap_or(GroupUsage {
                    process_count: 0,
                    cpu_ticks: 0,
                    rss_bytes: 0,
                });
            entry.insert("processCount".to_string(), Value::from(usage.process_count));
            entry.insert("rssBytes".to_string(), Value::from(usage.rss_bytes));
            entry.insert(
                "cpuPercent".to_string(),
                Value::from(self.cpu_percent(extension_id, usage.cpu_ticks, now)),
            );
            extensions.push(Value::Object(entry));
        }

        serde_json::json!({
            "sampledAtMs": sampled_at_ms,
            "system": self.system_block(),
            "runtime": {
                "pid": own_pid,
                "cpuPercent": self.cpu_percent("runtime", runtime_usage.cpu_ticks, now),
                "rssBytes": runtime_usage.rss_bytes,
                "uptimeMs": self.started_at.elapsed().as_millis() as u64,
            },
            "extensions": extensions,
        })
    }

    fn usage_for(&self, all: &[ProcStat], matches: impl Fn(&ProcStat) -> bool) -> GroupUsage {
        let mut usage = GroupUsage {
            process_count: 0,
            cpu_ticks: 0,
            rss_bytes: 0,
        };
        for stat in all.iter().filter(|stat| matches(stat)) {
            usage.process_count += 1;
            usage.cpu_ticks += stat.cpu_ticks;
            if let Ok(statm) = std::fs::read_to_string(format!("/proc/{}/statm", stat.pid)) {
                if let Some(pages) = parse_statm_resident_pages(&statm) {
                    usage.rss_bytes += pages * self.page_size;
                }
            }
        }
        usage
    }

    /// Normalized to one core (100 = one full core, like `top`). Ticks can go
    /// backwards when group members die or restart — that reads as 0, and the
    /// baseline resets.
    fn cpu_percent(&self, key: &str, cpu_ticks: u64, now: Instant) -> f64 {
        let mut prev = self.prev_cpu.lock().unwrap();
        let previous = prev.insert(key.to_string(), (cpu_ticks, now));
        let Some((prev_ticks, prev_at)) = previous else {
            return 0.0;
        };
        let elapsed = now.duration_since(prev_at).as_secs_f64();
        if elapsed <= 0.0 || cpu_ticks < prev_ticks {
            return 0.0;
        }
        let cpu_seconds = (cpu_ticks - prev_ticks) as f64 / self.ticks_per_second;
        ((cpu_seconds / elapsed) * 100.0 * 10.0).round() / 10.0
    }

    fn system_block(&self) -> Value {
        let loadavg = std::fs::read_to_string("/proc/loadavg")
            .ok()
            .and_then(|content| parse_loadavg(&content))
            .unwrap_or((0.0, 0.0, 0.0));
        let meminfo = std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|content| parse_meminfo(&content))
            .unwrap_or(MemInfo {
                total_bytes: 0,
                available_bytes: 0,
            });
        let disk = nix::sys::statvfs::statvfs(&self.workspace_dir)
            .map(|stat| {
                let frsize = stat.fragment_size() as u64;
                (stat.blocks() as u64 * frsize, stat.blocks_available() as u64 * frsize)
            })
            .unwrap_or((0, 0));

        serde_json::json!({
            "load1": loadavg.0,
            "load5": loadavg.1,
            "load15": loadavg.2,
            "memTotalBytes": meminfo.total_bytes,
            "memAvailableBytes": meminfo.available_bytes,
            "diskTotalBytes": disk.0,
            "diskFreeBytes": disk.1,
        })
    }

    fn subscribe(&self, client: &Arc<WsClient>) {
        let mut subscribers = self.subscribers.lock().unwrap();
        subscribers.retain(|weak| weak.strong_count() > 0);
        if !subscribers
            .iter()
            .any(|weak| weak.as_ptr() == Arc::as_ptr(client))
        {
            subscribers.push(Arc::downgrade(client));
        }
    }

    fn unsubscribe(&self, client: &Arc<WsClient>) {
        self.subscribers
            .lock()
            .unwrap()
            .retain(|weak| weak.strong_count() > 0 && weak.as_ptr() != Arc::as_ptr(client));
    }
}

/// `remux/system/resources/subscribe|unsubscribe` are client-scoped: the
/// subscription lives and dies with the WebSocket.
impl ClientScopedRpc for ResourceMonitor {
    fn handle(
        &self,
        client: &Arc<WsClient>,
        method: &str,
        _params: Option<&Value>,
    ) -> Option<RpcResult> {
        match method {
            RESOURCES_SUBSCRIBE_METHOD => self.subscribe(client),
            RESOURCES_UNSUBSCRIBE_METHOD => self.unsubscribe(client),
            _ => return None,
        }
        Some(Ok(serde_json::json!({ "ok": true })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAT_FIXTURE: &str = "1234 (some (weird) comm) S 1 1200 1200 0 -1 4194304 500 0 0 0 731 209 0 0 20 0 4 0 555444 1000000 2500 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";

    #[test]
    fn parses_proc_stat_around_parenthesized_comm() {
        let stat = parse_proc_stat(STAT_FIXTURE).unwrap();
        assert_eq!(stat.pid, 1234);
        assert_eq!(stat.pgrp, 1200);
        assert_eq!(stat.cpu_ticks, 731 + 209);
        assert_eq!(stat.start_ticks, 555_444);

        assert_eq!(parse_proc_stat(""), None);
        assert_eq!(parse_proc_stat("99 (x"), None);
    }

    #[test]
    fn parses_statm_loadavg_meminfo() {
        assert_eq!(parse_statm_resident_pages("52000 2500 1200 10 0 4000 0"), Some(2500));
        assert_eq!(parse_statm_resident_pages(""), None);

        let (load1, load5, load15) =
            parse_loadavg("0.52 1.10 2.35 2/1567 2235165").unwrap();
        assert_eq!((load1, load5, load15), (0.52, 1.10, 2.35));

        let meminfo = parse_meminfo(
            "MemTotal:       65536000 kB\nMemFree:        10000000 kB\nMemAvailable:   40000000 kB\nBuffers:ABC\n",
        )
        .unwrap();
        assert_eq!(meminfo.total_bytes, 65_536_000 * 1024);
        assert_eq!(meminfo.available_bytes, 40_000_000 * 1024);
        assert_eq!(parse_meminfo("MemTotal: 1 kB\n"), None, "missing MemAvailable");
    }

    #[test]
    fn reads_own_proc_stat() {
        let content = std::fs::read_to_string(format!("/proc/{}/stat", std::process::id())).unwrap();
        let stat = parse_proc_stat(&content).unwrap();
        assert_eq!(stat.pid, std::process::id());
        assert!(stat.start_ticks > 0);
    }

    #[test]
    fn memory_ceiling_alerts_once_per_extension_per_hour() {
        let alerts: Arc<Mutex<Vec<MemoryAlert>>> = Arc::new(Mutex::new(Vec::new()));
        let monitor = ResourceMonitor::new(
            std::env::temp_dir(),
            Vec::new(),
            1, // 1 MB ceiling
            Box::new({
                let alerts = alerts.clone();
                move |alert| alerts.lock().unwrap().push(alert)
            }),
        );

        let over = serde_json::json!({
            "extensions": [
                { "extensionId": "codex", "rssBytes": 5 * 1024 * 1024 },
                { "extensionId": "terminal", "rssBytes": 100 },
            ],
        });
        monitor.check_memory_ceiling(&over);
        monitor.check_memory_ceiling(&over); // throttled — within the hour
        {
            let alerts = alerts.lock().unwrap();
            assert_eq!(alerts.len(), 1, "one alert per extension per hour");
            assert_eq!(alerts[0].extension_id, "codex");
            assert_eq!(alerts[0].rss_bytes, 5 * 1024 * 1024);
            assert_eq!(alerts[0].ceiling_bytes, 1024 * 1024);
        }

        // A different extension crossing the ceiling alerts independently.
        let both = serde_json::json!({
            "extensions": [
                { "extensionId": "codex", "rssBytes": 5 * 1024 * 1024 },
                { "extensionId": "terminal", "rssBytes": 9 * 1024 * 1024 },
            ],
        });
        monitor.check_memory_ceiling(&both);
        assert_eq!(alerts.lock().unwrap().len(), 2);
    }

    #[test]
    fn zero_ceiling_disables_the_guardrail() {
        let alerts: Arc<Mutex<Vec<MemoryAlert>>> = Arc::new(Mutex::new(Vec::new()));
        let monitor = ResourceMonitor::new(
            std::env::temp_dir(),
            Vec::new(),
            0,
            Box::new({
                let alerts = alerts.clone();
                move |alert| alerts.lock().unwrap().push(alert)
            }),
        );
        monitor.check_memory_ceiling(&serde_json::json!({
            "extensions": [ { "extensionId": "codex", "rssBytes": u64::MAX } ],
        }));
        assert!(alerts.lock().unwrap().is_empty());
    }
}
