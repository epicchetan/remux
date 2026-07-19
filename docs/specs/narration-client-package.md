# Shared narration client extraction v1

Status: Implemented
Last verified: 2026-07-19
Target code: `packages/narration-client/`,
`extensions/codex/viewer/narration/`,
`extensions/codex/viewer/transcript/components/markdown/markdownModel.ts`, and
`extensions/codex/tests/`
Related implemented contracts: `docs/specs/narrate-batch-alignment.md`,
`docs/specs/narrate-pronunciation-audit.md`, and
`docs/specs/narrate-structural-transcripts.md`

## Outcome

Extract the proven browser-side narration protocol, job lifecycle, audio playback, and cue
resolution from the Codex viewer into a headless workspace package named
`@remux/narration-client`.

Codex is the only initial consumer and the dogfood gate. Its source-document construction,
controls, virtualizer integration, and highlighting must retain their current behavior while all
generic client behavior runs through the package.

```text
Codex Markdown renderer
  -> Codex-owned NarrationDocumentV1 projection
  -> @remux/narration-client
       -> strict client-side response decoding
       -> Narrate start/read/cancel transport
       -> preparation and recovery state machine
       -> HTMLAudioElement playback
       -> sample-to-block/sentence/word resolution
  -> Codex-owned controls, painting, and virtualizer focus
  -> unchanged Narrate server pipeline
       -> Sol structural transcripts
       -> contextual Misaki baseline
       -> Sol sparse direct-phone review
       -> NLP-aware chunking
       -> Kokoro WAV and NarrationArtifactV4
```

The future Narrate Markdown viewer will be able to create a second client instance and supply its
own document projection and presentation layer. This implementation pass does not add narration
controls, playback, highlighting, document projection, or tests to the Narrate viewer.

## Why this boundary

The server API is already viewer-independent: `narration/start` receives only a strict
`NarrationDocumentV1`. Assistant-message ids, thread ids, Markdown source, DOM references,
virtualizer state, and playback state never cross that boundary.

The browser client is not currently viewer-independent:

- public transport and artifact types are named `CodexNarration*` and live under Codex;
- RPC method wrappers live under Codex;
- the audio engine and cue resolver are generic but live under Codex;
- the lifecycle controller directly imports Codex transcript viewport state;
- its singleton target is an assistant-message identity;
- the paint controller and registries correctly depend on Codex DOM and virtualization.

Copying this client into another viewer would duplicate the most failure-prone parts of narration:
late job responses, cancellation ordering, extension restart recovery, background reconciliation,
media readiness, truthful play state, seeking, sample publication, and resource revision fencing.

The package therefore owns the generic lifecycle and playback path. Each viewer continues to own
the mapping between its rendered content and the source coordinates in the narration artifact.

## Closed decisions

1. Add one private workspace package at `packages/narration-client` with package name
   `@remux/narration-client`.
2. The package is a browser-side client. It does not contain TTS, Markdown parsing, server code,
   model prompts, cache code, or synthesis logic.
3. The root package entry is React-free. React bindings live in a separate `./react` export.
4. The package creates instances. It must not export a process-global narration singleton.
5. A client instance permits at most one active narration session.
6. Viewer-local presentation identity is a generic type parameter and is never serialized to the
   Narrate server.
7. Codex remains the owner of Markdown projection, action UI, block/text DOM registries, overlay
   painting, and virtualizer focus.
8. No UI components or CSS move into the package in v1.
9. No Narrate-viewer integration is implemented in v1.
10. There is one production client path after cutover. Do not retain a Codex client fallback,
    feature flag, compatibility store, dual transport, or old audio engine.
11. The Narrate server protocol, artifact schema, synthesis profile, artifact key, media URL, and
    cache namespace do not change for this extraction.
12. Existing cached narration artifacts remain valid because this is a client ownership change,
    not a server contract change.

## Ownership

