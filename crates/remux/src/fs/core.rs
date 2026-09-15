//! fs core, ported from `cli/core/fs.cjs` with identical method names,
//! params, result shapes, error codes, cache TTLs (directory 3s + in-flight
//! dedup, git status 1s, repo root 5s), concurrency limits (batch 4, entries
//! 24), and file caps (1 MiB text / 5 MiB base64).
//! Delete returns the descriptor captured before removal, plus `deleted: true`.
//! Atomic writes replace the named entry (including symlinks); reads follow links.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};
use tokio::io::AsyncReadExt;

use crate::fs::file_window::{
    read_file_window, FileWindowRequest, DEFAULT_WINDOW_BYTES, MAX_WINDOW_BYTES, MIN_WINDOW_BYTES,
};
use crate::fs::git::{
    git_repo_root, git_status_entries, index_git_status, is_path_within, relative_git_path,
    summarize_git_statuses, GitStatus, IndexedGitStatus,
};
use crate::paths;
use crate::rpc::jsonrpc::{JsonRpcError, INVALID_PARAMS};
use crate::rpc::router::{BoxFuture, CoreRpc, RpcResult};

pub const READ_DIRECTORY_METHOD: &str = "remux/fs/readDirectory";
pub const READ_DIRECTORIES_METHOD: &str = "remux/fs/readDirectories";
pub const READ_FILE_METHOD: &str = "remux/fs/readFile";
pub const READ_FILE_GIT_METHOD: &str = "remux/fs/readFileGit";
pub const READ_FILE_WINDOW_METHOD: &str = "remux/fs/readFileWindow";

pub const STAT_METHOD: &str = "remux/fs/stat";
pub const WRITE_FILE_METHOD: &str = "remux/fs/writeFile";
pub const CREATE_DIRECTORY_METHOD: &str = "remux/fs/createDirectory";
pub const RENAME_METHOD: &str = "remux/fs/rename";
pub const DELETE_METHOD: &str = "remux/fs/delete";
pub const MUTATION_ERROR: i64 = -32013;

pub const DIRECTORY_BATCH_CONCURRENCY: usize = 4;
pub const DIRECTORY_CACHE_TTL_MS: u64 = 3_000;
pub const DIRECTORY_ENTRY_CONCURRENCY: usize = 24;
pub const MAX_DIRECTORY_BATCH_PATHS: usize = 128;
pub const MAX_BINARY_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_TEXT_FILE_BYTES: u64 = 1024 * 1024;
pub const GIT_REPO_ROOT_CACHE_TTL_MS: u64 = 5_000;
pub const GIT_STATUS_CACHE_TTL_MS: u64 = 1_000;

pub const READ_DIRECTORY_ERROR: i64 = -32010;
pub const READ_FILE_ERROR: i64 = -32011;
pub const READ_FILE_WINDOW_ERROR: i64 = -32012;

/// Emitted for every fresh (uncached) directory read; the fs relay registers
/// watchers from this feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryServedEvent {
    pub path: PathBuf,
    pub repo_root: Option<PathBuf>,
}

type ServedListener = Box<dyn Fn(&DirectoryServedEvent) + Send + Sync>;

struct CachedDirectory {
    loaded_at: Instant,
    result: Value,
}

struct CachedRepoRoot {
    loaded_at: Instant,
    repo_root: Option<PathBuf>,
}

struct CachedStatus {
    loaded_at: Instant,
    status: Arc<IndexedGitStatus>,
}

pub struct FsCore {
    default_path: PathBuf,
    relay: Mutex<std::sync::Weak<crate::fs::relay::FsRelay>>,
    pub(crate) mutation_lock: Arc<Mutex<()>>,
    directory_cache: Mutex<HashMap<PathBuf, CachedDirectory>>,
    directory_gates: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
    repo_root_cache: Mutex<HashMap<PathBuf, CachedRepoRoot>>,
    status_cache: Mutex<HashMap<PathBuf, CachedStatus>>,
    served_listeners: Mutex<Vec<(u64, ServedListener)>>,
    next_listener_id: Mutex<u64>,
}

