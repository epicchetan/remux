# Codex Assistant Narration V2 Cleanup Spec

Status: Core cleanup implemented; provider and distribution hardening remains planned
Last verified: 2026-07-11
Supersedes for new work: `docs/specs/codex/assistant-narration.md`
Canonical implementation areas: `extensions/codex/shared/narration.ts`, `extensions/codex/server/src/narration.rs`, `extensions/codex/narration/`, `extensions/codex/viewer/narration/`, `extensions/codex/viewer/transcript/components/markdown/`, `extensions/codex/viewer/transcript/virtualizer.tsx`, `extensions/codex/viewer/transcript/viewportStore.ts`

## Summary

Clean up narration around four independently replaceable layers:

1. the Markdown renderer describes stable semantic targets;
2. a script generator creates natural speech associated with those targets;
3. a synthesizer and aligner produce audio timing and validated source cues;
4. the viewer plays cues and asks the transcript viewport to position targets.

The cleanup fixes incomplete word highlighting, unreliable auto-follow, and
awkward `scrollIntoView` positioning without assuming that Kokoro, Codex, or the
current alignment strategy will remain permanent.

The design must leave room for:

- trying other narration and TTS models through Codex;
- replacing native TTS token timing with forced alignment;
- combining deterministic, model-provided, and acoustic alignment;
- highlighting normalized expressions rather than arbitrary words;
- highlighting table cells, table regions, code lines, diagram nodes, or
  multiple Markdown targets during generated explanations;
- improving generation stages without rewriting the player or viewport;
- changing frontend presentation without regenerating audio.

## Current Problems

### Highlighting

The current worker adds display offsets only when a segment is `verbatim`.
`normalized` and `summary` segments have no source mapping and fall back to a
whole-block highlight. The distinction is valid, but the absence of an explicit
fallback makes incomplete alignment look like a rendering failure.

Verbatim offsets are found with a monotonic `displayText.find(tokenText)` call.
Kokoro may change punctuation, whitespace, Unicode forms, or token boundaries,
so an otherwise ordinary word can fail exact matching.

Every heading is currently sent through the script model. Transformed segments
cannot return verbatim source offsets, so even ordinary headings lose word
highlighting unnecessarily.

The present manifest can address a block or a text range only implicitly. It
cannot describe a table cell, code line range, diagram node, or a group of
targets.

### Scrolling

The audio player currently queries the document and calls `scrollIntoView`.
This bypasses the transcript virtualizer, cannot mount an offscreen turn, does
not account for the composer-obscured viewport, and lets the browser choose the
effective position.

Any pointer, touch, or wheel interaction suspends automatic following, but the
state is invisible and has no direct recovery control. Explicit seeking resets
the hidden suspension as a side effect.

### Ownership

The player currently owns audio, DOM discovery, transcript input listeners, and
scroll policy. That makes the audio engine hard to test and makes future
alignment or viewport changes depend on unrelated playback code.

The current artifact key correctly prevents stale reuse, but it treats the
whole generation process as one version. Changing alignment, script generation,
TTS, or presentation should have distinct invalidation behavior.

## Product Decisions

The cleanup adopts these decisions:

- Auto-follow is enabled by default.
- The active target is positioned at 30% of the usable transcript viewport.
- Natural playback uses a reading band from 22% to 65% and scrolls only when the
  target leaves that band.
- Manual transcript scrolling suspends auto-follow and visibly turns its button
  off.
- Tapping Auto-follow enables it and immediately returns to the active target.
- Explicit Previous/Next navigation always positions its destination at 30%,
  but does not change the user's auto-follow preference.
- Previous and Next continue to navigate narrated Markdown blocks in v2.
  Sentence timing remains available for a future navigation mode.
- During playback, hide the composer configuration button.
- Playback controls are ordered as:

```text
Auto-follow   Previous block   Next block   Play/Pause   Speed   Close
```

- Overview and History remain visible in the left composer action group.
- Word highlighting is used only when the source mapping is trustworthy.
- Normalized speech highlights its source expression as a unit.
- Generated summaries highlight the best available semantic region, falling
  back to the entire block.
- Highlighting must never change PreText dimensions.

## Architectural Boundaries

