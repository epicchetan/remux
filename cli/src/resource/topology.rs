use std::collections::BTreeSet;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CpuTopology {
    pub allowed_extension_cpus: String,
    pub logical_cpus: usize,
    pub reserved_cpus: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceCapabilities {
    pub cgroup_version: Option<u8>,
    pub systemd_user_manager: bool,
    pub cpu_weight: bool,
    pub memory_accounting: bool,
    pub pid_accounting: bool,
    pub pressure: bool,
    pub freeze: bool,
    pub process_affinity: bool,
    pub protected_mode: bool,
    pub reasons: Vec<String>,
}

impl CpuTopology {
    pub fn detect() -> Self {
        // `available_parallelism` reflects the caller's current affinity. An
        // extension already placed in remux-extensions.slice therefore sees
        // 14, but those CPUs are still numbered 1-7,9-15 rather than 0-13.
        // Read the host's online CPU IDs so nested workload admission never
        // renumbers or subtracts the reserved sibling pair twice.
        let online_cpus = std::fs::read_to_string("/sys/devices/system/cpu/online")
            .ok()
            .and_then(|source| parse_cpu_list(source.trim()))
            .filter(|cpus| !cpus.is_empty())
            .unwrap_or_else(|| {
                let count = std::thread::available_parallelism()
                    .map(usize::from)
                    .unwrap_or(1);
                (0..count).collect()
            });
        let logical_cpus = online_cpus.len();
        let reserved_cpus = read_thread_siblings(0)
            .filter(|siblings| !siblings.is_empty())
            .unwrap_or_else(|| vec![0]);
        let reserved: BTreeSet<usize> = reserved_cpus.iter().copied().collect();
        let allowed = online_cpus
            .into_iter()
            .filter(|cpu| !reserved.contains(cpu))
            .collect::<Vec<_>>();
        Self {
            allowed_extension_cpus: format_cpu_list(&allowed),
            logical_cpus,
            reserved_cpus,
        }
    }
}

impl ResourceCapabilities {
    pub fn detect(systemd_user_manager: bool) -> Self {
        let cgroup_v2 = std::path::Path::new("/sys/fs/cgroup/cgroup.controllers").exists();
        let controllers =
            std::fs::read_to_string("/sys/fs/cgroup/cgroup.controllers").unwrap_or_default();
        // cgroup v2 intentionally omits cgroup.freeze from the hierarchy
        // root. Check the caller's delegated cgroup instead; Remux and its
        // CLI run in non-root user-manager cgroups where freezer control is
        // actually exercised.
        let freeze = current_cgroup_path().is_some_and(|path| path.join("cgroup.freeze").exists());
        let pressure = std::path::Path::new("/proc/pressure/cpu").exists();
        let process_affinity = std::path::Path::new("/proc/self/status").exists();
        let cpu_weight = controllers.split_whitespace().any(|item| item == "cpu");
        let memory_accounting = controllers.split_whitespace().any(|item| item == "memory");
        let pid_accounting = controllers.split_whitespace().any(|item| item == "pids");
        let mut reasons = Vec::new();
        for (available, reason) in [
            (cgroup_v2, "cgroup v2 unavailable"),
            (systemd_user_manager, "systemd user manager unavailable"),
            (cpu_weight, "cpu controller unavailable"),
            (freeze, "cgroup freezer unavailable"),
            (process_affinity, "process affinity unavailable"),
        ] {
            if !available {
                reasons.push(reason.to_string());
            }
        }
        Self {
            cgroup_version: cgroup_v2.then_some(2),
            systemd_user_manager,
            cpu_weight,
            memory_accounting,
            pid_accounting,
            pressure,
            freeze,
            process_affinity,
            protected_mode: reasons.is_empty(),
            reasons,
        }
    }
}

fn current_cgroup_path() -> Option<PathBuf> {
    let source = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    cgroup_v2_relative_path(&source)
        .map(|path| PathBuf::from("/sys/fs/cgroup").join(path.trim_start_matches('/')))
}

fn cgroup_v2_relative_path(source: &str) -> Option<&str> {
    source.lines().find_map(|line| line.strip_prefix("0::"))
}

fn read_thread_siblings(cpu: usize) -> Option<Vec<usize>> {
    let source = std::fs::read_to_string(format!(
        "/sys/devices/system/cpu/cpu{cpu}/topology/thread_siblings_list"
    ))
    .ok()?;
    parse_cpu_list(source.trim())
}

fn parse_cpu_list(source: &str) -> Option<Vec<usize>> {
    let mut result = BTreeSet::new();
    for part in source.split(',') {
        if let Some((start, end)) = part.split_once('-') {
            let start = start.parse::<usize>().ok()?;
            let end = end.parse::<usize>().ok()?;
            result.extend(start..=end);
        } else {
            result.insert(part.parse::<usize>().ok()?);
        }
    }
    Some(result.into_iter().collect())
}

fn format_cpu_list(cpus: &[usize]) -> String {
    cpus.iter()
        .map(usize::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ranges_and_formats_an_affinity_list() {
        assert_eq!(parse_cpu_list("0,4-6"), Some(vec![0, 4, 5, 6]));
        assert_eq!(format_cpu_list(&[1, 2, 7]), "1,2,7");
    }

    #[test]
    fn resolves_the_unified_cgroup_path_without_assuming_root_has_freezer() {
        assert_eq!(
            cgroup_v2_relative_path("0::/user.slice/example.scope\n"),
            Some("/user.slice/example.scope")
        );
        assert_eq!(cgroup_v2_relative_path("1:name=/legacy\n"), None);
    }
}
