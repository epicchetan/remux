# Narrate Markdown viewer playback v1

Status: Active Spec
Last verified: 2026-07-19
Canonical code: `extensions/narrate/viewer/`, `packages/narration-client/`,
`extensions/narrate/server/`, and `docs/specs/narrate-batch-alignment.md`
Builds on: `docs/specs/narration-client-package.md`

## Outcome

Add first-class narration to the Narrate Markdown viewer without adding a second audio engine,
transport, lifecycle controller, or server protocol.

The user opens a Markdown file and sees one Narrate action. Starting narration creates a session for
that exact file revision. While Narrate prepares the artifact, the action bar shows useful progress
and a cancel action. Once the artifact is ready, the right side of the action bar becomes the
playback surface. Audio playback drives sentence and word highlighting against the rendered
Markdown, block seeking, and document following.

```text
Markdown file
  -> Narrate-owned Markdown narration model
       -> NarrationDocumentV1 sent to Narrate server
       -> stable block ids and exact logical UTF-16 text ranges bound to the DOM
  -> @remux/narration-client
       -> start/read/cancel transport
       -> preparation and recovery lifecycle
       -> HTMLAudioElement playback
       -> sample-to-block/sentence/word resolution
  -> Narrate-owned controls, highlighting, seeking, and scrolling
```

The user-facing lifecycle is deliberately simple:

```text
Off -> Preparing -> Active
          |           |
          v           v
        Error <-------+
```

The implementation retains the full client phase state machine. `Active` is a presentation group,
not a replacement boolean for `ready`, `buffering`, `playing`, and `paused`.

## Existing baseline

The implementation begins from these current contracts:

- `@remux/narration-client` already owns strict protocol decoding, RPC policy, request fencing,
  cancellation ordering, restart recovery, lifecycle reconciliation, browser audio, playback rate,
  seeking, and sample-to-cue resolution.
- The Narrate server already accepts `NarrationDocumentV1` and publishes one validated
  `NarrationArtifactV4` with final-WAV sample ranges for blocks, sentences, and words.
- The server already generates structural transcripts for code, table, and diagram blocks, runs
  contextual Misaki on the projected document, applies sparse Sol direct-phone review, plans
  NLP-aware acoustic chunks, and synthesizes with Kokoro.
- The Narrate viewer currently loads one Markdown file, renders it with React Markdown, and has an
  action bar with a standalone Open tabs action plus a Narrate menu containing Reload, Copy, and
  Close tab.
- The action bar right slot is intentionally empty and is reserved by this spec for narration.

This pass consumes those contracts. It does not redesign them.

## Closed decisions

1. Narration is one document-scoped session, not a persisted global on/off preference.
2. A client instance permits at most one active Narrate-viewer session, as required by the shared
   client.
3. The Narrate viewer creates its own `@remux/narration-client` instance. It does not import the
   Codex client singleton or Codex UI.
4. The shared client continues to own all transport, lifecycle, audio, timing, and recovery logic.
   The Narrate viewer owns Markdown projection, DOM bindings, controls, highlighting, and scrolling.
5. Narration starts only from a fully loaded UTF-8 Markdown file. Loading, unsupported, binary,
   errored, empty, or non-narratable documents cannot start narration.
6. Starting narration snapshots the current source document and local file identity. Later file
   content may never reuse its cues merely because a path stayed the same.
7. The Narrate server continues to receive only `NarrationDocumentV1`. File paths, modification
   times, viewer state, DOM metadata, and playback preferences remain local.
8. The Markdown narration request and the rendered DOM use one authoritative logical block model.
   Independent ad hoc text extraction is forbidden.
9. Public text offsets remain zero-based half-open UTF-16 code-unit ranges relative to the exact
   logical text of one block.
10. Paragraphs, headings, list-item prose, and blockquotes use sentence and word highlighting.
    Code, tables, diagrams, and display math use whole-block highlighting.
