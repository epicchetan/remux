Status: Implemented — automated verification complete; physical-device acceptance pending
Last verified: 2026-09-04
Canonical code: `extensions/agent/viewer/src/transcript/`, especially `controller/`, `disclosure/`, `geometry/`, `viewport/`, `layoutStore.ts`, and `virtualizer.tsx`

# Agent transcript UI controller v1

## Decision

Keep the working Agent transcript foundation and reorganize it around one
explicit client-side transcript controller. Do not replace the server resource
contract, deterministic measurement, relative-DOM virtualizer, or current
visual design.

The controller will accept one coherent authoritative transcript snapshot and
will coordinate four separate concerns in a defined order:

1. deterministic collapsed layout;
2. work and message disclosure policy;
3. semantic viewport intent and virtual range;
4. pre-paint DOM scroll and extent effects.

This is an internal UI hardening pass. The visible outcome is current feature
parity without timing-dependent behavior, plus smaller modules in which future
transcript features have an obvious owner.

The first functional correction is work disclosure: a newly materialized
active turn with running work opens its work section unless the user explicitly
closed that same turn. That decision comes from the transcript snapshot, not
from a separately refreshed runtime store or the current scroll mode.

## As-built record

- `resourceStore.ts` passes the authoritative transcript `activeTurnId` into
  layout reconciliation. `layoutStore.ts` publishes that identity, measured
  turns, and disclosure from the same resource snapshot; it no longer reads
  runtime or viewport stores to make disclosure decisions.
- `disclosure/disclosureReducer.ts` owns all work and user-message disclosure
  policy, including automatic open, response-boundary close, manual-close
  veto, replacement running work, and next-turn cleanup.
- `controller/useTranscriptRenderSnapshot.ts` assembles measured turns,
  expanded-row overlays, running identity, and one immutable
  `TranscriptGeometryIndex` for a render commit.
- `geometry/geometryIndex.ts` is the coordinate authority used by virtual
  range, spacers, message navigation, and row-anchor restore.
- `viewport/viewportTypes.ts` separates semantic intent from transient native
  or programmatic ownership. Pure transitions, semantic caching, and DOM
  geometry live in `viewportReducer.ts`, `viewportCache.ts`, and
  `viewportDom.ts`; `useTranscriptViewportController.ts` is the sole lifecycle
  and DOM-driving owner.
- `virtualizer.tsx` now only composes the render snapshot, viewport controller,
  and presentational viewport. Turn/row rendering is in
  `components/TranscriptViewportBody.tsx`, and `WorkSection` receives its open
  state and callbacks as props.
- The physical transport/cache/detail implementation remains behind the
  existing `resourceStore.ts` facade. It was not mechanically split because its
  ownership and read cadence were already correct, and doing so would add risk
  without changing the transcript UI contract.
- The established pre-paint range/scroll sequence was retained inside the one
  viewport controller instead of replacing it with a second parallel plan
  engine. Intent, ownership, geometry, and DOM helpers are now explicit and
  independently testable while preserving the proven no-shift behavior.

## Why this pass exists

The current implementation works, including long-history virtualization,
streaming, exact message navigation, expanded work, attachment resizing,
compaction rows, cached tab switching, and mobile momentum handling. The
cleanup must preserve those results.

The implementation has nevertheless accumulated timing-sensitive ownership:

- `virtualizer.tsx` is approximately 1,900 lines and coordinates measurement,
  cache restoration, range selection, native scrolling, animations, synthetic
  extent, route focus, pagination, and row rendering through many effects and
  refs.
- `layoutStore.ts` reads `runtimeStore` and `viewportStore` while reconciling
  measured resources. The virtualizer separately treats
  `resourceStore.workingTurnId` as streaming truth.
- Runtime, transcript, and viewport stores can publish in different orders.
  Consequently a turn can be running to the virtualizer while disclosure
  reconciliation sees no eligible active turn, leaving new work closed.
- `sent-message-anchor` now correctly represents explicit historical message
  navigation as well as a newly sent message, so its name no longer describes
  its behavior.
- Semantic viewport intent, transient DOM ownership, navigation cursor, and
  synthetic scroll support are represented in different stores and refs.
- Anchor runway and extent floor are written both imperatively and through
  React state. Correctness currently depends on careful callback/effect order.
- Expanded-row prefix geometry is implemented in more than one module.
- Agent has strong end-to-end scroll coverage, but did not port the Codex
  suite of pure work-disclosure transition tests.

