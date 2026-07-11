//! Method routing, ported from `cli/rpcRouter.cjs`. Dispatch order: system →
//! extension management → core (`remux/fs/*`) → extension by method prefix
//! `remux/<ext>/…` else the default extension.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::rpc::jsonrpc::{JsonRpcError, EXTENSION_ERROR, INVALID_PARAMS};

pub const EXTENSION_STATUS_METHOD: &str = "remux/extensions/status";
pub const EXTENSION_START_METHOD: &str = "remux/extensions/start";
pub const EXTENSION_STOP_METHOD: &str = "remux/extensions/stop";
pub const EXTENSION_RESTART_METHOD: &str = "remux/extensions/restart";
pub const EXTENSION_WATCH_START_METHOD: &str = "remux/extensions/watch/start";
pub const EXTENSION_WATCH_STOP_METHOD: &str = "remux/extensions/watch/stop";
pub const EXTENSION_SERVER_BUILD_METHOD: &str = "remux/extensions/server/build";
pub const EXTENSION_VIEWS_BUILD_METHOD: &str = "remux/extensions/views/build";
pub const EXTENSION_LOGS_METHOD: &str = "remux/extensions/logs";
pub const SYSTEM_INFO_METHOD: &str = "remux/system/info";
pub const SYSTEM_PING_METHOD: &str = "remux/system/ping";
pub const SYSTEM_RESTART_METHOD: &str = "remux/system/restart";
pub const SYSTEM_RESOURCES_METHOD: &str = "remux/system/resources";

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type RpcResult = Result<Value, JsonRpcError>;

/// Lifecycle + status snapshot for one extension server. `restartable` and
/// `running` are the Node-era fields; the rest are pass-1 additive fields
/// surfaced in management responses and `didChangeStatus` broadcasts.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerStatus {
    pub restartable: bool,
    pub running: bool,
    pub state: String,
    pub pid: Option<u32>,
    pub started_at_ms: Option<i64>,
    pub restart_count: u32,
    pub last_exit: Option<LastExit>,
    /// Pass-2 additive: whether the manifest declares any build phase —
    /// `server.build` or a view build since the view-build-watch pass
    /// (gates the app's Rebuild & Restart action).
    pub has_build: bool,
    /// View-build-watch additive: distinguishes "stopped server" from
    /// "nothing to run" (editor/markdown).
    pub has_server: bool,
    /// Whether the manifest declares `server.build` specifically — the app's
    /// server Build button keys off this, not the aggregate `hasBuild`.
    pub has_server_build: bool,
    /// View-build-watch additive: view build facet.
    pub views: ViewsFacet,
    /// View-build-watch additive: watch sidecar facet — NOT the extension
    /// lifecycle; states are `stopped | running | failed`.
    pub watch: WatchFacet,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ViewsFacet {
    /// Views with a declared build.
    pub declared: u32,
    /// True when every declared view's entry exists (statted at snapshot
    /// time).
    pub built: bool,
    pub last_build_at_ms: Option<i64>,
}

