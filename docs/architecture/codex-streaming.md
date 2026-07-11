# Codex App Server, Remux Backend, and Viewer Streaming Current State

Status: Current
Last verified: 2026-06-28
Canonical code: `extensions/codex/server/src/main.rs`, `extensions/codex/server/src/app_server.rs`, `extensions/codex/server/src/live_transcript.rs`, `extensions/codex/viewer/transcript/resourceStore.ts`

## Purpose

This document describes how the Codex app-server, the Remux Rust extension backend, and the Codex viewer store currently fit together.

It is a current-state walkthrough, not an implementation proposal. The goal is to make the read path and notification path understandable enough to reason about streaming behavior, compaction rendering, and duplicated work detail rows.

The central point is that the viewer is not applying transcript deltas directly. The current system is read-oriented:

1. Codex app-server emits notifications while a thread/turn is running.
2. The Rust extension records a small in-memory overlay from selected notifications.
3. The Rust extension emits Remux resource invalidations.
4. The viewer responds by rereading resources with known revisions.
5. The Rust transcript server answers those reads from disk-projected Codex history plus the live overlay.

## Source Map

Primary Remux files:

- `extensions/codex/server/src/main.rs`
- `extensions/codex/server/src/app_server.rs`
- `extensions/codex/server/src/thread_commands.rs`
- `extensions/codex/server/src/thread_resources.rs`
- `extensions/codex/server/src/resources/mod.rs`
- `extensions/codex/server/src/history/mod.rs`
- `extensions/codex/server/src/projection/mod.rs`
- `extensions/codex/server/src/projection/items.rs`
- `extensions/codex/server/src/projection/work.rs`
- `extensions/codex/server/src/projection/segments.rs`
- `extensions/codex/server/src/live_transcript.rs`
- `extensions/codex/server/src/resource_invalidations.rs`
- `extensions/codex/server/src/thread_runtime.rs`
- `extensions/codex/shared/transcript.ts`
- `extensions/codex/shared/threadCommands.ts`
- `extensions/codex/viewer/ipc/client.ts`
- `extensions/codex/viewer/ipc/resourceInvalidations.ts`
- `extensions/codex/viewer/transcript/resourceStore.ts`
- `extensions/codex/viewer/transcript/layoutStore.ts`
- `extensions/codex/viewer/transcript/components/work/WorkSection.tsx`

Primary Codex source files:

- `codex/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs`
- `codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
- `codex/codex-rs/app-server/src/request_processors/thread_processor.rs`
- `codex/codex-rs/app-server/src/request_processors/turn_processor.rs`
- `codex/codex-rs/app-server/src/bespoke_event_handling.rs`
- `codex/codex-rs/app-server/src/thread_state.rs`
- `codex/codex-rs/app-server-protocol/src/protocol/thread_history.rs`
- `codex/codex-rs/protocol/src/items.rs`

## High-Level Data Flow

There are two related but distinct data paths.

Request/response reads:

```text
Viewer store
  -> viewer IPC client
  -> React Native WebView bridge
  -> Remux host request
  -> CLI extension process
  -> Rust extension stdio JSON-RPC
  -> Rust resource reader
  -> response back along the same path
```

Notification-driven invalidation:

```text
Codex app-server notification
  -> Rust AppServerRuntime reader
  -> LiveTranscriptStore and ThreadRuntimeStore
  -> resource invalidation notification
  -> Rust stdout JSON-RPC notification
  -> CLI broadcast
  -> React Native WebView event
  -> viewer event queue
  -> viewer invalidation handlers
  -> viewer rereads resources
