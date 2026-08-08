Status: Active Spec
Last verified: 2026-08-08
Canonical code: Phase 1A.2a through Phase 1A.2d implementation, automated closeout, clean-state live validation, and owner desktop/physical-phone acceptance are complete in `extensions/agent/`

# Agent Phase 1A.2 durable transcript hardening scope

## Decision state

This is the hardening checkpoint after Phase 1A.1 owner acceptance and commit.
It hardens the storage-to-transcript path already in use. It does not begin the
shadow context compiler, active epochs, effectful coding tools, or a broader UI
parity pass.

The owner authorized and incrementally aligned Phase 1A.2a through Phase 1A.2d
on 2026-08-08, then explicitly accepted the completed checkpoint after the
clean-state real-provider/restart run and desktop/physical-phone review. The
slices are not separate product phases. Phase 1A.3 is the next planning
boundary.

## Current implementation state

Phase 1A.2a through Phase 1A.2d are closed in the working tree:

- the server/viewer protocol hard-cuts conversation create, caller-owned send
  operation identity, transcript protocol 2, projection v2, and the durable
  context-probe name;
- generic and transcript command parsers enforce the v2 identity/request
  boundaries, and exact operation/client-message retry conflicts are distinct;
- schema v2 adds the reviewed turn-local transcript index through an exact,
  fail-closed v1 migration that preserves existing conversations;
- conversation lists explicitly report truncation;
- live and replayed transcript identity comes from durable item IDs, while
  render revisions and invalidations carry committed journal sequence fences;
  and
- a deterministic live-to-cold test proves byte-identical completed frames at
  one basis and verifies user, assistant, and tool row IDs against SQLite.
- cold transcript reads resolve tail/around/range windows in SQLite, cap one
  resource batch at 40 selected turns, and query only those turns' transcript
  items and presentation events;
- completed assistant/reasoning projections contain compact versioned
  descriptors and exact immutable aggregate artifacts, while running
  checkpoints update byte counts and a bounded summary instead of accumulated
  text;
- conversation summary projection updates incrementally without replaying all
  prior visible messages per checkpoint;
- ordinary visible user, assistant, reasoning, and disclosed tool text is
  bounded to 48 KiB per body and carries an exact byte-length/hash/continuation
  descriptor when truncated;
- the viewer keeps oversized and projection-error turns visible, and exact
  content is fetched in bounded UTF-8 ranges only after explicit disclosure;
  and
- the cold projection cache is byte-weighted and disposable rather than an
  eight-conversation correctness dependency.
- work-group continuation cursors are opaque and bind projection version,
  group revision, and offset; stale cursors fail explicitly, first-page
  revision checks cannot be combined with cursors, and defensive viewer merges
  replace changed revisions while deduplicating durable row IDs;
- transcript batches, lazy work reads, and invalidation envelopes are fenced by
  server generation, with old in-flight responses discarded and generation
  transitions clearing resource revisions atomically while preserving the
  already-rendered window;
- open work and child-detail disclosures survive generation replacement and
  lazily refill their cleared resource caches;
- direct turn navigation loads an `around` window before measuring and
  scrolling, with explicit Retry/Dismiss behavior when the turn cannot be
  found; and
- transcript, projection, work-group, and work-detail failures expose bounded
  retries instead of silently disappearing;
- terminal journal events preserve the typed error category, committed
  duration, exact durable terminal status, and restart-versus-user interruption
  distinction through live and cold projection;
- startup runs SQLite `quick_check` plus artifact path/type/length validation,
  while immutable content hashes are verified on first use per server
  generation and an explicit full scrub reports referenced bytes and orphans;
- logout and conversation mutation share one serialized command lane,
  interrupt is idempotent, and the fault suite covers duplicate/conflicting
  sends, send/logout, interrupt/terminal, close/hydration, SQLite busy,
  artifact staging/corruption, crash boundaries, and notification recovery;
  and
- the opt-in hardening corpus contains 252 turns, 1,000 work rows, 73,400,333
  artifact bytes, selected/unselected oversized content, restart interruption,
  and an active checkpoint tail.

Provider input remains exact full replay. Transcript reads still perform the
Phase 1A.1 whole-conversation reconstruction only for provider hydration, not
for cold UI projection. Phase 1A.2d changes durability, recovery, and
measurement only; it does not alter prompt content or provider dispatch.

