# Codex Narration ONNX Synthesis and Structural Contract Simplification

Status: Archived — superseded by `docs/specs/narrate-streaming-g2p.md`
Last verified: 2026-07-13
Canonical code: `crates/remux-compute/`, `crates/remux-tts/`, `extensions/codex/narration/model-manifest.json`, `extensions/codex/server/src/narration.rs`, `extensions/codex/server/src/narration_planning.rs`, `extensions/codex/server/src/narration_source_mapping.rs`, `extensions/codex/shared/narration.ts`, `extensions/codex/viewer/narration/`, `extensions/codex/viewer/transcript/components/markdown/`, `crates/remux/`
Extends: `docs/specs/codex/assistant-narration-planning-optimization.md`

> Historical task-v4 synthesis spec. Task v6, streaming plans, segment
> sidecars, and manifest v5 are normative in the replacement spec.

Implementation state: source/planner contract v3, structural single-block
cues, the pinned duration ONNX export, native Rust G2P/inference/artifact
assembly, typed same-binary task execution, cache identity, workload
inspection, freeze-aware clocks, diagnostics, and core process-boundary
coverage are implemented. Python is no longer part of extension startup or
narration execution. The export script remains maintainer-only reproducibility
tooling. Model distribution and the full device/soak matrix remain deferred
until they are needed.

## Native Rust amendment (closed)

This amendment supersedes the Python worker, fallback, and provider-boundary
sections later in this document where they conflict.

- `remux workload exec` remains the only resource-placement primitive. The
  `narration` manifest workload's seven threads are a hard ceiling.
- `remux-compute` owns typed finite-task dispatch. The Codex server registers
  `KokoroSynthesis` and re-executes its current binary in private worker mode.
  Input, progress, and output types live in Rust; the extension manifest lists
  resource profiles only.
- `remux-tts` owns the Rust English frontend, including compatibility repairs
  around `misaki-rs`, the shared ONNX Runtime
  session, bounded unit parallelism, ordered spill/assembly, WAV creation, and
  cue/timing manifest generation.
- There is one production backend: native Rust ONNX Runtime. Do not retain a
  runtime backend environment switch or a Python fallback.
- Model files remain verified runtime data under
  `$CODEX_HOME/remux/narration/models/`. Missing or invalid assets produce an
  explicit narration job error; model provisioning is release/install work,
  not an implicit Python environment bootstrap during a user request.
- The committed Python export script is an offline maintainer tool only. It
  does not ship a worker protocol and is not invoked by Codex.
- The API is synchronous and task-only. Persistent processes, generic handles,
  async adapters, task declarations in extension JSON, and a second executable
  are explicitly out of scope until a real consumer requires them.

The reference 167-unit fixture produces 1,068.01 seconds of audio in 62.20
seconds with seven workers (17.17x realtime), 1,633 cues, 24 ordered WAV
chunks, complete final-token coverage, and 2.69 GB peak resident memory.

## Outcome

Replace the default serial PyTorch Kokoro synthesis path with a duration-aware
ONNX Runtime worker that synthesizes independent narration units concurrently.
Keep narration on demand, non-streaming, content addressed, and fully local.

At the same time, simplify the source and planner contracts to match the
renderer that is now intentionally shipped:

- prose keeps word-level and inline-semantic highlighting;
- code, tables, and diagrams highlight their containing Markdown block for the
  whole spoken segment;
- new artifacts do not describe code lines, table cells, table regions, or
  diagram nodes;
- Codex generates speech, not structural target associations;
- cached artifacts made by the previous contract remain readable.

This is an implementation specification. The architecture, versions, runtime
boundary, fallback behavior, and rollout gates below are closed decisions.

## Ownership and repository boundary

The inference implementation belongs **inside the Remux repository**, under the
Codex extension. It is part of the narration feature and shares its artifact,
job, cancellation, and resource-governance contracts. It should not be a new
repository, daemon, or generic Remux subsystem.