```

This means the viewer usually sees streaming as repeated resource rereads, not as direct mutation from app-server payloads.

## Codex App-Server Mechanics

### Threads

In Codex app-server protocol, a `Thread` is the app-server API view of a conversation/session. It has identity, metadata, status, cwd, source information, and optionally turns. The type is defined in `codex/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs:135`.

Important fields:

- `id`
- `session_id`
- `status`
- `path`
- `cwd`
- `source`
- `turns`

The `turns` field is intentionally not always populated. The protocol comment says it is only populated on some responses such as `thread/resume`, `thread/rollback`, `thread/fork`, and `thread/read` when `includeTurns` is true. For other responses and notifications returning a thread, it is empty. See `thread_data.rs:178`.

### Turns

A `Turn` is the app-server unit for one user input and the resulting model/tool activity. The type is defined in `thread_data.rs:188`.

Important fields:

- `id`
- `items`
- `items_view`
- `status`
- `error`
- `started_at`
- `completed_at`
- `duration_ms`

The `items_view` field tells consumers how complete `items` is. `TurnItemsView` is defined in `thread_data.rs:212`:

- `NotLoaded`: `items` is intentionally empty.
- `Summary`: `items` contains a display summary.
- `Full`: `items` contains every `ThreadItem` available from persisted app-server history for that turn.

This matters because app-server APIs may return a `Turn` without all items, even though the `Turn` object shape is the same.

### Item Identity in Codex

Codex current item models have item IDs.

In core protocol, `TurnItem` variants are defined in `codex/codex-rs/protocol/src/items.rs:42`. Each concrete item struct has an `id` field, and `TurnItem::id()` returns it at `items.rs:586`.

In app-server protocol, `ThreadItem` variants are defined in `codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs:215`. Every variant carries `id`, including `ContextCompaction`. `ThreadItem::id()` is implemented at `item.rs:406`.

So in the current Codex model, the answer to "does each item have a proper id?" is yes for current `TurnItem` and `ThreadItem` values. The important caveat is that Remux does not always consume current `ThreadItem` values for persisted transcript reads. Remux often reconstructs a viewer model from legacy rollout/session JSONL rows, and that reconstruction sometimes synthesizes IDs.

### Starting a Turn

When app-server handles `turn/start`, it submits user input to the loaded thread and returns an in-progress `TurnStartResponse`. The returned turn has:

- `id` set to the new turn ID.
- `items` empty.
- `items_view` set to `NotLoaded`.
- `status` set to `InProgress`.

This is visible in `codex/codex-rs/app-server/src/request_processors/turn_processor.rs:501`.

The Remux server calls this from `extensions/codex/server/src/thread_commands.rs:355`. After the response, it immediately records the returned turn into `LiveTranscriptStore` and records runtime state as running at `thread_commands.rs:383`.

### App-Server Notifications

App-server notifications carry the live event stream. Relevant protocol notifications include:

- `turn/started`: `TurnStartedNotification` in `codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs:376`.
- `turn/completed`: `TurnCompletedNotification` in `turn.rs:393`.
- `item/started`: `ItemStartedNotification` in `codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs:1127`.
- `item/completed`: `ItemCompletedNotification` in `item.rs:1201`.
- `rawResponseItem/completed`: `RawResponseItemCompletedNotification` in `item.rs:1213`.
- item-specific deltas such as `item/agentMessage/delta`, where the payload includes `thread_id`, `turn_id`, `item_id`, and `delta`; see `item.rs:1223`.

In app-server event handling, `EventMsg::TurnStarted` is translated into `turn/started`. The notification turn is forced to `itemsView: NotLoaded` and `items` is cleared before sending. See `codex/codex-rs/app-server/src/bespoke_event_handling.rs:160`.

Context compaction has both legacy and current representations in Codex. The app-server explicitly does not fan out the deprecated `ContextCompacted` event as the v2 representation; the comment says v2 clients receive the canonical `ContextCompaction` item instead. See `codex/codex-rs/app-server/src/bespoke_event_handling.rs:906`.

### App-Server Active-Turn Snapshot

Codex app-server keeps an in-memory active-turn projection for loaded/running threads.

`ThreadState` has `current_turn_history: ThreadHistoryBuilder` at `codex/codex-rs/app-server/src/thread_state.rs:86`. Incoming core events are fed into it by `track_current_turn_event`, which calls `current_turn_history.handle_event(event)` at `thread_state.rs:142`.

`ThreadHistoryBuilder` is defined in `codex/codex-rs/app-server-protocol/src/protocol/thread_history.rs:228`. It can return `active_turn_snapshot()` at `thread_history.rs:264`.

This is app-server's own live projection. It is separate from Remux's `LiveTranscriptStore`.

### App-Server Read APIs

`thread/read` is handled in `codex/codex-rs/app-server/src/request_processors/thread_processor.rs:2153`. It can return metadata only, or include turns if `includeTurns` is true.

The read behavior depends on whether the thread is loaded:

- For loaded threads with `includeTurns`, app-server can reconstruct turns from the live `CodexThread` history. See `thread_processor.rs:2179`.
- For unloaded threads with `includeTurns`, app-server reads persisted `ThreadStore` history. See `thread_processor.rs:2193`.
- Metadata-only reads can use persisted metadata or a loaded snapshot. See `thread_processor.rs:2205`.

`thread/turns/list` rebuilds the turn list from rollout items and, when the thread is loaded, merges an active in-memory turn snapshot before paginating. See `thread_processor.rs:2365`.

The `itemsView` transformation is applied at `thread_processor.rs:3897`:

- `NotLoaded` clears items.
- `Summary` keeps only the first user message and final agent message.
- `Full` leaves items present.

## Remux Rust Backend

### Server Shape

The Remux Codex extension server is a Rust stdio JSON-RPC server. It is wired in `extensions/codex/server/src/main.rs`.

Important request methods are declared at `main.rs:37`:

- `remux/codex/files`
- `remux/codex/composer/config/read`
- `remux/codex/composer/config/write`
- `remux/codex/transcript/resources/read`
- `remux/codex/thread/resources/read`
- `remux/codex/thread/message/edit`
- `remux/codex/thread/message/fork`
- `remux/codex/thread/message/send`
- `remux/codex/thread/message/start`
- `remux/codex/thread/turn/interrupt`

The server object owns:

- `CodexFileResourcesServer`
- `CodexThreadCommandServer`
- `CodexThreadResourcesServer`
- `CodexTranscriptServer`
- shared `LiveTranscriptStore`
- shared `ThreadRuntimeStore`
- `AppServerRuntime`

Construction is in `main.rs:145`.

### AppServerRuntime

`AppServerRuntime` is Remux's Rust facade for Codex app-server. It connects to or starts Codex app-server over a Unix WebSocket socket. The socket path is `CODEX_HOME/app-server-control/app-server-control.sock`; see `extensions/codex/server/src/app_server.rs:14`.

Request flow:

- `AppServerRuntime::request()` wraps one app-server JSON-RPC call and retries once on failure. See `app_server.rs:69`.
- `request_once()` assigns an app-server request ID, records a pending response channel, writes the request, and waits up to 300 seconds. See `app_server.rs:96`.
- `ensure_connected()` either reuses a live connection or calls `connect_or_start()`. See `app_server.rs:150`.
- `connect_or_start()` first tries an existing runtime, then starts app-server if needed. See `app_server.rs:168`.
- `spawn_app_server()` runs `codex app-server --listen unix://` with `CODEX_HOME` set. See `app_server.rs:296`.

