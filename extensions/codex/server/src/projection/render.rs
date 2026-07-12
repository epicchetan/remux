use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::media::rewrite_render_media;
use crate::util::stable_revision_value;

const DEFAULT_GROUP_ROWS: usize = 200;

pub(super) struct RenderProjection {
    pub(super) entry_details_by_key: HashMap<String, Value>,
    pub(super) frame: Value,
    pub(super) work_groups_by_key: HashMap<String, Value>,
}

pub(super) fn build_render_projection(
    turn: &Value,
    details_by_segment_id: &HashMap<String, Value>,
    work_items_by_id: &HashMap<String, Value>,
) -> RenderProjection {
    let mut entry_details_by_key = HashMap::new();
    let mut work_groups_by_key = HashMap::new();
    let mut segments = Vec::new();

    for segment in turn
        .get("segments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if segment.get("type").and_then(Value::as_str) != Some("work") {
            segments.push(segment.clone());
            continue;
        }

        let segment_id = segment.get("id").and_then(Value::as_str).unwrap_or("work");
        let timeline = details_by_segment_id
            .get(segment_id)
            .and_then(|details| details.get("entries"))
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| {
                        render_timeline_entry(
                            segment_id,
                            entry,
                            work_items_by_id,
                            &mut work_groups_by_key,
                            &mut entry_details_by_key,
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let layout_revision = stable_revision_value(&json!([
            "work-render-layout-v2",
            segment_id,
            segment.get("state"),
            segment.get("durationMs"),
            timeline,
        ]));
        segments.push(json!({
            "durationMs": segment.get("durationMs").cloned().unwrap_or(Value::Null),
            "id": segment_id,
            "layoutRevision": layout_revision,
            "revision": segment.get("revision").cloned().unwrap_or(Value::Null),
            "state": segment.get("state").cloned().unwrap_or_else(|| json!("completed")),
            "timeline": timeline,
            "type": "work",
        }));
    }

    let mut render_segments = Value::Array(segments);
    rewrite_render_media(&mut render_segments);
    let Value::Array(segments) = render_segments else {
        unreachable!("render segments remain an array");
    };

    let layout_segments = segments
        .iter()
        .map(
            |segment| match segment.get("type").and_then(Value::as_str) {
                Some("assistantMessage" | "userMessage") => segment.clone(),
                Some("work" | "compaction") => json!({
                    "id": segment.get("id").cloned().unwrap_or(Value::Null),
                    "type": segment.get("type").cloned().unwrap_or(Value::Null),
                }),
                _ => segment.clone(),
            },
        )
        .collect::<Vec<_>>();
    let frame_body = json!({
        "completedAt": turn.get("completedAt").cloned().unwrap_or(Value::Null),
        "durationMs": turn.get("durationMs").cloned().unwrap_or(Value::Null),
        "error": turn.get("error").cloned().unwrap_or(Value::Null),
        "id": turn.get("id").cloned().unwrap_or(Value::Null),
        "segments": segments,
        "startedAt": turn.get("startedAt").cloned().unwrap_or(Value::Null),
        "status": turn.get("status").cloned().unwrap_or_else(|| json!("completed")),
    });
    let render_revision = stable_revision_value(&json!(["turn-render-v2", frame_body]));
    let layout_revision = stable_revision_value(&json!([
        "turn-layout-v2",
        turn.get("id"),
        turn.get("status"),
        turn.get("error"),
        layout_segments,
    ]));
    let mut frame = frame_body;
    frame["layoutRevision"] = Value::String(layout_revision);
    frame["renderRevision"] = Value::String(render_revision);

    RenderProjection {
        entry_details_by_key,
        frame,
        work_groups_by_key,
    }
}

fn render_timeline_entry(
    segment_id: &str,
    entry: &Value,
    work_items_by_id: &HashMap<String, Value>,
    work_groups_by_key: &mut HashMap<String, Value>,
    entry_details_by_key: &mut HashMap<String, Value>,
) -> Option<Value> {
    match entry.get("type").and_then(Value::as_str) {
        Some("message" | "userMessage" | "compaction") => {
            let item_id = entry.get("itemId").and_then(Value::as_str)?;
            let resource = work_items_by_id.get(item_id)?;
            let mut item = resource.get("item")?.clone();
            item["revision"] = resource
                .get("revision")
                .cloned()
                .unwrap_or_else(|| Value::String(stable_revision_value(&item)));
            Some(item)
        }
        Some("group") => render_group_entry(
            segment_id,
            entry,
            work_items_by_id,
            work_groups_by_key,
            entry_details_by_key,
        ),
        _ => None,
    }
}

fn render_group_entry(
    segment_id: &str,
    entry: &Value,
    work_items_by_id: &HashMap<String, Value>,
    work_groups_by_key: &mut HashMap<String, Value>,
    entry_details_by_key: &mut HashMap<String, Value>,
) -> Option<Value> {
    let group = entry.get("group")?;
    let group_id = entry.get("id").and_then(Value::as_str)?;
    let group_type = group.get("type").and_then(Value::as_str).unwrap_or("tools");
    let title = group
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Tools");
    let mut rows = Vec::new();
    for item_id in group
        .get("itemIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let Some(resource) = work_items_by_id.get(item_id) else {
            continue;
        };
        let Some(item) = resource.get("item") else {
            continue;
        };
        append_item_rows(segment_id, group_id, item, &mut rows, entry_details_by_key);
    }

    let revision = stable_revision_value(&json!([
        "work-group-v2",
        segment_id,
        group_id,
        group_type,
        title,
        rows,
    ]));
    let layout_revision = stable_revision_value(&json!(["work-group-layout-v2", group_id, rows,]));
    let status = aggregate_status(&rows);
    let row_count = rows.len();
    let summary = summarize_group(group_type, &rows);
    let resource = json!({
        "groupId": group_id,
        "layoutRevision": layout_revision,
        "revision": revision,
        "rows": rows,
        "segmentId": segment_id,
        "title": title,
        "type": group_type,
    });
    work_groups_by_key.insert(group_key(segment_id, group_id), resource);

    Some(json!({
        "groupType": group_type,
        "hasMoreRows": row_count > DEFAULT_GROUP_ROWS,
        "id": group_id,
        "revision": revision,
        "rowCount": row_count,
        "status": status,
        "summary": summary,
        "title": title,
        "type": "group",
    }))
}

