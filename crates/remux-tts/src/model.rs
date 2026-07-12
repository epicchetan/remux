use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::ptr::{self, NonNull};
use std::sync::Arc;

use ort::AsPointer;
use ort::session::Session;
use ort::value::{DynValue, Tensor};
use sha2::{Digest, Sha256};

pub struct KokoroModel {
    session: Arc<Session>,
    vocab: HashMap<char, i64>,
    voice: Arc<Vec<f32>>,
}

pub struct InferenceOutput {
    pub waveform: Vec<f32>,
    pub duration: Vec<i64>,
}

impl KokoroModel {
    pub fn load(
        model_dir: &Path,
        expected_assets: &HashMap<String, String>,
    ) -> Result<Self, String> {
        for name in ["model.onnx", "af_heart.npy", "vocab.json"] {
            let expected = expected_assets
                .get(name)
                .ok_or_else(|| format!("narration model manifest is missing {name}"))?;
            let path = model_dir.join(name);
            let actual = sha256(&path)?;
            if &actual != expected {
                return Err(format!("narration model asset failed verification: {name}"));
            }
        }
        let raw_vocab: HashMap<String, i64> = serde_json::from_slice(
            &fs::read(model_dir.join("vocab.json"))
                .map_err(|error| format!("failed to read narration vocabulary: {error}"))?,
        )
        .map_err(|error| format!("invalid narration vocabulary: {error}"))?;
        let mut vocab = HashMap::new();
        for (key, value) in raw_vocab {
            let mut characters = key.chars();
            let character = characters
                .next()
                .filter(|_| characters.next().is_none())
                .ok_or_else(|| "narration vocabulary contains a non-character key".to_string())?;
            vocab.insert(character, value);
        }
        let voice = read_voice(&model_dir.join("af_heart.npy"))?;
        let session = Session::builder()
            .map_err(|error| format!("failed to create ONNX session builder: {error}"))?
            .with_intra_threads(1)
            .map_err(|error| format!("failed to configure ONNX intra-op threads: {error}"))?
            .with_inter_threads(1)
            .map_err(|error| format!("failed to configure ONNX inter-op threads: {error}"))?
            .with_parallel_execution(false)
            .map_err(|error| format!("failed to configure ONNX execution: {error}"))?
            .with_memory_pattern(false)
            .map_err(|error| format!("failed to configure ONNX memory pattern: {error}"))?
            .commit_from_file(model_dir.join("model.onnx"))
            .map_err(|error| format!("failed to load Kokoro ONNX model: {error}"))?;
        Ok(Self {
            session: Arc::new(session),
            vocab,
            voice: Arc::new(voice),
        })
    }

    pub fn infer(&self, phonemes: &str) -> Result<InferenceOutput, String> {
        let mut token_ids = Vec::with_capacity(phonemes.chars().count() + 2);
        token_ids.push(0);
        for character in phonemes.chars() {
            if let Some(token) = self.vocab.get(&character) {
                token_ids.push(*token);
            }
        }
        token_ids.push(0);
        if token_ids.len() <= 2 || token_ids.len() > 512 {
            return Err(format!("invalid Kokoro token count: {}", token_ids.len()));
        }
        let voice_index = phonemes.chars().count().saturating_sub(1);
        if voice_index >= 510 {
            return Err("Kokoro voice index exceeds 510 phonemes".to_string());
        }
        let voice_start = voice_index * 256;
        let reference = self.voice[voice_start..voice_start + 256].to_vec();
        let input_ids = Tensor::from_array(([1, token_ids.len()], token_ids.into_boxed_slice()))
            .map_err(|error| format!("failed to create Kokoro token tensor: {error}"))?;
        let reference = Tensor::from_array(([1, 256], reference.into_boxed_slice()))
            .map_err(|error| format!("failed to create Kokoro reference tensor: {error}"))?;
        let speed = Tensor::from_array((Vec::<usize>::new(), vec![1.0_f32].into_boxed_slice()))
            .map_err(|error| format!("failed to create Kokoro speed tensor: {error}"))?;
        concurrent_run(
            &self.session,
            [input_ids.ptr(), reference.ptr(), speed.ptr()],
        )
    }

    pub fn retain_supported(&self, value: &mut String) {
        value.retain(|character| self.vocab.contains_key(&character));
    }
}

