Status: Archived
Last verified: 2026-08-09
Canonical code: schema-v1 execution scopes and H4 sequential work-unit execution are implemented in `extensions/agent/server/src/storage/` and `extensions/agent/server/src/pi-runtime.ts`; work units remain opt-in and absent from the default model contract
Superseded by: `agent-native-provider-runtime-v1.md`. Work-unit evidence remains
historical; provider-native and federated children replace the custom runtime.

# Agent turns and internal work units

This document defines the semantic execution boundary that sits above the
epoch machinery in
[`agent-runtime-and-epoch-context.md`](agent-runtime-and-epoch-context.md) and
[`agent-durable-epoch-core.md`](agent-durable-epoch-core.md). It is grounded in
the Ledger/Remux transcript study recorded in
[`agent-ledger-benchmark-corpus.md`](agent-ledger-benchmark-corpus.md).

The core finding is that a user-visible turn and a model context lifetime are
different things. A turn may remain one fluid unit of collaboration while the
harness executes it through several bounded, inspectable **work units**. Epoch
rollover remains the hard safety mechanism when any one active context grows
too large. Work units are an experimental semantic mechanism for preventing
unrelated scratch work from sharing that context; the first measured run
reduced carried context but regressed task quality, so they remain opt-in.

This refinement is not a rigid workflow, task manager, or mandatory planner.
Short conversational and coding turns continue directly. The additional
primitive exists for work whose coordination scope is meaningfully larger than
the context required for any one part.

## Empirical motivation

Ledger history contains both clean bounded runs and oversized runs.

- Spec-driven worktree implementations with an exact base, scope, exclusions,
  and acceptance commands completed in roughly 73–106 tool calls.
- One atomic projection-delivery turn ran for about 67 minutes, crossed two
  repositories, issued 328 recorded tool calls, compacted after 176 calls, and
  continued for another 152 calls.
- A later zero-origin implementation issued 203 calls and continued for 127
  calls after compaction.
- Claude already decomposed backend work into Codex worktrees, independent
  review, tests, and integration. That improved semantic isolation, but large
  child reports and notifications still accumulated in the parent session,
  which required 16 manual compactions.

The oversized turns were not caused by unusually long user messages. Short
messages such as “proceed” inherited an accepted design and then opened long
tool loops. The tool trace, not the initial request, consumed the context.

The history also shows why a generic conversation summary is insufficient.
The durable context that actually changes outcomes includes:

- the immediately accepted proposal to which “proceed” refers;
- negative constraints and superseded alternatives;
- whether the current mode is exploration, specification, implementation, or
  commit authorization;
- live experiential evidence supplied by the owner;
- exact repository state, authoritative spec revision, test results, and
  process state; and
- which delegated result the coordinator independently verified.

## The overloaded turn

Current harnesses tend to make one turn serve all of these roles:

1. user-visible request and response;
2. intent and authorization boundary;
3. planning scope;
4. inference and tool-trace container;
5. implementation transaction;
6. context lifetime and compaction boundary; and
7. transcript/UI row.

Only the first two must remain tied together. A user should be able to say
“implement the accepted design” and receive one coherent result without being
asked to manufacture artificial turn boundaries. Internally, the harness can
give cache ownership, runtime changes, UI integration, validation, and audit
their own working contexts.

## Primitive hierarchy

The working hierarchy becomes:

```text
journal
└── projects
    ├── shared project sources and promoted records
    └── conversations
        └── strands
            ├── turns
            │   ├── user intent and steering lineage
            │   ├── work units
            │   │   ├── inferences
            │   │   ├── tool operations
            │   │   ├── context epochs
            │   │   └── result artifacts
            │   └── integrated response
            └── conversation/strand epochs when work remains direct
```

An epoch is an inference-context boundary. A work unit is a semantic scope.
A turn is the user's collaborative contract. They are orthogonal:

- A small direct turn may have no child work unit and one epoch.
- A work unit may span several epochs if its local task is still large.
- A turn may own several sequential or concurrent work units.
- A parent turn may itself roll epochs while coordinating long-running work.

## Turn contract

A turn owns the meaning visible to the user. At minimum it records:

```ts
type TurnContract = {
  turnId: string;
  strandId: string;
  userInputRefs: string[];
  acceptedProposalRef?: string;
  activeDecisionRefs: string[];
  supersededDecisionRefs: string[];
  mode: 'explore' | 'diagnose' | 'specify' | 'implement' | 'validate' | 'operate';
  permissions: {
    mayWrite: boolean;
    mayRunEffects: boolean;
    mayCommit: boolean;
    mayPush: boolean;
  };
  state: 'accepted' | 'running' | 'steered' | 'completed' | 'interrupted' | 'failed';
};
```

