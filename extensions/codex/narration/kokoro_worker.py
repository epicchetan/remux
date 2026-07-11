#!/usr/bin/env python3
"""Kokoro narration protocol v2 worker.

Reads one JSON request, writes bounded WAV chunks, and emits progress plus a
manifest containing provider-neutral units and renderer-owned alignment cues.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path


SAMPLE_RATE = 24_000
BLOCK_PAUSE_SECONDS = 0.08
TARGET_CHUNK_SECONDS = 50.0
PROTOCOL_VERSION = 2


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def fail(message: str) -> None:
    emit({"type": "error", "message": message})
    raise SystemExit(1)


try:
    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline
except Exception as error:  # pragma: no cover - exercised by server integration
    fail(
        "Kokoro runtime is unavailable. Configure REMUX_KOKORO_PYTHON with a "
        f"Python environment containing kokoro and soundfile. ({error})"
    )


def main() -> None:
    request_line = sys.stdin.readline()
    if not request_line.strip():
        fail("Kokoro worker received no request")
    try:
        request = json.loads(request_line)
    except json.JSONDecodeError as error:
        fail(f"Kokoro worker received invalid JSON: {error}")

    if request.get("protocolVersion") != PROTOCOL_VERSION:
        fail("Kokoro worker requires protocolVersion 2")
    if request.get("operation") != "synthesize":
        fail("Kokoro worker only supports the synthesize operation")
    requested_capabilities = request.get("capabilities")
    supported_capabilities = {
        "raw-token-timing",
        "spoken-character-offsets",
        "renderer-target-cues",
    }
    if not isinstance(requested_capabilities, list) or not set(requested_capabilities).issubset(supported_capabilities):
        fail("Kokoro worker received unsupported capabilities")
    artifact_key = required_string(request, "artifactKey")
    source_hash = required_string(request, "sourceHash")
    voice = required_string(request, "voice")
    output_dir = Path(required_string(request, "outputDir"))
    script = request.get("script")
    profile = request.get("profile")
    targets = request.get("targets")
    if not isinstance(script, dict) or not isinstance(script.get("units"), list) or not script["units"]:
        fail("Kokoro worker requires a non-empty v2 script")
    if not isinstance(profile, dict):
        fail("Kokoro worker requires a provider profile")
    if not isinstance(targets, list) or not targets:
        fail("Kokoro worker requires source targets")

    target_by_id = {
        target.get("id"): target
        for target in targets
        if isinstance(target, dict) and isinstance(target.get("id"), str)
    }
    audio_dir = output_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    try:
        pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device="cpu")
    except Exception as error:
        fail(f"Failed to load Kokoro: {error}")

    pause = np.zeros(round(SAMPLE_RATE * BLOCK_PAUSE_SECONDS), dtype=np.float32)
    chunks: list[dict] = []
    units: list[dict] = []
    cues: list[dict] = []
    raw_timing: list[dict] = []
    chunk_parts: list[np.ndarray] = []
    chunk_samples = 0
    total_samples = 0
    chunk_start_samples = 0

    def flush_chunk() -> None:
        nonlocal chunk_parts, chunk_samples, chunk_start_samples
        if not chunk_parts:
            return
        chunk_id = f"{len(chunks):03d}"
        waveform = np.concatenate(chunk_parts)
        path = audio_dir / f"{chunk_id}.wav"
        sf.write(path, waveform, SAMPLE_RATE, subtype="PCM_16")
        chunks.append(
            {
                "id": chunk_id,
                "start": chunk_start_samples / SAMPLE_RATE,
                "end": (chunk_start_samples + len(waveform)) / SAMPLE_RATE,
                "sampleRate": SAMPLE_RATE,
                "sizeBytes": path.stat().st_size,
            }
        )
        chunk_parts = []
        chunk_samples = 0
        chunk_start_samples = total_samples

    for index, script_unit in enumerate(script["units"]):
        if not isinstance(script_unit, dict):
            fail(f"Narration script unit {index} is invalid")
        unit_id = required_string(script_unit, "id")
        block_id = required_string(script_unit, "blockId")
        mode = required_string(script_unit, "mode")
        spoken_text = required_string(script_unit, "spokenText").strip()
        required_string(script_unit, "displayText")
        fallback_target_ids = valid_target_ids(
            script_unit.get("fallbackTargetIds"), target_by_id, unit_id
        )

        try:
            results = list(pipeline(spoken_text, voice=voice, speed=1.0))
        except Exception as error:
            fail(f"Kokoro failed on block {block_id}: {error}")
        result_audio = [
            result.audio.detach().cpu().numpy().astype(np.float32)
            for result in results
            if result.audio is not None
        ]
        if not result_audio:
            fail(f"Kokoro produced no audio for block {block_id}")
        unit_audio = np.concatenate(result_audio)

        if chunk_parts and (chunk_samples + len(unit_audio)) / SAMPLE_RATE > TARGET_CHUNK_SECONDS:
            flush_chunk()
        chunk_id = f"{len(chunks):03d}"
        unit_start_samples = total_samples
        unit_start = unit_start_samples / SAMPLE_RATE
        timed_tokens: list[dict] = []
        result_offset_samples = 0
        spoken_cursor = 0

        for result, audio in zip(results, result_audio):
            result_offset = (unit_start_samples + result_offset_samples) / SAMPLE_RATE
            for token in result.tokens or []:
                token_text = str(getattr(token, "text", "") or "")
                start_ts = getattr(token, "start_ts", None)
                end_ts = getattr(token, "end_ts", None)
                if start_ts is None or end_ts is None or not token_text.strip():
                    continue
                spoken_start_codepoint, spoken_end_codepoint, spoken_cursor = locate_text_span(
                    spoken_text, token_text, spoken_cursor
                )
                timed_tokens.append(
                    {
                        "text": token_text,
                        "spokenStart": utf16_offset(spoken_text, spoken_start_codepoint),
                        "spokenEnd": utf16_offset(spoken_text, spoken_end_codepoint),
                        "start": result_offset + float(start_ts),
                        "end": result_offset + float(end_ts),
                    }
                )
            result_offset_samples += len(audio)

        chunk_parts.append(unit_audio)
        chunk_samples += len(unit_audio)
        total_samples += len(unit_audio)
        unit_end = total_samples / SAMPLE_RATE
        previous_start = unit_start
        previous_end = unit_start
        for token in timed_tokens:
            token["start"] = max(
                previous_start,
                unit_start,
                min(unit_end, float(token["start"])),
            )
            token["end"] = max(
                token["start"],
                previous_end,
                min(unit_end, float(token["end"])),
            )
            previous_start = token["start"]
            previous_end = token["end"]
        chunk_parts.append(pause)
        chunk_samples += len(pause)
        total_samples += len(pause)

        unit_cues = build_cues(
            unit_id=unit_id,
            mode=mode,
            spoken_text=spoken_text,
            timed_tokens=timed_tokens,
            fallback_target_ids=fallback_target_ids,
            alignment_hints=script_unit.get("alignmentHints", []),
            target_by_id=target_by_id,
            unit_start=unit_start,
            unit_end=unit_end,
        )
        cues.extend(unit_cues)
        raw_timing.append({"unitId": unit_id, "tokens": timed_tokens})
        units.append(
            {
                "id": unit_id,
                "blockId": block_id,
                "chunkId": chunk_id,
                "end": unit_end,
                "fallbackTargetIds": fallback_target_ids,
                "mode": mode,
                "sentenceRanges": sentence_ranges(
                    timed_tokens, spoken_text, unit_start, unit_end
                ),
                "spokenText": spoken_text,
                "start": unit_start,
            }
        )
        emit({"type": "progress", "completed": index + 1, "total": len(script["units"])})

    flush_chunk()
    manifest = {
        "version": 2,
        "alignmentKey": required_string(request, "alignmentKey"),
        "artifactKey": artifact_key,
        "audioKey": required_string(request, "audioKey"),
        "chunks": chunks,
        "cues": cues,
        "durationSeconds": total_samples / SAMPLE_RATE,
        "profile": profile,
        "rawTiming": raw_timing,
        "scriptKey": required_string(request, "scriptKey"),
        "sourceDocumentKey": required_string(request, "sourceDocumentKey"),
        "sourceHash": source_hash,
        "targets": targets,
        "units": units,
    }
    emit({"type": "done", "manifest": manifest})


def build_cues(
    *,
    unit_id: str,
    mode: str,
    spoken_text: str,
    timed_tokens: list[dict],
    fallback_target_ids: list[str],
    alignment_hints: object,
    target_by_id: dict[str, dict],
    unit_start: float,
    unit_end: float,
) -> list[dict]:
    cues: list[dict] = []
    prepared_hints = prepare_alignment_hints(
        alignment_hints, spoken_text, target_by_id, unit_id, mode
    )
    last_non_fallback: tuple[list[str], str, str, float] | None = None
    for token_index, token in enumerate(timed_tokens):
        overlapping = [
            candidate
            for candidate in prepared_hints
            if candidate["spokenEnd"] > token["spokenStart"]
            and candidate["spokenStart"] < token["spokenEnd"]
        ]
        hint = min(
            overlapping,
            key=lambda candidate: (
                hint_target_precedence(candidate["targetIds"], target_by_id),
                candidate["spokenEnd"] - candidate["spokenStart"],
                candidate["order"],
            ),
            default=None,
        )
        if hint is not None:
            target_ids = hint["targetIds"]
            granularity = target_granularity(target_ids, target_by_id)
            origin = hint["origin"]
            confidence = 0.98 if origin == "sourceWord" else 0.9
            last_non_fallback = (target_ids, granularity, origin, confidence)
            cues.append(
                cue(
                    unit_id,
                    token_index,
                    token,
                    target_ids,
                    granularity,
                    origin,
                    confidence,
                )
            )
            continue

        if not token_contains_word(token["text"]) and last_non_fallback is not None:
            target_ids, granularity, origin, confidence = last_non_fallback
            cues.append(cue(unit_id, token_index, token, target_ids, granularity, origin, confidence))
        else:
            cues.append(
                cue(
                    unit_id,
                    token_index,
                    token,
                    fallback_target_ids,
                    target_granularity(fallback_target_ids, target_by_id),
                    "fallback",
                    0.45 if mode in {"verbatim", "normalized"} else 0.65,
                )
            )

    if not cues:
        cues.append(
            {
                "id": f"{unit_id}/cue/fallback",
                "unitId": unit_id,
                "start": unit_start,
                "end": unit_end,
                "spokenStart": 0,
                "spokenEnd": utf16_offset(spoken_text, len(spoken_text)),
                "targetIds": fallback_target_ids,
                "granularity": target_granularity(fallback_target_ids, target_by_id),
                "origin": "fallback",
                "confidence": 0.4,
            }
        )
    return cues


def prepare_alignment_hints(
    value: object,
    spoken_text: str,
    target_by_id: dict[str, dict],
    unit_id: str,
    mode: str,
) -> list[dict]:
    if not isinstance(value, list):
        fail(f"Narration script unit {unit_id} has invalid alignment hints")
    prepared: list[dict] = []
    cursor = 0
    for order, hint in enumerate(value):
        if not isinstance(hint, dict):
            fail(f"Narration script unit {unit_id} has an invalid alignment hint")
        hint_text = required_string(hint, "spokenText")
        start = spoken_text.find(hint_text, cursor)
        if start < 0:
            fail(f"Narration script unit {unit_id} has an unmatched alignment hint")
        end = start + len(hint_text)
        target_ids = valid_target_ids(hint.get("targetIds"), target_by_id, unit_id)
        origin = hint.get("origin")
        if origin not in {"sourceWord", "sourceSemantic", "summarySemantic"}:
            granularity = target_granularity(target_ids, target_by_id)
            origin = (
                "sourceWord"
                if granularity == "word"
                else "summarySemantic"
                if mode == "summary"
                else "sourceSemantic"
            )
        prepared.append(
            {
                "spokenStart": utf16_offset(spoken_text, start),
                "spokenEnd": utf16_offset(spoken_text, end),
                "targetIds": target_ids,
                "origin": origin,
                "order": order,
            }
        )
        cursor = end
    return prepared


def hint_target_precedence(target_ids: list[str], target_by_id: dict[str, dict]) -> int:
    granularity = target_granularity(target_ids, target_by_id)
    if granularity == "word":
        return 0
    if granularity == "expression":
        return 1
    if granularity in {"tableCell", "tableRegion", "codeLines", "diagramNode"}:
        return 2
    return 3


def token_contains_word(value: str) -> bool:
    return any(character.isalnum() for character in value)


def cue(
    unit_id: str,
    token_index: int,
    token: dict,
    target_ids: list[str],
    granularity: str,
    origin: str,
    confidence: float,
) -> dict:
    return {
        "id": f"{unit_id}/cue/{token_index}",
        "unitId": unit_id,
        "start": token["start"],
        "end": token["end"],
        "spokenStart": token["spokenStart"],
        "spokenEnd": token["spokenEnd"],
        "targetIds": target_ids,
        "granularity": granularity,
        "origin": origin,
        "confidence": confidence,
    }


def target_granularity(target_ids: list[str], target_by_id: dict[str, dict]) -> str:
    kinds = {target_by_id[target_id].get("kind") for target_id in target_ids if target_id in target_by_id}
    if "tableCell" in kinds:
        return "tableCell"
    if "tableRegion" in kinds:
        return "tableRegion"
    if "codeLines" in kinds:
        return "codeLines"
    if "diagramNode" in kinds:
        return "diagramNode"
    text_roles = {
        target_by_id[target_id].get("role")
        for target_id in target_ids
        if target_id in target_by_id and target_by_id[target_id].get("kind") == "textRange"
    }
    if text_roles:
        return "word" if text_roles == {"word"} else "expression"
    return "block"


def normalized_char_map(value: str) -> tuple[str, list[int]]:
    normalized: list[str] = []
    source_offsets: list[int] = []
    for source_index, character in enumerate(value):
        folded = unicodedata.normalize("NFKD", character).casefold()
        for candidate in folded:
            if candidate.isalnum():
                normalized.append(candidate)
                source_offsets.append(source_index)
    return "".join(normalized), source_offsets


def utf16_offset(value: str, codepoint_offset: int) -> int:
    return len(value[:codepoint_offset].encode("utf-16-le")) // 2


def locate_text_span(text: str, token: str, cursor: int) -> tuple[int, int, int]:
    direct = text.find(token, cursor)
    if direct >= 0:
        return direct, direct + len(token), direct + len(token)
    stripped = token.strip()
    direct = text.find(stripped, cursor) if stripped else -1
    if direct >= 0:
        return direct, direct + len(stripped), direct + len(stripped)
    normalized_text, source_map = normalized_char_map(text)
    normalized_token, _ = normalized_char_map(token)
    if normalized_token:
        normalized_cursor = next(
            (index for index, source_index in enumerate(source_map) if source_index >= cursor),
            len(source_map),
        )
        start = normalized_text.find(normalized_token, normalized_cursor)
        if start >= 0:
            end = start + len(normalized_token)
            source_start = source_map[start]
            source_end = source_map[end - 1] + 1
            return source_start, source_end, source_end
    safe_start = min(cursor, len(text))
    safe_end = min(len(text), safe_start + len(stripped))
    return safe_start, safe_end, safe_end


def sentence_ranges(tokens: list[dict], spoken_text: str, unit_start: float, unit_end: float) -> list[dict]:
    if not tokens:
        return [{"start": unit_start, "end": unit_end, "spokenStart": 0, "spokenEnd": utf16_offset(spoken_text, len(spoken_text))}]
    sentences: list[dict] = []
    first = 0
    for index, token in enumerate(tokens):
        if re.search(r"[.!?…][\"'”’)]*$", token["text"]):
            sentences.append(
                {
                    "start": tokens[first]["start"],
                    "end": token["end"],
                    "spokenStart": tokens[first]["spokenStart"],
                    "spokenEnd": token["spokenEnd"],
                }
            )
            first = index + 1
    if first < len(tokens):
        sentences.append(
            {
                "start": tokens[first]["start"],
                "end": tokens[-1]["end"],
                "spokenStart": tokens[first]["spokenStart"],
                "spokenEnd": tokens[-1]["spokenEnd"],
            }
        )
    return sentences


def valid_target_ids(value: object, target_by_id: dict[str, dict], unit_id: str) -> list[str]:
    if not isinstance(value, list) or not value:
        fail(f"Narration script unit {unit_id} has no fallback targets")
    target_ids = [target for target in value if isinstance(target, str) and target in target_by_id]
    if len(target_ids) != len(value):
        fail(f"Narration script unit {unit_id} references an unknown target")
    return target_ids


def required_string(payload: dict, key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        fail(f"Kokoro worker requires {key}")
    return value


if __name__ == "__main__":
    main()
