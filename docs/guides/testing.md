# Testing

Status: Current
Last verified: 2026-06-28

## Root Typecheck

```bash
npm run typecheck
```

## Mobile Typecheck

```bash
npm run app:typecheck
```

## CLI Tests

```bash
npm run test:cli
```

These use Node's built-in test runner against `cli/tests/*.test.js`.

## Codex Rust Server Tests

```bash
npm run test:codex-server
```

This runs Cargo tests with `--offline` against `extensions/codex/server/Cargo.toml`.

## Codex Viewer Tests

```bash
npm run test:codex
```

This uses the Playwright config in `extensions/codex/playwright.config.ts`. Make sure Playwright browsers are installed and viewer assets are current.

## Terminal Rust Server Tests

```bash
npm run test:terminal-server
```

This runs Cargo tests against `extensions/terminal/server/Cargo.toml`, including PTY start/write/replay, resize, kill, missing-session, and shell-exit coverage.

## Terminal Viewer Tests

```bash
npm run test:terminal
```

This uses the Playwright config in `extensions/terminal/playwright.config.ts` for byte-level key encoding and mocked-host terminal viewer layout tests across desktop and mobile viewports.

## Terminal WebSocket Smoke

```bash
REMUX_WS_URL=ws://127.0.0.1:48124/ws npm run test:terminal-smoke
```

This talks to a running Remux websocket and validates terminal session start/write/output/kill through the full runtime path. Without a reachable runtime it skips by default; set `REMUX_TERMINAL_SMOKE_REQUIRED=1` to make connection failure fatal.

## Codex Transcript Validation

For real transcript validation against a Codex home:

```bash
cargo run --manifest-path extensions/codex/server/Cargo.toml --offline -- validate --codex-home ~/.codex --limit 100
```

Use this when changing Rust transcript projection, item identity, live overlay behavior, or history indexing.