impl Default for ViewsFacet {
    fn default() -> Self {
        Self {
            declared: 0,
            built: false,
            last_build_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WatchFacet {
    /// Whether any view declares a watch spec; when false the wire shape is
    /// `{ "declared": false }` and nothing else.
    pub declared: bool,
    pub state: String,
    pub pid: Option<u32>,
    pub started_at_ms: Option<i64>,
    pub restart_count: u32,
}

impl Default for WatchFacet {
    fn default() -> Self {
        Self {
            declared: false,
            state: "stopped".to_string(),
            pid: None,
            started_at_ms: None,
            restart_count: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LastExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub at: i64,
    /// Pass-2 additive: non-exit failure reason (`build-failed`), omitted
    /// from the wire when absent.
    pub reason: Option<String>,
}

impl ServerStatus {
    /// The additive status fields, in a stable order, appended to management
    /// response objects after `extensionId`.
    pub fn append_to(&self, target: &mut Map<String, Value>) {
        target.insert("restartable".to_string(), Value::from(self.restartable));
        target.insert("running".to_string(), Value::from(self.running));
        target.insert("state".to_string(), Value::from(self.state.clone()));
        target.insert(
            "pid".to_string(),
            self.pid.map(Value::from).unwrap_or(Value::Null),
        );
        target.insert(
            "startedAtMs".to_string(),
            self.started_at_ms.map(Value::from).unwrap_or(Value::Null),
        );
        target.insert("restartCount".to_string(), Value::from(self.restart_count));
        target.insert(
            "lastExit".to_string(),
            match &self.last_exit {
                Some(exit) => {
                    let mut value = Map::new();
                    value.insert(
                        "code".to_string(),
                        exit.code.map(Value::from).unwrap_or(Value::Null),
                    );
                    value.insert(
                        "signal".to_string(),
                        exit.signal
                            .as_deref()
                            .map(Value::from)
                            .unwrap_or(Value::Null),
                    );
                    value.insert("at".to_string(), Value::from(exit.at));
                    if let Some(reason) = &exit.reason {
                        value.insert("reason".to_string(), Value::from(reason.clone()));
                    }
                    Value::Object(value)
                }
                None => Value::Null,
            },
        );
        target.insert("hasBuild".to_string(), Value::from(self.has_build));
        target.insert("hasServer".to_string(), Value::from(self.has_server));
        target.insert(
            "hasServerBuild".to_string(),
            Value::from(self.has_server_build),
        );
        let mut views = Map::new();
        views.insert("declared".to_string(), Value::from(self.views.declared));
        views.insert("built".to_string(), Value::from(self.views.built));
        views.insert(
            "lastBuildAtMs".to_string(),
            self.views
                .last_build_at_ms
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        target.insert("views".to_string(), Value::Object(views));
        let mut watch = Map::new();
        watch.insert("declared".to_string(), Value::from(self.watch.declared));
        if self.watch.declared {
            watch.insert("state".to_string(), Value::from(self.watch.state.clone()));
            watch.insert(
                "pid".to_string(),
                self.watch.pid.map(Value::from).unwrap_or(Value::Null),
            );
            watch.insert(
                "startedAtMs".to_string(),
                self.watch
                    .started_at_ms
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
            watch.insert(
                "restartCount".to_string(),
                Value::from(self.watch.restart_count),
            );
        }
        target.insert("watch".to_string(), Value::Object(watch));
    }
}

/// The contract the router expects from an extension server, mirroring the
/// duck-typed server objects `createRpcRouter` consumed in Node.
pub trait ExtensionServer: Send + Sync {
    /// `rebuild` forces the manifest `build` phase to run even when the
    /// artifact exists; ignored for extensions without a build phase.
    fn start(&self, rebuild: bool) -> BoxFuture<'_, ServerStatus>;
    fn stop(&self) -> BoxFuture<'_, ServerStatus>;
    fn restart(&self, rebuild: bool) -> BoxFuture<'_, ServerStatus>;
    /// Starts the view-watch sidecar. The bool is the idempotency flag
    /// (`started`): false when the watcher was already running (or the
    /// gating build failed — the facet in the status says so). Errors when
    /// no view declares a watch spec.
    fn watch_start(&self) -> BoxFuture<'_, Result<(ServerStatus, bool), JsonRpcError>> {
        Box::pin(async {
            Err(JsonRpcError::new(EXTENSION_ERROR, "watch not declared"))
        })
    }
    /// Stops the view-watch sidecar. Idempotent: the bool is `stopped`.
    fn watch_stop(&self) -> BoxFuture<'_, (ServerStatus, bool)> {
        Box::pin(async { (self.status(), false) })
    }
    /// Manual server build: rebuilds the binary while any running server
    /// keeps serving, then restarts it into the new build. A stopped server
    /// stays stopped. Build failure is a plain error — the lifecycle (and a
    /// live server) stays untouched.
    fn build_server(&self) -> BoxFuture<'_, Result<ServerStatus, JsonRpcError>> {
        Box::pin(async {
            Err(JsonRpcError::new(
                EXTENSION_ERROR,
                "server build not declared",
            ))
        })
    }
    /// Manual view build: force-runs every declared view build (watch-owned
    /// views are skipped). Same error-not-lifecycle failure contract as
    /// `build_server`.
    fn build_views(&self) -> BoxFuture<'_, Result<ServerStatus, JsonRpcError>> {
        Box::pin(async {
            Err(JsonRpcError::new(EXTENSION_ERROR, "view build not declared"))
        })
    }
    fn handle_rpc(&self, method: String, params: Option<Value>) -> BoxFuture<'_, RpcResult>;
    fn handle_notification(&self, method: String, params: Option<Value>);
    fn status(&self) -> ServerStatus;
    /// Snapshot of the in-memory log ring (`remux/extensions/logs`).
    fn logs(&self, lines: usize) -> Value;
}

pub trait CoreRpc: Send + Sync {
    fn handle_rpc(&self, method: String, params: Option<Value>) -> BoxFuture<'_, RpcResult>;
}

/// System hooks wired by the runtime: `info` supplies `remux/system/info`,
/// `restart` schedules the exit-75 restart before the response is sent,
/// `resources` supplies the latest `remux/system/resources` sample.
#[derive(Default)]
pub struct SystemHooks {
    pub info: Option<Box<dyn Fn() -> Value + Send + Sync>>,
    pub restart: Option<Box<dyn Fn() + Send + Sync>>,
    pub resources: Option<Box<dyn Fn() -> Value + Send + Sync>>,
}

pub struct RpcRouter {
    servers: Vec<(String, Arc<dyn ExtensionServer>)>,
    default_extension_id: Option<String>,
    core: Option<Arc<dyn CoreRpc>>,
    system: SystemHooks,
}

impl RpcRouter {
    pub fn new(
        servers: Vec<(String, Arc<dyn ExtensionServer>)>,
        default_extension_id: Option<String>,
        core: Option<Arc<dyn CoreRpc>>,
        system: SystemHooks,
    ) -> Self {
        Self {
            servers,
            default_extension_id,
            core,
            system,
        }
    }

    fn server(&self, extension_id: &str) -> Option<&Arc<dyn ExtensionServer>> {
        self.servers
            .iter()
            .find(|(id, _)| id == extension_id)
            .map(|(_, server)| server)
    }

    /// Boot start; `rebuild` comes from `remux start --rebuild` and applies
    /// to each extension's first spawn only.
    pub async fn start(&self, rebuild: bool) {
        let mut tasks = tokio::task::JoinSet::new();
        for (_, server) in &self.servers {
            let server = server.clone();
            tasks.spawn(async move {
                server.start(rebuild).await;
            });
        }
        while tasks.join_next().await.is_some() {}
    }

    /// Stops run in parallel — each stop can take up to ~4s (EOF → SIGTERM →
    /// SIGKILL), and shutdown has a 5s hard deadline.
    pub async fn stop(&self) {
        let mut tasks = tokio::task::JoinSet::new();
        for (_, server) in &self.servers {
            let server = server.clone();
            tasks.spawn(async move {
                server.stop().await;
            });
        }
        while tasks.join_next().await.is_some() {}
    }

    pub async fn handle_request(&self, method: &str, params: Option<&Value>) -> RpcResult {
        if is_system_method(method) {
            return self.handle_system_request(method).await;
        }

        if is_extension_management_method(method) {
            return self.handle_extension_management_request(method, params).await;
        }

        if is_core_method(method) {
            let Some(core) = &self.core else {
                return Err(JsonRpcError::method_not_found(method));
            };
            return core.handle_rpc(method.to_string(), params.cloned()).await;
        }

        let extension_id = extension_id_from_method(method)
            .or(self.default_extension_id.as_deref());
        let server = extension_id.and_then(|id| self.server(id));
        let Some(server) = server else {
            return Err(JsonRpcError::method_not_found(method));
        };

        server.handle_rpc(method.to_string(), params.cloned()).await
    }

    /// True when a request will be forwarded to an extension server rather
    /// than handled by Remux itself. The WS layer uses this boundary to attach
    /// an opaque downstream origin without changing built-in RPC contracts.
    pub fn routes_to_extension(&self, method: &str) -> bool {
        if is_system_method(method)
            || is_extension_management_method(method)
            || is_core_method(method)
        {
            return false;
        }
        let extension_id = extension_id_from_method(method)
            .or(self.default_extension_id.as_deref());
        extension_id.and_then(|id| self.server(id)).is_some()
    }

    pub fn handle_notification(&self, method: &str, params: Option<Value>) {
        let extension_id = extension_id_from_method(method)
            .or(self.default_extension_id.as_deref());
        if let Some(server) = extension_id.and_then(|id| self.server(id)) {
            server.handle_notification(method.to_string(), params);
        }
    }

    async fn handle_system_request(&self, method: &str) -> RpcResult {
        // Liveness probe: the app pings after foregrounding to detect half-open
        // sockets that still report OPEN. Any reply works; this one is cheapest.
        if method == SYSTEM_PING_METHOD {
            return Ok(serde_json::json!({ "ok": true }));
        }

        if method == SYSTEM_INFO_METHOD {
            return Ok(match &self.system.info {
                Some(info) => info(),
                None => serde_json::json!({ "cwd": null }),
            });
        }

        if method == SYSTEM_RESTART_METHOD {
            return Ok(match &self.system.restart {
                Some(restart) => {
                    restart();
                    serde_json::json!({ "restartable": true, "restarting": true })
                }
                None => serde_json::json!({ "restartable": false, "restarting": false }),
            });
        }

        if method == SYSTEM_RESOURCES_METHOD {
            // Without a monitor wired, degrade like an un-updated runtime.
            return match &self.system.resources {
                Some(resources) => Ok(resources()),
                None => Err(JsonRpcError::method_not_found(method)),
            };
        }

        Err(JsonRpcError::method_not_found(method))
    }

    async fn handle_extension_management_request(
        &self,
        method: &str,
        params: Option<&Value>,
    ) -> RpcResult {
        if method == EXTENSION_STATUS_METHOD {
            let extensions: Vec<Value> = self
                .servers
                .iter()
                .map(|(extension_id, server)| {
                    let mut entry = Map::new();
                    entry.insert("extensionId".to_string(), Value::from(extension_id.clone()));
                    server.status().append_to(&mut entry);
                    Value::Object(entry)
                })
                .collect();
            return Ok(serde_json::json!({ "extensions": extensions }));
        }

        if method == EXTENSION_LOGS_METHOD {
            let extension_id = extension_id_from_params(params, method)?;
            let Some(server) = self.server(&extension_id) else {
                return Ok(serde_json::json!({ "extensionId": extension_id, "lines": [] }));
            };
            let lines = params
                .and_then(|params| params.get("lines"))
                .and_then(Value::as_u64)
                .unwrap_or(200) as usize;
            let mut result = Map::new();
            result.insert("extensionId".to_string(), Value::from(extension_id));
            result.insert("lines".to_string(), server.logs(lines));
            return Ok(Value::Object(result));
        }

        if method == EXTENSION_START_METHOD {
            let extension_id = extension_id_from_params(params, method)?;
            let Some(server) = self.server(&extension_id) else {
                return Ok(serde_json::json!({
                    "extensionId": extension_id,
                    "restartable": false,
                    "running": false,
                    "started": false,
                }));
            };
            let status = server.start(rebuild_from_params(params)).await;
            let mut result = Map::new();
            result.insert("extensionId".to_string(), Value::from(extension_id));
            status.append_to(&mut result);
            result.insert("started".to_string(), Value::from(true));
            return Ok(Value::Object(result));
        }

        if method == EXTENSION_STOP_METHOD {
            let extension_id = extension_id_from_params(params, method)?;
            let Some(server) = self.server(&extension_id) else {
                return Ok(serde_json::json!({
                    "extensionId": extension_id,
                    "restartable": false,
                    "running": false,
                    "stopped": false,
                }));
            };
            let status = server.stop().await;
            let mut result = Map::new();
            result.insert("extensionId".to_string(), Value::from(extension_id));
            status.append_to(&mut result);
            result.insert("stopped".to_string(), Value::from(true));
            return Ok(Value::Object(result));
        }

        if method == EXTENSION_RESTART_METHOD {
            let extension_id = extension_id_from_params(params, method)?;
            let Some(server) = self.server(&extension_id) else {
                return Ok(serde_json::json!({
                    "extensionId": extension_id,
                    "restartable": false,
                    "restarted": false,
                    "running": false,
                }));
            };
            let status = server.restart(rebuild_from_params(params)).await;
            let mut result = Map::new();
            result.insert("extensionId".to_string(), Value::from(extension_id));
            status.append_to(&mut result);
            result.insert("restarted".to_string(), Value::from(true));
            return Ok(Value::Object(result));
        }

        if method == EXTENSION_SERVER_BUILD_METHOD || method == EXTENSION_VIEWS_BUILD_METHOD {
            let extension_id = extension_id_from_params(params, method)?;
            let Some(server) = self.server(&extension_id) else {
                return Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("unknown extension: {extension_id}"),
                ));
            };
            let status = if method == EXTENSION_SERVER_BUILD_METHOD {
                server.build_server().await?
            } else {
                server.build_views().await?
            };
            let mut result = Map::new();
            result.insert("extensionId".to_string(), Value::from(extension_id));
            status.append_to(&mut result);
            result.insert("built".to_string(), Value::from(true));
            return Ok(Value::Object(result));
        }

        if method == EXTENSION_WATCH_START_METHOD || method == EXTENSION_WATCH_STOP_METHOD {
            let extension_id = extension_id_from_params(params, method)?;
            let Some(server) = self.server(&extension_id) else {
                return Err(JsonRpcError::new(
                    EXTENSION_ERROR,
                    format!("unknown extension: {extension_id}"),
                ));
            };
            let (status, changed, flag) = if method == EXTENSION_WATCH_START_METHOD {
                let (status, started) = server.watch_start().await?;
                (status, started, "started")
            } else {
                let (status, stopped) = server.watch_stop().await;
                (status, stopped, "stopped")
            };
            let mut result = Map::new();
            result.insert("extensionId".to_string(), Value::from(extension_id));
            status.append_to(&mut result);
            result.insert(flag.to_string(), Value::from(changed));
            return Ok(Value::Object(result));
        }

        Err(JsonRpcError::method_not_found(method))
    }
}

pub fn is_system_method(method: &str) -> bool {
    method == SYSTEM_INFO_METHOD
        || method == SYSTEM_PING_METHOD
        || method == SYSTEM_RESTART_METHOD
        || method == SYSTEM_RESOURCES_METHOD
}

pub fn is_extension_management_method(method: &str) -> bool {
    method == EXTENSION_STATUS_METHOD
        || method == EXTENSION_START_METHOD
        || method == EXTENSION_STOP_METHOD
        || method == EXTENSION_RESTART_METHOD
        || method == EXTENSION_WATCH_START_METHOD
        || method == EXTENSION_WATCH_STOP_METHOD
        || method == EXTENSION_SERVER_BUILD_METHOD
        || method == EXTENSION_VIEWS_BUILD_METHOD
        || method == EXTENSION_LOGS_METHOD
}

pub fn is_core_method(method: &str) -> bool {
    method.starts_with("remux/fs/")
}

pub fn extension_id_from_method(method: &str) -> Option<&str> {
    let rest = method.strip_prefix("remux/")?;
    let (extension_id, _) = rest.split_once('/')?;
    if extension_id.is_empty() {
        return None;
    }
    Some(extension_id)
}

fn extension_id_from_params(params: Option<&Value>, method: &str) -> Result<String, JsonRpcError> {
    params
        .and_then(|params| params.get("extensionId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| JsonRpcError::new(INVALID_PARAMS, format!("Invalid {method} params")))
}

fn rebuild_from_params(params: Option<&Value>) -> bool {
    params
        .and_then(|params| params.get("rebuild"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    struct FixtureServer {
        extension_id: String,
        calls: Arc<Mutex<Vec<String>>>,
        running: Mutex<bool>,
        watch_declared: bool,
        watching: Mutex<bool>,
    }

    impl FixtureServer {
        fn new(extension_id: &str, calls: Arc<Mutex<Vec<String>>>) -> Arc<Self> {
            Self::with_watch(extension_id, calls, false)
        }

        fn with_watch(
            extension_id: &str,
            calls: Arc<Mutex<Vec<String>>>,
            watch_declared: bool,
        ) -> Arc<Self> {
            Arc::new(Self {
                extension_id: extension_id.to_string(),
                calls,
                running: Mutex::new(false),
                watch_declared,
                watching: Mutex::new(false),
            })
        }

        fn snapshot(&self) -> ServerStatus {
            let watching = *self.watching.lock().unwrap();
            ServerStatus {
                restartable: true,
                running: *self.running.lock().unwrap(),
                state: "Running".to_string(),
                pid: None,
                started_at_ms: None,
                restart_count: 0,
                last_exit: None,
                has_build: false,
                has_server: true,
                has_server_build: false,
                views: ViewsFacet::default(),
                watch: WatchFacet {
                    declared: self.watch_declared,
                    state: if watching { "running" } else { "stopped" }.to_string(),
                    ..WatchFacet::default()
                },
            }
        }
    }

    impl ExtensionServer for FixtureServer {
        fn start(&self, rebuild: bool) -> BoxFuture<'_, ServerStatus> {
            Box::pin(async move {
                *self.running.lock().unwrap() = true;
                let suffix = if rebuild { ":rebuild" } else { "" };
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("{}:start{suffix}", self.extension_id));
                self.snapshot()
            })
        }

        fn stop(&self) -> BoxFuture<'_, ServerStatus> {
            Box::pin(async {
                *self.running.lock().unwrap() = false;
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("{}:stop", self.extension_id));
                self.snapshot()
            })
        }

        fn restart(&self, rebuild: bool) -> BoxFuture<'_, ServerStatus> {
            Box::pin(async move {
                self.stop().await;
                self.start(rebuild).await
            })
        }

        fn watch_start(&self) -> BoxFuture<'_, Result<(ServerStatus, bool), JsonRpcError>> {
            Box::pin(async {
                if !self.watch_declared {
                    return Err(JsonRpcError::new(EXTENSION_ERROR, "watch not declared"));
                }
                let started = {
                    let mut watching = self.watching.lock().unwrap();
                    let started = !*watching;
                    *watching = true;
                    started
                };
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("{}:watch-start", self.extension_id));
                Ok((self.snapshot(), started))
            })
        }

        fn watch_stop(&self) -> BoxFuture<'_, (ServerStatus, bool)> {
            Box::pin(async {
                let stopped = {
                    let mut watching = self.watching.lock().unwrap();
                    let stopped = *watching;
                    *watching = false;
                    stopped
                };
                (self.snapshot(), stopped)
            })
        }

        fn handle_rpc(&self, method: String, params: Option<Value>) -> BoxFuture<'_, RpcResult> {
            let extension_id = self.extension_id.clone();
            Box::pin(async move {
                Ok(json!({
                    "extensionId": extension_id,
                    "method": method,
                    "params": params,
                }))
            })
        }

        fn handle_notification(&self, method: String, _params: Option<Value>) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("{}:notify:{method}", self.extension_id));
        }

        fn status(&self) -> ServerStatus {
            self.snapshot()
        }

        fn logs(&self, _lines: usize) -> Value {
            json!([])
        }
    }

    struct FixtureCore;

    impl CoreRpc for FixtureCore {
        fn handle_rpc(&self, method: String, params: Option<Value>) -> BoxFuture<'_, RpcResult> {
            Box::pin(async move {
                Ok(json!({ "core": true, "method": method, "params": params }))
            })
        }
    }

    fn fixture_router(calls: &Arc<Mutex<Vec<String>>>) -> RpcRouter {
        let servers: Vec<(String, Arc<dyn ExtensionServer>)> = vec![
            (
                "codex".to_string(),
                FixtureServer::new("codex", calls.clone()) as Arc<dyn ExtensionServer>,
            ),
            (
                "fs".to_string(),
                FixtureServer::new("fs-extension", calls.clone()),
            ),
            (
                "files".to_string(),
                FixtureServer::with_watch("files", calls.clone(), true),
            ),
        ];
        let system_calls = calls.clone();
        RpcRouter::new(
            servers,
            Some("codex".to_string()),
            Some(Arc::new(FixtureCore)),
            SystemHooks {
                info: Some(Box::new(|| json!({ "cwd": "/tmp/remux-runtime" }))),
                restart: Some(Box::new(move || {
                    system_calls.lock().unwrap().push("system:restart".to_string());
                })),
                resources: None,
            },
        )
    }

    #[test]
    fn extension_id_from_method_extracts_remux_namespaces() {
        assert_eq!(
            extension_id_from_method("remux/codex/transcript/read"),
            Some("codex")
        );
        assert_eq!(extension_id_from_method("remux/files/list"), Some("files"));
        assert_eq!(extension_id_from_method("host/viewport/get"), None);
        assert_eq!(extension_id_from_method("ping"), None);
    }

    #[tokio::test]
    async fn routes_by_remux_namespace_with_dispatch_order() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let router = fixture_router(&calls);

        router.start(false).await;
        {
            let mut started = calls.lock().unwrap().clone();
            started.sort();
            assert_eq!(
                started,
                vec!["codex:start", "files:start", "fs-extension:start"]
            );
        }

        // Core methods win over the `fs` extension namespace.
        for method in [
            "remux/fs/readDirectory",
            "remux/fs/readDirectories",
            "remux/fs/readFile",
        ] {
            let result = router
                .handle_request(method, Some(&json!({ "path": "/tmp" })))
                .await
                .unwrap();
            assert_eq!(result["core"], json!(true));
            assert_eq!(result["method"], json!(method));
        }

        let result = router
            .handle_request("remux/files/list", Some(&json!({ "cwd": "/tmp" })))
            .await
            .unwrap();
        assert_eq!(result["extensionId"], json!("files"));

        // Unprefixed methods go to the default extension.
        let result = router.handle_request("legacy/ping", None).await.unwrap();
        assert_eq!(result["extensionId"], json!("codex"));
        assert_eq!(result["params"], Value::Null);

        let status = router
            .handle_request(EXTENSION_STATUS_METHOD, None)
            .await
            .unwrap();
        let extensions = status["extensions"].as_array().unwrap();
        assert_eq!(extensions.len(), 3);
        assert_eq!(extensions[0]["extensionId"], json!("codex"));
        assert_eq!(extensions[0]["restartable"], json!(true));
        assert_eq!(extensions[0]["running"], json!(true));
        assert_eq!(extensions[0]["state"], json!("Running"));

        let restarted = router
            .handle_request(
                EXTENSION_RESTART_METHOD,
                Some(&json!({ "extensionId": "files" })),
            )
            .await
            .unwrap();
        assert_eq!(restarted["restarted"], json!(true));
        assert_eq!(restarted["running"], json!(true));

        let stopped = router
            .handle_request(
                EXTENSION_STOP_METHOD,
                Some(&json!({ "extensionId": "files" })),
            )
            .await
            .unwrap();
        assert_eq!(stopped["stopped"], json!(true));
        assert_eq!(stopped["running"], json!(false));

        let started = router
            .handle_request(
                EXTENSION_START_METHOD,
                Some(&json!({ "extensionId": "files" })),
            )
            .await
            .unwrap();
        assert_eq!(started["started"], json!(true));
        assert_eq!(started["running"], json!(true));
        assert_eq!(started["hasBuild"], json!(false));

        // Optional rebuild param reaches the server on start and restart.
        router
            .handle_request(
                EXTENSION_START_METHOD,
                Some(&json!({ "extensionId": "files", "rebuild": true })),
            )
            .await
            .unwrap();
        router
            .handle_request(
                EXTENSION_RESTART_METHOD,
                Some(&json!({ "extensionId": "files", "rebuild": true })),
            )
            .await
            .unwrap();
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| *call == "files:start:rebuild")
                .count(),
            2
        );

        assert_eq!(
            router.handle_request(SYSTEM_PING_METHOD, None).await.unwrap(),
            json!({ "ok": true })
        );
        assert_eq!(
            router.handle_request(SYSTEM_INFO_METHOD, None).await.unwrap(),
            json!({ "cwd": "/tmp/remux-runtime" })
        );
        assert_eq!(
            router.handle_request(SYSTEM_RESTART_METHOD, None).await.unwrap(),
            json!({ "restartable": true, "restarting": true })
        );

        router.stop().await;
        let calls = calls.lock().unwrap();
        assert!(calls.contains(&"system:restart".to_string()));
        let mut last = calls[calls.len() - 3..].to_vec();
        last.sort();
        assert_eq!(last, ["codex:stop", "files:stop", "fs-extension:stop"]);
    }

    #[tokio::test]
    async fn watch_rpcs_route_with_idempotency_flags_and_errors() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let router = fixture_router(&calls);

        // Happy path: first start flips the flag, second is idempotent.
        let started = router
            .handle_request(
                EXTENSION_WATCH_START_METHOD,
                Some(&json!({ "extensionId": "files" })),
            )
            .await
            .unwrap();
        assert_eq!(started["started"], json!(true));
        assert_eq!(started["watch"]["declared"], json!(true));
        assert_eq!(started["watch"]["state"], json!("running"));
        let again = router
            .handle_request(
                EXTENSION_WATCH_START_METHOD,
                Some(&json!({ "extensionId": "files" })),
            )
            .await
            .unwrap();
        assert_eq!(again["started"], json!(false));

        let stopped = router
            .handle_request(
                EXTENSION_WATCH_STOP_METHOD,
                Some(&json!({ "extensionId": "files" })),
            )
            .await
            .unwrap();
        assert_eq!(stopped["stopped"], json!(true));
        assert_eq!(stopped["watch"]["state"], json!("stopped"));
        let stopped_again = router
            .handle_request(
                EXTENSION_WATCH_STOP_METHOD,
                Some(&json!({ "extensionId": "files" })),
            )
            .await
            .unwrap();
        assert_eq!(stopped_again["stopped"], json!(false));

        // No watch declared (codex fixture) → error.
        let err = router
            .handle_request(
                EXTENSION_WATCH_START_METHOD,
                Some(&json!({ "extensionId": "codex" })),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code, EXTENSION_ERROR);
        assert_eq!(err.message, "watch not declared");

        // Unknown extension → error (not a degenerate shape: watch is new
        // enough that no old app calls it blind).
        let err = router
            .handle_request(
                EXTENSION_WATCH_START_METHOD,
                Some(&json!({ "extensionId": "nope" })),
            )
            .await
            .unwrap_err();
        assert_eq!(err.message, "unknown extension: nope");

        let err = router
            .handle_request(EXTENSION_WATCH_START_METHOD, None)
            .await
            .unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[tokio::test]
    async fn build_rpcs_route_with_not_declared_and_unknown_errors() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let router = fixture_router(&calls);

        // Fixtures use the trait defaults: no build phases declared.
        for method in [EXTENSION_SERVER_BUILD_METHOD, EXTENSION_VIEWS_BUILD_METHOD] {
            let err = router
                .handle_request(method, Some(&json!({ "extensionId": "codex" })))
                .await
                .unwrap_err();
            assert_eq!(err.code, EXTENSION_ERROR);
            assert!(err.message.ends_with("build not declared"), "{}", err.message);

            let err = router
                .handle_request(method, Some(&json!({ "extensionId": "nope" })))
                .await
                .unwrap_err();
            assert_eq!(err.message, "unknown extension: nope");

            let err = router.handle_request(method, None).await.unwrap_err();
            assert_eq!(err.code, INVALID_PARAMS);
        }
    }

    #[test]
    fn status_appends_facets_in_stable_order_after_has_build() {
        let status = ServerStatus {
            restartable: true,
            running: false,
            state: "stopped".to_string(),
            pid: None,
            started_at_ms: None,
            restart_count: 0,
            last_exit: None,
            has_build: true,
            has_server: false,
            has_server_build: false,
            views: ViewsFacet {
                declared: 1,
                built: true,
                last_build_at_ms: Some(42),
            },
            watch: WatchFacet {
                declared: true,
                state: "running".to_string(),
                pid: Some(9),
                started_at_ms: Some(7),
                restart_count: 2,
            },
        };
        let mut target = Map::new();
        status.append_to(&mut target);
        let keys: Vec<&String> = target.keys().collect();
        assert_eq!(
            keys,
            [
                "restartable",
                "running",
                "state",
                "pid",
                "startedAtMs",
                "restartCount",
                "lastExit",
                "hasBuild",
                "hasServer",
                "hasServerBuild",
                "views",
                "watch",
            ]
        );
        assert_eq!(
            target["views"],
            json!({ "declared": 1, "built": true, "lastBuildAtMs": 42 })
        );
        assert_eq!(
            target["watch"],
            json!({
                "declared": true,
                "state": "running",
                "pid": 9,
                "startedAtMs": 7,
                "restartCount": 2,
            })
        );

        // Undeclared watch is `{ declared: false }` and nothing else.
        let undeclared = ServerStatus {
            watch: WatchFacet::default(),
            ..status
        };
        let mut target = Map::new();
        undeclared.append_to(&mut target);
        assert_eq!(target["watch"], json!({ "declared": false }));
    }

    #[tokio::test]
    async fn unknown_extension_management_targets_return_degenerate_shapes() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let router = fixture_router(&calls);

        let result = router
            .handle_request(
                EXTENSION_START_METHOD,
                Some(&json!({ "extensionId": "nope" })),
            )
            .await
            .unwrap();
        assert_eq!(
            result,
            json!({
                "extensionId": "nope",
                "restartable": false,
                "running": false,
                "started": false,
            })
        );

        let err = router
            .handle_request(EXTENSION_START_METHOD, None)
            .await
            .unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
        assert_eq!(err.message, "Invalid remux/extensions/start params");

        // `remux/extensions/logs` for an unknown id returns empty lines.
        let logs = router
            .handle_request(
                EXTENSION_LOGS_METHOD,
                Some(&json!({ "extensionId": "nope" })),
            )
            .await
            .unwrap();
        assert_eq!(logs, json!({ "extensionId": "nope", "lines": [] }));

        // Methods with an unknown remux prefix do not fall back to the default.
        let err = router
            .handle_request("remux/unknown/thing", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, crate::rpc::jsonrpc::METHOD_NOT_FOUND);
        assert_eq!(err.message, "Method not found: remux/unknown/thing");
    }
}
