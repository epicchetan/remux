Status: Active Spec — staged implementation; incident fixes locally verified
Last verified: 2026-09-05
Canonical code: `extensions/agent/server/src/native-runtime/`,
`extensions/agent/server/src/providers/`,
`extensions/agent/server/src/federation/`, `extensions/agent/shared/`,
`extensions/agent/viewer/src/`, and the host items in
`crates/remux/src/rpc/ws.rs`, `crates/remux/src/http/viewer_bundles.rs`,
`crates/remux/src/extensions/supervisor.rs`
Amends: [agent-state-authority-and-synchronization-v1.md](agent-state-authority-and-synchronization-v1.md),
[agent-native-provider-runtime-v1.md](agent-native-provider-runtime-v1.md),
[agent-canonical-turn-journal-v2.md](agent-canonical-turn-journal-v2.md)

# Agent audit remediation pass 1

## User-directed checkpoint and restart

Current priority: the user has approved [durable subagent lifecycle and activity](agent-subagent-lifecycle.md).
Implement its A/B/C checkpoints before resuming the broader audit. The pause and
restart account below records the previous checkpoint, not a prohibition on this
newly authorized work.

Implementation is paused at the user's request. Commit the accumulated work on
main, push it, build the Agent server and viewer, and perform a controlled
restart with persisted-thread verification before resuming remediation.
Do not start S2a2 or investigate the newly reported subagent bugs yet.

S2a1 remains in progress. The latest tested checkpoint passed 100 focused tests,
typecheck and server build; subsequent edits require verification. Outstanding
review includes child-diff preparation/admission ordering, recovery guards and
dedicated restart/provider-evidence regressions. This checkpoint is not a claim
that the entire remediation plan or live acceptance is complete.

Going forward, use small committed milestones with builds and running-app
checks. Parallelize independent ownership scopes; defer nonessential hardening
instead of expanding every acceptance gate.

Checkpoint `9e2d0e9` was committed and pushed on main. Pre-restart validation
then fixed a readonly-union TypeScript narrowing issue and updated the stale
legacy spawn-receipt assertion to the reviewed unresolved-receipt policy.
The resulting tree passed typecheck, all 270 server tests, and the Agent server
and viewer production builds. Broader S2a1 acceptance remains pending as above.
The restart baseline records this conversation's 51 turn identities and user
content hashes, native session identity, and active strand under
`/tmp/remux-audit-implementation/checkpoint-thread-before.json`.

Restart verification, 2026-09-05: build correction `0d4b8bd` was pushed before
the Agent extension restarted through the host lifecycle API. The shared Codex
daemon remained running. Agent PID changed from 514847 to 810323; resource reads
after restart preserved all 51 baseline turn IDs and user-content hashes, the
native session ID, root execution, and active strand/revision. One additional
completed native-child turn was hydrated; no baseline turn was lost. This
conversation continued running with no health error.

The live viewer smoke passed at desktop and mobile widths with no JavaScript
errors or horizontal document/transcript overflow. Its only alert was the
preexisting capacity error on turn `f58192e3-f52d-45b3-b667-fd2353fe32ba`.
Evidence is in `checkpoint-{restart,server-tests,build,typecheck}.log`,
`checkpoint-thread-{before,after}.json`, and `checkpoint-live-viewer/` under
`/tmp/remux-audit-implementation/`. This verifies the restart checkpoint; broader
remediation and the newly reported subagent bugs remain paused.

## Purpose

The commits in `9d01170..bdd6825`, landed on 2026-09-04 and 2026-09-05, made
native Agent the product path. A nine-slice audit of that range on 2026-09-05
found that the provider-ownership boundary holds everywhere, but that several
normative invariants of the state-authority spec are only partially
implemented, and that the adapters, federation service, viewer, and host each
carry confirmed defects and several hypotheses requiring reproduction. This
document is the implementation agreement for a sequence of bounded changes.
It prioritizes reliable delivery, recoverable runtime state, consistent viewer
state, and history integrity. Recovery controls may become visible, but this
work does not add a version-tree UI or replace either provider's native harness.
Focused ownership extraction is part of each relevant fix; the full module map
in the state-authority spec remains a direction, not a required file checklist.

The complete findings register, with one row per defect and its disposition,
is [agent-audit-2026-09-05-findings.md](agent-audit-2026-09-05-findings.md).
The register separates planned coverage from implementation and verification.
Original audit locations refer to `bdd6825`; they are not a fresh assessment
of every change now in the shared working tree. Revalidate each finding when
its slice begins. Where a finding is already fixed, retain the regression
evidence and avoid implementing it again. Decisions below preserve existing
product behavior unless the user changes it.

## Delivery order and responsibility

The primary agent owns implementation outcomes, contracts, integration, review,
and this document. On implementation kickoff, it delegates bounded coding
slices to native same-provider `gpt-5.6-sol` subagents and reviews their work.
Use one implementation subagent at a time by default. A second may run only
for a concrete independent task with disjoint files and settled contracts;
never assign all stages or all audit areas concurrently. Shared schema,
protocol, coordinator, and journal edits have one writer at a time. Subagents
do not recursively delegate, commit, push, or restart services.

Before delegation, record the slice's finding IDs, invariants, allowed files,
dependencies, and acceptance scenarios. The primary agent reads the relevant
existing changes and gives the subagent enough context to preserve them.
During implementation the primary agent reviews the affected contracts and
failure paths; it does not independently edit files owned by that subagent.
After handoff it inspects the diff and tests, requests corrections, and runs
the appropriate integration checks. A subagent's completion report alone is
not acceptance. Work stays on `main`; commits, pushes, and live service
restarts are separate actions under the user's instructions.

Pass A–H below are topical requirements retained for finding traceability.
They are **not** eight parallel assignments or eight required commits. This
table determines delivery order; split a stage into smaller serial slices.

| Stage | Outcome and scope | Dependency / review gate | State |
| --- | --- | --- | --- |
| S0 — establish baseline | Inventory shared changes; review I1/I2 incident fixes and their tests; record current versions and validation. | Distinguish existing edits, locally verified changes, and live deployment. | Baseline inventoried; 196/196 server tests passed; prior local I1/I2 evidence reviewed |
| S0a — native Codex child identity | Fix I3's duplicate lifecycle blocks, completion mapping, and phantom descendants; establish explicit child ownership/identity for both native event paths. Reuse this boundary in S3. | S0; one bounded Sol assignment with primary review. Recorded-event regressions before live acceptance; repair existing incident from proven evidence. | Verified locally — runtime and copied-data repair; live repair/device acceptance pending |
| S0b — transcript error geometry | Include terminal error banners and per-turn projection retry in the shared layout/geometry model (I4); preserve navigation and scroll anchors through appearance, wrapping, clearing, and virtualization. | S0a; separate serial Sol assignment with primary review. Browser geometry assertions, not visibility alone. | Verified locally — primary review and full viewer integration; live/device acceptance pending |
| S1 — bounded correctness fixes | Serial slices for fitted bounds and compact failure (D, A7); auth/capability accuracy (A9/A10); draft/effort/compact gating (V6/V7/V10); attachment grants, checkout keys, catalog, result bounds (F1/F2/F5/F6); socket cleanup (R1). | S0b; affected scenario tests and source review per slice. Review any schema change before its implementation. | Verified locally — all S1 slices plus prerequisite C3a; F2 primary server 246/246; live acceptance pending; S2 tightens compact delivery evidence |
| S2 — command delivery | First ledger deduplication and stable client retries (C3/V1); then safe queue failure/recovery plus ownership-free reads (C1/R2); then edit/fork/spawn acceptance using the same delivery component (C5/A2/F4). Introduce the minimal transaction revision helper needed by admission. | S1 except the small C3a coalescing prerequisite moved before F2; review delivery transitions and provider evidence contract first. No prompt-text or session-binding acceptance inference. | C3a, A13 and S2a0 verified locally; S2a1 root delivery assigned |
| S3 — runtime and child lifecycle | Durable Stop and recovery (C2/A8/R3/R7); native child identity/ordinals/late completion and nested caller ownership (C4/A3/A4/A5/F3/F7). | S2; ownership survives stream loss and late events; no lane release based solely on disconnect. | Planned |
| S4 — viewer convergence | Projection revisions, one sync controller, edit/resume consistency, bounded detail caches, protocol mismatch (E excluding earlier V1/V6/V7/V10 slices). | S2–S3; prepare contracts and controller serially, then activate one refresh owner in an integrated cutover. | Planned |
| S5 — history integrity | Identity aliases, coverage-aware reconciliation, consistent sealing, bounded final output, scoped repair and foreign-key parity (C excluding S3 child work). | S4; identity/coverage plan reviewed before migration; copied-data and replay checks before acceptance. | Planned |
| S6 — host and app reliability | Separate lane, build/watcher, gateway, runtime-job, lifecycle-evidence slices (G); wire app tests (H10). | Serial slices with applicable host/app tests; do not couple independent host work to journal migrations. | Planned |
| S7 — closeout | Finish documentation corrections (H, including T7 and decision docs), audit unresolved findings, record release validation and any live acceptance still pending. | All in-scope findings have evidence or an explicit revised disposition. | Planned |

J9, A12, F9, V11, and H9 describe scenario coverage that accompanies the
relevant slice, not separate test-only rewrites. An urgent reproduced defect
can move earlier: update this table with the reason and dependencies before
delegating it. That is a scope adjustment the primary agent can make within
the agreed work, not a routine request for user approval.

### Review and progress record

For each completed slice, append a short record here containing: finding IDs;
behavior changed; component now owning the rule and old paths removed;
files or commit when available; tests and results; primary review result;
and remaining limitations/deployment state. Update register statuses in the
same change. Use `planned`, `in progress`, `implemented`, `verified locally`,
and `verified live`; `deferred` and `decision` are dispositions, not test results.
Never mark a row fixed merely because a planned stage mentions it.

Tests target failure classes and invariants. Reproduce correctness defects
before fixing them where practical; reuse existing scenarios where they
already cover the failure. Do not create 84 `todo` tests, mirror implementation
details in tests, or require test scaffolding for cosmetic documentation edits.
Each stage must remain buildable and reviewable; remove obsolete competing
paths as its new owner becomes active. No compatibility path may be left
without a named removal point.

### S0 incident evidence — 2026-09-05

I1: Claude context measurement now uses the latest distinct root model request,
not accumulated per-turn/cache counts or child usage; stale legacy context is
invalidated on read. Native Claude auto-compaction is enabled with a default
300,000-token policy, respecting the supported environment override and actual
capacity. The meter keeps actual model capacity separate from the compaction
policy. Native children use their native harness; federated children retain
their provider policy. Configuration/adapter behavior is tested; a live
threshold-crossing run has not been recorded.

I2: Journal materialization timestamps remain monotonic when provider events
precede durable admission or are replayed. Original observation timestamps are
preserved, stale events cannot reopen completed turns or replace newer recovery
state, and the composer identifies history-sync errors explicitly.

Evidence in `extensions/agent/tests/`: `claude-context-usage.test.ts`,
`claude-adapter.test.ts`, the root/legacy context and four timestamp scenarios
in `native-agent-journal.test.ts`, the pre-admission forced-history-refresh
scenario in `native-agent-coordinator.test.ts`, and desktop/mobile usage-tray
and history-retry scenarios in `viewer.spec.ts`. The previous implementation
run passed 196 server tests, the targeted desktop/mobile browser tests,
TypeScript checking, and Agent builds. A copy of the affected turn reproduced
the timestamp failure before the fix and passed afterward; the live database
was read-only. These are prior local results, not new runs for this spec edit.
Changes are uncommitted; that run did not restart the Agent server or verify
live recovery. S0 rechecks the current tree before accepting further changes.

### Kickoff inventory and S0a assignment — 2026-09-05

Baseline: `main` at `bdd682565557c2fbe38962037fc5c6c9c70d8270`, Node
24.18.0, npm 11.6.0, Codex CLI 0.153.4, Claude SDK 0.3.258. Existing tracked changes and
untracked incident/spec files are preserved; a baseline diff and status were
saved under `/tmp/remux-audit-implementation/`. Fresh server suite: 196/196
passed with two workers through the Remux research workload
(`s0-server.log`). I1/I2 source and prior browser/build evidence were reviewed;
live deployment/threshold crossing remain unverified. Fresh targeted desktop/
mobile browser baseline: 6/6 passed (native child navigation/interrupt, history
retry, context/compaction controls; `s0-browser.log`).

J7 deferral measurement: largest conversation by stored turns at kickoff was
`9c98742b-00f7-498c-863e-eca8306ae9a2`, 177 turns. Read-only local projector
tail-24: 411,461 bytes; three reads 19.29/15.81/15.10 ms, no provider hydration.
16 logical CPUs, load averages 0.20/0.11/0.10, no heavy workload active.
Both review thresholds remain untriggered (`s0-window.json`).

S0a delegated scope: I3 and its C4/A1/A5 overlap; Codex mapper/adapter and a
small child registry, the minimal durable binding contract/journal/coordinator
plumbing, focused tests and copied-data repair tooling where required. No
unrelated delivery/schema redesign, viewer filtering workaround, live database
mutation, commits, pushes, or restarts. Invariants and acceptance scenarios are
the I3 contract below. Primary owns spec updates, integration review and browser
acceptance after the implementation handoff. All shared contract/runtime files
have one implementation writer during this assignment. S0a is split into serial
runtime/restore and copied-data repair handoffs; S0b starts after both are
reviewed. The installed Codex CLI generated its protocol types into the
baseline directory for contract review: `Thread.parentThreadId` identifies a
subagent parent; collaboration receivers alone do not establish a spawn.
`SubAgentActivityKind` is started/interacted/interrupted/completed; failures
must use actual native turn/status evidence rather than an invented kind.

### S0a runtime handoff — verified locally, 2026-09-05

