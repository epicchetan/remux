# Codex Assistant Narration Planning, Alignment, and Highlighting Spec

Status: Active Spec
Last verified: 2026-07-11
Canonical code: `extensions/codex/server/src/narration.rs`, `extensions/codex/server/src/narration_planning.rs`, `extensions/codex/server/src/narration_source_mapping.rs`, `extensions/codex/narration/kokoro_worker.py`, `extensions/codex/shared/narration.ts`, `extensions/codex/viewer/narration/paintController.ts`, `extensions/codex/viewer/narration/textLeafRegistry.ts`
Extends: `docs/specs/codex/assistant-narration-v2.md`

Implementation state: the production code path and automated coverage for
phases 1–6 are implemented. The minimum-iOS/WKWebView device matrix, opt-in
live inference corpus, and rollout gates remain operational validation work;
they are intentionally not run by ordinary unit or CI verification.

## Summary

Optimize the speakable-transcript planning stage used by assistant narration,
make spoken-to-source alignment deterministic for normalized prose, and paint
active text ranges without mutating the Markdown DOM. Keep the v2 source block
and target identities, Kokoro voice and audio format, durable artifact boundary,
viewer controls, and viewport policy.

The next implementation should:

1. resolve an explicit `gpt-5.6-sol` Priority generation profile;
2. run it at low reasoning effort with reasoning summaries disabled;
3. replace the general coding-agent context with a minimal narration-only
   thread context and the exact versioned prompt in this document;
4. replace repeated durable identifiers with request-local integer references
   and exclude renderer word and block targets from the model contract;
5. assign normalized versus summary mode on the server rather than asking the
   model to classify or omit selected blocks;
6. align normalized speech back to display words with a monotonic deterministic
   source mapper, preserving semantic fallback for changed expressions;
7. keep Kokoro's generation-native token timestamps as the acoustic clock;
8. replace React-inserted active-word spans with a renderer-owned text-leaf
   registry and block-local range overlay, using the exact paint tokens and
   target-specific structural classes in this document;
9. batch large planning requests deterministically with concurrency capped at
   three;
10. version planning, source mapping, and overlay painting independently;
11. measure planning latency and token usage separately from synthesis,
   acoustic timing, source mapping, and viewer painting.

This document uses **speakable transcript** to mean the text and source-target
mapping generated for text-to-speech. It does not change the conversation
transcript resource or its persisted Codex turn history.

## Motivation

The current narrator already avoids sending ordinary verbatim blocks through a
model. Blocks that require pronunciation normalization or structural summaries
are sent to an isolated Codex app-server thread with a JSON output schema.

That path is correct, but it still behaves like a general Codex coding turn:

- the model is inherited from the machine default unless an environment
  override is present;
- the service tier is not part of the resolved provider profile;
- narrator instructions are added on top of general agent instructions;
- repository guidance, skill metadata, and general tools can enter the model
  context even though narration cannot use them;
- the stable narrator rules are split between developer instructions and the
  dynamic user payload;
- every durable block and target ID is repeated in the input document, output
  schema, fallback targets, and alignment hints;
- the output schema changes for every assistant message because it embeds those
  IDs as enums;
- the stored provider profile can say `default` rather than identify the model
  and tier that actually generated the artifact.

The model usually begins producing output within a few seconds. Most of the
remaining planning time is spent generating a verbose structured response.
Reducing that response is more valuable than adding another agent layer.

## R&D Baseline

The feasibility experiment used the real app-server protocol, the current
narrator instructions, the current JSON schema, and blocks from an existing v2
narration source document.

### Model comparison

The complex fixture contained six transformed blocks: code, paragraph,
heading, table, list item, and blockquote.

| Profile | Complex planning | Validity | Small-block median | Observation |
| --- | ---: | ---: | ---: | --- |
| GPT-5.6 Sol, default tier, low | 34.0-35.0s | 2/2 | 6.1s | Best pronunciation quality among default-tier candidates. |
| GPT-5.6 Terra, default tier, low | 17.3-40.8s | 2/2 | 9.4s | Too variable and often literal with notation. |
| GPT-5.6 Luna, default tier, low | 27.2-30.0s | 1/2 | 8.5s | One exact-hint validation failure would require failure handling. |
| GPT-5.5, default tier, low | 37.0-37.4s | 2/2 | 6.9s | No latency advantage over Sol. |
| GPT-5.4, default tier, low | 36.7-42.9s | 2/2 | 7.2s | Slower than Sol. |
| GPT-5.4 Mini, default tier, low | 22.5-30.6s | 2/2 | 6.6s | Faster on large output, but weaker technical pronunciation. |
| GPT-5.3 Codex Spark | request rejected | 0/2 | not run | Current request path sends an unsupported reasoning-summary parameter. |

Sol Priority reduced the same complex fixture to 23.1-24.5 seconds while
preserving valid, natural narration. The small fixture averaged 5.7 seconds.
Priority is therefore the chosen initial profile.

### Context experiment

For a single 70-character normalization block:

| Thread context | Input tokens | Completion time |
| --- | ---: | ---: |
| Current-style narration thread | about 14.5k | 5.6-7.1s |
| Explicit `summary: none` | about 14.5k | 5.0-5.4s |
| Minimal base instructions and neutral CWD | about 11.2k | 4.8-5.1s |
| Minimal base plus unused agent features disabled | about 6.5k | 4.6-5.3s |

Context pruning removes substantial unrelated input, but output decoding still
dominates complex requests.

### Compact-contract experiment

Using Sol Priority, low effort, minimal context, and the complex fixture:

| Contract | Input tokens | Output tokens | JSON size | Completion time |
| --- | ---: | ---: | ---: | ---: |
| Durable string IDs in the model contract | 13.0-13.2k | 1,708-1,725 | about 5.4 KB | 23.0-29.2s |
| Request-local integer references | 7.7-7.9k | 503-667 | 1.4-2.1 KB | 8.9-11.4s |

Both compact-contract results passed block-order, per-block target-bound, and
ordered-hint validation. Spoken output remained approximately 950 characters
and retained the same meaning and pronunciation quality.

### Long-response planning

The long fixture is a real cached assistant response with 167 Markdown blocks,
14,093 display characters, 58 transformed blocks, and 13,556 final spoken
characters. The 58 transformed blocks contain 8,374 display characters. Runs
used Sol Priority, low effort, no reasoning summary, the compact indexed
contract, and separate ephemeral threads for concurrent batches.

| Strategy | Runs | Wall time | Total input tokens | Total output tokens |
| --- | ---: | ---: | ---: | ---: |
| One 58-block request | 3 | 31.4s, 32.9s, 41.2s | 16.9-18.6k | 2,425-2,438 |
| Two 29-block requests | 2 | 17.4s, 23.2s | 28.4k | 2,447-2,497 |
| Three 19-20-block requests | 2 | 15.5s, 15.9s | 37.2-38.0k | 2,521-2,553 |

The response is output-decoding bound once unrelated context and JSON
verbosity are reduced. Three bounded batches are the selected long-response
policy. The additional per-thread input is acceptable for an on-demand cached
artifact and should fall after the minimal context profile removes unused
agent capabilities. Unbounded concurrency is not acceptable.

### Normalized source mapping

The existing artifact exposed the word-highlighting failure directly:

- all 22 normalized blocks containing inline Markdown ranges received a
  model-provided hint spanning the entire spoken unit;
- all 496 cues in those blocks therefore selected block granularity;
- the worker currently gives an overlapping model hint precedence over
  deterministic word matching, so unchanged words lose their word targets.

The problem is source-target selection, not acoustic timing or an inability to
render text inside `strong`, `em`, `a`, `code`, or `span` elements.

A monotonic token-diff replay over the 28 normalized units in the long artifact
found that 67.8% of spoken words were exact source words and another 11.8%
could honestly map to an existing inline-code, link, or expression target. A
stricter prompt requiring every word outside semantic inline ranges to remain
unchanged improved a fresh long run to:

- 531 spoken words across 24 normalized units;
- 472 exact source words, or 88.9%;
- 45 changed words covered by semantic inline targets;
- 14 changed ordinary words requiring phrase or block fallback;
- 97.4% honest word-or-semantic target coverage in total.

That run also varied `normalized`, `summary`, and `omit` classification for
equivalent source kinds and returned non-empty speech for four omitted segments.
Mode choice adds output and failure surface without information the server
lacks, so the final contract makes mode server-owned and removes omission.

The model should therefore produce speech, not word alignment. The server can
recover exact word targets more reliably and can decline to invent a word
mapping for the remaining changed prose.

### Acoustic timing and forced alignment

Kokoro's returned token timestamps are derived from the same predicted duration
sequence used to expand tokens for waveform generation. They are the closest
available representation of the synthesizer's own timing.

As a validation, a CPU-only Wav2Vec2 CTC forced aligner was run against Kokoro
audio on the reference Ryzen 7 9700X machine:

| Audio | Words | Forced-alignment time | Real-time factor | Native/forced start delta | Native/forced end delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2.68s sample | 7 | 0.095s | 0.036 | 75ms median, 124ms max | 8ms median, 315ms max |
| 47.02s chunk | 106 | 1.45s | 0.031 | 80ms median, 228ms max | 25ms median, 498ms max |
| 956.46s artifact | 2,088 | 26.69s | 0.028 | at most 276ms | at most 558ms |

