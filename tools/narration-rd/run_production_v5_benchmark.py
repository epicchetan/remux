#!/usr/bin/env python3
"""Replay a real assistant response through the production v5 linguistic contract.

This is a live R&D/acceptance harness. It mirrors server-owned group/unit identity,
pronunciation-risk metadata, token-local phonemes, corpus compatibility, and block provenance.
It does not synthesize audio or reproduce renderer semantic ranges.
"""

from __future__ import annotations

import argparse
import json
import queue
import time
from pathlib import Path
from typing import Any

from run_app_server_experiment import AppServer, ROOT, completed_group_count
from run_contract_benchmark import (
    WORD_RE,
    SourceWord,
    assistant_messages,
    exact_source_matches,
    load_lexicon,
    lookup_entry,
    markdown_blocks,
    ordered_unique,
    simple_phonemes,
)


KNOWN_HETERONYMS = {
    "abstract", "abuse", "address", "advocate", "alternate", "attribute", "bass", "bow",
    "close", "combine", "compact", "compound", "conduct", "conflict", "console", "content",
    "contract", "contrast", "convert", "coordinate", "default", "desert", "digest", "does",
    "dove", "duplicate", "entrance", "estimate", "excuse", "exploit", "export", "extract",
    "house", "impact", "import", "incline", "insert", "insult", "invalid", "lead", "live",
    "minute", "moderate", "object", "permit", "present", "produce", "project", "read",
    "record", "refuse", "reject", "resume", "row", "separate", "subject", "survey", "tear",
    "use", "wind", "wound",
}


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", type=Path, required=True)
    parser.add_argument("--message-index", type=int, required=True)
    parser.add_argument("--fixture-name", required=True)
    parser.add_argument("--result-dir", type=Path, required=True)
    parser.add_argument("--model", default="gpt-5.6-sol")
    parser.add_argument("--timeout", type=float, default=840.0)
    return parser.parse_args()


def normalize(phonemes: str) -> str:
    return (
        phonemes.replace("\u200b", "").replace("\u200c", "").replace("\u200d", "")
        .replace("\ufeff", "").replace("n\u0329", "ᵊn")
    )


def supported(phonemes: str, vocab: set[str]) -> bool:
    return bool(phonemes.strip()) and all(char.isspace() or char in vocab for char in phonemes)


def lookup(word: str, gold: dict[str, Any], silver: dict[str, Any]) -> Any | None:
    return lookup_entry(word, gold, silver)


def possessive_suffix(phonemes: str) -> str:
    final = next((char for char in reversed(phonemes) if char.isalpha()), "")
    if final in "szʃʒʧʤ":
        return "ᵻz"
    if final in "ptkfθ":
        return "s"
    return "z"


def resolve(word: str, gold: dict[str, Any], silver: dict[str, Any]) -> str | None:
    direct = simple_phonemes(lookup(word, gold, silver))
    if direct is not None:
        return normalize(direct)
    normalized = word.replace("’", "'").replace("‘", "'")
    if normalized.lower().endswith("'s"):
        base = resolve(normalized[:-2], gold, silver)
        if base:
            return base + possessive_suffix(base)
    if "-" not in word and "_" not in word:
        return None
    parts = word.replace("_", "-").split("-")
    values = [resolve(part, gold, silver) for part in parts]
    return "".join(values) if parts and all(values) else None


def initialism(word: str) -> bool:
    letters = [char for char in word if char.isalpha()]
    return len(letters) >= 2 and all(char.isupper() for char in letters)


def group_blocks(compact_blocks: list[dict[str, Any]]) -> list[list[int]]:
    groups: list[list[int]] = []
    current: list[int] = []
    current_words = 0
    for block in compact_blocks:
        count = max(1, len(block["w"]))
        summary = block["m"] == "s"
        budget = 45 if not groups else 72
        heading_only = len(current) == 1 and compact_blocks[current[0]]["k"] == "h"
        if summary and current and not heading_only:
            groups.append(current)
            current, current_words = [], 0
        elif not summary and current and current_words + count > budget:
            groups.append(current)
            current, current_words = [], 0
        elif block["k"] == "h" and current_words >= budget // 2:
            groups.append(current)
            current, current_words = [], 0
        current.append(block["i"])
        current_words += count
        if summary:
            groups.append(current)
            current, current_words = [], 0
    if current:
        groups.append(current)
    return groups