/// Invoke `OrtRun` through its C API so independent task threads can share one
/// session. ONNX Runtime documents concurrent `Run` calls as supported. The
/// safe `ort` wrapper currently takes `&mut Session` even though its own
/// implementation immediately calls an immutable inner method, which would
/// otherwise serialize this CPU workload behind a Rust mutex.
fn concurrent_run(
    session: &Session,
    input_ptrs: [*const ort_sys::OrtValue; 3],
) -> Result<InferenceOutput, String> {
    let input_names = [
        CString::new("input_ids").unwrap(),
        CString::new("ref_s").unwrap(),
        CString::new("speed").unwrap(),
    ];
    let output_names = [
        CString::new("waveform").unwrap(),
        CString::new("duration").unwrap(),
    ];
    let input_name_ptrs = input_names
        .iter()
        .map(|name| name.as_ptr())
        .collect::<Vec<_>>();
    let output_name_ptrs = output_names
        .iter()
        .map(|name| name.as_ptr())
        .collect::<Vec<_>>();
    let mut output_ptrs = [ptr::null_mut(); 2];
    let api = ort_api()?;
    // SAFETY: the session is held by `KokoroModel` for the whole call; every
    // input value and C string outlives `Run`; ONNX Runtime owns newly returned
    // outputs and explicitly permits concurrent Run calls on one session.
    let status = unsafe {
        (api.Run)(
            session.ptr().cast_mut(),
            ptr::null(),
            input_name_ptrs.as_ptr(),
            input_ptrs.as_ptr(),
            input_ptrs.len(),
            output_name_ptrs.as_ptr(),
            output_name_ptrs.len(),
            output_ptrs.as_mut_ptr(),
        )
    };
    status_result(api, status)?;
    let waveform_ptr = NonNull::new(output_ptrs[0])
        .ok_or_else(|| "ONNX returned no Kokoro waveform".to_string())?;
    let duration_ptr = NonNull::new(output_ptrs[1])
        .ok_or_else(|| "ONNX returned no Kokoro duration".to_string())?;
    // SAFETY: both pointers are fresh owned OrtValues returned by `Run`. The
    // session remains alive until after extraction and these wrappers drop.
    let waveform: DynValue = unsafe { DynValue::from_ptr(waveform_ptr, None) };
    let duration: DynValue = unsafe { DynValue::from_ptr(duration_ptr, None) };
    let waveform = waveform
        .try_extract_tensor::<f32>()
        .map_err(|error| format!("invalid Kokoro waveform output: {error}"))?
        .1
        .to_vec();
    let duration = duration
        .try_extract_tensor::<i64>()
        .map_err(|error| format!("invalid Kokoro duration output: {error}"))?
        .1
        .to_vec();
    if waveform.is_empty() {
        return Err("ONNX produced an empty Kokoro waveform".to_string());
    }
    Ok(InferenceOutput { waveform, duration })
}

fn ort_api() -> Result<&'static ort_sys::OrtApi, String> {
    // SAFETY: `OrtGetApiBase` and its API pointer are process-global values
    // owned by the linked ONNX Runtime for the process lifetime.
    unsafe {
        let base = ort_sys::OrtGetApiBase();
        if base.is_null() {
            return Err("ONNX Runtime API base is unavailable".to_string());
        }
        let api = ((*base).GetApi)(ort_sys::ORT_API_VERSION);
        api.as_ref()
            .ok_or_else(|| "ONNX Runtime API version is unavailable".to_string())
    }
}

fn status_result(api: &ort_sys::OrtApi, status: ort_sys::OrtStatusPtr) -> Result<(), String> {
    if status.0.is_null() {
        return Ok(());
    }
    // SAFETY: a non-null status came from this API call and remains valid until
    // released below. ONNX Runtime returns a null-terminated message.
    let message = unsafe {
        let pointer = (api.GetErrorMessage)(status.0);
        let message = if pointer.is_null() {
            "unknown ONNX Runtime error".to_string()
        } else {
            CStr::from_ptr(pointer).to_string_lossy().into_owned()
        };
        (api.ReleaseStatus)(status.0);
        message
    };
    Err(format!("Kokoro ONNX inference failed: {message}"))
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| {
        format!(
            "failed to read narration model asset {}: {error}",
            path.display()
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| {
            format!(
                "failed to read narration model asset {}: {error}",
                path.display()
            )
        })?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn read_voice(path: &Path) -> Result<Vec<f32>, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("failed to read Kokoro voice {}: {error}", path.display()))?;
    if bytes.len() < 12 || &bytes[..6] != b"\x93NUMPY" {
        return Err("Kokoro voice is not a NumPy array".to_string());
    }
    let major = bytes[6];
    let (header_start, header_length) = match major {
        1 => (10, u16::from_le_bytes([bytes[8], bytes[9]]) as usize),
        2 | 3 if bytes.len() >= 12 => (
            12,
            u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize,
        ),
        _ => return Err("unsupported Kokoro NumPy voice version".to_string()),
    };
    let data_start = header_start + header_length;
    let header = std::str::from_utf8(
        bytes
            .get(header_start..data_start)
            .ok_or_else(|| "truncated Kokoro NumPy voice header".to_string())?,
    )
    .map_err(|_| "Kokoro NumPy voice header is not UTF-8".to_string())?;
    if !header.contains("'<f4'") && !header.contains("\"<f4\"") {
        return Err("Kokoro voice must contain little-endian f32 values".to_string());
    }
    let data = bytes
        .get(data_start..)
        .ok_or_else(|| "truncated Kokoro voice data".to_string())?;
    if data.len() != 510 * 256 * 4 {
        return Err(format!(
            "Kokoro voice has unexpected byte length {}",
            data.len()
        ));
    }
    Ok(data
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires installed Kokoro model assets"]
    fn installed_model_runs_with_duration_output() {
        let directory = PathBuf::from(
            std::env::var("REMUX_TTS_MODEL_DIR").expect("REMUX_TTS_MODEL_DIR is required"),
        );
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join("asset-manifest.json")).unwrap())
                .unwrap();
        let assets = serde_json::from_value(manifest["assets"].clone()).unwrap();
        let model = KokoroModel::load(&directory, &assets).unwrap();
        let output = model.infer("həlˈO wˈɜɹld").unwrap();
        assert!(!output.waveform.is_empty());
        assert!(output.duration.len() > 2);
    }
}