All recognized word sequences matched, so forced alignment is technically
feasible on CPU. It adds a 378 MB acoustic model and about 26.7 seconds to a
16-minute artifact, however, without evidence that its timing is more correct
than Kokoro's generation-native durations. TorchAudio's documented forced
alignment APIs are also deprecated. Forced alignment is rejected as the
default Kokoro path and retained only as a future provider interface for a
synthesizer that lacks trustworthy timings or for offline diagnostics.

### Range overlay painting

The current renderer inserts and removes a `codex-md-narrated-word` span on
every cue. That makes the active word dependent on reconstructed fragment
offsets and changes the React subtree while PreText depends on stable measured
geometry.

Safari 17.2 added the CSS Custom Highlight API for styling arbitrary DOM
`Range` objects without changing markup, and desktop microbenchmarks confirmed
that range resolution itself is inexpensive and layout-neutral. Device usage
then exposed persistent WebKit repaint artifacts across cue replacement and a
separate flex-container failure for file-link labels. Alternating registry
names and empty animation frames did not make that paint lifecycle reliable.

The selected renderer therefore keeps DOM `Range` for authoritative geometry
but does not use the CSS Custom Highlight registry. It converts client
rectangles to one paint-only overlay owned by the mounted Markdown block. The
overlay is cleared atomically and treats file-link label text exactly like
ordinary prose. Narrated prose remains selectable
and its text lines are block containers with inline children. Inline file-link
chips use `inline-flex` and must keep an element-class fallback rather than
depending on range paint.

These measurements establish the implementation choices below. Production
rollout still requires the replay corpus and device gates in this document;
the architecture itself has no open design decisions.

## Product and Architecture Decisions

- Use `gpt-5.6-sol` as the preferred script-generation model.
- Use the catalog tier ID `priority` when it is available.
- Accept Priority's increased account usage for this on-demand, cacheable
  feature; do not infer or display a specific credit multiplier in this pass.
- Use the standard Sol tier only as a profile-resolution fallback decided
  before creating the internal thread.
- Do not silently fall back to Terra, Luna, Mini, or another model.
- Use low reasoning effort.
- Explicitly disable reasoning summaries.
- Keep narration on an isolated ephemeral app-server thread.
- Keep environment access empty and filesystem permissions read-only.
- Give the narration thread a neutral, empty working directory rather than the
  active repository directory.
- Do not expose repository instructions or repo-scoped skills to the narrator.
- Disable tools, apps, web search, multi-agent orchestration, and other general
  agent capabilities wherever the app-server configuration supports it.
- Do not create or invoke a production narration skill.
- Keep the durable v2 source document and renderer target identities unchanged.
- Use compact references only across the internal model boundary.
- Expand and validate compact output in the server before synthesis.
- The server assigns `normalized` to transformed prose, headings, list items,
  and blockquotes, and `summary` to transformed code, tables, and diagrams.
- Remove planner-controlled `omit`; content with no spoken meaning is filtered
  before planning, and every selected block must return non-empty speech.
- Do not expose block or word targets to the model.
- Do not accept model alignment associations for normalized units.
- Preserve ordinary display words exactly in normalized mode. Rewrite only
  semantic inline ranges and the minimum grammar required for natural speech.
- Build normalized source mappings with a monotonic, Unicode-aware word diff.
  Equal runs map to word targets; changed runs map to overlapping semantic
  targets or fall back honestly to a phrase/block target.
- Keep sparse exact-substring semantic associations only for summary units.
  They are optional in this implementation; the block target remains the
  honest fallback.
- Use one planning turn for at most 20 transformed blocks and 4,000 UTF-16 code
  units of display text. Partition larger requests in source order on both
  bounds and run
  at most three batches concurrently; process additional batches in waves.
- Publish no script or audio until every batch completes and the reassembled
  source order validates atomically.
- Use Kokoro's native token timestamps for acoustic timing.
- Do not run a forced aligner in the production Kokoro path.
- Resolve active text with renderer-owned DOM `Range` objects and paint their
  rectangles in a block-local overlay; never insert active-word spans into the
  Markdown text or use the CSS Custom Highlight registry.
- Paint file-link chip text through the same range overlay as ordinary prose;
  never put narration state on the chip element.
- Do not automatically replay ambiguous transport or app-server failures.
- Treat planning, synthesis, acoustic timing, source mapping, range painting,
  and publication as separate measurements.

## Non-Goals

- Changing the narration controls or composer layout.
- Changing automatic scrolling policy or PreText measurement ownership.
- Changing stable Markdown block or target IDs.
- Replacing Kokoro or changing its voice.
- Adding production forced alignment for Kokoro.
- Changing the durable narration manifest shape solely to mirror the compact
  planning contract.
- Exposing model or tier selection in the UI.
- Generating narration in the background without an explicit user request.
- Streaming partial audio before the complete script is validated.
- Using a skill, subagent, or tool call to produce the transcript.
- Automatically routing individual block kinds to different models.
- Replacing all model-based pronunciation normalization with deterministic
  rules in this pass.
- Adding table-region or diagram-node semantic narration generation beyond the
  sparse summary associations already representable by v2 targets.

## Target Flow

```text
Renderer-owned v2 source document
  durable block IDs + durable semantic target IDs
                         │
                         ▼
Planning adapter
  filter transformed blocks
  assign server-owned normalized/summary mode
  exclude block + word targets
  assign request-local semantic target indexes
  partition at 20 blocks / 4,000 UTF-16 units of display text
                         │
                         ▼
1-3 Codex app-server threads
  GPT-5.6 Sol / Priority / low / no reasoning summary
  minimal base instructions / no tools / neutral CWD
  static compact JSON Schema
                         │
                         ▼
Compact plan validator
  exact per-batch block order
  local target bounds
  empty normalized associations
  ordered exact summary associations
                         │
                         ▼
Planning adapter
  atomically reassemble source order
  derive normalized word + semantic mappings
  expand summary associations to durable target IDs
                         │
                         ▼
Versioned durable narration script
  unchanged source IDs and target IDs
                         │
                         ▼
Kokoro native timing → source mapper → manifest
                         │
                         ▼
Viewer text-leaf registry → DOM Range → block-local overlay rectangles
```

The compact plan is never persisted as the canonical narration script and is
never sent to the viewer. It is a provider-specific wire format owned by the
server planning adapter.

## Resolved Planning Profile

Resolve the complete profile before calculating the script or artifact key:

```ts
type NarrationPlanningProfile = {
  provider: 'codex-app-server';
  model: 'gpt-5.6-sol';
  serviceTier: 'priority' | 'standard';
  effort: 'low';
  reasoningSummary: 'none';
  contextProfileVersion: string;
  baseInstructionsVersion: string;
  promptVersion: string;
  contractVersion: string;
};
```

Use these exact initial version identifiers:

```rust
const NARRATION_CONTEXT_PROFILE_VERSION: &str = "1";
const NARRATION_BASE_INSTRUCTIONS_VERSION: &str = "1";
const NARRATION_PROMPT_VERSION: &str = "5"; // current implementation is 4
const NARRATION_PLANNING_CONTRACT_VERSION: u64 = 2;
const NARRATION_SOURCE_MAPPING_VERSION: &str = "6"; // replaces alignment 5
const NARRATION_ACOUSTIC_TIMING_PROVIDER_VERSION: &str = "kokoro-native-v1";
const NARRATION_PAINT_RENDERER_VERSION: &str = "4";

const MAX_PLANNING_BATCH_BLOCKS: usize = 20;
const MAX_PLANNING_BATCH_UTF16: usize = 4_000;
const MAX_CONCURRENT_PLANNING_BATCHES: usize = 3;
const MAX_COMPACT_LABEL_BYTES: usize = 160;
const MAX_PLANNING_SEGMENT_BYTES: usize = 16 * 1024;
const MAX_PLANNING_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_ASSOCIATIONS_PER_SEGMENT: usize = 64;
const MAX_TARGETS_PER_ASSOCIATION: usize = 16;
const MAX_ASSOCIATION_TEXT_BYTES: usize = 1_024;
const MAX_MAPPING_WORDS_PER_UNIT: usize = 2_048;
```

Do not reuse `NARRATION_ALIGNMENT_VERSION` for two meanings. Replace it with
the source-mapping and acoustic-timing identifiers above in the resolved
profile and cache key. The viewer-only painter version belongs in diagnostics
and tests, not the audio artifact key.

Resolution rules:

1. Read the app-server model catalog.
2. Require a visible or explicitly supported `gpt-5.6-sol` model entry.
3. Select `priority` only when the entry advertises that service tier.
4. Otherwise select the standard Sol tier before any thread or turn is
   dispatched.
5. If Sol itself is unavailable, report narration planning as unavailable.
6. Record the fully resolved profile in cache identity and the final provider
   descriptor.

Environment overrides may remain available for development benchmarks, but a
raw environment string must resolve to the same typed profile before cache
lookup. `default` is not a valid persisted model identity for newly generated
artifacts.

Do not retry with a different tier after `turn/start` has been accepted. That
would be an ambiguous replay and would produce a different provider profile.

`standard` is the normalized provider-profile name. The app-server request
represents it by omitting `serviceTier` or sending `null`; it must not send the
literal string `standard` unless a future model catalog advertises that exact
tier ID.

Persist this resolved artifact profile shape:

```json
{
  "id": "codex-kokoro-source-map-v3",
  "scriptGenerator": {
    "provider": "codex-app-server",
    "model": "gpt-5.6-sol",
    "serviceTier": "priority",
    "effort": "low",
    "reasoningSummary": "none",
    "contextProfileVersion": "1",
    "baseInstructionsVersion": "1",
    "promptVersion": "5",
    "contractVersion": 2
  },
  "sourceMapper": {
    "provider": "remux-monotonic-lcs",
    "algorithmVersion": "6"
  },
  "acousticTiming": {
    "provider": "kokoro-native",
    "algorithmVersion": "1"
  },
  "synthesizer": {
    "provider": "kokoro",
    "model": "hexgrad/Kokoro-82M",
    "modelRevision": "hexgrad/Kokoro-82M@0.9.4",
    "optionsVersion": "2",
    "sampleRate": 24000,
    "voice": "af_heart"
  }
}
```

Use `serviceTier: "standard"` in the persisted profile when the pre-dispatch
fallback is selected, even though the wire request sends `null`. Replace the
current ambiguous `aligner: remux-hybrid` object with `sourceMapper` and
`acousticTiming`; old v2 manifests remain readable through their stored shape.

## Minimal App-Server Thread

### Thread parameters

The narration thread should set the behavior it depends on explicitly:

```ts
{
  model: 'gpt-5.6-sol',
  serviceTier: resolvedTier === 'priority' ? 'priority' : null,
  baseInstructions: NARRATION_BASE_INSTRUCTIONS_V1,
  approvalPolicy: 'never',
  cwd: narrationContextDirectory,
  config: {
    features: {
      shell_tool: false,
      unified_exec: false,
      code_mode: false,
      standalone_web_search: false,
      multi_agent: false,
      multi_agent_v2: false,
      apps: false,
      enable_mcp_apps: false,
      tool_suggest: false,
      plugins: false,
      remote_plugin: false,
      image_generation: false
    },
    web_search: 'disabled',
    skills: {
      include_instructions: false,
      bundled: { enabled: false }
    }
  },
  dynamicTools: [],
  environments: [],
  ephemeral: true,
  experimentalRawEvents: false,
  persistExtendedHistory: false,
  sandbox: 'read-only',
  serviceName: 'remux-narration'
}
```

Use a dedicated empty directory under Remux-owned Codex state as
`narrationContextDirectory`. Do not use a project checkout or an assistant
message's working directory. The source document is already supplied in the
request and the model must not read repository files.

The `config` object above is the required configuration for the currently
bundled Codex source and must be covered by a fake app-server request snapshot.
These keys exist in the locally cloned Codex config parser; `ThreadStartParams`
accepts the scoped JSON config object. If a later bundled Codex renames or
removes one, update the context-profile version and rerun the context benchmark;
do not silently drop unknown keys.

This configuration disables:

- shell tools;
- web search;
- image tools;
- apps and connectors;
- multi-agent tools;
- remote plugin discovery;
- dynamic tools.

Codex may retain unavoidable system-level capability metadata that the current
protocol cannot disable independently. The requirement is to minimize the
effective context, avoid repo-scoped skill discovery, never invoke a skill or
tool, and verify the result through token-usage measurements. Do not construct
per-thread skill-disable lists from the user's global installation.

Generated app-server protocol types are the authority for accepted fields. Do
not pass undocumented configuration and silently ignore a rejection. A version
that cannot create the required minimal thread should fail the profile
capability check rather than fall back to a general mutable agent thread.

### Turn parameters

```ts
{
  threadId,
  serviceTier: resolvedTier === 'priority' ? 'priority' : null,
  effort: 'low',
  summary: 'none',
  input: [{ type: 'text', text: compactRequestJson, text_elements: [] }],
  outputSchema: COMPACT_PLAN_SCHEMA_V2
}
```

Supplying the tier on both the thread and turn is acceptable for an initial
defensive implementation, but the resolved values must agree. Tests should
assert that model, tier, effort, and summary do not inherit user composer
settings.

Treat `item/completed` for the matching `agentMessage` as the authoritative
response text. Record `item/agentMessage/delta` only for first-delta timing and
diagnostics; do not reconstruct production JSON from deltas. After the matching
`turn/completed`, require status `completed` and one authoritative agent
message. Missing, duplicate, or unparsable completed messages fail that batch.
This follows the app-server lifecycle contract and avoids accepting a truncated
stream as a plan.

## Instruction Design

`thread/start.baseInstructions` must be exactly the versioned string below.
Use `baseInstructions`, not `developerInstructions`: this isolated thread needs
a replacement base prompt rather than the general coding-agent prompt plus an
additional developer message. The official app-server surface supports base
instructions on thread creation and structured output on `turn/start`; the
generated protocol types for the bundled Codex version remain the compile-time
authority.

```text
You produce speakable narration for supplied Markdown blocks.

Return only JSON matching the supplied output schema. Do not return Markdown,
commentary, explanations, confidence, or reasoning. Do not use tools, browse,
read files, or refer to this task.

The input is compact JSON with version v and ordered blocks b.
Each block has:
- i: its zero-based index in this request;
- k: p paragraph, h heading, li list item, q blockquote, c code, tb table, or d diagram;
- m: n for pronunciation normalization or s for structural summary;
- x: exact display text;
- t: zero or more semantic targets local to the block.

Semantic target kinds are:
- expr, code, or link with UTF-16 display offsets s inclusive and e exclusive;
- cell with row r, column c, and source label x;
- lines with inclusive line indexes s and e and source label x;
- node with node identifier n and source label x.

Return version v equal to 2 and one output segment in s for every input block,
in the same order. Each segment has:
- b: the unchanged input block index;
- x: non-empty spoken text;
- a: ordered semantic associations.

Never choose a mode, omit a block, merge blocks, split a block, or reproduce a
durable renderer identifier.

For mode n:
- preserve the source meaning and sentence order;
- preserve every display word outside semantic target ranges, in the same order;
- rewrite only technical notation inside semantic target ranges and the minimum adjacent grammar required for natural speech;
- pronounce units, symbols, URLs, identifiers, abbreviations, and inline code naturally rather than reading punctuation literally;
- do not summarize, shorten, expand with new facts, or paraphrase ordinary prose;
- return a as an empty array. The server aligns normalized speech.

For mode s:
- produce a concise natural explanation of the structure and its meaning;
- preserve material behavior, relationships, ordering, quantities, and caveats;
- do not read Markdown syntax, code punctuation, type syntax, table separators,
  every table cell, or every diagram edge literally;
- keep the summary proportional to the source and do not add facts;
- a may associate an exact non-empty substring of spoken x with the narrowest
  relevant semantic target indexes from input t;
- associations must be non-overlapping, in spoken order, and must not map an
  entire summary sentence or ordinary prose to a broad target;
- return an empty a when no narrow semantic association is honest.

For every segment, use only target indexes owned by that input block. Do not
invent target indexes. Keep technical names recognizable while making their
pronunciation natural.
```

Store this exact string as `NARRATION_BASE_INSTRUCTIONS_V1`. Whitespace and
punctuation are part of the versioned prompt. Any edit requires incrementing
`NARRATION_BASE_INSTRUCTIONS_VERSION` and `NARRATION_PROMPT_VERSION`, rerunning
the live corpus, and invalidating the script cache.

The user input for the turn is only `serde_json::to_string(&compact_request)`.
Do not prepend a label such as `Input:` and do not repeat instructions in the
dynamic message. This preserves a stable instruction prefix across batches and
keeps the measured contract small.

Do not add examples to the production prompt in this version. The R&D prompt
achieved the target coverage without examples; examples would consume the same
prefix on every batch and can overfit pronunciation choices. A future example
requires a corpus failure, a prompt-version bump, and an old/new benchmark.

## Skills Decision

Do not implement the production narrator as a Codex skill. Skills solve
discoverable, reusable agent workflows. Codex initially exposes skill metadata
and loads full skill instructions after activation, while narration already has
an exact one-turn input and output contract.

A runtime narration skill would add discovery context and could add a skill-read
or tool round trip without improving the model's semantic input. The compact
base instructions are both smaller and more deterministic.

A development-only evaluation skill remains reasonable later. It may run the
replay corpus, compare provider profiles, and prepare a report for a developer.
It must call the same benchmark harness as any other development surface and
must never be visible to or invoked by the ephemeral production narration
thread.

## Compact Planning Contract

Use descriptive internal Rust and TypeScript names with short `serde` wire
renames. Short field names are confined to this provider adapter.

### Request

```ts
type CompactPlanningRequest = {
  v: 2;
  b: CompactPlanningBlock[];
};

type CompactPlanningBlock = {
  i: number; // zero-based request-local block index
  k: CompactBlockKind;
  m: 'n' | 's'; // server-owned normalized or summary mode
  x: string; // display text
  t: CompactSemanticTarget[];
};

type CompactBlockKind =
  | 'p'  // paragraph
  | 'h'  // heading
  | 'li' // list item
  | 'q'  // blockquote
  | 'c'  // code
  | 'tb' // table
  | 'd'; // diagram
```

Block indexes must be contiguous and match array order within one batch. Only
blocks selected for transformation appear. The adapter, not the model, assigns
mode. A transformed paragraph, heading, list item, or blockquote is normalized;
code, table, and diagram blocks are summarized.

### Targets

Each block owns a separate zero-based semantic-target index space:

```ts
type CompactSemanticTarget =
  | { i: number; k: 'expr' | 'code' | 'link'; s: number; e: number }
  | { i: number; k: 'cell'; r: number; c: number; x: string }
  | { i: number; k: 'lines'; s: number; e: number; x: string }
  | { i: number; k: 'node'; n: string; x: string };

type CompactLabel = string; // represented by x above, at most 160 UTF-8 bytes
```

