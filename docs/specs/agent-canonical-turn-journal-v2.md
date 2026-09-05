Status: Implemented in working tree — automated and installed Codex/Sol plus
Claude/Fable desktop/mobile-WebView acceptance pass; physical-mobile acceptance
pending
Last verified: 2026-09-02
Canonical code: `extensions/agent/shared/provider-runtime.ts`,
`extensions/agent/shared/native-agent-protocol.ts`,
`extensions/agent/server/src/native-runtime/native-journal.ts`,
`extensions/agent/server/src/native-runtime/native-projector.ts`,
`extensions/agent/server/src/providers/`, and
`extensions/agent/viewer/src/nativeTranscriptViewModel.ts`
Amends: `agent-native-provider-runtime-v1.md`
Coordinates with: `agent-composer-control-plane-v2.md`
Amended by: `agent-state-authority-and-synchronization-v1.md`, which supersedes
the generic append-only admission model, timestamp-based control placement,
and provider-event-sequence UI fencing while retaining ordered turns, passes,
blocks, and bounded transcript resources.

# Agent canonical turn journal v2

## Outcome

The Agent runtime keeps its durable coordinator and append-only semantic
journal, but replaces the current lossy turn buckets with one ordered,
provider-neutral turn structure. Codex and Claude map their native events into
stable assistant passes and blocks without replacing either provider's prompt,
tool loop, context, compactor, or same-provider subagent system.

The data contract fixes the source of ordering defects such as a Claude command
appearing after the thinking that preceded it. Usage, compaction, native
children, and federated children have explicit scopes instead of being forced
into one turn-shaped record. The viewer now consumes that order directly while
retaining the existing virtualizer, disclosure components, and mobile scroll
ownership.

## Why this revision is required now

The Version 1 journal already provides valuable properties:

- command receipts are durable and separate from provider events;
- semantic events are deduplicated by stable event identity;
- events survive WebView destruction and Agent-server restart; and
- the server, rather than a mounted viewer, owns reconciliation.

The Version 1 projector then loses provider order. It reduces a turn into one
reasoning string, one commentary string, and maps of operations and children.
The viewer reconstructs a fixed display order of reasoning, commentary, then
actions. That shape cannot represent either of these valid native sequences:

```text
thinking A -> tool A -> thinking B -> tool B -> final
commentary A -> native child -> commentary B -> final
```

Claude makes the defect visible sooner because streamed thinking arrives from
`content_block_delta`, while `tool.started` is currently delayed until the
completed assistant message is inspected. Codex exposes stronger item identity
and lifecycle events, but flattening those events into Version 1 buckets still
throws away information the native harness supplied.

Compaction makes this a contract problem rather than a cosmetic transcript
problem. A compact boundary, usage snapshot, tool still running in the
background, and an assistant pass are different kinds of state. We should
establish those scopes before adding durable Compact controls and usage state.

## Current implementation baseline

As of the verification date, the current working tree is at this boundary:

| Area | Current state |
| --- | --- |
| Native provider runtime | Version 3 Codex and Claude adapters, coordinator, journal, resources, and scoped MCP federation are present. |
| Provider/runtime contract | Strict Version 3 account/conversation/turn/execution scopes, ordered block events, native reasoning parts, and transient exact diffs are enforced at ingress. Version 2 envelopes remain readable for durable history. |
| Native viewer protocol | Version 4 self-contained turn frames expose ordered passes and blocks while retaining the existing virtualizer. |
| Journal schema | Version 5 materializes ordered passes, blocks, controls, preferences, usage, and command receipts. |
| Transcript projection | Native order is retained; uncertain migrated history is explicitly labeled `legacy-grouped`. |
| Claude tool ordering | Tool blocks begin at native content-block start and reconcile in place from later SDK messages. |
| Codex phase reconciliation | Phase-less agent-message deltas and later commentary/final item snapshots share native item identity and reconcile into one block. |
| Usage and plan limits | Context usage is projected on runtime and account usage on provider-instance resources. |
| Composer selection | Provider/access are first-class, model/effort preferences are server-owned, and missing target state fails closed. |
| Agent Compact | Codex keeps native auto/remote behavior and manual RPC; Claude root sessions use supported native manual `/compact` with Remux auto/precompute disabled. |
| Federated child rediscovery | `remux_list_agents` and the five mutation/wait tools use the same bounded credential lineage. |
| Version 2 presentation | Ordered pass/block rendering is implemented on the existing virtualizer; the terminal answer remains outside the work trace. |
| Reasoning and edit detail | Provider-native reasoning-part boundaries survive projection; exact diffs are content-addressed artifacts loaded only after disclosure. Metadata-only edits have no false disclosure affordance. |

