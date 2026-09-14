Status: Active Spec — implemented in working tree; automated and isolated Claude integration checks passed; deployment and physical-device acceptance pending
Last verified: 2026-09-14
Canonical code: `extensions/agent/server/src/provider-adapter.ts`,
`extensions/agent/server/src/providers/{claude,codex}/`,
`extensions/agent/server/src/native-runtime/`,
`extensions/agent/shared/{provider-runtime,native-agent-protocol}.ts`, and
`extensions/agent/viewer/src/{composer,transcript}/`

# Conversational input while agents work

## Outcome and scope

Users can send another message while the parent works or waits for a subagent,
compact the parent context, and continue talking while background children run.
Codex app-server and Claude Code retain their native tool loops, context,
compaction, and same-provider agents. Remux owns input intent, delivery evidence,
ordering, and presentation.

The shared product behavior does not require identical native turns. Several
user messages can belong to one native turn; a child can span several parent
turns and compaction. Neither fact should make the chat feel blocked.

Before this pass, normal Send requested `delivery: 'queue'`. Codex
had an explicit native steer implementation; Claude rejected overlapping
`startTurn` calls and did not expose active input through `ProviderSession`.

This pass amends the delivery selection in
[composer control plane](agent-composer-control-plane-v2.md) and the input
representation in [canonical turn journal](agent-canonical-turn-journal-v2.md).
It retains [state authority](agent-state-authority-and-synchronization-v1.md)
and [S2a delivery](agent-command-delivery-s2a.md): queued intent is not native
history, uncertain delivery is not rejection, and recovery must not replay
possibly delivered work. The new normal-Send admission contract below is an
explicit addition; existing explicit-steer RPC receipt semantics remain intact.

## Implementation checkpoint — 2026-09-14

The working implementation adds schema 18 on top of the concurrent schema 17
rejection-recovery change. Pending messages retain the existing durable queue
and command receipt. `delivery_intent` selects automatic versus explicit queued
delivery; `turn_inputs` stores additional accepted messages and their display
anchors. `DeliveryAttemptOwner` remains the delivery authority.

The initial adaptive composer layout was reverted at user request. History,
subagents, and turn navigation retain their original bottom-toolbar locations
while typing. The top conversation navigation and dedicated Queue button were
removed. Automatic Send routing and truthful compaction status remain in place.
The approved replacement is a delivery menu on the existing Send button, described below.

Codex advertises `activeInput: 'native-steer'`. Claude advertises
`activeInput: 'stream-input'` for the verified Code 2.1.258 producer, using the
pinned SDK 0.3.258. Absence of this optional capability keeps normal Send queued
while a parent is active. Existing clients continue sending explicit queue
intent; the new fields extend protocol 11 without requiring old clients to
understand them.

Live Claude acceptance passed through the actual adapter and coordinator in an
isolated, in-memory journal: foreground child held on a host gate, additional
input accepted in the same native turn, parent compacted, another parent message
completed, and the same child completed after host release. The maintained
opt-in probe is `extensions/agent/tests/live/conversation-input-acceptance.mjs`.
An earlier implementation backgrounded before writing input; live testing caught
that Claude could finish the original turn first. The fixed adapter writes input
first and backgrounds only after the SDK pulls again following its awaited
transport write. Exact replay UUID evidence, not this write ordering, proves
acceptance.

Verification: the initial 333 server tests passed, including migration, provider, coordinator,
and transcript projection tests. Desktop/mobile composer and transcript parity
checks passed, including 320/375/390 px layouts and child-navigation access.
Production sessions were not restarted and production schema migration was not
executed.

The following limits are explicit:

- Compact can now background an identified foreground Claude Agent on a verified
  producer. Codex and ineligible Claude waits retain queued compaction; the parent
  is never explicitly interrupted by this action.
- A native input consumed after its expected parent has ended remains delivery
  unconfirmed; it is not attached to the wrong turn or automatically resent.
- Delayed Claude acknowledgements can reconcile in the same process. Durable
  positive evidence can be admitted after restart. A process lost before exact
  acknowledgement remains held when native history cannot prove the binding.