impl FsCore {
    pub fn new(root_dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            default_path: paths::resolve(root_dir),
            relay: Mutex::new(std::sync::Weak::new()),
            mutation_lock: Arc::new(Mutex::new(())),
            directory_cache: Mutex::new(HashMap::new()),
            directory_gates: Mutex::new(HashMap::new()),
            repo_root_cache: Mutex::new(HashMap::new()),
            status_cache: Mutex::new(HashMap::new()),
            served_listeners: Mutex::new(Vec::new()),
            next_listener_id: Mutex::new(1),
        })
    }

    pub async fn handle_rpc(&self, method: &str, params: Option<&Value>) -> RpcResult {
        match method {
            STAT_METHOD => {
                let path = resolve_requested_path(&self.default_path, params, method)?;
                tokio::task::spawn_blocking(move || stat_path(&path))
                    .await
                    .map_err(|e| fs_error(READ_FILE_ERROR, &std::io::Error::other(e)))?
                    .map_err(|e| fs_error(READ_FILE_ERROR, &e))
            }
            WRITE_FILE_METHOD | CREATE_DIRECTORY_METHOD | RENAME_METHOD | DELETE_METHOD => {
                self.mutate(method, params).await
            }
            READ_DIRECTORY_METHOD => self.read_directory(params).await,
            READ_DIRECTORIES_METHOD => self.read_directories(params).await,
            READ_FILE_METHOD => self.read_file(params).await,
            READ_FILE_GIT_METHOD => self.read_file_git(params).await,
            READ_FILE_WINDOW_METHOD => self.read_file_window(params).await,
            _ => Err(JsonRpcError::method_not_found(method)),
        }
    }

    pub fn set_relay(&self, relay: &Arc<crate::fs::relay::FsRelay>) {
        *self.relay.lock().unwrap() = Arc::downgrade(relay);
    }

    pub fn on_paths_mutated(&self, paths: &[PathBuf]) {
        let parents: Vec<_> = paths
            .iter()
            .filter_map(|p| p.parent().map(Path::to_path_buf))
            .collect();
        self.invalidate(&parents, &[]);
        if let Some(relay) = self.relay.lock().unwrap().upgrade() {
            relay.on_paths_mutated(paths);
        }
    }

    async fn mutate(&self, method: &str, params: Option<&Value>) -> RpcResult {
        let record = params
            .and_then(Value::as_object)
            .ok_or_else(|| JsonRpcError::new(INVALID_PARAMS, "Expected mutation params"))?;
        let field = if method == RENAME_METHOD {
            "from"
        } else {
            "path"
        };
        let requested = required_string(record, field)?;
        let path = resolve_requested_path(
            &self.default_path,
            Some(&serde_json::json!({"path": requested})),
            method,
        )?;
        let destination = if method == RENAME_METHOD {
            Some(resolve_requested_path(
                &self.default_path,
                Some(&serde_json::json!({"path": required_string(record, "to")?})),
                method,
            )?)
        } else {
            None
        };
        let content = if method == WRITE_FILE_METHOD {
            let content = record
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| JsonRpcError::new(INVALID_PARAMS, "Expected UTF-8 content"))?;
            if content.len() as u64 > MAX_BINARY_FILE_BYTES {
                return Err(mutation_error("tooLarge", "Text exceeds 5 MiB"));
            }
            Some(content.to_owned())
        } else {
            None
        };
        let expected = match record.get("expectedVersion") {
            None => None,
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => return Err(JsonRpcError::new(INVALID_PARAMS, "Invalid expectedVersion")),
        };
        let create = optional_bool(record, "create")?;
        let overwrite = optional_bool(record, "overwrite")?;
        let recursive = optional_bool(record, "recursive")?;
        let method = method.to_owned();
        let lock = self.mutation_lock.clone();
        let relay = self.relay.lock().unwrap().clone();
        let changed = vec![path.clone()]
            .into_iter()
            .chain(destination.clone())
            .collect::<Vec<_>>();
        let notification_paths = changed.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _guard = lock.lock().unwrap();
            let affected = destination.as_deref().unwrap_or(&path);
            let before_delete = if method == DELETE_METHOD {
                Some(stat_path(&path).map_err(|e| fs_error(MUTATION_ERROR, &e))?)
            } else {
                None
            };
            match method.as_str() {
                WRITE_FILE_METHOD => {
                    let previous =
                        existing_metadata(&path).map_err(|e| fs_error(MUTATION_ERROR, &e))?;
                    if create && previous.is_some() {
                        return Err(mutation_error("exists", "Target exists"));
                    }
                    if let Some(expected) = expected {
                        if current_version(&path)
                            .map_err(|e| fs_error(MUTATION_ERROR, &e))?
                            .as_deref()
                            != Some(&expected)
                        {
                            return Err(mutation_error("versionChanged", "File version changed"));
                        }
                    }
                    let mut temp = tempfile::Builder::new()
                        .prefix(".remux-upload-")
                        .tempfile_in(path.parent().unwrap_or(Path::new("/")))
                        .map_err(|e| fs_error(MUTATION_ERROR, &e))?;
                    use std::io::Write;
                    temp.write_all(content.as_ref().unwrap().as_bytes())
                        .map_err(|e| fs_error(MUTATION_ERROR, &e))?;
                    if let Some(metadata) = previous {
                        temp.as_file()
                            .set_permissions(metadata.permissions())
                            .map_err(|e| fs_error(MUTATION_ERROR, &e))?;
                    }
                    temp.as_file()
                        .sync_all()
                        .map_err(|e| fs_error(MUTATION_ERROR, &e))?;
                    atomic_rename(temp.path(), &path, !create)
                        .map_err(|e| fs_error(MUTATION_ERROR, &e))?;
                }
                CREATE_DIRECTORY_METHOD => {
                    std::fs::create_dir(&path).map_err(|e| fs_error(MUTATION_ERROR, &e))?
                }
                RENAME_METHOD => atomic_rename(&path, affected, overwrite)
                    .map_err(|e| fs_error(MUTATION_ERROR, &e))?,
                DELETE_METHOD => {
                    let metadata = std::fs::symlink_metadata(&path)
                        .map_err(|e| fs_error(MUTATION_ERROR, &e))?;
                    let result = if metadata.is_dir() {
                        if recursive {
                            std::fs::remove_dir_all(&path)
                        } else {
                            std::fs::remove_dir(&path)
                        }
                    } else {
                        std::fs::remove_file(&path)
                    };
                    result.map_err(|e| fs_error(MUTATION_ERROR, &e))?;
                }
                _ => unreachable!(),
            }
            if let Some(relay) = relay.upgrade() {
                relay.on_paths_mutated(&notification_paths);
            }
            if let Some(mut descriptor) = before_delete {
                descriptor["deleted"] = Value::Bool(true);
                Ok(descriptor)
            } else {
                stat_path(affected).map_err(|e| fs_error(MUTATION_ERROR, &e))
            }
        })
        .await
        .map_err(|e| fs_error(MUTATION_ERROR, &std::io::Error::other(e)))?;
        // Also invalidate standalone cores that have no relay wired.
        self.invalidate(
            &changed
                .iter()
                .filter_map(|p| p.parent().map(Path::to_path_buf))
                .collect::<Vec<_>>(),
            &[],
        );
        result
    }

    /// Cache invalidation used by the relay before each `didChange`
    /// broadcast (the stale-read race guard).
    pub fn invalidate(&self, paths: &[PathBuf], under_roots: &[PathBuf]) {
        let mut cache = self.directory_cache.lock().unwrap();
        for target in paths {
            cache.remove(&crate::paths::resolve(target));
        }
        for root in under_roots {
            let resolved = crate::paths::resolve(root);
            cache.retain(|key, _| !is_path_within(&resolved, key));
            self.status_cache.lock().unwrap().remove(&resolved);
        }
    }

    pub fn subscribe(&self, listener: ServedListener) -> u64 {
        let id = {
            let mut next = self.next_listener_id.lock().unwrap();
            let id = *next;
            *next += 1;
            id
        };
        self.served_listeners.lock().unwrap().push((id, listener));
        id
    }

    pub fn unsubscribe(&self, id: u64) {
        self.served_listeners
            .lock()
            .unwrap()
            .retain(|(listener_id, _)| *listener_id != id);
    }

    fn notify_directory_served(&self, event: &DirectoryServedEvent) {
        // Listener failures must never break reads (they can't panic across
        // this boundary without poisoning; listeners are plain closures).
        for (_, listener) in self.served_listeners.lock().unwrap().iter() {
            listener(event);
        }
    }

    async fn read_directory(&self, params: Option<&Value>) -> RpcResult {
        let target_path =
            resolve_requested_path(&self.default_path, params, READ_DIRECTORY_METHOD)?;
        let force = params
            .and_then(|params| params.get("force"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.read_directory_cached(target_path, force).await
    }

    async fn read_directories(&self, params: Option<&Value>) -> RpcResult {
        let record = params.and_then(Value::as_object);
        let paths_param = record
            .and_then(|record| record.get("paths"))
            .and_then(Value::as_array);
        let Some(paths_param) = paths_param else {
            return Err(JsonRpcError::new(
                INVALID_PARAMS,
                format!("Invalid {READ_DIRECTORIES_METHOD} params"),
            ));
        };
        let force = record
            .and_then(|record| record.get("force"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !paths_param.iter().all(Value::is_string) {
            return Err(JsonRpcError::new(
                INVALID_PARAMS,
                format!("Invalid {READ_DIRECTORIES_METHOD} paths"),
            ));
        }
        if paths_param.len() > MAX_DIRECTORY_BATCH_PATHS {
            return Err(JsonRpcError::new(
                INVALID_PARAMS,
                format!(
                    "Invalid {READ_DIRECTORIES_METHOD} paths: maximum {MAX_DIRECTORY_BATCH_PATHS}"
                ),
            ));
        }

        let targets: Vec<PathBuf> = paths_param
            .iter()
            .map(|entry| {
                let entry = entry.as_str().expect("validated");
                if entry.is_empty() {
                    self.default_path.clone()
                } else if entry.starts_with('/') {
                    paths::resolve(Path::new(entry))
                } else {
                    paths::resolve_from(&self.default_path, entry)
                }
            })
            .collect();

        let results: Vec<Value> = futures_util::stream::iter(targets.into_iter().map(|target| {
            let core = self;
            async move {
                match core.read_directory_cached(target.clone(), force).await {
                    Ok(value) => serde_json::json!({
                        "ok": true,
                        "path": target.to_string_lossy(),
                        "value": value,
                    }),
                    Err(error) => serde_json::json!({
                        "message": error.message,
                        "ok": false,
                        "path": target.to_string_lossy(),
                    }),
                }
            }
        }))
        .buffered(DIRECTORY_BATCH_CONCURRENCY)
        .collect()
        .await;

        Ok(serde_json::json!({ "results": results }))
    }

    async fn read_directory_cached(&self, target_path: PathBuf, force: bool) -> RpcResult {
        let ttl = Duration::from_millis(DIRECTORY_CACHE_TTL_MS);
        if !force {
            if let Some(cached) = self.directory_cache.lock().unwrap().get(&target_path) {
                if cached.loaded_at.elapsed() < ttl {
                    return Ok(cached.result.clone());
                }
            }
        }

        // In-flight dedup: concurrent readers (even forced ones) join the
        // read that is already running rather than stacking readdir calls.
        let requested_at = Instant::now();
        let gate = self
            .directory_gates
            .lock()
            .unwrap()
            .entry(target_path.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        let _guard = gate.lock().await;

        if let Some(cached) = self.directory_cache.lock().unwrap().get(&target_path) {
            let fresh_enough = cached.loaded_at.elapsed() < ttl;
            let loaded_while_waiting = cached.loaded_at >= requested_at;
            if loaded_while_waiting || (!force && fresh_enough) {
                return Ok(cached.result.clone());
            }
        }

        let result = self.read_directory_fresh(&target_path).await?;
        self.directory_cache.lock().unwrap().insert(
            target_path,
            CachedDirectory {
                loaded_at: Instant::now(),
                result: result.clone(),
            },
        );
        Ok(result)
    }

    async fn read_directory_fresh(&self, target_path: &Path) -> RpcResult {
        let mut dir = tokio::fs::read_dir(target_path).await.map_err(|error| {
            JsonRpcError::new(
                READ_DIRECTORY_ERROR,
                format!("Directory could not be read: {error}"),
            )
        })?;

        let mut names: Vec<(String, Option<std::fs::FileType>)> = Vec::new();
        while let Ok(Some(entry)) = dir.next_entry().await {
            let file_type = entry.file_type().await.ok();
            names.push((entry.file_name().to_string_lossy().into_owned(), file_type));
        }

        let mut entries: Vec<DirectoryEntry> =
            futures_util::stream::iter(names.into_iter().map(|(name, file_type)| {
                let parent = target_path.to_path_buf();
                async move { directory_entry(&parent, name, file_type).await }
            }))
            .buffered(DIRECTORY_ENTRY_CONCURRENCY)
            .collect()
            .await;

        let git_status = self.read_git_status_for_path(target_path).await;

        entries.sort_by(compare_entries);

        let annotated: Vec<Value> = entries
            .iter()
            .map(|entry| {
                let git = git_status
                    .as_ref()
                    .map(|status| git_status_for_entry(status, entry));
                entry.to_value(git)
            })
            .collect();

        self.notify_directory_served(&DirectoryServedEvent {
            path: target_path.to_path_buf(),
            repo_root: git_status.as_ref().map(|status| status.repo_root.clone()),
        });

        let parent = parent_path(target_path);
        Ok(serde_json::json!({
            "entries": annotated,
            "parentPath": parent.map(|parent| parent.to_string_lossy().into_owned()),
            "path": target_path.to_string_lossy(),
            "version": directory_version(&annotated),
        }))
    }

    async fn read_file(&self, params: Option<&Value>) -> RpcResult {
        let target_path = resolve_requested_path(&self.default_path, params, READ_FILE_METHOD)?;
        let git_options = params
            .and_then(Value::as_object)
            .and_then(|record| record.get("git"))
            .and_then(Value::as_object)
            .cloned();
        let base64 = params
            .and_then(|params| params.get("format"))
            .and_then(Value::as_str)
            == Some("base64");
        let max_file_bytes = if base64 {
            MAX_BINARY_FILE_BYTES
        } else {
            MAX_TEXT_FILE_BYTES
        };

        let stats = tokio::fs::metadata(&target_path).await.map_err(|error| {
            JsonRpcError::new(READ_FILE_ERROR, format!("File could not be read: {error}"))
        })?;
        if !stats.is_file() {
            return Err(JsonRpcError::new(
                INVALID_PARAMS,
                format!("Invalid {READ_FILE_METHOD} path: expected file"),
            ));
        }

        let mut result = Map::new();
        result.insert("encoding".to_string(), Value::Null);
        result.insert("isBinary".to_string(), Value::from(false));
        result.insert("modifiedAtMs".to_string(), modified_at_ms(&stats));
        result.insert(
            "name".to_string(),
            Value::from(
                target_path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ),
        );
        result.insert(
            "path".to_string(),
            Value::from(target_path.to_string_lossy().into_owned()),
        );
        result.insert("sizeBytes".to_string(), Value::from(stats.len()));
        result.insert(
            "tooLarge".to_string(),
            Value::from(stats.len() > max_file_bytes),
        );

        if stats.len() > max_file_bytes {
            result.insert("content".to_string(), Value::Null);
            return self
                .include_file_git(Value::Object(result), git_options.as_ref(), &target_path)
                .await;
        }

        // Metadata can become stale before the read completes. Bound the read
        // itself to one byte over the advertised cap so a growing file cannot
        // inflate either memory use or the encoded RPC response.
        let buffer = read_file_bounded(&target_path, max_file_bytes)
            .await
            .map_err(|error| {
                JsonRpcError::new(READ_FILE_ERROR, format!("File could not be read: {error}"))
            })?;
        let actual_size = buffer.len() as u64;
        result.insert("sizeBytes".to_string(), Value::from(actual_size));
        if actual_size > max_file_bytes {
            result.insert("content".to_string(), Value::Null);
            result.insert("tooLarge".to_string(), Value::from(true));
            return self
                .include_file_git(Value::Object(result), git_options.as_ref(), &target_path)
                .await;
        }

        if base64 {
            use base64_encode::encode as to_base64;
            result.insert("content".to_string(), Value::Null);
            result.insert("dataBase64".to_string(), Value::from(to_base64(&buffer)));
            result.insert("encoding".to_string(), Value::from("base64"));
            result.insert(
                "isBinary".to_string(),
                Value::from(is_likely_binary(&buffer)),
            );
            result.insert(
                "mimeType".to_string(),
                mime_type_from_path(&target_path)
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
            return self
                .include_file_git(Value::Object(result), git_options.as_ref(), &target_path)
                .await;
        }

        if is_likely_binary(&buffer) {
            result.insert("content".to_string(), Value::Null);
            result.insert("isBinary".to_string(), Value::from(true));
            return self
                .include_file_git(Value::Object(result), git_options.as_ref(), &target_path)
                .await;
        }

        result.insert(
            "content".to_string(),
            Value::from(String::from_utf8_lossy(&buffer).into_owned()),
        );
        result.insert("encoding".to_string(), Value::from("utf8"));
        self.include_file_git(Value::Object(result), git_options.as_ref(), &target_path)
            .await
    }

    async fn read_file_window(&self, params: Option<&Value>) -> RpcResult {
        let target_path =
            resolve_requested_path(&self.default_path, params, READ_FILE_WINDOW_METHOD)?;
        let record = params.and_then(Value::as_object).ok_or_else(|| {
            JsonRpcError::new(
                INVALID_PARAMS,
                format!("Invalid {READ_FILE_WINDOW_METHOD} params"),
            )
        })?;
        if record.contains_key("offset") && record.contains_key("targetLine") {
            return Err(JsonRpcError::new(
                INVALID_PARAMS,
                format!("Invalid {READ_FILE_WINDOW_METHOD} params: offset and targetLine are mutually exclusive"),
            ));
        }
        let offset = optional_nonnegative_integer(record.get("offset"), "offset")?.unwrap_or(0);
        let limit = optional_nonnegative_integer(record.get("limit"), "limit")?
            .unwrap_or(DEFAULT_WINDOW_BYTES);
        if !(MIN_WINDOW_BYTES..=MAX_WINDOW_BYTES).contains(&limit) {
            return Err(JsonRpcError::new(
                INVALID_PARAMS,
                format!(
                    "Invalid {READ_FILE_WINDOW_METHOD} limit: expected {MIN_WINDOW_BYTES} to {MAX_WINDOW_BYTES} bytes"
                ),
            ));
        }
        let target_line = optional_nonnegative_integer(record.get("targetLine"), "targetLine")?;
        if target_line == Some(0) {
            return Err(JsonRpcError::new(
                INVALID_PARAMS,
                format!(
                    "Invalid {READ_FILE_WINDOW_METHOD} targetLine: expected a positive integer"
                ),
            ));
        }
        let expected_version = match record.get("expectedVersion") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
            _ => {
                return Err(JsonRpcError::new(
                    INVALID_PARAMS,
                    format!("Invalid {READ_FILE_WINDOW_METHOD} expectedVersion"),
                ))
            }
        };
        read_file_window(FileWindowRequest {
            expected_version,
            limit,
            offset,
            path: target_path,
            target_line,
        })
        .await
        .map_err(|error| {
            JsonRpcError::with_data(
                READ_FILE_WINDOW_ERROR,
                error.message,
                serde_json::json!({ "kind": error.kind.as_str() }),
            )
        })
    }

    async fn read_file_git(&self, params: Option<&Value>) -> RpcResult {
        let target_path = resolve_requested_path(&self.default_path, params, READ_FILE_GIT_METHOD)?;
        let include_base = params
            .and_then(Value::as_object)
            .and_then(|record| record.get("includeBase"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(self
            .read_file_git_metadata(include_base, &target_path)
            .await)
    }

    async fn include_file_git(
        &self,
        mut result: Value,
        git_options: Option<&Map<String, Value>>,
        target_path: &Path,
    ) -> RpcResult {
        let Some(options) = git_options else {
            return Ok(result);
        };
        let include_base = options.get("includeBase").and_then(Value::as_bool) == Some(true);
        let include_status =
            options.get("includeStatus").and_then(Value::as_bool) == Some(true) || include_base;
        if !include_base && !include_status {
            return Ok(result);
        }

        let git = self.read_file_git_metadata(include_base, target_path).await;
        result
            .as_object_mut()
            .expect("file result is an object")
            .insert("git".to_string(), git);
        Ok(result)
    }

    async fn read_file_git_metadata(&self, include_base: bool, target_path: &Path) -> Value {
        let parent = target_path.parent().unwrap_or(Path::new("/"));
        let Some(repo_status) = self.read_git_status_for_path(parent).await else {
            return serde_json::json!({
                "base": include_base.then(|| empty_git_file_base(
                    target_path,
                    Some("File is not in a git repository."),
                    None,
                    None,
                )),
                "repoRoot": null,
                "status": null,
            });
        };

        let repo_root_text = repo_status.repo_root.to_string_lossy().into_owned();
        let Some(relative_path) = relative_git_path(&repo_status.repo_root, target_path) else {
            return serde_json::json!({
                "base": include_base.then(|| empty_git_file_base(
                    target_path,
                    Some("File is outside the git repository."),
                    Some(&repo_root_text),
                    None,
                )),
                "repoRoot": repo_root_text,
                "status": null,
            });
        };

        let status = summarize_git_statuses(
            repo_status
                .exact_by_path
                .get(&relative_path)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        );
        let base = if include_base {
            read_git_file_base(&relative_path, &repo_status.repo_root, status, target_path).await
        } else {
            Value::Null
        };

        serde_json::json!({
            "base": base,
            "repoRoot": repo_root_text,
            "status": status.map(|status| status.status),
        })
    }

    async fn read_git_status_for_path(&self, target_path: &Path) -> Option<Arc<IndexedGitStatus>> {
        let repo_root = self.git_repo_root_cached(target_path).await?;

        {
            let cache = self.status_cache.lock().unwrap();
            if let Some(cached) = cache.get(&repo_root) {
                if cached.loaded_at.elapsed() < Duration::from_millis(GIT_STATUS_CACHE_TTL_MS) {
                    return Some(cached.status.clone());
                }
            }
        }

        let entries = git_status_entries(&repo_root).await;
        let status = Arc::new(index_git_status(entries, repo_root.clone()));
        self.status_cache.lock().unwrap().insert(
            repo_root,
            CachedStatus {
                loaded_at: Instant::now(),
                status: status.clone(),
            },
        );
        Some(status)
    }

    async fn git_repo_root_cached(&self, target_path: &Path) -> Option<PathBuf> {
        let resolved = paths::resolve(target_path);
        {
            let cache = self.repo_root_cache.lock().unwrap();
            if let Some(cached) = cache.get(&resolved) {
                if cached.loaded_at.elapsed() < Duration::from_millis(GIT_REPO_ROOT_CACHE_TTL_MS) {
                    return cached.repo_root.clone();
                }
            }
        }

        let repo_root = git_repo_root(&resolved).await;
        self.repo_root_cache.lock().unwrap().insert(
            resolved,
            CachedRepoRoot {
                loaded_at: Instant::now(),
                repo_root: repo_root.clone(),
            },
        );
        repo_root
    }
}

async fn read_file_bounded(path: &Path, max_bytes: u64) -> std::io::Result<Vec<u8>> {
    let file = tokio::fs::File::open(path).await?;
    let mut buffer = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut buffer).await?;
    Ok(buffer)
}

impl CoreRpc for FsCore {
    fn handle_rpc(&self, method: String, params: Option<Value>) -> BoxFuture<'_, RpcResult> {
        Box::pin(async move { FsCore::handle_rpc(self, &method, params.as_ref()).await })
    }
}

fn resolve_requested_path(
    default_path: &Path,
    params: Option<&Value>,
    method: &str,
) -> Result<PathBuf, JsonRpcError> {
    let Some(params) = params else {
        return Ok(default_path.to_path_buf());
    };
    if params.is_null() {
        return Ok(default_path.to_path_buf());
    }
    let Some(record) = params.as_object() else {
        return Err(JsonRpcError::new(
            INVALID_PARAMS,
            format!("Invalid {method} params"),
        ));
    };

    match record.get("path") {
        None | Some(Value::Null) => Ok(default_path.to_path_buf()),
        Some(Value::String(requested)) if requested.is_empty() => Ok(default_path.to_path_buf()),
        Some(Value::String(requested)) => {
            if requested.starts_with('/') {
                Ok(paths::resolve(Path::new(requested)))
            } else {
                Ok(paths::resolve_from(default_path, requested))
            }
        }
        Some(_) => Err(JsonRpcError::new(
            INVALID_PARAMS,
            format!("Invalid {method} path"),
        )),
    }
}

fn optional_nonnegative_integer(
    value: Option<&Value>,
    field: &str,
) -> Result<Option<u64>, JsonRpcError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number.as_u64().map(Some).ok_or_else(|| {
            JsonRpcError::new(
                INVALID_PARAMS,
                format!(
                    "Invalid {READ_FILE_WINDOW_METHOD} {field}: expected a nonnegative integer"
                ),
            )
        }),
        _ => Err(JsonRpcError::new(
            INVALID_PARAMS,
            format!("Invalid {READ_FILE_WINDOW_METHOD} {field}: expected a nonnegative integer"),
        )),
    }
}

/// Binary sniff ported verbatim: NUL in the first 4096 bytes, or >10%
/// non-allowed control bytes.
pub fn is_likely_binary(buffer: &[u8]) -> bool {
    let sample = &buffer[..buffer.len().min(4096)];
    if sample.contains(&0) {
        return true;
    }

    let suspicious = sample
        .iter()
        .filter(|&&byte| {
            let is_allowed_control = matches!(byte, 7 | 8 | 9 | 10 | 12 | 13 | 27);
            let is_control = byte < 32 || byte == 127;
            is_control && !is_allowed_control
        })
        .count();

    !sample.is_empty() && (suspicious as f64) / (sample.len() as f64) > 0.1
}

struct DirectoryEntry {
    kind: &'static str,
    modified_at_ms: Option<i64>,
    name: String,
    path: PathBuf,
    size_bytes: Option<u64>,
    target_kind: Option<&'static str>,
}

impl DirectoryEntry {
    fn to_value(&self, git: Option<Option<GitStatus>>) -> Value {
        let mut entry = Map::new();
        entry.insert("itemCount".to_string(), Value::Null);
        entry.insert("kind".to_string(), Value::from(self.kind));
        entry.insert(
            "modifiedAtMs".to_string(),
            self.modified_at_ms.map(Value::from).unwrap_or(Value::Null),
        );
        entry.insert("name".to_string(), Value::from(self.name.clone()));
        entry.insert(
            "path".to_string(),
            Value::from(self.path.to_string_lossy().into_owned()),
        );
        entry.insert(
            "sizeBytes".to_string(),
            self.size_bytes.map(Value::from).unwrap_or(Value::Null),
        );
        entry.insert(
            "targetKind".to_string(),
            self.target_kind.map(Value::from).unwrap_or(Value::Null),
        );
        if let Some(git) = git {
            entry.insert(
                "git".to_string(),
                git.map(GitStatus::to_value).unwrap_or(Value::Null),
            );
        }
        Value::Object(entry)
    }
}

async fn directory_entry(
    parent: &Path,
    name: String,
    dirent_type: Option<std::fs::FileType>,
) -> DirectoryEntry {
    let entry_path = parent.join(&name);
    let fallback_kind = dirent_type.map(kind_from_file_type).unwrap_or("other");

    match tokio::fs::symlink_metadata(&entry_path).await {
        Ok(stats) => {
            let kind = kind_from_file_type(stats.file_type());
            let target_kind = if kind == "symlink" {
                symlink_target_kind(&entry_path).await
            } else {
                None
            };
            DirectoryEntry {
                kind,
                modified_at_ms: modified_at_ms_meta(&stats),
                size_bytes: stats.is_file().then_some(stats.len()),
                target_kind,
                name,
                path: entry_path,
            }
        }
        Err(_) => DirectoryEntry {
            kind: fallback_kind,
            modified_at_ms: None,
            size_bytes: None,
            target_kind: None,
            name,
            path: entry_path,
        },
    }
}

async fn symlink_target_kind(entry_path: &Path) -> Option<&'static str> {
    match tokio::fs::metadata(entry_path).await {
        Ok(stats) if stats.is_dir() => Some("directory"),
        Ok(stats) if stats.is_file() => Some("file"),
        Ok(_) => Some("other"),
        Err(_) => None,
    }
}

fn kind_from_file_type(file_type: std::fs::FileType) -> &'static str {
    if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_file() {
        "file"
    } else {
        "other"
    }
}