Passes 1–4 below and composer passes 0–4 are implemented. Automated server,
unit, desktop-viewer, and mobile-viewer acceptance pass. Fresh
subscription-authenticated Codex/Sol and Claude/Fable conversations also pass
real create, native tool, ordered projection, follow-up, context/plan usage,
configuration, history, and desktop/mobile-WebView geometry checks. The
remaining exit work is physical-phone suspend/restore acceptance.

## Scope

This version owns:

- event scopes for account, conversation, turn, and execution state;
- stable provider identity, deduplication, and ordering rules;
- ordered root turns, assistant passes, and display-safe blocks;
- tool and child lifecycle updates against stable blocks;
- live-stream checkpoints and authoritative snapshot reconciliation;
- conversation-level compaction and other control boundaries;
- runtime and account usage placement;
- restart, mobile-resume, and multi-viewer projection behavior;
- an explicit compatibility projection for Version 1 history; and
- bounded rediscovery of cross-provider children after native compaction.

The following are out of scope:

- replacing Codex app-server or the Claude Agent SDK with a common model loop;
- rewriting provider prompts, tool definitions, approvals, or native history;
- extracting, reconstructing, or storing hidden chain-of-thought;
- making provider-native child agents use Remux federation;
- copying the complete parent transcript into a federated child;
- a transcript visual redesign, new virtualizer, or final compact meter UI;
- persisting raw, unbounded provider protocol objects as the public contract;
- treating timestamps as transcript order; and
- guaranteeing exact order for legacy rows whose Version 1 projection already
  discarded it.

## Normative principles

1. Native harnesses remain authoritative for model execution. Remux normalizes
   observation and control; it does not recreate their agent loops.
2. Provider order is data. The projector may not regroup blocks by visual type.
3. A tool's start fixes its place in the turn. Progress and completion update
   that same block; they do not create a later replacement action.
4. Stable native identity wins over arrival time. `observedAt` is diagnostic
   metadata and is never the primary ordering key.
5. The durable semantic journal is append-only. Materialized read models may be
   updated transactionally and rebuilt from that journal.
6. Terminal native snapshots are authoritative and reconcile existing stable
   blocks. They do not append a second copy of the turn.
7. Only provider-designated display-safe reasoning summaries are journaled.
   Encrypted thinking and hidden chain-of-thought are not transcript content.
8. Root turns, conversation controls, account limits, and independent child
   executions have different scopes and remain different records.
9. A provider-specific fact may be preserved as bounded metadata, but the
   shared contract never claims false semantic parity.
10. Version 1 history with unknown order is labeled honestly rather than
    rendered as if the reconstructed grouping were exact.

## Version boundary and ownership

This work shares the coordinated hard cut defined by the composer control-plane
spec:

- `PROVIDER_RUNTIME_CONTRACT_VERSION = 3`;
- `NATIVE_AGENT_PROTOCOL_VERSION = 4`; and
- `NATIVE_AGENT_SCHEMA_VERSION = 6`.

This spec owns the Version 2 event envelope, ordered turn model, structural
journal migration, and compatibility projection. The composer spec owns
provider/model/effort/access preferences, normalized usage values, Compact
commands, and composer capability semantics. Both land in one schema migration
and one protocol cut; neither creates an intermediate public Version 2 shape.

## Scope-aware provider event envelope

Version 1 requires conversation and execution identity even for state that is
not conversation-scoped. Version 2 uses a discriminated scope:

```ts
type ProviderEventScope =
  | {
      kind: 'account';
      providerInstanceId: ProviderInstanceId;
    }
  | {
      kind: 'conversation';
      providerInstanceId: ProviderInstanceId;
      conversationId: ConversationId;
      executionId: ExecutionId;
    }
  | {
      kind: 'turn';
      providerInstanceId: ProviderInstanceId;
      conversationId: ConversationId;
      executionId: ExecutionId;
      turnId: TurnId;
    }
  | {
      kind: 'execution';
      providerInstanceId: ProviderInstanceId;
      conversationId: ConversationId;
      executionId: ExecutionId;
      parentExecutionId?: ExecutionId;
      rootTurnId?: TurnId;
    };

type NativePosition =
  | {
      kind: 'native-sequence';
      sequence: number;
      subIndex: number;
    }
  | {
      kind: 'message-block';
      messageId: string;
      blockIndex: number;
      subIndex: number;
    }
  | {
      kind: 'snapshot-index';
      itemIndex: number;
      subIndex: number;
    };

type ProviderEventEnvelopeV3 = {
  contractVersion: 3;
  eventId: string;
  provider: ProviderKind;
  scope: ProviderEventScope;
  native: {
    sessionId?: string;
    turnId?: string;
    messageId?: string;
    itemId?: string;
    toolCallId?: string;
    kind: string;
    position?: NativePosition;
  };
  observedAt: number;
  event: ProviderEventV3;
  rawArtifactRef?: string;
};
```

The union is strict:

- plan/rate-limit usage uses `account`;
- session binding, health, preference changes, and compact boundaries use
  `conversation`;
- user input, assistant blocks, turn usage, and turn terminal state use `turn`;
- native and federated child lifecycle uses `execution`.

An event kind declares its permitted scope in the parser. An account event may
not smuggle in a conversation ID, and a turn block may not omit one.

`eventId` is based on stable provider identity whenever the provider supplies
it. A process-local adapter counter is never sufficient. Journal sequence is a
durable Remux arrival order and may break ties while a live turn is provisional;
it is not allowed to override an authoritative native position or snapshot.

## Canonical conversation and turn model

A conversation contains root turns, independently addressable child
executions, and conversation-control events. It is not one flat sequence of
everything that happened in the process.

```ts
type CanonicalTurn = {
  turnId: TurnId;
  executionId: ExecutionId;
  nativeTurnId: string | null;
  state: 'queued' | 'running' | 'recovering' | 'completed' | 'failed' | 'interrupted';
  input: readonly UserContentPart[];
  inputSubmittedAt: number;
  ordering: 'native-exact' | 'live-provisional' | 'legacy-grouped';
  passes: readonly AssistantPass[];
  finalBlockId: BlockId | null;
  usage: TurnUsageSnapshot | null;
  terminal: TurnTerminal | null;
};

type AssistantPass = {
  passId: PassId;
  turnId: TurnId;
  nativeMessageId: string | null;
  ordinal: number;
  state: 'streaming' | 'completed' | 'reconciled';
  blocks: readonly TurnBlock[];
};

type TurnBlockKind =
  | 'reasoning-summary'
  | 'commentary'
  | 'tool'
  | 'native-child'
  | 'federated-child'
  | 'web'
  | 'final-message'
  | 'compatibility-notice';

type TurnBlock = {
  blockId: BlockId;
  passId: PassId;
  ordinal: number;
  kind: TurnBlockKind;
  state: 'streaming' | 'running' | 'completed' | 'failed' | 'interrupted';
  revision: number;
  payload: TurnBlockPayload;
  startedAt: number | null;
  completedAt: number | null;
};
```

### Turn

A root turn begins with one user submission and ends at the native provider's
terminal turn/result boundary. Queueing and command acceptance precede the
native turn but remain linked to it through the command receipt and `turnId`.
Provider-internal tool-result messages are not new Remux user submissions.

### Assistant pass

An assistant pass is one provider-native model response between tool-result
boundaries. For Claude it normally maps to one assistant message. For Codex it
maps to a native response segment or deterministic item group exposed by
app-server. The adapter may create a deterministic pass boundary only when the
native protocol exposes an equivalent model/tool boundary. The viewer does not
manufacture passes from block type.

If a provider supplies no meaningful pass boundary, the adapter uses one stable
pass for the turn and preserves exact block order inside it. Pass count is not
a cross-provider quality metric.

### Block

A block is the smallest independently ordered and updated transcript unit.
Block identity does not change as content streams or work progresses.

- `reasoning-summary` stores only provider-authorized summary/display content.
- `commentary` is non-final assistant text emitted during work.
- `tool` contains display-safe invocation, progress, terminal outcome, and
  bounded output preview or artifact reference.
- `native-child` is provider-owned same-provider work observed from the native
  harness.
