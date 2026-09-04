Status: Active Spec — implementation landed; live provider/physical-phone acceptance pending
Last verified: 2026-09-03
Canonical code: `extensions/agent/shared/`,
`extensions/agent/server/src/native-runtime/`,
`extensions/agent/server/src/providers/`, and
`extensions/agent/viewer/src/conversation/`
Amends: `agent-native-provider-runtime-v1.md`
Depends on: `agent-canonical-turn-journal-v2.md` and
`agent-composer-control-plane-v2.md`

# Agent conversation lineage and sidebar tree v1

## Implementation status

Schema v7 and native protocol v5 now implement stable conversations,
immutable strands, explicit ordinal paths, provider-private branch bindings,
durable edit/fork/restore operations, compare-and-swap heads, historical
transcript reads, and the virtualized conversation tree. Edit remains on the
same route, Fork creates one child row, Make Current creates a fresh restore
strand, and preparing/failed destinations remain hidden.

Automated server, protocol, migration, adapter, unit, desktop, responsive, and
lifecycle suites pass. Live subscription-backed Codex and Claude branching,
physical-phone safe-area/keyboard checks, and real screen-off recovery remain
release acceptance rather than claims made by the fixture suite.

## Outcome

Agent models chats, edit history, and provider sessions as three different
things:

- a **conversation** is the stable user-facing chat shown in the sidebar;
- a **strand** is one immutable version of that conversation's history; and
- a **native session** is the Codex or Claude continuation that implements one
  strand.

New Chat creates a root conversation. Explicit Fork creates a child
conversation in a visible conversation tree. Edit creates and activates a new
strand inside the same conversation; it does not create another chat row. The
previous strand remains durable and inspectable.

Both Codex and Claude preserve provider-native model context through the
selected turn boundary. Remux does not reconstruct a native fork from visible
messages. Branching retains conversational context, including provider-owned
context represented in the native session, but it does not rewind the working
tree, copy Claude file-undo history, or migrate live subagents.

The Agent sidebar becomes a mobile-safe, virtualized conversation tree over
this model. Provider sessions remain an implementation detail and never become
sidebar rows.

## Why this revision is required

The current implementation has one structural operation called
`branchConversation`. Both Edit and Fork call it, and both create a new Remux
conversation. The destination receives its replacement turn before the source
prefix is materialized. A later provider snapshot may import the prefix with
new observation timestamps, while the journal sorts root turns by timestamp
and UUID. This can render the replacement before its inherited history and can
also move the conversation's latest-turn pointer backwards.

That behavior violates the product semantics:

- editing a message should keep the same chat identity;
- only an explicit fork should create a new chat;
- a branch must be complete before it becomes visible or active;
- provider-native order must not be inferred from import time; and
- the sidebar should expose intentional chat lineage without filling history
  with implementation-created “Edited chat” rows.

The current schema encodes `conversation -> one root execution -> one native
session`. It has no place for a second version of the same chat, no durable
branch provenance, and no branch-local turn ordinal or provider cutoff cursor.
The current flat sidebar mirrors that limitation.

## Scope

This version owns:

- conversation, strand, and native-session identity;
- edit, explicit-fork, version-preview, and version-activation semantics;
- exact provider-native branch cut points for Codex and Claude;
- durable lineage and deterministic transcript-path ordering;
- atomic preparation and activation of branch destinations;
- conversation-tree and version resources;
- desktop and mobile sidebar-tree behavior;
- rename and reversible archive behavior; and
- migration and recovery from the current one-session-per-conversation schema.

The following remain out of scope:

- replacing either provider's native harness or compactor;
- cross-provider native forks;
- copying hidden provider state into a different provider;
- rewinding or cloning checkout contents;
- automatically creating git branches or worktrees;
- moving running subagents to a new strand;
- mutating or deleting an old strand in place;
- permanent deletion of conversation trees in the first pass; and
- replacing the transcript virtualizer or ordered turn/block contract.

## Normative principles

1. Chat identity belongs to Remux; continuation semantics belong to the native
   provider.
2. A conversation has exactly one active strand. A strand has exactly one root
   execution and native session.
3. Completed strands are immutable. Edit and restore create new strands rather
   than rewriting history.