I3 runtime/restore and C4/A1/A5 overlap: the adapter's child registry now owns
verified parentage, immutable owning turn, and attempt transitions. Both native
event paths use it; duplicate adapter child/active-turn collections were removed.
Durable server-only bindings preserve canonical block payload/identity and
reachable native descendants across restore. Early notifications wait in a
bounded buffer for spawn ownership; overflow requests authoritative recovery.
Distinct child attempts retain one block but have distinct lifecycle event IDs.

Primary reviewed the mapper, registry, adapter routing, contract validation,
journal bindings, and regression tests, and required corrections before
acceptance. The original activity-completion-before-thread-completion order now
settles both child card and durable child turn. Focused Sol suite: 118/118;
primary full server suite: 205/205; primary repository `npm run typecheck`: passed;
server production build: passed. Desktop/mobile child disclosure/list/interrupt
scenarios: 4/4 passed. Logs: `/tmp/remux-audit-implementation/s0a-server.log`,
`s0a-typecheck.log`, `s0a-browser.log`. No app deployment/native live run occurred.

S0a repair handoff accepted locally: `i3-child-repair.ts` and its opt-in CLI
validate the exact incident inside one transaction, retain before rows and raw
events, and record narrowly scoped replay directives in existing `meta` (no
schema bump). Journal snapshot merging consumes those directives. The override
uses recorded terminal sequence 142741, so later genuine lifecycle observations
remain eligible. S5 must migrate these directives into its canonical alias/repair
boundary and remove the incident-specific journal branch only after equivalent
replay scenarios pass.

Hardened repair was applied to `/tmp/remux-audit-implementation/i3-repair-final.sqlite3`.
Sol verified unchanged 96,302 events and event SHA-256
`dc84bdda60a364bd844f35d3fadd93b1af8d07fda22cbe19ad332261a285c551`, SQLite integrity/FKs,
partial snapshot replay and idempotence. Primary independently read the repaired
copy/projector: one child card on the incident turn, original block
`codex-block-650ca9a1c9e40edee656699fc901c2a2` at ordinal 10, completed;
real child idle, no phantom descendant. The duplicate block was already absent
in this final backup; its exclusion is retained for replay. One similar record
without supplied incident evidence is reported as ambiguous and unchanged.
Audit output: `i3-repair-final-audit.json`; repeat CLI output is identical.
Sol repair/journal tests: 38/38; full server suite: 208/208; typecheck/server
build passed. Source live database remained read-only. Local repair acceptance
is not live application or physical-device acceptance.

### S0b assignment — 2026-09-05

I4 delegated after S0a local acceptance. One Sol writer owns transcript layout,
measurement/cache/reconciliation, turn rendering, necessary resource/layout
snapshot plumbing and styling, plus focused unit and desktop/mobile browser
geometry tests. Primary owns docs, review and integration. Use explicit measured
client display rows/footer for terminal error and local projection retry; no new
provider events or viewport state-machine rewrite. Preserve existing user scroll,
expanded work, action rows and disclosure behavior. Acceptance is the I4 section
below, including modeled-vs-DOM geometry (2 CSS px tolerance), wrapping,
appearance/clearing, virtualization, navigation, anchors and width changes.

### S0b handoff — verified locally, 2026-09-05

I4: resource layout snapshots now normalize terminal error and projection retry
into one typed footer. Rendering consumes this measured snapshot; the old
independent error/retry rendering path is removed. Footer revision participates
in measurement, reconciliation and cache version 10. Shared typography, spacing,
border and wrapping rules cover ordinary, whitespace-only and unbroken text.
No viewport state-machine rewrite or scroll-correction heuristic was added.

Primary reviewed the layout/render contract, cache invalidation, and test
assertions. New desktop/mobile scenarios (6/6) verify modeled-vs-DOM height and
adjacent turn positions within 2 CSS px, including expanded work, wrapping,
resize, virtual remount, error clearing/reappearance, projection retry, anchored
reading, navigation and bottom-follow. Navigation derives its expected offset
from actual content padding; it does not widen the tolerance. The development
projection-error test seam is absent from the production bundle.

Primary integration: full server 208/208, viewer 159 passed plus three existing
mobile-only scenarios skipped on desktop, all unit tests 56/56, root typecheck
and diff-check passed (`s0b-{server,browser,unit,typecheck}.log` in the baseline
directory). Sol also ran the viewer production build successfully. The recorded
phone screenshot still needs verification with the loaded runtime/device.

### S1 slice order and next assignment contract — 2026-09-05

After S0b acceptance, start S1 with R1 socket cleanup, then A7 compact failure,
then A9/A10 authentication and capability accuracy. Fitted bounds, composer
eligibility/persistence, and federation fixes follow as separate bounded
assignments. This orders the existing S1 scope; it does not start them together.

R1 owns only `codex-runtime-host.ts`, a small local transport cleanup helper if
needed, and `codex-runtime-host.test.ts`. The invariant is one bounded shutdown
with a cancellable, unreferenced timeout and no temporary close listener left
after either outcome. Preserve daemon/session ownership and JSON-RPC semantics.
Acceptance covers normal close, a peer that does not acknowledge close,
already-closed/connecting sockets, and cleanup on exceptional close. Existing
Unix WebSocket round-trip coverage remains. Reproduce the resource lifetime
defect where practical; the audit's Node abort remains an unproven attribution.
No schema or protocol change is needed. A single Sol writer implements this
after the S0b gate; primary reviews failure paths and runs integration checks.

A7 follows R1 review. Its writer owns `claude-adapter.ts` and focused Claude
tests, with coordinator/journal tests only if needed to prove durable settlement.
Installed SDK 0.3.258 declares `compact_result` and `compact_error` on
`system/status`. A root failure must settle the active manual operation with
the provider error, clear its local operation binding, and permit later work.
Child status must not settle root compaction; failure does not invalidate valid
context usage as a successful boundary does. Exercise failure, missing/long
error text, subsequent compaction, duplicate status, and ordinary success.
Reuse the existing typed failure event and bounds; do not redesign delivery or
change the provider contract in this slice. Source-fit helpers can be reused by
the later fitted-bounds slice. Primary reviews event identity and lane behavior.

### S1/R1 handoff — verified locally, 2026-09-05

The Codex socket shutdown helper now owns one timer and temporary close
listener. All settlement paths cancel the timer and remove only the owned
listener, including an exception during close. The timer is unreferenced.
CLOSED/CONNECTING behavior and JSON-RPC remain intact. The superseded
uncancellable Promise.race is removed. Primary reviewed cleanup and timeout
paths. Focused tests cover resource release, unrelated listeners, timeout
termination, exceptions and the existing real Unix WebSocket round trip (7/7).
The old acknowledged-close reproduction kept Node alive for 2.01 seconds; this
proves the timer lifetime defect, not the audit's Node abort attribution. Sol
typecheck passed; primary full server integration passed 212/212
(`s1-r1-server.log`). A7 is the next serial assignment; no live service restart
was performed.

### S1/A9–A10 preparation — 2026-09-05

A7 accepted locally before this assignment: root SDK compact failure now emits
the existing typed failure event with the exact manual operation ID and fitted
provider error, clears that binding, ignores child failures, and retains valid
request context. Bounded SDK-UUID replay tracking prevents a repeated failure
from settling a later operation. UUID-less malformed messages are observations,
not content-hash replay identities. Tests cover those distinctions, automatic
failure with actual context data, subsequent success, and durable failure
followed by queued-turn dispatch. The coordinator regression uses an explicit
failure release after asserting queue admission. Primary production review and
full server integration passed 214/214 (`s1-a7-server.log`); Sol focused files
48/48, final test-only correction 1/1 and root typecheck passed. No shared
contract or production coordinator/journal changes were required.

This slice follows A7 acceptance and owns the Claude adapter/auth helper and
focused Claude tests; primary owns capability documentation and review. No
shared schema change is required. The installed SDK's `Query.accountInfo()`
returns the initialization account metadata before prompt dispatch (verified
in `sdk.mjs` and `sdk.d.ts`); use this to reject incompatible credentials at
open, then validate later `init.apiKeySource` observations. Do not wait for a
first-turn message to complete open. Preserve cleanup of query, prompt and
native-session lease on rejection. Validate ordinary first-party subscription,
API key/helper/managed key, external backend, missing/unknown evidence, and
source change. Report source labels only, never credentials or account details.
The separate native-fork initialization handler reuses the same checks.

Runtime grounding: a zero-prompt initialization of installed Claude 2.1.258
reported first-party backend and subscription metadata while omitting account
source/token-source fields. Account-level source omission is therefore valid
when that subscription/backend evidence exists; explicit incompatible sources
are rejected. Probe requires the native CLI's positive `claude.ai` login,
first-party backend and subscription metadata. Ambient API-key/bearer variables
remain stripped. `init.apiKeySource` is checked separately. The SDK does not
provide a contractual token-source enum or a distinct source for every bearer
mechanism; do not invent one or claim that the account metadata distinguishes
every possible credential mechanism. Later auth rejection closes the prompt
and native query immediately, then publishes failure; it does not call public
`close()` from inside the consumer that `close()` awaits.

I1 currently emits latest-root-request context snapshots marked `derived`,
with an observation timestamp. The capability must describe that measurement
accurately. The separate account-usage read method and rate-limit push path
both exist, so `usage.plan = read-and-push` has direct implementation evidence;
do not remove that capability merely because context is derived.

A9/A10 accepted locally: primary reviewed open, later-init and fork gates,
prompt/query/lease cleanup and sanitized errors. Later rejection terminates the
native query without awaiting its own consumer. Context capability is now
`derived`; account read-and-push remains. Review also found the projector's old
Claude `manual` policy selection despite I1 enabling automatic compaction. It
now projects the selected Claude/Codex native-auto defaults separately from
support capabilities, retaining fixture manual policy. The provider-matrix test
sets automatic support false deliberately to prove this distinction. Primary
full server integration passed 218/218 (`s1-auth-policy-server.log`); Sol Claude/
context tests 24/24, projector 10/10, typecheck and server build passed. Composer
spec context/policy text and status now reflect the current implementation and
local-versus-live evidence. These fixes are not a live threshold-crossing test.

### S1 fitted-bounds assignment — A6/J8, Pass D

Next, one Sol writer first presents the contract compatibility and byte-budget
plan for primary review before editing shared types. Then it owns the shared
provider runtime contract, common display-fitting helpers, Codex mapper and
Claude adapter, required producer/restore call sites, and focused contract,
adapter and journal tests. Preserve I1/A7/A9 and S0a child ownership. No delivery,
history-alias, viewport or schema-table redesign belongs to this slice. Native
identities, tool commands and structural fields stay intact; only declared
display fields are fitted. Pass D below defines acceptance. The handoff must
prove legacy persisted reasoning remains readable, new producers signal
truncation correctly, oversized reasoning/summary/title/error events arrive,
and subsequent revisions and terminal events still validate. Primary owns docs
and integration; the composer slice follows its acceptance.

First review: the v6 reader preserves older event identity/hash semantics and
normalizes missing reasoning truncation flags narrowly. A read-only check of
the accepted I3 database copy projected all 5,642 legacy reasoning blocks and
parsed 18,030 reasoning events; the stored reasoning-row SHA remained
`4588c29744d06633d1311910022e1c19cc861ba05b084ee8da2b5b1842511887`
(`s1-bounds-legacy.log`). Initial server integration passed 220/220, but this
does not yet close A6/J8. Primary requested complete-envelope fitting in place
of an unproven half-budget reservation, independent bounded native reasoning
part indices, and truthful markers for tiny budgets and omitted parts. These
are arrival/identity invariants; the parser remains the final strict validator.

A6/J8 accepted locally: one explicit provider display fitter now measures the
complete candidate envelope for reasoning, tool titles, terminal/compaction
errors, execution summaries and child-block summaries. It preserves structural
fields, uses captured timestamps and fixed-size hash placeholders for sizing,
then hashes the fitted block and validates before state commit. Codex retains
native reasoning indices in separate bounded state; overflow visibly truncates,
later deltas retain the bounded prefix, and authoritative completion replaces
it. The regression reproduces index order 1/B, 1/C, 0/A, 1/D and expects A/BCD.
Tiny budgets and omitted parts carry truthful markers. The old ad hoc fitters
were removed. Contract v6 requires the flag; v2–v5 readers preserve old hashes.
Primary integration passed 222/222 (`s1-bounds-primary-server.log`), final mapper
tests 32/32, revised focused tests 113/113, typecheck and server build passed.
The read-only legacy-data check above passed. One Sol full run exposed the
existing 20 ms federation progress-test timeout; its isolated rerun and primary
integration passed. No provider-live oversized-payload run is claimed.

### S1 composer slice preparation — V6/V7/V10

State: verified locally after A6/J8 primary acceptance.

After provider correctness slices, one writer owns `App.tsx`, draft persistence,
composer configuration/usage plumbing, the viewer projection types, and focused
unit/browser fixtures and tests. Preserve existing service-tier and draft edits.
Persist access with the draft, restore it before asynchronous model defaults can
overwrite it, and include access-only changes in the persistence condition.
Legacy drafts use the existing workspace-write default; validate stored values.

The effort fix includes the viewer projection's fixed `REASONING_LEVELS` filter
and narrow `ReasoningLevel` type, not only the visible option list. Retain
provider-advertised effort strings through selection and submission; a model
with no efforts omits the row and supplies no native-provider effort. Existing
Remux configuration commands keep their required nullable `effort: null`;
optional create/provider parameters are omitted. Do not invent an Off option.
Remove the ambiguity between no effort and a native effort literally named
`off`: absence must remain distinguishable through request construction.
Prefer the native nullable effort representation over repeated special-case
rewrites in individual command builders. Test the actual submitted value for
an unfamiliar advertised effort and for advertised `off`, as well as omission
for a model with no efforts.
An advertised-effort model still exposes the row when its current effort is
null, so users can choose a native value without an invented Off/default option.
For compact eligibility use the selected native conversation's `resumable`
value and actual queued compact kind. The legacy viewer queue projection
currently loses `kind`; retain that discriminant rather than matching its text.
The history summary projection also loses `resumable`; retain it through
`ConversationSummary` so the selected conversation supplies the actual fact.
No native wire-format or database change is needed for these existing facts.
Test access-only reload and draft switching, models with no/unknown efforts,
and queued/running/unresumable compact states on desktop and mobile.

