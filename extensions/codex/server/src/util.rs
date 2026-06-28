use serde_json::Value;

pub(crate) fn payload_value(row: &Value) -> Option<&Value> {
    row.get("payload").or(Some(row))
}

pub(crate) fn number_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_f64().map(|number| number as i64))
}

pub(crate) fn value_to_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

pub(crate) fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut output = text.chars().take(max_chars).collect::<String>();
    output.push_str("\n<truncated>");
    output
}

pub(crate) fn stable_revision_value(value: &Value) -> String {
    let canonical = canonical_json(value);
    format!("{:016x}", fnv1a64(canonical.as_bytes()))
}

pub(crate) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let entries = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(&map[key])
                    )
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", entries.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn revision_is_stable_for_object_key_order() {
        let left = json!({ "b": 2, "a": 1 });
        let right = json!({ "a": 1, "b": 2 });
        assert_eq!(stable_revision_value(&left), stable_revision_value(&right));
    }
}
