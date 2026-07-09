use std::path::Path;

use serde_json::{Value, json};

use crate::composer_config::{
    ComposerIntelligence, ComposerReviewMode, ComposerSpeed, ObservedComposerConfig,
};
use crate::history::{build_session_index, file_revision, read_rows_range};
use crate::util::{number_as_i64, payload_value};

#[derive(Debug, Default)]
pub(crate) struct RolloutComposerState {
    pub(crate) cwd: Option<String>,
    pub(crate) file_revision: Option<String>,
    pub(crate) last_applied_turn_id: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) model_context_window: Option<i64>,
    pub(crate) model_provider: Option<String>,
    pub(crate) observed_config: ObservedComposerConfig,
    pub(crate) token_usage: Option<Value>,
    pub(crate) token_usage_turn_id: Option<String>,
}

pub(crate) fn read_rollout_composer_state(path: &Path) -> Result<RolloutComposerState, String> {
    let file_revision = file_revision(path)?;
    let index = build_session_index(path)?;
    let mut state = RolloutComposerState {
        file_revision: Some(file_revision),
        ..RolloutComposerState::default()
    };

    for turn_id in &index.visible_turn_ids {
        let Some(range) = index.turns.get(turn_id) else {
            continue;
        };
        for row in read_rows_range(path, range)? {
            apply_rollout_row(&mut state, turn_id, &row);
        }
    }

    Ok(state)
}

fn apply_rollout_row(state: &mut RolloutComposerState, turn_id: &str, row: &Value) {
    let payload = payload_value(row).unwrap_or(row);
    let row_type = payload
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| row.get("type").and_then(Value::as_str));

    if row_type == Some("turn_context") {
        apply_turn_context(state, turn_id, payload);
        return;
    }

    if row_type == Some("task_started") {
        if let Some(window) = number_field(payload, "model_context_window")
            .or_else(|| number_field(payload, "modelContextWindow"))
        {
            state.model_context_window = Some(window);
        }
        return;
    }

    if row_type == Some("token_count")
        && let Some(token_usage) = token_usage_from_count_payload(payload)
    {
        state.model_context_window = token_usage
            .get("modelContextWindow")
            .and_then(number_as_i64)
            .or(state.model_context_window);
        state.token_usage = Some(token_usage);
        state.token_usage_turn_id = Some(turn_id.to_string());
    }
}

fn apply_turn_context(state: &mut RolloutComposerState, turn_id: &str, payload: &Value) {
    if let Some(value) = string_field(payload, "model") {
        state.model = Some(value.clone());
        state.observed_config.model = Some(value);
    }
    if let Some(value) =
        string_field(payload, "modelProvider").or_else(|| string_field(payload, "model_provider"))
    {
        state.model_provider = Some(value);
    }
    if let Some(value) = string_field(payload, "cwd") {
        state.cwd = Some(value);
    }
    if let Some(window) = number_field(payload, "modelContextWindow")
        .or_else(|| number_field(payload, "model_context_window"))
    {
        state.model_context_window = Some(window);
    }

    if let Some(intelligence) = parse_intelligence(
        payload
            .get("effort")
            .or_else(|| payload.get("reasoning_effort"))
            .or_else(|| {
                payload
                    .get("collaboration_mode")
                    .and_then(|mode| mode.get("settings"))
                    .and_then(|settings| settings.get("reasoning_effort"))
            }),
    ) {
        state.observed_config.intelligence = Some(intelligence);
    }
    if let Some(speed) = parse_speed(
        payload
            .get("serviceTier")
            .or_else(|| payload.get("service_tier")),
    ) {
        state.observed_config.speed = Some(speed);
    }
    if let Some(review_mode) = parse_review_mode(payload) {
        state.observed_config.review_mode = Some(review_mode);
    }
    state.last_applied_turn_id = Some(turn_id.to_string());
}

fn token_usage_from_count_payload(payload: &Value) -> Option<Value> {
    let info = payload.get("info").unwrap_or(payload);
    let total = info
        .get("total_token_usage")
        .or_else(|| info.get("totalTokenUsage"))
        .and_then(token_usage_breakdown_from_rollout)?;
    let last = info
        .get("last_token_usage")
        .or_else(|| info.get("lastTokenUsage"))
        .and_then(token_usage_breakdown_from_rollout)
        .unwrap_or_else(|| total.clone());
    let model_context_window = info
        .get("model_context_window")
        .or_else(|| info.get("modelContextWindow"))
        .and_then(number_as_i64)
        .map(Value::from)
        .unwrap_or(Value::Null);

    Some(json!({
        "last": last,
        "modelContextWindow": model_context_window,
        "total": total,
    }))
}

