use std::cmp::Ordering;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::narration::NarrationSourceBlock;

pub(crate) const MAX_MAPPING_WORDS_PER_UNIT: usize = 2_048;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct SourceMappingStats {
    pub(crate) block_fallback_words: usize,
    pub(crate) exact_word_mappings: usize,
    pub(crate) semantic_run_mappings: usize,
}

#[derive(Clone, Debug)]
struct DisplayWord {
    end: usize,
    id: String,
    key: String,
    start: usize,
    text: String,
}

#[derive(Clone, Debug)]
struct SpokenWord {
    byte_end: usize,
    byte_start: usize,
    key: String,
}

#[derive(Clone, Debug)]
struct SemanticTarget {
    end: usize,
    id: String,
    priority: u8,
    start: usize,
}

pub(crate) fn verbatim_alignment_hints(
    block: &NarrationSourceBlock,
    targets: &[Value],
) -> Result<(Vec<Value>, SourceMappingStats), String> {
    let words = display_words(block, targets)?;
    let hints = words
        .iter()
        .map(|word| {
            json!({
                "origin": "sourceWord",
                "spokenText": word.text,
                "targetIds": [word.id],
            })
        })
        .collect::<Vec<_>>();
    Ok((
        hints,
        SourceMappingStats {
            exact_word_mappings: words.len(),
            ..SourceMappingStats::default()
        },
    ))
}

pub(crate) fn normalized_alignment_hints(
    block: &NarrationSourceBlock,
    spoken_text: &str,
    targets: &[Value],
) -> Result<(Vec<Value>, SourceMappingStats), String> {
    let display = display_words(block, targets)?;
    let spoken = spoken_words(spoken_text);
    if display.len() > MAX_MAPPING_WORDS_PER_UNIT || spoken.len() > MAX_MAPPING_WORDS_PER_UNIT {
        eprintln!(
            "[codex:narration] source mapping capped block={} display_words={} spoken_words={}",
            block.id,
            display.len(),
            spoken.len(),
        );
        return Ok((
            Vec::new(),
            SourceMappingStats {
                block_fallback_words: spoken.len(),
                ..SourceMappingStats::default()
            },
        ));
    }

    let matches = lcs_matches(&spoken, &display);
    let semantic = semantic_targets(block, targets)?;
    let mut hints = Vec::new();
    let mut stats = SourceMappingStats::default();
    let mut spoken_cursor = 0;
    let mut display_cursor = 0;

    for &(spoken_match, display_match) in matches
        .iter()
        .chain(std::iter::once(&(spoken.len(), display.len())))
    {
        if spoken_cursor < spoken_match {
            let (display_start, display_end) = if display_cursor < display_match {
                (
                    display[display_cursor].start,
                    display[display_match - 1].end,
                )
            } else {
                let boundary = display
                    .get(display_match)
                    .map(|word| word.start)
                    .or_else(|| {
                        display_cursor
                            .checked_sub(1)
                            .map(|index| display[index].end)
                    })
                    .unwrap_or(0);
                (boundary, boundary)
            };
            if let Some(target) = select_semantic_target(&semantic, display_start, display_end) {
                let byte_start = spoken[spoken_cursor].byte_start;
                let byte_end = spoken[spoken_match - 1].byte_end;
                hints.push(json!({
                    "origin": "sourceSemantic",
                    "spokenText": &spoken_text[byte_start..byte_end],
                    "targetIds": [target.id],
                }));
                stats.semantic_run_mappings += spoken_match - spoken_cursor;
            } else {
                stats.block_fallback_words += spoken_match - spoken_cursor;
            }
        }

        if spoken_match < spoken.len() {
            hints.push(json!({
                "origin": "sourceWord",
                "spokenText": &spoken_text[spoken[spoken_match].byte_start..spoken[spoken_match].byte_end],
                "targetIds": [display[display_match].id],
            }));
            stats.exact_word_mappings += 1;
            spoken_cursor = spoken_match + 1;
            display_cursor = display_match + 1;
        }
    }

    Ok((hints, stats))
}

fn word_regex() -> &'static Regex {
    static WORD_REGEX: OnceLock<Regex> = OnceLock::new();
    WORD_REGEX.get_or_init(|| {
        Regex::new(r"[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*")
            .expect("renderer narration word regex must compile")
    })
}

fn spoken_words(text: &str) -> Vec<SpokenWord> {
    word_regex()
        .find_iter(text)
        .map(|matched| SpokenWord {
            byte_end: matched.end(),
            byte_start: matched.start(),
            key: comparison_key(matched.as_str()),
        })
        .collect()
}

