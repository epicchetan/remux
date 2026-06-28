# Codex Current Thread Send and Invalidation Spec

Status: Archived
Last verified: 2026-06-28
Canonical code: `extensions/codex/server/src/thread_commands.rs`, `extensions/codex/server/src/resource_invalidations.rs`, `extensions/codex/viewer/ipc/resourceInvalidations.ts`

## Purpose

Add the smallest useful send path for an already-selected Codex thread while preserving the server-authoritative read model.

The viewer should submit a minimal composer message to the Rust extension server. The Rust server should own the Codex-facing request shape: resume the selected thread through Codex app-server when needed, build `turn/start` params from server-known thread/runtime state plus submitted composer content, start a new turn, and then drive transcript/thread updates through invalidation plus resource rereads.

This phase is not a text-delta streaming implementation. The viewer should not reconstruct transcript state from app-server event payloads. It should keep reading authoritative resources and reconcile changed resources into its existing caches.

## Current State

The Rust extension server exposes:

- `remux/codex/transcript/resources/read`
- `remux/codex/thread/resources/read`
- `remux/codex/files`

The Rust server now has a persistent `AppServerRuntime` that can connect to or spawn Codex app-server over the Unix control socket. Current thread resources use this runtime for `thread/list` and `thread/read`.

The viewer already has read-focused stores:

- `viewer/transcript/store.ts` mirrors transcript resources and measures turns.
- `viewer/threads/historyStore.ts` mirrors thread history and summaries.
- `viewer/threads/store.ts` is only UI/draft selection state.
- `viewer/composer/model/sendProjection.ts` currently converts the composer snapshot to Codex `UserInput[]`.

The missing pieces are:

- A Remux-specific send method on the Rust server.
- A server-side invalidation event path.
- A viewer-side cache invalidation path that keeps old data rendered while rereads are in flight.
- Composer wiring that submits the current thread message without reviving legacy transcript streaming.
- A narrower composer/server boundary so the viewer does not build Codex app-server params.

## Codex Source Grounding

This implementation should be grounded in the checked-in Codex app-server source, not guessed from old viewer code.

Primary source files:

- `codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
  - `ThreadResumeParams`
  - `ThreadResumeResponse`
- `codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
  - `TurnStartParams`
  - `TurnStartResponse`
  - `TurnStartedNotification`
  - `TurnCompletedNotification`
- `codex/codex-rs/app-server/src/request_processors/turn_processor.rs`
  - `turn/start` first calls `load_thread(&params.thread_id)`.
  - `load_thread` only resolves already-loaded threads through `thread_manager.get_thread`.
  - This is why our send command must call `thread/resume` before `turn/start` when the Rust runtime has not loaded that thread.
  - `turn/start` maps `params.input` through `V2UserInput::into_core`, submits the user input, and returns `TurnStartResponse { turn }` with an in-progress turn.
- `codex/codex-rs/app-server/src/message_processor.rs`
  - Dispatches `ClientRequest::ThreadResume` to `thread_processor.thread_resume`.
  - Dispatches `ClientRequest::TurnStart` to `turn_processor.turn_start`.
- `codex/codex-rs/app-server-protocol/src/protocol/common.rs`
  - Defines notification method names such as `turn/started`, `turn/completed`, `item/started`, `item/completed`, and delta notifications.
- `codex/codex-rs/app-server/src/bespoke_event_handling.rs`
  - Converts core turn events into app-server `ServerNotification` values.
  - `EventMsg::TurnStarted` emits `turn/started` with `{ threadId, turn }`.
  - `EventMsg::TurnComplete` emits `turn/completed` with `{ threadId, turn }`.
  - Item and delta events are mapped through `item_event_to_server_notification(...)`.
- `codex/codex-rs/app-server/tests/suite/v2/turn_start.rs`
  - Confirms `turn/start` returns a `TurnStartResponse`.
  - Confirms app-server then emits `turn/started` and `turn/completed` notifications whose payloads carry the same thread id and turn id.

Do not use legacy fields unless they are present in this source. For example, an older generated viewer protocol had `persistExtendedHistory` on `ThreadResumeParams`, but the checked-in `codex-rs` `ThreadResumeParams` no longer includes it. The Rust extension server should omit that field unless a compatibility test proves the active app-server requires it.

## Scope

