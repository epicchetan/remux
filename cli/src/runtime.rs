//! Worker assembly, shutdown, and panic policy, replacing `cli/start.cjs`.
//!
//! Startup order mirrors the Node runtime: config → journal → discovery →
//! default launch extension → notifications → extension supervisors → fs
//! core → fs relay → RPC router → viewers → HTTP bind → WS attach → relay
//! start → extension servers start → listen log block.
//!
//! Policy changes vs Node (per the pass-1 spec): signal shutdown races a 5s
//! hard deadline; a dead critical task (extension actor, HTTP accept loop)
//! exits 75 so L1 restarts a coherent process; panics are journaled.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use serde_json::Value;

use crate::config::{load_remux_config, load_runtime_values};
use crate::extensions::discovery::{discover_extensions, extension_roots};
use crate::extensions::manifest::ExtensionManifest;
use crate::extensions::supervisor::{ExtensionCtx, ExtensionSupervisor, SupervisorConfig};
use crate::fs::core::FsCore;
use crate::fs::relay::{FsRelay, FsRelayOptions};
use crate::http::viewers::ViewerProvider;
use crate::http::{build_router, HttpState};
use crate::logs::{ExtensionLogs, Journal, JournalEvent, StdTerminal, TerminalMode};
use crate::notifications::{production_fetch, NotificationManager};
use crate::rpc::router::{BoxFuture, ExtensionServer, RpcRouter, SystemHooks};
use crate::rpc::ws::{ClientCountListener, WsHooks, WsServer, REMUX_WEB_SOCKET_PATH};
use crate::supervise::REMUX_RESTART_EXIT_CODE;

pub const RESTART_DELAY_MS: u64 = 200;
pub const RESTART_FORCE_EXIT_DELAY_MS: u64 = 2_000;
pub const SHUTDOWN_HARD_DEADLINE_MS: u64 = 5_000;
pub const BIND_RETRY_WINDOW_MS: u64 = 10_000;

/// Late-bound runtime pieces: the extension supervisors and system hooks are
/// created before the WS server exists, so they reach it through here.
#[derive(Default)]
struct Shared {
    relay: OnceLock<Arc<FsRelay>>,
    ws: OnceLock<Arc<WsServer>>,
    router: OnceLock<Arc<RpcRouter>>,
    notifications: OnceLock<Arc<NotificationManager>>,
    shutting_down: AtomicBool,
}

impl Shared {
    /// Graceful sequence: relay → WS → extension stops (parallel, inside
    /// router.stop) — mirroring `start.cjs` `shutdown`. HTTP dies with the
    /// process.
    async fn shutdown_sequence(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(relay) = self.relay.get() {
            relay.close();
        }
        if let Some(ws) = self.ws.get() {
            ws.close();
        }
        if let Some(router) = self.router.get() {
            router.stop().await;
        }
    }

    async fn shutdown_with_deadline(&self, deadline_ms: u64) {
        tokio::select! {
            _ = self.shutdown_sequence() => {}
            _ = tokio::time::sleep(std::time::Duration::from_millis(deadline_ms)) => {}
        }
    }
}

struct RuntimeCtx {
    shared: Arc<Shared>,
}

impl ExtensionCtx for RuntimeCtx {
    fn broadcast(&self, message: Value) {
        if let Some(ws) = self.shared.ws.get() {
            ws.broadcast(message);
        }
    }

    fn handle_extension_notification(&self, message: Value) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            match self.shared.notifications.get() {
                Some(notifications) => notifications.handle_extension_notification(&message).await,
                None => false,
            }
        })
    }
}

struct RelayClientCount(Arc<FsRelay>);

impl ClientCountListener for RelayClientCount {
    fn on_client_count_changed(&self, count: usize) {
        self.0.on_client_count_changed(count);
    }
}

fn default_launch_extension(extensions: &[ExtensionManifest]) -> Option<&ExtensionManifest> {
    extensions
        .iter()
        .find(|extension| !extension.launchers.is_empty())
        .or_else(|| extensions.first())
}

pub fn bind_display_url(host: &str, port: u16) -> String {
    if host == "0.0.0.0" {
        format!("http://0.0.0.0:{port} (all IPv4 interfaces)")
    } else {
        format!("http://{host}:{port}")
    }
}