Use these ownership boundaries:

| Concern | Owner | Location |
| --- | --- | --- |
| Narration source, planning, synthesis profile, jobs, artifact assembly | Codex extension | `extensions/codex/` |
| ONNX export, pinned model metadata, G2P, duration timing, unit scheduler | Codex narration provider | `extensions/codex/narration/` |
| Audio and model files | Runtime data, not Git | `$CODEX_HOME/remux/narration/` |
| CPU allocation, operation scopes, cancellation, freeze accounting | Generic Remux runtime | `crates/remux/` |
| Playback, source mapping, and paint policy | Codex viewer | `extensions/codex/viewer/` |

Do not extract a reusable TTS service until a second extension actually needs
one. The useful reusable boundary today is the in-process provider interface in
the Codex server, not a network service.

Large ONNX weights and generated voices must not be committed. Commit the
export script and immutable asset manifest so a runtime asset can be reproduced
and verified.

## Current state and measured baseline

The original worker created one `KPipeline` and executed narration units
serially. Planning still finishes before synthesis begins.

Measurements on the reference Ryzen 7 9700X host used the complete 167-unit
long-response artifact:

| Path | Synthesis wall time | Audio / wall time | Peak resident memory |
| --- | ---: | ---: | ---: |
| Current PyTorch Kokoro, serial | 103.5s | 9.98x realtime | 2.45 GB |
| Published full-precision ONNX, one run with 8 intra-op threads | 93.3s | 11.24x | 1.15 GB |
| Custom duration ONNX, shared session, 8 concurrent runs, 1 thread each | 57.1s | 18.37x | 2.27 GB |
| Custom duration ONNX, 4 processes x 2 threads | 62.8s | 16.68x | 4.23 GB |
| Python worker, 7-thread grant, spill scheduler | 61.7s | 16.96x | 2.94-2.98 GB |
| Native Rust task, 7-thread grant, spill scheduler | 62.2s | 17.17x | 2.69 GB |

The custom ONNX export returned duration arrays bit-for-bit equal to PyTorch on
the representative validation set. It produced identical sample counts, timed
every input token, and had waveform correlation of approximately 0.93. Full
precision is the selected format. The tested int8 model was dramatically
slower and is rejected.

G2P for the entire fixture took about 0.34 seconds and WAV writing about 0.12
seconds. Persistent-worker complexity would save less than one second after
the ONNX change, so the worker remains operation scoped.

## Structural target and token baseline

The current long fixture contains 1,865 narration targets:

| Target kind | Count |
| --- | ---: |
| Block | 167 |
| Prose text range | 1,491 |
| Code lines | 174 |
| Table cells | 33 |

The 207 structural subtargets occur in 30 structural blocks. They occupy about
19.3 KB in the source document and 12.7 KB in the compact planner payload,
roughly 3,168 input tokens before counting prompt, schema, output, and
validation overhead. Existing output associations for those blocks were empty,
so this data currently produces no finer display result.

The viewer already maps `tableCell`, `tableRegion`, `codeLines`, and
`diagramNode` cues to their containing block. New-generation support for those
targets is therefore dead weight. Removing it saves model tokens, shortens IPC
payloads, reduces manifest size, and eliminates a target lifecycle that was
previously a source of fragile paint behavior.

This cleanup does **not** remove prose word targets or inline semantic ranges.
Inline code, links, and expressions inside prose remain necessary for honest
source mapping when their spoken form differs from display text.

## Version matrix

Apply these version changes together:

