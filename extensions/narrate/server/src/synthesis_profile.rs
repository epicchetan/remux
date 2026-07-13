use std::path::{Path, PathBuf};

use remux_tts::TASK_VERSION;
use serde_json::{Value, json};

const MODEL_MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../narration/model-manifest.json"
));

#[derive(Clone, Debug)]
pub(crate) struct NarrationSynthesisProfile {
    pub(crate) descriptor: Value,
    pub(crate) model_assets: Value,
    pub(crate) model_dir: PathBuf,
}

impl NarrationSynthesisProfile {
    pub(crate) fn assets_ready(&self) -> bool {
        if self.model_assets.as_object().is_none_or(|assets| {
            assets
                .keys()
                .any(|name| !self.model_dir.join(name).is_file())
        }) {
            return false;
        }
        let runtime_manifest = std::fs::read(self.model_dir.join("asset-manifest.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        runtime_manifest
            .as_ref()
            .and_then(|manifest| manifest.get("assets"))
            == Some(&self.model_assets)
    }
}

pub(crate) fn resolve_synthesis_profile(
    remux_root: &Path,
    codex_home: &Path,
) -> Result<NarrationSynthesisProfile, String> {
    let manifest: Value = serde_json::from_str(MODEL_MANIFEST)
        .map_err(|error| format!("invalid bundled narration model manifest: {error}"))?;
    let string = |field: &str| -> Result<&str, String> {
        manifest
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("narration model manifest is missing {field}"))
    };
    let assets = manifest
        .get("assets")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| "narration model manifest is missing assets".to_string())?;
    let asset_version = string("assetVersion")?;
    let descriptor = json!({
        "provider": "onnxruntime-rust",
        "model": string("model")?,
        "modelRevision": string("modelRevision")?,
        "modelAssetSha256": assets.get("model.onnx").cloned().unwrap_or(Value::Null),
        "voice": string("voice")?,
        "voiceAssetSha256": assets.get("af_heart.npy").cloned().unwrap_or(Value::Null),
        "vocabAssetSha256": assets.get("vocab.json").cloned().unwrap_or(Value::Null),
        "exportVersion": manifest.get("exportVersion").cloned().unwrap_or(Value::Null),
        "onnxOpset": manifest.get("onnxOpset").cloned().unwrap_or(Value::Null),
        "onnxRuntimeVersion": string("onnxRuntimeVersion")?,
        "frontend": "remux-english-v1+misaki-rs@0.3.0-us-no-fallback",
        "precision": string("precision")?,
        "sampleRate": manifest.get("sampleRate").cloned().unwrap_or(Value::Null),
        "optionsVersion": "6-progressive-segments",
        "execution": "remux-compute-shared-session-unit-parallel",
        "taskVersion": TASK_VERSION,
        "workerProtocolVersion": 4,
    });
    let primary = remux_root
        .join(".remux")
        .join("models")
        .join("narrate")
        .join(asset_version);
    let legacy = codex_home
        .join("remux")
        .join("narration")
        .join("models")
        .join(asset_version);
    let model_dir = if primary.is_dir() { primary } else { legacy };
    Ok(NarrationSynthesisProfile {
        descriptor,
        model_assets: assets,
        model_dir,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_profile_has_complete_cache_identity() {
        let profile =
            resolve_synthesis_profile(Path::new("/tmp/remux-root"), Path::new("/tmp/codex-home"))
                .unwrap();
        assert_eq!(profile.descriptor["provider"], "onnxruntime-rust");
        assert_eq!(
            profile.descriptor["optionsVersion"],
            "6-progressive-segments"
        );
        assert_eq!(profile.descriptor["taskVersion"], TASK_VERSION);
        assert_eq!(profile.descriptor["workerProtocolVersion"], 4);
        assert!(profile.descriptor["modelAssetSha256"].as_str().is_some());
    }
}
