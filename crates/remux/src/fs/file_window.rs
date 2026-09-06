use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::core::is_likely_binary;

pub const DEFAULT_WINDOW_BYTES: u64 = 256 * 1024;
pub const MAX_WINDOW_BYTES: u64 = 512 * 1024;
pub const MIN_WINDOW_BYTES: u64 = 4;
const SCAN_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileWindowErrorKind {
    Binary,
    Changed,
    InvalidUtf8,
    Read,
    TargetLineNotFound,
}

impl FileWindowErrorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Binary => "binary",
            Self::Changed => "changed",
            Self::InvalidUtf8 => "invalidUtf8",
            Self::Read => "read",
            Self::TargetLineNotFound => "targetLineNotFound",
        }
    }
}

#[derive(Debug)]
pub struct FileWindowError {
    pub kind: FileWindowErrorKind,
    pub message: String,
}

impl FileWindowError {
    fn new(kind: FileWindowErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct FileWindowRequest {
    pub expected_version: Option<String>,
    pub limit: u64,
    pub offset: u64,
    pub path: PathBuf,
    pub target_line: Option<u64>,
}

pub async fn read_file_window(request: FileWindowRequest) -> Result<Value, FileWindowError> {
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    // Opening a FIFO for reading can block before we get to the regular-file
    // check. Nonblocking open has no effect on ordinary files.
    #[cfg(unix)]
    options.custom_flags(nix::libc::O_NONBLOCK);
    let mut file = options.open(&request.path)
        .await
        .map_err(|error| read_error(error, &request.path))?;
    let initial_metadata = file
        .metadata()
        .await
        .map_err(|error| read_error(error, &request.path))?;
    if !initial_metadata.is_file() {
        return Err(FileWindowError::new(
            FileWindowErrorKind::Read,
            "Expected a file.",
        ));
    }
    let initial_version = file_version(&initial_metadata);
    if request
        .expected_version
        .as_deref()
        .is_some_and(|expected| expected != initial_version)
    {
        return Err(FileWindowError::new(
            FileWindowErrorKind::Changed,
            "The file changed. Refresh before loading another range.",
        ));
    }
    let total_size = initial_metadata.len();
    let (requested_offset, target) = if let Some(line_number) = request.target_line {
        let byte_offset = match find_line_offset(&mut file, line_number, total_size).await {
            Ok(offset) => offset,
            Err(error) if error.kind == FileWindowErrorKind::TargetLineNotFound => {
                ensure_unchanged(&file, &request.path, &initial_version).await?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        (
            byte_offset,
            Some(json!({ "byteOffset": byte_offset, "lineNumber": line_number })),
        )
    } else {
        (request.offset.min(total_size), None)
    };

    let start = utf8_aligned_start(&mut file, requested_offset, total_size, &request.path).await?;
    let mut starts_mid_line = false;
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start - 1))
            .await
            .map_err(|error| read_error(error, &request.path))?;
        let mut previous = [0u8; 1];
        file.read_exact(&mut previous)
            .await
            .map_err(|error| read_during_window_error(error, &request.path))?;
        starts_mid_line = previous[0] != b'\n';
    }

    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|error| read_error(error, &request.path))?;
    let available = total_size.saturating_sub(start);
    let read_length = available.min(request.limit.saturating_add(4));
    let mut buffer = vec![0u8; read_length as usize];
    file.read_exact(&mut buffer)
        .await
        .map_err(|error| read_during_window_error(error, &request.path))?;

    let desired_length = request.limit.min(total_size.saturating_sub(start)) as usize;
    let mut end_index = desired_length;
    while end_index > 0 && end_index < buffer.len() && is_continuation(buffer[end_index]) {
        end_index -= 1;
    }
    if end_index == 0 && start < total_size {
        end_index = 1;
        while end_index < buffer.len() && is_continuation(buffer[end_index]) {
            end_index += 1;
        }
    }
    let bytes = &buffer[..end_index];
    if is_likely_binary(bytes) {
        return Err(FileWindowError::new(
            FileWindowErrorKind::Binary,
            "The selected file contains binary data.",
        ));
    }
    let content = std::str::from_utf8(bytes).map_err(|_| {
        FileWindowError::new(
            FileWindowErrorKind::InvalidUtf8,
            "The requested range does not contain valid UTF-8.",
        )
    })?;
    let end = start + end_index as u64;
    let eof = end >= total_size;
    let ends_mid_line = !eof && bytes.last().is_some_and(|byte| *byte != b'\n');

