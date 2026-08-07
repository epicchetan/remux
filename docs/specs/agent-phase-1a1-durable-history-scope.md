Status: Proposed Spec
Last verified: 2026-08-07
Canonical code: Phase 1A.0 remains in `extensions/agent/`; this document proposes the next checkpoint and does not authorize implementation until the Phase 1A.0 owner gate and this scope are explicitly accepted

# Agent Phase 1A.1 durable conversations and history scope

## Purpose and authorization boundary

Phase 1A.1 is the first durable Agent checkpoint. It replaces the disposable
conversation source with a SQLite journal, immutable artifacts, deterministic
projections, restart recovery, and full logical replay. It then activates the
existing Codex-derived conversation-history UI against Agent-owned resources.

This checkpoint does **not** activate epoch rollover or change what a normal
provider inference sees. Pi still receives the exact logical conversation in
full. The journal makes that conversation durable and reproducible; it is not
itself a compaction mechanism.

Approval of this document authorizes only Phase 1A.1. It does not authorize
the complete long-transcript/work-detail pass in 1A.2, the shadow compiler in
1A.3, active epochs in 1B, new coding effects, queue/edit/fork behavior,
attachments, mentions, or durable processes.

Implementation may start only after:

1. the Phase 1A.0 implementation is committed and its commit is recorded in
   the 1A.0 report;
2. the owner records the Phase 1A.0 live desktop/phone decision; and
3. the owner explicitly accepts this scope.

## Checkpoint outcome

After Phase 1A.1:

- a sent Agent conversation is durable across viewer, Agent-extension, Remux,
  and host-machine restarts;
- the Agent can list, route to, open, and continue recent conversations;
- every durable UI projection is derived from a committed journal prefix;
- reopening a conversation creates a fresh Pi session and supplies an exact
  full logical replay through the existing context hook;
- a restart never restores a provider response ID or silently retries an
  inference, tool call, or user message;
- an interrupted Agent turn leaves a visible, terminal
  `interrupted_by_restart` turn that can be continued with a new user message;
- conversation titles and previews are deterministic renderings of committed
  visible content, with no model call;
- desktop receives the mature history sidebar and phone receives the matching
  history sheet/action; and
- the Phase 1A.0 transcript, composer, streaming, scrolling, auth, and mobile
  behavior remains the normal interaction surface.

Only conversations created after the durable cutover exist. Phase 0/1A.0
ephemeral conversations and Codex/App Server history are not migrated.

## Frozen inputs and version identities

- Implementation base: the owner-accepted Phase 1A.0 commit, to be recorded
  before implementation begins.
- Pi: `0.84.0` with the single `openai-codex` provider.
- Node runtime: Node 24.x with `node:sqlite`; startup fails clearly when the
  required API is unavailable.
- Journal schema: `agent-journal-v1`, stored as `PRAGMA user_version = 1`.
- Logical message schema: `LogicalMessageV1` from the durable-core spec.
- Projection reducer: `agent-projection-v1`.
- Conversation summary renderer: `agent-conversation-summary-v1`.
- Full replay renderer: `agent-full-replay-v1`.
- Transcript rendering remains `agent-turn-render-v1`; Phase 1A.1 changes its
  source, not its viewer shape.
- Agent transcript protocol remains version `1` for this checkpoint.

Any deviation from these versions, a Pi patch, or a later Codex UI fix selected
for the port is recorded in the Phase 1A.1 implementation report.

## Normative product decisions

### Journal authority

An event or event group is committed before its resource projection is
published. The database journal is the only durable conversation source.
Pi's in-memory session, viewer stores, `transcript_items`, `resources`, and
conversation summaries are disposable projections or live caches.

There is no second Pi JSONL history and no dual-write recovery policy.
`SessionManager.inMemory()` remains mandatory.

### Conversation, strand, and epoch identity

Every conversation creates exactly one root strand. The strand is durable now
so later edit/fork support does not change event identity, but no strand or
fork UI/API is exposed in 1A.1.

