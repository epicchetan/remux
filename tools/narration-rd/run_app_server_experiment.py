#!/usr/bin/env python3
"""Run one narration contract experiment against Codex app-server.

The script deliberately uses the same minimal app-server surface as Narrate. It records
agent-message delta timing so a completed group can be treated as a streaming commit.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['’._-][A-Za-z0-9]+)*")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--fixture", type=Path, default=ROOT / "fixture.json")
    parser.add_argument("--instructions", type=Path, default=ROOT / "instructions.txt")
    parser.add_argument("--schema", type=Path, default=ROOT / "output-schema.json")
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--service-tier", choices=["standard", "priority"], default="standard")
    parser.add_argument("--timeout", type=float, default=180.0)
    return parser.parse_args()


def load_lexicon() -> tuple[dict[str, object], dict[str, object]]:
    candidates = glob.glob(str(Path.home() / ".cargo/registry/src/*/misaki-rs-0.3.0/data"))
    if not candidates:
        raise RuntimeError("misaki-rs 0.3.0 corpus is not installed")
    directory = Path(candidates[0])
    return (
        json.loads((directory / "us_gold.json").read_text()),
        json.loads((directory / "us_silver.json").read_text()),
    )


def hint_for(word: str, gold: dict[str, object], silver: dict[str, object]) -> object | None:
    for key in (word, word.lower(), word.capitalize()):
        if key in gold:
            return gold[key]
    for key in (word, word.lower(), word.capitalize()):
        if key in silver:
            return silver[key]
    return None


def compact_input(path: Path) -> tuple[str, set[int], list[int]]:
    fixture = json.loads(path.read_text())
    gold, silver = load_lexicon()
    blocks = []
    word_id = 0
    hinted_ids: set[int] = set()
    for block_index, block in enumerate(fixture["blocks"]):
        words = []
        for match in WORD_RE.finditer(block["text"]):
            word = {"i": word_id, "x": match.group(0)}
            hint = hint_for(match.group(0), gold, silver)
            if hint is not None:
                word["h"] = hint
                hinted_ids.add(word_id)
            words.append(word)
            word_id += 1
        blocks.append({
            "i": block_index,
            "k": {"heading": "h", "paragraph": "p", "listItem": "li", "code": "c"}[block["kind"]],
            "m": "s" if block["mode"] == "summary" else "n",
            "x": block["text"],
            "w": words,
        })
    return json.dumps({"v": 1, "b": blocks}, separators=(",", ":")), hinted_ids, list(range(word_id))


class AppServer:
    def __init__(self) -> None:
        self.process = subprocess.Popen(
            ["codex", "app-server", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.events: queue.Queue[tuple[float, dict[str, object]]] = queue.Queue()
        self.stderr: list[str] = []
        self.started = time.monotonic()
        self.reader = threading.Thread(target=self._read_stdout, daemon=True)
        self.error_reader = threading.Thread(target=self._read_stderr, daemon=True)
        self.reader.start()
        self.error_reader.start()
        self.next_id = 1

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            self.events.put((time.monotonic() - self.started, value))

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self.stderr.append(line.rstrip())

    def send(self, value: dict[str, object]) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

    def request(self, method: str, params: dict[str, object], timeout: float = 30.0) -> dict[str, object]:
        request_id = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        deferred: list[tuple[float, dict[str, object]]] = []
        while time.monotonic() < deadline:
            try:
                event = self.events.get(timeout=min(0.25, deadline - time.monotonic()))
            except queue.Empty:
                continue
            if event[1].get("id") == request_id:
                for item in deferred:
                    self.events.put(item)
                if "error" in event[1]:
                    raise RuntimeError(f"{method} failed: {event[1]['error']}")
                return event[1].get("result", {})
            deferred.append(event)
        for item in deferred:
            self.events.put(item)
        raise TimeoutError(f"timed out waiting for {method}")

    def close(self) -> None:
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)


def completed_group_count(text: str) -> int:
    marker = '"g":['
    start = text.find(marker)
    if start < 0:
        return 0
    count = 0
    depth = 0
    in_string = False
    escaped = False
    for char in text[start + len(marker):]:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                count += 1
        elif char == "]" and depth == 0:
            break
    return count


def validate_output(value: object, valid_words: list[int], hinted_ids: set[int], vocab: set[str]) -> dict[str, object]:
    errors: list[str] = []
    if not isinstance(value, dict) or value.get("v") != 1 or not isinstance(value.get("g"), list):
        return {"valid": False, "errors": ["invalid root"]}
    groups = value["g"]
    covered_blocks: list[int] = []
    sources: list[int] = []
    unsupported: set[str] = set()
    token_count = 0
    hinted_token_count = 0
    generated_token_count = 0
    corrected_token_count = 0
    for index, group in enumerate(groups):
        if group.get("i") != index:
            errors.append(f"group id mismatch at {index}")
        block_range = group.get("b", [])
        if len(block_range) == 2 and block_range[0] <= block_range[1]:
            covered_blocks.extend(range(block_range[0], block_range[1] + 1))
        else:
            errors.append(f"invalid block range in group {index}: {block_range}")
        group_phonemes = ""
        for token in group.get("t", []):
            token_count += 1
            origin = token.get("o")
            hinted_token_count += int(origin == "h")
            corrected_token_count += int(origin == "c")
            generated_token_count += int(origin == "g")
            phonemes = token.get("p", "")
            group_phonemes += phonemes
            unsupported.update(
                char for char in phonemes
                if char not in vocab and not char.isspace() and char != "\u200d"
            )
            token_sources = token.get("s", [])
            if token_sources != sorted(token_sources):
                errors.append(f"non-monotonic sources inside group {index}")
            sources.extend(token_sources)
        if not group_phonemes.strip():
            errors.append(f"empty phonemes in group {index}")
        if len(group_phonemes) > 500:
            errors.append(f"phoneme budget exceeded in group {index}: {len(group_phonemes)}")
    expected_blocks = list(range(16))
    if covered_blocks != expected_blocks:
        errors.append(f"block coverage is {covered_blocks}, expected {expected_blocks}")
    if any(source not in valid_words for source in sources):
        errors.append("invalid source word id")
    if sources != sorted(sources):
        errors.append("source ids are not globally monotonic")
    if unsupported:
        errors.append("unsupported phoneme symbols: " + "".join(sorted(unsupported)))
    return {
        "valid": not errors,
        "errors": errors,
        "groups": len(groups),
        "speechTokens": token_count,
        "hintOriginTokens": hinted_token_count,
        "contextOriginTokens": corrected_token_count,
        "generatedOriginTokens": generated_token_count,
        "sourceReferences": len(sources),
        "uniqueSourceReferences": len(set(sources)),
        "hintedSourceWords": len(hinted_ids),
        "unsupportedSymbols": sorted(unsupported),
    }


def main() -> int:
    args = parse_args()
    compact, hinted_ids, valid_words = compact_input(args.fixture)
    instructions = args.instructions.read_text()
    schema = json.loads(args.schema.read_text())
    vocab_path = Path.home() / ".codex/remux/narration/models/kokoro-82m-onnx-duration-v1/vocab.json"
    vocab = set(json.loads(vocab_path.read_text()).keys())
    server = AppServer()
    delta_text = ""
    delta_events = 0
    first_delta = None
    first_group = None
    group_times: list[float] = []
    completed_text = None
    usage = None
    try:
        server.request("initialize", {
            "capabilities": {"experimentalApi": True},
            "clientInfo": {"name": "remux_narration_rd", "title": "Remux Narration R&D", "version": "0.1.0"},
        })
        server.send({"jsonrpc": "2.0", "method": "initialized"})
        thread = server.request("thread/start", {
            "model": args.model,
            "serviceTier": "priority" if args.service_tier == "priority" else None,
            "baseInstructions": instructions,
            "approvalPolicy": "never",
            "cwd": "/tmp",
            "config": {
                "features": {
                    "shell_tool": False, "unified_exec": False, "code_mode": False,
                    "standalone_web_search": False, "multi_agent": False,
                    "multi_agent_v2": False, "apps": False, "enable_mcp_apps": False,
                    "tool_suggest": False, "plugins": False, "remote_plugin": False,
                    "image_generation": False,
                },
                "web_search": "disabled",
                "skills": {"include_instructions": False, "bundled": {"enabled": False}},
            },
            "dynamicTools": [],
            "environments": [],
            "ephemeral": True,
            "experimentalRawEvents": False,
            "persistExtendedHistory": False,
            "sandbox": "read-only",
            "serviceName": "remux-narration-rd",
        })
        thread_id = thread["thread"]["id"]
        turn = server.request("turn/start", {
            "threadId": thread_id,
            "serviceTier": "priority" if args.service_tier == "priority" else None,
            "effort": "low",
            "summary": "none",
            "input": [{"type": "text", "text": compact, "text_elements": []}],
            "outputSchema": schema,
        })
        turn_id = turn["turn"]["id"]
        deadline = time.monotonic() + args.timeout
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
            elif method == "turn/completed":
                item = params.get("turn", {})
                if item.get("id") != turn_id:
                    continue
                usage = item.get("usage") or params.get("usage")
                break
        else:
            raise TimeoutError("turn did not complete")

        final_text = completed_text or delta_text
        parsed = json.loads(final_text)
        validation = validate_output(parsed, valid_words, hinted_ids, vocab)
        result = {
            "model": args.model,
            "serviceTier": args.service_tier,
            "timing": {
                "firstDeltaSeconds": first_delta,
                "firstCompleteGroupSeconds": first_group,
                "completeGroupSeconds": group_times,
                "totalSeconds": time.monotonic() - server.started,
                "deltaEvents": delta_events,
            },
            "usage": usage,
            "validation": validation,
            "outputBytes": len(final_text.encode("utf-8")),
            "output": parsed,
            "stderrTail": server.stderr[-20:],
        }
        args.result.parent.mkdir(parents=True, exist_ok=True)
        args.result.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps({key: result[key] for key in ["model", "serviceTier", "timing", "usage", "validation"]}, ensure_ascii=False))
        return 0 if validation["valid"] else 2
    except Exception as error:
        failure = {
            "model": args.model,
            "serviceTier": args.service_tier,
            "error": str(error),
            "partial": delta_text,
            "stderrTail": server.stderr[-50:],
        }
        args.result.parent.mkdir(parents=True, exist_ok=True)
        args.result.write_text(json.dumps(failure, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(failure, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        server.close()


if __name__ == "__main__":
    raise SystemExit(main())
