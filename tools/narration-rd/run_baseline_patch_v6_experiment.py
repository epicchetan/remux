#!/usr/bin/env python3
"""Benchmark a deterministic Misaki/eSpeak baseline plus sparse Sol text patches.

This is an R&D harness. The model never returns phonemes, offsets, occurrences, source
ranges, or ordinary transcript words. The server predeclares risk ids and summary block ids;
Misaki/eSpeak owns all final phonemization.
"""

from __future__ import annotations

import argparse
import json
import queue
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

from misaki.en import G2P
from misaki.espeak import EspeakFallback

from run_app_server_experiment import AppServer, ROOT, completed_group_count
from run_contract_benchmark import (
    WORD_RE,
    assistant_messages,
    load_lexicon,
    lookup_entry,
    markdown_blocks,
)


RUNTIME_PYTHON = Path.home() / ".codex/remux/narration/runtime/bin/python"
VOCAB_PATH = (
    Path.home()
    / ".codex/remux/narration/models/kokoro-82m-onnx-duration-v1/vocab.json"
)
ZERO_WIDTH = str.maketrans("", "", "\u200b\u200c\u200d\ufeff")
MAX_GROUP_BLOCKS = 4
MAX_GROUP_WORDS = 64
MODEL_CONTEXT_WORDS = {
    "bass",
    "bow",
    "lead",
    "minute",
    "row",
    "tear",
    "wind",
    "wound",
}
TECHNICAL_CONNECTOR_RE = re.compile(r"^[@/:]+$")
KIND_CODES = {
    "heading": "h",
    "paragraph": "p",
    "listItem": "li",
    "blockquote": "q",
    "code": "c",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="gpt-5.6-sol")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--fixture", type=Path)
    source.add_argument("--source", type=Path)
    source.add_argument("--session", type=Path)
    parser.add_argument("--message-index", type=int)
    parser.add_argument("--name", default="baseline-patch-v6")
    parser.add_argument(
        "--instructions",
        type=Path,
        default=ROOT / "baseline-patch-v6-instructions.txt",
    )
    parser.add_argument(
        "--schema", type=Path, default=ROOT / "baseline-patch-v6-schema.json"
    )
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--service-tier", choices=["standard", "priority"], default="priority")
    parser.add_argument("--effort", choices=["minimal", "low", "medium"], default="low")
    parser.add_argument("--timeout", type=float, default=300.0)
    return parser.parse_args()


def load_blocks(options: argparse.Namespace) -> tuple[list[dict[str, str]], str]:
    if options.source is not None:
        markdown = options.source.read_text()
        return markdown_blocks(markdown), markdown
    if options.session is not None:
        if options.message_index is None:
            raise ValueError("--message-index is required with --session")
        markdown = assistant_messages(options.session)[options.message_index]
        return markdown_blocks(markdown), markdown
    fixture_path = options.fixture or ROOT / "fixture.json"
    fixture = json.loads(fixture_path.read_text())
    blocks = fixture.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        raise ValueError("fixture must contain a non-empty blocks array")
    markdown = "\n\n".join(str(block.get("text", "")) for block in blocks)
    return blocks, markdown


def normalize_phone(value: str | None) -> str:
    return (value or "").translate(ZERO_WIDTH).strip()


class Baseline:
    def __init__(self) -> None:
        self.g2p = G2P(
            version="2.0",
            british=False,
            fallback=EspeakFallback(False, version="2.0"),
            unk="❓",
        )

    def phonemize(self, text: str) -> tuple[str, list[Any]]:
        phonemes, tokens = self.g2p(text)
        return normalize_phone(phonemes), tokens

    def word_analysis(self, text: str, words: list[re.Match[str]]) -> list[dict[str, str]]:
        _, tokens = self.phonemize(text)
        candidates = [
            (
                token.text.replace("’", "'").casefold(),
                normalize_phone(token.phonemes),
                token.tag,
            )
            for token in tokens
            if token.phonemes
        ]
        cursor = 0
        output: list[dict[str, str]] = []
        for word in words:
            key = word.group(0).replace("’", "'").casefold()
            match = None
            for index in range(cursor, len(candidates)):
                if candidates[index][0] == key:
                    match = index
                    break
            if match is None:
                phones, isolated = self.phonemize(word.group(0))
                tag = next((token.tag for token in isolated if token.phonemes), "")
                output.append({"p": phones, "t": tag})
            else:
                output.append({"p": candidates[match][1], "t": candidates[match][2]})
                cursor = match + 1
        return output


