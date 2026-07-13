use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use sha2::{Digest, Sha256};

use crate::extensions::manifest::{ExtensionManifest, ViewCachePolicy};
use crate::logs::Journal;
use crate::time::now_ms;

const MAX_SOURCE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SOURCE_FILES: usize = 20_000;
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;
// Long-lived mobile tabs keep immutable URLs across app backgrounding and
// runtime restarts. Keep enough history for normal development rebuilds while
// the global byte limit remains the final cache bound.
const RETAIN_REVISIONS_PER_VIEW: usize = 16;
const WATCH_QUIET_MS: u64 = 300;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ViewerBundleKey {
    pub extension_id: String,
    pub view_id: String,
}

#[derive(Clone, Debug)]
pub struct PublishedViewerBundle {
    pub extension_id: String,
    pub view_id: String,
    pub revision: String,
    pub route: String,
    pub entry_relative_path: PathBuf,
    pub snapshot_root: PathBuf,
    pub published_at_ms: i64,
    pub total_bytes: u64,
    pub file_count: usize,
}

#[derive(Clone, Debug)]
struct ViewerBundleSource {
    key: ViewerBundleKey,
    route: String,
    entry: PathBuf,
    source_root: PathBuf,
    entry_relative_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceFile {
    relative: PathBuf,
    source: PathBuf,
    len: u64,
    modified_ns: u128,
}

pub struct ViewerBundleRegistry {
    cache_root: PathBuf,
    journal: Arc<Journal>,
    published: RwLock<HashMap<ViewerBundleKey, PublishedViewerBundle>>,
    publish_lock: tokio::sync::Mutex<()>,
    runtime: tokio::runtime::Handle,
    sources: HashMap<ViewerBundleKey, ViewerBundleSource>,
    watch_generations: Mutex<HashMap<ViewerBundleKey, u64>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl ViewerBundleRegistry {
    pub fn new(
        root_dir: &Path,
        extensions: &[ExtensionManifest],
        journal: Arc<Journal>,
    ) -> Arc<Self> {
        let mut sources = HashMap::new();
        for extension in extensions {
            for (view_id, view) in &extension.views {
                if view.cache != ViewCachePolicy::Immutable {
                    continue;
                }
                if !safe_cache_component(&extension.id) || !safe_cache_component(view_id) {
                    journal.warn(&format!(
                        "viewer bundle ignored unsafe cache path extension={} view={}",
                        extension.id, view_id
                    ));
                    continue;
                }
                let source_root = view.entry.parent().unwrap_or(Path::new("/")).to_path_buf();
                let entry_relative_path = view
                    .entry
                    .strip_prefix(&source_root)
                    .unwrap_or_else(|_| Path::new("index.html"))
                    .to_path_buf();
                let key = ViewerBundleKey {
                    extension_id: extension.id.clone(),
                    view_id: view_id.clone(),
                };
                sources.insert(
                    key.clone(),
                    ViewerBundleSource {
                        key,
                        route: view.route.trim_end_matches('/').to_string(),
                        entry: view.entry.clone(),
                        source_root,
                        entry_relative_path,
                    },
                );
            }
        }
        Arc::new(Self {
            cache_root: root_dir.join(".remux/cache/viewers"),
            journal,
            published: RwLock::new(HashMap::new()),
            publish_lock: tokio::sync::Mutex::new(()),
            runtime: tokio::runtime::Handle::current(),
            sources,
            watch_generations: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
        })
    }

    pub async fn publish_all(self: &Arc<Self>) {
        let keys = self.sources.keys().cloned().collect::<Vec<_>>();
        for key in keys {
            self.publish_key(&key).await;
        }
    }

    pub fn schedule_publish(self: &Arc<Self>, extension_id: &str, view_id: &str) {
        let key = ViewerBundleKey {
            extension_id: extension_id.to_string(),
            view_id: view_id.to_string(),
        };
        if !self.sources.contains_key(&key) {
            return;
        }
        let registry = self.clone();
        self.runtime.spawn(async move {
            registry.publish_key(&key).await;
        });
    }

    pub fn start_watching(self: &Arc<Self>) -> Result<(), String> {
        if self.sources.is_empty() {
            return Ok(());
        }
        let weak: Weak<Self> = Arc::downgrade(self);
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Some(registry) = weak.upgrade() else {
                    return;
                };
                let Ok(event) = event else {
                    return;
                };
                for path in event.paths {
                    registry.schedule_path_publish(&path);
                }
            })
            .map_err(|error| format!("viewer bundle watcher: {error}"))?;