- `federated-child` links the root turn to a separate Remux execution.
- `web` is a provider-native web/search activity not already represented as a
  generic tool.
- `final-message` is authoritative terminal assistant text and may occur only
  where the provider placed it.
- `compatibility-notice` is bounded user-relevant degradation, not a dump of an
  unknown provider event.

File changes attach to the responsible tool or child block when the provider
supplies that relationship. Unattributed native file changes remain a
turn-scoped side-effect list with native position; the viewer may group their
presentation later but may not move the associated operation.

## Structural event contract

The durable semantic events needed to materialize the turn are:

```ts
type TurnStructure = {
  passId: PassId;
  blockId: BlockId;
  passOrdinal: number;
  blockOrdinal: number;
};

type ProviderEventV3 =
  | SessionEventV2
  | TurnLifecycleEventV2
  | {
      type: 'turn.block.started';
      structure: TurnStructure;
      block: TurnBlockSeed;
    }
  | {
      type: 'turn.block.revised';
      structure: TurnStructure;
      revision: number;
      contentHash: string;
      patch: TurnBlockPatch;
    }
  | {
      type: 'turn.block.completed';
      structure: TurnStructure;
      revision: number;
      contentHash: string;
      block: TurnBlockTerminal;
    }
  | { type: 'turn.file-changed'; change: FileChangeDisplay; blockId?: BlockId }
  | { type: 'turn.usage-updated'; usage: TurnUsageSnapshot }
  | ContextCompactionEventV2
  | { type: 'account.usage-updated'; usage: AccountUsageSnapshot }
  | ExecutionLifecycleEventV2
  | { type: 'compatibility.notice'; code: string; message: string };
```

The checked-in types replace the illustrative aliases above with bounded,
strict records. Tool inputs, output previews, error messages, and text each
retain explicit size limits. Larger values are stored in the existing
content-addressed artifact store.

### Version 3 reasoning and exact-diff amendment

Version 3 adds structure and detail without changing the Version 2 ordering
model:

- a `reasoning-summary` payload may carry `parts`, preserving the provider's
  ordered summary-part boundaries; `text` remains the compatibility value and
  must equal `parts.join('\n')`;
- a provider-edge file change may transiently carry an exact unified `diff`;
- the coordinator seals that text in the content-addressed artifact store
  before append and persists only `diffArtifactId` in the journal; raw patches
  never inflate journal rows or transcript resources;
- Codex maps native `summaryPartAdded`/`summaryTextDelta` indices and native
  file-change patches directly;
- Claude captures bounded before/after content for successful native
  `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` calls and derives an exact
  diff when both sides are available; and
- changes for which the provider cannot prove an exact before/after image stay
  metadata-only. The viewer does not invent a diff or show an expandable row.

The viewer renders each reasoning part as its own Markdown block with one
bounded inter-part gap. This avoids interpreting every provider newline as an
independent paragraph while retaining deliberate Markdown within a part.
Diff artifacts are read lazily and in bounded UTF-8 ranges only after the user
opens the corresponding file row. Existing Version 2 journal entries remain
readable; an older metadata-only edit cannot be retroactively reconstructed.

### Revisions and streaming

The journal does not need one durable row per token. An adapter may accumulate
native deltas in memory, and the coordinator also coalesces cumulative text
revisions received in one bounded provider burst. It waits only inside a small
display-checkpoint window and never moves a structural or terminal event. Each
durable checkpoint is an immutable `turn.block.revised` event with:

- a block-local revision allocated transactionally by the coordinator;
- a hash of the complete bounded block state;
- the stable block identity and structure; and
- an optional native delta identity when available.

Identical state hashes deduplicate. A non-authoritative replay may not regress a
block to a shorter or older revision. A terminal native block or reconciled
snapshot may replace provisional state and marks the block authoritative. The
materialized row is mutable for efficient reads, but it is rebuildable from
immutable events.

Transient WebSocket delivery may be more granular than durable checkpoints.
After reconnect, the resource revision and materialized block replace any
client-only partial delta, so WebView suspension cannot permanently duplicate
or truncate content.

### Ordering

The projector orders blocks by authoritative `passOrdinal` and `blockOrdinal`.
While native order is incomplete, it uses the durable journal arrival ordinal
only within that provisional region. Reconciliation may correct provisional
ordinals but never changes block identity.

