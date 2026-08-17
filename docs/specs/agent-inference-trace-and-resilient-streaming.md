Status: Implemented (automated acceptance complete; physical-phone acceptance pending)
Last verified: 2026-08-16
Canonical code: `extensions/agent/{server,shared,viewer}/`, with the stable lifecycle and transcript comparison in `extensions/codex/{server,shared,viewer}/`

# Agent inference traces and resilient viewer streaming

Implementation baseline: Agent state schema v5 and transcript protocol/projection
v3. The retired flat `workGroup`, `workEntryDetail`, and `workUnit` resource
paths have been removed; `executionScope` and `operationDetail` are the only
Work-detail resources.

## Outcome

The Agent viewer will present the model's work as a hierarchy of durable
execution scopes and provider inferences:

```text
turn
├── user message
├── root execution scope (Work)
│   ├── inference 1
│   │   ├── assistant commentary
│   │   ├── provider reasoning summary
│   │   └── tool-call group
│   ├── inference 2
│   │   ├── assistant commentary
│   │   ├── provider reasoning summary
│   │   └── tool-call group
│   │       └── work unit
│   │           ├── objective, completion criteria, and resources
│   │           ├── inference 1
│   │           │   ├── assistant commentary
│   │           │   ├── provider reasoning summary
│   │           │   └── tool-call group
│   │           ├── inference 2
│   │           │   ├── assistant commentary
│   │           │   ├── provider reasoning summary
│   │           │   └── tool-call group
│   │           └── result and returned resources
│   └── inference 3
│       └── provider reasoning summary
└── assistant response
```

The same execution-scope component renders the root turn and a work unit. A
work unit is not a special flat activity log. It is a nested execution scope
with the same inference, reasoning, tool, loading, error, and streaming
semantics as its parent.

Streaming remains server-authoritative. The viewer never needs to receive
every delta, preserve a WebSocket, remain mounted, or run in the background in
order to recover the exact current presentation. Invalidations only announce
that a revision may be newer. Bounded resource reads from the durable journal
always decide what is rendered.

This should be more reliable than the Codex extension's disk-plus-live-overlay
projection because the Agent commits its own provider and tool activity to one
SQLite journal before publishing it. It retains the proven Codex viewer model:
preserve ready content, suppress hidden work, verify authoritatively on resume,
and use stable revisioned render resources rather than applying transport
deltas directly to React state.

## Relationship to current Agent specifications

- [`agent-explicit-turn-context-v1.md`](agent-explicit-turn-context-v1.md) is
  normative for user-selected prior-turn context, exact active scopes, History
  retrieval, and work-unit continuation semantics.
- [`agent-ui-parity-and-phased-delivery.md`](agent-ui-parity-and-phased-delivery.md)
  remains normative for the copied Codex design system, virtualizer, composer,
  and interaction parity.
- [`codex/server-authoritative-transcript-windows.md`](codex/server-authoritative-transcript-windows.md)
  remains the reliability reference for bounded render windows, lifecycle
  recovery, lazy detail resources, and server-authoritative viewer state.
- This document is normative for inference identity in the transcript,
  recursive execution-scope presentation, semantic reasoning boundaries, and
  Agent-specific streaming/recovery behavior.

## Current-state audit

### What is already correct

The Agent already has most of the required reliability foundation:

1. `inference.started` is committed before provider dispatch and references an
   immutable context frame and inspectable dispatch payload.
2. Assistant text and reasoning are coalesced into durable
   `assistant.checkpoint` events rather than writing one row for every provider
   token.
3. Final provider messages, usage, context frames, tool operations, work-unit
   scopes, and terminal inference/turn states are durable.
4. All writes for an active turn pass through one serialized durability fence.
5. The in-memory live projector is advanced only after the corresponding
   journal mutation commits.
6. Transcript reads settle pending writes and return a monotonic
   `basisSequence`, per-turn render revisions, known-revision
   `notModified` results, and a server-generation fence.
7. The viewer coalesces streaming refreshes at a bounded cadence, rejects stale
   responses, preserves ready content on transient failures, and performs
   authoritative resume reads.
8. The provider loop and extension process do not belong to the viewer. The
   phone may background or destroy its WebView while work continues on the
   Remux machine.

These contracts are retained.

### What is currently projected incorrectly

1. Every durability checkpoint can become a visible reasoning entry. A 50 ms
   or 8 KiB storage boundary is not a semantic model thought.