        let mut roots = self
            .sources
            .values()
            .map(|source| source.source_root.clone())
            .filter(|root| root.exists())
            .collect::<Vec<_>>();
        roots.sort();
        roots.dedup();
        for root in roots {
            watcher
                .watch(&root, RecursiveMode::Recursive)
                .map_err(|error| format!("watch {}: {error}", root.display()))?;
        }
        *self.watcher.lock().unwrap() = Some(watcher);
        Ok(())
    }

    pub fn current(&self, extension_id: &str, view_id: &str) -> Option<PublishedViewerBundle> {
        self.published
            .read()
            .unwrap()
            .get(&ViewerBundleKey {
                extension_id: extension_id.to_string(),
                view_id: view_id.to_string(),
            })
            .cloned()
    }

    pub fn revision(
        &self,
        extension_id: &str,
        view_id: &str,
        revision: &str,
    ) -> Option<PublishedViewerBundle> {
        if !valid_revision(revision) {
            return None;
        }
        let current = self.current(extension_id, view_id);
        if current
            .as_ref()
            .is_some_and(|bundle| bundle.revision == revision)
        {
            return current;
        }
        let source = self.sources.get(&ViewerBundleKey {
            extension_id: extension_id.to_string(),
            view_id: view_id.to_string(),
        })?;
        let snapshot_root = self
            .cache_root
            .join(extension_id)
            .join(view_id)
            .join(revision);
        let entry = snapshot_root.join(&source.entry_relative_path);
        if !entry.is_file() {
            return None;
        }
        Some(PublishedViewerBundle {
            extension_id: extension_id.to_string(),
            view_id: view_id.to_string(),
            revision: revision.to_string(),
            route: source.route.clone(),
            entry_relative_path: source.entry_relative_path.clone(),
            snapshot_root,
            published_at_ms: 0,
            total_bytes: 0,
            file_count: 0,
        })
    }

    fn schedule_path_publish(self: &Arc<Self>, path: &Path) {
        let affected = self
            .sources
            .values()
            .filter(|source| path.starts_with(&source.source_root))
            .map(|source| source.key.clone())
            .collect::<Vec<_>>();
        for key in affected {
            let generation = {
                let mut generations = self.watch_generations.lock().unwrap();
                let generation = generations.entry(key.clone()).or_insert(0);
                *generation += 1;
                *generation
            };
            let registry = self.clone();
            self.runtime.spawn(async move {
                tokio::time::sleep(Duration::from_millis(WATCH_QUIET_MS)).await;
                if registry
                    .watch_generations
                    .lock()
                    .unwrap()
                    .get(&key)
                    .copied()
                    != Some(generation)
                {
                    return;
                }
                registry.publish_key(&key).await;
            });
        }
    }

    async fn publish_key(self: &Arc<Self>, key: &ViewerBundleKey) {
        let Some(source) = self.sources.get(key).cloned() else {
            return;
        };
        if !source.entry.is_file() {
            return;
        }
        let _guard = self.publish_lock.lock().await;
        let started = Instant::now();
        let mut attempt = 0usize;
        let result = loop {
            attempt += 1;
            let cache_root = self.cache_root.clone();
            let source = source.clone();
            let result = tokio::task::spawn_blocking(move || publish_snapshot(&cache_root, &source))
                .await
                .map_err(|error| format!("snapshot worker: {error}"))
                .and_then(|result| result);
            if result
                .as_ref()
                .err()
                .is_some_and(|error| error.contains("changed during publication"))
                && attempt < 3
            {
                tokio::time::sleep(Duration::from_millis(WATCH_QUIET_MS)).await;
                continue;
            }
            break result;
        };
        match result {
            Ok(bundle) => {
                let unchanged = self
                    .published
                    .read()
                    .unwrap()
                    .get(key)
                    .is_some_and(|current| current.revision == bundle.revision);
                self.published
                    .write()
                    .unwrap()
                    .insert(key.clone(), bundle.clone());
                self.journal.log(&format!(
                    "viewer bundle {} extension={} view={} revision={} files={} bytes={} duration_ms={}",
                    if unchanged { "unchanged" } else { "published" },
                    key.extension_id,
                    key.view_id,
                    bundle.revision,
                    bundle.file_count,
                    bundle.total_bytes,
                    started.elapsed().as_millis(),
                ));
                let cache_root = self.cache_root.clone();
                let published = self.published.read().unwrap().clone();
                let cleanup = tokio::task::spawn_blocking(move || {
                    cleanup_snapshots(&cache_root, &published)
                })
                .await
                .map_err(|error| format!("snapshot cleanup worker: {error}"))
                .and_then(|result| result);
                if let Err(error) = cleanup {
                    self.journal
                        .warn(&format!("viewer bundle cleanup failed: {error}"));
                }
            }
            Err(error) => self.journal.warn(&format!(
                "viewer bundle publication failed extension={} view={} duration_ms={}: {error}",
                key.extension_id,
                key.view_id,
                started.elapsed().as_millis(),
            )),
        }
    }
}