The 1A.2b closeout gate passed on 2026-08-08: repository typechecking, 80 Agent
server tests, 25 Agent unit tests, 56 Agent viewer tests with two expected
project skips, the Agent production build, and all 354 unchanged Codex tests.
The focused corpus proves compact running/terminal assistant projections,
selected-window isolation from a missing unselected artifact, bounded UTF-8
range reads, cold oversized assistant retrieval, and zero eager artifact reads
in the viewer. An opt-in real-subscription snapshot replay also exited cleanly
with `REMUX_REPLAY_OK` on `gpt-5.3-codex-spark` at high reasoning: 47,802
estimated input tokens, one completed full inference, and 2,032 ms elapsed.
This early live signal verifies the current path; it does not claim the full
Phase 1A.2d scale and fault gates.

The 1A.2c closeout gate passed on 2026-08-08: repository typechecking, 81 Agent
server tests, 25 Agent unit tests, 66 Agent viewer tests with two expected
project skips, the Agent production build, and all 354 unchanged Codex tests.
Focused desktop/mobile cases cover a delayed old-generation transcript, a
generation reset with open work and lazy detail, an old unloaded focus target,
an unfocusable target with Retry/Dismiss, and stale 205-row pagination without
mixed revisions or duplicate rows. The real-subscription snapshot replay also
exited cleanly with `REMUX_REPLAY_OK` on `gpt-5.3-codex-spark` at high
reasoning: 47,802 estimated input tokens, one completed full inference, and
2,760 ms elapsed. This verified the unchanged full-replay provider path after
the lifecycle changes; Phase 1A.2d subsequently closed the automated gates,
and owner acceptance subsequently closed the checkpoint.

The Phase 1A.2d automated closeout passed on 2026-08-08. The long-history
corpus measured p95 cold tail at 0.76 ms, cold around at 0.75 ms, durable
checkpoint through synchronous invalidation publication at 17.92 ms, and
startup through resource readiness at 84.23 ms. A full scrub verified all
73,400,333 referenced artifact bytes in 43.38 ms with no orphans. Repository
typechecking, 87 Agent server tests, 25 Agent unit tests, 66 Agent viewer tests
with two expected project skips, and the Agent production build passed. The
unchanged 354-test Codex baseline passed on retry after one desktop narration
auto-follow timing flake; no Codex source was changed. The real-subscription
snapshot replay returned `REMUX_REPLAY_OK` on `gpt-5.3-codex-spark` at high
reasoning: one completed full inference, 47,802 estimated input tokens, and
2,380 ms elapsed. The separate implementation report records the detailed
closure. Owner desktop/physical-phone acceptance was subsequently completed.

## Outcome

After this checkpoint, a large durable conversation can be opened, paged,
streamed, backgrounded, restarted, and focused to an old turn without replaying
or materializing unrelated history. Every visible revision and invalidation is
fenced by a committed journal sequence. Oversized content remains explicit and
retrievable instead of causing a turn to disappear.

Provider input deliberately remains exact full replay in Phase 1A.2. Runtime
hydration may therefore still read the whole logical conversation and the
pre-rollover budget guard may still reject a long conversation. Phase 1A.3
shadows a smaller context; Phase 1B makes epochs authoritative. Transcript
hardening must not quietly change what the model sees.

## Audit of the Phase 1A.1 implementation

### Foundation already worth keeping

- SQLite schema validation, foreign keys, canonical JSON, WAL/FULL durability,
  content-addressed artifacts, startup recovery, and idempotent conversation
  creation are implemented.
- User, assistant, reasoning, tool, inference, turn, scope, and epoch boundaries
  cross durable fences before their corresponding provider/tool/publication
  boundary.
- Full logical replay, the required Pi provider preflight, the hard input guard,
  fresh hydration after restart, and zero-effect replay are tested.
- The Agent already exposes bounded transcript windows, work groups, entry
  details, generation-tagged responses, lifecycle deferral, transcript
  virtualization, desktop history, and the mobile history sheet.
- Frozen transcript reconstruction is isolated from Pi hydration and has an
  eight-conversation LRU. Basic live/frozen equality, restart, navigation,
  scrolling, disclosure, and mobile containment fixtures pass.

