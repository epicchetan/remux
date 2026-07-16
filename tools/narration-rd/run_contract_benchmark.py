#!/usr/bin/env python3
"""Replay real thread responses against current-v4 and split scalar contracts.

This is an R&D harness only. It writes the exact source, compact request, streamed response,
validation, and timings under the requested result directory.
"""

from __future__ import annotations

import argparse
import glob
import json
import queue
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from run_app_server_experiment import AppServer, ROOT, completed_group_count


WORD_RE = re.compile(r"[^\W_]+(?:['’._-][^\W_]+)*", re.UNICODE)
LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
INLINE_CODE_RE = re.compile(r"`([^`]+)`")
ZERO_WIDTH = str.maketrans("", "", "\u200b\u200c\u200d\ufeff")
HOMOGRAPHS = {"close", "lead", "object", "project", "read", "record", "refuse", "use"}


@dataclass
class SourceWord:
    id: int
    block: int
    text: str
    hint: Any | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--contract", choices=["current-v4", "split-v5"], required=True)
    parser.add_argument("--session", type=Path, required=True)
    parser.add_argument("--message-index", type=int, required=True)
    parser.add_argument("--fixture-name", required=True)
    parser.add_argument("--result-dir", type=Path, required=True)
    parser.add_argument("--service-tier", choices=["standard", "priority"], default="priority")
    parser.add_argument("--timeout", type=float, default=240.0)
    return parser.parse_args()


def assistant_messages(path: Path) -> list[str]:
    output: list[str] = []
    with path.open() as handle:
        for line in handle:
            value = json.loads(line)
            if value.get("type") != "response_item":
                continue
            payload = value.get("payload", {})
            if payload.get("type") != "message" or payload.get("role") != "assistant":
                continue
            parts = payload.get("content")
            if not isinstance(parts, list):
                continue
            text = "\n".join(
                part.get("text", "")
                for part in parts
                if part.get("type") == "output_text"
            )
            if text:
                output.append(text)
    return output


def display_inline(value: str) -> str:
    value = LINK_RE.sub(lambda match: match.group(1), value)
    value = INLINE_CODE_RE.sub(lambda match: match.group(1), value)
    value = value.replace("**", "").replace("__", "")
    return value.strip()


def markdown_blocks(markdown: str) -> list[dict[str, str]]:
    blocks: list[dict[str, str]] = []
    paragraph: list[str] = []
    code: list[str] = []
    in_code = False

    def flush_paragraph() -> None:
        if paragraph:
            text = display_inline(" ".join(line.strip() for line in paragraph))
            if text:
                blocks.append({"kind": "paragraph", "mode": "normalized", "text": text})
            paragraph.clear()

    def flush_code() -> None:
        if code:
            blocks.append({"kind": "code", "mode": "summary", "text": "\n".join(code)})
            code.clear()

    for raw in markdown.splitlines():
        line = raw.rstrip()
        if line.lstrip().startswith("```"):
            if in_code:
                flush_code()
                in_code = False
            else:
                flush_paragraph()
                in_code = True
            continue
        if in_code:
            code.append(line)
            continue
        if not line.strip():
            flush_paragraph()
            continue
        heading = re.match(r"^#{1,6}\s+(.*)$", line)
        if heading:
            flush_paragraph()
            blocks.append({"kind": "heading", "mode": "normalized", "text": display_inline(heading.group(1))})
            continue
        listed = re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$", line)
        if listed:
            flush_paragraph()
            blocks.append({"kind": "listItem", "mode": "normalized", "text": display_inline(listed.group(1))})
            continue
        quoted = re.match(r"^\s*>\s?(.*)$", line)
        if quoted:
            flush_paragraph()
            blocks.append({"kind": "blockquote", "mode": "normalized", "text": display_inline(quoted.group(1))})
            continue
        paragraph.append(line)
    if in_code:
        flush_code()
    flush_paragraph()
    return blocks


