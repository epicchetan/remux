# Codex Extension Architecture

Status: Current
Last verified: 2026-06-28

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