2. Work-unit activity is a flat list of checkpoint fragments and tools. It
   truncates reasoning previews and admits only the first bounded activity
   slice, so it cannot express inference structure or exact continuation.
3. Root-scope reasoning and work-unit reasoning use different viewer models.
4. Tool operations do not carry an explicit durable source inference. Their
   association is reconstructed from sequence and current coordinator state.
5. The work-unit scope is not durably linked to the parent operation and
   inference that created it.
6. The viewer's top-level Work section separates all reasoning, all work units,
   and all operation groups instead of preserving the model-call hierarchy.
7. Agent invalidation handling is installed from a React effect. Codex installs
   its critical transcript subscription before React mounts, avoiding the
   subscribe-after-initial-read race.

### Pi boundary

No Pi fork is required for this checkpoint. Pi exposes model-message start,
update, and end boundaries, and the final assistant message contains the
combined visible reasoning text for that provider inference. That is enough to
create one semantic reasoning summary per inference.

Pi also preserves OpenAI Responses message phase in the finalized text block's
`textSignature`. During streaming, the partial message stop reason distinguishes
an explicit `final_answer` item from commentary. The Agent adapter therefore
keeps commentary with its source inference and reserves the turn-level assistant
segment for the final answer without modifying Pi.

Pi currently normalizes OpenAI's typed reasoning-summary events into generic
thinking deltas, losing exact provider part indexes and source-kind metadata.
The first implementation will preserve the exact visible text and inference
boundary without pretending that checkpoint boundaries are provider summary
parts. A later narrow Pi patch may retain provider item ID, output index,
summary index, and source kind if the resulting UI demonstrates a real need.
That optional patch must not block this work or change the durable viewer
contract.

## Goals

- Show the maximum provider-supported visible reasoning, grouped by actual
  model inference rather than storage flush.
- Show sparse model-authored commentary with the inference that emitted it,
  without concatenating it into the final assistant response.
- Group the tool calls emitted by an inference directly beneath its reasoning.
- Render work units as nested instances of the same execution trace.
- Show a work unit's model-authored objective, completion criteria, provided
  resources, result, and returned resources.
- Keep exact tool arguments, outputs, diffs, provider payloads, and oversized
  reasoning available through bounded detail reads.
- Preserve streaming assistant output, stable virtualizer identity, bottom
  following, manual-scroll ownership, and expandable-row measurement.
- Recover correctly after backgrounding, tab changes, WebView destruction,
  host WebSocket reconnect, Agent extension restart, and provider retry.
- Make all live presentation reconstructible from the durable journal.
- Leave a clean durable seam for host notifications after a root turn reaches a
  terminal state.

## Non-goals

- Exposing OpenAI's private chain of thought. The UI can display only provider-
  supported reasoning summaries or other reasoning text actually returned to
  the client.
- Generating a second model-written summary of reasoning.
- Applying raw provider deltas directly to React state.
- Keeping the viewer alive in the background or requiring background
  JavaScript execution.
- Persisting the viewer's resource cache across WebView destruction in this
  pass. A cold viewer must hydrate quickly from the server instead.
- Replacing Pi's provider transport or agent loop.
- Adding notifications in this checkpoint.
- Changing `thread.md`, context compilation, or work-unit continuation
  behavior.
- Nesting work units inside work units. The UI/resource model may be recursive,
  but the current execution policy remains one child level.
- Reintroducing Codex narration, app-server item types, or compaction UI.

## Terms and identities

### Turn

One user-visible unit beginning with a user message and ending in one terminal
assistant outcome. A turn owns one root execution scope.

### Execution scope

A provider-context lifetime in which the model performs work. The root scope
belongs to the turn. A work-unit scope belongs to the operation that entered
it. Each scope has its own ordered inferences.

### Inference

One provider request/response cycle. An inference starts before dispatch,
streams zero or more assistant/reasoning fragments, produces zero or more tool
calls, and reaches one terminal state. Tool results are followed by a new
inference in the same scope.

### Reasoning summary

The exact visible reasoning text returned for one inference. Streaming storage
may contain many fragments; the semantic projection contains at most one
reasoning-summary record per inference. Its display state is `streaming`,
`completed`, `failed`, `interrupted`, or `superseded` with the inference.

### Tool-call group

