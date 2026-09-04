Status: Archived
Last verified: 2026-08-08
Canonical code: The stable comparison UI remains in `extensions/codex/viewer/`; the Agent transcript/history/context foundation and applicable interaction-parity port are implemented and automated/live-validated, with native owner review and the durable-process phase still outstanding
Superseded by: `agent-native-provider-runtime-v1.md`, which keeps the proven UI
and virtualizer contract while replacing the provider/runtime boundary.

# Agent UI parity and phased delivery alignment

This document aligns how the new Remux Agent is delivered and how it reuses
the existing Codex viewer. It supplements
[`agent-runtime-and-epoch-context.md`](agent-runtime-and-epoch-context.md) and
[`agent-durable-epoch-core.md`](agent-durable-epoch-core.md).

The parent architecture remains normative for product/provider boundaries. The
durable-core spec remains normative for journal, artifact, context, operation,
and process semantics. This document is normative for delivery checkpoints,
UI reuse, parity, owner review, and cutover. Where an older section describes
UI parity as one late bulk phase, this document supersedes that timing.

Phase 0A live acceptance and the Phase 1A.0 desktop/physical-phone comparison
were owner-completed on 2026-08-07. The bounded Agent transcript/composer
foundation and its automated gates are checkpointed at
`8e96512f06ea354bd54f84f5e783161b786e1696`. Later implementation scopes still
require their own explicit alignment.

## Resolved decisions

1. **UI parity is continuous.** The proven Codex UI is introduced before
   durable storage and then activated capability-by-capability as Agent server
   semantics arrive. It is not reconstructed after the backend is complete.
2. **The Phase 0 viewer is a fixture, not the final UI foundation.** Its auth,
   model, streaming, interrupt, and reconnect behavior proved the integration
   spine. We do not grow its flat transcript into a second UI implementation.
3. **Copy and port; do not destabilize the baseline.** The current Codex viewer
   remains intact as the comparison target. Relevant source and tests are
   copied into Agent and converted to Agent-owned protocols. The duplication is
   temporary and disappears when the old extension is retired.
4. **Preserve behavior before renaming internals.** Layout algorithms,
   component boundaries, test fixtures, and CSS selectors stay as unchanged as
   practical during the port. Internal `codex-*` CSS class names may remain
   temporarily; they are styling implementation details, not App Server
   compatibility.
5. **No App Server compatibility layer.** The Agent viewer consumes
   Agent-owned resources and commands. The server projects Pi/journal state
   directly into provider-neutral turn frames. The browser never parses Pi or
   App Server events.
6. **No dormant excluded controls.** Narration, manual compaction, review,
   speed/service tier, approval/elicitation, collaboration/subagents, and
   first-class web/research UI are removed rather than hidden behind feature
   flags.
7. **Included future controls arrive with semantics.** Mentions, attachments,
   steering/follow-up queueing, edit, fork, and process controls are
   ported/activated only in the checkpoint that provides their durable server
   contract. There are no clickable placeholders.
8. **Every checkpoint is owner-reviewed.** The next checkpoint does not begin
   until its automated gates and live desktop/phone review are complete and
   the owner approves proceeding.

The initial clean Codex viewer source baseline for this alignment is commit
`47703785ea70d43e24ac575baa6693017cc948c0`. A later port records its actual
source commit and any selected post-baseline fixes.

## What parity means

Parity means preserving the mature behavior appropriate to the new Agent. It
does not mean reproducing all Codex/App Server product features.

### Required parity

| Area | Required behavior |
| --- | --- |
| Transcript ownership | Server-authoritative immutable turn frames; no viewer-invented terminal state or duplicate optimistic messages |
| Windows | Tail, earlier, later, around-turn, and route-focused reads with revision fencing |
| Streaming | Bounded/coalesced refresh, stable layout during deltas, and one terminal turn state |
| Virtualization | Measured turn virtualization, long-history window sliding, expandable-row reconciliation |
| Scrolling | Sent-message anchoring, bottom following, manual-scroll ownership, next/previous turn navigation, iOS momentum safety |
| Rendering | Markdown, headings, lists, tables, blockquotes, links, file references, code highlighting, copy, and diffs |
| Work | Running/completed/failed/interrupted states, grouped operations, progressive details, full-output retrieval |
| Conversation UI | New, list, open, title/preview, active status, route identity, reconnect, restart recovery |
| Composer | Lexical editor, focus/keyboard lift, multiline input, send, interrupt, status/error rows, model/reasoning |
| Lifecycle | Connected/background/inactive behavior, resume sync, preserve-ready refresh, stale request fencing |
| Responsive UI | Existing desktop/mobile structure, sidebar/overview behavior, safe areas, light/dark design tokens |
| Included advanced actions | Mentions, attachments, steer/follow-up queue, edit, and fork once their Agent contracts exist |

