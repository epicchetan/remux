# Narrate Streaming Transcript and G2P R&D

Status: R&D evidence
Last verified: 2026-07-13
Canonical code: `tools/narration-rd/`
Related: `docs/specs/narrate-service.md`, `docs/specs/codex/narration-onnx-synthesis.md`
Reproduction assets: `tools/narration-rd/`
Normative implementation spec: `docs/specs/narrate-streaming-g2p.md`

> Historical experiment. The later real-thread contract benchmark in
> `narrate-streaming-g2p-contract-rd.md` supersedes the model-owned block ranges and targeted repair
> recommendation below. Production v5 uses server-owned groups, token-local complete
> pronunciations, and no repair model. The full-phoneme result below became more relevant once
> streaming made total response size less important than first-group latency.

## Decision

Adopt one streaming `gpt-5.6-sol` Priority turn that receives the complete compact source
document and emits ordered narration groups. Each group contains final spoken text, an inclusive
source-block range, and **sparse pronunciation overrides**. Resolve every other spoken word from
the pinned Misaki US gold/silver corpus locally.

Do not make a second model an always-on phoneme stage. A `gpt-5.5` transcript followed by a Sol
phoneme audit improved correctness but moved the measured first usable patch to about 30 seconds
when the stages were sequential. A Mini audit still took about 19 seconds, emitted an unsupported
phoneme, and failed to correct contextual homographs. Use a targeted Sol repair only when local
validation finds an unresolved word or invalid override in one group.

The experiment originally proposed a hard v4 replacement with no runtime fallback to the
current planner, frontend, model profile, or cache reader. The active v4 spec
was subsequently superseded by v5; the normative spec supersedes this R&D document wherever
implementation details differ.

## What the experiment tested

The fixture combines:

- ordinary prose and short heading/list fragments that need acoustic grouping;
- dense code that should be summarized rather than read literally;
- contextual homographs: `lead`, `record`, `close`, and present/past `read`;
- technical expressions: ONNX, G2P, UTF-16, WKWebView, JSON-RPC, Rust identifiers, package names,
  model slugs, EPIPE, SQL, nginx, Kubernetes, SQLite, an IPv4 address, and port 8080;
- units and quantities such as p95, 1.2 seconds, 240 milliseconds, and M2 Max.

Every source word received a stable integer id. Exact Misaki corpus entries were supplied as hints.
The output validator checked group order and coverage, source-word references, the Kokoro phoneme
alphabet, the 500-code-point group budget, and whether every final spoken word was resolved by a
corpus entry or a model override. App-server `item/agentMessage/delta` notifications were recorded
to measure the first syntactically complete group, not merely the first token.

This is a focused architecture experiment, not a MOS study. The IPA and transcript outputs were
inspected for semantic and pronunciation errors, but the run did not include blinded human
listening scores. Production rollout still needs generated-audio A/B listening and a larger replay
corpus.

## Results

### Full-phoneme joint contract

The first contract asked the model to return a phoneme sequence for every spoken token. It proved
that Codex can do context-sensitive G2P, but the output is too large for the desired stream.

| Model | Tier | First complete group | Total | Result |
| --- | --- | ---: | ---: | --- |
| GPT-5.6 Sol | Priority | 12.7s | 52.8s | Correct contextual set and code summary; only a Misaki zero-width joiner needed local stripping. |
| GPT-5.6 Terra | Priority | 12.8s | 51.2s | Valid and correct on the contextual set. |
| GPT-5.6 Luna | Priority | 12.9s | 44.9s | Repeated unsupported `ɝ` and changed `10.0.0.8` to `10.0.0.0.8`. |
| GPT-5.5 | Priority | 12.1s | 49.5s | Valid and correct on the contextual set. |
| GPT-5.4 Mini | Standard | 20.9s | 64.1s | Wrong contextual pronunciations, literal code punctuation, and unsupported phonemes. |
| GPT-5.3 Codex Spark | Standard | 32.8s | 42.1s | Output was effectively buffered, source references were invalid, and contextual G2P failed. |

