//! Integration port of `cli/tests/fs-core.test.js`.

use std::path::Path;

use serde_json::{json, Value};

use remux::fs::core::FsCore;

async fn rpc(core: &FsCore, method: &str, params: Option<Value>) -> Result<Value, String> {
    core.handle_rpc(method, params.as_ref())
        .await
        .map_err(|error| error.message)
}

async fn git(cwd: &Path, args: &[&str]) {
    let status = tokio::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .unwrap();
    assert!(
        status.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&status.stderr)
    );
}

fn entry_names(result: &Value) -> Vec<String> {
    result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn reads_directories_from_the_cli_root_by_default() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    std::fs::create_dir(root_path.join("src")).unwrap();
    std::fs::write(root_path.join("package.json"), "{}").unwrap();

    let core = FsCore::new(&root_path);
    let result = rpc(&core, "remux/fs/readDirectory", None).await.unwrap();

    assert_eq!(result["path"], root_path.to_string_lossy().as_ref());
    assert_eq!(
        result["parentPath"],
        root_path.parent().unwrap().to_string_lossy().as_ref()
    );
    let entries = result["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["kind"], "directory");
    assert_eq!(entries[0]["name"], "src");
    assert_eq!(entries[0]["sizeBytes"], Value::Null);
    assert_eq!(entries[1]["kind"], "file");
    assert_eq!(entries[1]["name"], "package.json");
    assert_eq!(entries[1]["sizeBytes"], 2);
    assert_eq!(entries[1]["itemCount"], Value::Null);
}

#[tokio::test]
async fn batches_directory_reads_with_partial_failures() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let first = root_path.join("first");
    let second = root_path.join("second");
    let missing = root_path.join("missing");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    std::fs::write(first.join("a.txt"), "a").unwrap();
    std::fs::write(second.join("b.txt"), "b").unwrap();

    let core = FsCore::new(&root_path);
    let result = rpc(
        &core,
        "remux/fs/readDirectories",
        Some(json!({ "paths": [first.to_string_lossy(), missing.to_string_lossy(), second.to_string_lossy()] })),
    )
    .await
    .unwrap();

    let results = result["results"].as_array().unwrap();
    assert_eq!(results.len(), 3);
    assert_eq!(results[0]["ok"], true);
    assert_eq!(results[0]["path"], first.to_string_lossy().as_ref());
    assert_eq!(entry_names(&results[0]["value"]), vec!["a.txt"]);
    assert_eq!(results[1]["ok"], false);
    assert_eq!(results[1]["path"], missing.to_string_lossy().as_ref());
    assert!(results[1]["message"]
        .as_str()
        .unwrap()
        .starts_with("Directory could not be read"));
    assert_eq!(results[2]["ok"], true);
    assert_eq!(entry_names(&results[2]["value"]), vec!["b.txt"]);
}

#[tokio::test]
async fn caches_repeated_directory_reads_briefly_and_supports_force() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    std::fs::write(root_path.join("first.txt"), "first").unwrap();

    let core = FsCore::new(&root_path);
    let first = rpc(&core, "remux/fs/readDirectory", None).await.unwrap();
    std::fs::write(root_path.join("second.txt"), "second").unwrap();
    let second = rpc(&core, "remux/fs/readDirectory", None).await.unwrap();
    let refreshed = rpc(
        &core,
        "remux/fs/readDirectory",
        Some(json!({ "force": true })),
    )
    .await
    .unwrap();

    assert_eq!(entry_names(&first), vec!["first.txt"]);
    assert!(first["version"].is_string());
    assert_eq!(entry_names(&second), vec!["first.txt"]);
    assert_eq!(entry_names(&refreshed), vec!["first.txt", "second.txt"]);
    assert_ne!(refreshed["version"], first["version"]);
}

