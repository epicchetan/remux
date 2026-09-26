//! Thin authenticated loopback client; maintenance belongs to the runtime.
use std::path::Path;
use std::time::Duration;

use crate::config::{load_remux_config, load_runtime_values};
use crate::maintenance::RunOutcome;

pub fn run(root: &Path, now: bool, dry_run: bool) -> Result<i32, String> {
    let config = load_remux_config(root)?;
    let runtime = load_runtime_values(None, None, &config)?;
    let token =
        crate::auth::resolve_token(std::env::var("REMUX_AUTH_TOKEN").ok().as_deref(), root)?.token;
    let url = format!("http://127.0.0.1:{}/api/agent-autoupdate/run", runtime.port);
    let tokio = tokio::runtime::Runtime::new()
        .map_err(|error| format!("failed to start async runtime: {error}"))?;
    let outcome = tokio.block_on(async move {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            // A scheduled request can wait until the local window closes.
            .timeout(Duration::from_secs(26 * 60 * 60))
            .build()
            .map_err(|error| format!("failed to build HTTP client: {error}"))?;
        let response = client
            .post(&url)
            .bearer_auth(token)
            .json(&serde_json::json!({"now": now, "dryRun": dry_run}))
            .send()
            .await
            .map_err(|error| format!("runtime not reachable at :{} ({error})", runtime.port))?;
        if !response.status().is_success() {
            return Err(format!(
                "runtime returned HTTP {} at :{}",
                response.status().as_u16(),
                runtime.port
            ));
        }
        response
            .json::<RunOutcome>()
            .await
            .map_err(|error| format!("invalid /api/agent-autoupdate/run response: {error}"))
    })?;
    println!("{outcome}");
    Ok(
        if matches!(
            outcome,
            RunOutcome::RolledBack { .. } | RunOutcome::Held { .. }
        ) {
            1
        } else {
            0
        },
    )
}