The ordered set of calls emitted by one inference. Calls may execute in
parallel, but they share a source inference and appear under it. A call that
enters a work unit links to the child execution scope.

## Durable model

### Existing records retained

- `turns` remains the root user-visible state machine.
- `execution_scopes` remains the scope hierarchy.
- `inferences` remains the provider-call fence and usage record.
- `provider_items` remains the exact private/inspectable provider record.
- `operations` remains the durable operation table and becomes canonical for
  provider tool calls as well as user/queue operations.
- `events` remains the immutable ordered journal.
- content-addressed artifacts continue to hold large or sensitive content.

### Required identity additions

Provider tool calls are promoted from event/transcript-only records into
`operations` rows. The schema then makes relationships explicit rather than
deriving them from adjacency:

```text
operations.source_inference_id -> inferences.inference_id
execution_scopes.parent_operation_id -> operations.operation_id
```

Every `tool.called` payload also includes `sourceInferenceId`. Every
work-unit-start event includes `parentOperationId` and `parentInferenceId` for
diagnostics and deterministic replay. The relational columns are authoritative;
the event fields make journal inspection self-contained.

A provider call gets one stable harness operation ID plus its upstream
`callId`. `(scopeId, callId)` is unique. `events.operation_id` references that
row for call and completion events; transcript items and viewer resources use
the harness operation ID as their stable identity.

The coordinator passes the complete provider-emitted call list into inference
finalization. The tool-execution hook validates or idempotently observes those
already-durable operations rather than inventing their identity later. Starting
a work unit changes the active scope only after the parent operation and
child-scope link are durable.

### Inference output

Streaming fragments remain append-only `assistant.checkpoint` events with an
explicit `inferenceId`. They are recovery data, not viewer rows.

When Pi supplies the finalized assistant message, one atomic inference
finalization writes:

1. the raw and inspectable provider item;
2. the exact combined visible reasoning-summary artifact, if present;
3. the exact combined assistant-text artifact, if present;
4. reported usage;
5. provider-emitted tool-call operation rows/events, each explicitly linked to
   this inference;
6. the terminal inference event and state; and
7. the final semantic revision.

The `inferences` record gains nullable direct references for finalized visible
reasoning and assistant text. This avoids reparsing a provider payload during
every transcript read while retaining the raw provider item as evidence.

Until finalization, a running projection concatenates committed checkpoint
fragments for that inference. After finalization, the finalized artifact is
authoritative. If a provider's finalized text differs from the streamed
prefix, the projection replaces the provisional value, records a diagnostic,
and continues. A presentation mismatch must not duplicate text or fail an
otherwise valid turn.

An interrupted process with no final provider item retains its exact committed
prefix and marks it interrupted. A superseded transport attempt retains its
own output and is never merged into the replacement inference.

### Write and publish ordering

For every visible mutation:

```text
provider/tool event
  -> coalesce in server memory when appropriate
  -> commit journal transaction
  -> update/rebuild semantic projector
  -> enqueue revisioned invalidation
  -> viewer performs authoritative resource read
```

An invalidation may be duplicated, coalesced, delayed, reordered, or lost. It
must never contain state required for reconstruction. No invalidation is
published before its `basisSequence` is readable from SQLite.

The provider stream never waits for a viewer. Provider callbacks only enter the
serialized durability queue. Delta buffering must remain bounded and
coalescing-aware so a slow disk creates fewer larger checkpoints rather than an
unbounded row or promise backlog. Inference, tool, scope, and turn boundaries
always flush pending text before committing the boundary.

## Server-authoritative viewer protocol

This is a hard Agent protocol revision. It does not emulate both the flat
activity model and the inference model indefinitely.

### Turn frame

The bounded turn frame continues to contain the user message, collapsed Work
summary, and assistant response. The Work segment becomes a lightweight root
scope reference:

```ts
type AgentWorkRenderSegment = {
  id: string;
  type: 'work';
  scopeId: string;
  state: 'running' | 'completed' | 'failed' | 'interrupted';
  revision: string;
  layoutRevision: string;
  durationMs: number | null;
  inferenceCount: number;
  operationCount: number;
  workUnitCount: number;
};
```

Reasoning, commentary, and tool timelines no longer inflate every collapsed
turn frame. Opening Work reads the execution-scope resource. OpenAI's durable
message phase classifies commentary into its inference and keeps only
`final_answer` text in the stable turn-level assistant segment.

### Execution-scope resource

