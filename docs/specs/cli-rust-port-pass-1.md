# CLI Rust Port — Pass 1 Implementation Spec

Status: Active Spec
Last verified: 2026-07-06
Canonical code: `bin/remux.js`, `cli/*.cjs`, `cli/core/*.cjs`, `cli/tests/*.test.js` (source of truth being replaced); new code lands in `cli-rs/`

Parent: [cli-rust-port.md](cli-rust-port.md) (audit + full roadmap). This spec is the buildable plan for pass 1: a single pass that replaces the Node CLI with a Rust runtime and ends with the Node CLI deleted.

## Scope

**In pass 1**

- Full functional replacement of `bin/remux.js` + `cli/` in Rust: config, discovery/manifests, HTTP, WS JSON-RPC, extension stdio bridge, fs core, fs relay, notifications, logging.
- **L1** supervisor: restart the worker on *any* abnormal exit with backoff (not just exit 75).
- **L2** extension crash containment: per-extension state machine with backoff and a crash budget; an extension crash never terminates the runtime (deletes the `ctx.fatal` escalation).
- **Stop that actually stops**: stdin-EOF-first graceful shutdown → SIGTERM → SIGKILL with confirmed reap. This is deliberately *not* full L3 (no process groups, no PDEATHSIG, no boot-time orphan sweep) but eliminates the EPIPE crash class, the lying `status()`, and the restart double-instance race.
- Per-extension logs: stderr to rotated per-extension files + in-memory ring, exposed over new RPC (snapshot + follow).
- Runtime journal with rotation/retention (replaces the unbounded double-write `.remux/logs` scheme).
- Cutover: delete `bin/remux.js` and `cli/`, update npm scripts and docs.

**Punted to pass 2+** (tracked in the parent spec)

- L0 systemd unit / linger / watchdog.
- Full L3 process hygiene: process groups, `PR_SET_PDEATHSIG`, pidfile recording + boot-time orphan reaping.
- Resource monitoring (`sysinfo`, `remux/system/resources*`).
- Manifest `build` phase / prebuilt server binaries — manifests keep `cargo run` unchanged.
- App Settings UI for extension state/logs (pass 1 ships the RPC surface only; the app runs unmodified).
- Auth token; cargo workspace unification with the extension server crates.

## Ground rules

- **Protocol compatibility is absolute.** Every existing HTTP endpoint, WS method, JSON shape, error code, and stdio framing behavior is preserved byte-for-byte in structure (field names, defaults, fallbacks). New surface is strictly additive. The app and the codex/terminal servers must work with zero changes.
- The Node test suite (`cli/tests/*.test.js`) is the behavioral spec; each file maps to Rust tests (§Testing).
- Single user, no migration shims — but on-disk formats that survive cutover must stay readable: `.remux/notifications/clients.json` (push tokens) and `.remux/config.toml` keep their formats.

## Crate layout

```
cli-rs/                       # renamed to cli/ in the cutover commit
  Cargo.toml                  # package name: remux, bin name: remux
  src/
    main.rs                   # arg parsing; supervisor vs worker dispatch
    supervise.rs              # L1: std-only supervisor loop
    runtime.rs                # worker assembly, shutdown, panic policy
    config.rs
    logs.rs                   # journal + per-extension logs + retention
    rpc/{jsonrpc,router,ws}.rs
    http/{mod,catalog,icons,viewers}.rs
    extensions/{manifest,discovery,supervisor,process}.rs
    fs/{core,git,relay}.rs
    notifications.rs
  tests/                      # integration tests
  tests/fixtures/             # fixture extension (see §Testing)
```

Root `Cargo.toml` workspace with sole member `cli-rs`, `exclude = ["extensions/*"]` so the extension server crates keep their standalone builds (codex builds `--offline`; do not perturb its lockfile).

Dependencies (keep to this set): `tokio` (rt-multi-thread, macros, process, signal, sync, time, io-util, fs, net), `axum` (ws), `serde`, `serde_json`, `toml`, `notify`, `reqwest` (rustls-tls, json), `tracing`, `tracing-subscriber`, `sha1`, `nix` (signal), `clap` optional — arg surface is just `remux start`, matching `cli/main.cjs:8-12` (anything else prints `Usage: remux start`, exit 1); hand-rolling is fine.