def syntax_adjacent(text: str, start: int, end: int) -> bool:
    left = text[start - 1] if start else ""
    right = text[end] if end < len(text) else ""
    return left in "/:@" or right in "/:@"


def risk_labels(
    text: str,
    word: re.Match[str],
    entry: Any | None,
    phonemes: str,
    tag: str,
    vocabulary: set[str],
) -> list[str]:
    value = word.group(0)
    lower = value.casefold()
    plain_number = re.fullmatch(r"\d+(?:\.\d+)?", value) is not None
    dotted_address = re.fullmatch(r"\d+(?:\.\d+){2,}", value) is not None
    labels: list[str] = []
    if lower in MODEL_CONTEXT_WORDS and not (lower == "lead" and tag.startswith("VB")):
        labels.append("context")
    if isinstance(entry, dict):
        labels.append("ambiguous")
    if entry is None and not plain_number:
        labels.append("oov")
    if any(character.isdigit() for character in value):
        labels.append("numeric")
    if len(value) > 1 and value.isupper():
        labels.append("initialism")
    mixed_case = any(character.islower() for character in value) and any(
        character.isupper() for character in value[1:]
    )
    if (
        mixed_case
        or (any(character in value for character in "._-") and not plain_number)
        or (syntax_adjacent(text, word.start(), word.end()) and not plain_number)
        or dotted_address
    ):
        labels.append("technical")
    if any(character not in vocabulary and not character.isspace() for character in phonemes):
        labels.append("unsupported")
    labels = list(dict.fromkeys(labels))
    return [] if labels == ["numeric"] else labels


