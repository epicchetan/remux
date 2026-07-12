# Codex Server-Authoritative Transcript Windows and Resume

Status: Active Spec
Last verified: 2026-07-12
Canonical code: `extensions/codex/server/src/history/`, `extensions/codex/server/src/resources/`, `extensions/codex/server/src/projection/`, `extensions/codex/viewer/transcript/`, `extensions/codex/viewer/resumeSync.ts`, `packages/viewer-kit/src/host.ts`, `packages/viewer-kit/src/ipc.ts`, `app/src/surfaces/viewer/ExtensionWebView.tsx`

## Purpose

Make the Codex transcript server-authoritative at the unit the viewer actually renders, while keeping long threads fast to open, resume, scroll, and stream.

The implementation replaces per-turn and per-work-item hydration with three bounded resource layers:

1. A transcript sync returns an atomic window of self-contained turn render frames.
2. Opening a work group reads one group resource containing lightweight row summaries.
3. Opening an individual row reads its heavy detail resource.

It also introduces an explicit host lifecycle signal, foreground-first transcript hydration, incremental rollout indexing, revision-scoped measurement, and one width-contained transcript scroller.

This spec is decision-complete. The implementation should not reopen resource shape, ownership, pagination, lifecycle, cache, or migration decisions unless code evidence proves an invariant impossible.

## Implementation Status

The Version 2 implementation landed in-tree on 2026-07-11 behind capability negotiation. Automated coverage now includes:

- incremental complete-line and partial-line append indexing;
- stable completed-turn ranges across append;
- commentary between like-typed work groups;
- known-frame `notModified` responses;
- one group request and one row-detail request;
- desktop and mobile viewer rendering without Version 1 item fan-out;
- background invalidation deferral and one activation sync;
- the complete Codex server and viewer regression suites.

The 2026-07-12 stabilization pass retained the Version 2 resource protocol but restored the proven single-scroller viewport. Presentation order and measured rows now publish from one layout snapshot, paging is armed only by a real touch/wheel gesture, and prepend correction prefers an actual mounted DOM row over an estimated model offset. Desktop and mobile coverage asserts that programmatic scroll settlement cannot page, prepend keeps the visible anchor within one CSS pixel, and pathological Markdown cannot widen the document.

The subsequent live-update cleanup made refresh intent explicit. Order-changing, send-accepted, reconnect, and foreground verification use a tail window; content-only streaming preserves the current window; explicit history and narration navigation retain their requested window. Version 2 invalidations are runtime-validated exhaustively, critical subscription begins before React mounts, and resource plus measured-layout publication is one external-store transaction backed by `useSyncExternalStore`. Adjacent operational groups are presented as one deterministic action run and expanded with one batched group read. Real `patch_apply_end` change maps are normalized into named rows with lazy diffs.

A managed cold validation of the newest large rollout scanned the file and projected eight sampled turns in 0.25 seconds, below the 0.75-second cold gate.

The remaining rollout work is physical iOS validation, one mixed-version observation release, and subsequent removal of Version 1 compatibility resources. Those gates intentionally keep this document at `Active Spec` rather than `Implemented`.

## Relationship to Existing Documents

- [`transcript-store-scroll.md`](transcript-store-scroll.md) remains the rationale for separating resource, layout, and viewport ownership. This spec supersedes its per-turn/per-item hydration flow and all-turn refresh assumptions.
- [`transcript-identity-reconciliation.md`](transcript-identity-reconciliation.md) remains authoritative for canonical persisted/live item identity. New group and entry IDs must derive from that identity model.
- [`../../architecture/codex-streaming.md`](../../architecture/codex-streaming.md) documents the current implementation until this pass lands. It must be updated during cleanup, not prematurely rewritten as target state.
- [`../rpc-concurrency-and-mobile-resilience.md`](../rpc-concurrency-and-mobile-resilience.md) and [`../resource-governance-and-l0-5.md`](../resource-governance-and-l0-5.md) remain authoritative for semantic RPC cancellation, admission, transport recovery, and process containment.

## Goals

- Preserve disk plus live-overlay projection as the transcript source of truth.
- Make a turn renderable without asynchronously reconstructing its semantic timeline from many item requests.
- Never omit commentary, steering, compaction, tool groups, or changed-file groups because client request admission was exhausted.
- Avoid full rollout rescans and stable-turn reprojection after every append.
- Render a useful cached transcript immediately after foregrounding, then verify it atomically.
- Keep backgrounded and hidden viewers quiet without depending on iOS background JavaScript execution.
- Bound every read by semantic resource limits and the existing 8 MiB response ceiling.
- Preserve smooth streaming, scroll anchoring, PreText measurements, disclosure state, and narration targeting.
- Make stale, missing, oversized, and failed resources explicit in the UI instead of silently dropping rows.

## Non-Goals

- Replacing Codex rollout files with a Remux transcript database.
- Treating app-server `thread/read` or `thread/turns/list` as the primary transcript API.
- Persisting a durable Remux index sidecar in the first pass.
- Applying raw app-server deltas directly to rendered transcript rows.
- Exact scrollbar height for history that has not been loaded.
- Hydrating hidden tabs while the app is backgrounded.
- Raising the global 64-request admission limit to hide fan-out.
- Moving heavy work-entry payloads into the default turn response.

## Current Failure and Root Cause

The visible repeated `Tools` rows are not duplicate projection records. The server deliberately closes a pending tool group when an intervening commentary message occurs. In the affected turn, the projected work section contained:

- 26 work timeline entries;
- 99 referenced work items;
- 11 commentary messages;
- 14 group entries;
- 87 group item references.

The viewer currently reads work details and then calls `requestWorkItem(...)` for every `itemId` in one `Promise.all`. The viewer bridge and Remux WebSocket runtime each admit at most 64 pending requests. Requests beyond that boundary fail admission. `WorkSection` silently returns `null` for missing message items while still rendering group references. Commentary boundaries disappear, leaving consecutive `Tools` rows that look duplicated.

The symptom is therefore caused by all of the following acting together:

1. The server exposes a semantic work timeline as references.
2. The viewer reconstructs that timeline through independent item requests.
3. One ordinary turn can exceed global transport admission.
4. Missing commentary renders as nothing rather than an error placeholder.

Increasing the pending-request limit would only move the failure threshold. The fix is to make the server response match the viewer's consistency boundary.

## Current Long-Thread Cost

