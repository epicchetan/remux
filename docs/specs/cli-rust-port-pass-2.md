# CLI Rust Port — Pass 2 Implementation Spec

Status: Implemented
Last verified: 2026-07-07
Canonical code: `cli/` (Rust runtime crate), `extensions/{codex,terminal}/remux-extension.json`, `app/src/settings/`, `app/src/notifications/`

Parent: [cli-rust-port.md](cli-rust-port.md) (audit + roadmap). Predecessor: [cli-rust-port-pass-1.md](cli-rust-port-pass-1.md) (Implemented — L1 supervisor, L2 crash containment, EOF-first stop, per-extension logs, journal, chaos suite, Node CLI deleted).

Pass 1 made the runtime survive crashes. Pass 2 makes it survive **reboots and hangs**, makes process cleanup **airtight** (no orphans, ever), removes `cargo run` from production, and surfaces the whole machine — extension states, live logs, CPU/memory — in the app's Settings so the phone is a real operations console.

## Scope

**In pass 2**

- **L0**: systemd user service — starts on boot, survives supervisor death, retires the tmux pane.
- **Worker hang watchdog**: a wedged event loop becomes a crash (which L1 already heals) instead of a phone-unreachable zombie.
- **Full L3 process hygiene**: process groups + PDEATHSIG + boot-time orphan sweep via a run-state file; group-wide kill escalation.
- **Manifest `build` phase**: extensions ship `build` + prebuilt `command`; the runtime never runs `cargo run` again. New `building` state.
- **Resource monitoring**: `/proc`-based sampler; system + per-extension CPU/RSS/process-count over new `remux/system/resources*` RPCs; optional memory-ceiling alert.
- **System push notifications**: extension entered `failed` / memory ceiling exceeded → Expo push; tap opens Settings.
- **App Settings UI**: live state badges via `didChangeStatus`, per-extension detail sheet with live log tail and rebuild, System resources section.

**Out (pass 3+)**

- Auth token on `/ws` + HTTP (recommended next; touches app settings store — keep it a focused pass).
- CLI subcommands (`remux status|logs|doctor`).
- Auto-kill / auto-restart on resource ceilings (this pass only notifies).
- Resource history, graphs, or persistence of samples.
- Extension sandboxing of any kind.

**Constraints carried over from pass 1** (unchanged): protocol compatibility is absolute for all existing methods; all changes to the WS surface are additive; app remains OTA-only (no new native dependencies — everything below is plain RN); `clients.json` and `config.toml` formats survive (config keys are additive).

---

## L0 — systemd user service

The four-layer model from the roadmap, with pass-2 items marked:

```
L0  systemd user service   ← this pass   — reboots, supervisor death
L1  remux supervisor        (pass 1)     — worker crash restart, backoff
L2  extension containment   (pass 1)     — crash budget, failed state
L3  process hygiene        ← this pass   — pgroups, PDEATHSIG, orphan sweep
```

Checked-in unit at `deploy/systemd/remux.service`:

```ini
[Unit]
Description=Remux runtime

[Service]
ExecStart=%h/remux/target/release/remux start
WorkingDirectory=%h/remux
Restart=always
RestartSec=1
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

Install runbook (goes in `docs/guides/development.md`; one-time, performed by the user **from tmux/SSH, not from a remux terminal session**):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/remux.service ~/.config/systemd/user/
systemctl --user daemon-reload
loginctl enable-linger "$USER"        # run without an SSH session; start on boot
# stop the tmux-hosted runtime, then:
systemctl --user enable --now remux
```

Decisions and notes:

- `StartLimitIntervalSec` is left at its default rather than the roadmap's `0`: L1 already never gives up, so systemd's rate limit only triggers if the *supervisor* is crash-looping (e.g. missing binary), where stopping with a journal error is the right behavior. `systemctl --user reset-failed remux` recovers.
- **No `Type=notify` / `WatchdogSec`.** The unit's main process is the supervisor, which is trivially alive; a systemd watchdog would not detect a wedged worker, and it would do nothing for ad-hoc `remux start` runs during development. Hang protection lives in the worker instead (next section), where it works everywhere.
- `TimeoutStopSec=15` brackets the worker's 5s shutdown deadline + the supervisor's 7s signal-forward grace.
- Default `KillMode=control-group` sweeps the whole cgroup on stop. That kills PTY shells and tmux *clients* spawned by the terminal extension — the same semantics as today's stdin-EOF `kill_all()`. The user's tmux **server** (started from an SSH session, outside the remux cgroup) and its sessions survive; tmux-backed terminal sessions remain the durability story.
- Supervisor/worker stderr goes to journald (`journalctl --user -u remux`); the structured runtime journal stays in `.remux/logs/`.
- The hot-swap flow is unchanged under systemd: rebuild, then app **Restart runtime** → worker exits 75 → the (persistent) supervisor respawns from the on-disk binary. `systemctl --user restart remux` additionally swaps the supervisor itself.

## Worker hang watchdog

**Problem.** L1 restarts a worker that *exits*. A worker whose tokio runtime is wedged (deadlock, blocking call on the runtime, runaway sync loop) stays alive with a dead WS — the phone cannot reach it and cannot restart it. This is the one remaining "SSH required" failure mode.

**Design** (`cli/src/watchdog.rs`): convert hangs into crashes.

- An `AtomicU64` heartbeat stores milliseconds since a process-local monotonic epoch (`Instant`-based; wall-clock and suspend safe).
- A tokio interval task stamps the heartbeat every 1s. It must be spawned on the main runtime (that is the thing being monitored).
- A dedicated OS thread (spawned before the runtime starts serving, plain `std::thread`) checks every 5s. If the heartbeat is older than `watchdog_stale_seconds` (config, default 30, `0` disables):
  1. best-effort journal `fatal:watchdog-stale` with the stale age (the journal writer is its own thread, so this usually succeeds even when tokio is wedged; give it 200ms),
  2. `eprintln!` one line for journald,
  3. `std::process::abort()`.
- `abort()` rather than `exit(75)`: no atexit/unwind code runs (nothing to deadlock on), and the SIGABRT death takes L1's *backoff* path — a deterministic wedge-on-boot must not hot-loop at exit-75 speed.
- The thread is a no-op during `shutdown_sequence` (a `shutting_down` check) so slow graceful shutdowns aren't misread as hangs; the existing 5s shutdown hard deadline already bounds that path.

Testable as a unit: the checker logic takes the heartbeat atomic + a fake clock + an injected `on_stale` closure.

## L3 — full process hygiene

Pass 1 ships EOF → SIGTERM → SIGKILL against the **direct child** with confirmed reap. Two gaps remain: signals don't reach grandchildren (today's `cargo run` tree; any server that spawns helpers), and nothing reaps survivors of an abrupt worker death. Pass 2 closes both.

### Process groups

`cli/src/extensions/process.rs`, at spawn:

- `.process_group(0)` (std `CommandExt`, stable since 1.64) — the child leads a new group, pgid = child pid.
- `pre_exec` hook calling `prctl(PR_SET_PDEATHSIG, SIGKILL)` (nix `process` feature) — if the worker dies abruptly, the *direct* child dies with it. Grandchildren that re-parent are covered by the boot sweep below.

### Stop sequence upgrade

`cli/src/extensions/supervisor.rs` `stop_child`, per state today → pass 2:

| Step | Pass 1 | Pass 2 |
| --- | --- | --- |
| 1 | close stdin (EOF) | unchanged |
| 2 | wait 2s | unchanged |
| 3 | SIGTERM to pid | **SIGTERM to pgid** (`killpg`) |
| 4 | wait 2s | unchanged |
| 5 | SIGKILL to pid | **SIGKILL to pgid** |
| 6 | `waitpid` direct child (confirmed reap) | unchanged, **then** poll `killpg(pgid, 0)` up to 2s until the group is empty; journal a warning if anything lingers |

