# Codex Assistant Math Rendering

Status: Active Spec
Last verified: 2026-08-19
Canonical code: extensions/codex/viewer/transcript/components/markdown/, extensions/codex/viewer/transcript/layout/measureCollapsed.ts, extensions/codex/viewer/transcript/layoutStore.ts, extensions/codex/viewer/transcript/resourceStore.ts, extensions/codex/server/src/live_transcript.rs, packages/narration-client/src/protocol.ts

## Purpose

Render mathematical notation in Codex assistant messages without weakening the
transcript's existing guarantees:

- app-server and the Codex extension server remain authoritative for message
  text;
- streaming remains append-oriented and tolerant of delimiters split across
  arbitrary deltas;
- measured transcript height remains deterministic for a given text, width,
  style, and math-metrics snapshot;
- code, links, copying, narration, scrolling, and virtualized history keep their
  current semantics;
- malformed or unsupported TeX remains readable literal source and cannot blank
  an assistant response.

The motivating input must render as one display equation, including the newline
inside the second text command:

    \[
    \text{observed price} = \text{slow reference} + \text{temporary
    impact} + \text{new information}
    \]

This is a viewer feature. It does not introduce a math item into the Codex
app-server protocol and does not require server-side KaTeX rendering.

## Decision Summary

1. Support both display and inline math. Display-only support is not a complete
   product because ordinary Codex explanations frequently mix prose with short
   symbols, units, bounds, and equations.
2. Ship the implementation in two engineering phases: display math first, then
   inline math after atomic width and variable line-height measurement pass the
   exact-layout gates. The feature is complete only when both phases land.
3. Accept \[...\] and $$...$$ for display math. Accept \(...\) and a
   conservative $...$ form for inline math.
4. Prefer backslash delimiters in any optional model-format hint because they
   are unambiguous. Do not make correctness depend on a prompt or on one
   delimiter style.
5. Parse the complete accumulated assistant-message snapshot on every transcript
   refresh. Never carry a delimiter parser state across app-server delta
   boundaries.
6. Treat item/completed text, as projected by the extension server, as
   authoritative. A completed message is reparsed from that final text even if
   it differs from concatenated deltas.
7. Render unmatched, invalid, unsafe, or over-limit math literally. Never invent
   a closing delimiter and never hide the remainder of a response.
8. Use KaTeX through a narrow adapter with an exact direct dependency, public
   rendering APIs, bounded options, a math-specific error boundary, and a
   literal-source fallback.
9. Measure rendered math in one hidden browser-owned measurement surface. Batch
   missing measurements, wait for the KaTeX fonts used by that batch, publish
   one metrics revision, and let the transcript layout store perform its normal
   anchored remeasurement.
10. Separate mutable streaming caches from durable completed-document caches.
    Streaming prefixes must not evict completed history.

## Implementation Closeout

The viewer implementation landed on 2026-08-19. This spec remains `Active
Spec` until physical-phone validation is recorded, but the desktop/mobile
automated implementation is present and enabled without a feature flag.

The implementation made five deliberate adaptations from the preimplementation
module-level plan below:

1. It uses a Markdown-context-aware, equal-length source mask rather than a
   custom micromark tokenizer. The model first parses the unmodified snapshot to
   obtain exact code/inline-code/HTML ranges. `mathSyntax.ts` adds fenced-code,
   URL/autolink, angle-tag, and link-destination protection, applies the one
   canonical delimiter policy, and masks each recognized range with repeated
   private-use markers. The standard GFM MDAST parser then runs on the masked
   source. This keeps parser precedence, exact UTF-16 offsets, original source,
   and the current Markdown model without relying on global delimiter
   substitution.
2. Missing valid formulas are synchronously rendered and measured in the one
   hidden DOM surface because the current collapsed-layout API is synchronous.
   `document.fonts.ready` and `loadingdone` invalidate those measurements,
   publish one math revision, clear transcript measurement entries, and force
   an authoritative layout-store remeasurement. The visible Markdown component
   and collapsed layout both key their document on that revision. This replaces
   the planned pending-literal batch and row-carried snapshot with a synchronous
   initial snapshot plus coherent font-driven revision.
3. The small math renderer and error boundary live in `MarkdownBlock.tsx`
   instead of a separate `MathNode.tsx`; the trust boundary remains the branded
   output of `katexAdapter.ts`.
4. On completion, the final authoritative message is rendered through the
   completed cache tier and the segment's transient tiers are released. The
   implementation does not bulk-promote a streaming map, because that could
   retain formulas from a superseded prefix; only nodes referenced by the final
   reparse enter durable caches.
5. Display HTML exposes browser break opportunities between the outer-level
   `.base` chunks emitted by the exact pinned KaTeX version. Those chunks follow
   KaTeX's TeXBook-safe relation and binary-operator boundaries, so a long chain
   may wrap after an outer `=`, `+`, or similar operator while material inside a
   fraction, brace group, array, or other atom remains intact. Natural and
   constrained display measurements use separate cache keys, and the constrained
   form is measured at the exact Markdown width. Short displays remain centered;
   constrained displays use the readable leading edge; an expression with no
   usable boundary retains local horizontal scrolling. Display padding is four
   CSS pixels above and below instead of the original twelve-pixel draft.

