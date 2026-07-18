# Narrate local G2P and sparse spoken-text patches v6

Status: Archived — superseded by narrate-batch-alignment.md and narrate-pronunciation-audit.md
Last verified: 2026-07-14
Evidence: `docs/specs/narrate-baseline-patch-rd.md`, `tools/narration-rd/run_baseline_patch_v6_experiment.py`

## Decision

Narrate v6 is a hard replacement for the complete model-generated phoneme pipeline. Local Misaki
owns the complete baseline transcript, POS tags, phonemes, tokenization, and source alignment. GPT-5.6
Sol receives the complete document for context but may return only:

- a plain-text audio alias for one server-owned pronunciation risk;
- a plain-text transcript replacement for one server-owned risk span;
- spoken summary text for one server-designated code, table, or diagram block.

Sol never returns phonemes, source text, offsets, occurrences, source-word arrays, token separators,
groups, renderer targets, or timing. Kokoro receives only locally generated and locally validated
phonemes.

There is no v5 inference path, older G2P frontend, alternate model, checker model, repair turn,
prompt retry, feature switch, or old-cache reader. Git history is the rollback mechanism.

## Runtime topology

```text
Codex viewer
  -> remux/narrate/narration/start
  -> Narrate validates source schema and Kokoro profile
  -> native Misaki builds the complete word/POS/phoneme baseline
  -> reviewed aliases are applied locally
  -> Narrate batches blocks for sparse correction and assigns immutable source-word and risk ids
  -> immediate groups can enter the Kokoro spool
  -> one whole-document Sol Priority request for hard groups only
       -> { group id, summaries, sparse text patches }
  -> Narrate validates ids and locally phonemizes every returned string
  -> completed correction batches are split locally at sentences or phrases
  -> bounded acoustic groups enter the Kokoro spool in source order
  -> managed Kokoro workers publish immutable WAV segments
  -> final manifest validation and atomic cache promotion
```

The Python Misaki/eSpeak environment used during R&D is not a production dependency. Production
uses the already pinned native `misaki-rs` 0.3.0 US frontend. Native Misaki is weaker on a few
heteronyms than Python Misaki, so tagged corpus entries and the curated contextual set are explicit
Sol risks. Unknown and technical words are also risks. This keeps production self-contained while
retaining the experiment's central property: Sol corrects local spoken text and never authors
phonemes or alignment.

## Hard invariants

1. Narrate assigns every block, group, source word, semantic range, summary block, and risk id before
   inference.
2. Local Misaki generates every final phoneme string, including aliases, replacements, and summaries.
3. The Sol output contains exactly the predeclared hard group ids in order.
4. Summary ids exactly equal the server-declared summary ids for that group.
5. A patch may reference only one risk id from its current group and may reference it once.
6. An audio alias maps exactly one source word to exactly one locally tokenized alias word.
7. A transcript replacement may expand to multiple words; every generated word inherits the risk's
   complete server-owned source range.
8. Unchanged baseline words keep their exact source-word target when one exists and otherwise use
   their block target.
9. All local phonemes and spoken punctuation must exist in the active Kokoro vocabulary before the
   group is committed.
10. Correction batches and acoustic groups are distinct. One validated Sol record may resolve to
    several acoustic groups without another model turn.
11. Acoustic groups are committed and audio is published in document order. A committed group is
    immutable. Consecutive groups may cover different portions of the same source block.
12. A malformed emitted patch or missing required summary fails the narration with the exact group,
    block, or risk diagnostic. It does not invoke a fallback.
13. An omitted optional patch deliberately keeps the v6 local baseline; that is the primary design,
    not a fallback to an older pipeline.
14. Only a complete validated artifact is promoted to durable cache.

## Model contract

The compact input is version 6:

```json
{
  "v": 6,
  "b": [{ "i": 0, "k": "p", "m": "n", "x": "The lead pipe." }],
  "g": [{
    "i": 0,
    "b": [0],
    "s": [],
    "q": [{
      "i": 4,
      "b": 0,
      "w": [1],
      "x": "lead",
      "p": "lˈid",
      "t": "NN",
      "q": ["context"]
    }]
  }]
}
```

`b` contains the complete ordered document so Sol has global context. `g` contains only hard groups.
The output is version 6:

```json
{
  "v": 6,
  "g": [{
    "i": 0,
    "s": [],
    "p": [{ "i": 4, "k": "a", "x": "led" }]
  }]
}
```

Patch kind `a` is an audio alias: visible/spoken source spelling stays unchanged while local G2P
uses the alias pronunciation. Patch kind `r` replaces the spoken transcript for the complete risk
span. Empty `p` means every supplied baseline in the group is already acceptable.

The schema requires `items` on every array, disables additional object properties, requires every
declared property, and bounds group and string sizes. The incremental parser accepts either legal
root-key order, rejects any unknown or duplicate envelope key, emits only complete group objects,
and verifies the terminal delta and completed-text digests.

## Deterministic baseline and risks

Narrate applies the frontend to the complete block so POS and contextual corpus behavior are
available. It aligns the resulting lexical tokens monotonically to the server word grammar. Joined
spellings such as dotted, underscored, apostrophized, or hyphenated words may collect multiple local
G2P tokens while remaining one source word.

A normal source word becomes a model risk when one or more of these apply:

| Label | Server decision |
| --- | --- |
| `context` | spelling is in the curated heteronym set |
| `ambiguous` | Misaki corpus entry is POS-tagged |
| `oov` | no simple Misaki corpus resolution exists |
| `initialism` | two or more alphabetic characters are uppercase |
| `numeric` | a larger risky spelling contains a number |
| `technical` | mixed case, joined notation, syntax adjacency, or a renderer semantic range |
| `unsupported` | baseline contains a symbol outside the active Kokoro vocabulary |