11. The viewer does not expose acoustic chunks. Previous/next and tap-to-seek operate on public
    narration blocks.
12. A Narrate action begins preparation and requests automatic playback when the artifact becomes
    ready in the active foreground viewer. If lifecycle state or browser policy prevents that,
    the session remains Ready and waits for an explicit Play gesture.
13. Leaving for the tabs overview backgrounds and pauses playback through the shared lifecycle; it
    does not discard a completed artifact or cancel preparation. Returning never silently resumes
    audio that lifecycle handling paused.
14. Navigating to another file, reloading the viewer, closing the tab, or observing a mismatched
    file revision ends the local session and clears paint before the new document can render.
15. There is one production client path. Do not copy the former Codex audio engine, keep a legacy
    Narrate-viewer path, add a compatibility fallback, or weaken alignment when DOM bindings fail.
16. This pass is batch playback. It does not add generation streaming, partial WAVs, or partial
    alignment.
17. Playback controls remain viewer-owned in v1. No shared controls package is introduced merely
    because Codex and Narrate expose similar actions.

## Ownership

| Concern | Owner | Notes |
| --- | --- | --- |
| Markdown file loading and revision identity | Narrate viewer | Existing file store plus a local source hash/model identity |
| Markdown parsing and logical narration blocks | Narrate viewer | Same parsing configuration as the displayed document |
| Exact logical text-to-DOM ranges | Narrate viewer | Trusted post-sanitize bindings only |
| Narration wire contracts | `@remux/narration-client` | Existing schema, no forked types |
| Start/read/cancel and notifications | `@remux/narration-client` | Existing Remux adapter |
| Preparation and restart recovery | `@remux/narration-client` | Existing fenced controller |
| Audio loading, play state, samples, seek, and rate | `@remux/narration-client` | Existing browser audio driver |
| Action-bar presentation | Narrate viewer | Viewer-kit buttons and menus |
| Sentence/word/block paint | Narrate viewer | Narrate DOM has no Codex virtualizer dependency |
| Auto-follow and user-scroll suspension | Narrate viewer | Uses shared client focus and follow state |
| Transcript, pronunciation, chunking, synthesis, artifact | Narrate server / `remux-tts` | Unchanged |

## Viewer state model

The UI maps the shared client state rather than creating a competing store.

| Client state | Presentation mode | Right-side controls | Action-bar status |
| --- | --- | --- | --- |
| `idle` | Off | Narrate | File name and size |
| `preparing` | Preparing | Busy indicator, Cancel | Current preparation stage and progress |
| `ready` | Active | Previous, Play, Next, Speed, Close | Ready, position, and duration |
| `buffering` | Active | Previous, busy Play, Next, Speed, Close | Loading narration audio |
| `playing` | Active | Previous, Pause, Next, Speed, Close | Block position and elapsed/total time |
| `paused` | Active | Previous, Play, Next, Speed, Close | Paused position and elapsed/total time |
| `failed` | Error | Retry, Close | Stable concise error |

The controls must be selected from `phase` and artifact presence. They must not infer playback from
an optimistic React boolean. `playing` is published only by the audio driver's actual playing event.

An audio-load or autoplay error may leave an artifact in `ready` with `error` populated. That is an
active session, not a preparation failure. The controls remain available so an explicit Play can
recover; the status line surfaces the concise audio error until playback succeeds.

### Preparation labels

Map `NarrationProgress.stage` consistently with Codex while keeping the copy viewer-neutral:

| Stage | Label |
| --- | --- |
| `baseline` | Building pronunciation baseline |
| `languagePlanning` | Preparing speech N of M |
| `planning` | Planning natural speech chunks |
| `loadingModel` | Loading the voice model |
| `synthesizing` | Synthesizing audio P% |
| `finalizing` | Finishing audio |
| `ready` | Narration ready |

