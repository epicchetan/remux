# Codex Pending Queue Cleanup Spec

Status: Implemented
Last verified: 2026-07-10
Canonical code: `extensions/codex/server/src/operation_queue.rs`, `extensions/codex/server/src/main.rs`, `extensions/codex/viewer/composer/queue/OperationQueueTray.tsx`, `extensions/codex/viewer/composer/actions/turnAction.ts`

## Summary

Replace the durable operation queue with a deliberately small, process-memory pending queue.

The queue has one job:

> When a Codex turn is already active, retain follow-up messages or a requested compaction and start the next entry after that turn completes.

An idle message or compaction is not queued. It goes directly to Codex. As soon as Codex accepts a pending entry through `turn/start`, `turn/steer`, or `thread/compact/start`, that entry leaves Remux queue ownership. The Codex runtime and transcript are authoritative after acceptance.

The simplified queue supports only:

- append a pending message while a turn is active;
- append a pending compaction while a turn is active or another entry is pending;
- delete an entry that has not been sent;
- Send now, which attempts `turn/steer`;
- automatically start the next pending message or compaction after successful turn completion;
- cancel all pending entries when the user interrupts, the turn fails, or the extension server restarts.

This is intentionally fragile. It does not persist or recover prompts.

## Why the Current Design Is Wrong

The current implementation models queue entries as durable operations with states such as `starting`, `running`, `failed`, and `heldForEdit`. That creates two incorrect behaviors:

1. An ordinary idle send enters the queue state machine before `turn/start`, so app-server notification races can make the current Codex-owned message appear in queue UI.
2. Interrupting Codex completes or fails a queue-owned operation, so a simple Stop action can leave the queue paused in an error state.

Both are consequences of treating accepted Codex work as Remux queue state.

The cleanup changes the ownership boundary:

```text
Remux owns only messages and compactions that have not been sent.

turn/start accepted ──> remove from pending queue
turn/steer accepted ──> remove from pending queue
compact/start accepted > remove from pending queue
                       Codex runtime + transcript own everything after this point
```

## Product Rules

1. The queue contains only pending messages and pending compactions. It is not a generic operation engine.
2. If the thread is idle, Send calls `turn/start` directly and never inserts a queue entry.
3. If the thread is running or stopping, Send appends a pending message.
4. If the thread is idle and no entry is pending, Compact calls `thread/compact/start` directly.
5. If a turn is active or another entry is pending, Compact appends one pending compaction.
6. Pending messages and compactions share one FIFO order.
7. A pending entry disappears before or immediately when its Codex request is issued. It never has a visible running state.
8. A successful `turn/steer` removes that pending message.
9. Stop/interrupt clears every pending entry for that thread.
10. Failed or interrupted turns clear every pending entry for that thread.
11. App-server disconnect or thread system error clears every pending entry for that thread.
12. Extension-server restart loses all pending entries.
13. WebView reload and thread switching may preserve pending entries as long as the extension server process remains alive.
14. Pending entries can be deleted. Pending messages can additionally be sent now. Entries cannot be edited, retried, paused, resumed, or reordered.
15. Historical edit and fork are disabled while the thread has pending entries.

## State Model

Keep the queue entirely in Rust process memory:

```rust
struct PendingQueueStore {
    threads: Mutex<HashMap<String, ThreadPendingQueue>>,
}

struct ThreadPendingQueue {
    revision: u64,
    entries: VecDeque<PendingQueueEntry>,
}

enum PendingQueueEntry {
    Message {
        client_message_id: String,
        created_at: u64,
        id: String,
        parts: Vec<ComposerMessagePart>,
        preview: PendingMessagePreview,
    },
    Compact {
        created_at: u64,
        id: String,
    },
}
```

There is no queue mode and no operation state enum.

Remove:

- `pending`, `starting`, `running`, `failed`, and `heldForEdit` states;
- attempt IDs;
- compaction lifecycle state after `thread/compact/start` accepts the request;
- payload files and queue index files;
- crash reconciliation;
- retry, skip, pause, resume, reorder, and queued-message edit state;
- queue-owned turn IDs and compaction item IDs.

## Ownership and Dispatch

### Submit a message

Use one server command for an existing-thread send. The server, rather than the viewer, makes the final runtime decision.

```text
submit(thread, message)
  if authoritative runtime is idle:
    call turn/start directly
    return delivery = sent and turnId

  if authoritative runtime is running or stopping:
    append message to process-memory queue
    return delivery = queued
```

