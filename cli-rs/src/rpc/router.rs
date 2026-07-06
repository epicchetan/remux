//! Method routing, ported from `cli/rpcRouter.cjs`. Dispatch order: system →
//! extension management → core (`remux/fs/*`) → extension by method prefix
//! `remux/<ext>/…` else the default extension.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::rpc::jsonrpc::{JsonRpcError, INVALID_PARAMS};

pub const EXTENSION_STATUS_METHOD: &str = "remux/extensions/status";
pub const EXTENSION_START_METHOD: &str = "remux/extensions/start";
pub const EXTENSION_STOP_METHOD: &str = "remux/extensions/stop";
pub const EXTENSION_RESTART_METHOD: &str = "remux/extensions/restart";
pub const EXTENSION_LOGS_METHOD: &str = "remux/extensions/logs";
pub const SYSTEM_INFO_METHOD: &str = "remux/system/info";
pub const SYSTEM_PING_METHOD: &str = "remux/system/ping";
pub const SYSTEM_RESTART_METHOD: &str = "remux/system/restart";

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
}

#[derive(Debug, Clone, PartialEq)]
pub struct LastExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub at: i64,
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
                    Value::Object(value)
                }
                None => Value::Null,
            },
        );
    }
}

/// The contract the router expects from an extension server, mirroring the
/// duck-typed server objects `createRpcRouter` consumed in Node.
pub trait ExtensionServer: Send + Sync {
    fn start(&self) -> BoxFuture<'_, ServerStatus>;
    fn stop(&self) -> BoxFuture<'_, ServerStatus>;
    fn restart(&self) -> BoxFuture<'_, ServerStatus>;
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
/// `restart` schedules the exit-75 restart before the response is sent.
#[derive(Default)]
pub struct SystemHooks {
    pub info: Option<Box<dyn Fn() -> Value + Send + Sync>>,
    pub restart: Option<Box<dyn Fn() + Send + Sync>>,
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

    pub async fn start(&self) {
        let mut tasks = tokio::task::JoinSet::new();
        for (_, server) in &self.servers {
            let server = server.clone();
            tasks.spawn(async move {
                server.start().await;
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
            let status = server.start().await;
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
            let status = server.restart().await;
            let mut result = Map::new();
            result.insert("extensionId".to_string(), Value::from(extension_id));
            status.append_to(&mut result);
            result.insert("restarted".to_string(), Value::from(true));
            return Ok(Value::Object(result));
        }

        Err(JsonRpcError::method_not_found(method))
    }
}

pub fn is_system_method(method: &str) -> bool {
    method == SYSTEM_INFO_METHOD || method == SYSTEM_PING_METHOD || method == SYSTEM_RESTART_METHOD
}

pub fn is_extension_management_method(method: &str) -> bool {
    method == EXTENSION_STATUS_METHOD
        || method == EXTENSION_START_METHOD
        || method == EXTENSION_STOP_METHOD
        || method == EXTENSION_RESTART_METHOD
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    struct FixtureServer {
        extension_id: String,
        calls: Arc<Mutex<Vec<String>>>,
        running: Mutex<bool>,
    }

    impl FixtureServer {
        fn new(extension_id: &str, calls: Arc<Mutex<Vec<String>>>) -> Arc<Self> {
            Arc::new(Self {
                extension_id: extension_id.to_string(),
                calls,
                running: Mutex::new(false),
            })
        }

        fn snapshot(&self) -> ServerStatus {
            ServerStatus {
                restartable: true,
                running: *self.running.lock().unwrap(),
                state: "Running".to_string(),
                pid: None,
                started_at_ms: None,
                restart_count: 0,
                last_exit: None,
            }
        }
    }

    impl ExtensionServer for FixtureServer {
        fn start(&self) -> BoxFuture<'_, ServerStatus> {
            Box::pin(async {
                *self.running.lock().unwrap() = true;
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("{}:start", self.extension_id));
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

        fn restart(&self) -> BoxFuture<'_, ServerStatus> {
            Box::pin(async {
                self.stop().await;
                self.start().await
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
                FixtureServer::new("files", calls.clone()),
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

        router.start().await;
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