V6/V7/V10 accepted locally: draft storage now owns validated access persistence,
and App restore prevents the first stale effect or delayed model defaults from
replacing it. One nullable effort representation replaces fixed viewer enums
and magic-Off request conversions. The existing configuration controls retain
provider choices and expose selection when current effort is null. Projection
retains conversation resumability and queue kind; one compact-eligibility helper
requires matching loaded resources, resumability and no queued/running compact.
Submission pending is conversation-scoped. No native wire/schema change.
Primary reviewed all changed production paths; full server 224/224, full viewer
179 passed/3 existing mobile-only skips, unit 56/56 passed
(`s1-composer-primary-{server,browser,unit}.log`). Sol new desktop/mobile cases
20/20, existing model/edit/draft cases 6/6, typecheck and viewer build passed.
Tests cover empty access-only reload with delayed defaults, draft/conversation
switching, native unknown/off/null effort semantics, and compact gating. Live
runtime and physical-device acceptance remain pending.

### S1 federation preparation — F1/F2/F5/F6

State: F1/F5/F6 verified locally. F2 remains a later serial slice with its
reservation and command-retry contract under review.

After composer acceptance, first take the catalog/result-bound slice (F5/F6),
then the grants/checkout slice (F1/F2) with a reviewed migration proposal.
These remain serial assignments. The current credential already snapshots a
target catalog, but spawn only checks current provider readiness. Validate the
requested provider/model/effort against that snapshot, resolving an omitted
model from its recorded default, then retain current readiness validation.
A newly available target is not added to an existing credential implicitly.
The changed-file result retains the existing `changedFiles` array with at most
500 distinct paths and adds `changedFilesTruncated`, a numeric count of omitted
distinct paths (zero when complete). Repeated updates to a retained path keep
its latest data. F5/F6 owns the federation server/credential boundary, the
coordinator result builder/type, and focused federation tests; it does not edit
schema or implement delivery/child lifecycle. The existing 20 ms progress-test
deadline has flaked under server integration; if touched, replace that fragile
timing with a generous deadline while still proving progress extends a wait
beyond the initial timeout and preserving a bounded total deadline.

F5/F6 acceptance: the credential boundary resolves an explicit model from its
frozen catalog, validates frozen effort choices, and retains the coordinator's
current readiness checks. Results retain the first 500 distinct paths in the
existing latest-update ordering, merging latest data and preserving an earlier
diff artifact reference when later updates omit it. `changedFilesTruncated`
counts omitted distinct paths. Primary requested stronger effort coverage:
the current copy of the frozen model gains a new effort after issuance, which
still cannot be requested through the old credential. Real MCP tests cover
catalog expansion/contraction, frozen defaults, allowed effort, result overflow,
repeated paths and ordinary complete results. Focused 10/10; primary full server
224/224; typecheck and server production build passed
(`s1-federation-catalog-{effort-coverage,primary-server,typecheck,server-build}.log`).
The progress scenario uses a 1-second child, 250 ms idle timeout, 50 ms progress,
and 5-second total deadline. No live deployment or runtime acceptance claimed.

F1/F2 proposal assignment: inspect existing artifact admission, provider image
resolution, native history import, execution lineage and reservation paths;
write a concrete schema v12 migration design and verification plan under the
temporary implementation evidence directory. This assignment changes no
production files. Primary reviews grants/backfill trust, canonical worktree
identity, transaction boundaries, unresolved legacy reservations and compatibility
before assigning one bounded implementation slice. Preserve all prior canonical
IDs, raw events and incident repair behavior. Broad delivery and lifecycle
changes remain in S2/S3; schema parity repair remains in S5.

The artifact migration proposal must distinguish trusted viewer attachment
admission from a provider's attachment request. A provider cannot create its
own grant by submitting a guessed artifact ID: validate its existing caller
scope before granting a child access. Backfill only proven message/output
references, including queued messages and genuine execution lineage; leave
unreferenced uploads ungranted to provider callers. The local viewer upload/read
flow remains usable. Confirm all image resolution paths receive server-owned
caller scope, including first dispatch before a turn is durably admitted.
Checkout canonicalization may perform filesystem work before reservation, but
the capacity check and durable reservation share one transaction afterward.
Resolve existing conflicting/unknown reservations conservatively without
releasing a writer based only on missing connectivity. Record actual source
and target schema versions and copied-data evidence before migration edits.

Read-only copied-data preflight (`s1-federation-preflight.json`): schema v12;
24 image artifacts, 21 message image references to 19 distinct artifacts across
five conversations; no queued image references or assistant-artifact references;
2,543 diff artifacts. No active federated reservations exist in this copy, so
conflicting reservations and missing checkout paths need fixture coverage too.
These counts are input inventory, not an approved backfill or migrated result.

### S1 F1 migration review and assignment — 2026-09-05

Primary allocates schema v13 for F1 (current v12); provider contract v6 and
native wire v9 need no change for server-only grant scope. The reviewed source
proposal is `s1-federation-migration-proposal.md` in the temporary evidence
directory. Its binding choices are recorded here so implementation remains
aligned with this durable spec:

- Add `artifact_grants` with real artifact/conversation foreign keys and an
  optional execution constrained by the existing composite conversation/
  execution key. Partial unique indexes distinguish trusted conversation grants
  from execution grants. Source turn/execution fields are validated provenance;
  the earliest idempotent grant wins. No generic polymorphic scope or extra
  audit subsystem, and no rebuild of existing tables.
- Trusted viewer message, queue, steer and edit/branch admission validates image
  metadata and grants access before provider dispatch. Upload alone grants
  nothing to a provider. Never grant as a side effect of generic `createTurn`.
- Execution inheritance means self plus verified ancestors in the same
  conversation. It excludes siblings and descendants, with bounded traversal
  rejecting malformed lineage. Native children are not limited to federation's
  depth-two contract. Viewer-shared grants are conversation-scoped; imported or
  produced artifacts remain execution-scoped. Owned child result reads use the
  child's verified scope, not conversation-wide artifact access.
- Codex/Claude resolver callbacks receive immutable opened server scope. Native
  history imports grant from actual imported bytes under the verified source
  execution. Assistant/diff sealing receives source scope and registers/grants
  atomically after file staging. A pre-admission source turn may be absent; do
  not invent it or violate a foreign key just to annotate the grant.
- Federation validates each attachment against the caller's preexisting grant
  before allocation, then grants the admitted child in its transaction. Guessed
  IDs in provider messages/events/history never create authorization.
- Backfill only proven trusted admission/output relationships. Accepted viewer
  receipts must identify the exact turn/destination; validate historical strand
  root ownership rather than the currently selected root. Primary copied-data
  preflight found 13 potentially proven image references (11 send, 2 edit),
  including 10 on older roots; 8 references lack receipts and stay ungranted.
  Confirm metadata/MIME before insertion and report exclusions. Bare diff/event
  references are not proof. Preserve viewer reads for old artifacts and exact
  owned-turn assistant-result reads; this does not grant arbitrary text access.
- Preserve canonical IDs, raw event JSON/hashes and existing incident repair.
  Use the backup-before-migration transaction. Verify fresh v13, faithful
  pre-edit v12 -> v13, supported older migration paths, failure rollback/reopen,
  relational constraints and migration on a disposable copy. Existing broader
  historical foreign-key parity remains S5, not a new F1 acceptance claim.

One Sol writer owns schema/journal or a focused artifact-grant helper,
artifact store facade, adapter callback plumbing, coordinator admission/sealing,
federation resource authorization, main/server wiring and affected tests. It
must preserve prior accepted dirty changes and save its own baseline. It does
not implement checkout reservations, command delivery, child lifecycle or
viewer changes. Primary reviews production paths and copied-data evidence,
then runs integration before marking F1 verified.

F1 acceptance — verified locally, 2026-09-05: primary reviewed the scoped
artifact facade, full bounded ancestry validation, provider callback plumbing,
trusted admission transactions and migration. Requested corrections removed
a migration bypass for incomplete historical parent schemas, rejected partial
unique indexes as composite FK parents, and made the raw text reader private.
Maintained tests now include faithful committed-v8 and accepted-v12 schemas,
fresh/migrated grant-table and index parity, relational rejection, and an
injected migration failure through the production opener followed by rollback
and reopen. Earlier v2/v3/v5/v6/v7 sketch tests retain their specific delta
checks but explicitly reject incomplete v13 parents; they are not evidence of
full historical-schema parity. That broader verification remains in S5.

Provider-entry regressions assert image grants before initial, queued, steer,
edit and fork dispatch, including dispatch before a canonical turn exists.
Native child imports use the verified child execution. Output sealing grants
the producing execution; real MCP tests reject guessed, sibling-private and
cross-conversation attachments. Copying a fork prefix does not implicitly copy
all source-conversation grants: explicit new input is granted to the destination,
and authoritative native history bytes receive destination execution grants
when materialized. Existing owned-turn assistant artifacts retain the narrow
compatibility read described above.

Focused acceptance 94/94 and primary full server 230/230 passed; root typecheck,
server production build and diff checks passed. Evidence is in
`s1-f1-revised-logs/` and `s1-f1-primary-server.log` under the implementation
evidence directory. On a disposable copy, v12 -> v13 produced 11 distinct
conversation grants from 13 trusted references, excluded 8 unproven references,
and left bare historical diffs ungranted. Foreign-key and integrity checks
passed; canonical identity, raw event and legacy-event digests matched before
and after (`s1-f1-copied-validation-2/{result,preservation-hashes}.json`).
Schema is now 13; provider contract 6 and native wire 9 are unchanged. No live
database migration, deployment or runtime acceptance is claimed. S5 repair must
preserve or deliberately remap grant source-turn/source-execution references in
the same repair transaction as their canonical parents.

F2 review direction retained for its later assignment: every write-capable
access, including full-access, counts as a writer; real Git worktree roots
converge aliases while keeping separate worktrees distinct. Proven non-Git
fallback is the explicit workspace root's realpath. Missing/permission/indeterminate
Git paths cannot imply a distinct safe checkout for an active owner: retain an
unknown reservation and conservative admission fence. Reservations must survive
local startup failure states and fabricated child-failure events until actual
provider evidence settles ownership. Primary will review the exact release and
startup transitions before allocating the next schema migration.
Record the current reserved turn/attempt identity with the checkout owner:
a replayed completion for a previous follow-up cannot release newer work.
`finalizeFederatedExecution` is not release evidence because its callers mix
native outcomes with inferred recovery failures. Review live event, snapshot,
pre-dispatch failure, local close, and known descendant-work paths separately;
S3 remains responsible for the broader lifetime contract. Source review notes
are in `s1-checkout-lifecycle-preflight.md` in the evidence directory.

### C3a prerequisite before F2 — assignment, 2026-09-05

Source review confirms that a duplicate command can enter an asynchronous body
while its first invocation still owns a `received` receipt. Compaction already
exposes this defect; F2 filesystem resolution would add another such gap. Move
only same-process coalescing from S2 before F2. This is an ordering adjustment,
not acceptance of the full C3 delivery/restart fix or V1 viewer retry work.

One Sol writer extracts a shared in-flight command owner used by every async
coordinator command and artifact upload. Scope it to the journal/server runtime
so coordinator and artifact paths cannot establish independent owners for the
same command ID. Reuse the journal's existing canonical fingerprint algorithm;
do not change historical hashes. Install the deferred promise before invoking
the original body, which must still begin synchronously. Identical ID/kind/hash
joins one result or error while either received or dispatching. A mismatch
fails without changing the owner's receipt. Remove the entry on settlement,
including synchronous throw, without leaking rejected cleanup promises. A
transport waiter disconnect cannot cancel the owner. Synchronous commands retain
their synchronous API and existing durable fingerprint/replay checks.

Keep receipt replay and provider dispatch policy intact in this bounded slice.
An in-memory owner does not prove cross-process exclusion, native acceptance,
or restart recovery. F2 must separately replay settled receipts before path
resolution and conditionally claim/check/reserve in one transaction; a losing
connection cannot reject the winner's receipt. The later S2 delivery slice owns
unresolved receipt reconciliation and replaces the current recovery-failure
policy. Do not introduce reservation schema, a temporary federation-only map,
viewer retries, or a second provider-delivery state machine in C3a.

Verification must cover actual compact/send/federation/artifact entry points,
duplicate arrival during both received and dispatching, changed input and kind,
shared failure, durable settled replay, independent IDs, synchronous throws and
owner cleanup. Use controlled barriers rather than timing guesses. Primary
reviews the extraction and runs server integration before acceptance. The F2
follow-up design is `s1-f2-reviewed-contract.md` in the evidence directory; its
proposed schema/phase fields are not yet authorized and require simplification
against the shared S2 delivery owner before implementation.

C3a acceptance — verified locally, 2026-09-05: `NativeAgentJournal.runAsyncCommand`
owns the in-flight map and reuses the unchanged canonical hash. Fifteen async
coordinator methods and artifact upload use it; edit/fork share one method,
and native/federated interrupt routing retains its historical receipt kind.
Synchronous mutations retain their API and durable replay. Primary review added
an active fingerprint check to `claimCommand` so a synchronous different-kind
request cannot steal an ID before its async owner has created a receipt, plus
open-state checks before joining. Original command bodies and delivery/restart
policies are otherwise preserved. Controlled tests cover received/dispatching
overlaps, conflicts, shared failure and cleanup, independent IDs, durable replay,
actual send/compact/upload/federation entry points, and a server request whose
waiter disconnects without cancelling the command. Focused 87/87 plus final
39/39 delta tests and primary full server 234/234 passed; root typecheck, server
production build and diff checks passed (`c3a-logs/`, `c3a-primary-server.log`).
No schema/wire/provider contract change or live runtime acceptance. C3 remains
partially open for durable unresolved-receipt reconciliation in S2; V1's frozen
viewer retry identity is also still pending. Its source preflight is
`s2-viewer-retry-preflight.md` in the evidence directory.