The EOF-first step stays: it is the polite path both Rust servers already honor, and it keeps the pass-1 chaos tests meaningful. Group signals make the escalation reach cargo children, PTY shells, and anything else the server spawned. Stop/restart RPCs still block until the direct child is reaped.

### Run-state file + boot orphan sweep

PDEATHSIG cannot cover grandchildren that re-parented (e.g. the real server under a dead `cargo`), and nothing covers a `kill -9`'d worker's whole extension tree if the server ignores EOF. Persistent record + sweep:

- `.remux/run/extensions.json` (v1): `{ "version": 1, "extensions": { "<id>": { "pid": n, "pgid": n, "startTicks": n, "startedAtMs": n } } }`. Written atomically (temp file + rename) after each spawn; the entry is removed after each confirmed reap. `startTicks` is field 22 of `/proc/<pid>/stat` (process start time in clock ticks) — the pid-reuse guard.
- On worker boot, **before** spawning any extension: read the file; for each record where `/proc/<pid>` exists *and* its current `startTicks` matches the record, `killpg(pgid, SIGKILL)` and journal `sweep:killed` with the extension id. Mismatched or missing pids are skipped as stale. Hard guards: never signal pgid ≤ 1 or our own pid/pgid. Then reset the file.
- Sweeping a previous terminal server's group kills its PTY shells — identical to today's EOF `kill_all()` semantics; tmux-backed sessions are the mitigation, as everywhere else.

This closes the last double-instance window: a respawned worker can no longer coexist with a hung predecessor's extension servers (port binding already serializes the workers themselves).

## Manifest `build` phase — no more `cargo run` in production

`cargo run` at runtime is roadmap defect D4's root: the real server becomes a grandchild, restarts pay a cargo startup tax, and target-dir locks can stall spawns. It also means a debug-profile server in production today.

### Manifest schema (additive)

```json
"server": {
  "transport": "stdio",
  "build": {
    "command": "cargo",
    "args": ["build", "--release", "--manifest-path", "server/Cargo.toml",
             "--target-dir", "/tmp/remux-codex-server-target", "--offline", "--quiet"],
    "cwd": "."
  },
  "command": "/tmp/remux-codex-server-target/release/remux-codex-server",
  "args": []
}
```

- `build` is optional; validation mirrors the existing `server` command/args/cwd rules (same error-string style). Manifest validation must **not** stat `command` — with a `build` phase the binary legitimately doesn't exist yet.
- When `build` is present, `command` points at the build artifact. Both codex and terminal manifests switch to this shape (terminal without `--offline`). The `/tmp` target dirs are kept deliberately: they already exist to avoid workspace target-lock contention, and `/tmp` being cleared on reboot now composes with L0 — boot → binary missing → auto-build → serve, no SSH.

### State machine addition

```
stopped → building → starting → running        (build needed)
stopped → starting → running                   (binary present)
building --build fails--> failed(lastExit: build-failed)
```

- Build is needed when: the resolved `command` path does not exist, or the start/restart RPC passed `{"rebuild": true}`, or the worker was started with `remux start --rebuild` (first spawn of each extension only).
- The build job runs under the same pgroup/log plumbing as the server: stdout+stderr lines go into the extension's ring + rotated file prefixed `[build]`, visible over `remux/extensions/logs` — build errors are readable from the phone.
- Build timeout: 10 minutes → treated as failure. A failed build lands the extension in `failed` with `lastExit` reason `build-failed` and does **not** consume crash budget (builds are deterministic; retry is manual). `didChangeStatus` broadcasts `state: "building"` like any other transition.
- Dev iteration: edit server source → Settings "Rebuild & Restart" (or `remux/extensions/restart` with `rebuild: true`). A plain restart reuses the last-built binary and is fast.

### RPC changes (additive)

