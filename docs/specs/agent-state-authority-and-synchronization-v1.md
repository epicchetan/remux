Status: Active Spec — queue and Codex compaction authority slices implemented;
projection-fence and module-extraction passes remain
Last verified: 2026-09-05
Canonical code: `extensions/agent/shared/provider-runtime.ts`,
`extensions/agent/shared/native-agent-protocol.ts`,
`extensions/agent/server/src/native-runtime/`,
`extensions/agent/server/src/providers/`, and
`extensions/agent/viewer/src/{app,ipc,transcript}/`
Amends: `agent-native-provider-runtime-v1.md`,
`agent-canonical-turn-journal-v2.md`, and
`agent-composer-control-plane-v2.md`
Coordinates with: `agent-conversation-lineage-and-sidebar-tree-v1.md` and
`agent-transcript-ui-controller-v1.md`

# Agent state authority and synchronization v1

## Outcome

Remux Agent has one explicit admission boundary between commands/provider
observations and user-visible conversation history. Queue entries, failed
pre-dispatch commands, recovery probes, replayed provider controls, and other
operational facts cannot become transcript entries merely because they were
written to the same SQLite database or normalized into a provider event.

The provider remains authoritative for native conversation history and model
continuation. Remux remains authoritative for its command queue, conversation
lineage, and UI projection. A canonical Remux timeline contains only admitted,
identity-resolved facts. Provider snapshots reconcile that timeline; they are
not append operations.

The same transaction that changes a canonical UI fact advances a
server-generation-scoped projection revision and returns a typed change set.
One client synchronization controller consumes those revisions and change sets.
React actions do not independently orchestrate transcript, runtime, queue, and
history refreshes.

This is an ownership cleanup, not a new harness. Codex app-server and Claude
Code keep their prompts, context, tools, compaction, and native subagents. The
existing ordered turn model, bounded resources, transcript virtualizer, and UI
presentation remain.

## Production incident that makes the boundary concrete

The current long-running Codex conversation displayed three adjacent
`Compacted` rows at the transcript tail. The native provider did not perform
three new compactions there.

The durable database contains these pairs:

| Original provider fact | Original classification | Replayed at 23:05 | Replayed classification |
| --- | --- | --- | --- |
| Native control turn completed at 03:28 | manual compaction | same native turn with snapshot item `item-756` | new automatic compaction |
| Native control turn completed at 12:31 | manual compaction | same native turn with snapshot item `item-909` | new automatic compaction |
| Native control turn completed at 20:44 | manual compaction | same native turn with snapshot item `item-1253` | new automatic compaction |

All three replay rows were observed at the history-read time rather than their
native timeline positions. The projector therefore placed them together after
the latest completed Remux turn.

This is durable journal pollution, not a viewer cache or virtualizer defect.
The viewer rendered the rows it was given.

### Exact failure chain

1. A new Codex execution resumed or forked a native thread whose snapshot
   included older compaction-only native turns.
2. Remux supplied `inheritedNativeTurnIds` for ordinary Remux turns only.
   Compaction-only native turns have no `turns` row, so they were not in that
   inherited set.
3. Codex live item UUIDs are rewritten by `thread/read` as positional IDs such
   as `item-756`. The mapper correctly knows that item ID alone is unstable.
4. The mapper's otherwise stable occurrence identity still includes the
   current native session. A fork/resume execution has a different session, so
   the old occurrence received a new event ID.
5. The mapper had no pending manual command in the fresh process and therefore
   synthesized a new `codex-auto-compact-*` operation ID.
6. Snapshot coverage describes turn-block kinds only. It does not declare
   control-history coverage, ordering, or identity strength.
7. `appendProviderEvents`/`replaceSnapshot` admitted the normalized control with
   `INSERT OR IGNORE`. Uniqueness applied to the newly synthesized event and
   operation IDs, not to the underlying provider occurrence.
8. `conversation_control_events` is conversation-scoped but not strand-path
   scoped. Placement falls back to `created_at`, which was the replay time.

The queue ghost reported earlier is the same class of architecture failure at a
different ingress: a Remux command intent was inserted into `turns` and the
strand path before provider dispatch. Deleting the queue record removed only
the queue state, leaving the prematurely admitted transcript turn behind.

## Problems this spec owns