This table records the audit state at the start of Phase 1A.2. Implemented
findings are summarized above; remaining findings route to 1A.2c or 1A.2d.
Phase 1A.2 replaces weak internals behind those surfaces; it does not discard
the working viewer or reopen the journal/context architecture.

### Gaps found by the audit

| Finding | Current behavior | Required hardening |
| --- | --- | --- |
| Transcript reads are not structurally bounded | A cold tail/around read loads every conversation event, resolves its artifacts, replays the full conversation into `EphemeralTranscriptProjector`, and only then selects at most 40 turns. The eight-entry cache hides repeat cost but is count-bounded rather than byte-bounded. | Resolve the requested turn window in SQLite first and materialize only selected turns and disclosed details. Production transcript reads must not depend on full event replay. |
| Resource basis is not the journal basis | Replayed projectors increment a private action ordinal. `AgentTranscriptSyncResource.basisSequence`, render revisions, and invalidations therefore do not consistently name the maximum contributing `events.sequence`. | Use committed journal sequences for the batch basis and versioned hashes derived from durable item sequences for render/layout revisions. Include basis sequence on transcript invalidations. |
| Send admission collapses two identities | Conversation creation has a caller-stable operation ID, but message send accepts only `clientMessageId` and creates the operation ID on the server. This deviates from the 1A.1 protocol contract and weakens future retry/reconciliation semantics. | Require caller-stable v4 `operationId` and a separate v4 `clientMessageId`; reconcile and conflict-check both. |
| Durable method and list shapes retain Phase 0 residue | The durable create method is still named `conversation/start`, `ContextProbe.hookVersion` is still `phase0-v1`, and the 50-row conversation list does not state that it is truncated. | Hard-cut the pre-release Agent protocol to durable names/versions and return `truncated`. No compatibility alias is needed. |
| Large assistant state is rewritten and rescanned | Each assistant checkpoint appends to the full assistant/reasoning strings in `transcript_items`. Conversation summary refresh scans prior visible messages during streaming. Large exact event deltas may be artifacts, but the accumulated SQL projection is still unbounded text. | Store append-oriented content descriptors/chunks, update preview metadata incrementally, and avoid rewriting/scanning the historical transcript per delta. |
| Oversized turns fail by omission | A frame above 1 MiB becomes `frameTooLarge`; the viewer currently filters error frames out of `turnOrder`. Entry detail truncation has no exact continuation reference in the render resource. | Render an explicit stable placeholder with byte count/hash and bounded retrieval. A valid committed turn must never vanish because its display payload is large. |
| Work pagination can mix revisions | Group cursors are naked decimal offsets. A group can append between page reads, and the viewer may concatenate pages from different revisions. `knownRevision` and `cursor` are not mutually fenced. | Make cursors opaque and revision-scoped; reject stale cursors and never merge pages from different group revisions. |
| Terminal presentation is only approximately durable | Replay derives durations from event wall timestamps and maps stored errors back to a generic provider error. Restart interruption is flattened into ordinary interruption in the render frame. | Journal typed terminal reason/error category and monotonic duration at commit boundaries; preserve restart interruption and exact terminal state in projection. |
| Generation and direct-focus behavior are incomplete | Generic resources re-read on generation change, but transcript invalidation envelopes do not fence by generation, transcript cache acceptance treats every new generation as acceptable, and a requested unloaded turn is recorded in viewport state without triggering the required `around` read. | Atomically fence/reset transcript caches on generation change, ignore old-generation invalidations/responses, and load-then-scroll a focused turn. |
| Stress and failure coverage stops short of the intended gate | Existing tests cover 45 projector turns, ordinary work details, three Pi crash boundaries, and fixture restart. They do not cover a 100+ durable conversation, large selected/unselected artifacts, stale group pages, concurrent command/logout races, disk failures, or viewport recovery in the middle of old history. | Add the deterministic corpus, fault matrix, performance probes, and real restart smoke defined below. |
| Startup work grows with all stored bytes | Startup canonical-data validation scans all JSON and artifact validation reads and hashes every referenced artifact before serving. This is safe but makes restart cost proportional to the entire immutable corpus. | Keep synchronous structural/metadata validation, verify content on first use with a generation-local cache, and provide a full explicit scrub gate outside the hot restart path. |

## Normative scope

