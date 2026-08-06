#[cfg(test)]
use std::collections::VecDeque;
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::app_server::AppServerRuntime;

#[derive(Debug)]
pub(crate) struct CodexModelsServer {
    app_server: Arc<dyn AppServerRequester>,
}

trait AppServerRequester: Send + Sync + std::fmt::Debug {
    fn request(&self, method: &str, params: Value) -> Result<Value, String>;
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelsReadParams {
    cwd: Option<String>,
}

impl AppServerRequester for AppServerRuntime {
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        AppServerRuntime::request(self, method, params)
    }
}

impl CodexModelsServer {
    pub(crate) fn new(app_server: AppServerRuntime) -> Self {
        Self {
            app_server: Arc::new(app_server),
        }
    }

    #[cfg(test)]
    fn with_requester(app_server: Arc<dyn AppServerRequester>) -> Self {
        Self { app_server }
    }

    pub(crate) fn read_models(&self, params: Value) -> Result<Value, String> {
        let params = if params.is_null() {
            ModelsReadParams::default()
        } else {
            serde_json::from_value(params)
                .map_err(|error| format!("invalid models/read params: {error}"))?
        };
        let response = self
            .app_server
            .request("model/list", json!({ "limit": 100 }))?;
        let models = response
            .get("data")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item.get("hidden").and_then(Value::as_bool) != Some(true))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        // A null Remux model means "use app-server configuration". Resolve
        // that value for presentation without turning it into an explicit
        // thread/start override. Older app-server versions may not expose
        // config/read, so fall back to the catalog default when it fails.
        let configured_model = self
            .app_server
            .request("config/read", json!({ "cwd": params.cwd }))
            .ok()
            .and_then(|response| {
                response
                    .get("config")
                    .and_then(|config| config.get("model"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        let resolved_default_model = configured_model.or_else(|| catalog_default_model(&models));

        Ok(json!({
            "models": models,
            "resolvedDefaultModel": resolved_default_model,
        }))
    }
}

fn catalog_default_model(models: &[Value]) -> Option<String> {
    models
        .iter()
        .find(|model| model.get("isDefault").and_then(Value::as_bool) == Some(true))
        .or_else(|| models.first())
        .and_then(|model| {
            model
                .get("model")
                .or_else(|| model.get("id"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct FakeAppServer {
        calls: Mutex<Vec<(String, Value)>>,
        responses: Mutex<VecDeque<Result<Value, String>>>,
    }

    impl FakeAppServer {
        fn new(responses: Vec<Result<Value, String>>) -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                responses: Mutex::new(VecDeque::from(responses)),
            })
        }

        fn calls(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl AppServerRequester for FakeAppServer {
        fn request(&self, method: &str, params: Value) -> Result<Value, String> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err("missing fake response".to_string()))
        }
    }

    #[test]
    fn reads_visible_models_from_app_server() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({
                "data": [
                    {
                        "displayName": "GPT-5.5",
                        "hidden": false,
                        "id": "gpt-5.5-picker",
                        "isDefault": false,
                        "model": "gpt-5.5"
                    },
                    {
                        "displayName": "Hidden",
                        "hidden": true,
                        "id": "hidden-model",
                        "isDefault": false,
                        "model": "hidden-model"
                    },
                    {
                        "displayName": "GPT-5.6 Terra",
                        "id": "gpt-5.6-terra-picker",
                        "isDefault": true,
                        "model": "gpt-5.6-terra"
                    }
                ],
                "nextCursor": null
            })),
            Ok(json!({
                "config": { "model": "gpt-project-model" }
            })),
        ]);
        let server = CodexModelsServer::with_requester(app_server.clone());

        let response = server
            .read_models(json!({ "cwd": "/tmp/project" }))
            .unwrap();

        assert_eq!(
            app_server.calls(),
            vec![
                ("model/list".to_string(), json!({ "limit": 100 })),
                ("config/read".to_string(), json!({ "cwd": "/tmp/project" })),
            ]
        );
        assert_eq!(
            response,
            json!({
                "models": [
                    {
                        "displayName": "GPT-5.5",
                        "hidden": false,
                        "id": "gpt-5.5-picker",
                        "isDefault": false,
                        "model": "gpt-5.5"
                    },
                    {
                        "displayName": "GPT-5.6 Terra",
                        "id": "gpt-5.6-terra-picker",
                        "isDefault": true,
                        "model": "gpt-5.6-terra"
                    }
                ],
                "resolvedDefaultModel": "gpt-project-model"
            })
        );
    }

    #[test]
    fn falls_back_to_catalog_default_when_config_read_is_unavailable() {
        let app_server = FakeAppServer::new(vec![
            Ok(json!({
                "data": [
                    {
                        "id": "older-model",
                        "isDefault": false,
                        "model": "older-model"
                    },
                    {
                        "id": "catalog-default-picker",
                        "isDefault": true,
                        "model": "catalog-default"
                    }
                ]
            })),
            Err("config/read is unavailable".to_string()),
        ]);
        let server = CodexModelsServer::with_requester(app_server);

        assert_eq!(
            server.read_models(Value::Null).unwrap()["resolvedDefaultModel"],
            "catalog-default"
        );
    }

    #[test]
    fn returns_app_server_error() {
        let app_server = FakeAppServer::new(vec![Err("model list failed".to_string())]);
        let server = CodexModelsServer::with_requester(app_server);

        assert_eq!(
            server.read_models(Value::Null).unwrap_err(),
            "model list failed"
        );
    }
}