- Queue content appears in transcript history before dispatch and can survive
  queue deletion.
- A provider history read can append replayed or inferred controls as new
  conversation history.
- Pre-accept command failures can be modeled as failed turns even though the
  provider never accepted a turn.
- Snapshot time can accidentally become transcript chronology.
- Provider event sequence is used as a general UI-consistency clock even for
  Remux-owned mutations that emit no provider event.
- Broad invalidations lose whether order, layout, one turn, queue state, or
  metadata actually changed.
- Send, edit, stop, resume, and passive invalidation each have partially
  independent client refresh choreography.
- A dropped terminal invalidation can leave `Working` visible until a full
  refresh despite durable server state having changed.
- Protocol mismatch currently looks like stale content because the viewer can
  silently discard an invalidation envelope.

## Non-goals

- Replacing either provider's native context or agent loop.
- Replaying the Remux transcript to a model as provider history.
- Storing raw provider traffic indefinitely for speculative future UI.
- Replacing the transcript virtualizer or its deterministic layout model.
- Making every provider expose semantics it cannot prove.
- Hiding real provider failures that occurred after turn acceptance.
- Treating SQLite as the problem. One physical database is acceptable; the
  logical ownership and transaction boundaries are what must change.

## Normative invariants

1. **Persisted does not mean presentable.** A record may be durable command,
   queue, diagnostic, or observation state without being transcript history.
2. **No transcript fact exists before admission.** Creating a command receipt,
   reserving a future turn ID, or starting a delivery attempt cannot create a
   `turns` row or strand timeline entry.
3. **Provider acceptance is the send boundary.** A queued message moves from
   the composer queue to transcript exactly once when provider acceptance or an
   identity-equivalent native event proves the turn exists.
4. **Snapshots reconcile; they do not append.** A snapshot candidate must
   resolve canonical identity and branch membership before it may insert or
   revise a timeline fact.
5. **Weak identity cannot create visible history.** An ambiguous snapshot fact
   may be retained as bounded diagnostic evidence, but is quarantined from the
   canonical timeline.
6. **Canonical identity survives process and branch changes.** Current adapter
   session ID, current Remux execution ID, replay time, and mutable snapshot
   item ID are not identities for inherited provider facts.
7. **Chronology is structural.** Native order and the Remux strand path place
   timeline entries. `observedAt`, `created_at`, and hydration time are never
   historical ordering authorities.
8. **A pre-accept failure is not a failed turn.** It belongs to the command or
   queue delivery attempt. A post-accept provider failure is a terminal turn
   fact and remains visible.
9. **One mutation, one revision.** Every committed UI-visible change advances
   `projectionRevision`, including queue, stop intent, branch, metadata, and
   local recovery changes that have no provider event.
10. **The client converges from resources.** Push messages describe what became
    stale; they do not themselves become transcript truth.
11. **The journal rejects invalid admission.** Callers cannot bypass identity,
    branch, and authority checks by invoking a generic append method.
12. **Corrective migration is explicit.** Previously invalid experimental rows
    may be removed from canonical paths after a backed-up, deterministic audit;
    their command receipts or bounded repair audit remain.

## Authority map

| State | Owner | Durable home | Transcript-visible? |
| --- | --- | --- | --- |
| Native context, continuation, tools, native children, compaction decision | Provider | Provider session/history | Only through admitted display facts |
| Command idempotency and result | Remux coordinator | Command ledger | No |
| Pending message/compact FIFO | Remux coordinator | Operation queue | Composer/runtime only |
| Delivery attempts and ambiguity | Remux coordinator | Command ledger | No, until native acceptance is proven |
| Conversation, strand, edit/fork topology | Remux coordinator | Conversation topology | Indirectly |
| Accepted user turn and provider output | Provider fact admitted by Remux | Canonical timeline/journal | Yes |
| Manual stop request | Remux coordinator | Runtime operation state | `Stopping`, but not a transcript message |
| Provider terminal result | Provider | Canonical turn terminal | Yes |
| Usage and account limits | Provider observation | Current usage snapshots | Runtime/composer only |
| Provider health and session recovery | Coordinator + provider | Runtime state/diagnostics | Status UI only |
| Raw/unknown provider payload | Neither UI contract | Bounded diagnostic quarantine, if retained | Never |
| Resource hashes and projection revision | Remux projector | Projection metadata | Protocol only |
| Scroll, work disclosure, draft, selection | Viewer | Client session/cache, except durable draft policy | Never journal content |