This is a conceptual shape, not a final wire or database schema. In
particular, mode is an explicit state when known, not a mandatory classifier
that gates every action. Ordinary intent can remain unclassified.

Short anaphoric messages bind to exact context. “Proceed” should reference the
proposal it accepted rather than depending only on nearby prose. A correction
does not merely add another fact; it can supersede a prior proposal or
decision. Commit and push authority remain explicit episodic permissions and
are never inferred from implementation authority.

## Work unit contract

A work unit is a journaled child execution with a narrow objective and its own
hot context. It is not necessarily another model or subagent. The harness may
execute it with the same model, another permitted model invocation, a
deterministic worker, or a combination.

The current parent specs deliberately exclude Codex collaboration/subagent
protocol compatibility, controls, and events. This proposal does not restore
that App Server product surface or introduce a generic delegated-agent tool.
It proposes an Agent-owned execution/context primitive with a bounded contract.
If accepted for implementation, the parent exclusion must be narrowed
explicitly rather than silently contradicted; sequential same-model work units
can be implemented independently of concurrent multi-agent orchestration.

Its conceptual contract is:

```ts
type WorkUnit = {
  workUnitId: string;
  parentTurnId: string;
  parentWorkUnitId?: string;
  objective: string;
  scopeRefs: string[];
  inheritedDecisionRefs: string[];
  baseStateRefs: string[];
  dependencyIds: string[];
  execution: 'direct' | 'isolated-worktree' | 'read-only' | 'deterministic';
  state: 'created' | 'running' | 'yielded' | 'completed' | 'failed' | 'abandoned';
  epochIds: string[];
  resultRef?: string;
};
```

The contract answers five questions before execution:

1. What outcome is this unit responsible for?
2. Which accepted decisions and exclusions apply?
3. What exact repository/runtime state is its baseline?
4. What may it read, change, or operate?
5. What evidence must it return to the parent?

It does not need to predict every file or command. Scope is a context and
ownership aid, not a brittle allowlist unless safety requires one.

## Context capsule

Each work unit begins with a deterministically compiled capsule. The capsule
uses references to exact journal events, records, artifacts, and repository
observations rather than a fresh model-written summary.

| Layer | Included material | Normally excluded |
| --- | --- | --- |
| Project | Stable architecture, repository map, enduring conventions | Unrelated thread goals and experiments |
| Conversation/strand | Current product direction and applicable accepted decisions | Parallel thread-local work |
| Turn | User request, accepted proposal, exclusions, permissions, steering | Superseded proposals except as labeled history |
| Work unit | Objective, dependencies, scope, expected evidence | Sibling scratch traces |
| Live state | Base revision, dirty paths, process/test/resource revisions | Stale command output superseded by current state |
| Raw context | Exact nearby exchange when wording or reference binding matters | The full historical transcript by default |

The compiler must distinguish **intent authority** from **state authority**:

- User dialogue is authoritative for purpose, acceptance, rejection,
  experiential observations, and permissions.
- The current repository, journaled operations, and runtime resources are
  authoritative for files, commits, dirty state, processes, and test outcomes.
- A spec is authoritative only at an exact revision and only after the turn or
  project has accepted it.

The model is still expected to inspect the real tree. A capsule does not try
to serialize the repository into prose. It tells the model which state is the
baseline and which sources are relevant.

## Local trace and bounded handoff

Inference messages, command output, reads, patches, and failure investigation
remain in the work unit's local journal/context. Completion produces a bounded
handoff such as:

```ts
type WorkUnitResult = {
  status: 'completed' | 'failed' | 'yielded' | 'abandoned';
  basisRefs: string[];
  changeRefs: string[];
  findings: Array<{ statement: string; evidenceRefs: string[] }>;
  validationRefs: string[];
  unresolved: Array<{ statement: string; evidenceRefs: string[] }>;
  proposedRecordChanges: string[];
  traceRef: string;
};
```

The parent receives this bounded result, not a transcription of every child
tool call. Exact commands, output, diffs, and child messages remain available
through `traceRef` and related artifacts. The parent can inspect evidence when
needed, and the UI can disclose it without making it part of every later
provider request.

No child conclusion becomes shared project context merely because the child
spent many tokens on it. Semantic records are proposed separately and require
parent/model acceptance under the existing provenance rules. Abandoned
experiments stay local unless their negative result is intentionally promoted.

## Execution and lifecycle

The minimum lifecycle is:

```text
created -> running -> completed
              |  \-> failed
              |  \-> abandoned
              \-> yielded -> running
```

`yielded` supports a persistent worker that receives a later correction or
follow-up without pretending it is a brand-new task. Every resume adds a new
brief/steering event and retains the same work-unit identity.