Incoming app-server messages are routed by `route_app_server_message()` at `app_server.rs:440`:

- Messages with an `id` and no method resolve pending requests.
- Messages with an `id` and a method are app-server requests to the client. Remux currently emits an event and responds with "server requests are not supported by remux-codex-server yet".
- Messages with a method and no id are notifications. These are emitted through `AppServerEventSink`.

### Thread Command Path

The viewer does not call Codex app-server directly. It calls Remux-specific thread command methods, and the Rust server builds app-server requests.

Existing thread:

- `send_message()` validates params, converts composer parts to Codex user input, ensures the thread is resumed, starts a turn, and returns immediate invalidations. See `extensions/codex/server/src/thread_commands.rs:217`.

New thread:

- `start_message()` builds `thread/start` params, starts the app-server thread, marks it resumed, starts the first turn, and returns immediate invalidations. See `thread_commands.rs:238`.

Resume:

- `ensure_thread_resumed()` uses an in-memory `resumed_thread_ids` set. If the thread has not been resumed in this Rust server process, it calls `thread/resume` with `excludeTurns: true`. See `thread_commands.rs:304`.

Turn start:

- `start_turn()` builds `turn/start` params, calls app-server, extracts `turn.id`, records the returned turn in the live transcript store, records runtime state, and returns the turn ID. See `thread_commands.rs:355`.

The returned invalidations from send/start/edit/fork/interrupt are not app-server notifications. They are immediate Remux invalidations with reason `sendAccepted` or `commandAccepted`, produced before app-server notifications necessarily arrive. See `extensions/codex/server/src/resource_invalidations.rs:9`.

### Thread Resources

Thread list, thread summary, and runtime status are not read from the transcript JSONL projection.

`CodexThreadResourcesServer` handles `remux/codex/thread/resources/read` in `extensions/codex/server/src/thread_resources.rs:53`.

Resource types:

- `threadHistory`: calls app-server `thread/list`. See `thread_resources.rs:95`.
- `threadSummary`: calls app-server `thread/read` with `includeTurns: false`. See `thread_resources.rs:153`.
- `threadRuntime`: reads Remux's `ThreadRuntimeStore`. See `thread_resources.rs:189`.

Each response gets a stable revision hash, and known revisions return `notModified`.

### Thread Runtime Store

`ThreadRuntimeStore` is Remux-local runtime state. It tracks:

- `active_turn_id`
- `status`: `ready`, `running`, `stopping`, or `failed`
- `last_error`

It is updated from explicit commands and app-server notifications. Notification handling starts in `extensions/codex/server/src/thread_runtime.rs:77`.

Examples:

- `turn/started` records running.
- `item/started` records running unless already stopping.
- `turn/completed` records ready or failed.
- `error` records failed.
- `thread/status/changed` maps app-server thread status to Remux runtime status.

