use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use super::CodexTranscriptServer;
use crate::live_transcript::LiveTranscriptStore;
use crate::transcript::ValidationOptions;

static TEMP_SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn transcript_sync_inlines_commentary_between_work_groups() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"help"}}
{"type":"response_item","payload":{"type":"function_call","name":"first_tool","call_id":"call-1","arguments":"{}"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"one"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"I checked the first result.","phase":"commentary"}}
{"type":"response_item","payload":{"type":"function_call","name":"second_tool","call_id":"call-2","arguments":"{}"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-2","output":"two"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Done.","phase":"final_answer"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());
    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [{
                "type": "transcriptSync",
                "protocolVersion": 2,
                "projectionVersion": "turn-render-v2",
                "window": { "kind": "tail", "count": 24 }
            }]
        }))
        .expect("sync should succeed");

    let resource = &response["resources"][0];
    assert_eq!(resource["status"], json!("ok"));
    let frame = &resource["value"]["turns"][0]["frame"];
    let work = frame["segments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|segment| segment["type"] == json!("work"))
        .expect("work segment");
    let timeline = work["timeline"].as_array().expect("timeline");
    assert_eq!(timeline.len(), 3);
    assert_eq!(timeline[0]["type"], json!("group"));
    assert_eq!(timeline[1]["type"], json!("message"));
    assert_eq!(timeline[1]["text"], json!("I checked the first result."));
    assert_eq!(timeline[2]["type"], json!("group"));
    assert_ne!(timeline[0]["id"], timeline[2]["id"]);

    let known_revision = resource["value"]["turns"][0]["renderRevision"]
        .as_str()
        .unwrap();
    let unchanged = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [{
                "type": "transcriptSync",
                "protocolVersion": 2,
                "projectionVersion": "turn-render-v2",
                "window": { "kind": "tail" },
                "knownTurns": [{ "turnId": "turn-1", "renderRevision": known_revision }]
            }]
        }))
        .expect("known sync should succeed");
    assert_eq!(
        unchanged["resources"][0]["value"]["turns"][0]["status"],
        json!("notModified")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn transcript_sync_accepts_documented_camel_case_windows() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"first"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2","started_at":3}}
{"type":"event_msg","payload":{"type":"user_message","message":"second"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-2","completed_at":4,"duration_ms":1}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-3","started_at":5}}
{"type":"event_msg","payload":{"type":"user_message","message":"third"}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let range = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [{
                "type": "transcriptSync",
                "protocolVersion": 2,
                "projectionVersion": "turn-render-v2",
                "window": {
                    "kind": "range",
                    "startTurnId": "turn-2",
                    "endTurnId": "turn-3"
                }
            }]
        }))
        .expect("camelCase range window should deserialize");
    assert_eq!(
        range["resources"][0]["value"]["window"]["turnIds"],
        json!(["turn-2", "turn-3"])
    );

    let around = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [{
                "type": "transcriptSync",
                "protocolVersion": 2,
                "projectionVersion": "turn-render-v2",
                "window": {
                    "kind": "around",
                    "turnId": "turn-2",
                    "before": 1,
                    "after": 0
                }
            }]
        }))
        .expect("camelCase around window should deserialize");
    assert_eq!(
        around["resources"][0]["value"]["window"]["turnIds"],
        json!(["turn-1", "turn-2"])
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn version_two_group_and_entry_detail_are_bounded_resources() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"help"}}
{"type":"response_item","payload":{"type":"function_call","name":"a_tool","call_id":"call-1","arguments":"{\"value\":1}"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"result"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Done.","phase":"final_answer"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());
    let sync = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [{
                "type": "transcriptSync",
                "protocolVersion": 2,
                "projectionVersion": "turn-render-v2",
                "window": { "kind": "tail" }
            }]
        }))
        .unwrap();
    let work = sync["resources"][0]["value"]["turns"][0]["frame"]["segments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|segment| segment["type"] == json!("work"))
        .unwrap();
    let segment_id = work["id"].as_str().unwrap();
    let group_id = work["timeline"][0]["id"].as_str().unwrap();
    assert_eq!(work["timeline"][0]["summary"]["tools"], json!(1));
    let group = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [{
                "type": "workGroup",
                "protocolVersion": 2,
                "turnId": "turn-1",
                "segmentId": segment_id,
                "groupId": group_id
            }]
        }))
        .unwrap();
    assert_eq!(group["resources"][0]["status"], json!("ok"));
    assert_eq!(
        group["resources"][0]["value"]["rows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let row_id = group["resources"][0]["value"]["rows"][0]["id"]
        .as_str()
        .unwrap();
    let detail = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [{
                "type": "workEntryDetail",
                "protocolVersion": 2,
                "turnId": "turn-1",
                "segmentId": segment_id,
                "groupId": group_id,
                "rowId": row_id
            }]
        }))
        .unwrap();
    assert_eq!(detail["resources"][0]["status"], json!("ok"));
    assert_eq!(
        detail["resources"][0]["value"]["detail"]["type"],
        json!("tool")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn version_two_patch_apply_groups_expose_named_files_and_diffs() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"help"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Applying the change.","phase":"commentary"}}
{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"patch-1","turn_id":"turn-1","success":true,"changes":{"/repo/src/app.rs":{"type":"update","unified_diff":"@@ -1 +1 @@\n-old\n+new\n","move_path":null},"/repo/src/new.rs":{"type":"add","unified_diff":"@@ -0,0 +1 @@\n+new\n","move_path":null}}}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Done.","phase":"final_answer"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());
    let sync = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [{
                "type": "transcriptSync",
                "protocolVersion": 2,
                "projectionVersion": "turn-render-v2",
                "window": { "kind": "tail" }
            }]
        }))
        .unwrap();
    let work = sync["resources"][0]["value"]["turns"][0]["frame"]["segments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|segment| segment["type"] == json!("work"))
        .unwrap();
    let file_group = work["timeline"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["groupType"] == json!("files"))
        .expect("file group");
    assert_eq!(file_group["summary"]["files"], json!(2));
    assert_eq!(
        file_group["summary"]["fileNames"],
        json!(["/repo/src/app.rs", "/repo/src/new.rs"])
    );

    let group = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [{
                "type": "workGroup",
                "protocolVersion": 2,
                "turnId": "turn-1",
                "segmentId": work["id"],
                "groupId": file_group["id"]
            }]
        }))
        .unwrap();
    let rows = group["resources"][0]["value"]["rows"]
        .as_array()
        .expect("file rows");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["path"], json!("/repo/src/app.rs"));
    assert_eq!(rows[0]["hasDetail"], json!(true));
    assert_eq!(rows[1]["path"], json!("/repo/src/new.rs"));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn rollback_hides_removed_turns_from_direct_reads() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"first"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2","started_at":3}}
{"type":"event_msg","payload":{"type":"user_message","message":"second"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-2","completed_at":4,"duration_ms":1}}
{"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());
    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "threadTranscript" },
                { "type": "turn", "turnId": "turn-2" }
            ]
        }))
        .expect("read should succeed");

    let resources = response
        .get("resources")
        .and_then(Value::as_array)
        .expect("resources array");
    let turn_order = resources[0]
        .get("value")
        .and_then(|value| value.get("turnOrder"))
        .and_then(Value::as_array)
        .expect("turn order");
    assert_eq!(turn_order, &vec![json!("turn-1")]);
    assert_eq!(
        resources[1].get("status").and_then(Value::as_str),
        Some("missing")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn rollback_hidden_turns_prune_stale_live_overlay() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"removed"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
{"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_turn(
        "019test",
        &json!({
            "completedAt": null,
            "durationMs": null,
            "error": null,
            "id": "turn-1",
            "items": [
                {
                    "content": [
                        { "type": "text", "text": "stale live", "text_elements": [] }
                    ],
                    "id": "user-live",
                    "type": "userMessage"
                }
            ],
            "itemsView": "full",
            "startedAt": 1,
            "status": "inProgress"
        }),
    );
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "threadTranscript" },
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");

    assert_eq!(response["resources"][0]["value"]["turnOrder"], json!([]));
    assert_eq!(
        response["resources"][1]
            .get("status")
            .and_then(Value::as_str),
        Some("missing")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn empty_live_turn_started_is_hidden_until_item_activity() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "turn/started",
        "params": {
            "threadId": "019test",
            "turn": {
                "completedAt": null,
                "durationMs": null,
                "error": null,
                "id": "turn-live",
                "items": [],
                "itemsView": "full",
                "startedAt": 3,
                "status": "inProgress"
            }
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live.clone());

    let hidden = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "threadTranscript" },
                { "type": "turn", "turnId": "turn-live" }
            ]
        }))
        .expect("read should succeed");

    assert_eq!(hidden["resources"][0]["value"]["turnOrder"], json!([]));
    assert_eq!(
        hidden["resources"][1].get("status").and_then(Value::as_str),
        Some("missing")
    );

    live.record_notification(&json!({
        "method": "item/started",
        "params": {
            "item": {
                "id": "agent-1",
                "memoryCitation": null,
                "phase": null,
                "text": "",
                "type": "agentMessage"
            },
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));

    let visible = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "threadTranscript" },
                { "type": "turn", "turnId": "turn-live" }
            ]
        }))
        .expect("read should succeed");

    assert_eq!(
        visible["resources"][0]["value"]["turnOrder"],
        json!(["turn-live"])
    );
    assert_eq!(
        visible["resources"][1]
            .get("status")
            .and_then(Value::as_str),
        Some("ok")
    );
    assert_eq!(
        visible["resources"][1]["value"]["turn"]["status"],
        json!("inProgress")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn user_message_text_parts_include_text_elements() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());
    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");

    let text_part = response["resources"][0]["value"]["turn"]["segments"][0]["content"][0]
        .as_object()
        .expect("text part should be an object");
    assert_eq!(text_part.get("type"), Some(&json!("text")));
    assert_eq!(text_part.get("text"), Some(&json!("hello")));
    assert_eq!(text_part.get("text_elements"), Some(&json!([])));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn mention_text_elements_survive_replay_and_dedupe_with_response_item() {
    // Real rollout order for one message: the model-facing response item
    // (no text_elements) is written before the user_message event (which
    // carries rebased element spans). Both rows must collapse into a single
    // user message that keeps the spans.
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"review src/main.rs please"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"review src/main.rs please","text_elements":[{"byte_range":{"start":7,"end":18},"placeholder":"@main.rs"}]}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());
    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");

    let segments = response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    let user_segments = segments
        .iter()
        .filter(|segment| segment["type"] == json!("userMessage"))
        .collect::<Vec<_>>();

    assert_eq!(user_segments.len(), 1);
    assert_eq!(
        user_segments[0]["content"],
        json!([{
            "text": "review src/main.rs please",
            "text_elements": [
                { "byteRange": { "start": 7, "end": 18 }, "placeholder": "@main.rs" }
            ],
            "type": "text",
        }])
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn screenshot_message_replay_collapses_structured_and_flattened_rows() {
    // A complex submission is persisted in two shapes: the response item keeps
    // text around the image as separate parts, while the user_message event
    // flattens the text and stores image data URLs in a side array. They are
    // one user action and must not create a nested steering message.
    let response_image_url = "data:image/png;base64,b3JpZ2luYWw=";
    let legacy_image_url = "data:image/png;base64,cmVlbmNvZGVk";
    let (home, _path) = write_temp_session(&format!(
        r#"{{"type":"session_meta","payload":{{"id":"019test"}}}}
{{"type":"event_msg","payload":{{"type":"task_started","turn_id":"turn-1","started_at":1}}}}
{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"Look at "}},{{"type":"input_image","image_url":"{response_image_url}"}},{{"type":"input_text","text":" please"}}]}}}}
{{"type":"event_msg","payload":{{"type":"user_message","message":"Look at  please","images":["{legacy_image_url}"]}}}}
{{"type":"event_msg","payload":{{"type":"agent_message","message":"Inspecting the screenshot","phase":"commentary"}}}}
{{"type":"event_msg","payload":{{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}}}
"#,
    ));
    let mut server = CodexTranscriptServer::new(home.clone());

    let turn_response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let segments = turn_response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");

    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0]["type"], json!("userMessage"));
    assert_eq!(segments[0]["isSteering"], json!(false));
    assert_eq!(
        segments[0]["content"],
        json!([
            {
                "text": "Look at  please",
                "text_elements": [],
                "type": "text",
            },
            {
                "type": "image",
                "url": legacy_image_url,
            }
        ])
    );
    assert_eq!(segments[1]["type"], json!("work"));

    let work_id = segments[1]["id"].as_str().expect("work id");
    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id }
            ]
        }))
        .expect("details read should succeed");
    let entries = details["resources"][0]["value"]["details"]["entries"]
        .as_array()
        .expect("entries");
    assert!(
        entries
            .iter()
            .all(|entry| entry["type"] != json!("userMessage"))
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn non_adjacent_same_caption_images_remain_distinct_user_submissions() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Use this screenshot"},{"type":"input_image","image_url":"data:image/png;base64,Zmlyc3Q="}]}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Working on the first screenshot","phase":"commentary"}}
{"type":"event_msg","payload":{"type":"user_message","message":"Use this screenshot","images":["data:image/png;base64,c2Vjb25k"]}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Switching to the second screenshot","phase":"commentary"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let turn_response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let segments = turn_response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    assert_eq!(segments[0]["type"], json!("userMessage"));
    assert_eq!(
        segments[0]["content"][1]["url"],
        json!("data:image/png;base64,Zmlyc3Q=")
    );
    let work = segments
        .iter()
        .find(|segment| segment["type"] == json!("work"))
        .expect("work segment");
    let work_id = work["id"].as_str().expect("work id");

    let details_response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id }
            ]
        }))
        .expect("details read should succeed");
    let steering_item_id = details_response["resources"][0]["value"]["details"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .find(|entry| entry["type"] == json!("userMessage"))
        .and_then(|entry| entry["itemId"].as_str())
        .expect("steering item id");
    let item_response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workItem", "turnId": "turn-1", "itemId": steering_item_id }
            ]
        }))
        .expect("work item read should succeed");
    let steering_item = &item_response["resources"][0]["value"]["item"];
    assert_eq!(steering_item["isSteering"], json!(true));
    assert_eq!(
        steering_item["content"][1]["url"],
        json!("data:image/png;base64,c2Vjb25k")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn distinct_mid_turn_user_message_is_explicitly_projected_as_steering() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"Start with the first approach"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Working on it","phase":"commentary"}}
{"type":"event_msg","payload":{"type":"user_message","message":"Actually use the second approach"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Switching approaches","phase":"commentary"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let turn_response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let segments = turn_response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    assert_eq!(segments[0]["type"], json!("userMessage"));
    assert_eq!(segments[0]["isSteering"], json!(false));
    let work = segments
        .iter()
        .find(|segment| segment["type"] == json!("work"))
        .expect("work segment");
    let work_id = work["id"].as_str().expect("work id");

    let details_response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id }
            ]
        }))
        .expect("details read should succeed");
    let steering_entry = details_response["resources"][0]["value"]["details"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .find(|entry| entry["type"] == json!("userMessage"))
        .expect("steering entry");
    let steering_item_id = steering_entry["itemId"].as_str().expect("steering item id");

    let item_response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workItem", "turnId": "turn-1", "itemId": steering_item_id }
            ]
        }))
        .expect("work item read should succeed");
    let steering_item = &item_response["resources"][0]["value"]["item"];
    assert_eq!(steering_item["type"], json!("userMessage"));
    assert_eq!(steering_item["isSteering"], json!(true));
    assert_eq!(
        steering_item["content"][0]["text"],
        json!("Actually use the second approach")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn turn_aborted_marker_is_not_projected_as_user_message() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"question"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"question"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<turn_aborted>\nThe user interrupted the previous turn on purpose."}]}}
{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-1"}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");
    let turn = &response["resources"][0]["value"]["turn"];

    assert_eq!(turn["status"], json!("interrupted"));
    assert_eq!(turn["segments"].as_array().expect("segments").len(), 1);
    assert_eq!(turn["segments"][0]["type"], json!("userMessage"));
    assert_eq!(
        turn["segments"][0]["content"],
        json!([{ "text": "question", "text_elements": [], "type": "text" }])
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn environment_context_response_item_is_not_projected_as_user_message() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"visible prompt"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>"}]}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");
    let segments = response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");

    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0]["type"], json!("userMessage"));
    assert_eq!(
        segments[0]["content"],
        json!([{ "text": "visible prompt", "text_elements": [], "type": "text" }])
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn plain_response_item_user_message_still_projects_without_legacy_event() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"imported visible prompt"}]}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");
    let segments = response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");

    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0]["type"], json!("userMessage"));
    assert_eq!(
        segments[0]["content"],
        json!([{ "text": "imported visible prompt", "text_elements": [], "type": "text" }])
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn hook_prompt_response_item_projects_as_work_item_not_user_message() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"visible prompt"}}
{"type":"response_item","payload":{"type":"message","role":"user","id":"msg-hook","content":[{"type":"input_text","text":"<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>"},{"type":"input_text","text":"<hook_prompt hook_run_id=\"hook-run-1\">Retry with tests &amp; summarize.</hook_prompt>"}]}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let turn_response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let segments = turn_response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");

    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0]["type"], json!("userMessage"));
    assert_eq!(segments[1]["type"], json!("work"));
    let work_id = segments[1]["id"].as_str().expect("work id");
    let hook_id = canonical_id("turn-1", "msg-hook");

    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id },
                { "type": "workItem", "turnId": "turn-1", "itemId": hook_id }
            ]
        }))
        .expect("details read should succeed");

    assert_eq!(
        details["resources"][0]["value"]["details"]["itemIds"],
        json!([canonical_id("turn-1", "msg-hook")])
    );
    assert_eq!(
        details["resources"][0]["value"]["details"]["entries"][0]["group"]["type"],
        json!("tools")
    );
    assert_eq!(details["resources"][1]["status"], json!("ok"));
    assert_eq!(
        details["resources"][1]["value"]["item"]["row"]["label"],
        json!("Ran hook")
    );
    assert_eq!(
        details["resources"][1]["value"]["item"]["row"]["detail"],
        json!("Retry with tests & summarize.")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn response_item_compaction_uses_canonical_identity() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"compact"}}
{"type":"response_item","payload":{"type":"context_compaction","id":"cmp-1","encrypted_content":"..."}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");

    let compaction = &response["resources"][0]["value"]["turn"]["segments"][1];
    assert_eq!(compaction["type"], json!("compaction"));
    assert_eq!(compaction["id"], json!(canonical_id("turn-1", "cmp-1")));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn response_item_compaction_without_id_uses_legacy_identity() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"compact"}}
{"type":"response_item","payload":{"type":"compaction","encrypted_content":"..."}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");

    let compaction = &response["resources"][0]["value"]["turn"]["segments"][1];
    assert_eq!(compaction["type"], json!("compaction"));
    assert_eq!(
        compaction["id"],
        json!("cxitem:v1:turn-1:legacy:contextCompaction:0")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn duplicate_disk_compactions_collapse_inside_work_section() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"compact while working"}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-1","name":"exec_command","call_id":"cmd-1","arguments":"{\"cmd\":\"echo one\",\"workdir\":\"/tmp\"}"}}
{"type":"response_item","payload":{"type":"compaction","encrypted_content":"..."}}
{"type":"response_item","payload":{"type":"context_compaction","encrypted_content":"..."}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-2","name":"exec_command","call_id":"cmd-2","arguments":"{\"cmd\":\"echo two\",\"workdir\":\"/tmp\"}"}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let segments = turn["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    let compactions = segments
        .iter()
        .filter(|segment| segment.get("type").and_then(Value::as_str) == Some("compaction"))
        .collect::<Vec<_>>();
    assert!(compactions.is_empty());

    let work_ids = segments
        .iter()
        .filter(|segment| segment.get("type").and_then(Value::as_str) == Some("work"))
        .filter_map(|segment| segment.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert_eq!(work_ids.len(), 1);

    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_ids[0] },
                { "type": "workItem", "turnId": "turn-1", "itemId": "cxitem:v1:turn-1:legacy:contextCompaction:0" },
                { "type": "workItem", "turnId": "turn-1", "itemId": "cxitem:v1:turn-1:legacy:contextCompaction:1" }
            ]
        }))
        .expect("details read should succeed");
    let entries = details["resources"][0]["value"]["details"]["entries"]
        .as_array()
        .expect("entries");
    let compaction_entries = entries
        .iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("compaction"))
        .collect::<Vec<_>>();
    assert_eq!(compaction_entries.len(), 1);
    assert_eq!(
        compaction_entries[0]["itemId"],
        json!("cxitem:v1:turn-1:legacy:contextCompaction:0")
    );
    assert_eq!(details["resources"][1]["status"], json!("ok"));
    assert_eq!(
        details["resources"][1]["value"]["item"]["status"],
        json!("compacted")
    );
    assert_eq!(details["resources"][2]["status"], json!("ok"));
    assert_eq!(
        details["resources"][2]["value"]["itemId"],
        json!("cxitem:v1:turn-1:legacy:contextCompaction:0")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn duplicate_disk_compactions_collapse_across_metadata_rows() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"compact while working"}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-1","name":"exec_command","call_id":"cmd-1","arguments":"{\"cmd\":\"echo one\",\"workdir\":\"/tmp\"}"}}
{"type":"compacted"}
{"type":"turn_context","cwd":"/tmp"}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1,"output_tokens":1}}}}
{"type":"event_msg","payload":{"type":"context_compacted"}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-2","name":"exec_command","call_id":"cmd-2","arguments":"{\"cmd\":\"echo two\",\"workdir\":\"/tmp\"}"}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let segments = turn["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    let work_id = segments
        .iter()
        .find(|segment| segment.get("type").and_then(Value::as_str) == Some("work"))
        .and_then(|segment| segment.get("id").and_then(Value::as_str))
        .expect("work segment id")
        .to_string();

    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id },
                { "type": "workItem", "turnId": "turn-1", "itemId": "cxitem:v1:turn-1:legacy:contextCompaction:0" },
                { "type": "workItem", "turnId": "turn-1", "itemId": "cxitem:v1:turn-1:legacy:contextCompaction:1" }
            ]
        }))
        .expect("details read should succeed");
    let entries = details["resources"][0]["value"]["details"]["entries"]
        .as_array()
        .expect("entries");
    let compaction_entries = entries
        .iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("compaction"))
        .collect::<Vec<_>>();
    assert_eq!(compaction_entries.len(), 1);
    assert_eq!(
        compaction_entries[0]["itemId"],
        json!("cxitem:v1:turn-1:legacy:contextCompaction:0")
    );
    assert_eq!(
        details["resources"][2]["value"]["itemId"],
        json!("cxitem:v1:turn-1:legacy:contextCompaction:0")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn separate_disk_compactions_remain_distinct_inside_work_section() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"compact twice while working"}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-1","name":"exec_command","call_id":"cmd-1","arguments":"{\"cmd\":\"echo one\",\"workdir\":\"/tmp\"}"}}
{"type":"response_item","payload":{"type":"compaction","encrypted_content":"..."}}
{"type":"response_item","payload":{"type":"context_compaction","encrypted_content":"..."}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-2","name":"exec_command","call_id":"cmd-2","arguments":"{\"cmd\":\"echo two\",\"workdir\":\"/tmp\"}"}}
{"type":"response_item","payload":{"type":"compaction","encrypted_content":"..."}}
{"type":"response_item","payload":{"type":"context_compaction","encrypted_content":"..."}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-3","name":"exec_command","call_id":"cmd-3","arguments":"{\"cmd\":\"echo three\",\"workdir\":\"/tmp\"}"}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());

    let turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let segments = turn["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    let work_id = segments
        .iter()
        .find(|segment| segment.get("type").and_then(Value::as_str) == Some("work"))
        .and_then(|segment| segment.get("id").and_then(Value::as_str))
        .expect("work segment id")
        .to_string();

    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id }
            ]
        }))
        .expect("details read should succeed");
    let entries = details["resources"][0]["value"]["details"]["entries"]
        .as_array()
        .expect("entries");
    let compaction_ids = entries
        .iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("compaction"))
        .filter_map(|entry| entry.get("itemId").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(
        compaction_ids,
        vec![
            "cxitem:v1:turn-1:legacy:contextCompaction:0",
            "cxitem:v1:turn-1:legacy:contextCompaction:2"
        ]
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_durable_compaction_collapses_with_disk_legacy_compactions() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"compact while streaming"}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-1","name":"exec_command","call_id":"cmd-1","arguments":"{\"cmd\":\"echo one\",\"workdir\":\"/tmp\"}"}}
{"type":"response_item","payload":{"type":"compaction","encrypted_content":"..."}}
{"type":"response_item","payload":{"type":"context_compaction","encrypted_content":"..."}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-2","name":"exec_command","call_id":"cmd-2","arguments":"{\"cmd\":\"echo two\",\"workdir\":\"/tmp\"}"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "item/started",
        "params": {
            "item": {
                "id": "d4364495-93ed-4f7f-aa4f-19bff0161ea9",
                "type": "contextCompaction"
            },
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let segments = turn["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    let compactions = segments
        .iter()
        .filter(|segment| segment.get("type").and_then(Value::as_str) == Some("compaction"))
        .collect::<Vec<_>>();
    assert!(compactions.is_empty());

    let work_ids = segments
        .iter()
        .filter(|segment| segment.get("type").and_then(Value::as_str) == Some("work"))
        .filter_map(|segment| segment.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert_eq!(work_ids.len(), 1);
    let durable_compaction_id = canonical_id("turn-1", "d4364495-93ed-4f7f-aa4f-19bff0161ea9");
    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_ids[0] },
                { "type": "workItem", "turnId": "turn-1", "itemId": durable_compaction_id },
                { "type": "workItem", "turnId": "turn-1", "itemId": "cxitem:v1:turn-1:legacy:contextCompaction:0" },
                { "type": "workItem", "turnId": "turn-1", "itemId": "cxitem:v1:turn-1:legacy:contextCompaction:1" }
            ]
        }))
        .expect("details read should succeed");
    let entries = details["resources"][0]["value"]["details"]["entries"]
        .as_array()
        .expect("entries");
    let compaction_entries = entries
        .iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("compaction"))
        .collect::<Vec<_>>();
    assert_eq!(compaction_entries.len(), 1);
    assert_eq!(
        compaction_entries[0]["itemId"],
        json!(canonical_id(
            "turn-1",
            "d4364495-93ed-4f7f-aa4f-19bff0161ea9"
        ))
    );
    for index in 1..=3 {
        assert_eq!(details["resources"][index]["status"], json!("ok"));
        assert_eq!(
            details["resources"][index]["value"]["itemId"],
            json!(canonical_id(
                "turn-1",
                "d4364495-93ed-4f7f-aa4f-19bff0161ea9"
            ))
        );
        assert_eq!(
            details["resources"][index]["value"]["item"]["status"],
            json!("compacted")
        );
    }

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_compaction_started_and_completed_update_standalone_segment() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "turn/started",
        "params": {
            "threadId": "019test",
            "turn": {
                "completedAt": null,
                "durationMs": null,
                "error": null,
                "id": "turn-live",
                "items": [
                    {
                        "content": [
                            { "type": "text", "text": "compact now", "text_elements": [] }
                        ],
                        "id": "user-live",
                        "type": "userMessage"
                    }
                ],
                "itemsView": "full",
                "startedAt": 3,
                "status": "inProgress"
            }
        }
    }));
    live.record_notification(&json!({
        "method": "item/started",
        "params": {
            "item": {
                "id": "cmp-live",
                "type": "context_compaction"
            },
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live.clone());

    let started = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-live" }
            ]
        }))
        .expect("started turn read should succeed");
    let started_segments = started["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    assert_eq!(started_segments.len(), 2);
    assert_eq!(started_segments[1]["type"], json!("compaction"));
    assert_eq!(
        started_segments[1]["id"],
        json!(canonical_id("turn-live", "cmp-live"))
    );
    assert_eq!(started_segments[1]["status"], json!("compacting"));

    live.record_notification(&json!({
        "method": "item/completed",
        "params": {
            "item": {
                "id": "cmp-live",
                "type": "compaction"
            },
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));
    let completed = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-live" }
            ]
        }))
        .expect("completed turn read should succeed");
    let completed_segments = completed["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    assert_eq!(completed_segments.len(), 2);
    assert_eq!(completed_segments[1]["type"], json!("compaction"));
    assert_eq!(
        completed_segments[1]["id"],
        json!(canonical_id("turn-live", "cmp-live"))
    );
    assert_eq!(completed_segments[1]["status"], json!("compacted"));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_turns_overlay_disk_backed_transcript_reads() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"first"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_turn(
        "019test",
        &json!({
            "completedAt": null,
            "durationMs": null,
            "error": null,
            "id": "turn-live",
            "items": [
                {
                    "content": [
                        { "type": "text", "text": "live hello", "text_elements": [] }
                    ],
                    "id": "user-live",
                    "type": "userMessage"
                }
            ],
            "itemsView": "full",
            "startedAt": 3,
            "status": "inProgress"
        }),
    );
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "threadTranscript" },
                { "type": "turn", "turnId": "turn-live" }
            ]
        }))
        .expect("read should succeed");

    assert_eq!(
        response["resources"][0]["value"]["turnOrder"],
        json!(["turn-1", "turn-live"])
    );
    assert_eq!(
        response["resources"][1]["value"]["turn"]["segments"][0]["content"][0]["text"],
        json!("live hello")
    );
    assert_eq!(
        response["resources"][1]["value"]["turn"]["status"],
        json!("inProgress")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_overlay_keeps_distinct_user_steering_when_live_work_is_hidden() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"Start the task","images":["data:image/png;base64,ZGlzaw=="]}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_turn(
        "019test",
        &json!({
            "completedAt": null,
            "durationMs": null,
            "error": null,
            "id": "turn-1",
            "items": [
                {
                    "content": [
                        { "type": "text", "text": "Start the task", "text_elements": [] },
                        { "type": "image", "url": "data:image/png;base64,bGl2ZS1yZWVuY29kZWQ=" }
                    ],
                    "id": "user-initial",
                    "type": "userMessage"
                },
                {
                    "content": [
                        { "type": "text", "text": "Change the output format", "text_elements": [] }
                    ],
                    "id": "user-steering",
                    "type": "userMessage"
                },
                {
                    "aggregatedOutput": "",
                    "command": "echo changed",
                    "commandActions": [],
                    "cwd": "/tmp",
                    "durationMs": null,
                    "exitCode": null,
                    "id": "cmd-1",
                    "processId": null,
                    "source": "agent",
                    "status": "inProgress",
                    "type": "commandExecution"
                }
            ],
            "itemsView": "full",
            "startedAt": 1,
            "status": "inProgress"
        }),
    );
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let turn_response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let segments = turn_response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    assert_eq!(
        segments
            .iter()
            .filter(|segment| segment["type"] == json!("userMessage"))
            .count(),
        2
    );
    assert!(
        segments
            .iter()
            .all(|segment| segment["type"] != json!("work"))
    );
    let steering = segments
        .iter()
        .filter(|segment| segment["type"] == json!("userMessage"))
        .nth(1)
        .expect("steering segment");
    assert_eq!(
        steering["content"][0]["text"],
        json!("Change the output format")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_only_work_items_do_not_materialize_transcript_resources() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_turn(
        "019test",
        &json!({
            "completedAt": null,
            "durationMs": null,
            "error": null,
            "id": "turn-live",
            "items": [
                {
                    "content": [
                        { "type": "text", "text": "run command", "text_elements": [] }
                    ],
                    "id": "user-live",
                    "type": "userMessage"
                },
                {
                    "aggregatedOutput": "first output",
                    "command": "node -e 1",
                    "commandActions": [],
                    "cwd": "/tmp",
                    "durationMs": null,
                    "exitCode": null,
                    "id": "cmd-1",
                    "processId": null,
                    "source": "agent",
                    "status": "inProgress",
                    "type": "commandExecution"
                }
            ],
            "itemsView": "full",
            "startedAt": 3,
            "status": "inProgress"
        }),
    );
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-live" },
                { "type": "workItem", "turnId": "turn-live", "itemId": canonical_call("turn-live", "cmd-1") }
            ]
        }))
        .expect("read should succeed");
    let segments = response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0]["type"], json!("userMessage"));
    assert_eq!(response["resources"][1]["status"], json!("missing"));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_notifications_stream_agent_message_deltas() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "turn/started",
        "params": {
            "threadId": "019test",
            "turn": {
                "completedAt": null,
                "durationMs": null,
                "error": null,
                "id": "turn-live",
                "items": [
                    {
                        "content": [
                            { "type": "text", "text": "hello", "text_elements": [] }
                        ],
                        "id": "user-live",
                        "type": "userMessage"
                    }
                ],
                "itemsView": "full",
                "startedAt": 3,
                "status": "inProgress"
            }
        }
    }));
    live.record_notification(&json!({
        "method": "item/started",
        "params": {
            "item": {
                "id": "agent-1",
                "memoryCitation": null,
                "phase": null,
                "text": "",
                "type": "agentMessage"
            },
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));
    live.record_notification(&json!({
        "method": "item/agentMessage/delta",
        "params": {
            "delta": "Hello",
            "itemId": "agent-1",
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));
    live.record_notification(&json!({
        "method": "item/agentMessage/delta",
        "params": {
            "delta": " world",
            "itemId": "agent-1",
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live.clone());

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "threadTranscript" },
                { "type": "turn", "turnId": "turn-live" }
            ]
        }))
        .expect("read should succeed");

    assert_eq!(
        response["resources"][0]["value"]["turnOrder"],
        json!(["turn-live"])
    );
    assert_eq!(
        response["resources"][1]["value"]["turn"]["segments"][1]["text"],
        json!("Hello world")
    );

    let initial_sync = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [{
                "type": "transcriptSync",
                "protocolVersion": 2,
                "projectionVersion": "turn-render-v2",
                "window": { "kind": "tail" }
            }]
        }))
        .expect("initial live transcript sync should succeed");
    let known_revision = initial_sync["resources"][0]["value"]["turns"][0]["renderRevision"]
        .as_str()
        .expect("render revision")
        .to_string();

    live.record_notification(&json!({
        "method": "item/agentMessage/delta",
        "params": {
            "delta": "!",
            "itemId": "agent-1",
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));
    let streamed_sync = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [{
                "type": "transcriptSync",
                "protocolVersion": 2,
                "projectionVersion": "turn-render-v2",
                "knownTurns": [{
                    "turnId": "turn-live",
                    "renderRevision": known_revision
                }],
                "window": {
                    "kind": "range",
                    "startTurnId": "turn-live",
                    "endTurnId": "turn-live"
                }
            }]
        }))
        .expect("streaming range sync should succeed");
    let streamed_turn = &streamed_sync["resources"][0]["value"]["turns"][0];
    assert_eq!(streamed_turn["status"], json!("ok"));
    assert_ne!(streamed_turn["renderRevision"], json!(known_revision));
    assert_eq!(
        streamed_turn["frame"]["segments"][1]["text"],
        json!("Hello world!")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_work_segment_completes_when_final_agent_message_starts() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"run command"}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-1","name":"exec_command","call_id":"cmd-1","arguments":"{\"cmd\":\"node -e 1\",\"workdir\":\"/tmp\"}"}}
{"type":"response_item","payload":{"type":"function_call_output","id":"fco-1","call_id":"cmd-1","output":"done"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "item/started",
        "params": {
            "item": {
                "id": "agent-1",
                "memoryCitation": null,
                "phase": null,
                "text": "",
                "type": "agentMessage"
            },
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");
    let turn = &response["resources"][0]["value"]["turn"];
    let segments = turn["segments"].as_array().expect("segments");

    assert_eq!(turn["status"], json!("inProgress"));
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[1]["type"], json!("work"));
    assert_eq!(segments[1]["state"], json!("completed"));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_notification_command_output_does_not_materialize_work_item() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "turn/started",
        "params": {
            "threadId": "019test",
            "turn": {
                "completedAt": null,
                "durationMs": null,
                "error": null,
                "id": "turn-live",
                "items": [
                    {
                        "content": [
                            { "type": "text", "text": "run command", "text_elements": [] }
                        ],
                        "id": "user-live",
                        "type": "userMessage"
                    }
                ],
                "itemsView": "full",
                "startedAt": 3,
                "status": "inProgress"
            }
        }
    }));
    live.record_notification(&json!({
        "method": "item/started",
        "params": {
            "item": {
                "aggregatedOutput": "",
                "command": "node -e 1",
                "commandActions": [],
                "cwd": "/tmp",
                "durationMs": null,
                "exitCode": null,
                "id": "cmd-1",
                "processId": null,
                "source": "agent",
                "status": "inProgress",
                "type": "commandExecution"
            },
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));
    live.record_notification(&json!({
        "method": "item/commandExecution/outputDelta",
        "params": {
            "delta": "first",
            "itemId": "cmd-1",
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));
    live.record_notification(&json!({
        "method": "item/commandExecution/outputDelta",
        "params": {
            "delta": " second",
            "itemId": "cmd-1",
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-live" },
                { "type": "workItem", "turnId": "turn-live", "itemId": canonical_call("turn-live", "cmd-1") }
            ]
        }))
        .expect("turn read should succeed");
    let segments = response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0]["type"], json!("userMessage"));
    assert_eq!(response["resources"][1]["status"], json!("missing"));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn partial_live_delta_does_not_hide_disk_turn() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"disk prompt"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"disk answer"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "item/commandExecution/outputDelta",
        "params": {
            "delta": "partial output",
            "itemId": "cmd-1",
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");

    let turn = &response["resources"][0]["value"]["turn"];
    let serialized = serde_json::to_string(turn).expect("turn json");
    assert!(serialized.contains("disk prompt"));
    assert!(serialized.contains("disk answer"));
    assert!(!serialized.contains("partial output"));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn synthetic_live_agent_delta_merges_with_legacy_disk_agent_item() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"prompt"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Hello"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "item/agentMessage/delta",
        "params": {
            "delta": " world",
            "itemId": "item-1",
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");

    let segments = response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    assert_eq!(segments.len(), 2);
    assert_eq!(
        segments[1]["id"],
        json!("cxitem:v1:turn-1:legacy:agentMessage:0")
    );
    assert_eq!(segments[1]["text"], json!("Hello world"));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn work_details_dedupe_duplicate_canonical_group_membership() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"run command"}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-1","name":"exec_command","call_id":"cmd-1","arguments":"{\"cmd\":\"node -e 1\",\"workdir\":\"/tmp\"}"}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-2","name":"exec_command","call_id":"cmd-1","arguments":"{\"cmd\":\"node -e 1\",\"workdir\":\"/tmp\"}"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let work_id = turn["resources"][0]["value"]["turn"]["segments"][1]["id"]
        .as_str()
        .expect("work segment id")
        .to_string();

    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id }
            ]
        }))
        .expect("details read should succeed");
    let expected_item_ids = json!([canonical_call("turn-1", "cmd-1")]);
    assert_eq!(
        details["resources"][0]["value"]["details"]["itemIds"],
        expected_item_ids
    );
    assert_eq!(
        details["resources"][0]["value"]["details"]["entries"][0]["group"]["itemIds"],
        expected_item_ids
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn completed_disk_turn_ignores_live_snapshot() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"disk prompt"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"disk answer"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "turn/completed",
        "params": {
            "threadId": "019test",
            "turn": {
                "completedAt": 2,
                "durationMs": 1,
                "error": null,
                "id": "turn-1",
                "items": [
                    {
                        "id": "agent-live",
                        "memoryCitation": null,
                        "phase": null,
                        "text": "live-only answer",
                        "type": "agentMessage"
                    }
                ],
                "itemsView": "full",
                "startedAt": 1,
                "status": "completed"
            }
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");

    let turn = &response["resources"][0]["value"]["turn"];
    let serialized = serde_json::to_string(turn).expect("turn json");
    assert!(serialized.contains("disk prompt"));
    assert!(serialized.contains("disk answer"));
    assert!(!serialized.contains("live-only answer"));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn active_disk_turn_ignores_notification_only_command_output() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"run command"}}
{"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"cmd-1","arguments":"{\"cmd\":\"echo hi\",\"workdir\":\"/tmp\"}"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "item/commandExecution/outputDelta",
        "params": {
            "delta": "streamed output",
            "itemId": "cmd-1",
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let work_id = turn["resources"][0]["value"]["turn"]["segments"][1]["id"]
        .as_str()
        .expect("work segment id")
        .to_string();

    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id },
                { "type": "workItem", "turnId": "turn-1", "itemId": canonical_call("turn-1", "cmd-1") }
            ]
        }))
        .expect("details read should succeed");

    assert_eq!(
        details["resources"][0]["value"]["details"]["itemIds"],
        json!([canonical_call("turn-1", "cmd-1")])
    );
    assert_eq!(
        details["resources"][1]["value"]["item"]["activity"]["output"],
        json!("")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn active_disk_turn_keeps_durable_identity_without_overlaying_live_output() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"run command"}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-1","name":"exec_command","call_id":"cmd-1","arguments":"{\"cmd\":\"echo hi\",\"workdir\":\"/tmp\"}"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "item/commandExecution/outputDelta",
        "params": {
            "delta": "streamed output",
            "itemId": "cmd-1",
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let work_id = turn["resources"][0]["value"]["turn"]["segments"][1]["id"]
        .as_str()
        .expect("work segment id")
        .to_string();

    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id },
                { "type": "workItem", "turnId": "turn-1", "itemId": canonical_id("turn-1", "fc-1") },
                { "type": "workItem", "turnId": "turn-1", "itemId": canonical_call("turn-1", "cmd-1") }
            ]
        }))
        .expect("details read should succeed");

    assert_eq!(
        details["resources"][0]["value"]["details"]["itemIds"],
        json!([canonical_call("turn-1", "cmd-1")])
    );
    assert_eq!(
        details["resources"][1]["value"]["item"]["activity"]["output"],
        json!("")
    );
    assert_eq!(details["resources"][2]["status"], json!("ok"));
    assert_eq!(
        details["resources"][2]["value"]["item"]["activity"]["output"],
        json!("")
    );

    let turn_json = serde_json::to_string(&turn["resources"][0]["value"]["turn"]).expect("json");
    assert!(turn_json.contains(&canonical_call("turn-1", "cmd-1")));
    assert!(!turn_json.contains(&canonical_id("turn-1", "fc-1")));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_command_delta_does_not_duplicate_disk_output_when_disk_catches_up() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"run command"}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-1","name":"exec_command","call_id":"cmd-1","arguments":"{\"cmd\":\"echo hi\",\"workdir\":\"/tmp\"}"}}
{"type":"response_item","payload":{"type":"function_call_output","id":"fco-1","call_id":"cmd-1","output":"streamed output"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "item/commandExecution/outputDelta",
        "params": {
            "delta": "streamed output",
            "itemId": "cmd-1",
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let work_id = turn["resources"][0]["value"]["turn"]["segments"][1]["id"]
        .as_str()
        .expect("work segment id")
        .to_string();
    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id },
                { "type": "workItem", "turnId": "turn-1", "itemId": canonical_call("turn-1", "cmd-1") }
            ]
        }))
        .expect("details read should succeed");

    assert_eq!(
        details["resources"][0]["value"]["details"]["itemIds"],
        json!([canonical_call("turn-1", "cmd-1")])
    );
    assert_eq!(
        details["resources"][1]["value"]["item"]["activity"]["output"],
        json!("streamed output")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_command_delta_rekeys_without_overlaying_disk_work() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"run command"}}
{"type":"response_item","payload":{"type":"function_call","id":"fc-1","name":"exec_command","call_id":"cmd-1","arguments":"{\"cmd\":\"echo hi\",\"workdir\":\"/tmp\"}"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "item/commandExecution/outputDelta",
        "params": {
            "delta": "streamed output",
            "itemId": "fc-1",
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let work_id = turn["resources"][0]["value"]["turn"]["segments"][1]["id"]
        .as_str()
        .expect("work segment id")
        .to_string();
    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id },
                { "type": "workItem", "turnId": "turn-1", "itemId": canonical_call("turn-1", "cmd-1") },
                { "type": "workItem", "turnId": "turn-1", "itemId": canonical_call("turn-1", "fc-1") }
            ]
        }))
        .expect("details read should succeed");

    assert_eq!(
        details["resources"][0]["value"]["details"]["itemIds"],
        json!([canonical_call("turn-1", "cmd-1")])
    );
    assert_eq!(
        details["resources"][1]["value"]["item"]["activity"]["output"],
        json!("")
    );
    assert_eq!(details["resources"][2]["status"], json!("ok"));
    assert_eq!(
        details["resources"][2]["value"]["itemId"],
        json!(canonical_call("turn-1", "cmd-1"))
    );

    let turn_json = serde_json::to_string(&turn["resources"][0]["value"]["turn"]).expect("json");
    assert!(turn_json.contains(&canonical_call("turn-1", "cmd-1")));
    assert!(!turn_json.contains(&canonical_call("turn-1", "fc-1")));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn raw_response_item_completed_does_not_publish_work_before_disk_catches_up() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "turn/started",
        "params": {
            "threadId": "019test",
            "turn": {
                "completedAt": null,
                "durationMs": null,
                "error": null,
                "id": "turn-live",
                "items": [
                    {
                        "content": [
                            { "type": "text", "text": "run command", "text_elements": [] }
                        ],
                        "id": "user-live",
                        "type": "userMessage"
                    }
                ],
                "itemsView": "full",
                "startedAt": 3,
                "status": "inProgress"
            }
        }
    }));
    live.record_notification(&json!({
        "method": "item/commandExecution/outputDelta",
        "params": {
            "delta": "streamed output",
            "itemId": "fc-1",
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));
    live.record_notification(&json!({
        "method": "rawResponseItem/completed",
        "params": {
            "item": {
                "arguments": "{\"cmd\":\"echo hi\",\"workdir\":\"/tmp\"}",
                "call_id": "cmd-1",
                "id": "fc-1",
                "name": "exec_command",
                "type": "function_call"
            },
            "threadId": "019test",
            "turnId": "turn-live"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-live" },
                { "type": "workItem", "turnId": "turn-live", "itemId": canonical_call("turn-live", "cmd-1") }
            ]
        }))
        .expect("turn read should succeed");
    let segments = response["resources"][0]["value"]["turn"]["segments"]
        .as_array()
        .expect("segments");
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0]["type"], json!("userMessage"));
    assert_eq!(response["resources"][1]["status"], json!("missing"));

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_agent_deltas_do_not_duplicate_disk_message_when_disk_catches_up() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"prompt"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Hello world"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "item/agentMessage/delta",
        "params": {
            "delta": "Hello",
            "itemId": "item-1",
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    live.record_notification(&json!({
        "method": "item/agentMessage/delta",
        "params": {
            "delta": " world",
            "itemId": "item-1",
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("read should succeed");

    assert_eq!(
        response["resources"][0]["value"]["turn"]["segments"][1]["text"],
        json!("Hello world")
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn live_durable_agent_item_dedupes_with_legacy_disk_message() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"prompt"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Inspecting logs","phase":"commentary"}}
"#,
    );
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "item/completed",
        "params": {
            "item": {
                "id": "msg-1",
                "memoryCitation": null,
                "phase": "commentary",
                "text": "Inspecting logs",
                "type": "agentMessage"
            },
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);

    let turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("turn read should succeed");
    let work_id = turn["resources"][0]["value"]["turn"]["segments"][1]["id"]
        .as_str()
        .expect("work segment id")
        .to_string();
    let durable_id = canonical_id("turn-1", "msg-1");
    let legacy_id = "cxitem:v1:turn-1:legacy:agentMessage:0";

    let details = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "workDetails", "turnId": "turn-1", "segmentId": work_id },
                { "type": "workItem", "turnId": "turn-1", "itemId": durable_id },
                { "type": "workItem", "turnId": "turn-1", "itemId": legacy_id }
            ]
        }))
        .expect("details read should succeed");

    assert_eq!(
        details["resources"][0]["value"]["details"]["itemIds"],
        json!([canonical_id("turn-1", "msg-1")])
    );
    assert_eq!(
        details["resources"][0]["value"]["details"]["entries"],
        json!([{
            "id": canonical_id("turn-1", "msg-1"),
            "itemId": canonical_id("turn-1", "msg-1"),
            "type": "message"
        }])
    );
    assert_eq!(details["resources"][1]["status"], json!("ok"));
    assert_eq!(details["resources"][2]["status"], json!("ok"));
    assert_eq!(
        details["resources"][2]["value"]["itemId"],
        json!(canonical_id("turn-1", "msg-1"))
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn completed_disk_turn_preserves_live_work_segment_id() {
    let in_progress_session = r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"prompt"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Inspecting logs","phase":"commentary"}}
"#;
    let completed_session = r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"prompt"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Inspecting logs","phase":"commentary"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
"#;
    let completed_session_reread = r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"prompt"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Inspecting logs","phase":"commentary"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":2,"duration_ms":1}}
{"type":"event_msg","payload":{"type":"token_count","turn_id":"turn-1"}}
"#;
    let (home, path) = write_temp_session(in_progress_session);
    let live = LiveTranscriptStore::default();
    live.record_notification(&json!({
        "method": "item/completed",
        "params": {
            "item": {
                "id": "msg-1",
                "memoryCitation": null,
                "phase": "commentary",
                "text": "Inspecting logs",
                "type": "agentMessage"
            },
            "threadId": "019test",
            "turnId": "turn-1"
        }
    }));
    let mut server = CodexTranscriptServer::new_with_live_transcript(home.clone(), live);
    let durable_work_id = format!("turn-1:work:{}", canonical_id("turn-1", "msg-1"));
    let legacy_id = "cxitem:v1:turn-1:legacy:agentMessage:0";

    let live_turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("live turn read should succeed");
    let live_work_id = live_turn["resources"][0]["value"]["turn"]["segments"][1]["id"]
        .as_str()
        .expect("live work segment id")
        .to_string();
    assert_eq!(live_work_id, durable_work_id);

    fs::write(&path, completed_session).expect("write completed session");
    let completed_turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" },
                { "type": "workDetails", "turnId": "turn-1", "segmentId": durable_work_id },
                { "type": "workItem", "turnId": "turn-1", "itemId": legacy_id }
            ]
        }))
        .expect("completed turn read should succeed");
    assert_eq!(
        completed_turn["resources"][0]["value"]["turn"]["segments"][1]["id"],
        json!(durable_work_id)
    );
    assert_eq!(
        completed_turn["resources"][1]["value"]["details"]["itemIds"],
        json!([canonical_id("turn-1", "msg-1")])
    );
    assert_eq!(
        completed_turn["resources"][2]["value"]["itemId"],
        json!(canonical_id("turn-1", "msg-1"))
    );

    fs::write(&path, completed_session_reread).expect("write completed session for reread");
    let reread_turn = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "turn", "turnId": "turn-1" }
            ]
        }))
        .expect("completed reread should succeed");
    assert_eq!(
        reread_turn["resources"][0]["value"]["turn"]["segments"][1]["id"],
        json!(durable_work_id)
    );

    let _ = fs::remove_dir_all(home);
}