fn modified_at_ms(stats: &std::fs::Metadata) -> Value {
    modified_at_ms_meta(stats)
        .map(Value::from)
        .unwrap_or(Value::Null)
}

fn modified_at_ms_meta(stats: &std::fs::Metadata) -> Option<i64> {
    stats
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
}

fn compare_entries(first: &DirectoryEntry, second: &DirectoryEntry) -> std::cmp::Ordering {
    let rank = kind_rank(first.kind).cmp(&kind_rank(second.kind));
    if rank != std::cmp::Ordering::Equal {
        return rank;
    }
    natural_compare(&first.name, &second.name)
}

fn kind_rank(kind: &str) -> u8 {
    match kind {
        "directory" => 0,
        "file" => 1,
        "symlink" => 2,
        _ => 3,
    }
}

/// Numeric-aware, case-insensitive comparator standing in for
/// `localeCompare(…, { numeric: true, sensitivity: 'base' })`. Exact ICU
/// parity is not required — the client only needs a stable natural order.
pub fn natural_compare(first: &str, second: &str) -> std::cmp::Ordering {
    let mut left = first.chars().peekable();
    let mut right = second.chars().peekable();

    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => return first.cmp(second), // full tiebreak for stability
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(a), Some(b)) => {
                if a.is_ascii_digit() && b.is_ascii_digit() {
                    let mut left_num = String::new();
                    while let Some(&c) = left.peek() {
                        if c.is_ascii_digit() {
                            left_num.push(c);
                            left.next();
                        } else {
                            break;
                        }
                    }
                    let mut right_num = String::new();
                    while let Some(&c) = right.peek() {
                        if c.is_ascii_digit() {
                            right_num.push(c);
                            right.next();
                        } else {
                            break;
                        }
                    }
                    let left_value: u128 = left_num.parse().unwrap_or(u128::MAX);
                    let right_value: u128 = right_num.parse().unwrap_or(u128::MAX);
                    match left_value.cmp(&right_value) {
                        std::cmp::Ordering::Equal => continue,
                        other => return other,
                    }
                }

                let a_key: Vec<char> = a.to_lowercase().collect();
                let b_key: Vec<char> = b.to_lowercase().collect();
                match a_key.cmp(&b_key) {
                    std::cmp::Ordering::Equal => {
                        left.next();
                        right.next();
                    }
                    other => return other,
                }
            }
        }
    }
}