#[tokio::test]
async fn annotates_directory_entries_and_file_reads_with_git_status() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    std::fs::create_dir(root_path.join("nested")).unwrap();
    std::fs::write(root_path.join("tracked.txt"), "base\n").unwrap();
    std::fs::write(root_path.join("nested/clean.txt"), "base\n").unwrap();

    git(&root_path, &["init"]).await;
    git(
        &root_path,
        &["config", "user.email", "remux@example.invalid"],
    )
    .await;
    git(&root_path, &["config", "user.name", "Remux Test"]).await;
    git(&root_path, &["add", "."]).await;
    git(&root_path, &["commit", "-m", "initial"]).await;

    std::fs::write(root_path.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(root_path.join("loose.txt"), "new\n").unwrap();
    std::fs::write(root_path.join("staged.txt"), "new\n").unwrap();
    std::fs::create_dir(root_path.join("nested/untracked")).unwrap();
    std::fs::write(root_path.join("nested/untracked/child.txt"), "new\n").unwrap();
    git(&root_path, &["add", "staged.txt"]).await;

    let core = FsCore::new(&root_path);
    let result = rpc(&core, "remux/fs/readDirectory", None).await.unwrap();
    let entries: std::collections::HashMap<String, Value> = result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| (entry["name"].as_str().unwrap().to_string(), entry.clone()))
        .collect();

    assert_eq!(
        entries["tracked.txt"]["git"],
        json!({ "staged": false, "status": "modified" })
    );
    assert_eq!(
        entries["loose.txt"]["git"],
        json!({ "staged": false, "status": "untracked" })
    );
    assert_eq!(
        entries["staged.txt"]["git"],
        json!({ "staged": true, "status": "added" })
    );
    assert_eq!(
        entries["nested"]["git"],
        json!({ "staged": false, "status": "untracked" })
    );

    let tracked = rpc(
        &core,
        "remux/fs/readFile",
        Some(json!({
            "git": { "includeBase": true, "includeStatus": true },
            "path": root_path.join("tracked.txt").to_string_lossy(),
        })),
    )
    .await
    .unwrap();
    assert_eq!(tracked["content"], "changed\n");
    assert_eq!(tracked["git"]["status"], "modified");
    assert_eq!(
        tracked["git"]["repoRoot"],
        root_path.to_string_lossy().as_ref()
    );
    assert_eq!(tracked["git"]["base"]["status"], "modified");
    assert_eq!(tracked["git"]["base"]["content"], "base\n");
    assert_eq!(tracked["git"]["base"]["encoding"], "utf8");
    assert_eq!(tracked["git"]["base"]["isBinary"], false);
    assert_eq!(tracked["git"]["base"]["tooLarge"], false);

    let staged = rpc(
        &core,
        "remux/fs/readFile",
        Some(json!({
            "git": { "includeBase": true, "includeStatus": true },
            "path": root_path.join("staged.txt").to_string_lossy(),
        })),
    )
    .await
    .unwrap();
    assert_eq!(staged["git"]["status"], "added");
    assert_eq!(staged["git"]["base"]["status"], "added");
    assert_eq!(staged["git"]["base"]["content"], "");
    assert_eq!(staged["git"]["base"]["encoding"], "utf8");

    let untracked = rpc(
        &core,
        "remux/fs/readFile",
        Some(json!({
            "git": { "includeBase": true, "includeStatus": true },
            "path": root_path.join("loose.txt").to_string_lossy(),
        })),
    )
    .await
    .unwrap();
    assert_eq!(untracked["git"]["status"], "untracked");
    assert_eq!(untracked["git"]["base"]["status"], "untracked");
    assert_eq!(untracked["git"]["base"]["content"], "");
}

#[tokio::test]
async fn read_file_outside_a_repo_gets_the_not_in_git_reason() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let file_path = root_path.join("file.txt");
    std::fs::write(&file_path, "hello\n").unwrap();

    let core = FsCore::new(&root_path);
    let result = rpc(
        &core,
        "remux/fs/readFile",
        Some(json!({
            "git": { "includeBase": true, "includeStatus": true },
            "path": file_path.to_string_lossy(),
        })),
    )
    .await
    .unwrap();

    assert_eq!(result["content"], "hello\n");
    assert_eq!(result["git"]["status"], Value::Null);
    assert_eq!(result["git"]["repoRoot"], Value::Null);
    assert_eq!(
        result["git"]["base"],
        json!({
            "content": null,
            "encoding": null,
            "isBinary": false,
            "path": file_path.to_string_lossy(),
            "ref": "HEAD",
            "repoRoot": null,
            "sizeBytes": null,
            "status": null,
            "tooLarge": false,
            "unavailableReason": "File is not in a git repository.",
        })
    );
}

#[tokio::test]
async fn reads_utf8_base64_binary_and_oversized_files() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let core = FsCore::new(&root_path);

    std::fs::write(root_path.join("README.md"), "# hello\n").unwrap();
    let result = rpc(
        &core,
        "remux/fs/readFile",
        Some(json!({ "path": "README.md" })),
    )
    .await
    .unwrap();
    assert_eq!(
        result["path"],
        root_path.join("README.md").to_string_lossy().as_ref()
    );
    assert_eq!(result["name"], "README.md");
    assert_eq!(result["content"], "# hello\n");
    assert_eq!(result["encoding"], "utf8");
    assert_eq!(result["isBinary"], false);
    assert_eq!(result["sizeBytes"], 8);
    assert_eq!(result["tooLarge"], false);
    assert!(result["modifiedAtMs"].is_number());

    let bytes = [0x89u8, 0x50, 0x4e, 0x47, 0x00, 0x01];
    std::fs::write(root_path.join("image.png"), bytes).unwrap();
    let result = rpc(
        &core,
        "remux/fs/readFile",
        Some(json!({ "format": "base64", "path": "image.png" })),
    )
    .await
    .unwrap();
    assert_eq!(result["content"], Value::Null);
    assert_eq!(result["dataBase64"], "iVBORwAB");
    assert_eq!(result["encoding"], "base64");
    assert_eq!(result["isBinary"], true);
    assert_eq!(result["mimeType"], "image/png");
    assert_eq!(result["sizeBytes"], 6);

    std::fs::write(root_path.join("image.bin"), [0x00u8, 0x01, 0x02, 0x03]).unwrap();
    let result = rpc(
        &core,
        "remux/fs/readFile",
        Some(json!({ "path": "image.bin" })),
    )
    .await
    .unwrap();
    assert_eq!(result["content"], Value::Null);
    assert_eq!(result["encoding"], Value::Null);
    assert_eq!(result["isBinary"], true);
    assert_eq!(result["sizeBytes"], 4);
    assert_eq!(result["tooLarge"], false);

    let big = vec![b'a'; 1024 * 1024 + 1];
    std::fs::write(root_path.join("large.txt"), &big).unwrap();
    let result = rpc(
        &core,
        "remux/fs/readFile",
        Some(json!({ "path": "large.txt" })),
    )
    .await
    .unwrap();
    assert_eq!(result["content"], Value::Null);
    assert_eq!(result["encoding"], Value::Null);
    assert_eq!(result["isBinary"], false);
    assert_eq!(result["sizeBytes"], 1024 * 1024 + 1);
    assert_eq!(result["tooLarge"], true);
}

