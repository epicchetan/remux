# Agent context workspace v1

Status: Archived; superseded by `agent-explicit-turn-context-v1.md`
Last verified: 2026-08-16
Canonical code: `extensions/agent/server/src/context/`,
`extensions/agent/server/src/project-state/`, and
`extensions/agent/server/src/storage/repository.ts`

This document defines the first authoritative Remux Agent context system. It
replaces the diagnostic-only shadow compiler with a model-managed context
workspace and deterministic context frames. The journal remains lossless and
authoritative; provider context becomes a bounded, disposable projection.

## Outcome

The Agent must complete long, multi-turn coding work without manual
compaction. It must preserve user intent and active implementation state while
allowing bulky tool observations and old dialogue to leave the provider
window without being deleted.

The first implementation is deliberately small:

- normal coding tools may read and write any path available to the Remux Unix
  account; the conversation cwd is orientation, not a security boundary;
- the immutable journal remains the exact transcript and audit trail;
- the model can search and open journal evidence without automatically keeping
  it in future context;
- the model can atomically update semantic state and pinned resources;
- the compiler emits stable context frames and rolls them only under pressure;
- eviction is deterministic demotion to a retrievable handle, never deletion;
- full-history mode remains available as an evaluation control.

This version does not add embeddings, learned relevance, a background memory
model, nested work scopes, or a user-facing context editor.

## Existing foundation

The implementation builds on the current Agent primitives:

- projects, conversations, strands, turns, execution scopes, epochs,
  inferences, operations, artifacts, and immutable journal events;
- project context spaces, revisioned primaries, bindings, masking, and
  provenance;
- deterministic canonical JSON and artifact-addressed large values;
- provider preflight, durable inference manifests, and context inspection;
- the Pi 0.84 runtime using the OpenAI Codex subscription transport;
- the E0 Ledger collaboration benchmark and production-path adapter.

No parallel memory database is introduced. Model state is represented by
project primaries and context bindings already stored in the journal database.

## Context lifetimes

### Ephemeral evidence

`history_search`, `history_read`, ordinary file reads, and tool output enter the
current provider conversation. They are guaranteed to be available to the next
inference in the active frame. They do not become durable semantic state merely
because the model looked at them.

### Pinned resources

The model explicitly pins an exact governing resource with
`context_update.pin` and unpins it when it no longer matters. A pin accepts an
absolute or cwd-relative UTF-8 file or an immutable journal reference. Its
content and hash are snapshotted into the revisioned primary up to the v1
64 KiB exact-content limit. Under snapshot pressure the compiler may demote
the body to an excerpt plus an openable handle; the journal source remains
retrievable. The model re-reads a live file before implementation or final
validation because the pin is an authoritative snapshot, not a filesystem
watch.

### Durable semantic state

The model explicitly commits small canonical JSON values with
`context_update.set`. State is keyed and replaceable rather than an append-only
pile of notes. The normal home is the current thread. Project scope is
explicit and is reserved for state that other threads should inherit.

User-authored constraints and permissions remain authoritative. Model state
cannot weaken them. Model-authored state is explicitly presented as fallible
working memory, not source authority. It cannot override the current user
request, an accepted specification, or observed repository state. When an
exact spec or contract governs ongoing work, the model should keep that
resource active and re-read it before implementation and final audit; an
interpretive state value is not a substitute for the source.

## Model tools

### `history_search`

Input:

```json
{"query":"FIFO regression","limit":10,"scope":"project"}
```

The tool searches durable messages, tool operations, and context primaries. It
returns bounded excerpts, stable references, kinds, and journal sequence or
state revision. Results are ephemeral.

### `history_read`

Input:

```json
{"ref":"history://event/123","offset":0,"maxBytes":24000}
```

The tool returns a bounded exact expansion, content hash, byte range, and
continuation offset. Opening evidence is ephemeral.

### `context_update`

Input is one atomic, model-oriented update:

```json
{
  "set": [
    {
      "key": "active-implementation",
      "value": {
        "objective": "Implement the accepted feed spec",
        "status": "editing",
        "next": ["finish session lifecycle", "run workspace tests"]
      },
      "evidence": ["history://message/example#assistant"]
    }
  ],
  "pin": [
    {
      "ref": "/work/docs/accepted-spec.md",
      "label": "accepted spec"
    }
  ]
}
```

The four primitives are `set`, `remove`, `pin`, and `unpin`. Scope defaults to
`thread`; `project` must be explicit. The model never supplies a database
revision, primary kind, binding mode, retention class, or promotion operation.
The repository serializes the atomic update against current state, stores exact
revision history internally, and treats identical sets, missing removes, and
missing unpins as harmless no-ops. The result returns active thread/project
keys, pinned resources, estimated footprint, and warnings.

Stable keys must be updated instead of creating dated or numbered variants.
State values must contain decisions and current work, not copies of source
files, command logs, or transcript prose.

## Context frame

“Epoch” remains the durable execution/inference lineage term in storage. The
provider-facing object is called a context frame.