## Logical stores

These are logical repositories and may share one SQLite file. Their APIs and
foreign keys must preserve the boundary.

### 1. Command ledger

Owns idempotent user and coordinator intent:

```ts
type CommandRecord = {
  commandId: string;
  kind: 'message.send' | 'message.edit' | 'turn.stop' | 'conversation.compact' | string;
  state: 'claimed' | 'accepted' | 'failed' | 'delivery-unknown';
  result?: JsonValue;
  error?: DisplaySafeError;
};
```

The command ledger never owns transcript order. Reissuing a command ID returns
its durable result; it does not repeat side effects.

### 2. Operation queue

Owns pending user work independently of provider history:

```ts
type QueueEntry = {
  queueEntryId: string;
  commandId: string;
  conversationId: string;
  kind: 'message' | 'compact';
  proposedTurnId?: string;
  payload: BoundedQueuePayload;
  state: 'queued' | 'dispatching' | 'delivery-unknown' | 'failed';
  ordinal: number;
  createdAt: number;
};
```

`proposedTurnId` is an idempotency reservation, not a foreign key to `turns`.
Removing a queued entry cannot require updating transcript tables because no
transcript row exists yet.

### 3. Provider observation inbox

An observation is untrusted reconciliation input, not a semantic fact. The
normal path may process it transactionally without retaining its raw body. If
retained for diagnostics, it is bounded and explicitly separate:

```ts
type ProviderObservation = {
  observationId: string;
  providerInstanceId: string;
  source: 'live' | 'authoritative-snapshot' | 'session-local-snapshot';
  sourceGeneration: string;
  observedAt: number;
  boundedMetadata: JsonValue;
  disposition: 'admitted' | 'duplicate' | 'quarantined' | 'ignored';
};
```

Unknown events, parse failures, stale replays, and ambiguous identities end
here. A diagnostic row is not joined by the transcript projector.

### 4. Canonical timeline journal

Owns facts proven safe for presentation and recovery:

- admitted root/user turns;
- ordered assistant passes and blocks;
- accepted provider terminal outcomes;
- canonical conversation controls;
- native/federated child links; and
- stable provider-subject aliases used for reconciliation.

The current separate `strand_turn_path` is insufficient for controls. The
target is one ordered path whose entries can be either turns or controls:

```ts
type TimelineEntry = {
  timelineEntryId: string;
  conversationId: string;
  kind: 'turn' | 'control';
  subjectId: string;
  providerSubjectKey?: string;
};

type StrandTimelinePathEntry = {
  strandId: string;
  ordinal: number;
  timelineEntryId: string;
  relation: 'local' | 'inherited';
  sourcePathEntryId?: string;
};
```

Controls therefore inherit through edit/fork paths just like turns and retain
their exact position. They are not selected conversation-wide and placed by
timestamps.

### 5. Materialized resources

Turn passes, turn blocks, transcript windows, runtime summaries, queue views,
history cards, and operation details are rebuildable read models. They expose
only canonical state plus intentional runtime/queue state. They never scan the
observation inbox to discover UI rows.

## Admission pipeline

There is one server-side entry point for any provider or command fact:

```text
command or provider observation
            |
            v
  parse + bound + classify source
            |
            v
 provider-specific identity resolution
            |
            v
 branch/range membership resolution
            |
            v
 authority + lifecycle admission policy
            |
       +----+----+
       |         |
       v         v
 canonical    duplicate / ignore /
 mutation     diagnostic quarantine
       |
       v
 transaction: facts + materialized state + projection revision
       |
       v
 typed resource change set
```

The journal API accepts an `AdmissionPlan`, not arbitrary provider envelopes.
Provider adapters may normalize candidates, but only the coordinator/reconciler
may resolve them against durable command, session, execution, and strand state.

An admission plan is validated before the transaction:

- source authority is declared;
- canonical provider subject is durable or has an explicit provisional owner;
- conversation/execution scope matches server state;
- branch membership and timeline position are known for timeline entries;
- lifecycle transition is legal;
- payload is bounded and display-safe; and
- the expected projection revision still matches, or the plan is rebuilt.

## Provider subject identity