```text
Renderer-owned Markdown surface
  stable blocks, text ranges, cells, lines, semantic regions
                         │
                         ▼
Narration script
  natural spoken units + source targets + alignment hints
                         │
                         ▼
Audio synthesis
  replaceable TTS provider + raw token timing
                         │
                         ▼
Alignment
  replaceable aligner + validated source cues + confidence
                         │
                         ▼
Narration artifact
  immutable script, audio, timing, cues, provider descriptors
                         │
                         ▼
Viewer session
  audio engine → cue resolver → Markdown highlighter
                         │
                         ▼
Transcript viewport controller
  virtualization, reading position, native-scroll ownership
```

The renderer owns what can be highlighted. Models may select or describe
renderer targets, but they do not invent DOM selectors or reinterpret Markdown
identity.

The server owns generation profiles, version resolution, validation, cache
identity, and artifact publication. The viewer never decides which model or
aligner generated an artifact.

The audio engine owns media only. It must not query Markdown, listen to
transcript gestures, or write transcript scroll positions.

## Renderer-Owned Semantic Surface

### Source document

Build one immutable source document from the exact parsed Markdown model used by
rendering and PreText:

```ts
type NarrationSourceDocument = {
  schemaVersion: 2;
  documentVersion: string;
  messageId: string;
  messageRevision: string;
  sourceHash: string;
  blocks: NarrationSourceBlock[];
  targets: NarrationSourceTarget[];
};

type NarrationSourceBlock = {
  id: string;
  path: string;
  kind:
    | 'paragraph'
    | 'heading'
    | 'listItem'
    | 'blockquote'
    | 'code'
    | 'table'
    | 'diagram';
  displayText: string;
  sourceStart: number;
  sourceEnd: number;
  targetIds: string[];
};
```

IDs must be independent of line wrapping, viewport width, and DOM mounting.
Text offsets are UTF-16 offsets into the block's logical `displayText`, matching
the offsets consumed by the React renderer.

### Generalized source targets

Use a discriminated target model rather than adding special fields to words:

```ts
type NarrationSourceTarget =
  | {
      id: string;
      kind: 'block';
      blockId: string;
    }
  | {
      id: string;
      kind: 'textRange';
      blockId: string;
      displayStart: number;
      displayEnd: number;
    }
  | {
      id: string;
      kind: 'tableCell';
      blockId: string;
      row: number;
      column: number;
      role: 'header' | 'body';
    }
  | {
      id: string;
      kind: 'tableRegion';
      blockId: string;
      rowStart: number;
      rowEnd: number;
      columnStart: number;
      columnEnd: number;
    }
  | {
      id: string;
      kind: 'codeLines';
      blockId: string;
      lineStart: number;
      lineEnd: number;
    }
  | {
      id: string;
      kind: 'diagramNode';
      blockId: string;
      nodeId: string;
    };
```

V2 initially needs to render `block` and `textRange`. It should emit stable
`tableCell` and `codeLines` targets now where the renderer already has the
structure, even if generation does not select them yet. `tableRegion` and
`diagramNode` may remain capability-gated until their renderers expose stable
semantics.

Target validation occurs against the source document. Unknown IDs, invalid
ranges, and out-of-bounds table or line coordinates reject an artifact before
publication.

### Renderer resolution

The Markdown renderer resolves target IDs into visual state. It may render one
or multiple simultaneous targets. Allowed styles include background, foreground
color, outline, box shadow, and opacity. It must not change text, font metrics,
padding, borders, margins, display mode, or line height.

The renderer registers mounted target elements with a narration target registry
using the full identity:

```ts
{
  threadId,
  turnId,
  assistantMessageId,
  targetId,
  element,
}
```

Registrations are lifecycle-bound callback refs. Global selectors are not part
of the navigation path.

## Replaceable Generation Pipeline

### Resolved generation profile

The server resolves a profile before creating cache keys:

```ts
type NarrationGenerationProfile = {
  id: string;
  scriptGenerator: {
    provider: string;
    model: string;
    effort?: string;
    promptVersion: string;
  };
  synthesizer: {
    provider: string;
    model: string;
    modelRevision: string;
    voice: string;
    sampleRate: number;
    optionsVersion: string;
  };
  aligner: {
    provider: string;
    model?: string;
    modelRevision?: string;
    algorithmVersion: string;
  };
};
```