Schema v1 also creates the durable-core epoch and inference tables. Each root
strand begins with one ordinal-zero `full_replay` epoch. It has no bootstrap or
epoch blocks and never rolls in Phase 1A.1. This is bookkeeping for inference
identity, not active context compilation. Phase 1A.3 may attach shadow
candidates; Phase 1B is the first checkpoint allowed to close it for budget
rollover.

### Drafts versus conversations

A new-chat draft is viewer-local and is not journal state. It has a stable v4
UUID, cwd/model/reasoning selection, and plain-text composer snapshot in the
tab's `sessionStorage`. It may survive a WebView reload and conversation
switches in that tab. It is deleted when its durable conversation is confirmed
or when the owner discards it.

Closing a tab may discard its unsent draft. Phase 1A.1 does not promise
cross-device, cross-tab, or server-durable unsent text.

A durable conversation is created on first send, not merely by opening the
new-chat surface. If creation commits but the subsequent message command
cannot be confirmed, the empty conversation remains visible and the client
reconciles the two operation IDs before retrying. It never creates a second
conversation speculatively.

### One runtime, independently viewable history

Conversation selection is viewer-local. Multiple tabs may read different
durable conversations without changing server runtime ownership.

The server keeps at most one Pi `AgentSession`, called the loaded runtime.
Reading or selecting history does not load a session. Sending to an idle
conversation lazily creates or switches the loaded runtime after disposing the
previous idle runtime. While a turn is nonterminal, other conversations remain
viewable and draftable, but a send to another conversation fails with a typed
`active_runtime_busy` result naming the active conversation. No history click
implicitly interrupts work.

This avoids a global “selected conversation” race between tabs while keeping
the single-session/cache constraint.

### Deterministic titles and previews

No inference is used for history metadata.

- Initial title: `New conversation`.
- On the first committed user message, collapse Unicode whitespace to one
  ASCII space, trim it, and take the first 48 Unicode code points. An empty
  result remains `New conversation`.
- Preview: the most recent nonempty visible assistant text, otherwise the most
  recent user text; normalize whitespace identically and take the first 120
  Unicode code points.
- Tool arguments, tool results, reasoning, errors, restricted fields, and
  artifact bytes never become a title or preview.
- Sorting is `updated_at DESC, conversation_id DESC`; replay uses the recorded
  timestamps and produces the same order.

The first history page contains at most 50 summaries. A route-addressed
conversation remains openable even when it is older than that page. Broader
history pagination is deferred until measurements show it is required; data
itself is never truncated or deleted.

### Sign-out and deletion

Signing out disposes the loaded Pi session and credentials but does not delete
Agent journals or artifacts. Conversation delete, archive, retention, garbage
collection, export, and import are absent from Phase 1A.1.

## Durable storage contract

The data-root, permission, SQLite, artifact, canonicalization, and corruption
rules in
[`agent-durable-epoch-core.md`](agent-durable-epoch-core.md) are normative.
This scope fixes their 1A.1 application.

### Data root

Resolve in order:

1. `REMUX_AGENT_DATA_DIR`;
2. nonempty `$XDG_DATA_HOME/remux/agent`; or
3. `<os.homedir()>/.local/share/remux/agent`.

The initial layout is:

```text
agent/
  agent.sqlite3
  artifacts/
    sha256/<first-two-hex>/<full-sha256>
  tmp/
```

The root is mode `0700`; database, artifact, and staging files are mode
`0600`. The later `process-hosts/` tree is not created in this checkpoint.

### SQLite discipline

Use one `node:sqlite` `DatabaseSync` writable connection behind an async
repository interface. Every connection applies:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

Transactions contain only bounded database work. They never contain provider
I/O, filesystem scans, artifact streaming, `fsync`, runtime disposal, or
waiting for a tool.

Startup behavior is exact:

- user version `0` with no Agent tables creates schema v1 transactionally;
- user version `1` validates and opens;
- a database with a newer version is refused without mutation;
- malformed rows, failed foreign keys, or referenced missing/wrong-sized
  artifacts block model continuation and surface a redacted diagnostic; and
- there is no down migration.

### Schema v1

Create the full minimum table set already fixed by the durable-core spec:

```text
meta
conversations
strands
events
transcript_items
resources
operations
artifacts
epochs
epoch_blocks
inferences
```