fn display_words(
    block: &NarrationSourceBlock,
    targets: &[Value],
) -> Result<Vec<DisplayWord>, String> {
    let mut words = targets
        .iter()
        .filter(|target| {
            target.get("blockId").and_then(Value::as_str) == Some(block.id.as_str())
                && target.get("kind").and_then(Value::as_str) == Some("textRange")
                && target.get("role").and_then(Value::as_str) == Some("word")
        })
        .map(|target| {
            let id = target
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "word narration target is missing id".to_string())?
                .to_string();
            let start = target_usize(target, "displayStart")?;
            let end = target_usize(target, "displayEnd")?;
            let text = utf16_slice(&block.display_text, start, end)
                .ok_or_else(|| format!("word narration target {id} has an invalid UTF-16 range"))?
                .to_string();
            Ok(DisplayWord {
                end,
                id,
                key: comparison_key(&text),
                start,
                text,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    words.sort_by(|left, right| {
        (left.start, left.end, left.id.as_str()).cmp(&(right.start, right.end, right.id.as_str()))
    });
    for pair in words.windows(2) {
        if pair[0].end > pair[1].start {
            return Err(format!(
                "renderer word targets overlap in narration block {}",
                block.id
            ));
        }
    }
    Ok(words)
}

fn semantic_targets(
    block: &NarrationSourceBlock,
    targets: &[Value],
) -> Result<Vec<SemanticTarget>, String> {
    targets
        .iter()
        .filter(|target| {
            target.get("blockId").and_then(Value::as_str) == Some(block.id.as_str())
                && target.get("kind").and_then(Value::as_str) == Some("textRange")
        })
        .filter_map(|target| {
            let priority = match target.get("role").and_then(Value::as_str) {
                Some("inlineCode") => 0,
                Some("link") => 1,
                Some("expression") => 2,
                _ => return None,
            };
            Some((target, priority))
        })
        .map(|(target, priority)| {
            Ok(SemanticTarget {
                end: target_usize(target, "displayEnd")?,
                id: target
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "semantic narration target is missing id".to_string())?
                    .to_string(),
                priority,
                start: target_usize(target, "displayStart")?,
            })
        })
        .collect()
}

fn select_semantic_target(
    targets: &[SemanticTarget],
    display_start: usize,
    display_end: usize,
) -> Option<&SemanticTarget> {
    // A target that covers the whole spoken run's display range beats any
    // partial overlap, no matter how short: a two-character expression inside
    // an inline-code span must not win the span's own narration run. Among
    // covering targets the shortest is the most specific.
    let sort_key = |target: &SemanticTarget| {
        let covers = target.start <= display_start && display_end <= target.end;
        (
            !covers,
            target.end.saturating_sub(target.start),
            target.priority,
            target.start,
        )
    };
    targets
        .iter()
        .filter(|target| {
            if display_start == display_end {
                target.start <= display_start && display_start <= target.end
            } else {
                target.start < display_end && target.end > display_start
            }
        })
        .min_by(|left, right| {
            (sort_key(left), left.id.as_str()).cmp(&(sort_key(right), right.id.as_str()))
        })
}

fn lcs_matches(spoken: &[SpokenWord], display: &[DisplayWord]) -> Vec<(usize, usize)> {
    let rows = spoken.len() + 1;
    let columns = display.len() + 1;
    let mut lengths = vec![0u16; rows * columns];
    for spoken_index in (0..spoken.len()).rev() {
        for display_index in (0..display.len()).rev() {
            let index = spoken_index * columns + display_index;
            lengths[index] = if spoken[spoken_index].key == display[display_index].key {
                1 + lengths[(spoken_index + 1) * columns + display_index + 1]
            } else {
                lengths[(spoken_index + 1) * columns + display_index]
                    .max(lengths[spoken_index * columns + display_index + 1])
            };
        }
    }

    let mut matches = Vec::new();
    let mut spoken_index = 0;
    let mut display_index = 0;
    while spoken_index < spoken.len() && display_index < display.len() {
        if spoken[spoken_index].key == display[display_index].key {
            matches.push((spoken_index, display_index));
            spoken_index += 1;
            display_index += 1;
            continue;
        }
        let advance_spoken = lengths[(spoken_index + 1) * columns + display_index];
        let advance_display = lengths[spoken_index * columns + display_index + 1];
        match advance_spoken.cmp(&advance_display) {
            Ordering::Greater | Ordering::Equal => spoken_index += 1,
            Ordering::Less => display_index += 1,
        }
    }
    matches
}

fn comparison_key(value: &str) -> String {
    value.nfkc().flat_map(char::to_lowercase).collect()
}

fn target_usize(value: &Value, field: &str) -> Result<usize, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("narration target is missing {field}"))
}

