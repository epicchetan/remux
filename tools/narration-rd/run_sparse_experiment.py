#!/usr/bin/env python3
"""Benchmark the sparse transcript-plus-pronunciation-override contract."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

from run_app_server_experiment import (
    AppServer,
    ROOT,
    WORD_RE,
    compact_input,
    completed_group_count,
    load_lexicon,
)


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--fixture", type=Path, default=ROOT / "fixture.json")
    parser.add_argument("--instructions", type=Path, default=ROOT / "sparse-instructions.txt")
    parser.add_argument("--schema", type=Path, default=ROOT / "sparse-output-schema.json")
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--service-tier", choices=["standard", "priority"], default="standard")
    parser.add_argument("--timeout", type=float, default=180.0)
    return parser.parse_args()


def corpus_has(word: str, gold: dict[str, object], silver: dict[str, object]) -> bool:
    direct = any(key in gold or key in silver for key in (word, word.lower(), word.capitalize()))
    if direct:
        return True
    parts = [part for part in re.split(r"[-_]", word) if part]
    return len(parts) > 1 and all(
        any(key in gold or key in silver for key in (part, part.lower(), part.capitalize()))
        for part in parts
    )


def override_word_spans(text: str, overrides: list[dict[str, object]]) -> tuple[set[tuple[int, int]], list[str]]:
    covered: set[tuple[int, int]] = set()
    errors: list[str] = []
    for override in overrides:
        needle = override.get("x", "")
        occurrence = override.get("n", 0)
        matches = list(re.finditer(re.escape(needle), text, flags=re.IGNORECASE))
        if occurrence >= len(matches):
            errors.append(f"override substring not found: {needle!r} occurrence {occurrence}")
            continue
        match = matches[occurrence]
        for word in WORD_RE.finditer(text):
            if word.start() >= match.start() and word.end() <= match.end():
                covered.add((word.start(), word.end()))
    return covered, errors


def validate(value: object, valid_words: list[int], vocab: set[str]) -> dict[str, object]:
    if not isinstance(value, dict) or value.get("v") != 2 or not isinstance(value.get("g"), list):
        return {"valid": False, "errors": ["invalid root"]}
    gold, silver = load_lexicon()
    errors: list[str] = []
    covered_blocks: list[int] = []
    all_sources: list[int] = []
    unresolved: list[str] = []
    override_count = 0
    output_words = 0
    unsupported: set[str] = set()
    for index, group in enumerate(value["g"]):
        if group.get("i") != index:
            errors.append(f"group id mismatch at {index}")
        block_range = group.get("b", [])
        if len(block_range) == 2 and block_range[0] <= block_range[1]:
            covered_blocks.extend(range(block_range[0], block_range[1] + 1))
        else:
            errors.append(f"invalid block range in group {index}: {block_range}")
        overrides = group.get("o", [])
        override_count += len(overrides)
        overridden, override_errors = override_word_spans(group.get("x", ""), overrides)
        errors.extend(f"group {index}: {error}" for error in override_errors)
        for word in WORD_RE.finditer(group.get("x", "")):
            output_words += 1
            if not corpus_has(word.group(0), gold, silver) and (word.start(), word.end()) not in overridden:
                unresolved.append(word.group(0))
        for override in overrides:
            phonemes = override.get("p", "")
            unsupported.update(
                char for char in phonemes
                if char not in vocab and not char.isspace() and char != "\u200d"
            )
            sources = override.get("s", [])
            if sources != sorted(sources):
                errors.append(f"non-monotonic override source ids in group {index}")
            all_sources.extend(sources)
    if covered_blocks != list(range(16)):
        errors.append(f"block coverage is {covered_blocks}")
    if any(source not in valid_words for source in all_sources):
        errors.append("invalid source word id")
    if unsupported:
        errors.append("unsupported phoneme symbols: " + "".join(sorted(unsupported)))
    if unresolved:
        errors.append("unresolved corpus OOV words: " + ", ".join(unresolved))
    return {
        "valid": not errors,
        "errors": errors,
        "groups": len(value["g"]),
        "outputWords": output_words,
        "overrides": override_count,
        "overrideSourceReferences": len(all_sources),
        "unresolvedWords": unresolved,
        "unsupportedSymbols": sorted(unsupported),
    }


def main() -> int:
    options = args()
    compact, _, valid_words = compact_input(options.fixture)
    instructions = options.instructions.read_text()
    schema = json.loads(options.schema.read_text())
    vocab_path = Path.home() / ".codex/remux/narration/models/kokoro-82m-onnx-duration-v1/vocab.json"
    vocab = set(json.loads(vocab_path.read_text()).keys())
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
            "clientInfo": {"name": "remux_narration_rd", "title": "Remux Narration R&D", "version": "0.1.0"},
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
            "sandbox": "read-only", "serviceName": "remux-narration-rd",
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
            except Exception:
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
        parsed = json.loads(final_text)
        validation = validate(parsed, valid_words, vocab)
        result = {
            "model": options.model, "contract": "sparse", "serviceTier": options.service_tier,
            "timing": {"firstDeltaSeconds": first_delta, "firstCompleteGroupSeconds": first_group,
                       "completeGroupSeconds": group_times, "totalSeconds": time.monotonic() - server.started,
                       "deltaEvents": delta_events},
            "usage": usage, "validation": validation,
            "outputBytes": len(final_text.encode("utf-8")), "output": parsed,
            "stderrTail": server.stderr[-20:],
        }
        options.result.parent.mkdir(parents=True, exist_ok=True)
        options.result.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps({key: result[key] for key in ["model", "contract", "serviceTier", "timing", "usage", "validation", "outputBytes"]}, ensure_ascii=False))
        return 0 if validation["valid"] else 2
    except Exception as error:
        failure = {"model": options.model, "contract": "sparse", "error": str(error),
                   "partial": delta_text, "stderrTail": server.stderr[-50:]}
        options.result.parent.mkdir(parents=True, exist_ok=True)
        options.result.write_text(json.dumps(failure, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(failure, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        server.close()


if __name__ == "__main__":
    raise SystemExit(main())