Suggested response:

```ts
type CodexThreadMessageSubmitResponse = {
  delivery: 'queued' | 'sent';
  invalidations: CodexResourceInvalidation[];
  status: 'accepted';
  threadId: string;
  turnId?: string;
};
```

Do not route an idle send through enqueue followed by drive. That intermediate insertion is what allows the current message to flash or remain as queued.

### Natural completion

On `turn/completed`:

- `completed`: attempt to dispatch the next pending entry;
- `interrupted` or `failed`: clear the queue;
- no pending entries: do nothing.

Dispatch is destructive and intentionally fragile:

1. Pop the first pending entry from memory.
2. Emit a queue invalidation so it disappears from the tray.
3. For a message, call `turn/start`. For a compaction, call `thread/compact/start`.
4. If accepted, Codex owns the message or compaction lifecycle.
5. If the request fails, clear the remaining queue and surface the normal command/runtime error. Do not create a retry state.

Popping before the request ensures an app-server event cannot render newly accepted work as a pending queue entry. After a compaction is accepted, the authoritative runtime blocks later pending entries until the compaction turn completes.

### Request compaction

The existing `thread/compact` command makes the same server-side direct-versus-pending decision as message submission:

```text
compact(thread)
  if authoritative runtime is idle and pending queue is empty:
    call thread/compact/start directly
    return delivery = sent

  otherwise:
    append one compact entry
    return delivery = queued
```

A compact entry exposes Delete but not Send now. Once `thread/compact/start` accepts it, the entry disappears and Codex runtime becomes authoritative.

### Interrupt

When `remux/codex/thread/turn/interrupt` is invoked:

1. Clear the thread's pending queue immediately.
2. Emit the queue invalidation.
3. Send `turn/interrupt` to Codex.

Also clear defensively when an interrupted terminal notification arrives. Clearing twice is harmless.

There is no paused or error queue UI after Stop.

### Send now

For one pending message:

1. Read the authoritative active turn ID.
2. Call `turn/steer` with that ID as `expectedTurnId`.
3. Remove the pending message only after steer succeeds.
4. If steer fails because the turn ended or is not steerable, retain the message. The normal completion path will send it as the next turn.

Send now does not create `starting`, `running`, `retained`, or failed queue states.

### Race handling

Only minimal race handling is needed:

- After appending a message or compaction, call `drive_if_idle(threadId)`. If completion raced with the append, the entry starts immediately.
- Before automatic dispatch, recheck that the runtime is idle.
- Serialize queue mutations per thread with the store mutex.
- Never hold the queue mutex while calling app-server.
- If two viewers submit concurrently, append them in server arrival order.

No disk journal, attempt record, lifecycle cache, or recovery protocol is required.

## Queue Resource

Expose only pending entries:

```ts
type CodexPendingQueueEntry =
  | {
      createdAt: number;
      id: string;
      kind: 'message';
      preview: {
        attachmentCount: number;
        mentionCount: number;
        text: string;
      };
    }
  | {
      createdAt: number;
      id: string;
      kind: 'compact';
    };

type CodexPendingQueueResource = {
  entries: CodexPendingQueueEntry[];
  revision: string;
  threadId: string;
};
```

The resource never includes:

- the active/current user message;
- Codex turn IDs;
- delivery or failure states;
- image data URLs;
- blockers or queue mode.

Full structured message parts stay only in Rust memory until sent or discarded. Compact entries contain no additional payload.

## IPC Cleanup

Keep:

| Method | Purpose |
| --- | --- |
| `remux/codex/thread/message/send` | Server decides direct send versus append pending message |
| `remux/codex/thread/queue/remove` | Delete an unsent pending message |
| `remux/codex/thread/queue/run-now` | Attempt to steer an unsent pending message |
| `remux/codex/thread/resources/read` | Read the lightweight pending-entry queue resource |

Remove:

- `queue/enqueue` as a public viewer decision;
- `queue/reorder`;
- `queue/pause` and `queue/resume`;
- `queue/retry` and `queue/skip`;
- all `queue/message/edit/*` commands;
- the generic operation-draft union and all compaction lifecycle states.

The existing `thread/compact` command decides direct versus queued on the server. It does not use a generic enqueue command.

## UI Cleanup

The queue strip renders only when `entries.length > 0`. An active Codex turn by itself never causes the strip to render.

The active-turn action row is independent from queue visibility:

- While a turn is running with an empty composer, show Stop only.
- Once the composer has sendable content, keep Stop and add the Send/Queue message icon to its right.
- While an interrupt is already stopping the turn, show the stopping control and do not accept a new queued send until runtime settles.
- Do not reserve a disabled Send icon while the composer is empty.
- The send icon queues only because a turn is active; it does not make the queue strip appear until the server confirms a genuinely pending entry.

Collapsed form:

```text
Queued 2   Next follow-up message…                         Expand
```

Expanded rows expose only:

```text
1  Next follow-up message…                      Send now  Delete
2  Compact context                                        Delete
3  Check the tests after that…                  Send now  Delete
```

Remove from queue UI:

- pause/resume button;
- state labels such as Waiting, Starting, Working, Failed, and Editing;
- retry and skip;
- move up/down;
- queued-message edit;
- active operation count or current-turn representation;
- queue errors after interrupt.

Keep the compact context-strip presentation above the composer. Historical edit and fork use the same strip geometry, but their transcript buttons are disabled whenever pending entries exist.

## Notification Behavior

Completion notification behavior can remain simple:

- If a successful completion immediately dispatches another pending message, suppress that intermediate completion notification.
- If completion empties no queue or the queue was cancelled, emit the ordinary notification.
- A failed automatic `turn/start` may emit the normal error notification; no queue-specific error notification is required.

## Migration and Cleanup

The cleanup deliberately abandons the current durable queue.

On first startup of the simplified implementation:

1. Ignore and remove `${CODEX_HOME}/remux/operation-queue/index.json`.
2. Remove `${CODEX_HOME}/remux/operation-queue/messages/`.
3. Do not attempt to replay, recover, or present those entries.
4. Stop creating the operation-queue directory afterward.

This prevents stale `running` or failed entries from continuing to appear after the cleanup lands.

## Implementation Pass

### Server

1. Replace `OperationQueueStore` persistence with `PendingQueueStore` in memory.
2. Replace generic operation states with the `message | compact` pending-entry union.
3. Change existing-thread send to choose direct versus queued on the server.
4. Pop a pending entry before automatic `turn/start` or `thread/compact/start`.
5. Clear pending entries on interrupt, failed/interrupted completion, error, and disconnect.
6. Keep only remove and message Send now mutations.
7. Change compact to the same server-owned direct-versus-pending decision.
8. Delete legacy queue storage at startup.

### Viewer

1. Send existing-thread messages through `thread/message/send` again.
2. Interpret `delivery: sent | queued`.
3. Replace the operation queue store with the pending-entry resource.
4. Simplify the tray to disclosure, Send now, and Delete.
5. Remove queued-message edit integration from the composer store and edit bar.
6. Remove pause, retry, skip, reorder, queued-message editing, and operation-state rendering. Keep compact as a simple pending entry.
7. Keep edit/fork disabled while pending entries exist.

### Tests

Add focused coverage for:

1. Idle submit calls `turn/start` directly and the queue resource stays empty.
2. Active submit appends one pending message.
3. Compact while active appends one pending compaction.
4. Successful completion pops and starts exactly one next entry.
5. Accepted messages and compactions are absent from the queue before app-server lifecycle notifications arrive.
6. `message -> compact -> message` executes FIFO across successful completions.
7. Interrupt clears every pending entry without an error state.
8. Failed/interrupted completion clears every pending entry.
9. Delete removes only the selected unsent entry.
10. Send now removes a message on successful steer and retains it on steer failure.
11. Extension-server restart produces an empty queue.
12. Edit and fork are disabled while pending entries exist.
13. Legacy durable queue files are deleted and never rendered.

## Acceptance Criteria

The cleanup is complete when:

1. Sending while idle never displays `Queued`.
2. Sending while a turn is active displays only the genuinely pending follow-up messages.
3. Once Codex accepts a message, it disappears from Remux queue state immediately.
4. A compaction requested during active work appears as pending, starts in FIFO order, and disappears once Codex accepts it.
5. Stop clears the queue and never leaves a failed, paused, or retry state.
6. Pending messages expose Delete and Send now; pending compactions expose Delete only.
7. Messages and compactions execute FIFO after successful completions.
8. Pending entries are lost on extension-server restart by design.
9. With no pending entries, no queue strip or queue placeholder is rendered.
10. While working, Stop is always shown and Send appears only after the composer becomes sendable.
11. Queue refreshes remain isolated from transcript and PreText measurement state.
12. Full Rust tests, desktop/mobile Playwright tests, typecheck, viewer build, and `git diff --check` pass.
