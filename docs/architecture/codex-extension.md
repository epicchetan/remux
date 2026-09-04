# Codex Extension Architecture

Status: Current
Last verified: 2026-08-19

The Codex integration is a Remux extension with a React/Vite viewer and a Rust stdio JSON-RPC server. The extension manifest is `extensions/codex/remux-extension.json`.

## Pieces

- `extensions/codex/viewer/`: React viewer, composer, thread list, transcript renderer, resource stores, and WebView IPC wrappers.
- `extensions/codex/server/`: Rust extension server launched by Remux over stdio.
- `extensions/codex/shared/`: TypeScript contracts, transcript/thread models, generated Codex protocol bindings, and JSON schemas.
- `extensions/codex/tests/`: Playwright tests for viewer behavior.

The manifest launches the server with `cargo run --manifest-path server/Cargo.toml --target-dir /tmp/remux-codex-server-target --offline --quiet --`.

## Server Responsibilities

`extensions/codex/server/src/main.rs` exposes Remux-facing methods:

- `remux/codex/files`
- `remux/codex/composer/config/read`
- `remux/codex/composer/config/write`
- `remux/codex/transcript/resources/read`
- `remux/codex/thread/resources/read`
- `remux/codex/thread/compact`
- `remux/codex/thread/message/start`
- `remux/codex/thread/message/send`
- `remux/codex/thread/message/edit`
- `remux/codex/thread/message/fork`
- `remux/codex/thread/turn/interrupt`

The Rust server owns Codex app-server integration through `app_server.rs`. It connects to an existing app-server socket when available, starts `codex app-server` when needed, initializes the connection, routes requests, and forwards app-server notifications into Remux state.

## Streaming Model

The viewer does not apply app-server text deltas directly. Streaming is resource-driven:

1. The viewer sends commands or reads resources through Remux IPC.
2. The Rust server calls Codex app-server and records live app-server notifications.
3. Live notifications update process-local live transcript, thread runtime, usage, and item identity stores.
4. The Rust server emits `remux/codex/resources/invalidated`.
5. The viewer dedupes invalidations and rereads authoritative resources.
6. The transcript layout layer remeasures only the affected rows where possible.

After a server restart, durable state comes from Codex history on disk and app-server state; the live overlay is process-local.

## Assistant Math Rendering

Assistant Markdown supports display math with `\\[...\\]` and `$$...$$`, plus
inline math with `\\(...\\)` and a conservative `$...$` form. Backslash
delimiters are preferred; the dollar scanner deliberately leaves currency,
shell syntax, URLs, code, raw HTML, and Markdown link destinations alone.

Math remains a viewer projection of the authoritative assistant text. Every
streaming resource refresh reparses the complete accumulated message; the Rust
server does not buffer delimiters or add rendered HTML to transcript resources.
The Markdown model first parses the unmodified source to identify protected
Markdown ranges, then replaces recognized formulas with equal-length private
markers before its normal MDAST projection. The equal-length mask preserves
UTF-16 source offsets and exact literal recovery without changing the existing
Markdown parser.

KaTeX is called only through the local bounded adapter with `trust: false`,
`throwOnError: true`, expansion/size limits, generated HTML+MathML, and no
shared macros. Invalid, unsafe, incomplete, or over-limit expressions render as
their exact source. Valid expressions are measured in one hidden browser-owned
surface; formula ascent/depth participates in prose line height and display
geometry participates in collapsed transcript measurement. KaTeX font events
invalidate the math metrics revision and trigger the layout store's normal
authoritative remeasurement.

Mutable streaming messages have segment-scoped raw, prepared, layout, markup,
and metric caches. Completion reparses the authoritative final text under the
bounded durable cache tier and drops the transient tier. Display formulas wrap
at the outer relation/binary-operator chunks emitted by KaTeX; constructs inside
fractions, braces, and tables stay atomic. Short displays remain centered,
constrained displays align to the readable leading edge, expressions with no
safe break retain local horizontal scrolling, and tall displays use a capped
local vertical scroller. None can widen the transcript. Inline narration
exposes the delimiter-free TeX as its logical text and paints the entire
rendered formula when a cue overlaps it; display formulas use structural block
narration.

The detailed syntax, recovery, geometry, accessibility, and validation contract
is recorded in
[assistant-math-rendering.md](../specs/codex/assistant-math-rendering.md).

## Viewer State Ownership

The viewer intentionally separates state by lifetime:

- `viewer/transcript/resourceStore.ts`: authoritative transcript resources mirrored from the Rust server.
- `viewer/transcript/layoutStore.ts`: local measurement and layout cache.
- `viewer/transcript/viewportStore.ts`: scroll and viewport behavior.
- `viewer/threads/historyStore.ts`: thread list and summary resources.
- `viewer/threads/runtimeStore.ts`: running turn status.
- `viewer/composer/store.ts`: composer UI state and send projection.

The main app component subscribes to resource invalidations with `subscribeCodexResourceInvalidations()` and applies them through the resource stores.

## Caveats

- Transcript item IDs exposed to the viewer are canonical Remux identities, not necessarily raw app-server item IDs.
- Some app-server request types, such as approval or elicitation flows, are not fully bridged back through Remux yet.
- `edit` is modeled around rollback plus a new turn, not arbitrary historical editing.
- `cargo --offline` requires the Rust dependency set to already be available.
