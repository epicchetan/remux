# Codex Transcript Store and Scroll Implementation Spec

Status: Implemented
Last verified: 2026-06-28
Canonical code: `extensions/codex/viewer/transcript/resourceStore.ts`, `extensions/codex/viewer/transcript/layoutStore.ts`, `extensions/codex/viewer/transcript/viewportStore.ts`, `extensions/codex/viewer/transcript/virtualizer.tsx`

## Goal

Keep the Codex transcript viewer server-authoritative while making the client state easier to reason about.

The transcript component should receive a `threadId`, read authoritative resources from the Rust server, derive measurement locally, and let the virtualizer own only viewport behavior. Streaming and send invalidations should enter through the same resource invalidation path as manual refreshes.

This pass should also remove the temporary viewer diagnostics added while debugging send/streaming. Debug logging can return later behind an explicit diagnostic flag, but it should not be part of the default runtime path.

## Current Problem

`viewer/transcript/store.ts` is doing three jobs:

- Resource cache: active thread, thread revision, turn resources, work details, working turn status.
- Layout cache: measured turns, transcript width, disclosure height deltas.
- Viewport controls: active mounted turn ids, scroll up/down commands, scroll availability.

Those are related, but they have different lifetimes and update frequencies. Server resources change on reads and invalidations. Measurements change on width/resource/disclosure changes. Scroll data changes frequently and should not force transcript data churn.

## Target Ownership

### Transcript Resource Store

This is the server-state mirror.

State:

```ts
type TranscriptResourceState = {
  activeThreadId: string | null;
  status: "idle" | "loading" | "ready" | "failed";
  threadRevision: string | null;
  turnOrder: string[];
  turnResourcesById: Record<string, TranscriptTurnResourceEntry>;
  workDetailsByKey: Record<string, TranscriptWorkDetailsEntry>;
  isWorking: boolean;
  workingTurnId: string | null;
};
```

Responsibilities:

- Read `threadTranscript`, `turn`, and `workDetails` through `readTranscriptResources`.
- Send `knownRevision` whenever available.
- Preserve object identity for unchanged turn resources.
- Keep ready transcript data rendered while invalidation rereads are in flight.
- Ignore stale responses when the active thread or read generation changes.
- Expose narrow actions: `setActiveThreadId`, `invalidateTranscriptResources`, `ensureWorkDetails`.

It should not own scroll mechanics, composer edit/fork mode, token data, or DOM measurements.

### Transcript Layout Store

This is derived client state.

State:

```ts
type TranscriptLayoutState = {
  width: number | null;
  turnsById: Record<string, TranscriptMeasuredTurn>;
  disclosure: TranscriptDisclosureState;
};
```

Responsibilities:

- Measure collapsed turns from resource store data plus width.
- Reuse `TranscriptMeasureCache`.
- Remeasure only dirty turns when invalidation changes a subset of resources.
- Force full remeasurement on width change.
- Track one expanded work disclosure and its `additionalHeight`.
- Reconcile disclosure when its row disappears.

Work details are read by the resource store; expanded body height is a layout concern.

### Transcript Viewport Controller

This is viewport-local behavior.

State:

```ts
type TranscriptViewportState = {
  activeTurnIds: string[];
  canScrollUp: boolean;
  canScrollDown: boolean;
  autoScrollMode:
    | { type: "bottom" }
    | { type: "sent-message-anchor"; turnId: string }
    | { type: "off" };
};
```

Responsibilities:

- Compute the visible range plus overscan.
- Maintain top and bottom spacer heights.
- Expose up/down navigation commands.
- Read and set `scrollTop` inside `requestAnimationFrame`.
- Keep high-frequency scroll facts in refs where React state is not needed.

`activeTurnIds` means the turn ids currently mounted by the virtualizer. It is not transcript data and should not be used as a resource cache boundary.

## Invalidation Flow

The server emits or returns `CodexResourceInvalidation[]`.

Viewer flow:

1. `applyCodexResourceInvalidations(invalidations)` receives the batch.
2. Thread history store refreshes matching thread history or thread summary resources.
3. Transcript resource store checks for a matching active `threadTranscript` invalidation.
4. Transcript resource store rereads the thread transcript with `knownRevision`.
5. It rereads turns with known turn revisions.
6. It builds `dirtyTurnIds` for changed, added, removed, missing, or errored turns.
7. Layout store reconciles measured turns using `dirtyTurnIds`.
8. React store listeners fire, but selector equality keeps components whose selected slice did not change from rerendering.

The viewer should not parse app-server deltas into transcript rows in this phase. Event listening is only an invalidation source.

## Scroll Behavior

Navigation buttons:

- Up goes to the previous user message anchor.
- Down goes to the next user message anchor.
- If down has no next user message, it goes to the bottom.

Auto-scroll modes:

- `bottom`: if the user is at the bottom, new measured height keeps the viewport pinned to the bottom.
- `sent-message-anchor`: after sending, follow growth until the just-sent user message reaches the top anchor offset, then switch to `off`.
- `off`: preserve the user's reading position.

Mode transitions:

- Manual scroll switches to `off`, unless the user scrolls back to bottom.
- Reaching bottom switches to `bottom`.
- Sending an existing-thread message switches to `sent-message-anchor` once the resulting user turn id is known.
- Opening or closing expanded work updates spacer accounting in the same frame as disclosure state.

The virtualizer should continue rendering relative DOM:

```tsx
<TopSpacer height={topSpacerHeight} />
{activeTurnIds.map((turnId) => <Turn key={turnId} turnId={turnId} />)}
<BottomSpacer height={bottomSpacerHeight} />
```

No absolute positioning is required.

## Composer, Edit, and Fork

Composer state should stay outside the transcript store.

- Existing-thread send calls the server with `threadId` and composer-owned message parts.
- Server owns Codex app-server request construction.
- The composer may track submission UI state locally, but transcript truth comes back through invalidation plus read.
- Edit/fork mode should live in composer/thread UI state until the server exposes explicit edit/fork commands.
- Once edit/fork commands exist, transcript store should only react to the resulting active thread and invalidations.

## Implementation Steps

1. Remove temporary viewer diagnostics from composer send, invalidation IPC, and transcript load paths.
2. Keep the current combined transcript store working, but rename concepts internally where useful:
   - `turnResourcesById` remains resource data.
   - `turnsById` is measured layout data.
   - `activeTurnIds` is viewport-mounted range data.
3. Extract resource actions and types into a focused module once the current behavior is stable.
4. Extract measurement/disclosure state after resource extraction.
5. Move viewport auto-scroll/navigation into the virtualizer layer, backed by refs plus low-frequency store snapshots.
6. Add focused tests for invalidation reread, dirty turn measurement, one-open-work accounting, and auto-scroll mode transitions.

## Verification

Minimum checks after each extraction:

- `npm --workspace @remux/codex run build`
- `cargo test --manifest-path extensions/codex/server/Cargo.toml --offline`
- Open a known thread and verify the transcript renders from `threadId`.
- Send a short message in an existing thread and verify:
  - server accepts the send,
  - invalidation triggers transcript reread,
  - the user turn appears without a full blank reload,
  - unchanged earlier turns keep stable rendering.