The durable-core column names are normative. Phase 1A.1 actively uses all
tables except `epoch_blocks`, which remains empty. Later checkpoints may add
indexes and non-semantic metadata but do not rename these identities.

`events.sequence` is the one committed ordering cursor. Every materialized
resource revision is its maximum contributing `basis_sequence`, not an
in-memory counter. `serverGeneration` remains a random boot identity and never
substitutes for a revision.

### Events used in Phase 1A.1

The journal accepts this subset of the already-fixed taxonomy:

- `conversation.created`, `conversation.updated`;
- `turn.accepted`, `turn.started`, `turn.completed`, `turn.interrupted`,
  `turn.failed`;
- `message.user`, `message.assistant.started`,
  `message.assistant.delta`, `message.assistant.completed`;
- `tool.called`, `tool.updated`, `tool.completed`;
- `operation.accepted`, `operation.started`, `operation.succeeded`,
  `operation.failed`, `operation.interrupted`;
- `epoch.opened` for the one full-replay epoch;
- `inference.started`, `inference.completed`, `inference.failed`; and
- `recovery.observed`.

No `epoch.closed`, `context.pinned`, mutation-effect, shell, process, edit, or
fork event is emitted yet.

Assistant deltas are coalesced before commit at the earlier of 50 ms or 8 KiB.
The final assistant event is committed even if its last delta is empty.
Event payloads are canonical JSON capped at 32 KiB. Larger exact content is an
artifact reference.

### Transaction boundaries

Conversation creation commits, in one transaction:

1. caller operation acceptance;
2. conversation/root-strand/full-replay-epoch creation events and rows;
3. initial conversation/list/transcript projections;
4. operation success with the stable conversation ID; and
5. affected resource basis sequences.

Message acceptance commits, in one transaction:

1. caller operation acceptance;
2. `turn.accepted`, `message.user`, and `turn.started`;
3. conversation, transcript, title/preview, and list projections;
4. operation success with the stable turn ID; and
5. affected resource basis sequences.

Only after this commit may `session.prompt()` begin. Each provider inference
commits `inference.started` before network I/O. Runtime assistant/tool events
commit before their matching resource invalidation. A terminal transition
commits the assistant/inference/turn terminal events and all affected
projections together.

An invalidation is an after-commit hint. A dropped invalidation cannot lose
state because reconnect/resource reads are authoritative.

### Durable event fence and Pi preflight seam

The loaded runtime owns one promise-chained durable event sequencer. Pi event
listeners may drive live display, but no inference, tool, or terminal boundary
depends on an unawaited subscriber or a fire-and-forget database write.

The required order is:

1. message acceptance commits before `session.prompt()`;
2. the context boundary drains all prior sequenced events before building the
   exact durable replay;
3. a provider preflight validates the replay budget and commits
   `inference.started` before provider network I/O;
4. the Remux `workspace.read` execution wrapper flushes pending assistant
   deltas and commits `tool.called` before reading the workspace;
5. that wrapper installs any artifact and commits the terminal tool result
   before returning it to Pi; and
6. assistant deltas flush before tool start/result, inference start, message
   terminal state, interruption, runtime disposal, and restart recovery.

Pi 0.84.0 awaits `context`, `before_provider_request`, tool lifecycle, and
agent-event handlers in the relevant order. Its extension runner, however,
catches errors from `context` and `before_provider_request` handlers and then
continues. Those public extension hooks therefore cannot be the only
fail-closed boundary.

Phase 1A.1b begins with a provider-preflight seam proof. Remux must own an
awaited callback at Pi's existing payload boundary, after final context
conversion and before `modelRuntime.streamSimple` can initiate I/O. A callback
rejection must escape the hook runner, produce one durable failed inference and
turn, and result in zero provider calls. Prefer an existing non-extension seam
if inspection proves that contract. Otherwise add the smallest version-pinned
Pi dependency patch needed to expose it, and record the patch and fixtures in
the implementation report. A log-only extension error is not an acceptable
failure mode.