fn summarize_group(group_type: &str, rows: &[Value]) -> Value {
    let mut commands = 0usize;
    let mut file_names = Vec::new();
    let mut seen_files = HashSet::new();
    let mut reads = 0usize;
    let mut searches = 0usize;
    let mut tools = 0usize;

    for row in rows {
        match group_type {
            "files" => {
                let path = row.get("path").and_then(Value::as_str).unwrap_or("");
                if !path.is_empty() && seen_files.insert(path.to_string()) {
                    file_names.push(path.to_string());
                }
            }
            "activity" => match row.get("kind").and_then(Value::as_str) {
                Some("command") => commands += 1,
                Some("read" | "list") => reads += 1,
                Some("search" | "webSearch") => searches += 1,
                _ => tools += 1,
            },
            "tools" => {
                let label = row
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if matches!(
                    label.strip_prefix("ran ").unwrap_or(label.as_str()),
                    "exec" | "exec_command" | "command"
                ) {
                    commands += 1;
                } else {
                    tools += 1;
                }
            }
            _ => {}
        }
    }

    let file_count = if group_type == "files" {
        file_names.len()
    } else {
        0
    };
    json!({
        "commands": commands,
        "fileNames": file_names,
        "files": file_count,
        "reads": reads,
        "searches": searches,
        "tools": tools,
    })
}