    ensure_unchanged(&file, &request.path, &initial_version).await?;
    Ok(json!({
        "content": content,
        "continuation": {
            "endsMidLine": ends_mid_line,
            "startsMidLine": starts_mid_line,
        },
        "encoding": "utf8",
        "eof": eof,
        "nextOffset": (!eof).then_some(end),
        "path": request.path.to_string_lossy(),
        "previousOffset": (start > 0).then_some(start.saturating_sub(request.limit)),
        "range": { "endByte": end, "startByte": start },
        "targetLine": target,
        "totalSizeBytes": total_size,
        "version": initial_version,
    }))
}

async fn utf8_aligned_start(
    file: &mut tokio::fs::File,
    requested: u64,
    total_size: u64,
    path: &Path,
) -> Result<u64, FileWindowError> {
    if requested >= total_size {
        if total_size > 0 {
            let tail_start = total_size.saturating_sub(4);
            file.seek(std::io::SeekFrom::Start(tail_start))
                .await
                .map_err(|error| read_error(error, path))?;
            let mut tail = vec![0u8; (total_size - tail_start) as usize];
            file.read_exact(&mut tail)
                .await
                .map_err(|error| read_during_window_error(error, path))?;
            let first_boundary = tail
                .iter()
                .position(|byte| !is_continuation(*byte))
                .unwrap_or(tail.len());
            if first_boundary == tail.len() || std::str::from_utf8(&tail[first_boundary..]).is_err()
            {
                return Err(FileWindowError::new(
                    FileWindowErrorKind::InvalidUtf8,
                    "The file ends with invalid UTF-8.",
                ));
            }
        }
        return Ok(total_size);
    }
    file.seek(std::io::SeekFrom::Start(requested))
        .await
        .map_err(|error| read_error(error, path))?;
    let mut current = [0u8; 1];
    file.read_exact(&mut current)
        .await
        .map_err(|error| read_during_window_error(error, path))?;
    if !is_continuation(current[0]) {
        return Ok(requested);
    }
    if requested == 0 {
        return Err(FileWindowError::new(
            FileWindowErrorKind::InvalidUtf8,
            "The requested range starts with invalid UTF-8.",
        ));
    }

    let lookbehind_start = requested.saturating_sub(3);
    let inspect_end = total_size.min(requested + 4);
    file.seek(std::io::SeekFrom::Start(lookbehind_start))
        .await
        .map_err(|error| read_error(error, path))?;
    let mut context = vec![0u8; (inspect_end - lookbehind_start) as usize];
    file.read_exact(&mut context)
        .await
        .map_err(|error| read_during_window_error(error, path))?;
    let requested_index = (requested - lookbehind_start) as usize;
    let Some(lead_index) = (0..requested_index)
        .rev()
        .find(|index| !is_continuation(context[*index]))
    else {
        return Err(FileWindowError::new(
            FileWindowErrorKind::InvalidUtf8,
            "The requested range starts within invalid UTF-8.",
        ));
    };
    let width = utf8_sequence_width(context[lead_index]);
    let sequence_end = lead_index + width;
    if width < 2
        || sequence_end > context.len()
        || sequence_end <= requested_index
        || std::str::from_utf8(&context[lead_index..sequence_end]).is_err()
    {
        return Err(FileWindowError::new(
            FileWindowErrorKind::InvalidUtf8,
            "The requested range starts within invalid UTF-8.",
        ));
    }
    Ok(lookbehind_start + sequence_end as u64)
}

fn utf8_sequence_width(byte: u8) -> usize {
    match byte {
        0x00..=0x7f => 1,
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 0,
    }
}

