# CLI Rust Port: Process Supervision, Extension Ops, Resource Monitoring

Status: Active Spec
Last verified: 2026-07-06
Canonical code: `bin/remux.js`, `cli/*.cjs`, `cli/core/*.cjs`, `extensions/*/remux-extension.json`, `extensions/{codex,terminal}/server/`

## Goal

Replace the Node CLI (`bin/remux.js` + `cli/`) with a Rust runtime whose contract is: **the runtime never dies for good, and never leaves rogue processes behind.** Remux is accessed from a phone; when the runtime dies, the only recovery today is SSH → tmux → manual restart. That failure mode must become impossible.

On top of that reliability core, the port adds the features the current CLI can't cleanly support:

- A real extension lifecycle (state machine, crash isolation, backoff restarts) surfaced in the app's Settings.
- Per-extension logs, rotated on disk and tailable/streamable from the app.
- Machine + per-extension resource monitoring (CPU, memory, disk, process counts).

There is one user and no compatibility constraint; the Node CLI is deleted at cutover. The WS JSON-RPC protocol is kept identical so the app and existing extensions need zero changes on day one.

## Audit: how the current CLI dies

### D1. Unhandled EPIPE on extension stdin kills the whole runtime

This is the exact crash in the incident log (`write EPIPE … Emitted 'error' event on Socket instance`).

- `cli/extensionProcess.cjs:38` spawns the extension with `stdio: ['pipe','pipe','pipe']` and never attaches an `'error'` listener to `child.stdin`.
- `stop()` (`cli/extensionProcess.cjs:174`) sends SIGTERM and immediately nulls `child` — it never `end()`s or `destroy()`s stdin, never waits for exit.
- Any write already queued on that stdin socket (a notification mid-restart, a request racing the stop) completes asynchronously with EPIPE. The write *callback* would receive it, but Node **also** emits `'error'` on the Socket — with no listener, that's an uncaught exception → the worker dies.
- The incident sequence `extension:restart → extension:stop → extension:start → EPIPE` is precisely this race: old child SIGTERMed, queued write flushes into the dead pipe.

### D2. The supervisor only restarts *intentional* restarts

`bin/remux.js:41-60`: the worker is respawned **only** when it exits with code 75 (`remuxRestartExitCode`). Any crash — D1's EPIPE, an uncaught exception, OOM, a fatal escalation — exits with some other code, and the supervisor just… exits too. The one component whose job is "keep remux alive" handles only the case where remux asked to be restarted, not the case where it died. There is also no backoff, no restart counter, no watchdog.

### D3. An extension crash escalates to full-runtime death — permanently

`cli/extensionProcess.cjs:78-83`: when an extension exits non-zero (or fails to spawn, `:43-57`), it calls `ctx.fatal(reason, code)`. That routes to `onFatal` in `cli/start.cjs:87-90`, which shuts down **the entire runtime** and exits with the *extension's* exit code — which is never 75, so per D2 the supervisor does not restart. Net effect: **any extension server crashing once takes down phone access until manual SSH recovery.** For a runtime hosting four extensions, this is the dominant availability risk even after D1 is fixed.

### D4. No process groups; `cargo run` makes the real server a grandchild

Manifests launch servers via `cargo run` (`extensions/codex/remux-extension.json`, `extensions/terminal/remux-extension.json`), so the process tree is `node → cargo → server-binary`. `child.kill('SIGTERM')` hits **cargo**; cargo does not forward the signal, so the actual server survives, orphaned. Nothing in the CLI uses `detached`/process groups/`kill(-pgid)` (grep confirms zero occurrences), there is no SIGKILL escalation, and `stop()` never confirms death. Consequences observed in practice:

- Rogue server binaries lingering after stop/restart.
- `restart()` (`cli/extensionProcess.cjs:189`) spawns the new instance while the old one still runs → two live servers fighting (cargo target-dir lock contention, doubled tmux polling, duplicate session state).
- The only implicit cleanup is stdin EOF: both Rust servers exit when stdin closes (`extensions/codex/server/src/main.rs:77`, terminal `main.rs:78` runs `kill_all()` after the stdin loop). But the CLI-side write end only closes when the *worker process itself* dies, and a server blocked mid-operation (the terminal server's serial stdin loop is documented as blocking in `docs/specs/terminal/phase-4-input-latency-and-resync.md`) won't notice for a long time.
- `status()` lies: `running: Boolean(child && !child.killed)` reports "signal was sent", not "process is dead".

### D5. No global error handlers, no force-exit on signal shutdown

- No `process.on('uncaughtException')` / `'unhandledRejection')` anywhere — any stray throw in a callback kills the worker (and per D2, permanently).
- The RPC-restart path has a 2s force-exit timer (`cli/start.cjs:53-66`), but the SIGINT/SIGTERM path (`cli/start.cjs:109-114`) awaits shutdown with no timeout, and the outer supervisor forwards the signal and waits forever. A hung `server.close()` or extension stop means a shutdown that never finishes.

### D6. Worker death orphans every extension subtree and kills terminal sessions

When the worker dies abruptly, extension processes are not killed (no PDEATHSIG, no pgroup); they exit only if/when they notice stdin EOF. Meanwhile the terminal server's EOF handler `kill_all()`s the PTY sessions — so **every runtime crash also destroys the user's shells** (tmux-backed sessions from the phase-3 terminal spec are the mitigation). Both directions are wrong today: crash → orphans if the server is blocked, or total session loss if it isn't.

### D7. Logging is unbounded and synchronous

`cli/logger.cjs:78-86` writes every event **twice** (`current.jsonl` + per-run file) with `appendFileSync` — two open/write/close cycles per event on the hot path, blocking the event loop. Nothing rotates or prunes: `.remux/logs` is already 54 MB across 29 run files. Extension stderr is folded into the main log as `extension:stderr` events rather than kept per-extension.

### D8. Smaller gaps worth fixing in the port

- Extension RPC timeout is 300s (`cli/extensionProcess.cjs:6`); there is no liveness ping to extensions, so a hung-but-alive server is indistinguishable from a slow one for 5 minutes.
- Hand-rolled TOML subset parser (`cli/config.cjs`) — replace with a real `toml` crate.
- Unauthenticated `0.0.0.0` bind with full fs RPC (acknowledged in `docs/architecture/remux-runtime.md`); fine on a trusted network, but the port should support an optional shared token.
- The runtime lives in a user tmux pane, so it does not survive reboots and its lifecycle is invisible to the OS.

### What's worth keeping

The bones are good and should port structurally as-is: the generation-guarded child event handling, newline-delimited JSON-RPC stdio framing, the `remux/<ext>/*` method routing scheme, the exit-75 restart contract, notification correlation (`cli/notifications.cjs`), health endpoints, and the 14-file test suite in `cli/tests/` — that suite is the behavioral spec for the port.

## Design

### Reliability model: four layers, each assuming the one below it fails

```
L0  systemd user service        — survives reboots, worker+supervisor death, hangs (watchdog)
L1  remux supervisor process    — tiny Rust process: spawn worker, restart on ANY abnormal exit, backoff
L2  runtime worker              — extension crashes are contained; never fatal to the runtime
L3  process hygiene             — pgroups + PDEATHSIG + kill escalation + pidfile reaping: no orphans, ever
```

**L0 — systemd user unit** (replaces tmux as the host; works for the Node CLI today too):

```ini
# ~/.config/systemd/user/remux.service
[Unit]
Description=Remux runtime

[Service]
ExecStart=%h/remux/target/release/remux start
WorkingDirectory=%h/remux
Restart=always
RestartSec=1
StartLimitIntervalSec=0        # never give up
WatchdogSec=30                 # worker sd_notify pings; hang => restart
KillMode=control-group          # sweep the whole tree on stop

[Install]
WantedBy=default.target
```

Plus `loginctl enable-linger ubuntu` so it runs without an SSH session and starts on boot. This alone converts "SSH in and restart tmux" into "wait ~2 seconds". The remote-restart story becomes: the phone never *needs* to restart a dead runtime, because nothing stays dead.

**L1 — supervisor mode.** Keep today's two-process shape (`REMUX_WORKER` split in `bin/remux.js`) but fix the policy: restart on **any** abnormal exit (non-zero code or signal), immediate on exit-75, exponential backoff (250ms → 5s cap) on crashes, clean exit 0 = stop. The supervisor does nothing else — no I/O, no parsing — so it is effectively crash-proof; systemd covers the remainder. This keeps `remux start` fully self-healing when run ad hoc in a terminal during development, without systemd.

**L2 — extension crash containment.** Delete the `ctx.fatal` escalation (D3). An extension exiting abnormally transitions *that extension* through a supervised state machine:

```
stopped → starting → running
running --crash--> backing_off(attempt n, delay) → starting
backing_off --crash budget exceeded (5 crashes / 60s)--> failed(reason)
failed --manual start / remux restart--> starting
```

Every transition is broadcast as `remux/extensions/didChangeStatus` and logged. Entering `failed` sends a push notification ("codex server is crash-looping — last stderr: …"). The runtime itself is never at risk.

**L3 — process hygiene.** Each extension child is spawned with:

- its own **process group** (`process_group(0)`), so stop = `killpg(SIGTERM)` → bounded wait (5s) → `killpg(SIGKILL)` → `waitpid` confirmation. Kills cargo *and* the binary *and* anything they spawned.
- `PR_SET_PDEATHSIG(SIGKILL)` via `pre_exec` (Linux), so if the worker dies abruptly the direct child dies with it.
- a run-state record `.remux/run/extensions.json` ({extension id → pgid, pid, started_at}); on worker boot, any pgids from a previous run that are still alive are killed before spawning replacements. This closes the crash-orphan window that PDEATHSIG alone can't (grandchildren that re-parented).
- `stop()`/`restart()` only report success after `waitpid` confirms exit — `status()` stops lying, and restart can no longer race two live instances.

### Runtime shape

Single crate, two modes in one binary (`remux start` auto-forks the worker, like today). Tokio + axum (HTTP + WS upgrade on one port, same as now). Rough module map:

| Today | Rust | Notes |
| --- | --- | --- |
| `bin/remux.js` | `src/main.rs`, `src/supervise.rs` | clap; subcommands `start`, `status`, `logs`, `doctor` |
| `cli/start.cjs` | `src/runtime.rs` | assembly + graceful shutdown w/ hard 5s deadline |
| `cli/config.cjs` | `src/config.rs` | real `toml`; new keys below |
| `cli/extensionManifest.cjs`, `extensionRegistry.cjs` | `src/extensions/manifest.rs`, `discovery.rs` | serde |
| `cli/extensionProcess.cjs` | `src/extensions/{process,supervisor}.rs` | the heart: L2 + L3 |
| `cli/jsonRpc.cjs`, `rpcRouter.cjs` | `src/rpc/{jsonrpc,router}.rs` | method names unchanged |
| `cli/wsServer.cjs` | `src/rpc/ws.rs` | axum ws |
| `cli/httpServer.cjs`, `viewerProvider.cjs` | `src/http/{catalog,icons,viewers}.rs` | |
| `cli/core/{coreRouter,fs}.cjs` | `src/fs/core.rs` | |
| `cli/fsRelay.cjs` | `src/fs/relay.rs` | `notify` crate + debouncer; trickiest port, mirror the 3-layer detection contract from `docs/specs/files-tab.md` |
| `cli/notifications.cjs` | `src/notifications.rs` | `reqwest` → Expo push API |
| `cli/logger.cjs` | `src/logs.rs` | `tracing` + rolling files + per-extension ring buffers |
| — (new) | `src/monitor.rs` | `sysinfo` resource sampling |

Dependencies stay modest: `tokio`, `axum`, `serde`/`serde_json`, `toml`, `clap`, `tracing(-subscriber,-appender)`, `notify`, `nix` (pgids, signals, prctl), `sysinfo`, `reqwest`, `sd-notify`.

Add a root Cargo workspace with members `cli-rs` (package `remux`), `extensions/codex/server`, `extensions/terminal/server` — shared lockfile and target dir, one `cargo build --workspace`.

### Extension launch: stop running `cargo run` in production

`cargo run` at runtime is the root of D4, adds seconds of latency to every restart, and can block on target-dir locks. Replace `server.command: cargo run …` with a two-phase manifest:

```json
"server": {
  "transport": "stdio",
  "build": { "command": "cargo", "args": ["build", "--release", "--manifest-path", "server/Cargo.toml"] },
  "command": "server/target/release/remux-codex-server"
}
```

The runtime runs `build` as a supervised job (its output goes into the extension's log stream, a `building` state appears in the status machine) when the binary is missing or `remux start --rebuild` is passed; dev iteration keeps working via `remux/extensions/restart` triggering a rebuild if sources changed (or explicitly from Settings). The spawned process is now the real server — signals land where they should even before pgroup handling.

### Extension logs (Settings feature)

- Each extension gets `.remux/logs/extensions/<id>/` with `stderr.log` (rotated by size, e.g. 5 MB × 3) plus lifecycle events; the runtime's own structured journal goes to `.remux/logs/runtime.jsonl` (rotated daily, retention ~14 days). The double-write `current.jsonl` scheme is dropped; `remux logs` and the app read the same files.
- In memory: a ring buffer (last ~500 lines) per extension for instant reads.
- New RPC: `remux/extensions/logs` `{extensionId, lines?}` → snapshot; `remux/extensions/logs/subscribe|unsubscribe` → `remux/notifications/extensionLog` stream while the Settings log view is open.
- Settings UI: per-extension card gains state badge (running/backing_off/failed + uptime + restart count), Start/Stop/Restart (already exist), and a live log sheet.

### Resource monitoring (Settings feature)

`src/monitor.rs` samples every N seconds (config, default 5) using `sysinfo` + `/proc` walk of each extension's process group:

- Per extension: CPU %, RSS, process count in group, uptime, restarts, last exit reason.
- System: load average, memory used/total, disk free on the workspace mount, runtime's own CPU/RSS.
- RPC: `remux/system/resources` (poll) and `remux/system/resources/subscribe` → pushed samples only while the Settings screen is visible (same visibility-gating philosophy as the terminal tmux polling fix).
- Cheap guardrail: if an extension's RSS exceeds a config ceiling, log + notify (no auto-kill in v1).

### Config additions

```toml
host = "0.0.0.0"
port = 48123
extension_roots = ["extensions"]
auth_token = ""            # optional; when set, required as ?token= on /ws and Authorization on HTTP
log_retention_days = 14
resource_poll_seconds = 5
extension_crash_budget = { max = 5, window_seconds = 60 }
```

### Protocol compatibility

Unchanged: all `remux/system/*`, `remux/extensions/{status,start,stop,restart}`, `remux/fs/*`, `remux/<ext>/*` routing, `remux/notifications/*`, `/ws` path, health endpoints, catalog + icon routes, static viewer serving, stdio framing. Additions are purely new methods (`logs*`, `resources*`, `didChangeStatus`) plus richer fields on `extensions/status` responses (`state`, `pid`, `uptimeMs`, `restartCount`, `lastExit`). The app works unmodified until Phase 4's Settings UI opts into the new surface.

## Phases

> **Superseded by the pass plan.** Implementation proceeds as a single pass per
> [cli-rust-port-pass-1.md](cli-rust-port-pass-1.md), which covers L1 + L2 + an
> EOF-first stop sequence ("L3-lite"), extension logs, and cutover. Punted to
> pass 2: L0 (systemd), full L3 process hygiene, resource monitoring, the
> manifest `build` phase, and the app Settings UI. Phase 0 below was skipped in
> favor of going straight to the port. The phase breakdown is kept for the
> pass-2 backlog and rationale.

**Phase 0 — stop the bleeding (Node, ~1 hour, do now).** The port will take a while; these four small changes remove the current outage class immediately:

1. `child.stdin.on('error', …)` swallow-and-log, and `child.stdin.destroy()` in `stop()` — fixes the incident crash (D1).
2. `bin/remux.js`: restart the worker on *any* abnormal exit with capped backoff, not just code 75 (D2).
3. `process.on('uncaughtException'|'unhandledRejection')` in the worker: log, exit 75 (D5).
4. In `extensionProcess.cjs`, replace `ctx.fatal(...)` on extension exit with a dumb auto-restart (1s delay, max 5 attempts) (D3).
5. (Ops, not code) Install the systemd user unit + `enable-linger` around the *current* Node CLI and retire the tmux pane.

**Phase 1 — Rust skeleton that the app can point at.** Workspace + crate; config, discovery/manifests, HTTP (health/catalog/icons/viewers), WS JSON-RPC router, `system/{ping,info,restart}`, supervisor mode with correct restart policy. Acceptance: app connects to the Rust port, catalog and viewers render; `remux/system/restart` round-trips; `kill -9` the worker → back within 2s.

**Phase 2 — extension supervision (the point of the port).** Stdio bridge with generation guards; L2 state machine + L3 pgroup/PDEATHSIG/pidfile hygiene; manifest `build` phase + prebuilt-binary launch; status broadcasts. Acceptance: codex + terminal fully working from the phone; `kill -9` an extension → auto-restart, runtime unaffected; an extension that ignores SIGTERM is SIGKILLed within 5s; after 100 scripted restart cycles, `ps` shows zero stray processes; crash-looping extension lands in `failed` with a push notification.

**Phase 3 — fs core + relay + notifications.** Port `remux/fs/*`, the watcher relay (against the files-tab spec contract), and Expo push with request correlation. Acceptance: files tab + `didChange` invalidation work; codex turn-complete pushes arrive; existing app flows all green.

**Phase 4 — observability.** Logs pipeline + RPC, resource monitor + RPC, Settings UI work in `app/` (state badges, log viewer, resource panel). Acceptance: watch a live extension log from the phone; see CPU/RSS per extension; failed state visible and recoverable from Settings.

**Phase 5 — cutover.** Point systemd at the release binary; delete `bin/remux.js` + `cli/`; port `test:cli` scenarios that still apply; update `docs/architecture/remux-runtime.md`, `docs/guides/*`; npm scripts shell out to the binary (`npm run dev` → `cargo run -p remux -- start`).

## Testing

Port the scenarios in `cli/tests/*.test.js` as Rust integration tests (they encode the routing/framing/manifest contracts). Add the chaos suite the Node CLI never had, using a scriptable fixture extension:

- extension ignores SIGTERM → group SIGKILL within deadline, `stop` returns only after confirmed exit
- extension crashes N times → backoff schedule honored → `failed` state + notification
- extension spawns a grandchild, then crashes → grandchild reaped (pgroup) 
- worker SIGKILLed → supervisor restarts; leftover pgids from run-state file reaped on boot; no double instances
- extension writes garbage/partial JSON to stdout → logged, session unaffected
- extension closes stdin/stdout early → pending RPCs rejected, no panic, no EPIPE-class death (write to dead pipe path explicitly exercised)
- slow extension shutdown during `remux/system/restart` → hard deadline still restarts runtime

## Open decisions

1. **systemd user service as L0** — assumed yes (Ubuntu host, want boot persistence). Alternative is keeping tmux + relying on L1 only, which still loses reboots.
2. **Auth token** — recommended on (phone traffic traverses the LAN/tailnet); trivially added to the app's settings store.
3. **Terminal session survival across runtime restarts** — out of scope here; stdio transport ties extension lifetime to the worker. The real fix is tmux-backed sessions (terminal phase 3), which makes runtime restarts non-destructive for shells.
4. **Crate location** — `cli-rs/` with package name `remux` inside a new root workspace; directory can be renamed to `cli/` at Phase 5 cutover.
