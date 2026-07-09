#[cfg(test)]
use std::collections::VecDeque;
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;

use serde_json::{Value, json};

use crate::app_server::AppServerRuntime;

#[derive(Debug)]
pub(crate) struct CodexModelsServer {
    app_server: Arc<dyn AppServerRequester>,
}

trait AppServerRequester: Send + Sync + std::fmt::Debug {
    fn request(&self, method: &str, params: Value) -> Result<Value, String>;
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

    pub(crate) fn read_models(&self) -> Result<Value, String> {
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

        Ok(json!({ "models": models }))
    }
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
        let app_server = FakeAppServer::new(vec![Ok(json!({
            "data": [
                {
                    "displayName": "GPT-5.5",
                    "hidden": false,
                    "id": "gpt-5.5",
                    "model": "gpt-5.5"
                },
                {
                    "displayName": "Hidden",
                    "hidden": true,
                    "id": "hidden-model",
                    "model": "hidden-model"
                },
                {
                    "displayName": "GPT-5.6 Terra",
                    "id": "gpt-5.6-terra",
                    "model": "gpt-5.6-terra"
                }
            ],
            "nextCursor": null
        }))]);
        let server = CodexModelsServer::with_requester(app_server.clone());

        let response = server.read_models().unwrap();

        assert_eq!(
            app_server.calls(),
            vec![("model/list".to_string(), json!({ "limit": 100 }))]
        );
        assert_eq!(
            response,
            json!({
                "models": [
                    {
                        "displayName": "GPT-5.5",
                        "hidden": false,
                        "id": "gpt-5.5",
                        "model": "gpt-5.5"
                    },
                    {
                        "displayName": "GPT-5.6 Terra",
                        "id": "gpt-5.6-terra",
                        "model": "gpt-5.6-terra"
                    }
                ]
            })
        );
    }

    #[test]
    fn returns_app_server_error() {
        let app_server = FakeAppServer::new(vec![Err("model list failed".to_string())]);
        let server = CodexModelsServer::with_requester(app_server);

        assert_eq!(server.read_models().unwrap_err(), "model list failed");
    }
}