The custom tool wrapper, rather than a later display event, is authoritative
for `tool.called` and the terminal tool-result transaction. Pi's awaited events
remain ordering evidence and update the live projector, but replay correctness
must survive their duplication, delay, or absence.

### Artifact protocol

Artifact installation uses the durable-core stage → hash → flush → `fsync` →
atomic rename → database-reference sequence. It never falls back to storing
oversized bytes inline.

Phase 1A.1 implements bounded `remux/agent/artifact/read` for internal tests
and future viewer consumers. It accepts only a lowercase SHA-256 hash and a
bounded byte or line range. It cannot read an arbitrary path. No new artifact
viewer or attachment UI is activated.

Startup records unreferenced installed files as orphans but does not garbage
collect them. A referenced missing or length-mismatched artifact is corruption.

### Replay and canonical projection hash

Reducers are pure functions over a journal prefix. Replaying events `[1, N]`
into empty projection tables must reproduce the live projection hash at `N`.

The canonical hash includes, in primary-key order:

- conversations and strands;
- transcript items;
- materialized resource keys, basis sequences, and canonical values;
- operation state;
- artifact metadata and hashes;
- epoch/inference state; and
- the reducer/policy versions that interpreted the events.

It excludes SQLite page layout, row IDs not in the logical schema, WAL state,
filesystem paths derived from the data root, and current wall-clock time.

Crash fixtures inject failure before commit, after commit/before invalidation,
after artifact installation/before reference commit, and during assistant
streaming. Each recovered state must equal one committed journal prefix.

## Full logical replay contract

### Durable message view

Journal reducers materialize `LogicalMessageV1`, never raw Pi/provider
payloads. The logical order includes:

- committed user messages;
- visible assistant text and visible reasoning summaries;
- tool calls with canonical arguments;
- one corresponding terminal tool result for each completed call; and
- terminal stop state for completed, failed, interrupted, and
  restart-interrupted assistant messages.

Opaque reasoning, OAuth material, response IDs, request headers, environment
dumps, and raw provider request bodies are not semantic replay state.

The pinned `agent-full-replay-v1` converter maps this durable sequence to Pi's
message types. Converter fixtures include plain turns, reasoning, one and many
tool calls, tool errors, interruption, partial restart recovery, and
artifact-backed content.

### Runtime hydration

Selecting or reading a conversation does not create a Pi session. Before a
send, the server:

1. verifies there is no other nonterminal loaded runtime;
2. reads one stable journal basis and validates conversation/model/cwd state;
3. creates a fresh in-memory Pi session when the target is not already loaded;
4. installs a stable durable full-replay snapshot consumed by the awaited
   context hook;
5. commits the new user turn; and
6. calls `session.prompt()`.

The context hook returns the exact durable logical replay at every inference
boundary, including boundaries after a tool result inside one user turn. It
does not ask a model to summarize, omit messages, or consume a shadow epoch.

Within one healthy loaded runtime Pi may use provider continuation. The first
inference after conversation creation, runtime switching, extension restart,
or Remux restart must be observed as `full` with no prior response ID. A
continuation request at that boundary is a correctness failure.

### Pre-rollover budget guard

Before every provider inference, including those after tools, estimate:

```text
fixed contracts + exact durable replay + pending logical input
```

Use the larger of pinned Pi token estimation and the conservative UTF-8 byte
estimate. Reserve 25,000 output tokens and a 5,000-token safety margin. The
hard input limit is:

```text
min(150,000, selected_model_context_window - 25,000)
```

If the estimated input plus safety margin exceeds that limit, abort before
provider I/O with `context_rollover_not_enabled`, journal the inference/turn
failure, and keep the conversation reopenable. The 120k rollover threshold is
informational until active epochs exist; Phase 1A.1 does not roll or compact.

## Restart and recovery contract

On startup, before serving reads or accepting sends:

1. validate schema, artifacts, and the committed journal tail;
2. rebuild or verify materialized projection hashes;
3. find every nonterminal turn, inference, assistant message, and tool row;
4. append one recovery transaction that marks them terminal with reason
   `interrupted_by_restart`;
5. set each affected conversation back to an idle/reopenable state;
6. append `recovery.observed`; and
7. publish no invalidation until the recovery commit succeeds.