/// Journals a dead critical subsystem and exits 75 so L1 restarts a coherent
/// process (the Rust stand-in for the missing `uncaughtException` handler,
/// with a correct restart code).
fn fatal_task_died(journal: &Journal, shared: &Shared, name: &str, detail: Option<String>) {
    if shared.shutting_down.load(Ordering::SeqCst) {
        return;
    }
    journal.event(JournalEvent {
        detail: detail.map(Value::from),
        label: Some("fatal:task-died".to_string()),
        level: "error",
        message: Some(format!("critical task {name} died; restarting worker")),
        ..Default::default()
    });
    journal.flush();
    std::process::exit(REMUX_RESTART_EXIT_CODE);
}

fn install_panic_hook(journal: Arc<Journal>) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        journal.event(JournalEvent {
            detail: Some(serde_json::json!({ "backtrace": backtrace.to_string() })),
            label: Some("panic".to_string()),
            level: "error",
            message: Some(info.to_string()),
            terminal: TerminalMode::Silent,
            ..Default::default()
        });
        journal.flush();
        default_hook(info);
    }));
}

pub async fn run_worker() -> Result<i32, String> {
    let root_dir = crate::paths::resolve(
        &std::env::current_dir().map_err(|error| format!("cannot resolve cwd: {error}"))?,
    );

    // Config + journal (journal applies log retention on boot).
    let config = load_remux_config(&root_dir)?;
    let journal = Journal::new(&root_dir, config.log_retention_days(), Arc::new(StdTerminal))
        .map_err(|error| format!("failed to open journal: {error}"))?;
    install_panic_hook(journal.clone());

    let runtime = load_runtime_values(
        std::env::var("REMUX_HOST").ok().as_deref(),
        std::env::var("REMUX_PORT").ok().as_deref(),
        &config,
    )?;

    // Discovery.
    let roots = extension_roots(
        std::env::var("REMUX_EXTENSION_ROOTS").ok().as_deref(),
        &config,
        &root_dir,
    );
    let extensions = discover_extensions(&roots)?;
    let default_extension = default_launch_extension(&extensions)
        .cloned()
        .ok_or_else(|| "No Remux extensions found under extensions/*".to_string())?;

    let shared = Arc::new(Shared::default());

    // Notifications + logs.
    let notifications = NotificationManager::new(&root_dir, production_fetch(), journal.clone());
    let _ = shared.notifications.set(notifications.clone());
    let extension_logs = ExtensionLogs::new(&root_dir);

    // Extension supervisors (L2). Their actor tasks are critical: an actor
    // dying unexpectedly exits 75.
    let ctx: Arc<dyn ExtensionCtx> = Arc::new(RuntimeCtx {
        shared: shared.clone(),
    });
    let mut servers: Vec<(String, Arc<dyn ExtensionServer>)> = Vec::new();
    for extension in extensions.iter().filter(|ext| ext.server.is_some()) {
        let (supervisor, actor) = ExtensionSupervisor::spawn(
            extension.clone(),
            SupervisorConfig::default(),
            ctx.clone(),
            journal.clone(),
            extension_logs.clone(),
        );
        servers.push((extension.id.clone(), supervisor));

        let journal_for_watch = journal.clone();
        let shared_for_watch = shared.clone();
        let name = format!("extension-actor:{}", extension.id);
        tokio::spawn(async move {
            let outcome = actor.await;
            fatal_task_died(
                &journal_for_watch,
                &shared_for_watch,
                &name,
                outcome.err().map(|error| error.to_string()),
            );
        });
    }

    // fs core + relay.
    let fs_core = FsCore::new(&root_dir);
    let relay_warn_journal = journal.clone();
    let relay = FsRelay::new(
        FsRelayOptions::default(),
        FsRelay::production_hooks(Arc::new(move |message| relay_warn_journal.warn(&message))),
    );
    let _ = shared.relay.set(relay.clone());
    {
        let relay = relay.clone();
        fs_core.subscribe(Box::new(move |event| {
            relay.on_directory_served(event);
        }));
    }

    // RPC router with system hooks.
    let system = SystemHooks {
        info: Some(Box::new({
            let cwd = root_dir.to_string_lossy().into_owned();
            move || serde_json::json!({ "cwd": cwd })
        })),
        restart: Some(Box::new({
            let shared = shared.clone();
            move || {
                let shared = shared.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(RESTART_DELAY_MS)).await;
                    shared
                        .shutdown_with_deadline(RESTART_FORCE_EXIT_DELAY_MS)
                        .await;
                    std::process::exit(REMUX_RESTART_EXIT_CODE);
                });
            }
        })),
    };
    let router = Arc::new(RpcRouter::new(
        servers,
        Some(default_extension.id.clone()),
        Some(fs_core.clone()),
        system,
    ));
    let _ = shared.router.set(router.clone());

    // HTTP + WS.
    let viewer_providers: Vec<ViewerProvider> =
        extensions.iter().map(ViewerProvider::new).collect();
    let http_state = Arc::new(HttpState {
        default_extension: default_extension.clone(),
        extensions: extensions.clone(),
        viewer_providers,
    });
    let ws = WsServer::new(
        router.clone(),
        WsHooks {
            notifications: Some(notifications.clone()),
            client_count: Some(Arc::new(RelayClientCount(relay.clone()))),
            client_scoped: Some(extension_logs.clone()),
        },
        journal.clone(),
    );
    let _ = shared.ws.set(ws.clone());

    let app = ws
        .route()
        .merge(build_router(http_state))
        .into_make_service_with_connect_info::<std::net::SocketAddr>();

    log_start_config(&journal, &runtime.host, runtime.port, &default_extension, &extensions);

    // Bind, retrying through a lingering predecessor's EADDRINUSE.
    let listener = bind_with_retry(&runtime.host, runtime.port, &journal).await?;
    journal.log(&format!(
        "remux listening on {}",
        bind_display_url(&runtime.host, runtime.port)
    ));

    // Relay + extension servers.
    {
        let ws = ws.clone();
        let fs_core = fs_core.clone();
        relay.start(
            Arc::new(move |message| ws.broadcast(message)),
            Arc::new(move |paths, roots| fs_core.invalidate(paths, roots)),
        );
    }
    router.start().await;

    // Serve; the accept loop is critical.
    let serve_journal = journal.clone();
    let serve_shared = shared.clone();
    let server = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            fatal_task_died(&serve_journal, &serve_shared, "http-server", Some(error.to_string()));
        }
    });

    // Signal-driven shutdown with a hard deadline.
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(|error| format!("failed to install SIGINT handler: {error}"))?;
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| format!("failed to install SIGTERM handler: {error}"))?;

    tokio::select! {
        _ = sigint.recv() => {}
        _ = sigterm.recv() => {}
        outcome = server => {
            // axum::serve never returns Ok in normal operation; a dead accept
            // loop already exited via fatal_task_died unless we're shutting
            // down.
            let _ = outcome;
        }
    }

    shared
        .shutdown_with_deadline(SHUTDOWN_HARD_DEADLINE_MS)
        .await;
    journal.flush();
    Ok(0)
}

