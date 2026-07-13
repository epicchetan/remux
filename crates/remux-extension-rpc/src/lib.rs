use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::Value;

const MAX_PENDING_REQUESTS: usize = 32;

type Emit = dyn Fn(Value) -> Result<(), String> + Send + Sync;

#[derive(Clone)]
pub struct Peer {
    inner: Arc<Inner>,
}

struct Inner {
    emit: Arc<Emit>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Result<Value, RpcError>>>>,
    prefix: String,
}

impl Peer {
    pub fn new(
        name: impl Into<String>,
        emit: impl Fn(Value) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        let name = name.into();
        Self {
            inner: Arc::new(Inner {
                emit: Arc::new(emit),
                next_id: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                prefix: format!("{name}:{}:", std::process::id()),
            }),
        }
    }

    pub fn request(
        &self,
        method: impl Into<String>,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let method = method.into();
        let id = format!(
            "{}{}",
            self.inner.prefix,
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut pending = self
                .inner
                .pending
                .lock()
                .map_err(|_| RpcError::transport("extension RPC pending map poisoned"))?;
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(RpcError::transport(
                    "extension RPC pending request limit reached",
                ));
            }
            pending.insert(id.clone(), sender);
        }

        let mut request = serde_json::Map::new();
        request.insert("jsonrpc".to_string(), Value::from("2.0"));
        request.insert("id".to_string(), Value::from(id.clone()));
        request.insert("method".to_string(), Value::from(method));
        if let Some(params) = params {
            request.insert("params".to_string(), params);
        }
        if let Err(message) = (self.inner.emit)(Value::Object(request)) {
            self.remove_pending(&id);
            return Err(RpcError::transport(message));
        }

        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.remove_pending(&id);
                Err(RpcError::transport("extension RPC request timed out"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.remove_pending(&id);
                Err(RpcError::transport(
                    "extension RPC response became unavailable",
                ))
            }
        }
    }

    /// Resolves an extension-originated request response. Returns false when
    /// the value is not a response owned by this peer.
    pub fn resolve(&self, message: &Value) -> bool {
        let Some(record) = message.as_object() else {
            return false;
        };
        if record.get("method").is_some() {
            return false;
        }
        let Some(id) = record.get("id").and_then(Value::as_str) else {
            return false;
        };
        if !id.starts_with(&self.inner.prefix) {
            return false;
        }
        let sender = self
            .inner
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(id));
        let Some(sender) = sender else {
            return true;
        };
        let result = match record.get("error") {
            Some(error) if !error.is_null() => Err(RpcError::from_value(error)),
            _ => Ok(record.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = sender.send(result);
        true
    }

    fn remove_pending(&self, id: &str) {
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.remove(id);
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    fn transport(message: impl Into<String>) -> Self {
        Self {
            code: -32000,
            message: message.into(),
            data: None,
        }
    }

    fn from_value(error: &Value) -> Self {
        Self {
            code: error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Internal error")
                .to_string(),
            data: error.get("data").cloned(),
        }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for RpcError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correlates_successful_responses() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let peer = Peer::new("fixture", {
            let emitted = emitted.clone();
            move |value| {
                emitted.lock().unwrap().push(value);
                Ok(())
            }
        });
        let caller = peer.clone();
        let thread = std::thread::spawn(move || {
            caller.request(
                "remux/target/echo",
                Some(serde_json::json!({ "value": 7 })),
                Duration::from_secs(1),
            )
        });
        let request = loop {
            if let Some(request) = emitted.lock().unwrap().first().cloned() {
                break request;
            }
            std::thread::yield_now();
        };
        assert!(peer.resolve(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": { "ok": true },
        })));
        assert_eq!(
            thread.join().unwrap().unwrap(),
            serde_json::json!({ "ok": true })
        );
    }

    #[test]
    fn preserves_remote_errors() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let peer = Peer::new("fixture", {
            let emitted = emitted.clone();
            move |value| {
                emitted.lock().unwrap().push(value);
                Ok(())
            }
        });
        let caller = peer.clone();
        let thread = std::thread::spawn(move || {
            caller.request("remux/target/fail", None, Duration::from_secs(1))
        });
        let request = loop {
            if let Some(request) = emitted.lock().unwrap().first().cloned() {
                break request;
            }
            std::thread::yield_now();
        };
        assert!(peer.resolve(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": { "code": -32042, "message": "nope", "data": { "retry": false } },
        })));
        let error = thread.join().unwrap().unwrap_err();
        assert_eq!(error.code, -32042);
        assert_eq!(error.message, "nope");
        assert_eq!(error.data, Some(serde_json::json!({ "retry": false })));
    }

    #[test]
    fn rejects_requests_above_the_bounded_pending_limit() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let peer = Peer::new("fixture", {
            let emitted = emitted.clone();
            move |value| {
                emitted.lock().unwrap().push(value);
                Ok(())
            }
        });
        let mut callers = Vec::new();
        for _ in 0..MAX_PENDING_REQUESTS {
            let caller = peer.clone();
            callers.push(std::thread::spawn(move || {
                caller.request("remux/target/block", None, Duration::from_secs(5))
            }));
        }
        while emitted.lock().unwrap().len() != MAX_PENDING_REQUESTS {
            std::thread::yield_now();
        }

        let error = peer
            .request("remux/target/overflow", None, Duration::from_millis(1))
            .unwrap_err();
        assert_eq!(error.message, "extension RPC pending request limit reached");

        for request in emitted.lock().unwrap().clone() {
            assert!(peer.resolve(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": null,
            })));
        }
        for caller in callers {
            assert_eq!(caller.join().unwrap().unwrap(), Value::Null);
        }
    }
}