Partial assistant text and completed tool results remain visible. An
incomplete tool call becomes visibly interrupted; it is never re-executed.
There is no attempt to resume the old provider stream or recover a response ID.

Opening the recovered conversation reads the terminal durable projection.
The next user send creates a new Pi session, performs a full replay, and opens
a full provider request. Duplicate user or assistant transcript rows are a
checkpoint failure.

## Agent protocol changes

### Methods

The existing auth, model, resource-read, transcript-read, interruption, and
invalidation methods remain. The ephemeral create name is replaced:

```text
remove  remux/agent/conversation/start
add     remux/agent/conversation/create
add     remux/agent/artifact/read
keep    remux/agent/conversation/message/send
keep    remux/agent/conversation/turn/interrupt
```

`conversation/create` and `conversation/message/send` require caller-stable
v4 operation IDs generated by the shared Agent viewer UUID primitive.

```ts
type ConversationCreateParams = {
  operationId: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
};

type ConversationCreateResult = {
  accepted: true;
  operationId: string;
  conversationId: string;
  replayed: boolean;
};

type DurableMessageSendParams = {
  operationId: string;
  conversationId: string;
  clientMessageId: string;
  text: string;
};

type DurableMessageSendResult = {
  accepted: true;
  operationId: string;
  turnId: string;
  replayed: boolean;
};
```

Reusing an operation ID with the same canonical arguments returns the original
result. Reusing it with different arguments returns a typed conflict and
performs no mutation. A transport timeout causes reconciliation/read and then
an identical retry; it never causes a new UUID.

`clientMessageId` remains distinct from operation, turn, event, transcript,
and conversation identity. It anchors the optimistic/sent-message viewport
and is unique within a conversation.

### Durable resources

Add:

```text
conversation-list
conversation:<conversationId>
operation:<operationId>
```

`conversation-list` returns at most 50 summaries:

```ts
type AgentConversationSummary = {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
  status: 'idle' | 'running' | 'interrupting' | 'error';
  latestTurnId: string | null;
  createdAt: number;
  updatedAt: number;
};

type AgentConversationListValue = {
  conversations: AgentConversationSummary[];
  truncated: boolean;
};
```

Every durable resource result carries `basisSequence`, `serverGeneration`, and
`notModified` support. The request's existing `ifNoneMatch` compares against
`basisSequence`. During the transition, `revision` may remain as an equal
compatibility field inside Agent code, but the implementation report must
either remove it or prove the two fields cannot diverge.

Conversation-list invalidations occur only when a summary or order changes.
Conversation invalidations are scoped to one ID. Existing transcript/work
invalidations gain their committed `basisSequence`; they retain the 1A.0
turn-frame/resource vocabulary.

### Transcript boundary in 1A.1

The viewer continues to call the existing transcript sync method and render
the same turn frames. The implementation replaces live-only projector state
with journal-derived materialization sufficient to:

- reopen all committed turns;
- append and stream the current turn;
- preserve work/assistant/user identity;
- show restart-interrupted terminal state; and
- satisfy the existing tail/around/range behavior for current fixtures.

Phase 1A.2 owns the complete durable window/work-detail hardening: 100+ turn
and huge-result stress, immutable older windows, focus-to-turn across unloaded
pages, durable expanded details, cadence revalidation, and viewport survival
through restart. Those are not pulled into this checkpoint merely because the
schema can represent them.

## Viewer behavior and port closure

### Desktop and phone navigation

Desktop adds an Agent history sidebar. Phone adds the matching sheet opened by
an `Open history` action; the existing `Open tabs` host action remains.

Rows show title, preview, relative updated time, cwd, and active/terminal
status. They support loading, empty, preserve-ready refresh, and retry states.
The selected row uses `aria-current="page"`.

Selecting a row:

- preserves any new-chat draft snapshot in that tab;
- closes the mobile sheet;
- updates viewer-local active conversation state;
- reads conversation and transcript resources without creating a Pi session;
- applies the durable cwd/model/reasoning as locked composer configuration;
- retargets the host tab to
  `(agent, main, agentConversation, <conversationId>)`; and