Rust hygiene: `#![deny(warnings)]` in CI mood but not in code; `clippy` clean; no `unwrap()` outside tests — every I/O error path must map to a logged event or a JSON-RPC error, never a panic.

## L1 — supervisor (`main.rs` + `supervise.rs`)

Same two-process shape as `bin/remux.js`: `remux start` without `REMUX_WORKER=1` supervises; with it, runs the worker. The supervisor is **std-only** (no tokio): spawn `current_exe()` with `REMUX_WORKER=1`, stdio inherited, block on `wait()`.

Restart policy (replaces `bin/remux.js:41-60`):

| Worker exit | Action |
| --- | --- |
| code 75 (`REMUX_RESTART_EXIT_CODE`) | restart immediately; reset backoff |
| code 0 | supervisor exits 0 |
| any other code, or killed by signal | restart after backoff |

Backoff: `min(250ms × 2^n, 5s)`; `n` resets to 0 after the worker has stayed up 60s. **Never give up** — the loop runs until the supervisor itself is signaled. Every restart logs to stderr (the journal belongs to the worker): `remux: worker exited (<code|signal>), restarting in <delay>` .

Signals: SIGINT/SIGTERM → forward to worker, wait up to **7s**, then SIGKILL; exit with the worker's code. (Today the supervisor waits forever — `bin/remux.js:63-71`.) Use `signal_hook::flag` + a wait-with-timeout loop; no async needed.

## Worker assembly + shutdown (`runtime.rs`)

Startup order mirrors `cli/start.cjs:18-107`: config → journal → discovery → default launch extension (first sorted id with non-empty launchers, else first — `start.cjs:138-140`) → notification manager → extension supervisors → core router → fs relay (subscribed to fs-core served events) → RPC router → viewer providers → HTTP server bound → WS attached → relay started → extension servers started → listen log block (same lines as `start.cjs:190-216`).

- No extensions discovered → startup error, exit non-zero (supervisor backs off — do not hot-loop at 250ms forever on a config error; the backoff cap makes this a 5s retry, acceptable and self-healing when the config is fixed).
- Bind failure (`EADDRINUSE` from a lingering predecessor): retry the bind for up to 10s before failing.

**Shutdown**: SIGINT/SIGTERM → graceful sequence (relay close → WS close → extension stops in parallel → HTTP close) raced against a **5s hard deadline**, then `process::exit`. This fixes the current unbounded signal-path hang (`start.cjs:109-114`).

**`remux/system/restart`**: unchanged contract (`start.cjs:52-67`): respond `{restartable:true, restarting:true}`, then after 200ms run graceful shutdown with a 2s force timer, exit **75**.

**Panic policy**: install a panic hook that writes the panic (with backtrace) to the journal and stderr. Request-scoped work is wrapped so errors become JSON-RPC `-32603` responses. The long-lived critical tasks (HTTP accept loop, per-extension actors, relay) are spawned through a `spawn_supervised(name, fut)` helper: if such a task ever returns/panics unexpectedly, log `fatal:task-died` and exit **75** so L1 restarts a coherent process rather than limping with a dead subsystem. This is the Rust equivalent of the missing `uncaughtException` handler, with a correct restart code.

## Config (`config.rs`)

Real `toml` parse of `.remux/config.toml`, replacing the hand-rolled subset (`cli/config.cjs`). Struct with `deny_unknown_fields` so typos still fail loudly. Keys:

```toml
host = "0.0.0.0"                 # default
port = 48123                     # default
extension_roots = ["extensions"] # default; relative paths resolve against rootDir
log_retention_days = 14          # new
```

`extensionRoots` (camelCase) was accepted by the old parser — accept it as a serde alias. Precedence identical to today: `REMUX_HOST` / `REMUX_PORT` env over config over defaults (`start.cjs:131-136`); `REMUX_EXTENSION_ROOTS` (platform path-delimiter separated) overrides config roots entirely (`extensionRegistry.cjs:38-50`). Port validation: integer 1..=65535, same error text shape (`Invalid REMUX_PORT value: …`).

