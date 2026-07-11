use std::cmp::Ordering;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::util::stable_revision_value;

const DEFAULT_FILE_BYTES_LIMIT: u64 = 8 * 1024 * 1024;
const MAX_FILE_BYTES_LIMIT: u64 = 8 * 1024 * 1024;
const MAX_FILE_REQUESTS: usize = 32;
const MAX_FILE_RESPONSE_BYTES: usize = 12 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT: usize = 80;
const MAX_SEARCH_LIMIT: usize = 200;
const MAX_SEARCH_VISITED: usize = 30_000;

#[derive(Debug, Default)]
pub(crate) struct CodexFileResourcesServer;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileResourcesReadParams {
    requests: Vec<FileResourceRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum FileResourceRequest {
    #[serde(rename = "directoryListing", rename_all = "camelCase")]
    DirectoryListing {
        known_revision: Option<String>,
        path: String,
    },
    #[serde(rename = "directoryDetails", rename_all = "camelCase")]
    DirectoryDetails {
        known_revision: Option<String>,
        path: String,
    },
    #[serde(rename = "fileSearch", rename_all = "camelCase")]
    FileSearch {
        include_directories: Option<bool>,
        include_files: Option<bool>,
        known_revision: Option<String>,
        limit: Option<u32>,
        query: String,
        roots: Vec<String>,
    },
    #[serde(rename = "fileBytes", rename_all = "camelCase")]
    FileBytes {
        known_revision: Option<String>,
        max_bytes: Option<u64>,
        path: String,
    },
}

impl CodexFileResourcesServer {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(crate) fn read_resources(&self, params: Value) -> Result<Value, String> {
        let params: FileResourcesReadParams = serde_json::from_value(params)
            .map_err(|error| format!("invalid remux/codex/files params: {error}"))?;
        if params.requests.len() > MAX_FILE_REQUESTS {
            return Err(format!(
                "too many file requests: {}>{MAX_FILE_REQUESTS}",
                params.requests.len()
            ));
        }
        let resources = params
            .requests
            .into_iter()
            .enumerate()
            .map(|(request_index, request)| self.read_resource(request_index, request))
            .collect::<Vec<_>>();

        let response = json!({ "resources": resources });
        let encoded_len = serde_json::to_vec(&response)
            .map_err(|error| format!("failed to encode files response: {error}"))?
            .len();
        if encoded_len > MAX_FILE_RESPONSE_BYTES {
            return Err(format!(
                "files response is too large: {encoded_len}>{MAX_FILE_RESPONSE_BYTES}"
            ));
        }
        Ok(response)
    }

    fn read_resource(&self, request_index: usize, request: FileResourceRequest) -> Value {
        match request {
            FileResourceRequest::DirectoryListing {
                known_revision,
                path,
            } => self.read_directory_listing(request_index, path, known_revision),
            FileResourceRequest::DirectoryDetails {
                known_revision,
                path,
            } => self.read_directory_details(request_index, path, known_revision),
            FileResourceRequest::FileSearch {
                include_directories,
                include_files,
                known_revision,
                limit,
                query,
                roots,
            } => self.read_file_search(
                request_index,
                FileSearchRequest {
                    include_directories,
                    include_files,
                    known_revision,
                    limit,
                    query,
                    roots,
                },
            ),
            FileResourceRequest::FileBytes {
                known_revision,
                max_bytes,
                path,
            } => self.read_file_bytes(request_index, path, max_bytes, known_revision),
        }
    }

    fn read_directory_listing(
        &self,
        request_index: usize,
        path: String,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("directoryListing:{path}");
        let Some(path_buf) = non_empty_path(&path) else {
            return missing_result(request_index, key, "path_required".to_string());
        };
        if !path_buf.exists() {
            return missing_result(request_index, key, "path_missing".to_string());
        }
        if !path_buf.is_dir() {
            return error_result(request_index, key, "path_not_directory".to_string());
        }

        let entries = match fs::read_dir(&path_buf) {
            Ok(entries) => entries,
            Err(error) => return error_result(request_index, key, error.to_string()),
        };
        let mut entries = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_name = entry.file_name().to_string_lossy().to_string();
                let is_directory = entry.file_type().map(|file_type| file_type.is_dir()).ok()?;
                Some(json!({
                    "fileName": file_name,
                    "isDirectory": is_directory,
                    "path": path_string(&entry.path()),
                }))
            })
            .collect::<Vec<_>>();
        entries.sort_by(compare_directory_entries);

