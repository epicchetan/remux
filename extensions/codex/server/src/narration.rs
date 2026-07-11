use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::app_server::{AppServerEvent, AppServerRuntime};
use crate::file_resources::base64_encode;
use crate::live_transcript::LiveTranscriptStore;
use crate::resources::CodexTranscriptServer;
use crate::util::stable_revision_value;

pub(crate) const NARRATION_UPDATED_METHOD: &str = "remux/codex/narration/updated";
const NARRATION_SOURCE_DOCUMENT_VERSION: &str = "2";
const NARRATION_PROMPT_VERSION: &str = "4";
const NARRATION_ALIGNMENT_VERSION: &str = "5";
const NARRATION_WORKER_VERSION: &str = "2";
const NARRATION_MANIFEST_VERSION: u64 = 2;
const KOKORO_MODEL_VERSION: &str = "hexgrad/Kokoro-82M@0.9.4";
const KOKORO_VOICE: &str = "af_heart";
const PLANNING_TIMEOUT: Duration = Duration::from_secs(240);
const WORKER_POLL: Duration = Duration::from_millis(100);
const MAX_AUDIO_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct CodexNarrationServer {
    inner: Arc<NarrationInner>,
}

#[derive(Debug)]
struct NarrationInner {
    app_server: AppServerRuntime,
    cache_root: PathBuf,
    codex_home: PathBuf,
    jobs: Mutex<HashMap<String, NarrationJob>>,
    output_tx: mpsc::Sender<Value>,
    subscriptions: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    transcript: Mutex<CodexTranscriptServer>,
}