def prepare(
    blocks: list[dict[str, str]], vocab: set[str]
) -> tuple[str, list[SourceWord], list[list[int]], dict[int, set[str]]]:
    gold, silver = load_lexicon()
    source_words: list[SourceWord] = []
    compact_blocks: list[dict[str, Any]] = []
    risks: dict[int, set[str]] = {}
    kinds = {"heading": "h", "paragraph": "p", "listItem": "li", "blockquote": "q", "code": "c"}
    for block_id, block in enumerate(blocks):
        words: list[dict[str, Any]] = []
        for match in WORD_RE.finditer(block["text"]):
            text = match.group(0)
            entry = lookup(text, gold, silver)
            resolution = resolve(text, gold, silver)
            labels: set[str] = set()
            if resolution is None:
                labels.add("oov")
            if isinstance(entry, dict):
                labels.add("ambiguous")
            if text.lower().replace("’", "'") in KNOWN_HETERONYMS:
                labels.add("context")
            if initialism(text):
                labels.add("initialism")
            hint: Any | None = None
            if entry is not None:
                simple = simple_phonemes(entry)
                hint = normalize(simple) if simple is not None else {
                    key: normalize(value) if isinstance(value, str) else value
                    for key, value in entry.items()
                }
                values = [hint] if isinstance(hint, str) else [value for value in hint.values() if value]
                if any(not supported(value, vocab) for value in values):
                    labels.add("unsupported")
                    hint = None
            word_id = len(source_words)
            word: dict[str, Any] = {"i": word_id, "x": text}
            if hint is not None:
                word["h"] = hint
            if labels:
                word["q"] = sorted(labels)
            risks[word_id] = labels
            source_words.append(SourceWord(word_id, block_id, text, hint))
            words.append(word)
        compact_blocks.append({
            "i": block_id,
            "k": kinds[block["kind"]],
            "m": "s" if block["mode"] == "summary" else "n",
            "x": block["text"],
            "w": words,
            "r": [],
        })
    plans = group_blocks(compact_blocks)
    compact = {
        "v": 5,
        "g": [
            {"i": group_id, "u": [compact_blocks[block_id] for block_id in block_ids]}
            for group_id, block_ids in enumerate(plans)
        ],
    }
    return json.dumps(compact, separators=(",", ":"), ensure_ascii=False), source_words, plans, risks