async fn bind_with_retry(
    host: &str,
    port: u16,
    journal: &Journal,
) -> Result<tokio::net::TcpListener, String> {
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(BIND_RETRY_WINDOW_MS);
    loop {
        match tokio::net::TcpListener::bind((host, port)).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                if std::time::Instant::now() >= deadline {
                    journal.error(&format!(
                        "remux failed to listen on {}",
                        bind_display_url(host, port)
                    ));
                    return Err(format!("failed to bind {host}:{port}: {error}"));
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            Err(error) => {
                journal.error(&format!(
                    "remux failed to listen on {}",
                    bind_display_url(host, port)
                ));
                return Err(format!("failed to bind {host}:{port}: {error}"));
            }
        }
    }
}

fn log_start_config(
    journal: &Journal,
    host: &str,
    port: u16,
    default_extension: &ExtensionManifest,
    extensions: &[ExtensionManifest],
) {
    let extension_ids: Vec<&str> = extensions.iter().map(|ext| ext.id.as_str()).collect();
    let viewers: Vec<Value> = extensions
        .iter()
        .map(|ext| {
            serde_json::json!({
                "extensionId": ext.id,
                "route": ext.main_view().route,
            })
        })
        .collect();
    let websocket = format!("ws://{host}:{port}{REMUX_WEB_SOCKET_PATH}");

    journal.event(JournalEvent {
        detail: Some(serde_json::json!({
            "extensions": extension_ids,
            "http": bind_display_url(host, port),
            "viewer": {
                "extensionId": default_extension.id,
                "route": default_extension.main_view().route,
            },
            "viewers": viewers,
            "websocket": websocket,
        })),
        label: Some("start:config".to_string()),
        message: Some("Remux".to_string()),
        terminal: TerminalMode::Silent,
        ..Default::default()
    });

    journal.log("Remux");
    journal.log(&format!("  http:       {}", bind_display_url(host, port)));
    journal.log(&format!("  websocket:  {websocket}"));
    journal.log(&format!(
        "  viewer:     {} {}",
        default_extension.id,
        default_extension.main_view().route
    ));
    journal.log(&format!("  extensions: {}", extension_ids.join(", ")));
    journal.log(&format!(
        "  viewers:    {}",
        extensions
            .iter()
            .map(|ext| format!("{} {}", ext.id, ext.main_view().route))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    journal.log("");
}