        let mut value = json!({
            "entries": entries,
            "path": path_string(&path_buf),
        });
        let revision = stable_revision_value(&value);
        value["revision"] = Value::String(revision.clone());

        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        ok_result(request_index, key, revision, value)
    }

    fn read_directory_details(
        &self,
        request_index: usize,
        path: String,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("directoryDetails:{path}");
        let Some(path_buf) = non_empty_path(&path) else {
            return missing_result(request_index, key, "path_required".to_string());
        };
        let metadata = match fs::metadata(&path_buf) {
            Ok(metadata) => metadata,
            Err(error) => return missing_result(request_index, key, error.to_string()),
        };
        let is_directory = metadata.is_dir();
        let item_count = if is_directory {
            fs::read_dir(&path_buf)
                .ok()
                .map(|entries| entries.filter_map(Result::ok).count())
        } else {
            None
        };
        let mut value = json!({
            "isDirectory": is_directory,
            "itemCount": item_count,
            "modifiedAtMs": modified_at_ms(&metadata),
            "path": path_string(&path_buf),
            "sizeBytes": if metadata.is_file() { Some(metadata.len()) } else { None },
        });
        let revision = stable_revision_value(&value);
        value["revision"] = Value::String(revision.clone());

        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        ok_result(request_index, key, revision, value)
    }

    fn read_file_search(&self, request_index: usize, request: FileSearchRequest) -> Value {
        let query = normalize_query(&request.query);
        let limit = request
            .limit
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_SEARCH_LIMIT)
            .clamp(1, MAX_SEARCH_LIMIT);
        let include_directories = request.include_directories.unwrap_or(true);
        let include_files = request.include_files.unwrap_or(true);
        let roots = request.roots;
        let key = format!(
            "fileSearch:{}:{}:{}:{}",
            query, limit, include_files, include_directories
        );

        let results = if query.is_empty() {
            Vec::new()
        } else {
            search_files(FileSearchOptions {
                include_directories,
                include_files,
                limit,
                query: &query,
                roots: &roots,
            })
        };

        let mut value = json!({
            "query": query,
            "results": results,
            "roots": roots,
        });
        let revision = stable_revision_value(&value);
        value["revision"] = Value::String(revision.clone());

        if request.known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        ok_result(request_index, key, revision, value)
    }

    fn read_file_bytes(
        &self,
        request_index: usize,
        path: String,
        max_bytes: Option<u64>,
        known_revision: Option<String>,
    ) -> Value {
        let key = format!("fileBytes:{path}");
        let Some(path_buf) = non_empty_path(&path) else {
            return missing_result(request_index, key, "path_required".to_string());
        };
        let metadata = match fs::metadata(&path_buf) {
            Ok(metadata) => metadata,
            Err(error) => return missing_result(request_index, key, error.to_string()),
        };
        if !metadata.is_file() {
            return error_result(request_index, key, "path_not_file".to_string());
        }

        let limit = max_bytes
            .unwrap_or(DEFAULT_FILE_BYTES_LIMIT)
            .clamp(1, MAX_FILE_BYTES_LIMIT);
        if metadata.len() > limit {
            return error_result(
                request_index,
                key,
                format!("file_too_large:{}>{}", metadata.len(), limit),
            );
        }

        let bytes = match fs::read(&path_buf) {
            Ok(bytes) => bytes,
            Err(error) => return error_result(request_index, key, error.to_string()),
        };
        let mut value = json!({
            "dataBase64": base64_encode(&bytes),
            "path": path_string(&path_buf),
            "sizeBytes": metadata.len(),
        });
        let revision = stable_revision_value(&value);
        value["revision"] = Value::String(revision.clone());

        if known_revision.as_deref() == Some(revision.as_str()) {
            return not_modified_result(request_index, key, revision);
        }

        ok_result(request_index, key, revision, value)
    }
}

struct FileSearchRequest {
    include_directories: Option<bool>,
    include_files: Option<bool>,
    known_revision: Option<String>,
    limit: Option<u32>,
    query: String,
    roots: Vec<String>,
}

