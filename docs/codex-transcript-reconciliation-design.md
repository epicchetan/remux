# Codex Transcript Identity Reconciliation Design

## Purpose

Remux has a faster transcript read strategy than Codex app-server for viewer use:

- index the rollout/session file by turn byte ranges
- read only requested turn ranges
- cache projected turns by file revision and byte range
- apply a small live overlay from app-server notifications
- expose viewer resources with revisions

That strategy is worth keeping. The weak point is identity: persisted rollout rows and live app-server notifications do not always carry the same item IDs. A reconciliation layer should give Remux one canonical item identity model that is reproducible on rereads and can associate live app-server events with the same item keys.

This document designs that layer.

## Source Grounding

### Codex Rollout Structure

Codex persists thread history as rollout lines. A rollout line is a timestamp plus a flattened `RolloutItem`:

- `codex/codex-rs/protocol/src/protocol.rs:2981`
- `codex/codex-rs/protocol/src/protocol.rs:3150`

`RolloutItem` variants include:

- `SessionMeta`
- `ResponseItem`
- `InterAgentCommunication`
- `Compacted`
- `TurnContext`
- `EventMsg`

This is a timeline/log, not a normalized `ThreadItem[]` table.

Codex writes rollout items through `RolloutRecorder::record_canonical_items(...)`:

- `codex/codex-rs/rollout/src/recorder.rs:811`

Codex reads rollout items through `RolloutRecorder::load_rollout_items(...)`:

- `codex/codex-rs/rollout/src/recorder.rs:867`

### Codex Item IDs

Current Codex response items can receive missing IDs before being persisted when the `ItemIds` feature is enabled:

- `codex/codex-rs/core/src/session/mod.rs:2698`
- `codex/codex-rs/core/src/session/mod.rs:2705`

Those generated response item IDs use type prefixes and UUIDv7, for example:

- `msg_...`
- `fc_...`
- `cmp_...`

Codex app-server `ThreadItem` variants all have an `id` field:

- `codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs:215`
- `codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs:406`

But app-server also replays legacy/event-shaped rollout rows. For some event rows, there is no persisted item ID to preserve. In those cases `ThreadHistoryBuilder` synthesizes display IDs like `item-1`, `item-2`:

- user message handling: `codex/codex-rs/app-server-protocol/src/protocol/thread_history.rs:456`
- agent message handling: `codex/codex-rs/app-server-protocol/src/protocol/thread_history.rs:475`
- synthetic ID generator: `codex/codex-rs/app-server-protocol/src/protocol/thread_history.rs:1419`

For call-like events, app-server often preserves `call_id`. Examples:

- web search: `codex/codex-rs/app-server-protocol/src/protocol/thread_history.rs:643`
- MCP tool call: `codex/codex-rs/app-server-protocol/src/protocol/thread_history.rs:758`

### Codex App-Server Replay Cost

The app-server `thread/turns/list` path comments that it pages network output but still replays the entire rollout on every request:

- `codex/codex-rs/app-server/src/request_processors/thread_processor.rs:2355`

The comment says rollback and compaction can change earlier turns, so the server rebuilds the full turn list until turn metadata is indexed separately.

This is the core reason Remux's range-based read path remains valuable.

### Remux Current Read Structure

Remux builds its own session index:

- `extensions/codex/server/src/history/mod.rs:12`

The index records visible turn IDs and byte ranges. It recognizes:

- `task_started`
- `task_complete`
- `turn_aborted`
- `thread_rolled_back`

Remux projects one turn by reading only that turn range:

- `extensions/codex/server/src/resources/mod.rs:368`

The projection builds a `RawTurn`, then viewer segments, work details, and work items:

- `extensions/codex/server/src/projection/mod.rs:89`
- `extensions/codex/server/src/projection/mod.rs:252`

Remux currently synthesizes some IDs independently:

- user message: `extensions/codex/server/src/projection/items.rs:7`
- agent message: `extensions/codex/server/src/projection/items.rs:46`
- command call fallback: `extensions/codex/server/src/projection/items.rs:64`
- file change fallback: `extensions/codex/server/src/projection/items.rs:135`

Live events are recorded into `LiveTranscriptStore`:

- `extensions/codex/server/src/live_transcript.rs:91`

Overlay merge currently matches items by exact `id`:

- `extensions/codex/server/src/live_transcript.rs:558`

If the live item ID and disk-projected item ID differ, the live item can be appended instead of merged.

## Design Goals

1. Item keys are reproducible across rereads of the same visible turn history.
2. Live app-server event IDs can be associated with the same canonical item keys used by disk projection.
3. The viewer sees only canonical Remux IDs, not whatever source ID happened to arrive first.
4. Work details group membership uses canonical IDs and does not duplicate IDs accidentally.
5. The range-based Remux read approach remains intact.
6. The reconciliation layer is server-owned. The viewer remains a resource consumer.

## Non-Goals

1. Replacing Remux transcript reads with app-server `thread/turns/list`.
2. Making historical IDs globally immutable across unrelated changes to historical projection rules.
3. Recreating every Codex app-server reducer detail in the viewer.
4. Treating app-server synthetic IDs like `item-1` as durable external identity.

## Core Idea

Introduce a server-side `ItemIdentityResolver`.

The resolver maps many possible source aliases to one canonical Remux item key:

```text
source aliases:
  appServerItemId
  responseItemId
  callId
  legacyKindOrdinal
  rowOffset

resolve to:
  canonical Remux item key
```

Disk projection and live overlay both call the resolver. They do not independently decide the final `id` field used by viewer resources.

## Canonical Key Policy

Canonical IDs should be namespaced, versioned, turn-scoped strings.

Suggested format:

```text
cxitem:v1:{turnId}:{strategy}:{value}
```

Examples:

```text
cxitem:v1:turn-abc:id:fc_019...
cxitem:v1:turn-abc:call:call_123
cxitem:v1:turn-abc:legacy:agentMessage:0
cxitem:v1:turn-abc:legacy:contextCompaction:0
```

The `v1` prefix is intentional. If identity semantics change later, a new version can be introduced without pretending old resource keys have the same meaning.

### Priority Order

When projecting an item, choose the first available identity source:

1. Durable item ID
2. Call ID
3. Legacy ordinal key

### Durable Item ID

Use a durable item ID when the source row or live item has an ID that is not an app-server replay-synthetic ID.

Examples:

- `ResponseItem.id`
- current `TurnItem.id`
- current `ThreadItem.id`
- generated response item IDs such as `msg_...`, `fc_...`, `cmp_...`

Canonical form:

```text
cxitem:v1:{turnId}:id:{sourceItemId}
```

### Call ID

Use call ID for tool-like rows when there is no durable item ID but a `call_id` exists.

Canonical form:

```text
cxitem:v1:{turnId}:call:{callId}
```

This should be turn-scoped even if call IDs are expected to be unique. Turn scoping prevents accidental cross-turn collisions from becoming global resource-key collisions.

### Legacy Ordinal

Use a legacy ordinal when there is no durable item ID and no call ID.

Canonical form:

```text
cxitem:v1:{turnId}:legacy:{kind}:{ordinal}
```

Examples:

```text
cxitem:v1:turn-abc:legacy:userMessage:0
cxitem:v1:turn-abc:legacy:agentMessage:0
cxitem:v1:turn-abc:legacy:contextCompaction:0
```

The ordinal should be assigned by the Remux projection policy, not by app-server's `item-N` string.

Recommended ordinal rule:

- Maintain a counter per `(turnId, canonicalKind)`.
- Increment only when projecting an item of that canonical kind that lacks durable ID and call ID.
- Ignore rows that do not materialize into viewer items.

This keeps IDs reproducible across rereads under the same Remux projection rules.