The affected rollout is approximately 86 MiB, 15,000 JSONL rows, and 76 visible turns. A measured current-protocol response embedding only the final 20 turns is approximately 752 kB (735 KiB), so the expensive part is repeated scanning, reprojection, and request fan-out rather than unavoidable wire size. Current behavior compounds work on resume:

1. `build_session_index` reads the entire rollout when its length or modified time changes.
2. The viewer reads `threadTranscript`, then requests every turn in chunks of 50.
3. The turn cache is guarded by the global file revision, so an append invalidates otherwise stable completed turns.
4. Expanded work hydration may fan out into dozens of item RPCs.
5. Resume waits for history, summary, runtime, queue, and composer tasks before starting transcript refresh.

The existing server can embed tail turns in `threadTranscript`, but the viewer does not request or consume them. That is not enough by itself: it still lacks a window protocol, atomic known-revision comparison, grouped work resources, and incremental index validity.

## Ownership Invariants

### Server owns semantic truth

The Codex extension server owns:

- disk/live reconciliation;
- canonical item identity;
- visible turn ordering and rollback visibility;
- turn and segment ordering;
- commentary and steering boundaries;
- work grouping and group membership;
- turn, segment, group, row, and detail statuses;
- resource and layout revisions;
- response truncation metadata.

The client must not merge independently fetched work items to infer semantic order.

### Viewer owns ephemeral presentation

The viewer owns:

- the active contiguous history window;
- advisory cached frames keyed by server revision;
- scroll position and follow mode;
- visible range and overscan;
- disclosure state;
- measured heights for a width and layout revision;
- loading, retry, and explicit failure presentation;
- whether a hidden or backgrounded view should defer work.

Cached server data may be shown while verification is in flight. It is never promoted into a competing source of truth.

### Atomicity boundary

A turn render frame is the smallest resource that may change collapsed transcript semantics. A frame is applied atomically. The viewer must never render half of a new frame with half of an old frame.

Work-group rows and individual row detail have independent atomicity because they are visible only after explicit disclosure.

## Protocol Version

The new protocol is `codexTranscriptRender` version `2`.

Constants:

```ts
export const CODEX_TRANSCRIPT_RENDER_PROTOCOL_VERSION = 2;
export const CODEX_TRANSCRIPT_PROJECTION_VERSION = 'turn-render-v2';
export const DEFAULT_TRANSCRIPT_TAIL_TURNS = 24;
export const DEFAULT_TRANSCRIPT_PREPEND_TURNS = 16;
export const MAX_TRANSCRIPT_WINDOW_TURNS = 40;
export const MAX_TRANSCRIPT_KNOWN_TURNS = 80;
export const DEFAULT_WORK_GROUP_ROWS = 200;
export const MAX_WORK_GROUP_ROWS = 256;
```

Version 2 is added alongside the current resource union for one compatibility release. A viewer must not mix version 1 and version 2 resources in the same transcript store generation.

### Transport and capability probe

Version 2 resource requests continue to use the existing semantic RPC method:

```text
remux/codex/transcript/resources/read
```

Add one version-neutral probe:

```text
remux/codex/transcript/capabilities/read
```

It takes no parameters and returns:

```ts
export type CodexTranscriptCapabilities = {
  protocolVersions: Array<1 | 2>;
  preferredProtocolVersion: 2;
  projectionVersions: {
    2: 'turn-render-v2';
  };
  limits: {
    maxWindowTurns: 40;
    maxKnownTurns: 80;
    maxGroupRows: 256;
    maxResponseBytes: number;
  };
};
```

The viewer probes once per host connection generation and caches the result for that generation. `method not found` from an old server means version 1 support only. Any other probe failure uses version 1 for the current generation and records a diagnostic; it does not repeatedly probe during transcript refresh. A new connection generation probes again.

Each version 2 UI operation uses one semantic RPC. A transcript sync remains isolated, while expanding one action run batches all of that run's adjacent work-group requests into the RPC's `requests` array. Surviving open disclosures rehydrate only after the frame is applied.

## Resource Model

### Transcript sync request

One `transcriptSync` resource resolves thread order and one contiguous presentation window. It replaces a `threadTranscript` read followed by N `turn` reads.

```ts
export type CodexTranscriptSyncRequest = {
  type: 'transcriptSync';
  protocolVersion: 2;
  projectionVersion: 'turn-render-v2';
  window:
    | {
        kind: 'tail';
        count?: number;
      }
    | {
        kind: 'around';
        turnId: string;
        before: number;
        after: number;
      }
    | {
        kind: 'range';
        startTurnId: string;
        endTurnId: string;
      };
  knownThreadRevision?: string;
  knownTurns?: Array<{
    turnId: string;
    renderRevision: string;
  }>;
};
```

Validation rules:

- `tail.count` defaults to 24 and is clamped to 40.
- `around.before + 1 + around.after` is clamped to 40 by removing farthest turns evenly, preferring the requested anchor.
- `range` is accepted only when both endpoints are visible and ordered; the server clamps it to the 40 turns closest to `endTurnId`.
- `knownTurns` is deduplicated by `turnId` and limited to 80.
- Unknown anchors return `missing`, not an empty successful window.
- A thread with no turns returns an empty successful window.

The viewer uses:

- `tail(24)` for cold open, bottom-following resume, and return-to-latest;
- `range(firstLoaded, lastLoaded)` to verify an existing window;
- `around(firstLoaded, before: 16, after: min(23, loadedCount - 1))` to slide the active window toward older history;
- `around(lastLoaded, before: min(23, loadedCount - 1), after: 16)` to slide it toward newer history;
- `around(target, before: 12, after: 12)` for direct navigation to an unloaded turn.

Direct navigation replaces the active presentation window. The UI shows a `Return to latest` affordance if newer history is not in the active window. The viewer does not render disjoint ranges without an explicit gap row.

### Transcript sync response

```ts
export type CodexTranscriptSyncResource = {
  protocolVersion: 2;
  projectionVersion: 'turn-render-v2';
  threadId: string;
  sessionId: string | null;
  threadRevision: string;
  turnOrder: string[];
  activeTurnId: string | null;
  window: {
    startIndex: number;
    endIndexExclusive: number;
    turnIds: string[];
    hasEarlier: boolean;
    hasLater: boolean;
  };
  turns: CodexTurnRenderResult[];
  removedTurnIds: string[];
};

export type CodexTurnRenderResult =
  | {
      status: 'ok';
      turnId: string;
      renderRevision: string;
      frame: CodexTurnRenderFrame;
    }
  | {
      status: 'notModified';
      turnId: string;
      renderRevision: string;
    }
  | {
      status: 'error';
      turnId: string;
      code: 'projectionFailed' | 'frameTooLarge';
      message: string;
    };
```

