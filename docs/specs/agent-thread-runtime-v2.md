# Agent Thread Runtime v2: exact dialogue and living thread state

Status: Implemented
Last verified: 2026-08-11
Canonical code: `extensions/agent/server/src/{context,storage,pi-runtime.ts,agent-server.ts}` and `extensions/agent/tests/`
Replaces: the turn-capsule layer in `agent-thread-runtime-v1.md`

The later `agent-living-thread-canvas-v1.md` checkpoint supersedes this
document's thin-brief guidance and model-facing `thread_update` operation while
retaining the v2 storage, compilation, journal, and work-unit foundation.

## Outcome

The Agent uses four context lifetimes with non-overlapping jobs:

1. exact current-scope provider context for reasoning, tools, and work;
2. exact recent completed user/assistant turns for conversational continuity;
3. one versioned branch-scoped `thread.md` for current collaborative state; and
4. the immutable journal for all exact cold history and evidence.

Turn capsules are removed. No foreground or background process summarizes every
turn. Completed visible turns remain exact while they fit the recent-dialogue
budget, then leave normal context as whole units. Information that should remain
active is deliberately maintained in `thread.md`; anything else remains
retrievable from the journal.

Work units remain provider-context branches. A coherent unit may consume a
substantial part of the healthy model window. The harness does not split work at
an arbitrary small token count or compact an active trace. It warns before an
execution scope reaches unhealthy or unsafe pressure so the model can close the
current semantic checkpoint cleanly.

This is a clean development cutover. The database is recreated under a new
schema identity; v1 databases, capsules, manifests, and context frames are not
migrated or read.

## Non-goals

- No turn capsules or per-turn generated summaries.
- No background context-manager agent.
- No Pi, provider, manual, or model-written transcript compaction.
- No automatic promotion of retrieved history into persistent state.
- No fixed small work-unit size.
- No project-wide document compiled into every thread in v2.
- No automatic parent-scope checkpoint until a real multi-unit benchmark proves
  it is required.
- No compatibility readers, legacy schema migrations, or product context modes.

## Durable hierarchy

```text
project
└── conversation (user-visible thread)
    └── strand (edit/fork branch)
        ├── versioned thread.md
        └── turns
            ├── exact user message
            ├── exact visible assistant response
            ├── exact provider items and reasoning
            ├── tool operations and artifacts
            └── optional work units
                ├── exact private child trace
                └── bounded continuation bundle
                    ├── result Markdown
                    ├── proposed Thread update
                    └── authority/deliverable/evidence snapshots
```

The journal and content-addressed artifact store remain canonical. Transcript
items, searchable text, context manifests, and UI resources are rebuildable
projections.

## Context presented to the model

### Fresh user turn

The provider-visible order is:

1. fixed system prompt and tool contracts;
2. selected exact completed dialogue turns in chronological order;
3. one synthetic control message containing the complete current `thread.md`,
   its exact version reference, and a cold-history omission notice;
4. the exact current user message; and
5. exact current-turn provider items as the turn proceeds.

This reads naturally as:

```text
Here is the recent conversation.
Here is the current shared understanding after that conversation.
Here is the user's request now.
```

Putting the mutable thread document after older dialogue makes current state the
nearest authority before the new request. It also allows a longer exact-dialogue
prefix to remain cacheable across turns than placing a newly revised document at
the front of every request.

### Active turn and work unit

Inside an execution scope, provider messages remain exact and append-only. Tool
calls, tool results, visible reasoning summaries, private reasoning signatures,
and assistant messages remain in their original provider order. The harness
rebuilds context only at a semantic boundary: new user turn, work-unit entry,
work-unit return, pressure notice, or crash recovery.

A work unit inherits the parent provider anchor and a focused orientation. The
parent supplies one semantic objective, optional observable `doneWhen`
conditions, and selected resources classified as authority, deliverable, or
evidence. Each resource is resolved to an immutable content-addressed snapshot
before the boundary succeeds and its exact UTF-8 contents are materialized into
the child context. Its trace remains private. The model-facing
`work_unit_finish` tool closes it with completed, partial, or blocked status and
contributes only its explicit continuation bundle plus selected exact resource
snapshots to the parent.

## Exact recent dialogue

A dialogue group is one terminal completed turn containing:

- the exact provider-visible user content, including image/attachment content;
  and