struct FileSearchOptions<'a> {
    include_directories: bool,
    include_files: bool,
    limit: usize,
    query: &'a str,
    roots: &'a [String],
}

#[derive(Debug)]
struct SearchMatch {
    absolute_path: String,
    kind: &'static str,
    name: String,
    parent_path: String,
    path: String,
    root: String,
    score: i64,
}

fn search_files(options: FileSearchOptions<'_>) -> Vec<Value> {
    let mut matches = Vec::new();
    let mut visited = 0usize;

    for root in options.roots {
        if visited >= MAX_SEARCH_VISITED {
            break;
        }

        let root_path = PathBuf::from(root);
        if !root_path.is_dir() {
            continue;
        }

        let mut queue = VecDeque::from([root_path.clone()]);
        while let Some(directory) = queue.pop_front() {
            if visited >= MAX_SEARCH_VISITED {
                break;
            }

            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) => continue,
            };

            for entry in entries.filter_map(Result::ok) {
                if visited >= MAX_SEARCH_VISITED {
                    break;
                }
                visited += 1;

                let file_name = entry.file_name().to_string_lossy().to_string();
                let path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(_) => continue,
                };
                let is_directory = file_type.is_dir();

                if is_directory && should_skip_search_directory(&file_name) {
                    continue;
                }

                if is_directory {
                    queue.push_back(path.clone());
                }

                let kind = if is_directory { "directory" } else { "file" };
                if (is_directory && !options.include_directories)
                    || (!is_directory && !options.include_files)
                {
                    continue;
                }

                let relative_path = relative_path(&root_path, &path);
                let Some(score) = match_score(options.query, &file_name, &relative_path) else {
                    continue;
                };

                matches.push(SearchMatch {
                    absolute_path: path_string(&path),
                    kind,
                    name: file_name,
                    parent_path: parent_path(&relative_path),
                    path: relative_path,
                    root: path_string(&root_path),
                    score,
                });
            }
        }
    }

    matches.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
    });
    matches.truncate(options.limit);

    matches
        .into_iter()
        .map(|item| {
            json!({
                "absolutePath": item.absolute_path,
                "id": format!("{}:{}", item.root, item.path),
                "kind": item.kind,
                "name": item.name,
                "parentPath": item.parent_path,
                "path": item.path,
                "score": item.score,
            })
        })
        .collect()
}

fn match_score(query: &str, file_name: &str, relative_path: &str) -> Option<i64> {
    let name = file_name.to_lowercase();
    let path = relative_path.to_lowercase();
    let base_score = if name == query {
        10_000
    } else if path == query {
        9_500
    } else if name.starts_with(query) {
        9_000
    } else if path.starts_with(query) {
        8_000
    } else if name.contains(query) {
        7_000
    } else if path.contains(query) {
        6_000
    } else {
        return None;
    };

    Some(base_score - relative_path.len().min(1_000) as i64)
}

fn should_skip_search_directory(file_name: &str) -> bool {
    matches!(
        file_name,
        ".git"
            | ".next"
            | ".turbo"
            | ".cache"
            | "DerivedData"
            | "build"
            | "dist"
            | "node_modules"
            | "target"
    )
}

fn normalize_query(query: &str) -> String {
    query
        .trim()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_lowercase()
}

fn non_empty_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() {
        return None;
    }

    Some(PathBuf::from(path))
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string()
}