Response rules:

- `turnOrder` is always the full visible ordered ID list. IDs are cheap and are needed for navigation and rollback reconciliation.
- `turns` contains exactly one result for each `window.turnIds` entry and preserves that order.
- A matching known render revision yields `notModified`.
- `removedTurnIds` contains known IDs no longer visible because of rollback or reconciliation.
- The response is computed against one disk-index plus live-overlay snapshot. It cannot mix revisions from two reads.
- The server targets a 6 MiB encoded response. If necessary it removes frames farthest from the anchor until under the target, updates the returned window, and never truncates semantic frame content.
- The existing 8 MiB transport ceiling remains hard. If the required anchor frame alone exceeds it, that turn returns `frameTooLarge`; the response does not fail or silently omit neighboring turns.

`knownThreadRevision` does not make the whole response `notModified`: the requested window may differ. It allows the server to reuse order/reconciliation work and lets observability distinguish order changes from frame verification.

`threadRevision` covers session identity, visible turn order, rollback visibility, and `activeTurnId`. Turn body changes are represented by frame revisions and do not churn the thread revision when order and activity identity remain stable.

The outer `CodexTranscriptResourceResult` key is `transcriptSync:{threadId}`. A sync result is always `ok`, `missing`, or `error`; per-turn `notModified` states live inside its value. The outer `revision` is a stable hash of protocol version, projection version, thread revision, returned window bounds, and ordered returned frame revisions. The viewer does not use that outer revision to skip a sync because the desired window is request-dependent.

### Turn render frame

A frame contains everything needed for default collapsed rendering and height measurement.

```ts
export type CodexTurnRenderFrame = {
  id: string;
  status: TurnStatus;
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  renderRevision: string;
  layoutRevision: string;
  segments: CodexTurnRenderSegment[];
};

export type CodexTurnRenderSegment =
  | CodexUserMessageSegment
  | CodexAssistantMessageSegment
  | CodexCompactionSegment
  | CodexWorkRenderSegment;

export type CodexWorkRenderSegment = {
  type: 'work';
  id: string;
  revision: string;
  layoutRevision: string;
  state: 'running' | 'completed' | 'interrupted' | 'failed';
  durationMs: number | null;
  timeline: CodexWorkTimelineEntry[];
};

export type CodexWorkTimelineEntry =
  | {
      type: 'message';
      id: string;
      revision: string;
      phase: MessagePhase | null;
      text: string;
    }
  | {
      type: 'userMessage';
      id: string;
      revision: string;
      isSteering: boolean;
      content: UserInput[];
    }
  | {
      type: 'compaction';
      id: string;
      revision: string;
      status: 'compacting' | 'compacted' | 'cancelled';
    }
  | {
      type: 'group';
      id: string;
      revision: string;
      groupType: 'activity' | 'files' | 'text' | 'tools';
      title: string;
      rowCount: number;
      status: 'running' | 'completed' | 'interrupted' | 'failed';
      hasMoreRows: boolean;
    };
```

The timeline preserves commentary between groups inline. This is the central semantic fix. There are no item references to hydrate for collapsed work rendering.

Revision meaning:

- `renderRevision` changes when any frame content or status changes.
- `layoutRevision` changes only when collapsed geometry can change.
- A tool output delta that changes neither the collapsed row summary nor status does not change the turn `layoutRevision`.
- Duration display ticks are client-derived from stable `startedAt`; they do not change either revision every second.

### Work group request and response

Opening a group makes one ordinary request.

```ts
export type CodexWorkGroupRequest = {
  type: 'workGroup';
  protocolVersion: 2;
  turnId: string;
  segmentId: string;
  groupId: string;
  cursor?: string;
  limit?: number;
  knownRevision?: string;
};

export type CodexWorkGroupResource = {
  threadId: string;
  turnId: string;
  segmentId: string;
  groupId: string;
  revision: string;
  layoutRevision: string;
  type: 'activity' | 'files' | 'text' | 'tools';
  title: string;
  rows: CodexWorkRowSummary[];
  nextCursor: string | null;
};
```

The default limit is 200 and the maximum is 256. Ordinary groups load in one response. Pathological groups expose an explicit `Load more` row; paging never occurs invisibly.

Summary rows include only data needed to render the closed row:

```ts
export type CodexWorkRowSummary =
  | {
      type: 'activity';
      id: string;
      revision: string;
      kind: CodexWorkActivity['kind'];
      text: string;
      command: string | null;
      path: string | null;
      status: string;
      durationMs: number | null;
      exitCode: number | null;
      hasDetail: boolean;
    }
  | {
      type: 'fileChange';
      id: string;
      revision: string;
      path: string;
      kind: CodexFileChange['kind'];
      status: string;
      additions: number;
      deletions: number;
      hasDetail: boolean;
    }
  | {
      type: 'tool';
      id: string;
      revision: string;
      category: CodexToolRow['category'];
      label: string;
      status: string;
      detailPreview: string | null;
      mediaCount: number;
      hasDetail: boolean;
    }
  | {
      type: 'text';
      id: string;
      revision: string;
      text: string;
      hasDetail: false;
    };
```

Group cursors are opaque, revision-bound, and encode the next row offset. A cursor used against another group revision returns `staleCursor`; the viewer reloads page one and preserves disclosure if the row still exists.

`knownRevision` is valid only for the head page where `cursor` is absent. Cursor requests omit it and always return their page. All pages carry the same whole-group `revision`. When a refreshed head page has a new revision, the viewer atomically discards accumulated older pages before rendering the new head page.

### Work entry detail

Only an opened row reads heavy output, diff, or media metadata.

```ts
export type CodexWorkEntryDetailRequest = {
  type: 'workEntryDetail';
  protocolVersion: 2;
  turnId: string;
  segmentId: string;
  groupId: string;
  rowId: string;
  knownRevision?: string;
};

export type CodexWorkEntryDetailResource = {
  threadId: string;
  turnId: string;
  segmentId: string;
  groupId: string;
  rowId: string;
  revision: string;
  layoutRevision: string;
  detail:
    | { type: 'activity'; detail: string | null; output: string | null }
    | { type: 'fileChange'; diff: string }
    | { type: 'tool'; detail: string | null; result: string | null; media: CodexMediaPreview[] };
  truncation: {
    truncated: boolean;
    originalBytes: number;
    returnedBytes: number;
  };
};
```

