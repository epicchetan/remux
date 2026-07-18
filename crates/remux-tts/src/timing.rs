use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::batch::SAMPLE_RATE;

pub(crate) const WAV_HEADER_BYTES: u64 = 44;
const PCM_WRITE_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WavFileInfo {
    pub(crate) path: PathBuf,
    pub(crate) sha256: String,
    pub(crate) size_bytes: u64,
    pub(crate) total_samples: usize,
}

pub(crate) struct Pcm16WavWriter {
    file: Option<File>,
    final_path: PathBuf,
    max_bytes: u64,
    temporary_path: PathBuf,
    total_samples: usize,
}

impl Pcm16WavWriter {
    pub(crate) fn create(final_path: &Path, max_bytes: u64) -> Result<Self, String> {
        if max_bytes <= WAV_HEADER_BYTES || max_bytes > u32::MAX as u64 {
            return Err("narrationAudioTooLarge: invalid WAV byte ceiling".to_string());
        }
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create narration staging: {error}"))?;
        }
        let temporary_path = final_path.with_extension("wav.tmp");
        let mut file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&temporary_path)
            .map_err(|error| format!("failed to create narration WAV: {error}"))?;
        file.write_all(&[0; WAV_HEADER_BYTES as usize])
            .map_err(|error| format!("failed to reserve narration WAV header: {error}"))?;
        Ok(Self {
            file: Some(file),
            final_path: final_path.to_path_buf(),
            max_bytes,
            temporary_path,
            total_samples: 0,
        })
    }

    pub(crate) fn append(&mut self, audio: &[f32]) -> Result<usize, String> {
        if audio.is_empty() || audio.iter().any(|sample| !sample.is_finite()) {
            return Err(
                "durationProjectionInvalid: chunk waveform is empty or non-finite".to_string(),
            );
        }
        let new_samples = self
            .total_samples
            .checked_add(audio.len())
            .ok_or_else(|| "narrationAudioTooLarge: sample count overflow".to_string())?;
        let new_size = WAV_HEADER_BYTES
            .checked_add(
                u64::try_from(new_samples)
                    .ok()
                    .and_then(|samples| samples.checked_mul(2))
                    .ok_or_else(|| "narrationAudioTooLarge: byte count overflow".to_string())?,
            )
            .ok_or_else(|| "narrationAudioTooLarge: byte count overflow".to_string())?;
        if new_size > self.max_bytes || new_size - 8 > u32::MAX as u64 {
            return Err(format!(
                "narrationAudioTooLarge: WAV would exceed {} bytes",
                self.max_bytes
            ));
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| "narration WAV writer is already finalized".to_string())?;
        let mut buffer = [0_u8; PCM_WRITE_BUFFER_BYTES];
        let mut buffered = 0usize;
        for sample in audio {
            let bytes =
                (((*sample).clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16).to_le_bytes();
            buffer[buffered..buffered + 2].copy_from_slice(&bytes);
            buffered += 2;
            if buffered == buffer.len() {
                file.write_all(&buffer)
                    .map_err(|error| format!("failed to append narration WAV: {error}"))?;
                buffered = 0;
            }
        }
        if buffered > 0 {
            file.write_all(&buffer[..buffered])
                .map_err(|error| format!("failed to append narration WAV: {error}"))?;
        }
        self.total_samples = new_samples;
        Ok(self.total_samples)
    }

    pub(crate) fn finish(mut self) -> Result<WavFileInfo, String> {
        if self.total_samples == 0 {
            return Err("durationProjectionInvalid: completed waveform is empty".to_string());
        }
        let data_bytes = u32::try_from(self.total_samples.checked_mul(2).ok_or_else(|| {
            "narrationAudioTooLarge: final sample byte count overflow".to_string()
        })?)
        .map_err(|_| "narrationAudioTooLarge: final WAV exceeds RIFF limits".to_string())?;
        let header = canonical_header(data_bytes);
        let mut file = self
            .file
            .take()
            .ok_or_else(|| "narration WAV writer is already finalized".to_string())?;
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(&header))
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("failed to finalize narration WAV: {error}"))?;
        drop(file);
        fs::rename(&self.temporary_path, &self.final_path)
            .map_err(|error| format!("failed to publish narration WAV: {error}"))?;
        validate_wav_file(&self.final_path, self.max_bytes)
    }
}