Normalized event ID and canonical subject ID are different concepts.

```ts
type ProviderSubject = {
  provider: ProviderKind;
  kind: 'turn' | 'block' | 'control' | 'child';
  key: string;
  strength: 'durable' | 'provisional';
  aliases: readonly string[];
};
```

- An event ID deduplicates one delivery of one lifecycle revision.
- A subject key identifies the provider entity revised by many deliveries.
- Aliases reconcile live UUIDs with snapshot positional IDs.
- A provisional subject may update only its owning active operation. It cannot
  create historical transcript state during passive hydration.
- Replay-stable lifecycle envelopes remain idempotent, while an authoritative
  running snapshot may reassert execution state after recovery. Transport or
  native-session binding by itself never declares an execution idle.

The database enforces uniqueness on `(provider_instance_id, subject_kind,
subject_key)`. It separately stores aliases with their source generation. A new
event ID for an existing subject revises that subject; it cannot create another
turn/control.

## Snapshot contract v2

The current `turnBlocks.completeKinds` coverage is too narrow. Each snapshot
declares coverage by domain:

```ts
type ProviderSnapshotCoverageV2 = {
  turns: {
    range: 'full-branch' | 'tail' | 'session-local';
    order: 'exact' | 'partial';
  };
  blocks: {
    completeKinds: readonly TurnBlockKind[];
  };
  controls: {
    coverage: 'complete' | 'partial' | 'none';
    order: 'exact' | 'partial' | 'unknown';
    identity: 'durable' | 'occurrence' | 'unknown';
  };
  runtime: 'authoritative' | 'session-local';
};
```

Reconciliation stages the complete snapshot into a temporary in-memory plan,
resolves it against the existing provider subjects and strand path, and then
commits atomically. The snapshot's native order—not iteration time—sets path
order. Absence deletes or supersedes canonical state only for a domain and
range declared complete.

An authoritative snapshot may discover an old fact that Remux has never seen.
It may admit that fact only when durable identity, exact branch membership, and
exact structural position are available. Otherwise it remains provider-owned
history and is not invented as a Remux timeline row.

## Codex mapping rules

Codex `thread/read` is the authoritative current native branch. Its `turns[]`
array is structural order. A new mapper for a fork or resumed execution must
not treat inherited array entries as newly observed current-execution events.

- Visible turn subject: provider instance + native turn ID.
- Block subject: native turn subject + stable native item identity; when Codex
  rewrites item IDs, the adapter uses the tested item-kind/occurrence alias
  rules within that native turn.
- Inline compaction subject: native turn ID + `contextCompaction` occurrence.
- Compaction-only turn subject: native control turn ID +
  `contextCompaction` occurrence.
- Current native thread/session ID is branch membership, not part of an
  inherited subject's canonical identity.
- Snapshot IDs such as `item-756` are aliases and never operation IDs.
- A provider control turn in the inherited prefix links the existing canonical
  control into the new strand path. It does not create a new operation.
- A snapshot automatic classification cannot overwrite an existing
  command-backed manual classification for the same provider subject.

The retained `extensions/codex` implementation is useful evidence here: it
projects the authoritative raw native turns and merges live compaction items by
occurrence before presentation. Agent should retain its provider-neutral
journal, but must adopt that distinction between raw snapshot reconciliation
and visible transcript append.

## Claude mapping rules

Claude's adapter must declare what its historical reader can prove rather than
pretend it has Codex-equivalent control history.

- User/assistant message identity comes from durable Claude session/message
  identity when available.
- Live content-block identity remains message ID + block position/type under
  the existing reconciliation rules.
- Native tool and subagent facts are admitted only with an owning accepted
  turn/execution.
- If the historical reader cannot prove compaction identity and exact placement,
  compaction coverage is `none` or `unknown`; no visible `Compacted` row is
  synthesized.
- A resumed SDK handshake, iterator close, stderr line, or process exit is
  runtime evidence, not a transcript message.
- A Claude result that proves an accepted turn's terminal outcome may close
  that turn; a pre-accept SDK failure remains a command failure.

This fail-closed asymmetry is intentional. Provider-neutral UI does not require
false provider-semantic parity.

## Message queue lifecycle