fn parent_path(path: &str) -> String {
    path.rfind('/')
        .filter(|index| *index > 0)
        .map(|index| path[..index].to_string())
        .unwrap_or_default()
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn modified_at_ms(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

fn compare_directory_entries(left: &Value, right: &Value) -> Ordering {
    let left_name = left
        .get("fileName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let right_name = right
        .get("fileName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let left_hidden = left_name.starts_with('.');
    let right_hidden = right_name.starts_with('.');

    left_hidden
        .cmp(&right_hidden)
        .then_with(|| left_name.to_lowercase().cmp(&right_name.to_lowercase()))
}

fn ok_result(request_index: usize, key: String, revision: String, value: Value) -> Value {
    json!({
        "key": key,
        "requestIndex": request_index,
        "revision": revision,
        "status": "ok",
        "value": value,
    })
}

fn not_modified_result(request_index: usize, key: String, revision: String) -> Value {
    json!({
        "key": key,
        "requestIndex": request_index,
        "revision": revision,
        "status": "notModified",
    })
}

fn missing_result(request_index: usize, key: String, reason: String) -> Value {
    json!({
        "key": key,
        "reason": reason,
        "requestIndex": request_index,
        "status": "missing",
    })
}

fn error_result(request_index: usize, key: String, reason: String) -> Value {
    json!({
        "key": key,
        "reason": reason,
        "requestIndex": request_index,
        "status": "error",
    })
}

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0;

    while index + 3 <= bytes.len() {
        let first = bytes[index];
        let second = bytes[index + 1];
        let third = bytes[index + 2];
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        output.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        output.push(TABLE[(third & 0b0011_1111) as usize] as char);
        index += 3;
    }

    match bytes.len() - index {
        1 => {
            let first = bytes[index];
            output.push(TABLE[(first >> 2) as usize] as char);
            output.push(TABLE[((first & 0b0000_0011) << 4) as usize] as char);
            output.push('=');
            output.push('=');
        }
        2 => {
            let first = bytes[index];
            let second = bytes[index + 1];
            output.push(TABLE[(first >> 2) as usize] as char);
            output.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
            output.push(TABLE[((second & 0b0000_1111) << 2) as usize] as char);
            output.push('=');
        }
        _ => {}
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_directory_listing() {
        let root = create_test_dir("listing");
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("README.md"), "hello").unwrap();

        let server = CodexFileResourcesServer::new();
        let response = server
            .read_resources(json!({
                "requests": [{ "type": "directoryListing", "path": path_string(&root) }]
            }))
            .unwrap();
        let resources = response["resources"].as_array().unwrap();
        let value = &resources[0]["value"];
        let entries = value["entries"].as_array().unwrap();

        assert_eq!(resources[0]["status"], "ok");
        assert!(
            entries
                .iter()
                .any(|entry| entry["fileName"] == "src" && entry["isDirectory"] == true)
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry["fileName"] == "README.md" && entry["isDirectory"] == false)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn searches_files_and_directories() {
        let root = create_test_dir("search");
        fs::create_dir_all(root.join("viewer/composer")).unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::write(root.join("viewer/composer/MentionPicker.tsx"), "").unwrap();

        let server = CodexFileResourcesServer::new();
        let response = server
            .read_resources(json!({
                "requests": [{
                    "type": "fileSearch",
                    "query": "mention",
                    "roots": [path_string(&root)],
                    "limit": 10
                }]
            }))
            .unwrap();
        let results = response["resources"][0]["value"]["results"]
            .as_array()
            .unwrap();

        assert_eq!(response["resources"][0]["status"], "ok");
        assert!(
            results
                .iter()
                .any(|result| result["path"] == "viewer/composer/MentionPicker.tsx")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_file_bytes_as_base64() {
        let root = create_test_dir("bytes");
        let file = root.join("hello.txt");
        fs::write(&file, "hello").unwrap();

        let server = CodexFileResourcesServer::new();
        let response = server
            .read_resources(json!({
                "requests": [{ "type": "fileBytes", "path": path_string(&file) }]
            }))
            .unwrap();

        assert_eq!(response["resources"][0]["status"], "ok");
        assert_eq!(response["resources"][0]["value"]["dataBase64"], "aGVsbG8=");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn returns_not_modified_for_known_revision() {
        let root = create_test_dir("revision");
        fs::write(root.join("file.txt"), "hello").unwrap();
        let server = CodexFileResourcesServer::new();
        let first = server
            .read_resources(json!({
                "requests": [{ "type": "directoryDetails", "path": path_string(&root) }]
            }))
            .unwrap();
        let revision = first["resources"][0]["revision"].as_str().unwrap();
        let second = server
            .read_resources(json!({
                "requests": [{
                    "type": "directoryDetails",
                    "path": path_string(&root),
                    "knownRevision": revision
                }]
            }))
            .unwrap();

        assert_eq!(second["resources"][0]["status"], "notModified");

        let _ = fs::remove_dir_all(root);
    }

    fn create_test_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "remux-codex-file-resources-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