impl Drop for Pcm16WavWriter {
    fn drop(&mut self) {
        if self.file.is_some() {
            let _ = fs::remove_file(&self.temporary_path);
        }
    }
}

pub(crate) fn validate_wav_file(path: &Path, max_bytes: u64) -> Result<WavFileInfo, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("failed to open narration WAV {}: {error}", path.display()))?;
    let size_bytes = file
        .metadata()
        .map_err(|error| format!("failed to stat narration WAV: {error}"))?
        .len();
    if size_bytes <= WAV_HEADER_BYTES || size_bytes > max_bytes {
        return Err("wavSampleCountMismatch: narration WAV size is invalid".to_string());
    }
    let mut header = [0_u8; WAV_HEADER_BYTES as usize];
    file.read_exact(&mut header)
        .map_err(|error| format!("failed to read narration WAV header: {error}"))?;
    let data_bytes = u32::from_le_bytes(header[40..44].try_into().unwrap()) as u64;
    if header != canonical_header(u32::try_from(data_bytes).unwrap())
        || data_bytes + WAV_HEADER_BYTES != size_bytes
        || !data_bytes.is_multiple_of(2)
    {
        return Err("wavSampleCountMismatch: narration WAV header is invalid".to_string());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("failed to rewind narration WAV: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to hash narration WAV: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(WavFileInfo {
        path: path.to_path_buf(),
        sha256: format!("sha256-{:x}", digest.finalize()),
        size_bytes,
        total_samples: usize::try_from(data_bytes / 2)
            .map_err(|_| "wavSampleCountMismatch: sample count overflow".to_string())?,
    })
}

fn canonical_header(data_bytes: u32) -> [u8; WAV_HEADER_BYTES as usize] {
    let mut header = [0_u8; WAV_HEADER_BYTES as usize];
    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&(36 + data_bytes).to_le_bytes());
    header[8..16].copy_from_slice(b"WAVEfmt ");
    header[16..20].copy_from_slice(&16_u32.to_le_bytes());
    header[20..22].copy_from_slice(&1_u16.to_le_bytes());
    header[22..24].copy_from_slice(&1_u16.to_le_bytes());
    header[24..28].copy_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    header[28..32].copy_from_slice(&((SAMPLE_RATE * 2) as u32).to_le_bytes());
    header[32..34].copy_from_slice(&2_u16.to_le_bytes());
    header[34..36].copy_from_slice(&16_u16.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    header
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "remux-tts-{name}-{}-{}.wav",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ))
    }

    #[test]
    fn file_writer_produces_canonical_pcm_and_streaming_hash() {
        let path = temporary("writer");
        let _ = fs::remove_file(&path);
        let mut writer = Pcm16WavWriter::create(&path, 1024).unwrap();
        writer.append(&[0.0, 1.0, -1.0]).unwrap();
        let info = writer.finish().unwrap();
        assert_eq!(info.total_samples, 3);
        assert_eq!(info.size_bytes, 50);
        assert_eq!(validate_wav_file(&path, 1024).unwrap(), info);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn writer_rejects_before_crossing_size_ceiling() {
        let path = temporary("limit");
        let _ = fs::remove_file(&path);
        let mut writer = Pcm16WavWriter::create(&path, 48).unwrap();
        writer.append(&[0.0, 0.0]).unwrap();
        assert!(
            writer
                .append(&[0.0])
                .unwrap_err()
                .contains("narrationAudioTooLarge")
        );
        drop(writer);
        assert!(!path.exists());
    }

    #[test]
    fn writer_flushes_across_fixed_pcm_buffer_boundaries() {
        let path = temporary("buffer-boundary");
        let _ = fs::remove_file(&path);
        let samples = vec![0.25; PCM_WRITE_BUFFER_BYTES / 2 + 3];
        let expected_size = WAV_HEADER_BYTES + (samples.len() as u64 * 2);
        let mut writer = Pcm16WavWriter::create(&path, expected_size).unwrap();
        writer.append(&samples).unwrap();
        let info = writer.finish().unwrap();
        assert_eq!(info.total_samples, samples.len());
        assert_eq!(info.size_bytes, expected_size);
        assert_eq!(fs::metadata(&path).unwrap().len(), expected_size);
        let _ = fs::remove_file(path);
    }
}
