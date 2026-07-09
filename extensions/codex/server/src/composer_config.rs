use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

#[derive(Clone, Debug)]
pub(crate) struct ComposerConfigStore {
    persistence_path: Option<PathBuf>,
    state: Arc<Mutex<ComposerConfigState>>,
}

impl Default for ComposerConfigStore {
    fn default() -> Self {
        Self {
            persistence_path: None,
            state: Arc::new(Mutex::new(ComposerConfigState::default())),
        }
    }
}

#[derive(Debug)]
struct ComposerConfigState {
    config: ComposerConfig,
    revision: u64,
    thread_observed: HashMap<String, ObservedComposerConfig>,
    thread_preferences: HashMap<String, ObservedComposerConfig>,
}

impl Default for ComposerConfigState {
    fn default() -> Self {
        Self {
            config: ComposerConfig::default(),
            revision: 1,
            thread_observed: HashMap::new(),
            thread_preferences: HashMap::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ComposerIntelligence {
    #[serde(rename = "none")]
    NoReasoning,
    Minimal,
    Low,
    Medium,
    High,
    #[serde(rename = "xhigh")]
    Xhigh,
    Max,
    Ultra,
}

impl Default for ComposerIntelligence {
    fn default() -> Self {
        Self::High
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ComposerReviewMode {
    AutoReview,
    Default,
    FullAccess,
}

impl Default for ComposerReviewMode {
    fn default() -> Self {
        Self::AutoReview
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ComposerSpeed {
    Default,
    Fast,
}

impl Default for ComposerSpeed {
    fn default() -> Self {
        Self::Default
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComposerConfig {
    pub(crate) intelligence: ComposerIntelligence,
    #[serde(default)]
    pub(crate) model: Option<String>,
    pub(crate) review_mode: ComposerReviewMode,
    pub(crate) speed: ComposerSpeed,
}

impl Default for ComposerConfig {
    fn default() -> Self {
        Self {
            intelligence: ComposerIntelligence::High,
            model: None,
            review_mode: ComposerReviewMode::AutoReview,
            speed: ComposerSpeed::Default,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservedComposerConfig {
    pub(crate) intelligence: Option<ComposerIntelligence>,
    pub(crate) model: Option<String>,
    pub(crate) review_mode: Option<ComposerReviewMode>,
    pub(crate) speed: Option<ComposerSpeed>,
}

impl ObservedComposerConfig {
    pub(crate) fn is_empty(&self) -> bool {
        self.intelligence.is_none()
            && self.model.is_none()
            && self.review_mode.is_none()
            && self.speed.is_none()
    }

    fn apply_to(&self, mut config: ComposerConfig) -> ComposerConfig {
        if let Some(intelligence) = self.intelligence {
            config.intelligence = intelligence;
        }
        if let Some(model) = &self.model {
            config.model = Some(model.clone());
        }
        if let Some(review_mode) = self.review_mode {
            config.review_mode = review_mode;
        }
        if let Some(speed) = self.speed {
            config.speed = speed;
        }
        config
    }

    fn from_config(config: &ComposerConfig) -> Self {
        Self {
            intelligence: Some(config.intelligence),
            model: config.model.clone(),
            review_mode: Some(config.review_mode),
            speed: Some(config.speed),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComposerConfigWriteParams {
    intelligence: Option<ComposerIntelligence>,
    model: Option<String>,
    review_mode: Option<ComposerReviewMode>,
    speed: Option<ComposerSpeed>,
    thread_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedComposerConfigState {
    config: ComposerConfig,
    thread_configs: HashMap<String, ObservedComposerConfig>,
    version: u32,
}

impl ComposerConfigStore {
    pub(crate) fn new(persistence_path: PathBuf) -> Self {
        Self {
            state: Arc::new(Mutex::new(load_persisted_state(&persistence_path))),
            persistence_path: Some(persistence_path),
        }
    }

    pub(crate) fn read_config(&self) -> Result<Value, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "composer config store poisoned".to_string())?;
        Ok(config_response(&state.config, state.revision))
    }

    pub(crate) fn write_config(&self, params: Value) -> Result<Value, String> {
        let params: ComposerConfigWriteParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid composer config params: {error}"))?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "composer config store poisoned".to_string())?;
        let thread_id = params
            .thread_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let previous = config_for_thread_locked(&state, thread_id.as_deref().unwrap_or(""));
        let mut next = previous.clone();

        if let Some(intelligence) = params.intelligence {
            next.intelligence = intelligence;
        }
        if let Some(model) = &params.model {
            next.model = Some(model.clone());
        }
        if let Some(review_mode) = params.review_mode {
            next.review_mode = review_mode;
        }
        if let Some(speed) = params.speed {
            next.speed = speed;
        }

        if let Some(thread_id) = thread_id {
            let preference = state.thread_preferences.entry(thread_id).or_default();
            if let Some(intelligence) = params.intelligence {
                preference.intelligence = Some(intelligence);
            }
            if let Some(model) = &params.model {
                preference.model = Some(model.clone());
            }
            if let Some(review_mode) = params.review_mode {
                preference.review_mode = Some(review_mode);
            }
            if let Some(speed) = params.speed {
                preference.speed = Some(speed);
            }
        } else {
            state.config = next.clone();
        }

        if next != previous {
            state.revision += 1;
            self.persist_state(&state)?;
        }

        Ok(config_response(&next, state.revision))
    }

    pub(crate) fn seed_thread_config(
        &self,
        thread_id: &str,
        config: ComposerConfig,
    ) -> Result<(), String> {
        let thread_id = thread_id.trim();
        if thread_id.is_empty() {
            return Ok(());
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| "composer config store poisoned".to_string())?;
        let observed = ObservedComposerConfig::from_config(&config);
        let previous = state
            .thread_preferences
            .insert(thread_id.to_string(), observed.clone());
        if previous != Some(observed) {
            state.revision += 1;
            self.persist_state(&state)?;
        }
        Ok(())
    }

    pub(crate) fn seed_thread_config_from_observed(
        &self,
        thread_id: &str,
        observed: ObservedComposerConfig,
    ) -> Result<(), String> {
        let thread_id = thread_id.trim();
        if thread_id.is_empty() || observed.is_empty() {
            return Ok(());
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| "composer config store poisoned".to_string())?;
        state
            .thread_observed
            .insert(thread_id.to_string(), observed);
        Ok(())
    }

    pub(crate) fn config_for_thread(&self, thread_id: &str) -> Result<ComposerConfig, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "composer config store poisoned".to_string())?;
        Ok(config_for_thread_locked(&state, thread_id))
    }

    pub(crate) fn read_thread_config(&self, thread_id: &str) -> Result<Value, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "composer config store poisoned".to_string())?;
        let config = config_for_thread_locked(&state, thread_id);
        Ok(config_response(&config, state.revision))
    }

    pub(crate) fn thread_start_params(&self) -> Result<Map<String, Value>, String> {
        Ok(thread_params(&self.snapshot()?))
    }

    pub(crate) fn thread_start_params_for_config(
        &self,
        config: &ComposerConfig,
    ) -> Map<String, Value> {
        thread_params(config)
    }

    pub(crate) fn turn_start_params_for_thread(
        &self,
        thread_id: &str,
    ) -> Result<Map<String, Value>, String> {
        Ok(turn_params(&self.config_for_thread(thread_id)?))
    }

    fn snapshot(&self) -> Result<ComposerConfig, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "composer config store poisoned".to_string())?;
        Ok(state.config.clone())
    }

    fn persist_state(&self, state: &ComposerConfigState) -> Result<(), String> {
        let Some(path) = &self.persistence_path else {
            return Ok(());
        };
        let persisted = PersistedComposerConfigState {
            config: state.config.clone(),
            thread_configs: state.thread_preferences.clone(),
            version: 1,
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create composer config directory: {error}"))?;
        }
        let bytes = serde_json::to_vec_pretty(&persisted)
            .map_err(|error| format!("failed to encode composer config: {error}"))?;
        fs::write(path, bytes)
            .map_err(|error| format!("failed to persist composer config: {error}"))
    }
}

fn config_response(config: &ComposerConfig, revision: u64) -> Value {
    json!({
        "config": {
            "intelligence": config.intelligence,
            "model": config.model.as_deref(),
            "reviewMode": config.review_mode,
            "revision": revision.to_string(),
            "speed": config.speed,
        }
    })
}

fn config_for_thread_locked(state: &ComposerConfigState, thread_id: &str) -> ComposerConfig {
    let thread_id = thread_id.trim();
    let config = state
        .thread_observed
        .get(thread_id)
        .map(|observed| observed.apply_to(state.config.clone()))
        .unwrap_or_else(|| state.config.clone());
    if let Some(preference) = state.thread_preferences.get(thread_id) {
        preference.apply_to(config)
    } else {
        config
    }
}

pub(crate) fn observed_config_value(observed: ObservedComposerConfig) -> Value {
    json!(observed)
}

fn load_persisted_state(path: &PathBuf) -> ComposerConfigState {
    let Ok(bytes) = fs::read(path) else {
        return ComposerConfigState::default();
    };
    let Ok(persisted) = serde_json::from_slice::<PersistedComposerConfigState>(&bytes) else {
        return ComposerConfigState::default();
    };
    if persisted.version != 1 {
        return ComposerConfigState::default();
    }

    ComposerConfigState {
        config: persisted.config,
        revision: 1,
        thread_observed: HashMap::new(),
        thread_preferences: persisted.thread_configs,
    }
}

fn thread_params(config: &ComposerConfig) -> Map<String, Value> {
    let mut params = Map::new();
    insert_shared_params(&mut params, config);

    match config.review_mode {
        ComposerReviewMode::AutoReview => {
            params.insert("approvalsReviewer".to_string(), json!("auto_review"));
        }
        ComposerReviewMode::FullAccess => {
            params.insert("approvalPolicy".to_string(), json!("never"));
            params.insert("sandbox".to_string(), json!("danger-full-access"));
        }
        ComposerReviewMode::Default => {}
    }

    params
}

fn turn_params(config: &ComposerConfig) -> Map<String, Value> {
    let mut params = Map::new();
    insert_shared_params(&mut params, config);

    match config.review_mode {
        ComposerReviewMode::AutoReview => {
            params.insert("approvalsReviewer".to_string(), json!("auto_review"));
        }
        ComposerReviewMode::FullAccess => {
            params.insert("approvalPolicy".to_string(), json!("never"));
            params.insert(
                "sandboxPolicy".to_string(),
                json!({ "type": "dangerFullAccess" }),
            );
        }
        ComposerReviewMode::Default => {}
    }

    params
}

fn insert_shared_params(params: &mut Map<String, Value>, config: &ComposerConfig) {
    params.insert("effort".to_string(), json!(config.intelligence));

    if let Some(model) = &config.model {
        params.insert("model".to_string(), json!(model));
    }

    if config.speed == ComposerSpeed::Fast {
        params.insert("serviceTier".to_string(), json!("priority"));
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    static TEMP_CONFIG_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn reads_default_config() {
        let store = ComposerConfigStore::default();

        assert_eq!(
            store.read_config().unwrap(),
            json!({
                "config": {
                    "intelligence": "high",
                    "model": null,
                    "reviewMode": "auto-review",
                    "revision": "1",
                    "speed": "default",
                }
            })
        );
    }

    #[test]
    fn writes_partial_config_and_increments_revision() {
        let store = ComposerConfigStore::default();

        let response = store
            .write_config(json!({
                "intelligence": "xhigh",
                "reviewMode": "full-access",
                "speed": "fast",
            }))
            .unwrap();

        assert_eq!(
            response["config"],
            json!({
                "intelligence": "xhigh",
                "model": null,
                "reviewMode": "full-access",
                "revision": "2",
                "speed": "fast",
            })
        );
        assert_eq!(
            store.write_config(json!({ "speed": "fast" })).unwrap()["config"]["revision"],
            "2"
        );
    }

    #[test]
    fn rejects_unknown_config_values() {
        let store = ComposerConfigStore::default();

        let error = store
            .write_config(json!({ "reviewMode": "danger" }))
            .unwrap_err();

        assert!(error.contains("invalid composer config params"));
    }

    #[test]
    fn maps_config_to_codex_app_server_params() {
        let store = ComposerConfigStore::default();
        store
            .write_config(json!({
                "intelligence": "xhigh",
                "reviewMode": "full-access",
                "speed": "fast",
            }))
            .unwrap();

        assert_eq!(
            Value::Object(store.thread_start_params().unwrap()),
            json!({
                "approvalPolicy": "never",
                "effort": "xhigh",
                "sandbox": "danger-full-access",
                "serviceTier": "priority",
            })
        );
        assert_eq!(
            Value::Object(store.turn_start_params_for_thread("thread-1").unwrap()),
            json!({
                "approvalPolicy": "never",
                "effort": "xhigh",
                "sandboxPolicy": { "type": "dangerFullAccess" },
                "serviceTier": "priority",
            })
        );
    }

    #[test]
    fn maps_global_and_thread_model_to_codex_app_server_params() {
        let store = ComposerConfigStore::default();
        store
            .write_config(json!({
                "model": "gpt-5.5",
            }))
            .unwrap();
        store
            .write_config(json!({
                "threadId": "thread-1",
                "model": "gpt-5.6-terra",
            }))
            .unwrap();

        assert_eq!(
            Value::Object(store.thread_start_params().unwrap()),
            json!({
                "approvalsReviewer": "auto_review",
                "effort": "high",
                "model": "gpt-5.5",
            })
        );
        assert_eq!(
            Value::Object(store.turn_start_params_for_thread("thread-1").unwrap()),
            json!({
                "approvalsReviewer": "auto_review",
                "effort": "high",
                "model": "gpt-5.6-terra",
            })
        );
    }

    #[test]
    fn persists_explicit_thread_preferences() {
        let (dir, path) = temp_config_path("persist-thread");
        let store = ComposerConfigStore::new(path.clone());
        store
            .write_config(json!({
                "threadId": "thread-1",
                "intelligence": "low",
                "speed": "fast",
            }))
            .unwrap();

        let reloaded = ComposerConfigStore::new(path);

        assert_eq!(
            reloaded.read_thread_config("thread-1").unwrap()["config"],
            json!({
                "intelligence": "low",
                "model": null,
                "reviewMode": "auto-review",
                "revision": "1",
                "speed": "fast",
            })
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn observed_seed_is_partial_and_not_persisted() {
        let (dir, path) = temp_config_path("observed-seed");
        let store = ComposerConfigStore::new(path.clone());
        store
            .write_config(json!({
                "speed": "fast",
            }))
            .unwrap();
        store
            .seed_thread_config_from_observed(
                "thread-1",
                ObservedComposerConfig {
                    intelligence: Some(ComposerIntelligence::Low),
                    model: None,
                    review_mode: None,
                    speed: None,
                },
            )
            .unwrap();

        assert_eq!(
            store.read_thread_config("thread-1").unwrap()["config"],
            json!({
                "intelligence": "low",
                "model": null,
                "reviewMode": "auto-review",
                "revision": "2",
                "speed": "fast",
            })
        );

        let reloaded = ComposerConfigStore::new(path);
        assert_eq!(
            reloaded.read_thread_config("thread-1").unwrap()["config"],
            json!({
                "intelligence": "high",
                "model": null,
                "reviewMode": "auto-review",
                "revision": "1",
                "speed": "fast",
            })
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn loads_persisted_config_without_model() {
        let (dir, path) = temp_config_path("backward-compatible");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "config": {
                    "intelligence": "medium",
                    "reviewMode": "default",
                    "speed": "fast",
                },
                "threadConfigs": {},
                "version": 1,
            }))
            .unwrap(),
        )
        .unwrap();

        let store = ComposerConfigStore::new(path);

        assert_eq!(
            store.read_config().unwrap()["config"],
            json!({
                "intelligence": "medium",
                "model": null,
                "reviewMode": "default",
                "revision": "1",
                "speed": "fast",
            })
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn model_round_trips_through_persistence() {
        let (dir, path) = temp_config_path("model-round-trip");
        let store = ComposerConfigStore::new(path.clone());
        store
            .write_config(json!({
                "model": "gpt-5.5",
            }))
            .unwrap();
        store
            .write_config(json!({
                "threadId": "thread-1",
                "model": "gpt-5.6-terra",
            }))
            .unwrap();

        let reloaded = ComposerConfigStore::new(path);

        assert_eq!(
            reloaded.read_config().unwrap()["config"]["model"],
            "gpt-5.5"
        );
        assert_eq!(
            reloaded.read_thread_config("thread-1").unwrap()["config"]["model"],
            "gpt-5.6-terra"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn thread_preference_persists_only_written_fields() {
        let (dir, path) = temp_config_path("partial-thread-preference");
        let store = ComposerConfigStore::new(path.clone());
        store
            .seed_thread_config_from_observed(
                "thread-1",
                ObservedComposerConfig {
                    intelligence: Some(ComposerIntelligence::Low),
                    model: None,
                    review_mode: None,
                    speed: None,
                },
            )
            .unwrap();
        store
            .write_config(json!({
                "threadId": "thread-1",
                "speed": "fast",
            }))
            .unwrap();

        assert_eq!(
            store.read_thread_config("thread-1").unwrap()["config"],
            json!({
                "intelligence": "low",
                "model": null,
                "reviewMode": "auto-review",
                "revision": "2",
                "speed": "fast",
            })
        );

        let reloaded = ComposerConfigStore::new(path);
        assert_eq!(
            reloaded.read_thread_config("thread-1").unwrap()["config"],
            json!({
                "intelligence": "high",
                "model": null,
                "reviewMode": "auto-review",
                "revision": "1",
                "speed": "fast",
            })
        );
        reloaded
            .seed_thread_config_from_observed(
                "thread-1",
                ObservedComposerConfig {
                    intelligence: Some(ComposerIntelligence::Low),
                    model: None,
                    review_mode: None,
                    speed: None,
                },
            )
            .unwrap();
        assert_eq!(
            reloaded.read_thread_config("thread-1").unwrap()["config"],
            json!({
                "intelligence": "low",
                "model": null,
                "reviewMode": "auto-review",
                "revision": "1",
                "speed": "fast",
            })
        );

        let _ = fs::remove_dir_all(dir);
    }

    fn temp_config_path(suffix: &str) -> (PathBuf, PathBuf) {
        let counter = TEMP_CONFIG_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "remux-composer-config-test-{suffix}-{nanos}-{counter}"
        ));
        let path = dir.join("composer-config.json");
        (dir, path)
    }
}