```text
composer draft
     |
     | Send while busy
     v
durable queue entry  ---- delete ----> removed (no history)
     |
     | lane claim
     v
dispatching entry
     |
     +---- rejected before acceptance ----> queue failure (no turn)
     |
     +---- ambiguous delivery ------------> reconcile; never blind retry
     |
     `---- provider acceptance / matching native turn
                    |
                    v
          atomic transcript admission
          - create canonical turn
          - append strand timeline entry
          - bind provider native turn
          - remove queue entry
          - advance projection revision
```

Provider events may race ahead of the command response. The coordinator may
hold them in a bounded dispatch staging buffer keyed by the delivery attempt.
The first valid acceptance proof atomically admits the turn and drains staged
events. Staging is not transcript history.

For delivery-unknown, the provider snapshot is searched using the client
message/native command identity. If found, admission proceeds once. If absence
is authoritative, the queue entry becomes failed/retryable. If absence cannot
be proved, Remux surfaces the ambiguity and does not automatically duplicate a
potential provider turn.

`useConversationActions.send` branches on the command result:

- queued: update the queue resource; do not track or wait for a transcript turn;
- accepted: hand the returned projection fence to the sync controller; and
- failed/delivery-unknown: render command/queue state without fabricating a
  user bubble.

## Stop lifecycle

Stop intent is server state:

```text
running -> interrupt-requested -> interrupted | failed | completed
```

The command transaction records `interrupt-requested` and advances projection
revision before invoking the adapter. The composer derives `Stopping` from the
runtime resource rather than a local React promise. Provider terminal evidence
closes the turn. A bounded reconciliation watchdog reads authoritative provider
state if terminal evidence does not arrive; it never declares interruption
solely because the stream closed.

## Edit and fork lifecycle

Edit/fork creates a new strand/execution topology under one coordinator
transaction. Provider branch creation then reconciles the destination native
snapshot against inherited canonical subject identities.

- Inherited turns and controls link through `strand_timeline_path`.
- A replay from the destination provider thread cannot create another semantic
  copy of an inherited subject.
- The old render snapshot stays visible while the new revision-fenced snapshot
  is prepared.
- Resource, layout, disclosure, and viewport state swap atomically at the
  accepted destination projection revision.
- Hydration failure leaves the old snapshot visible with an actionable error;
  it does not partially replace the transcript.

## Projection revision and typed changes

Provider event sequence remains useful for provider ordering and diagnostics,
but it is not the UI consistency clock.

Every UI-visible transaction increments a conversation-scoped monotonic
`projection_revision`. Resource reads, command results, and invalidation pushes
carry:

```ts
type ProjectionFence = {
  serverGeneration: string;
  conversationId: string;
  projectionRevision: number;
};
```

The transition returns a typed change set:

```ts
type AgentResourceChange =
  | { type: 'queue.changed'; conversationId: string }
  | { type: 'runtime.changed'; conversationId: string }
  | { type: 'transcript.order-changed'; conversationId: string }
  | { type: 'transcript.turn-changed'; conversationId: string; turnId: string; layout: boolean }
  | { type: 'transcript.turn-terminal'; conversationId: string; turnId: string }
  | { type: 'conversation.metadata-changed'; conversationId: string }
  | { type: 'execution.changed'; conversationId: string; executionId: string };
```

There is no broad `invalidateConversation()` that always invalidates history,
runtime, queue, and transcript. The server translates typed changes into exact
resource keys. Streaming one block cannot refresh conversation history on
every checkpoint.

Protocol mismatch is explicit. If the viewer cannot parse the server's
invalidation protocol version, it enters `restart-required`/`incompatible`
state and performs a bounded control-resource probe. It never silently returns
an empty invalidation envelope.

## One client synchronization controller

One conversation-scoped controller accepts:

```ts
type SyncIntent =
  | { type: 'conversation-selected' }
  | { type: 'command-accepted'; fence: ProjectionFence; changes: AgentResourceChange[] }
  | { type: 'resources-invalidated'; fence: ProjectionFence; changes: AgentResourceChange[] }
  | { type: 'viewer-resumed' }
  | { type: 'server-generation-changed'; generation: string };
