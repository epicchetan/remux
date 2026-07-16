//! JSON-RPC 2.0 frame helpers, ported from `cli/jsonRpc.cjs`. Error codes and
//! message shapes are protocol surface — preserved exactly.

use serde_json::{Map, Value};

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
pub const EXTENSION_ERROR: i64 = -32000;

#[derive(Debug, Clone, PartialEq)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl JsonRpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(code: i64, message: impl Into<String>, data: Value) -> Self {
        Self {
            code,
            message: message.into(),
            data: Some(data),
        }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(METHOD_NOT_FOUND, format!("Method not found: {method}"))
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(INTERNAL_ERROR, message)
    }

    /// Port of `toJsonRpcError` for error payloads arriving as JSON values
    /// (extension responses): integer `code` or `-32603`, string `message` or
    /// `Internal error`, `data` passed through.
    pub fn from_value(error: &Value) -> Self {
        match error.as_object() {
            Some(record) => Self {
                code: record
                    .get("code")
                    .and_then(Value::as_i64)
                    .unwrap_or(INTERNAL_ERROR),
                message: record
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Internal error")
                    .to_string(),
                data: record.get("data").cloned(),
            },
            None => Self::new(
                INTERNAL_ERROR,
                error
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| "Internal error".to_string()),
            ),
        }
    }

    pub fn payload(&self) -> Value {
        let mut payload = Map::new();
        payload.insert("code".to_string(), Value::from(self.code));
        payload.insert("message".to_string(), Value::from(self.message.clone()));
        if let Some(data) = &self.data {
            payload.insert("data".to_string(), data.clone());
        }
        Value::Object(payload)
    }
}

impl std::fmt::Display for JsonRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for JsonRpcError {}

#[derive(Debug)]
pub struct ParsedFrame {
    pub error: Option<JsonRpcError>,
    /// String or number id when present, `Value::Null` otherwise.
    pub id: Value,
    pub message: Option<Value>,
}

pub fn parse_json_rpc_frame(frame: &str) -> ParsedFrame {
    match serde_json::from_str::<Value>(frame) {
        Ok(message) => {
            if !message.is_object() {
                return ParsedFrame {
                    error: Some(JsonRpcError::new(INVALID_REQUEST, "Invalid request")),
                    id: Value::Null,
                    message: None,
                };
            }
            ParsedFrame {
                error: None,
                id: json_rpc_id_or_null(message.get("id")),
                message: Some(message),
            }
        }
        Err(_) => ParsedFrame {
            error: Some(JsonRpcError::new(PARSE_ERROR, "Parse error")),
            id: Value::Null,
            message: None,
        },
    }
}

pub fn is_json_rpc_id(value: &Value) -> bool {
    value.is_string() || value.is_number()
}

pub fn json_rpc_id_or_null(value: Option<&Value>) -> Value {
    match value {
        Some(value) if is_json_rpc_id(value) => value.clone(),
        _ => Value::Null,
    }
}

pub fn is_json_rpc_request(message: &Value) -> bool {
    message.is_object()
        && message.get("method").map(Value::is_string).unwrap_or(false)
        && message.get("id").map(is_json_rpc_id).unwrap_or(false)
}

pub fn is_json_rpc_response(message: &Value) -> bool {
    let Some(record) = message.as_object() else {
        return false;
    };
    record.get("id").map(is_json_rpc_id).unwrap_or(false)
        && !record.get("method").map(Value::is_string).unwrap_or(false)
        && (record.contains_key("result") || record.contains_key("error"))
}

pub fn response_message(id: &Value, result: Value) -> Value {
    let mut message = Map::new();
    message.insert("jsonrpc".to_string(), Value::from("2.0"));
    message.insert("id".to_string(), id.clone());
    message.insert("result".to_string(), result);
    Value::Object(message)
}

pub fn error_message(id: &Value, error: &JsonRpcError) -> Value {
    let mut message = Map::new();
    message.insert("jsonrpc".to_string(), Value::from("2.0"));
    message.insert("id".to_string(), id.clone());
    message.insert("error".to_string(), error.payload());
    Value::Object(message)
}

/// Adds `jsonrpc: "2.0"` (first key) when the message is an object without a
/// `jsonrpc` field; anything else passes through unchanged.
pub fn with_json_rpc_version(message: Value) -> Value {
    let Some(record) = message.as_object() else {
        return message;
    };
    if record.contains_key("jsonrpc") {
        return message;
    }

    let mut versioned = Map::new();
    versioned.insert("jsonrpc".to_string(), Value::from("2.0"));
    for (key, value) in record {
        versioned.insert(key.clone(), value.clone());
    }
    Value::Object(versioned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_requests_responses_and_server_originated_requests() {
        assert!(is_json_rpc_request(
            &json!({ "id": 1, "method": "thread/list" })
        ));
        assert!(is_json_rpc_response(&json!({ "id": 1, "result": {} })));
        assert!(!is_json_rpc_response(
            &json!({ "id": 1, "method": "approval/request", "params": {} })
        ));
    }

    #[test]
    fn parse_frame_returns_parse_and_invalid_request_errors() {
        let parse_error = parse_json_rpc_frame("{");
        assert_eq!(parse_error.error.unwrap().code, PARSE_ERROR);
        assert_eq!(parse_error.id, Value::Null);

        let invalid = parse_json_rpc_frame("[]");
        assert_eq!(invalid.error.unwrap().code, INVALID_REQUEST);
        assert_eq!(invalid.id, Value::Null);
    }

    #[test]
    fn formats_responses_and_errors() {
        assert_eq!(
            response_message(&json!("a"), json!({ "ok": true })),
            json!({ "jsonrpc": "2.0", "id": "a", "result": { "ok": true } })
        );
        assert_eq!(
            error_message(
                &json!(7),
                &JsonRpcError::new(METHOD_NOT_FOUND, "Method not found")
            ),
            json!({
                "jsonrpc": "2.0",
                "id": 7,
                "error": { "code": -32601, "message": "Method not found" }
            })
        );
    }

    #[test]
    fn with_json_rpc_version_preserves_existing_and_adds_missing() {
        assert_eq!(
            with_json_rpc_version(json!({ "method": "turn/started" })),
            json!({ "jsonrpc": "2.0", "method": "turn/started" })
        );
        assert_eq!(
            with_json_rpc_version(json!({ "jsonrpc": "2.0", "method": "turn/started" })),
            json!({ "jsonrpc": "2.0", "method": "turn/started" })
        );
    }

    #[test]
    fn error_from_value_normalizes_code_message_and_data() {
        let error = JsonRpcError::from_value(&json!({
            "code": -32000,
            "message": "boom",
            "data": { "detail": 1 }
        }));
        assert_eq!(error.code, -32000);
        assert_eq!(error.message, "boom");
        assert_eq!(error.data, Some(json!({ "detail": 1 })));

        let fallback = JsonRpcError::from_value(&json!({ "code": "x" }));
        assert_eq!(fallback.code, INTERNAL_ERROR);
        assert_eq!(fallback.message, "Internal error");
    }
}