## Manifests + discovery (`extensions/manifest.rs`, `discovery.rs`)

Serde-based port of `cli/extensionManifest.cjs` with the same validation errors and the same normalization:

- `version` must be 1; `id` non-empty; `views.main` required; every view needs non-empty `entry`, optional `route` starting with `/` (default `/viewers/<id>` for main, `/viewers/<id>/<viewId>` otherwise), `dev` rejected; route trailing-slash normalized.
- `server` optional; `transport` must be `stdio`; `command` non-empty; `args` string array default `[]`; `cwd` resolved against the manifest dir (default `.`).
- Display/launcher/fileHandler rules: title fallback chain (`display.title` → `name` → `id`), label fallbacks, `.svg` icons rejected with the same message, `iconDark` requires `icon`, unique entry-point ids, launcher `route` `{kind:'launch', launch?, resourceKind?}` normalization to nulls, **iconPair inheritance**: an entry with its own `icon` never inherits `display.iconDark` (`extensionManifest.cjs:390-404`); entries without one inherit both display variants. `viewRoute` denormalized onto launchers/handlers.
- Discovery (`extensionRegistry.cjs`): for each root, each child dir containing `remux-extension.json`, load; sort by id (ids are ASCII; plain lexicographic sort replaces `localeCompare`). A manifest that fails validation aborts startup (today's behavior — keep; the supervisor's 5s backoff makes this recoverable-by-edit).

## JSON-RPC + router (`rpc/jsonrpc.rs`, `rpc/router.rs`)

Direct port of `cli/jsonRpc.cjs` (frame parse, id-or-null, request/response classification, error normalization, `withJsonRpcVersion`) and `cli/rpcRouter.cjs`. Error codes preserved exactly: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal, `-32000` extension-layer, `-32010`/`-32011` fs read errors.

Dispatch order (per `rpcRouter.cjs:33-65` + ws layer): system methods (`remux/system/{ping,info,restart}`) → extension management (`remux/extensions/{status,start,stop,restart}`) → core (`remux/fs/*`) → extension by method prefix `^remux/([^/]+)/` else default extension. `remux/clients/register` is intercepted at the WS layer by the notification manager before the router (`wsServer.cjs:150-160`). `system/ping` → `{ok:true}` (half-open-socket probe — keep the comment); `system/info` → `{cwd}`.

Extension management responses keep their exact shapes (including the degenerate `{extensionId, restartable:false, running:false, started:false}` fallbacks) but gain additive fields from the state machine (§L2): `state`, `pid`, `startedAtMs`, `restartCount`, `lastExit: {code, signal, at} | null`.

## WS server (`rpc/ws.rs`)

Axum WS upgrade at `/ws` only (exact-path match on pathname, `wsServer.cjs:231-238`). Per-client state: outbound mpsc sender, pending host→client request map (ids `remux-host:<n>`, default timeout 1s; visibility checks pass 500ms), `client_id`/`session_id` slots set by registration.

Frame handling ported 1:1 from `handleDownstreamFrame` (`wsServer.cjs:109-166`):

- parse error → error frame with null id;
- response → resolve pending host→client request (warn on unmatched);
- request → notifications intercept for `remux/clients/register`, else `router.handle_request`; then `notifications.record_client_request` with the **full request message** — the app sends a top-level `remuxContext` field on requests (`notifications.cjs:150`), so the WS layer must retain unknown top-level fields on the parsed request;
- non-request with method → `remux/app/log` diagnostics into the journal (same `[remux:app] <ts> <label> <detail>` formatting, `wsServer.cjs:248-269`) or forwarded as a notification to the extension via the router;
- broadcast = fan-out of `withJsonRpcVersion` frames to OPEN clients; a failed/lagging client send drops that client.

Close/error paths reject that client's pending requests and call `notifications.on_client_disconnected` and the relay's client-count hook (poller gating).

## L2 — extension supervision (`extensions/supervisor.rs`, `process.rs`)

One actor task per extension with a server manifest, owning the child process and a command mailbox (start/stop/restart/rpc/notify/status). This replaces `createExtensionProcess` (`cli/extensionProcess.cjs`) and **removes the `ctx.fatal` escalation entirely** — nothing an extension does can terminate the runtime.