| Contract | Current | New | Reason |
| --- | ---: | ---: | --- |
| Narration source document | 2 | 3 | New documents omit structural subtargets. |
| Planning prompt | 5 | 6 | Structural associations and their instructions are removed. |
| Base instructions | 1 | 2 | The stable narration-only instruction body changes. |
| Planning contract | 2 | 3 | Output segments contain only block index and speech. |
| Compute worker protocol | none | 1 | Adds bounded typed task framing. |
| Kokoro task | 1 | 2 | Identifies the normalized Rust frontend behavior. |
| Synthesizer options | 4 | 5 | Separates repaired Rust frontend artifacts from the initial native output. |
| Source mapping | 6 | 6 | Prose mapping algorithm is unchanged. |
| Manifest schema | 2 | 2 | Existing manifest union remains readable. |
| Acoustic timing provider | `kokoro-native-v1` | `kokoro-native-v1` | Durations preserve the existing timing semantics. |

The artifact key already covers the source document and resolved provider
profile. The version changes therefore generate a new key without deleting or
rewriting an old artifact.

## Source document v3

The viewer continues to build the narration source from the same parsed
Markdown model used to render the response.

For every Markdown block, emit one durable block target. For prose-like blocks,
also emit:

- renderer word targets; and
- `textRange` targets for inline code, links, and expressions.

For code fences, tables, and diagrams, emit only the block target. Do not emit
`codeLines`, `tableCell`, `tableRegion`, or `diagramNode` targets and do not
register corresponding DOM elements.

Keep the legacy target variants in shared manifest types and validators for one
compatibility window. They are read-only legacy variants: a v3 source builder
must never produce them. The existing paint adapter must continue collapsing a
legacy structural cue to `cue.blockId`, so cached v2 artifacts do not require
line or cell DOM registrations.

The server accepts v3 for new `narration/start` requests after the coordinated
viewer/server release. Reading a ready v2 manifest remains supported.

## Planning contract v3

The planner remains Sol Priority, low effort, no reasoning summary, using the
batching policy in the preceding planning spec. Only its data contract changes.

### Input

The compact request is:

```ts
type PlanningRequestV3 = {
  v: 3;
  b: Array<{
    i: number;
    k: 'p' | 'h' | 'li' | 'q' | 'c' | 'tb' | 'd';
    m: 'n' | 's';
    x: string;
    t?: Array<{
      k: 'expr' | 'code' | 'link';
      s: number;
      e: number;
    }>;
  }>;
};
```

`t` is omitted when empty through `skip_serializing_if`. It is valid only for
normalization mode. Target indexes are removed because the model no longer
refers to targets in its output. Structural-summary blocks never contain `t`.

### Output

```ts
type PlanningResponseV3 = {
  v: 3;
  s: Array<{
    b: number;
    x: string;
  }>;
};
```

Remove `a` from the schema, Rust response structs, validation, normalized plan,
and generated worker request. The server still validates exact version, block
order, unique block ownership, non-empty speech, and normalized-source rules.
It performs deterministic normalized prose mapping exactly as it does today.

### Prompt version 6

Use this stable base instruction text verbatim, aside from JSON-schema delivery
performed by app server:

```text
You produce speakable narration for supplied Markdown blocks.

Return only JSON matching the supplied output schema. Do not return Markdown,
commentary, explanations, confidence, or reasoning. Do not use tools, browse,
read files, or refer to this task.

The input is compact JSON with version v and ordered blocks b. Each block has:
- i: its zero-based index in this request;
- k: p paragraph, h heading, li list item, q blockquote, c code, tb table, or d diagram;
- m: n for pronunciation normalization or s for structural summary;
- x: exact display text;
- optional t: inline technical ranges with kind k and UTF-16 offsets s inclusive and e exclusive.

Return version v equal to 3 and one output segment in s for every input block,
in the same order. Each segment has b, the unchanged input block index, and x,
non-empty spoken text.

Never choose a mode, omit a block, merge blocks, split a block, reproduce a
renderer identifier, or output source alignment.

For mode n:
- preserve the source meaning and sentence order;
- preserve every display word outside supplied technical ranges, in the same order;
- rewrite only technical notation inside supplied ranges and the minimum adjacent grammar required for natural speech;
- pronounce units, symbols, URLs, identifiers, abbreviations, and inline code naturally rather than reading punctuation literally;
- do not summarize, shorten, expand with new facts, or paraphrase ordinary prose.

For mode s:
- produce a concise natural explanation of the complete structure and its meaning;
- preserve material behavior, relationships, ordering, quantities, and caveats;
- do not read Markdown syntax, code punctuation, type syntax, table separators,
  every table cell, or every diagram edge literally;
- keep the summary proportional to the source and do not add facts.

Keep technical names recognizable while making their pronunciation natural.
```