Initial payload limits retain current behavior:

- command/tool text: 256 KiB returned;
- diff text: 512 KiB returned;
- response-wide limit: 8 MiB.

Truncation is explicit. A later paged raw-output API may be added without changing turn or group resources.

## Resource Keys and Identity

Keys are deterministic:

```text
transcriptSync:{threadId}
turnFrame:{threadId}:{turnId}
workGroup:{threadId}:{turnId}:{segmentId}:{groupId}
workEntryDetail:{threadId}:{turnId}:{segmentId}:{groupId}:{rowId}
```

Group and row IDs must be derived from canonical persisted/live item IDs and stable group boundaries. Array indexes, current display position, app-server synthetic `item-N` values, and random UUIDs are forbidden as durable resource identity.

Projection changes that intentionally alter identity or grouping require a projection-version bump and comparison fixtures.

## Incremental Rollout Index

### Cached state

Replace the current global file-revision cache guard with an incremental session index:

```rust
struct IncrementalSessionIndex {
    schema_version: u32,
    file_identity: FileIdentity,
    scanned_len: u64,
    parsed_len: u64,
    trailing_partial_line: Vec<u8>,
    session_id: Option<String>,
    visible_turn_ids: Vec<String>,
    rollback_hidden_turn_ids: HashSet<String>,
    turn_ranges: HashMap<String, TurnRange>,
    open_turn: Option<OpenTurnState>,
    thread_revision: String,
}

struct FileIdentity {
    device: u64,
    inode: u64,
}
```

The implementation may use a platform abstraction for file identity, but Linux must use device plus inode rather than path plus modification time.

### Append path

When identity matches and file length grows:

1. Seek to `scanned_len`.
2. Prefix the new bytes with `trailing_partial_line`.
3. Parse only complete JSONL rows.
4. Retain the last incomplete line without parsing it.
5. Feed rows through the same turn/rollback state machine used by a full build.
6. Extend or close only the open turn range.
7. Update visible order, hidden rollback IDs, and thread revision.
8. Set `scanned_len` to the file offset through which bytes were read, including retained partial bytes.
9. Set `parsed_len` to the file offset after the last complete newline.

The next append seeks to `scanned_len` and prefixes only the retained partial bytes, so bytes are neither skipped nor parsed twice. Incomplete final lines are normal while Codex writes and must not produce errors or corrupt the index.

### Rebuild path

A full rebuild occurs only when:

- device/inode changes;
- file length shrinks;
- the cached byte boundary no longer matches a small stored boundary fingerprint;
- index schema changes;
- append parsing detects an impossible state transition.

The full rebuild uses `BufRead::read_until` or equivalent streaming iteration. It must not use `fs::read` to allocate the entire rollout and then retain every line string.

The boundary fingerprint stores a short hash of bytes immediately before `scanned_len`. It detects in-place rewrite without hashing the full file.

### Turn projection cache

Completed-turn validity is based on stable content boundaries:

```rust
struct CachedProjectedTurn {
    projection_version: &'static str,
    range: TurnRange,
    range_fingerprint: String,
    projected: ProjectedTurn,
}
```

A completed turn remains valid when later bytes append. Reproject only when:

- its byte range changes;
- its range fingerprint changes;
- it is the current open turn and its end offset grows;
- live-overlay reconciliation changes relevant canonical items;
- rollback visibility or canonical identity changes;
- projection version changes.

Thread revision changes do not invalidate every completed turn.

### Persistence decision

The first pass keeps this index in process memory. Do not add SQLite or a durable sidecar. Cold server restart still performs one streaming scan. Add persistence only if the cold-start benchmark cannot meet the gate after streaming parsing and stable projection caching are implemented.

## Disk and Live Overlay Snapshot

The read order remains:

1. Resolve the authoritative rollout path.
2. Incrementally advance or rebuild the disk index.
3. Snapshot the relevant live overlay revision and entries.
4. Reconcile canonical identity.
5. Compute visible order after rollback.
6. Project the requested frame/group/detail resources.
7. Compute revisions from the reconciled values.

The entire `transcriptSync` response uses one index/overlay generation. If the overlay changes during projection, finish the current snapshot and let the existing invalidation path schedule another read. Do not restart indefinitely inside one RPC.

## Invalidation Contract

Invalidations name loaded semantic resources, not every underlying item:

```ts
export type CodexTranscriptRenderInvalidation =
  | {
      type: 'transcript';
      threadId: string;
      turnId?: string;
      affectsOrder: boolean;
      affectsLayout: boolean;
    }
  | {
      type: 'workGroup';
      threadId: string;
      turnId: string;
      segmentId: string;
      groupId: string;
      affectsLayout: boolean;
    }
  | {
      type: 'workEntryDetail';
      threadId: string;
      turnId: string;
      segmentId: string;
      groupId: string;
      rowId: string;
      affectsLayout: boolean;
    };
```

Rules:

- New commentary, steering, compaction, group boundary, group title/count/status, assistant text, or turn status invalidates the frame.
- A row-summary status or label change emits a group-keyed invalidation. A viewer rereads it only if that group is loaded.
- Output/diff/media detail emits an entry-keyed invalidation. A viewer rereads it only if that entry detail is loaded.
- An output delta that is invisible in the collapsed frame does not force collapsed remeasurement.
- Order-changing invalidations cause `transcriptSync`; frame-only invalidations may still use `transcriptSync` with the active range so application remains atomic.
- The server does not need per-view subscription state. The viewer filters invalidations against its loaded resource keys.

Existing invalidation coalescing remains:

- ordinary invalidations: approximately 32 ms;
- streaming frame refresh: 125–200 ms, targeting 5–8 visual updates per second.

There is at most one transcript sync in flight per thread/viewer generation. New invalidations mark it dirty and cause one trailing sync; they do not create parallel reads.

## Viewer Resource Store

### State

The version 2 store is separate from the current store during migration:

```ts
type TranscriptRenderStoreState = {
  protocolVersion: 2;
  activeThreadId: string | null;
  generation: number;
  lifecycle: 'active' | 'inactive' | 'background';
  status: 'idle' | 'loading' | 'ready' | 'failed';
  threadRevision: string | null;
  turnOrder: string[];
  activeTurnId: string | null;
  window: {
    startIndex: number;
    endIndexExclusive: number;
    hasEarlier: boolean;
    hasLater: boolean;
  } | null;
  framesById: Map<string, ResourceEntry<CodexTurnRenderFrame>>;
  groupsByKey: Map<string, ResourceEntry<CodexWorkGroupResource>>;
  detailsByKey: Map<string, ResourceEntry<CodexWorkEntryDetailResource>>;
  dirty: {
    transcript: boolean;
    groupKeys: Set<string>;
    detailKeys: Set<string>;
  };
};
```

