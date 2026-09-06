# Agent transcript Mermaid diagrams

Status: Implemented
Last verified: 2026-09-06
Canonical code: `extensions/agent/viewer/src/transcript/components/markdown/`, `packages/viewer-kit/src/mermaid.ts`

## Outcome

Explicit Mermaid fences render as diagrams inside the provider-neutral Agent transcript. Their asynchronous rendering must not move subsequent content or invalidate the virtualizer's measured coordinates. Markdown file previews reuse the same renderer.

## Contract

- Only explicitly closed fences tagged `mermaid` become diagram blocks. Streaming or malformed unclosed fences remain source. Nested lists, blockquotes, backticks, tildes, and CRLF input follow the Markdown parser's structure.
- The synchronous Markdown model reserves `min(360, max(240, availableWidth * 0.65))` pixels for the card, including its 32px toolbar. Existing Markdown spacing remains outside the card. Loading, preview, source, and error states keep exactly that height. Width changes use ordinary transcript remeasurement.
- The diagram is the default. Toolbar actions show source and copy the original diagram source. Diagrams scale down to fit both the available width and bounded height without changing their aspect ratio. Source remains scrollable. There is no expanded view.
- Toolbar controls have no background highlight on hover, focus, or touch. Keyboard focus retains a visible outline. Diagram controls and source overflow must not widen the page or cover the composer.
- Invalid or oversized diagrams show an explanation and source inside the same frame. Rendering only begins on mounted blocks. Unmount, source changes, and theme changes ignore stale completions and release their image URLs.
- A shared web helper owns Mermaid loading, strict configuration, serialized rendering, unique IDs, font readiness, and bounded 32-entry success/failure caching. Identical in-flight requests share work; canceling one subscriber does not cancel another. Cache identity includes source and theme.
- Diagrams use SVG Blob images, without injected HTML, callbacks, or host capabilities. Mermaid uses strict security, SVG text labels, a 20,000-character source limit, and a 200-edge limit. Source configuration overrides and active/external SVG content are rejected.

## Boundaries

This pass adds one measured block type, not a generic asynchronous measurement system. It does not add arbitrary inline HTML, a new server API, provider-specific behavior, editable diagrams, or persisted diagram UI state. The older Codex extension is unchanged. The File Viewer retains its own freely scrolling layout.

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

- `agent`: `sha256-f7687f84eb9534229ae788d2882eb3292a3d57692578248eb3c67ae68c98d253`
- `editor`: `sha256-d8eb5a789b46df408583133ced886fdce42fcd874159f65de1ae827ccc0251b7`