fn valid_revision(revision: &str) -> bool {
    revision.len() == "sha256-".len() + 64
        && revision.starts_with("sha256-")
        && revision["sha256-".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_cache_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
        })
}

fn publish_snapshot(
    cache_root: &Path,
    source: &ViewerBundleSource,
) -> Result<PublishedViewerBundle, String> {
    let before = collect_source_files(&source.source_root)?;
    if before.is_empty() || !source.entry.is_file() {
        return Err("viewer entry is unavailable".to_string());
    }
    let total_bytes = before.iter().map(|file| file.len).sum::<u64>();
    if before.len() > MAX_SOURCE_FILES || total_bytes > MAX_SOURCE_BYTES {
        return Err(format!(
            "viewer source exceeds publication bounds files={} bytes={total_bytes}",
            before.len()
        ));
    }

    let view_root = cache_root
        .join(&source.key.extension_id)
        .join(&source.key.view_id);
    fs::create_dir_all(&view_root).map_err(|error| error.to_string())?;
    let temp = view_root.join(format!(
        ".tmp-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    if temp.exists() {
        let _ = fs::remove_dir_all(&temp);
    }
    fs::create_dir_all(&temp).map_err(|error| error.to_string())?;

    let copied = copy_and_hash_files(&before, &temp);
    let (digest, copied_bytes) = match copied {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_dir_all(&temp);
            return Err(error);
        }
    };
    let after = collect_source_files(&source.source_root)?;
    if before != after {
        let _ = fs::remove_dir_all(&temp);
        return Err("viewer source changed during publication".to_string());
    }
    if !temp.join(&source.entry_relative_path).is_file() {
        let _ = fs::remove_dir_all(&temp);
        return Err("published snapshot is missing its entry".to_string());
    }
    if let Err(error) = validate_entry_asset_urls(
        &temp.join(&source.entry_relative_path),
        &source.route,
    ) {
        let _ = fs::remove_dir_all(&temp);
        return Err(error);
    }

    let revision = format!("sha256-{}", hex_lower(&digest));
    let snapshot_root = view_root.join(&revision);
    if snapshot_root.exists() {
        fs::remove_dir_all(&temp).map_err(|error| error.to_string())?;
    } else {
        fs::rename(&temp, &snapshot_root).map_err(|error| error.to_string())?;
    }
    Ok(PublishedViewerBundle {
        extension_id: source.key.extension_id.clone(),
        view_id: source.key.view_id.clone(),
        revision,
        route: source.route.clone(),
        entry_relative_path: source.entry_relative_path.clone(),
        snapshot_root,
        published_at_ms: now_ms(),
        total_bytes: copied_bytes,
        file_count: before.len(),
    })
}

fn validate_entry_asset_urls(entry: &Path, route: &str) -> Result<(), String> {
    let html = fs::read_to_string(entry).map_err(|error| error.to_string())?;
    for attribute in ["src", "href", "poster"] {
        for value in quoted_attribute_values(&html, attribute) {
            validate_entry_url(value, route)?;
        }
    }
    for srcset in quoted_attribute_values(&html, "srcset") {
        for candidate in srcset.split(',') {
            if let Some(url) = candidate.split_whitespace().next() {
                validate_entry_url(url, route)?;
            }
        }
    }
    Ok(())
}

fn validate_entry_url(value: &str, route: &str) -> Result<(), String> {
    if value.starts_with("//") {
        return Ok(());
    }
    if value.starts_with('/') && value != route && !value.starts_with(&format!("{route}/")) {
        return Err(format!(
            "immutable viewer entry contains root-relative asset outside its route: {value}"
        ));
    }
    Ok(())
}

fn quoted_attribute_values<'a>(html: &'a str, attribute: &str) -> Vec<&'a str> {
    let mut values = Vec::new();
    for quote in ['\"', '\''] {
        let marker = format!("{attribute}={quote}");
        let mut remaining = html;
        while let Some(start) = remaining.find(&marker) {
            let value_start = start + marker.len();
            let value = &remaining[value_start..];
            let Some(end) = value.find(quote) else {
                break;
            };
            values.push(&value[..end]);
            remaining = &value[end + quote.len_utf8()..];
        }
    }
    values
}

fn collect_source_files(root: &Path) -> Result<Vec<SourceFile>, String> {
    let canonical_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let mut files = Vec::new();
    collect_directory(root, root, &canonical_root, &mut files)?;
    files.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(files)
}