#[derive(Clone, Debug)]
struct NarrationJob {
    artifact_key: String,
    document: NarrationSourceDocument,
    cancel_requested: bool,
    completed_units: Option<usize>,
    error: Option<String>,
    internal_thread_id: Option<String>,
    internal_turn_id: Option<String>,
    manifest: Option<Value>,
    revision: u64,
    stage: Option<&'static str>,
    status: NarrationStatus,
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
struct NarrationSourceDocument {
    blocks: Vec<NarrationSourceBlock>,
    document_version: String,
    message_id: String,
    message_revision: String,
    schema_version: u64,
    source_hash: String,
    targets: Vec<Value>,
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
struct NarrationSourceBlock {
    display_text: String,
    id: String,
    inline_ranges: Vec<Value>,
    kind: String,
    needs_transform: bool,
    path: String,
    target_ids: Vec<String>,
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
        output_tx: mpsc::Sender<Value>,
        live_transcript: LiveTranscriptStore,
    ) -> Self {
        let inner = Arc::new(NarrationInner {
            app_server,
            cache_root: codex_home.join("remux").join("narration").join("v2"),
            codex_home: codex_home.clone(),
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
        let params: NarrationStartParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid narration/start params: {error}"))?;
        validate_start_params(&params)?;
        self.validate_target(&params)?;

        let artifact_key = artifact_key(&params);
        if let Some(manifest) = read_cached_manifest(&self.inner.cache_root, &artifact_key) {
            let mut jobs = self
                .inner
                .jobs
                .lock()
                .map_err(|_| "narration job store poisoned".to_string())?;
            let job = NarrationJob::ready(artifact_key.clone(), params, manifest);
            let resource = job.resource_value();
            jobs.insert(artifact_key.clone(), job);
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
        if let Some(job) = jobs.get(&artifact_key) {
            return Ok(json!({
                "artifactKey": artifact_key,
                "resource": job.resource_value(),
                "status": "accepted",
            }));
        }
        if jobs.values().any(|job| job.status.active()) {
            return Err("another narration is already being prepared".to_string());
        }

        let job = NarrationJob::planning(artifact_key.clone(), params);
        let resource = job.resource_value();
        jobs.insert(artifact_key.clone(), job);
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
        let jobs = self
            .inner
            .jobs
            .lock()
            .map_err(|_| "narration job store poisoned".to_string())?;
        let Some(job) = jobs.get(artifact_key) else {
            return Ok(json!({ "resource": Value::Null, "status": "missing" }));
        };
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
        let (thread_id, turn_id) = {
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
            (job.internal_thread_id.clone(), job.internal_turn_id.clone())
        };
        self.inner.notify(&artifact_key);

        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            let app_server = self.inner.app_server.clone();
            thread::spawn(move || {
                let _ = app_server.request(
                    "turn/interrupt",
                    json!({ "threadId": thread_id, "turnId": turn_id }),
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
    fn notify(&self, artifact_key: &str) {
        let _ = self.output_tx.send(json!({
            "jsonrpc": "2.0",
            "method": NARRATION_UPDATED_METHOD,
            "params": { "artifactKey": artifact_key },
        }));
    }

    fn cancelled(&self, artifact_key: &str) -> bool {
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
        }
        self.notify(artifact_key);
    }
}

impl NarrationJob {
    fn planning(artifact_key: String, params: NarrationStartParams) -> Self {
        Self {
            artifact_key,
            document: params.document,
            cancel_requested: false,
            completed_units: None,
            error: None,
            internal_thread_id: None,
            internal_turn_id: None,
            manifest: None,
            revision: 1,
            stage: Some("planning"),
            status: NarrationStatus::Planning,
            target: params.target,
            total_units: None,
        }
    }

    fn ready(artifact_key: String, params: NarrationStartParams, manifest: Value) -> Self {
        Self {
            artifact_key,
            document: params.document,
            cancel_requested: false,
            completed_units: None,
            error: None,
            internal_thread_id: None,
            internal_turn_id: None,
            manifest: Some(manifest),
            revision: 1,
            stage: None,
            status: NarrationStatus::Ready,
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
    let (document, source_hash) = {
        let jobs = inner
            .jobs
            .lock()
            .map_err(|_| "narration job store poisoned")?;
        let job = jobs.get(artifact_key).ok_or("narration job disappeared")?;
        (job.document.clone(), job.target.source_hash.clone())
    };
    let plan = build_narration_plan(inner, artifact_key, &document)?;
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

    let profile = resolved_profile();
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
    let script_key = stable_revision_value(&script);
    let audio_key = stable_revision_value(&json!({
        "scriptKey": script_key,
        "synthesizer": profile.get("synthesizer").cloned().unwrap_or(Value::Null),
    }));
    let alignment_key = stable_revision_value(&json!({
        "aligner": profile.get("aligner").cloned().unwrap_or(Value::Null),
        "audioKey": audio_key,
        "scriptKey": script_key,
        "sourceDocumentKey": source_document_key,
    }));
    let worker_result = run_kokoro_worker(
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
    );
    let manifest = match worker_result {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(error);
        }
    };
    validate_manifest(&manifest, &temp_dir, artifact_key, &source_hash)?;
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

fn build_narration_plan(
    inner: &Arc<NarrationInner>,
    artifact_key: &str,
    document: &NarrationSourceDocument,
) -> Result<Vec<Value>, String> {
    let blocks = &document.blocks;
    let complex = blocks
        .iter()
        .filter(|block| block.needs_transform)
        .cloned()
        .collect::<Vec<_>>();
    let transformed = if complex.is_empty() {
        HashMap::new()
    } else {
        match plan_complex_blocks(inner, artifact_key, &complex, &document.targets) {
            Ok(plan) => plan,
            Err(first_error) => plan_complex_blocks(inner, artifact_key, &complex, &document.targets)
                .map_err(|second_error| format!(
                    "narration planning failed after retry: {second_error} (first attempt: {first_error})"
                ))?,
        }
    };

    blocks
        .iter()
        .filter_map(|block| {
            let segment = transformed.get(&block.id).cloned().unwrap_or_else(|| {
                json!({
                    "blockId": block.id,
                    "mode": "verbatim",
                    "spokenText": block.display_text,
                    "targetIds": [block_target_id(block)],
                })
            });
            (segment.get("mode").and_then(Value::as_str) != Some("omit")).then_some(segment)
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|segment| {
            let block_id = segment
                .get("blockId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let block = blocks
                .iter()
                .find(|block| block.id == block_id)
                .ok_or_else(|| format!("narration plan references unknown block {block_id}"))?;
            let fallback_target_ids = segment
                .get("targetIds")
                .and_then(Value::as_array)
                .filter(|targets| !targets.is_empty())
                .cloned()
                .unwrap_or_else(|| vec![json!(block_target_id(block))]);
            Ok(json!({
                "blockId": block_id,
                "displayText": block.display_text,
                "fallbackTargetIds": fallback_target_ids,
                "id": format!("unit:{}", block_id),
                "alignmentHints": segment.get("alignmentHints").cloned().unwrap_or_else(|| json!([])),
                "mode": segment.get("mode").cloned().unwrap_or_else(|| json!("summary")),
                "spokenText": segment.get("spokenText").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect()
}

fn plan_complex_blocks(
    inner: &Arc<NarrationInner>,
    artifact_key: &str,
    blocks: &[NarrationSourceBlock],
    targets: &[Value],
) -> Result<HashMap<String, Value>, String> {
    let ids = blocks
        .iter()
        .map(|block| block.id.clone())
        .collect::<Vec<_>>();
    let target_ids = blocks
        .iter()
        .flat_map(|block| block.target_ids.iter().cloned())
        .collect::<Vec<_>>();
    let output_schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["segments"],
        "properties": {
            "segments": {
                "type": "array",
                "minItems": ids.len(),
                "maxItems": ids.len(),
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["blockId", "mode", "spokenText", "targetIds", "alignmentHints"],
                    "properties": {
                        "blockId": { "type": "string", "enum": ids },
                        "mode": { "type": "string", "enum": ["normalized", "summary", "omit"] },
                        "spokenText": { "type": "string" },
                        "targetIds": {
                            "type": "array",
                            "minItems": 1,
                            "items": { "type": "string", "enum": target_ids }
                        },
                        "alignmentHints": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["spokenText", "targetIds"],
                                "properties": {
                                    "spokenText": { "type": "string" },
                                    "targetIds": {
                                        "type": "array",
                                        "minItems": 1,
                                        "items": { "type": "string", "enum": target_ids }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });
    let prompt_blocks = blocks
        .iter()
        .map(|block| {
            json!({
                "id": block.id,
                "kind": block.kind,
                "text": block.display_text,
                "inlineRanges": block.inline_ranges,
                "targets": targets.iter().filter(|target|
                    target.get("blockId").and_then(Value::as_str) == Some(block.id.as_str())
                ).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();

    let mut start_params = serde_json::Map::new();
    start_params.insert("approvalPolicy".to_string(), json!("never"));
    start_params.insert(
        "cwd".to_string(),
        json!(env::current_dir().unwrap_or_else(|_| PathBuf::from("/tmp"))),
    );
    start_params.insert("developerInstructions".to_string(), json!(
        "You create concise, natural speech for selected Markdown blocks. Preserve meaning. Summarize code, tables, and diagrams without reading syntax or every cell. Normalize technical notation, URLs, currency, and identifiers for speech. Do not add commentary. Return only the required structured output."
    ));
    start_params.insert("environments".to_string(), json!([]));
    start_params.insert("ephemeral".to_string(), json!(true));
    start_params.insert("experimentalRawEvents".to_string(), json!(false));
    start_params.insert("persistExtendedHistory".to_string(), json!(false));
    start_params.insert("sandbox".to_string(), json!("read-only"));
    start_params.insert("serviceName".to_string(), json!("remux-narration"));
    if let Ok(model) = env::var("REMUX_NARRATION_MODEL")
        && !model.trim().is_empty()
    {
        start_params.insert("model".to_string(), json!(model));
    }
    let thread_response = inner
        .app_server
        .request("thread/start", Value::Object(start_params))?;
    let thread_id = thread_response
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "narration thread/start response missing thread.id".to_string())?
        .to_string();
    let (event_tx, event_rx) = mpsc::channel();
    inner
        .subscriptions
        .lock()
        .map_err(|_| "narration event subscriptions poisoned".to_string())?
        .insert(thread_id.clone(), event_tx);
    inner.update_job(artifact_key, |job| {
        job.internal_thread_id = Some(thread_id.clone())
    });

    let prompt = json!({
        "blocks": prompt_blocks,
        "instructions": "Return one segment for every input block in the same order. Use summary for structural blocks, normalized for pronunciation-only rewrites, and omit only content with no useful spoken meaning. Keep summaries short and natural. targetIds are the visual fallback for the whole unit. alignmentHints map each rewritten phrase in spokenText to the narrowest renderer targets; return an empty array only when no narrower mapping exists."
    }).to_string();
    let turn_response = inner.app_server.request(
        "turn/start",
        json!({
            "threadId": thread_id,
            "effort": "low",
            "input": [{ "type": "text", "text": prompt, "text_elements": [] }],
            "outputSchema": output_schema,
        }),
    )?;
    let turn_id = turn_response
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "narration turn/start response missing turn.id".to_string())?
        .to_string();
    inner.update_job(artifact_key, |job| {
        job.internal_turn_id = Some(turn_id.clone())
    });

    let result = wait_for_plan(inner, artifact_key, &thread_id, &turn_id, event_rx);
    if let Ok(mut subscriptions) = inner.subscriptions.lock() {
        subscriptions.remove(&thread_id);
    }
    let text = result?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("Codex returned invalid narration JSON: {error}"))?;
    validate_complex_plan(&value, blocks)
}

fn wait_for_plan(
    inner: &NarrationInner,
    artifact_key: &str,
    thread_id: &str,
    turn_id: &str,
    event_rx: mpsc::Receiver<Value>,
) -> Result<String, String> {
    let started = std::time::Instant::now();
    let mut delta_text = String::new();
    let mut completed_text = None;
    loop {
        if inner.cancelled(artifact_key) {
            return Err("narration cancelled".to_string());
        }
        if started.elapsed() > PLANNING_TIMEOUT {
            return Err("narration planning timed out".to_string());
        }
        let notification = match event_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(notification) => notification,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("narration app-server event stream closed".to_string());
            }
        };
        let method = notification
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = notification.get("params").unwrap_or(&Value::Null);
        if params.get("threadId").and_then(Value::as_str) != Some(thread_id) {
            continue;
        }
        match method {
            "item/agentMessage/delta"
                if params.get("turnId").and_then(Value::as_str) == Some(turn_id) =>
            {
                if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                    delta_text.push_str(delta);
                }
            }
            "item/completed" if params.get("turnId").and_then(Value::as_str) == Some(turn_id) => {
                let item = params.get("item").unwrap_or(&Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                    completed_text = item.get("text").and_then(Value::as_str).map(str::to_string);
                }
            }
            "turn/completed" => {
                let turn = params.get("turn").unwrap_or(&Value::Null);
                if turn.get("id").and_then(Value::as_str) != Some(turn_id) {
                    continue;
                }
                if turn.get("status").and_then(Value::as_str) != Some("completed") {
                    return Err(turn
                        .get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("narration planning failed")
                        .to_string());
                }
                return completed_text
                    .or_else(|| (!delta_text.is_empty()).then_some(delta_text))
                    .ok_or_else(|| "narration planning completed without output".to_string());
            }
            "app-server/disconnected" => {
                return Err("narration app-server disconnected".to_string());
            }
            _ => {}
        }
    }
}

fn validate_complex_plan(
    value: &Value,
    blocks: &[NarrationSourceBlock],
) -> Result<HashMap<String, Value>, String> {
    let segments = value
        .get("segments")
        .and_then(Value::as_array)
        .ok_or_else(|| "narration plan missing segments".to_string())?;
    if segments.len() != blocks.len() {
        return Err(format!(
            "narration plan segment count mismatch: {}!={}",
            segments.len(),
            blocks.len()
        ));
    }
    let mut seen = HashSet::new();
    let mut output = HashMap::new();
    for (index, (segment, block)) in segments.iter().zip(blocks).enumerate() {
        let block_id = segment
            .get("blockId")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("narration plan segment {index} missing blockId"))?;
        if block_id != block.id {
            return Err(format!(
                "narration plan reordered block {block_id}; expected {}",
                block.id
            ));
        }
        if !seen.insert(block_id.to_string()) {
            return Err(format!("narration plan duplicated block {block_id}"));
        }
        let mode = segment
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(mode, "normalized" | "summary" | "omit") {
            return Err(format!("narration plan block {block_id} has invalid mode"));
        }
        let spoken = segment
            .get("spokenText")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if mode != "omit" && spoken.trim().is_empty() {
            return Err(format!(
                "narration plan block {block_id} has empty spokenText"
            ));
        }
        let target_ids = segment
            .get("targetIds")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("narration plan block {block_id} is missing targetIds"))?;
        if target_ids.is_empty()
            || target_ids.iter().any(|target| {
                target.as_str().is_none_or(|target_id| {
                    !block.target_ids.iter().any(|known| known == target_id)
                })
            })
        {
            return Err(format!(
                "narration plan block {block_id} contains an invalid targetId"
            ));
        }
        let hints = segment
            .get("alignmentHints")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("narration plan block {block_id} is missing alignmentHints"))?;
        let mut spoken_cursor = 0;
        for hint in hints {
            let hint_text = hint
                .get("spokenText")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| {
                    format!("narration plan block {block_id} has an empty alignment hint")
                })?;
            let relative = spoken[spoken_cursor..].find(hint_text).ok_or_else(|| {
                format!("narration plan block {block_id} has an unmatched alignment hint")
            })?;
            spoken_cursor += relative + hint_text.len();
            let hint_targets = hint
                .get("targetIds")
                .and_then(Value::as_array)
                .filter(|targets| !targets.is_empty())
                .ok_or_else(|| {
                    format!("narration plan block {block_id} has an empty hint target")
                })?;
            if hint_targets.iter().any(|target| {
                target.as_str().is_none_or(|target_id| {
                    !block.target_ids.iter().any(|known| known == target_id)
                })
            }) {
                return Err(format!(
                    "narration plan block {block_id} has an invalid hint target"
                ));
            }
        }
        if mode == "normalized"
            && block.target_ids.iter().any(|id| {
                id.contains("/target/expression/")
                    || id.contains("/target/inlineCode/")
                    || id.contains("/target/link/")
            })
            && hints.is_empty()
        {
            return Err(format!(
                "narration plan block {block_id} requires normalized alignment hints"
            ));
        }
        output.insert(block_id.to_string(), segment.clone());
    }
    Ok(output)
}

fn run_kokoro_worker(
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
) -> Result<Value, String> {
    let python = narration_python(&inner.codex_home);
    let worker = narration_worker_path();
    if !worker.is_file() {
        return Err(format!("Kokoro worker is missing at {}", worker.display()));
    }
    let mut child = Command::new(&python)
        .arg(&worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "failed to start Kokoro worker with {}: {error}",
                python.display()
            )
        })?;
    let request = json!({
        "alignmentKey": alignment_key,
        "artifactKey": artifact_key,
        "audioKey": audio_key,
        "capabilities": ["raw-token-timing", "spoken-character-offsets", "renderer-target-cues"],
        "operation": "synthesize",
        "outputDir": temp_dir,
        "profile": profile,
        "protocolVersion": 2,
        "script": script,
        "scriptKey": script_key,
        "sourceDocumentKey": source_document_key,
        "sourceHash": source_hash,
        "targets": targets,
        "voice": KOKORO_VOICE,
    });
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "Kokoro worker stdin unavailable".to_string())?
        .write_all(request.to_string().as_bytes())
        .and_then(|_| child.stdin.as_mut().unwrap().write_all(b"\n"))
        .map_err(|error| format!("failed to send Kokoro request: {error}"))?;
    drop(child.stdin.take());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Kokoro worker stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Kokoro worker stderr unavailable".to_string())?;
    let (line_tx, line_rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = line_tx.send(line);
        }
    });
    let (stderr_tx, stderr_rx) = mpsc::channel();
    thread::spawn(move || {
        let text = BufReader::new(stderr)
            .lines()
            .map_while(Result::ok)
            .collect::<Vec<_>>()
            .join("\n");
        let _ = stderr_tx.send(text);
    });

    let mut manifest = None;
    let mut last_progress_update = std::time::Instant::now() - Duration::from_secs(1);
    loop {
        if inner.cancelled(artifact_key) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("narration cancelled".to_string());
        }
        while let Ok(line) = line_rx.try_recv() {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match event.get("type").and_then(Value::as_str) {
                Some("progress") => {
                    let completed = event
                        .get("completed")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize);
                    let total = event
                        .get("total")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize);
                    if last_progress_update.elapsed() >= Duration::from_millis(500)
                        || completed == total
                    {
                        inner.update_job(artifact_key, |job| {
                            job.completed_units = completed;
                            job.total_units = total;
                        });
                        last_progress_update = std::time::Instant::now();
                    }
                }
                Some("done") => manifest = event.get("manifest").cloned(),
                Some("error") => {
                    let message = event
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Kokoro worker failed");
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(message.to_string());
                }
                _ => {}
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                while let Ok(line) = line_rx.try_recv() {
                    if let Ok(event) = serde_json::from_str::<Value>(&line)
                        && event.get("type").and_then(Value::as_str) == Some("done")
                    {
                        manifest = event.get("manifest").cloned();
                    }
                }
                if status.success() {
                    return manifest
                        .ok_or_else(|| "Kokoro worker completed without a manifest".to_string());
                }
                let stderr = stderr_rx
                    .recv_timeout(Duration::from_millis(100))
                    .unwrap_or_default();
                return Err(if stderr.trim().is_empty() {
                    format!("Kokoro worker exited with {status}")
                } else {
                    format!("Kokoro worker exited with {status}: {stderr}")
                });
            }
            Ok(None) => thread::sleep(WORKER_POLL),
            Err(error) => return Err(format!("failed to poll Kokoro worker: {error}")),
        }
    }
}

fn spawn_narration_event_router(
    inner: Arc<NarrationInner>,
    event_rx: mpsc::Receiver<AppServerEvent>,
) {
    thread::spawn(move || {
        for event in event_rx {
            match event {
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
                AppServerEvent::ServerRequest(_) => {}
            }
        }
    });
}

fn validate_start_params(params: &NarrationStartParams) -> Result<(), String> {
    non_empty(&params.target.thread_id, "threadId")?;
    non_empty(&params.target.turn_id, "turnId")?;
    non_empty(&params.target.assistant_message_id, "assistantMessageId")?;
    non_empty(&params.target.message_revision, "messageRevision")?;
    non_empty(&params.target.source_hash, "sourceHash")?;
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
        if !target_ids.insert(id) {
            return Err(format!("duplicate narration target id {id}"));
        }
        validate_source_target(target)?;
    }
    for block in &params.document.blocks {
        non_empty(&block.id, "block.id")?;
        non_empty(&block.path, "block.path")?;
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

fn artifact_key(params: &NarrationStartParams) -> String {
    stable_revision_value(&json!({
        "document": params.document,
        "manifestVersion": NARRATION_MANIFEST_VERSION,
        "profile": resolved_profile(),
        "sourceText": params.source_text,
    }))
}

fn resolved_profile() -> Value {
    let narration_model =
        env::var("REMUX_NARRATION_MODEL").unwrap_or_else(|_| "default".to_string());
    json!({
        "aligner": {
            "algorithmVersion": NARRATION_ALIGNMENT_VERSION,
            "provider": "remux-hybrid",
        },
        "id": "codex-kokoro-hybrid-v2",
        "scriptGenerator": {
            "effort": "low",
            "model": narration_model,
            "promptVersion": NARRATION_PROMPT_VERSION,
            "provider": "codex-app-server",
        },
        "synthesizer": {
            "model": "hexgrad/Kokoro-82M",
            "modelRevision": KOKORO_MODEL_VERSION,
            "optionsVersion": NARRATION_WORKER_VERSION,
            "provider": "kokoro",
            "sampleRate": 24_000,
            "voice": KOKORO_VOICE,
        },
    })
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
        if unit_bounds
            .insert(id, (start, end, spoken_text.encode_utf16().count() as u64))
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
        let (unit_start, unit_end, spoken_length) = unit_bounds
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
            Some("deterministic" | "scriptHint" | "ttsTiming" | "forcedAlignment" | "fallback")
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
        cued_units.insert(unit_id);
        previous_start = start;
    }
    if unit_bounds
        .keys()
        .any(|unit_id| !cued_units.contains(unit_id))
    {
        return Err("narration manifest contains a unit without a visual cue".to_string());
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

fn narration_worker_path() -> PathBuf {
    env::var_os("REMUX_CODEX_NARRATION_WORKER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("narration")
                .join("kokoro_worker.py")
        })
}

fn narration_python(codex_home: &Path) -> PathBuf {
    if let Some(path) = env::var_os("REMUX_KOKORO_PYTHON") {
        return PathBuf::from(path);
    }
    let managed = codex_home
        .join("remux")
        .join("narration")
        .join("runtime")
        .join("bin")
        .join("python");
    if managed.is_file() {
        return managed;
    }
    let development = PathBuf::from("/tmp/remux-kokoro-venv/bin/python");
    if development.is_file() {
        return development;
    }
    PathBuf::from("python3")
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
        let first = artifact_key(&params);
        let second = artifact_key(&sample_params("two"));
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
                document_version: "2".to_string(),
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
}