### Explicit non-parity

The Agent does not carry these controls, protocol variants, dependencies, or
background behavior:

- narration playback, preparation, paint layers, block/text-leaf registration,
  audio controls, or `@remux/narration-client`;
- manual Compact actions or compaction transcript segments;
- review mode;
- speed/service-tier selection;
- quota/reset/credit surfaces beyond ordinary provider errors;
- App Server approvals or elicitation;
- existing Codex history import;
- collaboration/subagent controls or transcript rows;
- first-class web/research controls or specialized rows; and
- generated Codex/App Server protocol types.

Generic Markdown links, shell/network output, and generic tool rows are not
first-class web/research integration and remain supported.

## Port strategy

### Why copy instead of importing the current App

`@remux/codex` currently exports the whole Codex `App`, `CodexTranscript`, and
host store. Those components still import Codex resource stores, RPC methods,
generated types, manual compaction, and narration. Direct reuse would make the
new product a compatibility shell around the old server contract.

Extracting a universal viewer package before the port would change the stable
baseline and the new viewer simultaneously. That creates two moving targets
during the most important comparison period. A bounded copy/port preserves the
old product and lets the Agent types become cleanly authoritative.

After cutover, only the Agent implementation remains. Common extraction may be
considered later if another real consumer exists; it is not a prerequisite.

### Port mechanics

For each selected subsystem:

1. Record its Codex source paths and source commit.
2. Copy source and the relevant tests into `extensions/agent`.
3. Preserve layout/rendering behavior and CSS selectors initially.
4. Replace Codex imports with Agent-owned protocol/store/IPC imports.
5. Remove excluded behavior rather than no-op stubbing it.
6. Add a focused Agent fixture that exercises the copied behavior.
7. Run the original applicable tests plus Agent protocol and Playwright tests.
8. Review the visual/behavioral comparison before proceeding.

Mechanical renaming is not mixed with behavioral porting. Product-facing text
uses “Agent” and “conversation/chat”; temporary internal filenames or CSS
selectors may retain historical names until after cutover.

### Destination ownership

The port stays under `extensions/agent/viewer/` and
`extensions/agent/shared/`. Agent IPC adapters stay under
`extensions/agent/viewer/ipc/`. The durable server owns the matching resource
and command projections.

The viewer is never given journal rows, Pi messages, provider payloads, or raw
artifacts as its primary model. It receives bounded render resources.

## Reuse matrix

### Port in checkpoint 1A.0

| Codex subsystem | Agent treatment |
| --- | --- |
| `transcript/layout/*`, measure cache, reconciliation | Copy with only Agent type/import changes |
| `transcript/virtualizerRange.ts`, `virtualizerScroll.ts` | Copy behavior and tests unchanged where narration-independent |
| `transcript/virtualizer.tsx` | Port; remove narration-focus mode and narration element lookup while preserving scroll ownership |
| `transcript/resourceStore.ts` | Port to Agent resource names and Agent turn-frame protocol |
| streaming refresh scheduler/policy | Copy and retain bounded cadence/lifecycle behavior |
| Markdown layout and renderer | Port parser/layout/code/table/file-link behavior; remove narration protocol and registration |
| assistant/user message components | Port rendering and copy actions; omit narrate/fork until their checkpoints |
| work section and diff renderer | Port generic activity/file/tool rendering and lazy disclosure |
| Lexical editor/model | Port text editing, focus, keyboard, document model, and test corpus |
| composer action shell/status rows | Port send/interrupt/scroll/history layout; remove narration/config exclusions |
| App viewport/keyboard geometry | Port mobile lift, overlays, safe-area and outside-tap behavior |
| host store, route attachment, resume infrastructure | Port to Agent resource identities and lifecycle reads |
| existing styles | Copy selectively; remove narration styles/dependencies, retain proven layout selectors |

