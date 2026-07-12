use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use remux_compute::{Registry as ComputeRegistry, TaskOptions};
use remux_tts::{KokoroSynthesis, SynthesisProgress, SynthesisRequest};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::app_server::{AppServerEvent, AppServerRuntime};
use crate::file_resources::base64_encode;
use crate::live_transcript::LiveTranscriptStore;
use crate::narration_planning::{
    NARRATION_ACOUSTIC_TIMING_PROVIDER_VERSION, NARRATION_SOURCE_MAPPING_VERSION,
    NarrationPlanningProfile, PlanningTurnIdentity, plan_transformed_blocks,
    resolve_planning_profile,
};
use crate::narration_source_mapping::{normalized_alignment_hints, verbatim_alignment_hints};
use crate::narration_synthesis::{NarrationSynthesisProfile, resolve_synthesis_profile};
use crate::resources::CodexTranscriptServer;
use crate::util::stable_revision_value;

pub(crate) const NARRATION_UPDATED_METHOD: &str = "remux/codex/narration/updated";
const NARRATION_SOURCE_DOCUMENT_VERSION: &str = "3";
const NARRATION_MANIFEST_VERSION: u64 = 2;
const WORKER_POLL: Duration = Duration::from_millis(100);
const MAX_AUDIO_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_START_PARAMS_BYTES: usize = 2 * 1024 * 1024;
const MAX_SOURCE_TEXT_BYTES: usize = 512 * 1024;
const MAX_SOURCE_BLOCKS: usize = 2_048;
const MAX_SOURCE_TARGETS: usize = 8_192;
const MAX_SOURCE_ASSOCIATIONS: usize = 32_768;
const MAX_IDENTIFIER_BYTES: usize = 1_024;
const MAX_INACTIVE_JOBS: usize = 128;
const MAX_PLANNING_SUBSCRIPTIONS: usize = 4;
const NARRATION_JOB_BUDGET: Duration = Duration::from_secs(15 * 60);
const NARRATION_STALL_BUDGET: Duration = Duration::from_secs(60);
const WORKLOAD_INSPECT_AFTER: Duration = Duration::from_secs(2);
const WORKLOAD_INSPECT_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Debug)]
pub(crate) struct CodexNarrationServer {
    inner: Arc<NarrationInner>,
}

#[derive(Debug)]
pub(crate) struct NarrationInner {
    app_server: AppServerRuntime,
    cache_root: PathBuf,
    codex_home: PathBuf,
    compute: ComputeRegistry,
    diagnostics: Mutex<VecDeque<Value>>,
    jobs: Mutex<HashMap<String, NarrationJob>>,
    output_tx: mpsc::SyncSender<Value>,
    subscriptions: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    transcript: Mutex<CodexTranscriptServer>,
}

pub(crate) struct PlanningSubscriptionGuard {
    inner: Arc<NarrationInner>,
    thread_id: String,
}

impl Drop for PlanningSubscriptionGuard {
    fn drop(&mut self) {
        if let Ok(mut subscriptions) = self.inner.subscriptions.lock() {
            subscriptions.remove(&self.thread_id);
        }
    }
}