- the exact visible terminal assistant response.

Completed-turn reasoning, tool calls, tool results, internal messages, work-unit
traces, and harness events are never part of recent dialogue. Failed or
interrupted turns without a terminal visible assistant response are not
synthesized into fake dialogue; their exact records remain in the journal and
their visible failure remains in the UI transcript.

The compiler selects newest whole dialogue groups and restores them to
chronological order. It never truncates a user or assistant message and never
keeps half a turn. The initial default recent-dialogue target is the smaller of:

- 64,000 estimated tokens; or
- 20 percent of the advertised model context window, with a floor of 16,000.

This is a harness constant and benchmark parameter, not a user-facing mode. A
group that does not fit is omitted whole. The synthetic control message reports
how many older eligible turns were omitted and exposes the conversation journal
reference. Exact history is never deleted.

There is no capsule tail and no independent capsule budget. The historical
portion of the prompt therefore has one selection rule and no duplicate
representation of the same recent turn.

## Living `thread.md`

`thread.md` is the sole model-maintained cross-turn state compiled by default.
It is a current collaboration brief, not an event log or historical summary.

It may retain:

- the current objective and near-term direction;
- user-accepted decisions and active constraints;
- current implementation or investigation state;
- important governing resources and evidence references;
- unresolved questions, risks, and limitations; and
- facts from older history that remain relevant now.

It must not retain:

- raw reasoning or tool traffic;
- command output or copied source files;
- a chronological block for every completed turn;
- rejected or superseded ideas as though still active;
- transient facts needed only to answer the current message; or
- claims that model-written state outranks the current user, a governing
  contract, or observed repository state.

The parent model uses the compare-and-swap `thread_read`, `thread_patch`, and
`thread_replace` tools. A work unit cannot update the document directly; it may
return a proposed Thread update, which the parent deliberately merges after
accounting for user decisions and newer evidence. Recommendations therefore do
not become accepted state merely because an audit child proposed them.

The foreground model revises `thread.md` near the end of a meaningful turn when
future context changed, then sends its user-facing response. A transient answer
does not require a state update. The document is stored with a generous 96 KiB
hard safety limit and is compiled in full. The compiler never silently truncates
it. If the document reaches the hard limit, the update is rejected and the model
must revise it coherently.

Every turn continues to record `thread_version_before` and
`thread_version_after`. These fields, not capsules, define historical state for
edit/fork behavior:

- fork before a turn inherits `thread_version_before`;
- fork after a terminal turn inherits `thread_version_after`; and
- a turn with no update has identical before/after versions.

Turn finalization settles the assistant projection, terminal state, and thread
version after the turn atomically. It does not create a summary artifact.

## Governing resources

`thread.md` provides orientation, not proof. The system prompt must state:

> Before implementing or auditing against an active governing file named in
> thread state, reopen that exact file unless its exact contents are already in
> the current scope. Model-written thread state records the current
> understanding; it does not substitute for the governing source.

Normal file and History tools remain available, but a work-unit boundary can
carry selected exact text resources directly. A resource may be a working-
directory-relative path, an absolute path, or an openable History reference.
The harness reads it before reporting boundary success, rejects missing or
non-UTF-8 content as a correctable tool error, stores the immutable snapshot in
the journal, and renders its full contents into the receiving scope.

Returned snapshots remain in the parent provider context for the rest of the
turn, so later work units inherit them naturally. If the same content hash is
selected again in that turn, the handoff emits metadata rather than a duplicate
body. A changed file produces a new snapshot and body. Snapshot freshness is
explicit: the snapshot is exact at capture time, while the source file may need
to be re-read after later edits. At the next user turn, the full body leaves hot
scope scratch but its History reference remains openable.

## History retrieval

Old dialogue and all omitted internals remain in the immutable internal
journal, exposed through a plain two-tool model surface:

- `history_search` finds exact durable messages, visible outcomes, Thread
  versions, work-unit objectives/results, artifacts, and optional operations;
- `history_read` reads a returned exact `history://` reference with byte
  continuation.

Retrieval is ephemeral. Opening an old turn does not update `thread.md` or make
it part of later turns. If the retrieved information becomes active again, the
foreground parent deliberately revises `thread.md`.

### Search projection

The current application-level scan is replaced by a rebuildable SQLite FTS5
projection. Canonical journal tables and artifacts remain authoritative. The
projection indexes:

- exact user message text;
- exact visible assistant response text;
- every `thread.md` version;
- work-unit objectives, returned bundles, and referenced artifacts;
- artifact/file-path metadata; and
- tool names and searchable operation text for `include: "operations"`.

Search applies project/conversation scope filters before ranking, prefers the
active strand and current conversation when relevance is otherwise equal, and
returns stable exact model-facing `history://` references. The repository maps
these to its internal journal identifiers. Query text is tokenized and safely
quoted by the server rather than interpolated as raw FTS syntax. The index is
rebuildable from canonical storage and is recreated with the v2 database.

The public tool shape remains small. Cursor/date/kind filters may be added only
when a benchmark or real workflow demonstrates that lexical query plus scope is
insufficient.

## Context pressure

Work-unit boundaries remain semantic. A 140k-token coherent implementation unit
is valid when the model and provider remain healthy. The harness does not force
an early split merely to lower a metric.

Each execution scope has a durable one-shot soft pressure boundary:

```text
soft_limit = min(200,000, model_context_window - 60,000)
hard admission remains the provider window minus output/safety reserves
```

When the next request would cross the soft limit and the scope has not already
been notified, the harness commits a pressure event and an internal control
message, recompiles the frame, and dispatches with that notice included. The
notice is stable for subsequent calls and occurs at most once per scope.

For a child work unit, the notice asks the model to finish the current coherent
checkpoint, perform the most important remaining validation, and call
`work_unit_finish`. For a parent scope, it asks the model to integrate completed
work, update retained thread state if necessary, and complete the user turn
honestly. It does not claim that work is complete.

Pressure never automatically:

- compacts or rewrites a provider trace;
- returns a child;
- creates a new work unit;
- mutates `thread.md`; or
- hides a hard context-limit failure.

Low-threshold deterministic tests exercise the boundary. The production
threshold remains model-aware and is recorded in context evidence.

## Parent coordination

Returned work-unit bundles accumulate in the active parent scope. Each bundle
has three focused parts:

1. required result Markdown with the outcome, changes, validation, and
   unresolved issues;
2. optional proposed Thread Markdown for the parent to merge; and
3. optional exact resources classified as authority, deliverable, or evidence.

The primary result and Thread proposal have no fixed low byte cap: the child
branch is discarded, so only the returned bundle consumes the parent scope's
remaining context. Resource descriptors remain capped separately at 16 KiB and
sixteen entries, but selected resource bodies are not truncated or replaced by
pointers. They are copied exactly into the receiving context and retained as
content-addressed snapshots. The complete rendered bundle is stored as the
execution scope's immutable Markdown result artifact and folded into the
parent. Structured resource metadata, including hash, byte length, source, and
whether the body was newly materialized or already inherited, is retained on
the return event.

All deterministic return validation and normalization happens before
`work_unit_finish` reports tool success. The durable scope transition still
commits after the tool-result boundary, preserving replay order. A malformed
handoff therefore remains a correctable child tool error rather than becoming a
failed parent transition.

This preserves the behavior measured in the three-unit turn, where bounded
returns left the parent well below pressure, while making continuation-critical
sources inspectable. A later work unit inherits returned resource bodies already
present in the parent and may receive additional selected resources through
`work_unit_start`; it does not inherit the prior child's private trace or every
file the child touched.

An internal parent checkpoint is explicitly deferred. It becomes eligible only
if a controlled multi-unit task shows that concise sibling returns push the
parent beyond the healthy boundary. That future checkpoint would create a fresh
provider parent from the exact user request, current thread state, and bounded
completed-unit handoffs; it would not mutate journal truth or masquerade as
transcript compaction.

## Schema v2 cutover

The schema identity becomes `agent-thread-runtime-v2`. Deployment moves the
development Agent data root to a recoverable archive and creates a fresh store.
No v1 rows are copied.

Remove:

- the `turn_capsules` table;
- `turns.capsule_id` and its foreign key;
- capsule artifact preparation during turn finalization;
- `capsule_tail` context layers and capsule IDs in manifests;
- capsule journal resources and search candidates;
- capsule benchmark counters and mechanics gates; and
- every compatibility path for capsule-bearing frames or v1 schema identity.

Retain:

- projects, conversations, strands, turns, and execution scopes;
- exact messages, provider items, inferences, operations, events, and artifacts;
- state documents and immutable document versions;
- `turns.thread_version_before/after`;
- actual context frames and manifests;
- transcript/resource projections; and
- work-unit result artifacts.

Add:

- a rebuildable FTS5 journal-search projection;
- durable per-scope pressure-notice evidence, represented by journal events
  rather than a mutable hidden flag; and
- context-manifest fields for selected dialogue turn IDs, omitted eligible turn
  count, complete thread-document tokens, active-scope tokens, soft limit, and
  notice state.

## Context manifest and UI evidence

Every provider dispatch records:

- exact ordered provider item hashes;
- selected recent dialogue turn IDs;
- omitted eligible dialogue count;
- full `thread.md` version, hash, bytes, and estimated tokens;
- active-turn and active-scope estimated tokens;
- execution scope kind and work-unit identity;
- soft/hard context limits and whether pressure was noticed;
- full versus continuation transport mode; and
- build duration and reported provider usage.

The Agent composer status should describe the real layers rather than a shadow
or capsule mode. A compact example is:

```text
thread 3k · recent 10k · active 141k · work unit
```

The UI does not expose a configuration mode or manual compaction action. Detailed
manifest evidence remains available to tests and future diagnostics.

## System-prompt behavior

The production prompts are repository-owned Markdown at
`extensions/agent/server/prompts/system.md` and `work-unit.md`; they are copied
into the server build and loaded at startup rather than hidden in TypeScript.
The prompt remains descriptive rather than procedural. It teaches these
invariants:

- recent dialogue is exact but may contain superseded statements;
- the nearer `thread.md` is current shared state;
- governing files and observed repository state outrank model-maintained text;
- update `thread.md` only when future context changed;
- journal retrieval is exact, cold, and ephemeral;
- ordinary short work stays in the parent;
- substantial coherent scratch may use a work unit and most of the healthy
  context window;
- close a pressured child through an explicit bounded return; and
- report uncertainty and incomplete validation honestly.

The prompt does not prescribe a brainstorm/spec/implement workflow, require a
work unit, force a thread update, or classify the user's request into modes.
The runtime also exposes scope-valid tools only: the parent receives Thread,
History, and `work_unit_start`, while a child receives History and
`work_unit_finish`. Both retain the normal file and shell tools.

## Implementation checkpoints

### V2.1 — schema and turn finalization

- bump the schema identity and recreate the development data root;
- remove capsule schema, artifacts, resources, and finalization work;
- settle `thread_version_after` directly on every terminal turn;
- preserve before/after fork inheritance; and
- update projection hashes and deterministic storage tests.

### V2.2 — exact-dialogue compiler

- replace independent capsule/dialogue layers with whole exact completed turns;
- place exact dialogue before the complete thread control message;
- remove thread truncation;
- emit cold-history omission metadata;
- update prompt, frame manifest, compiler tests, and restart tests; and
- retain exact active provider continuation and work-unit isolation.

### V2.3 — graceful pressure

- add durable one-shot pressure events/messages;
- recompile once when a notice is first crossed;
- provide scope-specific child/parent wording;
- retain fail-closed hard admission; and
- test low-threshold notification, restart, and no-duplicate behavior.

### V2.4 — indexed journal retrieval

- create and rebuild the FTS projection;
- index exact dialogue, document versions, work results, paths, and optional
  operations;
- preserve stable project/conversation scoping and exact refs;
- add scale, relevance, and malformed-query tests; and
- remove application-level full-corpus scanning.

### V2.5 — evidence, UI, and real validation

- replace capsule metrics with recent-dialogue/thread/pressure evidence;
- update inline status and benchmark extraction;
- run the complete Agent server, UI, build, typecheck, and viewer acceptance
  suites;
- run a real subscription smoke covering update, eviction, retrieval, work-unit
  return, pressure, restart, edit, and fork; and
- rerun the frozen Ledger Agent benchmark through the production API path.

### V2.6 — auditable work-unit resource handoffs

- give each child an explicit objective and optional observable `doneWhen`
  conditions while the parent retains the turn plan and integration decisions;
- replace pointer-only boundary artifacts with exact authority, deliverable, and
  evidence snapshots materialized into the receiving context;
- require completed, partial, or blocked return status and preserve the result
  and optional Thread proposal without a fixed low byte cap;
- keep child traces private while making selected file or History contents
  directly inspectable by the parent;