4. Only explicit Fork creates a new visible conversation.
5. Native context is preserved only by a tested same-provider-instance native
   fork. Visible transcript replay is never silently substituted.
6. A branch is activated only after its native session and complete inherited
   prefix have been validated.
7. Turn order is an explicit ordinal on a strand path. Timestamps are
   diagnostic and never determine transcript order.
8. A logical turn and its provider identity are different. Claude remaps
   native UUIDs during a fork, so provider identity cannot be the shared turn
   key.
9. Branching conversation context does not imply branching filesystem state.
10. The sidebar shows the user-facing conversation tree. It does not expose
    every provider session as a peer chat.

## Terminology and identities

```text
conversation family
├── root conversation (user-facing chat)
│   ├── strand A (initial version; native session A)
│   └── strand B (edit version; native session B; active)
└── child conversation (explicit fork; user-facing chat)
    └── strand C (native session C; active)
```

### Conversation

A conversation is the stable route and sidebar identity. It owns title,
preview, working directory, provider instance, and archive state. Its separate
head record points to the active strand with a compare-and-swap revision. A
conversation created by Fork also records its parent conversation and the exact
source path entry.

### Strand

A strand is an immutable path through logical turns plus any turns appended
locally after its branch point. It records the source strand, cutoff, reason,
root execution, native session, and lifecycle. A strand is `preparing` until
the native continuation and inherited path are valid; only `ready` strands can
be activated.

### Logical turn

A logical turn is the canonical user input, ordered assistant passes/blocks,
usage, and terminal result already defined by the canonical-turn journal. Its
content is stored once. A strand path can reference a turn produced on an
ancestor strand without copying its passes, blocks, events, or artifacts.

### Strand path entry

A path entry places one logical turn at one ordinal on one strand. It gives the
viewer a stable occurrence identity and carries the server-only native branch
cursor that can cut at that point. A shared inherited logical turn may therefore
appear through distinct path entries without becoming a duplicated execution.

### Native branch cursor

A native branch cursor is bounded, versioned, provider-private metadata. It
contains the provider identity needed to fork immediately before or through a
logical turn. It is stored server-side and never exposed in viewer resources.

## Product semantics

| Action | Visible conversation | Destination strand | Native provider action | Sidebar result |
| --- | --- | --- | --- | --- |
| Follow-up | Same | Same active strand | Normal next native turn | Same row |
| Edit message | Same | New strand, activated atomically | Fork before selected turn, then send replacement | Same row, version count increments |
| Fork chat | New child | New initial strand | Fork through selected turn, then send optional first message | New child row |
| Preview version | Same | No mutation | No provider action | Read-only version view |
| Make version current | Same | New strand cloned from selected version | Native fork through selected version head | Same row, version count increments |
| New chat | New root | New initial strand | Fresh native session | New root row |
| Cross-provider handoff | New root or linked handoff | New initial strand | Fresh destination session with explicit visible handoff | Dashed/labeled handoff, never “Fork” |

Edit retains the conversation route, title, notification destination, and
sidebar row. Explicit Fork receives a new route, title, active composer state,
notification identity, and child position in the tree.

Edits and forks are accepted only at settled turn boundaries. The source must
have no active root turn, queued message, queued/running compaction, or native
background activity that the provider declares unsafe to branch. Existing
federated children remain owned by the source strand. Terminal child summaries
already present in the native root context are preserved as part of the native
fork; child processes are not duplicated or moved.

## Context and workspace guarantees

The UI may say:

> Context inherited through “<turn preview>”. Current checkout retained.

It may not say “workspace restored,” “files branched,” or “everything copied.”

The initial guarantee is:

- model-visible root conversation context through the selected boundary is
  preserved by the provider's native mechanism;
- native compact summaries and provider context that survive that provider's
  own fork remain provider-owned and usable;
- the destination stays on the same provider instance and subscription;
- the checkout path and current filesystem contents are shared/current; and
- live subagents, background jobs, file checkpoints, and undo history are not
  promised to migrate.

A future “Branch workspace” operation may combine this with a git worktree, but
it must be a separate capability and user action.

## Provider capability contract

Replace the coarse `forkNative` boolean with a truthful branch capability, or
add this shape during a compatibility release and remove the boolean at the
next hard cut:

```ts
type ContextBranchingCapability = {
  strategy: 'native' | 'visible-replay' | 'none';
  boundary: 'turn';
  sameProviderInstanceOnly: boolean;
  workspace: 'shared-current';
  whileBackgroundChildrenRun: boolean;
};
```

Codex and the pinned Claude Agent SDK advertise:

```ts
{
  strategy: 'native',
  boundary: 'turn',
  sameProviderInstanceOnly: true,
  workspace: 'shared-current',
  whileBackgroundChildrenRun: false,
}
```

`visible-replay` is not sufficient to enable Edit or Fork. It may enable a
separately labeled “Copy visible context to new chat” action with a fidelity
warning. A provider change always uses that explicit handoff path.

The shared adapter contract should use an opaque boundary instead of pretending
that every provider has a single native turn ID:

```ts
type ProviderBranchBoundary = {
  contractVersion: 1;
  provider: ProviderKind;
  kind: 'empty' | 'before-turn' | 'through-turn';
  privateCursor: JsonValue;
};

type ProviderForkRequest = {
  commandId: string;
  source: NativeSessionRef;
  destinationSessionId: string;
  boundary: ProviderBranchBoundary;
  cwd: string;
  model: string;
  effort?: string;
  access: ProviderAccess;
  deferAutomaticContinuation: true;
};

type ProviderForkResult = {
  session: NativeSessionRef;
  materialized: boolean;
  providerLineage?: JsonValue;
};
```

The cursor is parsed only by the provider adapter that authored it. Its size is
strictly bounded, and secrets are forbidden. The coordinator stores it in a
server-only binding and never copies it into the public journal event envelope.

## Codex mapping

Codex App Server already exposes native `thread/fork` with mutually exclusive
`lastTurnId` and `beforeTurnId` cutoffs. It also returns `sessionId` and
`forkedFromId` lineage.

- Fork through turn T uses `lastTurnId = T.nativeTurnId`.
- Edit turn T uses `beforeTurnId = T.nativeTurnId`.
- Edit the first turn may use `beforeTurnId` when supported; otherwise it
  creates a fresh thread with the same explicit configuration.
- `deferGoalContinuation = true` prevents the fork from starting an implicit
  continuation before the replacement or fork prompt is dispatched.
- The fork applies the active model, effort, cwd, access, instructions, and
  runtime workspace roots through supported native overrides.

Remux stores App Server's native lineage as diagnostic/provider evidence. The
Remux conversation/strand graph remains authoritative for its own UI because
externally discovered native threads may be incomplete or absent.

## Claude mapping

The pinned Claude Agent SDK 0.3.258 supports native forking even though the
current adapter advertises `forkNative: false`.

The preferred path starts the destination query with the source `resume`,
`forkSession: true`, a caller-minted destination `sessionId`, and
`resumeSessionAt`. This preserves the provider instance's configured
environment, subscription identity, settings sources, Claude Code prompt, and
MCP configuration. The standalone `forkSession()` helper does not expose the
same provider-specific environment surface and is therefore not the primary
Remux path.

Claude cutoffs use transcript chain-entry UUIDs, not the Anthropic API
`msg_...` ID and not Remux's synthetic native turn ID:

- Fork through T uses T's last persisted chain-entry UUID.
- Edit T resumes through the preceding kept turn's last chain entry and records
  T's prompt UUID as the dropped turn.
- Editing the first turn creates a fresh destination session.

The last assistant response is not necessarily the last entry of a turn. Tool
results, structured-output attachments, interrupted-tool markers, and
transcript-only appends may follow it. The Claude adapter must therefore record
at least this provider-private data for a locally produced turn:

```ts
{
  version: 1,
  promptUuid: string,
  lastChainEntryUuid: string,
}
```

For Edit, use the SDK's `resumeDropsTurn` guard. If Claude rejects the cutoff
because unobserved entries would be dropped, the failure is deterministic:
refresh the source snapshot, keep the old strand active, clear the preparing
destination, and show an actionable conflict. Do not retry the same fork.

