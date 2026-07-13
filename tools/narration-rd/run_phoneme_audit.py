#!/usr/bin/env python3
"""Run a phoneme-only second stage over an immutable sparse transcript."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from run_app_server_experiment import (
    AppServer,
    ROOT,
    WORD_RE,
    completed_group_count,
    hint_for,
    load_lexicon,
)


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--transcript-result", type=Path, required=True)
    parser.add_argument("--instructions", type=Path, default=ROOT / "phoneme-audit-instructions.txt")
    parser.add_argument("--schema", type=Path, default=ROOT / "phoneme-audit-schema.json")
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--service-tier", choices=["standard", "priority"], default="standard")
    parser.add_argument("--timeout", type=float, default=180.0)
    return parser.parse_args()


def audit_input(path: Path) -> tuple[str, dict[int, int], dict[int, tuple[int, int]]]:
    transcript = json.loads(path.read_text())["output"]
    gold, silver = load_lexicon()
    groups = []
    missing_by_group: dict[int, int] = {}
    bounds: dict[int, tuple[int, int]] = {}
    word_id = 0
    for group in transcript["g"]:
        words = []
        first = word_id
        missing = 0
        for match in WORD_RE.finditer(group["x"]):
            word = {"i": word_id, "x": match.group(0)}
            hint = hint_for(match.group(0), gold, silver)
            if hint is None:
                missing += 1
            else:
                word["h"] = hint
            words.append(word)
            word_id += 1
        groups.append({"i": group["i"], "x": group["x"], "w": words})
        missing_by_group[group["i"]] = missing
        bounds[group["i"]] = (first, word_id - 1)
    return json.dumps({"v": 3, "g": groups}, separators=(",", ":")), missing_by_group, bounds


def validate(value: object, missing: dict[int, int], bounds: dict[int, tuple[int, int]], vocab: set[str]) -> dict[str, object]:
    if not isinstance(value, dict) or value.get("v") != 3 or not isinstance(value.get("g"), list):
        return {"valid": False, "errors": ["invalid root"]}
    errors: list[str] = []
    unsupported: set[str] = set()
    overrides = 0
    covered_words = 0
    for index, group in enumerate(value["g"]):
        if group.get("i") != index:
            errors.append(f"group id mismatch at {index}")
        previous_end = bounds[index][0] - 1
        for override in group.get("o", []):
            overrides += 1
            word_range = override.get("w", [])
            if len(word_range) != 2 or word_range[0] > word_range[1]:
                errors.append(f"invalid word range in group {index}: {word_range}")
                continue
            if word_range[0] <= previous_end:
                errors.append(f"overlapping or unordered range in group {index}: {word_range}")
            if word_range[0] < bounds[index][0] or word_range[1] > bounds[index][1]:
                errors.append(f"out-of-group range in group {index}: {word_range}")
            previous_end = word_range[1]
            covered_words += word_range[1] - word_range[0] + 1
            unsupported.update(
                char for char in override.get("p", "")
                if char not in vocab and not char.isspace() and char != "\u200d"
            )
    if len(value["g"]) != len(bounds):
        errors.append("patch group count mismatch")
    if unsupported:
        errors.append("unsupported phoneme symbols: " + "".join(sorted(unsupported)))
    # Exact OOV coverage needs ranges expanded against input hints. This first metric is a lower
    # bound: there must be at least as many covered words as corpus misses.
    if covered_words < sum(missing.values()):
        errors.append(f"only {covered_words} words patched for {sum(missing.values())} corpus misses")
    return {"valid": not errors, "errors": errors, "groups": len(value["g"]),
            "overrides": overrides, "coveredWords": covered_words,
            "corpusMissingWords": sum(missing.values()), "unsupportedSymbols": sorted(unsupported)}


def main() -> int:
    options = args()
    compact, missing, bounds = audit_input(options.transcript_result)
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
    try:
        server.request("initialize", {"capabilities": {"experimentalApi": True},
            "clientInfo": {"name": "remux_narration_rd", "title": "Remux Narration R&D", "version": "0.1.0"}})
        server.send({"jsonrpc": "2.0", "method": "initialized"})
        thread = server.request("thread/start", {
            "model": options.model, "serviceTier": "priority" if options.service_tier == "priority" else None,
            "baseInstructions": instructions, "approvalPolicy": "never", "cwd": "/tmp",
            "config": {"features": {"shell_tool": False, "unified_exec": False, "code_mode": False,
                "standalone_web_search": False, "multi_agent": False, "multi_agent_v2": False,
                "apps": False, "enable_mcp_apps": False, "tool_suggest": False, "plugins": False,
                "remote_plugin": False, "image_generation": False}, "web_search": "disabled",
                "skills": {"include_instructions": False, "bundled": {"enabled": False}}},
            "dynamicTools": [], "environments": [], "ephemeral": True, "experimentalRawEvents": False,
            "persistExtendedHistory": False, "sandbox": "read-only", "serviceName": "remux-narration-rd"})
        thread_id = thread["thread"]["id"]
        turn = server.request("turn/start", {"threadId": thread_id,
            "serviceTier": "priority" if options.service_tier == "priority" else None,
            "effort": "low", "summary": "none",
            "input": [{"type": "text", "text": compact, "text_elements": []}], "outputSchema": schema})
        turn_id = turn["turn"]["id"]
        deadline = time.monotonic() + options.timeout
        while time.monotonic() < deadline:
            try:
                at, event = server.events.get(timeout=0.25)
            except Exception:
                continue
            method, params = event.get("method"), event.get("params", {})
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
                break
        else:
            raise TimeoutError("turn did not complete")
        final_text = completed_text or delta_text
        parsed = json.loads(final_text)
        validation = validate(parsed, missing, bounds, vocab)
        result = {"model": options.model, "contract": "phoneme-audit", "serviceTier": options.service_tier,
            "timing": {"firstDeltaSeconds": first_delta, "firstCompleteGroupSeconds": first_group,
                "completeGroupSeconds": group_times, "totalSeconds": time.monotonic() - server.started,
                "deltaEvents": delta_events}, "validation": validation,
            "outputBytes": len(final_text.encode("utf-8")), "output": parsed, "stderrTail": server.stderr[-20:]}
        options.result.parent.mkdir(parents=True, exist_ok=True)
        options.result.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps({key: result[key] for key in ["model", "contract", "serviceTier", "timing", "validation", "outputBytes"]}, ensure_ascii=False))
        return 0 if validation["valid"] else 2
    finally:
        server.close()


if __name__ == "__main__":
    raise SystemExit(main())