The adapter builds an immutable lookup table:

```text
compact block 2                 -> md:11
compact block 2, target 8       -> md:11/target/inlineCode/1
```

Do not put durable IDs, block targets, word targets, or `blockId` on compact
targets. The model never needs renderer word identities: exact normalized words
are recovered after planning. Labels are server-derived exact source excerpts,
whitespace-normalized, and bounded to 160 UTF-8 bytes. Text-range targets do not
repeat labels because their source is already a direct slice of block text.
Long code-line labels truncate at a Unicode boundary. Label-format changes bump
the compact contract version; renderer identity remains unchanged.

### Response

```ts
type CompactPlanningResponse = {
  v: 2;
  s: CompactPlanningSegment[];
};

type CompactPlanningSegment = {
  b: number;              // request-local block index
  x: string;              // spoken text
  a: CompactSemanticAssociation[];
};

type CompactSemanticAssociation = {
  x: string;              // exact ordered substring of segment speech
  t: number[];            // narrow targets in this block
};
```

The model returns exactly one segment for each request block in the same order.
It may not choose mode, omit a block, choose a fallback, refer to renderer word
targets, or refer to another block's target index space. `a` must be empty for
normalized blocks. It may be empty for a summary; the server supplies the block
fallback.

### Canonical wire example

This example documents serialization and validation; it is not included in the
production prompt.

```json
{
  "v": 2,
  "b": [
    {
      "i": 0,
      "k": "p",
      "m": "n",
      "x": "That separation lets ten receivers share one bars:5m instance.",
      "t": [
        { "i": 0, "k": "code", "s": 45, "e": 52 }
      ]
    },
    {
      "i": 1,
      "k": "c",
      "m": "s",
      "x": "pub enum DeliverySemantics {\n    ReplaceLatest,\n    AppendOrdered,\n    PatchByKey,\n    Snapshot,\n}",
      "t": [
        { "i": 0, "k": "lines", "s": 0, "e": 0, "x": "pub enum DeliverySemantics" },
        { "i": 1, "k": "lines", "s": 1, "e": 4, "x": "ReplaceLatest; AppendOrdered; PatchByKey; Snapshot" }
      ]
    }
  ]
}
```

A valid response is:

```json
{
  "v": 2,
  "s": [
    {
      "b": 0,
      "x": "That separation lets ten receivers share one five-minute bars instance.",
      "a": []
    },
    {
      "b": 1,
      "x": "Delivery semantics support replacing the latest value, appending ordered values, patching by key, or publishing a snapshot.",
      "a": [
        {
          "x": "replacing the latest value, appending ordered values, patching by key, or publishing a snapshot",
          "t": [1]
        }
      ]
    }
  ]
}
```

The normalized rewrite has no association even though `bars:5m` changed. The
server maps `five-minute bars` to compact target 0 and then to its durable
inline-code target. The summary association is accepted because it is an exact
spoken substring and selects the narrow code-line group rather than the block.

### Static output schema