A unit completes only when its result and terminal state are durable. An
interrupted parent does not erase a completed child result. Recovery can list
open units, their last terminal operation, their repository/process
ownership, and whether resuming is safe.

## When the model should create a work unit

Creation is appropriate when the next work has a coherent objective and most
of its scratch context will not be useful afterward. Common boundaries are:

- inspecting an unfamiliar subsystem;
- implementing one architectural layer;
- investigating a specific failure;
- running focused validation or profiling;
- conducting an adversarial review;
- working in another repository;
- trying an alternative that may be discarded; and
- integrating a completed isolated patch.

Creation is not required for:

- a short explanation or brainstorm;
- one or two tightly related reads/edits;
- a local correction that depends on the exact current hot trace; or
- artificial fixed-size batching such as “spawn every 30 calls.”

Tool count, elapsed time, and token pressure are useful hints, not semantic
boundaries. The harness may suggest decomposition at a pressure threshold,
but the model chooses the work boundary. Hard preflight still rolls the
current context before a provider limit is reached.

## Cache and epoch behavior

The parent and each active work unit own separate append-only context chains.
Their stable capsules are content addressed and byte deterministic.

Within a unit:

- ordinary tool observations append to its hot trace;
- the existing preflight policy runs before every inference;
- rollover creates a fresh epoch for that unit if necessary; and
- the new epoch carries the unit objective, accepted decisions, live state,
  last completed action, unresolved work, and retrievable trace map.

Across units:

- a sibling starts from its own compiled capsule rather than inheriting the
  previous sibling's raw messages;
- filesystem and runtime changes are shared through journaled authoritative
  state, not copied shell prose;
- the parent context appends bounded lifecycle/results; and
- child trace artifacts do not enter the parent unless explicitly pulled.

This does not make provider KV cache global across children. It deliberately
trades one ever-growing continuation for several smaller, semantically stable
chains. Common contracts, tool schemas, and deterministic project/turn blocks
remain identical prefixes where the transport can reuse them. Benchmarking,
not assumption, decides whether the latency/token trade is favorable.

## Concurrency and write ownership

Concurrency is permitted when state ownership is explicit:

- read-only research and review units may run concurrently;
- independent writes should use isolated worktrees or disjoint owned roots;
- same-tree dependent writes run sequentially unless a merge protocol proves
  otherwise;
- validation may run concurrently against an immutable patch/revision; and
- the parent integrates conflicts and owns the final turn response.

A result always names the base revision and observed dirty state. A child must
not silently integrate against a different tree because another worker changed
it. It yields or asks the parent to rebase/recompile its capsule.

## Steering while work is active

User input may arrive while a work unit is running. It is journaled first as
turn steering and then resolved explicitly:

- amend and resume the active unit;
- cancel/abandon it because the premise changed;
- allow it to finish but suppress promotion;
- enqueue a dependent follow-up unit; or
- change the parent turn's requested outcome.

The active unit receives only steering relevant to it. A user correction must
be able to supersede an inherited decision immediately. Async process and
child-completion notifications are not represented as fake user turns.

## UI projection

The normal transcript remains turn-oriented. A running turn may display
compact nested work rows using the stable interaction patterns already ported
from Codex:

```text
Implement atomic projection delivery
  ✓ Grounded against accepted spec
  ✓ Cache/snapshot capabilities
  ● Runtime delivery and seek barrier
  ○ Lens integration
  ○ Validation and audit
```

Each row can expose objective, state, elapsed time, changed paths, evidence,
and bounded narration/status. Detailed inference/tool history is lazy. The UI
may steer, cancel, or inspect a unit, but the primitive must work without UI
ceremony and without forcing the user to manage a task board.

The integrated assistant response remains the terminal result of the parent
turn. Child results are evidence, not separate chat answers.

## Example decomposition from Ledger

The 328-call atomic delivery implementation naturally contained these units:

1. spec and repository grounding;
2. cache capability and atomic snapshot implementation;
3. projection delivery executor;
4. seek barrier semantics;
5. Lens protocol migration;
6. Remux targeted routing;
7. profiling and acceptance tests;
8. adversarial race audit;
9. audit corrections; and
10. final integration report.

Dependencies would make some sequential. Review and targeted validation could
run concurrently once their input revision became immutable. The user would
still see one implementation turn.

## Failure modes to avoid

- **Parent pollution:** copying complete child transcripts into the parent.
- **Project slop:** automatically promoting every child summary or finding.
- **Task bureaucracy:** requiring a work unit for ordinary conversation.
- **Stale authority:** trusting a capsule over the changed working tree.
- **Hidden permission expansion:** inheriting commit/push authority from write
  authority.
