# Development Guide

Status: Current
Last verified: 2026-06-28

## Prerequisites

- Node and npm compatible with `packageManager` in `package.json`.
- Rust and Cargo for the Codex extension server.
- Expo/iOS/Android tooling when working on the mobile app.
- Playwright browsers when running Codex viewer tests.

The Codex extension also expects a working Codex CLI/app-server environment on the host machine.

## Install

```bash
npm install
```

## Build Viewers

```bash
npm run viewers:build
```

This builds static assets for extensions that define build scripts. The runtime serves those built assets from each extension manifest's `views.main.entry`.

During viewer development, run:

```bash
npm run viewers:watch
```

Keep this in a separate terminal from the runtime.

## Start The Runtime

Local-only:

```bash
REMUX_HOST=127.0.0.1 npm run dev
```

Device/LAN testing:

```bash
REMUX_HOST=0.0.0.0 npm run dev
```

Useful environment variables:

| Variable | Purpose |
| --- | --- |
| `REMUX_HOST` | Runtime bind host. Defaults to `0.0.0.0`. |
| `REMUX_PORT` | Runtime port. Defaults to `48123`. |
| `REMUX_EXTENSION_ROOTS` | Path-list override for extension discovery roots. |
| `EXPO_PUBLIC_REMUX_ORIGIN` | Build-time fallback origin used by the Expo app before local settings are saved. |
| `CODEX_HOME` | Codex home used by the Codex extension server. |
| `CODEX_BIN` | Codex binary override for app-server startup. |
| `REMUX_CODEX_DEBUG` | Enables additional Codex extension diagnostics. |

Runtime logs are written under `.remux/`.

## Start The Mobile App

From the repo root:

```bash
npm --workspace @remux/app run start
```

For native builds:

```bash
npm --workspace @remux/app run ios
```

or:

```bash
npm --workspace @remux/app run android
```

The app stores Remux host/port settings locally. For physical device testing, set the runtime host to an address reachable from the device.

## Generated And Local Files

The repo intentionally ignores local runtime state, generated native folders, build outputs, credentials, Rust targets, Playwright results, and local reference checkouts.

Important ignored paths include:

- `.remux/`
- `.codex-mobile/`
- `node_modules/`
- `target/`
- `dist/`
- `test-results/`
- `app/ios/`
- `app/android/`
- `app/.expo/`
- `codex/`
- `t3code/`
