# Agent Living Thread Canvas v1

Status: Implemented checkpoint
Date: 2026-08-11
Builds on: `agent-thread-runtime-v2.md`
Canonical prompt: `extensions/agent/server/prompts/system.md`

## Outcome

The branch-scoped document stored internally as `thread.md` is exposed to the
model and user simply as the **Thread**. It is the canonical living alignment
document for this branch rather than a thin status brief. It should keep
shaping future work after older exact dialogue leaves the active request.

During exploration it may retain user intuition, motivating examples, active
questions, candidate interpretations, tradeoffs, tentative mental models,
working assumptions, emerging decisions, and the current conversational edge.
During execution it may also retain accepted behavior and rationale, observed
repository facts, governing resources, implementation checkpoints, incomplete
validation, and unresolved risks.

The canvas is organized for semantic quality and human readability. Prompt
cache behavior does not constrain its structure, ordering, wording, or
acceptance criteria.

## Context roles

- Exact recent user/assistant turns preserve conversational detail.
- The Thread preserves the active conceptual and execution state.
- Work units isolate bounded research, implementation, and validation traces.
- History tools expose exact omitted conversation and execution evidence from
  the immutable internal journal.

Collaborative exploration normally remains in the parent provider context. A
work unit is appropriate when a bounded external question can consume
disposable scratch and return evidence without losing the creative dialogue.
It is not a second drafting or brainstorming context and is not entered merely
to read or maintain the canvas.

## Thread shape

The Thread replaces the assumption that serious work requires a separate spec
file. Its first screen is a concise orientation surface: goal, phase, current
state, target, current edge, and blockers. Its body is an adaptive living spec.
As useful, it retains intent and rationale, observed current state, target
behavior, design and architecture, active alternatives and decisions, exact
acceptance-critical contracts, implementation mapping, verification evidence,
risks, and unresolved questions.

There is no brevity objective. Before deleting detail, the parent asks whether
a fresh agent could continue, challenge, implement, or audit the work without
replaying omitted conversation. If not, the detail remains. Empty template
sections are not required, and implementation progress must not replace the
architecture or accepted contract it is meant to realize.

External repository documents remain ordinary evidence or export targets. When
one matters, the Thread retains the consequential contract and source rather
than depending on every future turn to reconstruct the active design from the
file. Repository contents remain authoritative for observed implementation
state, and the current user remains authoritative over model-authored Thread
content.

## Canvas maintenance

The foreground parent owns the Thread. It updates the document only when a turn
or work-unit result changes what future turns should understand. There is no
background context manager and no scheduled compaction pass.

Maintenance is local:

- preserve unresolved ideas while they remain generative;
- distinguish user intent, accepted decisions, model proposals, assumptions,
  observations, direct verification, and unresolved risk;
- revise hypotheses when repository evidence arrives;
- consolidate alternatives only when the collaboration resolves them;
- retain rejection rationale only when losing it would cause repeated mistakes;
- remove chronology, raw tools, command output, copied files, private reasoning,
  and routine narration; and
- never promote model-authored state above the current user or governing source.

There is no soft canvas-size target. The existing 96 KiB storage limit remains
a defensive ceiling, not an instruction to summarize.

## Model tools

The clean model-facing surface is:

- `thread_read`: read the complete current version and editing identity;
- `thread_patch`: atomically apply one or more ordered exact replacements;
- `thread_replace`: intentionally replace the whole document for initialization,
  major reorganization, recovery, or a fundamental subject change.
- `history_search` and `history_read`: retrieve exact omitted evidence through
  model-facing `history://` references; and
- `work_unit_start` and `work_unit_finish`: isolate substantial bounded work and
  resolve the pending parent tool call with a result and selected durable
  authority, deliverable, or evidence resources. Thread edits remain parent-owned.

The model-facing prompt and tool descriptions never require the terms
`thread.md`, journal, cold history, provider frame, branch-scoped state, or CAS.
Those remain implementation vocabulary. A fresh model is introduced to only
three concepts: the Thread, History, and a work unit.

`thread_patch` requires a current `baseVersionId`. Every non-empty `oldText`
must match exactly once at the point its ordered edit is applied. Missing or
ambiguous matches reject the full batch without creating a version. Successful
patches and replacements create complete immutable document versions and retain
the existing fork/edit inheritance semantics.

Work-unit scopes cannot modify the Thread. They close through
`work_unit_finish`; the returned Thread Markdown is only a proposal. The resumed
parent decides which consequences belong in shared state and may pass selected
exact resources into later work units. The harness materializes their immutable
snapshots into the receiving scope. This keeps private scratch disposable
without losing exact governing sources or durable work products.

## User surface

The Agent composer exposes a read-only Thread dialog. It renders the
complete current Markdown using the production transcript renderer and permits
inspection of the immediately previous durable version. Version identity,
size, and originating turn are visible without inserting canvas narration into
the conversation.

Direct user editing, arbitrary version restoration, and a full journal browser
remain deferred until the canvas behavior is validated in regular use.

## Validation

Deterministic coverage includes:

- atomic exact patches, deletion, missing/ambiguous-match failure, no-op and
  size rejection;
- stale-version fencing and rollback of partially applicable edit batches;
- parent-only mutation and exact before/after fork inheritance;
- complete context compilation and durable version history;
- current/previous canvas RPC projection; and
- exact durable turn-state reads so benchmark stages cannot advance from a
  merely streamed or cached terminal frame; and
