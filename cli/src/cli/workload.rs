use std::os::unix::process::CommandExt;
use std::path::PathBuf;

use crate::extensions::manifest::{
    load_extension_manifest, WorkloadClass, WorkloadLifetime, MANIFEST_FILENAME,
};
use crate::resource::systemd::extension_slice_name;

pub fn capacity() -> Result<i32, String> {
    let topology = crate::resource::CpuTopology::detect();
    let protected = std::env::var("REMUX_RESOURCE_PROTECTED").as_deref() == Ok("1")
        || crate::resource::systemd::protected_mode_active();
    println!(
        "{}",
        serde_json::json!({
            "availableThreads": topology.logical_cpus.saturating_sub(topology.reserved_cpus.len()).max(1),
            "logicalCpus": topology.logical_cpus,
            "protected": protected,
            "reservedCpus": topology.reserved_cpus,
        })
    );
    Ok(0)
}

pub fn status(extension: Option<&str>) -> Result<i32, String> {
    let output = std::process::Command::new("systemctl")
        .args([
            "--user",
            "list-units",
            "remux-workload-*",
            "--all",
            "--no-legend",
            "--plain",
        ])
        .output()
        .map_err(|error| format!("systemctl failed to start: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if extension.is_none_or(|extension| line.contains(&format!("-{extension}-"))) {
            println!("{line}");
        }
    }
    Ok(0)
}

pub fn control(operation: &str, action: &str) -> Result<i32, String> {
    let needle = sanitize(operation);
    let output = std::process::Command::new("systemctl")
        .args([
            "--user",
            "list-units",
            "remux-workload-*",
            "--all",
            "--no-legend",
            "--plain",
        ])
        .output()
        .map_err(|error| format!("systemctl failed to start: {error}"))?;
    let units = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .filter(|unit| unit.contains(&needle))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if units.is_empty() {
        return Err(format!("no active workload matches operation {operation}"));
    }
    for unit in units {
        let output = std::process::Command::new("systemctl")
            .args(["--user", action, &unit])
            .output()
            .map_err(|error| format!("systemctl failed to start: {error}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }
    Ok(0)
}

pub fn exec(
    workload: &str,
    operation: &str,
    threads: Option<usize>,
    command: &[String],
) -> Result<i32, String> {
    if command.is_empty() {
        return Err("workload exec requires a command after --".to_string());
    }
    let extension_id = required_env("REMUX_EXTENSION_ID")?;
    let extension_root = PathBuf::from(required_env("REMUX_EXTENSION_ROOT")?);
    let manifest = load_extension_manifest(&extension_root.join(MANIFEST_FILENAME))?;
    if manifest.id != extension_id {
        return Err(format!(
            "workload owner mismatch: environment={extension_id} manifest={}",
            manifest.id
        ));
    }
    let spec = manifest.workloads.get(workload).ok_or_else(|| {
        format!(
            "unknown workload {workload} for {extension_id}; declared: {}",
            manifest
                .workloads
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    let logical_cpus = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    let threads = threads
        .or(spec.threads)
        .unwrap_or(logical_cpus)
        .clamp(1, logical_cpus);
    let protected = std::env::var("REMUX_RESOURCE_PROTECTED").as_deref() == Ok("1");
    if !protected
        && matches!(
            spec.class,
            WorkloadClass::Background | WorkloadClass::Research
        )
    {
        return Err(format!(
            "protected resource mode is unavailable; refusing {workload} workload"
        ));
    }

    let canonical_root = extension_root
        .canonicalize()
        .unwrap_or(extension_root)
        .to_string_lossy()
        .into_owned();
    let slice = extension_slice_name(&extension_id, &canonical_root);
    let class = match spec.class {
        WorkloadClass::Interactive => "interactive",
        WorkloadClass::Background => "background",
        WorkloadClass::Research => "research",
    };
    let weight = match spec.class {
        WorkloadClass::Interactive => 100,
        WorkloadClass::Background => 20,
        WorkloadClass::Research => 5,
    };
    let nice = match spec.class {
        WorkloadClass::Interactive => 0,
        WorkloadClass::Background => 10,
        WorkloadClass::Research => 15,
    };
    let lifetime = match spec.lifetime {
        WorkloadLifetime::Operation => "operation",
        WorkloadLifetime::Extension => "extension",
        WorkloadLifetime::Persistent => "persistent",
    };
    let unit = format!(
        "remux-workload-{}-{}-{}-{}-{}-{}",
        sanitize(&extension_id),
        sanitize(workload),
        class,
        lifetime,
        sanitize(operation),
        std::process::id(),
    );

    let mut process = if protected {
        let mut process = std::process::Command::new("systemd-run");
        process.args([
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            &format!("--unit={unit}"),
            &format!("--slice={slice}"),
            &format!("--property=CPUWeight={weight}"),
            &format!("--property=Nice={nice}"),
            "--",
            &command[0],
        ]);
        process.args(&command[1..]);
        process
    } else {
        let mut process = std::process::Command::new(&command[0]);
        process.args(&command[1..]);
        process
    };
    process.envs([
        ("REMUX_WORKLOAD_NAME", workload.to_string()),
        ("REMUX_WORKLOAD_OPERATION", operation.to_string()),
        ("REMUX_WORKLOAD_CLASS", class.to_string()),
        ("REMUX_WORKLOAD_LIFETIME", lifetime.to_string()),
        ("REMUX_WORKLOAD_THREADS", threads.to_string()),
        ("OMP_NUM_THREADS", threads.to_string()),
        ("OPENBLAS_NUM_THREADS", threads.to_string()),
        ("MKL_NUM_THREADS", threads.to_string()),
        ("NUMEXPR_NUM_THREADS", threads.to_string()),
        ("RAYON_NUM_THREADS", threads.to_string()),
        ("ORT_NUM_THREADS", threads.to_string()),
    ]);
    let error = process.exec();
    Err(format!("failed to exec workload command: {error}"))
}

fn required_env(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} is not set; workload exec must run inside an extension"))
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(40)
        .collect()
}