```

It owns request generation, single-flight reads, trailing reads, cadence, cache
dirtying, and fence satisfaction:

- order change supersedes individual turn refreshes;
- terminal turn refresh is immediate;
- streaming turn changes use the bounded paint cadence;
- queue-only changes do not read transcript;
- metadata-only changes do not read transcript;
- an invalidation received during an active read remains pending and triggers a
  trailing read if its revision is newer;
- inactive conversation caches are marked dirty without mounting or focusing
  them;
- a command completes in UI terms when the returned fence is observed, not
  after an arbitrary `Promise.all` of stores; and
- server-generation replacement rejects old responses and performs one
  deterministic recovery read.

The transcript UI controller and virtualizer remain downstream. They receive
one atomic transcript render snapshot and do not know whether it came from send,
edit, stop, hydration, push invalidation, or resume.

## Schema direction

The implementation should introduce or evolve the following logical tables:

```text
command_receipts
operation_queue                 -- no FK to canonical turns
delivery_attempts

provider_subjects               -- unique stable subject keys
provider_subject_aliases        -- live/snapshot identity aliases
provider_observations           -- optional bounded diagnostics only

timeline_entries                -- turn or control
strand_timeline_path            -- exact local/inherited order
turns
turn_events / passes / blocks
conversation_controls

conversation_projection_state   -- projection_revision
```

Exact SQL may retain current table names where constraints and repository APIs
enforce the same semantics. A generic `appendProviderEvent(s)` method must not
remain callable by the coordinator after cutover.

## Existing-data repair

The schema migration includes an audited repair, not an unbounded heuristic.
It first creates a database backup and a dry-run report with row IDs and counts.

### Safe queued-turn repair

A turn is removable from canonical history only when all are true:

- it was created for a queue entry under the affected schema version;
- provider dispatch was never accepted;
- `started_at` and native turn binding are absent;
- it has no provider events, passes, blocks, artifacts, or child executions;
- no accepted descendant path depends on it; and
- the queue/command record proves cancellation or pending ownership.

The repair removes its strand path entry and turn materialization while
retaining the command/queue record required by its actual state.

### Safe compaction repair

Compaction controls are grouped by resolved provider subject, not current
operation ID. For the current Codex incident, native control turn ID plus
compaction occurrence proves the three snapshot rows alias the three earlier
manual controls.

- Prefer a command-backed manual operation as the canonical operation.
- Retain the snapshot item ID as an alias/diagnostic, not another control.
- Link the one canonical control into each strand where the provider snapshot
  proves it is present.
- Use provider structural order for its boundary.
- Delete the duplicate canonical control/materialization and synthetic
  automatic operation only after all references are accounted for.

Ambiguous historical rows are excluded from presentation and reported for
manual review; the migration does not merge them by timestamp or label text.

### Repair audit

The migration records:

- schema/source version;
- backup path or backup identifier;
- candidate and repaired counts by class;
- canonical and removed IDs;
- foreign-key and path-order checks; and
- completion timestamp.

## Module ownership after extraction

The current coordinator, journal, projector, and transcript resource store are
too large for their mixed responsibilities. The target server structure is:

```text
native-runtime/
  command-ledger.ts             command claim/result only
  operation-queue.ts            queue lifecycle and dispatch claims
  delivery.ts                   provider acceptance and ambiguity
  admission.ts                  policy and transaction plans
  provider-subjects.ts          canonical identity and aliases
  snapshot-reconciler.ts        coverage-aware reconciliation
  timeline.ts                   strand turn/control path
  turn-lifecycle.ts             accepted turn transitions
  interruption.ts               stop intent and reconciliation
  conversation-branching.ts     edit/fork topology
  projection-revision.ts        fences and typed change sets
  resource-projector.ts         bounded read models only
