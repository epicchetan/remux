# Codex Assistant Response Narration Spec

Status: Archived — superseded by `docs/specs/narrate-streaming-g2p.md`
Last verified: 2026-07-13
Canonical code: `extensions/codex/viewer/transcript/components/assistantMessage.tsx`, `extensions/codex/viewer/composer/actions/ActionButtons.tsx`, `extensions/codex/viewer/composer/content.tsx`, `extensions/codex/viewer/transcript/components/markdown/`, `extensions/codex/server/src/app_server.rs`, `extensions/codex/server/src/main.rs`

> Historical behavior/UI spec. Its provider, RPC, readiness, cache, and
> compatibility contracts are not current after the direct Narrate v5 cutover.

> This document describes the initial narration architecture and remains the
> behavioral baseline. The versioned cleanup, alignment, viewport, and provider
> architecture for the next implementation pass is specified in
> `docs/specs/codex/assistant-narration-v2.md`. Where the documents differ, the
> v2 spec governs new work.

## Summary

Add on-demand, cached narration for completed Codex assistant responses.

Each completed assistant response gets a **Narrate** action immediately after the existing **Fork** action:

```text
Copy   Fork   Narrate
```

Selecting Narrate asks the Codex extension server to create or reuse a speakable version of that response. Codex rewrites only content that needs narration-specific treatment, such as code, tables, diagrams, URLs, currency, and technical notation. A local Kokoro worker generates timed audio. The viewer plays the result while highlighting the current Markdown block and, where the narration is verbatim, the current word.

Narration preparation uses the same slim context-row treatment as edit and fork state. Once an artifact is ready, narration temporarily replaces the normal right-side composer actions with playback controls:

```text
Previous block   Next block   Play/Pause   Speed   Close
```

The feature is on demand, does not stream partial audio, and caches a completed artifact until the source response or narration configuration changes.

## Validated Feasibility Baseline

The architecture was exercised against an actual completed Codex response containing prose, headings, code blocks, a flow diagram, JSON examples, and a provider-comparison table.

- Source response: 14,247 characters and 136 normalized Markdown blocks.
- Codex narration plan: 136 ordered segments, with no missing, duplicate, or unknown IDs.
- Verbatim prose: 120 blocks, all exact.
- Code and table blocks: all seven converted to concise spoken summaries.
- Codex planning time: 78.6 seconds at low reasoning with an intentionally over-granular schema.
- Speakable transcript: 11,160 characters.
- Kokoro audio: 13 minutes 45 seconds generated in 71.4 seconds on CPU.
- Alignment: 1,850 of 1,852 eligible tokens timed; the only untimed tokens were literal dollar signs that require pronunciation normalization.
- Timestamp order and bounds: valid for the complete waveform.

The production design reduces Codex latency by passing ordinary prose through deterministically and asking Codex to transform only pronunciation-sensitive or structurally complex blocks.

## Product Contract

### Response action

1. Show the Narrate action only for a completed, non-empty assistant message.
2. Place it directly after Fork in the assistant action row.
3. Preserve the existing action-row dimensions so adding Narrate does not change transcript measurement.
4. Give the action an accessible label that reflects its state:
   - `Narrate response`
   - `Preparing narration`
   - `Play narration`
   - `Narration failed; retry`
5. Clicking a cached response enters playback without regenerating it.
6. Clicking an uncached response starts one asynchronous server job.
7. Requests for the same artifact key deduplicate onto the same job.

### Preparation UI

While work is pending, render a dedicated narration row inside the existing composer context strip:

```text
Speaker   Preparing narration · Writing script                 Cancel
Speaker   Preparing narration · Generating audio 42%           Cancel
```

This row must:

- use the existing `remux-composer-context-row` geometry;
- sit immediately above the composer panel;
- avoid padded card presentation;
- leave the composer editor, its document, attachments, and queue state intact;
- expose Cancel while planning or synthesizing;
- expose Retry and Close after a failure;
- become `Narration ready` with Play and Close when automatic activation is not appropriate.

Narration preparation is not an edit or fork mode. It gets its own component and store, even though it shares their visual language.

### Playback controls

During an active narration session, keep the left composer action group unchanged and replace the normal right-side composer action group with:

| Control | Behavior |
| --- | --- |
| Arrow up | Seek to the start of the previous narrated Markdown block. |
| Arrow down | Seek to the start of the next narrated Markdown block. |
| Play/Pause | Toggle narration playback. Show Pause while audio is playing and Play while it is paused. |
| Playback speed | Open a menu containing the available playback rates. Display the selected rate on the control. |
| Close | Stop playback, remove highlights, release client audio resources, and restore normal composer actions. |

The control order is:

```text
Arrow up   Arrow down   Play/Pause   Rate   Close
```

The normal up/down, attachment, stop/send controls are not rendered underneath the narration controls.

For the first implementation, narration playback is unavailable while a Codex turn is active. If a new turn becomes active through another path while narration is open, pause and close narration before exposing the normal Stop control. This prevents playback mode from hiding the critical turn-interrupt action.

### Block seeking

1. Up seeks to the previous speakable block; down seeks to the next speakable block.
2. Omitted and empty blocks are skipped.
3. Seeking while playing continues playback from the selected block.
4. Seeking while paused keeps playback paused.
5. Disable Up at the first narrated block and Down at the last narrated block.
6. Explicit block seeking scrolls the destination block into view and resumes auto-follow.
7. Natural playback scrolls only when the active block leaves the viewport.
8. Manual scrolling temporarily suspends auto-follow until the user seeks or explicitly returns to the narration position.

### Playback speed

Initial options:

```text
0.75×
1×
1.25×
1.5×
2×
```

- Default to `1×`.
- Persist the selection locally as `narrationPlaybackRate`.
- Do not reuse Codex composer `speed`; that setting controls Codex behavior, not audio playback.
- Set `preservesPitch` when supported.

### Playback start

Generation can take long enough that the original Narrate click no longer carries a valid WKWebView media user gesture. Therefore:

1. On completion, enter ready/paused state.
2. Show Play rather than assuming autoplay will succeed.
3. An implementation may attempt autoplay on platforms that permit it, but a rejected autoplay request is not an error; remain ready and paused.

### Closing and cancellation

Preparation Cancel and playback Close have different ownership semantics.

Preparation Cancel:

- interrupts the internal Codex turn when planning;
- cancels the Kokoro worker operation when synthesizing;
- deletes partial temporary output;
- returns the requesting viewer to idle.

Playback Close:

- pauses and resets audio;
- clears block and word highlights;
- revokes loaded Blob URLs;
- restores the normal composer action group;
- preserves draft text and attachments;
- leaves the completed server artifact cached.

## Non-Goals

The first implementation does not provide:

- background playback;
- lock-screen or system media controls;
- partial or streaming audio playback;
- narration for an assistant message that is still streaming;
- cloud TTS fallback;
- multiple simultaneous CPU synthesis jobs;
- word-to-cell highlighting for synthetic table summaries;
- word-to-line highlighting for synthetic code summaries;
- restoration of playback position after a WebView reload;
- guaranteed gapless transitions between audio chunks.

## Ownership Model

Keep source content, generated artifacts, and playback session state separate.

```text
Codex transcript
  authoritative assistant message text and revision
          │
          ▼
NarrationJobManager in the Rust extension server
  validates target, owns job lifecycle, app-server planning,
  worker supervision, cache, cancellation, and resource state
          │
          ▼
Content-addressed narration artifact
  manifest + bounded audio chunks
          │
          ▼
Viewer narration store/player
  owns loaded audio, playback position, active highlight,
  playback rate, and temporary composer presentation mode
```

The composer store does not own narration state. The transcript does not include narration jobs or artifacts.

## Source and Cache Identity

Identify a narration request with:

```ts
type CodexNarrationTarget = {
  threadId: string;
  turnId: string;
  assistantMessageId: string;
  messageRevision: string;
  sourceHash: string;
};
```

The artifact key includes:

```text
assistant message text hash
normalized block-document hash
narration prompt version
Codex narration model
reasoning effort
Kokoro model version
voice version
speech speed
worker protocol version
```

If the assistant message changes, its source hash and artifact key change. A stale completed job may remain in the cache, but the viewer must not attach it to the changed response.

## Markdown Block Model