fn append_item_rows(
    segment_id: &str,
    group_id: &str,
    item: &Value,
    rows: &mut Vec<Value>,
    entry_details_by_key: &mut HashMap<String, Value>,
) {
    match item.get("type").and_then(Value::as_str) {
        Some("activity") => {
            let Some(activity) = item.get("activity") else {
                return;
            };
            let row_id = activity
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("activity");
            let has_detail = non_empty(activity.get("detail")) || non_empty(activity.get("output"));
            let summary_body = json!({
                "command": activity.get("command").cloned().unwrap_or(Value::Null),
                "durationMs": activity.get("durationMs").cloned().unwrap_or(Value::Null),
                "exitCode": activity.get("exitCode").cloned().unwrap_or(Value::Null),
                "hasDetail": has_detail,
                "id": row_id,
                "kind": activity.get("kind").cloned().unwrap_or_else(|| json!("command")),
                "path": activity.get("path").cloned().unwrap_or(Value::Null),
                "status": activity.get("status").cloned().unwrap_or_else(|| json!("completed")),
                "text": activity.get("text").cloned().unwrap_or_else(|| json!("Activity")),
                "type": "activity",
            });
            push_row_and_detail(
                segment_id,
                group_id,
                row_id,
                summary_body,
                json!({
                    "detail": activity.get("detail").cloned().unwrap_or(Value::Null),
                    "output": activity.get("output").cloned().unwrap_or(Value::Null),
                    "type": "activity",
                }),
                rows,
                entry_details_by_key,
            );
        }
        Some("fileChanges") => {
            for file in item
                .get("files")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let row_id = file.get("id").and_then(Value::as_str).unwrap_or("file");
                let summary_body = json!({
                    "additions": file.get("additions").cloned().unwrap_or_else(|| json!(0)),
                    "deletions": file.get("deletions").cloned().unwrap_or_else(|| json!(0)),
                    "hasDetail": non_empty(file.get("diff")),
                    "id": row_id,
                    "kind": file.get("kind").cloned().unwrap_or_else(|| json!("edited")),
                    "path": file.get("path").cloned().unwrap_or_else(|| json!("")),
                    "status": file.get("status").cloned().unwrap_or_else(|| json!("completed")),
                    "type": "fileChange",
                });
                push_row_and_detail(
                    segment_id,
                    group_id,
                    row_id,
                    summary_body,
                    json!({
                        "diff": file.get("diff").cloned().unwrap_or_else(|| json!("")),
                        "type": "fileChange",
                    }),
                    rows,
                    entry_details_by_key,
                );
            }
        }
        Some("tool") => {
            let Some(row) = item.get("row") else {
                return;
            };
            let row_id = row.get("id").and_then(Value::as_str).unwrap_or("tool");
            let media_count = row
                .get("media")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let has_detail =
                non_empty(row.get("detail")) || non_empty(row.get("result")) || media_count > 0;
            let summary_body = json!({
                "category": row.get("category").cloned().unwrap_or_else(|| json!("generic")),
                "detailPreview": preview(row.get("detail").and_then(Value::as_str)),
                "hasDetail": has_detail,
                "id": row_id,
                "label": row.get("label").cloned().unwrap_or_else(|| json!("Tool")),
                "mediaCount": media_count,
                "status": row.get("status").cloned().unwrap_or_else(|| json!("completed")),
                "type": "tool",
            });
            push_row_and_detail(
                segment_id,
                group_id,
                row_id,
                summary_body,
                json!({
                    "detail": row.get("detail").cloned().unwrap_or(Value::Null),
                    "media": row.get("media").cloned().unwrap_or_else(|| json!([])),
                    "result": row.get("result").cloned().unwrap_or(Value::Null),
                    "type": "tool",
                }),
                rows,
                entry_details_by_key,
            );
        }
        _ => {}
    }
}

fn push_row_and_detail(
    segment_id: &str,
    group_id: &str,
    row_id: &str,
    mut summary: Value,
    detail: Value,
    rows: &mut Vec<Value>,
    entry_details_by_key: &mut HashMap<String, Value>,
) {
    let revision = stable_revision_value(&json!(["work-row-v2", summary]));
    summary["revision"] = Value::String(revision);
    rows.push(summary);

    let detail_revision = stable_revision_value(&json!(["work-entry-detail-v2", detail]));
    let layout_revision = stable_revision_value(&json!(["work-entry-detail-layout-v2", detail]));
    entry_details_by_key.insert(
        entry_detail_key(segment_id, group_id, row_id),
        json!({
            "detail": detail,
            "groupId": group_id,
            "layoutRevision": layout_revision,
            "revision": detail_revision,
            "rowId": row_id,
            "segmentId": segment_id,
        }),
    );
}

fn aggregate_status(rows: &[Value]) -> &'static str {
    let statuses = rows
        .iter()
        .filter_map(|row| row.get("status").and_then(Value::as_str));
    let mut saw_running = false;
    let mut saw_interrupted = false;
    for status in statuses {
        match status {
            "failed" | "error" => return "failed",
            "inProgress" | "running" => saw_running = true,
            "interrupted" | "cancelled" => saw_interrupted = true,
            _ => {}
        }
    }
    if saw_running {
        "running"
    } else if saw_interrupted {
        "interrupted"
    } else {
        "completed"
    }
}

fn non_empty(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(value)) => !value.is_empty(),
        Some(Value::Object(value)) => !value.is_empty(),
        Some(_) => true,
    }
}

fn preview(value: Option<&str>) -> Value {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Value::Null;
    };
    Value::String(value.chars().take(160).collect())
}

pub(crate) fn group_key(segment_id: &str, group_id: &str) -> String {
    format!("{segment_id}:{group_id}")
}

pub(crate) fn entry_detail_key(segment_id: &str, group_id: &str, row_id: &str) -> String {
    format!("{segment_id}:{group_id}:{row_id}")
}
