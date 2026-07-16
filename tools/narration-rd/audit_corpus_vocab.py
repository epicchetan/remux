#!/usr/bin/env python3
"""Audit locally resolvable Misaki entries against the installed Kokoro vocabulary."""

from __future__ import annotations

import collections
import glob
import json
from pathlib import Path


def simple(entry: object) -> str | None:
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        values = {value for value in entry.values() if isinstance(value, str) and value}
        if len(values) == 1:
            return next(iter(values))
    return None


def main() -> None:
    data_dir = Path(glob.glob(str(Path.home() / ".cargo/registry/src/*/misaki-rs-0.3.0/data"))[0])
    vocab = set(json.loads((Path.home() / ".codex/remux/narration/models/kokoro-82m-onnx-duration-v1/vocab.json").read_text()))
    counts: collections.Counter[str] = collections.Counter()
    examples: dict[str, list[dict[str, str]]] = collections.defaultdict(list)
    corpus_counts: dict[str, dict[str, int]] = {}
    for filename in ("us_gold.json", "us_silver.json"):
        entries = json.loads((data_dir / filename).read_text())
        resolvable = invalid = 0
        for word, entry in entries.items():
            phonemes = simple(entry)
            if phonemes is None:
                continue
            resolvable += 1
            normalized = phonemes.translate(str.maketrans("", "", "\u200b\u200c\u200d\ufeff"))
            unsupported = sorted({character for character in normalized if not character.isspace() and character not in vocab})
            if not unsupported:
                continue
            invalid += 1
            for character in unsupported:
                counts[character] += 1
                if len(examples[character]) < 12:
                    examples[character].append({"word": word, "phonemes": normalized, "corpus": filename})
        corpus_counts[filename] = {"entries": len(entries), "simpleResolvable": resolvable, "unsupportedEntries": invalid}
    print(json.dumps({
        "corpora": corpus_counts,
        "unsupportedCharacters": dict(counts.most_common()),
        "examples": examples,
    }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