The following are forbidden as primary order:

- wall-clock or `observedAt` timestamps;
- block kind priority;
- map insertion order rebuilt from unrelated lifecycle updates; and
- completion time.

A tool that completes late stays at its start position. A background child that
finishes after the root final response updates its linked execution/block
status without moving the root turn's blocks.

## Provider mapping

### Codex app-server

The Codex adapter uses native thread, turn, item, and sequence identity.

- native turn start/terminal events own the root turn lifecycle;
- item start fixes the block position;
- reasoning summary items map to `reasoning-summary`;
- assistant text maps to commentary or final according to the native phase;
- command, MCP, web, file, and collaboration items map to stable operation or
  child blocks;
- a native turn whose item is `contextCompaction` maps only to a conversation
  control; it never creates an Agent user/assistant turn;
- item delta/progress/completion revises the block created at item start;
- an agent-message delta without a phase and its later commentary/final item
  snapshot share the native item block identity and reconcile in place; and
- the terminal thread/turn snapshot reconciles text, status, order, and missing
  terminal events without duplicating items.

Codex's provider-native automatic/remote compaction remains untouched. Compact
boundaries map to conversation-control events as defined below; they are not
synthetic tool items.

### Claude Agent SDK

The Claude adapter treats the semantic assistant message ID from
`message_start.message.id` as pass identity. Live content-block indices define
the provisional block positions, while finalized SDK snapshots reconcile text
and thinking by semantic-kind position because Claude may omit thinking and
renumber the remaining visible blocks. The SDK stream wrapper's outer `uuid`
is event-envelope identity only; it must never split or key assistant passes or
blocks.

- `content_block_start` creates text, thinking-summary, or tool blocks in the
  order Claude emitted them;
- `content_block_delta` revises the matching block;
- `input_json_delta` accumulates and backfills the matching tool block's input
  and presentation instead of creating another tool;
- `content_block_stop` completes the content block when appropriate;
- a `tool_use` block starts the tool immediately, not when a later completed
  assistant-message snapshot is processed;
- tool-result/system status events revise or complete that same tool block;
- the completed assistant message reconciles all block identities and content;
  it does not create a second set of tools;
- result messages own root turn completion, final text reconciliation, usage,
  context, and cost; and
- `rate_limit_event` maps to account scope rather than the active turn.

Claude thinking is stored only when the SDK exposes display-safe thinking or a
summary intended for the client. Encrypted thinking payloads and opaque resume
state remain adapter-private.

## Snapshot and recovery rules

Snapshots declare whether they are authoritative native reads or session-local
observations. Authoritative snapshots are reconciliation input, not transcript
append operations. Session-local snapshots are append/deduplication input only
and cannot prove that a durable turn is absent.

1. Restore the durable Remux-turn-to-native-turn bindings when a provider
   session resumes, then match sessions, turns, passes, items, content blocks,
   and tool calls using provider-native identifiers.
2. Upsert authoritative materialized state for the matching stable Remux IDs.
3. Append semantic reconciliation events only for new facts or changed
   authoritative revisions.
4. Seal native terminal text and outcomes only after the provider's terminal
   evidence is durable.
5. Mark an execution `recovering` while stream termination is ambiguous.
6. Never infer completion merely because an SDK iterator or child process
   ended.

On Claude resume, Remux passes the durable accepted-turn binding into the new
adapter process and keeps the turn recovering until the Agent SDK produces its
resume-handshake result. Claude Code can resume the session but cannot restore
an in-flight model invocation whose process ended. Remux therefore suppresses
the handshake assistant text, closes only that turn as `recovery_failed` from
the explicit native result, leaves the resumed session usable, and never
replays the user's prompt.

If a live block lacks native identity, the adapter gives it a session-scoped
provisional ID and must resolve it against the next authoritative snapshot
before sealing the turn. An unresolved provisional block is retained with a
compatibility notice; it is not silently merged with a nearby block based on
text alone.

## Conversation controls and compaction

Compaction is a conversation control boundary, not a user message, assistant
pass, tool, or boolean on the latest turn.

