use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use remux_tts::{
    CorpusOrigin, EnglishG2p, MappingOrigin, MisakiCorpus, PronunciationOrigin, normalize_phonemes,
    validate_phonemes,
};
use serde::de::{DeserializeOwned, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use unicode_segmentation::UnicodeSegmentation;

use crate::narration::{NarrationSourceBlock, NarrationSourceDocument};

pub(crate) const COMPACT_REQUEST_VERSION: u64 = 6;
pub(crate) const GROUP_OUTPUT_VERSION: u64 = 6;
pub(crate) const BASE_INSTRUCTIONS_VERSION: &str = "6";
pub(crate) const GROUPING_PROMPT_VERSION: &str = "4";
pub(crate) const CORPUS_RESOLVER_VERSION: &str = "3";
pub(crate) const TOKENIZER_VERSION: &str = "2";
pub(crate) const INCREMENTAL_PARSER_VERSION: &str = "5";
pub(crate) const SOURCE_MAPPER_VERSION: &str = "11";
pub(crate) const LOCAL_G2P_VERSION: &str = "misaki-rs-0.3.0-us";
pub(crate) const REVIEWED_LEXICON_VERSION: &str = "1";

pub(crate) const PRIMARY_INSTRUCTIONS: &str = include_str!("../prompts/primary-v6.txt");
pub(crate) const PRIMARY_SCHEMA_JSON: &str = include_str!("../schemas/primary-v6.json");

const MAX_MODEL_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_GROUP_JSON_BYTES: usize = 32 * 1024;
const MAX_GROUP_TEXT_BYTES: usize = 16 * 1024;
const MAX_GROUPS: usize = 512;
const ACOUSTIC_GROUP_PHONEME_LIMIT: usize = 450;
const FIRST_GROUP_PHONEME_TARGET: usize = 240;
const LATER_GROUP_PHONEME_TARGET: usize = 360;

#[derive(Clone, Debug)]
pub(crate) struct SourceWord {
    pub(crate) block_index: usize,
    pub(crate) byte_end: usize,
    pub(crate) byte_start: usize,
    pub(crate) display_end_utf16: usize,
    pub(crate) display_start_utf16: usize,
    pub(crate) id: usize,
    pub(crate) phonemes: String,
    pub(crate) reviewed_phonemes: Option<String>,
    pub(crate) tag: String,
    pub(crate) target_id: Option<String>,
    pub(crate) text: String,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedRisk {
    pub(crate) block_id: usize,
    pub(crate) byte_start: usize,
    pub(crate) id: usize,
    pub(crate) labels: Vec<&'static str>,
    pub(crate) phonemes: String,
    pub(crate) source_word_ids: Vec<usize>,
    pub(crate) tag: String,
    pub(crate) text: String,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedBlock {
    pub(crate) id: usize,
    pub(crate) kind: &'static str,
    pub(crate) mode: &'static str,
    pub(crate) text: String,
    pub(crate) word_ids: Vec<usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedDocument {
    pub(crate) blocks: Vec<PreparedBlock>,
    pub(crate) compact_json: String,
    pub(crate) groups: Vec<PreparedGroup>,
    pub(crate) hard_group_ids: Vec<usize>,
    pub(crate) risks: Vec<PreparedRisk>,
    pub(crate) source_words: Vec<SourceWord>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedGroup {
    pub(crate) block_ids: Vec<usize>,
    pub(crate) id: usize,
    pub(crate) risk_ids: Vec<usize>,
    pub(crate) summary_block_ids: Vec<usize>,
}

impl PreparedGroup {
    pub(crate) fn model_required(&self) -> bool {
        !self.risk_ids.is_empty() || !self.summary_block_ids.is_empty()
    }
}

#[derive(Debug, Serialize)]
struct CompactRequest {
    #[serde(rename = "v")]
    version: u64,
    #[serde(rename = "b")]
    blocks: Vec<CompactBlock>,
    #[serde(rename = "g")]
    groups: Vec<CompactHardGroup>,
}

#[derive(Clone, Debug, Serialize)]
struct CompactBlock {
    #[serde(rename = "i")]
    id: usize,
    #[serde(rename = "k")]
    kind: &'static str,
    #[serde(rename = "m")]
    mode: &'static str,
    #[serde(rename = "x")]
    text: String,
}

#[derive(Clone, Debug, Serialize)]
struct CompactHardGroup {
    #[serde(rename = "i")]
    id: usize,
    #[serde(rename = "b")]
    block_ids: Vec<usize>,
    #[serde(rename = "s")]
    summary_block_ids: Vec<usize>,
    #[serde(rename = "q")]
    risks: Vec<CompactRisk>,
}

#[derive(Clone, Debug, Serialize)]
struct CompactRisk {
    #[serde(rename = "i")]
    id: usize,
    #[serde(rename = "b")]
    block_id: usize,
    #[serde(rename = "w")]
    source_word_ids: Vec<usize>,
    #[serde(rename = "x")]
    text: String,
    #[serde(rename = "p")]
    phonemes: String,
    #[serde(rename = "t")]
    tag: String,
    #[serde(rename = "q")]
    labels: Vec<&'static str>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PatchEnvelope {
    #[serde(rename = "v")]
    pub(crate) version: u64,
    #[serde(rename = "g")]
    pub(crate) groups: Vec<PatchGroup>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PatchGroup {
    #[serde(rename = "i")]
    pub(crate) id: usize,
    #[serde(rename = "s")]
    pub(crate) summaries: Vec<SummaryPatch>,
    #[serde(rename = "p")]
    pub(crate) patches: Vec<PronunciationPatch>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SummaryPatch {
    #[serde(rename = "i")]
    pub(crate) block_id: usize,
    #[serde(rename = "x")]
    pub(crate) text: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) enum PatchKind {
    #[serde(rename = "a")]
    AudioAlias,
    #[serde(rename = "r")]
    TranscriptReplacement,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PronunciationPatch {
    #[serde(rename = "i")]
    pub(crate) risk_id: usize,
    #[serde(rename = "k")]
    pub(crate) kind: PatchKind,
    #[serde(rename = "x")]
    pub(crate) text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedWord {
    pub(crate) byte_end: usize,
    pub(crate) byte_start: usize,
    pub(crate) mapping_origin: MappingOrigin,
    pub(crate) phonemes: String,
    pub(crate) pronunciation_origin: PronunciationOrigin,
    pub(crate) source_block_ids: Vec<usize>,
    pub(crate) source_word_ids: Vec<usize>,
    pub(crate) target_ids: Vec<String>,
    pub(crate) text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedAcousticGroup {
    pub(crate) block_range: [usize; 2],
    pub(crate) id: usize,
    pub(crate) phonemes: String,
    pub(crate) text: String,
    pub(crate) words: Vec<ResolvedWord>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WordSpan<'a> {
    pub(crate) byte_end: usize,
    pub(crate) byte_start: usize,
    pub(crate) text: &'a str,
}

#[derive(Clone, Debug)]
struct WordAnalysis {
    phonemes: String,
    tag: String,
}

#[derive(Clone, Debug)]
struct WordSeed {
    mapping_origin: MappingOrigin,
    phonemes: String,
    pronunciation_origin: PronunciationOrigin,
    punctuation_after: String,
    source_block: usize,
    source_word_ids: Vec<usize>,
    target_ids: Vec<String>,
    text: String,
    whitespace_after: bool,
}

pub(crate) fn word_spans(text: &str) -> Vec<WordSpan<'_>> {
    word_regex()
        .find_iter(text)
        .map(|matched| WordSpan {
            byte_end: matched.end(),
            byte_start: matched.start(),
            text: matched.as_str(),
        })
        .collect()
}

fn word_regex() -> &'static Regex {
    static WORD_REGEX: OnceLock<Regex> = OnceLock::new();
    WORD_REGEX.get_or_init(|| {
        Regex::new(r"[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*")
            .expect("v6 narration word regex must compile")
    })
}

pub(crate) fn prepare_document(
    document: &NarrationSourceDocument,
    corpus: &MisakiCorpus,
    vocabulary: &HashSet<char>,
    g2p: &EnglishG2p,
) -> Result<PreparedDocument, String> {
    let mut source_words = Vec::new();
    let mut blocks = Vec::with_capacity(document.blocks.len());
    let mut risks = Vec::new();
    for (block_id, block) in document.blocks.iter().enumerate() {
        let kind = compact_kind(&block.kind)?;
        let mode = if is_summary_block(block) { "s" } else { "n" };
        let target_by_range = word_targets(block, &document.targets)?;
        let spans = word_spans(&block.display_text);
        let analyses = analyze_word_spans(&block.display_text, &spans, g2p)?;
        let first_word_id = source_words.len();
        for (span, analysis) in spans.iter().zip(analyses) {
            let id = source_words.len();
            let display_start_utf16 = block.display_text[..span.byte_start].encode_utf16().count();
            let display_end_utf16 = block.display_text[..span.byte_end].encode_utf16().count();
            let reviewed_phonemes = reviewed_audio_alias(span.text)
                .map(|alias| alias_phonemes(alias, g2p, vocabulary))
                .transpose()?;
            source_words.push(SourceWord {
                block_index: block_id,
                byte_end: span.byte_end,
                byte_start: span.byte_start,
                display_end_utf16,
                display_start_utf16,
                id,
                phonemes: analysis.phonemes,
                reviewed_phonemes,
                tag: analysis.tag,
                target_id: target_by_range
                    .get(&(display_start_utf16, display_end_utf16))
                    .cloned(),
                text: span.text.to_string(),
            });
        }
        let block_word_ids = (first_word_id..source_words.len()).collect::<Vec<_>>();
        if mode == "n" {
            let ranges = semantic_word_ranges(block, &document.targets, &source_words, block_id)?;
            let mut block_risks = build_block_risks(
                block_id,
                &block.display_text,
                &block_word_ids,
                &ranges,
                &source_words,
                corpus,
                vocabulary,
            );
            for risk in &mut block_risks {
                risk.id = risks.len();
                risks.push(risk.clone());
            }
        }
        blocks.push(PreparedBlock {
            id: block_id,
            kind,
            mode,
            text: block.display_text.clone(),
            word_ids: block_word_ids,
        });
    }

    let mut groups = deterministic_groups(&blocks, &source_words);
    for group in &mut groups {
        group.summary_block_ids = group
            .block_ids
            .iter()
            .copied()
            .filter(|block_id| blocks[*block_id].mode == "s")
            .collect();
        group.risk_ids = risks
            .iter()
            .filter(|risk| group.block_ids.contains(&risk.block_id))
            .map(|risk| risk.id)
            .collect();
    }
    let hard_group_ids = groups
        .iter()
        .filter(|group| group.model_required())
        .map(|group| group.id)
        .collect::<Vec<_>>();
    let compact = CompactRequest {
        version: COMPACT_REQUEST_VERSION,
        blocks: blocks
            .iter()
            .map(|block| CompactBlock {
                id: block.id,
                kind: block.kind,
                mode: block.mode,
                text: block.text.clone(),
            })
            .collect(),
        groups: groups
            .iter()
            .filter(|group| group.model_required())
            .map(|group| CompactHardGroup {
                id: group.id,
                block_ids: group.block_ids.clone(),
                summary_block_ids: group.summary_block_ids.clone(),
                risks: group
                    .risk_ids
                    .iter()
                    .map(|risk_id| {
                        let risk = &risks[*risk_id];
                        CompactRisk {
                            id: risk.id,
                            block_id: risk.block_id,
                            source_word_ids: risk.source_word_ids.clone(),
                            text: risk.text.clone(),
                            phonemes: risk.phonemes.clone(),
                            tag: risk.tag.clone(),
                            labels: risk.labels.clone(),
                        }
                    })
                    .collect(),
            })
            .collect(),
    };
    let compact_json = serde_json::to_string(&compact)
        .map_err(|error| format!("failed to encode v6 narration input: {error}"))?;
    Ok(PreparedDocument {
        blocks,
        compact_json,
        groups,
        hard_group_ids,
        risks,
        source_words,
    })
}

fn analyze_word_spans(
    text: &str,
    spans: &[WordSpan<'_>],
    g2p: &EnglishG2p,
) -> Result<Vec<WordAnalysis>, String> {
    if spans.is_empty() {
        return Ok(Vec::new());
    }
    let output = g2p.phonemize(text)?;
    let candidates = output
        .tokens
        .iter()
        .filter(|token| token.text.chars().any(char::is_alphanumeric))
        .collect::<Vec<_>>();
    let mut cursor = 0usize;
    let mut analyses = Vec::with_capacity(spans.len());
    for span in spans {
        let wanted = lexical_key(span.text);
        let mut matched = None;
        for start in cursor..candidates.len() {
            let mut key = String::new();
            let mut phonemes = Vec::new();
            for (offset, token) in candidates[start..].iter().enumerate() {
                key.push_str(&lexical_key(&token.text));
                phonemes.push(token.phonemes.as_str());
                if key == wanted {
                    matched = Some((start + offset + 1, phonemes.join(" "), token.tag.clone()));
                    break;
                }
                if !wanted.starts_with(&key) {
                    break;
                }
            }
            if matched.is_some() {
                break;
            }
        }
        if let Some((next, phonemes, tag)) = matched {
            cursor = next;
            analyses.push(WordAnalysis { phonemes, tag });
            continue;
        }
        let isolated = g2p.phonemize(span.text)?;
        let lexical = isolated
            .tokens
            .iter()
            .filter(|token| token.text.chars().any(char::is_alphanumeric))
            .collect::<Vec<_>>();
        if lexical.is_empty() {
            return Err(format!("local G2P produced no word for {:?}", span.text));
        }
        analyses.push(WordAnalysis {
            phonemes: lexical
                .iter()
                .map(|token| token.phonemes.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            tag: lexical[0].tag.clone(),
        });
    }
    Ok(analyses)
}

fn lexical_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn build_block_risks(
    block_id: usize,
    text: &str,
    word_ids: &[usize],
    semantic_ranges: &[[usize; 2]],
    source_words: &[SourceWord],
    corpus: &MisakiCorpus,
    vocabulary: &HashSet<char>,
) -> Vec<PreparedRisk> {
    let mut labels_by_id = HashMap::<usize, Vec<&'static str>>::new();
    let semantic_words = semantic_ranges
        .iter()
        .flat_map(|range| range[0]..=range[1])
        .collect::<HashSet<_>>();
    for word_id in word_ids {
        let word = &source_words[*word_id];
        if word.reviewed_phonemes.is_some() {
            continue;
        }
        let mut labels = Vec::new();
        if is_known_heteronym(&word.text) {
            labels.push("context");
        }
        if corpus.is_tagged(&word.text) {
            labels.push("ambiguous");
        }
        let plain_number = word
            .text
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.');
        if corpus.resolve_simple(&word.text).is_none() && !plain_number {
            labels.push("oov");
        }
        if word
            .text
            .chars()
            .any(|character| character.is_ascii_digit())
        {
            labels.push("numeric");
        }
        if is_initialism(&word.text) {
            labels.push("initialism");
        }
        let mixed_case = word.text.chars().any(char::is_lowercase)
            && word.text.chars().skip(1).any(char::is_uppercase);
        if mixed_case
            || semantic_words.contains(word_id)
            || syntax_adjacent(text, word.byte_start, word.byte_end)
            || word.text.contains(['.', '_', '-'])
        {
            labels.push("technical");
        }
        if !phonemes_supported(&word.phonemes, vocabulary) {
            labels.push("unsupported");
        }
        labels.dedup();
        if labels != ["numeric"] && !labels.is_empty() {
            labels_by_id.insert(*word_id, labels);
        }
    }

    let mut output = Vec::new();
    let mut consumed = HashSet::new();
    for range in semantic_ranges {
        let ids = (range[0]..=range[1]).collect::<Vec<_>>();
        if ids.iter().any(|id| consumed.contains(id)) {
            continue;
        }
        if ids.iter().any(|id| labels_by_id.contains_key(id)) {
            let mut labels = ids
                .iter()
                .filter_map(|id| labels_by_id.get(id))
                .flatten()
                .copied()
                .collect::<Vec<_>>();
            labels.push("technical");
            labels.sort_unstable();
            labels.dedup();
            output.push(make_risk(block_id, text, &ids, labels, source_words));
            consumed.extend(ids);
        }
    }

    let mut index = 0usize;
    while index < word_ids.len() {
        let word_id = word_ids[index];
        if consumed.contains(&word_id) || !labels_by_id.contains_key(&word_id) {
            index += 1;
            continue;
        }
        let mut component = vec![word_id];
        let mut end = index;
        while end + 1 < word_ids.len() {
            let current = &source_words[word_ids[end]];
            let next = &source_words[word_ids[end + 1]];
            let gap = &text[current.byte_end..next.byte_start];
            if !gap
                .chars()
                .all(|character| matches!(character, '@' | '/' | ':'))
                || gap.is_empty()
                || consumed.contains(&next.id)
                || !labels_by_id.contains_key(&next.id)
            {
                break;
            }
            component.push(next.id);
            end += 1;
        }
        let mut labels = component
            .iter()
            .filter_map(|id| labels_by_id.get(id))
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        if component.len() > 1 {
            labels.push("technical");
        }
        labels.sort_unstable();
        labels.dedup();
        output.push(make_risk(block_id, text, &component, labels, source_words));
        index = end + 1;
    }
    output.sort_by_key(|risk| risk.byte_start);
    output
}

fn make_risk(
    block_id: usize,
    text: &str,
    source_word_ids: &[usize],
    labels: Vec<&'static str>,
    source_words: &[SourceWord],
) -> PreparedRisk {
    let first = &source_words[source_word_ids[0]];
    let last = &source_words[*source_word_ids.last().unwrap()];
    let byte_start = if first.byte_start > 0 && text[..first.byte_start].ends_with('@') {
        first.byte_start - 1
    } else {
        first.byte_start
    };
    let phonemes = source_word_ids
        .iter()
        .map(|id| {
            source_words[*id]
                .reviewed_phonemes
                .as_deref()
                .unwrap_or(source_words[*id].phonemes.as_str())
        })
        .collect::<Vec<_>>()
        .join(" ");
    PreparedRisk {
        block_id,
        byte_start,
        id: 0,
        labels,
        phonemes,
        source_word_ids: source_word_ids.to_vec(),
        tag: if source_word_ids.len() == 1 {
            first.tag.clone()
        } else {
            "EXPR".to_string()
        },
        text: text[byte_start..last.byte_end].to_string(),
    }
}

fn deterministic_groups(
    blocks: &[PreparedBlock],
    source_words: &[SourceWord],
) -> Vec<PreparedGroup> {
    let mut groups = Vec::new();
    let mut current = Vec::<usize>::new();
    let mut current_phonemes = 0usize;
    for block in blocks {
        let block_phonemes = estimated_block_phonemes(block, source_words).max(1);
        let summary = block.mode == "s";
        let target = if groups.is_empty() {
            FIRST_GROUP_PHONEME_TARGET
        } else {
            LATER_GROUP_PHONEME_TARGET
        };
        let current_is_heading = current.len() == 1 && blocks[current[0]].kind == "h";
        if summary && !current.is_empty() && !current_is_heading {
            push_group(&mut groups, &mut current);
            current_phonemes = 0;
        } else if !summary
            && !current.is_empty()
            && current_phonemes
                .saturating_add(1)
                .saturating_add(block_phonemes)
                > target
            && !(current_phonemes < target / 2
                && current_phonemes
                    .saturating_add(1)
                    .saturating_add(block_phonemes)
                    <= ACOUSTIC_GROUP_PHONEME_LIMIT)
        {
            push_group(&mut groups, &mut current);
            current_phonemes = 0;
        } else if block.kind == "h" && current_phonemes >= target / 2 {
            push_group(&mut groups, &mut current);
            current_phonemes = 0;
        }
        if !current.is_empty() {
            current_phonemes = current_phonemes.saturating_add(1);
        }
        current.push(block.id);
        current_phonemes = current_phonemes.saturating_add(block_phonemes);
        if summary {
            push_group(&mut groups, &mut current);
            current_phonemes = 0;
        }
    }
    push_group(&mut groups, &mut current);
    groups
}

fn estimated_block_phonemes(block: &PreparedBlock, source_words: &[SourceWord]) -> usize {
    let words = block
        .word_ids
        .iter()
        .map(|word_id| &source_words[*word_id])
        .collect::<Vec<_>>();
    words
        .iter()
        .enumerate()
        .map(|(index, word)| {
            let separator_end = words
                .get(index + 1)
                .map_or(block.text.len(), |next| next.byte_start);
            let separator = &block.text[word.byte_end..separator_end];
            word.reviewed_phonemes
                .as_ref()
                .unwrap_or(&word.phonemes)
                .chars()
                .count()
                + separator
                    .chars()
                    .filter(|character| is_spoken_punctuation(*character))
                    .count()
                + usize::from(index + 1 < words.len() && separator.chars().any(char::is_whitespace))
        })
        .sum()
}

fn push_group(groups: &mut Vec<PreparedGroup>, current: &mut Vec<usize>) {
    if current.is_empty() {
        return;
    }
    groups.push(PreparedGroup {
        block_ids: std::mem::take(current),
        id: groups.len(),
        risk_ids: Vec::new(),
        summary_block_ids: Vec::new(),
    });
}

fn reviewed_audio_alias(word: &str) -> Option<&'static str> {
    match word {
        "G2P" => Some("G two P"),
        "ONNX" => Some("onyx"),
        "SQLite" => Some("sequel light"),
        "WKWebView" => Some("W K web view"),
        "Sol" => Some("soul"),
        _ if word.eq_ignore_ascii_case("kokoro") => Some("koh koh roh"),
        _ if word.eq_ignore_ascii_case("misaki") => Some("mee sah kee"),
        _ if word.eq_ignore_ascii_case("nginx") => Some("engine x"),
        _ if word.eq_ignore_ascii_case("remux") => Some("ree mux"),
        _ if word.eq_ignore_ascii_case("serde") => Some("sir dee"),
        _ => None,
    }
}

fn alias_phonemes(
    alias: &str,
    g2p: &EnglishG2p,
    vocabulary: &HashSet<char>,
) -> Result<String, String> {
    let spans = word_spans(alias);
    let analyses = analyze_word_spans(alias, &spans, g2p)?;
    let phonemes = analyses
        .iter()
        .map(|analysis| analysis.phonemes.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    validate_phonemes(&phonemes, |character| vocabulary.contains(&character)).map_err(|error| {
        format!("reviewed pronunciation alias {alias:?} is incompatible with Kokoro: {error}")
    })?;
    Ok(phonemes)
}

fn is_initialism(word: &str) -> bool {
    let letters = word.chars().filter(|character| character.is_alphabetic());
    let count = letters.clone().count();
    count >= 2
        && letters
            .into_iter()
            .all(|character| character.is_uppercase())
}

fn is_known_heteronym(word: &str) -> bool {
    matches!(
        comparison_key(word).as_str(),
        "abstract"
            | "abuse"
            | "address"
            | "advocate"
            | "alternate"
            | "attribute"
            | "bass"
            | "bow"
            | "close"
            | "combine"
            | "compact"
            | "compound"
            | "conduct"
            | "conflict"
            | "console"
            | "content"
            | "contract"
            | "contrast"
            | "convert"
            | "coordinate"
            | "default"
            | "desert"
            | "digest"
            | "does"
            | "dove"
            | "duplicate"
            | "entrance"
            | "estimate"
            | "excuse"
            | "exploit"
            | "export"
            | "extract"
            | "house"
            | "impact"
            | "import"
            | "incline"
            | "insert"
            | "insult"
            | "invalid"
            | "lead"
            | "live"
            | "minute"
            | "moderate"
            | "object"
            | "permit"
            | "present"
            | "produce"
            | "project"
            | "read"
            | "record"
            | "refuse"
            | "reject"
            | "resume"
            | "row"
            | "separate"
            | "subject"
            | "survey"
            | "tear"
            | "use"
            | "wind"
            | "wound"
    )
}

fn syntax_adjacent(text: &str, start: usize, end: usize) -> bool {
    text[..start]
        .chars()
        .next_back()
        .is_some_and(|character| matches!(character, '@' | '/' | ':'))
        || text[end..]
            .chars()
            .next()
            .is_some_and(|character| matches!(character, '@' | '/' | ':'))
}

fn phonemes_supported(phonemes: &str, vocabulary: &HashSet<char>) -> bool {
    !phonemes.trim().is_empty()
        && phonemes
            .chars()
            .all(|character| character.is_whitespace() || vocabulary.contains(&character))
}

fn compact_kind(kind: &str) -> Result<&'static str, String> {
    match kind {
        "paragraph" => Ok("p"),
        "heading" => Ok("h"),
        "listItem" => Ok("li"),
        "blockquote" => Ok("q"),
        "code" => Ok("c"),
        "table" => Ok("tb"),
        "diagram" => Ok("d"),
        other => Err(format!("unsupported narration block kind {other}")),
    }
}

fn word_targets(
    block: &NarrationSourceBlock,
    targets: &[Value],
) -> Result<HashMap<(usize, usize), String>, String> {
    targets
        .iter()
        .filter(|target| {
            target.get("blockId").and_then(Value::as_str) == Some(block.id.as_str())
                && target.get("kind").and_then(Value::as_str) == Some("textRange")
                && target.get("role").and_then(Value::as_str) == Some("word")
        })
        .map(|target| {
            Ok((
                (
                    required_usize(target, "displayStart")?,
                    required_usize(target, "displayEnd")?,
                ),
                target
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "word narration target is missing id".to_string())?
                    .to_string(),
            ))
        })
        .collect()
}

fn semantic_word_ranges(
    block: &NarrationSourceBlock,
    targets: &[Value],
    words: &[SourceWord],
    block_index: usize,
) -> Result<Vec<[usize; 2]>, String> {
    let block_words = words
        .iter()
        .filter(|word| word.block_index == block_index)
        .collect::<Vec<_>>();
    let mut output = Vec::new();
    for target in targets.iter().filter(|target| {
        target.get("blockId").and_then(Value::as_str) == Some(block.id.as_str())
            && target.get("kind").and_then(Value::as_str) == Some("textRange")
            && matches!(
                target.get("role").and_then(Value::as_str),
                Some("inlineCode" | "link" | "expression")
            )
    }) {
        let start = required_usize(target, "displayStart")?;
        let end = required_usize(target, "displayEnd")?;
        let overlapping = block_words
            .iter()
            .filter(|word| word.display_start_utf16 < end && word.display_end_utf16 > start)
            .collect::<Vec<_>>();
        if let (Some(first), Some(last)) = (overlapping.first(), overlapping.last()) {
            output.push([first.id, last.id]);
        }
    }
    output.sort_unstable();
    output.dedup();
    Ok(output)
}

fn required_usize(value: &Value, field: &str) -> Result<usize, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("narration target is missing {field}"))
}

pub(crate) fn primary_schema() -> Value {
    serde_json::from_str(PRIMARY_SCHEMA_JSON).expect("primary v6 schema must remain valid JSON")
}

pub(crate) fn asset_sha256(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(crate) fn validate_patch_group(
    group: &PatchGroup,
    expected: &PreparedGroup,
    prepared: &PreparedDocument,
    g2p: &EnglishG2p,
    vocabulary: &HashSet<char>,
) -> Result<(), String> {
    if group.id != expected.id || !expected.model_required() {
        return Err(format!(
            "v6 patch group {} does not equal expected hard group {}",
            group.id, expected.id
        ));
    }
    let encoded = serde_json::to_vec(group)
        .map_err(|error| format!("failed to encode v6 patch group {}: {error}", group.id))?;
    if encoded.len() > MAX_GROUP_JSON_BYTES {
        return Err(format!("v6 patch group {} exceeds 32 KB", group.id));
    }
    let summary_ids = group
        .summaries
        .iter()
        .map(|summary| summary.block_id)
        .collect::<Vec<_>>();
    if summary_ids != expected.summary_block_ids {
        return Err(format!(
            "v6 patch group {} summary ids {:?} do not equal {:?}",
            group.id, summary_ids, expected.summary_block_ids
        ));
    }
    for summary in &group.summaries {
        validate_generated_text(
            &summary.text,
            format!("group {} summary {}", group.id, summary.block_id).as_str(),
            g2p,
            vocabulary,
        )?;
    }
    let mut seen = HashSet::new();
    for patch in &group.patches {
        if !seen.insert(patch.risk_id) {
            return Err(format!(
                "v6 patch group {} duplicates risk {}",
                group.id, patch.risk_id
            ));
        }
        if !expected.risk_ids.contains(&patch.risk_id) {
            return Err(format!(
                "v6 patch group {} references unknown risk {}",
                group.id, patch.risk_id
            ));
        }
        if patch.text.trim() != patch.text || patch.text.is_empty() {
            return Err(format!(
                "v6 patch group {} risk {} has invalid replacement whitespace",
                group.id, patch.risk_id
            ));
        }
        let words = validate_generated_text(
            &patch.text,
            format!("group {} risk {}", group.id, patch.risk_id).as_str(),
            g2p,
            vocabulary,
        )?;
        let risk = &prepared.risks[patch.risk_id];
        if patch.kind == PatchKind::AudioAlias
            && (risk.source_word_ids.len() != 1 || words.len() != 1)
        {
            return Err(format!(
                "v6 audio alias {} must map one source word to one local G2P word",
                patch.risk_id
            ));
        }
    }
    Ok(())
}

fn validate_generated_text(
    text: &str,
    label: &str,
    g2p: &EnglishG2p,
    vocabulary: &HashSet<char>,
) -> Result<Vec<WordAnalysis>, String> {
    if text.is_empty() || text.len() > MAX_GROUP_TEXT_BYTES || text.trim() != text {
        return Err(format!("v6 {label} has invalid text"));
    }
    let spans = word_spans(text);
    if spans.is_empty() {
        return Err(format!("v6 {label} contains no spoken words"));
    }
    let analyses = analyze_word_spans(text, &spans, g2p)?;
    for (index, analysis) in analyses.iter().enumerate() {
        validate_phonemes(&analysis.phonemes, |character| {
            vocabulary.contains(&character)
        })
        .map_err(|error| format!("v6 {label} word {index} has invalid local G2P: {error}"))?;
    }
    Ok(analyses)
}

pub(crate) fn resolve_group(
    patch_group: Option<&PatchGroup>,
    prepared_group: &PreparedGroup,
    prepared: &PreparedDocument,
    document: &NarrationSourceDocument,
    corpus: &MisakiCorpus,
    g2p: &EnglishG2p,
    vocabulary: &HashSet<char>,
) -> Result<Vec<ResolvedAcousticGroup>, String> {
    match (prepared_group.model_required(), patch_group) {
        (true, Some(group)) => {
            validate_patch_group(group, prepared_group, prepared, g2p, vocabulary)?
        }
        (true, None) => {
            return Err(format!(
                "v6 hard group {} is missing its model patch record",
                prepared_group.id
            ));
        }
        (false, Some(_)) => {
            return Err(format!(
                "v6 immediate group {} unexpectedly has a model patch record",
                prepared_group.id
            ));
        }
        (false, None) => {}
    }
    let summaries = patch_group
        .map(|group| {
            group
                .summaries
                .iter()
                .map(|summary| (summary.block_id, summary.text.as_str()))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let patches = patch_group
        .map(|group| {
            group
                .patches
                .iter()
                .map(|patch| (patch.risk_id, patch))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let mut seeds_by_block = Vec::new();
    for block_id in &prepared_group.block_ids {
        let block = &prepared.blocks[*block_id];
        let seeds = if block.mode == "s" {
            let summary = summaries.get(block_id).ok_or_else(|| {
                format!(
                    "v6 group {} is missing required summary block {}",
                    prepared_group.id, block_id
                )
            })?;
            generated_seeds(
                summary,
                *block_id,
                Vec::new(),
                document.blocks[*block_id].target_ids.clone(),
                MappingOrigin::SummaryBlock,
                PronunciationOrigin::SolSummary,
                g2p,
                vocabulary,
            )?
        } else {
            resolve_normal_block(
                *block_id, prepared, document, corpus, &patches, g2p, vocabulary,
            )?
        };
        if seeds.is_empty() {
            return Err(format!(
                "v6 group {} block {} produced no spoken words",
                prepared_group.id, block_id
            ));
        }
        seeds_by_block.push(seeds);
    }
    let resolved = build_resolved_group(prepared_group, seeds_by_block, vocabulary)?;
    split_resolved_group(resolved, vocabulary)
}

fn resolve_normal_block(
    block_id: usize,
    prepared: &PreparedDocument,
    document: &NarrationSourceDocument,
    corpus: &MisakiCorpus,
    patches: &HashMap<usize, &PronunciationPatch>,
    g2p: &EnglishG2p,
    vocabulary: &HashSet<char>,
) -> Result<Vec<WordSeed>, String> {
    let block = &prepared.blocks[block_id];
    let source = &document.blocks[block_id];
    let words = block
        .word_ids
        .iter()
        .map(|id| &prepared.source_words[*id])
        .collect::<Vec<_>>();
    let risks = prepared
        .risks
        .iter()
        .filter(|risk| risk.block_id == block_id)
        .map(|risk| (risk.source_word_ids[0], risk))
        .collect::<HashMap<_, _>>();
    let mut output = Vec::new();
    let mut index = 0usize;
    while index < words.len() {
        let word = words[index];
        if let Some(risk) = risks.get(&word.id) {
            let end_id = *risk.source_word_ids.last().unwrap();
            let end_index = words
                .iter()
                .position(|word| word.id == end_id)
                .ok_or_else(|| format!("v6 risk {} has a nonlocal source range", risk.id))?;
            if let Some(patch) = patches.get(&risk.id) {
                let target_ids = risk_targets(risk, prepared, source);
                match patch.kind {
                    PatchKind::AudioAlias => {
                        let analyses = validate_generated_text(
                            &patch.text,
                            format!("audio alias {}", risk.id).as_str(),
                            g2p,
                            vocabulary,
                        )?;
                        let (punctuation_after, whitespace_after) =
                            source_separator(&source.display_text, &words, end_index);
                        output.push(WordSeed {
                            mapping_origin: MappingOrigin::SourceSemantic,
                            phonemes: analyses[0].phonemes.clone(),
                            pronunciation_origin: PronunciationOrigin::SolAudioAlias,
                            punctuation_after,
                            source_block: block_id,
                            source_word_ids: risk.source_word_ids.clone(),
                            target_ids,
                            text: word.text.clone(),
                            whitespace_after,
                        });
                    }
                    PatchKind::TranscriptReplacement => {
                        let mut replacement = generated_seeds(
                            &patch.text,
                            block_id,
                            risk.source_word_ids.clone(),
                            target_ids,
                            MappingOrigin::SourceSemantic,
                            PronunciationOrigin::SolTranscriptReplacement,
                            g2p,
                            vocabulary,
                        )?;
                        let (punctuation_after, whitespace_after) =
                            source_separator(&source.display_text, &words, end_index);
                        let last = replacement.last_mut().unwrap();
                        last.punctuation_after = punctuation_after;
                        last.whitespace_after = whitespace_after;
                        output.extend(replacement);
                    }
                }
            } else {
                for current in &words[index..=end_index] {
                    output.push(baseline_seed(
                        current,
                        &source.display_text,
                        &words,
                        corpus,
                        source,
                    ));
                }
            }
            index = end_index + 1;
        } else {
            output.push(baseline_seed(
                word,
                &source.display_text,
                &words,
                corpus,
                source,
            ));
            index += 1;
        }
    }
    Ok(output)
}

fn baseline_seed(
    word: &SourceWord,
    text: &str,
    block_words: &[&SourceWord],
    corpus: &MisakiCorpus,
    block: &NarrationSourceBlock,
) -> WordSeed {
    let index = block_words
        .iter()
        .position(|candidate| candidate.id == word.id)
        .expect("source word belongs to its block");
    let (punctuation_after, whitespace_after) = source_separator(text, block_words, index);
    let (target_ids, mapping_origin) = word.target_id.as_ref().map_or_else(
        || (block.target_ids.clone(), MappingOrigin::BlockFallback),
        |target| (vec![target.clone()], MappingOrigin::SourceWord),
    );
    let pronunciation_origin = if word.reviewed_phonemes.is_some() {
        PronunciationOrigin::ReviewedLexicon
    } else {
        corpus
            .resolve_simple(&word.text)
            .filter(|resolution| normalize_phonemes(&resolution.phonemes) == word.phonemes)
            .map_or(
                PronunciationOrigin::LocalG2p,
                |resolution| match resolution.origin {
                    CorpusOrigin::Gold => PronunciationOrigin::GoldCorpus,
                    CorpusOrigin::Silver => PronunciationOrigin::SilverCorpus,
                    CorpusOrigin::Compound => PronunciationOrigin::CompoundCorpus,
                    CorpusOrigin::Override => PronunciationOrigin::LocalG2p,
                },
            )
    };
    WordSeed {
        mapping_origin,
        phonemes: word
            .reviewed_phonemes
            .clone()
            .unwrap_or_else(|| word.phonemes.clone()),
        pronunciation_origin,
        punctuation_after,
        source_block: word.block_index,
        source_word_ids: vec![word.id],
        target_ids,
        text: word.text.clone(),
        whitespace_after,
    }
}

fn generated_seeds(
    text: &str,
    block_id: usize,
    source_word_ids: Vec<usize>,
    target_ids: Vec<String>,
    mapping_origin: MappingOrigin,
    pronunciation_origin: PronunciationOrigin,
    g2p: &EnglishG2p,
    vocabulary: &HashSet<char>,
) -> Result<Vec<WordSeed>, String> {
    let spans = word_spans(text);
    let analyses = validate_generated_text(text, "generated text", g2p, vocabulary)?;
    Ok(spans
        .iter()
        .zip(analyses)
        .enumerate()
        .map(|(index, (span, analysis))| {
            let separator_end = spans
                .get(index + 1)
                .map_or(text.len(), |next| next.byte_start);
            let (punctuation_after, whitespace_after) =
                normalize_separator(&text[span.byte_end..separator_end]);
            WordSeed {
                mapping_origin,
                phonemes: analysis.phonemes,
                pronunciation_origin,
                punctuation_after,
                source_block: block_id,
                source_word_ids: source_word_ids.clone(),
                target_ids: target_ids.clone(),
                text: span.text.to_string(),
                whitespace_after,
            }
        })
        .collect())
}

fn source_separator(text: &str, words: &[&SourceWord], index: usize) -> (String, bool) {
    let end = words
        .get(index + 1)
        .map_or(text.len(), |next| next.byte_start);
    normalize_separator(&text[words[index].byte_end..end])
}

fn normalize_separator(value: &str) -> (String, bool) {
    let punctuation = value
        .chars()
        .filter(|character| is_spoken_punctuation(*character))
        .collect::<String>();
    let whitespace = value.chars().any(char::is_whitespace);
    (punctuation, whitespace)
}

fn risk_targets(
    risk: &PreparedRisk,
    prepared: &PreparedDocument,
    block: &NarrationSourceBlock,
) -> Vec<String> {
    let mut targets = Vec::new();
    for word_id in &risk.source_word_ids {
        if let Some(target) = &prepared.source_words[*word_id].target_id {
            push_unique(&mut targets, target.clone());
        }
    }
    if targets.is_empty() {
        targets.extend(block.target_ids.iter().cloned());
    }
    targets
}

fn build_resolved_group(
    group: &PreparedGroup,
    mut seeds_by_block: Vec<Vec<WordSeed>>,
    vocabulary: &HashSet<char>,
) -> Result<ResolvedAcousticGroup, String> {
    let mut text = String::new();
    let mut words = Vec::new();
    let block_count = seeds_by_block.len();
    for (block_offset, seeds) in seeds_by_block.iter_mut().enumerate() {
        if block_offset + 1 < block_count {
            if let Some(last) = seeds.last_mut() {
                last.whitespace_after = true;
            }
        }
        for seed in seeds {
            if !text.is_empty()
                && !text.ends_with(char::is_whitespace)
                && !text.ends_with(is_spoken_punctuation)
            {
                text.push(' ');
            }
            let byte_start = text.len();
            text.push_str(&seed.text);
            let byte_end = text.len();
            text.push_str(&seed.punctuation_after);
            if seed.whitespace_after {
                text.push(' ');
            }
            words.push(ResolvedWord {
                byte_end,
                byte_start,
                mapping_origin: seed.mapping_origin,
                phonemes: seed.phonemes.clone(),
                pronunciation_origin: seed.pronunciation_origin,
                source_block_ids: vec![seed.source_block],
                source_word_ids: seed.source_word_ids.clone(),
                target_ids: seed.target_ids.clone(),
                text: seed.text.clone(),
            });
        }
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(format!("v6 group {} has no spoken text", group.id));
    }
    let phonemes = join_group_phonemes(&text, &words, vocabulary)?;
    Ok(ResolvedAcousticGroup {
        block_range: [
            *group.block_ids.first().unwrap(),
            *group.block_ids.last().unwrap(),
        ],
        id: group.id,
        phonemes,
        text,
        words,
    })
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum BreakStrength {
    Whitespace,
    Conjunction,
    MinorPunctuation,
    MajorPunctuation,
    Sentence,
}

#[derive(Clone, Copy, Debug)]
struct WordRange {
    end: usize,
    start: usize,
}

fn split_resolved_group(
    resolved: ResolvedAcousticGroup,
    vocabulary: &HashSet<char>,
) -> Result<Vec<ResolvedAcousticGroup>, String> {
    if resolved.words.is_empty() {
        return Err(format!(
            "v6 group {} contains no resolved words",
            resolved.id
        ));
    }
    let sentence_ends = sentence_word_ends(&resolved.text, &resolved.words);
    let mut atomic_ranges = Vec::new();
    let mut sentence_start = 0usize;
    for sentence_end in sentence_ends {
        if sentence_end <= sentence_start {
            continue;
        }
        if word_range_phonemes(&resolved, sentence_start, sentence_end)
            <= ACOUSTIC_GROUP_PHONEME_LIMIT
        {
            atomic_ranges.push(WordRange {
                start: sentence_start,
                end: sentence_end,
            });
        } else {
            atomic_ranges.extend(split_oversized_sentence(
                &resolved,
                sentence_start,
                sentence_end,
            )?);
        }
        sentence_start = sentence_end;
    }
    if sentence_start < resolved.words.len() {
        atomic_ranges.extend(split_oversized_sentence(
            &resolved,
            sentence_start,
            resolved.words.len(),
        )?);
    }

    let mut packed = Vec::<WordRange>::new();
    for unit in atomic_ranges {
        let is_first_acoustic_group = resolved.id == 0 && packed.len() == 1;
        if let Some(current) = packed.last_mut() {
            let target = if is_first_acoustic_group {
                FIRST_GROUP_PHONEME_TARGET
            } else {
                LATER_GROUP_PHONEME_TARGET
            };
            let current_count = word_range_phonemes(&resolved, current.start, current.end);
            let combined_count = word_range_phonemes(&resolved, current.start, unit.end);
            if combined_count <= target
                || (current_count < target / 2 && combined_count <= ACOUSTIC_GROUP_PHONEME_LIMIT)
            {
                current.end = unit.end;
                continue;
            }
        }
        packed.push(unit);
    }

    if packed.len() > MAX_GROUPS {
        return Err(format!(
            "v6 model group {} expands beyond 512 acoustic groups",
            resolved.id
        ));
    }
    packed
        .into_iter()
        .enumerate()
        .map(|(id, range)| acoustic_group_slice(&resolved, range, id, vocabulary))
        .collect()
}

fn sentence_word_ends(text: &str, words: &[ResolvedWord]) -> Vec<usize> {
    let mut ends = Vec::new();
    for (start, sentence) in text.split_sentence_bound_indices() {
        let boundary = start + sentence.len();
        let word_end = words.partition_point(|word| word.byte_start < boundary);
        if word_end > ends.last().copied().unwrap_or(0)
            && !suppressed_sentence_break(text, words, word_end)
        {
            ends.push(word_end);
        }
    }
    if ends.last().copied() != Some(words.len()) {
        ends.push(words.len());
    }
    ends
}

fn suppressed_sentence_break(text: &str, words: &[ResolvedWord], word_end: usize) -> bool {
    if word_end == 0 || word_end >= words.len() {
        return false;
    }
    let previous = &words[word_end - 1];
    let next = &words[word_end];
    let separator = &text[previous.byte_end..next.byte_start];
    if !separator.contains('.') || separator.contains(['!', '?', '…']) {
        return false;
    }
    let previous_key = previous
        .text
        .trim_matches(|character: char| !character.is_alphanumeric() && character != '.')
        .to_ascii_lowercase();
    let abbreviation = matches!(
        previous_key.as_str(),
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
    ) || (previous_key.chars().count() == 1
        && previous_key.chars().all(char::is_alphabetic));
    abbreviation || next.text.chars().next().is_some_and(char::is_lowercase)
}

fn split_oversized_sentence(
    resolved: &ResolvedAcousticGroup,
    start: usize,
    end: usize,
) -> Result<Vec<WordRange>, String> {
    let mut ranges = Vec::new();
    let mut cursor = start;
    while cursor < end {
        if word_range_phonemes(resolved, cursor, end) <= ACOUSTIC_GROUP_PHONEME_LIMIT {
            ranges.push(WordRange { start: cursor, end });
            break;
        }
        let candidates = ((cursor + 1)..end)
            .take_while(|candidate| {
                word_range_phonemes(resolved, cursor, *candidate) <= ACOUSTIC_GROUP_PHONEME_LIMIT
            })
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Err(format!(
                "v6 group {} contains one word above the 450-phoneme acoustic limit",
                resolved.id
            ));
        }
        let preferred_min = LATER_GROUP_PHONEME_TARGET / 2;
        let eligible = candidates
            .iter()
            .copied()
            .filter(|candidate| word_range_phonemes(resolved, cursor, *candidate) >= preferred_min)
            .collect::<Vec<_>>();
        let pool = if eligible.is_empty() {
            candidates.as_slice()
        } else {
            eligible.as_slice()
        };
        let split = pool
            .iter()
            .copied()
            .max_by_key(|candidate| {
                (
                    break_strength(resolved, *candidate),
                    word_range_phonemes(resolved, cursor, *candidate),
                )
            })
            .expect("oversized sentence has at least one word boundary");
        ranges.push(WordRange {
            start: cursor,
            end: split,
        });
        cursor = split;
    }
    Ok(ranges)
}

fn break_strength(resolved: &ResolvedAcousticGroup, boundary: usize) -> BreakStrength {
    let previous = &resolved.words[boundary - 1];
    let next = &resolved.words[boundary];
    if previous.source_block_ids != next.source_block_ids {
        return BreakStrength::Sentence;
    }
    let separator = &resolved.text[previous.byte_end..next.byte_start];
    if separator
        .chars()
        .any(|character| matches!(character, '.' | '!' | '?' | '…'))
    {
        BreakStrength::Sentence
    } else if separator
        .chars()
        .any(|character| matches!(character, ';' | ':'))
    {
        BreakStrength::MajorPunctuation
    } else if separator
        .chars()
        .any(|character| matches!(character, ',' | '—'))
    {
        BreakStrength::MinorPunctuation
    } else if is_phrase_leader(&next.text) {
        BreakStrength::Conjunction
    } else {
        BreakStrength::Whitespace
    }
}

fn is_phrase_leader(word: &str) -> bool {
    matches!(
        word.to_ascii_lowercase().as_str(),
        "and"
            | "although"
            | "as"
            | "because"
            | "but"
            | "except"
            | "for"
            | "however"
            | "if"
            | "nor"
            | "or"
            | "since"
            | "so"
            | "that"
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
    )
}

fn word_range_phonemes(resolved: &ResolvedAcousticGroup, start: usize, end: usize) -> usize {
    resolved.words[start..end]
        .iter()
        .enumerate()
        .map(|(offset, word)| {
            let index = start + offset;
            let separator_end = resolved
                .words
                .get(index + 1)
                .map_or(resolved.text.len(), |next| next.byte_start);
            let separator = &resolved.text[word.byte_end..separator_end];
            word.phonemes.chars().count()
                + separator
                    .chars()
                    .filter(|character| is_spoken_punctuation(*character))
                    .count()
                + usize::from(index + 1 < end && separator.chars().any(char::is_whitespace))
        })
        .sum()
}

fn acoustic_group_slice(
    resolved: &ResolvedAcousticGroup,
    range: WordRange,
    id: usize,
    vocabulary: &HashSet<char>,
) -> Result<ResolvedAcousticGroup, String> {
    let byte_start = resolved.words[range.start].byte_start;
    let byte_end = resolved
        .words
        .get(range.end)
        .map_or(resolved.text.len(), |next| next.byte_start);
    let text = resolved.text[byte_start..byte_end].trim_end().to_string();
    if text.is_empty() || text.len() > MAX_GROUP_TEXT_BYTES {
        return Err(format!(
            "v6 group {} produced an invalid acoustic text size",
            resolved.id
        ));
    }
    let mut words = resolved.words[range.start..range.end].to_vec();
    for word in &mut words {
        word.byte_start -= byte_start;
        word.byte_end -= byte_start;
    }
    let phonemes = join_group_phonemes(&text, &words, vocabulary)?;
    let phoneme_count = phonemes.chars().count();
    if phoneme_count == 0 || phoneme_count > ACOUSTIC_GROUP_PHONEME_LIMIT {
        return Err(format!(
            "v6 group {} produced an invalid {phoneme_count}-phoneme acoustic chunk",
            resolved.id
        ));
    }
    let first_block = words
        .first()
        .and_then(|word| word.source_block_ids.first())
        .copied()
        .ok_or_else(|| format!("v6 group {} lost its first block mapping", resolved.id))?;
    let last_block = words
        .last()
        .and_then(|word| word.source_block_ids.last())
        .copied()
        .ok_or_else(|| format!("v6 group {} lost its last block mapping", resolved.id))?;
    Ok(ResolvedAcousticGroup {
        block_range: [first_block, last_block],
        id,
        phonemes,
        text,
        words,
    })
}

fn join_group_phonemes(
    text: &str,
    words: &[ResolvedWord],
    vocabulary: &HashSet<char>,
) -> Result<String, String> {
    let mut output = String::new();
    for (index, word) in words.iter().enumerate() {
        validate_phonemes(&word.phonemes, |character| vocabulary.contains(&character))
            .map_err(|error| format!("local G2P for {:?} is invalid: {error}", word.text))?;
        output.push_str(&word.phonemes);
        let separator_end = words
            .get(index + 1)
            .map_or(text.len(), |next| next.byte_start);
        let separator = &text[word.byte_end..separator_end];
        let mut wrote_space = false;
        for character in separator.chars() {
            if character.is_whitespace() {
                wrote_space = true;
            } else if is_spoken_punctuation(character) {
                if !vocabulary.contains(&character) {
                    return Err(format!(
                        "spoken punctuation {character:?} is unsupported by Kokoro"
                    ));
                }
                output.push(character);
            } else {
                return Err(format!(
                    "spoken text contains unnormalized punctuation {character:?}"
                ));
            }
        }
        if wrote_space && index + 1 < words.len() {
            output.push(' ');
        }
    }
    Ok(output.trim().to_string())
}

fn comparison_key(value: &str) -> String {
    value
        .replace(['’', '‘'], "'")
        .chars()
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_summary_block(block: &NarrationSourceBlock) -> bool {
    matches!(block.kind.as_str(), "code" | "table" | "diagram")
}

fn is_spoken_punctuation(character: char) -> bool {
    matches!(character, ';' | ':' | ',' | '.' | '!' | '?' | '—' | '…')
}

fn push_unique(target: &mut Vec<String>, value: String) {
    if !target.contains(&value) {
        target.push(value);
    }
}

pub(crate) struct IncrementalGroupParser {
    text: String,
    array_start: Option<usize>,
    envelope_suffix: Option<EnvelopeSuffix>,
    cursor: usize,
    group_start: Option<usize>,
    object_depth: usize,
    in_string: bool,
    escaped: bool,
    array_closed: bool,
    root_closed: bool,
    after_group: bool,
    emitted: usize,
}

impl IncrementalGroupParser {
    pub(crate) fn new() -> Self {
        Self {
            text: String::new(),
            array_start: None,
            envelope_suffix: None,
            cursor: 0,
            group_start: None,
            object_depth: 0,
            in_string: false,
            escaped: false,
            array_closed: false,
            root_closed: false,
            after_group: false,
            emitted: 0,
        }
    }

    pub(crate) fn push(&mut self, delta: &str) -> Result<Vec<PatchGroup>, String> {
        if self.root_closed && !delta.trim().is_empty() {
            return Err("v6 narration output has trailing content".to_string());
        }
        if self.text.len().saturating_add(delta.len()) > MAX_MODEL_OUTPUT_BYTES {
            return Err("v6 narration output exceeds 512 KB".to_string());
        }
        self.text.push_str(delta);
        if self.array_start.is_none() {
            match parse_envelope_prefix(&self.text)? {
                Some((array_start, envelope_suffix)) => {
                    self.array_start = Some(array_start);
                    self.envelope_suffix = Some(envelope_suffix);
                    self.cursor = array_start;
                }
                None => return Ok(Vec::new()),
            }
        }
        let mut groups = Vec::new();
        while self.cursor < self.text.len() {
            let byte = self.text.as_bytes()[self.cursor];
            if let Some(start) = self.group_start {
                if self.in_string {
                    if self.escaped {
                        self.escaped = false;
                    } else if byte == b'\\' {
                        self.escaped = true;
                    } else if byte == b'"' {
                        self.in_string = false;
                    }
                } else if byte == b'"' {
                    self.in_string = true;
                } else if byte == b'{' {
                    self.object_depth += 1;
                } else if byte == b'}' {
                    self.object_depth = self
                        .object_depth
                        .checked_sub(1)
                        .ok_or_else(|| "v6 narration group has invalid object depth".to_string())?;
                    if self.object_depth == 0 {
                        let end = self.cursor + 1;
                        if end - start > MAX_GROUP_JSON_BYTES {
                            return Err("v6 narration group exceeds 32 KB".to_string());
                        }
                        let group: PatchGroup = decode_no_duplicates(&self.text[start..end])?;
                        self.emitted += 1;
                        if self.emitted > MAX_GROUPS {
                            return Err("v6 narration output exceeds 512 groups".to_string());
                        }
                        groups.push(group);
                        self.group_start = None;
                        self.after_group = true;
                    }
                }
                self.cursor += 1;
                continue;
            }
            if self.root_closed {
                if byte.is_ascii_whitespace() {
                    self.cursor += 1;
                    continue;
                }
                return Err("v6 narration output has trailing content".to_string());
            }
            if self.array_closed {
                let suffix = self.envelope_suffix.ok_or_else(|| {
                    "v6 narration parser is missing its envelope order".to_string()
                })?;
                match parse_envelope_suffix(&self.text, self.cursor, suffix)? {
                    Some(end) => {
                        self.root_closed = true;
                        self.cursor = end;
                    }
                    None => break,
                }
                continue;
            }
            if self.after_group {
                match byte {
                    b' ' | b'\n' | b'\r' | b'\t' => self.cursor += 1,
                    b',' => {
                        self.after_group = false;
                        self.cursor += 1;
                    }
                    b']' => {
                        self.array_closed = true;
                        self.cursor += 1;
                    }
                    _ => return Err("v6 narration output is missing a group separator".to_string()),
                }
                continue;
            }
            match byte {
                b' ' | b'\n' | b'\r' | b'\t' => self.cursor += 1,
                b'{' => {
                    self.group_start = Some(self.cursor);
                    self.object_depth = 1;
                    self.cursor += 1;
                }
                b']' => {
                    self.array_closed = true;
                    self.cursor += 1;
                }
                _ => return Err("v6 narration output has invalid group separators".to_string()),
            }
        }
        Ok(groups)
    }

    pub(crate) fn finish(self, completed_text: &str) -> Result<PatchEnvelope, String> {
        if self.text != completed_text {
            return Err("v6 narration delta text differs from completed text".to_string());
        }
        if self.group_start.is_some() || !self.array_closed || !self.root_closed {
            return Err("v6 narration output is truncated".to_string());
        }
        let envelope: PatchEnvelope = decode_no_duplicates(completed_text)?;
        if envelope.version != GROUP_OUTPUT_VERSION {
            return Err("v6 narration output has the wrong version".to_string());
        }
        if envelope.groups.is_empty() || envelope.groups.len() != self.emitted {
            return Err("v6 narration output group count is invalid".to_string());
        }
        Ok(envelope)
    }

    pub(crate) fn accumulated_text(&self) -> &str {
        &self.text
    }
}

#[derive(Clone, Copy)]
enum EnvelopeSuffix {
    RootClose,
    TrailingVersion,
}

fn parse_envelope_prefix(text: &str) -> Result<Option<(usize, EnvelopeSuffix)>, String> {
    let bytes = text.as_bytes();
    let mut cursor = 0;
    macro_rules! byte {
        ($expected:expr) => {{
            skip_whitespace(bytes, &mut cursor);
            if cursor == bytes.len() {
                return Ok(None);
            }
            if bytes[cursor] != $expected {
                return Err("v6 narration output has an invalid envelope prefix".to_string());
            }
            cursor += 1;
        }};
    }
    byte!(b'{');
    let Some(first_key) = parse_envelope_key(bytes, &mut cursor)? else {
        return Ok(None);
    };
    match first_key {
        b'v' => {
            byte!(b':');
            byte!(b'6');
            byte!(b',');
            let Some(second_key) = parse_envelope_key(bytes, &mut cursor)? else {
                return Ok(None);
            };
            if second_key != b'g' {
                return Err(
                    "v6 narration envelope must contain one v key and one g key".to_string()
                );
            }
            byte!(b':');
            byte!(b'[');
            Ok(Some((cursor, EnvelopeSuffix::RootClose)))
        }
        b'g' => {
            byte!(b':');
            byte!(b'[');
            Ok(Some((cursor, EnvelopeSuffix::TrailingVersion)))
        }
        _ => unreachable!("parse_envelope_key only accepts v or g"),
    }
}

fn parse_envelope_suffix(
    text: &str,
    start: usize,
    suffix: EnvelopeSuffix,
) -> Result<Option<usize>, String> {
    let bytes = text.as_bytes();
    let mut cursor = start;
    macro_rules! byte {
        ($expected:expr) => {{
            skip_whitespace(bytes, &mut cursor);
            if cursor == bytes.len() {
                return Ok(None);
            }
            if bytes[cursor] != $expected {
                return Err("v6 narration output has an invalid envelope suffix".to_string());
            }
            cursor += 1;
        }};
    }
    if matches!(suffix, EnvelopeSuffix::TrailingVersion) {
        byte!(b',');
        let Some(key) = parse_envelope_key(bytes, &mut cursor)? else {
            return Ok(None);
        };
        if key != b'v' {
            return Err("v6 narration envelope must contain one v key and one g key".to_string());
        }
        byte!(b':');
        byte!(b'6');
    }
    byte!(b'}');
    Ok(Some(cursor))
}

fn parse_envelope_key(bytes: &[u8], cursor: &mut usize) -> Result<Option<u8>, String> {
    skip_whitespace(bytes, cursor);
    if *cursor == bytes.len() {
        return Ok(None);
    }
    if bytes[*cursor] != b'"' {
        return Err("v6 narration output has an invalid envelope key".to_string());
    }
    *cursor += 1;
    if *cursor == bytes.len() {
        return Ok(None);
    }
    let key = bytes[*cursor];
    if !matches!(key, b'v' | b'g') {
        return Err("v6 narration envelope key must be v or g".to_string());
    }
    *cursor += 1;
    if *cursor == bytes.len() {
        return Ok(None);
    }
    if bytes[*cursor] != b'"' {
        return Err("v6 narration output has an invalid envelope key".to_string());
    }
    *cursor += 1;
    Ok(Some(key))
}

fn skip_whitespace(bytes: &[u8], cursor: &mut usize) {
    while *cursor < bytes.len() && bytes[*cursor].is_ascii_whitespace() {
        *cursor += 1;
    }
}

fn decode_no_duplicates<T: DeserializeOwned>(text: &str) -> Result<T, String> {
    let value = serde_json::from_str::<UniqueValue>(text)
        .map_err(|error| format!("invalid v6 narration JSON: {error}"))?
        .0;
    serde_json::from_value(value).map_err(|error| format!("invalid v6 narration contract: {error}"))
}

struct UniqueValue(Value);

impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct UniqueVisitor;
        impl<'de> Visitor<'de> for UniqueVisitor {
            type Value = UniqueValue;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON value without duplicate object keys")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(UniqueValue(Value::Bool(value)))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(UniqueValue(Value::Number(Number::from(value))))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(UniqueValue(Value::Number(Number::from(value))))
            }

            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                Number::from_f64(value)
                    .map(Value::Number)
                    .map(UniqueValue)
                    .ok_or_else(|| E::custom("non-finite JSON number"))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(UniqueValue(Value::String(value.to_string())))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(UniqueValue(Value::String(value)))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(UniqueValue(Value::Null))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(UniqueValue(Value::Null))
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<UniqueValue>()? {
                    values.push(value.0);
                }
                Ok(UniqueValue(Value::Array(values)))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = Map::new();
                while let Some((key, value)) = map.next_entry::<String, UniqueValue>()? {
                    if values.insert(key.clone(), value.0).is_some() {
                        return Err(serde::de::Error::custom(format!(
                            "duplicate object key {key:?}"
                        )));
                    }
                }
                Ok(UniqueValue(Value::Object(values)))
            }
        }

        deserializer.deserialize_any(UniqueVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn document(blocks: Vec<(&str, &str)>) -> NarrationSourceDocument {
        let mut targets = Vec::new();
        let blocks = blocks
            .into_iter()
            .enumerate()
            .map(|(block_index, (kind, text))| {
                let block_id = format!("md:{block_index}");
                let block_target = format!("block:{block_index}");
                targets.push(json!({
                    "blockId": block_id,
                    "id": block_target,
                    "kind": "element",
                    "role": "block",
                }));
                for (word_index, span) in word_spans(text).iter().enumerate() {
                    targets.push(json!({
                        "blockId": block_id,
                        "displayEnd": text[..span.byte_end].encode_utf16().count(),
                        "displayStart": text[..span.byte_start].encode_utf16().count(),
                        "id": format!("word:{block_index}:{word_index}"),
                        "kind": "textRange",
                        "role": "word",
                    }));
                }
                NarrationSourceBlock {
                    display_text: text.to_string(),
                    id: block_id,
                    inline_ranges: Vec::new(),
                    kind: kind.to_string(),
                    path: block_index.to_string(),
                    target_ids: vec![block_target],
                }
            })
            .collect();
        NarrationSourceDocument {
            blocks,
            document_version: "4".to_string(),
            message_id: "message".to_string(),
            message_revision: "revision".to_string(),
            schema_version: 3,
            source_hash: "source".to_string(),
            targets,
        }
    }

    fn vocabulary(g2p: &EnglishG2p, texts: &[&str]) -> HashSet<char> {
        let mut output = ";:,.!?—… ".chars().collect::<HashSet<_>>();
        for text in texts.iter().copied().chain([
            "G two P",
            "onyx",
            "sequel light",
            "W K web view",
            "soul",
            "koh koh roh",
            "mee sah kee",
            "engine x",
            "ree mux",
            "sir dee",
        ]) {
            let value = g2p.phonemize(text).unwrap();
            output.extend(value.phonemes.chars());
            for token in value.tokens {
                output.extend(token.phonemes.chars());
            }
        }
        output
    }

    fn prepare(document: &NarrationSourceDocument, extra: &[&str]) -> PreparedDocument {
        let g2p = EnglishG2p::new();
        let mut texts = document
            .blocks
            .iter()
            .map(|block| block.display_text.as_str())
            .collect::<Vec<_>>();
        texts.extend_from_slice(extra);
        prepare_document(
            document,
            &MisakiCorpus::load_us(),
            &vocabulary(&g2p, &texts),
            &g2p,
        )
        .unwrap()
    }

    fn synthetic_resolved(text: &str, phones_per_word: usize) -> ResolvedAcousticGroup {
        let words = word_spans(text)
            .into_iter()
            .enumerate()
            .map(|(id, span)| ResolvedWord {
                byte_end: span.byte_end,
                byte_start: span.byte_start,
                mapping_origin: MappingOrigin::SourceWord,
                phonemes: "a".repeat(phones_per_word),
                pronunciation_origin: PronunciationOrigin::LocalG2p,
                source_block_ids: vec![0],
                source_word_ids: vec![id],
                target_ids: vec![format!("word:{id}")],
                text: span.text.to_string(),
            })
            .collect::<Vec<_>>();
        let vocabulary = "a;:,.!?—… ".chars().collect::<HashSet<_>>();
        let phonemes = join_group_phonemes(text, &words, &vocabulary).unwrap();
        ResolvedAcousticGroup {
            block_range: [0, 0],
            id: 0,
            phonemes,
            text: text.to_string(),
            words,
        }
    }

    fn valid_output() -> &'static str {
        r#"{"v":6,"g":[{"i":0,"s":[],"p":[{"i":0,"k":"r","x":"onyx"}]}]}"#
    }

    #[test]
    fn tokenizer_preserves_unicode_joiners_and_utf16_offsets() {
        let text = "😀 Café foo_bar don’t A.B";
        let document = document(vec![("paragraph", text)]);
        let prepared = prepare(&document, &[]);
        assert_eq!(prepared.source_words[0].display_start_utf16, 3);
        assert_eq!(prepared.source_words[0].text, "Café");
        assert_eq!(
            word_spans(text)
                .iter()
                .map(|word| word.text)
                .collect::<Vec<_>>(),
            ["Café", "foo_bar", "don’t", "A.B"]
        );
    }

    #[test]
    fn sentence_boundaries_suppress_abbreviations_and_versions() {
        let resolved = synthetic_resolved("Dr. Smith explains v2.1 clearly. Next step works.", 2);
        assert_eq!(sentence_word_ends(&resolved.text, &resolved.words), [5, 8]);
    }

    #[test]
    fn long_sentence_uses_phrase_breaks_and_preserves_word_alignment() {
        let clause = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
        let text = format!("{}.", vec![clause; 12].join(", "));
        let resolved = synthetic_resolved(&text, 4);
        assert!(resolved.phonemes.chars().count() > 500);
        let vocabulary = "a;:,.!?—… ".chars().collect::<HashSet<_>>();
        let groups = split_resolved_group(resolved.clone(), &vocabulary).unwrap();
        assert!(groups.len() > 1);
        assert!(
            groups
                .iter()
                .all(|group| group.phonemes.chars().count() <= ACOUSTIC_GROUP_PHONEME_LIMIT)
        );
        assert!(
            groups
                .iter()
                .take(groups.len() - 1)
                .all(|group| group.text.ends_with(','))
        );
        assert_eq!(
            groups
                .iter()
                .flat_map(|group| group.words.iter().map(|word| word.source_word_ids[0]))
                .collect::<Vec<_>>(),
            (0..resolved.words.len()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn sentences_pack_by_exact_phoneme_count_below_the_operating_limit() {
        let sentence = "Alpha beta gamma delta epsilon zeta eta theta iota kappa";
        let text = format!("{}.", vec![sentence; 8].join(". "));
        let resolved = synthetic_resolved(&text, 4);
        let vocabulary = "a;:,.!?—… ".chars().collect::<HashSet<_>>();
        let groups = split_resolved_group(resolved, &vocabulary).unwrap();
        assert!(groups.len() >= 2);
        assert!(groups.iter().all(|group| {
            group.text.ends_with('.')
                && group.phonemes.chars().count() <= ACOUSTIC_GROUP_PHONEME_LIMIT
        }));
    }

    #[test]
    fn one_long_source_block_resolves_to_multiple_aligned_acoustic_groups() {
        let text = format!("{}.", vec!["hello"; 140].join(", "));
        let document = document(vec![("paragraph", &text)]);
        let g2p = EnglishG2p::new();
        let vocabulary = vocabulary(&g2p, &[&text]);
        let corpus = MisakiCorpus::load_us();
        let prepared = prepare_document(&document, &corpus, &vocabulary, &g2p).unwrap();
        assert_eq!(prepared.groups.len(), 1);
        assert!(!prepared.groups[0].model_required());
        let groups = resolve_group(
            None,
            &prepared.groups[0],
            &prepared,
            &document,
            &corpus,
            &g2p,
            &vocabulary,
        )
        .unwrap();
        assert!(groups.len() > 1);
        assert!(groups.iter().all(|group| {
            group.block_range == [0, 0]
                && group.phonemes.chars().count() <= ACOUSTIC_GROUP_PHONEME_LIMIT
        }));
        assert_eq!(
            groups
                .iter()
                .flat_map(|group| group.words.iter().flat_map(|word| &word.source_word_ids))
                .copied()
                .collect::<Vec<_>>(),
            (0..prepared.source_words.len()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn compact_input_contains_only_hard_groups_and_sparse_risks() {
        let document = document(vec![
            ("paragraph", "Hello world."),
            ("paragraph", "Record XYZAPI through nginx."),
        ]);
        let prepared = prepare(&document, &[]);
        let compact: Value = serde_json::from_str(&prepared.compact_json).unwrap();
        assert_eq!(compact["v"], 6);
        assert_eq!(compact["b"].as_array().unwrap().len(), 2);
        assert!(!compact["g"].as_array().unwrap().is_empty());
        let risks = compact["g"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|group| group["q"].as_array().unwrap())
            .collect::<Vec<_>>();
        assert!(risks.iter().any(|risk| risk["x"] == "Record"));
        assert!(risks.iter().any(|risk| risk["x"] == "XYZAPI"));
        assert!(!risks.iter().any(|risk| risk["x"] == "nginx"));
        assert!(risks.iter().all(|risk| risk.get("p").is_some()));
    }

    #[test]
    fn connected_technical_expression_is_one_server_owned_risk() {
        let text = "Call serde_json::from_value safely.";
        let mut document = document(vec![("paragraph", text)]);
        let start = text.find("serde_json").unwrap();
        let end = start + "serde_json::from_value".len();
        document.targets.push(json!({
            "blockId": "md:0",
            "displayEnd": text[..end].encode_utf16().count(),
            "displayStart": text[..start].encode_utf16().count(),
            "id": "expression:0",
            "kind": "textRange",
            "role": "inlineCode",
        }));
        let prepared = prepare(&document, &[]);
        let risk = prepared
            .risks
            .iter()
            .find(|risk| risk.text.contains("serde_json"))
            .unwrap();
        assert_eq!(risk.text, "serde_json::from_value");
        assert_eq!(risk.source_word_ids.len(), 2);
    }

    #[test]
    fn incremental_parser_is_identical_at_every_ascii_split_point() {
        let output = valid_output();
        for split in 0..=output.len() {
            let mut parser = IncrementalGroupParser::new();
            let mut groups = parser.push(&output[..split]).unwrap();
            groups.extend(parser.push(&output[split..]).unwrap());
            assert_eq!(groups.len(), 1, "split {split}");
            assert_eq!(parser.finish(output).unwrap().groups.len(), 1);
        }
    }

    #[test]
    fn parser_rejects_unknown_envelope_and_duplicate_keys() {
        let mut parser = IncrementalGroupParser::new();
        assert!(parser.push(r#"{"x":6,"g":[]}"#).is_err());
        let mut parser = IncrementalGroupParser::new();
        assert!(
            parser
                .push(r#"{"v":6,"g":[{"i":0,"i":0,"s":[],"p":[]}]}"#)
                .is_err()
        );
    }

    #[test]
    fn sparse_alias_and_replacement_preserve_server_alignment() {
        let document = document(vec![("paragraph", "The lead pipe passes ONNXX output.")]);
        let g2p = EnglishG2p::new();
        let vocabulary = vocabulary(&g2p, &["The lead pipe passes ONNXX output.", "led", "onyx"]);
        let prepared =
            prepare_document(&document, &MisakiCorpus::load_us(), &vocabulary, &g2p).unwrap();
        let lead = prepared
            .risks
            .iter()
            .find(|risk| risk.text == "lead")
            .unwrap();
        let onnx = prepared
            .risks
            .iter()
            .find(|risk| risk.text == "ONNXX")
            .unwrap();
        let group = PatchGroup {
            id: prepared.groups[0].id,
            summaries: Vec::new(),
            patches: vec![
                PronunciationPatch {
                    risk_id: lead.id,
                    kind: PatchKind::AudioAlias,
                    text: "led".to_string(),
                },
                PronunciationPatch {
                    risk_id: onnx.id,
                    kind: PatchKind::TranscriptReplacement,
                    text: "onyx".to_string(),
                },
            ],
        };
        let resolved = resolve_group(
            Some(&group),
            &prepared.groups[0],
            &prepared,
            &document,
            &MisakiCorpus::load_us(),
            &g2p,
            &vocabulary,
        )
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
        assert!(resolved.text.contains("lead pipe"));
        assert!(resolved.text.contains("onyx output"));
        let lead_word = resolved
            .words
            .iter()
            .find(|word| word.text == "lead")
            .unwrap();
        assert_eq!(lead_word.source_word_ids, lead.source_word_ids);
        assert!(matches!(
            lead_word.pronunciation_origin,
            PronunciationOrigin::SolAudioAlias
        ));
        let onyx = resolved
            .words
            .iter()
            .find(|word| word.text == "onyx")
            .unwrap();
        assert_eq!(onyx.source_word_ids, onnx.source_word_ids);
        assert!(matches!(onyx.mapping_origin, MappingOrigin::SourceSemantic));
    }

    #[test]
    fn summary_blocks_require_exact_server_ids() {
        let document = document(vec![("code", "if ready { run(); }")]);
        let g2p = EnglishG2p::new();
        let vocabulary = vocabulary(&g2p, &["if ready { run(); }", "Run when ready."]);
        let prepared =
            prepare_document(&document, &MisakiCorpus::load_us(), &vocabulary, &g2p).unwrap();
        let group = PatchGroup {
            id: 0,
            summaries: vec![SummaryPatch {
                block_id: 0,
                text: "Run when ready.".to_string(),
            }],
            patches: Vec::new(),
        };
        validate_patch_group(&group, &prepared.groups[0], &prepared, &g2p, &vocabulary).unwrap();
        let mut wrong = group.clone();
        wrong.summaries[0].block_id = 1;
        assert!(
            validate_patch_group(&wrong, &prepared.groups[0], &prepared, &g2p, &vocabulary)
                .is_err()
        );
    }

    #[test]
    fn prompt_and_schema_are_valid_versioned_assets() {
        assert_eq!(asset_sha256(PRIMARY_INSTRUCTIONS).len(), 64);
        assert_eq!(asset_sha256(PRIMARY_SCHEMA_JSON).len(), 64);
        let schema = primary_schema();
        assert_eq!(schema["properties"]["v"]["const"], 6);
        assert!(schema["properties"]["g"]["items"].is_object());
    }

    #[test]
    fn patch_groups_can_arrive_out_of_acoustic_order() {
        let mut groups = BTreeMap::new();
        groups.insert(
            3,
            PatchGroup {
                id: 3,
                summaries: Vec::new(),
                patches: Vec::new(),
            },
        );
        groups.insert(
            1,
            PatchGroup {
                id: 1,
                summaries: Vec::new(),
                patches: Vec::new(),
            },
        );
        assert_eq!(groups.keys().copied().collect::<Vec<_>>(), [1, 3]);
    }

    #[test]
    fn hard_group_ids_can_skip_an_immediate_local_group() {
        let common = "hello world ".repeat(22);
        let document = document(vec![
            ("paragraph", common.trim()),
            ("paragraph", "XYZAPI needs a contextual pronunciation."),
        ]);
        let prepared = prepare(&document, &[]);
        assert_eq!(prepared.groups.len(), 2);
        assert!(!prepared.groups[0].model_required());
        assert!(prepared.groups[1].model_required());
        assert_eq!(prepared.hard_group_ids, [1]);
    }

    #[test]
    #[ignore = "requires installed Kokoro vocabulary"]
    fn installed_vocabulary_accepts_reviewed_aliases_without_model_work() {
        let directory = std::path::PathBuf::from(
            std::env::var("REMUX_TTS_MODEL_DIR").expect("REMUX_TTS_MODEL_DIR is required"),
        );
        let raw: HashMap<String, i64> =
            serde_json::from_slice(&std::fs::read(directory.join("vocab.json")).unwrap()).unwrap();
        let vocabulary = raw
            .into_keys()
            .map(|key| key.chars().next().unwrap())
            .collect::<HashSet<_>>();
        let document = document(vec![(
            "paragraph",
            "Kokoro, Misaki, ONNX, nginx, Remux, G2P, SQLite, WKWebView, serde, and Sol.",
        )]);
        let g2p = EnglishG2p::new();
        let corpus = MisakiCorpus::load_us();
        let prepared = prepare_document(&document, &corpus, &vocabulary, &g2p).unwrap();
        assert!(prepared.hard_group_ids.is_empty());
        let resolved = resolve_group(
            None,
            &prepared.groups[0],
            &prepared,
            &document,
            &corpus,
            &g2p,
            &vocabulary,
        )
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
        assert!(
            resolved
                .words
                .iter()
                .filter(|word| {
                    matches!(
                        word.pronunciation_origin,
                        PronunciationOrigin::ReviewedLexicon
                    )
                })
                .count()
                >= 10
        );
    }
}
