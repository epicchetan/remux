# Narrate streaming transcript, pronunciation, and playback v5

Status: Archived — superseded by `docs/specs/narrate-local-g2p-sparse-patches.md`
Last verified: 2026-07-13
Canonical code: `extensions/narrate/server/`, `crates/remux-tts/`, `extensions/codex/server/src/structured_inference.rs`, `extensions/codex/shared/narration.ts`, `extensions/codex/viewer/narration/`
Evidence: `docs/specs/narrate-streaming-g2p-rd.md`, `docs/specs/narrate-streaming-g2p-contract-rd.md`, `tools/narration-rd/`

> Historical complete-model-phoneme specification. Narrate v6 removed this model contract and now
> uses authoritative local G2P plus sparse spoken-text patches. This document remains as rationale
> for the v5 implementation and its failure surface.

## Decision

Narrate uses one whole-document GPT-5.6 Sol Priority turn to produce streamed spoken tokens with complete word-level phonemes. The model does not own acoustic grouping, source-block coverage, renderer targets, audio timing, or token boundaries.

The server predeclares ordered acoustic groups and a source unit for every block. Sol returns one spoken unit for each predeclared source unit as an ordered token array. Every token carries one display word, one scalar phoneme string, optional material-rewrite source ids, and its following separator. Narrate validates and resolves one complete group at a time, commits it immutably, and lets the persistent Kokoro worker synthesize it while later groups are still arriving.

This is a hard replacement. There is no legacy planner, old G2P frontend, alternate model, repair model, prompt retry, old manifest reader, or runtime feature switch. Git history is the rollback mechanism.

## Why v5 exists

The v4 contract asked the model to invent block ranges and coupled multiword source associations to parallel arrays of phoneme strings. Real thread responses produced valid JSON whose association word count did not match its phoneme count. A split sparse-scalar prototype eliminated all 50 observed cardinality mismatches, but later live acceptance found a second occurrence-joining failure mode: pronunciations and source links could still drift away from the free-text words they described, especially for generated summaries, numbers, and technical spellings.

V5 moves every relational invariant possible into server-owned structure:

- group and unit membership are predeclared;
- each spoken unit has one immutable source block owner;
- spoken text is represented once as an ordered server-tokenized token array;
- every token directly owns one non-empty scalar phoneme string and its following separator;
- material rewrite source ids attach directly to the affected spoken token, with no substring or occurrence lookup;
- unassociated generated connectors inherit the unit's block provenance;
- known pronunciation hazards are marked before inference;
- incompatible corpus entries are not advertised as safe;
- failure reports the primary validation error and never invokes a second model.

## Hard invariants

1. One narration job uses exactly one `gpt-5.6-sol` Priority, low-effort turn.
2. Narrate determines every acoustic group and its ordered source blocks before inference.
3. Model output has exactly one ordered group per server group and one ordered unit per source block.
4. The model cannot output block ranges, offsets, DOM ids, timing, or audio boundaries.
5. Each output token contains exactly one tokenizer word, one scalar phoneme string, source ids, and a following separator.
6. Spoken text, pronunciation, and rewrite provenance share the same token cardinality; substring occurrences and parallel arrays do not exist.
7. Every spoken word has an explicit Sol phoneme string validated against Kokoro's vocabulary.
8. Risk labels guide contextual pronunciation and normalization; validation applies to the complete aligned token stream Sol actually speaks.
9. Exact source words map to word targets; rewritten tokens map through their source ids; otherwise words inherit their source unit's block target.
10. Kokoro native durations are the only production acoustic clock.
11. A validated group is immutable after commit.
12. A failure never starts a repair turn or an older narration path.
13. Only a complete validated artifact is promoted to the durable cache.

## Version cut

| Surface | v5 value |
| --- | --- |
| Renderer source schema | schema `3`, document version `4` |
| Compact model request | `5` |
| Streaming model output | `5` |
| Base instructions | `5` |
| Grouping prompt | `2` |
| Corpus resolver | `2` |
| Spoken tokenizer | `1` |
| Incremental parser | `3` |
| Source mapper | `9` |
| Kokoro streaming task | `6` |
| Worker protocol | `6` |
| Manifest | `5` |
| Cache namespace | `narrate/v4` |

Narrate removes old `narrate/v1`, `narrate/v2`, and `narrate/v3` cache directories at startup and reads only the current v5 artifacts from `narrate/v4`.

## Process topology

