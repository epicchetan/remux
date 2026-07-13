use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) fn stable_revision_value(value: &Value) -> String {
    let encoded = serde_json::to_vec(value).unwrap_or_default();
    format!("{:x}", Sha256::digest(encoded))
}