This store is used by interrupt handling when no explicit turn ID is supplied, and by the viewer through `threadRuntime` resources.

## Remux Transcript Reads

### Resource Contract

The transcript read API is batch-oriented. The shared TypeScript contract is in `extensions/codex/shared/transcript.ts:6`.

Requests can ask for:

- `threadTranscript`
- `turn`
- `workDetails`
- `workItem`

Results have:

- `requestIndex`
- `key`
- `status`: `ok`, `notModified`, `missing`, or `error`
- optional `revision`
- optional `value`

The Rust request enum mirrors this in `extensions/codex/server/src/transcript.rs:31`.

### Server Entry Point

`CodexTranscriptServer::read_resources()` handles `remux/codex/transcript/resources/read`. See `extensions/codex/server/src/resources/mod.rs:63`.

For every batch:

1. Resolve a session file for the thread.
2. Compute a file revision from file length and modification time.
3. Build or reuse a session index.
4. Dispatch each requested resource.

The dispatcher for resource types is at `resources/mod.rs:75`.

### Session File Discovery and Indexing

Transcript content is read from Codex session JSONL files under `CODEX_HOME/sessions` and `CODEX_HOME/archived_sessions`. Discovery is in `extensions/codex/server/src/history/mod.rs:140`.

`build_session_index()` scans line offsets and builds:

- `session_id`
- `visible_turn_ids`
- `turns: HashMap<String, TurnRange>`

See `history/mod.rs:12`.

The index uses legacy row payload types to identify turn boundaries:

- `task_started` opens a turn.
- `task_complete` completes a turn.
- `turn_aborted` interrupts a turn.
- `thread_rolled_back` hides recent visible turns.

This is important because Remux's persisted read path is not reading app-server `ThreadItem` objects directly. It is reading JSONL rows and projecting them into a viewer model.

### Raw Turn Projection

After indexing, `project_turn()` reads only the byte range for one turn and projects rows into a `RawTurn`. See `extensions/codex/server/src/resources/mod.rs:368`.

The row-to-raw-turn projection is in `extensions/codex/server/src/projection/mod.rs:89`.

This function translates legacy payload types into item-like JSON values:

- `user_message` becomes `userMessage`.
- `agent_message` becomes `agentMessage`.
- assistant `message` rows can become `agentMessage`.
- `function_call` becomes `commandExecution` or `dynamicToolCall`.
- `function_call_output` completes the matching call item.
- `custom_tool_call` becomes `dynamicToolCall`.
- `patch_apply_end` becomes `fileChange`.
- `mcp_tool_call_end` becomes `mcpToolCall`.
- `web_search_end` becomes `webSearch`.
- `context_compacted` or compacted rows become `contextCompaction`.

The current Codex source has canonical IDs, but this projection sometimes synthesizes IDs. Examples are in `extensions/codex/server/src/projection/items.rs`:

- user messages: `user:{turn_id}:{index}` at `items.rs:39`.
- agent messages: `agent:{turn_id}:{index}` at `items.rs:46`.
- command calls use `call_id` when present or `command:{turn_id}:{index}` at `items.rs:64`.
- dynamic tool calls use `call_id` when present or `dynamic-tool:{turn_id}:{index}` at `items.rs:90`.
- file changes use `call_id` when present or `file-change:{turn_id}:{index}` at `items.rs:135`.
- mcp tool calls use `call_id` when present or `mcp-tool:{turn_id}:{index}` at `items.rs:161`.

That is the main identity boundary: Codex current protocol has proper item IDs, while Remux's disk projection may synthesize IDs from legacy rows.

### Viewer Turn Projection

`project_raw_turn()` converts a `RawTurn` into:

- a viewer `turn` resource with display `segments`
- `details_by_segment_id`
- `work_items_by_id`

See `extensions/codex/server/src/projection/mod.rs:252`.

Segments are the viewer's top-level transcript rows:

- `userMessage`
- `assistantMessage`
- `work`
- `compaction`

The output turn resource has a stable `revision` over turn status, timing, and segments. See `projection/mod.rs:414`.

Work segments are built by collecting pending material items until they are flushed. When a work segment is flushed:

- A stable work segment ID is generated.
- A `work` segment is pushed.
- `workDetails` entries are generated.
- `workItem` resources are generated for the items in that work segment.

This happens in the nested `flush_work()` function at `projection/mod.rs:262`.

### Work Details and Work Items

Work details are the expanded content for a work segment. They are not the same as top-level transcript segments.

`build_work_entries()` creates entries for a set of work items. See `extensions/codex/server/src/projection/work.rs:12`.

Entries can be:

- `message`
- `userMessage`
- `compaction`
- `group`

