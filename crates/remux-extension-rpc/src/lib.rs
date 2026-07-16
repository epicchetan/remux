use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

const MAX_PENDING_REQUESTS: usize = 32;
const MAX_PROGRESS_FRAME_BYTES: usize = 16 * 1024;
const PROGRESS_METHOD: &str = "$/progress";

type Emit = dyn Fn(Value) -> Result<(), String> + Send + Sync;

#[derive(Clone)]
pub struct Peer {
    inner: Arc<Inner>,
}

struct Inner {
    emit: Arc<Emit>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<String, PendingRequest>>,
    prefix: String,
}

struct PendingRequest {
    response: mpsc::SyncSender<Result<Value, RpcError>>,
    progress: Option<mpsc::SyncSender<Value>>,
    next_progress_sequence: u64,
    deferred_terminal: Option<(Result<Value, RpcError>, u64)>,
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
        self.request_inner(method.into(), params, timeout, None)
    }

    /// Sends a correlated extension RPC request and forwards its ordered
    /// `$/progress` values to the supplied bounded channel. The caller owns
    /// the channel capacity; progress delivery never blocks the protocol
    /// reader.
    pub fn request_with_progress(
        &self,
        method: impl Into<String>,
        params: Option<Value>,
        timeout: Duration,
        progress: mpsc::SyncSender<Value>,
    ) -> Result<Value, RpcError> {
        self.request_inner(method.into(), params, timeout, Some(progress))
    }

    fn request_inner(
        &self,
        method: String,
        params: Option<Value>,
        timeout: Duration,
        progress: Option<mpsc::SyncSender<Value>>,
    ) -> Result<Value, RpcError> {
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
            pending.insert(
                id.clone(),
                PendingRequest {
                    response: sender,
                    progress,
                    next_progress_sequence: 0,
                    deferred_terminal: None,
                },
            );
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
        if record.get("method").and_then(Value::as_str) == Some(PROGRESS_METHOD) {
            return self.resolve_progress(record);
        }
        if record.get("method").is_some() {
            return false;
        }
        let Some(id) = record.get("id").and_then(Value::as_str) else {
            return false;
        };
        if !id.starts_with(&self.inner.prefix) {
            return false;
        }
        let mut requests = match self.inner.pending.lock() {
            Ok(pending) => pending,
            Err(_) => return true,
        };
        let Some(pending) = requests.get_mut(id) else {
            return true;
        };
        let result = match record.get("error") {
            Some(error) if !error.is_null() => Err(RpcError::from_value(error)),
            _ => Ok(record.get("result").cloned().unwrap_or(Value::Null)),
        };
        let progress_frames = result
            .as_ref()
            .ok()
            .and_then(|value| value.get("progressFrames"))
            .and_then(Value::as_u64);
        if pending.progress.is_some() {
            if let Some(progress_frames) = progress_frames {
                if pending.next_progress_sequence > progress_frames {
                    fail_pending(
                        &mut requests,
                        id,
                        "extension RPC terminal progress count is invalid",
                    );
                } else if pending.next_progress_sequence < progress_frames {
                    pending.deferred_terminal = Some((result, progress_frames));
                } else if let Some(pending) = requests.remove(id) {
                    let _ = pending.response.send(result);
                }
            } else if let Some(pending) = requests.remove(id) {
                let _ = pending.response.send(result);
            }
        } else if let Some(pending) = requests.remove(id) {
            let _ = pending.response.send(result);
        }
        true
    }

    fn resolve_progress(&self, record: &serde_json::Map<String, Value>) -> bool {
        let Some(params) = record.get("params").and_then(Value::as_object) else {
            return false;
        };
        let Some(id) = params.get("id").and_then(Value::as_str) else {
            return false;
        };
        if !id.starts_with(&self.inner.prefix) {
            return false;
        }

        let sequence = params.get("sequence").and_then(Value::as_u64);
        let value = params.get("value").cloned();
        let encoded_len = value
            .as_ref()
            .and_then(|value| serde_json::to_vec(value).ok())
            .map_or(usize::MAX, |bytes| bytes.len());

        let mut pending = match self.inner.pending.lock() {
            Ok(pending) => pending,
            Err(_) => return true,
        };
        let Some(request) = pending.get_mut(id) else {
            // A late frame for a request already completed or removed belongs
            // to this peer, but must not affect another request.
            return true;
        };

        let failure = if sequence != Some(request.next_progress_sequence) {
            Some("extension RPC progress sequence is invalid")
        } else if encoded_len > MAX_PROGRESS_FRAME_BYTES {
            Some("extension RPC progress frame is too large")
        } else if request.progress.is_none() {
            Some("extension RPC request did not opt into progress")
        } else {
            None
        };
        if let Some(message) = failure {
            fail_pending(&mut pending, id, message);
            return true;
        }

        let progress = request.progress.as_ref().expect("checked above");
        match progress.try_send(value.expect("checked above")) {
            Ok(()) => request.next_progress_sequence += 1,
            Err(mpsc::TrySendError::Full(_)) => {
                fail_pending(
                    &mut pending,
                    id,
                    "extension RPC progress channel overflowed",
                );
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                fail_pending(
                    &mut pending,
                    id,
                    "extension RPC progress receiver disconnected",
                );
            }
        }
        let terminal_ready = pending.get(id).map_or(false, |request| {
            request
                .deferred_terminal
                .as_ref()
                .is_some_and(|(_, expected)| request.next_progress_sequence == *expected)
        });
        if terminal_ready {
            if let Some(mut request) = pending.remove(id) {
                if let Some((terminal, _)) = request.deferred_terminal.take() {
                    let _ = request.response.try_send(terminal);
                }
            }
        }
        true
    }

    fn remove_pending(&self, id: &str) {
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.remove(id);
        }
    }
}