A frame begins with one deterministic bootstrap containing, in stable order:

1. context HUD and retrieval instructions;
2. project semantic state;
3. strand semantic state;
4. working-resource descriptors or bodies;
5. harness-derived runtime state;
6. the current user request;
7. the newest raw evidence that fits;
8. omission handles.

After the bootstrap, provider messages are append-only. Tool calls,
observations, steering, and `context_update` results append normally. A state
mutation does not rewrite the active prefix.

Visible model reasoning remains in the lossless journal and transcript for
inspection, but it is not part of durable provider-context identity and is not
reconstructed into a new frame. Pi can expose a streamed reasoning view that
differs from the provider-final representation in whitespace or corrected
fragments. Treating that presentation as replayable context would make an
otherwise identical frame nondeterministic. Assistant text, tool call IDs and
arguments, and exact tool results remain identity-bearing and must reconcile
before dispatch.

The compiler opens a new frame when:

- there is no active frame, including after runtime restart;
- the estimated active input reaches the rollover threshold;
- the active frame can no longer be reconciled with durable journal truth.

On rollover, the compiler reads the latest state revision, collapses prior
work into the canonical bootstrap, keeps the newest bounded evidence, and
emits retrieval handles for omitted content. Changing the prefix causes Pi's
cached Codex transport to send a full request. An unchanged prefix uses normal
`previous_response_id` continuation. The compiler therefore does not rewrite
context before every action and preserves KV-cache reuse inside a frame.

No turn-end compaction exists. A frame may span many user turns, and a single
large turn may cross several frames.

## Deterministic demotion

When a frame is over budget, content is demoted in this order:

1. unpinned resources;
2. already-handled ephemeral tool results;
3. superseded resource versions;
4. completed process polling output;
5. oldest/largest pinned resource bodies, retaining their handles;
6. sticky exact bodies to excerpt plus handle, then handle;
7. oversized semantic bodies to descriptor plus handle as a last resort.

The current user request, unhandled steering, active permissions, fixed
contracts, current state revision, and omission handles are never silently
removed.

Version 1 implements this with stable ordering, bounded per-value
externalization, newest-first raw-tail selection, pinned/unpinned binding
modes, and explicit retrieval handles. It does not use a semantic classifier.

## System prompt contract

The always-on prompt is short and says:

- the cwd is the default location, not a filesystem boundary;
- the journal is exact truth and retrieval is ephemeral;
- context state is durable working memory;
- model-authored state is fallible and never overrides user, spec, or observed
  source authority;
- update state at semantic transitions, not after every command;
- keep exact governing specs while active and do not promote speculative
  deviations as accepted decisions;
- keep exact resources only while they matter and release them when done;
- update stable keys rather than accumulating notes;
- user constraints and commit/push permission remain authoritative;
- use journal retrieval when a missing fact matters instead of guessing.

Mechanical runtime facts such as cwd, changed files, command status, and
artifact handles are owned by the harness where possible. The model should not
spend semantic state on them.

## Runtime modes

`full-history` uses the same Pi model, tools, journal, durability fences, UI,
and benchmark adapter, but selects full replay for the provider.

`stateful` uses the context workspace and frame compiler described here.

State may still be recorded in full-history mode, but it does not select the
provider prompt. This makes it a useful control without changing the rest of
the harness.

The product default is `stateful`. The benchmark adapter may select either mode
when creating a conversation.

## Durable evidence and inspection

Every inference records:

- runtime mode and frame ordinal;
- frame bootstrap and semantic hashes;
- state revision and journal basis;
- selected blocks and omission handles;
- estimated active input;
- full versus continuation transport mode;
- tool/state activity needed to calculate benchmark metrics.

The provider fence records the planned transport before network I/O. Because
Pi decides WebSocket delta eligibility after that fence, the harness also
records an immutable post-response `inference.transport` observation and
updates the inspector projection with the actual full/delta result. Benchmark
cache metrics use the observed result, not the preflight plan.

The existing context inspector remains diagnostic, but its labels must describe
the authoritative frame rather than calling it a shadow candidate.

Some internal TypeScript property/type names and the durable
`context_compilations.mode` compatibility value still use `shadow`, inherited
from Phase 1A.3. In stateful mode those values now carry the authoritative
frame candidate; the legacy spelling is not a second compiler or a user-facing
runtime mode. Renaming persisted fields is deferred until a storage migration
has a product reason.

## Implementation slices

### H1: useful coding runtime and recall

- enable Pi read, bash, edit, and write tools with absolute paths;
- describe cwd as orientation;
- add `history_search` and `history_read`;
- preserve all calls and results in the durable journal;
- add full-history/stateful selection to the production benchmark adapter.

### H2: context workspace and active frames

- add the atomic `context_update` repository transaction and tool;
- compile semantic and working primaries into the bootstrap;
- keep a stable frame prefix within a run;
- rebuild at deterministic pressure thresholds;
- record active frame manifests and inspection data;
- recover state and start a new frame after runtime restart.

### H3: evaluation and refinement