Sol, Terra, and GPT-5.5 demonstrated the capability. Producing roughly 7.5–9 KB of repetitive
phoneme JSON delayed completion to about 50 seconds, however. This should remain a diagnostic
contract rather than the production format.

### Sparse-override contract

The sparse contract returns final spoken text plus overrides only for technical/OOV spans and
contextually incorrect corpus hints. Local code fills ordinary words from the corpus.

| Model/run | First complete group | Total | Bytes | Result |
| --- | ---: | ---: | ---: | --- |
| Sol Priority, initial | 10.2s | 17.1s | 2,181 | Three unresolved outputs; two were deterministic hyphen splits and one needed an override. |
| Sol Priority, tightened | 10.4s | 25.7s | 3,824 | Fully resolved, supported alphabet, correct contextual set, valid grouping and source references. |
| GPT-5.5 Priority, initial | 8.9s | 18.0s | 2,778 | One splittable compound unresolved and one contextual correction missed. |
| GPT-5.5 Priority, tightened | 25.7s | 37.0s | 3,832 | Fully valid, but first-group latency varied by almost 3x. |
| Terra Priority | 24.7s | 34.9s | 3,036 | Failed to override Kokoro and Misaki despite their missing corpus hints. |

Sol's first usable group was stable at 10.2–10.4 seconds across the two sparse runs. GPT-5.5 had a
lower best case but an unacceptable 8.9–25.7 second spread. The tightened Sol output explicitly
handled every occurrence of the contextual words and every unresolved technical/name span.

### Two-model chain

The chain used GPT-5.5's immutable spoken transcript and performed a phoneme-only audit over
post-transcript corpus lookups.

| Audit model | Audit first group | Audit total | Result |
| --- | ---: | ---: | --- |
| Sol Priority | 21.2s | 24.2s | Valid, resolved all OOV words, and corrected contextual homographs. |
| GPT-5.4 Mini | 19.2s | 20.0s | Unsupported `ɝ`; patched only corpus misses and skipped contextual corrections. |

Sequential 5.5→Sol therefore needs about 30 seconds before the first audited group. Per-group
pipelining would reduce that number but would create many turns, repeat context, and complicate
ordering and cancellation. The measured quality does not justify that cost as the default path.

## Recommended model contract

Send the complete compact document once. Do not send renderer target objects or durable string ids.
For each source block send:

- integer block id, source kind, and server-selected `normalized` or `summary` mode;
- exact display text;
- stable integer source-word ids;
- exact gold/silver corpus candidate when present;
- compact semantic ranges for inline code, identifiers, links, math, and other technical spans.

Stream one outer structured object whose `groups` array contains records shaped conceptually as:

```json
{
  "id": 0,
  "blocks": [0, 2],
  "text": "Final natural spoken text for the contiguous block range.",
  "overrides": [
    {
      "text": "ONNX",
      "occurrence": 0,
      "phonemes": "...",
      "sourceWordIds": [14]
    }
  ]
}
```

`blocks` is an inclusive range. `text` is immutable once the closing brace is received.
`occurrence` disambiguates repeated output text without asking the model for character offsets.
After validation, Narrate replaces the exact-text reference with server-owned spoken-word ids.

The model must override:

- every final technical/name span derived from source words with no corpus hint;
- every occurrence of a context-sensitive word it identifies, including occurrences whose supplied
  hint remains correct;
- any generated word or phrase not present in the pinned corpus.

Ordinary words stay out of the model's phoneme output. Narrate tokenizes the final text, performs
gold-then-silver lookup, splits deterministic hyphen/underscore compounds, applies overrides, and
rejects the group if any word remains unresolved. There is no silent fallback pronunciation.

## Grouping policy

The model should see the whole document for discourse and pronunciation context while committing
groups in source order. Use soft output targets rather than fixed block counts:

- first group: approximately 25–45 spoken words or 8–15 seconds;
- later groups: approximately 40–80 spoken words or 12–25 seconds;
- prefer complete sentences and join short headings/fragments to adjacent prose;
- keep dense code, table, and diagram summaries in the same group as their introducing heading;
- hard cap the final combined phonemes at 500 code points for Kokoro;
- do not split inside an identifier expansion, URL, numeric expression, or override span.