```ts
type ConversationBoundary =
  | { kind: 'between-turns'; afterTurnId?: TurnId; beforeTurnId?: TurnId }
  | { kind: 'within-turn'; turnId: TurnId; afterBlockId?: BlockId }
  | { kind: 'native-unknown'; nativeTurnId?: string };

type ConversationControlEvent = {
  controlEventId: string;
  conversationId: ConversationId;
  kind: 'compaction' | 'session-recovery' | 'session-transition';
  boundary: ConversationBoundary;
  state: 'started' | 'completed' | 'failed';
  operationId: string;
  nativeIdentity?: string;
  payload: BoundedControlPayload;
};
```

The composer control-plane spec defines the exact Compact lifecycle and queue
semantics. This journal supports multiple automatic and manual compactions per
conversation. It replaces `activity.compacted: boolean` and the Version 1
terminal-only `context.compacted` event.

A manual Compact queued behind an active root turn is anchored between that
turn and the next root operation when dispatched. A provider-native automatic
compact may have a native within-turn boundary. Neither form creates fake
assistant or tool blocks.

## Usage scope

Usage consumes the exact normalized records in the composer control-plane
spec, with these placement rules:

- immediate turn usage is turn-scoped and may be referenced by the canonical
  turn convenience field;
- current context consumption and context-window size are conversation runtime
  state derived from the newest valid provider sample;
- provider-query epoch totals remain conversation runtime state and are
  labeled with their epoch;
- subscription windows and reset times are account/provider-instance state;
- compaction changes context state but never plan usage; and
- usage updates do not become transcript blocks merely because they arrived
  between two content events.

## Native and federated child work

Same-provider native children remain owned by Codex collaboration or Claude's
Agent/Task system. Their observable lifecycle attaches to a `native-child`
block when the harness exposes a stable parent position. Remux does not alter
their context, cancellation, resumption, or compaction rules.

Cross-provider children remain independent provider sessions owned by the
Remux federation coordinator. The root receives a `federated-child` link at
the MCP tool-call position. Progress and terminal state update the linked child
execution; the child's own conversation keeps its own ordered turns.

Root compaction does not close, interrupt, or wait for a detached child.
Foreground children still occupy the root provider turn, so a queued manual
Compact dispatches only at the next root boundary.

### Federated child rediscovery

Native compaction may remove a model's recollection of an execution ID even
though the coordinator still owns the child. Version 2 therefore adds one
read-only federation tool:

```ts
remux_list_agents(input: {
  state?: 'active' | 'idle' | 'terminal' | 'all';
  limit?: number; // default 32, maximum 128
}): Promise<{
  agents: readonly {
    executionId: string;
    providerInstanceId: string;
    provider: ProviderKind;
    model: string | null;
    state: ExecutionState;
    scheduling: 'foreground' | 'background';
    access: 'read-only' | 'workspace-write';
    summary: string | null;
    canSendMessage: boolean;
    canWait: boolean;
    canInterrupt: boolean;
    canClose: boolean;
    createdAt: number;
    updatedAt: number;
  };
  truncated: boolean;
}>;
```

The bearer credential scopes the result to federated executions owned by the
current root execution lineage. The tool never lists unrelated conversations,
native same-provider children, child transcripts, hidden reasoning, provider
credentials, or raw resume state. Results are bounded, active work sorts first,
and the summary is the same bounded coordinator-owned status/final preview
already safe for the parent.

This tool restores an address, not context. It does not automatically inject
child state after compaction, wake the model, create a turn, or claim that the
parent remembers the brief. The parent may use the returned `executionId` with
the existing send, wait, interrupt, and close tools.

## Durable journal and materialized schema

Schema Version 5 retains the existing append-only `events`, command receipts,
conversations, turns, executions, and native-session bindings. It adds or
replaces rebuildable materialized structures equivalent to:

```text
turn_passes
  pass_id primary key
  turn_id, native_message_id, ordinal, state

turn_blocks
  block_id primary key
  turn_id, pass_id, kind, ordinal, state, revision
  payload_json, artifact_id, started_at, completed_at

conversation_control_events
  control_event_id primary key
  conversation_id, kind, boundary_json, state, operation_id
  native_identity, payload_json, created_at, completed_at

usage_snapshots
  provider_instance_id, conversation_id?, turn_id?, epoch?, scope
  payload_json, observed_at
```

Exact SQL may combine tables when constraints and query bounds remain
equivalent. The normative requirements are:

- immutable semantic events remain the replay source;
- stable provider identity has a uniqueness constraint;
- block revisions cannot regress;
- block and pass order are explicit integer fields, not JSON/map order;
- all materialized rows are rebuildable transactionally from the event log;
- a resource revision advances only after its corresponding transaction
  commits; and
- artifacts, raw diagnostics, and secrets do not leak into presentation JSON.

### Version 1 migration

The migration preserves every existing conversation, turn, execution, event,
command receipt, and native-session reference.

For historical turns:

1. If an authoritative native snapshot can still supply exact item/block
   identity, reconciliation may materialize `ordering = 'native-exact'`.
2. Otherwise the existing reasoning/commentary/action grouping is imported as
   one compatibility pass with `ordering = 'legacy-grouped'`.
3. The projector does not claim that legacy block order is native order.
4. New Version 2 events for a resumed historical conversation use exact blocks;
   they do not rewrite older uncertain turns by proximity or timestamp.

No conversation is deleted and no provider session is restarted solely for the
migration.

## Resource and viewer boundary

The Version 2 transcript resource returns self-contained turn frames with
ordered passes and blocks. Runtime and provider resources carry usage,
capability, preference, health, and Compact state; those values are not copied
into every block.

The viewer projects Version 2 passes into exact ordered presentation blocks.
Consecutive action blocks may share one visual action summary, but a text or
child block splits that summary so provider order is never lost. The terminal
block identified by `finalBlockId` stays in the outer assistant-message lane;
an earlier assistant-text block followed by more work remains in the ordered
work trace. This projection uses the existing server-authoritative window and
virtualizer and never writes visual grouping back into the journal.

The mutable tail is refreshed per invalidated turn rather than rereading the
whole transcript window. Native resource revisions provide the bridge
`ifNoneMatch` fence, render revisions fence semantic replacement, and a
separate layout revision avoids remeasuring virtualized rows for usage-only
changes. Viewer refresh is cadence-limited; durable provider text revisions are
checkpointed at a finer bounded cadence below that paint loop.

On mobile resume the viewer discards target-mismatched partial state, reads the
current resource revision, and replaces ephemeral deltas from the authoritative
materialized blocks. Repeated invalidations and snapshots are idempotent. A
second viewer observes the same ordering and revisions.

## Error and compatibility behavior

- Unknown provider events are logged with bounded metadata and ignored unless
  they affect lifecycle; they do not become generic transcript blocks.
- A missing required block start may be recovered from a completed native
  snapshot and emits a bounded compatibility diagnostic.
- A duplicate native event or snapshot does not duplicate a pass, block, tool,
  final response, child, or compaction boundary.
- Invalid provider order marks the turn recovering/compatibility-degraded; the
  projector does not silently sort by timestamps.
- A lost provider stream never changes running work to completed without native
  terminal evidence.
- Version and parse errors are surfaced at adapter ingress with provider,
  instance, event kind, and bounded path information, but no secret payload.

## Implementation sequence

Passes 1–4 are implemented. The sequence remains here as the dependency order
for review and future migrations.

### Pass 1 — contract and schema foundation

- add the Version 2 scope, structure, order, pass, block, control, and resource
  types with strict parsers;
- make schema Version 5 one coordinated migration with the composer spec;
- add materialized pass/block/control storage and replay;
- import Version 1 turns as exact or explicitly `legacy-grouped`; and
- retain a compatibility viewer projection without changing transcript pixels.

Exit: a synthetic provider can write, restart, replay, and reconcile an
interleaved turn without losing order or duplicating blocks.

### Pass 2 — provider mappings

- map Codex native item start/delta/completion and authoritative snapshots;
- map Claude content-block start/delta/stop, assistant-message reconciliation,
  tool results, result messages, and rate-limit messages;
- remove the Claude late-tool-start path;
- persist only display-safe reasoning; and
- add provider parity fixtures that prove exact order and restart identity.

Exit: equivalent Codex and Claude fixtures project ordered turns through the
same resource while retaining provider-specific metadata.

### Pass 3 — control, usage, and recovery projection

- project context and turn usage into conversation runtime state;
- project plan usage into provider-instance state;
- project repeated compact lifecycles into conversation controls;
- reconcile live streams, terminal snapshots, suspend/resume, and multiple
  viewers; and
- expose the bounded `remux_list_agents` federation tool.