fn token_usage_breakdown_from_rollout(value: &Value) -> Option<Value> {
    Some(json!({
        "cachedInputTokens": number_field(value, "cached_input_tokens")
            .or_else(|| number_field(value, "cachedInputTokens"))
            .unwrap_or(0),
        "inputTokens": number_field(value, "input_tokens")
            .or_else(|| number_field(value, "inputTokens"))?,
        "outputTokens": number_field(value, "output_tokens")
            .or_else(|| number_field(value, "outputTokens"))
            .unwrap_or(0),
        "reasoningOutputTokens": number_field(value, "reasoning_output_tokens")
            .or_else(|| number_field(value, "reasoningOutputTokens"))
            .unwrap_or(0),
        "totalTokens": number_field(value, "total_tokens")
            .or_else(|| number_field(value, "totalTokens"))?,
    }))
}

fn parse_intelligence(value: Option<&Value>) -> Option<ComposerIntelligence> {
    match value.and_then(Value::as_str) {
        Some("none") => Some(ComposerIntelligence::NoReasoning),
        Some("minimal") => Some(ComposerIntelligence::Minimal),
        Some("low") => Some(ComposerIntelligence::Low),
        Some("medium") => Some(ComposerIntelligence::Medium),
        Some("high") => Some(ComposerIntelligence::High),
        Some("xhigh") => Some(ComposerIntelligence::Xhigh),
        Some("max") => Some(ComposerIntelligence::Max),
        Some("ultra") => Some(ComposerIntelligence::Ultra),
        _ => None,
    }
}

fn parse_speed(value: Option<&Value>) -> Option<ComposerSpeed> {
    match value.and_then(Value::as_str) {
        Some("priority") => Some(ComposerSpeed::Fast),
        Some("default") | Some("auto") => Some(ComposerSpeed::Default),
        _ => None,
    }
}

fn parse_review_mode(payload: &Value) -> Option<ComposerReviewMode> {
    let sandbox = payload
        .get("sandboxPolicy")
        .or_else(|| payload.get("sandbox_policy"));
    let sandbox_type = sandbox
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .or_else(|| sandbox.and_then(Value::as_str));
    if matches!(
        sandbox_type,
        Some("dangerFullAccess" | "danger-full-access")
    ) {
        return Some(ComposerReviewMode::FullAccess);
    }

    let approvals_reviewer = payload
        .get("approvalsReviewer")
        .or_else(|| payload.get("approvals_reviewer"))
        .and_then(Value::as_str);
    if approvals_reviewer == Some("auto_review") {
        return Some(ComposerReviewMode::AutoReview);
    }

    None
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
}

fn number_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(number_as_i64)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    static TEMP_SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn reads_latest_rollout_context_and_token_usage() {
        let (_home, path) = write_temp_session(
            r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1,"model_context_window":258400}}
{"type":"turn_context","payload":{"turn_id":"turn-1","cwd":"/tmp/project","model":"gpt-5.1-codex","effort":"low","summary":"auto","approvals_reviewer":"auto_review","service_tier":"priority"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1200,"cached_input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":1220},"last_token_usage":{"input_tokens":1200,"cached_input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":1220},"model_context_window":2400}}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
        );

        let state = read_rollout_composer_state(&path).expect("state");

        assert_eq!(state.model.as_deref(), Some("gpt-5.1-codex"));
        assert_eq!(state.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(state.model_context_window, Some(2400));
        assert_eq!(state.last_applied_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(state.token_usage_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(
            state.observed_config.intelligence,
            Some(ComposerIntelligence::Low)
        );
        assert_eq!(
            state.observed_config.review_mode,
            Some(ComposerReviewMode::AutoReview)
        );
        assert_eq!(
            state.observed_config.model.as_deref(),
            Some("gpt-5.1-codex")
        );
        assert_eq!(state.observed_config.speed, Some(ComposerSpeed::Fast));
        assert_eq!(
            state.token_usage.unwrap()["last"]["inputTokens"],
            json!(1200)
        );

        let _ = fs::remove_dir_all(_home);
    }

    #[test]
    fn leaves_speed_unset_when_rollout_has_no_service_tier() {
        let (_home, path) = write_temp_session(
            r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"turn_context","payload":{"turn_id":"turn-1","cwd":"/tmp/project","model":"gpt-5.1-codex","effort":"high"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
        );

        let state = read_rollout_composer_state(&path).expect("state");

        assert_eq!(
            state.observed_config.intelligence,
            Some(ComposerIntelligence::High)
        );
        assert_eq!(state.observed_config.speed, None);

        let _ = fs::remove_dir_all(_home);
    }

    fn write_temp_session(contents: &str) -> (PathBuf, PathBuf) {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be after epoch")
            .as_nanos();
        let counter = TEMP_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
        let home = std::env::temp_dir().join(format!(
            "remux-composer-state-test-{}-{suffix}-{counter}",
            std::process::id(),
        ));
        let session_dir = home.join("sessions").join("2026").join("01").join("01");
        fs::create_dir_all(&session_dir).expect("create session dir");
        let path = session_dir.join("rollout-2026-01-01T00-00-00-000Z-019test.jsonl");
        fs::write(&path, contents).expect("write session");
        (home, path)
    }
}