Current automated closeout:

- `npm run typecheck`: passed;
- `npm run test:codex -- --workers=8`: 372 passed across desktop and mobile;
- `npm run test:codex-server`: 170 passed, 1 ignored fixture validation;
- `npm run test:codex:narration-real`: 3 passed, including real WAV
  synthesis/playback, structural alignment, and multiwindow deterministic cache;
- `npm --workspace @remux/codex run build`: passed;
- focused parser fixtures cover every UTF-16 prefix of an astral-character
  formula, all delimiter forms, protected Markdown contexts, currency/shell/URL
  ambiguity, source/count limits, invalid and trust-requiring TeX, and transient
  cache isolation;
- focused route fixtures cover MathML, inline baseline/height, exact modeled
  height, safe display wrapping, unbreakable inline/display scrolling, capped
  tall-display scrolling, document-width containment, literal security
  fallback, and inline narration paint on desktop and mobile.

Physical-phone validation remains the only status gate that cannot be completed
in the repository test environment.

## Why This Is a Viewer Concern

The Codex app-server exposes an agentMessage item containing accumulated text.
Its item/agentMessage/delta notification appends text, while item/completed
provides the authoritative final item. Neither the item schema nor the delta
schema attaches Markdown or TeX semantics to ranges of that string.

The extension server already follows the correct ownership model:

1. append incoming agent-message deltas to its live accumulated text;
2. project the current full text into the transcript resource;
3. replace or settle that state from the authoritative completed item;
4. invalidate the viewer resource;
5. let the viewer parse the full snapshot.

Math does not change that flow. In particular:

- no server-side delimiter buffering is added;
- no raw delta is sent directly into a React math component;
- no protocol flag announces that a message contains math;
- no persisted rendered HTML is added to transcript resources;
- no dependency on app-server chunk boundaries is introduced.

This keeps disk history, live overlay, cold reopen, reconnect, and streaming on
one rendering path.

## Goals

- Render common Codex-generated LaTeX predictably in assistant prose.
- Handle the motivating multiline display expression.
- Support short inline formulas without confusing ordinary dollar amounts or
  shell syntax.
- Preserve original text exactly for copy and final fallback.
- Keep fenced code and inline code literal.
- Keep transcript measurement and rendered geometry within the existing
  one-CSS-pixel acceptance tolerance.
- Keep the viewport width contained; long displays wrap at safe outer
  operators, while unbreakable display and inline equations scroll locally.
- Make every failure local to one math node.
- Give screen readers useful MathML and give Remux narration a deterministic
  logical source.
- Bound parse, expansion, rendering, measurement, and cache costs.
- Produce the same completed model and DOM whether the text arrived at once or
  through any sequence of streaming deltas.

## Non-Goals

- A general WYSIWYG equation editor.
- Math input assistance in the composer.
- Server-side image, SVG, MathJax, or LaTeX-to-PDF rendering.
- Full AMS LaTeX or arbitrary TeX execution.
- Guessing that plain prose such as x squared is mathematical notation.
- Reinterpreting math inside fenced code, inline code, raw HTML, URLs, or link
  destinations.
- Making Codex promise a delimiter dialect that the app-server protocol does not
  promise.
- Replacing the custom Codex Markdown model with ReactMarkdown.
- Replacing the transcript's measured layout with intrinsic browser sizing,
  ResizeObserver-per-block behavior, or t3code's list-sizing model.
- Adding a math value to NarrationBlockKind in the first version.

## User-Facing Syntax

### Supported delimiters

| Kind | Preferred form | Compatible form | Result |
| --- | --- | --- | --- |
| Display | \[...\] | $$...$$ | Centered when short; safely wrapped or locally scrollable when constrained |
| Inline | \(...\) | conservative $...$ | Atomic expression on the prose baseline |

The backslash forms are preferred because they do not overlap with currency or
shell syntax. Dollar forms are accepted because models, documentation, and
users commonly produce them.

Delimiter characters are removed from the KaTeX input but retained in the
node's originalSource field. Copying an assistant message continues to copy the
original transcript string, not a normalized or speech-oriented projection.

### Context precedence

Existing Markdown constructs win before math:

1. fenced and indented code;
2. inline code;
3. autolink and Markdown link destinations;
4. escaped characters;
5. math;
6. ordinary emphasis and text handling.

Inline math may appear in link labels because the label is visible phrasing
content. Math is never parsed in the link destination. Display delimiters inside
a heading, table cell, or link label remain literal because those contexts do
not own block children. Inline delimiters remain supported in headings and table
cells.

A fenced latex or tex block remains a code block. The user explicitly chose code
semantics and must get exact source, code copying, and code narration.

### Display delimiter rules

A display opener is either an unescaped \[ or an unescaped pair of dollar
characters. Its matching closer is \] or another unescaped pair of dollar
characters of the same form.

Display math may span lines. A one-line form is also accepted:

    \[E = mc^2\]

    $$E = mc^2$$

At root level, in a blockquote, or in a list item, display math becomes a
mathDisplay block. If a complete display expression occurs between prose on the
same logical Markdown line, the parser splits the surrounding prose into a
paragraph, a display block, and a following paragraph. Empty surrounding
paragraphs are omitted.