#[test]
fn interleaved_turns_do_not_leak_rows_or_stay_in_progress() {
    let (home, _path) = write_temp_session(
        r#"{"type":"session_meta","payload":{"id":"019test"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1}}
{"type":"event_msg","payload":{"type":"user_message","message":"first"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"before interleave"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2","started_at":2}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-2","completed_at":3,"duration_ms":1}}
{"type":"event_msg","payload":{"type":"agent_message","message":"after interleave"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":4,"duration_ms":3}}
"#,
    );
    let mut server = CodexTranscriptServer::new(home.clone());
    let response = server
        .read_resources(json!({
            "threadId": "019test",
            "requests": [
                { "type": "threadTranscript" },
                { "type": "turn", "turnId": "turn-1" },
                { "type": "turn", "turnId": "turn-2" }
            ]
        }))
        .expect("read should succeed");

    let turn_order = response["resources"][0]["value"]["turnOrder"]
        .as_array()
        .expect("turn order");
    assert_eq!(turn_order, &vec![json!("turn-1"), json!("turn-2")]);

    let turn_one = &response["resources"][1]["value"]["turn"];
    let turn_two = &response["resources"][2]["value"]["turn"];
    assert_eq!(turn_one["status"], json!("completed"));
    assert_eq!(turn_two["status"], json!("completed"));
    assert_eq!(turn_one["completedAt"], json!(4));
    assert_eq!(turn_two["completedAt"], json!(3));

    let turn_one_text = serde_json::to_string(turn_one).expect("turn one json");
    let turn_two_text = serde_json::to_string(turn_two).expect("turn two json");
    assert!(turn_one_text.contains("after interleave"));
    assert!(!turn_two_text.contains("after interleave"));

    let _ = fs::remove_dir_all(home);
}

#[test]
#[ignore]
fn real_transcripts_validate() {
    let home = std::env::var("REMUX_VALIDATE_CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").expect("HOME")).join(".codex"));
    let mut server = CodexTranscriptServer::new(home);
    let report = server
        .validate_real_transcripts(ValidationOptions { limit: 25 })
        .expect("validation should run");
    assert!(report.scanned_files > 0);
    assert_eq!(report.duplicate_segment_failures, 0);
    assert_eq!(report.missing_work_details_failures, 0);
}

fn write_temp_session(contents: &str) -> (PathBuf, PathBuf) {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should be after epoch")
        .as_nanos();
    let counter = TEMP_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    let home = std::env::temp_dir().join(format!(
        "remux-codex-server-test-{}-{suffix}-{counter}",
        std::process::id(),
    ));
    let session_dir = home.join("sessions").join("2026").join("01").join("01");
    fs::create_dir_all(&session_dir).expect("create session dir");
    let path = session_dir.join("rollout-2026-01-01T00-00-00-000Z-019test.jsonl");
    fs::write(&path, contents).expect("write session");
    (home, path)
}

fn canonical_call(turn_id: &str, call_id: &str) -> String {
    format!("cxitem:v1:{turn_id}:call:{call_id}")
}

fn canonical_id(turn_id: &str, item_id: &str) -> String {
    format!("cxitem:v1:{turn_id}:id:{item_id}")
}
