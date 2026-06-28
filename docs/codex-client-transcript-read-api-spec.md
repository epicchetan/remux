# Codex Client Transcript Read API Spec

## Purpose

Rework the Codex extension client transcript path around the Rust server's batch read API.

This phase is transcript-focused and read-only. The goal is to make transcript rendering, measurement, and virtualization deterministic before reintroducing streaming, invalidation pushes, or composer workflows.

The server remains authoritative for transcript truth. The client mirrors server resources by key and revision, derives measurement from those resources, and uses viewport state only for rendering a relative virtualized transcript.

## Scope

In scope:

- Replace the current transcript store with a read-API-focused transcript client/cache.
- Remove client-side transcript streaming overlay behavior.
- Remove transcript event buffering and old per-method transcript reads.
- Use `remux/codex/transcript/resources/read` as the only transcript data read path.
- Keep the relative transcript virtualizer model.
- Keep collapsed measurement and measurement caching where compatible.
- Keep one expanded work section at a time.
- Load expanded work details through the same batch read API.
- Make the frontend build and run so the transcript implementation can be validated.

Out of scope for this phase:

- Composer correctness.
- Send/edit/fork/rollback UX correctness.
- Streaming deltas.
- Server invalidation pushes.
- Token usage display.
- Thread lifecycle refactors beyond what is required to keep the app running.

## Non-Goals

- Do not preserve the old transcript store API for composer convenience.
- Do not keep `streamOverlay` as a compatibility layer.
- Do not add TanStack Query for transcript resources.
- Do not make transcript state responsible for composer state, thread drafts, token usage, or host scroll buttons.
- Do not optimize tail-first loading until the full read/measure path is correct.

## New Client Shape

The transcript path should be layered:

```text
server read API
  -> TranscriptResourceCache
  -> measured transcript cache
  -> virtualizer range
  -> rendered rows
```

Avoid:

```text
server events + streaming overlay + transcript reads + measurement + disclosure + token usage in one store
```

## Transcript Resource Cache

The transcript resource cache is the client mirror of the server contract.

State shape:

```ts
type TranscriptResourceCacheSnapshot = {
  activeThreadId: string | null;
  status: "idle" | "loading" | "ready" | "failed";
  thread: null | {
    revision: string;
    turnOrder: string[];
  };
  turnsById: Record<string, {
    revision: string;
    layoutRevision: string;
    turn: CodexTranscriptTurn;
    status: "ready" | "missing" | "error";
  }>;
  workDetailsByKey: Record<string, {
    revision: string;
    details: CodexWorkDetails;
    status: "ready" | "missing" | "error";
  }>;
};
```

All transcript reads go through:

```ts
readTranscriptResources(threadId, requests)
```

Request examples:

```ts
[
  { type: "threadTranscript", knownRevision },
  { type: "turn", turnId, knownRevision },
  { type: "workDetails", turnId, segmentId, knownRevision },
]
```

Resource keys should match the server:

```text
threadTranscript:{threadId}
turn:{threadId}:{turnId}
workDetails:{threadId}:{turnId}:{segmentId}
```

Rules:

- Cache by resource key and server revision.
- Send `knownRevision` whenever possible.
- Treat `notModified` as a no-op.
- Reconcile only resources returned as changed.
- Dedupe in-flight reads by resource key.
- Batch compatible reads together.
- Ignore stale responses when `activeThreadId` has changed.
- Keep resource data separate from measured layout state.

## Initial Load

For this phase, prefer the simple correct path:

1. Active thread id is set.
2. Transcript viewport width is known.
3. Read `threadTranscript`.
4. Read all turns in one or more batches.
5. Reconcile resource cache.
6. Measure collapsed turns.
7. Render the transcript at the bottom.

This means the first version may wait for all turns before becoming fully ready. That is acceptable for this phase because it preserves perfect height math. Tail-first rendering can come later once the cache and measurement path are stable.

## Measurement Cache

Measurement remains a derived layer.

Measurement key:

```text
threadId + turnId + turn.revision + width + userActionRowId
```

Rules:

- `turn.revision` is the invalidation boundary for collapsed turn measurement.
- `workDetails` changes do not invalidate collapsed measurement.
- Expanded work height is tracked separately as an additional height delta.
- Width changes force remeasurement.
- Measurement cache is not authoritative state.

The existing `pre-text`-based measurement strategy still fits this model.

## Virtualizer State

The virtualizer should remain relative and scroll-event driven.

Viewport/layout state:

```ts
type TranscriptViewportState = {
  width: number | null;
  activeTurnIds: string[];
  openWork: null | {
    rowId: string;
    turnId: string;
    segmentId: string;
    additionalHeight: number;
    openChildByKey: Record<string, boolean>;
  };
  canScrollUp: boolean;
  canScrollDown: boolean;
};
```

Rendering shape:

```tsx
<TopSpacer height={topSpacerHeight} />
{activeTurnIds.map((turnId) => <TurnRow key={turnId} turnId={turnId} />)}
<BottomSpacer height={bottomSpacerHeight} />
```

Rules:

- React owns component rendering.
- Imperative DOM work is limited to reading `scrollTop`, setting `scrollTop`, reading viewport dimensions, and measuring expanded work body height.
- No absolute positioning.
- Scroll handling uses `requestAnimationFrame`.
- Active ids update only when the computed virtual range actually changes.
- Spacer heights are computed from measured collapsed heights plus the one expanded work delta.

## Expanded Work Details

Keep the one-open-work rule.

Rules:

- Only one work section may be expanded at a time.
- Opening a second work section closes the first in the same state transition.
- Closing/opening updates range accounting at the same time to avoid layout jumps.
- If the open work unmounts, the open state remains.
- When it remounts, the body measures itself and updates `additionalHeight`.
- Work details are read through `resources/read`.
- Missing details render a lightweight loading state inside the expanded body.

Opening flow:

1. User toggles a work section.
2. Viewport state records `openWork`.
3. If details are missing or stale, request:

   ```ts
   { type: "workDetails", turnId, segmentId, knownRevision }
   ```

4. Cache reconciles details by resource key.
5. The work section rerenders from that specific details key.
6. Expanded body height updates `additionalHeight`.

## Store Choice

Do not use TanStack Query for transcript resources in this phase.

Reasoning:

- We own the server, resource keys, revision model, batching, and future invalidation semantics.
- TanStack's generic query key and invalidation model would add behavior we would need to constrain.
- The transcript cache needs resource-level reconciliation and in-flight batch dedupe, not broad background refetch behavior.
- Measurement and virtualization are tightly coupled to resource revisions.

Use a small custom external store for authoritative transcript resource cache:

```ts
class TranscriptClient {
  getSnapshot(): TranscriptResourceCacheSnapshot;
  subscribe(listener: () => void): () => void;
  setThread(threadId: string | null): Promise<void>;
  readBatch(requests: TranscriptResourceRequest[]): Promise<void>;
  ensureTurns(turnIds: string[]): Promise<void>;
  ensureWorkDetails(input: { turnId: string; segmentId: string }): Promise<void>;
}
```

React hooks should wrap this with selector-based subscriptions:

```ts
useTranscriptResource(selector)
useTranscriptTurn(turnId)
useTranscriptWorkDetails(turnId, segmentId)
```

Use `useSyncExternalStore` or `useSyncExternalStoreWithSelector` for narrow rerenders.

Zustand is still acceptable for local UI state such as viewport/disclosure/scroll controls, but it should not be the core transcript resource cache unless it is wrapped so external consumers cannot import arbitrary internals.

## Public Boundary

Do not export raw `useTranscriptStore` from `viewer/index.ts`.

The transcript feature should expose narrow APIs:

```ts
<CodexTranscript threadId={threadId} />
useTranscriptViewportControls()
getTranscriptTurnSnapshot(threadId, turnId)
getTranscriptForkSource(target)
```

These APIs should be intentionally small and should not leak cache internals.

## Current Consumers

Current direct consumers of the transcript store and what should happen to them:

### `viewer/App.tsx`

Current behavior:

- Imports `useTranscriptStore`.
- Calls `setActiveThreadId(activeThreadId)`.

Target behavior:

- Stop importing transcript store.
- Render transcript with props:

  ```tsx
  <CodexTranscript threadId={activeThreadId} />
  ```

The transcript component owns the client/cache lifecycle for that thread.

### `transcript/virtualizer.tsx`

Current behavior:

- Reads `turnOrder`, `turnsById`, `status`, `activeTurnIds`, `workingTurnId`, disclosure, and scroll controls from `useTranscriptStore`.

Target behavior:

- This remains transcript-owned.
- It should read from the new transcript resource hooks and viewport state.
- It should not know about composer, token usage, streaming overlays, or server events.

### `transcript/components/work/WorkSection.tsx`

Current behavior:

- Reads disclosure state and height setters from transcript store.
- Receives details from `turnDetailsById`.

Target behavior:

- Keep disclosure/height behavior, but back it with transcript viewport state.
- Read work details by exact resource key through `useTranscriptWorkDetails(turnId, segmentId)`.

### `transcript/components/userMessage.tsx`

Current behavior:

- Reads `activeThreadId` and `isWorking` from transcript store for edit actions.

Target behavior:

- Do not read raw transcript store.
- Either receive action availability as props from transcript row rendering or call a narrow action facade.
- If edit is not supported in this phase, disable the edit button or hide user-message actions behind a temporary `transcriptActionsEnabled = false`.

### `transcript/components/assistantMessage.tsx`

Current behavior:

- Reads `activeThreadId`, `isWorking`, and `status` for fork actions.

Target behavior:

- Do not read raw transcript store.
- If fork is not supported in this phase, disable or hide fork actions behind the same temporary action gate.

### `composer/actions/turnAction.ts`