Three or more adjacent dollar characters are not display delimiters. This avoids
claiming unrelated dollar runs and leaves future Markdown extensions room to
define them.

Line endings passed to KaTeX are normalized from CRLF to LF. All other
whitespace, including newlines inside a text command, is preserved. Original
source remains untouched for copying and fallback.

### Backslash inline rules

An inline expression starts with an unescaped \( and ends with an unescaped \).
It must be non-empty after trimming and may not cross a blank line. An ordinary
single line break is normalized to a space for rendering while original source
is retained.

This is the most reliable inline form and is the form an optional output-format
hint should request.

### Conservative single-dollar rules

A single-dollar expression is recognized only when all of these conditions hold:

- opener and closer are each exactly one unescaped dollar character;
- neither delimiter is adjacent to another dollar character;
- the opener is not followed by whitespace;
- the closer is not preceded by whitespace;
- the body is non-empty and does not contain a line break or unescaped dollar;
- the body is not only a currency-like number made of digits, grouping
  separators, and a decimal separator;
- the candidate is outside code, raw HTML, and link destinations;
- the complete pair is available in the current snapshot.

Examples:

| Source | Interpretation |
| --- | --- |
| $x$ | inline math |
| $O(n^2)$ | inline math |
| $5x$ | inline math |
| \(5\) | inline math |
| $5 | literal currency |
| $5.00 | literal currency |
| $5.00 and $10.00 | literal currency |
| $HOME | literal shell text |
| dollar-brace environment syntax | literal shell text |
| $(command) | literal shell text |
| \$x\$ | literal text |

A purely numeric inline formula should use \(...\). When a single-dollar
candidate is ambiguous, literal text wins. The initial implementation must keep
these rules in one scanner and a table-driven fixture corpus; parser and renderer
code must not each invent their own dollar heuristic.

## Parser Architecture

### Do not rewrite with regular expressions

A global substitution from \[...\] to $$...$$ is not acceptable. It would
rewrite code examples, link destinations, escaped delimiters, and malformed
streaming tails before Markdown has established context. It would also lose the
exact source spans needed by narration and literal fallback.

Add a Markdown-aware micromark extension used by mdast-util-from-markdown. The
extension recognizes all four delimiter forms while participating in
micromark's normal construct precedence. It has two cooperating constructs:

- a flow construct for display delimiters that already occupy a block position;
- a text construct for inline math and complete display candidates embedded in
  phrasing content.

The mdast bridge initially emits inlineMath and an internal
remuxMathDisplayCandidate phrasing node. A required normalization pass then
splits the containing paragraph around each allowed display candidate and lifts
the candidate into a standard math block. It never inserts a block node directly
into paragraph children. Candidates in headings, table cells, and link labels
become literal nodes instead of being lifted.

Only the normalized tree enters rootContentToRawBlocks. The standard-shaped
inlineMath and math nodes carry Remux metadata:

    type MathDelimiter = 'backslashDisplay' | 'dollarDisplay'
      | 'backslashInline' | 'dollarInline';

    type MathSource = {
      delimiter: MathDelimiter;
      originalSource: string;
      sourceEnd: number;
      sourceStart: number;
      tex: string;
    };

sourceStart and sourceEnd are UTF-16 code-unit offsets into the exact assistant
message snapshot. The range includes delimiters. tex excludes delimiters and is
the only string passed to KaTeX.

The extension should live beside the Codex Markdown model rather than in the
Narrate extension. Narrate's remark-math pipeline is a useful precedent for
KaTeX rendering and math narration, but its default dollar grammar does not
recognize \[...\] and does not implement Remux's currency policy.

### Recovery nodes

The raw model has three math outcomes:

    type RawMarkdownMath =
      | { type: 'mathDisplay'; math: MathSource }
      | { type: 'mathInline'; math: MathSource }
      | {
          type: 'mathLiteral';
          originalSource: string;
          placement: 'block' | 'inline';
          reason: 'incomplete' | 'invalid' | 'overLimit' | 'unsupportedContext';
          sourceEnd: number;
          sourceStart: number;
        };

During streaming, a recognized unmatched backslash or double-dollar opener may
produce a transient incomplete mathLiteral node covering the current candidate
tail. It is rendered as exact text and is never sent to KaTeX. On a completed
message, an unmatched opener is preserved as exact literal text without
claiming unrelated Markdown after the opener.

A matched delimiter first produces a math node. KaTeX validation may later
resolve that node to either valid metrics and markup or an invalid literal
fallback. Invalid source is never reparsed as Markdown; otherwise TeX
characters such as underscores and asterisks could change meaning during error
recovery.

MarkdownRenderOptions gains an explicit cacheScope and mathMetricsSnapshotId.
cacheScope.kind is also the parser's streaming-versus-complete signal; parser
code must not rediscover message lifecycle by inspecting the text. Rendering
and measureCollapsed pass the same options for the same assistant segment.

### Block projection

Extend RawMarkdownBlock, PreparedMarkdownBlock, and MarkdownLayoutBlock with a
mathDisplay variant. Extend MarkdownInline, MarkdownInlineSource, prepared rich
items, and layout fragments with a math variant.

