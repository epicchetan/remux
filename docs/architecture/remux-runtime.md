# Remux Runtime Architecture

Status: Current
Last verified: 2026-07-07

Remux is split between a local Rust runtime and an Expo mobile shell. The runtime owns extension discovery, HTTP serving, websocket JSON-RPC, stdio extension servers, filesystem APIs, logging, restart behavior, and push notification delivery. The mobile shell owns tabs, WebViews, connection state, native file/media pickers, viewport metrics, keyboard behavior, and notification registration.

## Runtime Process

The runtime is the `remux` binary built from the `cli/` Cargo crate, layered for reliability:

```
L0  systemd user service   — boot start, supervisor death (deploy/systemd/remux.service)
L1  remux supervisor       — worker crash restart with backoff (cli/src/supervise.rs)
L2  extension containment  — crash budget, failed state (cli/src/extensions/supervisor.rs)
L3  process hygiene        — pgroups, PDEATHSIG, orphan sweep (cli/src/extensions/)
```

`remux start` runs a two-process tree:

- **Supervisor** (`cli/src/supervise.rs`): a minimal, std-only parent that spawns the worker and restarts it on *any* abnormal exit with capped backoff. Exit `75` is a deliberate restart request (`remux/system/restart`); exit `0` shuts the tree down. The supervisor never gives up, so the runtime stays remotely recoverable even after a worker crash.
- **Worker** (`cli/src/runtime.rs`): the actual runtime, marked by `REMUX_WORKER=<supervisor pid>` (honored only when it matches the parent pid, so shells spawned inside remux terminal sessions cannot accidentally start supervisor-less workers).

In production the tree runs under a systemd user service (`deploy/systemd/remux.service`, install runbook in the development guide) with linger enabled, so it starts on boot and outlives SSH sessions. A **hang watchdog** (`cli/src/watchdog.rs`) inside the worker converts a wedged event loop into a crash: a tokio task stamps a heartbeat every second, an OS thread aborts the process when the heartbeat is older than `watchdog_stale_seconds` (default 30, `0` disables), and the SIGABRT death takes L1's backoff path.

The worker assembles:

- `REMUX_HOST` / `REMUX_PORT`, with `.remux/config.toml` as the fallback (`cli/src/config.rs`)
- extension discovery from configured roots, defaulting to `extensions/` (`cli/src/extensions/`)
- one supervised stdio server per extension manifest that defines one
- viewer static serving for extension main views
- the HTTP server and the websocket server at `/ws`
- notification handling, the runtime journal, and graceful shutdown

The default bind is `0.0.0.0:48123`. Use `REMUX_HOST=127.0.0.1` for local-only development.

## Extension Supervision

`cli/src/extensions/supervisor.rs` runs one actor per extension with a state machine (`stopped`, `building`, `starting`, `running`, `stopping`, `backingOff`, `failed`). Crashes restart with capped backoff; five crashes in sixty seconds marks the extension `failed` until a manual start. An extension crash never terminates the runtime. Stop is stdin-EOF first, then SIGTERM to the process group, then SIGKILL to the group, and stop/restart RPCs only respond after the direct child is confirmed reaped and the group verified empty.

**Process hygiene (L3).** Every extension server (and build job) leads its own process group and takes `PDEATHSIG(SIGKILL)` at spawn (`cli/src/extensions/process.rs`). Group signals make kill escalation reach grandchildren; the crash path sweeps the dead child's group before any respawn. Live groups are recorded in `.remux/run/extensions.json` (`cli/src/extensions/runstate.rs`) with `/proc` start-ticks as a pid-reuse guard, and a boot-time sweep kills anything a previous worker left behind — a respawned worker can never coexist with a hung predecessor's extension servers.

**Build phase.** A manifest's `server.build` declares how to produce the server binary that `server.command` points at (both real extensions run `cargo build --release` into `/tmp` target dirs). The build runs when the binary is missing (e.g. after a reboot cleared `/tmp`), when a start/restart RPC passes `rebuild: true`, or under `remux start --rebuild`. Build output lands in the extension log ring prefixed `[build]`; a failed build lands the extension in `failed` with `lastExit` reason `build-failed` without consuming crash budget. Production never runs `cargo run`.

Extension stderr goes to rotated per-extension files under `.remux/logs/extensions/` plus an in-memory ring served over `remux/extensions/logs` (with subscribe/follow variants). The runtime journal is written to `.remux/logs/runtime-<runId>.jsonl` with retention controlled by `log_retention_days`.

## Resource Monitoring

`cli/src/monitor.rs` samples every `resource_poll_seconds` (default 5) from `/proc` directly (no extra dependencies): per-extension CPU/RSS/process-count by scanning process groups, system load/memory/disk, and the runtime's own usage. The latest sample is served over `remux/system/resources`; `remux/system/resources/subscribe|unsubscribe` are client-scoped and stream `remux/system/resources/didSample` per tick while the app's Settings surface is visible. An optional `extension_memory_ceiling_mb` raises a journal warning plus a system push (hourly-throttled per extension) when an extension's group RSS crosses it — alert only, no auto-kill.

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
- `remux/system/resources` (plus client-scoped `resources/subscribe` and `resources/unsubscribe`)
- `remux/extensions/status`
- `remux/extensions/start` (optional `rebuild: true`)
- `remux/extensions/stop`
- `remux/extensions/restart` (optional `rebuild: true`)
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

The notification system is extension-shaped, but the current concrete long-running actions are Codex turns and compactions. Separately, **system pushes** (`data.kind: "system"`, reasons `extension-failed` / `memory-ceiling`) go to every registered client with a token, are never visibility-suppressed, and open the Settings surface when tapped.

## Security Model

Remux currently assumes a trusted runtime and trusted clients. The runtime is unauthenticated and exposes filesystem and extension RPC capabilities to connected clients. Keep it bound to a trusted interface and avoid exposing it to untrusted networks.
