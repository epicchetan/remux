# Agent bounded work units v2

Status: Implemented experiment; not selected as default
Last verified: 2026-08-10
Canonical code: `extensions/agent/server/src/{pi-runtime.ts,engine.ts,context/,storage/repository.ts}` and `extensions/agent/tests/benchmark/`
Superseded by: `agent-native-provider-runtime-v1.md`. Its measurements remain
R&D evidence; custom bounded work units are deleted at Codex cutover.
Builds on: [`agent-turns-and-work-units.md`](agent-turns-and-work-units.md),
[`agent-context-workspace-v1.md`](agent-context-workspace-v1.md), and
[`agent-ledger-benchmark-corpus.md`](agent-ledger-benchmark-corpus.md)

## Outcome

Long user turns execute as a sequence of foreground-authored, bounded work
units instead of one provider context that grows until it must be compacted. A
user turn remains the visible objective. Each internal work unit receives a
fresh context capsule, performs one coherent piece of work, and returns a
durable result plus an optional shared-state commit. The parent model either
starts another unit or answers the user.

The immutable journal remains exact truth. Thread and project primaries remain
the larger working state. Pi compaction and the background working-memory
compiler are disabled in this experimental mode.

## Runtime mode

The server context mode is `work-units`; the benchmark arm is
`bounded-work-units-v2`. Existing `stateful`, `full-history`, and
`working-memory` behavior remains available as controls.

One visible turn may contain zero or more sequential work-unit scopes:

```text
user turn / parent coordinator
  -> child unit: orient or inspect
  -> bounded result + shared-state commit
  -> child unit: implement
  -> bounded result + shared-state commit
  -> child unit: validate
  -> bounded result
  -> parent answer
```

The model chooses semantic boundaries. The harness enforces context budgets
and scope isolation, not an audit/implement/test workflow. Simple conversation
may remain in the parent. Nested and concurrent units remain out of scope for
v2.

## Context capsule

Entering a unit opens a child execution scope and a fresh provider frame. Its
bootstrap contains:

1. stable harness and tool contracts;
2. current project and thread primaries applicable to the strand;
3. the exact current user request and accepted-proposal anchor;
4. the child objective, expected evidence, and selected references;
5. the latest bounded child result and observed workspace state where
   applicable; and
6. journal retrieval instructions.

Raw parent and sibling tool traces are excluded from the child shadow source.
They remain openable through the journal. The child hot tail contains only the
new unit's exact assistant, tool-call, and tool-result events.

Readable workspace files and `file:line` or `file:start-end` citations are
valid selected references. The host snapshots them into immutable artifacts
when the unit enters or returns.
Journal and Agent references are validated and retained directly. Arbitrary
unresolvable strings remain errors.

## Foreground state commit

`work_unit.return` gains an optional `commit` object with four primitives:

- `remember`: set or replace a small thread-scoped semantic value;
- `forget`: remove a thread-scoped semantic key;
- `hold`: retain an exact workspace path or journal resource;
- `release`: release an exact retained resource.

The child authors this commit from knowledge it acquired while doing the work.
The host validates and applies it to the parent strand context as part of the
return transition. A child cannot directly promote project-scoped state.
Project promotion remains a deliberate parent action through `context_update`.

The bounded result separately records findings, changed-resource references,
validation references, unresolved concerns, workspace before/after state, and
the exact child trace reference. The parent should consume the bounded result
and committed state without reopening the full child trace unless evidence is
missing or contradictory.

## Work-unit budget

The model context window is a hard provider capability, not the desired unit
size. Work-unit policy therefore has an earlier soft checkpoint boundary and
recovery boundary:

- soft checkpoint: the smaller of 96,000 input tokens or 48% of the effective
  input admission limit;
- recovery boundary: the smaller of 128,000 input tokens or 64% of the
  effective input admission limit.

At the soft boundary the frozen frame receives one stable notice instructing
the model to finish the current atomic action and return a bounded result. This
preserves the prefix and gives the model one ordinary inference to checkpoint.

If the model ignores the notice and reaches the recovery boundary, the harness
opens a recovery frame for the same unit from its durable capsule, current
state, bounded raw tail, and journal retrieval map. This prevents provider
overflow but counts as an emergency unit rollover and a failed unit-sizing
metric. It is not normal compaction and does not discard journal truth.

Large tool results continue to be stored exactly in journal artifacts and are
externalized in rebuilt capsules. A single unexpectedly large result can still
trigger recovery; benchmark telemetry must make that visible.

## Prompt contract

The parent is a lightweight coordinator. For a nontrivial objective it should
delegate coherent investigation, implementation, or validation work to a
child, integrate the bounded result, and decide the next unit. It should not
reperform the child's raw exploration.

The child should:

- work freely with normal coding and journal tools;
- re-read mutable files before edits and final validation;
- return at a semantic boundary or checkpoint notice;
- commit only state useful after its raw tail disappears;
- cite exact journal evidence or workspace resources instead of prose copies;
- release resolved state and avoid whole logs, files, or transcript summaries;
  and
- never broaden user-granted write, commit, or push authority.

## Failure behavior

- A malformed commit does not partially return a child or mutate shared state.
- A missing explicit return still produces the existing provisional implicit
  result and asks the parent to validate it.