Groups are references by item ID. `build_work_group_refs()` creates grouped references for file changes, activity, and tools at `work.rs:136`.

`build_work_item()` materializes a single item into the viewer `CodexWorkItem` union at `work.rs:77`.

The shared viewer types are in `extensions/codex/shared/transcript.ts`:

- `CodexWorkDetails` at `transcript.ts:129`
- `CodexWorkEntry` at `transcript.ts:136`
- `CodexWorkGroupRef` at `transcript.ts:158`
- `CodexWorkItem` at `transcript.ts:165`

### Resource Readers

Each resource reader returns `notModified` if the viewer's `knownRevision` matches.

`threadTranscript`:

- Builds turn order from disk visible turns plus live overlay turn order.
- Builds revision from file revision, live revision, and turn order.
- Optionally includes tail turns.
- See `extensions/codex/server/src/resources/mod.rs:139`.

`turn`:

- Calls `project_turn_or_live()`.
- Returns the projected turn and layout revision.
- See `resources/mod.rs:195`.

`workDetails`:

- Calls `project_turn_or_live()`.
- Looks up `details_by_segment_id`.
- See `resources/mod.rs:235`.

`workItem`:

- Calls `project_turn_or_live()`.
- Looks up `work_items_by_id`.
- See `resources/mod.rs:275`.

`project_turn_or_live()` first tries disk projection, then overlays live state. If disk projection fails, it asks `LiveTranscriptStore` for a live projected turn. See `resources/mod.rs:406`.

## Live Overlay

### What the Overlay Stores

`LiveTranscriptStore` stores in-memory live turns keyed by thread and turn. It receives app-server notifications in `extensions/codex/server/src/main.rs:193`.

When a notification contains a full `turn`, `record_notification()` calls `record_turn()`. See `extensions/codex/server/src/live_transcript.rs:107`.

`record_turn()`:

- Extracts `turn.id`.
- Appends the turn ID to live turn order if needed.
- If `itemsView` is `full`, stores the full turn as-is.
- Otherwise merges turn metadata and only fills `items` if target items are empty.

See `live_transcript.rs:40`.

### Item and Delta Handling

For selected item notifications, `record_notification()` mutates the live turn:

- `item/started` and `item/completed` upsert `params.item`.
- `item/agentMessage/delta` appends to an `agentMessage.text`.
- `item/plan/delta` appends to `plan.text`.
- `item/commandExecution/outputDelta` appends to `commandExecution.aggregatedOutput`.
- `item/fileChange/outputDelta` appends to `fileChange.output`.
- `item/fileChange/patchUpdated` replaces `fileChange.changes`.
- reasoning deltas update indexed reasoning fields.

See `live_transcript.rs:128`.

When a delta arrives before the full item, `ensure_turn_item()` creates a minimal item with the known `itemId` and type. See `live_transcript.rs:350`.

For string deltas, the overlay records both:

- the current live item snapshot, and
- a compact per-item delta map.

The per-item delta map is used later when merging into disk-projected raw turns. See `live_transcript.rs:306` and `live_transcript.rs:462`.

### Overlay Application

When a disk-projected turn exists, `apply_overlay()` merges live data into it. The merge path eventually calls `merge_live_turn_into_raw()` at `live_transcript.rs:518`.

That merge:

- applies live metadata such as status and timings
- merges live item snapshots
- applies item deltas by item ID

When disk projection does not find the turn, `projected_turn()` can project the live app-server turn by itself. This is the path for a new in-progress turn before the session file contains it. `project_app_server_turn()` is in `extensions/codex/server/src/projection/mod.rs:230`.

## Invalidation Model

### Remux Resource Invalidation Types

The shared invalidation type is in `extensions/codex/shared/threadCommands.ts:71`.

Current invalidation types:

- `threadHistory`
- `threadRuntime`
- `threadSummary`
- `threadTranscript`
- `workItem`

There is no distinct `workDetails` invalidation type in the shared contract.

### Immediate Command Invalidations

When a user sends, starts, edits, forks, or interrupts, the command response returns invalidations immediately.

`send_accepted_invalidations()` returns:

- `threadHistory`
- `threadRuntime`
- `threadSummary`
- `threadTranscript`

See `extensions/codex/server/src/resource_invalidations.rs:9`.

`command_accepted_invalidations()` returns the same shape with reason `commandAccepted`. See `resource_invalidations.rs:18`.

These invalidations are not proof that app-server has emitted all events. They are used to prompt the viewer to reread current resources after a command is accepted.

### App-Server Notification Invalidations

When an app-server notification arrives, `spawn_app_server_event_forwarder()` records the notification into local stores and derives invalidations. See `extensions/codex/server/src/main.rs:193`.

