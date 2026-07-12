use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};

use crate::time::now_ms;

const MAX_MEDIA_CACHE_BYTES: u64 = 1024 * 1024 * 1024;
const ACCESS_WRITE_INTERVAL: Duration = Duration::from_secs(60 * 60);
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaMetadata {
    schema_version: u32,
    sha256: String,
    mime_type: String,
    size_bytes: u64,
    created_at_ms: i64,
    last_access_at_ms: i64,
}

pub fn initialize_media_cache(root_dir: &Path) -> Result<PathBuf, String> {
    let root = root_dir.join(".remux/cache/media");
    fs::create_dir_all(root.join("sha256")).map_err(|error| error.to_string())?;
    cleanup_media_cache(&root)?;
    Ok(root)
}

pub async fn serve_media(root: &Path, pathname: &str, headers: &HeaderMap) -> Option<Response> {
    let hash = pathname.strip_prefix("/remux/media/sha256/")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Some(not_found());
    }

    let base = root.join("sha256").join(&hash[..2]).join(hash);
    let blob_path = base.with_extension("blob");
    let metadata_path = base.with_extension("json");
    let metadata = match tokio::fs::read(&metadata_path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<MediaMetadata>(&bytes).ok())
        .filter(|metadata| valid_metadata(metadata, hash))
    {
        Some(metadata) => metadata,
        None => return Some(not_found()),
    };
    let blob = match tokio::fs::read(&blob_path).await {
        Ok(blob) if blob.len() as u64 == metadata.size_bytes => blob,
        _ => return Some(not_found()),
    };

    let etag = format!("\"{hash}\"");
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|candidate| candidate.trim() == etag))
    {
        return Some(
            Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header(header::ETAG, etag)
                .body(Body::empty())
                .expect("media response"),
        );
    }

    maybe_touch_metadata(metadata_path, metadata.clone());
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, metadata.mime_type)
            .header(header::CONTENT_LENGTH, metadata.size_bytes)
            .header(header::ETAG, etag)
            .header(
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            )
            .body(Body::from(blob))
            .expect("media response"),
    )
}

fn valid_metadata(metadata: &MediaMetadata, hash: &str) -> bool {
    metadata.schema_version == 1
        && metadata.sha256 == hash
        && matches!(
            metadata.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        )
}

fn maybe_touch_metadata(path: PathBuf, mut metadata: MediaMetadata) {
    let age_ms = now_ms().saturating_sub(metadata.last_access_at_ms);
    if age_ms < ACCESS_WRITE_INTERVAL.as_millis() as i64 {
        return;
    }
    metadata.last_access_at_ms = now_ms();
    tokio::spawn(async move {
        if let Ok(bytes) = serde_json::to_vec(&metadata) {
            let temp = path.with_extension(format!(
                "json.tmp-{}-{}",
                std::process::id(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            ));
            if tokio::fs::write(&temp, bytes).await.is_ok() {
                let _ = tokio::fs::rename(temp, path).await;
            }
        }
    });
}

fn cleanup_media_cache(root: &Path) -> Result<(), String> {
    let hash_root = root.join("sha256");
    let mut blobs = Vec::new();
    collect_blobs(&hash_root, &mut blobs)?;
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

fn collect_blobs(root: &Path, output: &mut Vec<(SystemTime, u64, PathBuf)>) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            collect_blobs(&path, output)?;
        } else if path.extension().and_then(|value| value.to_str()) == Some("blob") {
            let access = fs::read(path.with_extension("json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<MediaMetadata>(&bytes).ok())
                .and_then(|metadata| {
                    UNIX_EPOCH.checked_add(Duration::from_millis(
                        metadata.last_access_at_ms.max(0) as u64,
                    ))
                })
                .unwrap_or_else(|| metadata.modified().unwrap_or(UNIX_EPOCH));
            output.push((access, metadata.len(), path));
        }
    }
    Ok(())
}

fn not_found() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from("Media not found."))
        .expect("media response")
}