The source document limit is already large enough for the observed long artifact. If a future input
exceeds the gateway's 2 MB input or 256 KB output bounds, use ordered windows with a small read-only
context preface from the previous window. Do not return to independent 20-block turns for ordinary
documents because that prevents one coherent stream and repeats input context.

## Streaming pipeline

```text
Codex agent-message deltas
        │
        ▼
incremental groups-array parser
        │ complete group object
        ▼
prefix + corpus + override + source-map validation
        │ atomic plan/NNN.json
        ▼
persistent workload-governed Kokoro worker
        │ immutable WAV + cues + segment sidecar
        ▼
Narrate availableSegments
        │
        ▼
Codex viewer append-only playback buffer
```

### 1. Correlated inference progress

The current structured gateway ignores `item/agentMessage/delta` and returns only the completed
message. Add correlated progress to extension RPC rather than a Narrate-specific callback:

- `remux/codex/inference/structured/generate` retains its final validated response;
- while the request is active, Codex forwards agent-message text deltas as `$/progress` frames tied
  to the originating JSON-RPC request id;
- the host routes progress only to the calling extension, just as it routes the final response;
- `remux-extension-rpc` accepts a bounded progress callback/channel;
- cancellation and the bounded host deadline remain correlated with the same request. The final
  implementation aligns that turn deadline with the 15-minute Narrate job budget because a healthy
  complete-token stream can outlive the earlier four-minute structured-inference limit.

This keeps the structured gateway domain-neutral and avoids broadcasting private inference deltas to
viewers or coupling Codex directly to Narrate.

### 2. Incremental parsing and commit validation

Narrate incrementally parses completed elements of the constrained `groups` array. A group becomes
committable only when all of these pass:

- next sequential group id;
- contiguous block range beginning at the next uncovered block;
- text and phoneme budgets;
- valid, monotonic source-word references inside the group's block range;
- exact override substring and occurrence resolution;
- non-overlapping overrides;
- supported Kokoro phoneme alphabet after removing corpus zero-width joiners;
- every spoken word resolved by gold/silver corpus, deterministic compound splitting, or override;
- honest deterministic source mapping for exact words and semantic/block fallback for rewrites.

The final turn still undergoes full JSON-schema validation and must end on the last source block.
Prefix segments may be played before that final validation, but a failed suffix is never promoted to
the durable cache.

### 3. Keep Kokoro loaded with an append-only spool

`remux-compute::Task` currently accepts one finite input and closes worker stdin, so it cannot accept
later groups directly. Avoid one task and ONNX load per group. Use the existing task boundary with an
append-only staging spool:

1. On a cache miss, Narrate creates the staging directory and starts one managed Kokoro task whose
   static input points at the spool.
2. The worker loads the model once (about 0.7 seconds in the observed artifacts) while Codex is
   planning, then waits for numbered atomic `plan/NNN.json` files.
3. Narrate writes each validated group to a temporary file and renames it into the spool.
4. The worker synthesizes ready groups with bounded concurrency, reorders completion by group id,
   and publishes immutable WAV/segment sidecars in order.
5. Narrate writes an atomic completion sentinel after the final model response validates. The worker
   then writes the final manifest and exits normally.
6. Cancellation kills the managed task and removes the staging directory. A promoted final artifact
   retains the existing "complete artifact wins" race rule.

This preserves Remux workload governance, overlaps the ONNX load with model latency, and avoids a
new bidirectional compute protocol. A later general streaming-task protocol may replace the spool,
but it is not required for the first implementation.

### 4. Decouple acoustic groups from source units

The current worker synthesizes one source block per unit and adds a pause after each unit. Natural
grouping requires a new separation:

- an **acoustic group** is one continuous Kokoro input with no forced pause at internal block
  boundaries;
- source targets and alignment hints may span several blocks;
- timed narration units and block navigation are derived from source-mapped token cues after
  synthesis, rather than defining the acoustic boundary;
- the group boundary supplies the actual pause and immutable audio-segment boundary.