When a denominator is zero or unavailable, omit the numeric suffix rather than showing `0 of 0` or
`NaN%`.

## Local session identity and invalidation

The viewer-local target is never serialized:

```ts
export type MarkdownNarrationTarget = {
  filePath: string;
  modifiedAtMs: number | null;
  sourceHash: string;
};
```

`sourceHash` is computed from the exact Markdown string used to build the model. The implementation
may initially use the same deterministic synchronous source hash as Codex; the canonical server
artifact hash remains authoritative for media identity. The local hash is a presentation fence, not
a security primitive.

The active renderer may paint only when all of these match:

- the client target file path equals the ready file path;
- the target source hash equals the current model source hash;
- the client has a decoded artifact whose block ids belong to the current model.

The following transitions close or cancel the session and synchronously clear paint:

- the active route navigates to a different file;
- the file store moves from ready to loading, unsupported, error, or idle;
- the same path loads different content or modification metadata;
- Reload viewer is selected;
- Close tab is selected;
- the model fails its render-binding integrity check.

Open tabs is different: it delegates to the host overview and lets the shared lifecycle pause the
audio or allow background preparation to finish. When the viewer resumes, an artifact that became
ready in the background remains `ready`; playback requires Play.

## Authoritative Markdown narration model

### Why this model exists

`react-markdown` renders from Markdown source, but its final DOM text is not a safe narration input:

- Markdown punctuation is absent from visible prose;
- formatting can split one logical sentence over several DOM leaves;
- KaTeX contains visual and accessibility representations of the same formula;
- highlighted code and Mermaid replace or expand their initial DOM;
- alert labels are viewer chrome, not source prose;
- tables need explicit cell and row separators for a useful structural transcript;
- sanitized raw HTML can differ from its source string.

The implementation therefore adds a pure `buildMarkdownNarrationModel(markdown)` boundary. It uses
the same remark/rehype configuration as the renderer and returns both the wire document and local
render bindings.

```ts
export type MarkdownNarrationModel = {
  document: NarrationSourceDocument;
  blocks: MarkdownNarrationBlock[];
  sourceHash: string;
};

export type MarkdownNarrationBlock = {
  id: string;
  kind: NarrationBlockKind;
  highlightMode: NarrationHighlightMode;
  text: string;
  leaves: MarkdownNarrationLeaf[];
  renderKey: string;
};

export type MarkdownNarrationLeaf = {
  end: number;
  kind: 'element' | 'text';
  renderKey: string;
  start: number;
  text: string;
};
```

`renderKey` is local deterministic structural metadata used to match the second synchronous
React-Markdown transform to the authoritative model. It is not sent to the server and is not used
as artifact identity.

### Shared parsing configuration

Factor the current pipeline configuration out of `MarkdownRenderer.tsx` so model construction and
rendering import the same definitions:

- `remark-gfm`;
- the current GitHub-alert transform;
- `remark-math`;
- `rehype-raw`;
- the current sanitization schema;
- `rehype-katex`.

Add direct Narrate workspace dependencies for any unified parser/bridge packages the model imports;
do not rely on accidental transitive dependencies from React Markdown.

The pure model builder runs the synchronous unified pipeline through the same sanitized and KaTeX-
expanded HAST shape used for rendering. A renderer plugin then derives the candidate block sequence
from its tree, compares `id`, `kind`, `highlightMode`, and exact logical `text` with the cached model,
and only after equality adds trusted narration attributes. Because this plugin runs after
sanitization, source HTML cannot forge `data-narration-*` bindings.

Parsing twice inside two libraries is acceptable only because one shared deterministic projection
function validates equality before controls become enabled. Two separately implemented text walkers
are not acceptable.

### Block discovery and IDs

Narration blocks are ordered leaf reading units. Use deterministic source-order ids `md:0`, `md:1`,
and so on for the Narrate viewer. IDs need to be stable for the unchanged document and unique within
it; a changed document has a different local target and artifact identity.

