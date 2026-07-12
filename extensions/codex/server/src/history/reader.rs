use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    pub(crate) device: u64,
    pub(crate) inode: u64,
}

#[derive(Debug)]
pub(crate) struct LineEntry {
    pub(crate) start_offset: u64,
    pub(crate) end_offset: u64,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct ScanChunk {
    pub(crate) lines: Vec<LineEntry>,
    pub(crate) parsed_len: u64,
    pub(crate) scanned_len: u64,
    pub(crate) trailing_partial_line: Vec<u8>,
}

pub(crate) fn file_identity_and_len(path: &Path) -> Result<(FileIdentity, u64), String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let identity = FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    };
    #[cfg(not(unix))]
    let identity = FileIdentity {
        device: 0,
        inode: metadata.len(),
    };
    Ok((identity, metadata.len()))
}

pub(crate) fn scan_from(
    path: &Path,
    scanned_len: u64,
    parsed_len: u64,
    trailing_partial_line: &[u8],
) -> Result<ScanChunk, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(scanned_len))
        .map_err(|error| error.to_string())?;
    let mut appended = Vec::new();
    file.read_to_end(&mut appended)
        .map_err(|error| error.to_string())?;
    let bytes_read = appended.len() as u64;
    let mut combined = Vec::with_capacity(trailing_partial_line.len() + appended.len());
    combined.extend_from_slice(trailing_partial_line);
    combined.extend_from_slice(&appended);

    let mut lines = Vec::new();
    let mut start = 0usize;
    for (index, byte) in combined.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let end = index + 1;
        let mut line = combined[start..index].to_vec();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        lines.push(LineEntry {
            start_offset: parsed_len + start as u64,
            end_offset: parsed_len + end as u64,
            bytes: line,
        });
        start = end;
    }

    Ok(ScanChunk {
        lines,
        parsed_len: parsed_len + start as u64,
        scanned_len: scanned_len + bytes_read,
        trailing_partial_line: combined[start..].to_vec(),
    })
}

pub(crate) fn boundary_fingerprint(path: &Path, scanned_len: u64) -> Result<u64, String> {
    let start = scanned_len.saturating_sub(128);
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut buffer = vec![0; scanned_len.saturating_sub(start) as usize];
    file.read_exact(&mut buffer)
        .map_err(|error| error.to_string())?;
    Ok(fnv1a64(0xcbf29ce484222325, &buffer))
}

pub(super) fn fnv1a64(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