Checkpoint 1A.0 does not port history, steer/follow-up queue, edit/fork,
mentions, attachments, or process controls merely as placeholders. Their
source is brought over when the corresponding Agent contract is implemented.

### Adapt rather than copy literally

| Codex subsystem | Required adaptation |
| --- | --- |
| Transcript types | Define `AgentTranscriptSyncResource`, `AgentTurnRenderFrame`, and Agent segments; no `compaction` variant |
| Resource invalidations | Use Agent reason/type vocabulary and durable `basisSequence`/revision fencing |
| Runtime store | Derive active turn, interruption, epoch pressure, and later processes from Agent resources |
| Composer config | Expose only model and reasoning; no speed/review/manual compact |
| Send projection | Produce Agent message input with stable client operation ID and later artifact/mention refs |
| Work categories | Project fixed Agent tools into generic read/search/command/file/tool/process rows |
| History/sidebar | Read durable Agent conversations rather than Codex rollout threads |
| Operation queue | Implement Agent queue semantics; do not forward Codex queue RPCs |
| Edit/fork | Use Agent strands and journal positions; do not call App Server thread APIs |

### Narration removal seams

Narration is not isolated to one folder, so removal is an explicit port task:

- remove narration client/paint installation from the App;
- remove narration bar and playback actions from the composer;
- remove narrate actions and audio state from assistant messages;
- remove narration block/text-leaf hooks and paint layers from Markdown;
- remove narration-client protocol types from the Markdown layout model;
- remove narration-follow viewport state and lookup from the virtualizer; and
- remove narration CSS and package dependency.

Stable Markdown block IDs may remain for layout caching, debugging, and future
turn focus. They are Agent rendering identity, not narration identity.

Narration removal passes when ordinary Markdown height, streaming layout, copy,
links, tables, code, expandable work, and scroll behavior remain unchanged.

## Agent viewer protocol shape

The Agent protocol follows the proven server-authoritative shape without
retaining Codex generated types.

### Turn frames

```ts
type AgentTurnRenderFrame = {
  id: string;
  status: 'queued' | 'inProgress' | 'completed' | 'failed' | 'interrupted';
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: AgentTurnError | null;
  renderRevision: string;
  layoutRevision: string;
  segments: AgentTurnSegment[];
};

type AgentTurnSegment =
  | AgentUserMessageSegment
  | AgentWorkSegment
  | AgentAssistantMessageSegment;
```

There is no compaction segment. Epoch boundaries are context/runtime metadata,
not fake conversation messages. The default transcript stays natural; the
context inspector may show epoch boundaries on demand.

### Transcript sync

The sync resource preserves the useful version-2 semantics:

```ts
type AgentTranscriptSyncResource = {
  conversationId: string;
  activeTurnId: string | null;
  basisSequence: number;
  turnOrder: string[];
  turns: AgentTurnRenderResult[];
  removedTurnIds: string[];
  window: {
    startIndex: number;
    endIndexExclusive: number;
    hasEarlier: boolean;
    hasLater: boolean;
    turnIds: string[];
  };
};
```

Requests support `tail`, `around`, and `range`, known per-turn render
revisions, and a known conversation revision. Work groups and entry details
remain separate bounded resources so opening a disclosure does not reload or
inflate the whole transcript.

### Projection boundary

The server maps journal/Pi state into UI semantics:

```text
Pi assistant/tool events
  -> durable events and operations (Phase 1A+)
  -> materialized turn/work state
  -> Agent turn render frames and bounded detail resources
  -> viewer resource stores
```

During checkpoint 1A.0, the same projector runs over Phase 0 in-memory events.
That lets the UI port land before the durable schema while exercising the
actual future projection boundary.

The viewer never infers a tool succeeded because streaming stopped, invents an
assistant row, or reconstructs work groups from raw event order. The server
publishes terminal state and stable identity.

## Delivery checkpoints

### Phase 1A.0 — UI port foundation