Discover blocks as follows:

- `h1` through `h6` become `heading` / `text`;
- prose paragraphs become `paragraph` / `text`;
- prose inside a list item becomes `listItem` / `text`;
- prose inside a blockquote becomes `blockquote` / `text`;
- fenced or indented code becomes `code` / `block`;
- Mermaid code becomes `diagram` / `block`;
- a complete table becomes one `table` / `block`;
- display math becomes `code` / `block` so it uses the existing structural-transcript path;
- horizontal rules and non-text media are omitted;
- empty or whitespace-only candidates are omitted.

For nested context, the nearest supported semantic container determines the prose kind. Blockquote
context takes precedence over a surrounding list-item context. Tight and loose list markup must
produce the same logical `listItem` block contract even though their HAST wrappers differ.

Standalone raw HTML is narratable only when the sanitized result contains a supported semantic
block above. Arbitrary visible text directly inside an unclassified `div` is omitted in v1 rather
than guessed into a block. This limitation must have an explicit fixture and may be expanded later.

### Logical text rules

For text-highlight blocks, walk supported visible inline content in display order:

- ordinary text contributes its exact string;
- emphasis, strong, deletion, and links contribute their child text without Markdown delimiters;
- inline code contributes its displayed code value;
- a hard or soft line break contributes `\n`;
- an image contributes no text in v1;
- task-list checkboxes and footnote-backlink chrome contribute no text;
- sanitized inline HTML contributes its visible supported text;
- inline math contributes its TeX annotation as one indivisible element leaf.

Inline math is intentionally an element leaf. If a returned word or sentence range intersects that
logical leaf, the viewer paints the complete rendered formula element instead of attempting to map
TeX character offsets into KaTeX's duplicated visual/MathML subtree. Special inline-math speech
projection is outside this pass.

For structural blocks:

- code and display math use their source code/formula with one trailing newline removed;
- Mermaid uses its diagram source;
- table cells are joined with ` | ` and rows with `\n`;
- structural blocks publish no text leaves because their public highlight mode is `block`.

All offsets are accumulated with JavaScript string length and are therefore UTF-16 code units. A
leaf range is half-open, nonempty, within its block, and ordered. Separator-only logical text such as
the ` | ` between table cells does not need a DOM leaf because structural blocks are painted whole.

### Integrity validation

Before Narrate is enabled, validate:

- document schema version and offset encoding are the existing constants;
- block ids are nonempty and unique;
- block text is nonempty after trimming;
- text-mode leaves are ordered, nonoverlapping, and within the block text;
- concatenated leaf text plus declared logical separators reconstructs the block text exactly;
- every text-mode alphanumeric range belongs to at least one paintable leaf or one declared
  indivisible element leaf;
- the renderer-derived candidate document exactly equals the cached authoritative document;
- every returned DOM block id is known to the current model.

An integrity failure disables Narrate for that revision and surfaces one stable viewer integration
error. It must not send a different document, fall back to `textContent`, or downgrade all prose to
block highlighting.

## DOM binding contract

After sanitize and content transformation, the renderer adds trusted attributes:

```html
<p data-narration-block-id="md:1" data-narration-surface="text">
  <span
    data-narration-leaf-kind="text"
    data-narration-text-start="0"
    data-narration-text-end="12"
  >Visible text</span>
</p>
```

Element leaves, such as inline KaTeX, receive the same start/end attributes on the outer stable
element with `data-narration-leaf-kind="element"`. Structural block roots receive only the block id
and `data-narration-surface="block"`.

The structural root is the logical timing and seek target; it is not necessarily the visible
rounded container. Every structural renderer must also expose exactly one explicit visual surface:

```html
<div data-narration-block-id="md:4" data-narration-surface="block">
  <div data-narration-render-surface="code">...</div>
</div>
```