async fn find_line_offset(
    file: &mut tokio::fs::File,
    target_line: u64,
    total_size: u64,
) -> Result<u64, FileWindowError> {
    if target_line == 1 {
        return Ok(0);
    }
    file.seek(std::io::SeekFrom::Start(0))
        .await
        .map_err(|error| read_error(error, Path::new("file")))?;
    let mut buffer = vec![0u8; SCAN_CHUNK_BYTES];
    let mut utf8_tail = Vec::with_capacity(3);
    let mut byte_offset = 0u64;
    let mut current_line = 1u64;
    while byte_offset < total_size {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|error| read_error(error, Path::new("file")))?;
        if count == 0 {
            break;
        }
        let chunk = &buffer[..count];
        if is_likely_binary(chunk) {
            return Err(FileWindowError::new(
                FileWindowErrorKind::Binary,
                "The selected file contains binary data.",
            ));
        }
        utf8_tail.extend_from_slice(chunk);
        match std::str::from_utf8(&utf8_tail) {
            Ok(_) => utf8_tail.clear(),
            Err(error) if error.error_len().is_none() => {
                let trailing = utf8_tail.split_off(error.valid_up_to());
                utf8_tail = trailing;
            }
            Err(_) => {
                return Err(FileWindowError::new(
                    FileWindowErrorKind::InvalidUtf8,
                    "The file is not valid UTF-8.",
                ))
            }
        }
        for (index, byte) in chunk.iter().enumerate() {
            if *byte == b'\n' {
                current_line += 1;
                if current_line == target_line {
                    return Ok(byte_offset + index as u64 + 1);
                }
            }
        }
        byte_offset += count as u64;
        tokio::task::yield_now().await;
    }
    if !utf8_tail.is_empty() {
        return Err(FileWindowError::new(
            FileWindowErrorKind::InvalidUtf8,
            "The file is not valid UTF-8.",
        ));
    }
    Err(FileWindowError::new(
        FileWindowErrorKind::TargetLineNotFound,
        format!("Line {target_line} is beyond the end of the file."),
    ))
}

async fn ensure_unchanged(
    file: &tokio::fs::File,
    path: &Path,
    initial_version: &str,
) -> Result<(), FileWindowError> {
    let handle_metadata = file
        .metadata()
        .await
        .map_err(|error| read_error(error, path))?;
    let path_metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| read_error(error, path))?;
    if file_version(&handle_metadata) != initial_version
        || file_version(&path_metadata) != initial_version
    {
        return Err(FileWindowError::new(
            FileWindowErrorKind::Changed,
            "The file changed while the range was being read. Refresh and try again.",
        ));
    }
    Ok(())
}

fn read_error(error: std::io::Error, path: &Path) -> FileWindowError {
    FileWindowError::new(
        FileWindowErrorKind::Read,
        format!("File could not be read ({}): {error}", path.display()),
    )
}

fn read_during_window_error(error: std::io::Error, path: &Path) -> FileWindowError {
    if error.kind() == std::io::ErrorKind::UnexpectedEof {
        FileWindowError::new(
            FileWindowErrorKind::Changed,
            "The file changed while the range was being read. Refresh and try again.",
        )
    } else {
        read_error(error, path)
    }
}

fn is_continuation(byte: u8) -> bool {
    byte & 0xc0 == 0x80
}