```text
Codex viewer
  -> remux/narrate/narration/start
  -> Narrate validates source, Sol profile, Kokoro assets, and vocabulary
  -> Narrate tokenizes source and predeclares groups and block units
  -> one remux/codex/inference/structured/generate request
       -> one isolated gpt-5.6-sol Priority turn
       -> item/agentMessage/delta progress
  -> incremental parser emits each complete JSON group
  -> Narrate validates unit identity, token boundaries, risks, provenance, and every pronunciation
  -> Narrate reconstructs aligned text and commits plan/NNN.json
  -> one managed Kokoro task synthesizes committed groups
  -> immutable WAV + segment sidecar publication
  -> remux/narrate/narration/updated
  -> viewer appends the available segment and duration-based cues
  -> final completion validation and cache promotion
```

## Deterministic acoustic grouping

Narrate groups complete source blocks before constructing the model request. Groups are ordered, contiguous, non-empty, and cover the document exactly once.

The implemented policy is deliberately small and deterministic:

- the first group has a 45-source-word budget;
- later groups have a 72-source-word budget;
- source blocks are never split;
- a heading at the beginning of a group remains attached to the following block;
- a new heading starts a group when the current group is at least half full;
- code, table, and diagram summary blocks end their group;
- a preceding standalone heading may share the summary block's group;
- an oversized block forms one group and is constrained by the output phoneme limit.

These are planning budgets, not acoustic timestamps. Final groups must still resolve to no more than 500 Kokoro phoneme symbols, 16 KB of spoken text, and 64 KB of JSON.

The complete streamed JSON is capped at 2 MB. This is intentionally larger than the earlier sparse-contract limit because full token-local phonemes trade total response size for a mechanically aligned stream. Per-group limits, bounded progress frames, the pending-group queue, and the 60-second no-progress watchdog remain the operative streaming backpressure boundaries.

## Compact input contract

The request has the following shape:

```json
{
  "v": 5,
  "g": [
    {
      "i": 0,
      "u": [
        {
          "i": 0,
          "k": "p",
          "m": "n",
          "x": "Record the record before starting ONNX Runtime.",
          "w": [
            { "i": 0, "x": "Record", "h": "ɹˈɛkɚd", "q": ["context"] },
            { "i": 1, "x": "the", "h": "ðə" },
            { "i": 2, "x": "record", "h": "ɹˈɛkɚd", "q": ["context"] },
            { "i": 3, "x": "before", "h": "bᵻfˈɔɹ" },
            { "i": 4, "x": "starting", "h": "stˈɑɹɾɪŋ" },
            { "i": 5, "x": "ONNX", "q": ["oov", "initialism", "technical"] },
            { "i": 6, "x": "Runtime", "q": ["technical"] }
          ],
          "r": [{ "k": "inlineCode", "w": [5, 6] }]
        }
      ]
    }
  ]
}
```

Short field names keep whole-document input and streamed output bounded. Source word ids are global and stable for the request. Model-visible data never contains renderer target ids or offsets.

### Source tokenizer

The tokenizer uses Unicode letter/number categories and preserves internal apostrophes, periods, underscores, and hyphens:

```text
[letters-or-numbers]+(?:['’._-][letters-or-numbers]+)*
```

Consequently, `source-to-transcript`, `out_of_vocab`, `A.B`, and `don't` are each one token. Output pronunciation targeting uses this same tokenizer rather than raw substring containment.

### Pronunciation-risk labels

`q` is omitted for safe words. It contains one or more of:

| Label | Meaning |
| --- | --- |
| `context` | Curated heteronym or part-of-speech-sensitive pronunciation |
| `ambiguous` | Misaki tagged entry |
| `initialism` | Two or more alphabetic characters are uppercase |
| `technical` | Word overlaps inline code, a link, or an expression |
| `oov` | No direct, compound, or productive-possessive corpus resolution |
| `unsupported` | Corpus pronunciation contains a symbol outside Kokoro's vocabulary |

The curated contextual set includes the observed failures `record`, `lead`, `read`, `close`, and `use`, plus common noun/verb and heteronym hazards. This is deterministic input metadata, not a second model's judgment.

Risk labels focus Sol on contextual and technical hazards. A materially rewritten token carries the relevant source ids. Incidental filenames, URLs, citations, and other source details may be omitted when the spoken sentence preserves the source meaning. Omitted source text creates no unresolved speech; every token that is actually spoken still has explicit phonemes and provenance.

## Streaming output contract

The response has the following shape:

```json
{
  "v": 5,
  "g": [
    {
      "i": 0,
      "u": [
        {
          "i": 0,
          "t": [
            { "x": "Record", "p": "ɹᵻkˈɔɹd", "s": [], "z": " " },
            { "x": "the", "p": "ðə", "s": [], "z": " " },
            { "x": "record", "p": "ɹˈɛkɚd", "s": [], "z": " " },
            { "x": "before", "p": "bᵻfˈɔɹ", "s": [], "z": " " },
            { "x": "starting", "p": "stˈɑɹɾɪŋ", "s": [], "z": " " },
            { "x": "Onnix", "p": "ˈɑnɪks", "s": [5], "z": " " },
            { "x": "Runtime", "p": "ɹˈʌntaɪm", "s": [6], "z": "." }
          ]
        }
      ]
    }
  ]
}
```