- Cross-provider foreground waits and arbitrary foreground tools do not receive
  Claude's native Agent background control. Physical-phone acceptance and a safe
  server deployment remain release work.

## Active-parent compaction follow-up — 2026-09-14

`compaction.activeParent: 'background-native-agent'` is optional and enabled only
for the verified Claude Code 2.1.258 producer. Codex does not advertise it.
`ProviderSession.activeCompactionTarget()` supplies a process-local native turn ID
and exact foreground Agent tool-use IDs. Missing identity, a recovering parent,
other outstanding foreground tools, or unresolved input makes the session
ineligible. This is runtime eligibility, separate from the provider capability.

The coordinator retains the same durable FIFO and Compact action. Eligible
head-of-queue compaction can dispatch while the parent is active. The existing
manual-compact attempt freezes the target, input UUID, and operation ID before
crossing. `/compact` is written before targeted background control; control
failure leaves possibly delivered work held, with no automatic resend. A child
that finishes before control is not controlled under a different parent.

Generic compacting statuses during the active parent are ambiguous with native
auto-compaction and do not acknowledge manual delivery. A fresh status after the
parent ends, or an explicit manual boundary, supplies the existing native proof.
Automatic boundaries retain their trigger and cannot complete the dispatched
manual operation. The optional runtime `pendingPhase` projects queued, requested,
and compacting from durable operation/acceptance records; no database migration
is needed for this follow-up. The queue tray and Compact controls use those phases.

The maintained live probe with `REMUX_COMPACT_ACTIVE=1` passed through the actual
adapter/coordinator: Compact during a gated foreground Agent call, parent native
compaction, another parent message while the same child remained running, then
child completion after host release. Verification also passed 342 full-suite server
checks, 84 targeted provider/coordinator checks after the final boundary changes,
38 final desktop/mobile compaction and composer checks (including 320 px status
layouts), and TypeScript checking. Production sessions were not touched.

## Verified native foundation

Isolated live probes used Claude Code 2.1.258 / Agent SDK 0.3.258 and Codex
CLI/app-server 0.153.4. Claude used Fable with a Haiku child; Codex used GPT-6
Astra for both. Children held a host-controlled gate until explicitly released,
so survival was established from actual outstanding work and terminal events.
Claude persistence was disabled; Codex threads were ephemeral. No production
session was interrupted or restarted.

| Operation | Claude native behavior observed | Codex native behavior observed |
| --- | --- | --- |
| Input during a parent wait | Ordinary streaming input remained pending during a foreground Agent call. Targeted `backgroundTasks(toolUseId)` freed the parent and preserved the child. | `turn/steer` reached a parent in native collaboration wait and returned the same turn ID. |
| Native turn identity | The parent answered the additional message, but its result retained the original prompt UUID. | Steer stayed in the existing turn. |
| Compact with background child | Manual compact boundary completed before child release. | Native compaction completed before child release. |
| Talk again after compact | A new parent prompt completed while the same child remained pending. | A new parent turn completed while the same child remained pending. |
| Compact during active parent wait | `/compact` waited behind the foreground call; backgrounding freed it to run. | Direct `thread/compact/start` interrupted the parent and started a distinct compaction turn; the child survived. |
| Force immediate input | `priority: 'now'` stopped the foreground child despite `perTaskStopAffordance: true`. | Normal active input uses steer; no forced interrupt is required for the tested wait. |

These probes establish native feasibility, not restart-safe per-message
acceptance or every tool type's behavior. In particular, the Claude result for
the original prompt does not acknowledge each subsequently streamed input.
Arbitrary foreground Bash/MCP work and cross-provider waits are not covered by
the native-child survival claims.

## User interaction

Normal **Send** means “deliver this to the ongoing conversation at the next
supported native opportunity.” It does not mean stop the parent or its children.
The composer stays usable while the parent works, waits, or compacts.