The default profile initially remains Codex plus Kokoro plus the Remux hybrid
aligner. Development overrides may select other profiles without adding a user
facing model picker. Cache identity uses the fully resolved provider descriptor,
not only the friendly profile ID.

Provider boundaries should be narrow:

```text
ScriptGenerator: source document → narration script
SpeechSynthesizer: narration script → audio + optional raw timing
SpeechAligner: source document + script + audio + raw timing → cues
```

An implementation may run multiple stages in one external worker, but the
artifact contracts and cache identity must preserve these logical boundaries.

### Narration script

The script is independent of audio and acoustic timing:

```ts
type NarrationScript = {
  schemaVersion: 2;
  sourceDocumentHash: string;
  generator: NarrationGenerationProfile['scriptGenerator'];
  units: NarrationScriptUnit[];
};

type NarrationScriptUnit = {
  id: string;
  blockId: string;
  mode: 'verbatim' | 'normalized' | 'summary';
  spokenText: string;
  fallbackTargetIds: string[];
  alignmentHints: Array<{
    spokenStart: number;
    spokenEnd: number;
    targetIds: string[];
  }>;
};
```

Ordinary prose and ordinary headings pass through deterministically as
`verbatim`. Only pronunciation-sensitive spans and structurally complex blocks
need a script model.

For normalized speech, the model returns character-range hints mapping the
spoken expression to renderer-owned targets. For example, “arc of tee” may map
to one text-range target containing `Arc<T>`.

For summaries, models should select the narrowest honest target available. A
future table-aware model may emit one unit per relevant row or cell. A future
code narrator may emit one unit per code-line range. If no trustworthy narrow
mapping exists, `fallbackTargetIds` contains the parent block.

Model output is untrusted. Validate order, IDs, character bounds, non-empty
speech, and target containment. Retry schema generation once before exposing a
retryable failure.

### Synthesis result

The synthesizer returns audio and spoken-text timing without knowing how React
will highlight it:

```ts
type SynthesizedSpeech = {
  synthesizer: NarrationGenerationProfile['synthesizer'];
  durationSeconds: number;
  chunks: NarrationAudioChunk[];
  units: Array<{
    unitId: string;
    start: number;
    end: number;
    rawTokens: Array<{
      text: string;
      spokenStart?: number;
      spokenEnd?: number;
      start: number;
      end: number;
    }>;
  }>;
};
```

`spokenStart` and `spokenEnd` are offsets into the script unit's `spokenText`.
When a TTS provider cannot supply them, the aligner may recover them.

### Alignment cues

Alignment is a separate, explicit result:

```ts
type NarrationCue = {
  id: string;
  unitId: string;
  start: number;
  end: number;
  spokenStart: number;
  spokenEnd: number;
  targetIds: string[];
  granularity:
    | 'word'
    | 'expression'
    | 'tableCell'
    | 'tableRegion'
    | 'codeLines'
    | 'diagramNode'
    | 'block';
  origin:
    | 'deterministic'
    | 'scriptHint'
    | 'ttsTiming'
    | 'forcedAlignment'
    | 'fallback';
  confidence: number;
};
```

Every non-omitted script unit must produce at least one cue. Missing fine-grain
alignment falls back explicitly to the unit's validated fallback targets.

Use this initial precedence:

1. validated forced alignment when configured and above its confidence floor;
2. normalized model hints combined with acoustic word timing;
3. normalized monotonic alignment of TTS tokens to verbatim display tokens;
4. script-level semantic targets;
5. parent block fallback.

The player does not care which level won. It receives time-ordered cues with
renderer-owned target IDs.

### Forced-alignment growth path

Do not make a forced aligner mandatory for the cleanup. Define the provider
boundary and retain enough intermediate data to add one later:

- exact script text;
- source document and target map;
- uncompressed or losslessly readable audio;
- TTS token timing, when available;
- spoken character offsets;
- model and algorithm descriptors.

A future aligner may regenerate only the alignment layer against cached script
and audio. It must not require rerunning Codex or TTS unless their inputs change.