def validate(
    output: Any,
    _blocks: list[dict[str, str]],
    source_words: list[SourceWord],
    plans: list[list[int]],
    _risks: dict[int, set[str]],
    vocab: set[str],
) -> dict[str, Any]:
    errors: list[str] = []
    observations: list[dict[str, Any]] = []
    gold, silver = load_lexicon()
    if not isinstance(output, dict) or output.get("v") != 5 or not isinstance(output.get("g"), list):
        return {"valid": False, "errors": ["invalid root"]}
    if len(output["g"]) != len(plans):
        errors.append(f"group count {len(output['g'])} != plan {len(plans)}")
    for group_id, plan in enumerate(plans):
        if group_id >= len(output["g"]):
            break
        group = output["g"][group_id]
        if not isinstance(group, dict) or group.get("i") != group_id or not isinstance(group.get("u"), list):
            errors.append(f"group {group_id}: invalid identity")
            continue
        if len(group["u"]) != len(plan):
            errors.append(f"group {group_id}: unit count {len(group['u'])} != {len(plan)}")
        group_phoneme_count = 0
        for offset, block_id in enumerate(plan):
            if offset >= len(group["u"]):
                break
            unit = group["u"][offset]
            label = f"group {group_id} block {block_id}"
            if not isinstance(unit, dict) or unit.get("i") != block_id:
                errors.append(f"{label}: invalid unit identity")
                continue
            tokens = unit.get("t")
            if not isinstance(tokens, list) or not tokens:
                errors.append(f"{label}: invalid token array")
                continue
            source_ids = {word.id for word in source_words if word.block == block_id}
            text = ""
            expected_spans: list[tuple[int, int, str]] = []
            token_sources: list[set[int]] = []
            token_phonemes: list[str] = []
            for token_id, token in enumerate(tokens):
                token_label = f"{label} token {token_id}"
                if not isinstance(token, dict):
                    errors.append(f"{token_label}: invalid object")
                    continue
                word, phonemes, sources, separator = (
                    token.get("x"), token.get("p"), token.get("s"), token.get("z")
                )
                if not isinstance(word, str) or WORD_RE.fullmatch(word) is None:
                    errors.append(f"{token_label}: x is not one tokenizer word")
                    continue
                if not ordered_unique(sources):
                    errors.append(f"{token_label}: source ids are not ordered and unique")
                    sources = []
                if any(source not in source_ids for source in sources):
                    errors.append(f"{token_label}: source outside unit")
                phonemes = normalize(phonemes) if isinstance(phonemes, str) else ""
                if any(char.isspace() for char in phonemes) or not supported(phonemes, vocab):
                    errors.append(f"{token_label}: invalid phonemes {phonemes!r}")
                if not isinstance(separator, str) or len(separator.encode()) > 16 or any(
                    char not in " ;:,.!?—…" for char in separator
                ):
                    errors.append(f"{token_label}: invalid separator")
                    separator = ""
                if token_id + 1 == len(tokens) and separator.endswith(" "):
                    errors.append(f"{token_label}: trailing whitespace")
                start = len(text)
                text += word
                expected_spans.append((start, len(text), word))
                text += separator
                token_sources.append(set(sources))
                token_phonemes.append(phonemes)
                group_phoneme_count += len(phonemes) + sum(
                    char in ";:,.!?—…" for char in separator
                )
            if text.strip() != text:
                errors.append(f"{label}: reconstructed text is padded")
            spoken = list(WORD_RE.finditer(text))
            if len(spoken) != len(expected_spans) or any(
                (match.start(), match.end(), match.group(0)) != expected
                for match, expected in zip(spoken, expected_spans)
            ):
                errors.append(f"{label}: separators changed token boundaries")
                continue
            if len(token_sources) != len(spoken) or len(token_phonemes) != len(spoken):
                errors.append(f"{label}: invalid token cardinality")
                continue
            source_slice = [word for word in source_words if word.block == block_id]
            exact = exact_source_matches(spoken, source_slice)
            for index, word in enumerate(spoken):
                phonemes = token_phonemes[index]
                corpus_phonemes = resolve(word.group(0), gold, silver)
                observations.append({
                    "group": group_id,
                    "block": block_id,
                    "word": word.group(0),
                    "phonemes": phonemes,
                    "origin": "corpus" if corpus_phonemes == phonemes else "model",
                    "mapping": "exact" if exact[index] is not None else (
                        "tokenSource" if token_sources[index] else "blockFallback"
                    ),
                })
        if group_phoneme_count > 500:
            errors.append(f"group {group_id}: {group_phoneme_count} phoneme symbols exceeds 500")
    return {"valid": not errors, "errors": errors, "observations": observations}