Claude remaps every message UUID in a fork. Logical path entries therefore
retain the cursor from the native session that originally produced the turn.
Branching again from an inherited turn may fork directly from that originating
session and cutoff, which represents the same native context through that
boundary. A local turn added after the fork uses the destination session's
cursor. This avoids guessing a remapped UUID and avoids copying historical
turn records.

If an implementation instead maps remapped cursors in the destination, it must
read both native histories, align them by validated order and content identity,
and fail closed on any mismatch. It may not align by timestamp or title.

Claude's native fork copies conversation messages but does not copy file-undo
history. This is reflected by `workspace: 'shared-current'`; it does not make
Claude branching a replay.

## Durable data model

The schema hard cut introduces explicit lineage. Illustrative names are
normative in meaning, not necessarily exact SQL spelling.

### `conversations`

```text
conversation_id              primary key
provider_instance_id         immutable
parent_conversation_id       nullable; explicit Fork parent
root_conversation_id         indexed family root
forked_from_path_entry_id    nullable
title / title_source         Remux-owned display metadata
preview                      derived from active strand
cwd                          immutable in v1
archived_at                  nullable
metadata_revision            monotonic
created_at / updated_at / subtree_updated_at
```

`parent_conversation_id` is semantic history and cannot be changed by dragging
a row. `root_conversation_id` allows bounded family queries. New Chat has no
parent and points to itself as root.

### `conversation_heads`

```text
conversation_id              primary key
strand_id                    unique active strand
revision                     monotonic compare-and-swap fence
switched_at
```

Keeping the head in a separate table avoids a circular
`conversation <-> strand` foreign key. Every Edit and Make Current command
carries `expectedHeadRevision`; only one concurrent head replacement can win.
Head changes are also appended as conversation-control events so the audit
history is rebuildable.

### `conversation_strands`

```text
strand_id                    primary key
conversation_id              owning visible chat
source_strand_id             nullable; may belong to another conversation
source_path_entry_id         nullable exact boundary provenance
cutoff_kind                  root | before | through | restore
reason                       initial | edit | fork | restore | legacy
root_execution_id            unique
state                        preparing | ready | failed | orphaned
created_at / ready_at / failed_at
```

Only a `ready` strand can be selected by `conversation_heads`. Previous strands
remain immutable and ready for preview or restoration; “current” is a head
relationship, not a mutable lifecycle label on the strand.

### `strand_turn_path`

```text
path_entry_id                primary key
strand_id                    destination strand
ordinal                      explicit zero-based transcript order
turn_id                      canonical logical turn
source_path_entry_id         nullable inherited occurrence
relation                     local | inherited
branch_binding_id            server-only branch binding
UNIQUE(strand_id, ordinal)
UNIQUE(strand_id, turn_id)
```

The inherited prefix is materialized as lightweight path memberships, not as
copies of turn passes, blocks, events, or artifacts. The path is complete before
a strand becomes ready. Projection uses `ordinal`; `created_at`, provider event
arrival, and UUID lexical order never participate.

### `native_turn_bindings`

```text
native_binding_id            primary key
provider_instance_id
native_session_execution_id
turn_id                      canonical logical turn
native_turn_id               nullable diagnostic identity
before_cursor_json           bounded provider-private value
through_cursor_json          bounded provider-private value
cursor_version
validated_at
UNIQUE(native_session_execution_id, turn_id)
```

Many inherited path entries may point to the same originating native binding.
If a provider-specific destination mapping is later materialized, it is an
additional binding for that destination execution rather than a replacement of
the origin evidence.

### `branch_operations`

Native provider mutation and SQLite cannot share one transaction, so Edit and
Fork are durable sagas:

```text
operation_id                 primary key
command_id                   unique idempotency key
mode                         edit | fork | restore
source_conversation_id
source_strand_id
source_path_entry_id
expected_head_revision
destination_conversation_id nullable for same-conversation edit
destination_strand_id
destination_execution_id
state                        claimed | native-forking | native-prepared |
                             prefix-validated | turn-dispatching | accepted |
                             activated | failed | delivery-unknown
native_result_json           bounded server-only recovery evidence
error_json                   nullable
created_at / updated_at
```

Recovery advances this state machine from evidence. It never repeats an
ambiguous native mutation or replacement prompt merely because the process
restarted.

### Existing records