def load_lexicon() -> tuple[dict[str, Any], dict[str, Any]]:
    matches = glob.glob(str(Path.home() / ".cargo/registry/src/*/misaki-rs-0.3.0/data"))
    if not matches:
        raise RuntimeError("misaki-rs 0.3.0 corpus is not installed")
    directory = Path(matches[0])
    return (
        json.loads((directory / "us_gold.json").read_text()),
        json.loads((directory / "us_silver.json").read_text()),
    )


def lookup_entry(word: str, gold: dict[str, Any], silver: dict[str, Any]) -> Any | None:
    apostrophe = word.replace("’", "'")
    lower = apostrophe.lower()
    candidates = []
    for candidate in (word, apostrophe, lower, lower[:1].upper() + lower[1:]):
        if candidate not in candidates:
            candidates.append(candidate)
    for corpus in (gold, silver):
        for candidate in candidates:
            if candidate in corpus:
                return corpus[candidate]
    return None


def simple_phonemes(entry: Any | None) -> str | None:
    if isinstance(entry, str):
        return entry.translate(ZERO_WIDTH)
    if isinstance(entry, dict):
        values = {value.translate(ZERO_WIDTH) for value in entry.values() if isinstance(value, str) and value}
        if len(values) == 1:
            return next(iter(values))
    return None


def resolve_simple(word: str, gold: dict[str, Any], silver: dict[str, Any]) -> str | None:
    direct = simple_phonemes(lookup_entry(word, gold, silver))
    if direct is not None:
        return direct
    if "-" not in word and "_" not in word:
        return None
    parts = re.split(r"[-_]", word)
    if not parts or any(not part for part in parts):
        return None
    resolved = [simple_phonemes(lookup_entry(part, gold, silver)) for part in parts]
    return "".join(resolved) if all(value is not None for value in resolved) else None


def prepare_compact(blocks: list[dict[str, str]]) -> tuple[str, list[SourceWord]]:
    gold, silver = load_lexicon()
    source_words: list[SourceWord] = []
    compact_blocks: list[dict[str, Any]] = []
    kinds = {"heading": "h", "paragraph": "p", "listItem": "li", "blockquote": "q", "code": "c"}
    for block_index, block in enumerate(blocks):
        words = []
        for match in WORD_RE.finditer(block["text"]):
            entry = lookup_entry(match.group(0), gold, silver)
            word = {"i": len(source_words), "x": match.group(0)}
            if entry is not None:
                hint = simple_phonemes(entry)
                word["h"] = hint if hint is not None else entry
            source_words.append(SourceWord(word["i"], block_index, word["x"], word.get("h")))
            words.append(word)
        compact_blocks.append({
            "i": block_index,
            "k": kinds[block["kind"]],
            "m": "s" if block["mode"] == "summary" else "n",
            "x": block["text"],
            "w": words,
        })
    return json.dumps({"v": 4, "b": compact_blocks}, separators=(",", ":"), ensure_ascii=False), source_words


def nth_span(haystack: str, needle: str, occurrence: int) -> tuple[int, int] | None:
    if not needle or occurrence < 0:
        return None
    start = -1
    cursor = 0
    for _ in range(occurrence + 1):
        start = haystack.find(needle, cursor)
        if start < 0:
            return None
        cursor = start + len(needle)
    return start, start + len(needle)


def covered_word_indices(text: str, start: int, end: int) -> list[int] | None:
    words = list(WORD_RE.finditer(text))
    covered = [index for index, word in enumerate(words) if word.start() >= start and word.end() <= end]
    if not covered or words[covered[0]].start() != start or words[covered[-1]].end() != end:
        return None
    return covered


def comparison_key(value: str) -> str:
    return value.replace("’", "'").lower()


