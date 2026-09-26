//! Runtime-owned agent harness maintenance. All effects (including waiting and
//! filesystem work) cross injected seams; the timer and HTTP client share a run.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::{parse_window, AgentAutoupdateConfig};
use crate::rpc::router::{BoxFuture, RpcRouter};

const PACKAGE: &str = "extensions/agent/package.json";
const LOCKFILE: &str = "package-lock.json";
const SDK: &str = "@anthropic-ai/claude-agent-sdk";
const DIST: &str = "extensions/agent/server/dist";
const PREV: &str = "extensions/agent/server/dist.prev";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(600);
pub const READ_METHOD: &str = "remux/maintenance/agent-autoupdate/read";
/// `provider` as the agent extension registers it; the probe filters on this.
const CLAUDE_PROVIDER: &str = "claude-code";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "decision")]
pub enum RunOutcome {
    Skipped {
        stage: String,
        reason: String,
    },
    Deferred {
        stage: String,
        reason: String,
    },
    Upgraded {
        cli: String,
        sdk: String,
    },
    RolledBack {
        stage: String,
        error: String,
    },
    Held {
        target: String,
        attempts: u32,
        reason: String,
    },
    NoOp,
    Plan {
        cli: String,
        current: String,
        target: String,
        gates: Vec<String>,
        steps: Vec<String>,
    },
}

impl std::fmt::Display for RunOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Skipped { stage, reason } => write!(f, "Skipped at {stage}: {reason}"),
            Self::Deferred { stage, reason } => write!(f, "Deferred at {stage}: {reason}"),
            Self::Upgraded { cli, sdk } => write!(f, "Upgraded: Claude CLI {cli}, SDK {sdk}"),
            Self::RolledBack { stage, error } => write!(f, "Rolled back at {stage}: {error}"),
            Self::Held {
                target,
                attempts,
                reason,
            } => write!(
                f,
                "Holding SDK {target} after {attempts} failure(s): {reason}"
            ),
            Self::NoOp => write!(f, "No SDK change needed."),
            Self::Plan {
                cli,
                current,
                target,
                gates,
                steps,
            } => {
                writeln!(f, "Dry run: Claude CLI {cli}, SDK {current} → {target}")?;
                for gate in gates {
                    writeln!(f, "  Gate: {gate}")?;
                }
                for step in steps {
                    writeln!(f, "  {step}")?;
                }
                Ok(())
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hold {
    pub target: String,
    pub attempts: u32,
    pub reason: String,
    pub timestamp: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceState {
    pub last_run: Option<i64>,
    pub last_result: Option<RunOutcome>,
    pub last_defer_reason: Option<String>,
    pub installed_cli_version: Option<String>,
    pub pinned_sdk_version: Option<String>,
    pub hold: Option<Hold>,
    pub failure_target: Option<String>,
    pub consecutive_failures: u32,
    pub state_error: Option<String>,
    /// Version used to select the failed target, even if rollback re-points CLI.
    pub target_cli_version: Option<String>,
    /// Registry head at resolution, so a newly published release can lift a hold
    /// even when the CLI has also advanced since our last successful install.
    pub registry_version: Option<String>,
}

/// What the settings card reads: the persisted state plus the schedule the
/// driver is actually running under, so the card never has to read config.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceStatus {
    pub enabled: bool,
    pub window: String,
    pub in_window: bool,
    pub quiet_minutes: u32,
    #[serde(flatten)]
    pub state: MaintenanceState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quiescence {
    pub quiescent: bool,
    pub observed_at: i64,
    pub active_turns: u32,
    pub queued_messages: u32,
    pub compacting: u32,
    pub recovering: u32,
    pub active_sessions: u32,
    pub last_activity_at: Option<i64>,
    pub blockers: Vec<String>,
}

#[derive(Debug)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}
pub trait CommandRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        program: &'a str,
        args: &'a [&'a str],
        cwd: &'a Path,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<CommandOutput, String>>;
}
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
    fn local_minute(&self) -> u32;
    fn wait(&self, duration: Duration) -> BoxFuture<'_, ()>;
}
pub trait QuiescenceReader: Send + Sync {
    fn read(&self) -> BoxFuture<'_, Result<Quiescence, String>>;
}
pub trait ExtensionControl: Send + Sync {
    fn build_server(&self) -> BoxFuture<'_, Result<(), String>>;
    fn restart(&self) -> BoxFuture<'_, Result<(), String>>;
    /// Checks ready, a passing Claude provider probe, and nonempty model catalogs.
    fn status(&self) -> BoxFuture<'_, Result<(), String>>;
    /// Uses the codex extension's existing idle gate, never owns its daemon.
    fn activate_codex(&self) -> BoxFuture<'_, Result<String, String>>;
}
pub trait RegistryClient: Send + Sync {
    fn sdk_versions(&self) -> BoxFuture<'_, Result<Vec<String>, String>>;
}
pub trait StateStore: Send + Sync {
    fn load(&self) -> Result<MaintenanceState, String>;
    fn save(&self, state: &MaintenanceState) -> Result<(), String>;
}
/// Files are a separate seam so even rollback tests need no real filesystem.
pub trait Workspace: Send + Sync {
    fn pin(&self) -> Result<String, String>;
    fn previous_cli(&self) -> Result<PathBuf, String>;
    fn backup_dist(&self) -> BoxFuture<'_, Result<(), String>>;
    fn restore_dist(&self) -> BoxFuture<'_, Result<(), String>>;
    fn restore_cli<'a>(&'a self, previous: &'a Path) -> BoxFuture<'a, Result<(), String>>;
}
pub struct MaintenanceDeps {
    pub commands: Arc<dyn CommandRunner>,
    pub clock: Arc<dyn Clock>,
    pub quiescence: Arc<dyn QuiescenceReader>,
    pub extension: Arc<dyn ExtensionControl>,
    pub registry: Arc<dyn RegistryClient>,
    pub store: Arc<dyn StateStore>,
    pub workspace: Arc<dyn Workspace>,
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
}
pub struct Maintenance {
    root: PathBuf,
    config: AgentAutoupdateConfig,
    deps: MaintenanceDeps,
    state: Mutex<MaintenanceState>,
    running: tokio::sync::Mutex<()>,
}