`ResourceEntry` is explicit:

```ts
type ResourceEntry<T> =
  | { status: 'idle' }
  | { status: 'loading'; value?: T }
  | { status: 'ready'; value: T }
  | { status: 'failed'; error: string; value?: T };
```

A prior ready value remains painted during refresh. Its entry becomes `loading` or `failed` with `value`, and only a successful atomic response replaces it.

The viewer sends a known frame revision only when it has the corresponding ready frame. If a server returns `notModified` without a ready local value, treat it as a protocol/cache inconsistency and retry that window once without known revisions. Do not render an empty turn.

### Applying a sync

Application is one store transaction:

1. Reject a response for another thread, generation, or protocol version.
2. Replace order and active-window metadata with the server-returned contiguous window.
3. Remove `removedTurnIds` from resource and layout caches.
4. Preserve frame object identity for `notModified` results.
5. Replace all `ok` frames atomically.
6. Store explicit errors for failed frames.
7. Reconcile open group/detail keys against the new frame identity.
8. Build and publish one measured presentation snapshot containing both order and rows.
9. Expose the resource revision as ready only after the initial presentation is measurable; the virtualizer never combines resource order with a different layout revision.

There is no state in which group references from one frame are paired with commentary from another.

### Prepending history

The active presentation range is contiguous and capped at 40 turns. A boundary read is eligible only after a real touch or wheel gesture settles near the top or bottom. Programmatic positioning, resize, safe-area changes, narration, anchor restoration, and initial hydration never arm paging. When an eligible top gesture settles:

1. Request `around(firstLoaded, before: 16, after: min(23, loadedCount - 1))` with known revisions.
2. Atomically replace the active window with the returned older window, reusing ready cached frames for `notModified` results.
3. Measure new frames.
4. Preserve the previously visible anchor element and pixel offset.
5. Expose a retry sentinel on failure.

After the first prepend from a 24-turn tail, all 24 existing frames remain and 16 earlier frames are added. On later prepends, the range slides: up to 16 newest offscreen frames leave the active window while remaining available in the bounded advisory cache. The symmetric newer-history request slides the range down. The viewer does not synthesize spacers for unloaded turns because their height is unknown. `turnOrder` is used to know that earlier or later history exists, not to fake exact scroll geometry.

The first pass does not speculatively prefetch unloaded transcript windows. User boundary intent, direct navigation, foreground verification, and return-to-latest are the only window-read triggers. This keeps background and hidden-tab work predictable; measurement data can justify an idle prefetch later.

### Direct navigation

If a requested turn is outside the active range, request an `around` window and replace the presentation range. Keep cached frames as advisory data, but do not render disjoint ranges. Show explicit `Load older`, `Load newer`, and `Return to latest` sentinels as applicable.

### Group disclosure

- Opening a group reads one `workGroup` resource.
- The group shell remains visible during loading.
- Opening another group closes the current group under the existing one-open disclosure rule.
- Opening a row reads one `workEntryDetail` resource.
- Closing a group aborts its pending group/detail reads and removes only ephemeral disclosure state; ready resources may remain in the bounded cache.
- A missing or failed group/detail renders an inline retry row. It never returns `null` silently.
- Cache at most 12 ready groups and 24 ready details per thread using least-recently-used eviction. Open resources are never evicted.

## Layout and PreText Measurement

The measurement cache key becomes:

```text
turn:{turnId}:{widthBucket}:{layoutRevision}
group:{groupKey}:{widthBucket}:{layoutRevision}:{pageCount}
detail:{detailKey}:{widthBucket}:{layoutRevision}
```

Rules:

- `renderRevision` alone does not invalidate height.
- Width changes invalidate measurement but not server resources.
- A group loading/error/ready transition has an explicit measured shell or body height.
- Group and detail bodies contribute additive disclosure height to their owning turn.
- Resource application and disclosure reconciliation happen before the virtualizer computes spacers.
- PreText measurement receives complete inline commentary and group summaries from the frame. It never measures a partial hydration state.
- Streaming refresh coalescing remains independent of the elapsed-time component tick.

### Safe area and width containment

The transcript keeps one element as both the flex child and the vertical scroller. Its inner measured lane owns `max(layoutPad, safe-area-inset-top)` as explicit top padding. The virtualizer reads that padding separately from turn heights, so it participates in anchor coordinates without contaminating PreText row measurement.

Do not wrap the scroller in an unconstrained flex shell. A shell with `min-width:auto` inherits the min-content width of code, tables, diffs, paths, and tool output before the inner overflow boundary can contain it. The scroller and measured lane require `width:100%`, `min-width:0`, and `max-width:100%`; only code/table/detail surfaces may scroll horizontally.

Validate portrait, landscape, Dynamic Island, non-notched devices, and pathological unbroken Markdown content.

## Narration Compatibility

The window protocol must preserve the existing narration source contract:

- completed assistant segment IDs remain canonical and stable;
- a frame contains the complete assistant Markdown source, not a preview;
- narration cache validity continues to use the assistant source hash plus narration pipeline version;
- a changed assistant segment invalidates narration through its source hash, independently of transcript measurement;
- narration target registration happens after an atomic frame render, never against partially hydrated Markdown;
- starting narration for an unloaded target first requests an `around` window for that turn, then starts playback after the target registry is ready;
- the actively narrated turn is pinned in the frame and measurement caches until playback closes.

No narration audio, transcript plan, cue, or forced-alignment payload is added to the turn render frame. Narration remains an on-demand resource with its own versioning and storage.

## Host Lifecycle Contract

### Native event

Add a host lifecycle message delivered independently of browser visibility heuristics:

```ts
export type RemuxHostLifecycleEvent = {
  state: 'active' | 'inactive' | 'background';
  epoch: number;
  reason: 'appState' | 'tabActive' | 'connect';
};
```

The native-to-WebView wire message is:

```ts
type NativeLifecycleMessage = {
  type: 'remux/lifecycle';
  lifecycle: RemuxHostLifecycleEvent;
};
```

`packages/viewer-kit/src/ipc.ts` adds this variant to `NativeMessage`, updates the lifecycle snapshot synchronously before notifying subscribers, and then emits at most one derived resume hint for an active transition.