- Root executions and `native_sessions` move from conversation ownership to
  strand ownership through `root_execution_id`.
- Canonical `turns` gain an origin strand and durable local ordinal.
- `latest_turn_id`, `active_turn_id`, execution state, resumability, context
  usage, and health derive from the active strand rather than living as global
  mutable conversation facts.
- Command receipts record operation kind, source conversation/strand/path
  entry, destination IDs, and the exact accepted client message ID.
- Strand-scoped events, controls, compactions, queued operations, usage, and
  notification state carry `strand_id`; provider account usage remains scoped
  only to its provider instance.

The foreign-key model must allow an explicit-fork strand to reference a source
strand in its parent conversation without giving cascade deletion permission
to destroy the source. Permanent deletion remains unavailable until lineage
references have tombstone/reference-count behavior.

## Atomic branch workflows

### Edit

1. Parse and hash the complete command, including conversation, active strand,
   source path entry, expected head revision, replacement content,
   `clientMessageId`, provider instance, model, effort, and access.
2. Under the conversation lane, verify that the submitted active strand is
   still active, the source is settled, and the target belongs to its path.
3. Create deterministic destination strand, execution, native-session, and
   replacement-turn IDs from the command ID. Persist a `preparing` operation.
4. Ask the provider to create a native destination immediately before the
   selected turn.
5. Materialize and validate every inherited path entry with explicit ordinals.
6. Dispatch the replacement turn on the destination session using the original
   client message ID.
7. In one durable transaction, record acceptance, compare-and-swap the
   conversation head to the new strand, append the head event, and update the
   conversation preview.
8. Publish conversation, runtime, transcript, tree, and version invalidations.

The returned `conversationId` equals the submitted ID. The returned `strandId`
is new.

### Explicit Fork

The workflow is the same except that it creates a deterministic child
conversation and initial strand, uses a `through` boundary, and does not change
the source conversation's active strand. The child is not visible in the tree
until its native session and inherited path are ready. If the first child
message is part of the action, it is accepted with the caller's original
`clientMessageId`.

### Failure and crash recovery

- Any pre-activation failure leaves the source conversation and strand
  untouched.
- A materialized native session with an uncommitted destination is recovered
  from the durable preparing operation or sealed as an orphan diagnostic; the
  native fork is never blindly repeated.
- Reusing the same command ID and same hash returns the recorded result.
  Reusing it with different content is rejected.
- A provider cutoff conflict refreshes source history and returns a stable
  `branch_conflict`; it never falls back to visible replay.
- The coordinator publishes no destination transcript fence until the complete
  inherited path is queryable.
- Recovery validates every head pointer, head revision, and ready-strand
  invariant before serving conversation resources.

## Protocol and resources

The strict native Agent protocol and schema versions increment together.

Conversation summaries add:

```ts
type ConversationLineageView = {
  parentConversationId: string | null;
  rootConversationId: string;
  forkedFromPathEntryId: string | null;
  activeStrandId: string;
  headRevision: number;
  versionCount: number;
  childCount: number;
  subtreeUpdatedAt: number;
  archivedAt: number | null;
  metadataRevision: number;
};
```

The viewer projection retains the existing provider field instead of dropping
it. It must never infer provider identity from a model ID.

Branch targets use `pathEntryId`, not a globally guessed provider turn ID:

```ts
type BranchSource = {
  sourceConversationId: string;
  sourceStrandId: string;
  expectedHeadRevision: number;
  pathEntryId: string;
};

type MessageEditCommand = {
  commandId: string;
  clientMessageId: string;
  source: BranchSource;
  content: readonly UserContentPart[];
  configuration: ComposerSubmissionConfiguration;
};

type MessageForkCommand = {
  commandId: string;
  clientMessageId?: string;
  source: BranchSource;
  firstMessage?: readonly UserContentPart[];
  configuration: ComposerSubmissionConfiguration;
};

type MessageEditResult = {
  conversationId: string;
  strandId: string;
  turnId: string;
  transcriptFence: AgentTranscriptFence;
};

type MessageForkResult = MessageEditResult & {
  parentConversationId: string;
};
```

The viewer currently generates a branch client-message ID but the IPC layer
drops it. The new contract carries that exact ID end to end.

Resources are normalized and bounded:

```text
agent/conversations                         paged active root summaries
agent/conversation-children:<id>:<cursor>  lazy child summaries
agent/conversation-lineage:<id>            focused node plus ancestor chain
agent/conversation-versions:<id>:<cursor>  strand/version summaries
agent/conversation:<id>                    active conversation summary
agent/runtime:<id>                         active strand runtime
agent/transcript:<id>:<window>             active strand transcript
agent/transcript:<id>:<strandId>:<window>  read-only version preview
```

For an ordinary Fork action, `expectedHeadRevision` protects the source shown
in the UI. A later advanced action may fork from a specifically selected older
strand, but it must name that immutable strand explicitly rather than bypassing
the fence accidentally.

The first implementation may extend the existing `agent/conversations`
resource with a bounded, ancestrally closed normalized index. It must honor
`truncated`, include the focused conversation's ancestor chain, and graduate to
lazy root/child pagination before unbounded history can exceed the resource
limit. Route hydration may not prepend an orphan row arbitrarily.

Transcript frames expose `pathEntryId` as the branch-action/virtualizer
occurrence identity while retaining `turnId` for canonical turn-detail reads.
The selected conversation route opens only its active strand. A version preview
adds an explicit `strandId` and is read-only.

Add idempotent commands:

```text
remux/agent/conversation/rename
remux/agent/conversation/archive/set
remux/agent/conversation/strand/activate
```

There is no permanent-delete command in this version.

## Sidebar information architecture

The primary sidebar is a forest of user-facing conversations:

```text
Chats                                             +

▾ Audit the Agent extension              Claude  3m
  ├─ Fix streaming recovery              Claude  2m
  │  └─ Test on mobile                    Claude  1m
  └─ Alternate journal design            Claude  8m

▸ Composer overhaul                       Codex  1h
```

Only explicit forks are child rows. An edited conversation stays in place and
shows a compact `v3` badge when it has three durable strands. Its actions expose
`Versions (3)`.

### Row layout

Use a fixed two-line row, approximately 56 CSS pixels high:

- first line: disclosure, transient status, title, provider mark, relative
  time, and overflow affordance;
- second line: one-line preview, version badge, collapsed-child count, and
  exceptional state badges; and
- working uses Remux orange, failed uses destructive red, and idle does not
  show a bright permanent success dot.

Working directory moves to details/actions or replaces the preview only when it
disambiguates identical titles. Three full text rows per tree node are too
dense on mobile.

Tap behavior is explicit:

- row selects the active strand and closes the mobile sheet;
- disclosure expands/collapses without selecting or closing;
- version badge opens versions;
- overflow or long-press opens actions; and
- New Chat retains the existing single-draft behavior and creates a root.

The action surface initially contains Rename, Versions, Fork from latest, and
Archive/Unarchive. Provider-native rename may be a best-effort mirror later;
the Remux title is authoritative.

### Tree order and depth

The viewer derives a flattened preorder list from normalized root and child
maps. Use a small fixed-row virtualizer rather than the transcript virtualizer.

- Roots sort by latest activity anywhere in their subtree.
- Siblings use stable creation order so streaming/status updates do not make
  branches jump.
- The active conversation's ancestor chain auto-expands.
- Explicit expansion state is viewer-local and keyed by conversation ID.
- Indent 12–14 pixels per level and cap visual indentation at three levels.
- At greater depth, show a depth marker and preserve the real `aria-level`;
  never add horizontal scrolling.
- Deep-node actions include “Focus on this branch,” with an ancestor breadcrumb
  and Back action.

Use `role="tree"`, `role="treeitem"`, `aria-level`, `aria-expanded`, and roving
tab focus. Desktop arrow keys navigate, expand, and collapse the visible tree.
Expansion preserves the selected row as the scroll anchor.

## Versions UI

Versions are subordinate to a conversation, not peers in the chat tree:

```text
Versions · Audit the Agent extension

✓ Current
  Edited “Can you audit…”                         3m

  Previous
  Before edit                                   12m
```

Selecting a previous version opens a clearly labeled, read-only transcript.
It does not change the active strand. “Make current” creates a new native strand
from that version's head and activates it through the normal staged workflow;
the historical strand itself stays immutable.