These are organization and ownership problems, not a reason to discard the
virtualizer.

## Retained foundation

The following behavior and architecture stay in place:

- The server and provider adapters own transcript truth.
- The viewer reads bounded, revisioned transcript windows and lazy detail
  resources. It never reconstructs provider events.
- Turn frames remain immutable, provider-neutral render resources.
- Collapsed turn and row heights remain deterministic at a given width,
  layout revision, and disclosure revision.
- Pretext remains the text and rich-inline measurement engine used by the
  Markdown layout model. Fixed transcript constants cover non-text chrome.
- Open work content contributes a separately measured expanded-height overlay.
- The virtualizer renders ordinary relative DOM with a top spacer, complete
  turns, and a bottom spacer. It never mounts a partial turn.
- Virtual range follows actual viewport position plus overscan. Navigation does
  not pre-mount a target-centered range.
- Transcript position caches remain semantic (`bottom`, message identity, or
  row identity plus offset), never a correctness dependency on raw pixels.
- Native touch/momentum scrolling owns the viewport until it settles.
- Server generation, request generation, basis sequence, and revision fencing
  remain unchanged.
- Existing Agent styling and component presentation remain unchanged during
  behavioral extraction.

## Product behavior contract

### Work disclosure

Work disclosure follows these rules:

1. When the authoritative active turn first contains a running work segment,
   that segment is open before its first visible frame.
2. Auto-open does not depend on bottom-follow, message anchoring, mounted range,
   or whether the user is reading an older part of the transcript.
3. If the user closes auto-open work, that turn receives a manual-close veto
   and no subsequent delta may reopen it automatically.
4. If a provider replaces the running work segment within the same active
   turn, auto-open transfers to the newest running segment unless that turn has
   a manual-close veto.
5. Preserve Codex response-boundary behavior: automatically opened work closes
   when the first assistant-response segment appears. Turn completion is the
   fallback close boundary if no assistant segment appeared.
6. Work explicitly opened before the assistant response starts may close at
   that response boundary. Work reopened after the response starts stays open.
7. Completed historical work is closed by default and remains user-toggleable.
8. User-opened work and child disclosures survive resource refreshes,
   virtualization unmount/remount, generation replacement, and in-memory
   conversation switching.
9. Disclosure is session UI state, not journal truth. A full WebView reload
   re-derives defaults: running work opens and completed work closes.
10. Fork, edit, direct send, and queued-send activation use the same policy;
    none has a special disclosure path.

### Viewport intent

The viewport has exactly one semantic intent:

```ts
type TranscriptViewportIntent =
  | { kind: 'bottom-follow' }
  | {
      kind: 'message-anchor';
      conversationId: string;
      phase: 'catching-up' | 'anchored';
      reason: 'send' | 'navigation' | 'restore' | 'route-focus';
      segmentId: string;
      turnId: string;
    }
  | { kind: 'free'; anchor: TranscriptRowAnchor | null };
```

- `bottom-follow` follows natural transcript bottom during growth.
- `message-anchor` owns an exact user-message position. This replaces the
  misleading `sent-message-anchor` name and supports both sent and historical
  messages.
- `free` preserves the user's reading position and never writes `scrollTop`
  because content streamed elsewhere.
- Up selects the previous semantic user-message identity.
- Down selects the next semantic user-message identity, or natural bottom when
  no later message can or should be anchored. Down eligibility and execution
  resolve the same destination against natural transcript bounds. Eligibility
  excludes trailing padding and synthetic runway; the bottom destination retains
  normal transcript padding. A latest turn
  that is already fully visible does not enable Down or gain synthetic runway,
  including while streaming. Explicit Up and new-message anchoring remain separate.
- Manual wheel/touch input enters `free`; reaching natural bottom enters
  `bottom-follow` after native scrolling settles.

Semantic intent is distinct from transient scroll ownership:

```ts
type TranscriptScrollOwner =
  | 'idle'
  | 'initial-placement'
  | 'programmatic-navigation'
  | 'native-touch'
  | 'native-momentum';
```

Only the current owner may write or reinterpret viewport position.

### Atomic viewport plans

Every controller reconciliation produces one plan:

```ts
type TranscriptViewportPlan = {
  intent: TranscriptViewportIntent;
  range: TranscriptVirtualRange;
  support: {
    extentFloorHeight: number;
    runwayHeight: number;
  };
  scroll: null | {
    animated: boolean;
    targetScrollTop: number;
  };
};
```