| State at dispatch | Normal Send | Compact |
| --- | --- | --- |
| Parent idle, including children still running | Start a native parent turn. | Dispatch native compact when older queued work has cleared. |
| Parent active and active input verified | Deliver active input using the provider mapping below. | Queue at the next parent boundary; do not interrupt the parent. |
| Claude foreground native Agent blocks parent | Write ordinary streaming input, then background the identified Agent call at the ordered SDK boundary. Child keeps running. | Write `/compact`, then background the identified Agent at the SDK transport boundary. Let native compaction proceed; preserve the child. |
| Active input unsupported or unverified | Queue and show the reason. | Keep the same boundary policy. |
| Compact running, recovery hold, or older queued operation | Preserve FIFO/barrier order; show queued or held status. | Existing pending compact is reused; do not dispatch another. |

The Send menu exposes **Queue for next turn** while the parent is active
(the withdrawn dedicated Queue button is no longer rendered). It retains the existing
explicit queue behavior and captured model/effort/service-tier configuration.
Changing those settings while the parent is active also queues the message with
“Queued with new settings”; active input must not silently ignore the change or
alter the running turn. Keep the existing explicit steer API strict about its
expected turn and configuration.

Sending an eligible active-input message or requesting eligible Claude Compact
authorizes the targeted native backgrounding necessary to let the parent continue. Show “Agent continues in
background” on the affected child activity. Do not call untargeted
`backgroundTasks()` or background arbitrary Bash/MCP calls. Do not background
anything merely because the parent has been waiting a long time. If native
ownership or foreground classification is unknown, do not background that call.
Ordinary input remains subject to the native safe boundary and exact receipt.
If the foreground call completes before the control executes, re-evaluate state
and continue without treating it as an error.

Use concise delivery states: **Queued**, **Sending**, **Delivered**, and
**Delivery unconfirmed**. “Delivered” means correlated native acceptance, not
that the model has answered or followed the instruction. The RPC acknowledging
durable local storage must not produce a Delivered badge. Messages remain
visible through reload, including unresolved delivery, with one stable identity.

Compact shows “Compaction queued · after this response” for an active parent
without an eligible native path, “Compaction requested · waiting to start” after dispatch, and “Compacting context…” after native acknowledgement. It does not send a hidden instruction asking the model to finish,
manufacture a turn boundary, or stop a child. A model may continue working after
backgrounding; Compact can therefore remain queued. Immediate interrupting
compaction and interrupt-and-send are outside this pass.

### Send delivery menu — implemented

The original toolbar is retained. History, Agents, preferences, attachment, and
turn navigation remain in their existing positions while typing. No top
conversation navigation or separate Queue button is added. The interim More-menu
proposal is superseded by the user-approved Send-menu design.

The existing Send button opens a menu when the parent is active or delivery has
pending work, compaction, or a hold. Its small chevron indicates that it opens
options; opening the menu does not submit the draft. Idle parents, including
those with still-running background children, retain ordinary one-click Send.

| State | Menu choices |
| --- | --- |
| Active parent, supported native input, same model/effort/speed/access, clear queue | Send to current turn; Queue for next turn |
| Active parent, unsupported native input | Queue for next turn, with the provider limitation explained |
| Draft settings differ from the active parent | Queue for next turn, using selected settings |
| Compaction or earlier queued work | Queue after pending work, with the ordering reason |
| Delivery unconfirmed or runtime/queue state unavailable | Explain the hold/check; no dispatchable choice |
| Parent idle, no barrier, children possibly still running | Ordinary Send; no menu required |

Current-turn delivery submits automatic intent; the coordinator rechecks ordering
and captured configuration, and uses its verified native route. It does not
promise immediate processing. Queue submits explicit queue intent and cannot
silently become steering. If the parent has finished, queued intent can naturally
start the next turn. Neither choice means waiting for every child to complete.

The menu preserves its original option identities while open. Current-turn
eligibility loss disables that option; Queue does not replace it under the
pointer. Option heights stay stable as explanations update. If the parent ends
between pressing and releasing Send, the press still opens options rather than
sending unexpectedly. A queue-only menu gains no new action until reopened.