- `remux/extensions/start` and `remux/extensions/restart` accept an optional `"rebuild": true` param. Response shapes unchanged (the RPC blocks through `building` like it blocks through everything else; app timeout for these calls raises to 10 min when rebuild is set).
- `remux start --rebuild` accepted by `main.rs` arg parsing (still no clap; the grammar is `remux start [--rebuild]`).

## Resource monitoring

`cli/src/monitor.rs`. **No new dependencies**: `/proc` reads + `nix::sys::statvfs` (nix `fs` feature). The host is Linux-only by charter.

### Sampler

A tokio task samples every `resource_poll_seconds` (config, default 5). Always on — it also feeds the memory guardrail — and cheap: a handful of `/proc` file reads.

- **Per extension** (for each supervisor in `running`/`stopping` with a live pgid): scan `/proc/*/stat` for entries whose pgrp (field 5) matches the pgid; sum `utime+stime` (fields 14/15) and diff against the previous sample for CPU; sum resident pages from `/proc/<pid>/statm` × page size for RSS; count members. `cpuPercent` is normalized to one core (100 = one full core, like `top`).
- **System**: `/proc/loadavg` (1/5/15), `/proc/meminfo` (`MemTotal`, `MemAvailable`), `statvfs` on the workspace cwd (disk total/free).
- **Runtime self**: same per-process math on our own pid.
- Parsers are pure functions over the file contents (unit-testable without `/proc`).

### RPCs (additive)

- `remux/system/resources` → the latest sample:

```json
{
  "sampledAtMs": 0,
  "system": { "load1": 0.0, "load5": 0.0, "load15": 0.0,
              "memTotalBytes": 0, "memAvailableBytes": 0,
              "diskTotalBytes": 0, "diskFreeBytes": 0 },
  "runtime": { "pid": 0, "cpuPercent": 0.0, "rssBytes": 0, "uptimeMs": 0 },
  "extensions": [ { "extensionId": "codex", "state": "running", "pid": 0,
                    "processCount": 0, "cpuPercent": 0.0, "rssBytes": 0,
                    "uptimeMs": 0, "restartCount": 0 } ]
}
```

- `remux/system/resources/subscribe` / `unsubscribe` — client-scoped (same `ClientScopedRpc` mechanism as extension logs), respond `{ok: true}`. While ≥1 subscriber exists, each tick is pushed as a `remux/system/resources/didSample` notification with the same shape. The app subscribes only while Settings is visible — the visibility-gating philosophy from the terminal tmux polling fix.

### Memory guardrail

Optional config `extension_memory_ceiling_mb` (absent/0 = disabled). When an extension group's RSS exceeds it: journal warning + system push notification (below), throttled to once per extension per hour. **No auto-kill in this pass.**

## System push notifications

New path in `cli/src/notifications.rs`: `notify_system(title, body, data)` — Expo push to **all** registered clients with tokens, with no is-viewing suppression (these are operational alerts; there is no tab target to be "viewing"). Reuses the existing Expo payload builder, ticket handling, and DeviceNotRegistered token clearing.

Payload `data`: `{ "kind": "system", "reason": "extension-failed" | "memory-ceiling", "extensionId": "<id>" }`.

Triggers:

- **L2 enters `failed`** (crash budget exhausted or `build-failed`): title `"<name> server failed"`, body = last stderr line + restart count. Fires once per `failed` entry — re-entry requires a manual start anyway, so no extra throttle state.
- **Memory ceiling** (above).

App side (`app/src/notifications/RemuxNotificationProvider.tsx` + `browserStore`): a tapped notification whose `data.kind === "system"` opens the **Settings** surface instead of resolving a tab target. Foreground behavior: show it (it is never "the visible target", so existing suppression logic already lets it through).

## App Settings UI

All plain React Native — no new native modules (OTA-only constraint).

### Live status (`extensionServerApi.ts`, `SettingsOverview.tsx`)