def main() -> int:
    options = args()
    source = assistant_messages(options.session)[options.message_index]
    blocks = markdown_blocks(source)
    vocab_path = Path.home() / ".codex/remux/narration/models/kokoro-82m-onnx-duration-v1/vocab.json"
    vocab = set(json.loads(vocab_path.read_text()))
    compact, source_words, plans, risks = prepare(blocks, vocab)
    instructions = (Path("extensions/narrate/server/prompts/primary-v5.txt")).read_text()
    schema = json.loads(Path("extensions/narrate/server/schemas/primary-v5.json").read_text())
    output_dir = options.result_dir / options.fixture_name / "production-v5" / options.model
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "source.md").write_text(source)
    (output_dir / "compact.json").write_text(json.dumps(json.loads(compact), indent=2, ensure_ascii=False) + "\n")

    server = AppServer()
    delta_text = ""
    completed_text: str | None = None
    first_delta: float | None = None
    first_group: float | None = None
    group_times: list[float] = []
    try:
        server.request("initialize", {
            "capabilities": {"experimentalApi": True},
            "clientInfo": {"name": "remux_v5_bench", "title": "Remux v5 Benchmark", "version": "0.1.0"},
        })
        server.send({"jsonrpc": "2.0", "method": "initialized"})
        thread = server.request("thread/start", {
            "model": options.model, "serviceTier": "priority", "baseInstructions": instructions,
            "approvalPolicy": "never", "cwd": "/tmp", "dynamicTools": [], "environments": [],
            "ephemeral": True, "persistExtendedHistory": False, "sandbox": "read-only",
            "serviceName": "remux-narration-v5-bench",
            "config": {"features": {"shell_tool": False, "unified_exec": False, "code_mode": False,
                "standalone_web_search": False, "multi_agent": False, "multi_agent_v2": False,
                "apps": False, "enable_mcp_apps": False, "tool_suggest": False, "plugins": False,
                "remote_plugin": False, "image_generation": False}, "web_search": "disabled",
                "skills": {"include_instructions": False, "bundled": {"enabled": False}}},
        })
        thread_id = thread["thread"]["id"]
        turn = server.request("turn/start", {
            "threadId": thread_id, "serviceTier": "priority", "effort": "low", "summary": "none",
            "input": [{"type": "text", "text": compact, "text_elements": []}], "outputSchema": schema,
        })
        turn_id = turn["turn"]["id"]
        deadline = time.monotonic() + options.timeout
        while time.monotonic() < deadline:
            try:
                at, event = server.events.get(timeout=0.25)
            except queue.Empty:
                continue
            method, params = event.get("method"), event.get("params", {})
            if params.get("threadId") != thread_id:
                continue
            if method == "item/agentMessage/delta" and params.get("turnId") == turn_id:
                delta = params.get("delta", "")
                if delta and first_delta is None:
                    first_delta = at
                delta_text += delta
                count = completed_group_count(delta_text)
                while len(group_times) < count:
                    group_times.append(at)
                    print(json.dumps({
                        "event": "groupComplete",
                        "group": len(group_times) - 1,
                        "seconds": at,
                    }), flush=True)
                if count and first_group is None:
                    first_group = at
            elif method == "item/completed" and params.get("turnId") == turn_id:
                item = params.get("item", {})
                if item.get("type") == "agentMessage":
                    completed_text = item.get("text")
            elif method == "turn/completed" and params.get("turn", {}).get("id") == turn_id:
                break
        else:
            raise TimeoutError("turn did not complete")
        final_text = completed_text or delta_text
        parsed = json.loads(final_text)
        validation = validate(parsed, blocks, source_words, plans, risks, vocab)
        result = {
            "fixture": options.fixture_name,
            "model": options.model,
            "sourceCharacters": len(source),
            "sourceBlocks": len(blocks),
            "sourceWords": len(source_words),
            "serverGroups": len(plans),
            "compactBytes": len(compact.encode()),
            "outputBytes": len(final_text.encode()),
            "timing": {"firstDeltaSeconds": first_delta, "firstCompleteGroupSeconds": first_group,
                "completeGroupSeconds": group_times, "totalSeconds": time.monotonic() - server.started},
            "validation": validation,
            "output": parsed,
            "stderrTail": server.stderr[-30:],
        }
        (output_dir / "result.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps({"fixture": options.fixture_name, "timing": result["timing"],
            "groups": len(plans), "valid": validation["valid"], "errors": validation["errors"]}, ensure_ascii=False))
        return 0 if validation["valid"] else 2
    finally:
        server.close()


if __name__ == "__main__":
    raise SystemExit(main())