impl Maintenance {
    pub fn new(root: PathBuf, config: AgentAutoupdateConfig, deps: MaintenanceDeps) -> Self {
        let state = deps.store.load().unwrap_or_else(|error| MaintenanceState {
            state_error: Some(error),
            ..Default::default()
        });
        Self {
            root,
            config,
            deps,
            state: Mutex::new(state),
            running: tokio::sync::Mutex::new(()),
        }
    }
    pub fn state(&self) -> MaintenanceState {
        self.state.lock().unwrap().clone()
    }
    pub fn status(&self) -> MaintenanceStatus {
        MaintenanceStatus {
            enabled: self.config.enabled(),
            window: self.config.window().to_string(),
            in_window: self.in_window(),
            quiet_minutes: self.config.quiet_minutes(),
            state: self.state(),
        }
    }
    pub async fn tick(&self) -> RunOutcome {
        self.run(false, false).await
    }
    pub async fn run_now(&self, dry_run: bool) -> RunOutcome {
        self.run(true, dry_run).await
    }
    /// HTTP without --now still observes the scheduled window.
    pub async fn run(&self, now: bool, dry_run: bool) -> RunOutcome {
        let Ok(_guard) = self.running.try_lock() else {
            let result = deferred("preconditions", "maintenance already running");
            self.log(&result.to_string());
            return result;
        };
        if !dry_run {
            self.state.lock().unwrap().last_defer_reason = None;
        }
        let outcome = self.execute(now, dry_run).await;
        self.log(&outcome.to_string());
        if !dry_run {
            let mut state = self.state.lock().unwrap();
            state.last_run = Some(self.deps.clock.now_ms());
            state.last_defer_reason = match &outcome {
                RunOutcome::Deferred { reason, .. } => Some(reason.clone()),
                _ => state.last_defer_reason.clone(),
            };
            state.last_result = Some(outcome.clone());
            if let Err(error) = self.deps.store.save(&state) {
                state.state_error = Some(error.clone());
                self.log(&format!("state: failed to save: {error}"));
                return skipped(
                    "state",
                    &format!("failed to persist result ({outcome}): {error}"),
                );
            }
        }
        outcome
    }
    fn log(&self, message: &str) {
        (self.deps.log)(&format!("agent-autoupdate: {message}"));
    }
    fn stage(&self, stage: &str) {
        self.log(&format!("{stage}: entering"));
    }
    fn in_window(&self) -> bool {
        parse_window(self.config.window())
            .map(|(start, end)| {
                let minute = self.deps.clock.local_minute();
                if minute >= 24 * 60 {
                    return false;
                }
                if start < end {
                    minute >= start && minute < end
                } else {
                    minute >= start || minute < end
                }
            })
            .unwrap_or(false)
    }
    async fn command(&self, program: &str, args: &[&str]) -> Result<String, String> {
        checked(self.deps.commands.as_ref(), program, args, &self.root).await
    }
    fn held(&self, hold: &Hold) -> RunOutcome {
        RunOutcome::Held {
            target: hold.target.clone(),
            attempts: hold.attempts,
            reason: hold.reason.clone(),
        }
    }
    async fn execute(&self, now: bool, dry_run: bool) -> RunOutcome {
        if !self.config.enabled() {
            return skipped("schedule", "agent_autoupdate is disabled");
        }
        if !now && !self.in_window() {
            return skipped("schedule", "outside maintenance window");
        }
        if let Some(error) = self.state().state_error {
            return skipped("state", &error);
        }

        // A held tick only reads the registry until a release changes.
        // Keep the hold if release discovery is unavailable.
        let held_state = self.state();
        if let Some(hold) = &held_state.hold {
            let changed = match self.deps.registry.sdk_versions().await {
                Ok(versions) => {
                    let cli = held_state
                        .target_cli_version
                        .as_deref()
                        .or(held_state.installed_cli_version.as_deref());
                    let compatible_changed = cli
                        .and_then(|cli| resolve_target(&versions, cli).ok())
                        .is_some_and(|target| target != hold.target);
                    let new_release =
                        held_state
                            .registry_version
                            .as_ref()
                            .is_some_and(|previous| {
                                latest_version(&versions)
                                    .as_ref()
                                    .is_some_and(|latest| latest != previous)
                            });
                    compatible_changed || new_release
                }
                Err(_) => false,
            };
            if !changed {
                return self.held(hold);
            }
            self.log("hold: registry changed; checking whether the compatible target changed");
        }
        if dry_run {
            return self.plan().await;
        }

        self.stage("1 preconditions");
        match self
            .command("git", &["status", "--porcelain", "--", PACKAGE, LOCKFILE])
            .await
        {
            Ok(status) if !status.is_empty() => {
                return skipped("preconditions", "watched package paths are dirty")
            }
            Err(error) => return skipped("preconditions", &error),
            _ => {}
        }
        // rev-parse works for normal repositories and linked worktrees.
        for marker in ["MERGE_HEAD", "rebase-merge", "rebase-apply"] {
            let path = match self
                .command("git", &["rev-parse", "--git-path", marker])
                .await
            {
                Ok(path) => path,
                Err(error) => return skipped("preconditions", &error),
            };
            match self
                .deps
                .commands
                .run("test", &["-e", &path], &self.root, COMMAND_TIMEOUT)
                .await
            {
                Ok(output) if output.code == 1 => {}
                Ok(output) if output.code == 0 => {
                    return skipped("preconditions", "merge or rebase in progress")
                }
                Ok(output) => return skipped("preconditions", &output.stderr),
                Err(error) => return skipped("preconditions", &error),
            }
        }
        // Refuse to mutate if durable state cannot be written.
        if let Err(error) = self.deps.store.save(&self.state()) {
            return skipped("state", &error);
        }
        let previous = match self.deps.workspace.previous_cli() {
            Ok(previous) => previous,
            Err(error) => return skipped("preconditions", &error),
        };
        self.stage("2 install CLIs");
        // Both installers run even if the first fails; neither is idle-gated.
        let claude = self.command("claude", &["update"]).await;
        let codex = self.command("codex", &["update"]).await;
        let cli = match self.command("claude", &["--version"]).await {
            Ok(cli) => cli,
            Err(error) => return skipped("install", &error),
        };
        {
            let mut state = self.state.lock().unwrap();
            state.installed_cli_version = Some(cli.clone());
            state.target_cli_version = Some(cli.clone());
        }
        if let Err(error) = claude.and(codex) {
            return skipped("install", &error);
        }

        self.stage("3 resolve target");
        let versions = match self.deps.registry.sdk_versions().await {
            Ok(versions) => versions,
            Err(error) => return skipped("resolve", &error),
        };
        self.state.lock().unwrap().registry_version = latest_version(&versions);
        let target = match resolve_target(&versions, &cli) {
            Ok(target) => target,
            Err(error) => return skipped("resolve", &error),
        };
        if let Some(hold) = self.state().hold {
            if hold.target == target {
                return self.held(&hold);
            }
        }
        let current = match self.deps.workspace.pin() {
            Ok(pin) => pin,
            Err(error) => return skipped("resolve", &error),
        };
        {
            let mut state = self.state.lock().unwrap();
            state.pinned_sdk_version = Some(current.clone());
            if state.failure_target.as_deref() != Some(&target) {
                state.failure_target = Some(target.clone());
                state.consecutive_failures = 0;
                state.hold = None;
            }
        }
        if current == target {
            self.log("9 commit: skipped; pin is unchanged");
            self.activate_codex().await;
            self.clear_failures();
            return RunOutcome::NoOp;
        }
        self.log(&format!(
            "3 resolve: CLI {cli}, pin {current}, target {target}"
        ));
        self.stage("4 pin and install SDK");
        if let Err(error) = self
            .command(
                "npm",
                &[
                    "install",
                    &format!("{SDK}@{target}"),
                    "--workspace",
                    "@remux/agent",
                ],
            )
            .await
        {
            return self
                .fail(&target, "install SDK", error, false, false, &previous)
                .await;
        }
        match self.deps.workspace.pin() {
            Ok(pin) if pin == target => {}
            Ok(pin) => {
                return self
                    .fail(
                        &target,
                        "pin",
                        format!("expected exact SDK pin {target}, got {pin}"),
                        false,
                        false,
                        &previous,
                    )
                    .await
            }
            Err(error) => {
                return self
                    .fail(&target, "pin", error, false, false, &previous)
                    .await
            }
        }
        self.stage("5 verify sources");
        for script in ["typecheck", "test:agent-server"] {
            if let Err(error) = self.command("npm", &["run", script]).await {
                return self
                    .fail(&target, script, error, false, false, &previous)
                    .await;
            }
        }
        self.stage("6 quiescence");
        let mut quiet_since = self.deps.clock.now_ms();
        loop {
            if !now && !self.in_window() {
                return self
                    .defer_restore(
                        &target,
                        "window closed waiting for quiescence",
                        false,
                        &previous,
                    )
                    .await;
            }
            match self.quiet(&mut quiet_since).await {
                Ok(()) => break,
                Err(reason) if now => {
                    return self.defer_restore(&target, &reason, false, &previous).await
                }
                Err(reason) => self.log(&format!("6 quiescence: waiting: {reason}")),
            }
            self.deps.clock.wait(Duration::from_secs(30)).await;
        }
        self.stage("7 backup and build");
        if let Err(error) = self.deps.workspace.backup_dist().await {
            return self
                .fail(&target, "backup", error, false, false, &previous)
                .await;
        }
        if let Err(error) = self.deps.extension.build_server().await {
            return self
                .fail(&target, "build", error, true, false, &previous)
                .await;
        }
        self.stage("8 activate and probe");
        if !now && !self.in_window() {
            return self
                .defer_restore(&target, "window closed before activation", true, &previous)
                .await;
        }
        if let Err(reason) = self.quiet(&mut quiet_since).await {
            return self.defer_restore(&target, &reason, true, &previous).await;
        }
        if let Err(error) = self.deps.extension.restart().await {
            return self
                .fail(&target, "restart", error, true, true, &previous)
                .await;
        }
        if let Err(error) = self.deps.extension.status().await {
            return self
                .fail(&target, "probe", error, true, true, &previous)
                .await;
        }
        self.log("8 probe: passed");
        self.stage("9 commit");
        if self.config.commit() {
            // --only leaves unrelated staged work out of this commit.
            if let Err(error) = self
                .command(
                    "git",
                    &[
                        "commit",
                        "--only",
                        "-m",
                        &format!("chore(agent): bump claude-agent-sdk to {target}"),
                        "--",
                        PACKAGE,
                        LOCKFILE,
                    ],
                )
                .await
            {
                // Activation passed; a commit failure must not revert the live
                // code or undo a commit that a hook may already have created.
                self.state.lock().unwrap().pinned_sdk_version = Some(target.clone());
                return self.failure(&target, "commit", error, true);
            }
        } else {
            self.log("9 commit: disabled");
        }
        self.state.lock().unwrap().pinned_sdk_version = Some(target.clone());
        self.clear_failures();
        self.activate_codex().await;
        RunOutcome::Upgraded { cli, sdk: target }
    }

