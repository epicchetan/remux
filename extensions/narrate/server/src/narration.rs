use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use remux_compute::{Registry as ComputeRegistry, TaskOptions};
use remux_extension_rpc::Peer as ExtensionRpcPeer;
use remux_tts::{
    AUDIT_WINDOW_PLANNER_VERSION, BatchSynthesisProgress, BatchSynthesisRequest,
    DIRECT_PHONE_ALPHABET_VERSION, DIRECT_PHONE_VALIDATOR_VERSION, HighlightMode,
    KokoroBatchSynthesis, KokoroVocabulary, NarrationArtifact, NarrationBlockKind,
    NarrationDocument, NarrationProfile, PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
    PRONUNCIATION_PROMPT_VERSION, PronunciationReviewerProfile, ReviewedPronunciationPlan,
    STRUCTURAL_TRANSCRIPT_OUTPUT_SCHEMA_VERSION, STRUCTURAL_TRANSCRIPT_PROMPT_VERSION,
    STRUCTURAL_TRANSCRIPT_WINDOW_PLANNER_VERSION, StructuralTranscriptPlan,
    StructuralTranscriptProfile, direct_phone_alphabet_sha256, narration_document_hash,
    prepare_baseline, validate_batch_artifact, validate_structural_transcript_plan,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::inference_gate::InferenceGate;
use crate::media::{media_url, publish_file};
use crate::pronunciation_audit::{
    AuditCallbacks, REVIEWER_EFFORT, REVIEWER_MODEL, REVIEWER_PROFILE_DIGEST,
    REVIEWER_SERVICE_TIER, reviewer_profile_descriptor, run_pronunciation_audit,
    validate_cached_plan,
};
use crate::structural_transcript::{
    TranscriptCallbacks, run_structural_transcript, structural_transcript_profile_descriptor,
    validate_cached_structural_transcript_plan,
};
use crate::synthesis_profile::{NarrationSynthesisProfile, resolve_synthesis_profile};

pub(crate) const NARRATION_UPDATED_METHOD: &str = "remux/narrate/narration/updated";

const CACHE_NAMESPACE: &str = "batch-alignment-v4-post-transcript-direct-review";
const MAX_START_PARAMS_BYTES: usize = 2 * 1024 * 1024;
const MAX_SOURCE_TEXT_BYTES: usize = 64 * 1024;
const MAX_SOURCE_BLOCKS: usize = 512;
const MAX_IDENTIFIER_BYTES: usize = 1_024;
const MAX_AUDIO_BYTES: u64 = 128 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_INACTIVE_JOBS: usize = 128;
const JOB_DEADLINE: Duration = Duration::from_secs(15 * 60);
const STALL_DEADLINE: Duration = Duration::from_secs(2 * 60);
const LOOP_POLL: Duration = Duration::from_millis(25);

#[derive(Clone)]
pub(crate) struct NarrationServer {
    inner: Arc<NarrationInner>,
}

struct NarrationInner {
    cache_root: PathBuf,
    compute: ComputeRegistry,
    diagnostics: Mutex<VecDeque<Value>>,
    host_rpc: ExtensionRpcPeer,
    jobs: Mutex<HashMap<String, NarrationJob>>,
    media_root: Option<PathBuf>,
    output_tx: mpsc::SyncSender<Value>,
    remux_root: PathBuf,
    codex_home: PathBuf,
}

#[derive(Clone, Debug)]
struct NarrationJob {
    artifact_key: String,
    active_operations: HashSet<String>,
    cancel_requested: bool,
    document: NarrationDocument,
    error: Option<String>,
    last_access_ms: u128,
    manifest: Option<NarrationArtifact>,
    progress: JobProgress,
    revision: u64,
    staging_dir: Option<PathBuf>,
    status: NarrationStatus,
    synthesis_profile: NarrationSynthesisProfile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NarrationStatus {
    Preparing,
    Synthesizing,
    Finalizing,
    Ready,
    Failed,
    Cancelled,
}

impl NarrationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Synthesizing => "synthesizing",
            Self::Finalizing => "finalizing",
            Self::Ready => "ready",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn active(self) -> bool {
        matches!(
            self,
            Self::Preparing | Self::Synthesizing | Self::Finalizing
        )
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
enum NarrationStage {
    #[default]
    Baseline,
    LanguagePlanning,
    Planning,
    LoadingModel,
    Synthesizing,
    Finalizing,
    Ready,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    stage: NarrationStage,
    audit_windows_completed: usize,
    audit_windows_total: usize,
    transcript_windows_completed: usize,
    transcript_windows_total: usize,
    chunks_completed: usize,
    chunks_total: usize,
    sentences: usize,
    words: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NarrationStartParams {
    document: NarrationDocument,
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

impl NarrationServer {
    pub(crate) fn new(
        remux_root: PathBuf,
        codex_home: PathBuf,
        output_tx: mpsc::SyncSender<Value>,
        host_rpc: ExtensionRpcPeer,
        compute: ComputeRegistry,
    ) -> Self {
        let cache_root = remux_root
            .join(".remux")
            .join("cache")
            .join("narrate")
            .join(CACHE_NAMESPACE);
        cleanup_temporary_artifacts(&cache_root);
        Self {
            inner: Arc::new(NarrationInner {
                cache_root,
                compute,
                diagnostics: Mutex::new(VecDeque::new()),
                host_rpc,
                jobs: Mutex::new(HashMap::new()),
                media_root: std::env::var_os("REMUX_MEDIA_DIR").map(PathBuf::from),
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
                "sourceSchemaInvalid: narration/start params are too large: {encoded_len}>{MAX_START_PARAMS_BYTES}"
            ));
        }
        let params: NarrationStartParams = decode_routed_params(params, "narration/start")?;
        validate_document(&params.document)?;
        let synthesis_profile =
            resolve_synthesis_profile(&self.inner.remux_root, &self.inner.codex_home)?;
        ensure_synthesis_assets(&synthesis_profile)?;
        let profile = narration_profile(&synthesis_profile)?;
        let document_hash = narration_document_hash(&params.document)?;
        let artifact_key = artifact_key(&document_hash, &profile, &synthesis_profile)?;

        if let Some(manifest) = read_cached_manifest(
            &self.inner.cache_root,
            self.inner.media_root.as_deref(),
            &artifact_key,
            &params.document,
            &document_hash,
            &profile,
            &synthesis_profile,
        )? {
            let job = NarrationJob::ready(
                artifact_key.clone(),
                params.document,
                manifest,
                synthesis_profile,
            );
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
            && job.status.active()
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
        let invalid_cache = self.inner.cache_root.join(&artifact_key);
        if invalid_cache.exists() {
            fs::remove_dir_all(&invalid_cache).map_err(|error| {
                format!(
                    "failed to remove invalid narration cache {}: {error}",
                    invalid_cache.display()
                )
            })?;
        }
        let job = NarrationJob::preparing(artifact_key.clone(), params.document, synthesis_profile);
        let resource = job.resource_value();
        jobs.insert(artifact_key.clone(), job);
        evict_inactive_jobs(&mut jobs, Some(&artifact_key));
        drop(jobs);
        if let Some(staging) = stale_staging {
            let _ = fs::remove_dir_all(staging);
        }

        let inner = self.inner.clone();
        let background_key = artifact_key.clone();
        thread::spawn(move || run_job(inner, background_key, profile, document_hash));
        Ok(json!({
            "artifactKey": artifact_key,
            "resource": resource,
            "status": "accepted",
        }))
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
        if job.status == NarrationStatus::Ready
            && let Some(manifest) = &job.manifest
        {
            publish_manifest_audio(
                self.inner.media_root.as_deref(),
                &self.inner.cache_root.join(artifact_key).join("audio.wav"),
                manifest,
            )?;
        }
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
        let (notify, operations) = {
            let mut jobs = self
                .inner
                .jobs
                .lock()
                .map_err(|_| "narration job store poisoned".to_string())?;
            let Some(job) = jobs.get_mut(&artifact_key) else {
                return Ok(json!({ "artifactKey": artifact_key, "status": "accepted" }));
            };
            if !job.status.active() {
                (false, Vec::new())
            } else {
                job.cancel_requested = true;
                job.revision += 1;
                (
                    true,
                    job.active_operations.iter().cloned().collect::<Vec<_>>(),
                )
            }
        };
        for operation_id in operations {
            self.inner.cancel_inference(&operation_id);
        }
        if notify {
            self.inner.notify(&artifact_key);
        }
        Ok(json!({ "artifactKey": artifact_key, "status": "accepted" }))
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
    fn preparing(
        artifact_key: String,
        document: NarrationDocument,
        synthesis_profile: NarrationSynthesisProfile,
    ) -> Self {
        Self {
            artifact_key,
            active_operations: HashSet::new(),
            cancel_requested: false,
            document,
            error: None,
            last_access_ms: now_millis(),
            manifest: None,
            progress: JobProgress::default(),
            revision: 1,
            staging_dir: None,
            status: NarrationStatus::Preparing,
            synthesis_profile,
        }
    }

    fn ready(
        artifact_key: String,
        document: NarrationDocument,
        manifest: NarrationArtifact,
        synthesis_profile: NarrationSynthesisProfile,
    ) -> Self {
        Self {
            artifact_key,
            active_operations: HashSet::new(),
            cancel_requested: false,
            document,
            error: None,
            last_access_ms: now_millis(),
            progress: JobProgress {
                stage: NarrationStage::Ready,
                ..Default::default()
            },
            manifest: Some(manifest),
            revision: 1,
            staging_dir: None,
            status: NarrationStatus::Ready,
            synthesis_profile,
        }
    }

    fn resource_value(&self) -> Value {
        json!({
            "artifactKey": self.artifact_key,
            "complete": self.status == NarrationStatus::Ready,
            "error": self.error,
            "manifest": self.manifest,
            "progress": self.progress,
            "revision": self.revision.to_string(),
            "status": self.status.as_str(),
        })
    }
}

impl NarrationInner {
    fn update_job(&self, artifact_key: &str, update: impl FnOnce(&mut NarrationJob)) {
        if let Ok(mut jobs) = self.jobs.lock()
            && let Some(job) = jobs.get_mut(artifact_key)
        {
            update(job);
            job.revision += 1;
            drop(jobs);
            self.notify(artifact_key);
        }
    }

    fn cancelled(&self, artifact_key: &str) -> bool {
        self.jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(artifact_key).map(|job| job.cancel_requested))
            .unwrap_or(true)
    }

    fn register_operation(&self, artifact_key: &str, operation_id: &str) -> Result<(), String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "narration job store poisoned".to_string())?;
        let job = jobs
            .get_mut(artifact_key)
            .ok_or_else(|| "narration job disappeared".to_string())?;
        if job.cancel_requested {
            return Err("narration cancelled".to_string());
        }
        if !job.active_operations.insert(operation_id.to_string()) {
            return Err("languagePlanningFailed: duplicate operation id".to_string());
        }
        Ok(())
    }

    fn unregister_operation(&self, artifact_key: &str, operation_id: &str) {
        if let Ok(mut jobs) = self.jobs.lock()
            && let Some(job) = jobs.get_mut(artifact_key)
        {
            job.active_operations.remove(operation_id);
        }
    }

    fn cancel_inference(&self, operation_id: &str) {
        let _ = self.host_rpc.request(
            "remux/codex/inference/structured/cancel",
            Some(json!({ "operationId": operation_id })),
            Duration::from_secs(5),
        );
    }

    fn notify(&self, artifact_key: &str) {
        let _ = self.output_tx.send(json!({
            "jsonrpc": "2.0",
            "method": NARRATION_UPDATED_METHOD,
            "params": { "artifactKey": artifact_key },
        }));
    }

    fn record_diagnostic(&self, value: Value) {
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.push_back(value);
            while diagnostics.len() > 64 {
                diagnostics.pop_front();
            }
        }
    }
}

fn run_job(
    inner: Arc<NarrationInner>,
    artifact_key: String,
    profile: NarrationProfile,
    document_hash: String,
) {
    let started = Instant::now();
    let result = run_job_inner(&inner, &artifact_key, profile, document_hash, started);
    let elapsed_ms = started.elapsed().as_millis();
    match result {
        Ok((manifest, diagnostics)) => {
            inner.record_diagnostic(json!({
                "artifactKey": artifact_key,
                "diagnostics": diagnostics,
                "elapsedMs": elapsed_ms,
                "phase": "ready",
            }));
            inner.update_job(&artifact_key, |job| {
                job.active_operations.clear();
                job.error = None;
                job.manifest = Some(manifest);
                job.progress.stage = NarrationStage::Ready;
                job.staging_dir = None;
                job.status = NarrationStatus::Ready;
            });
        }
        Err(error) => {
            let cancelled = inner.cancelled(&artifact_key) || error == "narration cancelled";
            let cleanup = inner.jobs.lock().ok().and_then(|jobs| {
                jobs.get(&artifact_key)
                    .and_then(|job| job.staging_dir.clone())
            });
            inner.record_diagnostic(json!({
                "artifactKey": artifact_key,
                "elapsedMs": elapsed_ms,
                "error": error,
                "phase": if cancelled { "cancelled" } else { "failed" },
            }));
            inner.update_job(&artifact_key, |job| {
                job.active_operations.clear();
                job.error = (!cancelled).then_some(error);
                job.manifest = None;
                job.staging_dir = None;
                job.status = if cancelled {
                    NarrationStatus::Cancelled
                } else {
                    NarrationStatus::Failed
                };
            });
            if let Some(path) = cleanup {
                let _ = fs::remove_dir_all(path);
            }
        }
    }
}

fn run_job_inner(
    inner: &Arc<NarrationInner>,
    artifact_key: &str,
    profile: NarrationProfile,
    document_hash: String,
    job_started: Instant,
) -> Result<(NarrationArtifact, Value), String> {
    let (document, synthesis_profile) = {
        let jobs = inner
            .jobs
            .lock()
            .map_err(|_| "narration job store poisoned".to_string())?;
        let job = jobs
            .get(artifact_key)
            .ok_or_else(|| "narration job disappeared".to_string())?;
        (job.document.clone(), job.synthesis_profile.clone())
    };
    let staging = inner.cache_root.join(format!(
        ".{artifact_key}.tmp-{}-{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("failed to create narration staging: {error}"))?;
    inner.update_job(artifact_key, |job| {
        job.staging_dir = Some(staging.clone());
        job.progress.stage = NarrationStage::Baseline;
    });

    let gate = InferenceGate::new(3);
    let transcript_callbacks = {
        let cancelled_inner = inner.clone();
        let cancelled_key = artifact_key.to_string();
        let register_inner = inner.clone();
        let register_key = artifact_key.to_string();
        let unregister_inner = inner.clone();
        let unregister_key = artifact_key.to_string();
        let progress_inner = inner.clone();
        let progress_key = artifact_key.to_string();
        TranscriptCallbacks {
            cancelled: Arc::new(move || cancelled_inner.cancelled(&cancelled_key)),
            deadline_exceeded: Arc::new(move || job_started.elapsed() > JOB_DEADLINE),
            register_operation: Arc::new(move |operation_id| {
                register_inner.register_operation(&register_key, operation_id)
            }),
            unregister_operation: Arc::new(move |operation_id| {
                unregister_inner.unregister_operation(&unregister_key, operation_id)
            }),
            window_completed: Arc::new(move |completed, total| {
                progress_inner.update_job(&progress_key, |job| {
                    job.progress.stage = NarrationStage::LanguagePlanning;
                    job.progress.transcript_windows_completed = completed;
                    job.progress.transcript_windows_total = total;
                });
            }),
        }
    };
    let transcript = run_structural_transcript(
        &inner.host_rpc,
        artifact_key,
        &document,
        gate.clone(),
        transcript_callbacks,
    )?;
    let structural_transcript_plan = transcript.plan;
    let structural_transcript_plan_sha256 = transcript.plan_sha256;
    let speech_document =
        validate_structural_transcript_plan(&document, &structural_transcript_plan)?;
    let vocabulary = KokoroVocabulary::load(&synthesis_profile.model_dir.join("vocab.json"))?;
    let baseline = prepare_baseline(&speech_document)?;
    inner.update_job(artifact_key, |job| {
        job.progress.stage = NarrationStage::LanguagePlanning;
        job.progress.sentences = baseline.sentences.len();
        job.progress.words = baseline.words.len();
    });
    let audit_callbacks = {
        let cancelled_inner = inner.clone();
        let cancelled_key = artifact_key.to_string();
        let register_inner = inner.clone();
        let register_key = artifact_key.to_string();
        let unregister_inner = inner.clone();
        let unregister_key = artifact_key.to_string();
        let progress_inner = inner.clone();
        let progress_key = artifact_key.to_string();
        AuditCallbacks {
            cancelled: Arc::new(move || cancelled_inner.cancelled(&cancelled_key)),
            deadline_exceeded: Arc::new(move || job_started.elapsed() > JOB_DEADLINE),
            register_operation: Arc::new(move |operation_id| {
                register_inner.register_operation(&register_key, operation_id)
            }),
            unregister_operation: Arc::new(move |operation_id| {
                unregister_inner.unregister_operation(&unregister_key, operation_id)
            }),
            window_completed: Arc::new(move |completed, total| {
                progress_inner.update_job(&progress_key, |job| {
                    job.progress.stage = NarrationStage::LanguagePlanning;
                    job.progress.audit_windows_completed = completed;
                    job.progress.audit_windows_total = total;
                });
            }),
        }
    };
    let audit = run_pronunciation_audit(
        &inner.host_rpc,
        artifact_key,
        &speech_document,
        &baseline,
        &vocabulary,
        gate,
        audit_callbacks,
    )?;
    let pronunciation_plan = audit.plan;
    let pronunciation_plan_sha256 = audit.plan_sha256;
    let redundant_direct_patches = audit.redundant_direct_patches;
    atomic_json(
        &staging.join("pronunciation-plan.json"),
        &pronunciation_plan,
    )?;
    atomic_json(
        &staging.join("structural-transcript-plan.json"),
        &structural_transcript_plan,
    )?;
    inner.update_job(artifact_key, |job| {
        job.status = NarrationStatus::Synthesizing;
        job.progress.stage = NarrationStage::Planning;
    });

    let request = BatchSynthesisRequest {
        artifact_key: artifact_key.to_string(),
        document: document.clone(),
        document_hash: document_hash.clone(),
        model_assets: synthesis_profile.model_assets.clone(),
        model_dir: synthesis_profile.model_dir.clone(),
        profile: profile.clone(),
        pronunciation_plan: pronunciation_plan.clone(),
        pronunciation_plan_sha256: pronunciation_plan_sha256.clone(),
        structural_transcript_plan: structural_transcript_plan.clone(),
        structural_transcript_plan_sha256: structural_transcript_plan_sha256.clone(),
        redundant_direct_patches,
        max_wav_bytes: MAX_AUDIO_BYTES,
        staging_dir: staging.clone(),
    };
    let mut worker = inner
        .compute
        .spawn::<KokoroBatchSynthesis>(
            TaskOptions::new("narration", format!("narration:{artifact_key}")),
            request,
        )
        .map_err(|error| format!("failed to start batch Kokoro task: {error}"))?;

    let mut last_progress = Instant::now();
    let output = loop {
        if inner.cancelled(artifact_key) {
            let _ = worker.cancel();
            return Err("narration cancelled".to_string());
        }
        while let Some(progress) = worker
            .try_progress()
            .map_err(|error| format!("batch Kokoro task failed: {error}"))?
        {
            last_progress = Instant::now();
            match progress {
                BatchSynthesisProgress::Planned {
                    chunks,
                    sentences,
                    words,
                } => inner.update_job(artifact_key, |job| {
                    job.progress.stage = NarrationStage::LoadingModel;
                    job.progress.chunks_total = chunks;
                    job.progress.sentences = sentences;
                    job.progress.words = words;
                }),
                BatchSynthesisProgress::ModelLoaded => {
                    inner.update_job(artifact_key, |job| {
                        job.progress.stage = NarrationStage::Synthesizing;
                    });
                }
                BatchSynthesisProgress::ChunkSynthesized { completed, total } => {
                    inner.update_job(artifact_key, |job| {
                        job.progress.stage = NarrationStage::Synthesizing;
                        job.progress.chunks_completed = completed;
                        job.progress.chunks_total = total;
                    });
                }
            }
        }
        if let Some(output) = worker
            .try_join()
            .map_err(|error| format!("batch Kokoro task failed: {error}"))?
        {
            break output;
        }
        if job_started.elapsed() > JOB_DEADLINE || last_progress.elapsed() > STALL_DEADLINE {
            let _ = worker.cancel();
            return Err(if job_started.elapsed() > JOB_DEADLINE {
                "narration job deadline exceeded".to_string()
            } else {
                "batch Kokoro task made no progress for 120 seconds".to_string()
            });
        }
        thread::sleep(LOOP_POLL);
    };
    if job_started.elapsed() > JOB_DEADLINE {
        return Err("narration job deadline exceeded".to_string());
    }

    inner.update_job(artifact_key, |job| {
        job.status = NarrationStatus::Finalizing;
        job.progress.stage = NarrationStage::Finalizing;
    });
    let mut artifact = output.artifact;
    artifact.audio.url = media_url(&artifact.audio.sha256)?;
    validate_artifact_files(
        &artifact,
        &document,
        &staging,
        artifact_key,
        &document_hash,
        &profile,
        &pronunciation_plan,
        &structural_transcript_plan,
    )?;
    publish_manifest_audio(
        inner.media_root.as_deref(),
        &staging.join("audio.wav"),
        &artifact,
    )?;
    atomic_json(&staging.join("source-document.json"), &document)?;
    atomic_json(&staging.join("manifest.json"), &artifact)?;
    validate_final_layout(&staging)?;
    if inner.cancelled(artifact_key) {
        return Err("narration cancelled".to_string());
    }
    if job_started.elapsed() > JOB_DEADLINE {
        return Err("narration job deadline exceeded".to_string());
    }
    let final_dir = inner.cache_root.join(artifact_key);
    if final_dir.exists() {
        return Err("refusing to replace an existing batch narration artifact".to_string());
    }
    fs::create_dir_all(&inner.cache_root)
        .map_err(|error| format!("failed to create narration cache: {error}"))?;
    fs::rename(&staging, &final_dir)
        .map_err(|error| format!("failed to promote narration artifact: {error}"))?;
    fs::File::open(&inner.cache_root)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync narration cache: {error}"))?;
    enforce_cache_limit(&inner.cache_root, artifact_key);
    Ok((
        artifact,
        serde_json::to_value(output.diagnostics).unwrap_or(Value::Null),
    ))
}

fn validate_document(document: &NarrationDocument) -> Result<(), String> {
    if document.schema_version != 1 {
        return Err("sourceSchemaInvalid: schemaVersion must be 1".to_string());
    }
    if document.blocks.is_empty() || document.blocks.len() > MAX_SOURCE_BLOCKS {
        return Err("sourceSchemaInvalid: blocks must contain 1..512 entries".to_string());
    }
    let mut ids = HashSet::new();
    let mut text_bytes = 0usize;
    for block in &document.blocks {
        if block.id.trim().is_empty()
            || block.id.len() > MAX_IDENTIFIER_BYTES
            || !ids.insert(block.id.as_str())
        {
            return Err("sourceSchemaInvalid: block ids must be unique and nonempty".to_string());
        }
        if block.text.trim().is_empty() {
            return Err(format!(
                "sourceSchemaInvalid: block {} has empty text",
                block.id
            ));
        }
        text_bytes = text_bytes.saturating_add(block.text.len());
        let expected = if block.kind.structural() {
            HighlightMode::Block
        } else {
            HighlightMode::Text
        };
        if block.highlight_mode != expected {
            return Err(format!(
                "sourceSchemaInvalid: block {} has an invalid highlightMode",
                block.id
            ));
        }
        if matches!(block.kind, NarrationBlockKind::Heading) && block.text.contains('\n') {
            return Err(format!(
                "sourceSchemaInvalid: heading {} may not contain a newline",
                block.id
            ));
        }
    }
    if text_bytes > MAX_SOURCE_TEXT_BYTES {
        return Err(format!(
            "sourceSchemaInvalid: block text is too large: {text_bytes}>{MAX_SOURCE_TEXT_BYTES}"
        ));
    }
    Ok(())
}

fn narration_profile(
    synthesis_profile: &NarrationSynthesisProfile,
) -> Result<NarrationProfile, String> {
    let synthesizer_hash = sha256_bytes(
        &serde_json::to_vec(&synthesis_profile.descriptor)
            .map_err(|error| format!("failed to encode synthesizer profile: {error}"))?,
    );
    Ok(NarrationProfile {
        phonemizer: "misaki-rs-0.3.0-us-no-default-features".to_string(),
        pronunciation_reviewer: PronunciationReviewerProfile {
            model: REVIEWER_MODEL.to_string(),
            service_tier: REVIEWER_SERVICE_TIER.to_string(),
            effort: REVIEWER_EFFORT.to_string(),
            profile_digest: REVIEWER_PROFILE_DIGEST.to_string(),
            prompt_version: PRONUNCIATION_PROMPT_VERSION,
            output_schema_version: PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
            window_planner_version: AUDIT_WINDOW_PLANNER_VERSION,
            phone_alphabet_version: DIRECT_PHONE_ALPHABET_VERSION,
            phone_alphabet_sha256: direct_phone_alphabet_sha256(),
            kokoro_vocabulary_sha256: format!(
                "sha256-{}",
                synthesis_profile
                    .model_assets
                    .get("vocab.json")
                    .ok_or_else(|| "narration model manifest is missing vocab.json".to_string())?
            ),
            direct_phone_validator_version: DIRECT_PHONE_VALIDATOR_VERSION,
        },
        structural_transcript: StructuralTranscriptProfile {
            model: REVIEWER_MODEL.to_string(),
            service_tier: REVIEWER_SERVICE_TIER.to_string(),
            effort: REVIEWER_EFFORT.to_string(),
            profile_digest: REVIEWER_PROFILE_DIGEST.to_string(),
            prompt_version: STRUCTURAL_TRANSCRIPT_PROMPT_VERSION,
            output_schema_version: STRUCTURAL_TRANSCRIPT_OUTPUT_SCHEMA_VERSION,
            window_planner_version: STRUCTURAL_TRANSCRIPT_WINDOW_PLANNER_VERSION,
        },
        source_mapper_version: 1,
        word_segmenter_version: 2,
        sentence_version: 1,
        planner_version: 1,
        timing_version: 2,
        synthesizer_hash: format!("sha256-{synthesizer_hash}"),
    })
}

fn artifact_key(
    document_hash: &str,
    profile: &NarrationProfile,
    synthesis_profile: &NarrationSynthesisProfile,
) -> Result<String, String> {
    let model_assets = synthesis_profile
        .model_assets
        .iter()
        .collect::<BTreeMap<_, _>>();
    let identity = json!({
        "namespace": CACHE_NAMESPACE,
        "documentHash": document_hash,
        "profile": profile,
        "pronunciationReviewer": reviewer_profile_descriptor(
            &profile.pronunciation_reviewer.kokoro_vocabulary_sha256,
        ),
        "structuralTranscript": structural_transcript_profile_descriptor(),
        "modelAssets": model_assets,
    });
    Ok(format!(
        "sha256-{}",
        sha256_bytes(
            &serde_json::to_vec(&identity)
                .map_err(|error| format!("failed to encode artifact identity: {error}"))?
        )
    ))
}

fn ensure_synthesis_assets(profile: &NarrationSynthesisProfile) -> Result<(), String> {
    profile.assets_ready().then_some(()).ok_or_else(|| {
        format!(
            "narration model assets are unavailable at {}",
            profile.model_dir.display()
        )
    })
}

#[allow(clippy::too_many_arguments)]
fn validate_artifact_files(
    artifact: &NarrationArtifact,
    document: &NarrationDocument,
    directory: &Path,
    artifact_key: &str,
    document_hash: &str,
    profile: &NarrationProfile,
    pronunciation_plan: &ReviewedPronunciationPlan,
    structural_transcript_plan: &StructuralTranscriptPlan,
) -> Result<(), String> {
    let expected_media_url = media_url(&artifact.audio.sha256)?;
    let pronunciation_plan_sha256 = pronunciation_plan.sha256()?;
    let structural_transcript_plan_sha256 = structural_transcript_plan.sha256()?;
    if artifact.schema_version != 4
        || artifact.artifact_key != artifact_key
        || artifact.document_hash != document_hash
        || artifact.pronunciation_plan_sha256 != pronunciation_plan_sha256
        || artifact.structural_transcript_plan_sha256 != structural_transcript_plan_sha256
        || artifact.profile != *profile
        || artifact.audio.url != expected_media_url
        || artifact.audio.mime_type != "audio/wav"
        || artifact.audio.sample_rate != 24_000
        || artifact.audio.channels != 1
    {
        return Err("artifactAlignmentInvalid: manifest identity is invalid".to_string());
    }
    let mut synthesis_artifact = artifact.clone();
    synthesis_artifact.audio.url = "audio.wav".to_string();
    validate_batch_artifact(
        document,
        pronunciation_plan,
        structural_transcript_plan,
        &synthesis_artifact,
        &directory.join("audio.wav"),
        MAX_AUDIO_BYTES,
    )?;
    Ok(())
}

fn validate_final_layout(directory: &Path) -> Result<(), String> {
    let mut names = fs::read_dir(directory)
        .map_err(|error| format!("failed to inspect narration artifact: {error}"))?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    if names
        != [
            "audio.wav",
            "manifest.json",
            "pronunciation-plan.json",
            "source-document.json",
            "structural-transcript-plan.json",
        ]
    {
        return Err("narration artifact contains unexpected files".to_string());
    }
    Ok(())
}

fn read_cached_manifest(
    cache_root: &Path,
    media_root: Option<&Path>,
    artifact_key: &str,
    document: &NarrationDocument,
    document_hash: &str,
    profile: &NarrationProfile,
    synthesis_profile: &NarrationSynthesisProfile,
) -> Result<Option<NarrationArtifact>, String> {
    let directory = cache_root.join(artifact_key);
    let Some(manifest) = fs::read(directory.join("manifest.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<NarrationArtifact>(&bytes).ok())
    else {
        return Ok(None);
    };
    let Some(source) = fs::read(directory.join("source-document.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<NarrationDocument>(&bytes).ok())
    else {
        return Ok(None);
    };
    let Some(pronunciation_plan) = fs::read(directory.join("pronunciation-plan.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ReviewedPronunciationPlan>(&bytes).ok())
    else {
        return Ok(None);
    };
    let Some(structural_transcript_plan) =
        fs::read(directory.join("structural-transcript-plan.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StructuralTranscriptPlan>(&bytes).ok())
    else {
        return Ok(None);
    };
    if &source != document
        || narration_document_hash(&source).ok().as_deref() != Some(document_hash)
    {
        return Ok(None);
    }
    let vocabulary = match KokoroVocabulary::load(&synthesis_profile.model_dir.join("vocab.json")) {
        Ok(vocabulary) => vocabulary,
        Err(_) => return Ok(None),
    };
    if validate_cached_structural_transcript_plan(&source, &structural_transcript_plan).is_err() {
        return Ok(None);
    }
    let speech_document =
        match validate_structural_transcript_plan(&source, &structural_transcript_plan) {
            Ok(document) => document,
            Err(_) => return Ok(None),
        };
    let baseline = match prepare_baseline(&speech_document) {
        Ok(baseline) => baseline,
        Err(_) => return Ok(None),
    };
    if validate_cached_plan(
        &speech_document,
        &baseline,
        &vocabulary,
        &pronunciation_plan,
    )
    .is_err()
    {
        return Ok(None);
    }
    if validate_artifact_files(
        &manifest,
        &source,
        &directory,
        artifact_key,
        document_hash,
        profile,
        &pronunciation_plan,
        &structural_transcript_plan,
    )
    .is_err()
        || validate_final_layout(&directory).is_err()
    {
        return Ok(None);
    }
    publish_manifest_audio(media_root, &directory.join("audio.wav"), &manifest)?;
    Ok(Some(manifest))
}

fn publish_manifest_audio(
    media_root: Option<&Path>,
    audio_path: &Path,
    manifest: &NarrationArtifact,
) -> Result<(), String> {
    let media_root = media_root.ok_or_else(|| {
        "narration media publication is unavailable: REMUX_MEDIA_DIR is not set".to_string()
    })?;
    let published_url = publish_file(
        media_root,
        audio_path,
        &manifest.audio.sha256,
        manifest.audio.size_bytes,
        &manifest.audio.mime_type,
    )?;
    if published_url != manifest.audio.url {
        return Err("narration media URL does not match its published content".to_string());
    }
    Ok(())
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let encoded = serde_json::to_vec(value)
        .map_err(|error| format!("failed to encode {}: {error}", path.display()))?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, encoded)
        .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
    fs::File::open(&temporary)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("failed to sync {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to publish {}: {error}", path.display()))
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
            Some((
                fs::metadata(entry.path().join("manifest.json"))
                    .ok()?
                    .modified()
                    .ok()?,
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
    let Ok(metadata) = fs::metadata(path) else {
        return 0;
    };
    if metadata.is_file() {
        return metadata.len();
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| directory_size(&entry.path()))
        .sum()
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
    use remux_tts::{NarrationBlock, OffsetEncoding};

    fn valid_document() -> NarrationDocument {
        NarrationDocument {
            schema_version: 1,
            offset_encoding: OffsetEncoding::Utf16CodeUnit,
            blocks: vec![NarrationBlock {
                id: "md:0".to_string(),
                kind: NarrationBlockKind::Paragraph,
                text: "A valid sentence.".to_string(),
                highlight_mode: HighlightMode::Text,
            }],
        }
    }

    #[test]
    fn source_document_contract_is_strict() {
        validate_document(&valid_document()).unwrap();
        let mut invalid = valid_document();
        invalid.blocks[0].highlight_mode = HighlightMode::Block;
        assert!(
            validate_document(&invalid)
                .unwrap_err()
                .contains("sourceSchemaInvalid")
        );
    }

    #[test]
    fn routed_params_remove_only_reserved_transport_fields() {
        let value: NarrationStartParams = decode_routed_params(
            json!({
                "_remuxOrigin": "viewer",
                "_remuxViewerKey": "codex",
                "document": valid_document(),
            }),
            "narration/start",
        )
        .unwrap();
        assert_eq!(value.document.schema_version, 1);
    }

    #[test]
    fn checked_in_v4_fixtures_match_the_strict_rust_contract() {
        let valid_document = include_str!("../schemas/fixtures/narration-document-v1.valid.json");
        let invalid_document =
            include_str!("../schemas/fixtures/narration-document-v1.invalid.json");
        let valid_artifact = include_str!("../schemas/fixtures/narration-artifact-v4.valid.json");
        let invalid_artifact =
            include_str!("../schemas/fixtures/narration-artifact-v4.invalid.json");
        assert!(serde_json::from_str::<NarrationDocument>(valid_document).is_ok());
        assert!(serde_json::from_str::<NarrationDocument>(invalid_document).is_err());
        assert!(serde_json::from_str::<NarrationArtifact>(valid_artifact).is_ok());
        assert!(serde_json::from_str::<NarrationArtifact>(invalid_artifact).is_err());
    }

    #[test]
    fn artifact_identity_is_independent_of_hash_map_iteration_order() {
        let first =
            resolve_synthesis_profile(Path::new("/tmp/remux-root"), Path::new("/tmp/codex-home"))
                .unwrap();
        let mut second = first.clone();
        let mut entries = second.model_assets.drain().collect::<Vec<_>>();
        entries.reverse();
        second.model_assets.extend(entries);
        let profile = narration_profile(&first).unwrap();
        assert_eq!(profile.word_segmenter_version, 2);
        assert_eq!(profile.pronunciation_reviewer.prompt_version, 4);
        assert_eq!(profile.pronunciation_reviewer.output_schema_version, 4);
        assert_eq!(profile.pronunciation_reviewer.window_planner_version, 3);
        assert_eq!(profile.pronunciation_reviewer.phone_alphabet_version, 1);
        assert_eq!(profile.structural_transcript.prompt_version, 2);
        assert_eq!(profile.structural_transcript.output_schema_version, 2);
        assert_eq!(
            profile.pronunciation_reviewer.kokoro_vocabulary_sha256,
            "sha256-5977eee9e44024553a1511cbc7f2c9320fbd4f6409228bcab0b5d26922260beb"
        );
        assert_eq!(
            artifact_key("sha256-document", &profile, &first).unwrap(),
            artifact_key("sha256-document", &profile, &second).unwrap(),
        );
    }
}