Plan application obeys these invariants:

- A range change and its top/bottom spacers are one React state commit.
- A target row is not substituted into the range ahead of viewport motion.
- An animation establishes enough extent to support both its starting and
  destination positions before its first frame.
- Extent never shrinks while the current `scrollTop` would be invalid under the
  smaller extent.
- Returning to bottom first moves to natural bottom, then releases synthetic
  extent before paint.
- Layout reconciliation cannot restore a captured row anchor while native or
  programmatic navigation owns the viewport.
- Stream growth, work collapse, attachment resizing, and keyboard geometry all
  resolve against the same semantic intent.

## Target ownership

```text
server transcript resources
          |
          v
TranscriptResourceStore  ---- lazy execution/operation details
          |
          | authoritative commit
          v
TranscriptController
    |             |                    |
    v             v                    v
layout engine  disclosure reducer  viewport reducer
    \             |                    /
     \            |                   /
      +---- TranscriptRenderSnapshot -+
                         |
                         v
              viewport DOM driver
                         |
                         v
       top spacer + complete turns + bottom spacer
```

### Resource store

Owns only remote/server state and transport lifecycle:

- active conversation and bounded transcript window;
- turn resources and their revisions;
- transcript `activeTurnId`;
- generation/basis fencing and stale-response rejection;
- execution-scope and operation-detail resources;
- invalidation scheduling, pagination, and resource caching.

It must not decide disclosure or viewport policy. The transcript sync's
`activeTurnId` is the sole running-turn input for transcript presentation.
The separately refreshed runtime resource may drive composer controls and
status, but not transcript disclosure.

### Layout engine

The layout engine is pure apart from its bounded measurement cache. Given
turn frames, width, and expanded-user-message state, it returns measured
collapsed turns.

Add one shared `TranscriptGeometryIndex` derived from measured turns and the
expanded-row height overlay. It owns:

- turn and row prefix positions;
- row lookup by row, segment, and turn identity;
- user-message navigation anchors;
- viewport range lookup and spacer calculation;
- capture/restore row anchors;
- natural content height.

This removes duplicate expanded-row scans from `virtualizer.tsx` and
`virtualizerScroll.ts` and gives every feature one coordinate system.

The initial implementation may rebuild the index in O(number of loaded rows)
when layout geometry changes. Transcript windows are bounded, so a more complex
incremental tree is unnecessary until measurement proves otherwise.

### Disclosure reducer

Disclosure becomes a pure reducer/policy module. Inputs are:

- previous disclosure state;
- measured turns;
- authoritative `activeTurnId`;
- explicit user disclosure action.

It does not import or read resource, runtime, layout, or viewport stores.
Expanded height is associated with a stable work-row key and remains layout
data; open/closed/source/veto/child choices remain disclosure intent.

### Viewport reducer and DOM driver

The viewport reducer is pure geometry and state transition code. It consumes
events such as:

- transcript committed;
- expanded row measured;
- previous/next requested;
- send identity resolved;
- initial or cached placement requested;
- viewport resized;
- native scroll started/settled;
- lifecycle backgrounded/activated.

It returns a viewport plan. The DOM driver is the only module allowed to:

- read `scrollTop`, `scrollHeight`, `clientHeight`, and element bounds;
- write `scrollTop`, extent floor, and runway;
- schedule or cancel animation frames;
- own ResizeObserver, scroll, touch, wheel, and visibility listeners.

The driver reports facts and completion events back to the controller. It does
not choose product policy.

### React rendering

`VirtualizedTranscript` becomes composition rather than the controller itself:

```tsx
function VirtualizedTranscript({ conversationId }: Props) {
  const snapshot = useTranscriptRenderSnapshot(conversationId);
  const viewport = useTranscriptViewportController(snapshot);
  return <TranscriptViewport snapshot={snapshot} viewport={viewport} />;
}
```

Move turn and row rendering to dedicated components. `WorkSection` receives
open state and typed callbacks; it should not infer auto-open policy. Its
ResizeObserver reports expanded content height through one callback.

## Proposed source layout