### F2 implementation gate — schema v14, 2026-09-05

Primary accepts the minimal contract below after C3a integration. One Sol writer
owns this slice; no other production slice starts until primary review and
integration. Extract one checkout reservation owner used by spawn, follow-up,
startup and evidence-based release, plus the filesystem resolver. Remove the
duplicated raw-cwd capacity paths. Keep coordinator call sites thin; avoid
unrelated file splitting or a second delivery state machine.

Add nullable `executions.checkout_key` and its index, plus
`federation_checkout_reservations` with one current row per execution:

- `execution_id` primary key and real execution FK; `checkout_key` nullable;
  nullable `command_id` with real receipt FK and unique index; nullable
  `expected_turn_id`, an explicitly reserved future-turn token, not a canonical
  turn FK. Both attempt tokens are present together or null together for legacy
  ambiguity. Replace them only when reactivating a released owner.
- `access` read-only/workspace-write/full-access; `scheduling` foreground/
  background; `state` held/unknown/released. Held requires a proven key and both
  attempt tokens. Capacity indexes cover held and unknown rows. No unique
  checkout-writer constraint: preserve all conflicting legacy owners.
- Optional valid bounded `terminal_evidence_json`, `release_reason`
  pre-dispatch-failure/native-terminal, and monotonic created/updated/released
  timestamps. Released state requires its reason and released timestamp;
  reactivation clears old evidence/release fields. Existing receipts/events
  retain history; no per-attempt reservation history or additional phase enum.

Production resolution returns both a canonical checkout key and a resolved
launch cwd. Realpath the configured directory, use bounded argv-only Git
`rev-parse --show-toplevel`, and realpath the worktree top. Git subdirectories
and symlink aliases converge; separate linked worktrees remain distinct. Keep
the requested resolved subdirectory as launch cwd and use it for new child
preparation. Configured conversation cwd remains intact. Only a recognized
outside-repository Git result permits the explicit non-Git workspace realpath
fallback. Missing/permission/timeout/broken/dubious/malformed results are
indeterminate and reject new dispatch before native preparation. Follow-up
checks its persisted key rather than silently re-keying after a path change.

Replay settled receipts with the original fingerprint before filesystem work,
including after cwd deletion. Existing unresolved receipts are not permission
to dispatch. For absent receipts, resolve asynchronously, then conditionally
claim in one BEGIN IMMEDIATE transaction with all parent/root/access/depth/
scheduling/model/limit revalidation and capacity/reservation insertion. Only
the insert winner may persist rejection; a losing connection replays settled
or reports in-progress without changing the winner. Apply the same rule to
resolution errors. No await inside the transaction. F1 attachment authorization
and delegation grants remain inside the admitted child transaction. Later-turn
follow-ups remain valid when the original root turn has completed; F7's broader
caller/parent semantics remain S3.

Count held and unknown reservations, including locally failed execution rows.
Workspace-write and full-access consume writer capacity; only background
read-only owners count toward the four-reader limit. A known-key unknown stays
scoped to that checkout. Null-key unknown fences new writers and background
readers conservatively across checkouts. Retain per-root limits and make MCP
list access truthful for legacy full-access without widening spawn input.

At initialization, capture pre-recovery active federated owners and insert
unknown fences before any await/provider probing/discovery/local failure path.
Include an idle/locally failed federated ancestor when a known active native
descendant can still write; its projected terminal state is not release proof.
Resolve outside transactions; compare-and-set only the captured still-unresolved
owner, using bounded batches/concurrency and per-pass reuse for identical cwd.
A resolved key scopes legacy unknown but does not prove held/accepted.
Preserve reservations even when execution projection was locally failed.
Checkout reconciliation must precede internal provider preparation/credential
issuance. The listener may start early; external MCP/direct federation mutations
reject as unavailable until full initialization. Credential issuance cannot
wait on the full initialization that itself opens recovery sessions.

Release only the exact current execution/command/expected-turn owner. A live
invocation can prove it never called startTurn and reject/release atomically;
any throw after invocation stays unknown. A validated live native terminal or
exact authoritative-snapshot terminal can record bounded native evidence before
waiter notification. Use the event's execution scope, current turn/receipt
relationship and native binding; exclude session-local/synthetic recovery_failed
events. Local finalization, interrupt acknowledgment, socket close, absent
snapshot items and projected failure never release. Known active write-capable
native descendants retain the ancestor reservation and its terminal evidence;
their actual terminal triggers re-evaluation along verified bounded lineage.
Federated descendant reservations remain independent. Complete late/unobserved
child lifetime handling remains S3; F2 does not claim that broader guarantee.

Verify real temporary Git roots/subdirectories/symlinks/linked worktrees/non-Git
paths and resolved launch cwd, two-journal writer/reader and same-ID error races,
settled retry after cwd deletion, conflicting/unknown legacy owners, readiness
and recovery ordering, stale A versus current B completion, terminal-before-waiter
and known-descendant release. Existing fictional-cwd scenarios may use an
explicit declared test resolver; never a production fixture fallback. Verify
fresh/migrated v14 constraints and indexes, rollback/reopen, and migration on a
new disposable copy with ID/raw-event hashes and categorized reconciliation
report. Preserve F1 grants and the incident repair. Schema v14 is allocated;
native wire v9/provider contract v6 remain unless primary reviews a required
change. No live database or runtime mutation in this assignment.

Primary source inventory for the disposable-copy check: schema v13, 21 federated
executions (19 idle, 2 failed), 11 artifact grants, 96,302 events, 26,829 legacy
events and 327 receipts. There are 23 native executions marked running, but a
bounded same-conversation ancestry check found no federated ancestor among them.
Thus this source has no known active federation owner; startup descendant fences
still require constructed scenarios (`f2-primary-{source,descendant}-inventory.json`).

F2 copied migration review: the disposable F1 database upgraded from v13 to
v14. Primary independently compared every original column in all 28 source
tables: all row counts and content digests match, including raw/legacy events,
canonical identities, receipts, grants, and I3 repair metadata. Foreign-key
check is empty and integrity check is `ok`; the new reservation table is empty,
consistent with the source inventory. Evidence:
`/tmp/remux-audit-implementation/f2-primary-preservation.json`. This accepts
data preservation only; F2 lifecycle/release review and integration remain open.
To make space for the copy and its backup, two earlier I3 validation copies and
the older F1 migration backup were compressed, fully decompressed for SHA-256
verification, then replaced by mode-0600 `.sqlite3.gz` archives. Manifests are
`archived-early-copies.json` and `archived-f1-backup.json` in the same evidence
directory. Accepted source databases and live state were unchanged.

### F2 acceptance — verified locally, 2026-09-05

F2 now uses `FederationCheckoutOwner` for conditional admission, durable
reservations, startup fencing, and exact-evidence release. Real checkout
resolution converges symlink/subdirectory aliases while retaining the resolved
launch subdirectory; display cwd remains configured. The old raw-cwd capacity
helpers were removed. One current reservation row belongs to each execution;
receipts retain command history. Schema is 14; provider contract remains 6 and
native viewer protocol remains 9.

Primary reviewed transaction/savepoint rollback, losing-retry behavior,
startup readiness and captured-row CAS, follow-up limits, provider launch cwd,
and native terminal routing across live and authoritative snapshot paths.
Corrections retain fencing through local child `recovery_failed`, validate the
parent native turn on child summaries, and prevent stale attempts from changing
the current reservation. Native descendants can delay an ancestor's release;
independent federated reservations do not cascade. Session-local snapshots,
local close/failure, and interrupt acknowledgment cannot release ownership.
Full later child-lifetime discovery and delivery admission remain S3 and S2.

Maintained tests cover real filesystem/Git aliases and worktrees, capacity and
global unknown fences, two-journal winner/loser behavior with rollback and
settled replay, stale owner tokens, startup capture/CAS, migrated/fresh schema
parity, and actual migration rollback/reopen. A separate lifetime handoff adds
parent-before-child terminal timing: evidence is stored while the native child
still runs, and its later summary releases the reservation with exactly one
parent terminal event. It also covers native child handles, local recovery
failure, invalid cross-conversation lineage, and independent reservations.

Primary full server: **246/246 passed** (`f2-primary-server.log`). Final lifetime
focused suite: **15/15 passed**; root typecheck and server production build
passed (`s1-f2-lifetime-focused.log`, `s1-f2-lifetime-typecheck.log`,
`s1-f2-lifetime-server-build.log`). A subsequent fixture-only timer cleanup was
covered by that final focused run. Schema and journal handoff logs are under
`f2-baseline/`. Copied-data preservation is recorded above. No live migration,
service restart, commit, or push occurred.

### S2 provider preparation prerequisite — A13 verified locally, 2026-09-05

Primary reproduced a native configuration mismatch with a controlled SDK:
open at Sonnet/high, send with Fable/low, then submit Sonnet/high again. The
adapter called only `setModel(Fable)` and `applyFlagSettings(low)` because it
compared both submissions with immutable opening settings. Evidence:
`/tmp/remux-audit-implementation/claude-config-repro.test.ts` and
`claude-config-repro.log` (expected failing regression, no native prompt).
The register adds A13 separately from the original audit's coverage counts.

Assign one bounded Sol slice in `claude-adapter.ts` and its tests before shared
delivery implementation. Submitted configuration must be applied before prompt
enqueue; switching back, clearing a prior effort override, and retrying after
a settings/preparation failure must not inherit stale native settings. Prefer
one small preparation helper and straightforward idempotent SDK setters over
another configuration state machine. SDK 0.3.258 `applyFlagSettings` explicitly
supports `effortLevel: null` to clear the session flag; `undefined` is omitted
and does not clear it (`sdk.d.ts:2657–2673`). Preserve native effort mapping,
existing subscription checks and capability behavior. Tests cover A→B→A,
explicit-to-unspecified effort, and a setter failure followed by another
submission; no prompt may cross before successful preparation. Schema 14,
provider contract 6, and native protocol 9 remain unchanged. Primary reviews
the source and regression, then runs appropriate integration. Other delivery,
queue, Stop, and viewer changes await their own gates.

A13 acceptance: `prepareTurnConfiguration` now reapplies the requested model
(opening model when omitted) and mapped effort before enqueue. Omitted effort
clears the session flag with `null`. No configuration cache was added. Primary
reviewed the helper and controlled SDK tests: return-to-original settings,
explicit-to-unspecified effort, and settings that change then reject before
prompt delivery. The next command reasserts configuration and sends only its
own prompt. Focused Claude tests **22/22 passed**, root typecheck and server
build passed; primary full server **248/248 passed**. Evidence files are
`a13-claude-focused.log`, `a13-typecheck.log`, `a13-server-build.log`, and
`a13-primary-server.log` in the implementation directory. No native prompt or
live runtime update was used. The following delivery slice owns dispatch
serialization and native acceptance proof; A13 does not redefine those.

### S2a0 — Codex request crossing prerequisite, verified locally 2026-09-05

Implement this small serial prerequisite before the integrated delivery-owner
cutover. One Sol writer owns the Codex JSON-RPC peer, its process wrapper, and
focused tests; primary reviews. This does not claim C1/C3/V1 delivery recovery
complete and does not change queue, receipt, or provider acceptance semantics.

The peer must expose a synchronous optional before-write hook with the exact
request method and connection-local request ID. Serialize first; invoke the
hook immediately before entering transport.write. The future delivery owner
uses this hook to commit its crossing marker. A failed hook prevents the write.
An entered write may have delivered bytes even when it throws.

Preserve structured request errors: phase `not-sent` for closed-before-request,
serialization, or hook failure; phase `possibly-sent` after entering write,
including write throws, timeout, close, transport exit, and native error
responses. Preserve method/request identity and numeric native error code when
present. Native error codes are diagnostic until their rejection semantics are
separately reviewed; do not classify by message text. Preserve existing useful
error messages, omit arbitrary native error payloads, and do not manufacture
request acceptance from transport completion. Success values remain unchanged;
each adapter will validate its command-specific success payload in S2a.

Tests cover hook ordering and no write after serialization/hook failure;
partial-write throw, timeout, close/exit, and structured native error remain
possibly-sent; a correlated success resolves once and removes its timer/pending
entry. Process forwarding and existing daemon/adapter tests remain compatible.
No schema or wire version changes in this prerequisite.

Acceptance: Sol implemented the peer and process-wrapper hook plus structured
request-phase errors. Primary found and requested correction of synchronous
closure during serialization/before-write; the corrected peer performs zero
writes and reports not-sent in those cases. Focused Codex tests **28/28**,
typecheck, server build, and primary full server **253/253** passed. Logs are
`s2a0-codex-focused.log`, `s2a0-typecheck.log`, `s2a0-server-build.log`, and
`s2a0-primary-server.log` in the implementation evidence directory. No live
provider dispatch, schema change, or runtime update was used.

### S2a1 — durable owner and root-send adoption, assigned 2026-09-05

Finding scope: C3/C1/R2 delivery foundations; provider start evidence supporting
later C5/F4. One Sol writer owns schema/journal, the new delivery contract and
owner modules, coordinator root dispatch/event intake/recovery, provider start
adapters/fixture, narrowly scoped projector idle/eligibility guards, and their
focused tests. Primary owns specification changes,
review, and copied-data/integration acceptance. Preserve all locally accepted
S0/S1, C3a, F2, A13, and S2a0 changes.

