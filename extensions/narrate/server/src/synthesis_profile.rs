use std::path::{Path, PathBuf};

use std::collections::HashMap;

use remux_tts::BATCH_TASK_VERSION;
use serde_json::{Value, json};

const MODEL_MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../narration/model-manifest.json"
));

#[derive(Clone, Debug)]
pub(crate) struct NarrationSynthesisProfile {
    pub(crate) descriptor: Value,
    pub(crate) model_assets: HashMap<String, String>,
    pub(crate) model_dir: PathBuf,
}

impl NarrationSynthesisProfile {
    pub(crate) fn assets_ready(&self) -> bool {
        if self
            .model_assets
            .keys()
            .any(|name| !self.model_dir.join(name).is_file())
        {
            return false;
        }
        let runtime_manifest = std::fs::read(self.model_dir.join("asset-manifest.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        runtime_manifest
            .as_ref()
            .and_then(|manifest| manifest.get("assets"))
            == serde_json::to_value(&self.model_assets).ok().as_ref()
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
    let assets: HashMap<String, String> = serde_json::from_value(
        manifest
            .get("assets")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| "narration model manifest is missing assets".to_string())?,
    )
    .map_err(|error| format!("invalid narration model assets: {error}"))?;
    let asset_version = string("assetVersion")?;
    let descriptor = json!({
        "provider": "onnxruntime-rust",
        "model": string("model")?,
        "modelRevision": string("modelRevision")?,
        "modelAssetSha256": assets.get("model.onnx").cloned().map(Value::from).unwrap_or(Value::Null),
        "voice": string("voice")?,
        "voiceAssetSha256": assets.get("af_heart.npy").cloned().map(Value::from).unwrap_or(Value::Null),
        "vocabAssetSha256": assets.get("vocab.json").cloned().map(Value::from).unwrap_or(Value::Null),
        "exportVersion": manifest.get("exportVersion").cloned().unwrap_or(Value::Null),
        "onnxOpset": manifest.get("onnxOpset").cloned().unwrap_or(Value::Null),
        "onnxRuntimeVersion": string("onnxRuntimeVersion")?,
        "frontend": "misaki-rs-0.3.0-us-no-default-features",
        "precision": string("precision")?,
        "sampleRate": manifest.get("sampleRate").cloned().unwrap_or(Value::Null),
        "optionsVersion": "3-direct-phoneme-audit",
        "execution": "remux-compute-reviewed-batch-artifact",
        "taskVersion": BATCH_TASK_VERSION,
        "workerProtocolVersion": 3,
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
            "3-direct-phoneme-audit"
        );
        assert_eq!(profile.descriptor["taskVersion"], BATCH_TASK_VERSION);
        assert_eq!(profile.descriptor["workerProtocolVersion"], 3);
        assert!(profile.descriptor["modelAssetSha256"].as_str().is_some());
    }
}