Current behavior:

- Reads transcript `activeThreadId`, `isWorking`, `status`, `workingTurnId`.
- Calls `setActiveThreadId`.
- Calls `applyServerEvents`.
- Calls `replaceTurns`.
- Reads `turnOrder` and `turnsById`.
- Subscribes to transcript store to wait for a turn.

Target behavior for this phase:

- Remove all direct transcript store mutations.
- Do not fake transcript events.
- Do not call `replaceTurns`.
- Do not wait on transcript store visibility as a send completion condition.
- Use thread store for active thread identity.
- Composer may remain partially disabled while transcript is being reworked.

Temporary compile-safe approach:

- Keep interrupt/send buttons disabled when the new transcript lifecycle does not expose working state.
- For new-chat/thread-start flows, select the thread via thread store only.
- After a thread mutation, request a transcript refresh through a narrow transcript facade if needed:

  ```ts
  transcriptClient.reloadThread(threadId)
  ```

- If this is too much for phase one, gate turn actions with a clear local flag:

  ```ts
  const composerTurnActionsEnabled = false;
  ```

  This is acceptable because composer correctness is out of scope. The frontend still needs to build and run so transcript can be validated.

### `composer/config/ConfigButton.tsx`

Current behavior:

- Reads transcript `activeThreadId`, `isWorking`, and `status` to decide compaction availability.

Target behavior for this phase:

- Use thread store for active thread id.
- Disable compaction while transcript rewrite is in progress, or gate it behind a narrow lifecycle helper later.

### `composer/config/RuntimeConfigHydrator.tsx`

Current behavior:

- Reads transcript `activeThreadId`.

Target behavior:

- Use thread store active thread id.
- This should not depend on transcript rendering.

### `composer/actions/ActionButtons.tsx`

Current behavior:

- Reads transcript scroll controls: `canScrollUp`, `canScrollDown`, `scrollUp`, `scrollDown`.

Target behavior:

- Move scroll controls to a narrow viewport controller:

  ```ts
  useTranscriptViewportControls()
  ```

- This can stay available to composer chrome because it is viewport UI state, not transcript resource state.

### `composer/actions/InlineStatus.tsx`

Current behavior:

- Reads token usage from transcript store.

Target behavior:

- Move token usage out of transcript.
- Disable or hide token usage display in this phase if no replacement source exists.

## Temporary Disable Strategy

The composer is not expected to be functional in this phase, but the frontend must build and run.

Allowed temporary changes:

- Disable composer send/edit/fork/compact controls.
- Hide transcript row action buttons that require composer.
- Replace action handlers with no-op disabled states.
- Move active thread reads from transcript store to thread store.
- Use a narrow transcript reload facade after mutations only if needed for build/runtime validation.

Disallowed temporary changes:

- Add compatibility fields to the new transcript resource cache just for composer.
- Recreate `applyServerEvents`, `replaceTurns`, or `streamOverlay`.
- Let composer import the raw transcript resource cache.
- Let token usage or thread lifecycle state live inside transcript state.

## Streaming Later

Streaming should return as invalidation, not as a parallel render model.

Future event path:

```text
server event says resource key changed
client marks resource stale
client batches read with knownRevision
server returns ok/notModified
client reconciles changed resource
measurement updates only if turn layout changed
```

Text delta streaming can become a specialized fast path later, but it should plug into the same resource cache and reconciliation model.

## Implementation Order

1. Add shared TypeScript types for the batch read API.
2. Replace `ipc/transcript.ts` with `resources/read`.
3. Add `TranscriptClient` custom external store.
4. Add selector hooks around `TranscriptClient`.
5. Add viewport/disclosure state separate from resource cache.
6. Rewire `<CodexTranscript threadId={...} />`.
7. Rewire virtualizer to use resource hooks and viewport state.
8. Rewire `WorkSection` to request details by resource key.
9. Remove stream overlay and transcript event buffering from the client.
10. Neutralize composer dependencies that touch transcript internals.
11. Validate build and run with transcript-only workflows.

## Validation

Build/runtime validation should focus on transcript correctness:

- Frontend builds.
- App runs with composer controls disabled if needed.
- Selecting a thread loads transcript via `resources/read`.
- The rendered tail matches manual server reads.
- No duplicate user or assistant segments are obvious.
- Work sections expand one at a time.
- Expanded work details load via `resources/read`.
- Scrolling remains relative, not absolute-positioned.
- Mobile scroll remains native and smooth.
- Width changes remeasure turns.
- Reopening a previously unmounted expanded work section preserves accounting.

## Success Criteria

This phase is complete when:

- Transcript rendering no longer depends on old streaming events.
- Transcript resources are read only through the batch read API.
- Transcript resource cache is isolated from composer and token usage.
- The virtualizer renders from measured server resources.
- Work details are loaded by resource key.
- The frontend builds and runs.
- Composer may be disabled or partially nonfunctional, but it must not force transcript store compatibility shims.