Implement the linked S2a contract's schema 15, exact native correlation, bounded
durable staging, positive-proof persistence followed by atomic admission,
ownership-free positive recovery, and root queued-send cutover. Remove the root
`PendingTurnAdmission` array/map and optimistic started/user-message acceptance
predicate. Reuse C3a and F2; add neither another in-flight map nor another
checkout owner. Scope validation precedes staging; native child declarations
and their dependent events must not bypass the root admission boundary.

Use the same unresolved-owner predicate before existing native writer controls,
including direct Compact, access reconfiguration, and branch/strand mutations.
Removing a visible unknown queue card cannot make those controls available or
permit session reopening. A later queued send behind that owner may validate
stored configuration and record its intent, but cannot claim/resume a writer
session merely to perform its initial history freshness check. This guard is
part of root ownership adoption; the later slices still own those commands'
delivery transitions. Read-only resources remain available.

This assignment adopts root start only. S2a2 follows primary acceptance and
adopts live steer and manual Compact into the same owner; their schema kinds
are included in the reviewed schema 15. Existing branch/federation start
callers use one temporary typed-result compatibility helper and retain F2's
possibly-sent holds. S2b then implements failed queue progression and viewer
retry/recheck; do not mark C1/V1 complete in this slice. No second production
writer runs alongside this assignment.

S2a2 protocol decision: add a server-derived runtime `deliveryHeld` boolean
under native protocol v10, using the same journal predicate as writer guards
and queue claims, including accepted attempts with undrained staging. This
keeps Compact eligibility truthful for an unresolved steer or hidden root
intent. Provider contract v6 and schema 15 remain unchanged. The detailed
contract specifies the change; implementation waits for S2a1 acceptance.

Acceptance: fresh/schema-14 migration parity and actual-opener rollback; all
old-row copied-data hashes and FKs preserved; root receipt remains accepted at
queue admission; exact provider evidence admits once; optimistic/replay/error
frames cannot admit; pre-cross rejection vs unknown is persisted truthfully;
recovered preparing remains fenced; unknown blocks subsequent dispatch even
without a visible queue card; exact positive history admits once without
opening a writer session; partial/empty history stays unknown; admission fault
retains proof/stage and recovery never sends again; scope mismatch, duplicate
observation, overflow, large valid final envelope, and late evidence are covered.
All existing F2/C3a regressions remain green. Run focused tests, typecheck and
server build, then primary full server and copied migration review.

Primary review gate: the initial implementation passed the existing 257 server
tests but is not accepted. The assigned Sol writer is adding the required
fault and provider-evidence tests while correcting ownership and staging edge
cases found in review. In particular, verify foreign-owner rejection before
provider invocation, persisted or typed possibly-sent outcomes retaining the
lane, runtime validation of compatible positive proof, exact native session
scope, conflicting observation identities, encoded diagnostic bounds, and
checked admission/rejection transitions. Exercise admission of a captured
prefix while a suffix arrives, followed by another event before that suffix
drains; retained ordinals must preserve order without colliding. Legacy Claude
start callers must also wait for actual correlated processing evidence.
The next slices remain unassigned until this gate and copied migration pass.

Serial acceptance handoff: the first Sol writer returned a stable production
checkpoint with typecheck and 95 focused owner/provider/schema/coordinator
tests passing (`s2a1-acceptance-focused.log`). A fresh Sol writer now owns the
remaining dedicated evidence/reopen/child/suffix regressions and readable
runtime validation of persisted proof. Primary review found that typed
possibly-sent throws without a marker and malformed stored proof still need
explicit correction despite the initial checkpoint's test results. S2a1 is
still in progress; no S2a2 production work has begun.

Copied migration checkpoint: the real journal opener migrated the preserved
F2/schema-14 copy into
`/tmp/remux-audit-implementation/s2a1-copied-validation/agent.sqlite3` at schema
15. Both new delivery tables are empty and `foreign_key_check` returned no
violations. The source remains unchanged. This checkpoint does not replace the
pending fault/reopen acceptance tests. The subsequent primary comparison
confirmed identical hashes for every original column and row in every source
table, with clean foreign keys and `integrity_check = ok`. Both new tables
remain empty. The detailed report and check log are
`s2a1-primary-preservation.json` and `s2a1-primary-preservation.log`.
The opener log is `s2a1-primary-copied-migration.log` in the same implementation
evidence directory.
Its inactive migration backup is retained as a gzip archive after complete
decompressed SHA-256 verification; `archived-s2a1-backup.json` records the path
and hash. Both the schema-14 source and schema-15 migrated copy remain available
uncompressed for subsequent checks.

The integrated contract is now durable in
[agent-command-delivery-s2a.md](agent-command-delivery-s2a.md). It defines the
schema-15 additive tables, owner transitions, provider evidence matrix, native
message identity, staging bounds, atomic admission, and serial adoption points.
Primary reviewed transaction integration and installed Codex steer support.
The contract is implementation guidance, not a claim that S2 is verified.

For the next copied migration, inactive S0/F2 test copies were compressed and
their complete decompressed SHA-256 hashes verified before the uncompressed
copies were removed. The manifest is
`/tmp/remux-audit-implementation/archived-s2-headroom.json`; the latest F2/schema-14
copy remains uncompressed as the next migration source. No live database was
altered by this storage housekeeping.

### S2 source preflight — source findings incorporated into the contract

Installed Codex 0.153.4 generated contracts declare `TurnStartParams.clientUserMessageId`,
`ThreadItem.userMessage.clientId`, and `TurnStartResponse.turn.id`.
`ThreadForkParams.beforeTurnId` is explicitly exclusive; `lastTurnId` is
inclusive. Preserve that distinction and verify supported runtime capability
before considering a fallback. `thread/read` may expose partial item views;
no matching item in one response is not proof of non-delivery.

Installed Claude SDK 0.3.258 declares `user_message_uuid` on the first root
assistant/partial frame and on result frames, referencing the caller-supplied
user UUID. The adapter currently supplies a stable prompt UUID but returns
acceptance immediately after pushing its local input queue. Native correlated
frames can provide stronger evidence; local `user.message`/`turn.started` cannot.
Do not treat every UUID-bearing result as accepted work: the SDK explicitly
documents UUID-bearing remote delivery-failure error results too. Classify
actual native processing evidence and delivery errors separately in the table.
`getSessionMessages` reads a persisted parent-linked conversation chain without
opening a query, but an empty result is explicitly also returned for a missing
session and cannot prove absence. The per-command evidence table, exact fixture
correlations, request-phase errors, and unsupported recovery cases still require
the S2 review gate before implementation. Source artifacts are the kickoff
`codex-protocol/v2/` capture and the installed SDK `sdk.d.ts`; no provider turn
was dispatched for this preflight.
The expanded per-command source matrix is recorded in the implementation
evidence directory as `s2-delivery-evidence-preflight.md`; it is still a
preflight, not acceptance of a delivery implementation. It separates Codex
start/steer/compact, Claude start/error-result/compact, and unsupported steer.
Additional bounded Sol review found the installed Claude CLI 2.1.258
`--replay-user-messages` flag. Primary verified its help text, the SDK's public
`extraArgs: { 'replay-user-messages': null }` option, and argument forwarding.
`SDKUserMessageReplay` supplies exact UUID/session/isReplay identity, providing
native stdin receipt evidence. This does not yet prove slash-command validation,
admission/start, or ordering relative to compact outcome: the first review
overstated that distinction and was corrected. An installed-CLI fixture/source
proof is required before promoting replay receipt to Pass B acceptance.
Outcome association still requires a continuously observed exclusive process
generation with no earlier unresolved control; restart/gaps retain unknown.
See `s2-claude-manual-compact-evidence-review.md`. No provider prompt was sent.
Follow-up inspection of the installed CLI's embedded source establishes a
manual-handler behavior without promoting replay receipt. The manual
handler validates ended-session/empty-history conditions, then emits
`status: compacting` before its first awaited hook (binary decimal byte
192262854). It returns a successful compaction result only after the native
summary succeeds (192264612); its `finally` emits success/failure metadata
(192265072), mapped to wire `compact_result` at 199065063. Primary verified
these source snippets. The same status is also emitted by automatic compaction
(183981707), and the shared SDK wire mapper omits trigger, input UUID, and
producer identity (199064964). Consequently, this proves how the manual handler
behaves but cannot attribute a received status to it. Treat generic
`compacting` as progress and untagged `compact_result` failure as ambiguous;
neither settles a manual command. A post-dispatch `compact_boundary` explicitly
tagged `compact_metadata.trigger: manual`, in one uninterrupted process/session
with no earlier unresolved manual control, can establish acceptance and
completion together. Gaps, restarts, overlaps, and failure-only status remain
unknown. Preserve manual Compact with that completion evidence; do not invent
`parent_tool_use_id` in status/boundary fixtures when the SDK producer does not
emit it. The final source review supersedes the provisional status-start
acceptance predicate in the temporary S2a proposal.
The duplicate-input path explicitly emits replay acknowledgment too
(199173629), confirming that replay itself does not prove processing. Likewise,
an exact user UUID in Claude's persisted JSONL proves ingress, not model
acceptance; recovery needs a correlated native reply or terminal fact. The
proposed S2a contract and primary review refinements are recorded in
`s2a-reviewed-proposal.md` and `s2a-primary-review-notes.md` in the implementation
evidence directory. The reviewed successor is the linked durable S2a contract;
the temporary proposals are historical review evidence.
Codex steering supports a per-message `clientUserMessageId`, currently omitted
by the adapter. Manual compaction has weaker restart correlation in both
providers; a local operation ID must not be represented as native proof.
The existing coordinator regression titled “stream loss during native Compact
becomes delivery_unknown and is never redispatched” currently also asserts that
unknown releases later work. In S2 invert that unsafe release assertion:
unknown manual controls retain lane ownership and expose recheck, just like
unknown message delivery. Preserve the useful no-redispatch coverage. Current
`dispatchNext` blocks only a running compaction and the projector maps unknown
to failed; update both under the shared delivery/queue contract rather than
keeping compaction as a competing exception.

### I3 priority adjustment — native Codex child projection, 2026-09-05

The first Sol spec-review child in this conversation exposed a concrete gap in
the planned C4/A1/A5 ownership/identity work. Address it as S0a before using
subagent-driven implementation broadly. It is part of this plan and does not
require the full S5 identity migration to be implemented first.

Read-only journal evidence: conversation `8862392c-d732-4d21-9bbd-a952bbfb7677`,
owning turn `e56a5d60-8f88-4016-bc0b-9eab3f2b5a1e`, native child thread
`01a0720f-ce20-7c71-9bbb-00d75cdc0207` (`/root/review_revised_spec`).

- Events 142651/142652 create two blocks for the same child execution, only
  43 ms apart. `mapSubAgentActivity` normalizes using the native parent turn;
  `mapChildThreadNotification` passes the Remux parent turn into the same block
  identity function with `turnAlreadyRemux`. The blocks land in different
  passes although their visible owner and child are identical. Completion
  updates one block, leaving the other running. The duplicate existed at start;
  completion made the inconsistent state apparent.
- Event 142740 maps `subAgentActivity.kind = completed` to a running
  `child.status`, because only `interrupted` is distinguished from running.
  Event 142741 correctly completes the other block via `turn/completed`.
- Event 142709 maps an `interacted` activity in the child's turn to another
  child execution. The native child rollout proves this is a message to
  `agent_thread_id = 01a07179-6793-7520-9180-28baa6a320cf`, path `/root`:
  its parent, not a spawned grandchild. The journal therefore contains one
  real child and one phantom descendant. The execution-list view traverses
  those durable rows, explaining its two entries.
- Both root transcript rows use the same execution-scope disclosure key,
  explaining why either row controls the same child dropdown. Changing the
  dropdown key alone would hide the ownership defect rather than resolve it.

A local mapper reproduction passed assertions for all three bad behaviors:
same child execution/different block IDs across activity and thread events;
completed activity still running; message-to-parent fabricates a native child.
No provider turn was dispatched and no live database was modified.

S0a contract: normalize provider and Remux turn identities before selecting the
child block; bind native child thread to one execution and its original owner.
Only spawn/verified parentage establishes a child edge. Interactions with a
parent, sibling, or existing child are activity, not new ownership or a new
turn; an activity notification alone does not establish an execution restart.
Map actual completion/interruption/failure semantics explicitly, and reconcile
duplicate or late lifecycle observations without reopening a completed attempt.
Preserve genuine child follow-up turns and genuine grandchildren. Use a small
adapter-owned child registry supplied with durable bindings, not independent
heuristics in each event handler. Resolve one canonical block for this owned
child; retain its existing ID and disclosure state.

Acceptance scenarios: both event paths in either order; duplicate notifications;
completion before later replay of started activity; parent advances turns before
child completes; message to parent/sibling creates no descendant; genuine spawn
and follow-up remain visible; restart/snapshot replay preserves identity; exactly
one root disclosure and one real child in the execution list for the recorded
incident. Add mapper/adapter tests plus journal/projector and desktop/mobile
viewer coverage for these outcomes. Tests may share fixtures with C4/A1/A5.
Existing-data repair first runs on a copy: merge only proven duplicate blocks
for the same owned child and remove/exclude only proven fabricated ownership
edges without deleting genuine turns or descendants. Retain diagnostic events
and repair evidence. Ambiguous rows stay reported rather than heuristically
deleted. Merely filtering duplicates in React does not satisfy acceptance.

### I4 priority adjustment — unmodeled error height, 2026-09-05

The screenshot shows a real `serverOverloaded` failure on turn
`f58192e3-f52d-45b3-b667-fd2353fe32ba` in conversation
`8862392c-d732-4d21-9bbd-a952bbfb7677`, with message "Selected model is at
capacity. Please try a different model." The durable error was read without
modifying the database. The provider's failure and the layout defect are
separate: an ordinary failed turn must still have correct geometry.