| Concern | v1 owner | Notes |
| --- | --- | --- |
| `NarrationDocumentV1` and `NarrationArtifactV4` TypeScript contracts | narration client package | Generic names; exact existing wire JSON |
| RPC start/read/cancel and update notification | narration client package | Through a replaceable transport port |
| Resource decoding and client-consumed artifact validation | narration client package | Reject malformed envelopes before state mutation |
| Preparation, refresh, retry, cancellation, and restart recovery | narration client package | One fenced state machine per instance |
| `HTMLAudioElement`, buffering, seeking, rate, and samples | narration client package | Through an injectable audio driver |
| Sample-to-cue resolution | narration client package | Half-open sample ranges |
| Host background/resume reactions | narration client package | Through an injectable lifecycle port |
| Markdown-to-block projection | Codex viewer | Existing parser and exact UTF-16 text ownership remain unchanged |
| Assistant response target identity | Codex viewer | Generic local target supplied to the client |
| Word/block DOM registration | Codex viewer | Renderer-specific |
| Highlight overlay geometry and CSS | Codex viewer | Renderer-specific |
| Virtualizer materialization and narration follow ownership | Codex viewer | Supplied through a small follow port |
| Progress and playback controls | Codex viewer | Existing composer UI remains unchanged |
| Transcript, G2P, phone review, chunking, synthesis, artifact/cache | Narrate server and `remux-tts` | No changes in this pass |

## Dependency rule

```text
@remux/viewer-kit
        ^
        |
@remux/narration-client <--- @remux/codex

@remux/narration-client -X-> @remux/codex
@remux/narration-client -X-> @remux/narrate
@remux/viewer-kit       -X-> @remux/narration-client
```

The package may depend on `@remux/viewer-kit` for the default Remux transport/lifecycle adapter and
on Zustand for a vanilla external store. The React export uses React as a peer dependency. The core
controller must depend on injected ports rather than importing viewer-kit globals so it can be
tested deterministically.

The Codex workspace declares `@remux/narration-client: "*"`. The root TypeScript paths include the
package and its subpaths, following the existing viewer-kit workspace convention.

The package declares a `test` script using its no-web-server Playwright configuration, and the root
adds `test:narration-client`. These tests use Playwright's test runner as a deterministic Node test
harness; they do not start the Codex viewer or a browser unless a browser-audio-specific test
explicitly requests a page.

## Package layout

```text
packages/narration-client/
  package.json
  playwright.config.ts
  src/
    index.ts
    protocol.ts
    decode.ts
    transport.ts
    remux.ts
    lifecycle.ts
    audio.ts
    browserAudio.ts
    cues.ts
    controller.ts
    react.ts
  tests/
    decode.spec.ts
    cues.spec.ts
    controller.spec.ts
```

Required package exports:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./protocol": "./src/protocol.ts",
    "./react": "./src/react.ts",
    "./remux": "./src/remux.ts"
  }
}
```

The root export contains the protocol, ports, cue resolver, controller factory, and browser audio
factory. It must not import React. `./react` contains only the hook binding. `./remux` constructs the
default transport and lifecycle ports from viewer-kit.

Do not add a styles export. Do not make the Codex or Narrate extension package re-export this
package.

## Wire protocol

Move the generic portions of `extensions/codex/shared/narration.ts` into `protocol.ts` and remove
the `Codex` prefix:

- `NarrationBlockKind`;
- `NarrationHighlightMode`;
- `NarrationSourceBlock`;
- `NarrationSourceDocument`;
- start/read/cancel params and responses;
- `NarrationStage` and `NarrationProgress`;
- `NarrationResource` and update notification;
- artifact, audio, block timing, sentence, word cue, and profile types.

`CodexNarrationTarget` does not move. It is not a wire type. Codex defines its local target beside
the client instantiation.

The JSON sent over RPC remains exactly:

```json
{
  "document": {
    "schemaVersion": 1,
    "offsetEncoding": "utf16CodeUnit",
    "blocks": []
  }
}
```

No target, viewer id, file path, assistant-message id, Markdown, playback option, or presentation
field may be added to `narration/start`.

The following method names remain unchanged:

- `remux/narrate/narration/start`;
- `remux/narrate/narration/resources/read`;
- `remux/narrate/narration/cancel`;
- `remux/narrate/narration/updated`.

The default Remux transport preserves the current deterministic operation-id derivation from the
serialized source document. The operation id is request deduplication metadata, not artifact
identity.

## Runtime decoding boundary

TypeScript annotations do not validate an RPC response. The package must decode external values
before the controller reads fields such as `status`, `revision`, or `manifest`.

At minimum, decoding validates:

- the start envelope has `status: "accepted"`, a nonempty `artifactKey`, and a matching resource;
- read status is `missing`, `notModified`, or `ok` and its resource presence matches that status;
- resource status is one of the declared states;
- resource and manifest artifact keys match the active request;
- revisions are nonempty strings accepted by the existing revision ordering function;
- progress counters are nonnegative finite integers and completed counts do not exceed totals;
- manifest schema is exactly `4` and offset encoding is `utf16CodeUnit`;
- audio is mono 24 kHz WAV metadata with finite nonnegative sizes and sample counts;
- the content-addressed media URL and SHA-256 shapes are valid;
- block, sentence, and word sample ranges are finite, ordered, half-open, and bounded by total
  samples;
- text ranges are finite, nonnegative, half-open UTF-16 offsets;
- required profile fields consumed by the viewer are present.

This is a client-consumption validator, not a second synthesis validator. It does not reconstruct
the source document, pronunciation plan, or WAV. Server and worker validation remain authoritative
for artifact generation.

Malformed external data becomes one stable client error and transitions the active session to
`failed`; it must never surface as an unhandled property-access exception. Tests must include
missing `status`, missing `resource`, mismatched artifact keys, invalid arrays, and non-finite
numbers.

## Ports

### Transport

```ts
export type NarrationTransport = {
  cancel(params: NarrationCancelParams): Promise<NarrationCancelResponse>;
  read(params: NarrationReadParams): Promise<NarrationReadResponse>;
  start(params: NarrationStartParams): Promise<NarrationStartResponse>;
  subscribeUpdated(listener: (event: NarrationUpdatedNotification) => void): () => void;
};
```

The default Remux implementation owns RPC policy selection, resource keys, operation ids, method
names, and decoding. The controller never calls viewer-kit RPC functions directly.

### Lifecycle

```ts
export type NarrationLifecycleState = 'active' | 'background' | 'inactive';