- retains the current rendered conversation during preserve-ready reconnect
  until the authoritative replacement is ready.

Starting a new chat allocates an `agentDraft` v4 resource ID, restores or
creates its session draft, and retargets the host tab to that draft. First send
retargets the same tab to `agentConversation` after the create result. A stale
route or missing conversation renders a durable-not-found state with `New
chat`; it does not silently attach another conversation.

`host/navigate` to an `agentConversation` selects that conversation and
honors a future `turn` focus through the existing viewport request. Navigation
is state-based and fenced so a slow response for conversation A cannot replace
newer selection B.

### Copied/adapted Codex viewer sources

| Frozen Codex source | Agent Phase 1A.1 use |
| --- | --- |
| `viewer/threads/Sidebar.tsx` | Copy/adapt as Agent sidebar and mobile sheet; remove Codex types/labels |
| `viewer/threads/historyStore.ts` | Copy stale-read, preserve-ready, invalidation, and missing-route-summary behavior against Agent resources |
| `viewer/threads/sidebarStore.ts` | Copy mobile sheet state |
| `viewer/threads/store.ts` | Port only draft/selection/directory state and session draft persistence; no thread command semantics |
| `viewer/threads/threadFormat.ts` | Port relative-time/path presentation; titles/previews remain server authoritative |
| `viewer/App.tsx` history/route shell | Port sidebar placement, route navigation, selection fencing, tab metadata, and draft restore only |
| `composer/actions/ActionButtons.tsx` history action | Port the phone history action without attachments, queue, narration, edit, or fork |
| relevant sidebar/sheet rules in `viewer/styles.css` and viewer-kit shadcn primitives | Reuse responsive dimensions, focus, safe area, and theme behavior |

Do not copy Codex history discovery, rollout parsing, App Server thread
commands, generated protocol types, `composerStateStore`,
`operationQueueStore`, `runtimeStore`, edit/fork code, or narration.

### Proposed Agent file closure

New server modules:

```text
extensions/agent/server/src/storage/data-root.ts
extensions/agent/server/src/storage/database.ts
extensions/agent/server/src/storage/schema.ts
extensions/agent/server/src/storage/canonical-json.ts
extensions/agent/server/src/storage/artifacts.ts
extensions/agent/server/src/storage/repository.ts
extensions/agent/server/src/storage/reducers.ts
extensions/agent/server/src/storage/replay.ts
extensions/agent/server/src/storage/recovery.ts
extensions/agent/server/src/storage/summaries.ts
```

New viewer modules:

```text
extensions/agent/viewer/src/conversation/Sidebar.tsx
extensions/agent/viewer/src/conversation/historyStore.ts
extensions/agent/viewer/src/conversation/sidebarStore.ts
extensions/agent/viewer/src/conversation/navigationStore.ts
```

Primary modified boundaries:

```text
extensions/agent/shared/protocol.ts
extensions/agent/shared/transcript.ts
extensions/agent/server/src/agent-server.ts
extensions/agent/server/src/engine.ts
extensions/agent/server/src/pi-runtime.ts
extensions/agent/server/src/resources.ts
extensions/agent/server/src/transcript-projector.ts
extensions/agent/viewer/src/App.tsx
extensions/agent/viewer/src/conversation/store.ts
extensions/agent/viewer/src/composer/content.tsx
extensions/agent/viewer/src/composer/actions/ActionButtons.tsx
extensions/agent/viewer/src/ipc/resources.ts
extensions/agent/viewer/src/ipc/resourceInvalidations.ts
extensions/agent/viewer/src/resumeSync.ts
extensions/agent/viewer/src/styles.css
extensions/agent/tests/viewer-fixture.ts
```

File names may change only when the implementation report records the reason
and preserves the same ownership boundaries. No durable Agent module is added
under `extensions/codex/` or `packages/viewer-kit/` in this checkpoint.

## Explicitly unchanged behavior

- `openai-codex` subscription auth and model discovery;
- Pi 0.84.0, websocket-cached transport, disabled retry/compaction/analytics;
- one loaded Pi session and at most one globally running Agent turn;
- `workspace.read` as the only model tool;
- the current fixed system prompt and tool ordering;
- plain-text composer and explicit send button;
- model/reasoning choice before first send and locked durable conversation
  configuration after creation;