On desktop the versions list may expand beneath the selected row or use a side
panel. On mobile it is a secondary screen inside the history sheet with a Back
button. It must not be an anchored narrow popover.

## Mobile behavior

Retain the existing left sheet width and its correct host/CSS safe-area inputs.
The tree refinement is:

```text
top safe area
┌──────────────────────────────────┐
│ ×   Chats                    +   │  sticky 48px header
├──────────────────────────────────┤
│ New-chat draft                   │
│ virtualized visible tree         │
│                                  │
├──────────────────────────────────┤
│ Active / Archived                │  optional sticky filter
└──────────────────────────────────┘
bottom safe area
```

- Apply each safe area once at the sheet shell.
- Close, New, disclosure, and overflow controls have at least 44-by-44 CSS-pixel
  coarse-pointer hit targets.
- Header and optional filter remain outside the scroll owner.
- Row actions use a bottom sheet whose scroll area and buttons clear the bottom
  safe area.
- Rename follows `visualViewport` keyboard changes and keeps the input visible.
- Overlay tap, swipe/back, Escape, and the sheet-local Close button dismiss.
- Selecting a chat closes the sheet; expanding, renaming, and viewing versions
  do not.

The Close button belongs only to the open history sheet. It is not another
main-transcript “exit to tabs” control.

## Rename, archive, and deletion

### Rename

Rename is a versioned Remux metadata command. A stale metadata revision is
rejected and refreshed. The visible title is not recomputed from provider
history after a manual rename.

### Archive

Archive is reversible and retains conversations, strands, native sessions,
turns, artifacts, and lineage. A running conversation must be stopped before
archive. Archiving a parent does not falsify the tree: active descendants keep
a dim ancestor placeholder, and the Archived filter exposes the full node.

### Delete

Permanent deletion does not ship in v1. Shared ancestor turns and cross-chat
strand provenance make naive cascade deletion unsafe. A later design must use
tombstones/reference counting and an explicit descendant policy.

## Migration

Migration is conservative and never guesses lineage.

1. Each existing conversation becomes one root conversation with one `legacy`
   strand, one native session, and a head at revision 1.
2. Existing turns receive explicit ordinals from an authoritative provider
   snapshot where available. If exact order was already discarded, retain the
   existing `legacy-grouped` label and assign a deterministic compatibility
   order; never use a fresh observation timestamp.
3. Existing provider-native fork lineage may be imported only when the source
   session and exact cutoff are both provable. Codex `forkedFromId` alone can
   identify a parent but not necessarily the user intent or cutoff.
4. Current “Edited chat” destinations generally lack durable operation/source
   provenance. They remain standalone legacy roots unless command receipts and
   native history prove the relationship. Do not infer from title or matching
   text.
5. The migration validates one active strand, contiguous path ordinals, native
   session ownership, and all conversation pointers before changing the schema
   version.

Development-only preview data may be reset explicitly, but production history
may not be deleted as a migration shortcut.

## Notifications, usage, and compaction

- Notifications remain keyed to conversation and terminal active-strand turn.
  A previous strand cannot send a new completion notification after
  activation moves away from it.
- Context usage and compact state come from the active strand. Read-only version
  previews may show their last recorded values but never overwrite composer
  state.
- Provider account/subscription usage remains provider-instance scoped.
- Native compaction continues on a strand's provider session. A later native
  fork preserves whatever compacted context that provider includes through the
  selected boundary.
- Branch operations are rejected while compaction is queued or running. A
  branch never copies a pending queue.

## Validation matrix

### Contract and journal

- New Chat creates one root conversation and one active initial strand.
- Edit returns the same conversation ID, a new strand ID, and a replacement
  turn after the complete inherited prefix.
- Fork returns a new child conversation ID and leaves the source active strand
  unchanged.
- Ordinals remain contiguous and deterministic across restart, late snapshot,
  duplicate event, and identical timestamps.
- Inherited turns share canonical content without global-ID collisions.
- A repeated command returns the same IDs/result; changed reuse is rejected.
- A failed or crashed preparation never switches the active strand.
- First-turn edit produces an empty-prefix native destination on both providers.

### Live Codex