fn utf16_slice(value: &str, start: usize, end: usize) -> Option<&str> {
    if start > end {
        return None;
    }
    let mut utf16 = 0;
    let mut byte_start = (start == 0).then_some(0);
    let mut byte_end = (end == 0).then_some(0);
    for (byte_index, character) in value.char_indices() {
        if utf16 == start {
            byte_start = Some(byte_index);
        }
        if utf16 == end {
            byte_end = Some(byte_index);
        }
        utf16 += character.len_utf16();
        if utf16 > end && byte_end.is_none() {
            return None;
        }
    }
    if utf16 == start {
        byte_start = Some(value.len());
    }
    if utf16 == end {
        byte_end = Some(value.len());
    }
    Some(&value[byte_start?..byte_end?])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(text: &str) -> NarrationSourceBlock {
        NarrationSourceBlock {
            display_text: text.to_string(),
            id: "md:0".to_string(),
            inline_ranges: Vec::new(),
            kind: "paragraph".to_string(),
            needs_transform: true,
            path: "0".to_string(),
            target_ids: Vec::new(),
        }
    }

    #[test]
    fn renderer_word_pattern_matches_unicode_joiners() {
        let words = spoken_words("café bars:5m foo_bar don't A.B");
        let ranges = words
            .iter()
            .map(|word| &"café bars:5m foo_bar don't A.B"[word.byte_start..word.byte_end])
            .collect::<Vec<_>>();
        assert_eq!(
            ranges,
            vec!["café", "bars", "5m", "foo_bar", "don't", "A.B"]
        );
    }

    #[test]
    fn normalized_mapping_prefers_exact_words_and_semantic_changed_run() {
        let source = block("Share one bars:5m instance");
        let targets = vec![
            json!({ "blockId": "md:0", "displayEnd": 5, "displayStart": 0, "id": "word:0", "kind": "textRange", "role": "word" }),
            json!({ "blockId": "md:0", "displayEnd": 9, "displayStart": 6, "id": "word:1", "kind": "textRange", "role": "word" }),
            json!({ "blockId": "md:0", "displayEnd": 14, "displayStart": 10, "id": "word:2", "kind": "textRange", "role": "word" }),
            json!({ "blockId": "md:0", "displayEnd": 17, "displayStart": 15, "id": "word:3", "kind": "textRange", "role": "word" }),
            json!({ "blockId": "md:0", "displayEnd": 26, "displayStart": 18, "id": "word:4", "kind": "textRange", "role": "word" }),
            json!({ "blockId": "md:0", "displayEnd": 17, "displayStart": 10, "id": "inline", "kind": "textRange", "role": "inlineCode" }),
        ];
        let (hints, stats) =
            normalized_alignment_hints(&source, "Share one five-minute bars instance", &targets)
                .unwrap();
        assert_eq!(stats.exact_word_mappings, 4);
        assert_eq!(stats.semantic_run_mappings, 1);
        assert!(hints.iter().any(
            |hint| hint["origin"] == "sourceSemantic" && hint["targetIds"] == json!(["inline"])
        ));
    }

    #[test]
    fn semantic_run_prefers_targets_covering_the_whole_run() {
        // "live_transcript.rs: filters" — one word target for the file name,
        // the inline-code span covering it, and a stray short expression
        // ("rs") inside it. The spelled-out spoken run must map to the span,
        // not the two-character overlap.
        let source = block("live_transcript.rs: filters");
        let targets = vec![
            json!({ "blockId": "md:0", "displayEnd": 18, "displayStart": 0, "id": "word:file", "kind": "textRange", "role": "word" }),
            json!({ "blockId": "md:0", "displayEnd": 27, "displayStart": 20, "id": "word:filters", "kind": "textRange", "role": "word" }),
            json!({ "blockId": "md:0", "displayEnd": 18, "displayStart": 0, "id": "inline", "kind": "textRange", "role": "inlineCode" }),
            json!({ "blockId": "md:0", "displayEnd": 18, "displayStart": 16, "id": "expr:rs", "kind": "textRange", "role": "expression" }),
        ];
        let (hints, stats) =
            normalized_alignment_hints(&source, "live transcript dot R S filters", &targets)
                .unwrap();
        assert_eq!(stats.exact_word_mappings, 1);
        assert!(stats.semantic_run_mappings > 0);
        let semantic = hints
            .iter()
            .find(|hint| hint["origin"] == "sourceSemantic")
            .expect("spelled-out file name maps to a semantic run");
        assert_eq!(semantic["targetIds"], json!(["inline"]));
    }

    #[test]
    fn utf16_slices_reject_surrogate_interiors() {
        assert_eq!(utf16_slice("a😀b", 1, 3), Some("😀"));
        assert_eq!(utf16_slice("a😀b", 2, 3), None);
    }
}