fn fail_pending(pending: &mut HashMap<String, PendingRequest>, id: &str, message: &str) {
    if let Some(request) = pending.remove(id) {
        let _ = request.response.try_send(Err(RpcError::transport(message)));
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
    fn forwards_correlated_ordered_progress_before_the_terminal_response() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let peer = Peer::new("fixture", {
            let emitted = emitted.clone();
            move |value| {
                emitted.lock().unwrap().push(value);
                Ok(())
            }
        });
        let (progress_tx, progress_rx) = mpsc::sync_channel(32);
        let caller = peer.clone();
        let thread = std::thread::spawn(move || {
            caller.request_with_progress(
                "remux/target/stream",
                None,
                Duration::from_secs(1),
                progress_tx,
            )
        });
        let request = loop {
            if let Some(request) = emitted.lock().unwrap().first().cloned() {
                break request;
            }
            std::thread::yield_now();
        };
        for (sequence, delta) in ["one", "two"].into_iter().enumerate() {
            assert!(peer.resolve(&serde_json::json!({
                "jsonrpc": "2.0",
                "method": "$/progress",
                "params": {
                    "id": request["id"],
                    "sequence": sequence,
                    "value": { "type": "textDelta", "delta": delta },
                },
            })));
        }
        assert_eq!(
            progress_rx.recv().unwrap(),
            serde_json::json!({ "type": "textDelta", "delta": "one" })
        );
        assert_eq!(
            progress_rx.recv().unwrap(),
            serde_json::json!({ "type": "textDelta", "delta": "two" })
        );
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
    fn rejects_progress_sequence_gaps_and_removes_the_request() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let peer = Peer::new("fixture", {
            let emitted = emitted.clone();
            move |value| {
                emitted.lock().unwrap().push(value);
                Ok(())
            }
        });
        let (progress_tx, _progress_rx) = mpsc::sync_channel(32);
        let caller = peer.clone();
        let thread = std::thread::spawn(move || {
            caller.request_with_progress(
                "remux/target/stream",
                None,
                Duration::from_secs(1),
                progress_tx,
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
            "method": "$/progress",
            "params": {
                "id": request["id"],
                "sequence": 1,
                "value": { "type": "textDelta", "delta": "late" },
            },
        })));
        assert_eq!(
            thread.join().unwrap().unwrap_err().message,
            "extension RPC progress sequence is invalid"
        );
        assert!(peer.resolve(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": null,
        })));
    }

    #[test]
    fn defers_a_terminal_response_until_its_declared_progress_prefix_arrives() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let peer = Peer::new("fixture", {
            let emitted = emitted.clone();
            move |value| {
                emitted.lock().unwrap().push(value);
                Ok(())
            }
        });
        let (progress_tx, progress_rx) = mpsc::sync_channel(32);
        let caller = peer.clone();
        let thread = std::thread::spawn(move || {
            caller.request_with_progress(
                "remux/target/stream",
                None,
                Duration::from_secs(1),
                progress_tx,
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
            "result": { "ok": true, "progressFrames": 1 },
        })));
        assert!(!thread.is_finished());
        assert!(peer.resolve(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "$/progress",
            "params": {
                "id": request["id"],
                "sequence": 0,
                "value": { "type": "textDelta", "delta": "done" },
            },
        })));
        assert_eq!(progress_rx.recv().unwrap()["delta"], "done");
        assert_eq!(thread.join().unwrap().unwrap()["ok"], true);
    }

    #[test]
    fn progress_overflow_fails_without_blocking_the_protocol_reader() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let peer = Peer::new("fixture", {
            let emitted = emitted.clone();
            move |value| {
                emitted.lock().unwrap().push(value);
                Ok(())
            }
        });
        let (progress_tx, _progress_rx) = mpsc::sync_channel(1);
        let caller = peer.clone();
        let thread = std::thread::spawn(move || {
            caller.request_with_progress(
                "remux/target/stream",
                None,
                Duration::from_secs(1),
                progress_tx,
            )
        });
        let request = loop {
            if let Some(request) = emitted.lock().unwrap().first().cloned() {
                break request;
            }
            std::thread::yield_now();
        };
        for sequence in 0..2 {
            assert!(peer.resolve(&serde_json::json!({
                "jsonrpc": "2.0",
                "method": "$/progress",
                "params": {
                    "id": request["id"],
                    "sequence": sequence,
                    "value": { "type": "textDelta", "delta": "x" },
                },
            })));
        }
        assert_eq!(
            thread.join().unwrap().unwrap_err().message,
            "extension RPC progress channel overflowed"
        );
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