`TranscriptViewportBody.tsx` renders `turn.turn.error` after `turn.rows`, outside
any measured `TranscriptRow`. It renders the per-turn projection-retry button
there too. `measureCollapsedTurn` sums only `turn.segments`; its supported kinds
are user message, assistant message, work, and compaction. Neither extra is
included. `TranscriptGeometryIndex` uses that collapsed height plus expanded
work height, so later turn offsets and virtual spacers omit the banner's text,
padding, border, and spacing. Body resize observers rerun viewport calculations
but do not add that missing height to the geometry model. The existing terminal
error browser test checks visibility/work status, not offsets or navigation.

S0b establishes one rule: every element occupying normal flow within a
virtualized turn is represented in the same layout input used for rendering,
measurement, geometry, and cache invalidation. Normalize terminal errors and
projection-retry state into explicit client display rows (or an equivalent
typed, measured turn-footer model). Preserve their stable identity and existing
placement; they are display state, not invented provider transcript events.
The renderer must consume that model instead of independently appending extras
from another store subscription. Inspect other turn-level conditional content
for the same bypass as part of this bounded slice.

Measure wrapped text at the actual content width with the rendered typography,
padding, borders, and spacing. Use shared layout constants and the existing
measurement system; do not add a fixed error-height offset, a scroll correction
timeout, or a DOM-height patch that disappears when the turn unmounts. Include
error text/presence and local projection-retry state in the relevant measurement
revision/cache inputs even when segment content is unchanged. Clear stale
cached geometry through the normal cache-version/revision mechanism. Changes
flow through the existing render snapshot and anchor policy: preserve a reading
anchor and native user scroll ownership; bottom-follow remains correct.

Acceptance: deterministic layout tests include error/retry height exactly once,
and later turn tops change by that height; changes/clearing invalidate cached
measurements. Desktop/mobile browser tests compare modeled and actual row/turn
positions, with an explicit rounding tolerance (at most 2 CSS px), for short,
wrapped, and multiple failed turns followed by successful turns. Exercise
Up/Down message navigation, free scrolling across virtual unmount/remount,
anchored reading when an error appears/clears, width changes, expanded work,
bottom-follow, and projection-retry appearance/clearing. Assert positions and
spacers, not only that the alert renders. Record the screenshot regression as
live/device pending until checked in that environment.

This is a missing layout input, not current evidence that the whole viewport
state machine needs replacing. T5/T6 retain their existing deferral/revisit rule;
S4 synchronization must preserve the geometry contract established here.

## Ownership boundaries to establish

| Responsibility | Owner after its slice | Old responsibility removed |
| --- | --- | --- |
| Command identity and delivery | A small ledger/delivery component with explicit attempt transitions, durable evidence, and per-command recovery policies; coordinator invokes it. | Separate send/edit/spawn guesses about acceptance and duplicate in-flight dispatch. |
| Stop and accepted-turn lifecycle | Explicit lifecycle transitions and an owned, cancellable reconciliation task. | React-local Stop authority and scattered timeout/stream-close outcome inference. |
| Viewer convergence | `conversationSyncController` owns generations, revision targets, pending changes, reads, and publication. | Independent action/bridge/history refresh choreography. |
| History reconciliation | Subject resolver and coverage planner produce a plan; the journal applies it atomically. | Identity heuristics, destructive snapshot replacement, and output selection mixed into unrelated reducer paths. |

Use small typed transitions and ordinary modules; no generic workflow engine
or new state-machine dependency is required. The coordinator may orchestrate
effects and repositories may execute SQL. Adapters translate provider evidence
and receive durable bindings through their contract; they do not read the
journal's database. Merely splitting files without removing duplicate owners
does not satisfy this cleanup.

## Grounding

The original audit reports are summarized here as historical grounding. Their
claims and severities must be checked against the current tree during S0 and
the relevant stage; the register retains plausible findings as hypotheses.

Runtime and queue. A pre-accept `startTurn` rejection, or an extension restart
during dispatch, marks the queue head `delivery_unknown`; the claim path refuses
that state and nothing reconciles it, so the conversation lane blocks forever.
Two in-flight commands with the same command ID both execute because the ledger
replays only settled receipts. Stop records adapter acceptance only, with no
durable interrupt-requested state and no watchdog. Edit and fork insert the
canonical destination turn before provider acceptance. The daemon-client
`closeSocket` in `codex-runtime-host.ts` races the close event against a
two-second delay and cancels neither. The audit also observed a Node 24 abort
in `codex-runtime-host.test.ts`; its causal link to this leak needs reproduction
because the subsequent 196-test server run passed without changing this code.

Identity and journal. Ordinary Codex blocks hash the mutable native item ID and
session ID, so a live item and its `thread/read` positional twin become two
subjects; only compaction controls received occurrence aliasing. Snapshot
reconciliation deletes live passes the snapshot did not cover and cannot
express an empty complete domain. Output sealing picks the highest ordinal
rather than the authoritative revision. Late native-child completions attach to
whichever root turn is current. A large but valid final response exceeds the
8 MiB resource ceiling because passes keep full text. The v11 repair records
ambiguous duplicate compactions and leaves them visible. A database migrated
from v6 lacks two foreign keys a fresh database has.

Adapters. Claude routes finalized subagent assistant frames into the root turn,
resets content-block ordinals per frame, ignores `compact_result: 'failed'`,
fails a recovered turn before the resume handshake, and ignores the SDK's
`apiKeySource`. Codex edit-before forks send `beforeTurnId`; the pinned
reference checkout (tagged v0.144.0) does not define it, but the installed CLI
0.153.2 does, so the defect is an unversioned assumption rather than a wrong
parameter. Both adapters validate display-string and envelope bounds without
fitting, so a long shell command or a long reasoning revision drops the whole
event.

Federation. Attachment references are not authorized against the caller, and
`artifacts` records no ownership to authorize against. Checkout keys are raw
`cwd` strings, so aliases defeat the one-writer rule. Nested spawns resolve the
root turn instead of the caller's active turn. Spawn acceptance is recorded
only after `startTurn` returns, so a lost response becomes a durable rejection.
The frozen target catalog is descriptive only. `changedFiles` is unbounded.
Passive history hydration acquires ownership and resumes a native Codex
thread, which the native-runtime spec currently permits and the
runtime-management spec forbids. Child cards do not say native versus
federated.

Viewer. Three refresh paths race with no shared fence. Retries mint new command
IDs. Draft access level is in-memory only. Effort gating shows Off for models
that advertise no efforts. A head-CAS rejection leaves the editor bound to the
stale target. Resume always requests the tail window. The edit fix in
`bdd6825` publishes the new anchor before the new snapshot exists. Execution
scope and detail caches are unbounded and never cancelled. A protocol-version
mismatch becomes an empty invalidation.

Host. Agent mutation lanes are keyed by caller-supplied conversation IDs and
never evicted, and the 512 lane cap is global across all route lanes. The
immutable-bundle watcher only registers roots that exist at startup. Manual
view builds are detached and not reaped on stop. Response sanitization strips
`Connection` but not the headers it nominates. Runtime-management jobs are
treated as complete on admission.

Docs. The specs index disagrees with five spec headers, version boundaries lag
the code by several migrations, the lineage spec and the extension README claim
historical preview and Make Current UI that the viewer intentionally lacks, and
the README lists five MCP tools where the code exposes six.

## Decisions

Stop keeps the queue. The Codex extension's queue clears pending entries on
Stop; the Agent queue is durable and explicit, and its viewer test asserts
preservation. Agent keeps preservation. The runtime resource makes this visible
by showing queued entries as `waiting` under a `stopping` turn. No queued work
dispatches while stopping/recovery owns the lane. After proven termination,
the existing FIFO resumes; Stop does not introduce a persistent queue-pause
mode. Tests must cover this distinction across reload and restart.

Historical preview and Make Current stay server-only in this pass. The viewer
ships a flat recent-chat list on purpose. The lineage spec and README are
corrected to say so rather than the viewer growing a version surface.

Codex Spark usage windows stay hidden. The usage tray omits them by decision
and `usage-windows.test.ts` asserts it. The composer control-plane spec is
corrected to list that exclusion instead of requiring every normalized window.

Identity follows the state-authority Codex mapping rules exactly. The subject
key for a block is the native turn subject plus the provider's durable native
item identity where one exists; when Codex rewrites item IDs in `thread/read`
or after resume, the journal aliases the positional ID to the existing subject
by semantic kind and occurrence within that native turn only when coverage
proves that the occurrence is unambiguous. Semantic kind is phase-independent:
commentary and final revisions of the same native item share one subject;
distinct assistant items never merge merely because their kinds match.
Existing persisted block IDs remain canonical opaque IDs, even if originally
computed as hashes. New subjects receive an ID once; resume/fork must not
recompute it from a new session or positional ID. Preserve existing references
and add aliases. Only proven duplicate subjects require scoped reference repair.

Bounds are fitted at the adapter, enforced at the coordinator. Adapters
truncate titles, summaries, errors, and cumulative reasoning revisions to the
shared display bounds before emitting. Shared validation keeps rejecting
over-limit envelopes so a broken adapter cannot poison the journal.

Delivery-unknown is surfaced, not auto-resolved. When a snapshot proves
presence for the specific delivery attempt, the entry admits once. When a
fresh, authoritative snapshot proves absence for that attempt and no dispatch
remains in flight, the entry becomes `failed` and retryable. Text equality,
timestamps, or a native-session binding alone prove neither. When neither is
provable, the entry stays `delivery_unknown` and blocks dispatch. A Retry on an
unknown entry rechecks evidence with the original command ID; it does not send
again. Discard acknowledges removal of Remux's queued intent, not cancellation
of potentially accepted provider work. It cannot release the execution lane
until ownership is reconciled. There is no implicit resend-anyway action.

Passive reads never own a session. This pass amends the native-runtime spec's
lazy-history paragraph, which allows a session to be opened solely to read
passive history, to match the runtime-management rule that history discovery
and passive native reads require no lease. Codex `thread/read` reads an
unloaded thread from its store without resuming it, so no capability is lost.

Migrations are scoped to reviewed slices. Rebuild only tables whose constraints
require it, under the existing backup-before-migration guard. Migrated and
fresh databases must converge. There is no mandatory all-table/block-ID rewrite.

S0 records the actual provider contract, native protocol, transcript protocol,
and schema versions. Allocate the next version when a slice requires an
incompatible contract or schema change; do not reserve one v12 migration for
the whole program. Each intermediate state must upgrade correctly. The primary
agent owns version allocation and compatibility review across subagents.

Focused extraction is required where this document names an owner. Move the
responsibility and its tests in the same slice, remove the superseded path,
and defer unrelated file splitting.

## Pass A — freeze and unblock

Intent: pre-accept failures do not deadlock the queue, ambiguous delivery never
silently duplicates work, and socket cleanup has bounded lifetime. Queue work
is S2 after the delivery contract is reviewed; socket cleanup is an S1 slice.

- `codex-runtime-host.ts` `closeSocket`: hold the timer handle, `unref()` it,
  clear it in `finally`, and remove the losing `close` listener. Reproduce both
  normal close and timeout cleanup; separate the proven resource leak from the
  audit's unconfirmed explanation of the Node abort.
- Queue head deadlock. `queued_messages` gains state `failed` and an
  `error_json` column. The adapter contract distinguishes proven not-sent or
  explicit native rejection from possibly-sent transport failure. Whether a
  promise rejects synchronously or asynchronously is not delivery evidence.
  Proven rejection becomes `failed` with the error and permits the next FIFO
  entry. Failed entries remain visible as failed intents but are excluded from
  dispatch claims. An explicit later retry enqueues a linked attempt at a new
  tail ordinal; it never jumps ahead of work already queued or running. Keep
  failed intent/receipt evidence even after its visible card is removed.
  Possibly sent, or restart during dispatch without terminal evidence,
  becomes `delivery_unknown`. Persist an attempt identity and available native
  correlation before crossing the dispatch boundary. A staged event proves
  acceptance only if it represents native evidence correlated to that attempt;
  an optimistic adapter-local `user.message`/`turn.started` is insufficient.
  The reviewed contract must state what each provider can actually prove.
  Before S2 coding, the primary agent records an evidence table per provider
  and command kind: exact native acknowledgment/event fields proving acceptance,
  explicit rejection/not-sent evidence, any authoritative negative proof,
  correlation persistence across restart, and unsupported cases. Cite the
  installed contract/fixture for each claim. Lack of native correlation or
  negative evidence is recorded as unsupported; a test fixture cannot invent
  stronger guarantees than that provider exposes. Unsupported absence stays
  unknown even if the text, time, and branch appear to match expectations.
  Reconciliation runs on startup, session recovery, and explicit recheck using
  the ownership-free read from Pass F (implemented in S2). Match durable native
  command/message/turn identity to the attempt, never prompt text or a relaxed
  attachment comparison. Absence requires authoritative coverage of the
  relevant branch and attempt, a read fresh enough to include dispatch, and no
  still-running request that could subsequently accept. Otherwise stay unknown.
  Claude's session-local log cannot prove absence after process loss.
- Queue resource and protocol. `NativeQueuedMessage` gains `state`, `error`,
  and `actions: ('retry' | 'discard')[]`; `AgentQueueResource` parsing and the
  method table gain `retryQueuedMessage` beside the existing
  `removeQueuedMessage`. Failed-entry retry creates a new delivery attempt
  linked to the original queued intent, without losing prior receipt evidence.
  The retry command itself has a stable ID across lost-response retries.
  Unknown-entry retry means recheck, labeled accordingly; discard behavior
  follows Decisions above. Removed unknown attempts retain recovery/ownership
  evidence outside the visible queue.

