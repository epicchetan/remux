use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use remux_compute::{Registry as ComputeRegistry, TaskOptions};
use remux_extension_rpc::Peer as ExtensionRpcPeer;
use remux_tts::{
    CorpusCompatibility, EnglishG2p, KokoroStreamingRequest, KokoroStreamingSynthesis,
    MisakiCorpus, StreamingCompletion, StreamingControl, StreamingGroupPlan, StreamingPlanFile,
    StreamingProgress, StreamingSegment, StreamingWordPlan, atomic_json, group_digest, plan_digest,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::streaming::{
    BASE_INSTRUCTIONS_VERSION, CORPUS_RESOLVER_VERSION, GROUPING_PROMPT_VERSION,
    INCREMENTAL_PARSER_VERSION, IncrementalGroupParser, LOCAL_G2P_VERSION, PRIMARY_INSTRUCTIONS,
    PatchGroup, REVIEWED_LEXICON_VERSION, SOURCE_MAPPER_VERSION, TOKENIZER_VERSION, asset_sha256,
    prepare_document, primary_schema, resolve_group, validate_patch_group, word_spans,
};
use crate::synthesis_profile::{NarrationSynthesisProfile, resolve_synthesis_profile};
use crate::util::stable_revision_value;

pub(crate) const NARRATION_UPDATED_METHOD: &str = "remux/narrate/narration/updated";

const SOURCE_DOCUMENT_VERSION: &str = "4";
const SOURCE_DOCUMENT_SCHEMA: u64 = 3;
const MANIFEST_VERSION: u64 = 6;
const CACHE_NAMESPACE: &str = "v6";
const MAX_START_PARAMS_BYTES: usize = 2 * 1024 * 1024;
const MAX_SOURCE_TEXT_BYTES: usize = 64 * 1024;
const MAX_SOURCE_BLOCKS: usize = 512;
const MAX_SOURCE_TARGETS: usize = 8_192;
const MAX_IDENTIFIER_BYTES: usize = 1_024;
const MAX_AUDIO_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_INACTIVE_JOBS: usize = 128;
const MAX_PENDING_GROUPS: usize = 32;
const MAX_PENDING_GROUP_BYTES: usize = 512 * 1024;
const MAX_COMMITTED_UNPUBLISHED_GROUPS: usize = 16;
const MAX_COMMITTED_UNPUBLISHED_PHONEMES: usize = 4_000;
const JOB_DEADLINE: Duration = Duration::from_secs(15 * 60);
const STALL_DEADLINE: Duration = Duration::from_secs(60);
const LOOP_POLL: Duration = Duration::from_millis(25);

#[derive(Clone)]
pub(crate) struct NarrationServer {
    inner: Arc<NarrationInner>,
}

pub(crate) struct NarrationInner {
    cache_root: PathBuf,
    compute: ComputeRegistry,
    diagnostics: Mutex<VecDeque<Value>>,
    host_rpc: ExtensionRpcPeer,
    jobs: Mutex<HashMap<String, NarrationJob>>,
    output_tx: mpsc::SyncSender<Value>,
    remux_root: PathBuf,
    codex_home: PathBuf,
}

#[derive(Clone, Debug)]
struct NarrationJob {
    artifact_key: String,
    available_segments: Vec<StreamingSegment>,
    cancel_requested: bool,
    document: NarrationSourceDocument,
    error: Option<String>,
    last_access_ms: u128,
    manifest: Option<Value>,
    primary_operation: Option<String>,
    progress: JobProgress,
    revision: u64,
    staging_dir: Option<PathBuf>,
    status: NarrationStatus,
    synthesis_profile: NarrationSynthesisProfile,
    target: NarrationTarget,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NarrationStatus {
    Planning,
    Streaming,
    Finalizing,
    Ready,
    Failed,
    Cancelled,
}

impl NarrationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Planning => "planning",
            Self::Streaming => "streaming",
            Self::Finalizing => "finalizing",
            Self::Ready => "ready",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn active(self) -> bool {
        matches!(self, Self::Planning | Self::Streaming | Self::Finalizing)
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    committed_blocks: usize,
    committed_groups: usize,
    primary_model_complete: bool,
    synthesized_groups: usize,
    total_blocks: usize,
    worker_complete: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NarrationStartParams {
    document: NarrationSourceDocument,
    source_text: String,
    target: NarrationTarget,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NarrationSourceDocument {
    pub(crate) blocks: Vec<NarrationSourceBlock>,
    pub(crate) document_version: String,
    pub(crate) message_id: String,
    pub(crate) message_revision: String,
    pub(crate) schema_version: u64,
    pub(crate) source_hash: String,
    pub(crate) targets: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NarrationTarget {
    assistant_message_id: String,
    message_revision: String,
    source_hash: String,
    thread_id: String,
    turn_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NarrationSourceBlock {
    pub(crate) display_text: String,
    pub(crate) id: String,
    pub(crate) inline_ranges: Vec<Value>,
    pub(crate) kind: String,
    pub(crate) path: String,
    pub(crate) target_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NarrationReadParams {
    artifact_key: String,
    known_revision: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NarrationCancelParams {
    artifact_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NarrationAudioReadParams {
    artifact_key: String,
    chunk_id: String,
}

impl NarrationServer {
    pub(crate) fn new(
        remux_root: PathBuf,
        codex_home: PathBuf,
        output_tx: mpsc::SyncSender<Value>,
        host_rpc: ExtensionRpcPeer,
        compute: ComputeRegistry,
    ) -> Self {
        let cache_parent = remux_root.join(".remux").join("cache").join("narrate");
        let cache_root = cache_parent.join(CACHE_NAMESPACE);
        let _ = fs::remove_dir_all(cache_parent.join("v1"));
        let _ = fs::remove_dir_all(cache_parent.join("v2"));
        let _ = fs::remove_dir_all(cache_parent.join("v3"));
        let _ = fs::remove_dir_all(cache_parent.join("v4"));
        let _ = fs::remove_dir_all(cache_parent.join("v5"));
        cleanup_temporary_artifacts(&cache_root);
        Self {
            inner: Arc::new(NarrationInner {
                cache_root,
                compute,
                diagnostics: Mutex::new(VecDeque::new()),
                host_rpc,
                jobs: Mutex::new(HashMap::new()),
                output_tx,
                remux_root,
                codex_home,
            }),
        }
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
        let params: NarrationStartParams = decode_routed_params(params, "narration/start")?;
        validate_start_params(&params)?;

        let profile = self.preflight_profile()?;
        let synthesis_profile =
            resolve_synthesis_profile(&self.inner.remux_root, &self.inner.codex_home)?;
        ensure_synthesis_assets(&synthesis_profile)?;
        let vocabulary = load_vocabulary(&synthesis_profile.model_dir.join("vocab.json"))?;
        let corpus = MisakiCorpus::load_us();
        let corpus_compatibility = corpus.audit_compatibility(&vocabulary);
        let g2p = EnglishG2p::new();
        let prepared = prepare_document(&params.document, &corpus, &vocabulary, &g2p)?;
        let artifact_key = artifact_key(
            &params,
            &profile,
            &synthesis_profile,
            &corpus,
            &prepared.compact_json,
        );

        if let Some(manifest) =
            read_cached_manifest(&self.inner.cache_root, &artifact_key, &params.document)
        {
            let job =
                NarrationJob::ready(artifact_key.clone(), params, manifest, synthesis_profile);
            let resource = job.resource_value();
            self.inner
                .jobs
                .lock()
                .map_err(|_| "narration job store poisoned".to_string())?
                .insert(artifact_key.clone(), job);
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
        if let Some(job) = jobs.get_mut(&artifact_key)
            && (job.status.active() || job.status == NarrationStatus::Ready)
        {
            job.last_access_ms = now_millis();
            return Ok(json!({
                "artifactKey": artifact_key,
                "resource": job.resource_value(),
                "status": "accepted",
            }));
        }
        let stale_staging = jobs.remove(&artifact_key).and_then(|job| job.staging_dir);
        if jobs.values().any(|job| job.status.active()) {
            return Err("another narration is already active".to_string());
        }
        let job = NarrationJob::planning(artifact_key.clone(), params, synthesis_profile);
        let resource = job.resource_value();
        jobs.insert(artifact_key.clone(), job);
        evict_inactive_jobs(&mut jobs, Some(&artifact_key));
        drop(jobs);
        if let Some(staging) = stale_staging {
            let _ = fs::remove_dir_all(staging);
        }

        let inner = self.inner.clone();
        let background_key = artifact_key.clone();
        thread::spawn(move || {
            run_job(
                inner,
                background_key,
                profile,
                corpus,
                corpus_compatibility,
                prepared,
                g2p,
            );
        });
        Ok(json!({
            "artifactKey": artifact_key,
            "resource": resource,
            "status": "accepted",
        }))
    }

    fn preflight_profile(&self) -> Result<Value, String> {
        let response = self
            .inner
            .host_rpc
            .request(
                "remux/codex/inference/structured/profile/validate",
                Some(json!({
                    "apiVersion": 1,
                    "model": "gpt-5.6-sol",
                    "serviceTier": "priority",
                    "effort": "low",
                })),
                Duration::from_secs(30),
            )
            .map_err(|error| format!("Codex Sol Priority preflight failed: {error}"))?;
        if response.get("model").and_then(Value::as_str) != Some("gpt-5.6-sol")
            || response.get("serviceTier").and_then(Value::as_str) != Some("priority")
            || response.get("effort").and_then(Value::as_str) != Some("low")
            || response
                .get("profileDigest")
                .and_then(Value::as_str)
                .is_none_or(|digest| digest.len() != 64)
        {
            return Err("Codex returned a mismatched structured inference profile".to_string());
        }
        Ok(response)
    }

    pub(crate) fn read(&self, params: Value) -> Result<Value, String> {
        let params: NarrationReadParams = decode_routed_params(params, "narration/resources/read")?;
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
        if params.known_revision.as_deref() == resource.get("revision").and_then(Value::as_str) {
            return Ok(json!({ "resource": Value::Null, "status": "notModified" }));
        }
        Ok(json!({ "resource": resource, "status": "ok" }))
    }

    pub(crate) fn cancel(&self, params: Value) -> Result<Value, String> {
        let params: NarrationCancelParams = decode_routed_params(params, "narration/cancel")?;
        let artifact_key = non_empty(&params.artifact_key, "artifactKey")?.to_string();
        let operations = {
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
            job.available_segments.clear();
            job.error = None;
            job.progress = JobProgress {
                total_blocks: job.document.blocks.len(),
                ..JobProgress::default()
            };
            job.revision += 1;
            job.primary_operation
                .clone()
                .into_iter()
                .collect::<Vec<_>>()
        };
        self.inner.notify(&artifact_key);
        for operation_id in operations {
            self.inner.cancel_inference(operation_id);
        }
        Ok(json!({ "artifactKey": artifact_key, "status": "accepted" }))
    }

    pub(crate) fn read_audio(&self, params: Value) -> Result<Value, String> {
        let params: NarrationAudioReadParams =
            decode_routed_params(params, "narration/audio/read")?;
        let artifact_key = non_empty(&params.artifact_key, "artifactKey")?;
        let chunk_id = non_empty(&params.chunk_id, "chunkId")?;
        if !safe_component(artifact_key) || !safe_component(chunk_id) {
            return Err("invalid narration artifact or chunk identifier".to_string());
        }
        let (announced, staging) = {
            let jobs = self
                .inner
                .jobs
                .lock()
                .map_err(|_| "narration job store poisoned".to_string())?;
            let job = jobs
                .get(artifact_key)
                .ok_or_else(|| "narration artifact was not found".to_string())?;
            let announced = job
                .available_segments
                .iter()
                .any(|segment| segment.audio.get("id").and_then(Value::as_str) == Some(chunk_id));
            (announced, job.staging_dir.clone())
        };
        if !announced {
            return Err("narration audio segment is not announced".to_string());
        }
        let final_path = self
            .inner
            .cache_root
            .join(artifact_key)
            .join("audio")
            .join(format!("{chunk_id}.wav"));
        let staging_path =
            staging.map(|directory| directory.join("audio").join(format!("{chunk_id}.wav")));
        let path = staging_path
            .filter(|path| path.is_file())
            .unwrap_or(final_path);
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("narration audio segment unavailable: {error}"))?;
        if metadata.len() > MAX_AUDIO_CHUNK_BYTES {
            return Err("narration audio segment exceeds the transport limit".to_string());
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("failed to read narration audio segment: {error}"))?;
        Ok(json!({
            "artifactKey": artifact_key,
            "chunkId": chunk_id,
            "dataBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
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
}

impl NarrationJob {
    fn planning(
        artifact_key: String,
        params: NarrationStartParams,
        synthesis_profile: NarrationSynthesisProfile,
    ) -> Self {
        let total_blocks = params.document.blocks.len();
        Self {
            artifact_key,
            available_segments: Vec::new(),
            cancel_requested: false,
            document: params.document,
            error: None,
            last_access_ms: now_millis(),
            manifest: None,
            primary_operation: None,
            progress: JobProgress {
                total_blocks,
                ..JobProgress::default()
            },
            revision: 1,
            staging_dir: None,
            status: NarrationStatus::Planning,
            synthesis_profile,
            target: params.target,
        }
    }

    fn ready(
        artifact_key: String,
        params: NarrationStartParams,
        manifest: Value,
        synthesis_profile: NarrationSynthesisProfile,
    ) -> Self {
        let total_blocks = params.document.blocks.len();
        let segments: Vec<StreamingSegment> = manifest
            .get("segments")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        let group_count = segments.len();
        Self {
            artifact_key,
            available_segments: segments,
            cancel_requested: false,
            document: params.document,
            error: None,
            last_access_ms: now_millis(),
            manifest: Some(manifest),
            primary_operation: None,
            progress: JobProgress {
                committed_blocks: total_blocks,
                committed_groups: group_count,
                primary_model_complete: true,
                synthesized_groups: group_count,
                total_blocks,
                worker_complete: true,
            },
            revision: 1,
            staging_dir: None,
            status: NarrationStatus::Ready,
            synthesis_profile,
            target: params.target,
        }
    }

    fn resource_value(&self) -> Value {
        let available_duration = self
            .available_segments
            .last()
            .and_then(|segment| segment.audio.get("end"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        json!({
            "artifactKey": self.artifact_key,
            "availableDuration": available_duration,
            "availableSegments": self.available_segments,
            "complete": self.status == NarrationStatus::Ready,
            "error": self.error,
            "manifest": self.manifest,
            "progress": self.progress,
            "revision": self.revision.to_string(),
            "status": self.status.as_str(),
            "target": self.target,
        })
    }
}

fn run_job(
    inner: Arc<NarrationInner>,
    artifact_key: String,
    profile: Value,
    corpus: MisakiCorpus,
    corpus_compatibility: CorpusCompatibility,
    prepared: crate::streaming::PreparedDocument,
    g2p: EnglishG2p,
) {
    let result = run_job_inner(
        &inner,
        &artifact_key,
        &profile,
        &corpus,
        &corpus_compatibility,
        prepared,
        &g2p,
    );
    if result.is_err() {
        let operations = inner
            .jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(&artifact_key).cloned())
            .map(|job| job.primary_operation.into_iter().collect::<Vec<_>>())
            .unwrap_or_default();
        for operation in operations {
            inner.cancel_inference(operation);
        }
    }
    inner.record_diagnostic(match &result {
        Ok(manifest) => json!({
            "artifactKey": artifact_key,
            "durationSeconds": manifest.get("durationSeconds"),
            "groupCount": manifest.get("groups").and_then(Value::as_array).map(Vec::len),
            "phase": "complete",
        }),
        Err(error) => json!({
            "artifactKey": artifact_key,
            "error": error,
            "phase": "failed",
        }),
    });
    let cancelled = inner.cancelled(&artifact_key);
    let mut cleanup = None;
    inner.update_job(&artifact_key, |job| match result {
        Ok(manifest) => {
            job.available_segments = manifest
                .get("segments")
                .cloned()
                .and_then(|value| serde_json::from_value(value).ok())
                .unwrap_or_default();
            job.cancel_requested = false;
            job.error = None;
            job.manifest = Some(manifest);
            job.primary_operation = None;
            job.progress.primary_model_complete = true;
            job.progress.worker_complete = true;
            job.staging_dir = None;
            job.status = NarrationStatus::Ready;
        }
        Err(_) if cancelled => {
            cleanup = job.staging_dir.take();
            job.available_segments.clear();
            job.error = None;
            job.manifest = None;
            job.primary_operation = None;
            job.status = NarrationStatus::Cancelled;
        }
        Err(error) => {
            // A failed immutable prefix remains readable for this in-memory
            // job, but is never promoted or reused.
            job.error = Some(error);
            job.manifest = None;
            job.primary_operation = None;
            job.status = NarrationStatus::Failed;
            if job.available_segments.is_empty() {
                cleanup = job.staging_dir.take();
            }
        }
    });
    if let Some(path) = cleanup {
        let _ = fs::remove_dir_all(path);
    }
}

fn run_job_inner(
    inner: &Arc<NarrationInner>,
    artifact_key: &str,
    profile: &Value,
    corpus: &MisakiCorpus,
    corpus_compatibility: &CorpusCompatibility,
    prepared: crate::streaming::PreparedDocument,
    g2p: &EnglishG2p,
) -> Result<Value, String> {
    let (document, synthesis_profile, source_hash) = {
        let jobs = inner
            .jobs
            .lock()
            .map_err(|_| "narration job store poisoned".to_string())?;
        let job = jobs
            .get(artifact_key)
            .ok_or_else(|| "narration job disappeared".to_string())?;
        (
            job.document.clone(),
            job.synthesis_profile.clone(),
            job.target.source_hash.clone(),
        )
    };
    let staging = inner.cache_root.join(format!(
        ".{artifact_key}.tmp-{}-{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(staging.join("plan"))
        .map_err(|error| format!("failed to create narration staging: {error}"))?;
    let output_schema = primary_schema();
    let output_schema_sha256 = asset_sha256(
        &serde_json::to_string(&output_schema)
            .map_err(|error| format!("failed to encode v6 output schema: {error}"))?,
    );
    let provider_profile = provider_profile(
        profile,
        &synthesis_profile,
        corpus,
        corpus_compatibility,
        &output_schema_sha256,
    );
    let control = StreamingControl {
        version: 1,
        artifact_key: artifact_key.to_string(),
        source_hash: source_hash.clone(),
        profile: provider_profile.clone(),
        block_ids: document
            .blocks
            .iter()
            .map(|block| block.id.clone())
            .collect(),
        targets: document.targets.clone(),
    };
    atomic_json(&staging.join("control.json"), &control)?;
    let control_sha256 = sha256_file(&staging.join("control.json"))?;
    inner.update_job(artifact_key, |job| {
        job.staging_dir = Some(staging.clone());
    });

    let request = KokoroStreamingRequest {
        artifact_key: artifact_key.to_string(),
        control_sha256,
        deadline_ms: JOB_DEADLINE.as_millis() as u64,
        max_groups: 512,
        model_assets: synthesis_profile.model_assets.clone(),
        model_dir: synthesis_profile.model_dir.clone(),
        source_hash: source_hash.clone(),
        staging_dir: staging.clone(),
    };
    let mut worker = inner
        .compute
        .spawn::<KokoroStreamingSynthesis>(
            TaskOptions::new("narration", format!("narration:{artifact_key}")),
            request,
        )
        .map_err(|error| format!("failed to start streaming Kokoro task: {error}"))?;

    let model_required = !prepared.hard_group_ids.is_empty();
    inner.record_diagnostic(json!({
        "artifactKey": artifact_key,
        "groupCount": prepared.groups.len(),
        "hardGroupCount": prepared.hard_group_ids.len(),
        "immediateGroupCount": prepared.groups.len() - prepared.hard_group_ids.len(),
        "riskCount": prepared.risks.len(),
        "summaryBlockCount": prepared
            .groups
            .iter()
            .map(|group| group.summary_block_ids.len())
            .sum::<usize>(),
        "phase": "baselinePrepared",
    }));
    let (progress_tx, progress_rx) = mpsc::sync_channel(32);
    let (terminal_tx, terminal_rx) = mpsc::sync_channel(1);
    let operation_id = format!("narration:{artifact_key}:primary");
    let expected_profile_digest = profile["profileDigest"].as_str().unwrap().to_string();
    if model_required {
        inner.update_job(artifact_key, |job| {
            job.primary_operation = Some(operation_id.clone());
        });
        let rpc = inner.host_rpc.clone();
        let input = prepared.compact_json.clone();
        let operation_for_thread = operation_id.clone();
        thread::spawn(move || {
            let result = rpc
                .request_with_progress(
                    "remux/codex/inference/structured/generate",
                    Some(json!({
                        "apiVersion": 1,
                        "operationId": operation_for_thread,
                        "model": "gpt-5.6-sol",
                        "serviceTier": "priority",
                        "effort": "low",
                        "instructions": PRIMARY_INSTRUCTIONS,
                        "input": input,
                        "outputSchema": output_schema,
                        "progress": { "protocolVersion": 1 },
                    })),
                    Duration::from_secs(14 * 60 + 30),
                    progress_tx,
                )
                .map_err(|error| format!("Codex structured inference failed: {error}"));
            let _ = terminal_tx.send(result);
        });
    } else {
        inner.update_job(artifact_key, |job| {
            job.primary_operation = None;
            job.progress.primary_model_complete = true;
        });
    }

    let vocabulary = load_vocabulary(&synthesis_profile.model_dir.join("vocab.json"))?;
    let mut parser = model_required.then(IncrementalGroupParser::new);
    let mut pending = BTreeMap::<usize, PatchGroup>::new();
    let mut pending_bytes = 0usize;
    let mut next_prepared_group = 0usize;
    let mut next_acoustic_group = 0usize;
    let mut next_block = 0usize;
    let mut next_hard_group = 0usize;
    let mut next_word_id = 0usize;
    let mut group_digests = Vec::new();
    let mut resolved_queue = VecDeque::<(crate::streaming::ResolvedAcousticGroup, usize)>::new();
    let mut committed_unpublished = VecDeque::<(usize, usize)>::new();
    let mut committed_unpublished_phonemes = 0usize;
    let mut terminal: Option<Value> = None;
    let mut primary_validated = !model_required;
    let mut completed_text_digest = sha256_bytes(b"");
    let started = Instant::now();
    let mut last_progress = Instant::now();

    loop {
        if inner.cancelled(artifact_key) {
            if model_required {
                inner.cancel_inference(operation_id.clone());
            }
            let _ = worker.cancel();
            return Err("narration cancelled".to_string());
        }
        if started.elapsed() > JOB_DEADLINE || last_progress.elapsed() > STALL_DEADLINE {
            if model_required {
                inner.cancel_inference(operation_id.clone());
            }
            let _ = worker.cancel();
            return Err(if started.elapsed() > JOB_DEADLINE {
                "narration job deadline exceeded".to_string()
            } else {
                "narration pipeline made no progress for 60 seconds".to_string()
            });
        }

        while let Ok(value) = progress_rx.try_recv() {
            let delta = value
                .get("delta")
                .and_then(Value::as_str)
                .filter(|_| value.get("type").and_then(Value::as_str) == Some("textDelta"))
                .ok_or_else(|| "structured inference emitted invalid progress".to_string())?;
            let groups = parser
                .as_mut()
                .ok_or_else(|| {
                    "structured inference emitted progress after completion".to_string()
                })?
                .push(delta)?;
            for group in groups {
                let expected_id =
                    *prepared
                        .hard_group_ids
                        .get(next_hard_group)
                        .ok_or_else(|| {
                            format!(
                                "v6 model emitted unexpected hard group {} after {} records",
                                group.id,
                                prepared.hard_group_ids.len()
                            )
                        })?;
                if group.id != expected_id {
                    return Err(format!(
                        "v6 model emitted hard group {} where server expected {}",
                        group.id, expected_id
                    ));
                }
                let expected = &prepared.groups[expected_id];
                validate_patch_group(&group, expected, &prepared, g2p, &vocabulary)?;
                inner.record_diagnostic(json!({
                    "artifactKey": artifact_key,
                    "group": group.id,
                    "patchCount": group.patches.len(),
                    "summaryCount": group.summaries.len(),
                    "phase": "patchGroupAccepted",
                }));
                let encoded_len = serde_json::to_vec(&group)
                    .map_err(|error| error.to_string())?
                    .len();
                if pending.insert(group.id, group).is_some() {
                    return Err(format!("v6 model duplicated hard group {expected_id}"));
                }
                pending_bytes += encoded_len;
                next_hard_group += 1;
            }
            if pending.len() > MAX_PENDING_GROUPS || pending_bytes > MAX_PENDING_GROUP_BYTES {
                return fail_with_cancel(
                    inner,
                    &mut worker,
                    &operation_id,
                    "streamed narration group queue exceeded its bound",
                );
            }
            last_progress = Instant::now();
        }

        if terminal.is_none()
            && let Ok(result) = terminal_rx.try_recv()
        {
            terminal = Some(result?);
            last_progress = Instant::now();
        }

        while let Some(progress) = worker
            .try_progress()
            .map_err(|error| format!("streaming Kokoro task failed: {error}"))?
        {
            match progress {
                StreamingProgress::ModelLoaded { .. } => {}
                StreamingProgress::SegmentReady { segment, .. } => {
                    accept_worker_segment(
                        inner,
                        artifact_key,
                        segment,
                        &mut committed_unpublished,
                        &mut committed_unpublished_phonemes,
                    )?;
                }
            }
            last_progress = Instant::now();
        }

        loop {
            if let Some((resolved, _)) = resolved_queue.front() {
                let phoneme_count = resolved.phonemes.chars().count();
                if !spool_has_capacity(
                    &committed_unpublished,
                    committed_unpublished_phonemes,
                    phoneme_count,
                ) {
                    break;
                }
                let (mut resolved, committed_blocks) = resolved_queue
                    .pop_front()
                    .expect("resolved narration queue has a front item");
                resolved.id = next_acoustic_group;
                commit_group(
                    inner,
                    artifact_key,
                    &staging,
                    &document,
                    resolved,
                    committed_blocks,
                    &mut next_word_id,
                    &mut group_digests,
                )?;
                committed_unpublished.push_back((next_acoustic_group, phoneme_count));
                committed_unpublished_phonemes += phoneme_count;
                next_acoustic_group += 1;
                next_block = committed_blocks;
                last_progress = Instant::now();
                continue;
            }

            let Some(prepared_group) = prepared.groups.get(next_prepared_group) else {
                break;
            };
            let patch_group = if prepared_group.model_required() {
                let Some(group) = pending.get(&prepared_group.id).cloned() else {
                    break;
                };
                Some(group)
            } else {
                None
            };
            let resolved = resolve_group(
                patch_group.as_ref(),
                prepared_group,
                &prepared,
                &document,
                corpus,
                g2p,
                &vocabulary,
            )?;
            if resolved.is_empty() {
                return Err(format!(
                    "v6 prepared group {} produced no acoustic groups",
                    prepared_group.id
                ));
            }
            if next_acoustic_group
                .saturating_add(resolved_queue.len())
                .saturating_add(resolved.len())
                > 512
            {
                return Err("v6 narration exceeds 512 acoustic groups".to_string());
            }
            inner.record_diagnostic(json!({
                "artifactKey": artifact_key,
                "acousticGroupCount": resolved.len(),
                "maxAcousticPhonemes": resolved
                    .iter()
                    .map(|group| group.phonemes.chars().count())
                    .max()
                    .unwrap_or(0),
                "patchGroup": prepared_group.id,
                "phase": "acousticGroupsPlanned",
            }));
            if let Some(removed) = pending.remove(&prepared_group.id) {
                pending_bytes = pending_bytes.saturating_sub(
                    serde_json::to_vec(&removed)
                        .map_err(|error| error.to_string())?
                        .len(),
                );
            }
            let completed_blocks = prepared_group
                .block_ids
                .last()
                .expect("server-owned groups are non-empty")
                + 1;
            for (index, acoustic_group) in resolved.iter().enumerate() {
                let committed_blocks = resolved
                    .get(index + 1)
                    .map_or(completed_blocks, |next| next.block_range[0]);
                resolved_queue.push_back((acoustic_group.clone(), committed_blocks));
            }
            next_prepared_group += 1;
            last_progress = Instant::now();
        }

        if !primary_validated
            && let Some(response) = terminal.as_ref()
            && let Some(parser_ref) = parser.as_ref()
        {
            let accumulated = parser_ref.accumulated_text();
            let accumulated_sha = sha256_bytes(accumulated.as_bytes());
            let completed_sha = response
                .get("completedTextSha256")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    "structured inference response is missing completed digest".to_string()
                })?;
            let delta_sha = response
                .get("deltaTextSha256")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    "structured inference response is missing delta digest".to_string()
                })?;
            if response.get("profileDigest").and_then(Value::as_str)
                != Some(expected_profile_digest.as_str())
            {
                return Err("structured inference profile changed after preflight".to_string());
            }
            if accumulated_sha == delta_sha {
                if accumulated_sha != completed_sha {
                    return Err(
                        "structured inference completed and delta digests differ".to_string()
                    );
                }
                let accumulated = accumulated.to_string();
                let parser_value = parser.take().unwrap();
                let envelope = parser_value.finish(&accumulated)?;
                if response.get("value").is_none()
                    || envelope.groups.len() != prepared.hard_group_ids.len()
                    || next_hard_group != prepared.hard_group_ids.len()
                    || envelope
                        .groups
                        .iter()
                        .map(|group| group.id)
                        .ne(prepared.hard_group_ids.iter().copied())
                {
                    return Err("structured inference terminal value is incomplete".to_string());
                }
                completed_text_digest = completed_sha.to_string();
                primary_validated = true;
                inner.update_job(artifact_key, |job| {
                    job.primary_operation = None;
                    job.progress.primary_model_complete = true;
                });
            }
        }

        if primary_validated && pending.is_empty() && resolved_queue.is_empty() {
            if next_block != document.blocks.len()
                || next_prepared_group != prepared.groups.len()
                || next_acoustic_group == 0
            {
                return Err("streamed narration groups do not cover every source block".to_string());
            }
            let complete = StreamingCompletion {
                version: 1,
                group_count: next_acoustic_group,
                last_block: next_block - 1,
                plan_digest: plan_digest(&group_digests),
                completed_text_digest: completed_text_digest.clone(),
            };
            atomic_json(&staging.join("complete.json"), &complete)?;
            inner.update_job(artifact_key, |job| {
                job.status = NarrationStatus::Finalizing;
            });
            break;
        }
        thread::sleep(LOOP_POLL);
    }

    let output = loop {
        if inner.cancelled(artifact_key) {
            let _ = worker.cancel();
            return Err("narration cancelled".to_string());
        }
        while let Some(progress) = worker
            .try_progress()
            .map_err(|error| format!("streaming Kokoro task failed: {error}"))?
        {
            if let StreamingProgress::SegmentReady { segment, .. } = progress {
                accept_worker_segment(
                    inner,
                    artifact_key,
                    segment,
                    &mut committed_unpublished,
                    &mut committed_unpublished_phonemes,
                )?;
            }
            last_progress = Instant::now();
        }
        if let Some(output) = worker
            .try_join()
            .map_err(|error| format!("streaming Kokoro task failed: {error}"))?
        {
            break output;
        }
        if last_progress.elapsed() > STALL_DEADLINE {
            let _ = worker.cancel();
            return Err("streaming Kokoro task made no progress for 60 seconds".to_string());
        }
        thread::sleep(LOOP_POLL);
    };
    inner.update_job(artifact_key, |job| job.progress.worker_complete = true);

    let manifest = build_manifest(
        artifact_key,
        &source_hash,
        &document,
        provider_profile,
        corpus,
        output,
    )?;
    atomic_json(&staging.join("source-document.json"), &document)?;
    validate_manifest_v6(&manifest, &staging, &document)?;
    atomic_json(&staging.join("manifest.json"), &manifest)?;
    fs::remove_dir_all(staging.join("plan"))
        .map_err(|error| format!("failed to remove narration plan spool: {error}"))?;
    for name in ["control.json", "complete.json", "worker-result.json"] {
        fs::remove_file(staging.join(name))
            .map_err(|error| format!("failed to remove narration spool file {name}: {error}"))?;
    }
    validate_final_artifact_layout(&staging, segments_count(&manifest)?)?;
    if inner.cancelled(artifact_key) {
        return Err("narration cancelled".to_string());
    }
    let final_dir = inner.cache_root.join(artifact_key);
    if final_dir.exists() {
        return Err("refusing to replace an existing narration v6 artifact".to_string());
    }
    fs::create_dir_all(&inner.cache_root)
        .map_err(|error| format!("failed to create narration cache: {error}"))?;
    fs::rename(&staging, &final_dir)
        .map_err(|error| format!("failed to promote narration artifact: {error}"))?;
    fs::File::open(&inner.cache_root)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync narration cache: {error}"))?;
    enforce_cache_limit(&inner.cache_root, artifact_key);
    Ok(manifest)
}

fn spool_has_capacity(
    committed: &VecDeque<(usize, usize)>,
    committed_phonemes: usize,
    next_phonemes: usize,
) -> bool {
    committed.len() < MAX_COMMITTED_UNPUBLISHED_GROUPS
        && committed_phonemes.saturating_add(next_phonemes) <= MAX_COMMITTED_UNPUBLISHED_PHONEMES
}

fn accept_worker_segment(
    inner: &Arc<NarrationInner>,
    artifact_key: &str,
    segment: StreamingSegment,
    committed: &mut VecDeque<(usize, usize)>,
    committed_phonemes: &mut usize,
) -> Result<(), String> {
    let (expected_index, phoneme_count) = committed
        .pop_front()
        .ok_or_else(|| "streaming worker published an uncommitted segment".to_string())?;
    if segment.index != expected_index {
        return Err(format!(
            "streaming worker published segment {} before committed segment {expected_index}",
            segment.index
        ));
    }
    *committed_phonemes = committed_phonemes.saturating_sub(phoneme_count);
    let mut accepted = false;
    inner.update_job(artifact_key, |job| {
        if segment.index == job.available_segments.len() {
            job.available_segments.push(segment);
            job.progress.synthesized_groups = job.available_segments.len();
            accepted = true;
        }
    });
    accepted
        .then_some(())
        .ok_or_else(|| "streaming worker segment prefix is not contiguous".to_string())
}

fn commit_group(
    inner: &Arc<NarrationInner>,
    artifact_key: &str,
    staging: &Path,
    document: &NarrationSourceDocument,
    resolved: crate::streaming::ResolvedAcousticGroup,
    committed_blocks: usize,
    next_word_id: &mut usize,
    group_digests: &mut Vec<String>,
) -> Result<(), String> {
    let expected_phonemes = resolved.phonemes.clone();
    let spans = word_spans(&resolved.text);
    let mut words = Vec::with_capacity(resolved.words.len());
    for (index, word) in resolved.words.into_iter().enumerate() {
        let separator_end = spans
            .get(index + 1)
            .map_or(resolved.text.len(), |next| next.byte_start);
        let separator = &resolved.text[word.byte_end..separator_end];
        let whitespace_after =
            index + 1 < spans.len() && separator.chars().any(char::is_whitespace);
        let mut phonemes = word.phonemes;
        phonemes.extend(
            separator
                .chars()
                .filter(|character| !character.is_whitespace()),
        );
        let source_block = word
            .source_block_ids
            .first()
            .copied()
            .unwrap_or(resolved.block_range[0]);
        words.push(StreamingWordPlan {
            id: *next_word_id,
            mapping_origin: word.mapping_origin,
            phonemes,
            pronunciation_origin: word.pronunciation_origin,
            source_block,
            target_ids: word.target_ids,
            text: word.text,
            whitespace_after,
        });
        *next_word_id += 1;
    }
    let reconstructed_phonemes = words
        .iter()
        .map(|word| {
            format!(
                "{}{}",
                word.phonemes,
                if word.whitespace_after { " " } else { "" }
            )
        })
        .collect::<String>()
        .trim()
        .to_string();
    if reconstructed_phonemes != expected_phonemes {
        return Err("resolved group cannot be reconstructed by task-v6 phonemes".to_string());
    }
    let group = StreamingGroupPlan {
        block_target_ids: (resolved.block_range[0]..=resolved.block_range[1])
            .map(|block| document.blocks[block].target_ids.clone())
            .collect(),
        index: resolved.id,
        first_block: resolved.block_range[0],
        last_block: resolved.block_range[1],
        first_word_id: words.first().map(|word| word.id).unwrap_or(*next_word_id),
        spoken_text: resolved.text,
        words,
    };
    let digest = group_digest(&group)?;
    let plan = StreamingPlanFile {
        version: 1,
        artifact_key: artifact_key.to_string(),
        group_digest: digest.clone(),
        group,
    };
    atomic_json(
        &staging
            .join("plan")
            .join(format!("{:06}.json", plan.group.index)),
        &plan,
    )?;
    group_digests.push(digest);
    inner.update_job(artifact_key, |job| {
        job.progress.committed_blocks = committed_blocks;
        job.progress.committed_groups += 1;
        job.status = NarrationStatus::Streaming;
    });
    Ok(())
}

fn fail_with_cancel<T>(
    inner: &Arc<NarrationInner>,
    worker: &mut remux_compute::TaskHandle<KokoroStreamingSynthesis>,
    operation_id: &str,
    message: &str,
) -> Result<T, String> {
    inner.cancel_inference(operation_id.to_string());
    let _ = worker.cancel();
    Err(message.to_string())
}

impl NarrationInner {
    fn notify(&self, artifact_key: &str) {
        let _ = self.output_tx.send(json!({
            "jsonrpc": "2.0",
            "method": NARRATION_UPDATED_METHOD,
            "params": { "artifactKey": artifact_key },
        }));
    }

    fn update_job(&self, artifact_key: &str, update: impl FnOnce(&mut NarrationJob)) {
        if let Ok(mut jobs) = self.jobs.lock()
            && let Some(job) = jobs.get_mut(artifact_key)
        {
            update(job);
            job.revision += 1;
            job.last_access_ms = now_millis();
        }
        self.notify(artifact_key);
    }

    fn cancelled(&self, artifact_key: &str) -> bool {
        self.jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(artifact_key).map(|job| job.cancel_requested))
            .unwrap_or(true)
    }

    fn cancel_inference(&self, operation_id: String) {
        let rpc = self.host_rpc.clone();
        thread::spawn(move || {
            let _ = rpc.request(
                "remux/codex/inference/structured/cancel",
                Some(json!({ "operationId": operation_id })),
                Duration::from_secs(10),
            );
        });
    }

    fn record_diagnostic(&self, value: Value) {
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.push_back(value);
            while diagnostics.len() > 50 {
                diagnostics.pop_front();
            }
        }
    }
}

fn provider_profile(
    profile: &Value,
    synthesis: &NarrationSynthesisProfile,
    corpus: &MisakiCorpus,
    compatibility: &CorpusCompatibility,
    output_schema_sha256: &str,
) -> Value {
    json!({
        "id": "narrate-codex-kokoro-streaming-v6",
        "patchGenerator": {
            "provider": "codex-structured-inference",
            "model": "gpt-5.6-sol",
            "serviceTier": "priority",
            "effort": "low",
            "reasoningSummary": "none",
            "profileDigest": profile["profileDigest"],
            "baseInstructionsVersion": BASE_INSTRUCTIONS_VERSION,
            "groupingPromptVersion": GROUPING_PROMPT_VERSION,
            "instructionsSha256": asset_sha256(PRIMARY_INSTRUCTIONS),
            "schemaTemplateSha256": asset_sha256(crate::streaming::PRIMARY_SCHEMA_JSON),
            "schemaSha256": output_schema_sha256,
        },
        "corpus": {
            "provider": "misaki-us-gold-silver",
            "resolverVersion": CORPUS_RESOLVER_VERSION,
            "goldSha256": corpus.gold_sha256(),
            "silverSha256": corpus.silver_sha256(),
            "compatibility": compatibility,
        },
        "localG2p": {
            "provider": "misaki-rs",
            "version": LOCAL_G2P_VERSION,
            "role": "authoritative-phoneme-and-token-alignment",
        },
        "reviewedLexicon": {
            "version": REVIEWED_LEXICON_VERSION,
            "role": "stable-audio-aliases",
        },
        "tokenizerVersion": TOKENIZER_VERSION,
        "parserVersion": INCREMENTAL_PARSER_VERSION,
        "sourceMapperVersion": SOURCE_MAPPER_VERSION,
        "synthesizer": synthesis.descriptor,
    })
}

fn build_manifest(
    artifact_key: &str,
    source_hash: &str,
    document: &NarrationSourceDocument,
    profile: Value,
    corpus: &MisakiCorpus,
    output: remux_tts::StreamingOutput,
) -> Result<Value, String> {
    let chunks = output
        .segments
        .iter()
        .map(|segment| segment.audio.clone())
        .collect::<Vec<_>>();
    let units = output
        .segments
        .iter()
        .flat_map(|segment| segment.units.clone())
        .collect::<Vec<_>>();
    let cues = output
        .segments
        .iter()
        .flat_map(|segment| segment.cues.clone())
        .collect::<Vec<_>>();
    let groups = output
        .segments
        .iter()
        .map(|segment| segment.group.clone())
        .collect::<Vec<_>>();
    Ok(json!({
        "version": MANIFEST_VERSION,
        "artifactKey": artifact_key,
        "sourceHash": source_hash,
        "sourceDocumentKey": stable_revision_value(&serde_json::to_value(document).map_err(|error| error.to_string())?),
        "profile": profile,
        "corpus": {
            "goldSha256": corpus.gold_sha256(),
            "silverSha256": corpus.silver_sha256(),
        },
        "planDigest": output.plan_digest,
        "durationSeconds": output.duration_seconds,
        "chunks": chunks,
        "groups": groups,
        "segments": output.segments,
        "targets": document.targets,
        "units": units,
        "cues": cues,
    }))
}

fn validate_manifest_v6(
    manifest: &Value,
    staging: &Path,
    document: &NarrationSourceDocument,
) -> Result<(), String> {
    if manifest.get("version").and_then(Value::as_u64) != Some(MANIFEST_VERSION) {
        return Err("streaming worker returned the wrong manifest version".to_string());
    }
    let document_value = serde_json::to_value(document)
        .map_err(|error| format!("failed to encode narration source document: {error}"))?;
    let disk_document: Value = serde_json::from_slice(
        &fs::read(staging.join("source-document.json"))
            .map_err(|error| format!("failed to read narration source document: {error}"))?,
    )
    .map_err(|error| format!("invalid narration source document: {error}"))?;
    let source_document_key = stable_revision_value(&document_value);
    if disk_document != document_value
        || manifest.get("targets") != Some(&Value::Array(document.targets.clone()))
        || manifest.get("sourceHash").and_then(Value::as_str) != Some(&document.source_hash)
        || manifest.get("sourceDocumentKey").and_then(Value::as_str)
            != Some(source_document_key.as_str())
    {
        return Err("narration manifest source identity is invalid".to_string());
    }
    let segments = manifest
        .get("segments")
        .and_then(Value::as_array)
        .filter(|segments| !segments.is_empty())
        .ok_or_else(|| "narration manifest has no segments".to_string())?;
    let target_ids = document
        .targets
        .iter()
        .filter_map(|target| target.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let mut chunks = Vec::new();
    let mut groups = Vec::new();
    let mut units = Vec::new();
    let mut cues = Vec::new();
    let mut unit_ids = HashSet::new();
    let mut cue_ids = HashSet::new();
    let mut covered_blocks = HashSet::new();
    let mut previous_end = 0.0;
    let mut last_block = None;
    for (index, segment) in segments.iter().enumerate() {
        if segment.get("index").and_then(Value::as_u64) != Some(index as u64) {
            return Err("narration segments are not contiguous".to_string());
        }
        let audio = segment
            .get("audio")
            .ok_or_else(|| "narration segment is missing audio".to_string())?;
        let id = audio
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "narration segment audio is missing id".to_string())?;
        if id != format!("{index:06}") {
            return Err("narration audio ids are not contiguous".to_string());
        }
        let start = audio
            .get("start")
            .and_then(Value::as_f64)
            .ok_or_else(|| "narration segment has invalid start".to_string())?;
        let end = audio
            .get("end")
            .and_then(Value::as_f64)
            .ok_or_else(|| "narration segment has invalid end".to_string())?;
        if !start.is_finite()
            || !end.is_finite()
            || (start - previous_end).abs() > 0.001
            || end <= start
        {
            return Err("narration segment timing is not continuous".to_string());
        }
        previous_end = end;
        let sidecar: Value = serde_json::from_slice(
            &fs::read(staging.join("segments").join(format!("{id}.json")))
                .map_err(|error| format!("failed to read segment sidecar {id}: {error}"))?,
        )
        .map_err(|error| format!("invalid segment sidecar {id}: {error}"))?;
        if &sidecar != segment {
            return Err(format!("segment sidecar {id} differs from worker output"));
        }
        let wav = fs::read(staging.join("audio").join(format!("{id}.wav")))
            .map_err(|error| format!("failed to read narration WAV {id}: {error}"))?;
        let audio_samples = segment
            .get("audioSamples")
            .and_then(Value::as_u64)
            .ok_or_else(|| "narration segment is missing audioSamples".to_string())?;
        let wav_size = audio_samples
            .checked_mul(2)
            .and_then(|size| size.checked_add(44))
            .ok_or_else(|| "narration WAV size overflow".to_string())?;
        if wav.len() as u64 != wav_size
            || audio.get("sizeBytes").and_then(Value::as_u64) != Some(wav_size)
            || audio.get("sampleRate").and_then(Value::as_u64) != Some(24_000)
            || wav.get(..4) != Some(b"RIFF")
            || wav.get(8..12) != Some(b"WAVE")
            || wav.get(36..40) != Some(b"data")
        {
            return Err(format!("narration WAV {id} failed integrity validation"));
        }
        let group = segment
            .get("group")
            .ok_or_else(|| "narration segment is missing its group".to_string())?;
        let first_id = group
            .get("firstBlockId")
            .and_then(Value::as_str)
            .ok_or_else(|| "narration group is missing firstBlockId".to_string())?;
        let last_id = group
            .get("lastBlockId")
            .and_then(Value::as_str)
            .ok_or_else(|| "narration group is missing lastBlockId".to_string())?;
        if group.get("index").and_then(Value::as_u64) != Some(index as u64)
            || group.get("chunkId").and_then(Value::as_str) != Some(id)
            || !same_number(group.get("start"), start)
            || !same_number(group.get("end"), end)
        {
            return Err("narration segment, group, and chunk identities differ".to_string());
        }
        let first = document
            .blocks
            .iter()
            .position(|block| block.id == first_id)
            .ok_or_else(|| "narration group has an unknown first block".to_string())?;
        let last = document
            .blocks
            .iter()
            .position(|block| block.id == last_id)
            .ok_or_else(|| "narration group has an unknown last block".to_string())?;
        let valid_first = last_block.map_or(first == 0, |previous| {
            first == previous || first == previous + 1
        });
        if !valid_first || last < first {
            return Err("narration groups skip or reverse their ordered source blocks".to_string());
        }
        last_block = Some(last);

        let segment_units = segment
            .get("units")
            .and_then(Value::as_array)
            .ok_or_else(|| "narration segment units are invalid".to_string())?;
        if segment_units.len() != last - first + 1 {
            return Err("narration units do not match the group block range".to_string());
        }
        let mut ranges = HashMap::new();
        for (offset, unit) in segment_units.iter().enumerate() {
            let block_id = unit
                .get("blockId")
                .and_then(Value::as_str)
                .ok_or_else(|| "narration unit is missing blockId".to_string())?;
            let unit_id = unit
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "narration unit is missing id".to_string())?;
            let unit_start = unit
                .get("start")
                .and_then(Value::as_f64)
                .ok_or_else(|| "narration unit has invalid start".to_string())?;
            let unit_end = unit
                .get("end")
                .and_then(Value::as_f64)
                .ok_or_else(|| "narration unit has invalid end".to_string())?;
            if block_id != document.blocks[first + offset].id
                || unit.get("chunkId").and_then(Value::as_str) != Some(id)
                || unit_start < start - 0.001
                || unit_end > end + 0.001
                || unit_end < unit_start
                || !unit_ids.insert(unit_id)
                || invalid_targets(unit.get("fallbackTargetIds"), &target_ids)
            {
                return Err("narration units are not an exact source-block partition".to_string());
            }
            ranges.insert(unit_id, (unit_start, unit_end));
            covered_blocks.insert(first + offset);
            units.push(unit.clone());
        }

        let segment_cues = segment
            .get("cues")
            .and_then(Value::as_array)
            .ok_or_else(|| "narration segment cues are invalid".to_string())?;
        for cue in segment_cues {
            let cue_id = cue
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "narration cue is missing id".to_string())?;
            let unit_id = cue
                .get("unitId")
                .and_then(Value::as_str)
                .ok_or_else(|| "narration cue is missing unitId".to_string())?;
            let cue_start = cue
                .get("start")
                .and_then(Value::as_f64)
                .ok_or_else(|| "narration cue has invalid start".to_string())?;
            let cue_end = cue
                .get("end")
                .and_then(Value::as_f64)
                .ok_or_else(|| "narration cue has invalid end".to_string())?;
            let Some((unit_start, unit_end)) = ranges.get(unit_id) else {
                return Err("narration cue references an unknown unit".to_string());
            };
            if !cue_ids.insert(cue_id)
                || cue_start < *unit_start - 0.001
                || cue_end > *unit_end + 0.001
                || cue_end < cue_start
                || !matches!(
                    cue.get("granularity").and_then(Value::as_str),
                    Some("block" | "expression" | "word")
                )
                || !matches!(
                    cue.get("origin").and_then(Value::as_str),
                    Some("blockFallback" | "sourceSemantic" | "sourceWord" | "summaryBlock")
                )
                || cue
                    .get("confidence")
                    .and_then(Value::as_f64)
                    .is_none_or(|confidence| !(0.0..=1.0).contains(&confidence))
                || cue
                    .get("spokenStart")
                    .and_then(Value::as_u64)
                    .zip(cue.get("spokenEnd").and_then(Value::as_u64))
                    .is_none_or(|(start, end)| end < start)
                || invalid_targets(cue.get("targetIds"), &target_ids)
            {
                return Err("narration cue failed range or target validation".to_string());
            }
            cues.push(cue.clone());
        }
        chunks.push(audio.clone());
        groups.push(group.clone());
    }
    if last_block != document.blocks.len().checked_sub(1) {
        return Err("narration manifest does not cover every source block".to_string());
    }
    if covered_blocks.len() != document.blocks.len()
        || !(0..document.blocks.len()).all(|block| covered_blocks.contains(&block))
        || manifest.get("chunks") != Some(&Value::Array(chunks))
        || manifest.get("groups") != Some(&Value::Array(groups))
        || manifest.get("units") != Some(&Value::Array(units))
        || manifest.get("cues") != Some(&Value::Array(cues))
        || !same_number(manifest.get("durationSeconds"), previous_end)
        || manifest
            .get("planDigest")
            .and_then(Value::as_str)
            .is_none_or(|digest| digest.len() != 64)
    {
        return Err("narration manifest does not exactly concatenate its segments".to_string());
    }
    Ok(())
}

fn same_number(value: Option<&Value>, expected: f64) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|actual| actual.is_finite() && (actual - expected).abs() <= 0.001)
}

fn invalid_targets(value: Option<&Value>, target_ids: &HashSet<&str>) -> bool {
    value.and_then(Value::as_array).is_none_or(|ids| {
        ids.is_empty()
            || ids
                .iter()
                .any(|id| id.as_str().is_none_or(|id| !target_ids.contains(id)))
    })
}

fn segments_count(manifest: &Value) -> Result<usize, String> {
    manifest
        .get("segments")
        .and_then(Value::as_array)
        .map(Vec::len)
        .filter(|count| *count > 0)
        .ok_or_else(|| "narration manifest has no final segments".to_string())
}

fn validate_final_artifact_layout(staging: &Path, segment_count: usize) -> Result<(), String> {
    let allowed = ["audio", "manifest.json", "segments", "source-document.json"]
        .into_iter()
        .collect::<HashSet<_>>();
    for entry in fs::read_dir(staging)
        .map_err(|error| format!("failed to inspect narration artifact: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("failed to inspect narration artifact: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !allowed.contains(name.as_str()) {
            return Err(format!("narration artifact contains spool entry {name}"));
        }
    }
    for (directory, suffix) in [("audio", "wav"), ("segments", "json")] {
        let mut names = fs::read_dir(staging.join(directory))
            .map_err(|error| format!("failed to inspect narration {directory}: {error}"))?
            .map(|entry| {
                entry
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .map_err(|error| format!("failed to inspect narration {directory}: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        names.sort();
        let expected = (0..segment_count)
            .map(|index| format!("{index:06}.{suffix}"))
            .collect::<Vec<_>>();
        if names != expected {
            return Err(format!(
                "narration {directory} does not contain the exact segment prefix"
            ));
        }
    }
    Ok(())
}

fn validate_start_params(params: &NarrationStartParams) -> Result<(), String> {
    if params.source_text.len() > MAX_SOURCE_TEXT_BYTES {
        return Err(format!("sourceText exceeds the v6 64 KB limit"));
    }
    if params.document.schema_version != SOURCE_DOCUMENT_SCHEMA
        || params.document.document_version != SOURCE_DOCUMENT_VERSION
    {
        return Err("narration requires source document schema 3, version 4".to_string());
    }
    if params.document.blocks.is_empty() || params.document.blocks.len() > MAX_SOURCE_BLOCKS {
        return Err("narration source block count is outside the v6 bounds".to_string());
    }
    if params.document.targets.is_empty() || params.document.targets.len() > MAX_SOURCE_TARGETS {
        return Err("narration source target count is outside the v6 bounds".to_string());
    }
    for (field, value) in [
        ("messageId", params.document.message_id.as_str()),
        ("messageRevision", params.document.message_revision.as_str()),
        ("sourceHash", params.document.source_hash.as_str()),
        (
            "assistantMessageId",
            params.target.assistant_message_id.as_str(),
        ),
        ("threadId", params.target.thread_id.as_str()),
        ("turnId", params.target.turn_id.as_str()),
    ] {
        if value.trim().is_empty() || value.len() > MAX_IDENTIFIER_BYTES {
            return Err(format!("narration {field} is invalid"));
        }
    }
    if params.target.assistant_message_id != params.document.message_id
        || params.target.message_revision != params.document.message_revision
        || params.target.source_hash != params.document.source_hash
    {
        return Err("narration target does not match its source document".to_string());
    }
    if narration_source_hash(&params.source_text) != params.document.source_hash {
        return Err("narration sourceText does not match sourceHash".to_string());
    }
    let mut block_ids = HashSet::new();
    for block in &params.document.blocks {
        if !block_ids.insert(block.id.as_str())
            || block.id.len() > MAX_IDENTIFIER_BYTES
            || block.display_text.trim().is_empty()
            || block.path.trim().is_empty()
            || block.target_ids.is_empty()
            || !matches!(
                block.kind.as_str(),
                "paragraph" | "heading" | "listItem" | "blockquote" | "code" | "table" | "diagram"
            )
        {
            return Err("narration source block is incomplete or duplicated".to_string());
        }
        let display_len = block.display_text.encode_utf16().count();
        for range in &block.inline_ranges {
            let start = range.get("displayStart").and_then(Value::as_u64);
            let end = range.get("displayEnd").and_then(Value::as_u64);
            if start
                .zip(end)
                .is_none_or(|(start, end)| start >= end || end > display_len as u64)
                || !matches!(
                    range.get("kind").and_then(Value::as_str),
                    Some("inlineCode" | "link" | "text")
                )
            {
                return Err("narration source block has an invalid inline range".to_string());
            }
        }
    }
    let mut target_ids = HashSet::new();
    let mut target_blocks = HashMap::new();
    for target in &params.document.targets {
        let id = target
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "narration source target is missing id".to_string())?;
        let block_id = target
            .get("blockId")
            .and_then(Value::as_str)
            .ok_or_else(|| "narration source target is missing blockId".to_string())?;
        let block = params
            .document
            .blocks
            .iter()
            .find(|block| block.id == block_id)
            .ok_or_else(|| "narration source target references an unknown block".to_string())?;
        if id.is_empty()
            || id.len() > MAX_IDENTIFIER_BYTES
            || !target_ids.insert(id)
            || !block.target_ids.iter().any(|target_id| target_id == id)
        {
            return Err("narration source targets contain invalid ids".to_string());
        }
        target_blocks.insert(id, block_id);
        match target.get("kind").and_then(Value::as_str) {
            Some("block") => {}
            Some("textRange") => {
                let start = target.get("displayStart").and_then(Value::as_u64);
                let end = target.get("displayEnd").and_then(Value::as_u64);
                let display_len = block.display_text.encode_utf16().count() as u64;
                if start
                    .zip(end)
                    .is_none_or(|(start, end)| start >= end || end > display_len)
                    || !matches!(
                        target.get("role").and_then(Value::as_str),
                        Some("expression" | "inlineCode" | "link" | "word")
                    )
                {
                    return Err("narration source target has an invalid text range".to_string());
                }
            }
            _ => return Err("narration source target has an unsupported kind".to_string()),
        }
    }
    if params.document.blocks.iter().any(|block| {
        let unique = block.target_ids.iter().collect::<HashSet<_>>();
        unique.len() != block.target_ids.len()
            || block.target_ids.iter().any(|target| {
                !target_ids.contains(target.as_str())
                    || target_blocks.get(target.as_str()).copied() != Some(block.id.as_str())
            })
    }) {
        return Err("narration source block references an invalid target".to_string());
    }
    Ok(())
}

fn narration_source_hash(text: &str) -> String {
    let hash = text
        .encode_utf16()
        .fold(0x811c_9dc5_u32, |hash, code_unit| {
            (hash ^ u32::from(code_unit)).wrapping_mul(0x0100_0193)
        });
    format!("{hash:08x}")
}

fn artifact_key(
    params: &NarrationStartParams,
    profile: &Value,
    synthesis: &NarrationSynthesisProfile,
    corpus: &MisakiCorpus,
    compact_json: &str,
) -> String {
    stable_revision_value(&json!({
        "cacheNamespace": CACHE_NAMESPACE,
        "manifestVersion": MANIFEST_VERSION,
        "sourceDocument": params.document,
        "target": params.target,
        "compactRequestSha256": sha256_bytes(compact_json.as_bytes()),
        "baseInstructionsVersion": BASE_INSTRUCTIONS_VERSION,
        "groupingPromptVersion": GROUPING_PROMPT_VERSION,
        "tokenizerVersion": TOKENIZER_VERSION,
        "parserVersion": INCREMENTAL_PARSER_VERSION,
        "localG2pVersion": LOCAL_G2P_VERSION,
        "reviewedLexiconVersion": REVIEWED_LEXICON_VERSION,
        "resolverVersion": CORPUS_RESOLVER_VERSION,
        "sourceMapperVersion": SOURCE_MAPPER_VERSION,
        "profileDigest": profile["profileDigest"],
        "goldCorpusSha256": corpus.gold_sha256(),
        "silverCorpusSha256": corpus.silver_sha256(),
        "synthesizer": synthesis.descriptor,
    }))
}

fn load_vocabulary(path: &Path) -> Result<HashSet<char>, String> {
    let raw: HashMap<String, i64> = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("failed to read Kokoro vocabulary: {error}"))?,
    )
    .map_err(|error| format!("invalid Kokoro vocabulary: {error}"))?;
    raw.into_keys()
        .map(|key| {
            let mut characters = key.chars();
            characters
                .next()
                .filter(|_| characters.next().is_none())
                .ok_or_else(|| "Kokoro vocabulary contains a non-character key".to_string())
        })
        .collect()
}

fn ensure_synthesis_assets(profile: &NarrationSynthesisProfile) -> Result<(), String> {
    if !profile.assets_ready() {
        return Err(format!(
            "native Kokoro model assets are not installed at {}",
            profile.model_dir.display()
        ));
    }
    Ok(())
}

fn read_cached_manifest(
    cache_root: &Path,
    artifact_key: &str,
    document: &NarrationSourceDocument,
) -> Option<Value> {
    if !safe_component(artifact_key) {
        return None;
    }
    let artifact = cache_root.join(artifact_key);
    let value: Value =
        serde_json::from_slice(&fs::read(artifact.join("manifest.json")).ok()?).ok()?;
    validate_manifest_v6(&value, &artifact, document).ok()?;
    Some(value)
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

fn evict_inactive_jobs(jobs: &mut HashMap<String, NarrationJob>, protected: Option<&str>) {
    if jobs.len() <= MAX_INACTIVE_JOBS {
        return;
    }
    let mut inactive = jobs
        .iter()
        .filter(|(key, job)| Some(key.as_str()) != protected && !job.status.active())
        .map(|(key, job)| (job.last_access_ms, key.clone()))
        .collect::<Vec<_>>();
    inactive.sort();
    for (_, key) in inactive {
        if jobs.len() <= MAX_INACTIVE_JOBS {
            break;
        }
        if let Some(job) = jobs.remove(&key)
            && job.status != NarrationStatus::Ready
            && let Some(staging) = job.staging_dir
        {
            let _ = fs::remove_dir_all(staging);
        }
    }
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
            Some((
                fs::metadata(&manifest).ok()?.modified().ok()?,
                directory_size(&entry.path()),
                entry.path(),
            ))
        })
        .collect::<Vec<_>>();
    let mut total = directory_size(&cache_root.join(protected_key))
        + artifacts.iter().map(|(_, size, _)| *size).sum::<u64>();
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
    fs::read_dir(path)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| {
                    if entry.path().is_dir() {
                        directory_size(&entry.path())
                    } else {
                        entry.metadata().map(|metadata| metadata.len()).unwrap_or(0)
                    }
                })
                .sum()
        })
        .unwrap_or(0)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|bytes| sha256_bytes(&bytes))
        .map_err(|error| format!("failed to hash {}: {error}", path.display()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn decode_routed_params<T: DeserializeOwned>(mut params: Value, method: &str) -> Result<T, String> {
    if let Some(params) = params.as_object_mut() {
        for field in ["_remuxOrigin", "_remuxViewerKey"] {
            if let Some(value) = params.remove(field)
                && !value.is_string()
            {
                return Err(format!(
                    "invalid {method} params: reserved field {field} must be a string"
                ));
            }
        }
    }
    serde_json::from_value(params).map_err(|error| format!("invalid {method} params: {error}"))
}

fn non_empty<'a>(value: &'a str, field: &str) -> Result<&'a str, String> {
    (!value.trim().is_empty())
        .then_some(value)
        .ok_or_else(|| format!("{field} is required"))
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

    fn with_routing_metadata(mut params: Value) -> Value {
        {
            let object = params
                .as_object_mut()
                .expect("test params must be an object");
            object.insert(
                "_remuxOrigin".to_string(),
                Value::String("viewer-origin".to_string()),
            );
            object.insert(
                "_remuxViewerKey".to_string(),
                Value::String("viewer-key".to_string()),
            );
        }
        params
    }

    #[test]
    fn routed_request_metadata_is_accepted_without_weakening_domain_params() {
        let source_text = "Hello world.";
        let source_hash = narration_source_hash(source_text);
        let start: NarrationStartParams = decode_routed_params(
            with_routing_metadata(json!({
                "document": {
                    "blocks": [{
                        "displayText": source_text,
                        "id": "md:0",
                        "inlineRanges": [],
                        "kind": "paragraph",
                        "path": "0",
                        "targetIds": ["md:0/target/block"]
                    }],
                    "documentVersion": "4",
                    "messageId": "message",
                    "messageRevision": "revision",
                    "schemaVersion": 3,
                    "sourceHash": source_hash,
                    "targets": [{
                        "blockId": "md:0",
                        "id": "md:0/target/block",
                        "kind": "block"
                    }]
                },
                "sourceText": source_text,
                "target": {
                    "assistantMessageId": "message",
                    "messageRevision": "revision",
                    "sourceHash": source_hash,
                    "threadId": "thread",
                    "turnId": "turn"
                }
            })),
            "narration/start",
        )
        .expect("start params should accept runtime routing metadata");
        validate_start_params(&start).expect("routed start params should remain valid");

        let read: NarrationReadParams = decode_routed_params(
            with_routing_metadata(json!({ "artifactKey": "artifact" })),
            "narration/resources/read",
        )
        .expect("read params should accept runtime routing metadata");
        assert_eq!(read.artifact_key, "artifact");

        let cancel: NarrationCancelParams = decode_routed_params(
            with_routing_metadata(json!({ "artifactKey": "artifact" })),
            "narration/cancel",
        )
        .expect("cancel params should accept runtime routing metadata");
        assert_eq!(cancel.artifact_key, "artifact");

        let audio: NarrationAudioReadParams = decode_routed_params(
            with_routing_metadata(json!({
                "artifactKey": "artifact",
                "chunkId": "000000"
            })),
            "narration/audio/read",
        )
        .expect("audio params should accept runtime routing metadata");
        assert_eq!(audio.artifact_key, "artifact");
        assert_eq!(audio.chunk_id, "000000");

        assert!(
            decode_routed_params::<NarrationReadParams>(
                with_routing_metadata(json!({
                    "artifactKey": "artifact",
                    "unexpected": true
                })),
                "narration/resources/read",
            )
            .is_err(),
            "ordinary unknown fields must remain rejected"
        );
        assert!(
            decode_routed_params::<NarrationReadParams>(
                json!({ "artifactKey": "artifact", "_remuxOrigin": 42 }),
                "narration/resources/read",
            )
            .is_err(),
            "reserved routing fields must retain their string contract"
        );
    }

    #[test]
    fn v6_source_contract_rejects_old_documents_and_needs_no_runtime_selector() {
        let params = NarrationStartParams {
            document: NarrationSourceDocument {
                blocks: vec![],
                document_version: "3".to_string(),
                message_id: "message".to_string(),
                message_revision: "revision".to_string(),
                schema_version: 2,
                source_hash: "source".to_string(),
                targets: vec![],
            },
            source_text: "source".to_string(),
            target: NarrationTarget {
                assistant_message_id: "message".to_string(),
                message_revision: "revision".to_string(),
                source_hash: "source".to_string(),
                thread_id: "thread".to_string(),
                turn_id: "turn".to_string(),
            },
        };
        assert!(validate_start_params(&params).is_err());
        assert!(std::env::var_os("REMUX_NARRATION_MODEL").is_none());
    }

    #[test]
    fn source_hash_matches_the_viewer_utf16_contract() {
        assert_eq!(narration_source_hash("source"), "1bcf29d8");
        assert_eq!(narration_source_hash("A😀"), "dfcb7cd9");
        assert_eq!(narration_source_hash("Hello, world!"), "ed90f094");
    }

    #[test]
    fn committed_spool_is_bounded_by_groups_and_phonemes() {
        let mut committed = VecDeque::new();
        for index in 0..15 {
            committed.push_back((index, 250));
        }
        assert!(spool_has_capacity(&committed, 3_750, 250));
        assert!(!spool_has_capacity(&committed, 3_750, 251));
        committed.push_back((15, 0));
        assert!(!spool_has_capacity(&committed, 3_750, 1));
    }
}