fn parent_path(target_path: &Path) -> Option<PathBuf> {
    let parent = target_path.parent()?;
    if parent == target_path {
        None
    } else {
        Some(parent.to_path_buf())
    }
}

/// Stable content hash over the serialized entries; clients only compare it
/// for equality, so byte-parity with the Node sha1 is not required.
fn directory_version(entries: &[Value]) -> String {
    let mut hasher = Sha1::new();
    for entry in entries {
        hasher.update(entry.to_string().as_bytes());
        hasher.update(b"\n");
    }
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn git_status_for_entry(status: &IndexedGitStatus, entry: &DirectoryEntry) -> Option<GitStatus> {
    let relative_path = relative_git_path(&status.repo_root, &entry.path)?;
    let mut statuses: Vec<GitStatus> = status
        .exact_by_path
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    if entry.kind == "directory" {
        if let Some(descendants) = status.descendant_by_directory_path.get(&relative_path) {
            statuses.extend(descendants.iter().copied());
        }
    }
    summarize_git_statuses(&statuses)
}

fn empty_git_file_base(
    target_path: &Path,
    reason: Option<&str>,
    repo_root: Option<&str>,
    status: Option<&str>,
) -> Value {
    serde_json::json!({
        "content": null,
        "encoding": null,
        "isBinary": false,
        "path": target_path.to_string_lossy(),
        "ref": "HEAD",
        "repoRoot": repo_root,
        "sizeBytes": null,
        "status": status,
        "tooLarge": false,
        "unavailableReason": reason,
    })
}

async fn read_git_file_base(
    relative_path: &str,
    repo_root: &Path,
    status: Option<GitStatus>,
    target_path: &Path,
) -> Value {
    let repo_root_text = repo_root.to_string_lossy().into_owned();
    let Some(status) = status else {
        return empty_git_file_base(
            target_path,
            Some("File has no local git changes."),
            Some(&repo_root_text),
            None,
        );
    };

    if status.status == "untracked" || status.status == "added" {
        return serde_json::json!({
            "content": "",
            "encoding": "utf8",
            "isBinary": false,
            "path": target_path.to_string_lossy(),
            "ref": "HEAD",
            "repoRoot": repo_root_text,
            "sizeBytes": 0,
            "status": status.status,
            "tooLarge": false,
            "unavailableReason": null,
        });
    }

    let base_spec = format!("HEAD:{relative_path}");
    let size_output = tokio::process::Command::new("git")
        .args(["-C"])
        .arg(repo_root)
        .args(["cat-file", "-s", &base_spec])
        .output()
        .await;
    let size_bytes: Option<u64> = match &size_output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().parse().ok()
        }
        _ => {
            return empty_git_file_base(
                target_path,
                None,
                Some(&repo_root_text),
                Some(status.status),
            );
        }
    };
    let Some(size_bytes) = size_bytes else {
        return empty_git_file_base(
            target_path,
            Some("Base file size could not be read."),
            Some(&repo_root_text),
            Some(status.status),
        );
    };

    if size_bytes > MAX_TEXT_FILE_BYTES {
        return serde_json::json!({
            "content": null,
            "encoding": null,
            "isBinary": false,
            "path": target_path.to_string_lossy(),
            "ref": "HEAD",
            "repoRoot": repo_root_text,
            "sizeBytes": size_bytes,
            "status": status.status,
            "tooLarge": true,
            "unavailableReason": format!("Base file is larger than {}.", format_bytes(MAX_TEXT_FILE_BYTES)),
        });
    }

    let show_output = tokio::process::Command::new("git")
        .args(["-C"])
        .arg(repo_root)
        .args(["show", "--no-ext-diff", "--no-color", &base_spec])
        .output()
        .await;
    let buffer = match show_output {
        Ok(output) if output.status.success() => output.stdout,
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return empty_git_file_base(
                target_path,
                Some(&format!("Base file could not be read: {stderr}")),
                Some(&repo_root_text),
                Some(status.status),
            );
        }
        Err(error) => {
            return empty_git_file_base(
                target_path,
                Some(&format!("Base file could not be read: {error}")),
                Some(&repo_root_text),
                Some(status.status),
            );
        }
    };

    if is_likely_binary(&buffer) {
        return serde_json::json!({
            "content": null,
            "encoding": null,
            "isBinary": true,
            "path": target_path.to_string_lossy(),
            "ref": "HEAD",
            "repoRoot": repo_root_text,
            "sizeBytes": size_bytes,
            "status": status.status,
            "tooLarge": false,
            "unavailableReason": "Base file is binary.",
        });
    }

    serde_json::json!({
        "content": String::from_utf8_lossy(&buffer).into_owned(),
        "encoding": "utf8",
        "isBinary": false,
        "path": target_path.to_string_lossy(),
        "ref": "HEAD",
        "repoRoot": repo_root_text,
        "sizeBytes": size_bytes,
        "status": status.status,
        "tooLarge": false,
        "unavailableReason": null,
    })
}