#[derive(Clone, Debug)]
struct NarrationJob {
    artifact_key: String,
    document: NarrationSourceDocument,
    cancel_requested: bool,
    completed_units: Option<usize>,
    error: Option<String>,
    last_access_ms: u128,
    manifest: Option<Value>,
    planning_profile: NarrationPlanningProfile,
    planning_turns: Vec<PlanningTurnIdentity>,
    revision: u64,
    stage: Option<&'static str>,
    status: NarrationStatus,
    synthesis_profile: NarrationSynthesisProfile,
    target: NarrationTarget,
    total_units: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NarrationStatus {
    Cancelled,
    Failed,
    Planning,
    Ready,
    Synthesizing,
}

impl NarrationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
            Self::Planning => "planning",
            Self::Ready => "ready",
            Self::Synthesizing => "synthesizing",
        }
    }

    fn active(self) -> bool {
        matches!(self, Self::Planning | Self::Synthesizing)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NarrationStartParams {
    document: NarrationSourceDocument,
    source_text: String,
    target: NarrationTarget,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NarrationSourceDocument {
    pub(crate) blocks: Vec<NarrationSourceBlock>,
    pub(crate) document_version: String,
    pub(crate) message_id: String,
    pub(crate) message_revision: String,
    pub(crate) schema_version: u64,
    pub(crate) source_hash: String,
    pub(crate) targets: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NarrationTarget {
    assistant_message_id: String,
    message_revision: String,
    source_hash: String,
    thread_id: String,
    turn_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NarrationSourceBlock {
    pub(crate) display_text: String,
    pub(crate) id: String,
    pub(crate) inline_ranges: Vec<Value>,
    pub(crate) kind: String,
    pub(crate) needs_transform: bool,
    pub(crate) path: String,
    pub(crate) target_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NarrationReadParams {
    artifact_key: String,
    known_revision: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NarrationCancelParams {
    artifact_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NarrationAudioReadParams {
    artifact_key: String,
    chunk_id: String,
}

impl CodexNarrationServer {
    pub(crate) fn new(
        codex_home: PathBuf,
        app_server: AppServerRuntime,
        event_rx: mpsc::Receiver<AppServerEvent>,
        output_tx: mpsc::SyncSender<Value>,
        live_transcript: LiveTranscriptStore,
        compute: ComputeRegistry,
    ) -> Self {
        let inner = Arc::new(NarrationInner {
            app_server,
            cache_root: codex_home.join("remux").join("narration").join("v2"),
            codex_home: codex_home.clone(),
            compute,
            diagnostics: Mutex::new(VecDeque::new()),
            jobs: Mutex::new(HashMap::new()),
            output_tx,
            subscriptions: Mutex::new(HashMap::new()),
            transcript: Mutex::new(CodexTranscriptServer::new_with_live_transcript(
                codex_home,
                live_transcript,
            )),
        });
        cleanup_temporary_artifacts(&inner.cache_root);
        spawn_narration_event_router(inner.clone(), event_rx);
        Self { inner }
    }

    pub(crate) fn start(&self, params: Value) -> Result<Value, String> {
        let encoded_len = serde_json::to_vec(&params)
            .map_err(|error| format!("failed to encode narration/start params: {error}"))?
            .len();
        if encoded_len > MAX_START_PARAMS_BYTES {
            return Err(format!(
                "narration/start params are too large: {encoded_len}>{MAX_START_PARAMS_BYTES}"
            ));
        }
        let params: NarrationStartParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid narration/start params: {error}"))?;
        validate_start_params(&params)?;
        self.validate_target(&params)?;

        // The resolved model and service tier are part of cache identity. Resolve
        // capability before lookup so a standard-tier fallback cannot collide
        // with a Priority artifact.
        let planning_profile = resolve_planning_profile(&self.inner)?;
        let synthesis_profile = resolve_synthesis_profile(&self.inner.codex_home)?;
        let artifact_key = artifact_key(&params, &planning_profile, &synthesis_profile);
        if let Some(manifest) = read_cached_manifest(&self.inner.cache_root, &artifact_key) {
            let mut jobs = self
                .inner
                .jobs
                .lock()
                .map_err(|_| "narration job store poisoned".to_string())?;
            let job = NarrationJob::ready(
                artifact_key.clone(),
                params,
                manifest,
                planning_profile,
                synthesis_profile,
            );
            let resource = job.resource_value();
            jobs.insert(artifact_key.clone(), job);
            evict_inactive_jobs(&mut jobs, Some(&artifact_key));
            return Ok(json!({
                "artifactKey": artifact_key,
                "resource": resource,
                "status": "accepted",
            }));
        }

        let mut jobs = self
            .inner
            .jobs
            .lock()
            .map_err(|_| "narration job store poisoned".to_string())?;
        if let Some(job) = jobs.get_mut(&artifact_key) {
            job.last_access_ms = now_millis();
            return Ok(json!({
                "artifactKey": artifact_key,
                "resource": job.resource_value(),
                "status": "accepted",
            }));
        }
        if jobs.values().any(|job| job.status.active()) {
            return Err("another narration is already being prepared".to_string());
        }

        let job = NarrationJob::planning(
            artifact_key.clone(),
            params,
            planning_profile,
            synthesis_profile,
        );
        let resource = job.resource_value();
        jobs.insert(artifact_key.clone(), job);
        evict_inactive_jobs(&mut jobs, Some(&artifact_key));
        drop(jobs);

        let inner = self.inner.clone();
        let background_key = artifact_key.clone();
        thread::spawn(move || run_narration_job(inner, background_key));

        Ok(json!({
            "artifactKey": artifact_key,
            "resource": resource,
            "status": "accepted",
        }))
    }

    pub(crate) fn read(&self, params: Value) -> Result<Value, String> {
        let params: NarrationReadParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid narration/resources/read params: {error}"))?;
        let artifact_key = non_empty(&params.artifact_key, "artifactKey")?;
        let mut jobs = self
            .inner
            .jobs
            .lock()
            .map_err(|_| "narration job store poisoned".to_string())?;
        let Some(job) = jobs.get_mut(artifact_key) else {
            return Ok(json!({ "resource": Value::Null, "status": "missing" }));
        };
        job.last_access_ms = now_millis();
        let resource = job.resource_value();
        let revision = resource.get("revision").and_then(Value::as_str);
        if params.known_revision.as_deref() == revision {
            return Ok(json!({ "resource": Value::Null, "status": "notModified" }));
        }
        Ok(json!({ "resource": resource, "status": "ok" }))
    }

    pub(crate) fn cancel(&self, params: Value) -> Result<Value, String> {
        let params: NarrationCancelParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid narration/cancel params: {error}"))?;
        let artifact_key = non_empty(&params.artifact_key, "artifactKey")?.to_string();
        let planning_turns = {
            let mut jobs = self
                .inner
                .jobs
                .lock()
                .map_err(|_| "narration job store poisoned".to_string())?;
            let Some(job) = jobs.get_mut(&artifact_key) else {
                return Ok(json!({ "artifactKey": artifact_key, "status": "accepted" }));
            };
            if !job.status.active() {
                return Ok(json!({ "artifactKey": artifact_key, "status": "accepted" }));
            }
            job.cancel_requested = true;
            job.status = NarrationStatus::Cancelled;
            job.stage = None;
            job.revision += 1;
            job.last_access_ms = now_millis();
            job.planning_turns.clone()
        };
        self.inner.notify(&artifact_key);
        for identity in planning_turns {
            let app_server = self.inner.app_server.clone();
            thread::spawn(move || {
                let _ = app_server.request(
                    "turn/interrupt",
                    json!({ "threadId": identity.thread_id, "turnId": identity.turn_id }),
                );
            });
        }

        Ok(json!({ "artifactKey": artifact_key, "status": "accepted" }))
    }

    pub(crate) fn read_audio(&self, params: Value) -> Result<Value, String> {
        let params: NarrationAudioReadParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid narration/audio/read params: {error}"))?;
        let artifact_key = non_empty(&params.artifact_key, "artifactKey")?;
        let chunk_id = non_empty(&params.chunk_id, "chunkId")?;
        if !safe_component(artifact_key) || !safe_component(chunk_id) {
            return Err("invalid narration artifact or chunk identifier".to_string());
        }

        let manifest = read_cached_manifest(&self.inner.cache_root, artifact_key)
            .ok_or_else(|| "narration artifact is not ready".to_string())?;
        let known_chunk = manifest
            .get("chunks")
            .and_then(Value::as_array)
            .is_some_and(|chunks| {
                chunks
                    .iter()
                    .any(|chunk| chunk.get("id").and_then(Value::as_str) == Some(chunk_id))
            });
        if !known_chunk {
            return Err("narration audio chunk was not found".to_string());
        }

        let path = self
            .inner
            .cache_root
            .join(artifact_key)
            .join("audio")
            .join(format!("{chunk_id}.wav"));
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("narration audio chunk unavailable: {error}"))?;
        if metadata.len() > MAX_AUDIO_CHUNK_BYTES {
            return Err(format!(
                "narration audio chunk is too large: {}>{MAX_AUDIO_CHUNK_BYTES}",
                metadata.len()
            ));
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("failed to read narration audio chunk: {error}"))?;
        Ok(json!({
            "artifactKey": artifact_key,
            "chunkId": chunk_id,
            "dataBase64": base64_encode(&bytes),
            "mimeType": "audio/wav",
            "sizeBytes": bytes.len(),
        }))
    }

    pub(crate) fn read_diagnostics(&self) -> Result<Value, String> {
        let diagnostics = self
            .inner
            .diagnostics
            .lock()
            .map_err(|_| "narration diagnostics poisoned".to_string())?;
        Ok(json!({ "runs": diagnostics.iter().collect::<Vec<_>>() }))
    }

    fn validate_target(&self, params: &NarrationStartParams) -> Result<(), String> {
        let response = self
            .inner
            .transcript
            .lock()
            .map_err(|_| "narration transcript validator poisoned".to_string())?
            .read_resources(json!({
                "threadId": params.target.thread_id,
                "requests": [{ "type": "turn", "turnId": params.target.turn_id }],
            }))?;
        let turn = response
            .get("resources")
            .and_then(Value::as_array)
            .and_then(|resources| resources.first())
            .filter(|resource| resource.get("status").and_then(Value::as_str) == Some("ok"))
            .and_then(|resource| resource.get("value"))
            .and_then(|value| value.get("turn"))
            .ok_or_else(|| "narration target turn was not found".to_string())?;
        let message = turn
            .get("segments")
            .and_then(Value::as_array)
            .and_then(|segments| {
                segments.iter().find(|segment| {
                    segment.get("type").and_then(Value::as_str) == Some("assistantMessage")
                        && segment.get("id").and_then(Value::as_str)
                            == Some(params.target.assistant_message_id.as_str())
                })
            })
            .ok_or_else(|| "narration target assistant message was not found".to_string())?;
        if message.get("revision").and_then(Value::as_str)
            != Some(params.target.message_revision.as_str())
        {
            return Err("narration target message revision changed".to_string());
        }
        if message.get("text").and_then(Value::as_str) != Some(params.source_text.as_str()) {
            return Err("narration source text does not match the transcript".to_string());
        }
        Ok(())
    }
}

impl NarrationInner {
    pub(crate) fn app_server_request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.app_server.request(method, params)
    }

    pub(crate) fn planning_context_directory(&self) -> Result<PathBuf, String> {
        let path = self
            .codex_home
            .join("remux")
            .join("narration")
            .join("context-v1");
        fs::create_dir_all(&path)
            .map_err(|error| format!("failed to create neutral narration context: {error}"))?;
        Ok(path)
    }

    pub(crate) fn subscribe_to_planning_thread(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<(mpsc::Receiver<Value>, PlanningSubscriptionGuard), String> {
        let (event_tx, event_rx) = mpsc::channel();
        let mut subscriptions = self
            .subscriptions
            .lock()
            .map_err(|_| "narration event subscriptions poisoned".to_string())?;
        if subscriptions.len() >= MAX_PLANNING_SUBSCRIPTIONS {
            return Err(format!(
                "narration planning subscription limit reached: {MAX_PLANNING_SUBSCRIPTIONS}"
            ));
        }
        subscriptions.insert(thread_id.to_string(), event_tx);
        drop(subscriptions);
        Ok((
            event_rx,
            PlanningSubscriptionGuard {
                inner: self.clone(),
                thread_id: thread_id.to_string(),
            },
        ))
    }

    pub(crate) fn record_planning_turn(&self, artifact_key: &str, identity: PlanningTurnIdentity) {
        self.update_job(artifact_key, |job| job.planning_turns.push(identity));
    }

    pub(crate) fn record_narration_diagnostic(&self, diagnostic: Value) {
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.push_back(diagnostic);
            while diagnostics.len() > 50 {
                diagnostics.pop_front();
            }
        }
    }

    pub(crate) fn interrupt_planning_turns(&self, artifact_key: &str) {
        let mut identities = self
            .jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(artifact_key).map(|job| job.planning_turns.clone()))
            .unwrap_or_default();
        identities.sort_by_key(|identity| identity.batch_index);
        for identity in identities {
            let _ = self.app_server.request(
                "turn/interrupt",
                json!({ "threadId": identity.thread_id, "turnId": identity.turn_id }),
            );
        }
    }

    fn notify(&self, artifact_key: &str) {
        let _ = self.output_tx.send(json!({
            "jsonrpc": "2.0",
            "method": NARRATION_UPDATED_METHOD,
            "params": { "artifactKey": artifact_key },
        }));
    }

    pub(crate) fn cancelled(&self, artifact_key: &str) -> bool {
        self.jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(artifact_key).map(|job| job.cancel_requested))
            .unwrap_or(true)
    }

    fn update_job(&self, artifact_key: &str, update: impl FnOnce(&mut NarrationJob)) {
        if let Ok(mut jobs) = self.jobs.lock()
            && let Some(job) = jobs.get_mut(artifact_key)
        {
            update(job);
            job.revision += 1;
            job.last_access_ms = now_millis();
        }
        if let Ok(mut jobs) = self.jobs.lock() {
            evict_inactive_jobs(&mut jobs, Some(artifact_key));
        }
        self.notify(artifact_key);
    }
}

impl NarrationJob {
    fn planning(
        artifact_key: String,
        params: NarrationStartParams,
        planning_profile: NarrationPlanningProfile,
        synthesis_profile: NarrationSynthesisProfile,
    ) -> Self {
        Self {
            artifact_key,
            document: params.document,
            cancel_requested: false,
            completed_units: None,
            error: None,
            last_access_ms: now_millis(),
            manifest: None,
            planning_profile,
            planning_turns: Vec::new(),
            revision: 1,
            stage: Some("planning"),
            status: NarrationStatus::Planning,
            synthesis_profile,
            target: params.target,
            total_units: None,
        }
    }

    fn ready(
        artifact_key: String,
        params: NarrationStartParams,
        manifest: Value,
        planning_profile: NarrationPlanningProfile,
        synthesis_profile: NarrationSynthesisProfile,
    ) -> Self {
        Self {
            artifact_key,
            document: params.document,
            cancel_requested: false,
            completed_units: None,
            error: None,
            last_access_ms: now_millis(),
            manifest: Some(manifest),
            planning_profile,
            planning_turns: Vec::new(),
            revision: 1,
            stage: None,
            status: NarrationStatus::Ready,
            synthesis_profile,
            target: params.target,
            total_units: None,
        }
    }

    fn resource_value(&self) -> Value {
        json!({
            "artifactKey": self.artifact_key,
            "completedUnits": self.completed_units,
            "error": self.error,
            "manifest": self.manifest,
            "revision": self.revision.to_string(),
            "stage": self.stage,
            "status": self.status.as_str(),
            "target": {
                "assistantMessageId": self.target.assistant_message_id,
                "messageRevision": self.target.message_revision,
                "sourceHash": self.target.source_hash,
                "threadId": self.target.thread_id,
                "turnId": self.target.turn_id,
            },
            "totalUnits": self.total_units,
        })
    }
}

fn run_narration_job(inner: Arc<NarrationInner>, artifact_key: String) {
    let result = run_narration_job_inner(&inner, &artifact_key);
    match result {
        Ok(manifest) => inner.update_job(&artifact_key, |job| {
            if job.cancel_requested {
                return;
            }
            job.completed_units = job.total_units;
            job.error = None;
            job.manifest = Some(manifest);
            job.stage = None;
            job.status = NarrationStatus::Ready;
        }),
        Err(error) => inner.update_job(&artifact_key, |job| {
            if job.cancel_requested {
                job.stage = None;
                job.status = NarrationStatus::Cancelled;
                return;
            }
            job.error = Some(error);
            job.stage = None;
            job.status = NarrationStatus::Failed;
        }),
    }
}

fn run_narration_job_inner(
    inner: &Arc<NarrationInner>,
    artifact_key: &str,
) -> Result<Value, String> {
    let (document, planning_profile, synthesis_profile, source_hash) = {
        let jobs = inner
            .jobs
            .lock()
            .map_err(|_| "narration job store poisoned")?;
        let job = jobs.get(artifact_key).ok_or("narration job disappeared")?;
        (
            job.document.clone(),
            job.planning_profile.clone(),
            job.synthesis_profile.clone(),
            job.target.source_hash.clone(),
        )
    };
    ensure_native_synthesis_assets(&synthesis_profile)?;
    let plan = build_narration_plan_v3(inner, artifact_key, &document, &planning_profile)?;
    if inner.cancelled(artifact_key) {
        return Err("narration cancelled".to_string());
    }

    inner.update_job(artifact_key, |job| {
        job.completed_units = Some(0);
        job.stage = Some("synthesizing");
        job.status = NarrationStatus::Synthesizing;
        job.total_units = Some(plan.len());
    });

    fs::create_dir_all(&inner.cache_root)
        .map_err(|error| format!("failed to create narration cache: {error}"))?;
    let temp_dir = inner.cache_root.join(format!(
        ".{artifact_key}.tmp-{}-{}",
        std::process::id(),
        now_millis()
    ));
    let final_dir = inner.cache_root.join(artifact_key);
    let _ = fs::remove_dir_all(&temp_dir);
    fs::create_dir_all(temp_dir.join("audio"))
        .map_err(|error| format!("failed to create narration temporary directory: {error}"))?;

    let profile = planning_profile.provider_descriptor(synthesis_profile.descriptor.clone());
    let source_document_key = stable_revision_value(
        &serde_json::to_value(&document)
            .map_err(|error| format!("failed to encode narration source document: {error}"))?,
    );
    let script = json!({
        "schemaVersion": 2,
        "sourceDocumentHash": source_document_key,
        "generator": profile.get("scriptGenerator").cloned().unwrap_or(Value::Null),
        "units": plan,
    });
    let script_key = stable_revision_value(&json!({
        "sourceDocumentKey": source_document_key,
        "script": script,
        "model": planning_profile.model,
        "serviceTier": planning_profile.service_tier,
        "effort": planning_profile.effort,
        "reasoningSummary": planning_profile.reasoning_summary,
        "contextProfileVersion": planning_profile.context_profile_version,
        "baseInstructionsVersion": planning_profile.base_instructions_version,
        "promptVersion": planning_profile.prompt_version,
        "contractVersion": planning_profile.contract_version,
        "sourceMappingVersion": NARRATION_SOURCE_MAPPING_VERSION,
        "acousticTimingProviderVersion": NARRATION_ACOUSTIC_TIMING_PROVIDER_VERSION,
    }));
    let audio_key = stable_revision_value(&json!({
        "scriptKey": script_key,
        "synthesizer": profile.get("synthesizer").cloned().unwrap_or(Value::Null),
    }));
    let alignment_key = stable_revision_value(&json!({
        "sourceMapper": profile.get("sourceMapper").cloned().unwrap_or(Value::Null),
        "acousticTiming": profile.get("acousticTiming").cloned().unwrap_or(Value::Null),
        "audioKey": audio_key,
        "scriptKey": script_key,
        "sourceDocumentKey": source_document_key,
    }));
    let worker_result = run_native_synthesis_worker(
        inner,
        artifact_key,
        &temp_dir,
        &source_hash,
        &script,
        &document.targets,
        &profile,
        &source_document_key,
        &script_key,
        &audio_key,
        &alignment_key,
        &synthesis_profile,
    );
    let manifest = match worker_result {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(error);
        }
    };
    validate_manifest(&manifest, &temp_dir, artifact_key, &source_hash)?;
    if let Some(metrics) = manifest.get("synthesisMetrics") {
        inner.record_narration_diagnostic(json!({
            "artifactKey": artifact_key,
            "backend": synthesis_profile.descriptor.get("provider"),
            "metrics": metrics,
            "phase": "synthesis",
            "profileHash": stable_revision_value(&synthesis_profile.descriptor),
        }));
        eprintln!(
            "[codex:narration] synthesis backend={} metrics={metrics}",
            synthesis_profile
                .descriptor
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        );
    }
    if inner.cancelled(artifact_key) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err("narration cancelled".to_string());
    }

    fs::write(
        temp_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("failed to write narration manifest: {error}"))?;
    write_json_file(
        &temp_dir.join("source-document.json"),
        &serde_json::to_value(&document)
            .map_err(|error| format!("failed to encode narration source document: {error}"))?,
    )?;
    write_json_file(&temp_dir.join("script.json"), &script)?;
    write_json_file(
        &temp_dir.join("alignment.json"),
        manifest.get("cues").unwrap_or(&Value::Null),
    )?;
    write_json_file(
        &temp_dir.join("raw-timing.json"),
        manifest.get("rawTiming").unwrap_or(&Value::Null),
    )?;
    if final_dir.exists() {
        fs::remove_dir_all(&final_dir)
            .map_err(|error| format!("failed to replace narration artifact: {error}"))?;
    }
    fs::rename(&temp_dir, &final_dir)
        .map_err(|error| format!("failed to publish narration artifact: {error}"))?;
    enforce_cache_limit(&inner.cache_root, artifact_key);
    Ok(manifest)
}

fn build_narration_plan_v3(
    inner: &Arc<NarrationInner>,
    artifact_key: &str,
    document: &NarrationSourceDocument,
    profile: &NarrationPlanningProfile,
) -> Result<Vec<Value>, String> {
    let transformed_blocks = document
        .blocks
        .iter()
        .filter(|block| block.needs_transform)
        .cloned()
        .collect::<Vec<_>>();
    let transformed = plan_transformed_blocks(
        inner,
        artifact_key,
        &transformed_blocks,
        &document.targets,
        profile,
    )?;

    let mut units = Vec::with_capacity(document.blocks.len());
    let mut exact_words = 0;
    let mut semantic_words = 0;
    let mut fallback_words = 0;
    for block in &document.blocks {
        let (spoken_text, mode, alignment_hints) = if let Some(segment) = transformed.get(&block.id)
        {
            let hints = if segment.mode == "normalized" {
                let (hints, stats) =
                    normalized_alignment_hints(block, &segment.spoken_text, &document.targets)?;
                exact_words += stats.exact_word_mappings;
                semantic_words += stats.semantic_run_mappings;
                fallback_words += stats.block_fallback_words;
                hints
            } else {
                segment.alignment_hints.clone()
            };
            (segment.spoken_text.clone(), segment.mode, hints)
        } else {
            let (hints, stats) = verbatim_alignment_hints(block, &document.targets)?;
            exact_words += stats.exact_word_mappings;
            (block.display_text.clone(), "verbatim", hints)
        };
        units.push(json!({
            "blockId": block.id,
            "displayText": block.display_text,
            "fallbackTargetIds": [block_target_id(block)],
            "id": format!("unit:{}", block.id),
            "alignmentHints": alignment_hints,
            "mode": mode,
            "spokenText": spoken_text,
        }));
    }
    eprintln!(
        "[codex:narration] source mapping exact_words={exact_words} semantic_words={semantic_words} fallback_words={fallback_words}"
    );
    Ok(units)
}

fn verify_synthesis_assets(directory: &Path, expected: &Value) -> Result<(), String> {
    let assets = expected
        .as_object()
        .ok_or_else(|| "narration model asset descriptor is invalid".to_string())?;
    for (name, digest) in assets {
        let expected_digest = digest
            .as_str()
            .ok_or_else(|| format!("narration model hash is invalid for {name}"))?;
        let path = directory.join(name);
        let mut file = fs::File::open(&path)
            .map_err(|error| format!("narration model asset {name} is missing: {error}"))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 1024 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|error| {
                format!("failed to verify narration model asset {name}: {error}")
            })?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        let actual = format!("{:x}", hasher.finalize());
        if actual != expected_digest {
            return Err(format!("narration model asset {name} failed verification"));
        }
    }
    Ok(())
}