fn collect_directory(
    root: &Path,
    directory: &Path,
    canonical_root: &Path,
    files: &mut Vec<SourceFile>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let link_metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if link_metadata.file_type().is_symlink() {
            let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
            if !canonical.starts_with(canonical_root) {
                return Err(format!(
                    "viewer symlink escapes source root: {}",
                    path.display()
                ));
            }
            let metadata = fs::metadata(&canonical).map_err(|error| error.to_string())?;
            if !metadata.is_file() {
                return Err(format!(
                    "viewer directory symlinks are unsupported: {}",
                    path.display()
                ));
            }
            files.push(source_file(root, path, canonical, &metadata)?);
        } else if link_metadata.is_dir() {
            collect_directory(root, &path, canonical_root, files)?;
        } else if link_metadata.is_file() {
            files.push(source_file(root, path.clone(), path, &link_metadata)?);
        }
        if files.len() > MAX_SOURCE_FILES {
            return Err("viewer source has too many files".to_string());
        }
    }
    Ok(())
}

fn source_file(
    root: &Path,
    display_path: PathBuf,
    source: PathBuf,
    metadata: &fs::Metadata,
) -> Result<SourceFile, String> {
    let relative = display_path
        .strip_prefix(root)
        .map_err(|_| "viewer file escaped source root".to_string())?
        .to_path_buf();
    Ok(SourceFile {
        relative,
        source,
        len: metadata.len(),
        modified_ns: metadata
            .modified()
            .unwrap_or(UNIX_EPOCH)
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    })
}

fn copy_and_hash_files(files: &[SourceFile], target: &Path) -> Result<(Vec<u8>, u64), String> {
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = vec![0u8; 64 * 1024];
    for file in files {
        let relative = file
            .relative
            .to_str()
            .ok_or_else(|| "viewer path is not UTF-8".to_string())?;
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(file.len.to_be_bytes());
        hasher.update([0]);

        let output_path = target.join(&file.relative);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut input = fs::File::open(&file.source).map_err(|error| error.to_string())?;
        let mut output = fs::File::create(&output_path).map_err(|error| error.to_string())?;
        loop {
            let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            output
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
            total += read as u64;
        }
        output.sync_all().map_err(|error| error.to_string())?;
    }
    Ok((hasher.finalize().to_vec(), total))
}

fn cleanup_snapshots(
    cache_root: &Path,
    published: &HashMap<ViewerBundleKey, PublishedViewerBundle>,
) -> Result<(), String> {
    let current = published
        .values()
        .map(|bundle| bundle.snapshot_root.clone())
        .collect::<HashSet<_>>();
    let mut candidates = Vec::new();
    let mut total = 0u64;
    for (key, bundle) in published {
        let view_root = cache_root.join(&key.extension_id).join(&key.view_id);
        let mut revisions = directory_children(&view_root)?;
        revisions.sort_by_key(|path| modified_time(path));
        revisions.reverse();
        for (index, path) in revisions.into_iter().enumerate() {
            let bytes = directory_size(&path)?;
            total = total.saturating_add(bytes);
            if index >= RETAIN_REVISIONS_PER_VIEW && path != bundle.snapshot_root {
                candidates.push((modified_time(&path), bytes, path));
            } else if !current.contains(&path) {
                candidates.push((modified_time(&path), bytes, path));
            }
        }
    }
    candidates.sort_by_key(|(modified, _, _)| *modified);
    for (_, bytes, path) in candidates {
        let over_count = published.values().any(|bundle| {
            path.parent() == bundle.snapshot_root.parent()
                && directory_children(path.parent().unwrap_or(Path::new("/")))
                    .map(|children| children.len() > RETAIN_REVISIONS_PER_VIEW)
                    .unwrap_or(false)
        });
        if total <= MAX_SNAPSHOT_BYTES && !over_count {
            continue;
        }
        if current.contains(&path) {
            continue;
        }
        fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
        total = total.saturating_sub(bytes);
    }
    Ok(())
}

fn directory_children(root: &Path) -> Result<Vec<PathBuf>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    Ok(fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("sha256-"))
        })
        .collect())
}

fn directory_size(root: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        total = total.saturating_add(if metadata.is_dir() {
            directory_size(&path)?
        } else {
            metadata.len()
        });
    }
    Ok(total)
}