- Fork before and through use native App Server cutoffs.
- The inherited context is present without Remux transcript replay.
- Compacted threads, tool-heavy turns, and interrupted terminal turns branch at
  the intended boundary.
- Native `sessionId`/`forkedFromId` evidence agrees with journal lineage.

### Live Claude

- The subscription-backed provider instance remains the same after fork.
- Fork-on-resume materializes the caller-minted destination session and can be
  resumed after server restart.
- Tool-result and structured-output tails use the last chain entry, not merely
  the assistant API message ID.
- `resumeDropsTurn` conflict fails closed and retains the old active strand.
- Claude compacted context remains usable after fork.
- File undo history is not represented as preserved and current checkout files
  remain unchanged by the branch operation itself.

### Sidebar and mobile

- Root, sibling, child, and deep trees flatten in stable preorder.
- Only explicit forks create chat rows; repeated edits only change `vN`.
- Opening a deep-linked child hydrates and expands its ancestor chain.
- 1,000 conversations and a 12-level lineage remain responsive with bounded
  reads and fixed-row virtualization.
- Expanding a sibling does not move the selected row unexpectedly.
- Mobile 360-by-780 and 390-by-844 layouts clear both safe areas and the
  keyboard; all critical controls meet 44-pixel coarse-pointer targets.
- Background/foreground, WebView destruction, reconnect, and server rebuild
  restore the same selected conversation, active strand, expansion path, and
  transcript.
- Rename/version/archive bottom sheets remain dismissible and safe-area clear.

## Implementation order

### Pass 0 — lock semantics and fixtures

- Freeze the action matrix and error codes.
- Add journal fixtures for same-chat edit, child fork, first-turn edit, sibling
  forks, nested forks, failed preparation, and out-of-order snapshot import.
- Add provider fixtures containing Claude tool-result tails and Codex before/
  through boundaries.

### Pass 1 — schema and deterministic paths

- Add conversations, strands, path memberships, native bindings, ordinals,
  metadata revisions, and archive state.
- Move root execution/native session ownership to strands.
- Project active transcripts strictly from path ordinals.
- Implement and verify the conservative migration.

No UI behavior changes in this pass.

### Pass 2 — atomic coordinator semantics

- Split Edit and Fork commands.
- Carry the submitted `clientMessageId` end to end.
- Stage destinations, validate prefixes, activate atomically, and recover
  preparing operations.
- Add version preview/activation and metadata commands.

Keep fork controls disabled until the relevant provider pass is complete.

### Pass 3 — provider-native branching

- Update Codex to the explicit `beforeTurnId`/`lastTurnId` contract and cover
  first-turn edit.
- Capture Claude prompt/last-chain cursors and implement guarded fork-on-resume.
- Advertise the structured capability only after fixture and live subscription
  tests pass.

### Pass 4 — resources and navigation

- Bump the strict protocol.
- Add lineage/version resources and `pathEntryId` transcript targets.
- Replace flat arbitrary route prepending with normalized ancestor hydration.
- Preserve selected active strand across mobile lifecycle recovery.

### Pass 5 — sidebar tree

- Build normalized root/child/expansion state and fixed-row virtualization.
- Add provider marks, disclosure, branch/version badges, stable ordering, tree
  keyboard semantics, and deep-tree focus.
- Add the mobile sticky header, explicit local Close, safe action sheets, and
  versions screen.

### Pass 6 — management and release validation

- Add Rename and Archive/Unarchive.
- Run schema, coordinator, provider fixture, live Codex, live Claude, desktop,
  responsive browser, WebView lifecycle, and physical-phone acceptance.
- Remove legacy `branchConversation` only after migrated history and deep links
  pass.

## Release gates

This work is not ready merely when a nested sidebar renders. Release requires:

- Edit never changes the visible conversation ID.
- Fork always creates exactly one child conversation.
- Both providers prove native inherited context with real subscription-backed
  prompts.
- No branch can render a replacement ahead of its inherited prefix.
- No turn order depends on timestamps or UUID lexical order.
- Failure before activation is source-preserving and retry-idempotent.
- Cross-provider replay is never labeled Fork.
- The mobile tree, versions view, rename, and archive surfaces pass safe-area,
  keyboard, reconnect, and screen-off recovery acceptance.