Forced alignment still does not prove source meaning. It aligns audio to spoken
text. Mapping spoken text to a table cell, code line, or diagram node remains a
semantic planning problem, represented by script hints and renderer targets.

## Artifact and Version Model

### Independent versions

Resolve and record these independently:

```text
source document schema version
source document algorithm version
script schema version
script prompt/algorithm version
synthesizer provider and model revision
voice and synthesis options version
alignment schema version
alignment provider and algorithm version
artifact manifest version
```

Frontend viewport and control presentation have their own code version and do
not invalidate generated artifacts.

### Layered cache keys

Use content-addressed keys per stage:

```text
sourceDocumentKey = hash(source + renderer document version)
scriptKey         = hash(sourceDocumentKey + resolved script generator)
audioKey          = hash(scriptKey + resolved synthesizer)
alignmentKey      = hash(sourceDocumentKey + scriptKey + audioKey + aligner)
artifactKey       = hash(all resolved keys + manifest schema)
```

This permits:

- trying a new narrator while retaining source parsing;
- trying a new voice or TTS model while retaining the script;
- trying forced alignment while retaining both script and audio;
- shipping viewport fixes without regenerating anything.

The first v2 implementation may store the layers in one artifact directory, but
the manifest must expose their keys and descriptors so storage can be split
later without another schema redesign.

### Storage

Store v2 artifacts separately:

```text
$CODEX_HOME/remux/narration/v2/{artifactKey}/
  manifest.json
  source-document.json
  script.json
  alignment.json
  audio/
    000.wav
    ...
```

V2 never mutates a v1 artifact in place. Activating v2 makes v1 cache entries
unreachable to new requests, forcing regeneration with the new alignment and
manifest contracts. Old entries may be removed by startup migration or normal
cache eviction.

If one stage changes, publish a new immutable artifact and update the message's
resolved cache result. “Overwrite” means replacing the active resolved artifact,
not rewriting files a viewer may currently be playing.

## V2 Manifest

```ts
type NarrationManifestV2 = {
  version: 2;
  artifactKey: string;
  sourceHash: string;
  sourceDocumentKey: string;
  scriptKey: string;
  audioKey: string;
  alignmentKey: string;
  profile: NarrationGenerationProfile;
  durationSeconds: number;
  chunks: NarrationAudioChunk[];
  units: Array<{
    id: string;
    blockId: string;
    mode: 'verbatim' | 'normalized' | 'summary';
    spokenText: string;
    start: number;
    end: number;
    chunkId: string;
    fallbackTargetIds: string[];
    sentenceRanges: Array<{
      start: number;
      end: number;
      spokenStart: number;
      spokenEnd: number;
    }>;
  }>;
  cues: NarrationCue[];
};
```

Validate finite monotonic timing, audio containment, cue containment, spoken
offset bounds, known unit IDs, known target IDs, target geometry bounds, and
provider descriptors before atomic publication.

## Viewer Architecture

### Files and responsibilities

```text
viewer/narration/audioEngine.ts
  HTMLAudioElement, chunks, playback rate, media lifecycle, time events

viewer/narration/sessionStore.ts
  resource phase, manifest, current unit/cue, follow preference

viewer/narration/cueResolver.ts
  time → active cue → renderer target IDs

viewer/narration/targetRegistry.ts
  mounted renderer targets, no playback state

viewer/narration/viewportController.ts
  narration focus requests backed by the transcript virtualizer

viewer/narration/NarrationBar.tsx
viewer/narration/PlaybackActions.tsx
viewer/narration/AutoFollowButton.tsx
viewer/narration/SpeedMenu.tsx
```

The audio engine emits media position. It has no Zustand dependency, DOM query,
or transcript listener. The session store publishes only when the active cue,
unit, phase, or displayed control state changes; it does not publish on every
animation frame.

### Follow state

```ts
type NarrationFollowState = {
  enabled: boolean;
  suspendedByUser: boolean;
};
```

`enabled` is the visible user preference. A manual transcript gesture sets it
to false and `suspendedByUser` to true. The control reflects the disabled state.
Enabling it clears suspension and issues an immediate focus request for the
active target.

Persist the enabled preference only if product testing shows that users expect
it across narration sessions. For the cleanup, default each new session to on
and keep the preference session-local.

### Viewport focus request