**Backend constraint:** retain the accepted Phase 0 runtime: one ephemeral Pi
conversation, unchanged prompt, `workspace.read` only.

Implement:

- Agent-owned turn-frame/work projection over the existing runtime events;
- copied transcript resource/layout/viewport stores;
- virtualized transcript and stable streaming refresh;
- Markdown/code/table/file-link rendering;
- generic work section for `workspace.read`;
- copied Lexical composer shell, model/reasoning, send, interrupt, connection,
  mobile keyboard/focus geometry;
- Agent auth state integrated with the mature shell;
- narration and excluded-control removal; and
- applicable copied unit/Playwright tests.

Do not add SQLite, journal, artifacts, epoch compilation, new tools, history,
steer/follow-up queue, edit/fork, mentions, attachments, or processes.

Exit gates:

- the same live Phase 0 read/stream/interrupt/reconnect flow works;
- desktop and phone match the existing Codex viewer for transcript/composer
  behavior within the available feature set;
- long fixture output virtualizes without scroll jumps;
- manual scrolling during streaming does not get stolen;
- assistant Markdown, code, tables, and tool disclosure render correctly;
- no narration or excluded UI code/dependency remains in Agent; and
- existing Codex remains unchanged and passes its relevant baseline tests.

Owner review: side-by-side desktop/phone use, visual feel, scrolling, keyboard,
streaming, and the proposed Agent-specific auth placement.

### Phase 1A.1 — durable conversations and history

Implement the journal/artifact foundation and durable conversation replay from
the durable-core spec, then activate:

- conversation list/history and summaries;
- new/open/reopen;
- route-addressed conversation identity;
- sidebar and mobile history controls;
- deterministic titles/previews without a model call;
- restart recovery and preserve-ready resume; and
- full-replay Pi reconstruction under the pre-rollover budget guard.

The 1A.0 turn-frame protocol remains the viewer boundary; storage replaces its
in-memory source rather than changing the renderer.

Exit gates include deterministic journal replay, restart continuation, no
duplicate user/assistant rows, stable selection across route/reconnect, and
desktop/phone history parity.

Owner review: new/list/open behavior, titles, routes, restart, draft retention,
and whether conversation switching feels equivalent to current Codex.

### Phase 1A.2 — authoritative transcript windows and work details

The audited implementation scope and exit gates are fixed in
[`agent-phase-1a2-transcript-hardening-scope.md`](agent-phase-1a2-transcript-hardening-scope.md).

Implement the complete durable transcript projection:

- tail/around/range windows;
- earlier/later loading and focus-to-turn;
- per-turn render/layout revisions;
- bounded work groups and entry detail resources;
- streaming invalidation cadence and lifecycle deferral;
- very long transcript fixtures; and
- journal-derived active/terminal runtime state.

Exit gates port the applicable Codex transcript/layout/streaming tests and add
Agent journal/restart cases. A 100+ turn fixture, a large tool result, and an
extension restart must preserve the viewport and authoritative terminal state.

Owner review: long history, expanded work, manual scroll, streaming follow,
background/resume, and route-focused turns.

### Phase 1A.3 — shadow compiler and context inspector

Implementation state: code and automated/live validation completed on
2026-08-08. The existing composer now exposes a quiet, expandable,
inference-scoped inspector separating the active full replay and sanitized
provider dispatch from the exact next-epoch bootstrap; active provider input
remains exact full replay. Owner snapshot review is still required before
Phase 1B.

Implement deterministic shadow epoch candidates without changing provider
input. Add an inspector—not a transcript compaction row—showing:

- current basis sequence and epoch candidate;
- estimated input/pressure;
- ordered blocks and source revisions;
- exact inclusions, omissions, and retrieval paths; and
- provider request mode/context hashes available from the pinned Pi seam.

Exit gates are byte-identical manifest rebuild, no prompt effect, bounded
inspector resources, and useful explanations on real Remux/Ledger transcripts.

Owner review: inspect several actual brainstorm → spec → implementation traces
and approve the proposed snapshot contents before active rollover.

### Phase 1B — active epochs, read-only workspace

Activate preflight/rollover before every inference. Add context status,
manifest, pull, and pin while retaining read-only workspace access.