```

Provider adapters keep wire-format parsing and provider-specific candidate
identity extraction. They do not write SQLite or decide Remux branch ownership.

The target viewer structure adds one `conversationSyncController` above the
existing resource store and transcript UI controller. Hooks issue commands and
render state; they do not coordinate resource races.

## Implementation sequence

### Pass 0 — characterize and freeze the incidents

- Add a Codex fixture that replays one manual compaction through a different
  fork/resume session with a rewritten snapshot item ID.
- Add the three-control production pattern: three historical controls arrive in
  one snapshot and must not appear at the tail.
- Add a queue fixture proving a pending/deleted entry never enters transcript.
- Add pre-accept failure, stop-with-missed-push, and invalidation-during-read
  fixtures.

### Pass 1 — authority foundation

- Add projection revision/fence and typed change contracts.
- Add provider subject/alias and timeline-entry/path schema.
- Add the admission and snapshot-reconciliation repositories.
- Make control coverage explicit in the provider contract.
- Retain compatibility reads while new writes go only through admission.

### Pass 2 — queue vertical slice

- Remove the queue-to-turn foreign-key requirement.
- Reserve proposed turn identity in the queue only.
- Add dispatch staging and atomic acceptance admission.
- Branch viewer send behavior for queued versus accepted results.
- Migrate/repair safe queue ghosts.

### Pass 3 — compaction and history vertical slice

- Implement Codex control occurrence identity independent of current session.
- Carry native snapshot order into strand timeline paths.
- Make Claude control coverage fail closed.
- Reconcile rather than append authoritative history snapshots.
- Repair proven duplicate compactions, including the current three-row case.

### Pass 4 — runtime mutations and synchronization

- Move stop to durable `interrupt-requested` state with reconciliation.
- Move edit/fork to revision-fenced atomic projection swaps.
- Replace broad invalidation with typed changes.
- Introduce the single client synchronization controller.
- Remove action-specific forced refresh choreography.

### Pass 5 — extraction and compatibility removal

- Split coordinator/journal/projector/store by the ownership map above.
- Remove generic append and old basis-sequence UI gating.
- Remove compatibility tables/APIs after migration and soak verification.
- Update the older specs from implementation evidence.

## Required acceptance tests

### Queue and commands

- A queued message survives server restart and WebView destruction while
  remaining absent from transcript.
- Deleting it produces no turn, path entry, event, pass, block, or history card.
- Dispatch moves it from queue to transcript exactly once.
- A provider event racing ahead of the command response still creates one turn.
- Pre-accept rejection creates no turn.
- Delivery-unknown never blindly resends and converges when a later snapshot
  proves presence or authoritative absence.

### Snapshot and journal admission

- Replaying the same snapshot in one process, after restart, and under a new
  execution is idempotent.
- Rewritten snapshot item IDs resolve as aliases without duplicating subjects.
- An ambiguous historical candidate is quarantined and never rendered.
- Unknown provider events and recovery diagnostics never become generic rows.
- Rebuilding materialized state from admitted canonical facts produces the
  same resource hashes and order.

### Compaction and branches

- One live manual compaction replayed from a fork snapshot remains one manual
  control.
- Three inherited manual compactions retain their original structural
  positions and never appear as three new automatic tail rows.
- Two genuine automatic compactions in one native turn remain two distinct
  occurrence subjects.
- An inherited control appears once on each applicable strand path without
  duplicating its semantic record.
- Claude creates no compaction row when its reader cannot prove identity and
  placement.

### Projection and client convergence

- Every queue, runtime, topology, control, turn, and metadata mutation advances
  projection revision once.
- Duplicate and out-of-order invalidations converge.
- An invalidation arriving during a read schedules the required trailing read.
- Streaming one turn does not refresh conversation history.
- Stop stays `Stopping` across viewer reload until provider terminal evidence.
- Missing terminal push converges through server reconciliation.
- Edit/fork swaps transcript topology without blanking or viewport movement.
- Protocol mismatch shows an explicit restart/incompatible state.

### Existing UI behavior

- Deterministic collapsed heights and expanded overlays remain unchanged.
- Initial placement, Up/Down user-message navigation, bottom follow, manual
  scroll ownership, attachments, and compaction-row measurement retain their
  existing browser coverage.
- Running work auto-opens unless manually closed; historical work remains
  closed by default.

## Exit criteria

1. No command, queue item, provider replay, diagnostic, or recovery probe can
   become transcript history without passing the admission policy.
2. The current three duplicate `Compacted` rows are deterministically repaired
   and cannot recur after restart, fork, edit, or hydration.
3. Provider snapshots are coverage-aware, branch-aware reconciliation inputs.
4. Queue deletion and pre-accept failure leave no transcript residue.
5. All UI-visible server mutations use projection revision and typed changes.
6. One client controller owns convergence; React action hooks no longer force
   unrelated resource refreshes.
7. Codex and Claude retain native harness behavior and honestly expose only the
   history each can prove.
8. The retained virtualizer receives coherent canonical snapshots and keeps
   current transcript usability parity.