fn ensure_native_synthesis_assets(
    synthesis_profile: &NarrationSynthesisProfile,
) -> Result<(), String> {
    if !synthesis_profile.assets_ready() {
        return Err(format!(
            "native Kokoro model assets are not installed at {}",
            synthesis_profile.model_dir.display()
        ));
    }
    verify_synthesis_assets(
        &synthesis_profile.model_dir,
        &synthesis_profile.model_assets,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_native_synthesis_worker(
    inner: &NarrationInner,
    artifact_key: &str,
    temp_dir: &Path,
    source_hash: &str,
    script: &Value,
    targets: &[Value],
    profile: &Value,
    source_document_key: &str,
    script_key: &str,
    audio_key: &str,
    alignment_key: &str,
    synthesis_profile: &NarrationSynthesisProfile,
) -> Result<Value, String> {
    let request: SynthesisRequest = serde_json::from_value(json!({
        "alignmentKey": alignment_key,
        "artifactKey": artifact_key,
        "audioKey": audio_key,
        "modelDir": synthesis_profile.model_dir,
        "modelAssets": synthesis_profile.model_assets,
        "outputDir": temp_dir,
        "profile": profile,
        "script": script,
        "scriptKey": script_key,
        "sourceDocumentKey": source_document_key,
        "sourceHash": source_hash,
        "targets": targets,
    }))
    .map_err(|error| format!("failed to create native TTS request: {error}"))?;
    let mut task = inner
        .compute
        .spawn::<KokoroSynthesis>(
            TaskOptions::new("narration", format!("narration:{artifact_key}")),
            request,
        )
        .map_err(|error| format!("failed to start native TTS task: {error}"))?;
    let mut last_progress_update = Instant::now() - Duration::from_secs(1);
    let mut last_tick = Instant::now();
    let mut active_clock = ActiveWorkerClock::default();
    let mut last_inspect = Instant::now() - WORKLOAD_INSPECT_INTERVAL;
    let mut inspect_warned = false;
    loop {
        let now = Instant::now();
        active_clock.advance(now.saturating_duration_since(last_tick));
        last_tick = now;
        if inner.cancelled(artifact_key) {
            let _ = task.cancel();
            return Err("narration cancelled".to_string());
        }
        if active_clock.stall_time >= WORKLOAD_INSPECT_AFTER
            && last_inspect.elapsed() >= WORKLOAD_INSPECT_INTERVAL
        {
            match inspect_workload_state(task.id()) {
                Ok(WorkloadState::Frozen) => active_clock.set_frozen(true),
                Ok(WorkloadState::Running | WorkloadState::Missing) => {
                    active_clock.set_frozen(false)
                }
                Err(error) => {
                    active_clock.set_frozen(false);
                    if !inspect_warned {
                        eprintln!(
                            "[codex:narration] compute inspection failed pid={}: {error}",
                            task.id()
                        );
                        inspect_warned = true;
                    }
                }
            }
            last_inspect = Instant::now();
        }
        if let Some(kind) = active_clock.expired(NARRATION_JOB_BUDGET, NARRATION_STALL_BUDGET) {
            let _ = task.cancel();
            return Err(match kind {
                "job" => "narration job deadline exceeded".to_string(),
                _ => "native TTS task made no progress for 60 seconds".to_string(),
            });
        }
        while let Some(SynthesisProgress { completed, total }) = task
            .try_progress()
            .map_err(|error| format!("native TTS task failed: {error}"))?
        {
            active_clock.progress();
            if last_progress_update.elapsed() >= Duration::from_millis(500) || completed == total {
                inner.update_job(artifact_key, |job| {
                    job.completed_units = Some(completed);
                    job.total_units = Some(total);
                });
                last_progress_update = Instant::now();
            }
        }
        if let Some(output) = task
            .try_join()
            .map_err(|error| format!("native TTS task failed: {error}"))?
        {
            return Ok(output.manifest);
        }
        thread::sleep(WORKER_POLL);
    }
}

#[derive(Debug, Default)]
struct ActiveWorkerClock {
    frozen: bool,
    job_time: Duration,
    stall_time: Duration,
}

impl ActiveWorkerClock {
    fn advance(&mut self, elapsed: Duration) {
        if self.frozen {
            return;
        }
        self.job_time = self.job_time.saturating_add(elapsed);
        self.stall_time = self.stall_time.saturating_add(elapsed);
    }

    fn expired(&self, job_budget: Duration, stall_budget: Duration) -> Option<&'static str> {
        if self.frozen {
            None
        } else if self.job_time >= job_budget {
            Some("job")
        } else if self.stall_time >= stall_budget {
            Some("stall")
        } else {
            None
        }
    }

    fn progress(&mut self) {
        self.frozen = false;
        self.stall_time = Duration::ZERO;
    }

    fn set_frozen(&mut self, frozen: bool) {
        self.frozen = frozen;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorkloadState {
    Frozen,
    Missing,
    Running,
}

fn inspect_workload_state(pid: u32) -> Result<WorkloadState, String> {
    let Some(wrapper) = env::var_os("REMUX_WORKLOAD_EXEC") else {
        return Ok(WorkloadState::Missing);
    };
    let output = Command::new(wrapper)
        .args(["workload", "inspect", "--pid", &pid.to_string(), "--json"])
        .output()
        .map_err(|error| format!("failed to start workload inspection: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid workload inspection output: {error}"))?;
    match value.get("state").and_then(Value::as_str) {
        Some("frozen") => Ok(WorkloadState::Frozen),
        Some("running") => Ok(WorkloadState::Running),
        Some("missing") => Ok(WorkloadState::Missing),
        _ => Err("workload inspection returned an unknown state".to_string()),
    }
}

fn spawn_narration_event_router(
    inner: Arc<NarrationInner>,
    event_rx: mpsc::Receiver<AppServerEvent>,
) {
    thread::spawn(move || {
        for event in event_rx {
            match event {
                AppServerEvent::Reconnected => {}
                AppServerEvent::Notification(notification) => {
                    let thread_id = notification
                        .get("params")
                        .and_then(|params| params.get("threadId"))
                        .and_then(Value::as_str)
                        .or_else(|| {
                            notification
                                .get("params")
                                .and_then(|params| params.get("thread"))
                                .and_then(|thread| thread.get("id"))
                                .and_then(Value::as_str)
                        });
                    if let Some(sender) = thread_id.and_then(|thread_id| {
                        inner
                            .subscriptions
                            .lock()
                            .ok()
                            .and_then(|subscriptions| subscriptions.get(thread_id).cloned())
                    }) {
                        let _ = sender.send(notification);
                    }
                }
                AppServerEvent::Disconnected(reason) => {
                    let notification = json!({
                        "method": "app-server/disconnected",
                        "params": { "reason": reason },
                    });
                    if let Ok(subscriptions) = inner.subscriptions.lock() {
                        for sender in subscriptions.values() {
                            let _ = sender.send(notification.clone());
                        }
                    }
                }
                AppServerEvent::ManagementLog { .. } => {}
                AppServerEvent::ServerRequest(_) => {}
            }
        }
    });
}

fn validate_start_params(params: &NarrationStartParams) -> Result<(), String> {
    if params.source_text.len() > MAX_SOURCE_TEXT_BYTES {
        return Err(format!(
            "sourceText is too large: {}>{MAX_SOURCE_TEXT_BYTES}",
            params.source_text.len()
        ));
    }
    if params.document.blocks.len() > MAX_SOURCE_BLOCKS {
        return Err(format!(
            "too many narration blocks: {}>{MAX_SOURCE_BLOCKS}",
            params.document.blocks.len()
        ));
    }
    if params.document.targets.len() > MAX_SOURCE_TARGETS {
        return Err(format!(
            "too many narration targets: {}>{MAX_SOURCE_TARGETS}",
            params.document.targets.len()
        ));
    }
    non_empty(&params.target.thread_id, "threadId")?;
    non_empty(&params.target.turn_id, "turnId")?;
    non_empty(&params.target.assistant_message_id, "assistantMessageId")?;
    non_empty(&params.target.message_revision, "messageRevision")?;
    non_empty(&params.target.source_hash, "sourceHash")?;
    for (field, value) in [
        ("threadId", params.target.thread_id.as_str()),
        ("turnId", params.target.turn_id.as_str()),
        (
            "assistantMessageId",
            params.target.assistant_message_id.as_str(),
        ),
        ("messageRevision", params.target.message_revision.as_str()),
        ("sourceHash", params.target.source_hash.as_str()),
        ("document.messageId", params.document.message_id.as_str()),
        (
            "document.messageRevision",
            params.document.message_revision.as_str(),
        ),
        ("document.sourceHash", params.document.source_hash.as_str()),
    ] {
        validate_identifier_len(value, field)?;
    }
    if params.source_text.trim().is_empty() {
        return Err("sourceText is required".to_string());
    }
    if params.document.schema_version != NARRATION_MANIFEST_VERSION
        || params.document.document_version != NARRATION_SOURCE_DOCUMENT_VERSION
    {
        return Err("unsupported narration source document version".to_string());
    }
    if params.document.message_id != params.target.assistant_message_id
        || params.document.message_revision != params.target.message_revision
        || params.document.source_hash != params.target.source_hash
    {
        return Err("narration source document identity does not match the target".to_string());
    }
    if params.document.blocks.is_empty() {
        return Err("at least one narration block is required".to_string());
    }
    let mut ids = HashSet::new();
    let mut target_ids = HashSet::new();
    let mut association_count = 0usize;
    for target in &params.document.targets {
        let id = target
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "narration source target is missing id".to_string())?;
        let block_id = target
            .get("blockId")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("narration target {id} is missing blockId"))?;
        non_empty(id, "target.id")?;
        non_empty(block_id, "target.blockId")?;
        validate_identifier_len(id, "target.id")?;
        validate_identifier_len(block_id, "target.blockId")?;
        if !target_ids.insert(id) {
            return Err(format!("duplicate narration target id {id}"));
        }
        validate_source_target(target)?;
        if matches!(
            target.get("kind").and_then(Value::as_str),
            Some("tableCell" | "tableRegion" | "codeLines" | "diagramNode")
        ) {
            return Err(format!(
                "narration source document v3 contains legacy structural target {id}"
            ));
        }
    }
    for block in &params.document.blocks {
        non_empty(&block.id, "block.id")?;
        non_empty(&block.path, "block.path")?;
        validate_identifier_len(&block.id, "block.id")?;
        validate_identifier_len(&block.path, "block.path")?;
        association_count = association_count
            .saturating_add(block.inline_ranges.len())
            .saturating_add(block.target_ids.len());
        if association_count > MAX_SOURCE_ASSOCIATIONS {
            return Err(format!(
                "too many narration associations: {association_count}>{MAX_SOURCE_ASSOCIATIONS}"
            ));
        }
        for target_id in &block.target_ids {
            validate_identifier_len(target_id, "block.targetIds[]")?;
        }
        if block.display_text.trim().is_empty() {
            return Err(format!(
                "narration block {} has empty displayText",
                block.id
            ));
        }
        if !ids.insert(block.id.as_str()) {
            return Err(format!("duplicate narration block id {}", block.id));
        }
        if block.target_ids.is_empty()
            || block
                .target_ids
                .iter()
                .any(|id| !target_ids.contains(id.as_str()))
        {
            return Err(format!(
                "narration block {} contains invalid targets",
                block.id
            ));
        }
    }
    for target in &params.document.targets {
        let block_id = target
            .get("blockId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !ids.contains(block_id) {
            return Err(format!(
                "narration target references unknown block {block_id}"
            ));
        }
        let block = params
            .document
            .blocks
            .iter()
            .find(|block| block.id == block_id)
            .ok_or_else(|| format!("narration target references unknown block {block_id}"))?;
        match target.get("kind").and_then(Value::as_str) {
            Some("textRange") => {
                let end = target
                    .get("displayEnd")
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX);
                if end > block.display_text.encode_utf16().count() as u64 {
                    return Err(format!("narration text target exceeds block {block_id}"));
                }
            }
            Some("codeLines") => {
                let end = target
                    .get("lineEnd")
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX);
                let line_count = block.display_text.split('\n').count().max(1) as u64;
                if end >= line_count {
                    return Err(format!("narration code target exceeds block {block_id}"));
                }
            }
            Some("tableCell") => {
                let row = target
                    .get("row")
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX);
                let column = target
                    .get("column")
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX);
                let rows = block.display_text.split('\n').collect::<Vec<_>>();
                if row >= rows.len() as u64
                    || column >= rows[row as usize].split(" | ").count() as u64
                {
                    return Err(format!("narration table target exceeds block {block_id}"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_identifier_len(value: &str, field: &str) -> Result<(), String> {
    if value.len() > MAX_IDENTIFIER_BYTES {
        Err(format!(
            "{field} is too large: {}>{MAX_IDENTIFIER_BYTES}",
            value.len()
        ))
    } else {
        Ok(())
    }
}

fn evict_inactive_jobs(jobs: &mut HashMap<String, NarrationJob>, preserve: Option<&str>) {
    while jobs.values().filter(|job| !job.status.active()).count() > MAX_INACTIVE_JOBS {
        let candidate = jobs
            .iter()
            .filter(|(key, job)| {
                !job.status.active() && preserve.is_none_or(|preserve| key.as_str() != preserve)
            })
            .min_by_key(|(_, job)| job.last_access_ms)
            .map(|(key, _)| key.clone());
        let Some(candidate) = candidate else {
            break;
        };
        jobs.remove(&candidate);
    }
}

fn artifact_key(
    params: &NarrationStartParams,
    planning_profile: &NarrationPlanningProfile,
    synthesis_profile: &NarrationSynthesisProfile,
) -> String {
    stable_revision_value(&json!({
        "document": params.document,
        "manifestVersion": NARRATION_MANIFEST_VERSION,
        "profile": planning_profile.provider_descriptor(synthesis_profile.descriptor.clone()),
        "sourceText": params.source_text,
    }))
}

fn block_target_id(block: &NarrationSourceBlock) -> String {
    block
        .target_ids
        .iter()
        .find(|id| id.ends_with("/target/block"))
        .cloned()
        .unwrap_or_else(|| format!("{}/target/block", block.id))
}

fn validate_source_target(target: &Value) -> Result<(), String> {
    let id = target
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    match target.get("kind").and_then(Value::as_str) {
        Some("block") => Ok(()),
        Some("textRange") => {
            let start = target
                .get("displayStart")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("narration text target {id} has invalid displayStart"))?;
            let end = target
                .get("displayEnd")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("narration text target {id} has invalid displayEnd"))?;
            if end <= start {
                return Err(format!("narration text target {id} has an empty range"));
            }
            Ok(())
        }
        Some("tableCell") => {
            target
                .get("row")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("narration table target {id} has invalid row"))?;
            target
                .get("column")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("narration table target {id} has invalid column"))?;
            Ok(())
        }
        Some("tableRegion") => {
            let row_start = target
                .get("rowStart")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("narration table region {id} has invalid rowStart"))?;
            let row_end = target
                .get("rowEnd")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("narration table region {id} has invalid rowEnd"))?;
            let column_start = target
                .get("columnStart")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("narration table region {id} has invalid columnStart"))?;
            let column_end = target
                .get("columnEnd")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("narration table region {id} has invalid columnEnd"))?;
            if row_end < row_start || column_end < column_start {
                return Err(format!("narration table region {id} has an invalid range"));
            }
            Ok(())
        }
        Some("codeLines") => {
            let start = target
                .get("lineStart")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("narration code target {id} has invalid lineStart"))?;
            let end = target
                .get("lineEnd")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("narration code target {id} has invalid lineEnd"))?;
            if end < start {
                return Err(format!("narration code target {id} has an invalid range"));
            }
            Ok(())
        }
        Some("diagramNode") => {
            target
                .get("nodeId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("narration diagram target {id} has invalid nodeId"))?;
            Ok(())
        }
        _ => Err(format!("narration target {id} has an unsupported kind")),
    }
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    fs::write(
        path,
        serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

fn validate_manifest(
    manifest: &Value,
    artifact_dir: &Path,
    artifact_key: &str,
    source_hash: &str,
) -> Result<(), String> {
    if manifest.get("version").and_then(Value::as_u64) != Some(NARRATION_MANIFEST_VERSION)
        || manifest.get("artifactKey").and_then(Value::as_str) != Some(artifact_key)
        || manifest.get("sourceHash").and_then(Value::as_str) != Some(source_hash)
    {
        return Err("Kokoro worker returned a mismatched manifest".to_string());
    }
    for key in ["sourceDocumentKey", "scriptKey", "audioKey", "alignmentKey"] {
        manifest
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("narration manifest is missing {key}"))?;
    }
    if !manifest.get("profile").is_some_and(Value::is_object) {
        return Err("narration manifest is missing its provider profile".to_string());
    }
    let duration = manifest
        .get("durationSeconds")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| "narration manifest has invalid duration".to_string())?;
    let chunks = manifest
        .get("chunks")
        .and_then(Value::as_array)
        .ok_or_else(|| "narration manifest missing chunks".to_string())?;
    let mut previous_end = 0.0;
    for chunk in chunks {
        let id = chunk
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| safe_component(id))
            .ok_or_else(|| "narration manifest has invalid chunk id".to_string())?;
        let start = finite_number(chunk.get("start"), "chunk start")?;
        let end = finite_number(chunk.get("end"), "chunk end")?;
        if start + 0.001 < previous_end || end < start || end > duration + 0.001 {
            return Err("narration manifest chunk timing is not monotonic".to_string());
        }
        let path = artifact_dir.join("audio").join(format!("{id}.wav"));
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("narration manifest audio missing: {error}"))?;
        if metadata.len() > MAX_AUDIO_CHUNK_BYTES {
            return Err("narration manifest audio chunk exceeds the transport limit".to_string());
        }
        previous_end = end;
    }
    let targets = manifest
        .get("targets")
        .and_then(Value::as_array)
        .ok_or_else(|| "narration manifest missing targets".to_string())?;
    let target_ids = targets
        .iter()
        .filter_map(|target| target.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    if target_ids.len() != targets.len() {
        return Err("narration manifest contains invalid or duplicate targets".to_string());
    }
    for target in targets {
        validate_source_target(target)?;
    }
    let units = manifest
        .get("units")
        .and_then(Value::as_array)
        .ok_or_else(|| "narration manifest missing units".to_string())?;
    let mut unit_bounds = HashMap::new();
    previous_end = 0.0;
    for unit in units {
        let id = unit
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "narration manifest unit is missing id".to_string())?;
        let start = finite_number(unit.get("start"), "unit start")?;
        let end = finite_number(unit.get("end"), "unit end")?;
        if start + 0.001 < previous_end || end < start || end > duration + 0.001 {
            return Err("narration manifest unit timing is not monotonic".to_string());
        }
        let spoken_text = unit
            .get("spokenText")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| format!("narration manifest unit {id} has no spokenText"))?;
        if !matches!(
            unit.get("mode").and_then(Value::as_str),
            Some("verbatim" | "normalized" | "summary")
        ) {
            return Err(format!("narration manifest unit {id} has an invalid mode"));
        }
        let mode = unit
            .get("mode")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("narration manifest unit {id} has an invalid mode"))?;
        if unit_bounds
            .insert(
                id,
                (start, end, spoken_text.encode_utf16().count() as u64, mode),
            )
            .is_some()
        {
            return Err(format!("narration manifest duplicated unit {id}"));
        }
        let fallback = unit
            .get("fallbackTargetIds")
            .and_then(Value::as_array)
            .filter(|targets| !targets.is_empty())
            .ok_or_else(|| format!("narration manifest unit {id} has no fallback targets"))?;
        if fallback
            .iter()
            .any(|target| target.as_str().is_none_or(|id| !target_ids.contains(id)))
        {
            return Err(format!(
                "narration manifest unit {id} has an unknown fallback target"
            ));
        }
        previous_end = end;
    }
    let cues = manifest
        .get("cues")
        .and_then(Value::as_array)
        .ok_or_else(|| "narration manifest missing cues".to_string())?;
    let mut cued_units = HashSet::new();
    let mut cue_ids = HashSet::new();
    let mut summary_cue_counts = HashMap::<&str, usize>::new();
    let mut previous_start = 0.0;
    for cue in cues {
        let unit_id = cue
            .get("unitId")
            .and_then(Value::as_str)
            .ok_or_else(|| "narration cue is missing unitId".to_string())?;
        let cue_id = cue
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "narration cue is missing id".to_string())?;
        if !cue_ids.insert(cue_id) {
            return Err(format!("narration manifest duplicated cue {cue_id}"));
        }
        let (unit_start, unit_end, spoken_length, unit_mode) = unit_bounds
            .get(unit_id)
            .ok_or_else(|| format!("narration cue references unknown unit {unit_id}"))?;
        let start = finite_number(cue.get("start"), "cue start")?;
        let end = finite_number(cue.get("end"), "cue end")?;
        if start + 0.001 < previous_start
            || end < start
            || start < unit_start - 0.001
            || end > unit_end + 0.001
        {
            return Err("narration cue timing is invalid".to_string());
        }
        let confidence = finite_number(cue.get("confidence"), "cue confidence")?;
        if !(0.0..=1.0).contains(&confidence) {
            return Err("narration cue confidence is out of bounds".to_string());
        }
        let spoken_start = cue
            .get("spokenStart")
            .and_then(Value::as_u64)
            .ok_or_else(|| "narration cue has invalid spokenStart".to_string())?;
        let spoken_end = cue
            .get("spokenEnd")
            .and_then(Value::as_u64)
            .ok_or_else(|| "narration cue has invalid spokenEnd".to_string())?;
        if spoken_end < spoken_start || spoken_end > *spoken_length {
            return Err("narration cue spoken range is out of bounds".to_string());
        }
        if !matches!(
            cue.get("granularity").and_then(Value::as_str),
            Some(
                "word"
                    | "expression"
                    | "tableCell"
                    | "tableRegion"
                    | "codeLines"
                    | "diagramNode"
                    | "block"
            )
        ) {
            return Err("narration cue has invalid granularity".to_string());
        }
        if !matches!(
            cue.get("origin").and_then(Value::as_str),
            Some(
                "deterministic"
                    | "scriptHint"
                    | "ttsTiming"
                    | "forcedAlignment"
                    | "sourceWord"
                    | "sourceSemantic"
                    | "summarySemantic"
                    | "fallback"
            )
        ) {
            return Err("narration cue has invalid origin".to_string());
        }
        let cue_targets = cue
            .get("targetIds")
            .and_then(Value::as_array)
            .filter(|targets| !targets.is_empty())
            .ok_or_else(|| "narration cue has no targets".to_string())?;
        if cue_targets
            .iter()
            .any(|target| target.as_str().is_none_or(|id| !target_ids.contains(id)))
        {
            return Err("narration cue references an unknown target".to_string());
        }
        if *unit_mode == "summary" {
            *summary_cue_counts.entry(unit_id).or_default() += 1;
            if cue.get("granularity").and_then(Value::as_str) != Some("block")
                || cue.get("origin").and_then(Value::as_str) != Some("fallback")
                || (start - unit_start).abs() > 0.001
                || (end - unit_end).abs() > 0.001
                || spoken_start != 0
                || spoken_end != *spoken_length
            {
                return Err(format!(
                    "narration summary unit {unit_id} must use one whole-block cue"
                ));
            }
        }
        cued_units.insert(unit_id);
        previous_start = start;
    }
    if unit_bounds
        .keys()
        .any(|unit_id| !cued_units.contains(unit_id))
    {
        return Err("narration manifest contains a unit without a visual cue".to_string());
    }
    if unit_bounds.iter().any(|(unit_id, (_, _, _, mode))| {
        *mode == "summary" && summary_cue_counts.get(unit_id).copied() != Some(1)
    }) {
        return Err("narration manifest summary unit must contain exactly one cue".to_string());
    }
    Ok(())
}