```text
viewer/src/transcript/
  controller/
    transcriptController.ts       authoritative commit ordering
    transcriptRenderStore.ts      coherent render snapshot
  disclosure/
    disclosureReducer.ts          pure work/message policy
    disclosureTypes.ts
  geometry/
    geometryIndex.ts              single coordinate model
    measureCache.ts
    measureCollapsed.ts
    reconcileMeasured.ts
    types.ts
  viewport/
    viewportReducer.ts            semantic transitions and plans
    viewportDriver.ts             DOM reads/writes and frame lifecycle
    viewportCache.ts              bounded semantic position cache
    viewportTypes.ts
  components/
    TranscriptViewport.tsx
    TranscriptTurn.tsx
    TranscriptRow.tsx
    ... existing segment components
  resources/
    resourceStore.ts              public resource facade
    syncCoordinator.ts            transcript reads and invalidations
    transcriptCache.ts            bounded conversation cache
    detailResources.ts            execution/operation lazy reads
```

File movement follows behavior extraction; it is not a prerequisite for the
first correctness fix. Existing public transcript imports retain a small
facade until callers migrate.

## Commit ordering

One authoritative resource update is reconciled in this order inside one
external-store batch:

1. Validate generation, conversation, basis, and resource revisions.
2. Build the next resource snapshot, including `activeTurnId`.
3. Reconcile collapsed measurements for dirty layout revisions.
4. Reduce disclosure from the same snapshot and active-turn identity.
5. Build the geometry index using the resulting disclosure-height overlay.
6. Reconcile pending sent-message identity and semantic viewport intent.
7. Publish one render snapshot.
8. Before paint, apply any viewport plan through the DOM driver.

No reducer obtains an input by imperatively reading another store during these
steps. A render snapshot therefore cannot combine a new turn frame with an old
runtime identity by accident.

## Implementation plan

### Phase 0 — characterize and lock behavior

- Port the applicable pure Codex disclosure tests into Agent fixtures.
- Add direct, fork, edit, queued-send, cache-restore, and full-reload work
  lifecycle tests.
- Retain frame probes for range replacement, message-anchor stability, content
  collapse, attachment resize, and return-to-bottom behavior.
- Add opt-in structured diagnostics for controller event, intent, owner,
  target, range boundary, spacer, natural extent, and synthetic extent.
- Do not change production behavior in this phase.

### Phase 1 — establish one truth and fix work disclosure

- Include authoritative transcript `activeTurnId` in layout/controller input.
- Remove `runtimeStore` and viewport-store reads from `layoutStore`.
- Extract the pure disclosure reducer.
- Remove viewport mode as an auto-open prerequisite.
- Apply the work-disclosure contract above, including fork/new-turn cases.
- Preserve lazy detail reads and current presentation.

This phase is the first owner-review checkpoint because it resolves the
known intermittent closed-work issue.

### Phase 2 — centralize geometry

- Introduce `TranscriptGeometryIndex`.
- Move navigation anchors, row positions, expanded prefix geometry, range, and
  spacer calculations onto the index.
- Delete duplicate geometry helpers only after parity tests pass.
- Keep current measurement constants, Pretext behavior, cache keys, and
  complete-turn rendering.

### Phase 3 — extract viewport state machine

- Rename `sent-message-anchor` to `message-anchor`.
- Separate semantic intent from transient scroll owner.
- Implement pure event-to-plan transitions.
- Move DOM listeners, observers, animation, and synthetic extent into one
  driver.
- Publish range and spacer state as one render-window object.
- Remove cross-effect cancellation and cleanup paths superseded by explicit
  plan completion.

This is the highest-risk phase and must land independently of file/style
renames.

### Phase 4 — decompose rendering and resources

- Extract `TranscriptViewport`, `TranscriptTurn`, and `TranscriptRow`.
- Make `WorkSection` prop-driven for disclosure and height reporting.
- Keep transport scheduling, transcript caching, and lazy detail resources
  behind the existing resource-store facade; split that file separately only
  when a resource-specific change benefits from it.
- Preserve cache bounds, resource read counts, invalidation cadence, and object
  identity for unchanged turns.

### Phase 5 — delete compatibility structure and document

- Remove unused adapters, duplicate helpers, obsolete refs, and stale comments.
- Rename internal Agent-owned selectors only in a separate mechanical change
  if still worthwhile; selector renaming is not required for controller
  correctness.
- Update this spec to `Implemented` with final source locations and measured
  gates.

Each phase lands green on `main`; do not maintain old and new virtualizers as
long-lived parallel implementations.

## Verification matrix

### Pure tests

- Every work-disclosure transition in the product contract.
- Active-turn identity arriving with the same transcript commit as first work.
- Manual-close veto and later new-turn reset.
- Geometry index row/turn lookup, expanded overlays, compaction placement,
  range selection, and spacers.