### Stable IDs

The renderer, Codex plan, alignment manifest, block controls, and highlights must use the same deterministic block IDs.

Extend the viewer Markdown model to assign paths to speakable leaf blocks. Example paths:

```text
0
1
2/list/0/0
2/list/1/0
3/blockquote/0
4/table
5/code
```

Rules:

- paragraphs and headings are individual blocks;
- each list item is independently seekable;
- blockquote children are independently seekable;
- one fenced code block is one narration block;
- one table is one narration block initially;
- thematic rules and empty blocks are omitted.

### Source document

The viewer builds the narration source document from the same parsed Markdown model used for rendering:

```ts
type NarrationSourceBlock = {
  id: string;
  path: string;
  kind:
    | 'paragraph'
    | 'heading'
    | 'listItem'
    | 'blockquote'
    | 'code'
    | 'table';
  displayText: string;
  sourceStart: number;
  sourceEnd: number;
  inlineRanges: Array<{
    kind: 'text' | 'inlineCode' | 'link';
    displayStart: number;
    displayEnd: number;
    sourceStart: number;
    sourceEnd: number;
  }>;
};
```

The Rust server validates the assistant message identity, revision, and source hash against disk-backed transcript data, with the live completed transcript as a fallback. It should not independently reinterpret the Markdown into a second block hierarchy.

## Speakable Plan

### Deterministic pass-through

Ordinary prose passes through without a model call when it contains no pronunciation-sensitive spans. This keeps exact display-to-speech mapping and reduces planning latency.

Send Codex only blocks or spans containing:

- code blocks or inline code;
- tables;
- diagrams;
- headings that need natural transitions;
- URLs;
- currency;
- technical symbols or type notation;
- opaque acronyms and identifiers;
- content the deterministic classifier cannot safely pronounce.

### Codex output

Use an ephemeral app-server thread, low reasoning, no tools, no environment access, and a strict output schema:

```ts
type NarrationPlanSegment = {
  blockId: string;
  mode: 'verbatim' | 'normalized' | 'summary' | 'omit';
  spokenText: string;
  displayRanges?: Array<{
    displayStart: number;
    displayEnd: number;
    spokenStart: number;
    spokenEnd: number;
  }>;
};
```

Modes:

- `verbatim`: spoken text exactly matches visible text; enable word highlighting.
- `normalized`: a source expression gets a natural pronunciation, such as `$5` becoming “five dollars”; highlight the replaced source span as a unit.
- `summary`: Codex creates a concise spoken explanation for code, a table, or a diagram; highlight the whole block.
- `omit`: skip decorative or redundant content.

Reject plans containing missing, duplicate, unknown, or reordered block IDs; invalid display ranges; empty non-omitted speech; or non-exact verbatim text. Retry planning once, then expose an ordinary retryable narration failure.

## App-Server Isolation

Narration must not enter the user-visible Codex transcript or normal completion-notification path.

Use a dedicated app-server connection to the existing app-server process:

```text
Existing Codex app-server process/socket
  ├── normal Remux connection → transcript/runtime/usage/queue events
  └── narration connection → NarrationJobManager only
```

Start the narration thread with:

```json
{
  "ephemeral": true,
  "approvalPolicy": "never",
  "sandbox": "read-only",
  "environments": [],
  "experimentalRawEvents": false,
  "serviceName": "remux-narration"
}
```

The dedicated connection owns its narration notifications and collects the completed structured assistant message. As defense in depth, register internal narration thread IDs and suppress any matching events that reach the normal app-server event forwarder.

An internal narration turn must never:

- update `LiveTranscriptStore`;
- update visible thread runtime or usage state;
- drive the pending message queue;
- emit thread or turn resource invalidations;
- emit a user-facing “Codex finished” notification;
- appear in persisted thread history.

## Asynchronous Server Job

The extension server handles viewer JSON-RPC synchronously, so narration work cannot run inside the request handler.

`narration/start` performs validation, creates or joins a job, and returns immediately. Planning and synthesis run on a background worker thread.

State machine:

```text
missing
  → planning
  → synthesizing
  → ready

planning or synthesizing
  → failed
  → cancelled
```

Initial RPC surface:

| Method | Purpose |
| --- | --- |
| `remux/codex/narration/resources/read` | Read cache/job status and the ready manifest. |
| `remux/codex/narration/start` | Create or join one content-addressed narration job. |
| `remux/codex/narration/cancel` | Cancel an incomplete narration job. |
| `remux/codex/narration/audio/read` | Read one bounded audio chunk by artifact key and chunk ID. |

Add a narration resource invalidation to the existing invalidation stream. Coalesce synthesis progress invalidations to at most two per second. Planning is indeterminate; synthesis reports completed units and total units.

Only one Kokoro synthesis job runs at a time in the first implementation. Requests for the same artifact reuse the in-flight work. A request for a different artifact receives a clear busy state rather than silently starting competing CPU inference.

## Kokoro Worker

Keep inference outside the Rust extension process in a persistent, supervised worker using newline-delimited JSON over stdin/stdout.

```text
Rust NarrationJobManager
        ↕ NDJSON
Kokoro worker
  loads model and voice once
  synthesizes bounded units
  emits progress
  writes audio and alignment
```

Pin the model, voice, Kokoro version, phonemizer version, sample rate, and worker protocol version. Verify downloaded model assets by checksum. Surface first-run runtime or model installation as another preparation stage instead of appearing hung.

Cancellation must stop the current worker operation and prevent partial output from becoming a valid artifact.

## Audio Artifacts and Transport

Store artifacts under:

```text
$CODEX_HOME/remux/narration/v1/{artifactKey}/
  manifest.json
  audio/
    000.wav
    001.wav
    ...
```

Write into a temporary sibling directory and atomically rename it only after validating the manifest and every audio file.

For the first implementation, concatenate blocks into PCM WAV chunks of approximately 45–60 seconds and split only at block boundaries. Do not send one response-length WAV through JSON-RPC: a long response can create tens of megabytes of PCM plus base64 overhead in WKWebView.

`narration/audio/read` accepts an artifact key and chunk ID, not an arbitrary path. The viewer loads the current and next chunks, creates Blob URLs, and releases them after use. Previous chunks can be reloaded for backward seeking.

A future compressed AAC or M4A artifact can improve storage and gapless playback, but it is not required for the first pass.

## Manifest

```ts
type NarrationManifest = {
  version: 1;
  artifactKey: string;
  sourceHash: string;
  durationSeconds: number;
  chunks: Array<{
    id: string;
    start: number;
    end: number;
    sampleRate: number;
    sizeBytes: number;
  }>;
  segments: Array<{
    blockId: string;
    mode: 'verbatim' | 'normalized' | 'summary';
    spokenText: string;
    start: number;
    end: number;
    chunkId: string;
    words: Array<{
      text: string;
      start: number;
      end: number;
      displayStart?: number;
      displayEnd?: number;
    }>;
    sentences: Array<{
      start: number;
      end: number;
      firstWord: number;
      lastWord: number;
    }>;
  }>;
};
```

Before publication, validate monotonic finite times, chunk and segment containment, display ranges, expected sample counts, and source/block identity.

## Cache Lifecycle

- Cache only fully validated artifacts.
- Use atomic temporary-directory promotion.
- Remove abandoned temporary directories at extension startup.
- Retain artifacts across viewer and extension-server reloads.
- Never evict the artifact currently playing.
- Start with a 2 GB total cache limit and least-recently-used eviction.
- A changed source response selects a new key; old artifacts become ordinary eviction candidates.

## Viewer State

Create a narration Zustand store separate from the composer, transcript resource, layout, and viewport stores:

```ts
type NarrationPhase =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'failed';

type NarrationState = {
  target: CodexNarrationTarget | null;
  artifactKey: string | null;
  phase: NarrationPhase;
  stage: 'planning' | 'synthesizing' | null;
  completedUnits: number | null;
  totalUnits: number | null;
  manifest: NarrationManifest | null;
  currentBlockId: string | null;
  currentWordIndex: number | null;
  globalTimeSeconds: number;
  playbackRate: number;
  error: string | null;
};
```

Suggested viewer files:

```text
viewer/narration/store.ts
viewer/narration/player.ts
viewer/narration/audioLoader.ts
viewer/narration/NarrationBar.tsx
viewer/narration/PlaybackActions.tsx
viewer/narration/SpeedMenu.tsx
viewer/ipc/narration.ts
shared/narration.ts
```

Starting or closing narration must not call composer document mutation methods.

## Playback Clock

Use one `HTMLAudioElement` and one animation loop only while playing.

On each animation frame:

1. Read chunk-local `audio.currentTime`.
2. Convert it to global narration time.
3. Binary-search the manifest for the active segment and word.
4. Publish state only when the active word or block changes.

Do not update React state every frame. Cancel the animation frame immediately on pause, close, unmount, or chunk transition.

## Highlighting and PreText

Narration must not change the dimensions calculated by PreText.

Allowed visual changes include background, color, box shadow, outline, and opacity. Narration highlighting must not change font, weight, padding, border width, margin, line height, display mode, or text contents.

Highlight behavior:

- `verbatim`: highlight the active source word.
- `normalized`: highlight the complete source expression represented by the spoken replacement.
- `summary`: highlight the complete code, table, or diagram block.

Extend layout fragments with visible-text offsets. Memoize block nodes so a word change rerenders only the old and new active blocks. The transcript virtualizer's measured row height must be identical before, during, and after narration.

Use known PreText block offsets and the transcript viewport controller for auto-follow. Do not measure every active word with DOM layout reads and do not call `scrollIntoView` on every word.

## Interactions with Existing Composer Modes

1. Narration preparation may coexist visually with an ordinary draft because it is a separate context row.
2. Do not automatically enter playback controls while edit, fork, or directory-picker mode is active; show `Narration ready` instead.
3. Entering edit, fork, or directory-picker mode while playback is active closes narration first.
4. A pending message queue does not invalidate a narration artifact.
5. An active Codex turn prevents playback mode in the first implementation so Stop remains immediately available.
6. Switching threads pauses and releases viewer playback resources. An in-progress server job may finish and remain cached.
7. Reloading the WebView stops playback but retains server artifacts.

## Error Handling

Use the preparation context row for actionable narration errors:

```text
Warning   Narration could not be prepared                 Retry   Close
```

Failure behavior:

- invalid target or stale revision: return to idle and require a fresh request;
- Codex schema failure after one retry: mark the job failed;
- app-server disconnect: fail planning without touching visible transcript state;
- worker failure: delete partial output and mark failed;
- malformed alignment or audio: reject the artifact and mark failed;
- audio chunk load failure: pause and expose Retry without deleting the server artifact;
- unsupported media autoplay: remain ready/paused rather than reporting failure.

## Implementation Plan

### Phase 1: Contracts and fake job

1. Add shared narration target, resource, manifest, and invalidation types.
2. Add narration read/start/cancel/audio IPC wrappers.
3. Add an asynchronous `NarrationJobManager` with fake staged progress.
4. Prove `narration/start` returns without blocking other extension requests.
5. Add a fake, bounded audio artifact for viewer integration tests.

### Phase 2: Response and composer UI

1. Add Narrate immediately after Fork in the assistant response action row.
2. Add the slim NarrationBar to the composer context strip.
3. Add the separate viewer narration store.
4. Add playback action substitution in `ComposerActionButtons`.
5. Add block buttons, play/pause, speed menu, and close behavior.
6. Prove composer drafts and attachments survive the complete lifecycle.

### Phase 3: Stable Markdown blocks

1. Add deterministic narration paths to parsed Markdown blocks.
2. Export the normalized block document used by both rendering and narration requests.
3. Add visible-text ranges to layout fragments.
4. Add block registration and viewport navigation.
5. Prove block identity remains stable across cached layout reads.

### Phase 4: Isolated Codex planning

1. Add a dedicated app-server connection for narration.
2. Add ephemeral thread and turn lifecycle collection.
3. Add deterministic prose classification and pass-through.
4. Add strict schema generation and validation for complex blocks.
5. Suppress internal thread events from normal transcript and notifications.
6. Cache the validated speakable plan.

### Phase 5: Kokoro and artifact cache

1. Add the pinned persistent worker protocol and supervisor.
2. Add runtime/model bootstrap with visible progress.
3. Generate bounded WAV chunks and alignment.
4. Add cancellation, atomic promotion, validation, and cache reuse.
5. Add bounded audio reads and LRU cleanup.