def block_risks(
    block_id: int,
    text: str,
    words: list[dict[str, Any]],
    labels_by_word: dict[int, list[str]],
    baseline: Baseline,
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    cursor = 0
    while cursor < len(words):
        component = [words[cursor]]
        end_cursor = cursor
        while end_cursor + 1 < len(words):
            gap = text[words[end_cursor]["end"] : words[end_cursor + 1]["start"]]
            if not TECHNICAL_CONNECTOR_RE.fullmatch(gap):
                break
            end_cursor += 1
            component.append(words[end_cursor])
        labels = list(
            dict.fromkeys(
                label
                for word in component
                for label in labels_by_word.get(word["i"], [])
            )
        )
        if labels:
            start = component[0]["start"]
            if start > 0 and text[start - 1] == "@":
                start -= 1
            end = component[-1]["end"]
            if len(component) > 1 or start != component[0]["start"]:
                labels = list(dict.fromkeys([*labels, "technical"]))
                phonemes, _ = baseline.phonemize(text[start:end])
                tag = "EXPR"
            else:
                phonemes = component[0]["p"]
                tag = component[0]["t"]
            output.append(
                {
                    "b": block_id,
                    "w": [word["i"] for word in component],
                    "x": text[start:end],
                    "p": phonemes,
                    "t": tag,
                    "q": labels,
                    "start": start,
                    "end": end,
                }
            )
        cursor = end_cursor + 1
    return output


def group_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    current: list[int] = []
    current_words = 0
    for block in blocks:
        count = len(block["words"])
        if current and (
            len(current) >= MAX_GROUP_BLOCKS or current_words + count > MAX_GROUP_WORDS
        ):
            groups.append({"i": len(groups), "b": current})
            current = []
            current_words = 0
        current.append(block["i"])
        current_words += count
    if current:
        groups.append({"i": len(groups), "b": current})
    return groups


def prepare(
    blocks: list[dict[str, str]], baseline: Baseline, vocabulary: set[str]
) -> tuple[dict[str, Any], dict[int, dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    gold, silver = load_lexicon()
    prepared_blocks: list[dict[str, Any]] = []
    risks: dict[int, dict[str, Any]] = {}
    word_id = 0
    risk_id = 0
    for block_id, raw in enumerate(blocks):
        text = str(raw.get("text", "")).strip()
        mode = "s" if raw.get("mode") == "summary" else "n"
        matches = list(WORD_RE.finditer(text))
        analyses = baseline.word_analysis(text, matches)
        words: list[dict[str, Any]] = []
        labels_by_word: dict[int, list[str]] = {}
        for match, analysis in zip(matches, analyses):
            phonemes, tag = analysis["p"], analysis["t"]
            entry = lookup_entry(match.group(0), gold, silver)
            labels = [] if mode == "s" else risk_labels(
                text, match, entry, phonemes, tag, vocabulary
            )
            word = {
                "i": word_id,
                "x": match.group(0),
                "start": match.start(),
                "end": match.end(),
                "p": phonemes,
                "t": tag,
            }
            words.append(word)
            if labels:
                labels_by_word[word_id] = labels
            word_id += 1
        for risk in block_risks(block_id, text, words, labels_by_word, baseline):
            risk["i"] = risk_id
            risks[risk_id] = risk
            risk_id += 1
        prepared_blocks.append(
            {
                "i": block_id,
                "k": KIND_CODES.get(str(raw.get("kind")), "p"),
                "m": mode,
                "x": text,
                "words": words,
            }
        )

    groups = group_blocks(prepared_blocks)
    hard_groups: list[dict[str, Any]] = []
    for group in groups:
        block_ids = group["b"]
        summaries = [
            block_id for block_id in block_ids if prepared_blocks[block_id]["m"] == "s"
        ]
        group_risks = [risk for risk in risks.values() if risk["b"] in block_ids]
        if summaries or group_risks:
            hard_groups.append(
                {
                    "i": group["i"],
                    "b": block_ids,
                    "s": summaries,
                    "q": group_risks,
                }
            )

    compact = {
        "v": 6,
        "b": [
            {key: block[key] for key in ("i", "k", "m", "x")}
            for block in prepared_blocks
        ],
        "g": [
            {
                "i": group["i"],
                "b": group["b"],
                "s": group["s"],
                "q": [
                    {key: risk[key] for key in ("i", "b", "w", "x", "p", "t", "q")}
                    for risk in group["q"]
                ],
            }
            for group in hard_groups
        ],
    }
    return compact, risks, prepared_blocks, groups


def replace_spans(text: str, replacements: list[tuple[int, int, str]]) -> str:
    output = text
    for start, end, value in sorted(replacements, reverse=True):
        output = output[:start] + value + output[end:]
    return output


def unsupported_symbols(phonemes: str, vocabulary: set[str]) -> list[str]:
    return sorted(
        {
            character
            for character in phonemes
            if not character.isspace() and character not in vocabulary
        }
    )


def focused_quality(
    blocks: list[dict[str, Any]],
    risks: dict[int, dict[str, Any]],
    patches: dict[int, dict[str, Any]],
    baseline: Baseline,
) -> dict[str, Any] | None:
    challenge = "Record the record before you close the close handler"
    block = next((block for block in blocks if challenge in block["x"]), None)
    lead_block = next(
        (block for block in blocks if "lead developer will lead" in block["x"]), None
    )
    if block is None or lead_block is None:
        return None

    expected = [
        (lead_block["i"], "lead", 0, "lˈid", "lead-developer"),
        (lead_block["i"], "lead", 1, "lˈid", "lead-verb"),
        (lead_block["i"], "lead", 2, "lˈɛd", "lead-metal"),
        (block["i"], "Record", 0, "ɹəkˈɔɹd", "record-verb"),
        (block["i"], "record", 1, "ɹˈɛkəɹd", "record-noun"),
        (block["i"], "close", 0, "klˈOz", "close-verb"),
        (block["i"], "close", 1, "klˈOs", "close-adjective"),
        (block["i"], "read", 0, "ɹˈid", "read-present"),
        (block["i"], "read", 1, "ɹˈɛd", "read-past"),
    ]
    rows: list[dict[str, Any]] = []
    passed = 0
    for block_id, text, occurrence, expected_phone, label in expected:
        source_block = blocks[block_id]
        candidates = [
            word for word in source_block["words"] if word["x"].casefold() == text.casefold()
        ]
        if occurrence >= len(candidates):
            rows.append({"label": label, "passed": False, "error": "source word missing"})
            continue
        word = candidates[occurrence]
        risk = next((risk for risk in risks.values() if word["i"] in risk["w"]), None)
        patch = patches.get(risk["i"]) if risk is not None else None
        actual = word["p"]
        if patch is not None:
            actual, _ = baseline.phonemize(patch["x"])
        ok = normalize_phone(actual) == normalize_phone(expected_phone)
        passed += int(ok)
        rows.append(
            {
                "label": label,
                "source": word["x"],
                "baseline": word["p"],
                "patch": patch,
                "actual": actual,
                "expected": expected_phone,
                "passed": ok,
            }
        )
    return {"passed": passed, "total": len(rows), "observations": rows}


def validate_and_reconstruct(
    value: Any,
    compact: dict[str, Any],
    risks: dict[int, dict[str, Any]],
    blocks: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    baseline: Baseline,
    vocabulary: set[str],
) -> dict[str, Any]:
    errors: list[str] = []
    ignored: list[str] = []
    expected_groups = compact["g"]
    if not isinstance(value, dict) or value.get("v") != 6 or not isinstance(value.get("g"), list):
        return {
            "strictValid": False,
            "narratable": False,
            "errors": ["invalid root"],
            "ignoredPatches": [],
        }

    output_groups = value["g"]
    expected_ids = [group["i"] for group in expected_groups]
    output_ids = [group.get("i") for group in output_groups if isinstance(group, dict)]
    if output_ids != expected_ids:
        errors.append(f"hard group ids {output_ids!r} do not equal {expected_ids!r}")

    summary_text: dict[int, str] = {}
    accepted_patches: dict[int, dict[str, Any]] = {}
    risk_group = {
        risk["i"]: group["i"] for group in expected_groups for risk in group["q"]
    }
    expected_by_id = {group["i"]: group for group in expected_groups}
    for output_group in output_groups:
        if not isinstance(output_group, dict) or output_group.get("i") not in expected_by_id:
            continue
        group_id = output_group["i"]
        expected = expected_by_id[group_id]
        summaries = output_group.get("s")
        patches = output_group.get("p")
        if not isinstance(summaries, list) or not isinstance(patches, list):
            errors.append(f"group {group_id} arrays are malformed")
            continue
        summary_ids = [summary.get("i") for summary in summaries if isinstance(summary, dict)]
        if summary_ids != expected["s"]:
            errors.append(
                f"group {group_id} summary ids {summary_ids!r} do not equal {expected['s']!r}"
            )
        for summary in summaries:
            if not isinstance(summary, dict):
                continue
            block_id, text = summary.get("i"), summary.get("x")
            if block_id in expected["s"] and isinstance(text, str) and text.strip():
                summary_text[block_id] = text.strip()
        for patch in patches:
            if not isinstance(patch, dict):
                ignored.append(f"group {group_id}: non-object patch")
                continue
            risk_id = patch.get("i")
            if risk_id not in risks or risk_group.get(risk_id) != group_id:
                ignored.append(f"group {group_id}: unknown risk id {risk_id!r}")
                continue
            if risk_id in accepted_patches:
                ignored.append(f"group {group_id}: duplicate risk id {risk_id}")
                continue
            kind, text = patch.get("k"), patch.get("x")
            if kind not in ("a", "r") or not isinstance(text, str) or not text.strip():
                ignored.append(f"group {group_id}: invalid patch for risk {risk_id}")
                continue
            patch_phones, _ = baseline.phonemize(text.strip())
            unsupported = unsupported_symbols(patch_phones, vocabulary)
            if not patch_phones or unsupported:
                ignored.append(
                    f"group {group_id}: unusable patch {risk_id}, unsupported={unsupported!r}"
                )
                continue
            accepted_patches[risk_id] = {"i": risk_id, "k": kind, "x": text.strip()}

    missing_summaries = sorted(set(sum((group["s"] for group in expected_groups), [])) - set(summary_text))
    if missing_summaries:
        errors.append(f"missing summary blocks {missing_summaries!r}")

    risks_by_block: dict[int, list[dict[str, Any]]] = {}
    for risk in risks.values():
        risks_by_block.setdefault(risk["b"], []).append(risk)

    rendered_blocks: dict[int, dict[str, str]] = {}
    for block in blocks:
        if block["m"] == "s":
            spoken = summary_text.get(block["i"], block["x"])
            rendered_blocks[block["i"]] = {"spoken": spoken, "audio": spoken}
            continue
        spoken_replacements: list[tuple[int, int, str]] = []
        audio_replacements: list[tuple[int, int, str]] = []
        for risk in risks_by_block.get(block["i"], []):
            patch = accepted_patches.get(risk["i"])
            if patch is None:
                continue
            replacement = (risk["start"], risk["end"], patch["x"])
            audio_replacements.append(replacement)
            if patch["k"] == "r":
                spoken_replacements.append(replacement)
        rendered_blocks[block["i"]] = {
            "spoken": replace_spans(block["x"], spoken_replacements),
            "audio": replace_spans(block["x"], audio_replacements),
        }

    group_reports: list[dict[str, Any]] = []
    narratable = not missing_summaries
    for group in groups:
        audio_text = " ".join(rendered_blocks[block_id]["audio"] for block_id in group["b"])
        phonemes, _ = baseline.phonemize(audio_text)
        unsupported = unsupported_symbols(phonemes, vocabulary)
        if not phonemes or unsupported or len(phonemes) > 500:
            narratable = False
        group_reports.append(
            {
                "i": group["i"],
                "blocks": group["b"],
                "modelRequired": group["i"] in expected_ids,
                "spokenText": " ".join(
                    rendered_blocks[block_id]["spoken"] for block_id in group["b"]
                ),
                "audioText": audio_text,
                "phonemeCount": len(phonemes),
                "unsupportedSymbols": unsupported,
            }
        )

    patch_rows = []
    for risk_id, patch in accepted_patches.items():
        risk = risks[risk_id]
        phones, _ = baseline.phonemize(patch["x"])
        patch_rows.append(
            {
                "riskId": risk_id,
                "block": risk["b"],
                "source": risk["x"],
                "labels": risk["q"],
                "baseline": risk["p"],
                "kind": patch["k"],
                "replacement": patch["x"],
                "replacementPhonemes": phones,
            }
        )
    patch_rows.sort(key=lambda row: row["riskId"])
    quality = focused_quality(blocks, risks, accepted_patches, baseline)
    return {
        "strictValid": not errors and not ignored,
        "narratable": narratable,
        "errors": errors,
        "ignoredPatches": ignored,
        "groups": len(groups),
        "hardGroups": len(expected_groups),
        "immediateGroups": len(groups) - len(expected_groups),
        "summaryBlocks": sum(len(group["s"]) for group in expected_groups),
        "riskCount": len(risks),
        "riskLabels": dict(Counter(label for risk in risks.values() for label in risk["q"])),
        "acceptedPatches": len(accepted_patches),
        "patchRate": len(accepted_patches) / len(risks) if risks else 0.0,
        "patches": patch_rows,
        "focusedQuality": quality,
        "groupReports": group_reports,
    }


def main() -> int:
    options = parse_args()
    if Path(sys.executable).resolve() != RUNTIME_PYTHON.resolve():
        print(
            f"warning: expected Narrate runtime Python at {RUNTIME_PYTHON}, got {sys.executable}",
            file=sys.stderr,
        )
    blocks, source = load_blocks(options)
    vocabulary = set(json.loads(VOCAB_PATH.read_text()))
    baseline = Baseline()
    compact, risks, prepared_blocks, groups = prepare(blocks, baseline, vocabulary)
    if not compact["g"]:
        raise RuntimeError("fixture has no summary or pronunciation-risk groups")
    compact_text = json.dumps(compact, separators=(",", ":"), ensure_ascii=False)
    instructions = options.instructions.read_text()
    schema = json.loads(options.schema.read_text())

    server = AppServer()
    delta_text = ""
    completed_text = None
    first_delta = None
    first_group = None
    group_times: list[float] = []
    delta_events = 0
    usage = None
    try:
        server.request(
            "initialize",
            {
                "capabilities": {"experimentalApi": True},
                "clientInfo": {
                    "name": "remux_baseline_patch_v6",
                    "title": "Remux Baseline Patch V6 R&D",
                    "version": "0.1.0",
                },
            },
        )
        server.send({"jsonrpc": "2.0", "method": "initialized"})
        thread = server.request(
            "thread/start",
            {
                "model": options.model,
                "serviceTier": "priority" if options.service_tier == "priority" else None,
                "baseInstructions": instructions,
                "approvalPolicy": "never",
                "cwd": "/tmp",
                "config": {
                    "features": {
                        "shell_tool": False,
                        "unified_exec": False,
                        "code_mode": False,
                        "standalone_web_search": False,
                        "multi_agent": False,
                        "multi_agent_v2": False,
                        "apps": False,
                        "enable_mcp_apps": False,
                        "tool_suggest": False,
                        "plugins": False,
                        "remote_plugin": False,
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
                "serviceName": "remux-baseline-patch-v6-rd",
            },
        )
        thread_id = thread["thread"]["id"]
        turn = server.request(
            "turn/start",
            {
                "threadId": thread_id,
                "serviceTier": "priority" if options.service_tier == "priority" else None,
                "effort": options.effort,
                "summary": "none",
                "input": [{"type": "text", "text": compact_text, "text_elements": []}],
                "outputSchema": schema,
            },
        )
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
        parsed = json.loads(final_text)
        validation = validate_and_reconstruct(
            parsed, compact, risks, prepared_blocks, groups, baseline, vocabulary
        )
        result = {
            "name": options.name,
            "model": options.model,
            "contract": "baseline-patch-v6",
            "serviceTier": options.service_tier,
            "effort": options.effort,
            "sourceCharacters": len(source),
            "sourceBlocks": len(blocks),
            "compactBytes": len(compact_text.encode()),
            "outputBytes": len(final_text.encode()),
            "timing": {
                "firstDeltaSeconds": first_delta,
                "firstCompleteGroupSeconds": first_group,
                "completeGroupSeconds": group_times,
                "totalSeconds": time.monotonic() - server.started,
                "deltaEvents": delta_events,
            },
            "usage": usage,
            "validation": validation,
            "input": compact,
            "output": parsed,
            "stderrTail": server.stderr[-20:],
        }
        options.result.parent.mkdir(parents=True, exist_ok=True)
        options.result.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        print(
            json.dumps(
                {
                    key: result[key]
                    for key in (
                        "name",
                        "model",
                        "contract",
                        "sourceCharacters",
                        "sourceBlocks",
                        "compactBytes",
                        "outputBytes",
                        "timing",
                        "usage",
                        "validation",
                    )
                },
                ensure_ascii=False,
            )
        )
        return 0 if validation["strictValid"] and validation["narratable"] else 2
    except Exception as error:
        failure = {
            "name": options.name,
            "model": options.model,
            "contract": "baseline-patch-v6",
            "error": str(error),
            "partial": delta_text,
            "input": compact,
            "stderrTail": server.stderr[-50:],
        }
        options.result.parent.mkdir(parents=True, exist_ok=True)
        options.result.write_text(json.dumps(failure, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(failure, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        server.close()


if __name__ == "__main__":
    raise SystemExit(main())