- Runtime restart resumes the active child from its immutable capsule and
  re-observes mutable workspace state.
- Child-local context updates do not leak into the parent unless returned in a
  valid commit.
- An interrupted or abandoned child cannot promote project state.
- No automatic or manual Pi transcript compaction is enabled.

## Instrumentation and benchmark

The existing Ledger E0 scenario remains the first causal comparison. Run
`bounded-work-units-v2` with the same model, reasoning, fixture, four user
turns, and hidden evaluator as the retained Codex, stateful, legacy work-unit,
and working-memory runs.

Report:

- total wall time and per-turn time;
- provider calls, full versus continuation requests, and cumulative/peak
  estimated foreground input;
- unit count, semantic objective, explicit versus implicit return, and tools
  per unit;
- maximum input per unit, checkpoint notices, and emergency unit rollovers;
- parent-visible result bytes, child artifact bytes, journal retrievals, and
  repeated file/spec reads;
- committed keys/resources and unresolved state left after the scenario;
- invalid work-unit/context calls, trace reopen count, compactions, and context
  failures; and
- all visible and hidden correctness gates.

The implementation passes mechanically when:

1. a real Pi turn enters a child, starts a fresh full frame, returns explicitly,
   commits parent-visible thread state, and restores a fresh parent frame;
2. a following child and a following user turn can use committed state without
   inheriting the prior child trace;
3. workspace and file/line references become openable immutable evidence;
4. a forced low-threshold test emits a checkpoint notice before recovery;
5. malformed commits and stale handles fail without partial state;
6. restart and implicit-return behavior remain durable;
7. builds and focused tests pass; and
8. the full real Ledger benchmark completes and produces auditable evidence.

The experiment is better than the retained working-memory arm only if task
correctness is no worse, no context-limit or compaction failure occurs, normal
units require no emergency rollover, and wall/provider-call overhead is
explained by a material reduction in cumulative context or tool rereads. One
run is directional evidence, not a default-mode decision.

## Measured result

Two complete E0 evaluations and one crash diagnostic were retained. The first
clean run is
`2026-08-10T01-57-25-702Z-agent-087182`. The final post-hardening run is
`2026-08-10T02-36-33-818Z-agent-e2be23`; a transient provider WebSocket error
occurred as its final-audit turn began, and the benchmark resumed the same
durable conversation and workspace. The Agent process did not restart. The
earlier `2026-08-10T01-25-19-911Z-agent-5b5d1e` run is crash/restart evidence,
not an efficiency sample.

| Metric | Clean bounded v2 | Post-hardening/recovered | Working-memory v1 | Codex reference |
| --- | ---: | ---: | ---: | ---: |
| task wall time | 30m31s | 33m31s including retry gap | 26m26s | 22m40s |
| provider calls | 97 | 130 | 78 | not comparable |
| estimated foreground input | 4.607M | 6.967M | 9.604M | 14.740M provider-reported, 97.7% cache-read |
| peak estimated input | 116,587 | 112,579 | 225,897 | not comparable |
| function/tool calls | 175 | 207 | 163 | 117 |
| repeated reads | 18 | 11 | 36 | not available |
| parent-visible tool-result bytes | 132,207 | 172,457 | 789,454 | not available |
| explicit units | 5/5 returned | 6/6 returned | n/a | n/a |
| checkpoint / emergency rollover | 2 / 0 | 3 / 0 | n/a | n/a |
| invalid context calls | 7 | 1 | 0 | n/a |

Both bounded runs had zero compactions, context-limit failures, emergency unit
rollovers, parent trace reopens, child-local leaks, or abandoned promotions.
The clean run reduced estimated foreground input by 52.0%, peak input by 48.4%,
repeated reads by 50.0%, and parent-visible result bytes by 83.3% relative to
working-memory v1. It was nevertheless 4m05s slower than that Agent control and
7m51s slower than the retained Codex task time. The post-hardening run proved
that all six children could checkpoint explicitly below 113k tokens and that
line-range/reference guidance reduced invalid context calls from seven to one.

Task quality did not reach the promotion bar. The clean run failed the hidden
historical API-shape gate and the dual playback/shutdown error gate. The final
run failed those two plus the stale-clock reread lifecycle gate. Codex failed
only the hidden API-shape gate. The final run also left 61,001 bytes of active
state because the model held five complete changed files as sticky working
resources and committed twelve state changes. This is valid under the current
primitive but is the wrong cache behavior: exact files already live in the
workspace and journal and should normally be referenced, not copied into the
always-active state layer.

The benchmark found and closed two primitive defects after the first clean
run: `file:start-end` citations now snapshot the exact range, and a
content-addressed artifact reused by another project receives a durable
project-local ownership link and remains openable. The remaining invalid call
was a fabricated validation tool ref. Coding-tool results currently do not
surface their exact durable `journal://tool/...` reference, so the schema asks
for evidence the model cannot reliably name without another search.

The result supports bounded foreground contexts as a mechanism, not this
state policy as the final harness. The next iteration should keep sequential
fresh units while making handoff state reference-first and self-cleaning:
surface exact durable refs with tool results, distinguish short handoff state
from retained exact resources, and expire or demote whole-file holds unless a
later unit explicitly renews them. It should then rerun E0 before adding more
workflow structure.