### 1. Protocol and identity hard cut

The Agent server and viewer ship together and have one owner. Phase 1A.2 makes
one clean break rather than carrying a compatibility layer:

```text
remove  remux/agent/conversation/start
add     remux/agent/conversation/create
keep    remux/agent/conversation/message/send
keep    remux/agent/conversation/turn/interrupt
```

Message admission becomes:

```ts
type MessageSendParams = {
  operationId: string;      // caller-stable lowercase UUID v4
  conversationId: string;   // server-issued lowercase UUID v4
  clientMessageId: string;  // distinct caller-stable lowercase UUID v4
  text: string;
};
```

An exact retry returns the original operation/turn result. Reusing either ID
with conflicting canonical arguments returns a typed conflict and causes no
mutation. Conversation, operation, client-message, turn, transcript-item,
scope, epoch, and inference identity remain distinct in tests and resources.

Other protocol cleanup in this checkpoint:

- transcript protocol `2`, projection `agent-turn-render-v2`;
- durable context probe version/name, without changing probe behavior;
- `ConversationListValue.truncated`, true when more than 50 summaries exist;
- strict UUID parsing for every Agent-owned identity at the RPC boundary;
- at most 64 generic resource requests, with duplicate keys rejected; and
- typed, redacted failures for storage busy/unavailable, stale cursor,
  oversized content, generation replacement, and durable corruption.

There is no version-1 transcript fallback. Fixture/server/viewer changes land
atomically in the same checkpoint.

### 2. One durable transcript snapshot

Every transcript resource batch reads one stable journal snapshot:

1. drain the repository writer lane;
2. capture the conversation head `events.sequence` as `basisSequence`;
3. resolve tail/around/range against `turns.accepted_sequence`;
4. select no more than 40 turns;
5. select `transcript_items` and terminal events only for those turns;
6. materialize only content needed by requested frames/groups/details; and
7. return all resources from that basis or retry the read.

The response must never combine a frame from basis `N` with a work resource
from `N+1`. A later invalidation is only a hint to read a newer basis.

The schema moves to version 2 through an exact, transactional version-1
migration that adds the turn-local transcript lookup index:

```sql
CREATE INDEX transcript_items_by_turn_sequence
  ON transcript_items(conversation_id, turn_id, first_sequence);
```

No owner database reboot is part of this phase. The migration preserves all
current conversations and remains fail-closed. If implementation measurements
prove another index is necessary, it must be added to the same reviewed schema
v2 fingerprint; new causal tables or renamed identities require a stop and
scope revision.

Production reads no longer reconstruct an entire `EphemeralTranscriptProjector`.
The render path is a pure projection over selected durable rows. A cache may
retain completed frames by durable revision, but it must be byte-weighted and
disposable; correctness and first-read cost cannot depend on it.

### 3. Durable render identity and revisions

Stable presentation identity derives from journal identity:

- user/assistant/tool rows use their durable `transcript_items.item_id`;
- the work segment ID is a versioned hash of turn ID plus projection policy;
- a group ID is a versioned hash of turn ID, group kind, and deterministic
  semantic run ordinal;
- a group row for a tool uses the tool transcript-item ID; and
- reasoning text entries derive from the assistant item plus checkpoint/run
  position, never an in-memory UUID counter.

`renderRevision` and `layoutRevision` are hashes over projection version,
durable IDs, contributing first/last sequences, and the relevant content
descriptors. `basisSequence` is always the maximum journal sequence observed by
the batch. Restart and cold/live reads must produce byte-identical frames.

Completed turns are immutable in Phase 1A.2. A streaming turn may advance its
revision, but an invalidation carries its committed basis and can never regress
a viewer already at a later basis.

### 4. Append-oriented text and explicit oversized content

User text continues to use the existing inline-or-artifact reference. New
assistant and reasoning checkpoint events append exact deltas or immutable
content descriptors; the mutable SQL transcript row keeps only byte counts and
a bounded summary rather than rewriting the complete accumulated string on
every checkpoint. Small event deltas may remain inline; larger deltas use the
existing content-addressed artifact store. The event journal remains sufficient
to rebuild this transcript projection. At a terminal boundary, the repository
installs aggregate immutable text artifacts so exact range retrieval does not
require the viewer to understand the internal checkpoint/chunk layout.