pub(crate) fn mime_type_from_path(file_path: &Path) -> Option<&'static str> {
    let extension = file_path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())?;
    match extension.as_str() {
        "pdf" => Some("application/pdf"),
        "mp3" => Some("audio/mpeg"),
        "m4a" => Some("audio/mp4"),
        "wav" => Some("audio/wav"),
        "ogg" => Some("audio/ogg"),
        "flac" => Some("audio/flac"),
        "aac" => Some("audio/aac"),
        "mp4" => Some("video/mp4"),
        "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        "zip" => Some("application/zip"),
        "tar" => Some("application/x-tar"),
        "gz" => Some("application/gzip"),
        "tgz" => Some("application/gzip"),
        "7z" => Some("application/x-7z-compressed"),
        "csv" => Some("text/csv"),
        "tsv" => Some("text/tab-separated-values"),
        "xml" => Some("application/xml"),
        "yaml" => Some("application/yaml"),
        "yml" => Some("application/yaml"),
        "toml" => Some("application/toml"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "pptx" => Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "html" => Some("text/html"),
        "htm" => Some("text/html"),
        "txt" => Some("text/plain"),
        "md" => Some("text/markdown"),
        "json" => Some("application/json"),
        "apng" => Some("image/apng"),
        "avif" => Some("image/avif"),
        "gif" => Some("image/gif"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{} KB", (bytes as f64 / 1024.0).round() as u64)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// Minimal standard base64 encoder (no external dep).
mod base64_encode {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(data: &[u8]) -> String {
        let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
        for chunk in data.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
            let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
            let triple = (b0 << 16) | (b1 << 8) | b2;
            out.push(TABLE[(triple >> 18) as usize & 63] as char);
            out.push(TABLE[(triple >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 {
                TABLE[(triple >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                TABLE[triple as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_sniff_matches_node_rules() {
        assert!(is_likely_binary(&[0x00, 0x01, 0x02]));
        assert!(!is_likely_binary(b"hello world\n"));
        assert!(!is_likely_binary(b""));
        // Allowed control characters do not count as suspicious.
        assert!(!is_likely_binary(b"\x1b[31mred\x1b[0m\ttext\r\n"));
        // >10% suspicious control bytes flips binary.
        assert!(is_likely_binary(&[1, 2, 3, 4, b'a', b'b']));
    }

    #[test]
    fn natural_compare_orders_numerically_and_case_insensitively() {
        let mut names = vec!["file10.txt", "file2.txt", "File1.txt", "alpha", "Beta"];
        names.sort_by(|a, b| natural_compare(a, b));
        assert_eq!(
            names,
            vec!["alpha", "Beta", "File1.txt", "file2.txt", "file10.txt"]
        );
    }

    #[test]
    fn base64_encoder_matches_reference() {
        assert_eq!(base64_encode::encode(b""), "");
        assert_eq!(base64_encode::encode(b"f"), "Zg==");
        assert_eq!(base64_encode::encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode::encode(b"foo"), "Zm9v");
        assert_eq!(
            base64_encode::encode(&[0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
            "iVBORwAB"
        );
    }

    #[tokio::test]
    async fn bounded_file_read_stops_at_limit_plus_one() {
        let root = tempfile::tempdir().unwrap();
        let exact_path = root.path().join("exact.html");
        let over_path = root.path().join("over.html");
        tokio::fs::write(&exact_path, b"12345").await.unwrap();
        tokio::fs::write(&over_path, b"123456789").await.unwrap();

        assert_eq!(read_file_bounded(&exact_path, 5).await.unwrap(), b"12345");
        assert_eq!(read_file_bounded(&over_path, 5).await.unwrap(), b"123456");
    }

    #[tokio::test]
    async fn read_file_reports_exact_actual_length_before_base64_encoding() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("report.html");
        tokio::fs::write(&path, b"hello").await.unwrap();
        let core = FsCore::new(root.path());

        let result = core
            .handle_rpc(
                READ_FILE_METHOD,
                Some(&serde_json::json!({ "format": "base64", "path": path })),
            )
            .await
            .unwrap();
        assert_eq!(result["sizeBytes"], 5);
        assert_eq!(result["tooLarge"], false);
        assert_eq!(result["dataBase64"], "aGVsbG8=");
    }

    #[tokio::test]
    async fn exact_binary_cap_fits_rpc_envelope_and_text_cap_is_unchanged() {
        assert_eq!(MAX_TEXT_FILE_BYTES, 1024 * 1024);
        assert_eq!(MAX_BINARY_FILE_BYTES, 5 * 1024 * 1024);
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("exact-cap.html");
        tokio::fs::write(&path, vec![b'a'; MAX_BINARY_FILE_BYTES as usize])
            .await
            .unwrap();
        let core = FsCore::new(root.path());

        let result = core
            .handle_rpc(
                READ_FILE_METHOD,
                Some(&serde_json::json!({ "format": "base64", "path": path })),
            )
            .await
            .unwrap();
        assert_eq!(result["sizeBytes"], MAX_BINARY_FILE_BYTES);
        assert_eq!(result["tooLarge"], false);
        assert_eq!(
            result["dataBase64"].as_str().unwrap().len(),
            (MAX_BINARY_FILE_BYTES as usize).div_ceil(3) * 4
        );
        assert!(serde_json::to_vec(&result).unwrap().len() < 8 * 1024 * 1024);
    }

    #[tokio::test]
    async fn read_file_window_rpc_validates_params_and_reports_version_changes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("paged.txt");
        tokio::fs::write(&path, "first page\nsecond page\n")
            .await
            .unwrap();
        let core = FsCore::new(root.path());
        let first = core
            .handle_rpc(
                READ_FILE_WINDOW_METHOD,
                Some(&serde_json::json!({ "limit": 8, "path": path })),
            )
            .await
            .unwrap();
        assert_eq!(
            first["range"],
            serde_json::json!({ "endByte": 8, "startByte": 0 })
        );
        assert_eq!(first["nextOffset"], 8);
        let version = first["version"].as_str().unwrap().to_string();

        tokio::fs::write(&path, "replacement with another size\n")
            .await
            .unwrap();
        let changed = core
            .handle_rpc(
                READ_FILE_WINDOW_METHOD,
                Some(&serde_json::json!({
                    "expectedVersion": version,
                    "limit": 8,
                    "offset": 8,
                    "path": path,
                })),
            )
            .await
            .unwrap_err();
        assert_eq!(changed.code, READ_FILE_WINDOW_ERROR);
        assert_eq!(changed.data.unwrap()["kind"], "changed");

        let invalid = core
            .handle_rpc(
                READ_FILE_WINDOW_METHOD,
                Some(&serde_json::json!({ "limit": 3, "path": path })),
            )
            .await
            .unwrap_err();
        assert_eq!(invalid.code, INVALID_PARAMS);
    }

    #[tokio::test]
    async fn read_file_git_returns_metadata_without_reading_working_contents() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("not-present.txt");
        let core = FsCore::new(root.path());

        let result = core
            .handle_rpc(
                READ_FILE_GIT_METHOD,
                Some(&serde_json::json!({
                    "includeBase": true,
                    "path": missing,
                })),
            )
            .await
            .unwrap();
        assert_eq!(result["repoRoot"], Value::Null);
        assert_eq!(result["status"], Value::Null);
        assert_eq!(
            result["base"]["unavailableReason"],
            "File is not in a git repository."
        );
    }

    #[test]
    fn format_bytes_matches_node() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(format_bytes(1536 * 1024), "1.5 MB");
    }
}

fn required_string<'a>(record: &'a Map<String, Value>, key: &str) -> Result<&'a str, JsonRpcError> {
    record
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| JsonRpcError::new(INVALID_PARAMS, format!("Expected non-empty {key}")))
}

fn optional_bool(record: &Map<String, Value>, key: &str) -> Result<bool, JsonRpcError> {
    match record.get(key) {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(JsonRpcError::new(INVALID_PARAMS, format!("Invalid {key}"))),
    }
}

pub(crate) fn mutation_error(kind: &str, message: &str) -> JsonRpcError {
    JsonRpcError::with_data(MUTATION_ERROR, message, serde_json::json!({"kind":kind}))
}

pub(crate) fn fs_error(code: i64, error: &std::io::Error) -> JsonRpcError {
    let kind = match error.kind() {
        std::io::ErrorKind::NotFound => "notFound",
        std::io::ErrorKind::AlreadyExists if code == MUTATION_ERROR => "exists",
        std::io::ErrorKind::DirectoryNotEmpty if code == MUTATION_ERROR => "notEmpty",
        std::io::ErrorKind::CrossesDevices if code == MUTATION_ERROR => "crossDevice",
        _ => "io",
    };
    JsonRpcError::with_data(code, error.to_string(), serde_json::json!({"kind":kind}))
}

pub(crate) fn existing_metadata(path: &Path) -> std::io::Result<Option<std::fs::Metadata>> {
    match std::fs::symlink_metadata(path) {
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub(crate) fn current_version(path: &Path) -> std::io::Result<Option<String>> {
    let Some(link) = existing_metadata(path)? else {
        return Ok(None);
    };
    let metadata = if link.is_symlink() {
        match std::fs::metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => link,
            Err(e) => return Err(e),
        }
    } else {
        link
    };
    Ok(Some(crate::fs::file_window::file_version(&metadata)))
}

/// Linux renameat2 preserves create-only semantics even if another process
/// creates the destination between the version check and the rename.
pub(crate) fn atomic_rename(from: &Path, to: &Path, overwrite: bool) -> std::io::Result<()> {
    if overwrite {
        return std::fs::rename(from, to);
    }
    nix::fcntl::renameat2(
        None,
        from,
        None,
        to,
        nix::fcntl::RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(std::io::Error::from)
}

/// Reads at most 8 KiB, following symlinks but never reading special devices.
/// Symlink descriptors retain their entry kind; size/version describe the target
/// when it exists. Dangling symlinks describe the link itself.
pub(crate) fn stat_path(path: &Path) -> std::io::Result<Value> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let link = std::fs::symlink_metadata(path)?;
    let target = if link.is_symlink() {
        match std::fs::metadata(path) {
            Ok(m) => Some(m),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        }
    } else {
        None
    };
    let mut metadata = target.as_ref().unwrap_or(&link).clone();
    let mut prefix = Vec::new();
    if metadata.is_file() {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NONBLOCK)
            .open(path)?;
        metadata = file.metadata()?;
        if metadata.is_file() {
            file.take(8192).read_to_end(&mut prefix)?;
        }
    }
    let target_kind = if link.is_symlink() {
        target.as_ref().and_then(|m| {
            if m.is_file() {
                Some("file")
            } else if m.is_dir() {
                Some("directory")
            } else {
                None
            }
        })
    } else {
        None
    };
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "name": path.file_name().unwrap_or_default().to_string_lossy(),
        "kind": kind_from_file_type(link.file_type()),
        "targetKind": target_kind,
        "sizeBytes": metadata.len(),
        "modifiedAtMs": modified_at_ms(&metadata),
        "version": crate::fs::file_window::file_version(&metadata),
        "mimeType": if metadata.is_file() { mime_type(path, &prefix) } else { None },
        "isBinary": if metadata.is_file() { Some(is_likely_binary(&prefix)) } else { None },
    }))
}

pub(crate) fn mime_type(path: &Path, prefix: &[u8]) -> Option<&'static str> {
    mime_type_from_path(path).or_else(|| {
        if prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some("image/png")
        } else if prefix.starts_with(b"\xff\xd8\xff") {
            Some("image/jpeg")
        } else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
            Some("image/gif")
        } else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP") {
            Some("image/webp")
        } else if prefix.starts_with(b"%PDF-") {
            Some("application/pdf")
        } else if [b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"]
            .iter()
            .any(|magic| prefix.starts_with(*magic))
        {
            Some("application/zip")
        } else {
            None
        }
    })
}