#[tokio::test]
async fn emits_directory_served_on_fresh_reads_and_honors_unsubscribe() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    std::fs::create_dir(root_path.join("src")).unwrap();

    let core = FsCore::new(&root_path);
    let served = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = served.clone();
    let subscription = core.subscribe(Box::new(move |event| {
        sink.lock().unwrap().push(event.clone());
    }));

    rpc(&core, "remux/fs/readDirectory", None).await.unwrap();
    {
        let served = served.lock().unwrap();
        assert_eq!(served.len(), 1);
        assert_eq!(served[0].path, root_path);
        assert_eq!(served[0].repo_root, None);
    }

    // A cached re-read does not emit again.
    rpc(&core, "remux/fs/readDirectory", None).await.unwrap();
    assert_eq!(served.lock().unwrap().len(), 1);

    core.unsubscribe(subscription);
    rpc(
        &core,
        "remux/fs/readDirectory",
        Some(json!({ "force": true })),
    )
    .await
    .unwrap();
    assert_eq!(served.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn invalidate_paths_and_under_roots_drop_cached_listings() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let child = root_path.join("child");
    std::fs::create_dir(&child).unwrap();

    let core = FsCore::new(&root_path);
    let before = rpc(&core, "remux/fs/readDirectory", None).await.unwrap();
    assert_eq!(entry_names(&before), vec!["child"]);

    std::fs::write(root_path.join("fresh.txt"), "hi").unwrap();
    let cached = rpc(&core, "remux/fs/readDirectory", None).await.unwrap();
    assert_eq!(entry_names(&cached), vec!["child"], "cache hit within TTL");

    core.invalidate(std::slice::from_ref(&root_path), &[]);
    let after = rpc(&core, "remux/fs/readDirectory", None).await.unwrap();
    assert_eq!(entry_names(&after), vec!["child", "fresh.txt"]);

    // underRoots drops every listing under the root, including the root.
    rpc(
        &core,
        "remux/fs/readDirectory",
        Some(json!({ "path": child.to_string_lossy() })),
    )
    .await
    .unwrap();
    std::fs::write(root_path.join("root.txt"), "r").unwrap();
    std::fs::write(child.join("child.txt"), "c").unwrap();
    core.invalidate(&[], std::slice::from_ref(&root_path));

    let root_result = rpc(&core, "remux/fs/readDirectory", None).await.unwrap();
    let child_result = rpc(
        &core,
        "remux/fs/readDirectory",
        Some(json!({ "path": child.to_string_lossy() })),
    )
    .await
    .unwrap();
    assert!(entry_names(&root_result).contains(&"root.txt".to_string()));
    assert_eq!(entry_names(&child_result), vec!["child.txt"]);
}

#[tokio::test]
async fn reports_symlink_target_kinds() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    std::fs::create_dir(root_path.join("real-dir")).unwrap();
    std::fs::write(root_path.join("real-file.txt"), "hi").unwrap();
    std::os::unix::fs::symlink(root_path.join("real-dir"), root_path.join("dir-link")).unwrap();
    std::os::unix::fs::symlink(root_path.join("real-file.txt"), root_path.join("file-link"))
        .unwrap();
    std::os::unix::fs::symlink(root_path.join("missing"), root_path.join("broken-link")).unwrap();

    let core = FsCore::new(&root_path);
    let result = rpc(&core, "remux/fs/readDirectory", None).await.unwrap();
    let by_name: std::collections::HashMap<String, Value> = result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| (entry["name"].as_str().unwrap().to_string(), entry.clone()))
        .collect();

    assert_eq!(by_name["dir-link"]["kind"], "symlink");
    assert_eq!(by_name["dir-link"]["targetKind"], "directory");
    assert_eq!(by_name["file-link"]["kind"], "symlink");
    assert_eq!(by_name["file-link"]["targetKind"], "file");
    assert_eq!(by_name["broken-link"]["kind"], "symlink");
    assert_eq!(by_name["broken-link"]["targetKind"], Value::Null);
    assert_eq!(by_name["real-dir"]["targetKind"], Value::Null);
}
