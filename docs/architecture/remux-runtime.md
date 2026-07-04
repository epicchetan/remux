# Remux Runtime Architecture

Status: Current
Last verified: 2026-06-28

Remux is split between a local Node runtime and an Expo mobile shell. The runtime owns extension discovery, HTTP serving, websocket JSON-RPC, stdio extension servers, filesystem APIs, logging, restart behavior, and push notification delivery. The mobile shell owns tabs, WebViews, connection state, native file/media pickers, viewport metrics, keyboard behavior, and notification registration.

## Runtime Process

`bin/remux.js` is the CLI entrypoint. `remux start` supervises the runtime worker; exit code `75` requests a restart.

`cli/start.cjs` assembles the runtime:

- reads `REMUX_HOST` and `REMUX_PORT`
- reads `.remux/config.toml`, with environment variables as overrides
- discovers extensions from configured roots, defaulting to `extensions/`
- starts stdio extension servers when manifests define one
- creates viewer providers for extension main views
- starts the HTTP server
- attaches the websocket server at `/ws`
- wires notification handling and graceful shutdown

The default bind is `0.0.0.0:48123`. Use `REMUX_HOST=127.0.0.1` for local-only development.

## HTTP Surface

`cli/httpServer.cjs` serves:

- `/health`, `/healthz`, `/readyz`
- `/remux/extensions`
- `/remux/extensions/<id>/icon`
- `/`, which redirects to the default extension viewer
- extension viewer routes such as `/viewers/codex`

`cli/viewerProvider.cjs` serves built static viewer assets from each manifest's `views.main.entry`. It blocks path traversal and falls back to the entry HTML for viewer routes.

## Websocket And RPC

`cli/wsServer.cjs` accepts JSON-RPC websocket connections at `/ws`.

`cli/rpcRouter.cjs` routes:

- `remux/system/restart`
- `remux/extensions/status`
- `remux/extensions/start`
- `remux/extensions/stop`
- `remux/extensions/restart`
- `remux/fs/*`
- extension-prefixed methods such as `remux/codex/*`

`cli/extensionProcess.cjs` launches stdio extension servers and forwards newline-delimited JSON-RPC to them.

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

`cli/notifications.cjs` receives extension notification requests, correlates them with earlier client requests, checks whether a registered client is already viewing the target, and sends Expo push notifications when needed.

`app/src/notifications/RemuxNotificationProvider.tsx` registers a persistent client id, obtains an Expo push token, reports the active tab target to the runtime, suppresses foreground notifications for the visible target, and opens the matching tab when a notification is tapped.

The notification system is extension-shaped, but the current concrete long-running actions are Codex turns and compactions.

## Security Model

Remux currently assumes a trusted runtime and trusted clients. The runtime is unauthenticated and exposes filesystem and extension RPC capabilities to connected clients. Keep it bound to a trusted interface and avoid exposing it to untrusted networks.
