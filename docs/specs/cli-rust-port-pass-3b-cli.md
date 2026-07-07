# CLI Rust Port — Pass 3b: CLI on PATH, systemd-first subcommands

Status: Active Spec
Last verified: 2026-07-07
Canonical code: `cli/src/main.rs`, `cli/src/cli/` (new), `cli/src/config.rs`, `cli/src/runtime.rs`, `cli/src/supervise.rs`, `cli/src/http/mod.rs`, `cli/src/monitor.rs`, `deploy/systemd/remux.service`

Parent: [cli-rust-port.md](cli-rust-port.md) (audit + roadmap). Predecessors: passes [1](cli-rust-port-pass-1.md), [2](cli-rust-port-pass-2.md), [3a](cli-rust-port-pass-3-auth.md) (all Implemented).

This is the final pass of the port. Pass 2 punted "auth token and CLI subcommands" to pass 3; 3a delivered auth plus the one-line `remux token`. 3b delivers the rest of the pass-3 menu — `status | logs | doctor` plus the operational glue the roadmap assumed but never specced: `remux` on PATH, working from any directory, delegating to systemd so the runtime is a background service you *manage* rather than a process you *babysit*, and a rebuild story where `cargo build --release && remux restart` just works. It also closes the last pass-3 menu item, the resource guardrail for watch sidecars, and discharges the view-build-watch deploy blocker (node/npm invisible to the systemd unit).

**Operator experience this buys** (the acceptance test, informally): from any cwd on the box —

```
$ cargo build --release --manifest-path ~/remux/Cargo.toml
$ remux restart          # picks up the new binary via systemd
$ remux status           # unit active, runtime healthy, per-extension table
$ remux logs terminal -f # tail an extension's log without cd'ing anywhere
$ remux doctor           # every green light, or a named fix per failure
```

## Scope

**In**

- **CLI:** clap-based arg parsing (the roadmap named clap; the hand-rolled matcher in `main.rs` is at its complexity limit). Subcommands: `start` (systemd-aware), `stop`, `restart`, `status [--json]`, `logs [EXTENSION] [-n N] [-f]`, `doctor`, `install`, `token` (existing, now root-aware).
- **Root discovery:** every subcommand resolves the remux root explicitly (`--root` > `REMUX_ROOT` > walk-up > `~/remux`) instead of assuming cwd. Kills the "ran `remux token` in $HOME, silently generated a second token file there" foot-gun.
- **PATH install:** `remux install` symlinks `~/.local/bin/remux → <root>/target/release/remux`, symlinks `node`/`npm`/`npx` into `~/.local/bin`, installs/updates the systemd user unit (embedded in the binary), reloads, enables linger + the unit.
- **systemd unit:** PATH gains `%h/.local/bin` (node/npm for view build phases — the view-build-watch deploy blocker); `ExecStart` becomes explicit `remux start --foreground`.
- **Runtime:** one new authenticated HTTP endpoint `GET /api/status` (feeds `remux status`); resource sampler learns role-keyed pids so watch sidecars count toward usage and the memory ceiling.

**Out (later / rejected / operator acts)**

- TLS or public exposure — rejected in 3a; tailnet stays.
- `remux update` / self-deploying automation — `cargo build && remux restart` is the whole story; git stays manual.
- Shell completions — clap_complete makes this a ~10-line follow-up; not part of the pass.
- App/Settings changes — none needed; the resources payload change is additive and the app renders it unmodified.
- Ledger onboarding (`views` blocks + `npm install` in `~/ledger/lens`) and the `watch = [...]` autostart key — operator acts sequenced in §Rollout, unblocked by this pass.
- Log retention/rotation changes — pass-1 machinery stays; doctor only *reports* on it.

**Compat note.** All wire-surface changes are additive (`/api/status` is a new route; the resources sample gains a `roles` object per extension but keeps every existing field). The systemd unit changes (`--foreground`, PATH) require the new binary first — §Rollout sequences binary-before-unit. `remux start` with no arguments keeps its exact current behavior when run inside the service or on a box with no unit installed.

---

## Root discovery (`cli/src/cli/root.rs`, new)

Today `run_worker` (`cli/src/runtime.rs:169`) and `token_command` (`cli/src/auth.rs:138`) both take root = cwd. That is correct inside the systemd unit (`WorkingDirectory=%h/remux`) and wrong everywhere else — worse than wrong for `token`, which *generates and persists* a token under whatever cwd it finds itself in.

Resolution order, uniform across every subcommand:

1. `--root <dir>` (global clap arg) — explicit override, and the bootstrap path for a fresh checkout (`remux start --root .` creates `.remux/` there; thereafter discovery finds it).
2. `REMUX_ROOT` env, if non-empty.
3. Walk up from cwd to `/`, first directory containing a `.remux/` directory wins. (Marker is the directory itself, not `config.toml` — config is optional, `.remux/` exists after any first run.)
4. `$HOME/remux`, iff `$HOME/remux/.remux/` exists.
5. Error, naming what was searched and suggesting `--root`. No subcommand ever silently adopts cwd.

The L1 supervisor resolves the root **once** and passes it to workers via `REMUX_ROOT` in the spawn env (`supervise.rs` already sets `REMUX_WORKER`; same spot). Workers prefer the env over re-deriving — supervisor and worker can never disagree, and the worker no longer depends on inheriting the right cwd. `run_worker` chdirs to the root at boot so the existing cwd-relative code (`runtime.rs`, extension cwds) is untouched.

## Subcommand surface (`cli/src/main.rs` → clap derive)

`main.rs` moves to clap (derive API). The `REMUX_WORKER` short-circuit stays exactly as-is *before* clap parsing — worker spawns must not be affected by CLI surface changes.

### `remux start [--foreground] [--rebuild]`

Three modes, decided in order:

1. **`--foreground`** → run the L1 supervisor loop exactly as today. This is what the systemd unit execs (see §Unit) and the dev-loop verb.
2. **Unit installed** (`~/.config/systemd/user/remux.service` exists) → delegate: `systemctl --user start remux`, then print a one-line result (`started` / `already running`). Idempotent. `--rebuild` is rejected in this mode with a hint (`--rebuild needs --foreground; extension builds also rerun automatically when binaries are missing, and Settings → Restart rebuilds changed sources`) — there is no way to smuggle a flag through `systemctl start`.
3. **No unit** → foreground supervisor with a one-line hint that `remux install` sets up the background service. Preserves current fresh-box behavior.

Detection is the *unit file's existence*, deliberately not `INVOCATION_ID` sniffing: shells inside a remux terminal session inherit the service's environment (the same trap the `REMUX_WORKER` pid-guard comment in `supervise.rs` documents), so env-based detection would misfire exactly where it matters. The explicit `--foreground` in `ExecStart` keeps the unit → binary contract legible.

### `remux stop` / `remux restart`

Unit installed → `systemctl --user stop|restart remux`. No unit → error: a foreground runtime is stopped with Ctrl-C; there is no pidfile-based kill in this pass. `restart` is the post-rebuild verb; its help text says so ("picks up a freshly built binary").

### `remux status [--json]`

Three layers, each degrading independently:

1. **systemd:** unit installed / enabled / active (`systemctl --user is-enabled|is-active`), linger (`loginctl show-user $USER -p Linger`), `MainPID`. Skipped with a note when no unit exists.
2. **runtime:** `GET http://127.0.0.1:<port>/api/status` with `Authorization: Bearer <token>` — port from the root's config (host may be `0.0.0.0`; the client always dials loopback), token via the 3a resolution order. Renders: version, pid, uptime, auth on/off, resource summary (runtime RSS/CPU, system load), then a per-extension table — id, state, pid, uptime, restarts, watch state, RSS/CPU. Unreachable → "runtime not reachable at :<port>" plus the systemd block and a `remux logs` hint; 401 → "token mismatch — is REMUX_AUTH_TOKEN or the token file stale?".
3. **staleness:** if `MainPID` is known and `readlink /proc/<MainPID>/exe` ends in `(deleted)`, the binary was rebuilt under the running process → `⚠ binary rebuilt since start — run 'remux restart' to pick it up`. This is the cheap, kernel-truth answer to "did my rebuild take effect".

`--json` emits one object: the raw `/api/status` payload plus a `systemd` block — the scripting surface.

### `remux logs [EXTENSION] [-n N] [-f]`

Reads **files, not RPC** — this must work with the runtime down, because it is the recovery tool:

- No argument → the newest `<root>/.remux/logs/runtime-*.jsonl`, last `N` (default 100) entries pretty-printed (`HH:MM:SS level message` + non-empty extra fields); `--raw` for the JSONL as-is.
- `EXTENSION` → tail of `<root>/.remux/logs/extensions/<id>.log` (the pass-1 flat per-extension file: lifecycle + stderr + watch lines, already interleaved and rotated). Unknown id → error listing the ids present in that directory.
- `-f` → poll-follow (250ms): reopen when the inode changes or the size shrinks, so rotation and runtime restarts don't strand the tail. Ctrl-C exits 0.

### `remux doctor`

Read-only, one line per check (`ok` / `warn` / `fail` + a specific fix), exit 0 iff no `fail`. Checks, in dependency order:

| # | Check | Failure mode caught |
|---|---|---|
| 1 | root discovered; `config.toml` parses (surface the serde error verbatim) | the `deny_unknown_fields` boot-loop class — e.g. adding `watch = [...]` before deploying a runtime that knows the key |
| 2 | token file exists, mode 0600 | broken pairing / loose perms |
| 3 | `remux` on PATH resolves into `<root>/target/release/` (via symlink) | stale or missing install; PATH remux ≠ the binary systemd runs |
| 4 | `~/.local/bin/{node,npm}` exist and are not dangling | nvm version bump broke the symlinks → every view build fails at spawn |
| 5 | installed unit file == the binary's embedded copy | unit drift → `warn`, "run remux install" |
| 6 | unit enabled, active, linger on | box reboots into silence |
| 7 | `node`, `npm`, `cargo` all resolve on the *installed unit's* `Environment=PATH` (parse the line, probe each) | the view-build-watch deploy blocker, permanently monitored |
| 8 | `/healthz` reachable, then authenticated `/api/status` | daemon down vs token mismatch, distinguished |
| 9 | MainPID exe not `(deleted)` | rebuilt-but-not-restarted → `warn` |
| 10 | no second `remux start` process beyond the unit's own tree — scan `/proc` for `remux start` cmdlines; the legitimate set is exactly the unit's `MainPID` (the L1 supervisor) plus pids whose ppid is `MainPID` (its worker); anything else warns. Cgroup membership is deliberately *not* the discriminator: a stray launched from a remux terminal lives inside the service's cgroup and would pass a cgroup test | the stray-dev-instance case (observed live on this box: two `target/debug` runtimes started from a remux terminal, inside the service cgroup) |
| 11 | configured port, when the daemon is down, is not held by a foreign process | port squatting → `fail` naming the pid |
| 12 | `.remux/logs` under 500 MB | retention regression → `warn` |

### `remux install`

Idempotent setup, prints one line per action (`created` / `updated` / `unchanged` / `skipped: <why>`):

1. Resolve own binary via `current_exe()` (follows symlinks). If it is a `target/debug` build, warn and continue — the symlink still points at `<root>/target/release/remux` (the deployed path), never at debug.
2. `~/.local/bin/remux` → symlink to `<root>/target/release/remux`. **This is the whole rebuild contract:** cargo replaces the file at that path in place, so the symlink — and the unit, and the next `systemctl restart` — always resolve to the newest build with no re-install step.
3. `~/.local/bin/{node,npm,npx}` → symlinks to the binaries currently resolved on the invoking shell's PATH (`which node` — run install from a login shell so nvm is loaded; absent node → `skipped` + warn). Re-running install after an nvm upgrade refreshes them; doctor #4 nags when they dangle.
4. Write the **embedded** unit file (`include_str!("../../deploy/systemd/remux.service")` — repo copy stays canonical, binary carries it) to `~/.config/systemd/user/remux.service`; on change, `systemctl --user daemon-reload`.
5. `loginctl enable-linger $USER`; `systemctl --user enable remux`.
6. **Never auto-restarts a running service** (a restart bounces extension servers and live PTYs). When the unit changed or doctor-#9-style staleness is detected, it ends with: `run 'remux restart' to apply`.

## systemd unit changes (`deploy/systemd/remux.service`)

```ini
ExecStart=%h/.local/bin/remux start --foreground
Environment=PATH=%h/.local/bin:%h/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
```

Everything else (WorkingDirectory, Restart, TimeoutStopSec, the L0 rationale comments) is unchanged. Notes:

- `%h/.local/bin` first supplies both `remux` and the node/npm symlinks. This resolves the view-build-watch deploy checklist item with home-scoped symlinks instead of `/usr/local/bin` (no sudo, survives reprovisioning of system dirs, refreshed by `remux install`). nvm version bumps do not edit the unit — they re-run install.
- `ExecStart` through the symlink decouples the unit from the repo path; `--foreground` makes the unit → supervisor contract explicit rather than env-sniffed.
- `WorkingDirectory=%h/remux` stays as belt-and-braces; root discovery no longer depends on it.

## `GET /api/status` (runtime)

New exact-match route in the HTTP handler (`cli/src/http/mod.rs:38` neighborhood), behind the 3a auth middleware like everything else (health trio stays the only exemption). Response:

```json
{
  "version": "<CARGO_PKG_VERSION>",
  "pid": 1234, "startedAtMs": 0, "uptimeMs": 0,
  "requireAuth": true, "host": "0.0.0.0", "port": 48123,
  "resources": { /* latest remux/system/resources sample, verbatim */ },
  "extensions": { /* same payload as remux/extensions/status */ }
}
```

