# Durable subagent lifecycle and activity

Status: approved in chat; implementation in progress. Broader audit remediation remains paused.

## Contract

An agent is one persistent native thread/execution with established parentage;
assignments are separate native turns. Messages do not establish ownership.
Follow-ups reuse the agent. Terminal evidence applies to the exact assignment;
replayed starts and late completions cannot reopen or finish another assignment.
The existing child registry and durable bindings own identity and lifecycle.
Connection visibility is separate from execution outcome.

Recovery restores accepted root/child active bindings before control actions,
reconciles unfinished children without opening their transcript, and retains
uncertainty when native evidence is unavailable. Existing partial history is not
proof of completion. Reconciliation is bounded/coalesced; completed history is
not repeatedly hydrated. Restart must preserve outstanding Stop intent.

Conversation Stop targets active root work and active descendants; child Stop
targets that agent and active descendants. Persist intent before interrupts,
bind targets to exact assignments, retain individual errors and include late
discovered descendants of stopped work. Acknowledgment means stopping, not
terminal. Root completion alone does not settle child targets. Repeated requests
reuse outstanding intent. Old Stop cannot interrupt a subsequent assignment.
Queued messages survive and must not auto-start as a side effect of Stop.

## Presentation

Replace child transcript dropdowns with one conversation activity row immediately
above the composer, outside virtualized transcript content. The Agents button
remains permanently available; the row opens the same Agents view. One agent
entry contains successive assignments. Historical agents remain accessible.

| Situation | Row |
| --- | --- |
| No active/unresolved agents | Hidden |
| Confirmed active agents | N subagents running (singular for one) |
| Some finish or an existing agent receives follow-up | Update same row/count; unique agent identities |
| Parent finishes while children work | Remains visible |
| Stop pending, including root already terminal | Stopping N subagents… |
| All targets terminal | Hidden |
| Reconnecting/unverified work | Checking subagents… |
| Mixed visibility | N running · M checking |
| Reconciliation/Stop fails | Status unavailable / Couldn't stop N subagents; detail in Agents view |
| Conversation switch | Only selected conversation state |

One fixed-height slot prevents count/label changes resizing it. Narrow labels
truncate. Appearance/disappearance preserves reading position or bottom-follow;
no overlap with composer/keyboard/last message, no historical turn-height changes.
Navigation preserves scroll; refresh does not flash the row or show stale counts
from another conversation. Root-only activity remains existing Thinking behavior.

## Checkpoints and ownership

Primary owns integration/review, docs, commits, builds and live checks. Sol agents
implement bounded slices with disjoint files. No recursive delegation. Commit and
push reviewed checkpoints on main, then build/restart/verify. Tests/builds use
Remux research workload scopes. Do not resume S2a2 or unrelated audit work.

A. Lifecycle/control: one Sol writer owns server/provider/shared contracts and
focused tests. Restore bindings, reconcile children, persist Stop/target state,
expose lifecycle activity for the viewer, protect queued work. Add an additive
migration only if required for durable intent; never rewrite transcript history.
Native protocol changes must update dependent fixtures. Provider contract changes
must be additive and validated. Primary reviews exact-turn/race/restart behavior.

B. Repair: independent Sol writer owns i3 repair helpers/tests only; primary owns
live application. Extend proven interaction-to-ancestor repair beyond the original
single incident. Validate on a copy; idempotent audited repair; retain diagnostic
events, genuine turns/descendants and ambiguous cases. Reconcile real stale work
using native evidence, not age, naming or CPU usage.

C. Viewer: after A's resource contract settles, Sol writer owns activity row,
Agents view integration and viewer tests. Remove subagent dropdown presentation;
reuse existing navigation/transcript components. No virtualizer rewrite.

Essential tests: spawn/message/follow-up identity; old terminal/replayed starts;
restart root+child then Stop; missed terminal reconciles without Agents view;
parent settles first; child interrupt error; Stop survives restart and preserves
queue; bottom-row geometry/navigation/count/visibility desktop and mobile.

## Evidence and progress

Baseline bd084a5; 270 server tests and server/viewer builds passed at prior
checkpoint. Live read found ten old phantom grandchildren with child/interacted
evidence and no native handles/own turns. Real child implement_s2a1_acceptance
is interrupted in native history but running in Remux. Root activeTurnBinding
is passed by coordinator but ignored by CodexProviderSession; child history
sync returns early whenever any turn exists. Checkpoints A/B/C pending.

Repair helper review: four focused tests pass. Applied v2 repair to a consistent
live schema-15 copy: ten proven phantom executions and 22 projected blocks
removed, 22 archived block IDs suppressed for replay. All event/turn rows and
all other tables except the intended execution/block/audit changes retain exact
ordered-row hashes; foreign-key check empty and quick_check ok. Evidence under
`/tmp/remux-audit-implementation/subagent-validation/`. Live application waits
for A's replay suppression integration and reviewed build/restart.

A reviewed: protocol 10 exposes runtime and execution lifecycle; schema 16 adds
Stop intents/assignment targets and nullable executions.lifecycle_error. Accepted
interrupts retain acceptance when verification expires; explicit retry rechecks
without another native interrupt. Existing intents retain frozen targets across
repeated requests. Old native outcomes do not settle newer work; recovery_failed
is not native terminal proof. Child reads and Stop processing are coalesced;
resource invalidations cover timer outcomes. Stop's queue pause survives settlement
until the next deliberate send. The full server suite passed 277/277 and typecheck
passed; the dropped-terminal test additionally covers retry during a newer child
assignment with only one native interrupt. Full browser acceptance and live
deployment remain pending. Server/viewer protocol changes ship together.

C reviewed: one fixed-height visible activity row; an empty slot collapses so
short mobile tails retain their geometry. Agents overlays the full main pane
while the hidden transcript retains its reading anchor. Disconnected counts
show Checking; connected unresolved reads show Status unavailable; root-only
Stop failures remain in the composer error surface. Child disclosures are removed
from Work and the permanent Agents action retains access to historical agents.
The full browser run passed 187 with three expected platform skips after updating
four stale disclosure assertions and fixing the empty-slot mobile regression.
Primary inspected the changes and passing test-results/agent/.last-run.json;
Sol's full run was codex-rd:subagent-ui-full (1.2 minutes, exit 0). The earlier
viewer-tests.log is the pre-fix failing run. Server and viewer builds passed.

Final copied migration verification includes nullable executions.lifecycle_error;
all original columns of all 31 preexisting tables retain exact ordered-row hashes,
the two Stop tables are empty, foreign keys pass, and repaired block replay stays
suppressed across 22 affected turns. Live deployment and canary checks pending.