### State machine

```
Stopped ──start──▶ Starting ──spawned──▶ Running
Running ──stop──▶ Stopping ──reaped──▶ Stopped
Running ──exit code 0 (unprompted)──▶ Stopped            # clean self-exit: no restart (today: silent not-running)
Running ──crash (signal / code≠0)──▶ BackingOff{n} ──delay──▶ Starting
BackingOff: crash budget exceeded (5 crashes in 60s) ──▶ Failed{reason}
Failed ──manual start / runtime restart──▶ Starting
```

- Backoff delay: `min(500ms × 2^n, 10s)`. Budget window and counts are constants in pass 1 (no config).
- Manual `stop` always lands in `Stopped` (no auto-restart); manual `start` is idempotent when Running (returns current status, `extensionProcess.cjs:19-23`).
- Every transition emits a journal event and broadcasts `remux/extensions/didChangeStatus` `{extensionId, state, running, restartable, pid, startedAtMs, restartCount, lastExit}` to all clients (additive; today's app ignores unknown notifications).
- Spawn failure (`command` not found etc.) counts as a crash → BackingOff, not Failed-immediately and *not* runtime-fatal (today: fatal, `extensionProcess.cjs:43-57`).
- `Failed` is terminal until manual intervention; entering it logs at error level with the last stderr tail attached.

### Process I/O

Spawn via `tokio::process::Command`, `kill_on_drop(true)` (worker death takes the direct child with it — cheap insurance until full L3), stdio all piped, cwd from manifest.

- **stdin**: owned by a single writer task fed by an mpsc channel. All RPC/notification writes go through the channel; the writer logs-and-drops on write error. Nothing else touches stdin. This is the structural fix for the incident EPIPE — there is no code path where a pipe error surfaces as an unhandled event.
- **stdout**: line reader → `serde_json` parse → response? resolve pending map (id, method, timer — reject with `-32000 "<method> timed out"` after **300s**, same default as `extensionProcess.cjs:6`) → else notification: methods starting `remux/notifications/` get `extensionId` injected into params (`normalizeExtensionNotification`, `extensionProcess.cjs:266-278`) and are offered to the notification manager first, broadcast to clients only if unhandled; other methods broadcast as-is. Invalid JSON lines log a warning and are skipped.
- **stderr**: line reader → per-extension log sink (§Logs). No longer mirrored into the main journal as `extension:stderr` events; lifecycle events (`extension:start/stop/restart/exit` with the same labels/details) stay in the journal.
- Generation counter guards stale reader/exit events across restarts exactly as today (`extensionProcess.cjs:27, 44, 59, 91`).
- Pending requests are rejected on exit/stop with the same `-32000` messages (`extension <id> exited` / `stopped` / `is not running`).

### Stop sequence (the L3-lite core)

`stop()`:

1. mark Stopping; reject pending; close the stdin channel and **drop `ChildStdin`** → the extension sees EOF. Both existing servers treat EOF as shutdown (codex: `for line in stdin.lock().lines()` ends, `main.rs:77`; terminal: runs `kill_all()` then exits, `main.rs:78`). With `cargo run`, stdin is passed through to the binary, so EOF reaches the *grandchild* — this cleanly shuts down the real server despite the cargo wrapper, which SIGTERM today does not.
2. wait up to **2s** for exit;
3. SIGTERM, wait up to **2s**;
4. SIGKILL, await reap unconditionally.

`stop`/`restart` RPCs return only after the reap, so `restart` can never overlap two live instances of the direct child and the reported status is truthful. Worst case ~4s, within the app's request tolerances (its own host-call default timeouts are ≥10s; verify during manual validation).

## HTTP (`http/*`)

Ported endpoint-for-endpoint from `cli/httpServer.cjs` + `cli/viewerProvider.cjs`:

- `/health`, `/healthz`, `/readyz` → `{ok:true, defaultExtension, service:'remux'}`.
- `/remux/extensions` → catalog with the exact shape of `extensionCatalog` (`httpServer.cjs:71-108`): `defaultExtensionId`, `service`, per-extension `display{title,iconUrl,iconDarkUrl}`, `launchers[]`/`fileHandlers[]` (with per-entry icon URLs), `views` (routes only). Icon URLs keep the `?format=&kind=&id=&variant=` query construction.
- `/remux/extensions/<id>/icon` with `kind`/`id`/`variant` query: same resolution + dark→light fallback (`iconVariantPath`, `httpServer.cjs:159-170`), `cache-control: no-cache`, same content-type table, 404 text `Extension icon not found.`.
- `/` → 302 to `<default main route>/`.
- Viewer static serving per extension route: exact-route and `route/` serve the entry; deeper paths resolve under the entry's dir with the traversal guard (`relative(root, candidate).startsWith('..') → entry`, `viewerProvider.cjs:52-67`); missing file falls back to entry (SPA), 404 only if the entry itself is missing; content-type table from `viewerProvider.cjs:69-92`.
- Unmatched → 404 `Not found.`.

Hand-roll the static file handler rather than using `ServeDir` — the entry-fallback and traversal semantics above are the contract.

## fs core (`fs/core.rs`, `fs/git.rs`)

Port of `cli/core/fs.cjs` with identical method names, params, result shapes, and error codes:

- `remux/fs/readDirectory` `{path?, force?}`; `remux/fs/readDirectories` `{paths, force?}` (batch concurrency 4, per-entry `{ok, path, value|message}`); `remux/fs/readFile` `{path?, format?: 'base64', git?: {includeStatus?, includeBase?}}`.
- Directory results: entries (lstat-based `kind`/`sizeBytes`/`modifiedAtMs`, symlink `targetKind`), sorted directories-first then name (numeric-aware, case-insensitive natural sort — a small hand-rolled comparator replaces `localeCompare(…, {numeric:true, sensitivity:'base'})`; exact ICU parity is not required), git annotation per entry, `parentPath`, `version` (stable sha1 over the serialized entries; only compared for equality client-side, so byte-parity with Node is not required), entry-stat concurrency 24.
- Caches with the same TTLs: directory 3s + in-flight dedup, git status 1s per repo root, repo root 5s; `invalidate({paths, underRoots})` and the served-directory listener feed (`subscribe`) that the relay consumes.
- File reads: 1 MiB text / 5 MiB base64 caps → `tooLarge` with null content; binary sniff (NUL in first 4096 bytes, or >10% suspicious control bytes) ported verbatim; base64 mode returns `dataBase64` + `mimeType` from the image-extension table; optional `git` metadata block with `status` and HEAD `base` content (via `git cat-file -s` size check then `git show`), including all the `unavailableReason` fallbacks (`fs.cjs:505-633`).
- Git status: `git status --porcelain=v1 -z --untracked-files=all` via `tokio::process`, porcelain parse incl. rename second-token skip, status classification table (`gitStatusFromPorcelain`), directory-descendant aggregation, `summarizeGitStatuses` ranking. `isPathWithin` keeps the boundary-safety contract (root == target is within; `/repo2` not within `/repo`); the macOS `/var`↔`/private/var` candidates trick can be dropped (Linux host) but keep the function shape and tests.

## fs relay (`fs/relay.rs`)

Port of `cli/fsRelay.cjs` preserving the three-layer contract documented at `fsRelay.cjs:17-24` and in `docs/specs/files-tab.md`:

1. Non-recursive watcher per served directory (`notify` with `RecursiveMode::NonRecursive`), registered from the fs-core served feed, LRU-capped at 256 with 10-min idle eviction.
2. A `.git` dir watcher per known repo root, filtering to `HEAD`/`index`/unknown filenames, with a debounced porcelain **confirm** so index churn without status change stays silent (`scheduleGitConfirm`/`confirmGitDirty`), and a seeded baseline at registration.
3. A git-status poller (2.5s) running only while `clientCount > 0`, diffing porcelain snapshots into changed directories (`changedStatusDirectories` + `parsePorcelainRecords`, incl. rename both-sides handling).

Dirty paths debounce 250ms, broadcast at most once per 1s with a trailing flush; **fs-core cache invalidation runs before each broadcast** (the stale-read race guard, `fsRelay.cjs:341-353`); message is `remux/fs/didChange {changedPaths, gitDirtyRoots}` (sorted). Watcher errors drop the watcher (directory case) or null it (repo case) without propagating.

## Notifications (`notifications.rs`)

Port of `cli/notifications.cjs` 1:1, including its extension-specific correlation tables (codex turn/compact methods, terminal session start/attach/kill → audience record/remove with `once`/`target` lifetimes) — this hardcoded knowledge is acknowledged debt, not to be redesigned in this pass.

- `remux/clients/register` (WS-layer intercept): registration parse, per-client sessions map, expo token persistence to `.remux/notifications/clients.json` — **same file format, version 1**, so existing push tokens survive cutover.
- Extension-originated `remux/notifications/request`: intent parse/validation, audience key (8-part join, `notifications.cjs:676-698`), per-audience delivery: skip-if-visible via host→client `remux/notifications/visibility/check` (500ms timeout, any session visible suppresses), then Expo push POST (`exp.host/--/api/v2/push/send`, same payload incl. `channelId: remux-extension-events`, `data.remuxNotificationIntent`, priority/interruption/sound) via `reqwest`; ticket handling incl. `DeviceNotRegistered` token clearing. `once` audiences consumed on delivery.
- `remux/notifications/audience/remove` and kill-request-driven removal with the exact-key-else-tab-target-match fallback (`notificationAudienceRemovalKeys`).
- `record_client_request` correlation reads `remuxContext {resourceKey, tabId}` from the raw request and stamps `originResourceKey`/`originTabId` onto delivered intents (`intentForAudience`).
- All the `notifications:*` journal labels preserved (they are how push issues get debugged).

## Logs (`logs.rs`)

Replaces `cli/logger.cjs` and adds the extension log feature.

**Runtime journal**: same JSONL event shape (`ts, level, source, runId, scope?, label?, message?, detail?`) with the same detail normalization caps (8000-char strings, 50-element arrays, depth 5). Written to `.remux/logs/runtime-<runId>.jsonl` through a dedicated writer task (async, batched — no more two synchronous file opens per event). Terminal mirroring honors the `terminal: 'silent'` flag as today. **Dropped**: the `current.jsonl` truncate-and-duplicate scheme; `runId` in each event plus the newest run file serve the same purpose. **Retention**: on boot, delete run files older than `log_retention_days` (this also cleans up the existing 54 MB backlog on first run — the old `*.jsonl` naming matches the same glob).

**Per-extension logs**: `.remux/logs/extensions/<id>.log` — stderr lines plus lifecycle markers, timestamped, size-rotated (5 MiB, keep 2 rotations). Parallel in-memory ring of the last 500 lines per extension.

**New RPC** (additive):

- `remux/extensions/logs` `{extensionId, lines?=200}` → `{extensionId, lines: [{ts, stream, line}]}` from the ring.
- `remux/extensions/logs/subscribe` / `unsubscribe` `{extensionId}` → per-WS-client subscription; appended lines push `remux/extensions/logs/didAppend {extensionId, lines:[…]}` notifications (batched ~100ms). Subscriptions die with the socket.

## Behavior changes (intentional, complete list)

1. Extension crash → contained restart/backoff/Failed; never runtime-fatal (was: whole runtime exits unrecoverably).
2. Worker crash → supervisor restarts with backoff (was: dead until SSH).
3. `extensions/stop`/`restart` block until the process is reaped (≤ ~4s; was: fire-and-forget lies).
4. Unprompted clean exit (code 0) of an extension → `Stopped` state broadcast (was: silent not-running).
5. Journal: rolling `runtime-<runId>.jsonl` + retention; no `current.jsonl`; extension stderr moves to per-extension files.
6. Config accepts full TOML syntax (unknown keys still rejected); adds `log_retention_days`.
7. Signal shutdown has a 5s hard deadline (was: unbounded).
8. New additive RPC/notifications as specified above.

Everything else — method names, shapes, timeouts (300s extension RPC, 1s host→client, 500ms visibility), ports, paths, redirects, error strings — is parity.

## Testing

Fixture extension: a tiny second binary in the crate (`src/bin/remux-fixture-ext.rs`, compiled automatically for integration tests) speaking line-JSON-RPC with scriptable behaviors selected by args/env: echo RPC, emit notification, ignore SIGTERM, ignore EOF, exit(code) after N ms, crash on demand, spam garbage stdout, block forever. Tests generate a temp extension root with a manifest pointing at it.

Unit-test ports (source file → Rust test module): `config.test.js → config`, `extension-manifest` coverage inside `extension-registry.test.js → extensions::manifest/discovery`, `json-rpc.test.js → rpc::jsonrpc`, `rpc-router.test.js → rpc::router`, `logger.test.js → logs` (normalization caps, run-id format), `http-server.test.js + viewer-provider.test.js → http` (catalog shape, icon fallback, traversal guard, SPA fallback), `fs-core.test.js → fs::core` (incl. porcelain table, `isPathWithin`, binary sniff), `fs-relay.test.js → fs::relay` (debounce/min-interval/trailing, confirm-gate, poller gating, eviction), `notifications.test.js → notifications` (audience lifecycle, correlation, expo mock), `ws-server.test.js`, `extension-process.test.js`, `start.test.js`, `main.test.js → tests/*.rs` integration.

Chaos integration tests (the suite the Node CLI never had — all must pass before cutover):

- write-to-dead-pipe: stop an extension mid-notification-stream; assert no worker death, warning logged. (The incident regression test.)
- SIGTERM-ignoring + EOF-ignoring fixture → SIGKILL within the ~4s budget; `stop` response truthful; restart yields exactly one live child (assert via `/proc`).
- crash-loop fixture → backoff schedule observed → `Failed` after budget; `didChangeStatus` sequence correct; manual `start` recovers.
- `kill -9` the worker → supervisor respawns within backoff; port rebinds; WS clients can reconnect; fixture extension respawned.
- exit-75 path (`remux/system/restart`) round-trips under load.
- garbage/partial stdout lines → skipped with warnings, later valid RPC still correlates.
- graceful-shutdown deadline: extension blocking forever in stop → worker still exits ≤5s on SIGTERM.

Manual phone validation checklist before cutover: connect + tabs render; codex chat turn end-to-end + push notification arrives + tap-focuses correctly; terminal session + tmux context; files tab listing + edit-triggered `didChange` refresh + git badges; Settings → restart runtime; Settings → stop/start/restart each extension; `kill -9` worker mid-session → app reconnects without user action.

## Work order (single pass, commit-sized steps)

1. Workspace + crate scaffold; `config.rs`; `extensions/{manifest,discovery}.rs` + unit tests.
2. `rpc/jsonrpc.rs` + `rpc/router.rs` (system + management methods stubbed against a trait) + tests.
3. `http/*` + tests (catalog/icons/viewers/health).
4. `rpc/ws.rs` + client registry + broadcast + tests.
5. `extensions/{process,supervisor}.rs` + `logs.rs` ring/files — the core; fixture extension; chaos tests.
6. `fs/core.rs` + `fs/git.rs` + tests.
7. `fs/relay.rs` + tests.
8. `notifications.rs` + tests (mock Expo endpoint).
9. `runtime.rs` assembly + shutdown/panic policy; `supervise.rs`; journal retention; end-to-end integration tests.
10. Manual phone validation against the checklist; fix fallout.
11. **Cutover commit**: delete `bin/remux.js`, `cli/`; rename `cli-rs/` → `cli/`; `package.json`: drop `"bin"`, `"dev": "cargo run --manifest-path cli/Cargo.toml -- start"` (plus a `remux` release-build script), `test:cli` → `cargo test --manifest-path cli/Cargo.toml`; remove `ws` dependency; update `docs/architecture/remux-runtime.md`, `docs/guides/{development,testing}.md`, specs README (this spec → Implemented).

## Acceptance

Pass 1 is done when: all unit/integration/chaos tests pass; the manual phone checklist passes against the Rust runtime; the Node CLI is deleted; and the two incident scenarios are demonstrably dead — (a) an extension restart storm cannot take the runtime down, (b) `kill -9` of the worker self-heals without SSH.