Extend the transcript viewport controller with a narration-specific request:

```ts
type NarrationFocusRequest = {
  id: number;
  threadId: string;
  turnId: string;
  assistantMessageId: string;
  targetIds: string[];
  placement: 0.30;
  reason: 'follow' | 'explicitSeek' | 'followReenabled';
};
```

The virtualizer handles the request in two phases:

1. ensure the target turn is included in the active virtual range;
2. once a registered target mounts, calculate and apply the scroll position.

Use the usable viewport between the transcript's visible top and the composer's
top edge. For a primary target:

```text
desiredScrollTop =
  currentScrollTop
  + targetTopRelativeToViewport
  - usableViewportHeight * 0.30
```

Clamp through the existing viewport controller. Explicit seeks may use its
short controlled animation. Natural following should use an immediate or very
short adjustment and must not write while native iOS scrolling owns the
viewport.

For multiple targets, position their union. Prefer the first target at 30% when
the full union cannot fit.

Natural playback issues a focus request only when the active target union is
outside the 22%–65% reading band. Cue changes within the same visual target do
not cause scroll work.

### Playback controls

During `ready`, `playing`, or `paused`:

- do not render `ComposerConfigButton`;
- render Auto-follow before Previous block;
- retain the existing rate menu and Close action;
- keep Stop immediately available by closing narration if a Codex turn starts.

Auto-follow button states:

| State | Accessible label | Action |
| --- | --- | --- |
| Enabled | `Disable narration auto-scroll` | Disable without changing playback. |
| Disabled | `Enable narration auto-scroll` | Enable and focus the active target. |
| No mounted target yet | `Enable narration auto-scroll` | Enable; the virtualizer fulfills focus after mount. |

Previous/Next seek to narration units whose `blockId` differs from the current
unit. Omitted blocks remain absent. A later navigation setting may use
`sentenceRanges` without changing the control or audio-engine contract.

## Server and Worker Cleanup

Keep the existing transcript-authoritative target validation, isolated Codex
app-server connection, asynchronous job manager, cancellation, bounded audio
transport, atomic publication, and cache limit.

Refactor generation behind provider traits or equivalent internal interfaces.
The first implementation still supports one active synthesis job. Provider
descriptors and intermediate artifacts must be recorded even if Codex and
Kokoro remain hard-coded defaults.

The worker protocol must carry explicit protocol and capability versions:

```json
{
  "protocolVersion": 2,
  "operation": "synthesize",
  "capabilities": ["raw-token-timing", "spoken-character-offsets"]
}
```

Workers reject unsupported protocol versions. The server validates declared
capabilities rather than assuming every TTS provider supplies equivalent token
timing.

Runtime/model bootstrap and persistent worker supervision remain required
distribution hardening. They are orthogonal to the artifact/provider contracts
and must surface progress through the existing preparation row.

## Migration Plan

### Phase 1: Contracts and cache version

1. Add the v2 source target, script, provider, cue, and manifest types.
2. Add independent version constants and layered key computation.
3. Move new artifacts to the v2 cache namespace.
4. Keep v1 reads isolated; never reinterpret a v1 manifest as v2.
5. Add validation tests for every target and cue discriminator.

### Phase 2: Renderer target surface

1. Emit stable block and text-range targets from the existing Markdown model.
2. Emit table-cell and code-line targets where structural data already exists.
3. Add target registration to mounted Markdown nodes.
4. Resolve one or multiple active targets without changing layout.
5. Prove target IDs remain stable across width and cached PreText reads.

### Phase 3: Script and alignment cleanup

1. Stop transforming ordinary headings.
2. Validate normalized script hints against renderer target IDs.
3. Replace exact `find` alignment with normalized monotonic token alignment.
4. Convert TTS timing and script hints into explicit cues.
5. Provide a validated block fallback for every script unit.
6. Retain intermediate script, token timing, and audio for future forced
   alignment experiments.

### Phase 4: Frontend ownership and viewport

1. Extract the audio-only engine.
2. Add cue resolution and the target registry.
3. Add narration focus requests to the transcript viewport controller.
4. Remove global selectors, `scrollIntoView`, and transcript listeners from the
   audio engine.