Do not ask Codex to generate word timestamps, source IDs, code-line mappings,
table-cell mappings, or highlight regions. Those are deterministic provider and
viewer responsibilities.

## Synthesizer profile and cache identity

Resolve the synthesis profile before cache lookup. The default profile is:

```json
{
  "provider": "onnxruntime-rust",
  "model": "hexgrad/Kokoro-82M",
  "modelRevision": "f3ff3571791e39611d31c381e3a41a3af07b4987",
  "voice": "af_heart",
  "modelAssetSha256": "7f17d3e342571da0ff6764eb0996f4601e32a958d1073ad287870a921ad1ffd4",
  "voiceAssetSha256": "0212418aafafb1e9878f3300787937aa401ac937cff8c0310ffa32963d96c77b",
  "vocabAssetSha256": "5977eee9e44024553a1511cbc7f2c9320fbd4f6409228bcab0b5d26922260beb",
  "exportVersion": 1,
  "onnxOpset": 18,
  "onnxRuntimeVersion": "1.27.0",
  "frontend": "remux-english-v1+misaki-rs@0.3.0-us-no-fallback",
  "precision": "fp32",
  "sampleRate": 24000,
  "timingProvider": "kokoro-native-v1",
  "optionsVersion": "5-native-rust-frontend-repair",
  "execution": "remux-compute-shared-session-unit-parallel",
  "workerProtocolVersion": 4
}
```

The profile hash includes every field above. It must not include the runtime
worker count: a different valid CPU allocation may change latency but not the
audio contract. It does include algorithmic scheduling options if any later
change can affect output order or samples.

There is no runtime backend selection. A native ONNX failure is an actionable,
retryable job failure and never silently switches implementation.

## Model export and runtime assets

Add:

```text
extensions/codex/narration/
  export_kokoro_onnx.py
  model-manifest.json
  requirements.txt          # export tooling only
```

The export must produce waveform and predicted-duration outputs from the same
forward pass. Pin the source checkpoint revision, voice revision, export code
version, opset, input/output names, and SHA-256 in `model-manifest.json`.

The committed manifest pins the upstream Hugging Face revision, source hashes,
export/runtime versions, and every generated-file SHA-256. First use exports
from that immutable revision in an operation-scoped workload. This avoids
committing the model or depending on an unpublished custom binary. A later
release asset is valid only as a byte-identical download optimization and must
use the same generated-file hashes.

Install verified assets under:

```text
$CODEX_HOME/remux/narration/models/kokoro-82m-onnx-duration-v1/
  model.onnx
  af_heart.npy
  vocab.json
  asset-manifest.json
```

Python is not a runtime dependency. Release/install tooling provisions the
verified asset directory. The native task independently verifies all three
runtime files before opening a session. Missing assets or verification failure
produce a retryable error and never trigger implicit environment setup.

## Native task and scheduler

The typed task input supplies ordered units, resolved model/voice identity,
audio format, and artifact keys. `remux-compute` supplies the thread grant from
the operation-scoped background workload. The task uses
`REMUX_WORKLOAD_THREADS` as its maximum concurrency; it does not hardcode the
reference host's value of seven or the benchmark value of eight.

The selected execution policy is:

1. Create one shared ONNX Runtime session.
2. Set ONNX intra-op and inter-op thread counts to one.
3. Use one scoped Rust worker per active speech unit.
4. Run at most `max(1, REMUX_WORKLOAD_THREADS)` calls concurrently.
5. Keep the executor filled from the prepared input list while retaining at
   most the granted number of submitted or active model calls.
