# Durable subagent lifecycle and activity

Status: implemented, committed and deployed; local and live acceptance recorded below.
Broader audit remediation remains paused.

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
sync returns early whenever any turn exists. This paragraph records the pre-implementation baseline.

Repair helper review: four focused tests pass. Applied v2 repair to a consistent
live schema-15 copy: ten proven phantom executions and 22 projected blocks
removed, 22 archived block IDs suppressed for replay. All event/turn rows and
all other tables except the intended execution/block/audit changes retain exact
ordered-row hashes; foreign-key check empty and quick_check ok. Evidence under
`/tmp/remux-audit-implementation/subagent-validation/`. Live application subsequently passed, as recorded below.

A reviewed: protocol 10 exposes runtime and execution lifecycle; schema 16 adds
Stop intents/assignment targets and nullable executions.lifecycle_error. Accepted
interrupts retain acceptance when verification expires; explicit retry rechecks
without another native interrupt. Existing intents retain frozen targets across
repeated requests. Old native outcomes do not settle newer work; recovery_failed
is not native terminal proof. Child reads and Stop processing are coalesced;
resource invalidations cover timer outcomes. Stop's queue pause survives settlement
until the next deliberate send. The full server suite passed 277/277 and typecheck
passed; the dropped-terminal test additionally covers retry during a newer child
assignment with only one native interrupt. Browser and live acceptance are recorded below. Server/viewer protocol changes
ship together.

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
suppressed across 22 affected turns. Live migration subsequently passed, as recorded below.


Live deployment, 2026-09-05: schema 16 and the v2 phantom repair applied while
Agent was stopped, after the automatic pre-migration backup. Removed ten proven
phantom executions and 22 projected blocks; retained all 587 turns and 127,222
journal events. Foreign keys and quick_check passed. The native Codex daemon
remained running. The current thread preserved all 67 baseline turn IDs and user
content hashes, its native session, root, and active strand/revision; a later
native child hydration accounts for the 68th turn. The historical real stale
child implement_s2a1_acceptance now projects interrupted from native evidence.

The first isolated canary exposed I7: authoritative snapshot replay skipped the
existing ordinal allocator on two early-return paths. The reviewed fix always
normalizes per-pass block ordinals; a regression starts with two blocks proposing
ordinal zero. Server suite 278/278, typecheck and production builds passed. That
test conversation was reopened with an audited, test-only projection reset after
independent native reads proved both agents completed; no user thread was reset.

The second live canary (conversation 010f3e50-e000-4cc0-b671-d2353d46d91b) had an
active root and one child when Agent restarted. Conversation Stop, invoked while
the root was recovering, interrupted both exact native turns. Intent
227bfb16-aaeb-478b-9f43-b9b8543d0891 settled with two terminal targets and no errors;
queue_paused remained 1. Independent daemon thread/read confirmed both native
turns interrupted. Runtime returned idle with all child counts zero. Evidence:
`/tmp/remux-audit-implementation/subagent-validation/live-canary-stop.json` and
`live-canary-native.jsonl`. Desktop/mobile live browser checks passed without new
alerts, JavaScript errors or horizontal overflow; Agents opens and returns to the
retained transcript. Native phone interaction was not repeated.


Final assignment reconciliation checkpoint: a completed parent-side child card
can coexist with an unfinished child assignment. Startup and child-history reads
now check both execution status and durable assignment status. The regression
covers an unavailable initial read followed by authoritative completion through
the Stop watchdog. The final server suite passed 278/278, typecheck and both
production builds passed. The viewer remains at 187 passed / three platform
skips; subsequent changes were server-only.

After deploying 7882bfc, startup reconciled the first canary's child turn to
completed and settled its previously failed Stop intent without an Agents read.
The second canary remained interrupted/idle with its settled intent and paused
queue across another restart. Both isolated test conversations were then archived
through the normal API after confirming idle lifecycle, retaining their diagnostic
history. Agent PID 1513481 started at 23:31:09 UTC. This
thread remains healthy on the original native session, root and strand; all 67
baseline user-content hashes/turn IDs remain unchanged. There are now 82 turns
because startup hydrated additional previously unfinished child assignments.
No historical user turn was replaced. Checkpoint evidence is under
`/tmp/remux-audit-implementation/subagent-validation/`; pre-migration backups
remain under the native data root and archived copied-validation backups retain
verified uncompressed SHA-256 hashes.

Implementation commits: 685c0be (contract), f122d26 (proven repair), b463931
(durable lifecycle/Stop), 2ed4784 (activity UI), 0cc5b7b and 6e6a1c5 (snapshot
replay regression), 7882bfc (unfinished assignment reconciliation). All are on
main and pushed. These checkpoints complete this subagent slice, not S2a1 or
the broader audit. Original-device testing and live Claude threshold crossing
remain outside the acceptance claimed here.