Use tiny test budgets to force multiple rollovers inside one turn. The first
request of every epoch must be a verified full provider request. There is no
manual compact control.

Owner review: continuity across free exploration and spec-driven work, omitted
facts/retrieval, inspector accuracy, latency, and whether the model retains the
real task rather than merely sounding coherent.

### Phase 1C.1 — search, reads, and artifacts

Add bounded workspace search and artifact-backed observations. Activate
grouped read/search work rows and paginated detail retrieval.

Owner review: scanability, disclosure behavior, large-output recovery, and
whether the model can cheaply retrieve what rollover omitted.

### Phase 1C.2 — atomic patching and diffs

Add create/update/delete patch operations with expected hashes, idempotent
operation state, recovery inspection, and existing diff rendering.

Owner review: edit granularity, diff readability, conflicts, failed/unknown
operations, and multi-file workflow ergonomics.

### Phase 1C.3 — finite shell

Add finite Bash execution, output artifacts, structured terminal state, and
interrupt/restart recovery. Activate command work rows, durations, failure
excerpts, and full output disclosure.

Owner review: real build/test workflows, large output, interruption, failure
visibility, and output retrieval.

### Phase 1C.4 — interaction parity

Implementation state: completed and automated/live-validated on 2026-08-09.
The Agent now owns structured file mentions and image attachments, a durable
follow-up queue with run-now/remove behavior, and immutable edit/fork branches.
The source conversation remains unchanged, queued work resumes after an Agent
restart, and the viewer exercises these Agent RPCs on desktop and mobile. A
native owner feel review remains part of the acceptance gate.

Implement and activate the remaining included interaction surfaces only after
their durable semantics exist:

- file mentions with exact workspace refs;
- image attachments stored as artifacts;
- steering the active turn plus follow-up queue and run-now/remove behavior;
- edit from a user message;
- fork from user or assistant positions using strands;
- server-authoritative composer preference/state; and
- host navigation/focus to a turn.

Queue/edit/fork operations use Agent operation IDs and journal positions; they
do not forward Codex RPCs or mutate transcript state optimistically.

Owner review: ordinary multi-turn use, queue semantics, correcting a prompt,
branching exploration, attachment/mention display, and recovery after
reconnect/restart.

### Phase 1D — durable processes and evaluation release

Implement the persistent process host and process tools from the durable-core
spec. Activate process inventory, controls, bounded log detail, and restart
reconciliation in the mature work/runtime UI.

Run the paired Agent versus Codex evaluation only after the required parity
matrix below passes.

Owner review: real Remux/Ledger servers, restart/reconnect, input/output,
interrupt/terminate, identity uncertainty, and long-running implementation
work.

### Cutover checkpoint

Cutover is not a late UI implementation phase. It is a release gate:

1. Close material parity findings from Phases 1A.0–1D.
2. Run the deterministic and paired evaluation suites.
3. Switch the normal launcher/default from the old Codex extension to Agent.
4. Remove App Server lifecycle from the shipping path.
5. Archive/delete the old comparison extension and temporary duplicated UI.

No cutover occurs merely because all backend features exist.

## Owner collaboration contract

Every checkpoint begins with a short scope note containing:

- exact capability and files in scope;
- protocol/storage migrations, if any;
- copied Codex source/test paths;
- behaviors intentionally unchanged;
- behaviors intentionally absent; and
- live scenarios that will demonstrate completion.

Every checkpoint ends with:

1. focused automated test results;
2. a deterministic fixture/demo path;
3. a concise implementation and deviation report;
4. a live desktop/phone build when UI changed;
5. unresolved findings and measurements;
6. an explicit owner acceptance decision; and
7. only after acceptance, the proposed scope for the next checkpoint.

The agent may fix defects inside the accepted checkpoint without reopening
scope. A new feature, protocol expansion, migration policy, or product
behavior outside that scope pauses for owner alignment.

## Parity acceptance matrix

The matrix is cumulative. A later checkpoint reruns affected earlier rows.