Exit: context loss or native compaction never loses durable UI state or the
ability to rediscover an owned federated child.

### Pass 4 — ordered presentation and mutable-tail delivery

- project exact pass/block order into the provider-neutral work components;
- keep the native terminal final block in the assistant lane and retain earlier
  assistant-text blocks in work when the provider continued afterward;
- read only invalidated turn resources during active streaming;
- preserve server-generation, native-resource, semantic-render, and
  layout-revision fences;
- coalesce cumulative text revisions into bounded durable display checkpoints;
  and
- retain the existing virtualizer, scroll ownership, disclosure state, and
  suspend/resume recovery path.

Exit: equivalent interleaved Codex and Claude streams paint in native order,
the mutable tail does not trigger whole-window reads or usage-only row
remeasurement, and suspension converges to the same durable turn frame.

Composer correctness, usage presentation, and Compact command delivery proceed
in the order defined by `agent-composer-control-plane-v2.md` and are implemented
on the same runtime resources.

## Validation plan

### Contract and parser tests

- Each event kind accepts only its declared account/conversation/turn/execution
  scope and rejects extra identity fields.
- Native order unions reject missing, negative, fractional, or conflicting
  position values.
- Pass, block, and revision identifiers are bounded and extra keys fail.
- Hidden/encrypted thinking fixtures never reach a semantic event or artifact.
- Oversized text/tool/diagnostic payloads use bounded artifacts or fail at the
  adapter boundary.

### Ordered projection fixtures

- Claude: thinking A, tool A start/progress/end, thinking B, tool B, final stays
  in exactly that order.
- Claude creates a tool block at `content_block_start`; the later completed
  assistant message reconciles rather than moves or duplicates it.
- Codex item start/progress/completion preserves start order even when tools
  complete out of order.
- Multiple assistant passes remain distinct across tool-result boundaries.
- A final message is not moved ahead of a late-completing background child.
- File changes attach to the responsible operation when native identity exists.

### Deduplication and recovery

- Replaying the same live events, completed message, and terminal snapshot
  produces one pass/block set and one final response.
- A crash after a block start, after a revision checkpoint, and before turn
  terminal reconciles to the same state as an uninterrupted run.
- A provisional live order is replaced by authoritative snapshot order without
  changing block IDs.
- Two viewers and repeated resource invalidations converge on identical
  revisions and order.
- A phone/WebView suspend during streaming returns with no duplicated or
  truncated block.
- A Version 1 turn without native detail remains visibly
  `ordering = 'legacy-grouped'`.

### Compaction and work isolation

- Two automatic and one manual compaction produce three conversation-control
  lifecycles, not one `compacted` boolean.
- A queued manual Compact is anchored at the root boundary and creates no user,
  assistant, pass, or tool block.
- Compacting a root with a background native child, Bash/PTY task, MCP task, and
  federated child does not interrupt or reparent any of them.
- A foreground child delays queued Compact until the provider root turn ends.
- After root native compaction, `remux_list_agents` returns the still-owned
  federated execution ID and only the credential's permitted lineage.
- The rediscovered ID works with wait, follow-up, interrupt, and close according
  to its actual current state.

### Scale and boundedness

- Ten thousand blocks across a long conversation remain bounded by the
  server-authoritative transcript window; no resource returns the full journal
  by accident.
- Streaming checkpoint cadence bounds write amplification while retaining a
  responsive mutable tail.
- Account usage and control history are independently bounded and cannot expand
  every turn frame.
- Rebuilding materialized tables from events produces the same resource hashes
  and revisions as the live path.

## Exit criteria

This version is complete only when:

1. Codex and Claude both project interleaved native work through the same
   ordered turn contract without changing their native harnesses.
2. Tool and child lifecycle updates retain their start position.
3. Restart and terminal snapshot replay are idempotent by stable native
   identity.
4. Compaction and usage occupy their correct conversation/runtime/account
   scopes and never become fake transcript content.
5. Legacy uncertainty is explicit and no existing conversation is deleted.
6. Native and federated background work survives root compaction.
7. A compacted parent can rediscover its owned federated children without
   gaining transcript, credential, or cross-conversation access.
8. The current virtualized viewer renders ordered native blocks directly,
   preserves mobile scroll/resume behavior, and does not require a transcript
   visual redesign to retain provider order.