Use `code`, `table`, or `diagram` as the render-surface value. The code surface is the syntax
highlight container (or the rendered display-math root), the table surface is its rounded scroll
wrapper, and the diagram surface is the Mermaid card. The DOM registry resolves this relationship
once and requires exactly one matching surface. It must not infer a surface from CSS classes or
fall back to the logical wrapper. Seeking remains attached to the logical block id, while structural
paint, focus bounds, resize observation, and auto-follow geometry use the visual surface.

The React Markdown component overrides must forward trusted narration props. In particular, the
current `pre` wrapper drops incoming props and must be corrected so code/diagram block identity is
not lost. New list-item or prose wrappers required for tight-list bindings must preserve visual
layout and semantics.

The DOM index is rebuilt when any of these change:

- the model identity changes;
- React commits a new Markdown tree;
- asynchronous code highlighting or Mermaid rendering replaces descendants;
- a relevant mutation invalidates an element leaf.

Use a root-scoped registry or index rather than global selectors. At most one current Markdown
document may be registered by one viewer instance.

## Highlighting

### Text-mode blocks

For every current sentence and word cue:

1. Locate the current block root by `blockId`.
2. Select leaves whose half-open logical ranges intersect the cue.
3. For ordinary text leaves, convert the local intersection to one or more browser `Range` objects.
4. For an indivisible element leaf, select the whole element when any part intersects.
5. Paint sentence rectangles as context and word rectangles as foreground.
6. Clip/position rectangles relative to the narration block surface without changing document
   layout.

The foreground unit remains the server-provided source word. Formatting boundaries may produce
several rectangles for one word; they remain one semantic cue.

### Block-mode blocks

If the current sentence has no public word cues or its block uses `highlightMode: "block"`, apply a
whole-block narration class to the registered structural surface. The class changes the surface's
existing border color and adds an inset ring plus a soft shadow that follows its border radius; it
must not draw a rectangular outline around an outer logical wrapper. Code highlighting, table
scroll wrappers, Mermaid output, and display math retain their layout.

### Paint lifecycle

The Narrate paint controller subscribes to the client store and the DOM index. It clears stale
paint before applying a new cue. It also repaints after:

- document resize/reflow;
- font readiness;
- Mermaid or syntax-highlighting completion;
- a relevant DOM registry rebuild.

Paint classes and overlay layers are Narrate-prefixed. Do not depend on Codex class names or import
the Codex paint controller.

## Seeking and document follow

The Markdown content shell handles tap-to-seek while the current document owns an active artifact.
A tap seeks only when:

- it resolves to a known `data-narration-block-id`;
- the target is not within a link, button, or other interactive control;
- the browser selection is collapsed;
- the client phase is `ready`, `buffering`, `playing`, or `paused`.

Seeking uses `seekToBlock(blockId)`. It preserves play/pause intent through the shared client.

Auto-follow is enabled when a session starts. On a focus intent, scroll only if the active block or
foreground word is outside a padded reading band; do not continuously center every word. Explicit
previous, next, or tapped-block seeks may use smooth scrolling. Ordinary playback follow should use
the least motion necessary to keep the cue in the reading band.

Wheel, touch, or pointer-driven scrolling while narration is active calls
`suspendFollowByUser()`. The active action bar exposes the same persistent auto-scroll toggle as the
Codex viewer. Its enabled state is visually distinct and its accessible label changes between
`Disable narration auto-scroll` and `Enable narration auto-scroll`. An explicit
previous/next/tap seek or pressing Play after manual suspension re-enables follow before performing
the action. A deliberate toggle to Off remains Off across playback progress; explicit seeks may
still bring their destination into view once. Programmatic narration scrolling must not suspend
follow ownership.

## Action-bar controls

The existing left side remains:

```text
Open tabs | Narrate menu
```

The right side is owned by one `NarrationActions` component.

### Off

Show one primary Narrate action:

- icon: `AudioLines`;
- accessible label: `Narrate markdown`;
- disabled unless the current file is ready, the model is valid, and at least one narration block
  exists.