#[cfg(test)]
mod file_service_tests {
    use super::*;
    #[test]
    fn mime_extensions_override_sniffing() {
        for (ext, mime) in [
            ("pdf", "application/pdf"),
            ("SVG", "image/svg+xml"),
            ("mp3", "audio/mpeg"),
            ("m4a", "audio/mp4"),
            ("wav", "audio/wav"),
            ("ogg", "audio/ogg"),
            ("flac", "audio/flac"),
            ("aac", "audio/aac"),
            ("mp4", "video/mp4"),
            ("m4v", "video/mp4"),
            ("mov", "video/quicktime"),
            ("webm", "video/webm"),
            ("woff", "font/woff"),
            ("woff2", "font/woff2"),
            ("ttf", "font/ttf"),
            ("otf", "font/otf"),
            ("zip", "application/zip"),
            ("tar", "application/x-tar"),
            ("gz", "application/gzip"),
            ("tgz", "application/gzip"),
            ("7z", "application/x-7z-compressed"),
            ("csv", "text/csv"),
            ("tsv", "text/tab-separated-values"),
            ("xml", "application/xml"),
            ("yaml", "application/yaml"),
            ("toml", "application/toml"),
        ] {
            assert_eq!(
                mime_type(Path::new(&format!("file.{ext}")), b"%PDF-"),
                Some(mime)
            );
        }
        for ext in ["docx", "xlsx", "pptx"] {
            assert!(mime_type_from_path(Path::new(&format!("file.{ext}")))
                .unwrap()
                .starts_with("application/vnd.openxmlformats-officedocument."));
        }
        assert_eq!(mime_type(Path::new("unknown"), b"plain"), None);
    }
    #[test]
    fn rename_cross_device_error_mapping() {
        assert_eq!(
            fs_error(
                MUTATION_ERROR,
                &std::io::Error::from_raw_os_error(nix::libc::EXDEV)
            )
            .data
            .unwrap()["kind"],
            "crossDevice"
        );
        // The workspace sandbox may have no writable second mount. Exercise
        // the real syscall when /tmp and the workspace are different devices.
        use std::os::unix::fs::MetadataExt;
        let local = tempfile::tempdir_in(".").unwrap();
        let other = tempfile::tempdir().unwrap();
        if std::fs::metadata(local.path()).unwrap().dev()
            == std::fs::metadata(other.path()).unwrap().dev()
        {
            eprintln!("Skipping real EXDEV: no writable second device");
            return;
        }
        let from = local.path().join("from");
        std::fs::write(&from, "data").unwrap();
        let error = atomic_rename(&from, &other.path().join("to"), false).unwrap_err();
        assert_eq!(
            fs_error(MUTATION_ERROR, &error).data.unwrap()["kind"],
            "crossDevice"
        );
        assert!(from.exists());
    }
}