The frontend should accept server-tokenized spoken words with optional phoneme overrides. It should
not rerun the current fallback G2P over an already resolved override span.

### 5. Progressive viewer behavior

The service already reports immutable available segments. Update the viewer so `synthesizing` plus
one available segment is playable:

- build playback from the segment prefix instead of waiting for the final manifest;
- preload the next available segment;
- when playback reaches the current prefix end and the job is active, enter `buffering`, not `ended`;
- resume automatically when an update publishes the next segment;
- allow seeking only through `availableDuration` until completion;
- keep cues and targets segment-local and immutable;
- retain final-manifest playback for cached completed artifacts.

## Backpressure, repair, and failure policy

- Bound the parsed-but-unsynthesized queue by group count and total phoneme count.
- Let the Kokoro worker use its granted workload threads and an ordered result buffer; do not create
  an unbounded native pool.
- If a group has unresolved words, hold only that group and request a small Sol repair containing
  the final spoken tokens and their post-transcript corpus lookups. Continue parsing later groups,
  but do not publish past the gap.
- Cache accepted technical pronunciations by normalized phrase, locale, voice/frontend version, and
  optional project pronunciation profile. Do not cache a homograph without context.
- If repair fails, mark the artifact failed-after-prefix, let already-playing audio stop cleanly at
  the last valid segment, and never promote the staging artifact.
- Preserve exact diagnostics: model group, corpus misses, rejected symbols, repair request, native
  synthesis timing, buffer underruns, and final promotion state.

## Cache and version identity

Add these to artifact identity:

- streaming contract and incremental parser versions;
- grouping prompt and policy versions;
- source-word tokenizer and deterministic mapper versions;
- hashes of the exact Misaki gold and silver corpora;
- sparse override validator and compound-splitting versions;
- planner model, tier, and reasoning effort;
- pronunciation repair profile when used;
- Kokoro model, voice, vocabulary, and synthesis option versions.

A group prefix may be retained for diagnostics, but only a complete validated artifact is reusable as
a narration cache hit.

## Adoption sequence

1. Add the sparse group types, corpus loader, validator, and replay tests without changing production
   planning.
2. Add correlated structured-inference progress and verify delta ordering, cancellation, overload,
   target restart, and bounded buffering.
3. Add the append-only synthesis spool and persistent Kokoro task; replay deterministic fake groups
   before enabling live inference.
4. Exercise v4 through unreachable library/integration fixtures while production
   still runs the current checked-in path; do not add a runtime selector.
5. Atomically cut the service and viewer over to v4 and delete the v3 runtime
   path.
6. Run a sanitized real-response corpus plus blinded listening tests. Gate on semantic preservation,
   contextual pronunciation, OOV coverage, time to first audio, underrun rate, and cancellation
   cleanup.
7. If live validation fails, fix v4 or revert with Git; do not add a runtime
   fallback.

## Proposed rollout gates

- 100% ordered block coverage and source-reference validity;
- 100% spoken-word resolution before group publication;
- zero unsupported phoneme symbols after deterministic normalization;
- no semantic mutations in addresses, versions, quantities, identifiers, or code summaries;
- at least 99% correct contextual pronunciation on a curated heteronym set;
- median first complete group at or below 12 seconds and p95 below 18 seconds on Priority;
- first audio at or below 14 seconds median after overlapping model load and first-group synthesis;
- no playback underrun on the reference long artifact after the first segment;
- cancellation leaves no staging artifact and no live model/compute operation;
- blinded listening preference or non-inferiority versus the current Misaki frontend on ordinary
  prose, with a clear win on technical/OOV material.

## Reproduction

All heavy runs were executed through the Remux `research` workload with one granted thread. The
checked-in harness uses a minimal tool-free, read-only, ephemeral app-server thread and captures
real agent-message deltas. Example:

```bash
remux workload exec \
  --workload research \
  --operation codex-rd:sparse-sol \
  --threads 1 \
  -- python3 tools/narration-rd/run_sparse_experiment.py \
       --model gpt-5.6-sol \
       --service-tier priority \
       --result /tmp/narration-rd/sparse-sol.json
```