    async fn quiet(&self, quiet_since: &mut i64) -> Result<(), String> {
        let q = match self.deps.quiescence.read().await {
            Ok(q) => q,
            Err(error) => {
                *quiet_since = self.deps.clock.now_ms();
                return Err(error);
            }
        };
        if !q.quiescent
            || q.active_turns > 0
            || q.queued_messages > 0
            || q.compacting > 0
            || q.recovering > 0
            || !q.blockers.is_empty()
        {
            *quiet_since = self.deps.clock.now_ms();
            return Err(format!("agent is busy: {}", q.blockers.join(", ")));
        }
        let now = self.deps.clock.now_ms();
        if q.observed_at > now || now.saturating_sub(q.observed_at) > 60_000 {
            *quiet_since = now;
            return Err("quiescence observation is stale".to_string());
        }
        // With no recorded activity, observe a whole quiet period from the
        // first observation of this run, not from an invented epoch.
        let last = q.last_activity_at.unwrap_or(*quiet_since);
        if last > now || now.saturating_sub(last) < i64::from(self.config.quiet_minutes()) * 60_000
        {
            return Err("quiet period has not elapsed".to_string());
        }
        Ok(())
    }
    async fn plan(&self) -> RunOutcome {
        self.stage("dry run: read-only plan");
        let cli = match self.command("claude", &["--version"]).await {
            Ok(cli) => cli,
            Err(error) => return skipped("resolve", &error),
        };
        let target = match self
            .deps
            .registry
            .sdk_versions()
            .await
            .and_then(|v| resolve_target(&v, &cli))
        {
            Ok(target) => target,
            Err(error) => return skipped("resolve", &error),
        };
        let current = match self.deps.workspace.pin() {
            Ok(pin) => pin,
            Err(error) => return skipped("resolve", &error),
        };
        let mut quiet_since = self.deps.clock.now_ms();
        let quiet = match self.quiet(&mut quiet_since).await {
            Ok(()) => "quiescence and quiet period pass".to_string(),
            Err(reason) => format!("activation blocked: {reason}"),
        };
        let mut steps = vec![
            "Update Claude, then Codex; re-resolve target from the resulting CLI version."
                .to_string(),
        ];
        if target == current {
            steps.push("Current pin already matches; skip SDK build/restart/commit.".to_string());
        } else {
            steps.extend([
                format!("Install {SDK}@{target} in workspace @remux/agent."),
                "Run typecheck and test:agent-server before touching dist.".to_string(),
                "Wait for quiescence, copy dist to dist.prev, build server.".to_string(),
                "Re-check quiescence, restart agent, probe provider and models.".to_string(),
                if self.config.commit() {
                    format!("Commit only {PACKAGE} and {LOCKFILE} after passing probe; no push.")
                } else {
                    "Leave verified pin changes uncommitted (commit=false).".to_string()
                },
            ]);
        }
        steps.push(
            "Ask the codex extension to activate if restartRequired; its idle gate decides."
                .to_string(),
        );
        RunOutcome::Plan { cli, current, target, gates: vec![
            "Git cleanliness and merge/rebase gates are checked on execution (dry run invokes no git).".to_string(),
            quiet,
        ], steps }
    }
    async fn restore_pin(&self) -> Result<(), String> {
        self.command("git", &["checkout", "--", PACKAGE, LOCKFILE])
            .await?;
        self.command("npm", &["install", "--workspace", "@remux/agent"])
            .await?;
        let pin = self.deps.workspace.pin()?;
        self.state.lock().unwrap().pinned_sdk_version = Some(pin);
        Ok(())
    }
    async fn rollback(&self, dist: bool, activate: bool, previous: &Path) -> Result<(), String> {
        let mut errors = Vec::new();
        if dist {
            if let Err(error) = self.deps.workspace.restore_dist().await {
                errors.push(format!("dist: {error}"));
            }
        }
        if let Err(error) = self.restore_pin().await {
            errors.push(format!("pin: {error}"));
        }
        if activate {
            match self.deps.workspace.restore_cli(previous).await {
                Err(error) => errors.push(format!("CLI: {error}")),
                Ok(()) => {
                    self.state.lock().unwrap().installed_cli_version = previous
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(str::to_string);
                }
            }
            if let Err(error) = self.deps.extension.restart().await {
                errors.push(format!("restart: {error}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    async fn fail(
        &self,
        target: &str,
        stage: &str,
        mut error: String,
        dist: bool,
        activate: bool,
        previous: &Path,
    ) -> RunOutcome {
        self.log(&format!("{stage}: failed: {error}; restoring"));
        let rollback = self.rollback(dist, activate, previous).await;
        let hold = activate || rollback.is_err();
        if let Err(restore_error) = rollback {
            error.push_str(&format!("; restore failed: {restore_error}"));
        }
        self.failure(target, stage, error, hold)
    }
    fn failure(
        &self,
        target: &str,
        stage: &str,
        error: String,
        immediate_hold: bool,
    ) -> RunOutcome {
        let mut state = self.state.lock().unwrap();
        if state.failure_target.as_deref() != Some(target) {
            state.consecutive_failures = 0;
        }
        state.failure_target = Some(target.to_string());
        state.consecutive_failures += 1;
        if immediate_hold || state.consecutive_failures >= 3 {
            let hold = Hold {
                target: target.to_string(),
                attempts: state.consecutive_failures,
                reason: format!("{stage}: {error}"),
                timestamp: self.deps.clock.now_ms(),
            };
            let outcome = self.held(&hold);
            state.hold = Some(hold);
            outcome
        } else {
            RunOutcome::RolledBack {
                stage: stage.to_string(),
                error,
            }
        }
    }
    async fn defer_restore(
        &self,
        target: &str,
        reason: &str,
        dist: bool,
        previous: &Path,
    ) -> RunOutcome {
        self.log(&format!("quiescence: {reason}; restoring"));
        match self.rollback(dist, false, previous).await {
            Ok(()) => deferred("quiescence", reason),
            Err(error) => self.failure(target, "restore", error, true),
        }
    }
    fn clear_failures(&self) {
        let mut state = self.state.lock().unwrap();
        state.failure_target = None;
        state.consecutive_failures = 0;
        state.hold = None;
    }
    async fn activate_codex(&self) {
        self.stage("10 Codex activation");
        match self.deps.extension.activate_codex().await {
            Ok(message) => self.log(&format!("10 Codex activation: {message}")),
            Err(error) => {
                self.log(&format!("10 Codex activation: deferred: {error}"));
                self.state.lock().unwrap().last_defer_reason =
                    Some(format!("Codex activation: {error}"));
            }
        }
    }
}

fn skipped(stage: &str, reason: &str) -> RunOutcome {
    RunOutcome::Skipped {
        stage: stage.to_string(),
        reason: reason.to_string(),
    }
}
fn deferred(stage: &str, reason: &str) -> RunOutcome {
    RunOutcome::Deferred {
        stage: stage.to_string(),
        reason: reason.to_string(),
    }
}

/// Published stable versions only: prerelease wire schemas are not unattended targets.
fn version(value: &str) -> Option<(u32, u32, u32)> {
    let mut parts = value.split('.');
    let parse = |s: &str| {
        if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
            s.parse().ok()
        } else {
            None
        }
    };
    let result = (
        parse(parts.next()?)?,
        parse(parts.next()?)?,
        parse(parts.next()?)?,
    );
    parts.next().is_none().then_some(result)
}
fn latest_version(versions: &[String]) -> Option<String> {
    versions
        .iter()
        .filter_map(|v| version(v).map(|n| (n, v)))
        .max_by_key(|(n, _)| *n)
        .map(|(_, v)| v.clone())
}
fn resolve_target(versions: &[String], cli: &str) -> Result<String, String> {
    let cli = cli
        .split_whitespace()
        .find_map(version)
        .ok_or_else(|| format!("invalid Claude CLI version: {cli}"))?;
    versions
        .iter()
        .filter_map(|v| version(v).map(|n| (n, v)))
        .filter(|(n, _)| n.2 <= cli.2)
        .max_by_key(|(n, _)| *n)
        .map(|(_, v)| v.clone())
        .ok_or_else(|| "no SDK version compatible with installed Claude CLI".to_string())
}

async fn checked(
    runner: &dyn CommandRunner,
    program: &str,
    args: &[&str],
    cwd: &Path,
) -> Result<String, String> {
    let output = runner.run(program, args, cwd, COMMAND_TIMEOUT).await?;
    if output.code != 0 {
        return Err(format!(
            "{program} {} failed ({}): {}",
            args.join(" "),
            output.code,
            output.stderr.trim()
        ));
    }
    Ok(output.stdout.trim().to_string())
}

// Production adapters. The driver above never reaches directly into the host.
struct ProcessRunner {
    registry: String,
}
impl CommandRunner for ProcessRunner {
    fn run<'a>(
        &'a self,
        program: &'a str,
        args: &'a [&'a str],
        cwd: &'a Path,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<CommandOutput, String>> {
        Box::pin(async move {
            let mut command = tokio::process::Command::new(program);
            command.args(args).current_dir(cwd).kill_on_drop(true);
            if program == "npm" {
                command.env("npm_config_save_exact", "true");
                command.env("npm_config_registry", &self.registry);
            }
            // Kill the whole command group on timeout, including npm's children.
            command.process_group(0);
            command
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let child = command
                .spawn()
                .map_err(|error| format!("{program}: {error}"))?;
            let pid = child.id();
            let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
                Ok(output) => output.map_err(|error| format!("{program}: {error}"))?,
                Err(_) => {
                    if let Some(pid) = pid {
                        let _ = nix::sys::signal::killpg(
                            nix::unistd::Pid::from_raw(pid as i32),
                            nix::sys::signal::Signal::SIGKILL,
                        );
                    }
                    return Err(format!("{program}: timed out after {}s", timeout.as_secs()));
                }
            };
            Ok(CommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                code: output.status.code().unwrap_or(-1),
            })
        })
    }
}
struct LocalClock;
impl Clock for LocalClock {
    fn now_ms(&self) -> i64 {
        crate::time::now_ms()
    }
    fn local_minute(&self) -> u32 {
        let seconds = (self.now_ms() / 1000) as nix::libc::time_t;
        let mut local = std::mem::MaybeUninit::<nix::libc::tm>::uninit();
        // localtime_r writes a caller-owned tm and honors the host timezone.
        unsafe {
            if nix::libc::localtime_r(&seconds, local.as_mut_ptr()).is_null() {
                return u32::MAX;
            }
            let local = local.assume_init();
            local.tm_hour as u32 * 60 + local.tm_min as u32
        }
    }
    fn wait(&self, duration: Duration) -> BoxFuture<'_, ()> {
        Box::pin(tokio::time::sleep(duration))
    }
}
struct NpmRegistry {
    base: String,
}
impl RegistryClient for NpmRegistry {
    fn sdk_versions(&self) -> BoxFuture<'_, Result<Vec<String>, String>> {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| format!("registry: {error}"))?;
            let response: Value = client
                .get(format!(
                    "{}/@anthropic-ai%2fclaude-agent-sdk",
                    self.base.trim_end_matches('/')
                ))
                .send()
                .await
                .map_err(|error| format!("registry: {error}"))?
                .error_for_status()
                .map_err(|error| format!("registry: {error}"))?
                .json()
                .await
                .map_err(|error| format!("registry: {error}"))?;
            response
                .get("versions")
                .and_then(Value::as_object)
                .map(|v| v.keys().cloned().collect())
                .ok_or_else(|| "registry: missing versions".to_string())
        })
    }
}
struct JsonStateStore {
    path: PathBuf,
}
impl StateStore for JsonStateStore {
    fn load(&self) -> Result<MaintenanceState, String> {
        match std::fs::read(&self.path) {
            Ok(data) => serde_json::from_slice(&data)
                .map_err(|error| format!("{}: {error}", self.path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(MaintenanceState::default())
            }
            Err(error) => Err(format!("{}: {error}", self.path.display())),
        }
    }
    fn save(&self, state: &MaintenanceState) -> Result<(), String> {
        use std::io::Write;
        let write = || -> Result<(), Box<dyn std::error::Error>> {
            let parent = self.path.parent().ok_or("state path has no parent")?;
            std::fs::create_dir_all(parent)?;
            let mut file = tempfile::NamedTempFile::new_in(parent)?;
            file.write_all(&serde_json::to_vec_pretty(state)?)?;
            file.as_file().sync_all()?;
            file.persist(&self.path)?;
            std::fs::File::open(parent)?.sync_all()?;
            Ok(())
        };
        write().map_err(|error| format!("{}: {error}", self.path.display()))
    }
}
struct HostWorkspace {
    root: PathBuf,
    home: PathBuf,
    commands: Arc<dyn CommandRunner>,
}
impl Workspace for HostWorkspace {
    fn pin(&self) -> Result<String, String> {
        let path = self.root.join(PACKAGE);
        let package: Value = serde_json::from_slice(
            &std::fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?,
        )
        .map_err(|error| format!("{}: {error}", path.display()))?;
        package
            .get("dependencies")
            .and_then(|v| v.get(SDK))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("{PACKAGE}: missing dependency {SDK}"))
    }
    fn previous_cli(&self) -> Result<PathBuf, String> {
        let link = self.home.join(".local/bin/claude");
        let path =
            std::fs::canonicalize(&link).map_err(|error| format!("{}: {error}", link.display()))?;
        let versions = std::fs::canonicalize(self.home.join(".local/share/claude/versions"))
            .map_err(|error| format!("Claude versions: {error}"))?;
        if path.parent() != Some(versions.as_path()) {
            return Err(
                "Claude executable is not an entry in ~/.local/share/claude/versions".to_string(),
            );
        }
        Ok(path)
    }
    fn backup_dist(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            checked(
                self.commands.as_ref(),
                "rm",
                &["-rf", "--", PREV],
                &self.root,
            )
            .await?;
            checked(
                self.commands.as_ref(),
                "cp",
                &["-a", "--", DIST, PREV],
                &self.root,
            )
            .await?;
            Ok(())
        })
    }
    fn restore_dist(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            checked(
                self.commands.as_ref(),
                "rm",
                &["-rf", "--", DIST],
                &self.root,
            )
            .await?;
            checked(
                self.commands.as_ref(),
                "cp",
                &["-a", "--", PREV, DIST],
                &self.root,
            )
            .await?;
            Ok(())
        })
    }
    fn restore_cli<'a>(&'a self, previous: &'a Path) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let link = self.home.join(".local/bin/claude");
            checked(
                self.commands.as_ref(),
                "ln",
                &[
                    "-sfn",
                    "--",
                    &previous.to_string_lossy(),
                    &link.to_string_lossy(),
                ],
                &self.root,
            )
            .await?;
            Ok(())
        })
    }
}
struct RuntimeExtension {
    router: Arc<RpcRouter>,
}
impl RuntimeExtension {
    async fn rpc(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        tokio::time::timeout(
            COMMAND_TIMEOUT,
            self.router.handle_request(method, params.as_ref()),
        )
        .await
        .map_err(|_| format!("{method}: timed out"))?
        .map_err(|error| format!("{method}: {}", error.message))
    }
    async fn probe_once(&self) -> Result<(), String> {
        let status = self.rpc("remux/extensions/status", None).await?;
        let ready = status
            .get("extensions")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("extensionId").and_then(Value::as_str) == Some("agent")
                        && item.get("state").and_then(Value::as_str) == Some("running")
                })
            });
        if !ready {
            return Err("agent extension is not ready".to_string());
        }
        // Startup probes call adapter.probe() followed by listModels().
        // Read their actual projected results rather than trusting stdio ready.
        let resource = self.resource("agent/providers").await?;
        let providers = resource
            .get("providers")
            .and_then(Value::as_array)
            .ok_or("agent providers catalog missing")?;
        // The registration id is `claude-code` (see `main.ts`), not `claude`.
        let claude: Vec<_> = providers
            .iter()
            .filter(|p| p.get("provider").and_then(Value::as_str) == Some(CLAUDE_PROVIDER))
            .collect();
        if claude.is_empty() {
            return Err("Claude provider missing".to_string());
        }
        for provider in claude {
            if provider.get("state").and_then(Value::as_str) != Some("ready") {
                return Err(format!("Claude provider probe failed: {provider}"));
            }
            let id = provider
                .get("providerInstanceId")
                .and_then(Value::as_str)
                .ok_or("Claude provider id missing")?;
            let models = self.resource(&format!("agent/models:{id}")).await?;
            if !models
                .get("models")
                .and_then(Value::as_array)
                .is_some_and(|models| !models.is_empty())
            {
                return Err(format!("Claude model catalog empty: {id}"));
            }
        }
        Ok(())
    }
    async fn resource(&self, key: &str) -> Result<Value, String> {
        let result = self
            .rpc(
                "remux/agent/resources/read",
                Some(json!({"requests": [{"key": key}]})),
            )
            .await?;
        result
            .get("resources")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("key").and_then(Value::as_str) == Some(key)
                        && item.get("status").and_then(Value::as_str) == Some("ok")
                })
            })
            .and_then(|item| item.get("value"))
            .cloned()
            .ok_or_else(|| format!("agent resource missing: {key}"))
    }
}
impl QuiescenceReader for RuntimeExtension {
    fn read(&self) -> BoxFuture<'_, Result<Quiescence, String>> {
        Box::pin(async move {
            serde_json::from_value(
                self.rpc("remux/agent/maintenance/quiescence/read", None)
                    .await?,
            )
            .map_err(|error| format!("quiescence: {error}"))
        })
    }
}
impl ExtensionControl for RuntimeExtension {
    fn build_server(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.rpc(
                "remux/extensions/server/build",
                Some(json!({"extensionId": "agent"})),
            )
            .await?;
            Ok(())
        })
    }
    fn restart(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let status = self
                .rpc(
                    "remux/extensions/restart",
                    Some(json!({"extensionId": "agent", "rebuild": false})),
                )
                .await?;
            if status.get("state").and_then(Value::as_str) != Some("running") {
                return Err(format!("agent restart did not reach ready: {status}"));
            }
            Ok(())
        })
    }
    fn status(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let mut last_error = "agent provider initialization timed out".to_string();
            let result = tokio::time::timeout(Duration::from_secs(60), async {
                loop {
                    match self.probe_once().await {
                        Ok(()) => return,
                        Err(error) => last_error = error,
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            })
            .await;
            result.map_err(|_| last_error)
        })
    }
    fn activate_codex(&self) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move {
            let status = self.rpc("remux/codex/app-server/status/read", None).await?;
            if status.get("restartRequired").and_then(Value::as_bool) != Some(true) {
                return Ok("no restart required".to_string());
            }
            // Do not reproduce the idle predicate: this RPC owns that gate,
            // including reconciliation and a fresh check immediately at restart.
            self.rpc("remux/codex/app-server/restart", None).await?;
            Ok("restarted through Codex idle gate".to_string())
        })
    }
}
pub fn production(
    root: PathBuf,
    config: AgentAutoupdateConfig,
    router: Arc<RpcRouter>,
    journal: Arc<crate::logs::Journal>,
) -> Arc<Maintenance> {
    let commands: Arc<dyn CommandRunner> = Arc::new(ProcessRunner {
        registry: config.registry().to_string(),
    });
    let extension = Arc::new(RuntimeExtension { router });
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    Arc::new(Maintenance::new(
        root.clone(),
        config.clone(),
        MaintenanceDeps {
            commands: commands.clone(),
            clock: Arc::new(LocalClock),
            quiescence: extension.clone(),
            extension,
            registry: Arc::new(NpmRegistry {
                base: config.registry().to_string(),
            }),
            store: Arc::new(JsonStateStore {
                path: root.join(".remux/maintenance/agent-autoupdate.json"),
            }),
            workspace: Arc::new(HostWorkspace {
                root,
                home,
                commands,
            }),
            log: Arc::new(move |message| journal.log(message)),
        },
    ))
}