## Synthetic App-Server IDs

Treat app-server replay IDs matching `item-{integer}` as aliases, not canonical IDs.

Reason:

- Codex `ThreadHistoryBuilder::next_item_id()` produces exactly this shape.
- It is a replay display ID, not necessarily a persisted source ID.
- Remux can generate a better turn-scoped legacy ordinal key.

Example:

```text
appServerItemId = item-4
item type       = agentMessage
turn            = turn-abc
observed ordinal among agentMessage legacy items = 0

canonical:
  cxitem:v1:turn-abc:legacy:agentMessage:0

alias:
  app:item-4 -> cxitem:v1:turn-abc:legacy:agentMessage:0
```

This is the key behavior needed for live events to merge with later disk reads.

## Resolver Data Model

Rust-side types could be conceptually shaped like this:

```rust
struct ItemIdentityResolver {
    threads: HashMap<String, ThreadIdentityState>,
}

struct ThreadIdentityState {
    turns: HashMap<String, TurnIdentityState>,
}

struct TurnIdentityState {
    aliases: HashMap<ItemAlias, CanonicalItemKey>,
    reverse_aliases: HashMap<CanonicalItemKey, HashSet<ItemAlias>>,
    live_ordinals: HashMap<ItemKind, usize>,
}

enum ItemAlias {
    AppServerItemId(String),
    DurableItemId(String),
    CallId(String),
    LegacyOrdinal { kind: ItemKind, ordinal: usize },
    RowOffset(u64),
}

struct CanonicalItemKey(String);
```

The exact implementation can be simpler, but the model should keep aliases explicit. The current problem comes from treating source IDs and canonical viewer IDs as the same thing.

## Disk Projection Integration

The current `project_rows_to_raw_turn(...)` should stop writing source-derived IDs directly into item JSON.

Instead, each materialized item should be created through an identity-aware helper:

```text
project row
  -> detect source identity inputs
  -> resolver.resolve_disk_item(...)
  -> set item.id = canonical key
  -> attach source aliases in server-only metadata if needed
```

The viewer-facing `id` should always be canonical.

Server-only metadata can be kept out of serialized viewer resources or stripped before returning. If retained internally, use a reserved field such as:

```json
{
  "id": "cxitem:v1:turn-abc:call:call_123",
  "type": "commandExecution",
  "_identity": {
    "aliases": ["call:call_123", "app:item-7"]
  }
}
```

The `_identity` field should not be exposed as part of the public transcript contract unless there is a clear debugging need.

## Live Overlay Integration

The live overlay should store canonical IDs, not raw app-server IDs.

Current flow:

```text
notification item.id
  -> upsert live item by item.id
  -> merge live item into disk raw turn by exact id
```

Target flow:

```text
notification item.id
  -> resolver.resolve_live_item(...)
  -> rewrite live item.id to canonical key
  -> record app-server id as alias
  -> merge by canonical key
```

### Full Item Notifications

For `item/started` and `item/completed`:

1. Extract `threadId`, `turnId`, `item.id`, and item type.
2. Resolve a canonical key:
   - durable ID if not app-server synthetic
   - call ID/durable item ID where applicable
   - legacy ordinal if app-server ID is synthetic
3. Store alias `AppServerItemId(item.id) -> canonical`.
4. Rewrite item `id` to canonical before storing in `LiveTranscriptStore`.

### Delta Notifications

For deltas such as `item/agentMessage/delta`:

1. Extract `threadId`, `turnId`, `itemId`, and infer item kind from method.
2. Resolve `itemId`:
   - if alias exists, use it
   - if itemId is durable-looking, use durable ID canonical key
   - if itemId is `item-{integer}`, allocate or reuse a live legacy ordinal for the inferred kind
3. Store the delta under canonical key.
4. Store alias `AppServerItemId(itemId) -> canonical`.

This avoids a delta creating `item-3` while disk projection later creates `agent:{turn}:0`.