```ts
type AgentExecutionScopeResource = {
  conversationId: string;
  turnId: string;
  scopeId: string;
  parentScopeId: string | null;
  parentOperationId: string | null;
  kind: 'turn' | 'workUnit';
  state: 'running' | 'completed' | 'partial' | 'blocked' |
    'failed' | 'interrupted' | 'abandoned';
  revision: string;
  basisSequence: number;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  objective: string | null;
  doneWhen: string[];
  providedResources: AgentScopeResourceReference[];
  inferenceOrder: string[];
  inferences: AgentInferenceTraceResult[];
  window: {
    startIndex: number;
    endIndexExclusive: number;
    hasEarlier: boolean;
    hasLater: boolean;
  };
  result: string | null;
  returnedResources: AgentScopeResourceReference[];
  threadUpdate: string | null;
};
```

The root scope uses null objective/result metadata when those fields are not
applicable. A work unit uses the same trace plus its handoff metadata.

The resource supports tail, around, and range windows over inferences, known
inference revisions, and an overall known scope revision. The normal response
returns the complete small trace. Pagination becomes visible only when the
bounded response would otherwise exceed its inference-count or byte limit. It
never silently drops old activity or labels a prefix as the complete trace.

### Inference trace

```ts
type AgentInferenceTrace = {
  id: string;
  ordinal: number;
  state: 'running' | 'completed' | 'failed' | 'interrupted' | 'superseded';
  revision: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  reasoning: null | {
    kind: 'providerSummary';
    state: 'streaming' | 'final' | 'partial';
    text: string;
    content?: AgentTextContentReference;
  };
  actionGroup: null | {
    id: string;
    status: 'running' | 'completed' | 'failed' | 'interrupted';
    callCount: number;
    calls: AgentToolCallSummary[];
  };
};
```

`reasoning.text` contains one exact concatenated summary preview, not a list of
checkpoint rows. Oversized text uses the existing exact-content reference and
range reader. It is never summarized again or silently truncated.

The action group carries lightweight call rows. Exact arguments, output,
diffs, and media remain lazy detail resources. A call that owns a child scope
contains `childScopeId`; opening it reads another execution-scope resource and
renders the same component recursively.

### Revision rules

- Conversation `basisSequence` never regresses within one server generation.
- A turn render revision changes only when its bounded frame changes.
- A scope revision changes when scope metadata, inference order, or a visible
  inference summary changes.
- An inference revision changes when its visible summary, state, timing, or
  action-group summary changes.
- Heavy operation output changing does not change unrelated inference or turn
  layout revisions unless its visible lightweight summary changes.
- Stable identities are database IDs, never array indexes, timestamps, or
  checkpoint sequences.
- `notModified` is valid only when the requested identity, protocol version,
  projection version, and server generation still match.

## Viewer presentation

### Root Work disclosure

The existing `Worked for …` row remains the only collapsed representation.
Opening it loads the root execution-scope resource and shows inference cards in
provider order.

Each inference renders:

1. its sparse assistant commentary, when present;
2. its reasoning summary, streamed into one stable Markdown block;
3. a compact state/retry indicator when relevant; and
4. one tool-call group directly beneath the summary.

There is no separate nested “Reasoning: N updates” disclosure. The reasoning
summary itself is the semantic unit. Empty summaries render nothing.

### Tool calls

Tool calls retain the proven compact Codex row, status, duration, expandable
detail, output, diff, and exact-content behavior. Calls from one inference are
visually grouped, including parallel calls. Updating tool progress changes the
existing row in place; it does not append a duplicate.

The `work_unit_start` operation presents a nested Work disclosure rather than a
generic duplicate tool row plus an unrelated work-unit section. Its collapsed
header shows the objective, state, duration, operation count, and returned
resource count. The generic call arguments remain available under an advanced
detail if needed.

### Work-unit disclosure

Opening a work unit shows:

1. objective;
2. completion criteria;
3. provided authority/deliverable/evidence resources;
4. its inference trace rendered by the same component as root Work;
5. result;
6. returned resources.

The exact compiled provider payload is not shown by default. An advanced
diagnostic action may open the already-durable context manifest and dispatch
payload. The normal UI shows the model-authored assignment and resources because
those are the meaningful collaboration boundary.

### Virtualizer and streaming rules

- One inference, reasoning block, tool row, and work-unit disclosure keeps the
  same React/DOM identity for its entire lifetime.
