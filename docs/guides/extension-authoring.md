# Extension Authoring

Status: Current
Last verified: 2026-06-28

Remux extensions live under an extension root and are discovered by `remux-extension.json`. By default the runtime scans `extensions/*`; `REMUX_EXTENSION_ROOTS` can override the roots.

## Manifest

Manifest version `1` is required.

```json
{
  "version": 1,
  "id": "example",
  "name": "Example",
  "display": {
    "title": "Example",
    "icon": "assets/example.svg"
  },
  "views": {
    "main": {
      "route": "/viewers/example",
      "entry": "viewer/dist/index.html"
    }
  },
  "launchers": [
    {
      "id": "open",
      "view": "main",
      "label": "Example"
    }
  ],
  "fileHandlers": []
}
```

`views.main` is required. The runtime currently creates viewer providers for main views. The manifest parser validates multiple views, but full multi-view serving is not the stable contract yet.

## Viewer Contract

Viewers are static web apps served by the Remux runtime. The runtime serves assets from the directory that contains the manifest entry file and falls back to the entry HTML for routes under the viewer route.

Viewer code can use `@remux/extension-api` for host IPC helpers:

- `openHostOverview`
- `openHostFile`
- `reloadHostView`
- `updateHostTab`
- `dismissHostKeyboard`

The mobile host bridge handles native file/media pickers, viewport metrics, tab updates, and forwarded Remux RPC requests.

## Extension Servers

Extensions may define a stdio JSON-RPC server:

```json
{
  "server": {
    "transport": "stdio",
    "command": "node",
    "args": ["server/index.js"],
    "cwd": "."
  }
}
```

Only `stdio` transport is currently supported. The runtime launches the process, sends newline-delimited JSON-RPC requests, and forwards extension notifications back to connected clients.

Extension-prefixed methods are routed by id. For example, the Codex extension handles methods under `remux/codex/*`.

## Launchers And File Handlers

Launchers expose extension entry points in the mobile app. File handlers describe which extensions can open files by extension and route the app to the matching viewer.

Each launcher or file handler can specify:

- `id`
- `label`
- `icon`
- `view`
- route metadata such as `launch`, `resourceKind`, and `resourceId`

Route metadata becomes part of the browser tab target and notification target matching.

## Current Limits

- Dev viewer proxies are rejected by manifest validation.
- Runtime authentication is not implemented.
- Extension server crashes are treated as runtime-fatal.
- Viewer assets must be built before the runtime can serve them.
