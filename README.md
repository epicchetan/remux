# Remux

Remux is a local-first mobile shell and extension runtime for small embeddable viewers. The runtime runs on your machine, serves extension viewers, proxies JSON-RPC between the mobile app and extension servers, and lets the Expo app host those viewers as native tabs.

The first production-focused extension is Codex. The repo also includes markdown and editor viewers that exercise the same extension model.

Remux is early-stage local tooling. The runtime is intended for a trusted local machine or trusted LAN; it currently has no authentication layer and exposes filesystem/RPC capabilities to connected clients.

## Quick Start

Install dependencies:

```bash
npm install
```

Build the bundled extension viewers:

```bash
npm run viewers:build
```

Start the Remux runtime:

```bash
REMUX_HOST=127.0.0.1 npm run dev
```

For device testing, use a host address that the device can reach:

```bash
REMUX_HOST=0.0.0.0 npm run dev
```

Run the mobile app separately from `app/`:

```bash
npm --workspace @remux/app run start
```

or build to a device:

```bash
npm --workspace @remux/app run ios
```

The runtime defaults to port `48123`, serves the extension catalog at `/remux/extensions`, serves viewers under their manifest routes, and exposes the Remux websocket at `/ws`.

## Architecture

Remux has four main pieces:

- `app/`: Expo/React Native mobile shell, browser tabs, WebView host bridge, connection settings, local tab persistence, and push notification registration.
- `cli/`: Rust runtime (crash-restart supervisor + worker), HTTP server, websocket JSON-RPC router, extension discovery, extension process supervision, filesystem APIs, logging, and notification delivery.
- `extensions/`: bundled Remux extensions. Each extension has a `remux-extension.json` manifest, a static viewer, and optionally a stdio JSON-RPC server.
- `packages/`: shared extension APIs and UI primitives used by viewers.

The high-level flow is:

```text
Expo app -> WebView host bridge -> Remux websocket /ws -> runtime router -> extension stdio server
       \-> HTTP viewer assets and extension catalog served by the runtime
```

See [docs/architecture/remux-runtime.md](docs/architecture/remux-runtime.md) and [docs/architecture/codex-extension.md](docs/architecture/codex-extension.md) for the maintained architecture notes.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Remux runtime (cargo run) with extension discovery and `/ws`. |
| `npm run build:cli` | Build the release runtime binary at `target/release/remux`. |
| `npm run viewers:build` | Build bundled extension viewer assets. |
| `npm run viewers:watch` | Watch extension viewers during frontend development. |
| `npm run typecheck` | Typecheck the root TypeScript project. |
| `npm run app:typecheck` | Typecheck the Expo app workspace. |
| `npm run test:cli` | Run the Rust runtime tests (unit, chaos, and e2e). |
| `npm run test:codex-server` | Run the Rust Codex extension server tests. |
| `npm run test:codex` | Run Codex viewer Playwright tests. |

## Documentation

Start with [docs/README.md](docs/README.md).

The root README is for orientation and day-one setup. Current architecture and guides live under `docs/architecture/` and `docs/guides/`. Implementation specs and historical phase plans live under `docs/specs/` with lifecycle labels.

## Public Notes

- The root package is private and this repo is source-oriented, not published as an npm package.
- Native Expo generated folders, build output, local Remux state, credentials, and Rust targets are ignored.
- `codex/` and `t3code/` are local reference checkouts used during development; they are not part of a fresh clone.