- run focused unit/integration tests;
- run the production-path sentinel;
- run the E0 Ledger benchmark in stateful mode;
- compare it with the existing GPT-5.6 Codex/App Server baseline and, when
  useful, the full-history Agent control;
- inspect tool usage, state updates, frame rollovers, retrieval, correctness,
  tokens, cache reuse, and wall time;
- preserve a failed run's workspace, completed stages, and conversation ID so
  the remaining stages can be resumed after an extension-process restart;
- fix correctness gaps exposed by the real run before declaring the slice
  complete.

## Completion criteria

The implementation is complete only when all of the following hold:

- a model can read and edit outside cwd using an absolute path;
- journal search/open retrieves old evidence without creating active state;
- state transactions are atomic, revision checked, durable across repository
  reopen, and isolated by strand unless promoted;
- unpinned resources leave active context but remain retrievable;
- compilation is byte-deterministic for the same journal basis and revision;
- the provider prefix remains stable across ordinary tool calls;
- pressure rollover changes the prefix and produces a full transport request;
- current user intent and user authority survive rollover;
- no Pi manual or automatic compaction is enabled;
- the Agent production build and focused suites pass;
- the real production-path sentinel passes;
- a real GPT-5.6 stateful E0 run completes and leaves sufficient evidence to
  explain correctness and context behavior.

As of 2026-08-08 these implementation criteria are met. The first stateful E0
comparison and its limitations are recorded in
[`agent-ledger-benchmark-corpus.md`](agent-ledger-benchmark-corpus.md#first-measured-comparison).
Matching the current Codex baseline on one fixture is completion evidence for
this slice, not evidence that the harness is generally superior.

## H4 frozen contract: context fidelity

H4 keeps the H1-H3 architecture and closes the fidelity gaps found in the
first real benchmark. The identifiers below are the conformance contract used
by implementation tests and the next measured run.

### F1: one openable reference plane

The model-facing surface remains `history_search`, `history_read`, and
`context_update`. Every reference emitted by the compiler, search, context
workspace, runtime snapshot, or work-unit result must be accepted by
`history_read` and support bounded byte continuation. The resolver covers
journal events, messages, turns, tool calls and results, primaries, artifacts,
context frames, omissions, execution scopes, work-unit traces, and exact file
snapshots. A visible reference that cannot be opened is a contract failure.

### F2: high-signal lexical search

Default search indexes user messages, assistant proposals and answers, active
and historical primaries, completed turn outcomes, and named artifacts or work
results. It excludes raw reads, context/search/control plumbing, and ordinary
tool operations. `include: "operations"` opt-in adds those records while still
excluding the search operation that is currently executing. Results are
lexical, deduplicated, and deterministically ordered by active primary, user
message, assistant proposal/outcome, completed turn, historical primary, then
operation. Historical records are labelled as such.

### F3: primary provenance

`context_update.set` accepts optional `evidence: string[]`. All evidence
references are validated before any action in the transaction is applied.
Validated references are recorded in the primary and binding provenance in
addition to the management event. State bodies remain arbitrary canonical
JSON; H4 does not impose a plan or summary schema.

### F4: exact pinned resources

`context_update.pin` accepts absolute or cwd-relative files and immutable
journal references for messages, turns, artifacts, primaries, work-unit
results, and omissions. Pins snapshot exact bounded UTF-8 content and remain
openable after rollover or restart.

### F5: deterministic turn anchor

Every compiled frame contains a `TurnAnchor`: the current user message
reference and body, the preceding assistant-message candidate when one exists,
an accepted-proposal reference only when the model explicitly pins or cites
it, and any steering-message references. No classifier guesses that terse
acceptance means agreement. Sol makes that judgment and records the exact
proposal reference with `context_update`.

### F6: observed runtime state

The `open_work` block is populated from observations, never inferred intent.
It includes cwd, git root and HEAD, dirty paths and a status hash, observation
time, active operations, recent command references with bounded excerpts and
exit status, recent failures, and changed paths. It is refreshed at frame
creation or restart and after relevant mutating tools, not before every
provider call. Full command output remains behind an openable reference.

### F7: pressure and admission policy

For model window `W`, output reserve `O`, and safety margin `S`:

- hard input limit = `W - O`;
- admission limit = `hard - S`;
- soft notice = `floor(0.82 * admission)`; and
- rollover threshold = `floor(0.94 * admission)`.

The harness appends at most one small pressure notice per frame before a
non-emergency rollover, giving the model its normal next action to checkpoint.
If the next provider request cannot be admitted safely, it rolls immediately.
Pi compaction remains disabled.

## H4 prompt heuristics

The fixed system prompt teaches a three-layer mental model: recent messages and
tool results are hot context, the journal is exact cold history, and
`context_update` is a small durable working context. It asks the model to use
stable keys only at meaningful phase changes, pin exact governing resources,
default to thread scope, use project scope only for cross-thread state, and do
nothing on pressure when existing durable state is already sufficient. Work
units are opt-in and absent from the default contract while their separate
benchmark profile remains experimental.
