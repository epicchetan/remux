# Viewer direct host transport

## Connection and request mechanism

`initializeIpc()` installs `directHost.ts` in a top-level browser window without
a React Native bridge or an installed protected transport. Native and embedded
viewers keep their existing transports. The direct host dispatches ordinary
`message` events containing viewer-kit envelopes; it does not impersonate a
React Native WebView.

The host opens same-origin `/ws` over `ws:` or `wss:` with the browser's auth
cookie. It sends `remux/system/ping`, waits for the result, then sends
`remux/system/info`. Both have query contracts, with resource keys `system-ping`
and `system-info`. **Verified protocol correction:** the runtime rejects a
`liveness` contract with `Invalid or missing remuxContract`; the app also sends
ping as a query. The method is assigned to the runtime's liveness lane.

Only after both replies does the host emit, in order:

1. `remux/status` connected, containing `cwd` and generation.
2. `host/connection` connected, containing the same generation.
3. `host/active {active: true}`.
4. `remux/lifecycle {state: active, reason: connect, epoch, inactiveForMs: 0}`.

The current system-info response contains `cwd` and `serverInstanceId`, but no
generation. The direct host advances its connection counter on each handshake;
if info includes a generation, it uses at least that value. Epoch also advances.
No client registration or active-tab event filtering occurs.

Each viewer request becomes `{jsonrpc: '2.0', id, method, params?,
remuxContract, remuxContext: {tabId, resourceKey}}`. The tab id comes from
`remuxTabId` or a generated `direct:<uuid>`. Resource context is read from the
current URL on every request, using the shared `route.ts` serializer.
`/viewers/<extension>/<view>` identifies a view; absent view ids, `index.html`,
and `_bundle/<revision>` use `main`, matching all current extension manifests.
The app imports these same resource-key helpers; its old module is deleted.

Replies preserve ids, results, and RPC error details. Frames without ids become
viewer events. Runtime requests receive method-not-found. Cancel sends
`$/cancelRequest {id}`; canceling a queued request removes it before dispatch.
Notifications forward unchanged except preview invalidation, which is local.
Health pongs and WebView log envelopes need no direct-host action.

Connection/handshake timeout is 10 seconds. Disconnect emits `closed` so IPC
rejects pending requests, drops unsent work, then reports `reconnecting` with
an attempt counter. Retry delays are 250, 500, 1000, 2000, 4000, then 5000 ms.
Success resets attempts and repeats the handshake announcements. At most 64
new requests/notifications can wait for connection; old requests are not replayed.

## Local host calls

| Method | Browser behavior |
| --- | --- |
| viewport/get; keyboard/dismiss | Window dimensions, zero insets/keyboard; resize emits viewport/changed. |
| theme/get | System color preference; changes emit host/theme. |
| preview/invalidate | Successful no-op. |
| tab/update | Updates title and route query parameters with history.replaceState. |
| clipboard/read | Returns `{text}`; unavailable/denied clipboard returns empty text. |
| view/reload; navigate | Acknowledge, then reload or assign the current route with requested parameters. |
| link/open | Validated HTTP(S) URL opened with window.open(url, '_blank'). |
| file/open | `{path, line}` becomes an editor-view URL with file identity and line focus; opens a new tab. |
| attachments/pick; overview/open; tab/close | Error -32601 naming the direct host. |

## Headless helper and authentication

`npm run view:open -- agent --shot /tmp/x.png` launches disposable headless
Chromium, installs `.remux/auth-token` as an HttpOnly cookie, and waits for
`window.__REMUX_DIRECT_HOST__.status.type === 'connected'`. Timeout diagnostics
include the last transport status. Console and page errors go to stderr.
`REMUX_HOST`/`REMUX_PORT` select the host (default 127.0.0.1:48123).
Resource kind/id and tab id flags populate route parameters. `--mobile` uses
the agent tests' Pixel 5 profile; `--full` captures full-page screenshots.
`--keep` prints a real loopback CDP endpoint and waits for SIGINT. Each invocation
owns its browser/profile and cleans up on exit; browsers do not survive turns.
The old live acceptance script now uses this transport, with its shim deleted.

Auth middleware now sets `remux_auth` after successful query-token auth as well
as header auth, enabling a pasted tokenized URL to load protected subresources.
The live smoke spec is isolated behind `npm run test:viewer:live`; it skips only
when `/readyz` does not return 200. Fixture viewer tests exclude `tests/live`.

## Verification observed (2026-09-15)

| Command/check | Actual result |
| --- | --- |
| Root `npm run typecheck`; app `npm run typecheck` | Both exit 0; no TypeScript errors. |
| `npm run test:viewer-kit` | `tests 12`, `pass 12`, `fail 0`. |
| `npm run test:runtime -- auth` | 8 unit, 3 auth integration, 1 gateway passed; 0 failed. |
| `npm run test:runtime` | 150 unit + 101 integration passed, including all 6 auth integration tests; 0 failed. |
| `npm run test:agent` | Server and unit stages passed; viewer stage: `3 failed`, `4 skipped`, `285 passed (1.0m)`. Failures were existing error-geometry assertions. |
| Agent `npm run test:viewer -- viewer-error-geometry.spec.ts --workers=1` | `6 passed (9.3s)`; no layout code changed. |
| Agent `npm run build:viewer` | `4662 modules transformed`, `built in 654ms`; warning about chunks over 500 kB. |
| `npm run test:viewer:live` | Initial liveness-contract attempt failed; corrected query contract: `1 passed (952ms)`. |
| `npm run view:open -- agent --shot /tmp/remux-direct-host-desktop.png` | `Connected: http://127.0.0.1:48123/viewers/agent/`; screenshot saved, exit 0. |
| `npm run view:open -- agent --mobile --full --shot /tmp/remux-direct-host-mobile.png` | Connected; screenshot saved, exit 0. Both images inspected. |
| `npm run view:open -- agent --keep` | Printed CDP endpoint; external CDP client confirmed connected shell and no native bridge. SIGINT: exit 130, endpoint closed; controlled repeat confirmed `Temporary profile removed: true`. |
| `npm run view:open -- --help` | Usage printed, exit 0. |

Both direct and immutable routes serve `index-CodLcxwL.js`, byte-identical to
the build (SHA-256 `e720515408ed3971f0ccf7cca89e6683b1950e71dbff6339f7bd2045d3c89c12`).
Published revision: `sha256-8cf3f2281d064e27a17790ed7508fdf8998ee00af0f0b20f9e58604adc02a9cf`.
The live spec saved `test-results/agent-live/**/viewer-direct-host.png`.
No runtime/extension restart, runtime release build/install, or Git mutation ran.
The cookie middleware change is tested but **pending runtime build/restart**:
the running query-token response remains HTTP 200 with no Set-Cookie header.