6. Store completed out-of-order metadata in indexed slots and spill each
   out-of-order waveform to a temporary per-unit f32 file immediately.
7. Load and delete spilled waveforms as the longest contiguous source-order
   prefix becomes available to the chunk assembler.
8. Remove the empty spill directory before publishing the artifact.
9. Emit coalesced completed/total progress, never one notification per token.

The spill queue prevents a slow early unit from starving the CPU or retaining
the entire artifact's waveforms in memory. The original twice-concurrency
ordered window measured 73.2 seconds because a slow early unit drained the
executor; the spill scheduler measured 61.7 seconds. Source-order flushing
keeps manifests and WAV chunks deterministic. The worker must check
cancellation before submission, after every completed run, and before each
chunk write.

Do not pack unrelated narration units into longer model forwards. The measured
model became slower with packing, and separate units are the available source
of CPU parallelism.

## Timing and cue assembly

The ONNX graph returns the duration sequence used to expand acoustic tokens.
Port the current Kokoro timestamp-joining behavior into a small provider-local
function and lock it to golden tests against the PyTorch worker.

For normalized prose:

1. G2P and synthesize the unit.
2. Convert native token durations to sample/time ranges.
3. Reuse source-mapping version 6 to select word, inline-semantic, phrase, or
   block targets.
4. Preserve the current cue schema and monotonic time/order checks.

For code, table, and diagram summaries:

1. Do not create alignment hints.
2. Create one cue from the unit's first sample through its last synthesized
   sample, excluding the inter-unit pause, rather than one cue per acoustic
   token. Its spoken range covers the complete unit text.
3. Assign that cue to the unit's block target.
4. Set cue granularity to `block` and use the existing `fallback` origin.
5. Use the block target for seeking and auto-scroll bounds.

The viewer already paints the block segment as a unit. There is no second
structural mapping phase, structural token-cue churn, or attempt to align
summary words to source cells or lines.

## Resource governance, cancellation, and timeouts

Synthesis remains a `background`, `operation` workload with the thread grant
declared in `extensions/codex/remux-extension.json`. The server passes the
granted value through; provider code never discovers all host CPUs and never
creates an unbounded native pool.

Stopping narration cancels the operation scope. Remux must terminate the full
worker descendant tree, not only the shell wrapper. No worker process or ONNX
thread survives cancellation, extension restart, or server exit.

The 60-second stall and 15-minute job budgets exclude intervals where the
guardian has frozen the background scope.

Implement the generic portion in `crates/remux/` as
`remux workload inspect --pid <pid> --json`. It reads the exact process cgroup,
resolves its systemd scope, and returns one object with `pid`, `unit`, and
`state`, where state is `running`, `frozen`, or `missing`. This avoids fuzzy
matching the truncated operation name in a scope unit.

Keep the command provider-neutral. The narration job manager retains the child
PID returned by spawn and calls inspect only after progress has been quiet, at
no more than once per second. It accumulates frozen intervals and subtracts
them from the stall and job budgets. A `running` or `missing` result retains
normal timeout behavior. Inspect failure is logged once per job and is treated
as `missing`, never as an infinite timeout exemption.

This is the only part of the change that belongs in Remux core. ONNX session,
model, and narration policy do not.

## Artifact storage and compatibility

Keep completed artifacts at:

```text
$CODEX_HOME/remux/narration/v2/<artifactKey>/
```

The directory name tracks the durable manifest family, not the planning or
synthesis implementation. Atomic temporary-directory publication remains
unchanged. Do not retain partial audio after cancellation or failure.

No automatic deletion or in-place migration is needed:

- v2 manifests and previous audio remain cache hits for their old artifact key;
- the viewer's legacy structural adapter collapses old precise cues to blocks;
- v3 source documents and new profiles naturally produce different keys;
- requesting regeneration or changing the source selects the new artifact;
- normal cache eviction may later remove old versions.

