# CLI Rust Port — Pass 3a: Bearer-Token Auth

Status: Active Spec
Last verified: 2026-07-07
Canonical code: `cli/src/auth.rs` (new), `cli/src/runtime.rs`, `cli/src/config.rs`, `app/src/remote/`, `app/src/surfaces/viewer/ExtensionWebView.tsx`, `app/src/settings/SettingsOverview.tsx`

Parent: [cli-rust-port.md](cli-rust-port.md) (audit + roadmap). Predecessors: [cli-rust-port-pass-1.md](cli-rust-port-pass-1.md), [cli-rust-port-pass-2.md](cli-rust-port-pass-2.md) (both Implemented).

Pass 2 punted "auth token on `/ws` + HTTP" to pass 3 and recommended keeping it a focused pass. This is that pass: a single shared bearer token required on every runtime request. Nothing else from the pass-3 menu (CLI `status|logs|doctor`, resource guardrails) is in scope, except the one-line `remux token` subcommand the rollout needs.

## Threat model — what this is and is not

The runtime binds `0.0.0.0:48123` (`cli/src/config.rs:15`) and is reachable today by anything that gets past one ufw rule (`allow on tailscale0`). The protocol includes a terminal extension — network access is shell access.

**Defends against:** the firewall-slip scenario. A `ufw disable` during debugging, a reprovision that resets rules, or a future config mistake currently exposes an unauthenticated shell to the first port scanner that finds it. With this pass, that failure mode becomes "scanner finds a 401."

**Does not defend against (deliberately):**

- On-box attackers. The token file is readable by the `ubuntu` user; anyone with local code execution already owns the runtime.
- Transport snooping. There is no TLS in this pass; WireGuard (Tailscale) remains the encryption layer. The token crosses the wire inside the tunnel. Public/TLS exposure was considered and rejected — see the tailnet decision (2026-07-07): direct WireGuard adds ~0 latency, and exposing a remote-shell protocol publicly is all downside.
- Multi-user scenarios. One token, one owner. No per-device tokens, rotation UI, or lockout counters.

## Scope

**In**

- Runtime: token generation + persistence (`.remux/auth-token`, 0600), one auth middleware over the merged router (WS upgrade + all HTTP), health endpoints exempt, cookie hand-off for WebView subresources, constant-time compare, 401 journal lines.
- CLI: `remux token` subcommand (print the token, generating it if absent) — needed by the rollout.
- App: token field in connection settings (AsyncStorage, alongside host/port), `Authorization` header on the WS connect / catalog fetch / icon Images / WebView top document.
- Tests: middleware accept/reject matrix, token-file perms, WS integration with/without token, existing integration + chaos harnesses updated to authenticate.

**Out (later passes / rejected)**

- TLS or any public exposure (rejected — tailnet stays).
- `remux status|logs|doctor` beyond `remux token`.
- Token rotation flows, multiple tokens, per-client identity (client identity stays the in-band `remux/clients/register`).
- `expo-secure-store` — native module, excluded by the OTA-only rule; AsyncStorage is the storage (see Risks).
- Rate limiting / brute-force lockout (64-hex-char token over a tailnet; entropy is the defense).

**Compat note.** Pass 1/2 held "all WS surface changes are additive." This pass deliberately breaks unauthenticated clients — that is the point. The rollout section sequences app-before-runtime so the only client (the app) never sees a 401 in practice. `clients.json` and all RPC methods are unchanged; `config.toml` changes are additive.

---

## Token lifecycle (runtime)

New module `cli/src/auth.rs`.

**Resolution order** at worker boot (in `run_worker`, alongside the existing `REMUX_HOST`/`REMUX_PORT` resolution at `cli/src/runtime.rs:183-187`):

1. `REMUX_AUTH_TOKEN` env, if non-empty (tests, emergency override).
2. `.remux/auth-token` file, trimmed.
3. Neither → generate and persist.