- Streaming mutates content in place and publishes measured height through the
  existing `ResizeObserver`/layout-store path.
- Resource and measured-layout publication remains one external-store batch.
- A user at the bottom follows growth. A user who has scrolled away keeps the
  same visual anchor.
- Opening or closing nested Work changes only the owning turn's additional
  measured height.
- Backgrounding freezes viewport work and preserves the last ready resource
  snapshot; it does not clear, remount, or reset disclosure state while the
  WebView survives.
- Pathological Markdown, tool output, and nested resources remain width-
  contained and cannot enlarge the document.

## Streaming and lifecycle reliability

### Distinct connections

There are two independent channels:

1. the Agent server's provider connection to OpenAI; and
2. the viewer/app connection to Remux.

Losing or destroying the viewer channel must not cancel the provider call. The
send RPC acknowledges durable turn acceptance; the long-running provider loop
belongs to the server. Viewer reconnect is a read/reconciliation operation, not
provider-stream continuation.

### Critical subscription ordering

Agent installs its resource-invalidation subscription during viewer bootstrap,
before React mounts and before the first transcript/resource read. HMR keeps one
tracked subscription and disposes it explicitly. React hooks consume already-
installed invalidations; they do not own the critical subscription lifetime.

The initial sequence is:

```text
initialize host IPC
  -> install invalidation subscription
  -> mount React
  -> select conversation
  -> authoritative transcript + runtime reads in parallel
```

Even with this ordering, initial and resume reads are mandatory because
invalidations are lossy hints.

### Active viewer

- Runtime and transcript invalidations are deduplicated by type/key while
  retaining the greatest `basisSequence`.
- Order-changing, terminal, send-accepted, and generation-changing events
  trigger an immediate authoritative sync.
- Content-only streaming uses a bounded refresh cadence, initially 125 ms.
- Open scope/detail resources refresh only if present in the local resource
  store. Closed disclosures incur no detail reads.
- A transcript sync takes priority over history, composer, context-inspector,
  and queue refreshes.

### Background or inactive viewer

- No transcript, scope, or detail reads are started while hidden.
- Matching invalidations only set dirty intent.
- Ready content and measurements remain intact.
- Pending replaceable reads are cancelled or allowed to finish without applying
  stale results; generation tokens decide whether a response may commit.
- Correctness never depends on receiving invalidations while hidden.

### Foreground/resume

Every `active`, tab-active, pageshow, or host-reconnected transition performs
authoritative transcript and runtime verification in parallel, even if no dirty
flag was observed. The current visible window is preserved when the user is
reading history; a bottom-following viewer requests the tail. Ready content
stays visible during the read.

Only the newest coalesced resume run may apply. If another resume cause arrives
while one is in flight, one follow-up verification runs afterward. Failures in
history, queue, context inspector, or composer refresh do not block transcript
hydration.

### WebView destruction and cold reopen

A destroyed viewer has no state to resume. On reopen it:

1. installs the critical subscription;
2. reads the selected conversation's bounded transcript tail and runtime;
3. renders committed partial reasoning/tool state if the turn is active;
4. subscribes to later invalidations; and
5. continues ordinary streaming from the returned `basisSequence`.

The server does not retain per-viewer cursors. Known revisions are optimization
hints supplied by a surviving viewer, not requirements for correctness.

### Agent server restart

On extension restart:

1. the server receives a new `serverGeneration`;
2. all running inferences are durably marked interrupted before recovery;
3. the live projector is rebuilt from journal events;
4. an eligible running turn/work-unit scope resumes through a new inference;
5. the old inference remains interrupted or superseded and never merges into
   the replacement; and
6. the viewer detects the generation change, discards conditional-read tokens,
   and performs one force-fresh sync while preserving ready content.

If provider continuation cannot be recovered, the turn reaches an explicit
failed/interrupted terminal state. It may never remain visually running solely
because the old process disappeared.

### Retry and duplicate delivery

- A provider retry creates a new inference ID.
- Failed attempt checkpoints remain attached to the failed attempt.
- The default trace may collapse a superseded transport attempt into a compact
  retry row, with its exact summary available on expansion.
- Tool start is idempotent by `(scopeId, callId)` and also validates its source
  inference.
- Tool completion is idempotent and cannot complete a call from another scope
  or inference.
