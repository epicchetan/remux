use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

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

pub(crate) fn media_url(sha256: &str) -> Result<String, String> {
    let hash = raw_hash(sha256)?;
    Ok(format!("/remux/media/sha256/{hash}"))
}

pub(crate) fn publish_file(
    media_root: &Path,
    source: &Path,
    sha256: &str,
    size_bytes: usize,
    mime_type: &str,
) -> Result<String, String> {
    if mime_type != "audio/wav" {
        return Err(format!("unsupported narration media type {mime_type}"));
    }
    let hash = raw_hash(sha256)?;
    let source_metadata = fs::metadata(source)
        .map_err(|error| format!("narration media source unavailable: {error}"))?;
    if !source_metadata.is_file() || source_metadata.len() != size_bytes as u64 {
        return Err("narration media source size does not match its manifest".to_string());
    }

    let directory = media_root.join("sha256").join(&hash[..2]);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create narration media directory: {error}"))?;
    let base = directory.join(hash);
    let blob = base.with_extension("blob");
    let sidecar = base.with_extension("json");
    let expected = MediaMetadata {
        schema_version: 1,
        sha256: hash.to_string(),
        mime_type: mime_type.to_string(),
        size_bytes: size_bytes as u64,
        created_at_ms: now_ms(),
        last_access_at_ms: now_ms(),
    };

    let blob_valid = fs::metadata(&blob)
        .ok()
        .is_some_and(|metadata| metadata.is_file() && metadata.len() == expected.size_bytes);
    let sidecar_valid = read_metadata(&sidecar).is_some_and(|metadata| {
        metadata.schema_version == expected.schema_version
            && metadata.sha256 == expected.sha256
            && metadata.mime_type == expected.mime_type
            && metadata.size_bytes == expected.size_bytes
    });
    if blob_valid && sidecar_valid {
        return Ok(format!("/remux/media/sha256/{hash}"));
    }

    if !blob_valid {
        publish_blob(source, &blob)?;
    }
    let metadata = if let Some(previous) = read_metadata(&sidecar) {
        MediaMetadata {
            created_at_ms: previous.created_at_ms,
            ..expected
        }
    } else {
        expected
    };
    atomic_write(
        &sidecar,
        &serde_json::to_vec(&metadata)
            .map_err(|error| format!("failed to encode narration media metadata: {error}"))?,
    )?;
    Ok(format!("/remux/media/sha256/{hash}"))
}

fn publish_blob(source: &Path, destination: &Path) -> Result<(), String> {
    let temporary = temporary_path(destination);
    let _ = fs::remove_file(&temporary);
    if fs::hard_link(source, &temporary).is_err() {
        fs::copy(source, &temporary)
            .map_err(|error| format!("failed to copy narration media: {error}"))?;
        fs::File::open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("failed to sync narration media: {error}"))?;
    }
    match fs::rename(&temporary, destination) {
        Ok(()) => Ok(()),
        Err(_error)
            if destination
                .metadata()
                .ok()
                .is_some_and(|metadata| metadata.is_file()) =>
        {
            let _ = fs::remove_file(temporary);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(temporary);
            Err(format!("failed to publish narration media: {error}"))
        }
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = temporary_path(path);
    fs::write(&temporary, bytes)
        .map_err(|error| format!("failed to write narration media metadata: {error}"))?;
    fs::File::open(&temporary)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("failed to sync narration media metadata: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to publish narration media metadata: {error}"))
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("media");
    path.with_file_name(format!(
        ".{name}.tmp-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed),
    ))
}

fn read_metadata(path: &Path) -> Option<MediaMetadata> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn raw_hash(sha256: &str) -> Result<&str, String> {
    let hash = sha256
        .strip_prefix("sha256-")
        .ok_or_else(|| "narration media SHA-256 is invalid".to_string())?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("narration media SHA-256 is invalid".to_string());
    }
    Ok(hash)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_content_addressed_audio_and_repairs_missing_blob() {
        let root = std::env::temp_dir().join(format!(
            "remux-narrate-media-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        let source = root.join("source.wav");
        fs::create_dir_all(&root).unwrap();
        fs::write(&source, b"RIFFtest").unwrap();
        let sha256 = "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let url = publish_file(&root, &source, sha256, 8, "audio/wav").unwrap();
        assert_eq!(
            url,
            "/remux/media/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        let blob = root.join(
            "sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.blob",
        );
        assert_eq!(fs::read(&blob).unwrap(), b"RIFFtest");
        fs::remove_file(&blob).unwrap();
        publish_file(&root, &source, sha256, 8, "audio/wav").unwrap();
        assert_eq!(fs::read(blob).unwrap(), b"RIFFtest");
        let _ = fs::remove_dir_all(root);
    }
}