- desktop/mobile Markdown dialog behavior.

Real validation uses both the frozen Ledger implementation benchmark and a
multi-turn design-continuity exercise. The latter judges retention of user
intuition, active alternatives, epistemic separation, response quality,
evidence integration, stale-state revision, and later recall. Provider prompt
cache performance is recorded only as a general diagnostic and is not a canvas
success criterion.

### Measured checkpoint

The 2026-08-11 design-continuity run
`2026-08-11T00-11-03-209Z-canvas-agent` completed six durable turns in 10.7
minutes. Its five-version, 14.9 KiB final canvas retained every semantic
acceptance point, including the original motivation, the observed-versus-
inferred distinction, the parked gamma direction, the selected trade-activity
slice, provenance constraints, and unresolved risk. The opening brainstorm
stayed in the parent; repository grounding used one bounded work unit. There
were no repository edits. A first report marked recall false only because its
heuristic accepted `trade activity` but not the equivalent `trade-activity`;
the checker now accepts either form.

The frozen Ledger run `2026-08-11T01-07-25-338Z-agent-7df008` demonstrated the
runtime mechanics over four implementation turns: three work units entered and
returned, 109 durable context frames matched 109 provider items, no compaction
or context-limit event occurred, and no scope remained running. Peak estimated
input was 85,696 tokens in the parent and 131,082 in a child. The produced code
did not pass the task benchmark: its public API differed from hidden acceptance
tests and its backward-regression loop did not demonstrably re-read the clock.
This is retained as a model/task-quality failure, not reclassified as a canvas
pass.

An earlier Ledger attempt exposed a durability defect when a provider stopped
inside an unreturned child. Abandoned child scopes and the root turn had shared
one terminal sequence, violating the schema's uniqueness fence. Finalization
now emits a distinct `work_unit.abandoned` event for every open child before the
root terminal event, with regression coverage for preserving the original turn
failure.

The later model-language checkpoint was measured with design run
`2026-08-11T14-49-57-835Z-canvas-agent` and Ledger run
`2026-08-11T15-06-59-957Z-agent-007311`. The six-turn design run completed in
16.3 minutes. It used one repository-grounding work unit and produced a
seven-version, 28.3 KiB Thread with a glanceable orientation followed by the
full design space, repository findings, selected vertical slice, implementation
proposal, trust constraints, and unresolved questions. Every Thread semantic
gate passed. The final no-tools response substantively recalled the selected
slice as eligible option prints and volume over session time and strike, but the
lexical recall gate required the literal phrase `trade activity`, so the report
remains a narrow 4/5 recall failure rather than being rewritten after the run.

The Ledger run completed its four accepted driver turns in approximately 43.7
minutes of model time, excluding one failed provider attempt and restart gap.
It entered four work units, returned three, used 132 matching durable frames and
provider items, had no compaction or context-limit error, and peaked at 80,290
estimated parent tokens and 136,857 child tokens. The final Thread was 9.8 KiB
and retained the approved due-time and FIFO decisions, but it claimed full
validation without preserving or checking every acceptance-critical public API
name. Independent hidden validation failed to compile because expected replay
exports and builder methods were missing or renamed; the stale-clock-loop and
dual playback/shutdown-error gates also failed. This is a model/task-quality
regression relative to the preceding Agent run, not a context-runtime pass.

The transient provider failure in that run exposed a separate reload defect:
top-level transcript reconstruction attempted to project internal work-unit
tool events, which intentionally have no transcript items. Projection now
selects only `transcript`-visible events. A regression test completes a child
tool trace, reconstructs the parent transcript, and proves the private child
events remain durable without leaking into or breaking the visible transcript.
The original large benchmark conversation then hydrated successfully after an
Agent restart and completed its final turn.

The repository-owned-prompt/adaptive-benchmark checkpoint is retained as run
`2026-08-11T17-40-36-879Z-agent-87d83c`. Three natural turns produced three
completed work units for audit, implementation, and independent review. The
Thread grew from a 698-byte initial orientation to a 7.8 KiB living design and
implementation record, preserving the model's proposed corrections, the
owner's accepted decisions, implementation mapping, evidence, and limitations.
All 121 provider calls had matching durable frames and provider items; no scope
was abandoned, no context limit was reached, and peak child context was 117,696
estimated tokens. The final reviewer added three edge-case tests without
inheriting the implementation child's trace.

The frozen evaluator still failed: the collaboration accepted private
`BarsParams` state and omitted root projection re-exports required by the
governing spec. This is an important canvas lesson. Rich preservation of a
decision does not make that decision compatible with an external contract; the
parent must explicitly reconcile proposed deviations with acceptance-critical
interfaces before treating them as accepted implementation truth.

## Completion criteria

- Rich unresolved design state survives across turns without becoming a
  transcript.
- Patches preserve semantic detail and fail closed on stale or ambiguous input.
- Work-unit evidence returns to the parent before shared-state mutation.
- The rendered document is useful to a human without requiring transcript
  replay.
- Existing context durability, fork behavior, and no-compaction guarantees do
  not regress.
- Real-model runs preserve uncertainty and do not turn hypotheses into accepted
  decisions.