def exact_source_matches(spoken: list[re.Match[str]], sources: list[SourceWord]) -> list[int | None]:
    rows, columns = len(spoken) + 1, len(sources) + 1
    lengths = [[0] * columns for _ in range(rows)]
    for i in range(len(spoken) - 1, -1, -1):
        for j in range(len(sources) - 1, -1, -1):
            if comparison_key(spoken[i].group(0)) == comparison_key(sources[j].text):
                lengths[i][j] = 1 + lengths[i + 1][j + 1]
            else:
                lengths[i][j] = max(lengths[i + 1][j], lengths[i][j + 1])
    output: list[int | None] = [None] * len(spoken)
    i = j = 0
    while i < len(spoken) and j < len(sources):
        if comparison_key(spoken[i].group(0)) == comparison_key(sources[j].text):
            output[i] = sources[j].id
            i += 1
            j += 1
        elif lengths[i + 1][j] >= lengths[i][j + 1]:
            i += 1
        else:
            j += 1
    return output


def ordered_unique(values: Any) -> bool:
    return isinstance(values, list) and all(isinstance(value, int) for value in values) and all(
        left < right for left, right in zip(values, values[1:])
    )


def validate_output(
    output: Any,
    contract: str,
    blocks: list[dict[str, str]],
    source_words: list[SourceWord],
    vocab: set[str],
) -> dict[str, Any]:
    structural: list[str] = []
    alignment: list[str] = []
    phoneme_errors: list[str] = []
    unresolved: list[dict[str, Any]] = []
    context: list[dict[str, Any]] = []
    technical: list[dict[str, Any]] = []
    gold, silver = load_lexicon()
    expected_version = 4 if contract == "current-v4" else 5
    if not isinstance(output, dict) or output.get("v") != expected_version or not isinstance(output.get("g"), list):
        return {"valid": False, "structuralErrors": ["invalid root"], "alignmentErrors": [], "phonemeErrors": []}
    covered_blocks: list[int] = []
    output_words = 0
    override_words = 0
    association_records = 0
    pronunciation_records = 0
    direct_mapped = 0
    associated_mapped = 0
    fallback_mapped = 0
    source_reference_count = 0
    referenced_sources: set[int] = set()
    all_source_ids = {word.id for word in source_words}
    next_block = 0

    for group_index, group in enumerate(output["g"]):
        if not isinstance(group, dict):
            structural.append(f"group {group_index}: not an object")
            continue
        if group.get("i") != group_index:
            structural.append(f"group {group_index}: id is {group.get('i')!r}")
        block_range = group.get("b")
        if not (
            isinstance(block_range, list) and len(block_range) == 2 and
            all(isinstance(value, int) for value in block_range) and
            0 <= block_range[0] <= block_range[1] < len(blocks)
        ):
            structural.append(f"group {group_index}: malformed block range {block_range!r}")
            continue
        if block_range[0] != next_block:
            structural.append(f"group {group_index}: block range starts at {block_range[0]}, expected {next_block}")
        next_block = block_range[1] + 1
        covered_blocks.extend(range(block_range[0], block_range[1] + 1))
        text = group.get("x")
        if not isinstance(text, str) or not text or text.strip() != text:
            structural.append(f"group {group_index}: invalid text")
            continue
        spoken = list(WORD_RE.finditer(text))
        output_words += len(spoken)
        owners = [-1] * len(spoken)
        overrides: dict[int, str] = {}
        associations = group.get("r") if contract == "current-v4" else group.get("a")
        pronunciations = [] if contract == "current-v4" else group.get("p")
        if not isinstance(associations, list) or not isinstance(pronunciations, list):
            structural.append(f"group {group_index}: record arrays are invalid")
            continue
        association_records += len(associations)
        pronunciation_records += sum(1 for record in associations if contract == "current-v4" and record.get("p") is not None)
        pronunciation_records += len(pronunciations)

        for record_index, record in enumerate(associations):
            label = f"group {group_index} association {record_index}"
            if not isinstance(record, dict):
                structural.append(f"{label}: not an object")
                continue
            source_ids, block_ids = record.get("s"), record.get("b")
            if not ordered_unique(source_ids) or not ordered_unique(block_ids):
                alignment.append(f"{label}: source ids are not ordered and unique")
                continue
            if not source_ids and not block_ids:
                alignment.append(f"{label}: no source identity")
            if any(value not in all_source_ids for value in source_ids):
                alignment.append(f"{label}: unknown source word")
            in_range_sources = [word for word in source_words if word.id in source_ids]
            if any(word.block < block_range[0] or word.block > block_range[1] for word in in_range_sources):
                alignment.append(f"{label}: source word outside group")
            if any(value < block_range[0] or value > block_range[1] for value in block_ids):
                alignment.append(f"{label}: source block outside group")
            source_reference_count += len(source_ids)
            referenced_sources.update(source_ids)
            span = nth_span(text, record.get("x", ""), record.get("n", -1))
            if span is None:
                structural.append(f"{label}: occurrence does not exist")
                continue
            covered = covered_word_indices(text, *span)
            if covered is None or len(covered) != len(list(WORD_RE.finditer(record["x"]))):
                structural.append(f"{label}: not word-boundary aligned")
                continue
            for word_index in covered:
                if owners[word_index] >= 0:
                    structural.append(f"{label}: overlaps association {owners[word_index]}")
                owners[word_index] = record_index
            if contract == "current-v4" and record.get("p") is not None:
                phonemes = record.get("p")
                if not isinstance(phonemes, list) or len(phonemes) != len(covered):
                    structural.append(
                        f"{label}: phoneme count {len(phonemes) if isinstance(phonemes, list) else 'non-array'} "
                        f"does not match {len(covered)} words"
                    )
                else:
                    for word_index, phoneme in zip(covered, phonemes):
                        if word_index in overrides:
                            structural.append(f"{label}: duplicate pronunciation")
                        overrides[word_index] = phoneme

        pronunciation_owners: set[int] = set()
        for record_index, record in enumerate(pronunciations):
            label = f"group {group_index} pronunciation {record_index}"
            if not isinstance(record, dict):
                structural.append(f"{label}: not an object")
                continue
            span = nth_span(text, record.get("x", ""), record.get("n", -1))
            if span is None:
                structural.append(f"{label}: occurrence does not exist")
                continue
            covered = covered_word_indices(text, *span)
            if covered is None:
                structural.append(f"{label}: not word-boundary aligned")
                continue
            if len(covered) != 1 or len(list(WORD_RE.finditer(record["x"]))) != 1:
                structural.append(f"{label}: must target exactly one server word, got {len(covered)}")
                continue
            word_index = covered[0]
            if word_index in pronunciation_owners:
                structural.append(f"{label}: duplicate pronunciation")
            pronunciation_owners.add(word_index)
            overrides[word_index] = record.get("p")

        source_slice = [word for word in source_words if block_range[0] <= word.block <= block_range[1]]
        exact = exact_source_matches(spoken, source_slice)
        summary_blocks = [
            index for index in range(block_range[0], block_range[1] + 1)
            if blocks[index]["mode"] == "summary"
        ]
        for word_index, word in enumerate(spoken):
            if exact[word_index] is not None:
                direct_mapped += 1
            elif owners[word_index] >= 0:
                associated_mapped += 1
            elif len(summary_blocks) == 1:
                fallback_mapped += 1
            else:
                alignment.append(f"group {group_index} word {word_index} {word.group(0)!r}: no source association")

            phoneme = overrides.get(word_index)
            origin = "override" if phoneme is not None else "corpus"
            if phoneme is None:
                phoneme = resolve_simple(word.group(0), gold, silver)
            else:
                override_words += 1
            if not isinstance(phoneme, str) or not phoneme.translate(ZERO_WIDTH).strip():
                unresolved.append({"group": group_index, "word": word_index, "text": word.group(0)})
                continue
            phoneme = phoneme.translate(ZERO_WIDTH)
            unsupported = sorted({character for character in phoneme if not character.isspace() and character not in vocab})
            if unsupported:
                phoneme_errors.append(f"group {group_index} word {word_index} {word.group(0)!r}: unsupported {unsupported}")
            lower = word.group(0).lower()
            observation = {
                "group": group_index,
                "word": word_index,
                "text": word.group(0),
                "context": " ".join(item.group(0) for item in spoken[max(0, word_index - 3):word_index + 4]),
                "phonemes": phoneme,
                "origin": origin,
            }
            if lower in HOMOGRAPHS:
                context.append(observation)
            if (
                any(character in word.group(0) for character in ".-_") or
                (len(word.group(0)) > 1 and word.group(0).isupper()) or
                resolve_simple(word.group(0), gold, silver) is None
            ):
                technical.append(observation)

    if covered_blocks != list(range(len(blocks))):
        structural.append(f"block coverage {covered_blocks!r} does not cover {len(blocks)} blocks")
    missing_unhinted = [
        word.id for word in source_words
        if word.hint is None and word.id not in referenced_sources
    ]
    return {
        "valid": not structural and not alignment and not phoneme_errors and not unresolved,
        "structuralValid": not structural,
        "alignmentValid": not alignment,
        "phonemeValid": not phoneme_errors and not unresolved,
        "structuralErrors": structural,
        "alignmentErrors": alignment,
        "phonemeErrors": phoneme_errors,
        "unresolvedWords": unresolved,
        "groups": len(output["g"]),
        "outputWords": output_words,
        "associationRecords": association_records,
        "pronunciationRecords": pronunciation_records,
        "overrideWords": override_words,
        "directMappedWords": direct_mapped,
        "associationMappedWords": associated_mapped,
        "summaryFallbackWords": fallback_mapped,
        "sourceReferenceCount": source_reference_count,
        "uniqueSourceReferences": len(referenced_sources),
        "unhintedSourceIdsNotReferenced": missing_unhinted,
        "contextObservations": context,
        "technicalObservations": technical,
    }