Tests: `native-agent-coordinator.test.ts` gains pre-accept rejection leaves a
retryable failed entry and does not block the next entry; restart during
dispatching remains unresolved without native evidence; failed A followed by
queued B/C dispatches B/C and puts a later retry of A at the tail; restart during
dispatching followed by snapshot presence admits once; snapshot absence with
fresh attempt coverage fails retryable; partial/stale coverage stays unknown;
same-text prompts with different attachments never establish identity;
optimistic local events do not prove acceptance; recheck and discard cannot
dispatch a duplicate or overlap unresolved provider work. `viewer.spec.ts`
covers failed retry versus unknown recheck. `codex-runtime-host.test.ts`
covers cleanup without relying on process exit as the assertion.

## Pass B — command and stop authority

Intent: one command ID yields one receipt, no transcript fact exists before
acceptance, and stop is durable server state with a bounded watchdog.

Command ledger. Extract one command entry point with an in-flight map keyed by
command ID, installed before the first await. Validate the request fingerprint:
the same ID with different content is a conflict. Same-process duplicates await
the same outcome in both `received` and `dispatching`; they do not redispatch
or report a false ambiguity while the original call is still active. Settled
receipts replay their original result. On restart reconcile all unresolved
receipts and attempts, including `dispatching`, through per-kind policies.
Unknown is a durable delivery state that may later resolve, not a terminal
failure frozen forever. Keep receipt replay and attempt reconciliation distinct.

| Delivery state | Evidence / transition | Permitted effect |
| --- | --- | --- |
| Preparing | Intent and command fingerprint persisted; no send has crossed the adapter boundary | Prepare native session or branch; these are separate milestones |
| Dispatching | Attempt recorded before send; receipt not yet settled | One provider dispatch; stage bounded native observations |
| Accepted | Native acknowledgment or correlated native fact proves this attempt was accepted | Admit exactly once in a transaction; bind native identity and drain staged observations |
| Rejected | Proven not sent or explicit native rejection | No canonical turn; failed intent can be retried explicitly |
| Unknown | Dispatch may have occurred but evidence is incomplete | Reconcile; no automatic new dispatch |

The implementation may retain current persisted enum names if these semantics
are explicit and tested. Send requires accepted-turn evidence; compaction
requires its correlated native control, not merely a locally emitted started
marker. Fork/edit distinguish destination creation, inherited-history read,
new-turn acceptance, and head activation. Spawn distinguishes child allocation,
session creation, and task acceptance. Existence of a destination session proves
only session creation. All callers use the shared delivery component; native
terminal outcome remains a separate lifecycle after command acceptance.

Edit and fork admission. `createTurn` for a branch destination moves after
provider acceptance. Before acceptance, persist preparation topology (including
execution/session bindings), the branch operation, receipt, and attempt; no
canonical destination turn exists. On acceptance one
transaction inserts the turn, appends the path entry, binds the native turn,
activates the head with the compare-and-swap revision, and advances the
projection revision. On rejection the strand becomes `failed` and no turn row
exists. If a turn is accepted but head activation loses its CAS, retain the
accepted destination and report recovery state; never turn this into a safe
resend. Codex fork requests use verified native capability/version evidence.
Before implementing a `lastTurnId` fallback, test its edit-before semantics,
including the first turn. Fail explicitly on unsupported runtimes rather than
guessing a parameter. Record the actual installed/reference protocol used by
tests; do not assume the audit's version remains current.

Stop. Add `interrupt_requested_at` to `turns` for root turns and to
`executions` for child executions. `interruptTurn` and `interruptExecution`
record it in the command transaction, advance the projection revision, then
call the adapter. The runtime resource projects `stopping` from those columns.
A reconciliation task per stopping target owns its timers, cancellation, and
restart recovery; default checks are at 15 and 45 seconds after intent, with
injectable timings for deterministic tests. After those probes, unresolved
targets wait for native evidence, session recovery, or explicit recheck rather
than an unbounded polling loop. Reconstruct pending deadlines on restart.
Deadlines trigger probes, not invented terminal outcomes. `readHistoryRevision`
is only a change probe; the watchdog reads terminal evidence through `snapshot`
or the read-only history path. A terminal native
turn closes the Remux turn as interrupted or completed from provider evidence;
a proven-dead owning Claude process may close its lost invocation as failed;
a still-running or unknown turn retains lane ownership. After the second check
the runtime exposes recovery actions supported by the provider. Force-close
may release the lane only after verified termination of that work or an
established fencing mechanism that prevents overlapping execution. Closing a
shared-daemon socket or expiring a local timer proves neither. If no safe
force-close exists, show unresolved recovery and recheck; preserve queued work
without dispatching it. Adapter interruption rejection is recorded explicitly;
it cannot look like successful cancellation or strand an uncancellable timer.

Claude adapter. Resume emits `recovering`; an SDK `init` establishes session
readiness, not absence of an accepted turn's result. Reconcile using correlated
terminal evidence or proof that the old process-owned invocation is gone.
Test handshake failure, result timing around init, and missing terminal evidence;
never resend the old prompt to discover its outcome. `status` messages with `compact_result:
'failed'` emit `context.compaction.failed` carrying `compact_error` and clear
`manualCompactionOperationId`. Session open reads `init.apiKeySource` and
validates the source against the existing OAuth-only product policy, together
with the native login/provider check. Installed SDK 0.3.258 documents `none`
for OAuth, bearer tokens, and third-party providers; it is not sufficient proof
of subscription authentication by itself. `ANTHROPIC_API_KEY`, `apiKeyHelper`,
and `/login managed key` are API-key sources; legacy union members are not
currently emitted. Revalidate these meanings against `sdk.d.ts` at slice entry.
An incompatible source fails open with a `provider_auth` error naming the
source, without exposing keys. Do not reject ordinary OAuth because its source
is `none`, or accept another provider merely because it also reports `none`.
A10 is reassessed against I1's current measurement:
declare its actual provider-request source, observation freshness, and available
read/push behavior. Do not downgrade it based on the pre-fix aggregate estimate
or claim a dedicated current-context read that the adapter does not implement.

Tests: `native-agent-coordinator.test.ts` gains concurrent same-command
compaction returns one result to both callers even after dispatch begins;
same ID with different request conflicts; restart with `received` or
`dispatching` settles only by attempt-specific evidence; session creation
without task acceptance stays unresolved; edit rejected before
acceptance leaves no turn row; stop with provider silence projects `stopping`,
then terminal from native evidence; reload preserves stopping; disconnect or
discard cannot release an unresolved writer; rejected interrupt and termination
cleanup release timers correctly. `codex-adapter.test.ts` covers supported fork
semantics and unsupported versions. `claude-adapter.test.ts` covers recovery
evidence around init, compact failure, and authentication source enforcement.

## Pass C — subject identity, ownership, and reconciliation

Intent: canonical identity survives live delivery, resume, `thread/read`, and
fork; native children belong to the turn that started them; snapshots delete
only what they cover.

Subject keys. Add `provider_subjects` and `provider_subject_aliases` tables per
the state-authority schema direction: unique on
`(provider_instance_id, subject_kind, subject_key)`. Alias lookup includes the
provider instance, durable native turn/lineage scope, native item ID, and source
session/generation where the provider's IDs require it. A naked `item-N` is
never globally unique. Fork aliases are admitted only with proven inherited
lineage; generation replacement cannot join unrelated turns. Adapters emit
candidate identity as
`{ kind, nativeTurnId, nativeItemId, semanticKind, occurrenceHint }`. The
journal resolves a candidate in this order: an existing subject or alias for
the native item ID; else, when the item ID is positional, the subject with the
same native turn, semantic kind, and occurrence ordinal among blocks of that
kind in native order where complete occurrence coverage proves the match;
else allocate a new subject only with evidence of a distinct native item.
Partial same-kind history can shift occurrence numbering: an ambiguous candidate
remains unresolved without deleting or merging existing blocks. A resolved match
records the new native ID as an alias and revises the existing block. Existing
`turn_blocks` IDs and references remain stable. Backfill the registry with those
IDs; remap references only for proven duplicates, recording the mapping and
reason. Allocate IDs once for newly admitted subjects. Fork inheritance links
existing subjects using proven native lineage, not the destination session ID.
The `native-agent-journal.test.ts` case at the resumed-snapshot rewrite that
currently asserts a changed block ID is inverted to assert a stable one.

Claude ordinals. Content-block ordinals are counted per `message.id` across
frames, not per frame, so text, tool, text completes as ordinals 0, 1, 2.
Every SDK message type that carries `parent_tool_use_id`, including finalized
assistant frames, is routed to the child execution when the field is set; a
finalized assistant frame with a parent never becomes a root block.

Child ownership. `executions.root_turn_id` is the owner of a native child.
The coordinator supplies durable child bindings to adapters through the session
contract; adapters retain a child-identity registry for later events rather
than accessing SQLite or using the current root turn. The Claude adapter keeps a
`task_id` to execution map beyond `activeTurn` and processes
`task_notification`, which carries `task_id` and `tool_use_id`, after
`result`. The journal's child upsert never rewrites `root_turn_id` on conflict.
Registry retention covers late terminal events and recovery; define cleanup at
proven child completion/session disposal so the fix does not create a new
unbounded cache. Root ownership and a nested caller's active turn are distinct
bindings and both survive follow-ups.

Coverage-safe reconciliation. Extend `ProviderSnapshotCoverageV2` with
`turns.nativeTurnIds`, the explicit set of native turns the snapshot covers,
and carry it through a versioned provider contract; the current
`turnBlocks.completeKinds` becomes `blocks.completeKinds`. Reconciliation
stages the snapshot, resolves subjects, and commits once through the extracted
reconciliation planner. Validate source generation, branch, and freshness before
applying a plan; stale snapshots cannot overwrite newer live state. Absence
deletes only
blocks whose kind is in `completeKinds` and whose native turn is in
`nativeTurnIds`; passes with no covered kinds are retained. An empty complete
domain is expressible because a covered turn with no blocks of a complete kind
deletes stale blocks of that kind. Codex declares what `thread/read` returns;
Claude declares `session-local` with an empty turn set and never deletes.

Output sealing. Projection and sealing use the same reconciled canonical block
and authoritative revision. A snapshot does not win merely because it arrived
later; honor its coverage and freshness relative to newer live observations.
Test phase correction and multiple distinct final blocks against the provider's
output semantics. The `assistantContent` artifact enforces the 20 MiB cap
with a truncation marker. `projectTurn` keeps only the bounded preview in
passes and references the artifact for the full text, so a valid large final
never breaks the transcript resource. Apply the resource budget to the entire
serialized response, including multiple passes, and expose any artifact
truncation truthfully rather than presenting truncated text as the full answer.

Repair. The v11 ambiguous-compaction rows are excluded from canonical control
paths with a durable audit reason. The
scoped rebuild of affected tables restores foreign-key parity and records
the repair in `meta`. The primary review chooses whether a quarantine table is
needed or an existing durable exclusion/reason mechanism already satisfies J5.

Tests: `native-agent-journal.test.ts` gains live UUID to `item-N` rewrite keeps
one block with the existing ID; commentary then final for the same native item
share one block while separate items stay distinct; ambiguous same-kind
occurrence matching never merges; two native turns with the same `item-N`
remain distinct; snapshot with partial coverage retains uncovered pass; covered
turn with no blocks removes stale blocks; sealing after snapshot rewrite
matches the visible final; near-limit final projects a preview plus artifact;
v6 and each subsequently supported schema migrate to the same constraints as
fresh while preserving canonical IDs; proven duplicate repair updates every
reference; ambiguous compaction stays excluded. `codex-event-mapper.test.ts`
and `claude-adapter.test.ts` gain late child completion after the next turn
started; Claude per-message ordinals; subagent finalized frame routes to child.

## Pass D — fitted bounds

Intent: valid provider payloads never vanish because of size.

Add bounded display/payload helpers using the shared constants. Fit only
declared display fields; never truncate identities, commands, ownership fields,
or structural data to make an envelope validate. Keep policy outside a generic
recursive envelope truncator. Commands passed to and executed by the native
harness remain unchanged. Existing `inputPreview` and `outputPreview` are
bounded display copies under their existing preview contract; a command larger
than that preview limit cannot be promised intact in the preview. Preserve it
there when it fits and signal preview truncation when it does not.
The Codex mapper fits `tool.title` from the command
line, summaries, and errors. The Claude adapter fits reasoning revisions by
emitting bounded cumulative text with a `truncated` boolean added to the
`reasoning-summary` payload under the next required contract version, fits error
messages, and guarantees `turn.completed` validates by fitting before emit.
Fit both Unicode character bounds and encoded JSON byte budgets: a reasoning
payload within `messageChars` can still exceed `eventBytes`, especially with
multibyte text or duplicated summary parts. Preserve valid surrogate pairs and
make truncation explicit. Current contract version 5 and supported legacy
records need a defined normalization path for the new flag; do not silently
make existing persisted blocks invalid. Review that compatibility boundary
before the shared-contract writer changes it. Coordinator validation is
unchanged. The existing tests that accept dropped events are inverted to assert
the fitted event arrives and later deltas/completion remain valid.

Shared-contract review accepted for this slice: v6 requires the reasoning
flag, supported v2–v5 events normalize its absence to false, and journal reads
normalize that legacy reasoning field at the persisted-block boundary. Preserve
historical raw JSON, identities, revisions and original content hashes; new v6
hashes cover the fitted v6 payload. This is not a blanket revalidation of other
historical payload kinds. Candidate byte-budget calculations must not allocate
ordinals or mutate mapper state on each search iteration. Commit the fitted
block and streaming accumulator only after the final envelope validates.

## Pass E — projection fence and client synchronization

Intent: every UI-visible mutation advances one conversation revision, pushes
are typed, and one client controller converges.