- `ExtensionServerStatus` grows the pass-1 additive fields: `state`, `pid`, `startedAtMs`, `restartCount`, `lastExit` (all already emitted by the runtime).
- Subscribe via the existing `connection.subscribe` to `remux/extensions/didChangeStatus` and merge into `extensionStatuses` — states update live (crash → `backingOff` → `running` visibly, no manual refresh). Initial load stays `remux/extensions/status`.
- `ExtensionRow`: status dot + label per state — green `running`, gray `stopped`, amber `starting`/`stopping`/`building`/`backingOff`, red `failed`. Meta line: `Running · 2h 14m · 3 restarts`; for `failed`, show `lastExit` (e.g. `build-failed`, `signal SIGKILL`). Uptime derives from `startedAtMs` (tick while visible).
- Existing Switch/Restart controls unchanged in behavior.

### Extension detail sheet (new)

Tapping a row opens a modal sheet:

- Status block: state, pid, uptime, restart count, last exit.
- Actions: Start/Stop/Restart (as today) + **Rebuild & Restart** (passes `rebuild: true`; only shown when the manifest has a `build` phase — surfaced by a new additive `hasBuild: bool` on status responses).
- **Live log tail**: `remux/extensions/logs {extensionId}` snapshot, then `logs/subscribe`; append `logs/didAppend` batches; `unsubscribe` on close/blur. Monospace, capped at the ring size (500 lines), autoscroll-to-bottom with stick-to-bottom-unless-scrolled behavior.
- Per-extension resource line (CPU/RSS/processes) from the resources feed while the sheet is open.

### System section (new, on the Settings overview)

Load average, memory used/total, disk free, runtime CPU/RSS/uptime. Subscribes to `remux/system/resources` while the Settings surface is visible; unsubscribes when it isn't (surface visibility, not just mount — hidden tabs stay mounted in this app).

## Config additions

Additive keys in `.remux/config.toml` (`RemuxConfig` stays `deny_unknown_fields`; all optional with defaults):

```toml
resource_poll_seconds = 5          # sampler cadence
watchdog_stale_seconds = 30        # 0 disables the hang watchdog
extension_memory_ceiling_mb = 0    # 0 disables the memory alert
```

The crash budget (5 in 60s) stays hardcoded — no observed need to tune it.

## Protocol compatibility

Unchanged and untouched: every pass-1 method, response shape, error code, notification, HTTP route, and file format. Additions only:

- New `state` value `"building"` in status payloads and `didChangeStatus`.
- New `hasBuild` field on extension status objects.
- Optional `rebuild` param on `extensions/start|restart`.
- New methods: `remux/system/resources`, `resources/subscribe`, `resources/unsubscribe`; new notification `remux/system/resources/didSample`.
- New push payload `data.kind: "system"`.

An un-updated app build keeps working against a pass-2 runtime; an updated app degrades gracefully against a pass-1 runtime (unknown-method errors on `resources*` hide the System section).

## Testing

### Chaos additions (`cli/tests/chaos.rs`, fixture extension grows knobs)

- **Grandchild reap**: fixture spawns a `sleep 300` child (new env `FIXTURE_SPAWN_CHILD=1`), then crashes → after restart, old grandchild is gone (`/proc` scan by pgid).
- **Kill-resistant tree**: fixture ignores EOF+SIGTERM *and* has a grandchild → stop RPC returns ≤3s, both processes dead (group SIGKILL).
- **Boot sweep**: hand-write a run-state file pointing at a live decoy process group → boot kills it (journal `sweep:killed`); a record with a mismatched `startTicks` (pid-reuse simulation) is skipped and journaled as stale.
- **Restart storm hygiene**: 20 scripted stop/start/restart cycles with a grandchild-spawning fixture → zero processes left matching any recorded pgid.

### Build phase

- Fixture manifest with a script build step (`sh -c 'cp server-src.sh server-bin && chmod +x server-bin'`): missing binary → `building` → `running`, build lines visible in `extensions/logs` with the `[build]` prefix.
- Failing build → `failed`, `lastExit: build-failed`, crash budget untouched, manual start retries the build.
- `rebuild: true` forces a rebuild when the binary exists (artifact mtime changes).