fn modified_time(path: &Path) -> SystemTime {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(UNIX_EPOCH)
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::manifest::{Display, ExtensionManifest, View};
    use crate::logs::StdTerminal;
    use tempfile::TempDir;

    fn source(temp: &TempDir) -> ViewerBundleSource {
        let root = temp.path().join("dist");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(
            root.join("index.html"),
            "<script src=\"assets/app.js\"></script>",
        )
        .unwrap();
        fs::write(root.join("assets/app.js"), "console.log('a')").unwrap();
        ViewerBundleSource {
            key: ViewerBundleKey {
                extension_id: "fixture".to_string(),
                view_id: "main".to_string(),
            },
            route: "/viewers/fixture".to_string(),
            entry: root.join("index.html"),
            source_root: root,
            entry_relative_path: PathBuf::from("index.html"),
        }
    }

    #[test]
    fn identical_content_has_a_stable_revision() {
        let temp = TempDir::new().unwrap();
        let cache = temp.path().join("cache");
        let source = source(&temp);
        let first = publish_snapshot(&cache, &source).unwrap();
        let second = publish_snapshot(&cache, &source).unwrap();
        assert_eq!(first.revision, second.revision);
        assert!(first.snapshot_root.join("assets/app.js").is_file());
    }

    #[test]
    fn timestamps_do_not_contribute_to_revision() {
        let temp = TempDir::new().unwrap();
        let cache = temp.path().join("cache");
        let source = source(&temp);
        let first = publish_snapshot(&cache, &source).unwrap();
        std::thread::sleep(Duration::from_millis(2));
        fs::write(
            source.source_root.join("assets/app.js"),
            "console.log('a')",
        )
        .unwrap();
        let second = publish_snapshot(&cache, &source).unwrap();
        assert_eq!(first.revision, second.revision);
    }

    #[test]
    fn changed_content_publishes_an_immutable_revision() {
        let temp = TempDir::new().unwrap();
        let cache = temp.path().join("cache");
        let source = source(&temp);
        let first = publish_snapshot(&cache, &source).unwrap();
        fs::write(source.source_root.join("assets/app.js"), "console.log('b')").unwrap();
        let second = publish_snapshot(&cache, &source).unwrap();
        assert_ne!(first.revision, second.revision);
        assert_eq!(
            fs::read_to_string(first.snapshot_root.join("assets/app.js")).unwrap(),
            "console.log('a')"
        );
    }

    #[test]
    fn root_relative_assets_outside_the_declared_route_are_rejected() {
        let temp = TempDir::new().unwrap();
        let cache = temp.path().join("cache");
        let source = source(&temp);
        fs::write(
            &source.entry,
            "<script src=\"/assets/app.js\"></script>",
        )
        .unwrap();
        assert!(publish_snapshot(&cache, &source)
            .unwrap_err()
            .contains("root-relative asset"));

        fs::write(
            &source.entry,
            "<script src=\"/viewers/fixture/assets/app.js\"></script>",
        )
        .unwrap();
        assert!(publish_snapshot(&cache, &source).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn escaping_symlink_is_rejected() {
        use std::os::unix::fs::symlink;
        let temp = TempDir::new().unwrap();
        let cache = temp.path().join("cache");
        let source = source(&temp);
        let outside = temp.path().join("secret");
        fs::write(&outside, "secret").unwrap();
        symlink(&outside, source.source_root.join("assets/secret.js")).unwrap();
        assert!(publish_snapshot(&cache, &source).is_err());
    }

    #[test]
    fn revision_validation_rejects_paths_and_short_hashes() {
        assert!(!valid_revision(".."));
        assert!(!valid_revision("sha256-deadbeef"));
        assert!(!valid_revision(&format!("sha256-{}", "A".repeat(64))));
        assert!(valid_revision(&format!("sha256-{}", "a".repeat(64))));
    }

    #[tokio::test]
    async fn revalidate_policy_does_not_publish_snapshots() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("dist");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("index.html"), "viewer").unwrap();
        let manifest = ExtensionManifest {
            display: Display {
                icon: None,
                icon_dark: None,
                title: "Fixture".to_string(),
            },
            file_handlers: Vec::new(),
            id: "fixture".to_string(),
            launchers: Vec::new(),
            name: "Fixture".to_string(),
            root_dir: temp.path().to_path_buf(),
            server: None,
            views: vec![(
                "main".to_string(),
                View {
                    build: None,
                    cache: ViewCachePolicy::Revalidate,
                    entry: root.join("index.html"),
                    route: "/viewers/fixture".to_string(),
                    watch: None,
                },
            )],
            workloads: Default::default(),
        };
        let journal = Journal::new(temp.path(), 1, Arc::new(StdTerminal)).unwrap();
        let registry = ViewerBundleRegistry::new(temp.path(), &[manifest], journal);
        assert!(registry.sources.is_empty());
    }
}