- Viewport reducer transitions for send, previous, next, bottom, manual scroll,
  resize, lifecycle, and cancellation.
- Extent plans never invalidate current or destination scroll positions.

### Browser tests on desktop and mobile

- Short final transcript initially lands at natural bottom.
- Long final transcript initially lands the latest user message at the top
  anchor.
- Running transcript and full reload land the active user message correctly.
- Previous/next navigation is exact, monotonic, and has no corrective frame.
- Navigation crosses virtual range boundaries and compacted turns.
- Running work opens on direct send, fork, edit, and queued dispatch.
- Manual work close is respected for the rest of that active turn.
- First assistant response collapses auto-open work; explicit reopen persists.
- Work growth/collapse, images, attachment trays, keyboard resize, and safe-area
  changes preserve the current semantic anchor.
- Conversation switching restores cached bottom/message/row intent without
  focusing an empty composer.
- Pagination, route focus, stale reads, reconnect, generation reset, and lazy
  detail retry remain functional.

### Frame-level gates

- A settled message anchor remains within 2 px of its modeled top.
- No frame after a navigation target first reaches its anchor deviates by more
  than 2 px unless native user input takes ownership.
- Range replacement begins only after viewport motion begins and preserves the
  modeled total extent.
- Forced synchronous work collapse cannot expose a browser-clamped frame.
- Returning to bottom leaves zero synthetic runway and is within 2 px of
  natural bottom.

### Performance and boundedness

- No additional transcript or detail resource reads for equivalent user
  behavior.
- Streaming refresh cadence and coalescing remain unchanged.
- Unchanged layout revisions reuse measurement objects and cache entries.
- Mounted turn count remains within the existing overscan bound.
- Conversation layout and viewport caches remain bounded to five entries
  unless a later measured requirement changes the limit.
- The controller schedules at most one pending range reconciliation and one
  pending managed-scroll reconciliation per animation frame.

Minimum commands after every behavioral phase:

```sh
npm --workspace @remux/agent run test:unit -- --workers=1
npm --workspace @remux/agent run test:viewer -- --project=desktop --workers=1
npm --workspace @remux/agent run test:viewer -- --project=mobile --workers=1
npm --workspace @remux/agent run test:server
npm --workspace @remux/agent run build
git diff --check
```

Physical-phone acceptance is required after Phases 1 and 3 because native
keyboard, momentum, compositor clamping, and safe-area behavior cannot be
fully established by desktop browser emulation.

## Non-goals

- No server, journal, provider-adapter, or transcript protocol redesign.
- No absolute-positioned list or third-party virtualizer replacement.
- No partial-turn virtualization.
- No eager loading of work details or exact artifacts.
- No persistence of disclosure state as conversation truth.
- No visual redesign, animation redesign, or composer behavior expansion.
- No unbounded history or client cache.
- No attempt to share source with the legacy Codex extension during this pass.
- No optimization more complex than the bounded window requires without
  measurements demonstrating a need.

## Completion criteria

The pass is complete when:

1. one authoritative snapshot drives running-turn presentation;
2. new active work cannot start closed without a same-turn manual-close veto;
3. disclosure, geometry, semantic viewport intent, and DOM effects each have a
   single documented owner;
4. `VirtualizedTranscript` is a composition surface rather than the policy
   implementation;
5. no store reducer imperatively reads another store for policy inputs;
6. duplicate coordinate calculations and misleading anchor naming are gone;
7. the full automated matrix passes with no resource-read or boundedness
   regression; and
8. owner review confirms correct direct-send, fork, navigation, streaming,
   tab-switch, reload, keyboard, and physical-phone behavior.

## Verification record

Automated verification on 2026-09-04:

- 54 unit tests passed, including pure disclosure, geometry, viewport intent,
  native ownership, anchor, and extent cases.
- 163 server tests passed, including Codex commentary/final-answer projection
  coverage and bounded transcript resources.
- Desktop browser: 71 passed and 3 mobile-only cases skipped as intended.
- Mobile browser: all 74 passed.
- Production server and viewer builds passed.
- `git diff --check` passed.

The browser matrix covers direct send, edit, fork, queued dispatch, running and
completed reloads, compacted navigation, frame-level anchor stability,
attachment/composer resize, native-scroll settlement, tab switching, cache
restore, pagination, route focus, reconnect, and generation reset. A physical
phone remains the final acceptance environment for native keyboard,
compositor, momentum, and safe-area behavior.