fn finite_number(value: Option<&Value>, label: &str) -> Result<f64, String> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("narration manifest has invalid {label}"))
}

fn read_cached_manifest(cache_root: &Path, artifact_key: &str) -> Option<Value> {
    if !safe_component(artifact_key) {
        return None;
    }
    let path = cache_root.join(artifact_key).join("manifest.json");
    let bytes = fs::read(&path).ok()?;
    let _ = fs::write(&path, &bytes);
    serde_json::from_slice(&bytes).ok()
}

fn enforce_cache_limit(cache_root: &Path, protected_key: &str) {
    let Ok(entries) = fs::read_dir(cache_root) else {
        return;
    };
    let mut artifacts = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == protected_key {
                return None;
            }
            let manifest = entry.path().join("manifest.json");
            let modified = fs::metadata(&manifest).ok()?.modified().ok()?;
            Some((modified, directory_size(&entry.path()), entry.path()))
        })
        .collect::<Vec<_>>();
    let protected_size = directory_size(&cache_root.join(protected_key));
    let mut total = protected_size + artifacts.iter().map(|(_, size, _)| *size).sum::<u64>();
    artifacts.sort_by_key(|(modified, _, _)| *modified);
    for (_, size, path) in artifacts {
        if total <= MAX_CACHE_BYTES {
            break;
        }
        if fs::remove_dir_all(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                directory_size(&path)
            } else {
                fs::metadata(path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0)
            }
        })
        .sum()
}