### Monitor + watchdog + notifications

- Unit tests for the `/proc` parsers (`stat` pgrp/utime/stime/starttime, `statm`, `meminfo`, `loadavg`) on captured fixtures; CPU delta math.
- Integration: `remux/system/resources` shape with the fixture running (`processCount ≥ 1`, `rssBytes > 0`); `didSample` cadence with a fast poll config; unsubscribe stops pushes.
- Watchdog: unit test with injected clock/heartbeat/on-stale closure (no e2e — you can't safely wedge a shared test runtime).
- `notify_system`: exact Expo payload, all-registered-clients fan-out, DeviceNotRegistered clearing, memory-ceiling hourly throttle, failed-state trigger fires once per entry.

### e2e (`cli/tests/e2e.rs`)

- Boot with the build-phase fixture and a missing binary → healthy, extension `running` (exercises `building` on the real assembly path).
- The pass-1 quartet keeps passing unmodified — that is the L3-changes-nothing-observable regression gate.

### Manual phone checklist (validation gate before marking Implemented)

1. Settings shows live state badges; `kill -9` an extension server → badge flickers `backingOff` → `running` with no manual refresh.
2. Crash-loop fixture → red `failed` badge, push notification arrives, tap opens Settings, manual start recovers it.
3. Detail sheet live-tails codex logs during a real turn; Rebuild & Restart round-trips.
4. System section shows sane load/memory/disk; numbers move under load.
5. Migrate the host to systemd (runbook above), then: reboot the machine → runtime reachable from the phone with no SSH; `/tmp`-cleared server binaries rebuilt automatically on first start.
6. Under systemd: app **Restart runtime** works; `systemctl --user restart remux` works; `kill -9` the worker self-heals.

## Work order

1. **L3 pgroups**: `process_group(0)` + PDEATHSIG at spawn; killpg stop-sequence upgrade; grandchild chaos tests.
2. **Run-state file + boot sweep** (+ pid-reuse guard) + sweep chaos tests.
3. **Build phase**: manifest schema + validation, `building` state, `rebuild` params, `--rebuild` flag, fixture build tests; flip the codex + terminal manifests to prebuilt `--release` binaries.
4. **Watchdog** thread + unit tests.
5. **monitor.rs**: parsers, sampler, `resources*` RPCs, memory guardrail; tests.
6. **notify_system**: failed-state + ceiling pushes; tests.
7. **App — live status**: additive status fields, `didChangeStatus` merge, state badges.
8. **App — detail sheet**: log tail (subscribe/unsubscribe lifecycle), Rebuild & Restart.
9. **App — System section** + system-notification tap → Settings.
10. **L0**: `deploy/systemd/remux.service`, runbook in the development guide; user migrates the host from tmux to systemd.
11. **Manual phone validation** (checklist above; includes the reboot test).
12. **Docs sync**: architecture doc (L0/L3/watchdog/build/resources), development + testing guides, specs README; mark this spec Implemented.

Steps 1–6 are runtime-only and land behind the unchanged protocol (safe to deploy at any point); 7–9 are app-side and OTA-shippable independently; 10–11 are host operations.

## Acceptance

- After a scripted restart storm with grandchild-spawning extensions, a `/proc` sweep finds **zero** stray processes. (D4/D6 fully dead.)
- Machine reboot → phone reconnects without SSH; extension binaries rebuild themselves from a cleared `/tmp`. (The tmux pane is retired.)
- A wedged worker event loop recovers automatically within `watchdog_stale_seconds` + backoff.
- A crash-looping extension is visible as `failed` on the phone, announced by a push, and recoverable from Settings — no SSH.
- Live extension logs and CPU/RSS are readable from the phone.
- Every pass-1 test still passes; a pass-1-era app build works unmodified against the pass-2 runtime.