/// A failed decision never terminates the timer; missed ticks are not replayed.
pub fn start(maintenance: Arc<Maintenance>, minutes: u32) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs(u64::from(minutes.max(1)) * 60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Delay the first tick too, so extension startup can complete.
        interval.tick().await;
        loop {
            interval.tick().await;
            maintenance.tick().await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Fake {
        inner: Mutex<FakeState>,
    }
    struct FakeState {
        events: Vec<String>,
        mutations: Vec<String>,
        dirty: String,
        merge: bool,
        fail: Option<String>,
        fail_restore: bool,
        pin: String,
        cli: String,
        versions: Vec<String>,
        quiescence: VecDeque<Result<Quiescence, String>>,
        now: i64,
        minute: u32,
        close_on_wait: bool,
        reads: usize,
        save_error: bool,
        saved: MaintenanceState,
    }
    impl Fake {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                inner: Mutex::new(FakeState {
                    events: vec![],
                    mutations: vec![],
                    dirty: String::new(),
                    merge: false,
                    fail: None,
                    fail_restore: false,
                    pin: "0.3.258".into(),
                    cli: "2.1.283 (Claude Code)".into(),
                    versions: vec!["0.3.280".into()],
                    quiescence: VecDeque::new(),
                    now: 2_000_000,
                    minute: 240,
                    close_on_wait: false,
                    reads: 0,
                    save_error: false,
                    saved: MaintenanceState::default(),
                }),
            })
        }
        fn change(&self, f: impl FnOnce(&mut FakeState)) {
            f(&mut self.inner.lock().unwrap());
        }
        fn events(&self) -> Vec<String> {
            self.inner.lock().unwrap().events.clone()
        }
        fn event(&self, event: &str, mutating: bool) -> Result<(), String> {
            let mut s = self.inner.lock().unwrap();
            s.events.push(event.to_string());
            if mutating {
                s.mutations.push(event.to_string());
            }
            if s.fail.as_deref() == Some(event) {
                Err(format!("injected {event} failure"))
            } else {
                Ok(())
            }
        }
        fn make(self: &Arc<Self>, config: AgentAutoupdateConfig) -> Maintenance {
            Maintenance::new(
                PathBuf::from("/fake/repo"),
                config,
                MaintenanceDeps {
                    commands: self.clone(),
                    clock: self.clone(),
                    quiescence: self.clone(),
                    extension: self.clone(),
                    registry: self.clone(),
                    store: self.clone(),
                    workspace: self.clone(),
                    log: Arc::new(|_| {}),
                },
            )
        }
    }
    fn quiet(now: i64) -> Quiescence {
        Quiescence {
            quiescent: true,
            observed_at: now,
            active_turns: 0,
            queued_messages: 0,
            compacting: 0,
            recovering: 0,
            active_sessions: 3,
            last_activity_at: Some(0),
            blockers: vec![],
        }
    }
    fn busy(now: i64) -> Quiescence {
        Quiescence {
            quiescent: false,
            active_turns: 1,
            blockers: vec!["active turn".into()],
            ..quiet(now)
        }
    }
    impl CommandRunner for Fake {
        fn run<'a>(
            &'a self,
            program: &'a str,
            args: &'a [&'a str],
            cwd: &'a Path,
            _: Duration,
        ) -> BoxFuture<'a, Result<CommandOutput, String>> {
            Box::pin(async move {
                assert_eq!(cwd, Path::new("/fake/repo"));
                let label = format!("{program} {}", args.join(" "));
                let mutating = !matches!(
                    (program, args.first().copied()),
                    ("git", Some("status" | "rev-parse"))
                        | ("test", _)
                        | ("claude", Some("--version"))
                );
                let result = self.event(&label, mutating);
                let mut s = self.inner.lock().unwrap();
                let mut code = if result.is_err() { 1 } else { 0 };
                let mut stdout = String::new();
                match (program, args.first().copied()) {
                    ("git", Some("status")) => stdout = s.dirty.clone(),
                    ("git", Some("rev-parse")) => stdout = args[2].to_string(),
                    ("test", _) => code = if s.merge { 0 } else { 1 },
                    ("claude", Some("--version")) => stdout = s.cli.clone(),
                    ("npm", Some("install")) if args.get(1).is_some_and(|s| s.starts_with(SDK)) => {
                        s.pin = args[1].rsplit('@').next().unwrap().to_string();
                    }
                    ("git", Some("checkout")) => {
                        assert_eq!(args, ["checkout", "--", PACKAGE, LOCKFILE]);
                        s.pin = "0.3.258".into();
                        if s.fail_restore {
                            code = 1;
                        }
                    }
                    ("git", Some("commit")) => {
                        assert_eq!(&args[args.len() - 3..], ["--", PACKAGE, LOCKFILE]);
                        assert!(args.contains(&"--only"));
                        assert!(s.events.iter().any(|e| e == "probe"));
                    }
                    _ => {}
                }
                Ok(CommandOutput {
                    stdout,
                    stderr: result.err().unwrap_or_default(),
                    code,
                })
            })
        }
    }
    impl Clock for Fake {
        fn now_ms(&self) -> i64 {
            self.inner.lock().unwrap().now
        }
        fn local_minute(&self) -> u32 {
            self.inner.lock().unwrap().minute
        }
        fn wait(&self, duration: Duration) -> BoxFuture<'_, ()> {
            Box::pin(async move {
                self.change(|s| {
                    s.events.push("wait".into());
                    s.now += duration.as_millis() as i64;
                    if s.close_on_wait {
                        s.minute = 360;
                    }
                });
            })
        }
    }
    impl QuiescenceReader for Fake {
        fn read(&self) -> BoxFuture<'_, Result<Quiescence, String>> {
            Box::pin(async move {
                self.event("quiescence", false)?;
                let mut s = self.inner.lock().unwrap();
                s.reads += 1;
                s.quiescence.pop_front().unwrap_or_else(|| Ok(quiet(s.now)))
            })
        }
    }
    impl ExtensionControl for Fake {
        fn build_server(&self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async { self.event("build", true) })
        }
        fn restart(&self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async { self.event("restart", true) })
        }
        fn status(&self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async { self.event("probe", false) })
        }
        fn activate_codex(&self) -> BoxFuture<'_, Result<String, String>> {
            Box::pin(async {
                self.event("codex activate", true)?;
                Ok("idle gate".into())
            })
        }
    }
    impl RegistryClient for Fake {
        fn sdk_versions(&self) -> BoxFuture<'_, Result<Vec<String>, String>> {
            Box::pin(async {
                self.event("registry", false)?;
                Ok(self.inner.lock().unwrap().versions.clone())
            })
        }
    }
    impl StateStore for Fake {
        fn load(&self) -> Result<MaintenanceState, String> {
            Ok(self.inner.lock().unwrap().saved.clone())
        }
        fn save(&self, state: &MaintenanceState) -> Result<(), String> {
            let mut s = self.inner.lock().unwrap();
            s.mutations.push("save".into());
            if s.save_error {
                return Err("state unwritable".into());
            }
            s.saved = state.clone();
            Ok(())
        }
    }
    impl Workspace for Fake {
        fn pin(&self) -> Result<String, String> {
            self.event("read pin", false)?;
            Ok(self.inner.lock().unwrap().pin.clone())
        }
        fn previous_cli(&self) -> Result<PathBuf, String> {
            self.event("previous CLI", false)?;
            Ok(PathBuf::from(
                "/fake/home/.local/share/claude/versions/2.1.258",
            ))
        }
        fn backup_dist(&self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async { self.event("backup dist", true) })
        }
        fn restore_dist(&self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async { self.event("restore dist.prev", true) })
        }
        fn restore_cli<'a>(&'a self, previous: &'a Path) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                assert_eq!(
                    previous,
                    Path::new("/fake/home/.local/share/claude/versions/2.1.258")
                );
                self.event("restore CLI symlink", true)
            })
        }
    }
    fn assert_no_build_restart(fake: &Fake) {
        assert!(!fake
            .events()
            .iter()
            .any(|e| matches!(e.as_str(), "build" | "restart" | "backup dist")));
    }
    fn assert_pin_restored(fake: &Fake) {
        let events = fake.events();
        let checkout = events
            .iter()
            .position(|e| e == &format!("git checkout -- {PACKAGE} {LOCKFILE}"))
            .unwrap();
        assert_eq!(events[checkout + 1], "npm install --workspace @remux/agent");
        assert_eq!(fake.inner.lock().unwrap().pin, "0.3.258");
    }

    #[tokio::test]
    async fn dirty_either_path_stops_before_any_other_operation() {
        for path in [PACKAGE, LOCKFILE] {
            let fake = Fake::new();
            fake.change(|s| s.dirty = format!(" M {path}"));
            let result = fake.make(Default::default()).tick().await;
            assert!(matches!(result, RunOutcome::Skipped { .. }));
            assert_eq!(
                fake.events(),
                [format!("git status --porcelain -- {PACKAGE} {LOCKFILE}")]
            );
        }
    }
    #[tokio::test]
    async fn merge_or_rebase_skips_without_installing() {
        let fake = Fake::new();
        fake.change(|s| s.merge = true);
        assert!(matches!(
            fake.make(Default::default()).tick().await,
            RunOutcome::Skipped { .. }
        ));
        assert!(!fake.events().iter().any(|e| e == "claude update"));
    }
    #[tokio::test]
    async fn unchanged_pin_is_noop_but_checks_codex_activation() {
        let fake = Fake::new();
        fake.change(|s| s.pin = "0.3.280".into());
        assert_eq!(fake.make(Default::default()).tick().await, RunOutcome::NoOp);
        assert_no_build_restart(&fake);
        assert!(fake.events().contains(&"codex activate".into()));
        assert!(!fake.events().iter().any(|e| e.starts_with("git commit")));
    }
    #[tokio::test]
    async fn source_gates_restore_without_touching_artifacts() {
        for script in ["typecheck", "test:agent-server"] {
            let fake = Fake::new();
            fake.change(|s| s.fail = Some(format!("npm run {script}")));
            assert!(
                matches!(fake.make(Default::default()).tick().await, RunOutcome::RolledBack { stage, .. } if stage == script)
            );
            assert_pin_restored(&fake);
            assert_no_build_restart(&fake);
        }
    }
    #[tokio::test]
    async fn window_closes_while_waiting_and_restores_pin() {
        let fake = Fake::new();
        fake.change(|s| {
            s.close_on_wait = true;
            s.quiescence.push_back(Ok(busy(s.now)));
        });
        let result = fake.make(Default::default()).tick().await;
        assert!(
            matches!(result, RunOutcome::Deferred { reason, .. } if reason.contains("window closed"))
        );
        assert_pin_restored(&fake);
        assert_no_build_restart(&fake);
        assert!(fake.events().contains(&"wait".into()));
    }
    #[tokio::test]
    async fn active_turn_blocks_manual_restart_without_waiting() {
        let fake = Fake::new();
        fake.change(|s| s.quiescence.push_back(Ok(busy(s.now))));
        assert!(matches!(
            fake.make(Default::default()).run_now(false).await,
            RunOutcome::Deferred { .. }
        ));
        assert_pin_restored(&fake);
        assert_no_build_restart(&fake);
        assert!(!fake.events().contains(&"wait".into()));
        // Both CLI updates happened before asking about activity.
        assert!(fake.events().contains(&"claude update".into()));
        assert!(fake.events().contains(&"codex update".into()));
    }
    #[tokio::test]
    async fn recheck_after_build_blocks_a_new_turn_and_restores_dist() {
        let fake = Fake::new();
        fake.change(|s| {
            s.quiescence.push_back(Ok(quiet(s.now)));
            s.quiescence.push_back(Ok(busy(s.now)));
        });
        assert!(matches!(
            fake.make(Default::default()).run_now(false).await,
            RunOutcome::Deferred { .. }
        ));
        assert_pin_restored(&fake);
        assert!(fake.events().contains(&"restore dist.prev".into()));
        assert!(!fake.events().contains(&"restart".into()));
    }
    #[tokio::test]
    async fn probe_failure_restores_everything_restarts_again_and_holds() {
        let fake = Fake::new();
        fake.change(|s| s.fail = Some("probe".into()));
        let maintenance = fake.make(Default::default());
        assert!(matches!(
            maintenance.tick().await,
            RunOutcome::Held { attempts: 1, .. }
        ));
        assert_pin_restored(&fake);
        let events = fake.events();
        let probe = events.iter().position(|e| e == "probe").unwrap();
        assert_eq!(
            &events[probe + 1..],
            [
                "restore dist.prev",
                &format!("git checkout -- {PACKAGE} {LOCKFILE}"),
                "npm install --workspace @remux/agent",
                "read pin",
                "restore CLI symlink",
                "restart",
            ]
        );
        assert_eq!(events.iter().filter(|e| *e == "restart").count(), 2);
        assert!(!events.iter().any(|e| e.starts_with("git commit")));
        assert!(maintenance.state().hold.is_some());
    }
    #[tokio::test]
    async fn three_failures_hold_across_reload_until_target_changes() {
        let fake = Fake::new();
        fake.change(|s| s.fail = Some("npm run typecheck".into()));
        let maintenance = fake.make(Default::default());
        for _ in 0..2 {
            assert!(matches!(
                maintenance.tick().await,
                RunOutcome::RolledBack { .. }
            ));
        }
        assert!(matches!(
            maintenance.tick().await,
            RunOutcome::Held { attempts: 3, .. }
        ));
        let maintenance = fake.make(Default::default());
        fake.change(|s| s.events.clear());
        assert!(matches!(
            maintenance.tick().await,
            RunOutcome::Held { attempts: 3, .. }
        ));
        assert_eq!(fake.events(), ["registry"]);
        fake.change(|s| {
            s.versions.push("0.3.281".into());
            s.fail = None;
        });
        assert!(
            matches!(maintenance.tick().await, RunOutcome::Upgraded { sdk, .. } if sdk == "0.3.281")
        );
        assert!(maintenance.state().hold.is_none());
        assert_eq!(maintenance.state().consecutive_failures, 0);
    }
    #[tokio::test]
    async fn release_beyond_old_cli_patch_rechecks_installers_but_keeps_same_target_held() {
        let fake = Fake::new();
        fake.change(|s| {
            s.versions = vec!["0.3.283".into()];
            s.fail = Some("probe".into());
        });
        let maintenance = fake.make(Default::default());
        assert!(matches!(maintenance.tick().await, RunOutcome::Held { .. }));
        assert_eq!(
            maintenance.state().installed_cli_version.as_deref(),
            Some("2.1.258")
        );
        fake.change(|s| {
            s.events.clear();
            s.versions.push("0.3.284".into());
            s.fail = None;
        });
        // CLI release may lag registry: still do not retry the failed pin.
        assert!(matches!(maintenance.tick().await, RunOutcome::Held { .. }));
        assert_no_build_restart(&fake);
        fake.change(|s| {
            s.events.clear();
            s.versions.push("0.3.285".into());
            s.cli = "2.1.285".into();
        });
        assert!(
            matches!(maintenance.tick().await, RunOutcome::Upgraded { sdk, .. } if sdk == "0.3.285")
        );
    }

    #[tokio::test]
    async fn happy_path_has_exact_transaction_order_and_commit_is_last() {
        let fake = Fake::new();
        assert!(matches!(
            fake.make(Default::default()).tick().await,
            RunOutcome::Upgraded { .. }
        ));
        let events = fake.events();
        let install = events.iter().position(|e| e == "claude update").unwrap();
        assert_eq!(&events[install..], [
            "claude update", "codex update", "claude --version", "registry", "read pin",
            "npm install @anthropic-ai/claude-agent-sdk@0.3.280 --workspace @remux/agent",
            "read pin", "npm run typecheck", "npm run test:agent-server", "quiescence",
            "backup dist", "build", "quiescence", "restart", "probe",
            &format!("git commit --only -m chore(agent): bump claude-agent-sdk to 0.3.280 -- {PACKAGE} {LOCKFILE}"),
            "codex activate",
        ]);
    }
    #[tokio::test]
    async fn dry_run_never_mutates_any_seam_or_invokes_git() {
        for scenario in [
            "upgrade",
            "noop",
            "busy",
            "missing RPC",
            "held",
            "disabled",
            "outside window",
        ] {
            let fake = Fake::new();
            let mut config = AgentAutoupdateConfig::default();
            fake.change(|s| match scenario {
                "noop" => s.pin = "0.3.280".into(),
                "busy" => s.quiescence.push_back(Ok(busy(s.now))),
                "missing RPC" => s.quiescence.push_back(Err("method not found".into())),
                "held" => {
                    s.saved.installed_cli_version = Some(s.cli.clone());
                    s.saved.hold = Some(Hold {
                        target: "0.3.280".into(),
                        attempts: 3,
                        reason: "bad".into(),
                        timestamp: 0,
                    });
                }
                "disabled" => config.enabled = Some(false),
                "outside window" => s.minute = 800,
                _ => {}
            });
            let maintenance = fake.make(config);
            let before = maintenance.state();
            let result = maintenance.run(false, true).await;
            assert!(!matches!(
                result,
                RunOutcome::Upgraded { .. } | RunOutcome::RolledBack { .. }
            ));
            assert_eq!(before, maintenance.state(), "{scenario}");
            assert!(
                fake.inner.lock().unwrap().mutations.is_empty(),
                "{scenario}"
            );
            assert!(
                !fake.events().iter().any(|e| e.starts_with("git ")),
                "{scenario}"
            );
        }
    }
    #[tokio::test]
    async fn quiet_period_and_all_blockers_are_required() {
        for kind in [
            "recent",
            "queued",
            "compacting",
            "recovering",
            "stale",
            "future",
            "unknown",
        ] {
            let fake = Fake::new();
            fake.change(|s| {
                let mut q = quiet(s.now);
                match kind {
                    "recent" => q.last_activity_at = Some(s.now - 60_000),
                    "queued" => q.queued_messages = 1,
                    "compacting" => q.compacting = 1,
                    "recovering" => q.recovering = 1,
                    "stale" => q.observed_at = 0,
                    "future" => q.last_activity_at = Some(s.now + 1),
                    "unknown" => q.last_activity_at = None,
                    _ => unreachable!(),
                }
                s.quiescence.push_back(Ok(q));
            });
            assert!(
                matches!(
                    fake.make(Default::default()).run_now(false).await,
                    RunOutcome::Deferred { .. }
                ),
                "{kind}"
            );
            assert_no_build_restart(&fake);
        }
    }
    #[tokio::test]
    async fn never_active_agent_can_accumulate_a_quiet_period() {
        let fake = Fake::new();
        fake.change(|s| {
            for i in 0..=2 {
                let mut q = quiet(s.now + i * 30_000);
                q.last_activity_at = None;
                s.quiescence.push_back(Ok(q));
            }
        });
        let maintenance = fake.make(AgentAutoupdateConfig {
            quiet_minutes: Some(1),
            ..Default::default()
        });
        assert!(matches!(
            maintenance.tick().await,
            RunOutcome::Upgraded { .. }
        ));
        assert_eq!(fake.events().iter().filter(|e| *e == "wait").count(), 2);
    }
    #[tokio::test]
    async fn install_and_build_failures_restore_their_touched_paths() {
        for failure in [
            "npm install @anthropic-ai/claude-agent-sdk@0.3.280 --workspace @remux/agent",
            "backup dist",
            "build",
        ] {
            let fake = Fake::new();
            fake.change(|s| s.fail = Some(failure.into()));
            assert!(matches!(
                fake.make(Default::default()).tick().await,
                RunOutcome::RolledBack { .. }
            ));
            assert_pin_restored(&fake);
            assert_eq!(
                fake.events().contains(&"restore dist.prev".into()),
                failure == "build"
            );
            assert!(!fake.events().contains(&"restart".into()));
        }
    }
    #[tokio::test]
    async fn restoration_failure_holds_immediately_and_preserves_error() {
        let fake = Fake::new();
        fake.change(|s| {
            s.fail = Some("npm run typecheck".into());
            s.fail_restore = true;
        });
        assert!(matches!(fake.make(Default::default()).tick().await,
            RunOutcome::Held { reason, .. } if reason.contains("restore failed")));
        assert_no_build_restart(&fake);
    }
    #[tokio::test]
    async fn now_bypasses_window_but_not_enabled_and_wrapping_windows_work() {
        let fake = Fake::new();
        let maintenance = fake.make(AgentAutoupdateConfig {
            window: Some("23:00-01:00".into()),
            ..Default::default()
        });
        assert!(matches!(
            maintenance.tick().await,
            RunOutcome::Skipped { .. }
        ));
        assert!(fake.events().is_empty());
        fake.change(|s| s.minute = 30);
        assert!(matches!(
            maintenance.run(false, true).await,
            RunOutcome::Plan { .. }
        ));
        fake.change(|s| s.minute = 800);
        assert!(matches!(
            maintenance.run_now(true).await,
            RunOutcome::Plan { .. }
        ));
        let disabled = fake.make(AgentAutoupdateConfig {
            enabled: Some(false),
            ..Default::default()
        });
        assert!(matches!(
            disabled.run_now(false).await,
            RunOutcome::Skipped { .. }
        ));
    }
    #[tokio::test]
    async fn unreadable_or_unwritable_state_fails_closed() {
        for unreadable in [true, false] {
            let fake = Fake::new();
            fake.change(|s| {
                if unreadable {
                    s.saved.state_error = Some("invalid state JSON".into());
                } else {
                    s.save_error = true;
                }
            });
            assert!(
                matches!(fake.make(Default::default()).tick().await, RunOutcome::Skipped { stage, .. } if stage == "state")
            );
            assert!(!fake.events().contains(&"claude update".into()));
        }
    }
    #[tokio::test]
    async fn read_seam_reports_the_schedule_alongside_a_flat_state() {
        let fake = Fake::new();
        let maintenance = fake.make(AgentAutoupdateConfig {
            window: Some("03:30-06:00".into()),
            ..Default::default()
        });
        maintenance.run_now(false).await;
        let json = serde_json::to_value(maintenance.status()).unwrap();
        assert_eq!(json["enabled"], true);
        assert_eq!(json["window"], "03:30-06:00");
        assert_eq!(json["quietMinutes"], 20);
        // Flattened, so the card reads one object: no nested `state` wrapper.
        assert!(json.get("state").is_none());
        assert_eq!(json["lastResult"]["decision"], "Upgraded");
        assert!(json["lastRun"].is_i64());
        assert!(json["hold"].is_null());
    }
    #[tokio::test]
    async fn concurrent_run_is_deferred() {
        let fake = Fake::new();
        let maintenance = fake.make(Default::default());
        let _guard = maintenance.running.lock().await;
        assert!(matches!(
            maintenance.run_now(false).await,
            RunOutcome::Deferred { .. }
        ));
        assert!(fake.events().is_empty());
    }
    #[tokio::test]
    async fn commit_disabled_and_commit_failure_do_not_roll_back_verified_runtime() {
        let fake = Fake::new();
        assert!(matches!(
            fake.make(AgentAutoupdateConfig {
                commit: Some(false),
                ..Default::default()
            })
            .tick()
            .await,
            RunOutcome::Upgraded { .. }
        ));
        assert!(!fake.events().iter().any(|e| e.starts_with("git commit")));
        let fake = Fake::new();
        fake.change(|s| s.fail = Some(format!("git commit --only -m chore(agent): bump claude-agent-sdk to 0.3.280 -- {PACKAGE} {LOCKFILE}")));
        assert!(matches!(
            fake.make(Default::default()).tick().await,
            RunOutcome::Held { .. }
        ));
        assert!(!fake.events().iter().any(|e| e.starts_with("git checkout")));
        assert_eq!(fake.inner.lock().unwrap().pin, "0.3.280");
    }
    #[test]
    fn version_selection_is_numeric_stable_and_patch_bounded() {
        let versions = [
            "0.3.9",
            "0.3.280",
            "0.3.284",
            "0.3.283-beta.1",
            "0.2.283",
            "garbage",
        ]
        .map(str::to_string);
        assert_eq!(
            resolve_target(&versions, "2.1.283 (Claude Code)").unwrap(),
            "0.3.280"
        );
        assert!(resolve_target(&versions, "not a version").is_err());
        assert!(resolve_target(&[], "2.1.283").is_err());
    }
}