`epoch` is monotonically increasing for the mounted WebView and increments whenever native state changes. Repeated messages with the same epoch are ignored.

Native computes one effective lifecycle state rather than forwarding raw signals independently:

```text
app background                 -> background
app inactive                   -> inactive
app active + extension hidden  -> inactive
app active + extension active  -> active
```

This prevents a tab-activation event from incorrectly marking a WebView active while the app is backgrounded.

React Native sends:

- `background` when `AppState` becomes background;
- `inactive` for iOS inactive transitions or when the extension tab stops being active;
- `active` when the app is active and this extension tab is active;
- a current-state event after WebView connection/reload so a late subscriber can reconcile.

Browser `pageshow` and `visibilitychange` remain fallback resume hints, not the authoritative lifecycle state.

### Viewer-kit API

Viewer-kit exposes:

```ts
getHostLifecycleSnapshot(): RemuxHostLifecycleEvent;
subscribeHostLifecycle(listener): () => void;
subscribeHostResume(listener): () => void;
```

Resume reasons expand to:

```ts
type RemuxHostResumeReason =
  | 'app-active'
  | 'tab-active'
  | 'connected'
  | 'pageshow'
  | 'visible';
```

`host/active` is folded into the lifecycle snapshot instead of remaining an unrelated signal. Existing consumers may keep the old API for one compatibility release.

### Background behavior

When inactive or backgrounded, the Codex viewer:

- preserves the last ready transcript DOM and store snapshot;
- aborts cancellable transcript, group, and detail reads;
- cancels idle prefetch and scheduled trailing refresh timers;
- records matching invalidations as dirty if JavaScript is still running;
- does not start hydration in response to hidden-tab invalidations;
- leaves server/runtime truth untouched.

No design may require a timer, fetch, or WebSocket callback to run while iOS suspends the WebView.

### Foreground ordering

On the first new active epoch:

1. Keep the cached transcript painted.
2. Start transcript sync immediately.
3. Start thread runtime refresh in parallel.
4. Start thread summary, history, queue, and composer refreshes in parallel at lower UI priority.
5. Apply the transcript response atomically.
6. Rehydrate only the still-open group and row if they remain in the new frame.
7. Run one trailing sync if invalidations arrived during the request.

Transcript refresh must not await thread history or queue refresh. The existing sequential resume ordering is removed.

Window selection on foreground:

- if follow mode is bottom, request `tail(24)`;
- otherwise verify the current contiguous loaded range, clamped to 40 around the visible anchor;
- if no range exists, request `tail(24)`.

Multiple `connected`, native active, `pageshow`, and `visible` hints in one epoch use one single-flight sync. A later epoch may supersede an earlier request by aborting it and advancing the viewer generation.

Resume deduplication is keyed by `(hostConnectionGeneration, lifecycleEpoch)`. A reconnect always permits one new sync even when the native lifecycle epoch did not change. Browser fallback hints are coalesced into the current pair; they never invent a newer lifecycle epoch.

## RPC and Cancellation Semantics

- Transcript sync, group read, and detail read use the semantic cancellable RPC contract.
- They do not add caller-authored wall-clock timeouts.
- Cancellation occurs on thread change, window replacement, disclosure close, lifecycle background, viewer generation change, or WebView disconnect.
- Server work checks cancellation between index advance, turn projections, and response encoding where the extension RPC runtime exposes cancellation.
- One transcript sync consumes one admission slot regardless of window size.
- Group pagination and entry detail each consume one slot per explicit user action.
- The global 64-slot client/runtime bounds remain unchanged.

## Cache Boundaries

### Server

- One incremental index per resolved rollout path.
- Completed projected turns keyed by stable range fingerprint and projection version.
- Active turn projected value replaced as its end grows.
- Group/detail values are derived from the cached canonical projected turn; they do not cause a second rollout read or duplicate heavy payload storage.
- Keep at most 8 session indexes in an LRU. An index with an in-flight request is pinned.
- Keep projected turns in a byte-accounted LRU capped at 128 MiB and 512 turns, whichever is reached first. In-flight turns and each indexed thread's open turn are pinned.
- Estimate cache weight from owned projected strings, diffs, media metadata, and container overhead using one conservative helper; exact allocator accounting is not required.
- Eviction affects performance only. Every evicted resource is reproducible from the rollout plus live overlay.

### Viewer

- Frames are advisory and scoped to thread plus projection version.
- The active contiguous range is retained across background/foreground.
- Evict least-recently-used off-range frames whenever the per-thread cache exceeds 80 frames. Active-range and actively narrated frames are pinned.
- Layout measurements are scoped to width bucket plus layout revision.
- A server protocol/projection-version change clears frame, group, detail, and measurement caches together.
- Current process-memory caching is sufficient. Do not add IndexedDB in this pass.

## Compatibility and Migration

### Additive server phase

1. Add version 2 shared types and validation without removing version 1.
2. Generate version 1 and version 2 resources from the same canonical projection.
3. Add server comparison fixtures proving equivalent visible turn/segment/timeline semantics.
4. Add `remux/codex/transcript/capabilities/read` with the exact capability response above.

### Viewer cutover

The viewer selects one protocol at thread-store creation:

- version 2 capability present: create the new render-window store;
- version 2 absent: use the existing version 1 store for that viewer generation;
- capability changes after a server restart: reload/reset the transcript store rather than mixing state.

Because static viewer assets and the extension server can update at different times, a version 2 viewer must tolerate an old server. An old viewer must continue to work against the compatibility server for one release.

### Feature flag

Use one extension-local flag, `codexTranscriptRenderV2`, default off during comparison and default on after device validation. Do not maintain per-resource subflags.

### Removal

After one observed release with version 2 default on, remove:

- `threadTranscript` embedded-tail compatibility logic;
- viewer all-turn chunk reads;
- `workDetails.itemIds` hydration;
- `workItemsByKey` and per-item `Promise.all`;
- version 1 `turn`, `workDetails`, and `workItem` requests;
- old lifecycle-only `host/active` compatibility handling;
- comparison telemetry and the feature flag.

Keep canonical projection helpers shared where useful.

## Implementation Plan

### Phase 1: Shared protocol and projection boundary

Files:

- `extensions/codex/shared/transcript.ts`
- `extensions/codex/shared/threadCommands.ts`
- `extensions/codex/server/src/transcript.rs`
- `extensions/codex/server/src/projection/mod.rs`
- `extensions/codex/server/src/projection/work.rs`
- new `extensions/codex/server/src/projection/render.rs`

