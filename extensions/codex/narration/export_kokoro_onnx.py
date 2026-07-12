#!/usr/bin/env python3
"""Export the pinned Kokoro model with waveform and native duration outputs."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


DEFAULT_REPO = "hexgrad/Kokoro-82M"
DEFAULT_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
DEFAULT_VOICE = "af_heart"
EXPORT_VERSION = 1


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--repo-id", default=DEFAULT_REPO)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--opset", type=int, default=18)
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    import numpy as np
    import onnx
    import torch
    from huggingface_hub import hf_hub_download
    from kokoro import KModel
    from kokoro.model import KModelForONNX

    args.output_dir.mkdir(parents=True, exist_ok=True)
    config_path = Path(
        hf_hub_download(args.repo_id, "config.json", revision=args.revision)
    )
    checkpoint_path = Path(
        hf_hub_download(args.repo_id, "kokoro-v1_0.pth", revision=args.revision)
    )
    voice_source = Path(
        hf_hub_download(
            args.repo_id,
            f"voices/{args.voice}.pt",
            revision=args.revision,
        )
    )

    model = KModel(
        repo_id=args.repo_id,
        config=str(config_path),
        model=str(checkpoint_path),
        disable_complex=True,
    ).eval()
    wrapper = KModelForONNX(model).eval()
    voice = torch.load(voice_source, map_location="cpu", weights_only=True).float()

    with config_path.open("r", encoding="utf-8") as source:
        config = json.load(source)
    vocab_path = args.output_dir / "vocab.json"
    vocab_path.write_text(
        json.dumps(config["vocab"], ensure_ascii=False, sort_keys=True),
        encoding="utf-8",
    )
    voice_path = args.output_dir / f"{args.voice}.npy"
    np.save(voice_path, voice.numpy(), allow_pickle=False)

    # The actual values are unimportant; the token dimension is dynamic in the
    # exported graph and the reference style retains its fixed [1, 256] shape.
    sample_ids = torch.tensor([[0, 16, 43, 54, 0]], dtype=torch.long)
    sample_ref = voice[3]
    sample_speed = torch.tensor(1.0, dtype=torch.float32)
    model_path = args.output_dir / "model.onnx"
    torch.onnx.export(
        wrapper,
        (sample_ids, sample_ref, sample_speed),
        model_path,
        input_names=["input_ids", "ref_s", "speed"],
        output_names=["waveform", "duration"],
        opset_version=args.opset,
        dynamo=False,
        dynamic_axes={
            "input_ids": {1: "token_count"},
            "waveform": {0: "audio_samples"},
            "duration": {0: "token_count"},
        },
        external_data=False,
        do_constant_folding=True,
    )

    graph = onnx.load(model_path, load_external_data=True)
    onnx.checker.check_model(graph)
    output_names = [output.name for output in graph.graph.output]
    if output_names != ["waveform", "duration"]:
        raise RuntimeError(f"unexpected ONNX outputs: {output_names}")

    manifest = {
        "exportVersion": EXPORT_VERSION,
        "frontend": {
            "fallback": "none",
            "provider": "misaki-en",
            "spacyVersion": "3.8.14",
            "version": "0.9.4",
        },
        "model": args.repo_id,
        "modelRevision": args.revision,
        "onnxOpset": args.opset,
        "precision": "fp32",
        "sampleRate": 24_000,
        "source": {
            "checkpointSha256": sha256(checkpoint_path),
            "configSha256": sha256(config_path),
            "voiceSha256": sha256(voice_source),
        },
        "assets": {
            "model.onnx": sha256(model_path),
            f"{args.voice}.npy": sha256(voice_path),
            "vocab.json": sha256(vocab_path),
        },
        "voice": args.voice,
    }
    manifest_path = args.output_dir / "asset-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, sort_keys=True))


if __name__ == "__main__":
    main()
