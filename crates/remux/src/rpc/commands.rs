use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use crate::rpc::jsonrpc::{JsonRpcError, INVALID_REQUEST};

const MAX_COMMAND_RECORDS: usize = 256;
const MAX_OUTCOME_BYTES: usize = 8 * 1024 * 1024;
const OUTCOME_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, PartialEq)]
pub enum RpcOutcome {
    Error(JsonRpcError),
    Result(Value),
}

impl RpcOutcome {
    fn retained_bytes(&self) -> usize {
        match self {
            Self::Error(error) => error.payload().to_string().len(),
            Self::Result(result) => result.to_string().len(),
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CommandKey {
    method: String,
    operation_id: String,
}

struct CommandRecord {
    fingerprint: String,
    _admitted_at: Instant,
    completed_at: Option<Instant>,
    outcome: watch::Sender<Option<RpcOutcome>>,
    retained_bytes: usize,
}

#[derive(Default)]
struct RegistryState {
    records: HashMap<CommandKey, CommandRecord>,
    retained_bytes: usize,
}

pub struct CommandRegistry {
    state: Mutex<RegistryState>,
}

pub enum CommandAdmission {
    Execute(CommandExecution),
    Replay {
        completed: bool,
        receiver: watch::Receiver<Option<RpcOutcome>>,
    },
}

pub struct CommandExecution {
    key: CommandKey,
}

impl Default for CommandRegistry {
    fn default() -> Self {
        Self {
            state: Mutex::new(RegistryState::default()),
        }
    }
}

impl CommandRegistry {
    pub fn admit(
        &self,
        method: &str,
        operation_id: &str,
        params: Option<&Value>,
    ) -> Result<CommandAdmission, JsonRpcError> {
        if operation_id.is_empty() || operation_id.len() > 256 {
            return Err(JsonRpcError::with_data(
                INVALID_REQUEST,
                "command operationId must be between 1 and 256 UTF-8 bytes",
                serde_json::json!({ "detail": "invalid_operation_id" }),
            ));
        }

        let key = CommandKey {
            method: method.to_string(),
            operation_id: operation_id.to_string(),
        };
        let fingerprint = parameter_fingerprint(method, params);
        let mut state = self.state.lock().unwrap();
        cleanup_expired(&mut state);

        if let Some(existing) = state.records.get(&key) {
            if existing.fingerprint != fingerprint {
                return Err(JsonRpcError::with_data(
                    INVALID_REQUEST,
                    "operationId was already admitted with different parameters",
                    serde_json::json!({ "detail": "operation_id_conflict" }),
                ));
            }
            return Ok(CommandAdmission::Replay {
                completed: existing.outcome.borrow().is_some(),
                receiver: existing.outcome.subscribe(),
            });
        }

        evict_to_fit(&mut state, 1, 0);
        if state.records.len() >= MAX_COMMAND_RECORDS {
            return Err(JsonRpcError::with_data(
                -32000,
                "Durable command admission is full",
                serde_json::json!({ "detail": "server_busy" }),
            ));
        }

        let (outcome, _) = watch::channel(None);
        state.records.insert(
            key.clone(),
            CommandRecord {
                fingerprint,
                _admitted_at: Instant::now(),
                completed_at: None,
                outcome,
                retained_bytes: 0,
            },
        );
        Ok(CommandAdmission::Execute(CommandExecution { key }))
    }

    pub fn complete(
        &self,
        execution: CommandExecution,
        outcome: RpcOutcome,
    ) -> (RpcOutcome, usize) {
        let outcome = if outcome.retained_bytes() > MAX_OUTCOME_BYTES {
            RpcOutcome::Error(JsonRpcError::with_data(
                -32000,
                "Durable command outcome exceeded the retention limit",
                serde_json::json!({ "detail": "durable_outcome_too_large" }),
            ))
        } else {
            outcome
        };
        let retained_bytes = outcome.retained_bytes();
        let mut state = self.state.lock().unwrap();
        let previous_bytes = if let Some(record) = state.records.get_mut(&execution.key) {
            let previous_bytes = record.retained_bytes;
            record.completed_at = Some(Instant::now());
            record.retained_bytes = retained_bytes;
            record.outcome.send_replace(Some(outcome.clone()));
            Some(previous_bytes)
        } else {
            None
        };
        if let Some(previous_bytes) = previous_bytes {
            state.retained_bytes = state
                .retained_bytes
                .saturating_sub(previous_bytes)
                .saturating_add(retained_bytes);
        }
        evict_to_fit(&mut state, 0, 0);
        (outcome, retained_bytes)
    }
}

pub fn operation_id_hash(operation_id: &str) -> String {
    hex_lower(&Sha256::digest(operation_id.as_bytes()))[..12].to_string()
}

pub async fn await_outcome(
    mut receiver: watch::Receiver<Option<RpcOutcome>>,
) -> Result<RpcOutcome, JsonRpcError> {
    loop {
        if let Some(outcome) = receiver.borrow().clone() {
            return Ok(outcome);
        }
        receiver.changed().await.map_err(|_| {
            JsonRpcError::new(-32000, "Durable command outcome became unavailable")
        })?;
    }
}

fn cleanup_expired(state: &mut RegistryState) {
    let now = Instant::now();
    let expired = state
        .records
        .iter()
        .filter_map(|(key, record)| {
            record
                .completed_at
                .filter(|completed| now.duration_since(*completed) >= OUTCOME_TTL)
                .map(|_| key.clone())
        })
        .collect::<Vec<_>>();
    for key in expired {
        remove_record(state, &key);
    }
}

fn evict_to_fit(state: &mut RegistryState, incoming_records: usize, incoming_bytes: usize) {
    while state.records.len().saturating_add(incoming_records) > MAX_COMMAND_RECORDS
        || state.retained_bytes.saturating_add(incoming_bytes) > MAX_OUTCOME_BYTES
    {
        let candidate = state
            .records
            .iter()
            .filter_map(|(key, record)| record.completed_at.map(|at| (key.clone(), at)))
            .min_by_key(|(_, at)| *at)
            .map(|(key, _)| key);
        let Some(candidate) = candidate else {
            break;
        };
        remove_record(state, &candidate);
    }
}

fn remove_record(state: &mut RegistryState, key: &CommandKey) {
    if let Some(record) = state.records.remove(key) {
        state.retained_bytes = state.retained_bytes.saturating_sub(record.retained_bytes);
    }
}

fn parameter_fingerprint(method: &str, params: Option<&Value>) -> String {
    let mut identity = Map::new();
    identity.insert("method".to_string(), Value::String(method.to_string()));
    identity.insert(
        "params".to_string(),
        canonical_value(params.cloned().unwrap_or(Value::Null)),
    );
    let bytes = serde_json::to_vec(&Value::Object(identity)).expect("JSON identity serializes");
    let digest = Sha256::digest(bytes);
    format!("sha256-{}", hex_lower(&digest))
}

fn canonical_value(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonical_value).collect()),
        Value::Object(values) => {
            let mut entries = values.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonical_value(value)))
                    .collect(),
            )
        }
        scalar => scalar,
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn duplicate_replays_one_terminal_outcome() {
        let registry = Arc::new(CommandRegistry::default());
        let first = registry
            .admit("remux/example/write", "op-1", Some(&serde_json::json!({ "b": 2, "a": 1 })))
            .unwrap();
        let duplicate = registry
            .admit("remux/example/write", "op-1", Some(&serde_json::json!({ "a": 1, "b": 2 })))
            .unwrap();
        let CommandAdmission::Execute(execution) = first else {
            panic!("first request must execute");
        };
        let _ = registry.complete(
            execution,
            RpcOutcome::Result(serde_json::json!({ "ok": true })),
        );
        let CommandAdmission::Replay { receiver, .. } = duplicate else {
            panic!("duplicate must replay");
        };
        assert_eq!(
            await_outcome(receiver).await.unwrap(),
            RpcOutcome::Result(serde_json::json!({ "ok": true }))
        );
    }

    #[test]
    fn conflicting_params_are_rejected() {
        let registry = CommandRegistry::default();
        registry
            .admit("remux/example/write", "op-1", Some(&serde_json::json!({ "a": 1 })))
            .unwrap();
        let error = registry
            .admit("remux/example/write", "op-1", Some(&serde_json::json!({ "a": 2 })))
            .err()
            .expect("conflict");
        assert_eq!(error.data.unwrap()["detail"], "operation_id_conflict");
    }
}