Keyboard activation, arrow navigation, Escape, outside dismissal, and History
access preserve the draft. Hold explanations remain accessible. Edit/fork actions
keep their existing explicit behavior. Pending submissions prevent duplicate
sends. The existing queue tray continues to display accepted pending messages
and compaction progress. Build the viewer after validation before reporting the
UI implementation complete.

Validation for this replacement: six delivery-policy tests, 156 desktop/mobile
regression checks, TypeScript checking, and 30 acceptance checks against the
rebuilt production viewer assets passed. The viewer was rebuilt with
`npm run build:viewer`; no server session was restarted.

## Provider interface and routing

Extend capabilities with an optional active-input mode (`native-steer` or
`stream-input`); absence means unsupported. Keep
native capability separate from whether the evidence/recovery implementation is
enabled for that installed version. Do not set Claude's existing `steer` flag
true merely because its SDK accepts an input stream.

Add `ProviderSession.sendActiveInput(...)` with frozen conversation, execution,
session/process generation, command/message IDs, content, and expected native
turn. Codex may delegate to its existing `steer` implementation. Claude performs targeted backgrounding within `sendActiveInput`, using the exact
native Agent tool-use ID and expected parent ownership. A boolean SDK control
response alone does not prove delivery or child survival; native replay and
task observations supply those facts.

The coordinator owns one serial admission/dispatch lane per conversation,
including automatic provider-origin parent follow-ups. Reuse the existing
command winner, queue, and `DeliveryAttemptOwner`; add no second in-flight map
or parallel scheduler. Do not hold a database transaction or the entire
conversation's event-processing lock while awaiting provider acceptance.

At dispatch, in order:

1. Reconcile the bound session and any unresolved crossing. Existing recovery
   holds and earlier queued operations take precedence.
2. Honor explicit queue intent and captured configuration changes.
3. If parent idle, select root start. Otherwise select enabled active input;
   unsupported delivery remains queued.
4. Freeze the selected input attempt and current display anchor before crossing
   the provider boundary.
5. For Claude, write ordinary input before backgrounding any specifically
   observed blocking native Agent calls. The SDK next-pull boundary orders these
   operations without claiming native acceptance.
6. Apply correlated observations to the attempt, message, native binding, and
   projection transactionally. Dispatch later input only once this attempt's
   delivery is resolved; the parent need not finish its response.

### Codex

Use `turn/steer` with the frozen `expectedTurnId` and `clientUserMessageId`.
The correlated response binds the input to the same native turn. Do not create
another native turn or expect another `turn/started` event for that input.
Wait tools remain owned by the native harness; no special Remux wait loop is
introduced.

If the parent ends in the dispatch race, route to a new root turn only before
crossing or after authoritative evidence that the steer was not applied. A
lost response or generic error is insufficient. Preserve the logical message
and record the resolved route transition; never mutate the identity of an
already-crossed attempt. Do not silently steer a newer autonomous parent turn
using an old turn's attempt.

### Claude

Keep the persistent SDK input stream open and keep
`perTaskStopAffordance: true`. Use ordinary streaming user input with a stable
UUID; do not use `priority: 'now'`. Track all outstanding inputs independently
of the one active native root turn. Replace the single `rootAcceptance` slot
for this path with per-input correlation, without resetting active-turn usage,
assistant blocks, or the original prompt identity for every new message.

**Verified live evidence:** `extraArgs: { 'replay-user-messages': null }`
produces `SDKUserMessageReplay` with the exact additional input UUID, including
when the input is folded into the original turn. The adapter requires root
scope, a non-synthetic replay, the expected active parent, matching session and
process generation, and an observation after input yield. Verify delayed observations,
process loss, and durable-history recovery separately. Stream enqueue/yield,
an assistant echo of the text, and a result tagged with the original UUID are
not proof. Do not assume an internal SDK control event is publicly emitted.

For unverified Claude producers, leave active input disabled and retain queued
delivery. Do not issue targeted background controls on that fallback path. Codex
can be enabled independently.

If input crosses as the old parent ends, bind it to the native turn that actually
consumes it using evidence. Do not mark it delivered to the old turn by
assumption, or resend it as a new prompt. Unresolved binding is an explicit
transcript gap, not permission to create a duplicate user turn.