Display math is a first-class measured block, not a code block styled to look
like an equation. The narration projection may classify it as code, but the
render and layout models must retain its math identity.

Use source-derived node keys for math:

    math:<sourceStart>:<hash(delimiter + tex)>

Appending a streaming suffix then preserves identity for already-complete math
nodes. This is a local stability improvement and does not require replacing the
current block-key scheme for every Markdown type.

## Streaming Contract

### Snapshot states

For any possible math expression, a current accumulated snapshot has one of
these states:

| State | Viewer behavior |
| --- | --- |
| No opener | ordinary Markdown |
| Opener without closer while turn is in progress | exact literal source; no KaTeX call |
| Complete delimiter pair, validation pending | exact literal source while measurement is queued |
| Complete and valid | KaTeX math |
| Complete but invalid or over limit | exact literal source |
| Unmatched opener after item completion | exact literal source |

The transition from literal source to KaTeX is atomic for the math node. The
viewer may change the node's measured height when validation completes, but it
must publish the replacement layout through the normal layout-store transaction
so scroll anchoring sees one coherent before/after snapshot.

### Arbitrary delta boundaries

The implementation must work when streaming boundaries occur:

- before or after either character of \[ or \(;
- between the two dollar characters of a display delimiter;
- at every UTF-16 code-unit boundary inside the TeX body;
- between either character of \] or \);
- between the two characters of the closing display delimiter.

No parser state is keyed by delta number, WebSocket frame, resource revision, or
the 125 ms transcript refresh cadence. Each refresh reparses the full
accumulated segment text. This is inexpensive at the bounded transcript-window
scale and makes reconnect and cold reopen identical to live rendering.

### Authoritative completion

When a turn settles:

1. the extension server projects the final authoritative agentMessage text;
2. the resource revision changes;
3. the viewer discards the streaming snapshot for that message;
4. the final text is parsed from the beginning;
5. the final parse and math results are eligible for durable caches.

Tests must include a completed item whose text is not byte-for-byte equal to the
concatenated deltas. The rendered result must follow the completed item.

### No synthetic repair

Do not append synthetic delimiters, run a streaming-Markdown repair library, or
ask KaTeX to render a partial formula. Synthetic repair can make an incomplete
fraction look authoritative, can swallow prose after a mistaken opener, and can
produce large height oscillations as braces arrive.

Progressive literal source is the reliable fallback. Prose outside the
candidate continues to stream normally.

## KaTeX Adapter and Safety

Add KaTeX as an exact direct dependency of the Codex extension even though
Narrate currently brings it into the repository. Codex must not rely on a
sibling extension's transitive dependency. Pin the exact version in
extensions/codex/package.json and package-lock.json; upgrade it deliberately
with the geometry fixture suite.

All rendering and validation goes through one adapter. The adapter uses public
KaTeX APIs and the same options for the visible renderer and hidden measurement
surface:

    {
      displayMode,
      globalGroup: false,
      macros: {},
      maxExpand: 1000,
      maxSize: 20,
      output: 'htmlAndMathml',
      strict: 'warn',
      throwOnError: true,
      trust: false
    }

The adapter catches parse and render errors, rate-limits diagnostics, and returns
a typed invalid result. It must not expose a raw exception to React or the
transcript layout pass.

Hard bounds:

- at most 16,384 UTF-16 code units in one formula;
- at most 128 recognized formulas in one assistant message;
- at most 1,000 macro expansions, enforced by KaTeX;
- no shared mutable macro dictionary between formulas;
- no trusted URLs, HTML commands, protocols, or custom trust callback;
- no persistence of generated markup in transcript resources.

If a limit is reached, the candidate remains literal. The rest of the message
continues through the normal Markdown parser.

Generated KaTeX HTML may enter the DOM only through a math-specific component
and only through a branded adapter result. Raw model text must never reach
dangerouslySetInnerHTML. The component is wrapped in a math-specific render
error boundary whose fallback is originalSource rendered as a text node.

Import the exact KaTeX CSS from the Codex viewer entrypoint and override only
container geometry, colors, margins, and overflow in Codex-owned styles. Do not
copy the generated KaTeX stylesheet into Remux.

## Exact Measurement

### Why CSS-only intrinsic sizing is insufficient

The transcript virtualizer measures collapsed turns before their active rows are
necessarily mounted. MarkdownBlock then renders with an explicit pixel height.
Allowing KaTeX to choose an intrinsic height after that measurement would cause
clipping, incorrect spacers, broken sent-message anchoring, and narration paint
offsets.

Display math needs exact content height. Inline math also needs atomic width,
ascent, and descent because fractions, matrices, sums, and superscripts may be
taller than the surrounding prose line.

### MathMetricsStore

Add one browser-owned MathMetricsStore with this result:

    type MathMetrics = {
      ascent: number;
      depth: number;
      height: number;
      html: TrustedKatexMarkup;
      naturalWidth: number;
      status: 'valid';
    };

    type MathMetricResult =
      | MathMetrics
      | { reason: string; status: 'invalid' }
      | { status: 'missing' };

The cache key includes:

- exact KaTeX version;
- a Codex math-style fingerprint;
- display versus inline mode;
- density and containing font variant;
- normalized TeX passed to KaTeX.

Color is not part of the geometry key. Width is natural intrinsic width and is
also not part of the key.

### Hidden measurement surface

The store owns one offscreen, non-interactive DOM root attached to document.body.
It uses the exact KaTeX and Codex font-size CSS applied by the visible math
component. It must not use visibility: collapse, display: none, transforms that
scale geometry, or a different zoom.

For a batch of missing keys:

1. validate and render each candidate through the adapter;
2. append all valid markup plus zero-size baseline probes to the hidden root;
3. allow the referenced KaTeX font faces to load and await document.fonts.ready;
4. read all bounding rectangles in one read phase;
5. derive inline ascent and depth from the baseline-probe coordinate;
6. round only at the final CSS-pixel boundary used by the Markdown model;
7. remove the temporary nodes;
8. publish one store revision with the complete batch.

There is no ResizeObserver per formula. Theme-only color changes do not
remeasure. Browser zoom, root font-size changes, KaTeX stylesheet changes, or a
font loading event that changes the probe geometry invalidate the applicable
metric keys and dirty only turns that reference them.

While a key is missing, the layout model measures and renders originalSource as
literal text. Once the metrics batch publishes, the layout store remeasures the
affected turns and applies its existing viewport-anchor correction. The visible
renderer and collapsed measurement must read the same metrics snapshot.

MathMetricsStore is not a second UI store. It publishes internally to
layoutStore. layoutStore resolves all affected turns against an immutable
metrics snapshot and publishes the new measured row heights plus that snapshot
id in its existing external-store transaction. MarkdownBlock receives the
snapshot id from its measured row and must not subscribe independently to
MathMetricsStore. This prevents visible KaTeX from upgrading one React commit
before the virtualizer receives its matching height.

Unit tests inject a deterministic MathMetricResolver. Browser geometry tests use
the real MathMetricsStore and bundled fonts. Pure parsing tests do not require a
DOM.

### Display layout

mathDisplay has:

- the ordinary Markdown inter-block top gap;
- four CSS pixels of Codex-owned padding above and below;
- centered content when its natural width fits;
- leading-edge alignment and browser wrapping at KaTeX's outer relation and
  binary-operator chunks when constrained;
- a local horizontal scroller when no safe boundary can make the expression
  fit;
- no KaTeX default one-em outer margin;
- a measured content height based on the returned rectangle, with natural and
  exact-width constrained measurements kept under separate cache keys;
- a maximum visible height of 320 CSS pixels, after which the math block gets a
  local vertical scroller.

Its occupied width is the containing Markdown width. Its internal natural width
may exceed that width only for an unbreakable atom, but the transcript and
document body may not.

A display block counts as one logical line for maxLines-based collapsed user
messages. A clipped document must still clip at the already-measured block
boundary.

### Inline layout

An inline formula is one non-breaking PreText item. Its logical item text is the
delimiter-free TeX used by narration. Its geometry is replaced by the measured
math width:

    extraWidth = occupiedMathWidth - naturalWidth(logicalTexText)

The source metadata marks the item as math, so the renderer ignores the visible
PreText fragment string and mounts the KaTeX node in its place. The complete TeX
logical range remains available for narration.

If naturalWidth fits the available prose width, occupiedMathWidth equals
naturalWidth. If it is wider, occupiedMathWidth equals the available width and
the inline node becomes a local horizontal overflow island. PreText may move
that atom to the next visual line but must never let it widen the transcript.

The inline host owns that horizontal overflow. CSS otherwise assigns the
bottom edge of an overflowing inline block as its baseline, which would lift
the actual KaTeX baseline above adjacent prose. Hidden measurement temporarily
uses visible overflow to recover the host's true baseline depth, and the
renderer applies that measured depth as its `vertical-align` correction. This
keeps simple variables, subscripts, and tall fractions on the prose baseline
without a formula-specific fixed offset.

KaTeX's stock `.katex` rule also scales every formula to `1.21em`. The viewer
overrides that scale to `1em` only for inline math so a lone variable has the
same typographic size as the sentence around it. Display math retains KaTeX's
larger presentation scale.

Extend MarkdownLayoutTextLine with baseline-aware geometry:

    type MarkdownLayoutTextLine = {
      ascent: number;
      depth: number;
      fragments: MarkdownLayoutLineFragment[];
      height: number;
      width: number;
    };

For each visual line:

- ascent is the maximum prose or inline-math ascent;
- depth is the maximum prose or inline-math depth;
- height is at least the existing density-specific line height;
- the baseline is shared by all fragments;
- paragraph and heading content height is the sum of actual line heights, not
  line count multiplied by one constant.

Table rows, list children, blockquotes, capped-height calculation, and rendered
text-line styles must consume actual per-line heights. This refactor is the gate
for enabling inline math; shipping inline KaTeX inside the current fixed 18 px
line boxes is not acceptable.

## Caching

The current exact-string Markdown caches can admit hundreds of successive
streaming prefixes. Math would add generated markup and metric entries to that
pressure. Add explicit cache scope:

    type MarkdownCacheScope =
      | { kind: 'complete' }
      | { key: string; kind: 'streaming' };