export type NarrationLifecycle = {
  snapshot(): { state: NarrationLifecycleState };
  subscribe(listener: (state: NarrationLifecycleState) => void): () => void;
  subscribeResume(listener: () => void): () => void;
};
```

The default Remux lifecycle adapter wraps viewer-kit. Tests use a fake lifecycle with explicit
transitions.

### Audio

```ts
export type NarrationAudioCallbacks = {
  onBuffering(): void;
  onEnded(): void;
  onError(message: string): void;
  onPaused(): void;
  onPlaying(): void;
  onSample(sample: number): void;
};

export type NarrationAudioDriver = {
  close(): void;
  pause(): void;
  play(artifactKey: string, artifact: NarrationArtifact): Promise<void>;
  prepare(artifactKey: string, artifact: NarrationArtifact): Promise<boolean>;
  seek(artifactKey: string, sample: number, play: boolean): Promise<boolean>;
  setCallbacks(callbacks: NarrationAudioCallbacks): void;
  setPlaybackRate(rate: NarrationPlaybackRate): void;
  snapshot(): unknown;
};
```

The browser implementation owns one `HTMLAudioElement` per client instance. Tests inject a fake
driver and never require media decoding. The browser-audio factory also accepts a test-only media
element factory so its event fencing and URL validation can be exercised without depending on a
host browser's codec behavior.

### Preferences and scheduling

Playback rate persistence and controller timers use small injected ports with browser defaults.
Tests must be able to advance refresh, cancellation-wait, and media timing without real one-second
delays. The persisted preference key remains `narrationPlaybackRate` for the Codex migration.

### Follow ownership

```ts
export type NarrationFollowPort<TTarget> = {
  claim(target: TTarget): void;
  release(): void;
};
```

This port does not scroll or paint. It only lets Codex reserve and release its transcript
auto-scroll mode. The controller exposes `suspendFollowByUser()` so Codex's viewport subscription
can disable follow after a real user scroll. No transcript viewport module is imported by the
package.

## Client factory

```ts
export function createNarrationClient<TTarget>(options: {
  audio: NarrationAudioDriver;
  follow?: NarrationFollowPort<TTarget>;
  lifecycle: NarrationLifecycle;
  preferences?: NarrationPreferences;
  scheduler?: NarrationScheduler;
  transport: NarrationTransport;
}): NarrationClient<TTarget>;
```

`TTarget` is opaque to the package. It is stored in memory so the consuming viewer can resolve
artifact block ids against the correct rendered surface. It is never cloned into the transport,
artifact, cache, or debug protocol.

The client exposes:

- one vanilla Zustand `StoreApi<NarrationClientState<TTarget>>`;
- `attach()` to subscribe to transport notifications and host lifecycle;
- `debugSnapshot()` for deterministic test diagnostics; and
- `destroy()` to stop timers, subscriptions, and local audio.

`attach()` is reference-counted so React development remounts do not install duplicate listeners.
The first attachment installs subscriptions; the last detachment removes only subscriptions.
`destroy()` is final and idempotent.

The package must not write a debug function to `globalThis`. Codex may expose its existing debug
hook from its local adapter for the real harness.

## Store contract

The generic state retains the existing user-visible model:

```ts
export type NarrationPhase =
  | 'idle'
  | 'preparing'
  | 'buffering'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'failed';