## Durable input and transcript model

Distinguish four identities: conversation, logical user message, native parent
turn, and child execution. Keep existing turn IDs and child ownership. The
current single `turns.user_content_json` value cannot represent several root
messages within a turn; do not overwrite it to simulate active input.

Reuse `queued_messages` for pending input identity, requested delivery mode,
captured configuration, immutable content/artifact references, and admission
order. Freeze native identity and input on `delivery_attempts`. On acceptance,
`turn_inputs` records the client message ID, command, resolved parent turn,
content, and display anchor; the parent turn supplies conversation/strand/execution. Record delivery through the
existing attempt owner. Derive visible delivery state from queue/attempt facts,
rather than maintaining an independent status machine in the viewer.

For normal Send, commit the input intent and an accepted local command receipt
atomically. The receipt retains the accepted queued-admission result and reserved turn ID;
provider delivery progresses asynchronously. The request client message ID and
command ID remain the stable input identities: an auto input folded into an
existing turn does not materialize its reserved new-turn ID. This allows durable active
input without pretending the existing explicit-steer receipt means the same
thing. Preserve old-client queue behavior and gate new delivery through the optional
capability; receipt semantics do not change for an explicitly steered command.

Preserve S2a's frozen attempts. Active input uses the existing `steer` attempt
kind, with provider-specific acceptance evidence. Claude adds
`claude-input-replay`; its targeted background control shares the conservative
input crossing instead of adding a second in-flight operation. Input is written
first, then the SDK's next pull permits the background control. Uncertain input
or control outcome holds the lane; neither is automatically replayed. A
background-control success is not accepted message delivery. Local admission
receipts remain accepted while delivery is unresolved or fails.

Pending input is an operational projection adjacent to the transcript, not
admitted native history. On native acceptance, admit a separate user-message
entry with its resolved binding. Reconcile the pending and accepted views by
the same message ID so delivery does not duplicate a bubble. Historical root
messages use a deterministic identity derived from their existing turn/client
IDs; migration must not duplicate them or change branch lineage.

The server supplies stable presentation ordering and anchors for input and
assistant segments. A user message is a hard boundary for adjacent tool-activity
grouping. A native turn can have display segments before and after the message;
these segments do not create new native turns or reset usage. Do not copy all
assistant output into a new turn merely to obtain another chat bubble. Output
already streaming retains its block identity. Arrival order in the UI does not
claim the provider consumed the input before an earlier-running tool completed.

Extend existing bounded transcript resources and projection revisions. Reload,
snapshot reconciliation, virtualized windows, and multiple viewers must produce
the same identities/order. Keep existing disclosure IDs and grouped descriptive
tool labels. Edit/fork at an additional input requires a native-supported branch
cursor; when unavailable, disable that exact branch action with a reason rather
than invent a cursor from the display position.

## Ordering, recovery, and child lifetime

Compact is a barrier in the existing durable operation order. Later Send does
not overtake it, even if active input would otherwise be supported. Earlier
queued input does not become active input just because the parent is waiting.
An unresolved possibly-sent input holds later dispatch until reconciled. Reuse
current queued-compact deduplication and automatic-compaction satisfaction rules.

If input is written and targeted backgrounding subsequently fails, preserve
the child and retain unresolved delivery until exact input evidence arrives. Do not undo
backgrounding by stopping/restarting it. If the control response is lost,
reconcile exact task/tool ownership and foreground/background observations;
neither a timeout nor absence from a partial snapshot authorizes replay.

Root idle, root completion, and compaction are not child completion. Preserve
the existing background-work eviction guard and original parent-child bindings
across input, compaction, and subsequent parent turns. Child completion continues
through the provider's native notification path. Autonomous root follow-ups
must be admitted with native identity and serialized against pending dispatch;
notifications during compact must not synthesize a concurrent root turn.

Same-provider work uses native collaboration. Cross-provider children retain
existing federation identity, auth binding, completion, and rediscovery. Do not
apply Claude's native Agent background control to a federated MCP wait. Normal
Send can queue behind an unsupported foreground wait with a visible reason;
full prompt responsiveness during federation waits needs its own adapter-level
test before being advertised.