`invalidations_for_app_server_notification()` is in `extensions/codex/server/src/resource_invalidations.rs:27`.

It may generate:

- `threadHistory` and `threadSummary` for thread-history-affecting methods.
- `threadRuntime` for runtime-affecting methods.
- `threadTranscript` for transcript-affecting methods.
- `workItem` for item-affecting methods with a resolvable `turnId` and `itemId`.

`threadTranscript` invalidating methods include:

- `turn/started`
- `turn/completed`
- `turn/diff/updated`
- `turn/plan/updated`
- `item/started`
- `item/completed`
- `rawResponseItem/completed`
- `item/agentMessage/delta`
- `item/commandExecution/terminalInteraction`
- `item/reasoning/summaryPartAdded`
- `thread/compacted`
- `model/rerouted`
- moderation and warning/error events

See `resource_invalidations.rs:208`.

`workItem` invalidating methods include:

- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/plan/delta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`
- `item/fileChange/patchUpdated`
- `item/mcpToolCall/progress`
- reasoning deltas

See `resource_invalidations.rs:230`.

## Process Bridge

### Extension server to runtime

The Rust server writes JSON-RPC responses and notifications to stdout. `spawn_stdout_writer()` writes one JSON value per line. See `extensions/codex/server/src/main.rs:176`.

The runtime supervisor reads stdout line-by-line. A JSON-RPC response resolves
the routed pending request; a notification with a method is broadcast to
connected clients. See `crates/remux/src/extensions/supervisor.rs`.

### Runtime to React Native WebView

`ExtensionWebView` sends viewer requests to Remux via `remux.request(...)` and posts responses back into the WebView. See `app/src/surfaces/viewer/ExtensionWebView.tsx:523`.

It also subscribes to Remux broadcasts and posts them into the WebView as `remux/event`. See `ExtensionWebView.tsx:562`.

### Viewer IPC Client

Inside the WebView, `extensions/codex/viewer/ipc/client.ts` owns request/response handling and event batching.

Requests use `requestIpc()` at `client.ts:82`. It posts a `remux/request` message and waits for a matching `remux/response` or `remux/error`.

Incoming native events are queued and flushed on the next animation frame. See `client.ts:226`.

This batching means multiple Rust notifications can be applied together by viewer subscribers.

## Viewer Resource Store

### Store Shape

The transcript resource store is in `extensions/codex/viewer/transcript/resourceStore.ts`.

It stores:

- `activeThreadId`
- `status`
- `threadRevision`
- `turnOrder`
- `turnResourcesById`
- `workDetailsByKey`
- `workItemsByKey`
- `workingTurnId`
- `isWorking`

See `resourceStore.ts:56`.

Work details and work items have separate maps:

- `workDetailsByKey` is keyed as `workDetails:{threadId}:{turnId}:{segmentId}`.
- `workItemsByKey` is keyed as `workItem:{threadId}:{turnId}:{itemId}`.

Key helpers are at `resourceStore.ts:134`.

### Initial Thread Load

When the active thread changes, `setActiveThreadId()` increments `transcriptReadGeneration`, clears pending work detail/item requests, resets layout, clears resource state, and calls `loadTranscript()` if layout width is known. See `resourceStore.ts:83`.

`loadTranscript()` starts at `resourceStore.ts:198`.

Its read sequence:

1. Read `threadTranscript` with the current known thread revision.
2. Reconcile or reuse `turnOrder`.
3. For each chunk of up to 50 turn IDs, read `turn` resources with known revisions.
4. Keep previous turn resources for `notModified` responses.
5. Filter cached work details and work items down to still-visible turns.
6. Set the store state.
7. Reconcile layout.
8. Refresh currently open work details.

The turn chunking starts at `resourceStore.ts:252`.

The stale-load check only rejects loads when the active thread changes or `transcriptReadGeneration` changes. See `resourceStore.ts:766`.

### Invalidation Handling

Viewer subscription starts in `extensions/codex/viewer/ipc/resourceInvalidations.ts:24`.

It filters `remux/codex/resources/invalidated` events, parses invalidations, and calls:

- `invalidateThreadResources`
- `invalidateThreadRuntimeResources`
- `invalidateTranscriptResources`

See `resourceInvalidations.ts:12`.

Transcript invalidation handling is in `extensions/codex/viewer/transcript/resourceStore.ts:142`.

Order:

1. For `workItem` invalidations matching the active thread, request those individual work items.
2. If a matching `threadTranscript` invalidation exists, call `loadTranscript()` with `preserveReady: true`.

This means item-level refresh can happen without a full transcript refresh, and full transcript refresh can happen without a separate `workDetails` invalidation type.

### Work Details Loading

Work details are lazy.

When a work section is opened, `WorkSection` calls `ensureWorkDetails()` if details are not present. See `extensions/codex/viewer/transcript/components/work/WorkSection.tsx:94`.

The layout store also calls `ensureWorkDetails()` when opening work disclosure. See `extensions/codex/viewer/transcript/layoutStore.ts:175`.

`requestWorkDetails()`:

- checks the existing `workDetails` cache
- dedupes in-flight requests by resource key
- reads the `workDetails` resource with known revision
- stores ready/missing/error state
- then requests each listed `workItem`

See `extensions/codex/viewer/transcript/resourceStore.ts:397`.

After details are read, `requestWorkItemsForDetails()` calls `requestWorkItem()` for every `details.itemIds`. See `resourceStore.ts:490`.

### Work Item Loading

`requestWorkItem()`:

- uses key `workItem:{threadId}:{turnId}:{itemId}`
- dedupes in-flight requests by key
- if another invalidation arrives while the same key is in flight, marks the key dirty
- after the in-flight request completes, refetches if dirty

See `resourceStore.ts:500`.

This is one of the places where the viewer is designed for high-frequency item invalidations without directly applying deltas.

### Work Rendering

`WorkSection` materializes groups using the fetched item cache.

It builds a deduped list of item IDs for fetching with `workGroupItemIds()` at `extensions/codex/viewer/transcript/components/work/WorkSection.tsx:649`.

However, rendering a group uses the group's original `itemIds` with `itemsForGroup()` at `WorkSection.tsx:663`.

That distinction matters: the fetch list is deduped, but the render list follows the server-provided group membership exactly.

## End-to-End Sequences

### Opening a Transcript

1. Viewer sets an active thread ID.
2. `resourceStore.setActiveThreadId()` resets transcript resources and layout.
3. `loadTranscript()` reads `threadTranscript`.
4. Rust transcript server resolves the session file, indexes visible turns, overlays live turn order, and returns turn IDs.
5. Viewer reads `turn` resources in chunks.
6. Rust projects each turn from disk JSONL rows plus live overlay.
7. Viewer stores turn resources and reconciles layout.
8. Work details are not loaded until a work section opens.

### Sending to an Existing Thread

1. Viewer submits a Remux thread command.
2. Rust `send_message()` converts composer parts to app-server user input.
3. Rust ensures the app-server thread is resumed.
4. Rust calls app-server `turn/start`.
5. App-server returns a `Turn` with `itemsView: NotLoaded`.
6. Rust records that turn in `LiveTranscriptStore`.
7. Rust records runtime state as running.
8. Rust returns immediate `sendAccepted` invalidations.
9. Viewer rereads transcript/thread/runtime resources.
10. App-server later emits notifications such as `turn/started`, `item/started`, deltas, `item/completed`, and `turn/completed`.
11. Rust records selected notifications into the live overlay and emits `appServerEvent` invalidations.
12. Viewer rereads changed resources.

### Expanding Work Details

1. User opens a work segment.
2. Viewer calls `ensureWorkDetails({ turnId, segmentId })`.
3. Rust reads the `workDetails` resource for that turn and segment.
4. The response contains `entries` and `itemIds`.
5. Viewer requests one `workItem` resource per item ID.
6. Rendered rows come from group entries plus the fetched item cache.

### App-Server Item Delta

1. App-server emits a delta notification with `threadId`, `turnId`, `itemId`, and `delta`.
2. Rust `LiveTranscriptStore` appends the delta to its in-memory item.
3. Rust invalidation code emits:
   - `threadTranscript` for some delta types
   - `workItem` for item-level delta types
4. Viewer rereads the specific `workItem`, and sometimes the broader transcript.
5. The read response is computed from disk projection plus overlay.

## Compaction Current State

Codex current protocol models context compaction as an item. `ThreadItem::ContextCompaction { id }` is defined in `codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs:386`.

Codex tests assert that compaction started and completed notifications use the same item ID. See `codex/codex-rs/app-server/tests/suite/v2/compaction.rs:92`.

Remux persisted projection also recognizes compacted rows and creates `contextCompaction` items. In disk projection, IDs are synthesized as `compaction:{turn_id}:{compaction_count}`. See `extensions/codex/server/src/projection/mod.rs:204`.

Viewer compaction can appear as:

- a top-level `compaction` segment, built in `extensions/codex/server/src/projection/segments.rs:31`
- a `compaction` work entry/item, built in `extensions/codex/server/src/projection/work.rs:60` and `work.rs:100`

Compaction status is derived from turn status and later material items:

- top-level helper `compaction_status()` maps in-progress turns to `compacting`, interrupted/failed to `cancelled`, and other states to `compacted`; see `extensions/codex/server/src/projection/mod.rs:457`.
- `compaction_statuses_for_turn()` marks a compaction as `compacted` if later material items exist; see `projection/mod.rs:601`.

Important current boundary:

- `resource_invalidations.rs` treats `rawResponseItem/completed` and `thread/compacted` as transcript-invalidating events.
- `LiveTranscriptStore::record_notification()` handles `item/started`, `item/completed`, selected deltas, and full `turn` payloads, but it does not currently materialize `rawResponseItem/completed` into an item.

That means some compaction-related invalidations may cause rereads where the live overlay does not contain a corresponding new item. The eventual read may then depend on what has reached the session file and how the disk projection sees it.

## Duplicate Work Detail Rows Current State

There are two different notions of dedupe in the current code:

1. The viewer dedupes item IDs for fetching.
2. The viewer does not dedupe group membership for rendering.

Server-side group membership:

`build_work_group_refs()` collects item IDs by type. The collector is `item_ids_for_types()` at `extensions/codex/server/src/projection/work.rs:178`. It iterates items and collects IDs. It does not dedupe IDs.

Viewer fetch path:

`workGroupItemIds()` dedupes IDs across groups before selecting/fetching item cache values. See `extensions/codex/viewer/transcript/components/work/WorkSection.tsx:649`.

Viewer render path:

`itemsForGroup()` maps `group.itemIds` directly back through the fetched item map. See `WorkSection.tsx:663`.

Current consequence:

If a server-provided `group.itemIds` array contains the same item ID twice, the viewer may fetch only once, but render twice. A reload can remove the duplicate if the later disk-backed projection no longer has duplicate membership.

This document is not assigning root cause. The current code path only establishes where duplicates can survive: in `workDetails` group membership, not in the per-item cache key.

## Revisions and Read Stability

The resource system relies on stable revisions instead of direct streaming mutation.

Examples:

- `threadTranscript` revision includes file revision, live revision, and turn order. See `extensions/codex/server/src/resources/mod.rs:155`.
- `turn` revision is generated from status, timings, and segments. See `extensions/codex/server/src/projection/mod.rs:414`.
- work details revision is generated from entries. See `projection/mod.rs:288`.
- work item revision is generated from the materialized work item. See `projection/mod.rs:305`.

The viewer passes known revisions on reads:

- thread known revision at `extensions/codex/viewer/transcript/resourceStore.ts:214`
- turn known revision at `resourceStore.ts:257`
- work details known revision at `resourceStore.ts:414`
- work item known revision at `resourceStore.ts:518`

The server returns `notModified` when possible. This keeps the viewer from replacing unchanged resource entries during frequent invalidations.

## Important Boundaries

Codex app-server has a canonical item model, an active-turn snapshot, and read APIs that can return turns with controlled `itemsView`.

Remux transcript reads do not currently use app-server `thread/turns/list` or app-server `thread/read(includeTurns: true)` as the transcript source. Remux reads local JSONL session files and projects them into its own viewer resource model, with a live overlay for in-flight state.

The viewer does not directly apply app-server item deltas into rendered state. It uses invalidations to reread authoritative Remux resources.

`workDetails` and `workItem` are separate layers:

- `workDetails` describes expanded section structure and item membership.
- `workItem` describes the materialized payload for one item ID.

There is no `workDetails` invalidation type. Open work details are refreshed after transcript reloads, and work items can refresh independently.

Item identity is canonical in current Codex protocol but partly reconstructed in Remux disk projection. This distinction is central when comparing app-server notifications with JSONL-backed reads.

## Glossary

Thread:

An app-server conversation/session object with metadata and optional turns.

Turn:

One user-input cycle inside a thread, containing ordered items.

ThreadItem:

App-server protocol item with a proper `id` field on every current variant.

RawTurn:

Remux Rust intermediate representation produced from JSONL rows or app-server turn data.

Segment:

Viewer top-level transcript row. Examples: user message, assistant message, work, compaction.

Work segment:

A top-level segment representing a group of material work items such as tool calls, command executions, file changes, or compaction work.

Work details:

Lazy expanded structure for a work segment. Contains entries and item IDs.

Work item:

Lazy materialized payload for one item ID inside work details.

Live overlay:

Remux-local in-memory state recorded from selected app-server notifications and merged into disk-projected turns.

Invalidation:

A notification telling viewer stores that cached resources may be stale and should be reread.

Revision:

A stable hash attached to a resource response. The viewer sends known revisions, and the server returns `notModified` when the resource has not changed.