Conversation title is fixed from the first user message. Preview updates use
only the changed latest visible item; assistant streaming must not rescan all
earlier transcript rows.

An ordinary frame contains at most 256 KiB of any one visible text body and at
most 1 MiB total. When exact content is larger, the v2 segment includes:

- a bounded UTF-8 preview;
- exact SHA-256 and byte length;
- returned byte count and `truncated: true`; and
- an artifact range from which the viewer can request the next bounded slice.

The viewer labels this state and offers explicit continuation. It does not
silently omit the turn or auto-fetch megabytes while the disclosure is closed.
Chunked oversized text may render as bounded plain text; it is not required to
pretend that a partial Markdown document is a complete Markdown document.

Work-entry truncation uses the same descriptor. Provider call IDs, credentials,
request bodies, and restricted metadata remain redacted before either preview
or artifact publication.

### 5. Work groups and detail pagination

The default work page stays 200 rows and the maximum accepted page size stays
256. `hasMoreRows` is derived from actual row count.

`nextCursor` encodes at least projection version, group revision, and next
offset. It is opaque to the viewer. A cursor from an older group revision
returns `staleCursor`; it never returns a page that the viewer can append to a
newer first page. `knownRevision` is valid only for the first page and cannot be
combined with a continuation cursor.

The viewer deduplicates rows by durable row ID as a defensive check, replaces
the group on revision change, and exposes retry for missing/error/stale detail.
One work disclosure issues bounded batched reads rather than per-row fan-out.

### 6. Viewer generation, focus, and viewport recovery

The transcript store owns one accepted `serverGeneration` and one
`basisSequence` per active conversation:

- an invalidation from another generation is ignored;
- a response from an older generation cannot replace current state;
- a newly observed generation clears protocol revisions, group pages, and
  detail caches atomically, while preserve-ready rendering may remain until one
  fresh batch succeeds;
- basis sequence never moves backward inside a generation; and
- background/resume performs one current-window verification, not a tail jump
  unless the viewer was already following the bottom.

Host navigation to `focusKind=turn` first performs an `around` read when the
turn is outside the loaded window, measures the resulting frame, and then
scrolls to it. Missing turns produce an explicit not-found state. “Return to
latest,” earlier/later window movement, sent-message anchoring, manual-scroll
ownership, keyboard geometry, and safe areas retain the existing UI behavior.

Frame projection failures, oversized content, missing work resources, and
stale pages render explicit retry/retrieval affordances. No valid server result
is filtered out merely because it is an error variant.

### 7. Recovery and operational hardening

Startup keeps the existing exact-fingerprint discipline, canonical JSON,
foreign-key, recovery, and safe-path checks and adds `PRAGMA quick_check`. It validates
artifact path/type/declared length synchronously. Full content hashes are
verified on first content use in each server generation and cached by immutable
hash. A selected corrupt artifact fails the read or provider preflight before
use and surfaces a redacted durable-corruption diagnostic.

A separate explicit storage scrub verifies every referenced artifact and
reports orphans. It is a test/maintenance command, not a model tool, UI control,
garbage collector, or automatic background model task.

Conversation-mutating commands, logout, and runtime replacement share the
existing serialized command lane. Interrupt remains immediate and idempotent.
The fault matrix must prove deterministic outcomes for concurrent duplicate
sends, conflicting sends, send versus logout, interrupt versus terminal, close
versus hydration, SQLite busy, artifact read/write failure, and notification
loss. Storage uncertainty is surfaced; no provider call or tool effect is
guessed or repeated.

## Implementation slices

### Phase 1A.2a — protocol and durable revision fence (implemented)

- hard-cut create/send identity shapes and transcript v2;
- add conversation-list truncation and strict parsers;
- add schema-v2 index migration;
- make basis-bearing invalidations and durable render identities authoritative;
- retain exact full provider replay and existing Pi preflight behavior.

### Phase 1A.2b — bounded SQL projection and large content (implemented)

- replace production full-replay transcript reads with selected-row queries;
- add append-oriented assistant/reasoning descriptors;
- make summaries incremental;
- add explicit oversized segment/detail references; and
- retain a byte-bounded completed-frame cache only as an optimization.

### Phase 1A.2c — pagination and viewer lifecycle (implemented)

