# Agent transcript Mermaid diagrams

Status: Implemented
Last verified: 2026-09-06
Canonical code: `extensions/agent/viewer/src/transcript/components/markdown/`, `packages/viewer-kit/src/mermaid.ts`

## Outcome

Explicit Mermaid fences render as diagrams inside the provider-neutral Agent transcript. Their asynchronous rendering must not move subsequent content or invalidate the virtualizer's measured coordinates. Markdown file previews reuse the same renderer.

## Contract

- Only explicitly closed fences tagged `mermaid` become diagram blocks. Streaming or malformed unclosed fences remain source. Nested lists, blockquotes, backticks, tildes, and CRLF input follow the Markdown parser's structure.
- The synchronous Markdown model uses a 240px fallback until natural SVG dimensions are available. It then measures fitted image height plus a 32px toolbar, padding, and borders, clamped to 120–360px. A bounded natural-dimensions registry updates the measured layout and rendered blocks together. A visible Markdown-block anchor preserves reading position within an assistant message. Source/preview toggles and zoom retain the resting card height. Width changes use ordinary transcript remeasurement.
- The diagram is the default. Toolbar actions show source and copy the original diagram source. Diagrams scale down to fit both the available width and bounded height without changing their aspect ratio. Source remains scrollable. The quieter card uses the existing code-surface palette and compact header. There is no expanded view.
- Toolbar controls have no background highlight on hover, focus, or touch. Keyboard focus retains a visible outline. Diagram controls and source overflow must not widen the page or cover the composer.
- Invalid or oversized diagrams show an explanation and source inside the same frame. Rendering only begins on mounted blocks. Unmount, source changes, and theme changes ignore stale completions and release their image URLs.
- A shared web helper owns Mermaid loading, strict configuration, serialized rendering, unique IDs, font readiness, and bounded 32-entry success/failure caching. Identical in-flight requests share work; canceling one subscriber does not cancel another. Cache identity includes source and theme.
- Diagrams use SVG Blob images, without injected HTML, callbacks, or host capabilities. Mermaid uses strict security, SVG text labels, a 20,000-character source limit, and a 200-edge limit. Source configuration overrides and active/external SVG content are rejected.

## Boundaries

This pass adds one measured block type with a controlled natural-dimension update, not a generic asynchronous measurement system. It does not add arbitrary inline HTML, a new server API, provider-specific behavior, editable diagrams, or persisted diagram UI state. Zoom resets on remount, source/theme changes, and viewport resize. The older Codex extension is unchanged. The File Viewer retains its own freely scrolling layout.

## Implementation and review

1. Sol implements the shared renderer and Agent parser/layout model in separate bounded lanes; primary reviews the contracts and integrates the UI.
2. Primary implements the frame and controls. Sol validates the shared renderer in Editor and the transcript in browser tests; primary reviews failures and final diffs.
3. Run model/layout and browser geometry tests, shared Editor integration tests, and repository typechecks. Commit and push reviewed green work, rebuild Agent and Editor web assets, and verify their served revisions. No server restart or Expo update is required for web-only assets.

## Acceptance evidence

- Model tests cover explicit closure, nested fences, incomplete input, stable IDs/cache identity, and min/max geometry.
- Editor browser tests cover decoded SVG Blob images, deduplication, cache reuse, subscriber cancellation, errors, limits, and concurrent themes.
- Agent browser tests cover ready/source/error geometry, width fitting, width changes, partial-to-closed input, and virtualized remount behavior.

Validation on 2026-09-06:

- Repository and linked-viewer TypeScript checks passed.
- All 59 Agent unit tests passed; the focused 6-test Markdown model suite passed again after adding the final fence-like-content edge cases.
- All 8 Mermaid browser cases passed across desktop/mobile, including a real middle-turn virtual unmount/remount with identical cached SVG, stable following-content position, and preserved scroll position.
- All 6 existing error/footer geometry browser cases passed.
- The full Editor suite passed, including shared Mermaid renderer browser checks.
- After the inline-fit refinement, all 8 Mermaid browser cases passed again. The reviewed mobile screenshot shows the entire diagram fitting the card. Source/copy controls stay transparent when selected, and source fallback remains bounded to the document. Repository typechecks and the Agent viewer build also passed.

The shared renderer landed in `6067998`. Agent and Editor web builds are served by the runtime's immutable viewer catalog; this deployment requires a view reload, with no runtime restart or Expo update.

Verified served revisions:

- `agent`: `sha256-ee2446193f4f10ba1859bd82de157588e6f4186c2d1542e893d0590a005a4812`
- `editor`: `sha256-d8eb5a789b46df408583133ced886fdce42fcd874159f65de1ae827ccc0251b7`


## Inline gesture refinement (2026-09-06)

- At fitted size, one-finger movement scrolls the transcript. Once that movement passes the native-scroll threshold, a second finger cannot steal the gesture.
- A two-finger gesture started over the diagram before native scrolling wins pinches around the moving finger midpoint and pans within bounds. Zoom is limited to 1–8 times fitted size.
- At zoom greater than one, one-finger drags pan the diagram; gestures starting outside it keep normal transcript behavior. An owned gesture remains owned until all fingers lift or it is canceled, including when pinching back to fit.
- A transparent Reset view icon appears in the header only while zoomed, leaving diagram labels unobstructed. Keyboard `+`/`-` zoom around the center and `0` resets. No fullscreen UI returns.
- Image transforms never change the resting card or measured row height. The diagram and transcript coordinate gesture start/end explicitly; ownership is released on cancellation, resize, hiding, source change, and virtualized unmount.
- Natural-dimension publications wait during native touch/momentum and diagram-owned gestures, then batch into one layout revision after release. Touch cancellation and remaining-finger cases must not strand that hold.
- First validate pure bounds/focal math and registry batching, then desktop/mobile browser ownership, fit scrolling, pinch/pan/reset, actual row heights, first-render anchoring, and virtual remount. iPhone WebView feel remains a separate on-device observation; Chromium synthetic touch coverage is not evidence of actual iOS gesture arbitration.

Implementation uses two bounded Sol lanes (gesture component and metrics model), primary integration/review, then Sol browser checks before committing and rebuilding the Agent web assets.


Refinement validation:

- All 64 Agent unit cases passed, including natural-dimensions hold batching and pinch focal/bounds math.
- All 6 existing error/footer scroll-regression cases passed.
- Both desktop/mobile same-message anchor cases passed: a paragraph already at the reading position stays there when a diagram above it adopts its compact height.
- The final Mermaid lifecycle and interaction suites passed 10 cases with 2 intentional input-specific project skips, including the header Reset icon and releasing queued metrics when switching to source during an owned pinch.
- Chromium CDP exercises pinch/pan and verifies unclaimed fitted one-finger touch events after all handlers run. Headless synthesized native scroll did not move even ordinary text, so wheel-based scroll checks are not presented as native touch-motion evidence. Physical iPhone WebView feel remains unverified.
- Repository and linked-viewer typechecks and the final Agent production build passed. The served immutable Agent bundle was checked for gesture controls, clipping styles, and removal of fullscreen UI.