- transcript Markdown/work rendering, measurement, virtualization, scrolling,
  interruption, reconnect, background/resume, keyboard, and safe-area behavior;
- device-code sign-in/sign-out; and
- existing Codex extension as an unchanged comparison target.

## Explicitly absent

- epoch snapshot compilation, shadow manifests, context inspector, active
  rollover, context pull/pin, or a Compact control;
- workspace search/patch, arbitrary writes, shell, runtime queries, or
  persistent processes;
- queue/steer/follow-up, edit, fork, branches exposed to the user, mentions,
  attachments, or image input;
- model-generated titles/summaries;
- conversation delete/archive/import/export, Phase 0 migration, Codex history
  import, retention, or artifact garbage collection;
- multiple simultaneous Pi sessions or concurrent Agent turns;
- narration, review, speed/service-tier, quota/reset, approval/elicitation,
  collaboration/subagents, or web/research UI; and
- App Server, OpenAI API keys, Anthropic, or runtime fallbacks.

## Implementation sequence and owner stops

### Phase 1A.1a — storage kernel and deterministic replay

Implement data-root resolution, schema v1, repository transactions, artifact
installation, event canonicalization, pure reducers, projection hashing, and
crash fixtures. Do not connect the live Agent server or viewer yet.

Stop/go evidence:

- clean create/reopen/newer-schema refusal;
- permissions and SQLite pragma tests;
- event payload/artifact limits;
- replay-at-every-prefix equivalence;
- operation idempotency/conflict tests; and
- crash points resolve to one committed prefix.

Owner review: schema/event examples, data layout, and replay diagnostics.

### Phase 1A.1b — live journal and Pi full-replay cutover

Move conversation create/send/runtime events behind the repository. Implement
one loaded runtime, lazy hydration, exact full replay, provider-mode evidence,
the hard budget guard, and startup interruption recovery. Keep the current
single-conversation viewer temporarily; route fixtures may address durable
IDs directly.

Stop/go evidence:

- the provider-preflight seam is proven fail-closed before live cutover;
- injected preflight/journal failure makes zero provider calls and one durable
  terminal failure;
- create/send acknowledgements occur only after commit;
- repeated operations return original IDs;
- a short conversation continues after a server restart;
- first inference after hydration is `full`;
- mid-stream restart produces one interrupted terminal turn;
- next send contains exact replay with no duplicate messages; and
- an over-budget fixture makes zero provider calls.

Owner review: one live short conversation before/after extension restart.

### Phase 1A.1c — history/sidebar activation

Add conversation-list resources, deterministic summaries, desktop/sidebar and
phone/sheet UI, draft retention, route selection, host navigation, and
preserve-ready reconnect behavior.

Stop/go evidence:

- recent order/title/preview fixtures;
- new → first send → durable route transition;
- open A → draft B → open A without losing the draft;
- rapid A/B selection fences stale reads;
- mobile sheet focus/safe-area behavior;
- two tabs may view different conversations without changing runtime;
- sending elsewhere while a turn runs returns `active_runtime_busy`; and
- sign-out preserves durable history.

Owner review: desktop and physical phone history/list/open/draft feel.

### Phase 1A.1d — recovery, parity, and acceptance hardening

Run cumulative 1A.0 regressions, deterministic restart/crash matrices, Codex
baseline tests, live restart scenarios, and source/exclusion audits. Record an
implementation/deviation report. Do not begin Phase 1A.2.

## Automated verification

Add at minimum:

```text
extensions/agent/tests/durable-database.test.ts
extensions/agent/tests/durable-artifacts.test.ts
extensions/agent/tests/durable-replay.test.ts
extensions/agent/tests/durable-recovery.test.ts
extensions/agent/tests/durable-runtime.test.ts
extensions/agent/tests/viewer-history.spec.ts
```

Required deterministic cases:

1. Schema create/reopen, foreign keys, pragmas, file modes, and newer-version
   refusal.