- deduplicate unchanged returned snapshots for the remainder of the turn and
  materialize changed content as a new snapshot; and
- validate all boundary input and resource reads before reporting tool success.

## Implementation evidence

The clean v2 cutover was completed on 2026-08-10. The former development data
root was moved intact to
`~/.local/share/remux/agent-archive-thread-runtime-v1-20260810`; the live Agent
store was recreated with schema identity `agent-thread-runtime-v2`.

Automated validation passed 31 server tests, 34 viewer unit tests, and 78 browser
tests with two platform-specific skips. A real GPT-5.6 Sol/high acceptance run
also passed exact dialogue continuation, `thread.md` nonce recall across
restart, work-unit return isolation, and terminal durability.

The first frozen Ledger run is retained at
`.remux-benchmarks/runs/2026-08-10T21-37-43-616Z-agent-f5681a`. It completed all
four collaborative turns in 27m34s with 110 provider calls, no compaction,
no context-limit or invalid-context calls, two returned work units, a 167,495
token peak root scope, a 101,813 token peak child scope, and a 90.9% reported
cache-read ratio. Exact recent dialogue peaked at three turns; `thread.md`
peaked at 3,226 bytes; no cold journal retrieval was needed.

The benchmark did **not** pass implementation quality. Hidden validation found
missing public ES replay symbols and builder compatibility, and the CLI could
discard one of simultaneous playback/shutdown failures. It therefore provides
useful v2 context evidence, not task correctness or superiority over Codex. Its
originally captured mechanics gate also failed at 109 durable provider items
for 110 frames, exposing a terminal-durability race: the benchmark driver could
observe idle before the last provider item committed. That item later settled,
and the runtime now defers terminal publication until the exact assistant
boundary and durability tail settle. A two-turn real-provider restart sentinel
then verified matching turns, inferences, and provider items with no running
records.

## Acceptance criteria

The cutover is complete only when:

1. no capsule schema, artifacts, context layers, resources, tests, or runtime
   vocabulary remain;
2. a new turn receives exact recent user/assistant pairs with no prior tools,
   reasoning, or duplicate summary representation;
3. recent turns are selected and evicted whole under one global dialogue budget;
4. the complete current `thread.md` is ordered after old dialogue and before the
   current user request;
5. a meaningful foreground turn can update state before its visible response,
   while a transient answer can finish without an update;
6. old omitted dialogue remains exactly searchable and opening it does not
   mutate retained state;
7. implementation and audit scopes are reminded to reopen named governing
   resources rather than trusting derived state;
8. a large coherent work unit can run normally, receives one durable early
   pressure notice when configured to cross the boundary, and returns without
   leaking its trace;
9. repeated sibling work units keep explicit bounded handoffs, selected exact
   resources remain auditable and reusable, and the parent never receives child
   reasoning or raw operations unless it deliberately retrieves that trace;
10. active-scope restart preserves exact provider reasoning/signatures and does
    not duplicate a pressure notice;
11. edit/fork before and after a historical turn inherit the correct exact
    `thread.md` version without capsule metadata;
12. journal search is indexed, scoped, deterministic, and returns exact openable
    references;
13. context evidence and UI report thread, recent, active, scope, pressure, and
    transport behavior accurately;
14. Pi/provider/manual compaction remains absent; and
15. automated validation, real subscription smoke, and the frozen Ledger
    benchmark all complete with inspectable evidence and no context mechanics
    regression.

## Benchmark interpretation

The existing Ledger fixture remains the development regression and Codex
remains the external control. V2 should not be called better merely because it
has no capsules, uses fewer tokens, or avoids compaction.

The rerun must report at least:

- visible and hidden correctness gates;
- wall time, provider calls, tool calls, and output;
- reported input/cache tokens and request modes;
- starting and peak root/child context;
- selected/omitted exact dialogue turns and thread-document size;
- thread updates and journal retrieval usefulness;
- pressure notices and hard-limit failures;
- work-unit enter/return/result sizes and parent-visible bytes; and
- compaction, invalid context calls, leakage, and restart behavior.

The first v2 comparison answers a narrow causal question: whether removing the
duplicated capsule layer preserves or improves the already-working thread/work
unit mechanics. Cold recall, supersession, branch isolation, and long-lived
project behavior require separate held-out scenarios before any general harness
quality claim.