| Scenario | Required result |
| --- | --- |
| New chat | Correct cwd/model/reasoning shown before first send; no incorrect default flash |
| First send | One user message, one active turn, stable sent-message anchor |
| Streaming answer | Stable Markdown growth, bounded refresh, follow-bottom until user takes control |
| Manual scroll while streaming | Native/manual ownership retained; no snap to bottom |
| Interrupt | Immediate stopping state, one interrupted terminal frame, composer reusable |
| Tool sequence | Grouped running → terminal rows; opening detail does not move unrelated content |
| Large output | Bounded frame, artifact/detail retrieval, no oversized resource or prompt injection |
| Markdown corpus | Paragraphs, headings, lists, tables, links, file refs, code, copy match baseline |
| File changes | Correct path/status/diff and expansion height |
| Long transcript | Windowing/virtualization with earlier/later navigation and bounded memory |
| Route focus | Open conversation and focus requested turn without losing window context |
| Desktop reconnect | Preserve rendered state while authoritative resources refresh |
| Phone background/resume | No blank transcript, stale terminal state, keyboard jump, or lost selection |
| Extension restart | Durable state reconstructs with new generation and no duplicate effects/messages |
| Steer/queue | Stable ordering, steering and run-now/remove semantics, correct interrupt interaction |
| Edit/fork | New durable strand/history result; source conversation remains immutable |
| Mention/attachment | Exact display/provenance and restart-safe artifact availability |
| Epoch rollover | No transcript ceremony; inspector shows boundary and sources accurately |
| Persistent process | Stable logical identity, logs/control after Agent/Remux restart |
| Exclusion audit | No narration, Compact, review, speed, approval, collaboration, or research UI/dependency |

Required environments are desktop Chromium/WebView dimensions and the phone
WebView path used for Remux. High-risk scrolling, keyboard, reconnect, and
background/resume cases require physical-phone validation before cutover;
desktop Playwright alone is insufficient.

## Test preservation

Applicable Codex tests are copied with the source and initially changed only
for Agent imports/fixtures. In particular, preserve coverage for:

- transcript layout measurement and reconciliation;
- virtualizer range and scroll decisions;
- streaming refresh scheduler/policy;
- Markdown layout/rendering and user-message Markdown;
- composer document/send projection and mention parsing;
- work durations and disclosures;
- route attachment and resource invalidation; and
- desktop/mobile Playwright interactions.

Narration tests are not copied. App Server protocol tests remain with Codex.
Agent adds server projection, durable replay, generation/restart, context,
operation, and process tests at the matching checkpoints.

Tests are evidence, not the sole parity definition. The owner live review is a
required gate because mobile keyboard, native momentum scrolling, perceived
streaming stability, and interaction feel are not fully represented by DOM
assertions.

## Risks and guardrails

### Temporary fork drift

During the port, relevant fixes landing in Codex are recorded and deliberately
selected into Agent. No blind directory synchronization is used. Cutover
removes the duplicate.

### Accidental compatibility inheritance

Copying UI code can drag generated protocols and excluded features with it.
Dependency, import, protocol, and rendered-control audits run at 1A.0 and
cutover. A no-op hidden feature is still a failure.

### Narration removal destabilizes layout

Narration registration is embedded in Markdown, assistant actions, composer,
App lifecycle, and viewport logic. It is removed surgically with layout and
scroll regression tests. The Markdown measurement model is preserved.

### Backend/UI co-design becomes a big bang

Each checkpoint has one server contract and one UI activation. Later controls
are absent until supported. Storage, transcript projection, shadow context,
active rollover, effects, interaction parity, and processes remain separate
acceptance units.

### Parity blocks context experiments

The UI port precedes the journal, but active context work does not wait for
every future interaction feature. Core rendering/lifecycle parity is required
at 1A.0; steer/queue/edit/fork/attachments activate in 1C.4. This preserves
both a stable product surface and fast context experimentation.

## Current gate

The applicable interaction-parity port is the current review gate. The
provider-neutral Codex styling contract, desktop/mobile viewer suite,
production build, deployed viewer geometry/error check, restart behavior, and
real-subscription replay smoke are green. Narration, manual compaction, review,
speed/service tier, quota UI, App Server approvals, Codex history import,
collaboration/subagent UI, and first-class web/research UI remain intentional
exclusions. Durable processes and the paired evaluation release remain the
next architectural checkpoint after owner acceptance.