## Implementation sequence and exit criteria

| Slice | Changes | Exit evidence |
| --- | --- | --- |
| 1. Provider contract and evidence | Add explicit active-input capabilities and targeted backgrounding within Claude input dispatch. Probe Claude exact-input receipts/history. Reuse Codex steer correlation. | Versioned fixtures plus isolated gate tests; Claude live-input capability remains off if evidence fails. |
| 2. Durable input identity | Journal/schema migration, linked attempts, normal-Send admission receipt, ordered message projection, compatible optional protocol fields. | Existing history is unchanged; pending/accepted/rejected/unresolved input survives restart and reload without duplicates. |
| 3. Coordinator dispatch | Route idle/active/queued input, target Claude Agent backgrounding, enforce settings and compact barriers, handle native follow-up races. | Deterministic crossing/failure/race tests, including the fallback when active input is unavailable. |
| 4. Composer and transcript | Enable normal conversational Send for verified capabilities; secondary queue action, truthful status, interleaved user-message segments. | Desktop/mobile browser coverage for streaming, grouping, scrolling, reload, draft preservation, and two viewers. |
| 5. Native acceptance and rollout | Repeat controlled tests through the actual Remux adapter/coordinator, then enable each provider independently. | Child survives input, compact, and new parent turn; evidence and UI agree; no unresolved acceptance shortcut. |

Use `provider-adapter.ts` and `shared/provider-runtime.ts` for primitives;
`delivery-contract.ts`, `delivery-attempt-owner.ts`, `schema.ts`, and
`native-journal.ts` for durability; `native-coordinator.ts` for dispatch;
`native-projector.ts` and `shared/native-agent-protocol.ts` for projection;
composer `actions/turnAction.ts`, queue controls, and transcript resources for
presentation. Build on concurrent delivery/compaction work already in the tree;
do not overwrite it. Schema 18 is the input migration; the optional capability
and frame fields extend protocol 11 compatibly.

Required tests cover:

- Two inputs in one native turn, distinct bubbles and content, unchanged original
  turn identity, per-input correlation, and no extra usage charge/reset.
- Active-turn completion before write, authoritative rejection after request,
  lost reply after acceptance, SDK yield without receipt, process generation
  change, duplicate command submission, and snapshot replay.
- Child completion during background control, after input but before Compact,
  during Compact, and during a later parent turn; autonomous parent follow-up
  racing queued input must create neither duplicate nor overlapping root turns.
- Model/effort changes, explicit queue, multiple rapid sends, compact barrier,
  cancellation before crossing, and inability to retract possibly delivered input.
- Foreground Claude native child versus already-background child versus unknown
  Bash/MCP/federated wait; no untargeted background or priority-now call.
- Migration of existing root messages, branch/history views, stable disclosure
  and message IDs, virtualized transcript windows, reconnect and multiple viewers.

Live acceptance uses new disposable sessions with actual gated child work and
records provider version, correlation IDs, boundary events, and terminal child
state. Do not use model self-reports as proof. Preserve production sessions:
implementation/build can proceed independently, but deployment must wait for a
safe service boundary or a verified drain/handoff mechanism. This spec requires
no restart, production-data migration execution, or modification of a live turn.

## Evidence and references

The 2026-09-14 local probe report is
`/tmp/remux-native-harness-support-2026-09-14.md`; assertions are in
`/tmp/remux-native-harness-evidence-checks.json`. These are temporary diagnostic
artifacts, not durable repository test dependencies. The native observation
table above preserves the conclusions; slice 1 must turn the relevant cases
into maintained fixtures/probes without committing credentials or raw sessions.

Installed Claude declarations are in
`extensions/agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
(`SDKUserMessage`, `Query.backgroundTasks`, `Options.perTaskStopAffordance`).
Primary interface references are the
[Claude streaming-input documentation](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
and [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
The foreground-child stop and active-parent compact-interruption findings come
from the version-specific live probes, not a guarantee about future releases.