- add revision-scoped group cursors and defensive row merging;
- implement generation/basis fencing;
- complete focus-to-turn load and measured scroll;
- preserve current windows/disclosures across reconnect and restart; and
- render explicit frame/detail failure and retry states.

### Phase 1A.2d — fault, scale, and live closeout (implemented; automated gate passed)

- add the deterministic long-history corpus and performance probes;
- run the concurrency/storage/crash matrix;
- port only applicable stable Codex transcript tests, with Agent-owned fixtures;
- run the complete Agent and unchanged Codex suites; and
- run an opt-in real-subscription restart/replay smoke against a snapshot.

## Verification corpus

The deterministic fixture uses a temporary Agent data root and contains:

1. 250 completed turns with mixed short and Markdown responses;
2. one active streaming tail turn;
3. one 2 MiB user or assistant body;
4. one work group with 1,000 rows and a revision change between page reads;
5. one 8 MiB artifact-backed result plus corrupt and missing variants;
6. one failed, interrupted, and restart-interrupted turn;
7. an old route-focused turn outside the initial tail;
8. a middle-history viewport with open work disclosure; and
9. at least 60 MiB of unselected historical artifacts.

Assertions are structural before they are timing-based:

- a tail/around/range read selects at most 40 turns;
- it reads no content artifact owned only by an unselected turn;
- every returned basis/revision is reproducible after restart;
- all group pages belong to one revision and contain no duplicate/missing row;
- every committed turn has a visible frame or explicit error placeholder;
- DOM turn roots remain bounded by the active window/overscan; and
- a dropped invalidation followed by resource read converges exactly.

Reference-box performance gates, measured through a Remux research workload:

- 250-turn cold tail and around server reads: p95 at or below 100 ms;
- durable checkpoint through invalidation publication: p95 at or below 25 ms
  on the long-history fixture, excluding provider time;
- extension startup through resource readiness: p95 at or below 1.5 seconds
  on the fixture without a full scrub; and
- no response exceeds the existing 8 MiB batch ceiling.

Timing failures are profiled and fixed locally. They are not hidden with a
model call, a larger response limit, or eager whole-history caching.

## Exit gates

Phase 1A.2 is complete only when:

1. the Phase 1A.1 database migrates in place and all existing conversations
   remain readable and continuable;
2. operation/client-message identity and exact retry/conflict semantics pass;
3. selected transcript reads are structurally bounded and journal-sequenced;
4. cold/live/restarted render frames are byte-identical at the same basis;
5. large content and failed projections remain visible and exactly retrievable;
6. stale cursor, generation, lifecycle, and direct-turn-focus cases converge;
7. the concurrency, crash, storage-fault, and notification-loss matrix produces
   no duplicate message, provider call, or tool effect;
8. the deterministic scale and performance gates pass;
9. `npm run test:agent`, Agent build, repository typecheck, and the unchanged
   Codex baseline pass; and
10. the owner accepts desktop and physical-phone long-history, restart,
    disclosure, focus, error, and scrolling behavior.

Automated exit gates 1–9 passed on 2026-08-08. The owner explicitly accepted
desktop and physical-phone behavior on 2026-08-08, closing gate 10. This
decision is recorded directly rather than inferred from fixture, browser,
performance, or subscription smoke tests.

The implementation report records source closure, protocol/schema versions,
performance results, the real-subscription smoke, selected Codex parity sources,
and every deviation. Phase 1A.3 may now begin as a separately aligned shadow
compiler checkpoint.

## Explicitly absent

- shadow manifests, project-context injection, context inspector, active epoch
  rollover, context pull/pin, or manual compaction;
- changes to provider prompt content, tool ordering, cache strategy, or the Pi
  provider-preflight seam beyond regression fixes;
- workspace search/patch, shell, runtime/process tools, or persistent processes;
- queue/steer, edit, fork, mentions, attachments, or image input;
- archive/delete, export/import, retention, artifact garbage collection, or a
  general backup product;
- simultaneous Agent turns or multiple loaded Pi sessions;
- Codex/App Server protocol reuse or source changes under `extensions/codex/`;
  and
- narration, review, service-tier/quota UI, collaboration, subagents, or web
  research integration.

This phase is deliberately quiet in the product. It should make the existing
conversation surface trustworthy under scale and failure, not add workflow
ceremony.