A number with no other reason remains local and is not sent merely for being numeric. Code, table,
and diagram blocks are summary blocks rather than word-risk blocks.

Overlapping renderer semantic ranges are deduplicated. A semantic range becomes one risk. Outside
those ranges, adjacent risky words connected only by `@`, `/`, or `:` become one risk, including
`@scope/my_package`, `serde_json::from_value`, and address/port forms. The model cannot target only a
substring of these expressions.

## Reviewed pronunciation lexicon

Version 1 owns stable audio aliases for recurring terms so Sol does not choose a new spelling on
each narration. It currently includes G2P, Kokoro, Misaki, nginx, ONNX, Remux, serde, Sol, SQLite,
and WKWebView. These aliases preserve the source transcript and source target while using locally
generated alias phonemes. A lexicon entry is excluded from model risks unless it participates in a
larger risky semantic expression.

The lexicon version is part of the artifact cache key and provider descriptor. Changes require unit
coverage and a version bump. Generated model choices are never promoted automatically.

## Alignment

Every source word has a global id, block id, UTF-16 display range, optional exact renderer word
target, local POS tag, and local phonemes before inference.

- An unchanged word maps to its exact word target or, when unavailable, its block target.
- A reviewed alias retains the unchanged source word and exact source mapping.
- An audio alias retains the source transcript and attaches the locally generated alias phones to
  that source word.
- Every word in a transcript replacement inherits the complete ordered source-word id range and the
  union of its targets.
- Every generated summary word maps to the summary block target.

This makes transcript expansion an explicit many-to-one relation. There is no substring occurrence
search after inference and no model-generated association cardinality to reconcile.

## Streaming and backpressure

Server correction batches are contiguous and cover every block exactly once. There are two lanes
that feed the same ordered acoustic commit stream:

- An immediate batch has no unresolved risk and no required summary. It can be locally resolved and
  committed without waiting for a Sol text delta.
- A hard batch waits for its small patch record, then runs local G2P and validation.

Sol receives all hard batches in one request and streams records in hard-batch order. Hard batch ids
may skip immediate batch ids. Once a batch is resolved, Narrate uses Unicode sentence boundaries
and exact final phoneme counts to form acoustic groups. Complete sentences are packed to a
240-symbol first-group target and a 360-symbol later-group target. A sentence above the operating
limit is split through a deterministic waterfall: sentence or block boundary, semicolon/colon,
comma/em dash, coordinating or subordinating phrase leader, then whitespace. Common abbreviations,
initials, versions, and lowercase continuations suppress false sentence breaks.

The local planner caps every acoustic group at 450 phoneme symbols, leaving margin under the
worker's absolute 500-symbol Kokoro validation limit. One correction batch can therefore yield
several acoustic groups, including several consecutive groups for one source block. Their word
targets and many-to-one replacement associations are sliced with the words, so source highlighting
remains exact. No checker model or repair request participates in grouping.

Narrate stores completed patch records in a bounded map and commits acoustic groups only when the
Kokoro spool has capacity. Later records can arrive while earlier groups synthesize, but audio
publication remains ordered. Worker and manifest validation allow only a repeated last block or the
immediately following block; skipped or reversed block ranges still fail.

The existing bounds remain: 32 pending patch groups, 512 KiB pending JSON, 16 committed but
unpublished groups, 4,000 committed but unpublished phonemes, a 450-symbol planner ceiling, a
500-symbol absolute worker ceiling, a 60-second no-progress deadline, and a 15-minute job deadline.

## Version cut

| Surface | v6 value |
| --- | --- |
| Renderer source schema | schema `3`, document version `4` |
| Compact model request | `6` |
| Sparse patch output | `6` |
| Base instructions | `6` |
| Grouping prompt | `4` |
| Corpus resolver | `3` |
| Local G2P | `misaki-rs-0.3.0-us` |
| Reviewed lexicon | `1` |
| Spoken tokenizer | `2` |
| Incremental parser | `5` |
| Source mapper | `11` |
| Kokoro streaming task | `7` |
| Worker protocol | `7` |
| Manifest | `6` |
| Cache namespace | `narrate/v6` |

Narrate deletes the obsolete `v1` through `v5` cache directories at startup and reads only v6
artifacts.

## Failure and diagnostics

The job diagnostic ring records baseline group counts, immediate and hard group counts, risk and
summary counts, every accepted patch-group cardinality, terminal completion, and the exact failure.
Invalid schema, group order, summary coverage, risk identity, replacement text, local G2P,
vocabulary, source mapping, spool identity, or final manifest validation stops the job. Published
prefix audio may remain readable for the active failed job but is never promoted or reused.

## Validation evidence

- Narrate server unit suite covers source schema, phoneme-aware sentence/phrase grouping, risks,
  connected expressions, every-byte incremental parsing, duplicate and invalid envelope keys,
  summary coverage, aliases, replacements, alignment, immediate-group id gaps, spool bounds, and
  profile identity.
- `remux-tts` covers local G2P, corpus normalization, streaming spool validation, timing, WAV output,
  and Kokoro model boundaries.
- The installed Kokoro vocabulary accepts all version-1 reviewed aliases.
- The exact production prompt and schema completed one Sol Priority run in 12.99 seconds, emitted
  its first complete group in 10.43 seconds, returned 1,035 bytes, passed strict validation, and
  retained the 9/9 focused contextual score.

Live acceptance still requires restarting Narrate onto the new binary, narrating several real
thread responses, verifying progressive playback and highlighting, and listening for stress,
technical-name preference, pacing, and summary fidelity.