### Phase 6: Highlighting and hardening

1. Add word, normalized-span, and whole-block highlighting.
2. Add the audio-driven clock with state-change coalescing.
3. Add auto-follow and manual-scroll suspension.
4. Test long-response memory and scroll performance on iOS WKWebView.
5. Add accessibility, reduced-motion, reload, and failure coverage.

## Test Plan

### Server tests

1. Start validates the source target and returns immediately.
2. Identical requests deduplicate onto one job.
3. Cache hits skip Codex and Kokoro.
4. Changed source text creates a new artifact key.
5. Codex output rejects missing, duplicate, unknown, or reordered blocks.
6. Verbatim output rejects changed text.
7. Internal narration events do not mutate transcript, runtime, usage, or queue stores.
8. Internal completion does not emit a user-facing notification.
9. Cancel interrupts planning and removes partial output.
10. Cancel interrupts synthesis and removes partial output.
11. Worker failure cannot publish a ready artifact.
12. Manifest validation rejects non-monotonic or out-of-bounds timing.
13. Atomic promotion prevents readers from seeing incomplete output.
14. LRU cleanup preserves active artifacts.
15. Extension restart removes abandoned temporary directories and reuses complete artifacts.

### Viewer tests

1. Narrate appears immediately after Fork only on completed assistant responses.
2. An uncached request shows the slim preparation row.
3. Preparation progress does not clear or replace a composer draft.
4. Ready playback replaces the right composer action group with exactly five controls.
5. Up/down seek to previous/next speakable Markdown blocks.
6. Seeking preserves playing or paused state.
7. Play/Pause updates its icon and accessible label.
8. Speed menu applies and persists the selected rate.
9. Close restores normal controls and preserves the composer document.
10. A new active Codex turn closes narration before showing Stop.
11. A cache hit enters ready state without a generation stage.
12. Thread switching and WebView reload release Blob URLs and stop audio.
13. Audio load failure produces a retryable state.

### Markdown and layout tests

1. Stable IDs cover paragraphs, headings, list items, blockquotes, code, and tables.
2. The same Markdown and width produce the same block paths from cache.
3. Verbatim word ranges map to rendered fragments.
4. Normalized replacements highlight their complete source span.
5. Code and table summaries highlight only their complete block.
6. PreText document height is identical with no highlight, block highlight, and word highlight.
7. Transcript row and virtualizer heights do not change during playback.
8. Playback clock updates do not invalidate unrelated transcript rows.
9. Auto-follow uses layout offsets without per-word DOM measurement.

### Device validation

1. WKWebView can play a generated chunk after an explicit Play tap.
2. Playback speed preserves understandable pitch.
3. Chunk transitions are acceptable for narration.
4. Momentum scrolling remains responsive during playback and highlighting.
5. A long response does not create a single oversized JSON/WebSocket frame.
6. Pausing, seeking, and closing remain responsive during virtualized transcript scrolling.

## Acceptance Criteria

The feature is complete when:

1. Every completed assistant response exposes Narrate immediately after Fork.
2. Narration creation is on demand and a completed artifact is reused until its cache key changes.
3. Preparation appears as a slim composer context row and never mutates the composer document.
4. Playback exposes Previous block, Next block, Play/Pause, Speed, and Close in the composer action area.
5. Up/down seek by speakable Markdown block, not by turn or arbitrary time interval.
6. Close restores normal composer controls and leaves the artifact cached.
7. Ordinary prose is word-highlighted with accurate timing.
8. Normalized expressions highlight their source span.
9. Code, tables, and diagrams receive concise narration and whole-block highlighting.
10. Highlighting never changes PreText or virtualizer height.
11. Playback and highlighting do not degrade momentum scrolling.
12. Internal Codex narration turns never appear in transcript history, runtime state, queue state, or completion notifications.
13. Narration generation never blocks unrelated extension RPC.
14. Partial, malformed, stale, or cancelled artifacts are never served as ready.
15. Completed artifacts survive viewer and extension-server reloads.
16. Server, viewer, Playwright, layout, and device validation suites pass.