- **Blind fan-out:** concurrent writers without base and ownership fencing.
- **Summary recursion:** repeatedly summarizing prior summaries instead of
  retaining exact source references.
- **Call-count partitioning:** creating arbitrary boundaries unrelated to the
  work's meaning.
- **Uninspectable handoff:** reporting a conclusion with no evidence or trace
  reference.

## Evaluation requirements

The companion corpus defines the first realistic fixtures. The design should
be evaluated against at least three arms:

1. current Codex/App Server behavior;
2. Agent with deterministic epoch rollover but no work-unit decomposition;
3. Agent with work units plus epoch rollover.

The third arm must not win merely by using more concurrent inference. Compare
task correctness, user corrections, context pressure, cache telemetry, wall
time, duplicated observations, permission adherence, and evidence quality.

Specific gates added by this design are:

- parent input remains bounded when child tool volume grows;
- a child can roll epochs without losing its objective or accepted constraints;
- abandoned exploration does not enter project context;
- a sibling can recover exact relevant evidence without replaying the first
  child's trace;
- mid-run user steering supersedes the correct active decision;
- concurrent writes never silently share a mutable baseline; and
- the complete turn can be reconstructed and audited from journal/artifact
  references.

## Relationship to the current implementation phases

The owner accepted the schema-level refinement during Phase 1A.1. Schema v1
therefore uses a generic `execution_scope` relation: every direct turn has one
root scope, while child `kind=work_unit` scopes remain inactive. Epochs,
inferences, operations, and events can be attributed to that scope without
interpreting transcript rows or adding nullable work-unit identity later.

The later Phase 1A.3/1B design still must decide:

- how parent and child prompt manifests reference one another;
- which events are required for create/yield/resume/complete/abandon;
- how same-tree ownership and isolated worktrees are represented; and
- how a bounded result proposes rather than automatically performs record
  promotion.

The journal should preserve enough causal identity now that adding these
relations later does not require interpreting display transcript rows.

## Open questions

1. What term should ship in the UI: work unit, work span, tasklet, or another
   less process-heavy label?
2. Should the parent coordinator always be a live model context, or can it be
   deterministically reconstructed between child completions?
3. How much of an accepted spec belongs in the shared stable prefix versus a
   content-addressed reference opened by each unit?
4. Which pressure/locality signals should invite the model to split work
   without becoming a mandatory classifier?
5. Can the Codex subscription transport reuse enough common prefix across
   child chains to offset their full-request boundaries?
6. How should a resumed work unit distinguish a small correction from a new
   child objective?
7. Which semantic promotions can be deterministically derived, and which must
   remain model-proposed or owner-accepted?

## H4 sequential work-unit contract

H4 resolves the v1 questions narrowly. It activates the existing
`execution_scopes(kind='work_unit')` storage without adding task boards,
subagents, alternate models, worktrees, concurrency, or nested units.

- **W1 — one tool:** `work_unit` has `enter` and `return` actions. `enter`
  accepts an objective plus optional exact refs and expected evidence. `return`
  accepts status (`completed`, `failed`, or `abandoned`), evidence-backed
  findings, change refs, validation refs, and unresolved items.
- **W2 — root children only:** one root turn may have one active child at a
  time. The same Sol process and mutable working tree continue to execute it.
- **W3 — bounded capsule:** entering writes a child scope, child context space,
  base git observation, and deterministic capsule. The next inference is a
  full child frame containing objective, current-user and preceding/accepted
  proposal refs, applicable primaries, explicit refs, runtime observation, and
  inherited authority. Parent scratch and raw tool trace are absent.
- **W4 — local state:** state written while a child is active defaults to its
  context space. A child cannot directly promote project state; its result may
  propose promotions for the parent to accept explicitly.
- **W5 — bounded result:** return writes a content-addressed result artifact
  containing objective and basis, base/final workspace observations, findings,
  change and validation refs, unresolved items, proposed promotions, and a
  trace reference. The parent receives this bounded result, not the child raw
  trace.
- **W6 — safe implicit return:** if Sol emits terminal assistant text while a
  child remains active, the harness stores it as a provisional result,
  completes the child implicitly, restores the parent, and runs a parent
  integration inference. Only the parent response is terminal transcript
  output.
- **W7 — restart:** active scope and capsule are derived from the journal. An
  unfinished child resumes from its capsule in a fresh full frame; recovery
  does not replay parent scratch into it.

The normal path is explicit completion. Work units are optional semantic
boundaries, not a call-count threshold or mandatory process. A child result
must contain openable evidence; merely moving a long trace behind an opaque
summary does not satisfy the design.