5. Implement 30% placement and 22%–65% reading-band hysteresis.
6. Ensure offscreen turns mount before focus is fulfilled.

### Phase 5: Playback controls

1. Add the Auto-follow control before Previous block.
2. Hide the composer configuration button during playback.
3. Make manual scrolling visibly disable following.
4. Make re-enabling follow return to the active target.
5. Preserve explicit block navigation while follow is disabled.

### Phase 6: Provider hardening

1. Add provider capability validation and protocol versioning.
2. Add persistent worker supervision and model/runtime bootstrap progress.
3. Exercise an alternate narrator, synthesizer, or forced aligner against the
   same source/script/cue contracts.
4. Confirm changing only the aligner reuses cached script and audio.

## Test Plan

### Alignment

- punctuation, curly quotes, Unicode normalization, and repeated words align
  monotonically;
- line-wrapped fragments retain logical display offsets;
- normal headings remain verbatim and word-highlightable;
- inline code, URLs, currency, and type notation produce expression cues;
- generated code and table summaries always produce a semantic or block cue;
- invalid model hints, target IDs, timing, confidence, or ranges reject the
  artifact;
- a failed fine-grain alignment produces an explicit fallback cue;
- changing only the aligner changes `alignmentKey` but not `scriptKey` or
  `audioKey`.

### Markdown semantics

- target IDs remain stable across desktop/mobile widths;
- table-cell coordinates match rendered headers and body cells;
- code-line targets match logical lines, including wrapped visual lines;
- multiple target highlights do not change Markdown height;
- active word, expression, cell, region, code-line, and block styles preserve
  the exact PreText measurement.

### Viewport

- a target in an unmounted turn causes the turn to mount and then focuses;
- explicit navigation places the primary target at 30% within tolerance;
- natural following does nothing while the target remains in the reading band;
- natural following repositions a target that leaves the band;
- touch or wheel input disables follow without cancelling playback;
- no narration scroll write occurs during native iOS momentum ownership;
- enabling follow returns to the current target;
- explicit Previous/Next positions targets while follow remains disabled;
- composer obstruction and safe-area insets are included in usable height.

### UI and lifecycle

- Config is absent only during narration playback mode;
- Auto-follow is immediately left of Previous block;
- closing narration restores the ordinary composer controls and configuration;
- draft text, attachments, queue state, and playback-rate preference survive;
- starting a Codex turn closes narration and restores Stop;
- switching threads releases viewer media while allowing server generation to
  finish and cache;
- reloading never attaches a v1 artifact to a v2 session.

### Performance

- the audio clock does not publish React state every frame;
- word cue changes do not read layout or scroll;
- geometry is read only on target transitions or explicit focus requests;
- no DOM mutation used for highlighting changes measured height;
- long responses retain iOS momentum scrolling while narration is playing.

## Acceptance Criteria

The cleanup is complete when:

1. every spoken unit has an explicit validated visual fallback;
2. ordinary prose and headings reliably receive word cues;
3. normalized expressions receive expression cues;
4. summaries use semantic targets or explicit block fallback;
5. the player contains no transcript selectors, listeners, or scroll policy;
6. the virtualizer owns all narration scrolling and can focus unmounted turns;
7. automatic following has visible user control and uses the 30% reading
   position with reading-band hysteresis;
8. narration playback hides Config and uses the agreed six-control order;
9. v2 artifacts regenerate without mutating active v1 files;
10. script, synthesis, alignment, and presentation versions can change
    independently;
11. another aligner or narrator can be introduced without changing Markdown
    target identity, playback controls, or viewport integration;
12. desktop and mobile tests prove highlighting and playback never change
    PreText height.

## Deferred Product Choices

These are intentionally left open behind stable contracts:

- which alternate narrator and TTS models become supported profiles;
- whether narration profiles receive a user-facing picker;
- which forced aligner provides the best CPU/quality tradeoff;
- whether table narration defaults to cells, rows, columns, or semantic groups;
- whether diagrams expose nodes through Mermaid/source semantics or a model-built
  map;
- whether Previous/Next gains a sentence-navigation mode;
- whether auto-follow preference persists between sessions;
- whether compressed audio replaces PCM WAV.

None of these choices should require another renderer identity, cue, player, or
viewport architecture change.