**Generation:** 32 bytes from `/dev/urandom` (std-only, Linux-only — matches the runtime's platform), lowercase hex, 64 chars. Written with the crate's atomic pattern (temp + rename, as in `cli/src/extensions/runstate.rs:83-89`) plus `OpenOptionsExt::mode(0o600)` — the crate has no restricted-perms precedent yet; this introduces it. On read, if the file exists with broader perms, tighten to 0600 and journal a warning.

**Enforcement knob:** new config field `require_auth: Option<bool>` in `RemuxConfig` (default `true`). `RemuxConfig` is `deny_unknown_fields` (`cli/src/config.rs:22`), so the field must be added to the struct with the usual `unwrap_or` accessor. `require_auth = false` is the ssh-recoverable escape hatch: the token is still generated and logged-as-present, but the middleware passes everything. Journal a loud line at boot when auth is off.

The token is never journaled. Auth-failure journal lines carry remote IP and path only.

## Runtime middleware

One `axum::middleware::from_fn_with_state` layer inserted on the merged app in `run_worker` between the `.merge(...)` and `.into_make_service_with_connect_info` (`cli/src/runtime.rs:345-348`). One layer covers everything: the `/ws` upgrade GET rejects with 401 before the handshake, and the entire HTTP fallback tree is behind it. There are currently zero layers in the crate; this is the first.

Per-request logic:

1. **Exempt paths** — `/healthz`, `/readyz`, `/health` (exact match, same trio as `cli/src/http/mod.rs:38`) pass through. They return liveness only; keeping them open preserves dumb probes and gives a locked-out client something to distinguish "server down" from "unauthorized."
2. **Extract a candidate token**, first match wins:
   - `Authorization: Bearer <token>` header — the app's primary path (WS, fetch, Images, WebView top document).
   - `remux_auth` cookie — WebView subresources (see next section).
   - `token` query parameter — documented fallback for `curl` convenience and as insurance if RN's WebSocket `headers` option ever regresses. The journal never logs raw URLs today (`upgrade_handler` logs peer IP only); keep it that way so tokens never land in logs.
3. **Constant-time compare** against the expected token (small local XOR-fold `constant_time_eq` helper; no new crate). Length mismatch → immediate reject (length is not secret).
4. **Match** → pass. If the token arrived via the `Authorization` header and the request has no valid `remux_auth` cookie, append `Set-Cookie: remux_auth=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` to the response — this is the WebView hand-off. No `Secure` attribute (transport is plain HTTP inside WireGuard).
5. **No match / no token** → `401` with a small JSON body `{ "error": "unauthorized" }`, plus a journal line (`auth rejected <ip> <path>`).

## The WebView problem and the cookie hand-off

Viewer WebViews (`app/src/surfaces/viewer/ExtensionWebView.tsx:1210`) load runtime-hosted HTML which then pulls its own JS/CSS/asset subresources from the same origin. `source.headers` on react-native-webview applies **only to the top-level document request** — subresources carry no custom headers. Rewriting viewer bundles to token-ize every asset URL is invasive; a cookie is the standard answer:

1. App sets `source={{ uri, headers: { Authorization: 'Bearer <token>' } }}` on the WebView.
2. Runtime validates the header, serves the HTML, and appends the `Set-Cookie` (step 4 above).
3. The WebView's cookie store attaches `remux_auth` to every subsequent same-origin request — bundles, assets, in-page navigations, reloads.

Both WKWebView and Android WebView persist cookies from in-webview responses by default; no `sharedCookiesEnabled` (that flag shares the *native app's* cookie jar, which we don't need). The existing same-origin navigation guard (`ExtensionWebView.tsx:1502-1542`) already blocks cross-origin loads, so the cookie never has anywhere foreign to leak to.

Edge: a WebView whose cookie was cleared but whose top document is cached could 401 on subresources; the header on the next top-document load (any reload / tab reopen) re-establishes the cookie. Acceptable for a personal tool.

## App changes

Token storage and plumbing live where host/port already live.

- **`app/src/remote/remuxSettingsStore.ts`** — add optional `token` to the persisted shape under the existing `remux.connection.settings.v1` key (additive field; no version bump — absent token just means "send nothing", which matches a `require_auth = false` runtime). Export `authHeaders(): { Authorization: string } | undefined` and thread the token into the store's save/load.
- **`app/src/settings/SettingsOverview.tsx`** — a Token input beside Host/Port (`:236-246`): monospace, paste-friendly, masked with a show toggle, included in Save & Reconnect. When the catalog fetch fails with 401, surface "token rejected" instead of a generic connection error.
- **`app/src/remote/remuxRpcClient.ts:81`** — `new WebSocket(url)` → `new WebSocket(url, null, { headers })` with headers passed through `RemuxRpcClientOptions`. RN's WebSocket supports the third-arg headers natively on iOS/Android (this app is native-only — no `react-dom`, and `NSAllowsArbitraryLoads` already permits plain http). `RemuxConnectionProvider.tsx` supplies `authHeaders()` when constructing the client.
- **`app/src/remote/remuxExtensions.ts:99`** — catalog fetch gains `headers: authHeaders()`.
- **Icon Images** — `BrowserOverview.tsx:452`, `LauncherMenu.tsx:175`, `SettingsOverview.tsx:560`: introduce a `remuxImageSource(uri)` helper (returns `{ uri, headers }`) next to `remuxPublicUrl` and use it at all three sites. RN `Image` supports `source.headers` on both platforms. (`tab.previewUri` at `BrowserOverview.tsx:479` is a local view-shot file — untouched.)
- **`ExtensionWebView.tsx:1210`** — `source` gains `headers: authHeaders()` (top document only; subresources ride the cookie).

No change to viewer-kit or extension servers: viewers RPC through native postMessage (never talk to the network themselves), and extension server children are stdio-only with no port handoff (`cli/src/extensions/process.rs:52-99`) — the token never reaches them.

## `remux token` subcommand

`remux token` prints the resolved token to stdout (generating + persisting it if absent, same code path as worker boot). This solves the rollout chicken-and-egg: the token file doesn't exist until auth-aware code first runs, but the user must paste the token into the phone *before* restarting the runtime into enforcement. It's also the permanent "re-pair a device" story.

## Rollout (ordering matters — enforcement is a breaking change)

1. Land runtime + app code; `npm run build:cli`. The **old** worker keeps running unauthenticated — do not restart yet.
2. OTA-publish the app; update it on the phone. The app now *sends* a token when one is set; with none set it behaves exactly as today.
3. On the box: `./target/release/remux token` → copy the token to the phone (ssh from the MacBook, AirDrop/clipboard) → paste into Settings → Save & Reconnect. (Still accepted by the old worker, which ignores the header.)
4. App Settings → Restart runtime. The new binary boots, loads the same token file, and enforces. The app reconnects already-authenticated. (A worker restart bounces extension servers and live PTYs — normal hot-swap cost; pick a quiet moment.)

**Lockout recovery:** ssh from the MacBook → `cat ~/remux/.remux/auth-token` (re-paste on phone), or set `require_auth = false` in `.remux/config.toml` + `systemctl --user restart remux`, fix, re-enable.

## Testing

- **Unit (`cli/src/auth.rs`):** generation writes 64 lowercase hex chars with mode 0600; resolution order (env > file > generate); perms-tightening on loose files; `constant_time_eq` correctness.
- **Middleware matrix (runtime integration):** valid header / valid cookie / valid query → 200; missing / wrong / truncated token → 401 with JSON body; health trio → 200 with no token; header-auth response carries `Set-Cookie`, cookie-auth response does not re-set it; `require_auth = false` passes everything.
- **WS integration:** upgrade without token → HTTP 401 (no handshake); with token → connects, `remux/clients/register` works. Existing integration + chaos harnesses set `REMUX_AUTH_TOKEN` (or write the token file) and authenticate their test clients — this is the bulk of the churn.
- **App:** typecheck; phone validation checklist — catalog loads, all three icon sites render, a viewer loads *including its JS bundle* (proves the cookie hand-off), terminal PTY works over the authenticated WS, reconnect-after-background works, wrong token shows "token rejected," Restart runtime round-trips.

## Risks / accepted tradeoffs

- **AsyncStorage is not hardware-encrypted.** The token sits in the app's sandboxed storage. Acceptable: personal device, and `expo-secure-store` is barred by the OTA-only constraint. Revisit if a native-dep window ever opens.
- **Token in query param is supported** (curl convenience, WS-headers insurance). Mitigated: the runtime never logs URLs; the app never uses it.
- **One token forever** unless manually rotated (`rm .remux/auth-token` + restart + re-paste). Fine at this scale.
- **401 vs down ambiguity in the app:** RN's WebSocket surfaces a failed upgrade as a generic error, so the reconnect loop can't distinguish 401 from unreachable. The catalog fetch *can* see 401 — that's where "token rejected" surfaces. Reconnect backoff (`RemuxConnectionProvider.tsx:27`) already caps churn.