Assistant rendering and collapsed measurement pass the assistant segment id as
the streaming key. Each streaming key owns only its latest raw, prepared, and
layout snapshot, plus at most one immediately previous snapshot needed for a
single React transition. Replacing the prefix replaces those entries; it does
not add them to the durable LRUs.

Completed messages use the existing bounded durable LRUs. Completion promotes
only the final raw, prepared, and laid-out document. Pending or invalid formula
prefixes never enter the durable KaTeX markup or metrics cache.

Math metrics and markup are cached only for complete delimiter pairs that pass
the source limits. A matched formula in an in-progress message may use or create
only that message's transient metric tier. Final completion promotes results
still referenced by the authoritative text into the durable tier and drops the
rest. Invalid results from completed messages receive a small bounded negative
cache so a bad completed formula is not reparsed on every render.

TranscriptMeasureCache entries for a turn include the applicable math-metric
digest. A metrics-store publication reports the assistant segment ids waiting
on each key, allowing layoutStore to dirty only affected turns instead of
invalidating the entire transcript.

This mutable-tail cache discipline is the most useful rendering lesson to bring
from t3code.

## Narration and Accessibility

KaTeX renders with htmlAndMathml output. The visual HTML branch remains hidden
from assistive technology in the standard KaTeX structure and the MathML branch
provides the accessible representation. A literal fallback is ordinary text.

No NarrationBlockKind protocol change is required:

- mathDisplay projects as kind code with block highlighting and delimiter-free
  TeX text, matching the existing Narrate math precedent;
- inline math remains part of its containing paragraph, heading, list item,
  blockquote, or table logical text.

For inline math, add an element narration leaf:

    type NarrationElementLeaf = {
      assistantMessageId: string;
      blockId: string;
      displayEnd: number;
      displayStart: number;
      element: HTMLElement;
    };

The logical narration text for an inline formula is normalized,
delimiter-free TeX. Any narration cue that overlaps that logical range paints
the whole formula element. The first version does not attempt glyph-level paint
inside KaTeX.

The text-leaf paint resolver must return both DOM Ranges and element rectangles.
This mirrors the Narrate viewer's existing distinction between text and element
leaves and avoids trying to highlight KaTeX's hidden annotation node.

Display math remains block-highlighted. The structural narration service may
turn its TeX into spoken prose just as it does for code-like structural blocks.
Improved deterministic math-to-speech can be a later narration version; it is
not a prerequisite for visual math.

Narration may start only from a completed assistant message, so transient
incomplete math never enters a narration document.

## Rendering and Interaction

- Original assistant-message copying is unchanged and therefore retains
  delimiters and exact source.
- A display math block may offer a node-local copy action later, but it is not
  part of the first pass.
- Text selection over the visible KaTeX output uses normal browser behavior.
- Clicking math does not navigate and does not focus the composer.
- Clicking a narrated display block retains the existing block seek behavior.
- Inline math inside a link label retains the enclosing link behavior.
- Long display formulas wrap at safe outer operators; unbreakable display and
  inline formulas scroll only inside their own math container.
- Light and dark themes share geometry. Math inherits the foreground color.
- Error fallback has no alarming error color; it uses the existing inline-code
  or code-like literal treatment plus a development-only diagnostic.

## t3code Comparison

The comparison is against pingdotgg/t3code commit
4347f14b89ed66777ae16def278fd44575ab499b, inspected on 2026-08-19.

At that snapshot t3code does not implement math rendering. Its ChatMarkdown uses
ReactMarkdown plus GFM/raw/sanitize-related plugins and has no remark-math,
rehype-katex, or KaTeX dependency. There is therefore no t3code math parser or
delimiter policy to copy.

Its relevant streaming pattern is:

1. append streaming message text in the thread reducer;
2. replace it with non-streaming final text when the final message arrives;
3. render the whole accumulated text through ReactMarkdown;
4. avoid reading or populating the durable Shiki highlighted-code cache while a
   code block is streaming;
5. place an error boundary and plain preformatted fallback around the expensive
   highlighted-code renderer.

Bring these principles into Remux:

- full-snapshot parsing rather than delimiter state tied to deltas;
- authoritative final replacement;
- mutable-tail cache isolation;
- component-local error containment with readable source fallback;
- stable identity for unchanged completed content where it is cheap to retain.

Do not bring these implementation choices:

- ReactMarkdown as a replacement for the custom measured Markdown model;
- runtime list estimates as a replacement for exact collapsed-turn heights;
- browser-intrinsic math blocks with later uncoordinated resize;
- t3code's Markdown plugin list as evidence of a math dialect;
- a general streaming repair layer.

Remux's measured transcript, server resource revisions, scroll anchors, and
narration geometry require a more explicit math contract than t3code currently
needs.

## Codex-Generated Math Reliability

The app-server contract makes the text stream reliable, not the formatting
dialect inside that text. Official Codex documentation defines agentMessage as
accumulated reply text, item/agentMessage/delta as appended text, and
item/completed as authoritative. Official prompting guidance says callers may
request an output format, but it does not guarantee that every model response
will use Markdown math or one exact delimiter style.

Therefore reliability comes from tolerant rendering:

- accept the two dominant display and inline delimiter families;
- prefer unambiguous delimiters when a format hint is used;
- protect code and ordinary dollars;
- preserve exact source;
- treat completion as authoritative;
- degrade locally and visibly when TeX is malformed or unsupported.

No mandatory system/developer prompt change is part of the first implementation.
After telemetry and fixture testing, Remux may add a short advisory instruction:

    When using mathematical notation, prefer \( ... \) inline and
    \[ ... \] for display math. Do not wrap rendered math in code fences.

That hint can improve consistency, but every acceptance test must also pass with
no hint. A prompt is not a parser, a security boundary, or a recovery strategy.

Expected outcomes:

| Model output | Result |
| --- | --- |
| Well-formed supported TeX and delimiters | KaTeX |
| Supported TeX with a newline inside text | KaTeX |
| Equivalent Unicode equation without delimiters | ordinary text |
| Formula wrapped in inline or fenced code | code |
| Unknown KaTeX command | exact literal source |
| Unbalanced braces | exact literal source |
| Truncated stream | progressive exact literal source |
| Final response with unmatched delimiter | exact literal source |
| Currency or shell dollar syntax | ordinary text |

This is reliable enough for generated math because formatting errors stay
readable and recoverable. It is not a claim that every Codex response will be
mathematically correct; rendering correctness and mathematical correctness are
separate concerns.

## Implementation Map

### New viewer modules

- extensions/codex/viewer/transcript/components/markdown/mathSyntax.ts
  owns delimiter tokenizers, currency rules, source spans, and recovery nodes.
- extensions/codex/viewer/transcript/components/markdown/katexAdapter.ts
  owns exact options, validation, branded markup, normalization, limits, and
  bounded diagnostics.
- extensions/codex/viewer/transcript/components/markdown/mathMetricsStore.ts
  owns font readiness, hidden batch measurement, metric caches, waiters, and
  revision publication.
- extensions/codex/viewer/transcript/components/markdown/MathNode.tsx
  owns visible inline/display rendering, overflow containers, accessibility,
  and literal fallback.
- extensions/codex/viewer/narration/elementLeafRegistry.ts
  owns element-leaf registration and paint rectangle resolution.

### Existing files to change

- extensions/codex/package.json and package-lock.json:
  add the exact direct KaTeX dependency and direct declarations for any
  micromark packages imported by the new syntax extension.
- extensions/codex/viewer/main.tsx:
  import the KaTeX stylesheet and initialize the metrics-store font lifecycle.
- extensions/codex/viewer/styles.css:
  define inline/display geometry, pending and invalid literal styles, local
  overflow, and theme inheritance.
- extensions/codex/viewer/transcript/components/markdown/markdownModel.ts:
  add syntax extensions, math raw/prepared/layout variants, per-line
  ascent/depth/height, math-aware capping, narration projection, metric
  resolution, and streaming cache scope.
- extensions/codex/viewer/transcript/components/markdown/MarkdownBlock.tsx:
  render MathNode, consume per-line geometry, receive the measured math-snapshot
  id, register element leaves, and add a math-specific error boundary.
- extensions/codex/viewer/transcript/components/assistantMessage.tsx:
  pass the assistant segment id as streaming cache scope.
- extensions/codex/viewer/transcript/layout/measureCollapsed.ts:
  pass the same cache scope and metrics snapshot used by rendering.
- extensions/codex/viewer/transcript/layoutStore.ts:
  subscribe internally to metrics publication, dirty affected turns, publish
  measured rows with their immutable math-snapshot id, and apply the normal
  anchor-preserving remeasurement.
- extensions/codex/viewer/narration/textLeafRegistry.ts and narration paint
  code:
  combine text ranges with element rectangles.

The extension server needs no functional change. Add a server regression test
only if needed to make the authoritative-completed-item behavior explicit.

## Delivery Phases

### Phase 0: grammar and fixtures

- Add the Markdown-aware delimiter extension.
- Freeze the currency, shell, escaping, code-precedence, and unsupported-context
  corpus.
- Add source-span and recovery tests.
- Add a fixture for the motivating observed-price equation.
- Add split-at-every-boundary streaming equivalence tests at the raw-model level.

No visual math is enabled in this phase.

### Phase 1: display math

- Add the exact KaTeX adapter and direct dependency.
- Add batched hidden measurement and font readiness.
- Add mathDisplay raw, prepared, layout, and React nodes.
- Add horizontal and bounded vertical overflow.
- Add literal fallback and error containment.
- Add streaming versus completed cache scopes.
- Add block narration and MathML accessibility.
- Enable \[...\] and $$...$$ after geometry, scrolling, and security gates pass.

### Phase 2: inline math

- Add inline math model/source variants.
- Add atomic width, baseline, ascent, and depth metrics.
- Refactor text lines and table rows to actual per-line heights.
- Add local overflow behavior for overwide inline formulas.
- Add element narration leaves.
- Enable \(...\), then enable conservative $...$ only after the ambiguity corpus
  passes.

Display and inline can land in one release if both phases pass. If they land in
separate releases, the UI must not reinterpret inline delimiters as display
math.

### Phase 3: hardening and cleanup

