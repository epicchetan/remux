mod alignment;
mod batch;
mod batch_artifact;
mod model;
mod pronunciation;
mod speech;
mod timing;

pub use alignment::{
    BaselineNarration, BaselineWord, DisplayUtf16, ReviewedNarration, SourceByte, SourceSentence,
    apply_pronunciation_plan, prepare_baseline, prepare_text_baseline,
    validate_structural_transcript_plan, word_fingerprint,
};

pub use batch::{
    BATCH_TASK_NAME, BATCH_TASK_VERSION, BatchDiagnostics, BatchSynthesisOutput,
    BatchSynthesisProgress, BatchSynthesisRequest, ChunkDiagnostic, HighlightMode,
    KokoroBatchSynthesis, NarrationArtifact, NarrationAudio, NarrationBlock, NarrationBlockKind,
    NarrationBlockTiming, NarrationDocument, NarrationProfile, NarrationSentence, NarrationWordCue,
    OffsetEncoding, PronunciationReviewerProfile, StructuralTranscriptProfile,
    narration_document_hash,
};
pub use batch_artifact::validate_batch_artifact;
pub use pronunciation::{
    AUDIT_WINDOW_PLANNER_VERSION, BaselinePhoneState, BaselineUnresolvedReason,
    DIRECT_PHONE_ALPHABET_VERSION, DIRECT_PHONE_VALIDATOR_VERSION,
    KOKORO_REVIEW_LEXICAL_ALPHABET_V1, KokoroVocabulary, MAX_DIRECT_PHONE_SYMBOLS,
    PRONUNCIATION_OUTPUT_SCHEMA_VERSION, PRONUNCIATION_PLAN_SCHEMA_VERSION,
    PRONUNCIATION_PROMPT_VERSION, PronunciationPatchKind, PronunciationWindowRecord,
    ReviewedPronunciationPatch, ReviewedPronunciationPlan, SourceWordFingerprint, SourceWordId,
    canonical_sha256, direct_phone_alphabet_sha256, sha256_prefixed,
    validate_direct_phone_alphabet, validate_direct_phone_string,
};
pub use speech::{
    STRUCTURAL_TRANSCRIPT_OUTPUT_SCHEMA_VERSION, STRUCTURAL_TRANSCRIPT_PLAN_SCHEMA_VERSION,
    STRUCTURAL_TRANSCRIPT_PROMPT_VERSION, STRUCTURAL_TRANSCRIPT_WINDOW_PLANNER_VERSION,
    StructuralTranscriptBlock, StructuralTranscriptPlan, StructuralTranscriptWindowRecord,
    empty_structural_transcript_plan, structural_transcript_input_hash,
    structural_transcript_plan_hash,
};
