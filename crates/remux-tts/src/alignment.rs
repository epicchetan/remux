use std::cmp::Ordering;
use std::sync::OnceLock;

use misaki_rs::{G2P, Language, MToken};
use regex::Regex;
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
use unicode_segmentation::UnicodeSegmentation;

use crate::batch::{
    HighlightMode, MAX_CHUNK_SYMBOLS, NarrationBlockKind, NarrationDocument,
    narration_document_hash,
};
use crate::pronunciation::{
    BaselinePhoneState, BaselineUnresolvedReason, KokoroVocabulary, PronunciationPatchKind,
    ReviewedPronunciationPlan, SourceWordFingerprint, SourceWordId, canonical_sha256,
    joined_symbol_count, normalize_phone_run, patch_map, sha256_prefixed,
    validate_direct_phone_string,
};
use crate::speech::StructuralTranscriptPlan;

const PREFERRED_CHUNK_SYMBOLS: usize = 360;
const MIN_NATURAL_CHUNK_SYMBOLS: usize = 300;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct SourceByte(usize);

impl SourceByte {
    pub fn value(self) -> usize {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct DisplayUtf16(usize);

impl DisplayUtf16 {
    pub fn value(self) -> usize {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AcousticRole {
    Lexical,
    SourcePunctuation,
    Separator,
    SyntheticProsody,
}

#[derive(Clone, Debug)]
pub(crate) struct AcousticSymbol {
    pub(crate) character: char,
    pub(crate) sentence: usize,
    pub(crate) word: Option<usize>,
    pub(crate) role: AcousticRole,
}

#[derive(Clone, Debug)]
pub struct BaselineWord {
    pub id: SourceWordId,
    pub block: usize,
    pub byte_start: SourceByte,
    pub byte_end: SourceByte,
    pub utf16_start: DisplayUtf16,
    pub utf16_end: DisplayUtf16,
    pub text: String,
    pub sentence: usize,
    pub tags: Vec<String>,
    pub baseline: BaselinePhoneState,
    phone_runs: Vec<String>,
    associated_tokens: usize,
    unresolved_reason: Option<BaselineUnresolvedReason>,
}

type SourceWord = BaselineWord;

#[derive(Clone, Debug)]
pub struct SourceSentence {
    pub id: String,
    pub block: usize,
    pub utf16_start: DisplayUtf16,
    pub utf16_end: DisplayUtf16,
    pub first_word: usize,
    pub last_word: usize,
}

#[derive(Clone, Debug)]
struct WordGroup {
    block: usize,
    sentence: usize,
    word: usize,
    separator: String,
    symbols: Vec<AcousticSymbol>,
    tags: Vec<String>,
    text: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ChunkPlan {
    pub(crate) boundary: &'static str,
    pub(crate) first_word: usize,
    pub(crate) last_word: usize,
    pub(crate) symbols: Vec<AcousticSymbol>,
    pub(crate) synthetic_prosody: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedNarration {
    pub(crate) chunks: Vec<ChunkPlan>,
    pub(crate) sentences: Vec<SourceSentence>,
    pub(crate) words: Vec<SourceWord>,
}

#[derive(Clone, Debug)]
pub struct BaselineNarration {
    pub document_hash: String,
    pub baseline_hash: String,
    pub block_ids: Vec<String>,
    pub sentences: Vec<SourceSentence>,
    pub words: Vec<BaselineWord>,
}

#[derive(Clone, Debug)]
pub struct ReviewedNarration {
    sentences: Vec<SourceSentence>,
    words: Vec<SourceWord>,
    pub initially_unresolved_words: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedSpeechNarration {
    pub(crate) prepared: PreparedNarration,
    pub(crate) initially_unresolved_words: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BoundaryKind {
    Final,
    Sentence,
    Block,
    MajorPunctuation,
    MinorPunctuation,
    PosClause,
    Emergency,
}

impl BoundaryKind {
    fn label(self) -> &'static str {
        match self {
            Self::Final => "final",
            Self::Sentence => "sentence",
            Self::Block => "block",
            Self::MajorPunctuation => "majorPunctuation",
            Self::MinorPunctuation => "minorPunctuation",
            Self::PosClause => "posClause",
            Self::Emergency => "emergency",
        }
    }

    fn penalty(self) -> u64 {
        match self {
            Self::Final => 0,
            Self::Sentence => 0,
            Self::Block => 5,
            Self::MajorPunctuation => 40,
            Self::MinorPunctuation => 80,
            Self::PosClause => 160,
            Self::Emergency => 2_000,
        }
    }
}

#[derive(Clone, Debug)]
struct NormalizedScalar {
    normalized_start: usize,
    normalized_end: usize,
    source_start: SourceByte,
    source_end: SourceByte,
}

#[derive(Clone, Debug)]
struct NormalizedBlock {
    text: String,
    scalars: Vec<NormalizedScalar>,
}

#[derive(Clone, Debug)]
struct AnchoredToken {
    source_start: SourceByte,
    source_end: SourceByte,
    text: String,
    tag: String,
    phones: String,
}

pub fn prepare_baseline(document: &NarrationDocument) -> Result<BaselineNarration, String> {
    prepare_baseline_filtered(document, |_| true, false)
}

pub fn prepare_text_baseline(document: &NarrationDocument) -> Result<BaselineNarration, String> {
    prepare_baseline_filtered(document, |kind| !kind.structural(), true)
}

fn prepare_baseline_filtered(
    document: &NarrationDocument,
    include: impl Fn(NarrationBlockKind) -> bool,
    allow_empty: bool,
) -> Result<BaselineNarration, String> {
    if document.schema_version != 1 {
        return Err("sourceSchemaInvalid: schemaVersion must be 1".to_string());
    }
    if document.blocks.is_empty() {
        return Err("documentHasNoSpeech: narration document has no blocks".to_string());
    }

    let g2p = G2P::new(Language::EnglishUS);
    let vocabulary = KokoroVocabulary::pinned();
    let mut words = Vec::new();
    let mut sentences = Vec::new();
    for (block_index, block) in document.blocks.iter().enumerate() {
        if !include(block.kind) {
            continue;
        }
        let first_word = words.len();
        let mut block_words = segment_source_words(&block.text, block_index)?;
        for (local_index, word) in block_words.iter_mut().enumerate() {
            word.id = SourceWordId(
                u32::try_from(first_word + local_index)
                    .map_err(|_| "sourceWordSegmentationInvalid: too many source words")?,
            );
        }
        if block_words.is_empty() {
            continue;
        }
        let normalized = normalize_block(&block.text);
        let (_, tokens) = g2p
            .g2p(&normalized.text)
            .map_err(|error| format!("misakiG2pFailed: block {}: {error}", block.id))?;
        let anchored = anchor_tokens(&block.id, &normalized, &tokens)?;
        assign_tokens_to_words(&block.id, &anchored, &mut block_words, &vocabulary)?;
        words.append(&mut block_words);
        let last_word = words.len();
        let block_sentences = construct_sentences(
            &block.id,
            &block.text,
            block.highlight_mode,
            first_word,
            &words[first_word..last_word],
            block_index,
        )?;
        for sentence in &block_sentences {
            for word in &mut words[sentence.first_word..=sentence.last_word] {
                word.sentence = sentences.len();
            }
            sentences.push(sentence.clone());
        }
    }
    if !allow_empty && (words.is_empty() || sentences.is_empty()) {
        return Err("documentHasNoSpeech: narration document has no speakable words".to_string());
    }
    if words.iter().any(|word| word.sentence == usize::MAX) {
        return Err("artifactAlignmentInvalid: a source word has no sentence".to_string());
    }

    let document_hash = narration_document_hash(document)?;
    let baseline_hash = baseline_hash(&document_hash, &words, &sentences)?;
    Ok(BaselineNarration {
        document_hash,
        baseline_hash,
        block_ids: document
            .blocks
            .iter()
            .map(|block| block.id.clone())
            .collect(),
        sentences,
        words,
    })
}

pub fn apply_pronunciation_plan(
    baseline: BaselineNarration,
    plan: &ReviewedPronunciationPlan,
    vocabulary: &KokoroVocabulary,
) -> Result<ReviewedNarration, String> {
    plan.validate_versions()?;
    if plan.kokoro_vocabulary_sha256 != vocabulary.sha256() {
        return Err("pronunciationPlanInvalid: Kokoro vocabulary hash mismatch".to_string());
    }
    if plan.document_hash != baseline.document_hash || plan.baseline_hash != baseline.baseline_hash
    {
        return Err("pronunciationBaselineDrift: plan does not match baseline".to_string());
    }
    let patches = patch_map(plan)?;
    if patches
        .keys()
        .any(|word_id| word_id.index() >= baseline.words.len())
    {
        return Err("pronunciationPlanInvalid: patch references an unknown word".to_string());
    }
    let initially_unresolved_words = baseline
        .words
        .iter()
        .filter(|word| !word.baseline.resolved())
        .count();
    let block_ids = baseline.block_ids;
    let mut words = baseline.words;
    for word in &mut words {
        let baseline_runs = word.baseline.phone_runs();
        let final_runs = if let Some(patch) = patches.get(&word.id) {
            let expected = word_fingerprint(word, &block_ids)?;
            if patch.target != expected {
                return Err(format!(
                    "pronunciationBaselineDrift: word {} fingerprint mismatch",
                    word.id.0
                ));
            }
            match &patch.correction {
                PronunciationPatchKind::DirectPhones { phones } => {
                    validate_direct_phone_string(phones, vocabulary)?
                }
            }
        } else if let BaselinePhoneState::Resolved { phone_runs } = &word.baseline {
            phone_runs.clone()
        } else {
            return Err(format!(
                "pronunciationUnresolved: source word {} {:?} was omitted",
                word.id.0, word.text
            ));
        };
        validate_final_phone_runs(word, &final_runs, vocabulary)?;
        if patches.contains_key(&word.id) && word.baseline.resolved() && final_runs == baseline_runs
        {
            return Err(format!(
                "pronunciationPatchNoEffect: source word {} {:?}",
                word.id.0, word.text
            ));
        }
        word.phone_runs = final_runs;
    }
    Ok(ReviewedNarration {
        sentences: baseline.sentences,
        words,
        initially_unresolved_words,
    })
}

pub fn validate_structural_transcript_plan(
    source: &NarrationDocument,
    plan: &StructuralTranscriptPlan,
) -> Result<NarrationDocument, String> {
    project_structural_speech(source, plan)
}

pub(crate) fn prepare_speech_narration(
    source: &NarrationDocument,
    structural_plan: &StructuralTranscriptPlan,
    pronunciation_plan: &ReviewedPronunciationPlan,
    vocabulary: &KokoroVocabulary,
) -> Result<PreparedSpeechNarration, String> {
    let speech_document = project_structural_speech(source, structural_plan)?;
    let baseline = prepare_baseline(&speech_document)?;
    for (block_index, block) in source.blocks.iter().enumerate() {
        if block.kind.structural() && !baseline.words.iter().any(|word| word.block == block_index) {
            return Err(format!(
                "structuralTranscriptInvalid: block {} has no speakable transcript word",
                block.id
            ));
        }
    }
    let initially_unresolved_words = baseline
        .words
        .iter()
        .filter(|word| !word.baseline.resolved())
        .count();
    let reviewed = apply_pronunciation_plan(baseline, pronunciation_plan, vocabulary)?;
    let prepared = plan_reviewed_narration(&speech_document, reviewed)?;
    Ok(PreparedSpeechNarration {
        prepared,
        initially_unresolved_words,
    })
}

fn project_structural_speech(
    source: &NarrationDocument,
    plan: &StructuralTranscriptPlan,
) -> Result<NarrationDocument, String> {
    plan.validate_versions()?;
    let source_hash = narration_document_hash(source)?;
    if plan.source_document_hash != source_hash {
        return Err(
            "structuralTranscriptBaselineDrift: plan does not match the source document"
                .to_string(),
        );
    }
    let expected = source
        .blocks
        .iter()
        .filter(|block| block.kind.structural())
        .map(|block| block.id.as_str())
        .collect::<Vec<_>>();
    let actual = plan
        .blocks
        .iter()
        .map(|block| block.block_id.as_str())
        .collect::<Vec<_>>();
    if actual != expected {
        return Err(
            "structuralTranscriptPlanInvalid: blocks do not exactly cover structural source blocks"
                .to_string(),
        );
    }

    let mut document = source.clone();
    let mut projected_bytes = 0usize;
    let mut projected_block = 0usize;
    for block in &mut document.blocks {
        if !block.kind.structural() {
            projected_bytes = projected_bytes.saturating_add(block.text.len());
            continue;
        }
        let planned = &plan.blocks[projected_block];
        projected_block += 1;
        if planned.transcript.trim().is_empty()
            || planned.transcript.contains('\0')
            || !planned.transcript.chars().any(char::is_alphanumeric)
        {
            return Err(format!(
                "structuralTranscriptInvalid: block {} has an empty or invalid transcript",
                block.id
            ));
        }
        projected_bytes = projected_bytes.saturating_add(planned.transcript.len());
        block.text.clone_from(&planned.transcript);
    }
    if projected_bytes > 256 * 1024 {
        return Err("structuralTranscriptTooLarge: projected speech exceeds 256 KiB".to_string());
    }

    Ok(document)
}

pub(crate) fn plan_reviewed_narration(
    document: &NarrationDocument,
    reviewed: ReviewedNarration,
) -> Result<PreparedNarration, String> {
    if reviewed.words.iter().any(|word| word.phone_runs.is_empty()) {
        return Err("pronunciationUnresolved: final word has no phones".to_string());
    }
    let groups = build_word_groups(document, &reviewed.words, &reviewed.sentences)?;
    let chunks = plan_chunks(document, &groups, &reviewed.sentences)?;
    Ok(PreparedNarration {
        chunks,
        sentences: reviewed.sentences,
        words: reviewed.words,
    })
}

pub fn word_fingerprint(
    word: &BaselineWord,
    block_ids: &[String],
) -> Result<SourceWordFingerprint, String> {
    Ok(SourceWordFingerprint {
        word_id: word.id,
        block_id: block_ids
            .get(word.block)
            .cloned()
            .ok_or_else(|| "pronunciationBaselineDrift: source block is missing".to_string())?,
        utf16_start: word.utf16_start.value(),
        utf16_end: word.utf16_end.value(),
        source_text_sha256: sha256_prefixed(word.text.as_bytes()),
        baseline_phones_sha256: sha256_prefixed(word.baseline.joined_phones().as_bytes()),
    })
}

fn baseline_hash(
    document_hash: &str,
    words: &[BaselineWord],
    sentences: &[SourceSentence],
) -> Result<String, String> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CanonicalWord<'a> {
        id: SourceWordId,
        block: usize,
        sentence: usize,
        byte_start: usize,
        byte_end: usize,
        utf16_start: usize,
        utf16_end: usize,
        text: &'a str,
        tags: &'a [String],
        baseline: &'a BaselinePhoneState,
    }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CanonicalSentence<'a> {
        id: &'a str,
        block: usize,
        utf16_start: usize,
        utf16_end: usize,
        first_word: usize,
        last_word: usize,
    }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CanonicalBaseline<'a> {
        document_hash: &'a str,
        words: Vec<CanonicalWord<'a>>,
        sentences: Vec<CanonicalSentence<'a>>,
    }
    canonical_sha256(&CanonicalBaseline {
        document_hash,
        words: words
            .iter()
            .map(|word| CanonicalWord {
                id: word.id,
                block: word.block,
                sentence: word.sentence,
                byte_start: word.byte_start.value(),
                byte_end: word.byte_end.value(),
                utf16_start: word.utf16_start.value(),
                utf16_end: word.utf16_end.value(),
                text: &word.text,
                tags: &word.tags,
                baseline: &word.baseline,
            })
            .collect(),
        sentences: sentences
            .iter()
            .map(|sentence| CanonicalSentence {
                id: &sentence.id,
                block: sentence.block,
                utf16_start: sentence.utf16_start.value(),
                utf16_end: sentence.utf16_end.value(),
                first_word: sentence.first_word,
                last_word: sentence.last_word,
            })
            .collect(),
    })
}

fn validate_final_phone_runs(
    word: &BaselineWord,
    runs: &[String],
    vocabulary: &KokoroVocabulary,
) -> Result<(), String> {
    if runs.is_empty() || joined_symbol_count(runs) > MAX_CHUNK_SYMBOLS {
        return Err(format!(
            "sourceWordTooLarge: source word {} {:?} has invalid final phones",
            word.id.0, word.text
        ));
    }
    for run in runs {
        if normalize_phone_run(run) != *run {
            return Err("pronunciationPlanInvalid: phones are not normalized".to_string());
        }
        vocabulary.validate(run)?;
    }
    Ok(())
}

#[cfg(test)]
fn prepare_document(document: &NarrationDocument) -> Result<PreparedNarration, String> {
    use crate::pronunciation::{
        AUDIT_WINDOW_PLANNER_VERSION, DIRECT_PHONE_ALPHABET_VERSION,
        DIRECT_PHONE_VALIDATOR_VERSION, PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
        PRONUNCIATION_PLAN_SCHEMA_VERSION, PRONUNCIATION_PROMPT_VERSION,
        direct_phone_alphabet_sha256,
    };

    let baseline = prepare_baseline(document)?;
    let plan = ReviewedPronunciationPlan {
        schema_version: PRONUNCIATION_PLAN_SCHEMA_VERSION,
        document_hash: baseline.document_hash.clone(),
        baseline_hash: baseline.baseline_hash.clone(),
        reviewer_profile_hash: "sha256-test".to_string(),
        prompt_version: PRONUNCIATION_PROMPT_VERSION,
        output_schema_version: PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
        window_planner_version: AUDIT_WINDOW_PLANNER_VERSION,
        phone_alphabet_version: DIRECT_PHONE_ALPHABET_VERSION,
        phone_alphabet_sha256: direct_phone_alphabet_sha256(),
        kokoro_vocabulary_sha256: KokoroVocabulary::pinned().sha256().to_string(),
        direct_phone_validator_version: DIRECT_PHONE_VALIDATOR_VERSION,
        windows: Vec::new(),
        patches: Vec::new(),
    };
    let reviewed = apply_pronunciation_plan(baseline, &plan, &KokoroVocabulary::pinned())?;
    plan_reviewed_narration(document, reviewed)
}

fn source_word_regex() -> &'static Regex {
    static WORDS: OnceLock<Regex> = OnceLock::new();
    WORDS.get_or_init(|| {
        Regex::new(
            r"(?xi)
              https?://[^\s<>()]+ |
              [\p{L}\p{N}._%+\-]+@[\p{L}\p{N}.\-]+\.[\p{L}]{2,} |
              (?:[+\-−]\p{Sc}?|\p{Sc}[+\-−]?)?\d+(?:[,.]\d+)*(?:%)? |
              [\p{L}\p{N}]+(?:['’._\-][\p{L}\p{N}]+)*
            ",
        )
        .expect("source-word regex must compile")
    })
}

fn segment_source_words(text: &str, block: usize) -> Result<Vec<SourceWord>, String> {
    let mut words = Vec::new();
    for found in source_word_regex().find_iter(text) {
        let byte_start = adjust_numeric_sign_start(text, found.start(), found.as_str());
        let mut byte_end = found.end();
        if text[byte_start..byte_end]
            .to_ascii_lowercase()
            .starts_with("http")
        {
            while byte_end > byte_start
                && text[..byte_end]
                    .chars()
                    .next_back()
                    .is_some_and(|character| {
                        matches!(
                            character,
                            '.' | ',' | '!' | '?' | ';' | ':' | ')' | ']' | '}' | '"' | '”' | '’'
                        )
                    })
            {
                byte_end -= text[..byte_end].chars().next_back().unwrap().len_utf8();
            }
        }
        if byte_end <= byte_start {
            continue;
        }
        let (byte_start, byte_end) = expand_to_grapheme_boundaries(text, byte_start, byte_end);
        if words
            .last()
            .is_some_and(|previous: &SourceWord| previous.byte_end > SourceByte(byte_start))
        {
            return Err("sourceWordSegmentationInvalid: source words overlap".to_string());
        }
        words.push(SourceWord {
            id: SourceWordId(u32::MAX),
            block,
            byte_start: SourceByte(byte_start),
            byte_end: SourceByte(byte_end),
            utf16_start: DisplayUtf16(text[..byte_start].encode_utf16().count()),
            utf16_end: DisplayUtf16(text[..byte_end].encode_utf16().count()),
            text: text[byte_start..byte_end].to_string(),
            sentence: usize::MAX,
            tags: Vec::new(),
            baseline: BaselinePhoneState::Unresolved {
                available_phone_runs: Vec::new(),
                reason: BaselineUnresolvedReason::MissingPhones,
            },
            phone_runs: Vec::new(),
            associated_tokens: 0,
            unresolved_reason: None,
        });
    }
    Ok(words)
}

fn adjust_numeric_sign_start(text: &str, start: usize, matched: &str) -> usize {
    let Some(sign) = matched
        .chars()
        .next()
        .filter(|character| matches!(*character, '+' | '-' | '−'))
    else {
        return start;
    };
    let sign_is_binary_or_repeated = text[..start].chars().next_back().is_some_and(|previous| {
        previous.is_alphanumeric() || matches!(previous, '%' | ')' | ']' | '}' | '+' | '-' | '−')
    });
    if sign_is_binary_or_repeated {
        start + sign.len_utf8()
    } else {
        start
    }
}

fn expand_to_grapheme_boundaries(text: &str, start: usize, end: usize) -> (usize, usize) {
    let mut expanded_start = start;
    let mut expanded_end = end;
    for (grapheme_start, grapheme) in text.grapheme_indices(true) {
        let grapheme_end = grapheme_start + grapheme.len();
        if grapheme_start <= start && start < grapheme_end {
            expanded_start = grapheme_start;
        }
        if grapheme_start < end && end <= grapheme_end {
            expanded_end = grapheme_end;
            break;
        }
    }
    (expanded_start, expanded_end)
}

fn normalize_block(source: &str) -> NormalizedBlock {
    let mut text = String::new();
    let mut scalars = Vec::new();
    for (source_start, grapheme) in source.grapheme_indices(true) {
        let source_end = source_start + grapheme.len();
        let normalized = grapheme
            .replace(['’', '‘'], "'")
            .nfkd()
            .filter(|character| !is_combining_mark(*character))
            .collect::<String>();
        for character in normalized.chars() {
            let normalized_start = text.len();
            text.push(character);
            scalars.push(NormalizedScalar {
                normalized_start,
                normalized_end: text.len(),
                source_start: SourceByte(source_start),
                source_end: SourceByte(source_end),
            });
        }
    }
    NormalizedBlock { text, scalars }
}

fn anchor_tokens(
    block_id: &str,
    normalized: &NormalizedBlock,
    tokens: &[MToken],
) -> Result<Vec<AnchoredToken>, String> {
    let mut cursor = 0usize;
    let mut output = Vec::with_capacity(tokens.len());
    for (index, token) in tokens.iter().enumerate() {
        cursor = skip_whitespace(&normalized.text, cursor);
        let end = cursor.saturating_add(token.text.len());
        if normalized.text.get(cursor..end) != Some(token.text.as_str()) {
            let excerpt_end = normalized.text.len().min(cursor.saturating_add(48));
            return Err(format!(
                "misakiTokenDrift: block {block_id} token {index} {:?} at {cursor}, source {:?}",
                token.text,
                &normalized.text[cursor..excerpt_end],
            ));
        }
        let (source_start, source_end) = project_normalized_range(normalized, cursor, end)
            .ok_or_else(|| {
                format!("normalizationMapInvalid: block {block_id} token {index} has no source")
            })?;
        output.push(AnchoredToken {
            source_start,
            source_end,
            text: token.text.clone(),
            tag: token.tag.clone(),
            phones: normalize_phones(token.phonemes.as_deref().unwrap_or_default()),
        });
        cursor = end;
    }
    cursor = skip_whitespace(&normalized.text, cursor);
    if cursor != normalized.text.len() {
        return Err(format!(
            "misakiTokenDrift: block {block_id} left unconsumed source at {cursor}"
        ));
    }
    Ok(output)
}

fn skip_whitespace(text: &str, mut cursor: usize) -> usize {
    while let Some(character) = text[cursor..].chars().next() {
        if !character.is_whitespace() {
            break;
        }
        cursor += character.len_utf8();
    }
    cursor
}

fn project_normalized_range(
    normalized: &NormalizedBlock,
    start: usize,
    end: usize,
) -> Option<(SourceByte, SourceByte)> {
    let mut matching = normalized
        .scalars
        .iter()
        .filter(|scalar| scalar.normalized_end > start && scalar.normalized_start < end);
    let first = matching.next()?;
    let mut source_end = first.source_end;
    for scalar in matching {
        source_end = scalar.source_end;
    }
    Some((first.source_start, source_end))
}

fn normalize_phones(value: &str) -> String {
    normalize_phone_run(value)
}

fn assign_tokens_to_words(
    block_id: &str,
    tokens: &[AnchoredToken],
    words: &mut [SourceWord],
    vocabulary: &KokoroVocabulary,
) -> Result<(), String> {
    for (token_index, token) in tokens.iter().enumerate() {
        if !token.text.chars().any(char::is_alphanumeric) {
            continue;
        }
        let owners = words
            .iter_mut()
            .filter(|word| {
                word.byte_start <= token.source_start && token.source_end <= word.byte_end
            })
            .collect::<Vec<_>>();
        if owners.len() != 1 {
            return Err(format!(
                "misakiTokenCrossesWords: block {block_id} token {token_index} {:?} maps to {} words",
                token.text,
                owners.len(),
            ));
        }
        let owner = owners.into_iter().next().unwrap();
        owner.associated_tokens += 1;
        owner.tags.push(token.tag.clone());
        if token.phones.is_empty() {
            owner
                .unresolved_reason
                .get_or_insert(BaselineUnresolvedReason::MissingPhones);
        } else {
            owner.phone_runs.push(token.phones.clone());
            if token.phones.contains('❓') {
                owner.unresolved_reason = Some(BaselineUnresolvedReason::UnresolvedMarker);
            } else if !vocabulary.supports(&token.phones) {
                owner.unresolved_reason = Some(BaselineUnresolvedReason::UnsupportedSymbol);
            }
        }
    }
    for word in words {
        if word.associated_tokens == 0 {
            return Err(format!(
                "misakiTokenAssociationMissing: block {block_id} word {:?}",
                word.text
            ));
        }
        word.baseline = if let Some(reason) = word.unresolved_reason {
            BaselinePhoneState::Unresolved {
                available_phone_runs: word.phone_runs.clone(),
                reason,
            }
        } else if word.phone_runs.is_empty() {
            BaselinePhoneState::Unresolved {
                available_phone_runs: Vec::new(),
                reason: BaselineUnresolvedReason::MissingPhones,
            }
        } else {
            BaselinePhoneState::Resolved {
                phone_runs: word.phone_runs.clone(),
            }
        };
    }
    Ok(())
}

fn construct_sentences(
    block_id: &str,
    text: &str,
    highlight_mode: HighlightMode,
    first_global_word: usize,
    words: &[SourceWord],
    block: usize,
) -> Result<Vec<SourceSentence>, String> {
    if words.is_empty() {
        return Ok(Vec::new());
    }
    if highlight_mode == HighlightMode::Block {
        let (byte_start, byte_end) = trim_byte_range(text, 0, text.len())
            .ok_or_else(|| "documentHasNoSpeech: block text is empty".to_string())?;
        return Ok(vec![SourceSentence {
            id: format!("{block_id}/sentence/0"),
            block,
            utf16_start: DisplayUtf16(text[..byte_start].encode_utf16().count()),
            utf16_end: DisplayUtf16(text[..byte_end].encode_utf16().count()),
            first_word: first_global_word,
            last_word: first_global_word + words.len() - 1,
        }]);
    }

    let mut output = Vec::new();
    let mut word_start = 0usize;
    let mut source_start = 0usize;
    for (segment_start, segment) in text.split_sentence_bound_indices() {
        let boundary = segment_start + segment.len();
        let word_end = words.partition_point(|word| word.byte_start < SourceByte(boundary));
        if word_end <= word_start || suppressed_sentence_break(text, words, word_end) {
            continue;
        }
        push_sentence(
            &mut output,
            block_id,
            block,
            first_global_word,
            text,
            source_start,
            boundary,
            word_start,
            word_end,
        )?;
        word_start = word_end;
        source_start = boundary;
    }
    if word_start < words.len() {
        push_sentence(
            &mut output,
            block_id,
            block,
            first_global_word,
            text,
            source_start,
            text.len(),
            word_start,
            words.len(),
        )?;
    }
    if output.is_empty() {
        return Err(format!(
            "artifactAlignmentInvalid: block {block_id} produced no sentence"
        ));
    }
    Ok(output)
}

#[allow(clippy::too_many_arguments)]
fn push_sentence(
    output: &mut Vec<SourceSentence>,
    block_id: &str,
    block: usize,
    first_global_word: usize,
    text: &str,
    source_start: usize,
    source_end: usize,
    word_start: usize,
    word_end: usize,
) -> Result<(), String> {
    let (byte_start, byte_end) = trim_byte_range(text, source_start, source_end)
        .ok_or_else(|| format!("artifactAlignmentInvalid: block {block_id} has empty sentence"))?;
    output.push(SourceSentence {
        id: format!("{block_id}/sentence/{}", output.len()),
        block,
        utf16_start: DisplayUtf16(text[..byte_start].encode_utf16().count()),
        utf16_end: DisplayUtf16(text[..byte_end].encode_utf16().count()),
        first_word: first_global_word + word_start,
        last_word: first_global_word + word_end - 1,
    });
    Ok(())
}

fn trim_byte_range(text: &str, start: usize, end: usize) -> Option<(usize, usize)> {
    let value = text.get(start..end)?;
    let leading = value.len() - value.trim_start_matches(char::is_whitespace).len();
    let trailing = value.trim_end_matches(char::is_whitespace).len();
    let trimmed_start = start + leading;
    let trimmed_end = start + trailing;
    (trimmed_start < trimmed_end).then_some((trimmed_start, trimmed_end))
}

fn suppressed_sentence_break(text: &str, words: &[SourceWord], word_end: usize) -> bool {
    if word_end == 0 || word_end >= words.len() {
        return false;
    }
    let previous = &words[word_end - 1];
    let next = &words[word_end];
    let separator = &text[previous.byte_end.value()..next.byte_start.value()];
    if !separator.contains('.') || separator.contains(['!', '?', '…']) {
        return false;
    }
    let key = previous.text.to_ascii_lowercase();
    let abbreviation = matches!(
        key.as_str(),
        "dr" | "e.g"
            | "eq"
            | "etc"
            | "fig"
            | "i.e"
            | "jr"
            | "mr"
            | "mrs"
            | "ms"
            | "no"
            | "prof"
            | "sr"
            | "st"
            | "vs"
    ) || (key.chars().count() == 1 && key.chars().all(char::is_alphabetic));
    let dotted_number = key.contains('.')
        && key.chars().any(|character| character.is_ascii_digit())
        && key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '.');
    abbreviation || dotted_number || next.text.chars().next().is_some_and(char::is_lowercase)
}

fn build_word_groups(
    document: &NarrationDocument,
    words: &[SourceWord],
    sentences: &[SourceSentence],
) -> Result<Vec<WordGroup>, String> {
    let mut groups = Vec::with_capacity(words.len());
    for (word_index, word) in words.iter().enumerate() {
        let sentence = sentences
            .get(word.sentence)
            .ok_or_else(|| "artifactAlignmentInvalid: source word sentence missing".to_string())?;
        let mut symbols = Vec::new();
        for (run_index, run) in word.phone_runs.iter().enumerate() {
            if run_index > 0 {
                push_symbol(
                    &mut symbols,
                    ' ',
                    word.sentence,
                    None,
                    AcousticRole::Separator,
                );
            }
            for character in run.chars() {
                if character.is_whitespace() {
                    push_symbol(
                        &mut symbols,
                        ' ',
                        word.sentence,
                        None,
                        AcousticRole::Separator,
                    );
                } else {
                    push_symbol(
                        &mut symbols,
                        character,
                        word.sentence,
                        Some(word_index),
                        AcousticRole::Lexical,
                    );
                }
            }
        }
        if symbols.iter().all(|symbol| symbol.word.is_none()) {
            return Err(format!("sourceWordUnvoiced: word {:?}", word.text));
        }

        let block_text = &document.blocks[word.block].text;
        let (separator_end, is_sentence_end) = if word_index == sentence.last_word {
            let byte_end = utf16_to_byte(block_text, sentence.utf16_end).ok_or_else(|| {
                "artifactAlignmentInvalid: sentence UTF-16 end is invalid".to_string()
            })?;
            (byte_end, true)
        } else {
            (words[word_index + 1].byte_start, false)
        };
        let separator = block_text[word.byte_end.value()..separator_end.value()].to_string();
        let mut punctuation = separator
            .chars()
            .filter_map(normalize_prosody_punctuation)
            .collect::<Vec<_>>();
        if is_sentence_end && punctuation.is_empty() {
            punctuation.push('.');
        }
        for character in punctuation {
            push_symbol(
                &mut symbols,
                character,
                word.sentence,
                None,
                if separator
                    .chars()
                    .any(|source| normalize_prosody_punctuation(source) == Some(character))
                {
                    AcousticRole::SourcePunctuation
                } else {
                    AcousticRole::SyntheticProsody
                },
            );
        }
        if symbols.len() > MAX_CHUNK_SYMBOLS {
            return Err(format!(
                "sourceWordTooLarge: block {} word {:?} has {} symbols",
                document.blocks[word.block].id,
                word.text,
                symbols.len()
            ));
        }
        groups.push(WordGroup {
            block: word.block,
            sentence: word.sentence,
            word: word_index,
            separator,
            symbols,
            tags: word.tags.clone(),
            text: word.text.clone(),
        });
    }
    Ok(groups)
}

fn push_symbol(
    symbols: &mut Vec<AcousticSymbol>,
    character: char,
    sentence: usize,
    word: Option<usize>,
    role: AcousticRole,
) {
    if character == ' ' && symbols.last().is_some_and(|symbol| symbol.character == ' ') {
        return;
    }
    symbols.push(AcousticSymbol {
        character,
        sentence,
        word,
        role,
    });
}

fn normalize_prosody_punctuation(character: char) -> Option<char> {
    match character {
        ';' | ':' | ',' | '.' | '!' | '?' | '—' | '…' => Some(character),
        '–' => Some('—'),
        _ => None,
    }
}

fn utf16_to_byte(text: &str, wanted: DisplayUtf16) -> Option<SourceByte> {
    if wanted.value() == 0 {
        return Some(SourceByte(0));
    }
    let mut utf16 = 0usize;
    for (byte, character) in text.char_indices() {
        if utf16 == wanted.value() {
            return Some(SourceByte(byte));
        }
        utf16 += character.len_utf16();
    }
    (utf16 == wanted.value()).then_some(SourceByte(text.len()))
}

fn plan_chunks(
    document: &NarrationDocument,
    groups: &[WordGroup],
    sentences: &[SourceSentence],
) -> Result<Vec<ChunkPlan>, String> {
    if groups.is_empty() {
        return Err("acousticPlanInvalid: no word groups".to_string());
    }
    let sentence_counts = sentences
        .iter()
        .map(|sentence| range_symbol_count(groups, sentence.first_word, sentence.last_word, false))
        .collect::<Vec<_>>();
    let count = groups.len();
    let mut costs = vec![u64::MAX; count + 1];
    let mut previous = vec![None::<(usize, BoundaryKind)>; count + 1];
    costs[0] = 0;

    for start in 0..count {
        if costs[start] == u64::MAX {
            continue;
        }
        for end in start..count {
            if crosses_mandatory_boundary(document, groups, start, end) {
                break;
            }
            let Some(kind) = boundary_kind(groups, &sentence_counts, end) else {
                continue;
            };
            let synthetic = kind == BoundaryKind::Emergency;
            let symbols = range_symbol_count(groups, start, end, synthetic);
            if symbols > MAX_CHUNK_SYMBOLS {
                break;
            }
            let length_delta = symbols.abs_diff(PREFERRED_CHUNK_SYMBOLS) as u64;
            let mut edge_cost = kind.penalty() + length_delta * length_delta / 32;
            if kind == BoundaryKind::Emergency && protected_pair(&groups[end], &groups[end + 1]) {
                edge_cost += 10_000;
            }
            if symbols < MIN_NATURAL_CHUNK_SYMBOLS && end + 1 < count {
                edge_cost += (MIN_NATURAL_CHUNK_SYMBOLS - symbols) as u64 * 8;
            }
            if groups[start].sentence == groups[end].sentence
                && start != sentences[groups[start].sentence].first_word
            {
                edge_cost += 40;
            }
            let candidate = costs[start].saturating_add(edge_cost);
            let destination = end + 1;
            let replace = candidate < costs[destination]
                || (candidate == costs[destination]
                    && previous[destination].is_none_or(|(old_start, old_kind)| {
                        kind.penalty().cmp(&old_kind.penalty()) == Ordering::Less
                            || (kind == old_kind && start < old_start)
                    }));
            if replace {
                costs[destination] = candidate;
                previous[destination] = Some((start, kind));
            }
        }
    }
    if previous[count].is_none() {
        return Err("acousticPlanInvalid: no plan satisfies the 450-symbol limit".to_string());
    }

    let mut ranges = Vec::new();
    let mut cursor = count;
    while cursor > 0 {
        let (start, kind) = previous[cursor]
            .ok_or_else(|| "acousticPlanInvalid: planner predecessor missing".to_string())?;
        ranges.push((start, cursor - 1, kind));
        cursor = start;
    }
    ranges.reverse();

    let mut chunks = Vec::with_capacity(ranges.len());
    for (start, end, kind) in ranges {
        let synthetic = kind == BoundaryKind::Emergency;
        let mut symbols = Vec::new();
        for (index, group) in groups.iter().enumerate().take(end + 1).skip(start) {
            symbols.extend(group.symbols.iter().cloned());
            if index < end {
                push_symbol(
                    &mut symbols,
                    ' ',
                    group.sentence,
                    None,
                    AcousticRole::Separator,
                );
            }
        }
        if synthetic {
            push_symbol(
                &mut symbols,
                ',',
                groups[end].sentence,
                None,
                AcousticRole::SyntheticProsody,
            );
        }
        if symbols.is_empty() || symbols.len() > MAX_CHUNK_SYMBOLS {
            return Err("acousticPlanInvalid: planned chunk size is invalid".to_string());
        }
        chunks.push(ChunkPlan {
            boundary: kind.label(),
            first_word: groups[start].word,
            last_word: groups[end].word,
            symbols,
            synthetic_prosody: synthetic,
        });
    }
    Ok(chunks)
}

fn range_symbol_count(groups: &[WordGroup], start: usize, end: usize, synthetic: bool) -> usize {
    groups[start..=end]
        .iter()
        .map(|group| group.symbols.len())
        .sum::<usize>()
        + end.saturating_sub(start)
        + usize::from(synthetic)
}

fn crosses_mandatory_boundary(
    document: &NarrationDocument,
    groups: &[WordGroup],
    start: usize,
    end: usize,
) -> bool {
    (start..end).any(|index| {
        let left = &groups[index];
        let right = &groups[index + 1];
        left.block != right.block
            && (document.blocks[left.block].kind.structural()
                || document.blocks[right.block].kind.structural())
    })
}

fn boundary_kind(
    groups: &[WordGroup],
    sentence_counts: &[usize],
    end: usize,
) -> Option<BoundaryKind> {
    if end + 1 == groups.len() {
        return Some(BoundaryKind::Final);
    }
    let left = &groups[end];
    let right = &groups[end + 1];
    if left.sentence != right.sentence {
        return Some(BoundaryKind::Sentence);
    }
    if left.block != right.block {
        return Some(BoundaryKind::Block);
    }
    if sentence_counts[left.sentence] <= MAX_CHUNK_SYMBOLS {
        return None;
    }
    if left.separator.contains([';', ':']) {
        return Some(BoundaryKind::MajorPunctuation);
    }
    if left.separator.contains([',', '—', '–']) {
        return Some(BoundaryKind::MinorPunctuation);
    }
    if !protected_pair(left, right) && pos_clause_boundary(groups, end) {
        return Some(BoundaryKind::PosClause);
    }
    Some(BoundaryKind::Emergency)
}

fn protected_pair(left: &WordGroup, right: &WordGroup) -> bool {
    let left_tag = left.tags.last().map(String::as_str).unwrap_or("");
    let right_tag = right.tags.first().map(String::as_str).unwrap_or("");
    let left_lower = left.text.to_ascii_lowercase();
    let right_lower = right.text.to_ascii_lowercase();
    (matches!(left_tag, "DT" | "PDT" | "WDT")
        && (right_tag.starts_with("JJ") || right_tag.starts_with("NN")))
        || (left_tag.starts_with("JJ") && right_tag.starts_with("NN"))
        || (left_tag == "MD" && right_tag.starts_with("VB"))
        || ([
            "am", "are", "be", "been", "being", "did", "do", "does", "had", "has", "have", "is",
            "was", "were", "will",
        ]
        .contains(&left_lower.as_str())
            && (right_tag.starts_with("VB") || right_tag == "RB"))
        || ((left_lower == "not" || left_lower == "n't") && right_tag.starts_with("VB"))
        || (left_tag == "TO" && right_tag.starts_with("VB"))
        || (left_tag == "POS" && right_tag.starts_with("NN"))
        || (left_tag.starts_with("NNP") && right_tag.starts_with("NNP"))
        || (left_tag == "CD" && right_tag.starts_with("NN"))
        || (left_tag == "IN"
            && (matches!(right_tag, "DT" | "PRP" | "CD")
                || right_tag.starts_with("JJ")
                || right_tag.starts_with("NN")))
        || (left_lower.chars().all(char::is_numeric)
            && matches!(
                right_lower.as_str(),
                "ms" | "s" | "sec" | "seconds" | "hz" | "khz" | "mb" | "gb" | "px"
            ))
}

fn pos_clause_boundary(groups: &[WordGroup], end: usize) -> bool {
    let next = &groups[end + 1];
    let lower = next.text.to_ascii_lowercase();
    if !matches!(
        lower.as_str(),
        "although"
            | "and"
            | "as"
            | "because"
            | "but"
            | "however"
            | "if"
            | "nor"
            | "or"
            | "since"
            | "so"
            | "though"
            | "unless"
            | "until"
            | "when"
            | "where"
            | "whereas"
            | "which"
            | "while"
            | "who"
            | "yet"
    ) {
        return false;
    }
    let tag = next.tags.first().map(String::as_str).unwrap_or("");
    if !matches!(tag, "CC" | "IN" | "RB" | "WDT" | "WP" | "WRB") {
        return false;
    }
    let sentence = groups[end].sentence;
    let left_start = (0..=end)
        .rev()
        .take_while(|index| groups[*index].sentence == sentence)
        .take(8)
        .last()
        .unwrap_or(end);
    let right_end = ((end + 1)..groups.len())
        .take_while(|index| groups[*index].sentence == sentence)
        .take(8)
        .last()
        .unwrap_or(end + 1);
    has_verb(&groups[left_start..=end]) && has_verb(&groups[end + 1..=right_end])
}

fn has_verb(groups: &[WordGroup]) -> bool {
    groups.iter().any(|group| {
        group
            .tags
            .iter()
            .any(|tag| tag == "MD" || tag.starts_with("VB"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::batch::{HighlightMode, NarrationBlock, NarrationBlockKind, OffsetEncoding};
    use crate::pronunciation::{PronunciationWindowRecord, ReviewedPronunciationPatch};
    use crate::speech::{
        STRUCTURAL_TRANSCRIPT_OUTPUT_SCHEMA_VERSION, STRUCTURAL_TRANSCRIPT_PLAN_SCHEMA_VERSION,
        STRUCTURAL_TRANSCRIPT_PROMPT_VERSION, STRUCTURAL_TRANSCRIPT_WINDOW_PLANNER_VERSION,
        StructuralTranscriptBlock, StructuralTranscriptPlan,
    };

    fn document(text: &str) -> NarrationDocument {
        NarrationDocument {
            schema_version: 1,
            offset_encoding: OffsetEncoding::Utf16CodeUnit,
            blocks: vec![NarrationBlock {
                id: "md:0".to_string(),
                kind: NarrationBlockKind::Paragraph,
                text: text.to_string(),
                highlight_mode: HighlightMode::Text,
            }],
        }
    }

    fn empty_audit_plan(document: &NarrationDocument) -> ReviewedPronunciationPlan {
        let baseline = prepare_baseline(document).unwrap();
        ReviewedPronunciationPlan {
            schema_version: crate::pronunciation::PRONUNCIATION_PLAN_SCHEMA_VERSION,
            document_hash: baseline.document_hash.clone(),
            baseline_hash: baseline.baseline_hash.clone(),
            reviewer_profile_hash: "sha256-test".to_string(),
            prompt_version: crate::pronunciation::PRONUNCIATION_PROMPT_VERSION,
            output_schema_version: crate::pronunciation::PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
            window_planner_version: crate::pronunciation::AUDIT_WINDOW_PLANNER_VERSION,
            phone_alphabet_version: crate::pronunciation::DIRECT_PHONE_ALPHABET_VERSION,
            phone_alphabet_sha256: crate::pronunciation::direct_phone_alphabet_sha256(),
            kokoro_vocabulary_sha256: KokoroVocabulary::pinned().sha256().to_string(),
            direct_phone_validator_version: crate::pronunciation::DIRECT_PHONE_VALIDATOR_VERSION,
            windows: Vec::new(),
            patches: Vec::new(),
        }
    }

    fn structural_plan(document: &NarrationDocument, transcript: &str) -> StructuralTranscriptPlan {
        StructuralTranscriptPlan {
            schema_version: STRUCTURAL_TRANSCRIPT_PLAN_SCHEMA_VERSION,
            source_document_hash: narration_document_hash(document).unwrap(),
            generator_profile_hash: "sha256-test".to_string(),
            prompt_version: STRUCTURAL_TRANSCRIPT_PROMPT_VERSION,
            output_schema_version: STRUCTURAL_TRANSCRIPT_OUTPUT_SCHEMA_VERSION,
            window_planner_version: STRUCTURAL_TRANSCRIPT_WINDOW_PLANNER_VERSION,
            windows: Vec::new(),
            blocks: vec![StructuralTranscriptBlock {
                block_id: "md:1".to_string(),
                transcript: transcript.to_string(),
            }],
        }
    }

    #[test]
    fn generated_structural_words_are_reviewed_after_misaki() {
        let source = NarrationDocument {
            schema_version: 1,
            offset_encoding: OffsetEncoding::Utf16CodeUnit,
            blocks: vec![
                NarrationBlock {
                    id: "md:0".to_string(),
                    kind: NarrationBlockKind::Paragraph,
                    text: "A simple sentence.".to_string(),
                    highlight_mode: HighlightMode::Text,
                },
                NarrationBlock {
                    id: "md:1".to_string(),
                    kind: NarrationBlockKind::Code,
                    text: "rewrite(response);".to_string(),
                    highlight_mode: HighlightMode::Block,
                },
            ],
        };
        let plan = structural_plan(&source, "The response was rewritten.");
        let speech_document = validate_structural_transcript_plan(&source, &plan).unwrap();
        let baseline = prepare_baseline(&speech_document).unwrap();
        let rewritten = baseline
            .words
            .iter()
            .find(|word| word.text == "rewritten")
            .unwrap();
        assert!(!rewritten.baseline.resolved());
        assert!(rewritten.baseline.joined_phones().contains('\u{0329}'));
        let patch = ReviewedPronunciationPatch::new(
            0,
            word_fingerprint(rewritten, &baseline.block_ids).unwrap(),
            PronunciationPatchKind::DirectPhones {
                phones: "ɹiɹˈɪʔn".to_string(),
            },
        )
        .unwrap();
        let mut audit_plan = empty_audit_plan(&speech_document);
        audit_plan.windows.push(PronunciationWindowRecord {
            window_id: 0,
            input_sha256: "sha256-input".to_string(),
            output_sha256: "sha256-output".to_string(),
        });
        audit_plan.patches.push(patch);
        let prepared =
            prepare_speech_narration(&source, &plan, &audit_plan, &KokoroVocabulary::pinned())
                .unwrap();
        let rewritten = prepared
            .prepared
            .words
            .iter()
            .find(|word| word.text == "rewritten")
            .unwrap();
        assert_eq!(rewritten.phone_runs, vec!["ɹiɹˈɪʔn".to_string()]);
        let structural_sentences = prepared
            .prepared
            .sentences
            .iter()
            .filter(|sentence| sentence.block == 1)
            .collect::<Vec<_>>();
        assert_eq!(structural_sentences.len(), 1);
    }

    #[test]
    fn structural_transcript_must_contain_speakable_text() {
        let source = NarrationDocument {
            schema_version: 1,
            offset_encoding: OffsetEncoding::Utf16CodeUnit,
            blocks: vec![
                NarrationBlock {
                    id: "md:0".to_string(),
                    kind: NarrationBlockKind::Paragraph,
                    text: "A simple sentence.".to_string(),
                    highlight_mode: HighlightMode::Text,
                },
                NarrationBlock {
                    id: "md:1".to_string(),
                    kind: NarrationBlockKind::Code,
                    text: "foo();".to_string(),
                    highlight_mode: HighlightMode::Block,
                },
            ],
        };
        let plan = structural_plan(&source, "...");
        let error = validate_structural_transcript_plan(&source, &plan).unwrap_err();
        assert!(error.contains("empty or invalid transcript"));
    }

    #[test]
    fn source_words_are_user_visible_units() {
        let words = segment_source_words(
            "don't state-of-the-art foo_bar live_transcript.rs v2.1 $10,000.50 42% \"https://example.com/api.\"",
            0,
        )
        .unwrap();
        assert_eq!(
            words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>(),
            [
                "don't",
                "state-of-the-art",
                "foo_bar",
                "live_transcript.rs",
                "v2.1",
                "$10,000.50",
                "42%",
                "https://example.com/api",
            ]
        );
    }

    #[test]
    fn signed_numbers_are_one_source_word_without_absorbing_range_separators() {
        let words =
            segment_source_words("-32000 +42 −3.14 -$32,000.50 $-12.25 10-20 --32000", 0).unwrap();
        assert_eq!(
            words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>(),
            [
                "-32000",
                "+42",
                "−3.14",
                "-$32,000.50",
                "$-12.25",
                "10",
                "20",
                "32000",
            ]
        );
    }

    #[test]
    fn signed_number_misaki_tokens_stay_inside_their_source_words() {
        let g2p = G2P::new(Language::EnglishUS);
        let cases = [
            ("-32000", vec!["-32000"]),
            ("+42", vec!["+", "42"]),
            ("−3.14", vec!["−", "3.14"]),
            ("-$32,000.50", vec!["-", "$", "32,000.50"]),
            ("$-12.25", vec!["$", "-", "12.25"]),
            ("10-20", vec!["10", "-", "20"]),
        ];
        for (source, expected_tokens) in cases {
            assert_eq!(
                g2p.tokenize(source)
                    .iter()
                    .map(|token| token.text.as_str())
                    .collect::<Vec<_>>(),
                expected_tokens,
                "unexpected Misaki tokenization for {source:?}",
            );
            let baseline = prepare_baseline(&document(source)).unwrap();
            assert!(
                baseline.words.iter().all(|word| word.associated_tokens > 0),
                "signed numeric source word was left unowned for {source:?}",
            );
        }
    }

    #[test]
    fn normalization_projects_smart_apostrophes_and_accents() {
        let source = "Café don’t";
        let normalized = normalize_block(source);
        assert_eq!(normalized.text, "Cafe don't");
        let cafe = project_normalized_range(&normalized, 0, 4).unwrap();
        assert_eq!(&source[cafe.0.value()..cafe.1.value()], "Café");
        let prepared = prepare_document(&document("Café don’t change.")).unwrap();
        assert_eq!(prepared.words[1].text, "don’t");
        assert!(!prepared.words[1].phone_runs.is_empty());
    }

    #[test]
    fn source_word_offsets_use_utf16_code_units() {
        let words = segment_source_words("👩‍💻 Café", 0).unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "Café");
        assert_eq!(words[0].utf16_start.value(), 6);
        assert_eq!(words[0].utf16_end.value(), 10);
    }

    #[test]
    fn contextual_alignment_survives_unicode_normalization_and_repetition() {
        let prepared = prepare_document(&document("👩‍💻 Café cafe\u{301} ﬁle file.")).unwrap();
        assert_eq!(
            prepared
                .words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>(),
            ["Café", "cafe\u{301}", "ﬁle", "file"]
        );
        assert_eq!(prepared.words[0].utf16_start.value(), 6);
        assert_eq!(prepared.words[0].utf16_end.value(), 10);
        assert!(
            prepared
                .words
                .windows(2)
                .all(|pair| pair[0].byte_end <= pair[1].byte_start)
        );
        assert!(
            prepared
                .words
                .iter()
                .all(|word| !word.phone_runs.is_empty())
        );
    }

    #[test]
    fn contextual_tokens_group_under_source_words() {
        let prepared = prepare_document(&document("I don't read the same record twice.")).unwrap();
        assert_eq!(
            prepared
                .words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>(),
            ["I", "don't", "read", "the", "same", "record", "twice"]
        );
        assert!(
            prepared
                .words
                .iter()
                .all(|word| !word.phone_runs.is_empty())
        );
        assert_eq!(prepared.sentences.len(), 1);
        assert_eq!(prepared.chunks.len(), 1);
    }

    #[test]
    fn abbreviations_do_not_split_sentences() {
        let prepared = prepare_document(&document(
            "Dr. Smith explains v2.1 clearly. Next step works.",
        ))
        .unwrap();
        assert_eq!(prepared.sentences.len(), 2);
    }

    #[test]
    fn technical_prose_keeps_exact_source_word_ownership() {
        let prepared = prepare_document(&document(
            "Use misaki-rs with Kokoro v2.1 at https://example.com/api. The live_transcript.rs path costs $10.50 for 42% more HTTP coverage.",
        ))
        .unwrap();
        assert!(prepared.words.iter().any(|word| word.text == "misaki-rs"));
        assert!(prepared.words.iter().any(|word| word.text == "v2.1"));
        assert!(
            prepared
                .words
                .iter()
                .any(|word| word.text == "https://example.com/api")
        );
        assert!(
            prepared
                .words
                .iter()
                .any(|word| word.text == "live_transcript.rs")
        );
        assert!(prepared.words.iter().any(|word| word.text == "$10.50"));
        assert!(prepared.words.iter().any(|word| word.text == "42%"));
        assert!(
            prepared
                .words
                .iter()
                .all(|word| !word.phone_runs.is_empty())
        );
    }

    #[test]
    fn oversized_sentence_splits_only_between_words() {
        let text = (0..80)
            .map(|index| format!("the careful narrator explains section {index} because the listener needs context"))
            .collect::<Vec<_>>()
            .join(", ")
            + ".";
        let prepared = prepare_document(&document(&text)).unwrap();
        assert_eq!(prepared.sentences.len(), 1);
        assert!(prepared.chunks.len() > 1);
        assert!(prepared.chunks.iter().all(|chunk| {
            !chunk.symbols.is_empty() && chunk.symbols.len() <= MAX_CHUNK_SYMBOLS
        }));
        assert_eq!(prepared.chunks.first().unwrap().first_word, 0);
        assert_eq!(
            prepared.chunks.last().unwrap().last_word,
            prepared.words.len() - 1
        );
        assert!(
            prepared
                .chunks
                .windows(2)
                .all(|pair| { pair[0].last_word + 1 == pair[1].first_word })
        );
    }

    #[test]
    fn structural_blocks_keep_one_block_owned_sentence() {
        let document = NarrationDocument {
            schema_version: 1,
            offset_encoding: OffsetEncoding::Utf16CodeUnit,
            blocks: vec![
                NarrationBlock {
                    id: "md:0".to_string(),
                    kind: NarrationBlockKind::Paragraph,
                    text: "The implementation returns a typed result.".to_string(),
                    highlight_mode: HighlightMode::Text,
                },
                NarrationBlock {
                    id: "md:1".to_string(),
                    kind: NarrationBlockKind::Code,
                    text: "const value: Result<T, E> = parse(input)?;".to_string(),
                    highlight_mode: HighlightMode::Block,
                },
                NarrationBlock {
                    id: "md:2".to_string(),
                    kind: NarrationBlockKind::Table,
                    text: "Name | Price\nStarter | $5".to_string(),
                    highlight_mode: HighlightMode::Block,
                },
            ],
        };
        let prepared = prepare_document(&document).unwrap();
        let structural = prepared
            .sentences
            .iter()
            .filter(|sentence| sentence.block > 0)
            .collect::<Vec<_>>();
        assert_eq!(structural.len(), 2);
        assert_eq!(structural[0].id, "md:1/sentence/0");
        assert_eq!(structural[1].id, "md:2/sentence/0");
        assert!(prepared.chunks.iter().all(|chunk| {
            let first_block = prepared.words[chunk.first_word].block;
            let last_block = prepared.words[chunk.last_word].block;
            (first_block == 0 && last_block == 0) || first_block == last_block
        }));
    }

    #[test]
    fn sparse_direct_phones_preserve_source_word_ownership() {
        use crate::pronunciation::{
            AUDIT_WINDOW_PLANNER_VERSION, DIRECT_PHONE_ALPHABET_VERSION,
            DIRECT_PHONE_VALIDATOR_VERSION, PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
            PRONUNCIATION_PLAN_SCHEMA_VERSION, PRONUNCIATION_PROMPT_VERSION,
            PronunciationPatchKind, PronunciationWindowRecord, ReviewedPronunciationPatch,
            direct_phone_alphabet_sha256,
        };

        let source = document("Sol parses HTMLAudioElement.");
        let baseline = prepare_baseline(&source).unwrap();
        let vocabulary = KokoroVocabulary::pinned();
        let sol = baseline
            .words
            .iter()
            .find(|word| word.text == "Sol")
            .unwrap();
        let html = baseline
            .words
            .iter()
            .find(|word| word.text == "HTMLAudioElement")
            .unwrap();
        let patches = vec![
            ReviewedPronunciationPatch::new(
                0,
                word_fingerprint(sol, &baseline.block_ids).unwrap(),
                PronunciationPatchKind::DirectPhones {
                    phones: "sˈoʊl".to_string(),
                },
            )
            .unwrap(),
            ReviewedPronunciationPatch::new(
                0,
                word_fingerprint(html, &baseline.block_ids).unwrap(),
                PronunciationPatchKind::DirectPhones {
                    phones: "ˌeɪtʃ tˌiː ˌɛm ˈɛl ˈɔːdioʊ ˈɛləmənt".to_string(),
                },
            )
            .unwrap(),
        ];
        let plan = ReviewedPronunciationPlan {
            schema_version: PRONUNCIATION_PLAN_SCHEMA_VERSION,
            document_hash: baseline.document_hash.clone(),
            baseline_hash: baseline.baseline_hash.clone(),
            reviewer_profile_hash: "sha256-test".to_string(),
            prompt_version: PRONUNCIATION_PROMPT_VERSION,
            output_schema_version: PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
            window_planner_version: AUDIT_WINDOW_PLANNER_VERSION,
            phone_alphabet_version: DIRECT_PHONE_ALPHABET_VERSION,
            phone_alphabet_sha256: direct_phone_alphabet_sha256(),
            kokoro_vocabulary_sha256: vocabulary.sha256().to_string(),
            direct_phone_validator_version: DIRECT_PHONE_VALIDATOR_VERSION,
            windows: vec![PronunciationWindowRecord {
                window_id: 0,
                input_sha256: "sha256-input".to_string(),
                output_sha256: "sha256-output".to_string(),
            }],
            patches,
        };
        let reviewed = apply_pronunciation_plan(baseline, &plan, &vocabulary).unwrap();
        let prepared = plan_reviewed_narration(&source, reviewed).unwrap();
        assert_eq!(prepared.words.len(), 3);
        let html_index = prepared
            .words
            .iter()
            .position(|word| word.text == "HTMLAudioElement")
            .unwrap();
        let html_symbols = prepared
            .chunks
            .iter()
            .flat_map(|chunk| &chunk.symbols)
            .filter(|symbol| symbol.word == Some(html_index))
            .count();
        assert!(html_symbols > prepared.words[html_index].text.chars().count());
    }

    #[test]
    fn worker_rejects_a_persisted_resolved_baseline_no_effect_patch() {
        use crate::pronunciation::{
            AUDIT_WINDOW_PLANNER_VERSION, DIRECT_PHONE_ALPHABET_VERSION,
            DIRECT_PHONE_VALIDATOR_VERSION, PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
            PRONUNCIATION_PLAN_SCHEMA_VERSION, PRONUNCIATION_PROMPT_VERSION,
            PronunciationPatchKind, PronunciationWindowRecord, ReviewedPronunciationPatch,
            direct_phone_alphabet_sha256,
        };

        let source = document("An ordinary sentence.");
        let baseline = prepare_baseline(&source).unwrap();
        let vocabulary = KokoroVocabulary::pinned();
        let word = &baseline.words[0];
        let patch = ReviewedPronunciationPatch::new(
            0,
            word_fingerprint(word, &baseline.block_ids).unwrap(),
            PronunciationPatchKind::DirectPhones {
                phones: word.baseline.joined_phones(),
            },
        )
        .unwrap();
        let plan = ReviewedPronunciationPlan {
            schema_version: PRONUNCIATION_PLAN_SCHEMA_VERSION,
            document_hash: baseline.document_hash.clone(),
            baseline_hash: baseline.baseline_hash.clone(),
            reviewer_profile_hash: "sha256-test".to_string(),
            prompt_version: PRONUNCIATION_PROMPT_VERSION,
            output_schema_version: PRONUNCIATION_OUTPUT_SCHEMA_VERSION,
            window_planner_version: AUDIT_WINDOW_PLANNER_VERSION,
            phone_alphabet_version: DIRECT_PHONE_ALPHABET_VERSION,
            phone_alphabet_sha256: direct_phone_alphabet_sha256(),
            kokoro_vocabulary_sha256: vocabulary.sha256().to_string(),
            direct_phone_validator_version: DIRECT_PHONE_VALIDATOR_VERSION,
            windows: vec![PronunciationWindowRecord {
                window_id: 0,
                input_sha256: "sha256-input".to_string(),
                output_sha256: "sha256-output".to_string(),
            }],
            patches: vec![patch],
        };
        let error = apply_pronunciation_plan(baseline, &plan, &vocabulary).unwrap_err();
        assert!(error.contains("pronunciationPatchNoEffect"));
    }
}