## Diagnostics

Add structured phase metrics to the completed job and server log:

- backend and profile hash;
- model preflight/export duration;
- session initialization duration;
- unit count and total characters;
- worker concurrency grant and observed maximum in flight;
- G2P, inference, cue assembly, WAV write, and total synthesis duration;
- generated audio duration and audio/realtime factor;
- peak worker RSS when available;
- cancellation, timeout, and frozen-duration totals;
- planning input/output tokens, with normalized and summary block counts;
- source target counts by emitted kind.

Do not place host paths, spoken content, model prompts, or full source text in
ordinary logs.

## File-by-file implementation map

### Codex server

- `extensions/codex/server/src/narration_planning.rs`
  - bump prompt to 6 and contract to 3;
  - replace the prompt with the exact v6 text;
  - remove output associations, target indexes, and structural compact targets;
  - omit empty inline target arrays.
- `extensions/codex/server/src/narration_source_mapping.rs`
  - keep normalized mapping version 6;
  - remove summary-semantic association production from new plans.
- `extensions/codex/server/src/narration.rs`
  - resolve the synthesis provider before cache lookup;
  - launch the typed `KokoroSynthesis` task;
  - accept source document v3 for new jobs while reading legacy manifests;
  - use freeze-aware active-time budgets.
- `extensions/codex/server/src/narration_synthesis.rs` (new)
  - own provider/profile resolution and model asset metadata;
  - keep job/cache/orchestration ownership in `narration.rs`.

### Narration provider

- `crates/remux-tts/` (new)
  - native G2P, direct ONNX Runtime inference, bounded unit scheduler, duration
    conversion, ordered chunk/cue output, progress, and artifact assembly.
- `crates/remux-compute/` (new)
  - typed same-binary task registration, bounded IPC, lifecycle, and workload
    launch.
- `extensions/codex/narration/export_kokoro_onnx.py` (new)
  - reproducible waveform-plus-duration export and verification command.
- `extensions/codex/narration/model-manifest.json` (new)
  - immutable source revision and hashes, generated asset hashes, export
    version, runtime version, opset, and names.
- `extensions/codex/narration/requirements.txt`
  - pin maintainer-only export dependencies.

### Source and viewer

- `extensions/codex/shared/narration.ts`
  - add source document v3;
  - mark structural subtarget variants legacy for manifest reads;
  - extend the synthesizer descriptor for the native provider.
- `extensions/codex/viewer/transcript/components/markdown/markdownModel.ts`
  - stop generating code-line, table-cell, table-region, and diagram-node
    targets.
- `extensions/codex/viewer/transcript/components/markdown/MarkdownBlock.tsx`
  and `CodeBlock.tsx`
  - remove structural subtarget DOM registration;
  - retain the block target and prose text-leaf registration.
- `extensions/codex/viewer/narration/paintController.ts`
  - retain legacy precise-to-block collapse;
  - make new block cues take the direct block path.

### Remux core

- `crates/remux/`
  - add `remux workload inspect --pid <pid> --json` and the provider-neutral
    cgroup/systemd state lookup needed by active-time job budgets;
  - do not add narration, Kokoro, ONNX, or artifact concepts.

## Implementation phases

### Phase 1: simplify source and planning contracts

1. Add source document v3 and planning contract v3.
2. Remove structural target generation and DOM registrations.
3. Remove planner associations and use direct block fallback for summaries.
4. Preserve legacy manifest reads and precise-to-block paint adaptation.
5. Verify planner token and payload reductions against the long fixture.

This phase may ship independently and is expected to improve planning before
the synthesis backend changes.

### Phase 2: reproduce and pin ONNX

1. Land the export script and asset manifest.
2. Export waveform and duration outputs from the pinned checkpoint.
3. Add golden waveform, duration, sample-count, and token-coverage tests.
4. Add verified runtime provisioning outside Git-tracked model storage when a
   clean-host distribution path is needed.

