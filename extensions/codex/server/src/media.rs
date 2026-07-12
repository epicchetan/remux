use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::util::stable_revision_value;

const MAX_MEDIA_BYTES: usize = 20 * 1024 * 1024;
const MAX_MEDIA_CACHE_BYTES: u64 = 1024 * 1024 * 1024;
const WARNING_INTERVAL_MS: i64 = 60 * 60 * 1000;

static MEDIA_CACHE: OnceLock<MediaCache> = OnceLock::new();
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static LAST_WARNING_MS: AtomicI64 = AtomicI64::new(0);
static LAST_CLEANUP_MS: AtomicI64 = AtomicI64::new(0);

#[derive(Debug)]
pub(crate) struct MediaCache {
    root: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaMetadata<'a> {
    schema_version: u32,
    sha256: &'a str,
    mime_type: &'a str,
    size_bytes: usize,
    created_at_ms: i64,
    last_access_at_ms: i64,
}

impl MediaCache {
    fn from_environment() -> Self {
        Self {
            root: std::env::var_os("REMUX_MEDIA_DIR").map(PathBuf::from),
        }
    }

    #[cfg(test)]
    fn at(root: PathBuf) -> Self {
        Self { root: Some(root) }
    }

    fn materialize_data_url(&self, url: &str) -> Result<Option<String>, String> {
        let Some(root) = &self.root else {
            return Ok(None);
        };
        let Some(rest) = url.strip_prefix("data:") else {
            return Ok(None);
        };
        let (metadata, encoded) = rest
            .split_once(',')
            .ok_or_else(|| "image data URL is missing a payload".to_string())?;
        let mut fields = metadata.split(';');
        let mime_type = fields.next().unwrap_or_default().to_ascii_lowercase();
        if !matches!(
            mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        ) {
            return Err(format!("unsupported transcript image type {mime_type}"));
        }
        if !fields.any(|field| field.eq_ignore_ascii_case("base64")) {
            return Err("transcript image data URL is not base64".to_string());
        }
        if encoded.len() > (MAX_MEDIA_BYTES * 4 / 3) + 8 {
            return Err("transcript image exceeds 20 MiB".to_string());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("invalid transcript image base64: {error}"))?;
        if bytes.len() > MAX_MEDIA_BYTES {
            return Err("transcript image exceeds 20 MiB".to_string());
        }

        let digest = Sha256::digest(&bytes);
        let hash = hex_lower(&digest);
        let directory = root.join("sha256").join(&hash[..2]);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let base = directory.join(&hash);
        let blob = base.with_extension("blob");
        let sidecar = base.with_extension("json");
        if !blob
            .metadata()
            .ok()
            .is_some_and(|metadata| metadata.len() == bytes.len() as u64)
        {
            atomic_write(&blob, &bytes)?;
        }
        let sidecar_valid = fs::read(&sidecar)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|metadata| {
                metadata.get("schemaVersion").and_then(Value::as_u64) == Some(1)
                    && metadata.get("sha256").and_then(Value::as_str) == Some(hash.as_str())
                    && metadata.get("mimeType").and_then(Value::as_str)
                        == Some(mime_type.as_str())
                    && metadata.get("sizeBytes").and_then(Value::as_u64)
                        == Some(bytes.len() as u64)
            });
        if !sidecar_valid {
            let now = now_ms();
            let metadata = serde_json::to_vec(&MediaMetadata {
                schema_version: 1,
                sha256: &hash,
                mime_type: &mime_type,
                size_bytes: bytes.len(),
                created_at_ms: now,
                last_access_at_ms: now,
            })
            .map_err(|error| error.to_string())?;
            atomic_write(&sidecar, &metadata)?;
        }
        schedule_cleanup(root);
        Ok(Some(format!("/remux/media/sha256/{hash}")))
    }
}

pub(crate) fn rewrite_render_media(value: &mut Value) {
    let cache = MEDIA_CACHE.get_or_init(MediaCache::from_environment);
    rewrite_value(value, cache);
}

