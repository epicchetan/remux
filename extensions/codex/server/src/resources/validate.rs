use std::collections::HashSet;
use std::fs;
use std::time::UNIX_EPOCH;

use serde_json::Value;

use super::CodexTranscriptServer;
use crate::history::{build_session_index, discover_session_files, file_revision};
use crate::transcript::{ValidationOptions, ValidationReport};
use crate::util::canonical_json;

impl CodexTranscriptServer {
    pub fn validate_real_transcripts(
        &mut self,
        options: ValidationOptions,
    ) -> Result<ValidationReport, String> {
        let mut files = discover_session_files(&self.codex_home)?;
        files.sort_by_key(|path| {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs())
                .unwrap_or(0)
        });
        files.reverse();
        files.truncate(options.limit);

        let mut report = ValidationReport {
            codex_home: self.codex_home.display().to_string(),
            scanned_files: 0,
            threads_with_turns: 0,
            turns_checked: 0,
            work_details_checked: 0,
            duplicate_segment_failures: 0,
            duplicate_message_warnings: 0,
            invalid_user_input_failures: 0,
            missing_work_details_failures: 0,
            rollback_hidden_turn_failures: 0,
            errors: Vec::new(),
        };

        for path in files {
            report.scanned_files += 1;
            let file_revision = match file_revision(&path) {
                Ok(revision) => revision,
                Err(error) => {
                    report.errors.push(format!("{}: {error}", path.display()));
                    continue;
                }
            };
            let index = match build_session_index(&path) {
                Ok(index) => index,
                Err(error) => {
                    report.errors.push(format!("{}: {error}", path.display()));
                    continue;
                }
            };
            if index.visible_turn_ids.is_empty() {
                continue;
            }
            report.threads_with_turns += 1;
            let visible = index.visible_turn_ids.iter().collect::<HashSet<_>>();
            for turn_id in index.turns.keys() {
                if !visible.contains(turn_id) {
                    report.rollback_hidden_turn_failures += 1;
                }
            }

            for turn_id in sample_turn_ids(&index.visible_turn_ids, 8) {
                let thread_id = index.session_id.as_deref().unwrap_or("");
                let projected =
                    match self.project_turn(thread_id, &path, &file_revision, &index, &turn_id) {
                        Ok(projected) => projected,
                        Err(error) => {
                            report.errors.push(format!(
                                "{} turn {}: {error}",
                                path.display(),
                                turn_id
                            ));
                            continue;
                        }
                    };
                report.turns_checked += 1;

                let segments = projected
                    .turn
                    .get("segments")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut seen = HashSet::new();
                for segment in &segments {
                    let id = segment.get("id").and_then(Value::as_str).unwrap_or("");
                    if !seen.insert(id.to_string()) {
                        report.duplicate_segment_failures += 1;
                    }
                    if segment.get("type").and_then(Value::as_str) == Some("work") {
                        if projected.details_by_segment_id.contains_key(id) {
                            report.work_details_checked += 1;
                            if let Some(details) = projected.details_by_segment_id.get(id) {
                                report.invalid_user_input_failures +=
                                    invalid_work_details_user_input_count(details, &projected);
                            }
                        } else {
                            report.missing_work_details_failures += 1;
                        }
                    } else if segment.get("type").and_then(Value::as_str) == Some("userMessage") {
                        report.invalid_user_input_failures +=
                            invalid_user_content_count(segment.get("content"));
                    }
                }

                report.duplicate_message_warnings += duplicate_message_count(&segments);
            }
        }

        Ok(report)
    }
}

fn invalid_work_details_user_input_count(
    details: &Value,
    projected: &crate::projection::ProjectedTurn,
) -> usize {
    details
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("userMessage"))
        .filter_map(|entry| {
            entry
                .get("itemId")
                .and_then(Value::as_str)
                .and_then(|item_id| projected.work_items_by_id.get(item_id))
                .and_then(|item| item.get("item"))
        })
        .map(|item| invalid_user_content_count(item.get("content")))
        .sum()
}

fn invalid_user_content_count(content: Option<&Value>) -> usize {
    content
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| !is_valid_user_input(part))
        .count()
}

fn is_valid_user_input(part: &Value) -> bool {
    match part.get("type").and_then(Value::as_str) {
        Some("text") => {
            part.get("text").and_then(Value::as_str).is_some()
                && part
                    .get("text_elements")
                    .and_then(Value::as_array)
                    .is_some()
        }
        Some("image") => part.get("url").and_then(Value::as_str).is_some(),
        Some("localImage") => part.get("path").and_then(Value::as_str).is_some(),
        Some("mention") | Some("skill") => {
            part.get("name").and_then(Value::as_str).is_some()
                && part.get("path").and_then(Value::as_str).is_some()
        }
        _ => false,
    }
}

fn sample_turn_ids(turn_ids: &[String], max_count: usize) -> Vec<String> {
    if turn_ids.len() <= max_count {
        return turn_ids.to_vec();
    }
    let mut result = Vec::new();
    result.extend(turn_ids.iter().rev().take(max_count / 2).cloned());
    let step = (turn_ids.len() / (max_count - result.len()).max(1)).max(1);
    let mut index = 0usize;
    while result.len() < max_count && index < turn_ids.len() {
        let turn_id = turn_ids[index].clone();
        if !result.contains(&turn_id) {
            result.push(turn_id);
        }
        index += step;
    }
    result
}

fn duplicate_message_count(segments: &[Value]) -> usize {
    let mut seen = HashSet::new();
    let mut duplicates = 0;
    for segment in segments {
        let kind = segment.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "userMessage" && kind != "assistantMessage" {
            continue;
        }
        let key = if kind == "assistantMessage" {
            format!(
                "{kind}:{}",
                segment.get("text").and_then(Value::as_str).unwrap_or("")
            )
        } else {
            format!(
                "{kind}:{}",
                canonical_json(segment.get("content").unwrap_or(&Value::Null))
            )
        };
        if !seen.insert(key) {
            duplicates += 1;
        }
    }
    duplicates
}