- Remove any temporary feature flag after one observation release.
- Review bounded diagnostics for real malformed-model patterns.
- Decide whether an advisory Codex format hint materially improves output.
- Update docs/architecture/codex-streaming.md and the current Codex viewer
  architecture documentation to describe the implemented behavior.
- Mark this spec Implemented only after desktop and physical-phone validation.

## Verification Matrix

### Parser fixtures

- all four delimiter forms;
- same-line and multiline display math;
- the motivating newline inside a text command;
- escaped openers and closers;
- adjacent and triple dollar characters;
- empty bodies;
- nested braces;
- underscores, asterisks, backslashes, pipes, and Markdown-looking TeX;
- inline and fenced code;
- headings, paragraphs, blockquotes, tight and loose lists;
- table cells and link labels;
- link destinations, autolinks, and raw HTML;
- currency and shell examples from the syntax table;
- CRLF and LF input;
- astral Unicode before and inside math to validate UTF-16 offsets;
- formula-count and source-length limits.

### Streaming fixtures

For each supported example, feed every non-empty prefix of the source and assert:

- parsing never throws;
- the visible literal fallback contains the full received source;
- prose outside the candidate is not swallowed;
- no incomplete candidate enters KaTeX;
- durable cache sizes do not grow with every prefix;
- the completed final raw model equals a cold parse of the same final string.

Also split app-server deltas at every UTF-16 boundary and compare the settled
layout and DOM with an all-at-once completed item.

### KaTeX and security fixtures

- valid fractions, sums, superscripts, matrices, aligned expressions, and text;
- unknown commands and unbalanced braces;
- macro-expansion limit;
- size limit;
- trust-requiring URL and HTML commands;
- malicious strings containing tags and event attributes;
- repeated invalid formulas to exercise the negative cache;
- one invalid formula between two valid formulas;
- component render exception with exact literal fallback.

No test may rely only on a snapshot of generated KaTeX HTML. Assert user-visible
text/MathML, containment, and geometry.

### Geometry fixtures

With real bundled fonts loaded, at minimum test widths 320, 390, 768, and 1024
CSS pixels in light and dark themes:

- modeled Markdown height and rendered DOM height differ by at most one CSS
  pixel;
- inline baselines align with adjacent prose;
- fractions and matrices expand their prose line without clipping;
- simple display chains wrap at outer relation and binary operators and retain
  exact modeled height;
- operators inside fractions, braces, arrays, and other atomic constructs do
  not become display break points;
- paragraph, heading, list, blockquote, and table heights use actual line
  heights;
- long inline and display expressions do not widen document.body;
- display height caps produce a local vertical scroller;
- maxLines capping ends at a measured boundary;
- browser zoom or font invalidation causes one coherent remeasurement.

### Transcript behavior

- bottom-follow remains pinned while pending literal math becomes display math;
- sent-message anchoring preserves its target during math-metrics publication;
- auto-scroll off preserves the reader's visible anchor;
- virtualized reopen measures completed math before or through one anchored
  correction;
- reconnect and cold reopen match live final rendering;
- copying returns the exact original assistant text;
- narration block seek works for display math;
- a cue overlapping inline TeX paints the whole inline formula;
- hundreds of streaming prefixes do not evict durable completed Markdown or
  KaTeX entries.

### Commands

The implementation pass must run the existing Codex viewer and transcript suites
plus the new focused parser, measurement, route, and narration tests. It must
also run:

    npm run lint
    npm run typecheck
    npm run test:codex
    npm run test:codex-server
    npm run test:codex:narration-real
    npm --workspace @remux/codex run build

If repository scripts differ when implementation begins, use the then-current
equivalent commands and record them in the implementation closeout.

## Acceptance Criteria

The work is complete when:

1. the motivating observed-price expression renders as a display equation;
2. \(...\), \[...\], compatible dollar forms, and literal fallback obey the
   frozen syntax corpus;
3. all streaming split points settle to the same result as cold parsing;
4. item/completed text overrides divergent accumulated deltas;
5. code, currency, shell syntax, links, copying, and raw source remain correct;
6. invalid or hostile TeX cannot blank, crash, navigate, or widen the response;
7. display and inline math pass exact geometry at the supported widths;
8. math metrics remeasurement preserves transcript scroll modes;
9. narration and accessibility contracts pass;
10. mutable streaming prefixes do not pollute durable caches;
11. desktop and physical-phone validation pass;
12. architecture docs are updated and this spec can be marked Implemented.

## References

- OpenAI Codex app-server documentation:
  https://learn.chatgpt.com/docs/app-server.md
- OpenAI prompting documentation:
  https://learn.chatgpt.com/docs/prompting.md
- Current transcript ownership:
  [server-authoritative-transcript-windows.md](server-authoritative-transcript-windows.md)
  and [transcript-store-scroll.md](transcript-store-scroll.md)
- Existing Narrate KaTeX and element-leaf precedent:
  extensions/narrate/viewer/src/markdown/markdownPipeline.ts and
  extensions/narrate/viewer/src/markdown/narrationModel.ts
- t3code comparison snapshot:
  https://github.com/pingdotgg/t3code/tree/4347f14b89ed66777ae16def278fd44575ab499b