### Phase 3: concurrent native task

1. Implement the typed task and direct ONNX inference.
2. Add the bounded ordered scheduler.
3. Reuse existing chunk and manifest semantics.
4. Add cancellation, crash, corrupt-output, and bounded-memory tests.

### Phase 4: server integration and governance

1. Add synthesis provider/profile resolution before cache lookup.
2. Use native ONNX as the only runtime backend.
3. Add active/frozen workload accounting.
4. Add metrics and actionable error reporting.

### Phase 5: validation and rollout

1. Run automated unit/integration suites.
2. Run long-fixture performance and determinism benchmarks under a Remux
   workload grant, not directly on the host.
3. Run repeated cancel/retry and freeze/resume soak tests.
4. Validate playback, seeking, highlights, and cache reuse on iOS/WKWebView.
5. Verify extension startup has no Python runtime preflight.

## Required tests

### Contract and planner

- A v3 structural block contains only a block target.
- A v3 prose block retains word and inline-semantic targets.
- Empty `t` is omitted from planner JSON.
- Planner output schema has exactly `v`, `s`, `b`, and `x` fields.
- Structural speech produces no alignment hints and only block cues.
- Every new structural unit contains exactly one cue spanning that unit.
- Invalid version, ordering, duplicate block, and empty speech are rejected.
- The long fixture removes all 207 structural subtargets and materially lowers
  measured planning input tokens.

### Export and inference

- Representative duration arrays equal the PyTorch reference exactly.
- Every acoustic token receives a valid monotonic duration.
- Sample counts match the reference for short, long, punctuation-heavy, code,
  and table-summary units.
- Concurrent and single-run ONNX modes produce deterministic unit order,
  durations, cue order, and valid audio within the chosen waveform tolerance.
- The worker never exceeds the granted active inference concurrency, and
  out-of-order waveforms are spilled instead of retained in memory.

### Lifecycle

- Cancelling a job terminates the worker scope and publishes no artifact.
- Worker crash, invalid JSON, bad SHA, and missing audio fail atomically.
- Freeze longer than 60 seconds does not trigger a false stall timeout.
- Running without progress still triggers the configured stall timeout.
- Extension restart leaves no worker descendants.

### Compatibility and viewer

- A cached v2 manifest containing line/cell cues still paints its block.
- A new v3 manifest never asks the viewer for a line/cell/node element.
- Prose word and inline-semantic highlighting remain unchanged.
- Structural playback uses the block border/segment paint only.
- Seeking and auto-scroll resolve to the same block for old and new artifacts.
- Narration paint does not change Markdown layout or PreText row height.

## Acceptance gates

The default ONNX path can ship when all of the following hold on the reference
host:

- complete long-fixture synthesis is no slower than 65 seconds in three
  consecutive managed-workload runs;
- audio/realtime factor is at least 16x;
- peak worker RSS is no greater than 3.10 GB;
- duration arrays and sample counts pass all golden tests;
- no unit, cue, chunk, or progress event is missing or reordered;
- ten cancel/retry cycles leave no descendants or partial artifacts;
- a freeze/resume soak does not produce a false timeout;
- planning contract v3 removes structural targets and shows the expected token
  reduction without reducing narration quality;
- iOS playback, seek, auto-scroll, block highlight, and prose word highlight
  pass the existing narration device matrix.

## Out of scope

- streaming partial audio to the viewer;
- a persistent TTS daemon;
- a separate narration repository or network service;
- int8 quantization;
- packing multiple narration units into one model forward;
- forced alignment for Kokoro output;
- word or cell highlighting inside code, tables, and diagrams;
- background audio playback;
- changing the voice or audio format;
- overlapping Codex planning with synthesis in this pass.

Planning/synthesis overlap remains a valid later optimization once the simpler
ONNX path is stable. It requires a streaming planning-to-worker boundary and is
not necessary to obtain the measured synthesis improvement.