In scope:

- Send a message to the currently selected existing thread.
- Resume the thread before sending if the app-server runtime has not loaded it.
- Start a turn through app-server `turn/start`.
- Return immediate resource invalidations from the send response.
- Listen to app-server notifications and coalesce them into resource invalidation notifications.
- Let the viewer react to invalidations by rereading transcript and thread resources.
- Preserve stable React keys and object identity for unchanged turns/rows.
- Keep the transcript visible during refreshes.

Out of scope:

- New chat creation through `thread/start`.
- Edit, fork, rollback, compact, or same-turn steer.
- Optimistic transcript insertion.
- Text-level delta rendering.
- Parsing app-server deltas into local transcript state.
- Approval, elicitation, or tool-request UI.
- Token usage and detailed runtime status.

## Server API

Add one viewer-facing command method:

```ts
method: "remux/codex/thread/message/send"
```

Request:

```ts
type CodexThreadMessageSendParams = {
  threadId: string;
  clientMessageId?: string | null;
  parts: CodexComposerMessagePart[];
};

type CodexComposerMessagePart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      dataUrl: string;
      mimeType?: string | null;
      name?: string | null;
    }
  | {
      type: "mention";
      name?: string | null;
      path: string;
    };
```

This is intentionally not Codex `TurnStartParams` and not generic app-server forwarding. It is a Remux composer command for an existing thread.

The viewer should send only what the composer owns:

```ts
{
  threadId,
  clientMessageId,
  parts,
}
```

The viewer should not send cwd, model, sandbox, approval policy, service tier, runtime roots, token state, or other thread/runtime configuration. Those are server-authoritative. If the composer needs to display cwd, token estimates, model, or send eligibility, add a server read resource for composer state later.

The `path` on a `mention` part is different: it is user-authored message content that identifies the mentioned file or directory. It is not the thread cwd and should not be used as runtime configuration.

The server maps `CodexComposerMessagePart[]` into Codex `UserInput[]` internally:

```ts
text    -> { type: "text", text, text_elements: [] }
image   -> { type: "image", url: dataUrl }
mention -> { type: "mention", name, path }
```

That mapping should be tested against the generated Codex protocol shape, but it should remain an implementation detail of the Rust server contract.

Response:

```ts
type CodexThreadMessageSendResponse = {
  threadId: string;
  turnId: string;
  status: "accepted";
  invalidations: CodexResourceInvalidation[];
};

type CodexResourceInvalidation =
  | {
      key: string;
      reason: "sendAccepted" | "appServerEvent";
      type: "threadHistory";
    }
  | {
      key: string;
      reason: "sendAccepted" | "appServerEvent";
      threadId: string;
      type: "threadSummary" | "threadTranscript";
    };
```

Initial invalidations after a successful send:

```text
threadHistory:updated_at:desc:50::false:
threadSummary:{threadId}
threadTranscript:{threadId}
```

The exact thread-history key can match the active history request shape. The client should also tolerate broader invalidations such as `type: "threadHistory"` without relying on a single key.

## Server Send Flow

Implement a focused server module, for example:

```text
extensions/codex/server/src/thread_commands.rs
```

Flow:

1. Validate `threadId` is non-empty.
2. Validate `parts` contains at least one meaningful text/image/mention part.
3. Map `parts` into Codex `UserInput[]`.
4. Ensure the thread is resumed in the app-server runtime.
5. Build app-server `turn/start` params from server-known state plus mapped input.
6. Call app-server `turn/start`.
7. Mark thread resources stale.
8. Return `accepted` plus immediate invalidations.

Thread resume:

```ts
method: "thread/resume"
params: {
  threadId,
  excludeTurns: true,
  ...resumeOptions
}
```

Grounding: `ThreadResumeParams` in `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` is `#[serde(rename_all = "camelCase")]`, so Rust JSON should use `threadId`, `excludeTurns`, `modelProvider`, `approvalPolicy`, etc.

Turn start:

```ts
method: "turn/start"
params: {
  threadId,
  clientUserMessageId: clientMessageId,
  input,
  // optional server-owned fields may be filled in here later
}
```

Grounding: `TurnStartParams` in `codex-rs/app-server-protocol/src/protocol/v2/turn.rs` is `#[serde(rename_all = "camelCase")]`. For this phase, the Rust extension server should build only the fields needed for existing-thread send:

```ts
{
  threadId,
  clientUserMessageId,
  input,
}
```

Do not add dormant Remux API fields just because Codex `TurnStartParams` supports them. When the server later owns composer resources for model, cwd, permissions, token estimates, runtime roots, or other settings, add those fields to the server-owned builder, not to the viewer send request by default.

`turn/start` returns:

```ts
type TurnStartResponse = {
  turn: Turn;
};
```

The Remux response should use `turn.id` as `turnId`, but should not expose the raw app-server response as the viewer contract.

The server should keep a small runtime registry:

```rust
struct LiveThreadRegistry {
    resumed_thread_ids: HashSet<String>,
}
```

Rules:

- Resume once per thread per Rust server process before the first send.
- If `turn/start` returns `thread not found: {thread_id}`, clear the registry entry, resume, and retry `turn/start` once.
- Do not return app-server's raw response to the viewer.
- Do not wait for the assistant turn to complete.
- Do not manufacture transcript turns in Rust; the transcript read path remains authoritative.
- Do not require the viewer to provide cwd or runtime config. Existing-thread `turn/start` can omit cwd and use the resumed thread's sticky runtime state.
- Keep the app-server params camelCase. The Rust extension server currently builds raw `serde_json::Value` params for `thread/list` and `thread/read`; use the same pattern until we generate or share Rust protocol types.

## Server Invalidation Bus

The current Rust stdio loop writes only request responses. Streaming invalidation notifications need one serialized output path.

Introduce an output sink:

```rust
enum ServerOutput {
    Response(JsonRpcResponse),
    Notification(JsonRpcNotification),
}
```

One writer owns stdout and serializes every output line. Request handlers send responses into this writer. App-server event handling sends notifications into the same writer. This avoids concurrent writes from the request thread and app-server reader thread.

Notification method:

```ts
method: "remux/codex/resources/invalidated"
```

Params:

```ts
type CodexResourcesInvalidatedParams = {
  batchId: number;
  emittedAt: number;
  invalidations: CodexResourceInvalidation[];
};
```

Event routing:

- `AppServerRuntime` already routes app-server notifications to `AppServerEventSink`.
- Add an invalidation aggregator that receives those events.
- Parse notification method names from the local Codex protocol mapping in `codex-rs/app-server-protocol/src/protocol/common.rs`.
- If a notification has `params.threadId`, invalidate that thread.
- If a notification has `params.thread.id`, invalidate that thread.
- If a notification has `params.turn.id` plus `params.threadId`, retain the turn id for future finer-grained invalidations, but emit only thread-level invalidations in this phase.
- If a notification is thread-list relevant, invalidate thread history.
- Coalesce invalidations for about 100-250 ms.
- Deduplicate by invalidation key before emitting.

Thread-list relevant app-server notifications for this phase:

```text
thread/started
thread/status/changed
thread/archived
thread/deleted
thread/unarchived
thread/closed
thread/name/updated
thread/goal/updated
thread/goal/cleared
thread/settings/updated
thread/tokenUsage/updated
turn/started
turn/completed
```

Transcript-relevant app-server notifications for this phase:

```text
turn/started
turn/completed
turn/diff/updated
turn/plan/updated
item/started
item/completed
rawResponseItem/completed
item/agentMessage/delta
item/plan/delta
item/commandExecution/outputDelta
item/commandExecution/terminalInteraction
item/fileChange/outputDelta
item/fileChange/patchUpdated
item/mcpToolCall/progress
item/reasoning/summaryTextDelta
item/reasoning/summaryPartAdded
item/reasoning/textDelta
thread/compacted
model/rerouted
turn/moderationMetadata
warning
guardianWarning
error
```

For `warning`, `guardianWarning`, and `error`, only invalidate transcript resources if the payload carries `threadId`; otherwise ignore for transcript refresh and handle later as UI status/toast scope.

For this phase, invalidation granularity can stay at:

```text
threadHistory
threadSummary:{threadId}
threadTranscript:{threadId}
```

Later, the same bus can emit:

```text
turn:{threadId}:{turnId}
workDetails:{threadId}:{turnId}:{segmentId}
```

Do not parse app-server text deltas into React state in this pass.

## Viewer Send Flow

Add a small IPC wrapper:

```text
extensions/codex/viewer/ipc/threadCommands.ts
```

```ts
export const threadMessageSendMethod = "remux/codex/thread/message/send";

export function sendThreadMessage(params: CodexThreadMessageSendParams) {
  return requestIpc<CodexThreadMessageSendResponse>(threadMessageSendMethod, params);
}
```

Composer flow:

1. Current thread is selected in `useThreadsStore`.
2. Composer submit builds `CodexComposerMessagePart[]` from the current composer snapshot.
3. If projection is valid, build `CodexThreadMessageSendParams`.
4. Include `threadId` from `useThreadsStore((state) => state.activeThreadId)`.
5. Include `clientMessageId` if the composer has one; otherwise let the server generate one later if useful.
6. Do not include cwd/model/sandbox/config fields.
7. Call `sendThreadMessage`.
8. Keep a local composer `sending` state so the button can show progress.
9. On accepted response, clear the composer.
10. Pass returned invalidations into the resource cache invalidation path.

Do not insert an optimistic user message into the transcript store. The transcript should update only when the read API returns the new resource revisions.

## Viewer Invalidation Handling

Use the existing IPC event channel through `subscribeIpcEvents`.

Add a small client-side invalidation dispatcher:

```text
extensions/codex/viewer/resources/invalidation.ts
```

Responsibilities:

- Subscribe once to IPC events.
- Filter `remux/codex/resources/invalidated`.
- Batch invalidations in a microtask or animation frame.
- Forward invalidations into the relevant resource caches.
- Let each cache decide whether to reread now, dedupe with an in-flight read, or ignore because the resource is not active.

Store additions:

```ts
type TranscriptStoreState = {
  invalidateTranscriptResources: (invalidations: CodexResourceInvalidation[]) => Promise<void>;
};

type ThreadHistoryStoreState = {
  invalidateThreadResources: (invalidations: CodexResourceInvalidation[]) => Promise<void>;
};
```

The dispatcher should not directly manipulate renderer state. It should only tell caches that server-owned resources are stale. The caches then use the same read/reconcile path as initial loading.

The transcript cache should check the active thread before rereading transcript resources. If an invalidation is for a non-active thread, the transcript cache should ignore it and the thread cache can refresh history/summary.

This is the smoothness contract: invalidation triggers the same state change path as a normal cache read. The cache reads server resources, reconciles by key/revision, preserves unchanged object references, and commits one snapshot update. React components then rerender only when their selected cache slice actually changed.

## No-Flash Transcript Cache Invalidation

Invalidation must not mean clearing state.

Current initial load can set `status: "loading"` and empty the transcript because the user is switching threads. Invalidation after send is different: the user is already looking at a transcript.

Add a separate cache invalidation path:

```ts
invalidateTranscriptResources(invalidations)
```

Rules:

- If there is no active thread or no width, do nothing.
- Keep `status: "ready"` while the refresh is in flight.
- Optionally track `isRefreshing` separately, but do not let the virtualizer render `Loading transcript`.
- Read `threadTranscript` with `knownRevision`.
- If `notModified`, do nothing.
- For changed thread order, read only missing or stale turns with each turn's `knownRevision`.
- Preserve the previous `turnResourcesById[turnId]` object for unchanged turns.
- Preserve previous measured rows for unchanged turn layout revisions.
- Call `commitMeasuredTranscript` with `dirtyTurnIds`, not `forceFullMeasure`, whenever possible.
- Keep `disclosure.openWork` if the expanded row still exists.
- Keep `workDetailsByKey` unless the owning turn/segment disappeared.

This avoids flicker because:

- The transcript array is not cleared.
- Existing turn ids remain React keys.
- Existing row ids remain React keys.
- Memoized `TranscriptTurn` and `TranscriptRow` components keep the same props for unchanged rows.
- The virtualizer only sees spacer/height changes for new or changed turns.

The only visible movement should be expected transcript growth near the bottom. If the user is at the bottom or near the working turn, auto-scroll can follow. If the user has scrolled up, the existing virtualizer should keep auto-scroll off.

## No-Flash Thread History Cache Invalidation

Thread history invalidation should also avoid clearing state.

Rules:

- If history is already ready, do not set `status: "loading"` during invalidation refresh.
- Use `knownRevision`.
- On `notModified`, do nothing.
- Merge returned summaries into `threadsById`.
- Preserve existing summary object identity when fields did not change.
- Replace `threadOrder` only when order actually changed.
- Keep draft selection state in `viewer/threads/store.ts` separate.

Sidebar updates are less sensitive than transcript updates, but preserving identity keeps renders focused.

## Rerender Model

The viewer should rerender by subscription granularity, not DOM manipulation.

Use React state/external-store updates:

- The invalidation dispatcher marks transcript/history cache resources stale.
- The caches reread and reconcile server resources.
- Store selectors compare selected slices.
- `TranscriptTurn` is keyed by `turnId`.
- `TranscriptRow` is keyed by row id.
- Unchanged turns retain the same measured row array reference.
- Work details are selected per row by key.

Avoid:

- Replacing every turn object after every refresh.
- Rebuilding all measured rows when only one turn changed.
- Setting `status: "loading"` during refresh.
- Clearing `turnOrder`, `turnResourcesById`, or `turnsById` while a refresh is pending.
- Direct DOM manipulation to swap transcript rows.

This is the answer to the flicker concern: flicker happens when the app clears data, remounts keyed components, or swaps stable object references unnecessarily. With reconciliation by resource revision, unchanged components do not update.

## Backend Tests

Add focused Rust tests around command sequencing and invalidation routing.

Recommended tests:

- Send rejects empty `threadId`.
- Send rejects empty `parts`.
- Send maps text/image/mention parts into Codex `UserInput[]`.
- Send resumes a thread before first `turn/start`.
- Send does not resume again for a known live thread.
- Send retries resume once if `turn/start` reports an unloaded thread.
- Send response includes thread history, thread summary, and thread transcript invalidations.
- App-server notifications with a thread id produce coalesced invalidation notifications.
- Pending app-server requests still receive responses while notifications are being routed.

The command sequencing tests can use a small fake app-server RPC trait. The real transcript/read correctness tests should continue using real Codex transcript data.

## Viewer Tests

Add tests for the read/reconcile behavior rather than full app-server streaming.

Recommended tests:

- Composer projection sends Remux message parts to `remux/codex/thread/message/send`.
- Composer send does not include cwd/model/sandbox/config fields.
- Accepted send clears composer and triggers invalidation handling.
- Transcript refresh keeps existing turns visible while the read is pending.
- `notModified` refresh does not rerender measured turns.
- Appending a new turn does not remount unchanged previous turns.
- Expanded work state survives refresh when the row still exists.
- Expanded work state closes when the owning row disappears.
- Thread history invalidation refreshes summaries without clearing sidebar rows.

## Manual Validation

Use the current real Codex data path:

1. Open a known existing thread from the sidebar.
2. Send a short message from the composer.
3. Verify the composer enters and leaves sending state.
4. Verify the transcript does not flash to `Loading transcript`.
5. Verify the new user message appears after resource reread.
6. Verify the assistant turn appears as in progress once Codex writes it.
7. Verify previous turns do not remount or lose expanded work state.
8. Verify sidebar history moves/updates the active thread without blanking.

For debugging, log invalidation batches with:

```text
batchId
invalidation keys
read request keys
changed resource revisions
dirty turn ids
```

## Implementation Order

1. Add shared TypeScript types for send params/response/invalidation.
2. Add Rust `thread_commands` module with `remux/codex/thread/message/send`.
3. Add a small live-thread registry around app-server `thread/resume`.
4. Route successful send to app-server `turn/start`.
5. Return immediate invalidations from the send response.
6. Refactor Rust stdout writing through a single output sink.
7. Wire `AppServerEventSink` into a coalescing invalidation aggregator.
8. Emit `remux/codex/resources/invalidated` notifications.
9. Add viewer `threadCommands.ts`.
10. Add viewer invalidation dispatcher.
11. Add transcript cache invalidation that does not clear ready state.
12. Add thread history cache invalidation that does not clear ready state.
13. Wire composer submit for active existing threads.
14. Add focused tests and run manual validation.

## Later Extensions

Once current-thread send works without flicker, extend the same shape to:

- New chat via `thread/start`.
- Edit/fork/rollback commands.
- More precise `turn` and `workDetails` invalidations.
- Text-delta streaming as a server-side resource update optimization.
- Approval and elicitation request routing.
- Token usage and runtime status resources.