/// Advisory identity for paging, not a transactional snapshot. An in-place
/// rewrite that preserves inode, byte length and nanosecond mtime can retain
/// the same token; callers recover by starting a fresh explicit reload.
fn file_version(metadata: &std::fs::Metadata) -> String {
    let mut hash = Sha1::new();
    hash.update(metadata.len().to_le_bytes());
    if let Ok(modified) = metadata.modified().and_then(|time| {
        time.duration_since(std::time::UNIX_EPOCH)
            .map_err(std::io::Error::other)
    }) {
        hash.update(modified.as_secs().to_le_bytes());
        hash.update(modified.subsec_nanos().to_le_bytes());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        hash.update(metadata.dev().to_le_bytes());
        hash.update(metadata.ino().to_le_bytes());
    }
    format!("file-v1:{:x}", hash.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn special_files_do_not_block_before_type_validation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("pipe");
        nix::unistd::mkfifo(&path, nix::sys::stat::Mode::S_IRUSR).unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            read_file_window(request(path, 0, DEFAULT_WINDOW_BYTES)),
        ).await.unwrap();
        assert_eq!(result.unwrap_err().kind, FileWindowErrorKind::Read);
    }

    fn request(path: PathBuf, offset: u64, limit: u64) -> FileWindowRequest {
        FileWindowRequest {
            expected_version: None,
            limit,
            offset,
            path,
            target_line: None,
        }
    }

    #[tokio::test]
    async fn windows_are_utf8_aligned_and_page_without_gaps() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("utf8.txt");
        tokio::fs::write(&path, "ab😀cd\néf").await.unwrap();

        let first = read_file_window(request(path.clone(), 0, 4)).await.unwrap();
        assert_eq!(first["content"], "ab");
        assert_eq!(first["range"], json!({ "endByte": 2, "startByte": 0 }));
        assert_eq!(first["nextOffset"], 2);
        assert_eq!(first["continuation"]["endsMidLine"], true);

        let second = read_file_window(request(path.clone(), 2, 4)).await.unwrap();
        assert_eq!(second["content"], "😀");
        assert_eq!(second["range"], json!({ "endByte": 6, "startByte": 2 }));
        let inside = read_file_window(request(path, 3, 4)).await.unwrap();
        assert_eq!(inside["range"]["startByte"], 6);
        assert_eq!(inside["content"], "cd\n");
    }

    #[tokio::test]
    async fn target_line_scan_uses_bounded_chunks_across_a_huge_line() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("huge-line.txt");
        let huge_line = vec![b'x'; 2 * 1024 * 1024];
        let mut file = tokio::fs::File::create(&path).await.unwrap();
        tokio::io::AsyncWriteExt::write_all(&mut file, &huge_line)
            .await
            .unwrap();
        tokio::io::AsyncWriteExt::write_all(&mut file, b"\ntarget\n")
            .await
            .unwrap();
        drop(file);

        let mut target_request = request(path, 0, DEFAULT_WINDOW_BYTES);
        target_request.target_line = Some(2);
        let result = read_file_window(target_request).await.unwrap();
        assert_eq!(result["content"], "target\n");
        assert_eq!(result["targetLine"]["lineNumber"], 2);
        assert_eq!(
            result["targetLine"]["byteOffset"],
            huge_line.len() as u64 + 1
        );
        assert_eq!(result["range"]["startByte"], huge_line.len() as u64 + 1);
    }

    #[tokio::test]
    async fn expected_version_rejects_changed_files() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("changing.txt");
        tokio::fs::write(&path, "first\n").await.unwrap();
        let first = read_file_window(request(path.clone(), 0, 64))
            .await
            .unwrap();
        let version = first["version"].as_str().unwrap().to_string();
        tokio::fs::write(&path, "second version\n").await.unwrap();

        let mut changed_request = request(path, 0, 64);
        changed_request.expected_version = Some(version);
        let error = read_file_window(changed_request).await.unwrap_err();
        assert_eq!(error.kind, FileWindowErrorKind::Changed);
    }

    #[tokio::test]
    async fn binary_invalid_utf8_and_missing_target_are_explicit() {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("binary.txt");
        let invalid = root.path().join("invalid.txt");
        let short = root.path().join("short.txt");
        tokio::fs::write(&binary, b"hello\0world").await.unwrap();
        tokio::fs::write(&invalid, [0xf0, 0x28, 0x8c, 0x28])
            .await
            .unwrap();
        tokio::fs::write(&short, b"one\ntwo").await.unwrap();

        assert_eq!(
            read_file_window(request(binary, 0, 64))
                .await
                .unwrap_err()
                .kind,
            FileWindowErrorKind::Binary
        );
        assert_eq!(
            read_file_window(request(invalid, 0, 64))
                .await
                .unwrap_err()
                .kind,
            FileWindowErrorKind::InvalidUtf8
        );
        let mut target = request(short, 0, 64);
        target.target_line = Some(4);
        assert_eq!(
            read_file_window(target).await.unwrap_err().kind,
            FileWindowErrorKind::TargetLineNotFound
        );
    }

    #[tokio::test]
    async fn standalone_continuation_bytes_are_never_skipped() {
        let root = tempfile::tempdir().unwrap();
        let leading = root.path().join("leading.txt");
        let eof = root.path().join("eof.txt");
        tokio::fs::write(&leading, [0x80, b'a']).await.unwrap();
        tokio::fs::write(&eof, [0x80]).await.unwrap();

        assert_eq!(
            read_file_window(request(leading, 0, 4))
                .await
                .unwrap_err()
                .kind,
            FileWindowErrorKind::InvalidUtf8
        );
        assert_eq!(
            read_file_window(request(eof.clone(), 0, 4))
                .await
                .unwrap_err()
                .kind,
            FileWindowErrorKind::InvalidUtf8
        );
        assert_eq!(
            read_file_window(request(eof, 1, 4)).await.unwrap_err().kind,
            FileWindowErrorKind::InvalidUtf8
        );
    }
}