Use this exact process-static `COMPACT_PLAN_SCHEMA_V2`:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["v", "s"],
  "properties": {
    "v": {
      "type": "integer",
      "enum": [2]
    },
    "s": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["b", "x", "a"],
        "properties": {
          "b": {
            "type": "integer"
          },
          "x": {
            "type": "string"
          },
          "a": {
            "type": "array",
            "maxItems": 64,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["x", "t"],
              "properties": {
                "x": {
                  "type": "string"
                },
                "t": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 16,
                  "items": {
                    "type": "integer"
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Serialize the schema once with stable object-key order and cover its exact bytes
with a snapshot test. Do not enumerate per-message block or target IDs. The
schema deliberately permits any integer index; exact non-negative bounds,
batch length, block order, mode-specific association rules, and local target
bounds remain semantic server validation.

Keeping the schema static reduces request size and makes stable-prefix caching
possible. JSON Schema validates shape; the server validates meaning.
Server-side limits remain mandatory for strings, integers, arrays, aggregate
bytes, and associations. Enforce the byte constants from Resolved Planning
Profile after JSON decoding because JSON Schema string lengths are not UTF-8
byte limits. Do not add string-length or numeric-range schema keywords without
an app-server compatibility test; the current exact schema confines those
limits to semantic validation while retaining the array bounds already used by
the working narrator.

## Deterministic Batching

Partition selected blocks greedily in source order. Close the current batch
before adding a block when that addition would exceed either 20 blocks or 4,000
UTF-16 code units of display text. A single valid source block larger than
4,000 UTF-16 code units occupies a batch by itself; the existing per-block source
limit remains authoritative.

Assign every batch a request-local zero-based block index space. Dispatch the
first three batches concurrently on separate ephemeral threads. When one
finishes, dispatch the next batch until all are complete. Do not change batch
boundaries based on live latency, model output, or account state because that
would make behavior and metrics difficult to replay.

Replace the single `NarrationJob.internal_thread_id` and
`internal_turn_id` fields with:

```rust
struct PlanningTurnIdentity {
    batch_index: usize,
    thread_id: String,
    turn_id: String,
}

planning_turns: Vec<PlanningTurnIdentity>
```

Append an identity only after both start responses are matched. Cancellation or
sibling failure snapshots the vector under the job lock, releases the lock, and
sends `turn/interrupt` for every known identity. Never hold the job mutex while
waiting on app-server RPC or a planning thread.

Store each result under its immutable global source slice. Reassembly verifies
that slices are contiguous, non-overlapping, and cover every selected source
block exactly once. Validation or transport failure in any batch cancels known
siblings and discards the entire plan. Only complete reassembly may enter
synthesis.

## Semantic Validation

Validate the complete compact response before creating any durable narration
unit or starting synthesis.

Required checks:

1. Reject the raw completed message above 256 KiB before JSON parsing.
2. Response and contract versions are supported and no unknown fields survive
   typed deserialization.
3. Segment count exactly equals that batch's request block count.
4. Segment `b` values equal their array indexes and are unique.
5. Speech is non-empty, has no leading or trailing whitespace, and is at most
   16 KiB of UTF-8 per segment. Reject rather than trim it so association
   offsets remain provider-authored and reproducible.
6. Normalized segments have no model associations.
7. A segment has at most 64 associations. Every summary association has
   non-empty text without leading/trailing whitespace, is at most 1 KiB UTF-8,
   and owns between 1 and 16 unique target indexes.
8. Association text occurs at or after the previous association's end,
   preserving non-overlapping monotonic order. Repeated text resolves to the
   first occurrence at or after the cursor; absence is invalid.
9. Every target index is non-negative and exists in that segment's semantic
   target space. Duplicate indexes inside an association are rejected.
10. Every batch covers exactly its immutable source slice, and reassembled
   batches cover all selected blocks once in original source order.
11. Aggregate output, spoken text, target associations, and association counts
    remain under the server-owned source and job limits.

After every batch validates, reassemble them atomically. The server supplies the
durable block target as each transformed unit's fallback. Summary associations
expand through the immutable semantic lookup table. Normalized units ignore
model associations by contract and run through the source mapper described
below. Deterministic blocks merge as `verbatim` units exactly as they do today:

```ts
type NarrationUnit = {
  id: string;
  blockId: string;
  displayText: string;
  spokenText: string;
  mode: 'normalized' | 'summary' | 'verbatim';
  fallbackTargetIds: string[];
  alignmentHints: Array<{
    spokenText: string;
    targetIds: string[];
  }>;
};
```

The worker, aligner, manifest validator, and viewer continue consuming durable
IDs and require no awareness of compact indexes. The source mapper and viewer
paint implementation change behind that durable identity boundary.

## Normalized Source Mapping

The source mapper runs while constructing every durable prose unit and before
synthesis. For verbatim units it emits direct renderer-word hints because
spoken and display text are identical. After compact-plan validation it emits
diff-derived hints for normalized units. Both use the existing durable
`alignmentHints` field, so the worker and manifest schemas do not need a
parallel source-map representation. Mapping is Unicode-aware and independent
of audio time.

1. Read display words and UTF-16 spans from renderer-owned word targets, and
   tokenize spoken text with the renderer-equivalent lexical rule while
   retaining punctuation boundaries and normalized comparison forms.
2. For `verbatim`, emit one exact spoken-word hint for each renderer word target
   and skip diffing.
3. For `normalized`, normalize comparison keys with Unicode NFKC plus lowercase, then run a
   deterministic longest-common-subsequence diff. Prefer the earliest display
   match when repeated words admit equal-length solutions. Do not reorder
   matches and do not use fuzzy similarity.
4. Map equal spoken words to the exact renderer word target covering the
   display span.
5. For each changed run, find the narrowest expression, inline-code, or link
   target overlapping the changed display run. Map all spoken words in that
   run to that semantic target.
6. If a changed run has no honest semantic target, emit no hint for it. The
   unit's block fallback then applies to those spoken words.
7. When punctuation-only changes sit between two equal words, keep them with
   the nearest mapped spoken word; punctuation does not get a standalone cue.
8. Summary units use only validated model semantic associations and block
   fallback. They never run through word diff because summary prose is not a
   faithful word-level view of the source structure.

Source mapping establishes visual targets. Kokoro timing establishes when each
spoken token is active. The cue builder intersects those two independent axes.
An exact word hint always wins for that word; a broad block fallback can never
override it. A semantic association wins only for words inside its validated
spoken substring. Generated hints are ordered by spoken offset so repeated
substrings remain unambiguous under the existing exact-substring expansion.

The mapper reports exact-word, semantic-run, and block-fallback counts per unit
for diagnostics. It rejects invalid UTF-16 spans but does not fail narration
merely because changed ordinary prose falls back to the block.

### Mapper implementation

Add `regex = "1"` and `unicode-normalization = "0.1"` to the narration server.
Do not independently tokenize display text: the renderer-owned source document
already contains the authoritative `textRange` targets with role `word`. Sort
those targets by `(displayStart, displayEnd, id)`, validate that their UTF-16
ranges are in bounds and non-overlapping, and slice their comparison text from
`displayText`.

Tokenize spoken text with the same lexical rule used by the renderer:

```text
[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*
```

The Rust regex is compiled once with `OnceLock<Regex>`. Each token stores its
UTF-8 byte range, UTF-16 range, exact substring, and comparison key. The key is
`token.nfkc().flat_map(char::to_lowercase).collect::<String>()`.

Use `MAX_MAPPING_WORDS_PER_UNIT = 2_048`. When either side exceeds the cap,
record a bounded diagnostic and leave the unit at block fallback; do not allocate
an unbounded diff matrix and do not fail audio generation.

For normalized inputs inside the cap, compute a deterministic LCS over
comparison keys. Verbatim units bypass the cap because they directly enumerate
already-bounded source word targets without allocating a matrix.
Backtracking uses these tie rules in order:

1. take an equal-key diagonal match;
2. otherwise choose the branch with the larger remaining LCS length;
3. on equal lengths, advance the spoken side so the next match uses the
   earliest possible display target.

Convert the matches into alternating equal runs and changed hunks. For every
equal spoken token, emit one durable alignment hint whose `spokenText` is the
exact spoken token and whose `targetIds` contains the matched renderer word
target.

For a changed hunk, calculate the display interval between the previous and
next equal anchors. Include a semantic target when its interval overlaps that
display interval or contains an insertion boundary. Select exactly one target
using:

1. smallest display span;
2. explicit inline-code role before link before inferred expression;
3. source start, then durable target ID.

If a target is selected, emit one hint spanning from the first changed spoken
token's byte start through the last changed token's byte end, including internal
punctuation and whitespace. If none is selected, emit no hint and let block
fallback apply. Coalesce adjacent hints only when their target IDs are identical
and the intervening spoken substring contains no word token.

### Cue-builder precedence

`prepare_alignment_hints` must expand every ordered hint into explicit spoken
UTF-16 offsets before iterating Kokoro tokens. For each timed token, collect all
overlapping hints and select one deterministically by:

1. word target;
2. inline expression/code/link target;
3. table cell or region, code lines, or diagram node;
4. block target;
5. shortest spoken hint span;
6. original hint order.

The generated contract should make overlaps rare, but cue selection must not
depend on that assumption. Use cue origins `sourceWord`, `sourceSemantic`,
`summarySemantic`, and `fallback` in diagnostics and the manifest. Delete the
old normalized `display_normalized.find` recovery path after replay tests prove
the server-generated hints cover it; retaining two independent word mappers
would make cue selection nondeterministic.

A punctuation-only Kokoro token that overlaps no hint inherits the previous
non-fallback cue target and origin within the same unit. If none exists, it uses
the unit fallback. It never advances source mapping or creates a standalone
visual target.

The resulting generation path is therefore exact:

```text
renderer source document
  → deterministic verbatim units with exact word hints
  + server-selected transformed units
  → compact Sol Priority batches
  → authoritative completed JSON
  → validate and atomically reassemble
  → deterministic normalized hints + validated summary associations
  → durable script.json
  → Kokoro audio and native token times
  → cue precedence above
  → manifest.json
```

## Acoustic Timing Decision

Continue consuming Kokoro token `start_ts` and `end_ts` values. Normalize them
to monotonically increasing non-negative cue intervals, clamp them to the audio
duration, and retain existing sentence/block gap handling. Do not run a second
speech recognizer or forced aligner.

Define an internal `NarrationAcousticTimingProvider` boundary now, with
`kokoro-native-v1` as the only production implementation. A future synthesizer
without native timings may add a forced-aligner provider and must bump the
timing-provider version and artifact key. The interface is extensibility, not a
reason to ship an unused acoustic model.

## Renderer Range Overlay

Text highlighting belongs to the rendered text geometry, not to the planner and
not to React's active-cue render path.

### Text-leaf registry

Each mounted Markdown line fragment registers a stable leaf record:

```ts
type NarrationTextLeaf = {
  assistantMessageId: string;
  blockId: string;
  displayStart: number;
  displayEnd: number;
  textNode: Text;
  textStart: number;
  textEnd: number;
};
```

The registry contains rendered leaves, not one entry per narration word. It is
keyed by assistant message and block, ordered by display span, and updated only
when a fragment mounts, unmounts, or its text node changes. Virtualized blocks
unregister normally.

`MarkdownLineFragment` owns registration. Remove `highlights` from
`MarkdownTextLines` and `MarkdownLineFragment`, delete `highlightedFragment`,
and render `fragment.text` as one stable text node. In a layout effect, read the
wrapper's direct text node and assert that its text equals `fragment.text`. A
file-link fragment registers the text node inside
`codex-md-file-link-name` exactly like ordinary text. A mismatch logs a bounded
development diagnostic and leaves that fragment without foreground paint; the
owning prose context remains available as an honest fallback.

PreText may omit boundary whitespace from a materialized fragment and express
the visual separation as `gapBefore`. That pixel gap is not a source-text
offset. `PreparedMarkdownInlineLine` therefore preserves the original
`RichInlineItem.text` values. During layout, keep a monotonically advancing
UTF-16 source cursor for each rich-inline item and locate every emitted
`fragment.text` sequentially in that original item text. Compute
`displayStart` from the logical-line start, the item's display start, and the
located source offset; never derive character offsets from `gapBefore` or from
the lengths of earlier materialized fragments alone. The required invariant is
`displayText.slice(fragment.displayStart, fragment.displayEnd) ===
fragment.text` for every registered prose fragment, including wrapped text,
collapsed spaces and tabs, repeated words, rich spans, file chips, and Unicode.
This is renderer projection behavior and increments
`NARRATION_PAINT_RENDERER_VERSION`; it does not invalidate the transcript or
audio artifact because the canonical display ranges are unchanged.

### Imperative paint controller

Active cue changes must not flow back through assistant-message React props.
Remove `activeTargets` and text highlight arrays from Markdown block, code-line,
and table-cell render props. Components only register stable geometry. A single
`NarrationPaintController` subscribes to narration-store target changes and
performs this transaction outside React rendering:

1. empty and hide every previously painted block overlay and remove all
   previously added structural classes;
2. resolve the new target IDs against source target metadata;
3. materialize the virtualized block if no geometry is mounted;
4. after materialization, resolve text leaves or target elements again;
5. convert text ranges into block-local overlay rectangles or apply the
   target-specific structural classes;
6. publish the resulting union rectangle to the existing auto-follow path.

The controller stores the exact overlay layers, elements, and classes it
applied so cleanup does not query the entire transcript. It uses one request token per cue;
an older asynchronous materialization result must not paint after a seek or cue
change. Playback state changes that do not change target IDs do not repaint.

Stop registering text-range target IDs on the whole block frame. The frame
registers only the block target; table cells and code lines register their
existing element targets; all prose text, including file-link labels, resolves
exclusively through leaves. This prevents a valid word cue from silently
resolving back to a block or chip element.

On an active text-range target, resolve the intersecting leaves and construct
one DOM `Range` per contiguous rendered portion. Ordinary words normally use
one range in one leaf; a semantic expression may use several ranges across
nested inline elements. Read `Range.getClientRects()`, translate every rectangle
into coordinates relative to the closest `.codex-md-block-frame`, and paint it
inside that frame's single `.codex-narration-paint-layer`.

Every block frame owns one permanent, initially hidden, absolutely positioned
overlay layer. It participates in neither line layout nor PreText height. On a
cue transaction the controller clears and hides the old layer before resolving
the new target, builds context rectangles before foreground rectangles in a
document fragment, replaces the destination layer's children atomically, and
then reveals it. Pause retains the children. Seek, end, close, artifact change,
virtualized unmount, and controller teardown empty and hide the layer. No CSS
Custom Highlight names, WebKit repaint workaround, word wrappers, or
inline-element active classes remain.

### Paint taxonomy

Do not reuse one generic active class for every target. Select exactly one
primary paint treatment from the resolved target kind:

| Target | Paint primitive | CSS hook |
| --- | --- | --- |
| word or inline expression/code/link/file label | range rectangles plus subtle prose context | `codex-narration-word-rect` + `codex-narration-context-rect` |
| prose block fallback | block-relative overlay rectangle on the rendered prose surface | `codex-narration-context-rect` |
| whole code/table/diagram | glow on the real bordered surface, never the height frame | `codex-md-structural-target-narrating` |
| code line range | left rail and inset wash | `codex-md-code-line-narrating` |
| table cell or region cells | inset ring and wash | `codex-md-table-cell-narrating` |
| diagram node | node outline/glow | `codex-md-diagram-node-narrating` |

A word target keeps a low-contrast fill on its owning paragraph or heading so
the reading context remains visible, but it never adds a border, shadow, glow,
padding, or inline wrapper to prose. A precise structural child target suppresses the
whole code/table treatment. Apply structural glow only when the selected target
itself has kind `block`, and resolve that block frame to its descendant
`data-narration-surface="code"` or `"table"` element. Never paint the outer
fixed-height frame or the table scroll container. Remove the old generic
`codex-md-target-narrating`, `codex-md-block-narrating`,
`codex-md-narrated-word`, and `codex-md-file-link-narrating` rules; none remain
as compatibility aliases.

### Exact theme tokens and CSS

Place this token block with the existing Codex Markdown theme variables:

```css
:root {
  --codex-narration-word-fill:
    color-mix(in srgb, var(--composer-accent) 20%, transparent);
  --codex-narration-context-fill:
    color-mix(in srgb, var(--composer-accent) 5%, transparent);
  --codex-narration-frame-ring:
    color-mix(in srgb, var(--composer-accent) 52%, transparent);
  --codex-narration-frame-inner:
    color-mix(in srgb, var(--composer-accent) 8%, transparent);
  --codex-narration-frame-outer:
    color-mix(in srgb, var(--composer-accent) 22%, transparent);
  --codex-narration-line-fill:
    color-mix(in srgb, var(--composer-accent) 8%, transparent);
  --codex-narration-line-rail:
    color-mix(in srgb, var(--composer-accent) 72%, transparent);
  --codex-narration-line-inner:
    color-mix(in srgb, var(--composer-accent) 36%, transparent);
  --codex-narration-cell-fill:
    color-mix(in srgb, var(--composer-accent) 9%, transparent);
  --codex-narration-cell-ring:
    color-mix(in srgb, var(--composer-accent) 64%, transparent);
  --codex-narration-cell-inner:
    color-mix(in srgb, var(--composer-accent) 16%, transparent);
}

:root[data-remux-theme="light"] {
  --codex-narration-word-fill:
    color-mix(in srgb, var(--composer-accent) 15%, transparent);
  --codex-narration-context-fill:
    color-mix(in srgb, var(--composer-accent) 4%, transparent);
  --codex-narration-frame-ring:
    color-mix(in srgb, var(--composer-accent) 48%, transparent);
  --codex-narration-frame-inner:
    color-mix(in srgb, var(--composer-accent) 7%, transparent);
  --codex-narration-frame-outer:
    color-mix(in srgb, var(--composer-accent) 16%, transparent);
  --codex-narration-line-fill:
    color-mix(in srgb, var(--composer-accent) 7%, transparent);
  --codex-narration-line-inner:
    color-mix(in srgb, var(--composer-accent) 28%, transparent);
  --codex-narration-cell-fill:
    color-mix(in srgb, var(--composer-accent) 7%, transparent);
  --codex-narration-cell-inner:
    color-mix(in srgb, var(--composer-accent) 12%, transparent);
}
```

Place the paint rules after the ordinary code and table rules so active table
cells override header backgrounds without `!important`:

```css
.codex-md-block-frame {
  isolation: isolate;
  position: relative;
}

.codex-narration-paint-layer {
  position: absolute;
  z-index: 2;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}

.codex-narration-paint-layer[hidden] {
  display: none;
}

.codex-narration-context-rect,
.codex-narration-word-rect {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  pointer-events: none;
}

.codex-narration-context-rect {
  background: var(--codex-narration-context-fill);
}

.codex-narration-word-rect {
  border-radius: 2px;
  background: var(--codex-narration-word-fill);
}

.codex-md-code-block.codex-md-structural-target-narrating,
.codex-md-table.codex-md-structural-target-narrating {
  border-color: var(--codex-narration-frame-ring);
  box-shadow:
    inset 0 0 14px var(--codex-narration-frame-inner),
    0 0 9px var(--codex-narration-frame-outer);
}

.codex-md-code-line.codex-md-code-line-narrating {
  background-color: var(--codex-narration-line-fill);
  box-shadow:
    inset 3px 0 0 var(--codex-narration-line-rail),
    inset 10px 0 16px -12px var(--codex-narration-line-inner);
}

.codex-md-table-cell.codex-md-table-cell-narrating {
  --codex-narration-cell-edge-top: transparent;
  --codex-narration-cell-edge-right: transparent;
  --codex-narration-cell-edge-bottom: transparent;
  --codex-narration-cell-edge-left: transparent;
  background: var(--codex-narration-cell-fill);
  box-shadow:
    inset 0 2px 0 var(--codex-narration-cell-edge-top),
    inset -2px 0 0 var(--codex-narration-cell-edge-right),
    inset 0 -2px 0 var(--codex-narration-cell-edge-bottom),
    inset 2px 0 0 var(--codex-narration-cell-edge-left),
    inset 0 0 12px var(--codex-narration-cell-inner);
}

.codex-md-table-cell-narrating.codex-md-table-cell-edge-top {
  --codex-narration-cell-edge-top: var(--codex-narration-cell-ring);
}

.codex-md-table-cell-narrating.codex-md-table-cell-edge-right {
  --codex-narration-cell-edge-right: var(--codex-narration-cell-ring);
}

.codex-md-table-cell-narrating.codex-md-table-cell-edge-bottom {
  --codex-narration-cell-edge-bottom: var(--codex-narration-cell-ring);
}

.codex-md-table-cell-narrating.codex-md-table-cell-edge-left {
  --codex-narration-cell-edge-left: var(--codex-narration-cell-ring);
}

.codex-md-diagram-node-narrating {
  outline: 1px solid var(--codex-narration-frame-ring);
  outline-offset: 2px;
  filter: drop-shadow(0 0 5px var(--codex-narration-frame-outer));
}

.codex-md-code-block,
.codex-md-table,
.codex-md-code-line,
.codex-md-table-cell {
  transition:
    background-color 110ms ease-out,
    box-shadow 110ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .codex-md-code-block,
  .codex-md-table,
  .codex-md-code-line,
  .codex-md-table-cell {
    transition: none;
  }
}

@media (forced-colors: active) {
  .codex-narration-context-rect {
    background: Highlight;
    opacity: 0.18;
  }

  .codex-narration-word-rect {
    background: Highlight;
    opacity: 0.62;
  }

  .codex-md-code-block.codex-md-structural-target-narrating,
  .codex-md-table.codex-md-structural-target-narrating,
  .codex-md-code-line.codex-md-code-line-narrating,
  .codex-md-table-cell.codex-md-table-cell-narrating,
  .codex-md-diagram-node-narrating {
    outline: 2px solid Highlight;
    outline-offset: -2px;
    background: transparent;
    box-shadow: none;
    filter: none;
  }
}
```

The overlay does not set text color or mutate the originating element, so link,
inline-code, emphasis, and syntax colors remain owned by Markdown. Do not add
padding, border width, font weight, letter spacing, line height, transforms, or
DOM wrappers to any active treatment. Do not add persistent `will-change`,
`backdrop-filter`, or a full-block blur; they increase mobile compositing cost.
The active word has no text shadow or glow. The prose context is only the light
surface fill above; it has no border, outline, radius, or box shadow. Structural
glow is reserved for code, tables, and diagrams.
The active word rectangle may use a two-pixel radius, but it has no transition,
text shadow, outline, or glow. Context and word rectangles are always
`pointer-events: none` and contain no text.

The diagram-node `drop-shadow` is the only filter in this design and is applied
only while one node target is active. If the first diagram implementation uses
SVG, prefer an SVG stroke plus the same shadow color over wrapping the node in
HTML.

For a single `tableCell` target, add all four edge classes. For a `tableRegion`,
add the top class only on `rowStart`, right only on `columnEnd`, bottom only on
`rowEnd`, and left only on `columnStart`. Every cell in the region receives the
wash and inner glow, but internal grid edges do not receive the bright ring.
This produces one glowing perimeter rather than a collection of selected cells.

Empty and hide the old block overlay before painting the destination cue. Pause
retains the overlay. Playback end, close, assistant-message change, artifact
replacement, virtualization, and unmount empty it. Seeking replaces it in one
controller transaction. Keep the existing element registry only for non-text
structural targets.

### Geometry and PreText

The active `Range.getBoundingClientRect()` or union of
`getClientRects()` supplies auto-follow geometry. The transcript virtualizer
continues to materialize the block before range resolution. Range paint adds no
inline DOM nodes, margins, borders, or line boxes. Its absolutely positioned
empty rectangles must not invalidate PreText height measurements. Tests assert
identical block and transcript heights before and during every text cue.

Previous/Next block navigation seeks just inside the destination unit's first
precise cue rather than its raw unit boundary. The resulting `explicitSeek`
focus owns viewport positioning until its animation settles or user input
cancels it. Ordinary `follow` focus requests may repaint during that interval
but must not cancel or reverse the explicit scroll; normal reading-band
arbitration resumes immediately after settlement.

### Compatibility fallback

`Range` and `getClientRects()` are required by the supported WebView baseline.
If a mounted text leaf cannot produce geometry, retain only its owning prose
context and bounded diagnostic; never activate the inline element or restore
per-word React spans. File-link labels follow the same text-range path. The
message transcript must not set `user-select: none` on narrated prose. A device
test covers the minimum supported iOS/WKWebView version before rollout.

## Failure and Retry Semantics

The internal planning flow creates a thread and dispatches a turn. Transport
failure after dispatch is ambiguous.

- Do not automatically replay thread creation or `turn/start` after an
  app-server timeout, disconnect, or unmatched response.
- Do not switch model or service tier after dispatch.
- If any batch fails or is invalid, interrupt all known sibling turns and do
  not synthesize or cache partial output.
- Surface a bounded narration preparation failure while leaving the assistant
  response itself unaffected.
- Preserve cancellation by interrupting every matched internal batch turn whose
  IDs are known.

The compact-contract implementation fails rather than repairs. It performs no
semantic repair turn in this rollout. Adding one requires a later spec revision
backed by corpus evidence and explicit attempt identity.

## Cache and Versioning

Add independent planning versions rather than bumping unrelated layers:

```text
narration source document version   = 2 (unchanged)
narration manifest version          = 2 (unchanged)
narration worker version            = 2 (unchanged)
narration acoustic timing provider  = kokoro-native-v1
narration source mapping version    = 6
narration paint renderer version    = 4 (viewer diagnostics only)
planning context profile version    = 1
planning base instructions version  = 1
planning prompt version             = 5
planning contract version           = 2
```

The script key must include the fully resolved planning profile:

```text
scriptKey = hash(
  sourceDocumentKey
  + model
  + serviceTier
  + effort
  + reasoningSummary
  + contextProfileVersion
  + baseInstructionsVersion
  + promptVersion
  + contractVersion
  + sourceMappingVersion
  + acousticTimingProviderVersion
)
```

Changing from Sol standard to Sol Priority must produce a different script key.
Changing the compact wire representation or normalized source mapping must
invalidate generated cue targets even if the durable script schema remains the
same. Viewer-only paint changes do not invalidate audio artifacts because they
do not change cue identity or timing.

Existing v2 artifacts remain readable. A cached artifact created under the old
planning profile may continue playing. A request whose resolved new key misses
the cache regenerates through the compact planner and atomically publishes the
usual v2 artifact.

## Metrics and Benchmarking

Instrument timestamps around:

- profile resolution;
- `thread/start` request and response;
- `turn/start` request and response;
- first agent-message delta;
- final agent-message completion;
- semantic validation;
- compact-to-durable expansion;
- batch dispatch, completion, and atomic reassembly;
- Kokoro worker start and completion;
- native acoustic timing completion;
- normalized source mapping completion;
- artifact publication.

Capture app-server usage when available:

```ts
type NarrationPlanningMetrics = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  threadStartMs: number;
  firstDeltaMs?: number;
  completionMs: number;
  validationMs: number;
  compactRequestBytes: number;
  compactResponseBytes: number;
  transformedBlockCount: number;
  batchCount: number;
  maxConcurrentBatches: number;
  semanticAssociationCount?: number;
  exactWordMappingCount?: number;
  semanticRunMappingCount?: number;
  blockFallbackWordCount?: number;
};
```

Metrics go to bounded diagnostic logging and a development-only diagnostics
resource that returns the most recent 50 aggregate runs. They do not enter the
viewer's reactive narration state. The resource excludes assistant text, spoken
text, repository paths, durable target IDs, and raw model output.

### Replay corpus

Create checked-in, sanitized fixtures covering:

- ordinary inline-code pronunciation;
- words split across plain spans, strong, emphasis, links, inline code, and
  nested combinations of those leaves;
- raw inline HTML span text where the Markdown parser permits it;
- currency, percentages, time frames, URLs, and identifiers;
- headings requiring and not requiring normalization;
- nested lists and blockquotes;
- code that should be summarized rather than read literally;
- narrow and wide tables;
- table cells with repeated text;
- Mermaid or diagram-like code;
- multiple transformed blocks sharing similar target shapes;
- Unicode punctuation and non-ASCII source offsets;
- near-limit block, target, and association counts;
- long responses at 20, 21, 40, 41, 60, and 61 transformed blocks to exercise
  batch boundaries and the three-turn concurrency cap.

The harness should run the same source document through old and new adapters,
validate both expanded scripts, and report latency, token use, response size,
pronunciation cases, exact-word coverage, semantic-run coverage, block fallback,
batch count, and summary semantic target coverage.

Live model benchmarks should be explicit and opt-in. Unit and CI tests must not
depend on network model availability.

## Code Ownership

Keep orchestration readable by splitting new behavior at these boundaries:

| File | Ownership |
| --- | --- |
| `extensions/codex/server/src/narration.rs` | Job lifecycle, cache publication, cancellation, worker launch, and composition of planning/mapping results. |
| `extensions/codex/server/src/narration_planning.rs` | Versioned base prompt, compact types, exact schema, profile resolution, batching, app-server turns, validation, and atomic reassembly. |
| `extensions/codex/server/src/narration_source_mapping.rs` | Renderer-word extraction, spoken tokenization, bounded LCS, semantic hunk selection, and durable hint generation. |
| `extensions/codex/narration/kokoro_worker.py` | Kokoro-native token timing, prepared hint offsets, cue precedence, audio chunks, and final manifest. |
| `extensions/codex/shared/narration.ts` | Add `sourceWord`, `sourceSemantic`, and `summarySemantic` cue origins while retaining legacy origins for cached v2 artifact reads. |
| `extensions/codex/viewer/narration/textLeafRegistry.ts` | Mounted text-leaf registration and display-range-to-DOM-range resolution. |
| `extensions/codex/viewer/narration/paintController.ts` | Imperative cue paint transaction, structural class cleanup, geometry union, materialization guards, and lifecycle clearing. |
| `extensions/codex/viewer/narration/targetRegistry.ts` | Existing non-text element target registration and lookup; no text-range-to-block aliases. |
| `extensions/codex/viewer/transcript/components/markdown/MarkdownBlock.tsx` | Stable text-node rendering and leaf registration; no active-cue text splitting. |
| `extensions/codex/viewer/transcript/components/markdown/CodeBlock.tsx` | Stable code-line element registration; no `activeTargets` prop. |
| `extensions/codex/viewer/styles.css` | Exact narration tokens, highlight pseudo-element, structural classes, accessibility modes, and transitions. |

Register the two new Rust modules from `extensions/codex/server/src/main.rs`.
Keep provider-specific short JSON field names private to
`narration_planning.rs`; shared narration protocol types continue using
descriptive names.

New artifacts emit only `sourceWord`, `sourceSemantic`, `summarySemantic`, and
`fallback`. Keep `deterministic`, `scriptHint`, `forcedAlignment`, and
`ttsTiming` in the shared read union until the old-v2 observation window ends;
they are compatibility values, not new-generation output.

## Implementation Plan

### Phase 1: Profile resolution and metrics

1. Introduce the typed planning profile.
2. Resolve Sol and Priority from `model/list` before cache lookup.
3. Add standard-tier Sol as the only automatic pre-dispatch fallback.
4. Add `summary: none` and explicit tier/effort parameters.
5. Include actual model and tier in the provider descriptor and script key.
6. Add bounded planning-stage timing and usage diagnostics.

### Phase 2: Minimal narration thread

1. Create the neutral Remux narration context directory.
2. Add the exact `NARRATION_BASE_INSTRUCTIONS_V1` string and snapshot its
   bytes.
3. Send it through `baseInstructions`; send compact JSON alone as user input.
4. Add the exact thread `config` overrides and disable dynamic tools.
5. Parse only the authoritative completed agent message; use deltas for timing.
6. Assert exact thread and turn parameters in server tests.

### Phase 3: Compact planning adapter

1. Add descriptive internal compact request/response types with short wire
   renames.
2. Build immutable local block and target lookup tables.
3. Assign normalized/summary mode on the server and filter unspeakable content
   before dispatch.
4. Encode only transformed blocks and semantic target descriptors; exclude
   block and word targets.
5. Partition at 20 blocks or 4,000 UTF-16 code units, run at most three turns,
   and atomically reassemble validated results.
6. Add bounded labels for cell, line, and diagram targets.
7. Add the exact static `COMPACT_PLAN_SCHEMA_V2` and snapshot its bytes.
8. Decode, semantically validate, and expand into the durable narration script.
9. Remove durable IDs, mode choice, omission, fallback choice, and normalized
   alignment associations from the model-facing contract.

### Phase 4: Source mapping and cue precedence

1. Add the `regex` and `unicode-normalization` dependencies and the exact
   renderer-equivalent spoken-token pattern.
2. Consume renderer word targets as authoritative display tokens and add the
   bounded deterministic LCS for normalized units.
3. Map changed runs to the narrowest overlapping expression, inline-code, or
   link target and use block fallback otherwise.
4. Materialize ordered durable hints and implement the explicit cue precedence.
5. Retain Kokoro native timestamps behind the acoustic timing provider
   interface.
6. Delete the worker's independent normalized substring finder after replay
   coverage passes.
7. Add mapping coverage diagnostics and set source-mapping version 6.

### Phase 5: Renderer range overlay

1. Add the mounted Markdown text-leaf registry and imperative paint controller.
2. Register stable text nodes and display spans, including file-chip labels.
3. Remove active target props, `highlightedFragment`, and text-range IDs from
   block-frame registration.
4. Resolve active text targets into DOM ranges and block-relative overlay
   rectangles.
5. Add the exact narration theme tokens and target-specific CSS classes.
6. Add table-region perimeter edge calculation and structural class cleanup.
7. Use range or element union rectangles for auto-follow geometry.
8. Add atomic overlay clearing, pause/seek/end lifecycle,
   stale-materialization guards, forced-colors, and reduced-motion behavior.
9. Add PreText height-invariance and iOS/WKWebView device tests.

### Phase 6: Cache migration and regression coverage

1. Add the exact independent version constants specified above.
2. Verify old v2 artifacts remain readable.
3. Verify new profile changes cause deterministic cache misses.
4. Add fake app-server tests for catalog resolution, Priority selection, Sol
   fallback, and unavailable-model errors.
5. Add compact-contract validation and size-limit tests.
6. Run the full server, viewer, and device regression suites.

### Phase 7: Evaluation and rollout

1. Run at least ten live iterations of each benchmark corpus class.
2. Compare old and compact contracts using the same Sol Priority profile.
3. Review pronunciation and structural summaries, not just schema validity.
4. Enable the compact profile as the sole new-generation profile after gates
   pass.
5. Retain a development-only switch for replaying the old contract through two
   successful release builds and at least 14 calendar days after first rollout.
6. Remove the old generation path only after that window, 100 successful new
   artifacts, no unresolved severity-one narration regressions, and a cache
   compatibility audit.

## Test Plan

### Unit tests

- Compact block indexes are contiguous and stable for one request.
- Target indexes are local to their owning block.
- Durable lookup tables round-trip every source target kind.
- Compact serialization uses the expected short wire names.
- `NARRATION_BASE_INSTRUCTIONS_V1` is byte-stable and contains no dynamic
  content.
- `COMPACT_PLAN_SCHEMA_V2` is byte-stable for contract version 2.
- The output schema contains no source block or target IDs.
- Expansion reconstructs the expected durable v2 script.
- Unsupported versions, wrong segment counts, reordered blocks, duplicate
  blocks, empty speech, normalized associations, invalid targets, unordered
  associations, and unmatched associations are rejected.
- Aggregate limits reject oversized compact requests and responses before
  synthesis.
- The 20-block and 4,000-UTF-16-unit bounds partition deterministically without
  splitting a block.
- At most three app-server turns are active and later batches run in waves.
- One failed batch cancels siblings and publishes nothing.
- Equal normalized words map to their exact renderer word targets through
  nested inline leaves.
- Changed runs map to the narrowest overlapping inline-code, expression, or
  link target; unmatched changed runs use block fallback.
- Broad fallback never overrides an exact word target.
- Spoken tokenization matches the renderer word pattern for ASCII, Unicode,
  apostrophes, periods, underscores, and hyphens.
- The LCS word cap produces block fallback without an oversized allocation.
- Repeated words follow the documented earliest-display tie break.

### App-server integration tests

- Model catalog resolution selects Sol Priority when advertised.
- Resolution selects Sol standard before dispatch when Priority is absent.
- Missing Sol fails without dispatching a turn.
- The internal thread is ephemeral, read-only, neutral-CWD, environment-free,
  advertises no dynamic tools, and disables every supported general tool
  capability.
- The thread request contains the exact base-instruction and config snapshots;
  the user input is compact JSON with no prose prefix.
- The turn explicitly carries low effort, no reasoning summary, and the
  resolved tier.
- Composer model, effort, speed, personality, and working directory do not leak
  into narration planning.
- All matched valid batch completions reassemble once and start synthesis once.
- Deltas without a completed agent item fail; the authoritative completed item
  wins when delta concatenation differs.
- Disconnects and timeouts do not replay `turn/start`.
- Cancellation interrupts only the matched internal batch turns.

### Artifact tests

- Fully resolved provider fields appear in the script key and manifest profile.
- Standard and Priority artifacts do not collide.
- Context, instruction, prompt, contract, source-mapping, and acoustic-timing
  version changes invalidate the appropriate artifact layer.
- Source, worker, and manifest versions are not changed accidentally.
- Old v2 artifacts remain readable.
- Compact wire data is not persisted as the canonical script.

### End-to-end tests

- Existing narration preparation, cancellation, playback, semantic table-cell
  cues, block seeking, auto-follow, and composer controls remain behaviorally
  unchanged.
- Normalized words highlight through plain spans, strong, emphasis, links,
  inline code, and nested inline leaves.
- Structural summaries still fall back to honest block or semantic targets.
- Highlight changes add no Markdown React rerender and no PreText height change.
- Range auto-follow resolves the active range rectangle after virtualization.
- Inline-flex file-link labels use the same range overlay and never receive an
  active element class.
- Word cues add one foreground rectangle and a lighter prose-context rectangle;
  code-line cues use the rail and table regions show one outer perimeter.
- Pause retains paint, seek replaces it, playback end clears it, and a stale
  materialization callback cannot repaint an old cue.
- Dark, light, reduced-motion, and forced-colors snapshots cover every target
  class using the exact theme tokens in this spec.

## Acceptance Criteria

The optimization is complete when:

1. every newly generated narration artifact records an explicit model and
   service tier rather than `default`;
2. the preferred resolved profile is Sol Priority at low effort with reasoning
   summaries disabled;
3. the narrator receives no repository-scoped instructions or repo-scoped
   skills; it advertises no dynamic tools, invokes no skill or tool, and every
   independently configurable general capability is disabled;
4. the model-facing contract contains no durable renderer IDs;
5. the output schema is static for a planning contract version;
6. compact responses pass all semantic validation before expansion or
   synthesis;
7. expanded scripts remain compatible with Kokoro and the durable manifest
   boundary while normalized cue targeting uses the versioned source mapper;
8. all replay-corpus cases generate valid scripts across at least ten live
   runs per class;
9. on the validated complex fixture, compact planning achieves a median of at
   most 12 seconds and p95 of at most 18 seconds on the current reference
   machine and account conditions;
10. the compact contract reduces median complex planning time by at least 40%
    relative to the old contract on the same Sol Priority profile;
11. small normalization requests have a median planning time of at most 6
    seconds;
12. the 58-transformed-block long fixture uses three batches and achieves a
    median wall time of at most 18 seconds and p95 of at most 24 seconds;
13. normalized replay fixtures achieve at least 85% exact-word mapping and 95%
    combined word-or-semantic mapping without incorrect word targets;
14. pronunciation review finds no regression for time frames, currency,
    percentages, URLs, or identifiers;
15. production artifacts use Kokoro-native timing and load no forced-alignment
    acoustic model;
16. active text cues create no inline Markdown DOM nodes, mutate no text or chip
    elements, and produce a zero-pixel PreText height delta in desktop and
    minimum-supported-iOS device tests;
17. active words paint correctly inside plain spans, strong, emphasis, links,
    inline code, and supported nested combinations;
18. transport or sibling-batch failures cannot produce an automatic ambiguous
    replay or partial artifact;
19. old cached v2 artifacts remain playable;
20. the shipped base-instruction bytes, compact schema bytes, version constants,
    and thread configuration match this spec's snapshots;
21. target-specific dark/light styling matches the specified tokens and does
    not use the removed generic active-target background;
22. the full Codex server and desktop/mobile viewer suites remain green.

## Deferred Follow-Ups

- Deterministic normalization for common notation before invoking a model.
- Separate model calls for structural summaries and pronunciation rewrites.
- A semantic repair turn for matched-but-invalid completed responses.
- Required table-region and diagram-node summary associations after a dedicated
  semantic-highlighting corpus establishes quality.
- A forced-alignment timing provider for a future synthesizer without reliable
  generation-native timing, or for opt-in offline diagnostics.
- Additional model profiles after a replay corpus establishes quality gates.
- A development-only Codex skill for running narration evaluations. Such a
  skill must never be part of the production narration thread.
- User-visible model, quality, speed, or credit controls.

## R&D References

- [Official Codex app-server protocol and lifecycle](https://learn.chatgpt.com/docs/app-server)
- [WebKit: Safari 17.2 Custom Highlights](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)
- [W3C CSS Custom Highlight API Level 1](https://www.w3.org/TR/css-highlight-api-1/)
- [W3C highlight pseudo-element paint-only properties](https://www.w3.org/TR/css-pseudo-4/#highlight-styling)
- [W3C box-shadow layout behavior](https://www.w3.org/TR/css-backgrounds-3/#shadow-layers)
- [Visual Studio Code editor highlight color patterns](https://code.visualstudio.com/api/references/theme-color)
- [WebKit bug 278455: custom highlights and `user-select: none`](https://bugs.webkit.org/show_bug.cgi?id=278455)
- [WebKit bug 307455: custom highlights inside flex containers](https://bugs.webkit.org/show_bug.cgi?id=307455)
- [PyTorch/TorchAudio forced-alignment tutorial and deprecation notice](https://docs.pytorch.org/audio/stable/tutorials/forced_alignment_tutorial.html)
- [Kokoro model and pipeline source](https://github.com/hexgrad/kokoro)
- [WhisperX paper](https://arxiv.org/abs/2303.00747)
- [Montreal Forced Aligner documentation](https://montreal-forced-aligner.readthedocs.io/en/latest/)

## Decision Closure

This spec is decision-complete for implementation. In particular:

- the production model/profile is Sol Priority, low effort, no reasoning
  summary, with Sol standard as the only pre-dispatch fallback;
- the production planner is a direct app-server turn, not a skill or subagent;
- the exact production base prompt and output schema are included above and
  byte-snapshotted;
- the compact contract is version 2 and contains server-owned mode plus speech
  and sparse summary semantic associations only;
- batches are bounded at 20 transformed blocks or 4,000 UTF-16 code units,
  with concurrency capped at three;
- normalized source alignment is deterministic and model-independent;
- Kokoro native timings are authoritative and forced alignment is not shipped;
- active word paint uses DOM ranges and block-local overlay rectangles; structural paint
  uses the exact target-specific glow classes and theme tokens above, without
  changing measured Markdown geometry;
- aggregate planning metrics are available through a development-only resource;
- old generation remains available for two successful releases and at least 14
  days, then is removed only after 100 successful new artifacts and the stated
  regression gates.

Any change to these decisions requires an explicit spec revision and the
relevant replay benchmark; implementation should not silently choose among
alternatives.