export type NarrationClientState<TTarget> = {
  artifact: NarrationArtifact | null;
  artifactKey: string | null;
  currentBlockId: string | null;
  currentBlockIndex: number;
  currentSample: number;
  currentSentence: NarrationSentence | null;
  currentSentenceIndex: number;
  currentWordCue: NarrationWordCue | null;
  currentWordCueIndex: number;
  error: string | null;
  followEnabled: boolean;
  followSuspendedByUser: boolean;
  focusIntent: NarrationFocusIntent | null;
  phase: NarrationPhase;
  playbackRate: NarrationPlaybackRate;
  progress: NarrationProgress | null;
  resourceRevision: string | null;
  status: NarrationResource['status'] | null;
  target: TTarget | null;

  cancel(): Promise<void>;
  close(): void;
  nextBlock(): Promise<void>;
  pause(): void;
  play(): Promise<void>;
  previousBlock(): Promise<void>;
  refresh(): Promise<void>;
  retry(): Promise<void>;
  seekToBlock(blockId: string): Promise<void>;
  setPlaybackRate(rate: NarrationPlaybackRate): void;
  start(request: { document: NarrationSourceDocument; target: TTarget }): Promise<void>;
  suspendFollowByUser(): void;
  toggleFollow(): void;
};
```

Keeping the action names and state shape minimizes the Codex UI migration. The React subpath
provides a typed selector hook over the instance store; it does not create an instance itself.

## State machine

| Event | Required result |
| --- | --- |
| `start` from idle | `preparing`, target retained locally, deterministic start request begins |
| new `start` while another start/job is active | previous accepted or pending job is cancelled and confirmed stopped before the new start is sent |
| preparation resource update | progress/revision advance; phase remains truthful |
| complete artifact while active and foregrounded | artifact installs, audio enters `buffering`, then only `onPlaying` may set `playing` |
| complete artifact while backgrounded | artifact installs as `ready`; no implicit playback |
| `play` | claim follow when enabled; phase changes through audio callbacks, not optimistic state |
| `pause` | audio pauses and state becomes `paused` |
| seek while playing | prepare if needed, seek, retain play intent, publish explicit focus intent |
| seek while paused/ready | prepare if needed, seek, remain nonplaying, publish explicit focus intent |
| natural media end | clear active cues and become `paused` unless a terminal error exists |
| lifecycle leaves active | pause locally, clear play intent, never auto-resume |
| lifecycle resumes | refresh server resource; user must explicitly resume audio |
| current job is missing after extension restart | reissue the exact deterministic last request once through the fenced recovery path |
| malformed response | `failed` with a stable decoded error; no property-access crash |
| terminal server failure | `failed` with server error |
| `cancel` | close audio, release follow, reset local state, cancel pending/active preparation, wait for stop |
| `close` on unfinished job | reset immediately and cancel unfinished server work best-effort |
| `close` on ready artifact | stop local audio and reset; do not delete the content-addressed artifact |
| `retry` | restart the exact last document and local target through normal cancellation fencing |

`ready` means a complete artifact exists but audio is not playing. `buffering` means the browser is
preparing media for an active play intent. `playing` is asserted only after the media element emits
the corresponding event. UI must never show Pause solely because an asynchronous `play()` call was
made.

## Concurrency and fencing invariants

1. Every start increments a client epoch. Late start, read, cancellation, media, seek, and timer
   completions from an older epoch are ignored.
2. Resource revisions never move backward. An older or duplicate revision cannot replace current
   state.
3. At most one refresh request mutates the current epoch. Sequence fencing prevents a slower read
   from overwriting a newer read.
4. Update notifications are hints. A one-second refresh timer remains the fallback while a resource
   is active.
5. Only one refresh timer exists per instance.
6. Cancellation serializes behind an earlier cancellation. A replacement start waits for the
   previous narration to reach a nonactive or missing state.
7. If a start promise resolves after local cancel, its returned artifact key is still cancelled.
8. Missing-resource recovery is single-flight and bound to the original epoch, document, and
   target.
9. Audio callbacks include or are fenced by the active media generation. Events from a replaced
   element cannot mutate current state.
10. `destroy()` prevents every later callback from mutating the store.

These invariants are package behavior, not Codex glue.

## Audio invariants

The moved browser audio implementation preserves the current design:

- use the published same-origin `/remux/media/sha256/<hash>` URL directly;
- verify URL, origin, path hash, and manifest SHA-256 agreement before assigning `src`;
- use one `HTMLAudioElement`, not Web Audio and not an RPC byte reader;
- wait for metadata before seeking or declaring media prepared;
- report buffering separately from playing;
- compute current sample from media time and the artifact's 24 kHz sample rate;
- clamp published samples to `[0, totalSamples]`;
- use media events plus an animation-frame loop while playing;
- preserve rates `0.75`, `1`, `1.25`, `1.5`, and `2` only;
- abort and detach listeners when the artifact or client is replaced;
- surface decode/load/play failures as controlled client errors;
- retain a bounded debug snapshot without audio bytes or sensitive content.

No preload of the complete WAV into JavaScript memory is introduced.

## Cue resolution

Move `resolveNarrationPosition` into the package without semantic changes.

- Sample ranges are zero-based, half-open `[startSample, endSample)`.
- At an exact boundary, ownership moves to the next range.
- Punctuation and synthetic-prosody gaps may have a sentence or block but no word cue.
- A sample at or beyond `totalSamples` resolves to no active cue.
- Returned indices refer directly to the artifact arrays.
- Resolution is deterministic for repeated calls and does not inspect the DOM.

Block navigation seeks to the selected block's `startSample`. It does not seek through sentences or
private synthesis chunks.

## Presentation and focus contract

Painting remains observer-driven. The package publishes:

- the current block, sentence, and word cue;
- `target`, opaque to the package;
- `followEnabled` and `followSuspendedByUser`; and
- a monotonically identified `focusIntent` with reason `follow`, `followReenabled`,
  `explicitSeek`, or `explicitSeekInPlace`.

The package does not resolve DOM nodes, create ranges, add classes, render overlays, call
`scrollIntoView`, or know whether content is virtualized.

Codex keeps:

- `blockRegistry.ts`;
- `textLeafRegistry.ts`;
- `paintController.ts`;
- transcript viewport materialization;
- narration-follow scroll ownership; and
- all narration CSS.

Codex's paint controller switches from the old singleton to the package-backed instance but retains
the same assistant-message, block, sentence, and word lookup behavior.

## Markdown/source contract

The extraction does not change `narrationSourceDocument(markdown)` or the Markdown parser.

Codex continues to derive block ids, exact logical block text, block kinds, highlight modes, and
UTF-16 coordinate ownership from the same parsed representation used by its renderer. The generic
protocol type is imported from `@remux/narration-client/protocol`.

The package does not offer a Markdown-to-document convenience function in v1. Adding one before a
second renderer exists would either couple the package to Codex's Markdown model or create a second
parser whose block text could drift from the rendered DOM.

This is the future viewer integration seam: a viewer supplies a `NarrationSourceDocument` and
observes cues against its own render tree. It is intentionally exercised only by Codex in this
pass.

## Codex adapter

Add a Codex-owned instantiation module, for example
`extensions/codex/viewer/narration/client.ts`.

It defines:

```ts
export type CodexNarrationTarget = {
  assistantMessageId: string;
  messageRevision: string;
  sourceHash: string;
  threadId: string;
  turnId: string;
};
```

It creates exactly one client instance with:

- the default Remux narration transport;
- the default Remux lifecycle adapter;
- the browser audio driver;
- localStorage playback-rate preferences;
- a Codex follow port that claims/releases `narration-follow`; and
- the default browser scheduler.

It exports the typed selector hook used by the existing components, an attachment function used by
`App`, and a Codex-local debug snapshot installed under the existing test-only global name.

The transcript viewport subscription remains in Codex. When a user scroll displaces
`narration-follow`, it calls `suspendFollowByUser()` on the client.

`NarrationBar`, `NarrationPlaybackActions`, assistant actions, `App`, and the paint controller keep
their existing presentation. Their imports change; their user-visible labels, layout, and action
availability do not.

## Migration map

| Current file | Destination/result |
| --- | --- |
| `extensions/codex/shared/narration.ts` | generic wire types move to package `protocol.ts`; Codex target moves to local adapter; old file deleted |
| `extensions/codex/viewer/ipc/narration.ts` | move behavior to package Remux transport; old file deleted |
| `extensions/codex/viewer/narration/audioEngine.ts` | move to package browser audio; old file deleted |
| `extensions/codex/viewer/narration/cueResolver.ts` | move to package cues; old file deleted |
| `extensions/codex/viewer/narration/store.ts` | split into package controller plus Codex instantiation; old implementation deleted |
| `extensions/codex/viewer/narration/blockRegistry.ts` | stays in Codex |
| `extensions/codex/viewer/narration/textLeafRegistry.ts` | stays in Codex |
| `extensions/codex/viewer/narration/paintController.ts` | stays in Codex; imports package-backed hook/types |
| `extensions/codex/viewer/narration/NarrationBar.tsx` | stays in Codex |
| `extensions/codex/viewer/narration/PlaybackActions.tsx` | stays in Codex |
| Codex Markdown model | stays in Codex; imports generic source-document types |
| Narrate server and viewer | unchanged |

Do not leave re-export shims at the deleted Codex paths after all imports migrate. Git history is the
rollback mechanism.

## Implementation slices

### Slice 1: package protocol and ports

- Add the workspace package, exports, dependencies, and TypeScript aliases.
- Move and generically rename wire types.
- Add decoders and malformed-envelope tests.
- Define transport, lifecycle, audio, preference, scheduler, and follow ports.
- Migrate type-only Codex imports without changing runtime ownership yet.

Gate: root typecheck and all source-document/schema tests pass.

### Slice 2: cue and audio extraction

- Move the cue resolver and its fixtures.
- Move the browser audio engine behind `NarrationAudioDriver`.
- Add direct tests for URL rejection, abort fencing, seek behavior, rate validation, sample clamping,
  and stale media events.
- Temporarily construct these package pieces from the existing Codex controller; do not retain the
  temporary wiring after Slice 3.

Gate: current buffering, playback, seek, pause, background, and highlighting route tests pass.

### Slice 3: controller extraction

- Implement the instance-based generic controller with injected ports.
- Move resource polling, notification handling, revision fencing, cancellation ordering, missing
  recovery, retry, focus intent, and playback actions.
- Add deterministic fake-port state-machine tests.
- Preserve current errors and debug evidence where practical; replace raw exceptions with decoded
  client errors.

Gate: package tests cover every state-machine row and concurrency invariant above.

### Slice 4: Codex hard cut

- Add the Codex target/follow/client instantiation.
- Change all Codex UI and paint consumers to the package-backed instance.
- Move the debug global to the Codex adapter.
- Delete the old shared protocol, IPC wrapper, audio engine, cue resolver, and store implementation.
- Remove unused dependencies only if no other Codex module uses them.

Gate: no production import reaches a deleted Codex narration-client module, and no duplicate
transport/audio/controller implementation remains.

### Slice 5: dogfood verification

- Run typecheck and production viewer builds.
- Run the entire Codex Playwright suite on desktop and mobile.
- Run all real narration tests: playback/background recovery, structural transcript alignment, and
  500+ word multiwindow review/cache reuse.
- Inspect the real manifest and request capture to prove wire JSON, artifact key, profile, and media
  URL are unchanged.
- Verify the Narrate viewer build remains unchanged and does not import the new package.

The package is not considered implemented until Slice 5 passes.

## Testing requirements

### Package-level deterministic tests

- half-open cue boundaries and punctuation gaps;
- valid and malformed start/read/resource/artifact decoding;
- start success and terminal failure;
- stale start/read/media completion ignored after epoch change;
- cancel before start resolves;
- second start waits for first cancellation to settle;
- duplicate and out-of-order revisions ignored;
- notification-triggered refresh and polling fallback;
- only one refresh timer;
- background pause without automatic resume;
- ready artifact arriving in background remains nonplaying;
- missing resource single-flight recovery;
- buffering never reports playing prematurely;
- media error returns to a truthful nonplaying state;
- seek while playing and seek while paused;
- natural end clears cues;
- follow claim, release, toggle, and user suspension;
- playback-rate validation and persistence;
- attach reference counting and final destroy fencing.

Use fake transport, lifecycle, audio, preferences, and scheduler ports for controller tests. Do not
depend on SOL, Misaki, Kokoro, a running extension, real time, or browser audio in these tests.

### Codex integration tests

Existing route tests remain normative for:

- exact `NarrationDocumentV1` request JSON and absence of local target fields;
- preparation progress and cancellation;
- truthful media buffering;
- cancellation/start ordering;
- background reconciliation and explicit resume;
- extension job loss and deterministic recovery;
- block, sentence, and word painting;
- structural block highlighting;
- seeking by block;
- follow suspension and re-enable;
- virtualizer materialization and automatic follow;
- close/error/retry behavior; and
- desktop/mobile parity.

Tests should import protocol fixtures and cue resolution from the package after migration. Do not
keep copies under Codex.

### Real-stack acceptance

The existing real harness remains the end-to-end gate. It must prove:

- actual media advances and foreground word/context paint appears;
- backgrounding pauses truthfully and foregrounding does not auto-play;
- code, table, and diagram transcripts retain source-block ownership;
- the pronunciation plan contains only direct phone patches;
- a 500+ word document completes multiple bounded review windows;
- a repeated request hits the deterministic validated cache; and
- the client still reads audio from the content-addressed HTTP media URL.

No new model benchmark is required because inference and synthesis are unchanged.

## Failure policy

- A malformed external response fails the current client session with a controlled message.
- A transient read/connection failure retains the last truthful resource and schedules another
  verification while the job is active.
- A media failure does not claim playback and remains retryable by an explicit user play action.
- Backgrounding is not an error.
- Missing resource recovery is bounded to one single-flight reissue for the active request; repeated
  absence continues through the normal resource state rather than spawning parallel starts.
- Cancellation errors may be surfaced for an explicit cancel operation, but local audio and paint
  still close immediately.
- There is no alternate audio backend, RPC byte fallback, legacy Codex store, or duplicated recovery
  path.

## Versioning and cache behavior

This extraction does not bump:

- `NarrationDocumentV1`;
- `NarrationArtifactV4`;
- pronunciation or transcript plan versions;
- Narrate RPC method versions;
- Kokoro task/profile versions; or
- `batch-alignment-v4-post-transcript-direct-review`.

The request bytes produced from a given Codex response must remain identical. The same source
document therefore resolves to the same artifact key and existing cache entry before and after the
client cutover.

The package is private workspace source and does not need a published semantic version. Its
contract version is this v1 spec plus compile-time exports and tests.

## Explicitly deferred

The following require a later spec or amendment after Codex dogfooding is complete:

- adding Narrate controls to its Markdown file viewer;
- creating a Narrate Markdown-to-`NarrationDocumentV1` projection;
- DOM text-leaf registration for ReactMarkdown;
- Narrate viewer highlighting or scroll follow;
- generic presentation components or narration CSS;
- multiple simultaneous sessions inside one viewer;
- persistence of active playback across a full viewer reload;
- streaming audio or progressive artifact playback;
- native/mobile audio outside the WebView's `HTMLAudioElement`; and
- protocol changes for non-Markdown content.

The package must nevertheless remain second-consumer-ready: it has no Codex imports, no fixed
assistant target type, no transcript viewport dependency, no global singleton, and no DOM paint
assumptions.

## Acceptance checklist

- `packages/narration-client` exists with the specified hard dependency direction.
- Root export is React-free and a separate React selector binding exists.
- Generic wire types and strict client decoders live in the package.
- Codex sends byte-equivalent narration start documents and local target identity remains local.
- One instance-based controller owns all generic job/playback behavior.
- Codex is fully migrated to the package; the previous implementations are deleted.
- Codex Markdown projection, controls, painting, and virtualizer behavior are unchanged.
- Narrate server code, schemas, prompts, cache namespace, and model pipeline are unchanged.
- Narrate viewer has no playback integration in this pass.
- Package deterministic tests pass.
- Root typecheck and both viewer production builds pass.
- Full desktop/mobile Codex Playwright coverage passes.
- All three real narration acceptance tests pass.
- Worktree search finds no duplicate old controller, transport, audio engine, or cue resolver.
- There is no feature flag, fallback, compatibility shim, or unused parallel implementation.