Selecting it calls `start({ document, target })`. A fresh start requests automatic playback through
the existing controller behavior.

### Preparing

Show:

- a disabled busy action labelled `Preparing narration`;
- `Cancel narration preparation`, which awaits or safely launches `cancel()`.

Cancel immediately returns the presentation to Off. Late start/read/update responses remain fenced
by the shared controller.

### Active

Show, in order:

1. Auto-scroll toggle;
2. Previous narrated block;
3. Play narration or Pause narration;
4. Next narrated block;
5. Narration speed;
6. Close narration.

Previous and Next are disabled at their respective boundaries. During `buffering`, the playback
button displays a spinner and is disabled; navigation and Close remain usable. The speed trigger
shows the current value (`0.75x`, `1x`, `1.25x`, `1.5x`, or `2x`) and opens a viewer-kit action menu
aligned to the right.

Close narration calls `close()`, removes paint, releases follow ownership, and returns to Off. It
does not close the Markdown tab and does not delete a completed content-addressed server artifact.

### Error

Show:

- Retry narration, which calls the shared `retry()` only if the current file identity still matches
  the target;
- Close narration error, which calls `close()`.

If the document changed, automatically close the stale failed session and show a fresh Narrate
action instead of retrying the old request.

### Responsive constraint

The normal active layout must fit the reference narrow viewer width with the two existing left-side
actions. Do not add text labels beside playback icons or shrink the shared 39-by-36-pixel action
buttons. Match the Codex composer geometry with 16-pixel horizontal edge padding and 7-pixel gaps
inside each action group. At the 390-CSS-pixel reference phone width, the flexible gap between the
two groups may contract to 4 pixels so every button retains its full size. Button width must be a
non-shrinking flex constraint, not only a preferred CSS `width`. If a narrower platform cannot fit them,
preserve Auto-scroll, Play/Pause, Previous, Next, and Close; move only Speed into a compact overflow
menu. Never hide Cancel during preparation or Close during an active session.

## Status line

`MarkdownSurface` continues to pass one status node to `ActionBar`:

- Off: existing file name and size;
- Preparing: stage label and bounded numeric progress;
- Ready: `Narration ready · 04:42`;
- Buffering: `Loading narration audio`;
- Playing: `Block 6 of 24 · 01:18 / 04:42`;
- Paused: `Paused · Block 6 of 24 · 01:18 / 04:42`;
- Failed: stable concise error text.

Compute elapsed and total time from integer samples and the artifact sample rate. Formatting must
handle zero samples and missing artifacts without `NaN`, negative values, or property-access errors.
Long errors are truncated visually while the full value remains available through an accessible
description or title.

## Client integration

Add a Narrate-local client module:

```text
extensions/narrate/viewer/src/narration/
  client.ts
  NarrationActions.tsx
  narrationStatus.ts
  domIndex.ts
  paintController.ts
  followController.ts
```

`client.ts` constructs one `createNarrationClient<MarkdownNarrationTarget>` with:

- `createBrowserNarrationAudio()`;
- `createRemuxNarrationLifecycle()`;
- `createRemuxNarrationTransport()`;
- a React hook through `useNarrationClientStore`.

The viewer attaches the client exactly once for the mounted app lifetime and installs the paint and
follow controllers with cleanup. React Strict Mode or remounts must not duplicate notification or
lifecycle subscriptions; the package attachment refcount remains authoritative.

Add `@remux/narration-client: "*"` as a direct Narrate dependency. Import protocol types from the
package rather than recreating local wire interfaces.

Expose a development/test debug snapshot analogous to Codex, including:

- shared client debug state;
- current local target/model identity;
- DOM integrity status;
- currently painted block/sentence/word;
- viewer visibility state.

It must not expose source Markdown or other large document contents.

## Expected file changes

The implementation is expected to touch or add:

```text
extensions/narrate/package.json
extensions/narrate/viewer/src/App.tsx
extensions/narrate/viewer/src/markdown/MarkdownRenderer.tsx
extensions/narrate/viewer/src/markdown/MarkdownSurface.tsx
extensions/narrate/viewer/src/markdown/markdownPipeline.ts
extensions/narrate/viewer/src/markdown/narrationModel.ts
extensions/narrate/viewer/src/markdown/narrationBindings.ts
extensions/narrate/viewer/src/narration/client.ts
extensions/narrate/viewer/src/narration/NarrationActions.tsx
extensions/narrate/viewer/src/narration/narrationStatus.ts
extensions/narrate/viewer/src/narration/domIndex.ts
extensions/narrate/viewer/src/narration/paintController.ts
extensions/narrate/viewer/src/narration/followController.ts
extensions/narrate/viewer/src/styles.css
extensions/narrate/tests/
extensions/narrate/playwright.config.ts
package-lock.json
package.json
```

Exact filenames may be consolidated when a module would otherwise be trivial, but the ownership
boundaries above must remain visible.

No Narrate server or `remux-tts` source change is expected. A required server schema change is a
design blocker and must be surfaced rather than silently added to this viewer pass.

## Testing strategy

The tests are intentionally layered so routine verification stays fast while one real-stack gate
proves the full user experience.

### 1. Pure model tests

Add table-driven fixtures for:

- headings and paragraphs;
- emphasis, strong, deletion, links, and inline code;
- tight and loose ordered/unordered lists;
- nested blockquotes and list items;
- GitHub alerts without narrating the injected alert label;
- fenced code and one trailing newline;
- Mermaid diagrams;
- GFM tables with exact ` | ` and `\n` separators;
- inline and display math;
- sanitized raw HTML;
- emoji and supplementary-plane characters proving UTF-16 offsets;
- combining marks and punctuation;
- images, rules, empty blocks, and documents with no narratable content.

Every fixture asserts the complete wire document, block ordering/ids, highlight modes, leaf ranges,
and reconstruction invariant.

### 2. DOM binding and paint tests

Render real React Markdown and assert:

- the candidate projection equals the authoritative model;
- all block ids and trusted leaf offsets appear in the DOM;
- raw source HTML cannot forge a narration id;
- ranges cross emphasis/link/inline-code leaves correctly;
- one UTF-16 word cue paints the expected emoji-adjacent word;
- inline math selects the whole KaTeX element once, not duplicated MathML text;
- code, table, Mermaid, and display math paint their whole structural surfaces;
- resizing and asynchronous Mermaid/code completion repaint without changing layout;
- closing or changing the file removes every overlay/class.

### 3. Viewer lifecycle tests with mocked Narrate resources

Add a Narrate viewer Playwright harness and cover:

- Off -> Preparing -> auto-playing Active;
- cached immediate-ready response;
- progress labels for every server stage;
- Cancel while start is pending and cancellation ordering before a later start;
- Retry after a preparation failure;
- malformed external response becoming a stable Failed state through the shared decoder;
- background completion returning Ready without autoplay;
- backgrounding active playback becoming Paused;
- truthful buffering, playing, paused, ended, and audio-error controls;
- previous/next boundary disabling;
- speed persistence;
- tap-to-seek exclusions for links, buttons, and selected text;
- file navigation/revision change fencing a late response;
- cue-level auto-scroll keeping the foreground word or block inside the reading band;
- the visible auto-scroll toggle, manual scrolling suspending follow, and explicit playback
  navigation reclaiming only user-suspended follow;
- Reload, Close tab, and Open tabs using their distinct lifecycle behavior.

Use a small valid WAV served through the content-addressed media route so the browser's real
`HTMLAudioElement` advances. Do not replace the production client with a test-only UI store.

### 4. Real-stack smoke gate

Add one short Markdown fixture that includes prose plus one structural block. The real smoke test
must:

1. open the fixture in the actual Narrate viewer;
2. click Narrate markdown;
3. observe at least one real preparation stage;
4. wait for a decoded real artifact;
5. verify audio time advances while phase is `playing`;
6. verify a sentence context and word or structural highlight are visible;
7. pause, seek to another block, resume, and verify the active block changes;
8. background and foreground the viewer and verify it stays truthfully paused/ready;
9. close narration and verify audio and paint are gone.

This gate uses the actual Narrate server, Sol path, Misaki, Kokoro model, media route, shared browser
client, and viewer. It is a deliberate release/verification command rather than part of every fast
typecheck. Keep the fixture short and content-addressed so reruns reuse the completed artifact and do
not add an hour to routine turns.

### 5. Physical-viewer check

Before declaring the pass complete, perform one real viewer interaction on the target mobile
surface covering Play, background, foreground, Pause, seek, Speed, and Close. Automated mocked and
desktop-browser tests do not replace this check because WebView audio policy and lifecycle delivery
are platform-sensitive.

## Implementation sequence

### Pass 1: model and bindings

- Factor the shared Markdown pipeline configuration.
- Implement the pure narration model and strict integrity validation.
- Add trusted render bindings and forwarding through custom components.
- Land pure and DOM mapping tests before sending any narration request.

Exit criterion: fixtures reconstruct exact wire block text from registered logical leaves, including
UTF-16 and nested formatting cases.

### Pass 2: client and action bar

- Add the Narrate dependency and client instance.
- Attach lifecycle subscriptions.
- Add Off, Preparing, Active, and Error action-bar presentations.
- Add status formatting and file-revision fencing.

Exit criterion: a mocked valid artifact drives truthful real browser audio controls and all
cancel/retry/background transitions.

### Pass 3: paint, seek, and follow

- Add the DOM index and overlay controller.
- Add text and structural paint.
- Add tap-to-seek, previous/next scrolling, and manual-scroll suspension.
- Add reflow and asynchronous-render repaint handling.

Exit criterion: word, sentence, and structural highlights move with audio and never paint a stale
document.

### Pass 4: realistic verification

- Add the real-stack smoke command and short fixture.
- Run the fast model/viewer suites, shared-client suite, typecheck, and Narrate build.
- Run the real-stack smoke and physical-viewer check.
- Record any environment-only prerequisite separately from product correctness.

## Acceptance criteria

The pass is complete only when all of the following are true:

- a loaded narratable Markdown file exposes Narrate markdown on the action-bar right side;
- preparation has visible truthful progress and can always be cancelled;
- one decoded artifact produces real audio through `@remux/narration-client`;
- active controls reflect actual buffering/playing/paused state;
- sentence, word, and structural highlighting use artifact offsets against the exact submitted block
  text;
- nested formatting and UTF-16 text cannot drift from DOM ranges;
- tap/previous/next seeking targets public block timings;
- playback follows the foreground cue within a stable reading band and exposes a truthful
  auto-scroll toggle;
- lifecycle backgrounding never leaves UI saying Playing while audio is paused;
- a changed file revision cannot receive stale paint or playback;
- viewer reload/close clears its session, while Open tabs preserves a paused/preparing session;
- no Codex playback implementation is copied into Narrate;
- no fallback, alternate source extractor, or block-level downgrade hides an integrity failure;
- fast tests and the real-stack smoke both pass.

## Explicit non-goals

- generation streaming or partial playback;
- narration of image pixels or generated image descriptions;
- a new `math` wire block kind or special inline-math transcript protocol;
- editing Markdown or live-updating a narration in place;
- persistence of the active playback position across a full viewer reload or app restart;
- multiple simultaneous narration sessions;
- moving Narrate controls or CSS into the shared client package;
- changing Sol prompts, Misaki behavior, acoustic chunking, Kokoro inference, or artifact schemas.
