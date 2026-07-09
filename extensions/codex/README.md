# Remux Codex Extension

Status: Current
Last verified: 2026-06-28

The Codex extension lets Remux host a mobile Codex transcript and composer experience. It is implemented as a static React viewer plus a Rust stdio JSON-RPC server.

## Layout

- `remux-extension.json`: Remux manifest for the Codex launcher, viewer route, and Rust server process.
- `viewer/`: React/Vite viewer, transcript renderer, thread list, composer, and WebView IPC wrappers.
- `server/`: Rust server that reads Codex history, talks to Codex app-server, projects transcript resources, and emits invalidations.
- `shared/`: shared TypeScript contracts, generated Codex protocol bindings, and schemas.
- `tests/`: Playwright viewer tests.

## Data Flow

```text
Codex viewer
  -> WebView IPC
  -> Remux websocket
  -> Remux CLI router
  -> Codex Rust stdio server
  -> Codex app-server and Codex history on disk
```

The viewer treats the Rust server as authoritative. It does not apply app-server deltas directly. During streaming, app-server notifications update Rust live state, the Rust server emits `remux/codex/resources/invalidated`, and the viewer rereads changed resources.

## Main Methods

The Rust server exposes:

- `remux/codex/thread/resources/read`
- `remux/codex/transcript/resources/read`
- `remux/codex/files`
- `remux/codex/composer/config/read`
- `remux/codex/composer/config/write`
- `remux/codex/models/read`
- `remux/codex/thread/message/start`
- `remux/codex/thread/message/send`
- `remux/codex/thread/message/edit`
- `remux/codex/thread/message/fork`
- `remux/codex/thread/compact`
- `remux/codex/thread/turn/interrupt`

## Development

Build all viewers from the repo root:

```bash
npm run viewers:build
```

Run the Rust server tests:

```bash
npm run test:codex-server
```

Run the viewer tests:

```bash
npm run test:codex
```

Validate transcript projection against a Codex home:

```bash
cargo run --manifest-path extensions/codex/server/Cargo.toml --offline -- validate --codex-home ~/.codex --limit 100
```

## More Detail

- [Codex extension architecture](../../docs/architecture/codex-extension.md)
- [Codex streaming current state](../../docs/architecture/codex-streaming.md)
- [Codex specs](../../docs/specs/README.md)
