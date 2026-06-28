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

## Codex Transcript Validation

For real transcript validation against a Codex home:

```bash
cargo run --manifest-path extensions/codex/server/Cargo.toml --offline -- validate --codex-home ~/.codex --limit 100
```

Use this when changing Rust transcript projection, item identity, live overlay behavior, or history indexing.