### Group and unit identity

The `g` array and each `u` array must exactly mirror the server plan. Group `i` equals its array position. Unit `i` equals the corresponding source block index. The incremental parser may emit a group as soon as its object closes, but Narrate commits it only after checking it against the predeclared plan.

The schema constrains JSON shape. Runtime validation owns dynamic group count, exact unit count, ordering, and identity because JSON Schema cannot express those request-dependent relationships.

### Spoken token records

A `t` record has four required fields:

- `x`: exactly one complete word under the production tokenizer;
- `p`: one non-empty Kokoro-compatible phoneme string for that word, with no whitespace;
- `s`: ordered, unique global source word ids from the same unit when the token materially rewrites them, otherwise empty;
- `z`: the separator following the word, limited to spaces and supported spoken punctuation.

The unit transcript is reconstructed by concatenating each `x` and `z`. Runtime tokenization must reproduce exactly one word span per record at the recorded boundaries. Thus an empty separator cannot accidentally merge adjacent words, punctuation cannot create a compound token, and a pronunciation can never target the wrong occurrence.

When a written expression is spoken as several lexical words, the model emits several records. For example, `37` becomes `thirty` and `seven`; `narration.rs` can become `narration`, `dot`, `R`, and `S`. Each word has its own phonemes. The rewritten records repeat the smallest relevant source-id range in `s`.

Exact unchanged words use `s: []` because the server recovers their source ids by monotonic exact matching. Generated connectives also use `s: []` and inherit the owning block. This keeps provenance truthful without forcing broad sentence-level associations.

### Risk guidance

Risk handling is derived from the token stream rather than repeated in a parallel decision map. Retained words are found by monotonic normalized matching. Material rewrites carry source ids in `s`. Risk metadata remains visible to Sol so it can select context-sensitive phones and natural expansions.

Because every retained or generated token has `p`, a spoken risky word cannot silently fall back to a context-free corpus pronunciation. Omitted incidental source details are not treated as missing G2P work because they produce no speech. No second decision representation is needed.

## Corpus policy

Misaki US gold and silver remain the pronunciation baseline, but not a runtime fallback. Compatible entries are sent as per-source-word hints. Sol copies a simple hint when it is correct in context, chooses from tagged hints, corrects contextual homographs, and supplies phones for rewritten or generated words. Every final spoken token carries explicit phones regardless of whether they originated from a hint.

At job admission, Narrate audits every gold and silver entry against the active Kokoro vocabulary after pinned normalization and records compatible/incompatible counts plus unsupported symbols in the provider profile. Per-word request preparation filters incompatible hints independently. During resolution, the server may label an exactly matching model value with its gold, silver, or compound corpus origin for diagnostics; otherwise its origin is model override. Synthesis never silently substitutes a corpus value for missing model output because missing output is structurally impossible.

### Compatibility normalization

Corpus and model strings remove zero-width formatting characters. Misaki's `n` plus combining syllabic mark is deterministically normalized to Kokoro's supported schwa plus `n` representation, `ᵊn`. Other unsupported symbols, including `ɬ`, are not sent as safe hints and are rejected if they appear in output.

### Productive possessives

When a base word resolves safely, `'s` and `’s` are derived deterministically:

- sibilants receive `ᵻz`;
- voiceless non-sibilants receive `s`;
- other endings receive `z`.

This allows a productive form to be supplied as a useful compatible hint. The final output still contains explicit token phonemes.

## Source mapping and alignment

Each spoken unit is permanently owned by one source block. Within it, mapping priority is:

1. monotonic exact-token matching to a source word;
2. source ids attached directly to a materially rewritten token;
3. source unit block provenance.

Exact words use their renderer word target where present. Rewritten tokens use targets from their `s` source word ids and fall back to the unit block target if needed. Summary words use summary-block provenance. Unmatched connective words use block fallback.

Block fallback is not an old narration fallback. It is a truthful alignment granularity: a generated connective belongs to a visible source block but not to one exact source word.

Kokoro receives the final per-word phonemes and returns native token durations. Those durations produce word cue timestamps. No forced aligner or model-supplied timing exists in the runtime path.

## Incremental validation and commit

For each complete streamed group, Narrate checks:

1. group id equals the next server group;
2. unit count and block ids exactly equal the server plan;
3. token, reconstructed transcript, and JSON bounds;
4. every `x` is exactly one tokenizer word and every `z` preserves the declared token boundaries;
5. token source ids exist, are ordered/unique, and belong to the owning block;
6. every token has one non-empty scalar pronunciation with no whitespace;
7. every pronunciation uses only Kokoro-compatible symbols;
8. every spoken token has explicit valid phones and deterministic exact, rewrite, summary, or block provenance;
9. the reconstructed text, token array, pronunciation array, and cue words have identical cardinality by construction;
10. every spoken word has a non-empty renderer target at word, semantic, summary, or block granularity;
11. the final group stays within Kokoro's 500-symbol limit.

Passing groups are written atomically to the staging plan spool. The worker can synthesize committed groups concurrently but publishes segments in group order. The durable cache is promoted only after the terminal structured result, exact group count, completion digest, worker result, segment sidecars, WAV files, targets, and timing all validate.

## Failure and cancellation

There is no repair model. A primary error names the group, source block, source or spoken word index, token text, and failed invariant where applicable. Already published in-memory segments may finish playback, but failed partial artifacts are never promoted or reused.

Cancellation stops the one primary inference operation and the Kokoro worker. No repair operation exists to cancel. Staging state is removed when no immutable segment remains visible.

The structured turn is bounded at 14 minutes inside the 15-minute Narrate job deadline. This is a terminal-completion bound, not a time-to-first-audio target. A separate 60-second no-progress watchdog still aborts a stalled model or worker even while the longer healthy stream budget remains.

## Model profile

The fixed profile is:

```text
model: gpt-5.6-sol
service tier: priority
reasoning effort: low
reasoning summary: none
thread: ephemeral
tools/apps/web/MCP/plugins/skills: disabled
```

Narrate preflights the exact profile before it starts the worker and verifies the returned profile digest at terminal completion. Terra, GPT-5.5, and other models are neither fallbacks nor checker stages.

## Resource and playback behavior

The direct Narrate methods remain:

- `remux/narrate/narration/start`;
- `remux/narrate/narration/resources/read`;
- `remux/narrate/narration/audio/read`;
- `remux/narrate/narration/cancel`;
- `remux/narrate/narration/diagnostics/read`;
- `remux/narrate/narration/updated`.

The viewer can begin from the first announced immutable segment. Later segments append to the audio engine and timeline. A final manifest is not required to start playback, but only a final manifest is durable and reusable.

## Code ownership

- `extensions/narrate/server/src/streaming.rs`: tokenizer, risk metadata, deterministic grouping, compact request, parser, token validation, corpus provenance, and source mapping.
- `extensions/narrate/server/prompts/primary-v5.txt`: primary linguistic instructions.
- `extensions/narrate/server/schemas/primary-v5.json`: structured output shape.
- `extensions/narrate/server/src/narration.rs`: profile preflight, one primary turn, spool orchestration, cancellation, cache promotion, diagnostics, and direct API.
- `crates/remux-tts/src/corpus.rs`: pinned corpus lookup, normalization, possessives, and phoneme validation.
- `crates/remux-tts/src/streaming_artifact.rs`: Kokoro worker, ordered segment publication, native duration cues, and immutable sidecars.
- `extensions/codex/server/src/structured_inference.rs`: domain-neutral structured inference and progress transport.
- `extensions/codex/shared/narration.ts`: source, resource, manifest v5, segment, cue, and provider types.
- `extensions/codex/viewer/narration/`: progressive audio and source highlighting.

## Required validation

Automated gates:

- corpus lookup, syllabic-`n` normalization, productive possessives, and unsupported-symbol rejection;
- Unicode tokenizer and UTF-16 source offset fixtures;
- deterministic group and immutable unit identity tests;
- schema compatibility with OpenAI Structured Outputs restrictions;
- parser equivalence at every split point and one-byte deltas;
- duplicate-key and malformed-envelope rejection;
- token-local text/phoneme/provenance cardinality and separator-boundary rejection;
- contextual risk labeling and technical rewrite provenance;
- connector block-provenance behavior;
- worker spool, digest, timing, manifest, cancellation, and cache tests;
- viewer progressive playback, cue resolution, and failed-after-prefix behavior.

Live release gates still required:

- at least three first-pass runs on the original failure response and contextual challenge response;
- 100% first-pass validator success without repair;
- Kokoro synthesis through the production model and voice;
- blinded A/B listening for pronunciation, grouping, prosody, intelligibility, and preference;
- real viewer verification of progressive playback and source highlighting.

The implementation is complete when the automated suites pass. Audible quality claims remain provisional until the live listening gates pass.
