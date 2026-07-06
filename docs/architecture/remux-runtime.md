# Remux Runtime Architecture

Status: Current
Last verified: 2026-07-06

Remux is split between a local Rust runtime and an Expo mobile shell. The runtime owns extension discovery, HTTP serving, websocket JSON-RPC, stdio extension servers, filesystem APIs, logging, restart behavior, and push notification delivery. The mobile shell owns tabs, WebViews, connection state, native file/media pickers, viewport metrics, keyboard behavior, and notification registration.

## Runtime Process

The runtime is the `remux` binary built from the `cli/` Cargo crate. `remux start` runs a two-process tree:

- **Supervisor** (`cli/src/supervise.rs`): a minimal, std-only parent that spawns the worker and restarts it on *any* abnormal exit with capped backoff. Exit `75` is a deliberate restart request (`remux/system/restart`); exit `0` shuts the tree down. The supervisor never gives up, so the runtime stays remotely recoverable even after a worker crash.
- **Worker** (`cli/src/runtime.rs`): the actual runtime, marked by `REMUX_WORKER=<supervisor pid>` (honored only when it matches the parent pid, so shells spawned inside remux terminal sessions cannot accidentally start supervisor-less workers).

The worker assembles:

- `REMUX_HOST` / `REMUX_PORT`, with `.remux/config.toml` as the fallback (`cli/src/config.rs`)
- extension discovery from configured roots, defaulting to `extensions/` (`cli/src/extensions/`)
- one supervised stdio server per extension manifest that defines one
- viewer static serving for extension main views
- the HTTP server and the websocket server at `/ws`
- notification handling, the runtime journal, and graceful shutdown

The default bind is `0.0.0.0:48123`. Use `REMUX_HOST=127.0.0.1` for local-only development.

## Extension Supervision

`cli/src/extensions/supervisor.rs` runs one actor per extension with a state machine (`stopped`, `starting`, `running`, `stopping`, `backingOff`, `failed`). Crashes restart with capped backoff; five crashes in sixty seconds marks the extension `failed` until a manual start. An extension crash never terminates the runtime. Stop is stdin-EOF first, then SIGTERM, then SIGKILL, and stop/restart RPCs only respond after the process is confirmed reaped.

Extension stderr goes to rotated per-extension files under `.remux/logs/extensions/` plus an in-memory ring served over `remux/extensions/logs` (with subscribe/follow variants). The runtime journal is written to `.remux/logs/runtime-<runId>.jsonl` with retention controlled by `log_retention_days`.

## HTTP Surface

`cli/src/http/` serves:

- `/health`, `/healthz`, `/readyz`
- `/remux/extensions`
- `/remux/extensions/<id>/icon`
- `/`, which redirects to the default extension viewer
- extension viewer routes such as `/viewers/codex`

The viewer provider serves built static viewer assets from each manifest's `views.main.entry`. It blocks path traversal and falls back to the entry HTML for viewer routes.

## Websocket And RPC

`cli/src/rpc/ws.rs` accepts JSON-RPC websocket connections at `/ws`.

`cli/src/rpc/router.rs` routes:

- `remux/system/restart`
- `remux/extensions/status`
- `remux/extensions/start`
- `remux/extensions/stop`
- `remux/extensions/restart`
- `remux/extensions/logs` (plus `logs/subscribe` and `logs/unsubscribe`)
- `remux/fs/*`
- extension-prefixed methods such as `remux/codex/*`

`cli/src/extensions/process.rs` launches stdio extension servers and forwards newline-delimited JSON-RPC to them through a single writer task, so a dying extension's closed pipe can never crash the runtime.

## Mobile Shell

The app is an Expo/React Native shell under `app/`.

Important ownership:

- `app/src/remote/remuxSettingsStore.ts`: host/port settings and origin building.
- `app/src/remote/RemuxConnectionProvider.tsx`: websocket lifecycle, reconnects, request dispatch, and app diagnostics.
- `app/src/browser/browserStore.ts`: extension catalog, tabs, active surface, restored session, and notification target opening.
- `app/src/surfaces/viewer/ExtensionWebView.tsx`: WebView bridge, viewer readiness, request forwarding, health checks, automatic reloads, attachments, tab updates, file opening, keyboard dismissal, and viewport metrics.
- `app/src/settings/SettingsOverview.tsx`: reconnect, runtime restart, and extension controls.

Hidden viewer tabs remain mounted so tab state survives switching. That is good for continuity, but it can affect memory and background activity.

## Notifications

`cli/src/notifications.rs` receives extension notification requests, correlates them with earlier client requests, checks whether a registered client is already viewing the target, and sends Expo push notifications when needed.

`app/src/notifications/RemuxNotificationProvider.tsx` registers a persistent client id, obtains an Expo push token, reports the active tab target to the runtime, suppresses foreground notifications for the visible target, and opens the matching tab when a notification is tapped.

The notification system is extension-shaped, but the current concrete long-running actions are Codex turns and compactions.

## Security Model

Remux currently assumes a trusted runtime and trusted clients. The runtime is unauthenticated and exposes filesystem and extension RPC capabilities to connected clients. Keep it bound to a trusted interface and avoid exposing it to untrusted networks.