- Replayed invalidations and repeated known-revision reads do not duplicate
  inferences, summaries, tool rows, work units, or assistant text.

## Future notification seam

Notifications will be driven by durable root-turn transitions, not by viewer
stream events. The future notification service can observe a terminal turn
event using an idempotency key such as:

```text
agent-turn:<conversationId>:<turnId>:<terminalSequence>
```

It can notify when the viewer is backgrounded, disconnected, or destroyed
because the server owns both the terminal state and notification intent. A
viewer reopening from the notification navigates to the turn and performs an
ordinary authoritative sync.

This pass must preserve terminal sequence, error/outcome, conversation title,
and a bounded final-response preview in a server-readable projection. It does
not send notifications or make notification delivery part of turn completion.

## Bounds and performance

- Checkpoint persistence and viewer refresh cadence are separate controls.
  Persistence targets recovery loss; refresh cadence targets paint cost.
- The initial checkpoint policy remains bounded by time and bytes and must be
  measured under long reasoning and high-rate tool output before adjustment.
- Viewer streaming performs no more than one transcript/scope refresh per
  cadence per active resource class. Duplicate invalidations collapse.
- Turn frames remain below the existing bounded frame limit because full
  reasoning moves into scope resources.
- Scope resources have explicit inference-count and byte bounds. Oversized
  reasoning and operation detail use exact artifact references; older
  inferences use explicit paging.
- Opening one work unit performs one scope read plus only the operation details
  the user expands. It does not fan out one request per checkpoint or tool row.
- Server resource projection must avoid parsing raw provider artifacts for
  already-finalized summaries; direct finalized artifact references are used.
- Commit-to-applied-viewer latency is measured from journal commit, not provider
  token arrival, so provider/network variance does not obscure viewer cost.

The comparative performance gate uses the same host, conversation fixture,
viewport, disclosure state, and refresh cadence for Agent and Codex:

- Agent median commit-to-paint latency must be no slower than Codex.
- Agent p95 may not exceed 1.25 times Codex p95 without an explained platform
  bottleneck and owner approval.
- Agent must issue no more streaming transcript reads per second than Codex's
  bounded cadence on the same trace.
- Cold tail hydration and resume verification are recorded separately from live
  streaming.

Reliability is the stronger gate: zero lost or duplicated semantic items and an
exact final projection hash across every lifecycle/restart scenario below.

## Implementation checkpoints

### Checkpoint 1 — durable inference relationships

1. Add source-inference identity to operations and parent-operation identity to
   child scopes.
2. Make checkpoint `inferenceId` mandatory while an inference is running.
3. Replace the split provider-item/checkpoint/terminal sequence with one
   semantic inference-finalization transaction while retaining streamed
   checkpoints.
4. Store direct finalized reasoning/assistant artifacts on the inference.
5. Make final provider output authoritative over provisional stream fragments.
6. Rebuild and validate replay, retry, restart, work-unit entry, and tool
   idempotency tests.

Completion criterion: a journal-only query deterministically reconstructs each
scope's ordered inferences, each inference's visible summary, its calls, and any
child scope without consulting coordinator memory.

### Checkpoint 2 — protocol and projection

1. Introduce the execution-scope and inference-trace resources.
2. Reduce the collapsed turn Work segment to a lightweight root-scope summary.
3. Project finalized summaries from direct artifacts and running summaries from
   checkpoint fragments.
4. Group operations by explicit source inference.
5. Link work-unit calls to child scope resources.
6. Add known revisions, pagination, exact-content references, byte limits, and
   `notModified` behavior.
7. Remove the old flat work-unit activity projection after fixture parity is
   established.

Completion criterion: cold SQLite projection and live-projector projection are
deeply equal at every semantic boundary in a multi-inference root/work-unit
fixture.

### Checkpoint 3 — recursive viewer

1. Implement one reusable `ExecutionScopeTrace` component.
2. Render root Work and nested work units with that component.
3. Render one stable reasoning Markdown block and one action group per
   inference.
4. Reuse the existing tool row, detail, diff, exact-content, disclosure,
   measurement, and virtualizer behavior.
5. Preserve assistant response streaming as a separate turn segment.
6. Remove checkpoint-count wording and the flat work-unit Activity disclosure.

Completion criterion: the same fixture renders the intended hierarchy on
desktop and phone, updates every row in place during streaming, and preserves
scroll/disclosure state.