## Live Ordinal Assignment

The hard case is app-server synthetic IDs with no durable source ID.

For those, the resolver needs live ordinals. Suggested rule:

- One counter per `(turnId, itemKind)`.
- On first synthetic app-server item ID for that kind, assign the next ordinal.
- Reuse the ordinal for later events with the same app-server item ID.

Example:

```text
notification: item/agentMessage/delta itemId=item-2
kind: agentMessage

no alias exists
item-2 matches replay synthetic pattern
next live agentMessage ordinal is 0

canonical = cxitem:v1:turn-abc:legacy:agentMessage:0
alias app:item-2 -> canonical
```

When disk later projects the legacy agent message row, it should also produce:

```text
cxitem:v1:turn-abc:legacy:agentMessage:0
```

The live overlay and disk item then merge.

## Turn Boundaries and Reset Rules

The resolver should reset turn-local state when a turn is no longer visible or is explicitly removed.

Cases:

- `thread_rolled_back` hides turns in the disk index.
- edit/rollback paths call `LiveTranscriptStore::remove_turn(...)`.
- a thread switch clears viewer-side state, but server-side identity state may remain until process exit unless pruned.

Recommended server behavior:

- Resolver state is keyed by thread and turn.
- When a turn is removed from live transcript, remove resolver state for that turn.
- When a transcript read produces visible turn IDs, optionally prune resolver turns not visible for that thread.

This keeps aliases from stale turns from leaking into future reads.

## Compaction Handling

Compaction has several source shapes:

1. Current `ThreadItem::ContextCompaction { id }`
2. Current `ResponseItem::ContextCompaction` or `ResponseItem::Compaction`
3. Legacy `EventMsg::ContextCompacted`
4. `RolloutItem::Compacted`
5. Remux compacted-line fallback

Identity policy:

- If current compaction has a durable item ID, use:

```text
cxitem:v1:{turnId}:id:{compactionId}
```

- If compaction is legacy/no-id, use:

```text
cxitem:v1:{turnId}:legacy:contextCompaction:{ordinal}
```

App-server synthetic `item-N` for compaction should be an alias to the legacy compaction key, not the canonical key.

This is important because compaction can appear as either a top-level segment or as work detail content in Remux.

## Work Details and Work Items

After canonical IDs are in place:

- `workDetails.itemIds` should contain canonical IDs.
- `workItem:{threadId}:{turnId}:{itemId}` should use canonical IDs.
- Work group membership should dedupe canonical IDs before returning.

Current behavior dedupes only on the viewer fetch path, while rendering follows group membership. The server should return deduped group `itemIds` because duplicate membership is a data issue, not a rendering concern.

Suggested server rule:

- Within each work group, preserve first occurrence order.
- Drop later duplicate canonical IDs.
- Build `details.itemIds` from deduped group entries and standalone entries.

## Revisions

Revisions should use canonical IDs.

Current revision inputs that include item IDs should switch to canonical IDs:

- turn segment revision
- work segment revision
- work details revision
- work item revision
- live overlay revision

This ensures rereads agree with live invalidation reads.

The resolver's alias table should not generally affect resource revisions unless alias changes alter viewer-visible data. If a new alias maps to an existing canonical item and the viewer-visible item is unchanged, the resource can remain `notModified`.

## Event Processing Order

The reconciler must be tolerant of out-of-order or partial events.

Examples:

- A delta can arrive before `item/started`.
- A completion can arrive after output deltas.
- Disk can catch up after multiple live invalidations.

Rules:

1. `resolve_live_delta(...)` may create a canonical item before a full item snapshot exists.
2. `resolve_live_item(...)` must reuse an existing alias if one exists.
3. Full item snapshots should merge into existing live delta items by canonical ID.
4. Disk projection should merge with existing live overlay by canonical ID.

This matches the current dirty-request behavior on the viewer side, but moves identity correctness into the server.

## Relationship to Codex App-Server