Work:

1. Add version 2 request, response, frame, group, detail, and invalidation types.
2. Extract one canonical `ProjectedTurn` model that can emit both compatibility and render-frame resources.
3. Inline commentary, steering, and compaction into work timelines.
4. Derive stable group/row IDs through the existing item-identity layer.
5. Compute render and layout revisions separately.
6. Add golden fixtures for commentary-separated tool groups, changed files, compaction, steering, rollback, running groups, and completed groups.

Exit gate: a fixture with 99 work items renders all 11 commentary messages and 14 groups from one turn frame without work-item reads.

### Phase 2: Incremental history index and stable projection cache

Files:

- `extensions/codex/server/src/history/mod.rs` for the public history API and cache orchestration;
- new `extensions/codex/server/src/history/index.rs` for the incremental state machine;
- new `extensions/codex/server/src/history/reader.rs` for streaming and appended-range reads;
- `extensions/codex/server/src/resources/mod.rs`;
- `extensions/codex/server/src/live_transcript.rs`.

Work:

1. Implement file identity, indexed length, partial-line buffering, boundary fingerprint, and append advancement.
2. Make full scans streaming.
3. Separate thread-index revision from stable completed-turn validity.
4. Reproject only changed/open/live-reconciled turns.
5. Add counters for bytes scanned, rows parsed, rebuild reason, projected turns, and projection-cache hits.

Exit gate: appending one row to the 86 MiB fixture reads only the appended range and does not reproject completed turns.

### Phase 3: Version 2 server resources

Files:

- `extensions/codex/server/src/resources/mod.rs`
- `extensions/codex/server/src/resources/validate.rs`
- `extensions/codex/server/src/resources/tests.rs`
- `extensions/codex/server/src/resource_invalidations.rs`
- `extensions/codex/server/src/main.rs`

Work:

1. Implement `transcriptSync`, `workGroup`, and `workEntryDetail` requests.
2. Enforce window, known-revision, pagination, text, and response budgets.
3. Add the version-neutral transcript capability method and per-request protocol validation.
4. Emit resource-level invalidations with layout impact.
5. Retain version 1 resources during migration.

Exit gate: the reported turn opens in one transcript RPC; each group opens in one RPC; a single row detail opens in one RPC; no operation approaches 64 pending requests.

### Phase 4: Viewer render-window store

Files:

- `extensions/codex/viewer/ipc/transcript.ts`
- new `extensions/codex/viewer/transcript/renderStore.ts`
- `extensions/codex/viewer/transcript/store.ts`
- `extensions/codex/viewer/transcript/layoutStore.ts`
- `extensions/codex/viewer/transcript/layout/measureCache.ts`
- `extensions/codex/viewer/transcript/layout/reconcileMeasured.ts`
- `extensions/codex/viewer/transcript/virtualizer.tsx`
- `extensions/codex/viewer/transcript/virtualizerRange.ts`
- `extensions/codex/viewer/transcript/components/work/WorkSection.tsx`

Work:

1. Add the isolated version 2 store and capability-based selection.
2. Render inline work timeline entries directly from frames.
3. Add group and row disclosure resource states with retry placeholders.
4. Implement contiguous tail, prepend, direct-navigation, and return-to-latest windows.
5. Preserve scroll anchor across prepend and atomic frame replacement.
6. Key measurements by layout revision and width.
7. Bound advisory resource caches.
8. Remove any version 2 path that silently renders a missing semantic row as `null`.

Exit gate: throttling or rejecting the 65th RPC cannot alter transcript semantics because ordinary transcript rendering never creates that fan-out.

### Phase 5: Native lifecycle and foreground-first resume

Files:

- `packages/viewer-kit/src/ipc.ts`
- `packages/viewer-kit/src/host.ts`
- viewer-kit tests;
- `app/src/surfaces/viewer/ExtensionWebView.tsx`
- `extensions/codex/viewer/resumeSync.ts`
- `extensions/codex/viewer/ipc/resourceInvalidations.ts`
- `extensions/codex/viewer/transcript/streamingRefreshScheduler.ts`

Work:

1. Send epoch-based lifecycle state from native.
2. Expose lifecycle snapshot/subscription in viewer-kit.
3. Preserve compatibility resume hints.
4. Abort/defer reads while inactive/backgrounded and mark resources dirty.
5. Start transcript and runtime refresh first and in parallel on active.
6. Deduplicate resume hints by epoch and single-flight generation.
7. Rehydrate only still-open visible disclosures.

Exit gate: background for 30 seconds during streaming, then foreground. Cached content paints immediately; one transcript sync starts without waiting for history/queue; the authoritative tail appears without duplicate or missing rows.

### Phase 6: Viewport containment, observability, and cleanup

Files:

- `extensions/codex/viewer/transcript/virtualizer.tsx`
- `extensions/codex/viewer/styles.css`
- `docs/architecture/codex-streaming.md`
- `docs/specs/codex/transcript-store-scroll.md`
- `docs/specs/README.md`

Work:

1. Retain one width-contained transcript scroller and account for safe-area top padding separately from turn heights.
2. Add development diagnostics and production counters listed below.
3. Run comparison mode and device validation.
4. Enable version 2 by default.
5. Update current-state architecture documentation.
6. Mark superseded version 1 sections clearly; remove compatibility code only after the observation release.

## Tests

### Rust unit tests

- Empty rollout and no turns.
- Cold streaming index build.
- Append complete line.
- Append partial line followed by completion.
- Inode replacement.
- Truncation and rollback.
- Boundary fingerprint mismatch.
- Open-turn range growth.
- Completed-turn cache survives unrelated append.
- Live overlay changes one turn without invalidating stable turns.
- Commentary between like-typed groups remains in the frame.
- Known frame revision returns `notModified`.
- Response budget removes farthest frames and keeps the anchor.
- Oversized anchor returns explicit `frameTooLarge`.
- Group cursor is revision-bound.
- Detail truncation metadata is accurate.

### Resource integration tests

Extend `extensions/codex/server/src/resources/tests.rs` with:

- 99-item regression fixture;
- cold tail window;
- range verification;
- prepend window;
- direct-navigation window;
- rollback removes known turns;
- mixed disk/live active turn;
- group summary and detail separation;
- version 1/version 2 semantic comparison;
- protocol-version rejection and fallback.

### Viewer tests

Add focused tests under `extensions/codex/tests/` for:

- atomic frame application;
- preserving `notModified` object identity;
- explicit error placeholder instead of missing row;
- one group request per disclosure;
- one detail request per row disclosure;
- one-open group behavior;
- prepend anchor preservation;
- direct navigation and return-to-latest;
- layout revision versus render revision;
- hidden/background dirty marking;
- foreground single-flight dedupe;
- cancellation on background/thread change;
- streaming invalidation coalescing;
- safe-area exclusion from measured heights.

### Native/viewer-kit tests

- Lifecycle epoch monotonicity.
- App active plus tab inactive resolves to `inactive`.
- Connection sends the current lifecycle snapshot.
- Duplicate active messages in one epoch do not produce duplicate resume work.
- `pageshow` and `visible` remain fallback hints.

### Device scenarios

Run on a physical iPhone or the closest available simulator:

1. Cold-open a 75+ turn thread.
2. Expand the 99-item work section and each group type.
3. Background during an active turn and resume after 5, 30, and 120 seconds.
4. Switch to another extension tab while Codex streams, then return.
5. Scroll deep into history, background, and resume without jumping to tail.
6. Prepend history while momentum scrolling.
7. Rotate portrait/landscape on a Dynamic Island device.
8. Disconnect/reconnect while backgrounded.
9. Roll back a turn while the viewer holds cached frames.

## Performance Gates

Measure release builds on the reference host and an iPhone target. Record p50 and p95 over at least 20 warm runs plus 5 cold runs.

### Server

- Warm append index advancement on the 86 MiB fixture: p95 under 20 ms and bytes read proportional to appended bytes plus boundary fingerprint.
- Warm tail transcript sync with unchanged completed turns: p95 under 75 ms server time.
- Active-turn streaming transcript sync: p95 under 100 ms server time.
- Cold 86 MiB streaming index build: p95 under 750 ms on the reference host.
- Completed-turn projection-cache hit rate after append: at least 95% when only the active turn changes.
- Ordinary transcript sync request count: 1.
- Ordinary group-open request count: 1.

### Viewer

- Cached foreground paint: no blank transcript frame.
- First authoritative foreground sync begins within one animation frame after active lifecycle delivery when connected.
- No more than one transcript sync in flight per viewer generation.
- Streaming frame application target: 5–8 updates per second.
- No long task over 50 ms attributable to transcript store application in the tested 40-turn window.
- Prepend preserves the visible anchor within 2 CSS pixels after measurement settles.
- Open/close disclosure height accounting drift: 0 pixels after the reconciliation frame.

Performance gates are acceptance criteria, not production RPC timeouts.

## Observability

Add structured, rate-limited development diagnostics and aggregate production counters:

### Server counters

- `transcript_index_build_total{reason}`;
- `transcript_index_bytes_read`;
- `transcript_index_rows_parsed`;
- `transcript_projection_total{cache=hit|miss}`;
- `transcript_sync_duration_ms`;
- `transcript_sync_encoded_bytes`;
- `transcript_sync_window_turns`;
- `transcript_group_rows`;
- `transcript_detail_truncated_total{type}`.

### Viewer counters

- transcript sync requested/applied/aborted/failed;
- foreground cause and deduped cause count;
- cached frames shown before verification;
- changed versus not-modified frames;
- group/detail cache hit and eviction;
- measurement hit/miss by resource layer;
- prepend anchor correction pixels;
- maximum concurrent transcript RPCs.

Do not log full user messages, assistant text, tool output, diffs, or media URIs. IDs and byte/count/timing metadata are sufficient.

## Acceptance Criteria

The implementation is complete when all of the following are true:

- The regression turn renders every commentary boundary and no misleading consecutive duplicate group rows.
- Default rendering performs no per-work-item reads.
- One transcript sync produces a complete collapsed window.
- One ordinary group request produces all visible group rows.
- Heavy output/diff/media is fetched only for an opened row.
- Missing/failed/oversized resources have explicit UI states.
- Appending to a rollout does not rescan 86 MiB or invalidate stable completed-turn projections.
- Backgrounded and hidden viewers do not initiate hydration.
- Foreground transcript verification starts immediately and does not await history, queue, or composer refresh.
- Cached content remains painted through foreground verification.
- Window prepend and disclosure changes preserve scroll anchors and exact PreText height accounting.
- Safe-area padding is explicit in viewport anchor coordinates and is not included in individual turn measurement.
- Version 1 and version 2 can coexist for one compatibility release without mixed-store state.
- The current architecture document is updated after version 2 becomes the default.

## Explicitly Rejected Alternatives

- Raise the 64-request limit: preserves semantic fan-out and fails again on larger turns.
- Add a client concurrency pool around 99 item reads: avoids admission failure but still renders partial semantic state and delays measurement.
- Put every tool output and diff in each turn: makes default responses unbounded and harms resume.
- Use app-server thread history directly: loses the detailed rollout projection and still replays large histories.
- Apply raw notifications to React state: creates a second transcript truth and makes disk reconciliation nondeterministic.
- Load all turns before first paint: scales with thread lifetime rather than viewport need.
- Fabricate spacer heights for unloaded history: makes scroll geometry inaccurate.
- Depend only on `visibilitychange`: insufficient for native tab state and iOS suspension.
- Refresh everything sequentially on resume: delays the content the user is looking at.
- Persist an index database immediately: adds recovery and migration complexity before measuring the simpler incremental memory index.

## Final Decision Record

- Consistency unit: self-contained turn render frame.
- Initial window: 24 tail turns.
- Maximum window: 40 turns.
- History expansion: 16 turns per prepend.
- Work disclosure: group summary resource, one request in the ordinary case.
- Heavy disclosure: one row detail resource.
- Transcript order: full ordered ID list on each sync.
- Active presentation: one contiguous range; explicit sentinels for gaps/newer history.
- Server history index: incremental in memory, streaming cold rebuild, no database.
- Stable cache key: byte range fingerprint plus projection version, not global file revision.
- Resume authority: native lifecycle epoch with browser fallbacks.
- Foreground priority: transcript and runtime first, other stores parallel and lower priority.
- Background behavior: preserve, cancel/defer, mark dirty, verify once active.
- Measurement key: width plus server layout revision.
- Presentation publication: order and measured rows come from one layout snapshot; resource readiness cannot expose mixed revisions.
- Paging intent: only a settled user touch/wheel gesture may request a boundary window.
- Viewport topology: one width-contained flex scroller; horizontal overflow stays local to code, table, diff, and detail surfaces.
- Migration: additive version 2, capability-selected store, one compatibility release, then version 1 removal.