### Checkpoint 4 — lifecycle and transport hardening

1. Move the critical Agent invalidation subscription before React mount.
2. Make transcript hydration foreground-first and independent of generic
   resource refresh success.
3. Verify active/inactive/background, reconnect, pageshow, and server-generation
   recovery with preserve-ready behavior.
4. Add cancellation/generation fencing for replaceable scope/detail reads.
5. Ensure hidden viewers schedule no repeated reads.
6. Add the future notification projection seam without sending notifications.

Completion criterion: the full lifecycle matrix passes with zero semantic
loss, duplication, stale regression, or turn stuck running.

### Checkpoint 5 — real smoke and comparative closeout

1. Run a real OpenAI turn with multiple root inferences, ordinary tools, a work
   unit with multiple inferences, returned resources, and a final response.
2. Repeat while backgrounding, disconnecting, destroying/reopening the viewer,
   and restarting the Agent extension at controlled boundaries.
3. Compare commit-to-paint, read cadence, hydration, memory, and projection
   hashes against the stable Codex viewer path.
4. Perform physical-phone validation of safe areas, keyboard transitions,
   manual scrolling, bottom follow, disclosure measurement, and cold reopen.

Completion criterion: automated gates pass, the real-subscription trace is
fully reconstructible from the journal, and the owner accepts desktop and
physical-phone behavior.

## Verification matrix

### Deterministic projection

- one inference with reasoning and final response;
- multiple inference/tool/result cycles;
- an inference with no visible reasoning;
- parallel tool calls under one inference;
- tool failure followed by recovery;
- provider retry with a superseded partial summary;
- work-unit entry, multiple child inferences, return, and parent continuation;
- interrupted root and child scopes with only checkpointed partial text;
- finalized output differing from the provisional prefix;
- oversized reasoning and tool output with exact range continuation;
- enough inferences to require explicit scope paging;
- cold replay equal to every captured live projection.

### Viewer and virtualizer

- reasoning deltas mutate one DOM block instead of adding rows;
- tool status and output mutate one call row;
- nested work-unit growth updates only its owning turn measurement;
- bottom-follow remains attached during long reasoning and tool output;
- a manually scrolled viewport does not jump during any nested update;
- open/closed disclosures survive background/foreground while mounted;
- a cold viewer rehydrates the same hierarchy and active states;
- long Markdown, code, tables, diffs, and paths stay width-contained;
- no per-row resource fan-out on opening root or child Work.

### Lifecycle and faults

- drop all invalidations for a period, then resume sync;
- duplicate and reorder invalidations;
- disconnect the viewer host WebSocket while the provider continues;
- background before a checkpoint, tool start, tool end, inference end, work-unit
  return, and turn terminal event;
- destroy and reopen the WebView at each of those boundaries;
- reconnect with the same server generation and with a new generation;
- restart the Agent extension during reasoning, tool execution, and child scope;
- fail one transcript, history, runtime, queue, context, and detail read
  independently;
- ensure a stale older response never overwrites a newer `basisSequence`;
- confirm no active/inactive loop performs background read churn.

The canonical assertion after every scenario is:

```text
render projection after recovery
  == fresh projection from durable journal at the same basisSequence
```

### Real smoke

The real smoke is not a unit-test substitute. It uses the same send, provider,
durability, invalidation, resource-read, viewer, and work-unit paths as the
owner. The test controller may drive lifecycle and reconnection, but it may not
inject transcript rows or bypass the Agent server.

It records:

- provider and viewer connection generations;
- turn, scope, inference, operation, and terminal IDs;
- journal and final render projection hashes;
- checkpoint, invalidation, and resource-read counts;
- commit-to-paint latency distribution;
- cold hydration and resume duration;
- duplicate/missing semantic identity checks; and
- screenshots of root and nested Work on desktop and phone.

## Cutover

The Agent is still a development harness, so this is a clean protocol/schema
cut rather than a permanent dual reader. Before implementation, preserve any
benchmark evidence that is still valuable. The schema version, transcript
protocol version, projection version, fixture corpus, and seeded conversation
are then advanced together. The development database may be recreated and the
canonical multi-turn fixture reseeded.

The Codex extension is not modified. It remains the behavioral and performance
comparison until this pass is accepted. The old Agent flat reasoning/work-unit
projection is removed after the recursive viewer and cold replay tests pass;
there is no hidden compatibility mode left to drift.