This design does not require replacing Codex's app-server replay.

It uses Codex facts:

- rollout is a timeline
- current items can have durable IDs
- legacy events sometimes lack IDs
- app-server may synthesize `item-N`
- app-server full replay can be expensive

But it keeps Remux's read architecture:

- byte-range turn reads
- server-side projection
- resource revisions
- viewer invalidation rereads

The reconciler is a compatibility layer between Codex's event-sourced storage and Remux's read-optimized resource model.

## Concrete Read Flow With Reconciler

### Disk Turn Read

```text
read turn byte range
  -> parse rows
  -> for each material item:
       resolve disk identity
       emit canonical item id
  -> project RawTurn
  -> build segments/workDetails/workItems using canonical IDs
  -> apply live overlay by canonical IDs
```

### Live Notification

```text
receive app-server notification
  -> resolve live identity
  -> rewrite itemId/item.id to canonical key
  -> store live snapshot/delta under canonical key
  -> emit invalidation using canonical key for workItem
```

This last point matters: `workItem` invalidations should use canonical item IDs. The viewer should never need to request `workItem:{thread}:{turn}:item-7` if the canonical key is `cxitem:v1:{turn}:legacy:agentMessage:0`.

## Example: Legacy Agent Message

Disk row:

```text
payload type: agent_message
turn_id: turn-a
message: "hello"
no item id
```

Disk identity:

```text
cxitem:v1:turn-a:legacy:agentMessage:0
```

Live delta:

```text
method: item/agentMessage/delta
turnId: turn-a
itemId: item-2
delta: "hel"
```

Live identity:

```text
item-2 is app-server synthetic
kind = agentMessage
ordinal = 0
canonical = cxitem:v1:turn-a:legacy:agentMessage:0
alias app:item-2 -> canonical
```

Result:

The live delta and the later disk row merge into one item.

## Example: Command Execution

Disk row:

```text
payload type: function_call
turn_id: turn-a
call_id: call_x
name: exec_command
```

Disk identity:

```text
cxitem:v1:turn-a:call:call_x
```

Live event:

```text
method: item/commandExecution/outputDelta
turnId: turn-a
itemId: call_x
```

Live identity:

```text
cxitem:v1:turn-a:call:call_x
```

Result:

Disk and live naturally merge.

## Example: Current Response Item With ID

Disk row:

```text
RolloutItem::ResponseItem
id: msg_019...
```

Disk identity:

```text
cxitem:v1:turn-a:id:msg_019...
```

Live event:

```text
item.id: msg_019...
```

Live identity:

```text
cxitem:v1:turn-a:id:msg_019...
```

Result:

No alias fallback is needed.

## Implementation Boundaries

Likely modules:

- New module: `extensions/codex/server/src/identity.rs`
- Integrate into `LiveTranscriptStore`
- Integrate into `projection/items.rs`
- Integrate into `projection/mod.rs`
- Integrate invalidation key generation for `workItem`

The server should own this. The viewer should continue to use resource keys and revisions.

## Validation Strategy

Useful tests:

1. Disk projection returns identical canonical IDs across repeated reads of the same file.
2. A live `item-N` delta for an agent message merges with the later disk-projected legacy agent row.
3. A command output delta using `call_id` merges with the disk command item.
4. Compaction live event and disk compacted row merge when no durable compaction ID exists.
5. Work details do not return duplicate item IDs when source rows or overlay contain duplicate aliases.
6. `workItem` invalidations use canonical IDs.
7. Rollback removes/prunes resolver state for hidden turns.

## Main Risk

The hardest case is assigning live legacy ordinals before disk has caught up. The design assumes live event order for a given item kind matches the eventual disk projection order for that kind within a turn.

That assumption is already mostly implicit in the current streaming model. The reconciler makes it explicit and testable.

If that assumption fails for a specific event type, that event type should use a stronger durable source key, such as `call_id`, response item ID, or another event-specific identifier.