Server. Add `projection_revision` per conversation. Every authoritative
transaction that changes queue, runtime, stop intent, branch, metadata, child
executions, or transcript increments it and returns a `ProjectionFence` plus
the typed `AgentResourceChange[]` from the state-authority spec. The server
translates changes to exact resource keys; the broad conversation invalidation
is deleted. Command results and resource reads carry the fence. The state change
and revision increment commit atomically; emit invalidation only after commit.
No-op replay does not fabricate a new change. An accepted command's receipt fence
proves admission, not eventual provider completion. First prepare the server
contract and controller behind the current active path; then switch bridge,
hooks, and stores together and remove the competing refresh owners. Do not
activate two controllers or require a single giant commit to prepare the work.

Client. Add `conversationSyncController` above `resourceStore`. It is the only
consumer of invalidation pushes and command fences and the only caller of
transcript, runtime, queue, and history reads. It implements the cadence rules
in the state-authority spec: order change supersedes turn refresh, terminal is
immediate, streaming uses the paint cadence, queue-only and metadata-only never
read transcript, a newer revision during a read schedules one trailing read,
generation change performs one recovery read. `useAgentResources`,
`historyStore`, and the bridge-driven transcript refresh route through it.
A protocol-version mismatch enters `restart-required` and probes one control
resource; it never returns an empty envelope. Cancellation and late responses
are fenced by both server generation and selected conversation/branch. Publish
related edit resources as one coherent render snapshot after the destination
fence is satisfied. Ordinary streaming may refresh only the dirty turn; it
must not wait for unrelated resources or rebuild the whole transcript per delta.

Viewer fixes that ride the controller:

- Stable command/client message identity is established in S2. Preserve the
  submitted payload and pending identity across lost responses and viewer reload;
  editing the draft creates a new intent, not a mutation of an in-flight request.
- Draft access level persists with the draft text (S1).
- The effort row renders only when the selected model advertises efforts, and
  Off only when the model lists it; unknown provider-native effort values pass
  through unchanged (S1).
- A head-CAS rejection rereads the conversation head, rebinds the editor to the
  current strand and revision, and keeps the text.
- Resume requests a window by current intent: tail when following, otherwise
  anchored to the retained row.
- Edit swaps resource, disclosure, and viewport state atomically at the
  accepted destination fence. The `preserveReady` mechanism in
  `useConversationActions.ts`, `transcript/resourceStore.ts`, and
  `conversation/historyStore.ts` is removed where it orchestrates edit swaps;
  ordinary stale-while-refreshing presentation may remain. The controller holds the old
  snapshot until the destination read satisfies the fence. Exhausted hydration
  leaves the old snapshot visible with an actionable error.
- `executionScopesByKey` and `operationDetailsByKey` become bounded LRUs, and
  their in-flight reads abort on conversation switch and background.
- Incremental turn refreshes preserve the authoritative `activeTurnId` instead
  of inferring it from frame status.
- Compact eligibility considers a queued compact and session resumability (S1).

Tests: `native-agent-coordinator.test.ts` gains every mutation kind advances
the revision and returns typed changes. A new
`tests/unit/conversation-sync-controller.test.ts` covers the cadence rules with
a fake bridge. `viewer.spec.ts` and `viewer-lifecycle.spec.ts` gain lost
response then retry produces one turn; draft access survives reload; no-effort
model hides the row; CAS conflict rebinds; non-tail resume keeps position; edit
keeps the anchored message until swap; mismatch enters restart-required.

## Pass F — federation isolation and lifecycle

Intent: the credential, not the model, defines every scope; the scheduler keys
on real checkouts; children are owned by the turn that spawned them.

- Attachments. Add `artifact_grants` keyed by artifact ID and conversation ID
  or execution ID, written whenever an artifact is attached to a message or
  produced by an execution. `resolveLocalImage` gains a caller scope argument
  and accepts an artifact only when a grant exists for the caller's
  conversation or for an execution in the caller's lineage.
- Checkout keys. Resolve the canonical worktree root, including symlink and
  subdirectory aliases, and store `checkout_key` on execution rows. Separate
  Git worktrees remain separate keys; define a canonical workspace-root fallback
  for non-Git directories. Capacity check and durable reservation must be atomic,
  not two racing reads followed by writes. Re-key existing active reservations
  through a reviewed migration/reconciliation step; do not silently release
  conflicting unknown writers. Test more than the symlink case.
- Nested spawns. The credential carries the caller execution ID; the spawn
  resolves the caller's own active turn while retaining the immutable owning
  root turn. A completed root does not by itself invalidate a still-running
  caller; existing authorization, depth, and scheduling limits still apply.
- Acceptance recording. The child execution row and its native-session binding
  are written as preparation before `startTurn`; use a durable `preparing`
  state or equivalent explicit milestone in all resource/auth/scheduler readers.
  Preparation reserves ownership but does not prove the child has a running
  accepted turn. A thrown transport error after send marks the
  spawn `unknown`. Session creation is a preparation milestone, never proof of
  task acceptance. The shared delivery component from Pass B admits the child
  turn only on correlated task acceptance. A retry with the same command ID
  returns the same child and delivery state; it cannot resend unresolved work.
  Child allocation may be visible as preparing, but not as an accepted turn.
- Frozen catalog. The spawn rejects any target outside the credential's
  catalog even if it is now ready.
- `changedFiles` is capped at 500 distinct paths with a numeric
  `changedFilesTruncated` count of omitted paths.
- Passive hydration. Add a read-only `readHistory` capability to the adapter
  contract that never acquires ownership or resumes. Codex implements it with
  `thread/read`, which serves an unloaded thread from the thread store; Claude
  implements it from its session-local transcript. History hydration, child
  rediscovery, and the Pass A and Pass B reconciliation steps use it.
  `ensureSession` is called only by commands.
- Transport loss keeps ownership fenced until reconciliation proves safe
  transfer or termination. Lease expiry alone must not permit a second writer
  while the original provider work can continue. Check the actual provider
  lifetime and enforceable lease behavior before resolving plausible R3.
- UI. `AgentExecutionsView` and `ExecutionScope` show a `native` or
  `federated` label with provider and model.

Tests: `federation-mcp.test.ts` gains cross-conversation artifact rejected and
granted artifact accepted; `/repo`, its subdirectories, and a symlink alias
share one writer slot; distinct worktrees remain independent; concurrent
reservations admit at most one writer;
grandchild lands under the caller's turn with the original root binding;
lost spawn response then retry returns one child with honest delivery state;
session creation without accepted work cannot resolve unknown; catalog
enforcement; restart between child allocation/session creation and dispatch
retains preparation without inventing an accepted turn;
`changedFiles` truncation; unauthorized Host/Origin rejected at
the federation transport boundary; passive hydration acquires no lease;
Claude-to-Codex direction. `viewer.spec.ts`
asserts the ownership label.

## Pass G — host runtime

Intent: the Rust host does not exhaust or leak on Agent's per-conversation
traffic.

- `ws.rs`. Conversation lanes are evicted when idle and empty for 60 seconds,
  with generation-safe removal so one conversation is never split across an
  old and a new lane worker; `MAX_ROUTE_LANES` applies to live lanes only.
  Lane policy for Agent methods is derived from the trusted registered method
  contract, cross-checked against the validated request envelope. Caller-provided
  conversation IDs or `remuxContract.kind` must not bypass mutation ordering or
  manufacture arbitrary permanent lanes. A new query is not silently serialized.
- `viewer_bundles.rs`. `start_watching` registers a view's source root when
  its first build publishes, not only at startup. Publication and cleanup share
  the per-view lock so a just-renamed revision cannot be deleted.
- `supervisor.rs`. Manual view builds hold a join handle owned by the actor;
  `Stop`, `Restart`, and automatic restart cancel and reap it.
- `extension_gateways.rs`. Strip every header nominated by `Connection` and
  the standard hop-by-hop set on non-101 responses.
- Settings. Runtime-management jobs stay busy until the job's completion
  notification, and failure details render. "Check runtimes" triggers a real
  provider re-probe instead of rereading cached status. Codex status reports
  the configured executable and the daemon's executable as two fields.
- App host lifecycle. `ExtensionWebView` defers consuming lifecycle evidence
  until the page reports ready so `inactiveForMs` survives a load or reload.
  `lifecycleEvidence.ts` keeps separate clocks for native suspension and tab
  inactivity so a tab return produces probe-strength evidence only.

Tests: `crates/remux/tests/ws.rs` lane eviction and cap; `extension_gateway.rs`
nominated hop-by-hop headers, unauthorized WS upgrade, upstream disconnect
mid-stream, chunked and aborted upload; a chaos case for stop during a build;
publication/cleanup race reproduction before fixing plausible H4. App tests
cover readiness-delayed lifecycle evidence and distinct inactivity clocks;
runtime settings tests distinguish admission from eventual job completion.

## Pass H — documentation sync

Intent: the spec set is an honest as-built record again.

- Copy each spec's `Status:` line verbatim into `docs/specs/README.md`.
- Maintain one as-built version table in the native-runtime spec using the
  actual versions at each integrated slice. Label older boundaries as migration
  history; this document does not preassign final version numbers.
- Amend the native-runtime lazy-history paragraph to the ownership-free read
  path from Pass F.
- Rewrite the lineage spec status and the README history paragraph to say
  historical preview and Make Current are server-side only and the viewer
  ships a flat list by decision.
- List all six MCP tools in the README.
- Mark live-acceptance claims as manually reported unless a result manifest is
  committed.
- Annotate archived specs that cite deleted files with one line naming the
  deleting commit.
- Normalize the header block order on the touched specs.
- Downgrade the transcript-controller spec status to "implementation
  substantially extracted; verification partial; physical-device acceptance
  pending" and list the uncovered verification-matrix rows.
- Correct the composer control-plane spec for the Spark exclusion decision.
- Fix `docs/architecture/codex-extension.md` to describe the release-binary
  launch and label its RPC list as partial; move the native-runtime spec's
  "Pre-cutover" section to past tense.
- Wire `app/scripts/test-viewer-host-contract.mjs` and
  `test-viewer-lifecycle.mjs` into the app test script.

## Schema and contract review

Expected logical additions are scoped to their stage: artifact grants and
checkout identity (S1); delivery attempts, structured unresolved receipts,
retryable queue failures, and the minimal projection-revision foundation for
admission transactions (S2); durable interruption intent (S3); complete fence
propagation and typed changes (S4); subject aliases and scoped historical
repair/constraint parity (S5). Existing tables may satisfy these needs; table
names in this document are not a mandate to duplicate storage.

Before a migration is delegated, record its source/target versions, tables,
data assumptions, backup behavior, and validation in the slice record. The
next slice upgrades from the previously accepted schema, not only the audit
baseline. Test fresh creation, real supported historical schemas, each
intermediate upgrade, foreign-key/integrity checks, and safe reopen after an
interrupted transaction. Repair plans produce candidate counts and reasons
against a copied production database before applying any repair to live data.
Existing canonical IDs are preserved except for reviewed duplicate merges.
Retain an audit mapping for those merges and prove referenced resources resolve.

## Risks

Identity aliases and coverage planning change history semantics. Avoid broad
key rewrites, and test replay across restart/fork plus stale and partial
snapshots before accepting the slice. Projection fences require an integrated
activation across server and viewer; preparatory changes are allowed, but only
one active synchronization owner remains after cutover. Lane eviction touches
hot dispatch and must prove it cannot split one conversation across workers.
The shared working tree already contains unrelated changes: each handoff names
its files, and primary review checks that those changes are preserved.

## Out of scope

Unrelated module extraction, the full shared host ownership redesign in the
runtime-management spec, a version tree or Make Current UI, and
converting the transcript viewport to the full atomic-plan state machine
described in the transcript-controller spec. First test whether the focused
resume/edit fixes close the reproduced failures. Reopen T5/T6 if the anchored
resume/edit or expanded-work tests still demonstrate a jump attributable to
split viewport ownership; do not add a second chain of compensating timers.

J7 remains deferred while navigation depends on full `turnOrder`. During S0,
record representative transcript-window bytes and latency at the current largest
conversation, with machine/load and turn count. Revisit if a valid window reaches
half the resource byte ceiling, if a reproducible local window read exceeds
250 ms excluding provider hydration, or before changing navigation to support
larger histories. These are review triggers, not performance claims or new
telemetry requirements. T8 shims and H11 fixture-binary packaging stay deferred
until their owner is otherwise being changed or a concrete failure warrants it.
Cosmetic/archived documentation fixes are S7 housekeeping, not a gate for the
earlier runtime fixes. Physical-device checks remain pending until performed;
browser tests do not count as physical-device acceptance.

## Acceptance

Each slice is accepted after primary diff/contract review, its relevant failure
scenarios pass, affected type/build checks pass, and the register and slice
record are updated. Required scenarios can share tests; test count is not the
acceptance metric. Review extraction by identifying which old owner/path was
removed, not by the number of new files.

At closeout, run the Agent server/unit/browser suites and builds, applicable
app contract/lifecycle suites, and `cargo test -p remux` for the integrated host
changes on the supported runtimes recorded in S0. Use the workload skill for
sustained test/build commands. Record failures honestly and address regressions
before calling the affected stage verified. Do not repeat unrelated expensive
suites after every small edit.

Release verification records whether the built code is actually loaded. A
manual run on the reference host must show: proven not-sent or explicit native
rejection unblocks the next queued message; lost-response retry/recheck resolves
from attempt-specific evidence without redispatch, or remains honestly unknown;
Stop survives
reload and settles from evidence; restart/resume does not duplicate blocks;
late children stay under their original owner; Claude child text and usage do
not become root text/context; long command titles remain visible; anchored
resume/edit retains position; the affected Claude history can sync successfully.
Record native auto-compaction threshold verification separately from tested
configuration. Never report a live or device scenario as passed solely because
its fixture passed. The implementation may be verified locally with explicit
live checks pending; the whole program is complete only when its in-scope
acceptance evidence is recorded or the user agrees to a changed disposition.