fn cleanup_temporary_artifacts(cache_root: &Path) {
    let Ok(entries) = fs::read_dir(cache_root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name.contains(".tmp-") {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn non_empty<'a>(value: &'a str, field: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{field} is required"))
    } else {
        Ok(value)
    }
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_key_changes_with_source_content() {
        let params = sample_params("one");
        let profile = sample_profile();
        let synthesis = sample_synthesis_profile("onnxruntime");
        let first = artifact_key(&params, &profile, &synthesis);
        let second = artifact_key(&sample_params("two"), &profile, &synthesis);
        assert_ne!(first, second);
        assert!(safe_component(&first));
    }

    #[test]
    fn validates_unique_non_empty_blocks() {
        let mut params = sample_params("one");
        params
            .document
            .blocks
            .push(params.document.blocks[0].clone());
        assert!(
            validate_start_params(&params)
                .unwrap_err()
                .contains("duplicate")
        );
    }

    #[test]
    fn source_document_v3_rejects_legacy_structural_targets() {
        let mut params = sample_params("one");
        params.document.targets.push(json!({
            "blockId": "md:0",
            "id": "md:0/target/line/0",
            "kind": "codeLines",
            "lineEnd": 0,
            "lineStart": 0,
        }));
        params.document.blocks[0]
            .target_ids
            .push("md:0/target/line/0".to_string());
        assert!(
            validate_start_params(&params)
                .unwrap_err()
                .contains("legacy structural target")
        );
    }

    #[test]
    fn artifact_key_separates_priority_and_standard_profiles() {
        let params = sample_params("one");
        let priority = sample_profile();
        let mut standard = priority.clone();
        standard.service_tier = crate::narration_planning::PlanningServiceTier::Standard;
        let synthesis = sample_synthesis_profile("onnxruntime");
        assert_ne!(
            artifact_key(&params, &priority, &synthesis),
            artifact_key(&params, &standard, &synthesis)
        );
    }

    #[test]
    fn artifact_key_separates_synthesis_profiles() {
        let params = sample_params("one");
        let planning = sample_profile();
        assert_ne!(
            artifact_key(
                &params,
                &planning,
                &sample_synthesis_profile("onnxruntime-rust-v1")
            ),
            artifact_key(
                &params,
                &planning,
                &sample_synthesis_profile("onnxruntime-rust-v2")
            )
        );
    }

    #[test]
    fn synthesis_asset_verification_rejects_corruption() {
        let directory = env::temp_dir().join(format!(
            "remux-narration-asset-test-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("model.onnx"), b"model").unwrap();
        let expected = json!({
            "model.onnx": "9372c470eeadd5ecd9c3c74c2b3cb633f8e2f2fad799250a0f70d652b6b825e4"
        });
        assert!(verify_synthesis_assets(&directory, &expected).is_ok());
        fs::write(directory.join("model.onnx"), b"corrupt").unwrap();
        assert!(
            verify_synthesis_assets(&directory, &expected)
                .unwrap_err()
                .contains("failed verification")
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn frozen_worker_time_does_not_consume_deadlines() {
        let mut clock = ActiveWorkerClock::default();
        clock.advance(Duration::from_secs(59));
        clock.set_frozen(true);
        clock.advance(Duration::from_secs(120));
        assert_eq!(
            clock.expired(Duration::from_secs(900), Duration::from_secs(60)),
            None
        );
        clock.set_frozen(false);
        clock.advance(Duration::from_secs(1));
        assert_eq!(
            clock.expired(Duration::from_secs(900), Duration::from_secs(60)),
            Some("stall")
        );
        clock.progress();
        assert_eq!(clock.stall_time, Duration::ZERO);
        assert_eq!(clock.job_time, Duration::from_secs(60));
    }

    fn sample_params(text: &str) -> NarrationStartParams {
        NarrationStartParams {
            document: NarrationSourceDocument {
                blocks: vec![NarrationSourceBlock {
                    display_text: text.to_string(),
                    id: "md:0".to_string(),
                    inline_ranges: Vec::new(),
                    kind: "paragraph".to_string(),
                    needs_transform: false,
                    path: "0".to_string(),
                    target_ids: vec!["md:0/target/block".to_string()],
                }],
                document_version: "3".to_string(),
                message_id: "assistant".to_string(),
                message_revision: "revision".to_string(),
                schema_version: 2,
                source_hash: "hash".to_string(),
                targets: vec![json!({
                    "blockId": "md:0",
                    "id": "md:0/target/block",
                    "kind": "block",
                })],
            },
            source_text: text.to_string(),
            target: NarrationTarget {
                assistant_message_id: "assistant".to_string(),
                message_revision: "revision".to_string(),
                source_hash: "hash".to_string(),
                thread_id: "thread".to_string(),
                turn_id: "turn".to_string(),
            },
        }
    }

    fn sample_profile() -> NarrationPlanningProfile {
        NarrationPlanningProfile {
            provider: "codex-app-server",
            model: "gpt-5.6-sol".to_string(),
            service_tier: crate::narration_planning::PlanningServiceTier::Priority,
            effort: "low",
            reasoning_summary: "none",
            context_profile_version: "1",
            base_instructions_version: "2",
            prompt_version: "6",
            contract_version: 3,
        }
    }

    fn sample_synthesis_profile(provider: &str) -> NarrationSynthesisProfile {
        NarrationSynthesisProfile {
            descriptor: json!({
                "provider": provider,
                "model": "hexgrad/Kokoro-82M",
                "modelRevision": "fixture",
                "optionsVersion": "3",
                "sampleRate": 24_000,
                "voice": "af_heart",
            }),
            model_assets: json!({}),
            model_dir: PathBuf::new(),
        }
    }
}
