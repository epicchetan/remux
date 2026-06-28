# Codex Thread History Read Spec

## Purpose

Extend the Rust Codex extension server with server-authoritative thread history reads.

The viewer should keep treating the extension server as authoritative for thread metadata. It should not know whether thread history came from the Codex SQLite state DB, JSONL repair scanning, app-server runtime state, or a later invalidation path.

This phase is only about reading thread history and selected thread summaries. It does not restore message send, thread start, resume, fork, compact, filesystem, directory picker, or fuzzy search behavior.

## Current State

The Rust server currently handles only:

- `remux/codex/transcript/resources/read`
- direct Codex JSONL discovery
- transcript order, turn, and work-details projection

It does not start or connect to Codex app-server.

The previous Node server did start app-server:

```text
codex app-server --listen ws://127.0.0.1:48124
```

It then forwarded most requests to app-server over WebSocket. That gave the viewer access to `thread/list`, `thread/read`, `thread/start`, `turn/start`, and related methods, but leaked app-server as the practical client boundary.

The viewer transcript path is now on the new read API, but thread history is still legacy:

- `viewer/threads/store.ts` uses Zustand.
- It calls `thread/list`, `thread/read`, and `thread/resume` through `viewer/ipc/threads.ts`.
- It subscribes to app-server events and mutates local thread records.
- Sidebar rendering is still backed by this legacy thread store.
- Directory picker, draft state, composer cwd, and mention/file search wiring still exist.

## Target Shape

Keep a single viewer-facing authority:

```text
viewer
  -> Remux Codex Rust server API
      -> direct JSONL projection for transcript resources
      -> Codex app-server for thread history reads
```

Avoid exposing generic app-server passthrough as the primary viewer API:

```text
viewer
  -> arbitrary app-server JSON-RPC forwarding
```

The Rust server can call app-server internally, parse the result, normalize it, cache it, and return Remux resource responses.

## App-Server Management

Codex app-server supports:

```text
stdio://
ws://IP:PORT
unix://
unix://PATH
off
```

Use Unix control socket transport for this extension.

Default socket:

```text
~/.codex/app-server-control/app-server-control.sock
```

`unix://` still uses WebSocket framing over a Unix domain socket. The Rust server should either use Codex's app-server client crates directly or mirror their transport behavior closely.

Preferred startup strategy:

1. On Rust server startup, compute the default Codex home.
2. Try to connect to the default app-server Unix control socket.
3. If connection succeeds, initialize and mark the app-server as externally owned.
4. If connection fails because there is no active server, spawn:

   ```bash
   codex app-server --listen unix://
   ```

5. Wait for the socket to become connectable.
6. Connect and initialize.
7. If the Rust extension server spawned the app-server, terminate it on shutdown.
8. If the app-server was already running, leave it running on shutdown.

Do not use the old fixed TCP port.

## Server API

Keep the transcript read method unchanged:

```ts
method: "remux/codex/transcript/resources/read"
```

Add a thread history read method:

```ts
method: "remux/codex/thread/resources/read"
```

Request:

```ts
type CodexThreadResourcesReadParams = {
  requests: CodexThreadResourceRequest[];
};

type CodexThreadResourceRequest =
  | {
      type: "threadHistory";
      knownRevision?: string;
      cursor?: string | null;
      limit?: number | null;
      sortKey?: "created_at" | "updated_at" | "recency_at" | null;
      sortDirection?: "asc" | "desc" | null;
      archived?: boolean | null;
      searchTerm?: string | null;
    }
  | {
      type: "threadSummary";
      threadId: string;
      knownRevision?: string;
    };
```

Response follows the existing resource envelope:

```ts
type CodexThreadResourcesReadResponse = {
  resources: CodexThreadResourceResult[];
};

type CodexThreadResourceResult = {
  requestIndex: number;
  key: string;
  status: "ok" | "notModified" | "missing" | "error";
  revision?: string;
  value?: unknown;
  reason?: string;
};
```

Resource keys:

```text
threadHistory:{sortKey}:{sortDirection}:{limit}:{cursor}:{archived}:{searchTerm}
threadSummary:{threadId}
```

Thread history value:

```ts
type CodexThreadHistoryResource = {
  revision: string;
  threads: CodexThreadSummary[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};
```

Thread summary value:

```ts
type CodexThreadSummaryResource = {
  revision: string;
  thread: CodexThreadSummary;
};
```

Summary shape should be viewer-focused and should not include turns:

```ts
type CodexThreadSummary = {
  id: string;
  sessionId: string | null;
  title: string;
  preview: string;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
  status: unknown;
  archived: boolean;
  path: string | null;
  source: unknown;
  modelProvider: string | null;
  name: string | null;
};
```

The server should derive these summaries from app-server `thread/list` and `thread/read` responses, stripping `turns`.

## Why App-Server Owns Thread History

Do not implement thread-list scanning directly in the extension server.

Codex app-server already handles:

- SQLite state DB reads.
- JSONL repair scans.
- Pagination cursors.
- Source/provider/cwd/archive/search filters.
- Loaded runtime status overlays.
- Thread metadata evolution.

Duplicating this in the extension server would force us to mirror `codex-rs/rollout` and app-server thread processor behavior.

Transcript projection remains direct because the viewer needs a specialized read path with stable turn, segment, and work-detail resources for virtualization.

## Server State

The Rust server should own:

- app-server process ownership state
- app-server connection state
- pending app-server requests
- latest thread history resources by key/revision

The client should own:

- selected thread id
- selected draft id
- local draft composer snapshot
- sidebar open state
- transcript viewport/disclosure/measurement state

The client should not own authoritative thread metadata.

## Viewer Thread Store Rewrite

Replace the thread store's data source with the new read API.

Split thread state by ownership:

```text
server-backed thread history
  -> custom external store, like transcript

local draft/new-chat UI state
  -> local UI store, Zustand is acceptable
```

The server-backed thread history store should mirror the thread resource API by key and revision. It should use `useSyncExternalStore` or the same selector-subscription pattern as the transcript store so sidebar rows only rerender when the relevant resource changes.

Keep local UI state separate:

- `activeThreadId`
- `activeDraftId`
- `draft`
- `directoryPickerOpen`
- `directoryPickerPath`

Move server-backed history to a custom resource cache:

```ts
type ThreadHistoryResourceSnapshot = {
  status: "idle" | "loading" | "ready" | "failed";
  error: string | null;
  historyRevision: string | null;
  threadOrder: string[];
  threadsById: Record<string, CodexThreadSummary>;
  nextCursor: string | null;
  backwardsCursor: string | null;
};
```

Public history-resource actions:

```ts
loadThreadHistory(): Promise<void>
ensureThreadSummary(threadId: string): Promise<void>
```

Public local thread UI actions:

```ts
selectThread(threadId: string): void
selectDraft(): void
startNewChat(input?: StartNewChatInput | string): void
discardDraft(): void
saveActiveDraftSnapshot(snapshot: ComposerSnapshot): void
```

Remove from the thread store:

- app-server event subscription
- `applyServerEvents`
- local mutation of thread records from app-server notifications
- `ensureThreadResumed` during selection
- `readThread` during selection
- `replaceThreads`
- `upsertThread`
- direct dependency on generated app-server `Thread` as the store's internal type

The current `viewer/threads/store.ts` should be reworked rather than incrementally patched. It can either become the local draft/selection store after server-backed history is moved out, or it can be replaced by two files:

```text
viewer/threads/historyStore.ts
viewer/threads/draftStore.ts
```

Preferred split:

- `historyStore.ts`: custom external store for thread resources.
- `draftStore.ts`: Zustand store for draft/new-chat/sidebar-adjacent UI state.

Thread selection should become a local navigation/UI transition:

```text
selectThread(threadId)
  -> activeThreadId = threadId
  -> activeDraftId = null
  -> transcript component receives threadId
  -> transcript store reads transcript resources
```

If a selected thread is not present in the current history page, the store can either keep the selection or request `threadSummary` later. Do not force a resume/read just to select.

## Sidebar

`CodexSidebar` should render from `CodexThreadSummary`.

Keep:

- current row layout
- active thread highlighting
- draft row
- new-chat button

Remove assumptions that thread records contain app-server `turns`.

## Composer And Directory Features

Composer correctness remains out of scope.

Allowed temporary behavior:

- Send/edit/fork/compact can remain disabled or fail.
- Directory picker and file/mention search can fail.
- Existing wiring for reading directories/files does not need to be fixed in this phase.

Do not add transcript or thread-store compatibility shims solely for composer.

## Dead Code Removal

Remove client code that exists only for the old thread event model:

- `viewer/threads/serverEvents.ts`
- event application helpers in `viewer/threads/store.ts`
- app-server thread subscription usage from thread store
- unused thread IPC wrappers once their callers are gone

Keep generated app-server protocol files. They are shared generated artifacts and may still be used server-side or for typed action params later.

Do not remove composer/directory files just because their calls can fail. Remove only dead code that is no longer referenced after the thread-store rewrite.

## Implementation Order

1. Add shared thread resource types next to transcript shared types.
2. Add Rust app-server manager:
   - connect default Unix socket
   - spawn `codex app-server --listen unix://` if needed
   - initialize connection
   - track whether process is owned
3. Add app-server request helper in Rust.
4. Add `remux/codex/thread/resources/read`.
5. Implement `threadHistory` using app-server `thread/list`.
6. Implement `threadSummary` using app-server `thread/read` with `includeTurns: false`.
7. Add server tests with mocked app-server responses where practical.
8. Add manual validation against real Codex app-server.
9. Replace viewer thread IPC with thread resource reads.
10. Move server-backed thread history into a custom external store.
11. Keep draft/new-chat state in a separate local store, using Zustand if that remains simplest.
12. Rewire sidebar to use `CodexThreadSummary`.
13. Remove old thread event dead code.
14. Run typecheck and frontend build.
15. Run Rust tests.

## Validation

Server validation:

- Rust tests pass.
- `threadHistory` returns recent threads with no `turns`.
- `knownRevision` returns `notModified`.
- `threadSummary` returns one selected thread summary.
- App-server spawned by the Rust server exits when owned by the Rust server.
- Existing app-server is not killed when the Rust server exits.

Viewer validation:

- App opens and shows thread history.
- Selecting a thread loads transcript via the transcript read API.
- Opening a new-chat route does not block thread history loading.
- Sidebar rows render title, cwd, and relative timestamp.
- Composer may remain disabled or partially failing.
- Directory/file search failures do not break transcript/thread history rendering.

## Success Criteria

This phase is complete when:

- Thread history no longer depends on old app-server passthrough in the viewer.
- Viewer thread metadata comes from Rust-server resources.
- Transcript remains direct read API based.
- Rust server manages or connects to Codex app-server internally.
- Dead thread-event code is removed.
- Frontend builds and runs with transcript plus thread history.