2. Canonical JSON and logical message fixtures are byte-identical across two
   processes.
3. Replay each prefix of a mixed user/assistant/reasoning/tool/error trace and
   match the live projection hash.
4. Artifact deduplication, staged crash/orphan, missing reference, wrong size,
   range cap, and path rejection.
5. Duplicate create/send operation with identical arguments returns the same
   conversation/turn; mismatched arguments conflict.
6. Crash before commit publishes nothing; commit-before-invalidation is found
   by the next read.
7. Restart while idle reopens and continues with a full provider request.
8. Restart during assistant text and during `workspace.read` each yields one
   restart-interrupted turn and no repeated tool execution.
9. Exact replay preserves user/tool/assistant order and no message appears
   twice after continuation.
10. Provider-preflight database failure and the hard-budget fixture both fail
    before provider I/O; provider call count remains zero.
11. Delta → tool call → tool result → next inference ordering survives delayed
    display subscribers and contains no uncommitted boundary.
12. History titles/previews/order are deterministic and restricted content
    never leaks into them.
13. Route-open outside the recent 50 works; a missing route remains missing.
14. Rapid conversation selection, reconnect, background/resume, generation
    reset, and preserve-ready state never display the wrong transcript.
15. Desktop/sidebar and phone/sheet new/list/open/draft interactions match the
    accepted layout and focus behavior.
16. Every existing Phase 1A.0 server/unit/viewer test remains green or has an
    explicitly documented durable equivalent.

Verification commands:

```text
npm --workspace @remux/agent run build
npm --workspace @remux/agent run test:server
npm --workspace @remux/agent run test:unit
npm --workspace @remux/agent run test:viewer
npm run typecheck
npm run test:codex
git diff --check
```

The implementation report records exact counts, fixture data-root paths
(redacted to their temporary root), schema/reducer versions, provider request
modes, selected Codex source closure, and every accepted deviation.

## Live acceptance matrix

Run on desktop and the physical Remux phone using a temporary fresh Agent data
root and real subscription auth.

| Scenario | Required result |
| --- | --- |
| Fresh cutover | Empty Agent history; no Phase 0/Codex rows imported |
| First send | One durable conversation, one user row, one active turn, correct locked model/reasoning |
| Deterministic summary | First user text becomes title; latest visible answer becomes preview; no extra model call |
| Two conversations | Create A and B, switch repeatedly, correct transcript/config/route every time |
| Draft retention | Type unsent B draft, open A, return to draft, exact text/cwd/model/reasoning restored |
| Desktop restart | Restart Agent extension; history stays rendered/reloads, A reopens, next send continues exact history |
| Mid-stream restart | Partial answer becomes one `interrupted_by_restart` turn; no late mutation or duplicate after continuation |
| Remux/host restart | Durable list and transcript return with a new generation and unchanged basis state |
| Reconnect | Preserve-ready list/transcript remains visible while authoritative reads settle |
| Busy runtime | View B while A runs; send in B is rejected without interrupting or duplicating A |
| Phone history | Sheet, focus, scrolling, selection, keyboard dismissal, safe areas, and route state feel native |
| Sign out/in | History remains local; model execution is unavailable signed out and resumes only after auth |
| Light/dark | Sidebar, sheet, rows, status, composer, and transcript surfaces remain opaque and legible |

The owner records date/devices, data-root mode, live results, accepted visual
differences, blockers, and an explicit `accepted` or `rejected` decision.

## Exit gate

Phase 1A.1 is complete only when:

1. the storage/replay/runtime/history implementation matches this scope;
2. every projection can be rebuilt from its journal prefix with the same hash;
3. create/send retries are idempotent and conflict-safe;
4. restart produces terminal, visible, nonduplicated recovery state;
5. a reopened short conversation continues through a verified full provider
   request under the budget guard;
6. desktop and phone history/list/open/draft behavior is owner-accepted;
7. all cumulative Agent and unchanged-Codex gates pass;
8. the implementation/deviation report is complete; and
9. the owner explicitly authorizes planning Phase 1A.2.

Until then, Phase 1A.2 authoritative-window work and all context-compiler work
remain out of scope.