No new data sources: the handler closes over the same supervisor snapshot and `ResourceMonitor::latest()` the RPC router already uses (`cli/src/rpc/router.rs:248`). This is deliberately a read-only mirror — management verbs stay WS-RPC-only, so the attack surface of a leaked token over plain HTTP grows by zero write operations.

## Resource guardrail: role-keyed sampling (`cli/src/monitor.rs`)

The sampler attributes usage by `pgrp == server pid` (`monitor.rs:300`). Watch sidecars run in their own process groups, so a vite `--watch` tree — the hungriest thing view-build-watch added — is invisible to both the resources UI and the `extension_memory_ceiling_mb` alert. Observed on this box: the service cgroup at 6.5 GB while per-extension numbers look innocent.

Change: the monitor pulls **role-keyed pids** from the supervisor's status facets (run-state v2 already tracks `server` and `watch` slots per extension) and samples one pgroup per live role. Per-extension entry keeps every existing top-level field (now the **sum** across roles) and gains an additive breakdown:

```json
"roles": { "server": { "pid": 1, "processCount": 3, "rssBytes": 0, "cpuPercent": 0.0 },
           "watch":  { "pid": 2, "processCount": 4, "rssBytes": 0, "cpuPercent": 0.0 } }
```

The memory ceiling checks the summed figure — a runaway watcher now trips the same push notification as a runaway server. Transient `build` jobs stay unsampled (they live for seconds; the 5s cadence would mostly miss them anyway). The app renders the existing fields unmodified; a per-role Settings view is future polish, not this pass.

## Testing

- **Unit:** root discovery matrix (flag > env > walk-up > `~/remux` > error; walk-up stops at first `.remux`); clap parse table incl. `start --rebuild` rejection in delegate mode; journal pretty-printer; follow-mode reopen on inode-change and on truncation; unit-file drift compare; doctor check functions against fixture roots (loose token perms, dangling node symlink, unit-PATH missing npm); `/proc/<pid>/exe (deleted)` staleness parse; status rendering from a canned `/api/status` payload; monitor role aggregation (sum + breakdown) with fake proc tables.
- **Integration (existing harness):** `/api/status` — 401 without token, full payload with; payload extensions/resources agree with the WS methods; watch-role RSS appears after a `watch/start` and the ceiling alert fires on a fat fake watcher.
- **Manual checklist (the box):** run `remux install` from a login shell; from `$HOME`: `status`, `logs`, `logs terminal -f`, `doctor` all green; `cargo build --release` → `status` shows the staleness warning → `remux restart` → clean; `kill -9 <MainPID>` → systemd revives, `status` reflects it; `systemctl --user show remux -p Environment` shows the new PATH and an editor/markdown view build succeeds under the unit (`remux logs editor` shows the vite build, not a spawn ENOENT); reboot → linger brings everything back with no session.

## Rollout (binary before unit — the unit references `--foreground`, which old binaries reject)

1. Land the pass; `cargo build --release`.
2. From a login shell: `./target/release/remux install` — symlinks, unit update, daemon-reload, enable + linger. The **old** worker keeps running; nothing restarts yet.
3. Quiet moment: `remux restart` (bounces PTYs — same hot-swap cost as any runtime deploy). Then `remux doctor` from `$HOME`: everything green, including unit-PATH node/npm.
4. Now-unblocked operator acts from view-build-watch: add `views` build/watch blocks to ledger's manifest + `npm install` in `~/ledger/lens`; add `watch = [...]` autostart to `.remux/config.toml` (safe now — the running runtime knows the key; doctor #1 catches it if not).
5. Mark this spec Implemented; flip the stale "Active Spec" rows for landed work in `docs/specs/README.md` while there.

## Risks / accepted tradeoffs

- **`systemctl`/`loginctl` shell-outs** make `start|stop|restart|install|status` Linux+systemd-shaped. Accepted: the runtime is already Linux-only (`/proc`, pgroups, PDEATHSIG); every shell-out failure degrades to a printed error with the underlying stderr.
- **Loopback-only status client.** `remux status` dials `127.0.0.1` regardless of bind host — this pass's CLI is for the box the runtime runs on; remote status stays the app's job.
- **Doctor reads, never writes.** It will happily report the same failure forever; fixes are one named command away by design (install / restart / chmod). No auto-remediation, no surprises.
- **node symlinks pin a version until re-run.** An nvm upgrade needs `remux install` again. Doctor #4 turns that from a mystery build failure into a one-line nag — strictly better than the pinned-PATH or login-shell-ExecStart alternatives.
- **Stale-binary detection covers the supervisor only.** After a rebuild, a crash-restarted *worker* execs the new binary under the old supervisor (`supervise.rs` spawns via `current_exe`), a short-lived version skew until the next `remux restart`. Pre-existing behavior; status/doctor now at least make it visible.