def main() -> int:
    options = parse_args()
    source = assistant_messages(options.session)[options.message_index]
    blocks = markdown_blocks(source)
    compact, source_words = prepare_compact(blocks)
    if options.contract == "current-v4":
        instructions_path = ROOT / "legacy-contract/primary-v4.txt"
        schema_path = ROOT / "legacy-contract/primary-v4.json"
    else:
        instructions_path = ROOT / "split-contract-instructions.txt"
        schema_path = ROOT / "split-contract-schema.json"
    instructions = instructions_path.read_text()
    schema = json.loads(schema_path.read_text())
    vocab_path = Path.home() / ".codex/remux/narration/models/kokoro-82m-onnx-duration-v1/vocab.json"
    vocab = set(json.loads(vocab_path.read_text()))
    result_path = options.result_dir / options.fixture_name / options.contract / f"{options.model}.json"
    artifact_dir = result_path.parent
    artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact_prefix = options.model
    (artifact_dir / f"{artifact_prefix}.source.md").write_text(source)
    (artifact_dir / f"{artifact_prefix}.blocks.json").write_text(
        json.dumps({"blocks": blocks}, indent=2, ensure_ascii=False) + "\n"
    )
    (artifact_dir / f"{artifact_prefix}.compact.json").write_text(
        json.dumps(json.loads(compact), indent=2, ensure_ascii=False) + "\n"
    )

    server = AppServer()
    delta_text = ""
    completed_text = None
    first_delta = None
    first_group = None
    group_times: list[float] = []
    delta_events = 0
    usage = None
    try:
        server.request("initialize", {
            "capabilities": {"experimentalApi": True},
            "clientInfo": {"name": "remux_contract_bench", "title": "Remux Contract Benchmark", "version": "0.1.0"},
        })
        server.send({"jsonrpc": "2.0", "method": "initialized"})
        thread = server.request("thread/start", {
            "model": options.model,
            "serviceTier": "priority" if options.service_tier == "priority" else None,
            "baseInstructions": instructions,
            "approvalPolicy": "never",
            "cwd": "/tmp",
            "config": {"features": {
                "shell_tool": False, "unified_exec": False, "code_mode": False,
                "standalone_web_search": False, "multi_agent": False, "multi_agent_v2": False,
                "apps": False, "enable_mcp_apps": False, "tool_suggest": False,
                "plugins": False, "remote_plugin": False, "image_generation": False,
            }, "web_search": "disabled", "skills": {"include_instructions": False, "bundled": {"enabled": False}}},
            "dynamicTools": [], "environments": [], "ephemeral": True,
            "experimentalRawEvents": False, "persistExtendedHistory": False,
            "sandbox": "read-only", "serviceName": "remux-narration-contract-bench",
        })
        thread_id = thread["thread"]["id"]
        turn = server.request("turn/start", {
            "threadId": thread_id,
            "serviceTier": "priority" if options.service_tier == "priority" else None,
            "effort": "low", "summary": "none",
            "input": [{"type": "text", "text": compact, "text_elements": []}],
            "outputSchema": schema,
        })
        turn_id = turn["turn"]["id"]
        deadline = time.monotonic() + options.timeout
        while time.monotonic() < deadline:
            try:
                at, event = server.events.get(timeout=0.25)
            except queue.Empty:
                continue
            method = event.get("method")
            params = event.get("params", {})
            if params.get("threadId") != thread_id:
                continue
            if method == "item/agentMessage/delta" and params.get("turnId") == turn_id:
                delta = params.get("delta", "")
                if delta and first_delta is None:
                    first_delta = at
                delta_text += delta
                delta_events += 1
                count = completed_group_count(delta_text)
                while len(group_times) < count:
                    group_times.append(at)
                if count and first_group is None:
                    first_group = at
            elif method == "item/completed" and params.get("turnId") == turn_id:
                item = params.get("item", {})
                if item.get("type") == "agentMessage":
                    completed_text = item.get("text")
            elif method == "turn/completed" and params.get("turn", {}).get("id") == turn_id:
                usage = params.get("turn", {}).get("usage") or params.get("usage")
                break
        else:
            raise TimeoutError("turn did not complete")
        final_text = completed_text or delta_text
        (artifact_dir / f"{artifact_prefix}.output.json.txt").write_text(final_text)
        (artifact_dir / f"{artifact_prefix}.deltas.txt").write_text(delta_text)
        parsed = json.loads(final_text)
        validation = validate_output(parsed, options.contract, blocks, source_words, vocab)
        result = {
            "fixture": options.fixture_name,
            "assistantMessageIndex": options.message_index,
            "sourceCharacters": len(source),
            "sourceBlocks": len(blocks),
            "sourceWords": len(source_words),
            "compactBytes": len(compact.encode()),
            "model": options.model,
            "contract": options.contract,
            "serviceTier": options.service_tier,
            "timing": {
                "firstDeltaSeconds": first_delta,
                "firstCompleteGroupSeconds": first_group,
                "completeGroupSeconds": group_times,
                "totalSeconds": time.monotonic() - server.started,
                "deltaEvents": delta_events,
            },
            "usage": usage,
            "outputBytes": len(final_text.encode()),
            "validation": validation,
            "output": parsed,
            "stderrTail": server.stderr[-20:],
        }
        result_path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps({
            "fixture": options.fixture_name,
            "model": options.model,
            "contract": options.contract,
            "timing": result["timing"],
            "outputBytes": result["outputBytes"],
            "validation": {key: validation.get(key) for key in (
                "valid", "structuralValid", "alignmentValid", "phonemeValid", "groups",
                "outputWords", "associationRecords", "pronunciationRecords", "overrideWords",
                "structuralErrors", "alignmentErrors", "phonemeErrors", "unresolvedWords",
            )},
        }, ensure_ascii=False))
        return 0 if validation["valid"] else 2
    except Exception as error:
        failure = {
            "fixture": options.fixture_name,
            "model": options.model,
            "contract": options.contract,
            "error": str(error),
            "partial": delta_text,
            "stderrTail": server.stderr[-50:],
        }
        result_path.write_text(json.dumps(failure, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(failure, ensure_ascii=False))
        return 1
    finally:
        server.close()


if __name__ == "__main__":
    raise SystemExit(main())