fn rewrite_value(value: &mut Value, cache: &MediaCache) -> bool {
    match value {
        Value::Array(values) => values.iter_mut().fold(false, |changed, value| {
            rewrite_value(value, cache) || changed
        }),
        Value::Object(object) => {
            let mut changed = false;
            if object.get("type").and_then(Value::as_str) == Some("image") {
                if let Some(url) = object.get("url").and_then(Value::as_str) {
                    match cache.materialize_data_url(url) {
                        Ok(Some(media_url)) => {
                            object.insert("url".to_string(), Value::String(media_url));
                            changed = true;
                        }
                        Ok(None) => {}
                        Err(error) => warn_throttled(&error),
                    }
                }
            }
            for child in object.values_mut() {
                changed = rewrite_value(child, cache) || changed;
            }
            if changed && object.contains_key("revision") {
                let mut identity = object.clone();
                identity.remove("revision");
                object.insert(
                    "revision".to_string(),
                    Value::String(stable_revision_value(&Value::Object(identity))),
                );
            }
            changed
        }
        _ => false,
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::File::create(&temp).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(_error) if path.exists() => {
            let _ = fs::remove_file(temp);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(temp);
            Err(error.to_string())
        }
    }
}

fn warn_throttled(message: &str) {
    let now = now_ms();
    let previous = LAST_WARNING_MS.load(Ordering::Relaxed);
    if now.saturating_sub(previous) < WARNING_INTERVAL_MS {
        return;
    }
    if LAST_WARNING_MS
        .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
    {
        eprintln!("transcript media materialization failed: {message}");
    }
}

fn schedule_cleanup(root: &Path) {
    let now = now_ms();
    let previous = LAST_CLEANUP_MS.load(Ordering::Relaxed);
    if now.saturating_sub(previous) < WARNING_INTERVAL_MS
        || LAST_CLEANUP_MS
            .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
    {
        return;
    }
    let root = root.to_path_buf();
    let _ = std::thread::Builder::new()
        .name("codex-media-cleanup".to_string())
        .spawn(move || {
            if let Err(error) = cleanup_cache(&root) {
                warn_throttled(&format!("media cache cleanup: {error}"));
            }
        });
}

fn cleanup_cache(root: &Path) -> Result<(), String> {
    let mut blobs = Vec::new();
    collect_blobs(&root.join("sha256"), &mut blobs)?;
    let mut total = blobs.iter().map(|(_, bytes, _)| *bytes).sum::<u64>();
    blobs.sort_by_key(|(accessed, _, _)| *accessed);
    for (_, bytes, blob) in blobs {
        if total <= MAX_MEDIA_CACHE_BYTES {
            break;
        }
        let _ = fs::remove_file(&blob);
        let _ = fs::remove_file(blob.with_extension("json"));
        total = total.saturating_sub(bytes);
    }
    Ok(())
}

fn collect_blobs(root: &Path, output: &mut Vec<(i64, u64, PathBuf)>) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            collect_blobs(&path, output)?;
        } else if path.extension().and_then(|value| value.to_str()) == Some("blob") {
            let accessed = fs::read(path.with_extension("json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|value| value.get("lastAccessAtMs").and_then(Value::as_i64))
                .unwrap_or(0);
            output.push((accessed, metadata.len(), path));
        }
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
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

    #[test]
    fn data_image_is_materialized_once_and_rewritten() {
        let temp = tempfile_dir();
        let cache = MediaCache::at(temp.clone());
        let url = "data:image/png;base64,aGVsbG8=";
        let first = cache.materialize_data_url(url).unwrap().unwrap();
        let second = cache.materialize_data_url(url).unwrap().unwrap();
        assert_eq!(first, second);
        let hash = first.rsplit('/').next().unwrap();
        assert_eq!(fs::read(temp.join("sha256").join(&hash[..2]).join(format!("{hash}.blob"))).unwrap(), b"hello");
    }

    #[test]
    fn render_tree_replaces_data_url_and_revisions() {
        let temp = tempfile_dir();
        let cache = MediaCache::at(temp);
        let mut frame = serde_json::json!({
            "revision": "old",
            "segments": [{
                "content": [{
                    "type": "image",
                    "url": "data:image/png;base64,aGVsbG8="
                }],
                "revision": "old-segment",
                "type": "userMessage"
            }]
        });
        assert!(rewrite_value(&mut frame, &cache));
        let encoded = frame.to_string();
        assert!(!encoded.contains("data:image"));
        assert!(encoded.contains("/remux/media/sha256/"));
        assert_ne!(frame["revision"], "old");
        assert_ne!(frame["segments"][0]["revision"], "old-segment");
    }

    fn tempfile_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "remux-codex-media-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }
}
