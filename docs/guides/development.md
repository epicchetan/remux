# Development Guide

Status: Current
Last verified: 2026-07-07

## Prerequisites

- Node and npm compatible with `packageManager` in `package.json`.
- Rust and Cargo for the runtime (`cli/`) and the extension servers.
- Expo/iOS/Android tooling when working on the mobile app.
- Playwright browsers when running Codex viewer tests.

The Codex extension also expects a working Codex CLI/app-server environment on the host machine.

## Install

```bash
npm install
```

## Build Viewers

```bash
npm run viewers:build
```

This builds static assets for extensions that define build scripts. The runtime serves those built assets from each extension manifest's `views.main.entry`.

During viewer development, run:

```bash
npm run viewers:watch
```

Keep this in a separate terminal from the runtime.

## Start The Runtime

The runtime is the Rust `remux` binary (`cli/` crate). `npm run dev` wraps `cargo run`.

Local-only:

```bash
REMUX_HOST=127.0.0.1 npm run dev
```

Device/LAN testing:

```bash
REMUX_HOST=0.0.0.0 npm run dev
```

For day-to-day use, build the release binary once and run it directly:

```bash
npm run build:cli
./target/release/remux start
```

`remux start` runs a supervisor that restarts the worker on any abnormal exit, so a crash or an in-app "Restart runtime" never requires SSH. After editing runtime source, rebuild (`npm run build:cli`) and restart from the app — the supervisor respawns the worker from the freshly built binary on disk. Changes to the supervisor itself (`cli/src/supervise.rs`, `cli/src/main.rs`) need a full stop/start of `remux start` (under systemd: `systemctl --user restart remux`).

`remux start --rebuild` forces each extension's manifest `build` phase to run on first spawn even when the built artifact exists. Extension servers with a `server.build` manifest phase (codex, terminal) are otherwise built automatically whenever their binary is missing — e.g. after a reboot clears `/tmp` — and can be rebuilt from the app via **Rebuild & Restart** in the extension's detail sheet.

### Run under systemd (production)

The production host runs remux as a systemd user service so it starts on boot and survives supervisor death. One-time install, performed **from tmux/SSH, never from a remux terminal session** (stopping the runtime from inside kills your own shell):

```bash
npm run build:cli
mkdir -p ~/.config/systemd/user
cp deploy/systemd/remux.service ~/.config/systemd/user/
systemctl --user daemon-reload
loginctl enable-linger "$USER"        # run without an SSH session; start on boot
# stop any tmux-hosted `remux start`, then:
systemctl --user enable --now remux
```

Operations:

```bash
systemctl --user status remux         # unit + supervisor/worker state
journalctl --user -u remux -f         # supervisor/worker stderr
systemctl --user restart remux        # full restart incl. the supervisor
systemctl --user reset-failed remux   # recover from a supervisor crash-loop stop
```

The structured runtime journal stays in `.remux/logs/`. The app's **Restart runtime** flow is unchanged under systemd: the worker exits 75 and the persistent supervisor respawns it from the on-disk binary — so `npm run build:cli` + app restart remains the hot-swap path for worker-side changes.

Local runtime configuration can live in `.remux/config.toml`:

```toml
host = "0.0.0.0"
port = 48123
extension_roots = ["extensions"]
log_retention_days = 14
resource_poll_seconds = 5          # resource sampler cadence
watchdog_stale_seconds = 30        # worker hang watchdog; 0 disables
extension_memory_ceiling_mb = 0    # per-extension RSS alert; 0 disables
```

`extension_roots` entries are parent directories scanned for child folders that
contain `remux-extension.json`. Relative entries resolve from the Remux checkout
root. Include `"extensions"` when adding out-of-tree roots, because configured
roots replace the default.

Environment variables override `.remux/config.toml` when present:

| Variable | Purpose |
| --- | --- |
| `REMUX_HOST` | Runtime bind host. Defaults to `0.0.0.0`. |
| `REMUX_PORT` | Runtime port. Defaults to `48123`. |
| `REMUX_EXTENSION_ROOTS` | Path-list override for configured extension discovery roots. |
| `EXPO_PUBLIC_REMUX_ORIGIN` | Build-time fallback origin used by the Expo app before local settings are saved. |
| `CODEX_HOME` | Codex home used by the Codex extension server. |
| `CODEX_BIN` | Codex binary override for app-server startup. |
| `REMUX_CODEX_DEBUG` | Enables additional Codex extension diagnostics. |

Runtime logs are written under `.remux/logs/`: a journal per boot (`runtime-<runId>.jsonl`, pruned by `log_retention_days`, default 14) and rotated per-extension stderr files under `.remux/logs/extensions/`.

## Start The Mobile App

From the repo root:

```bash
npm --workspace @remux/app run start
```

For native builds:

```bash
npm --workspace @remux/app run ios
```

or:

```bash
npm --workspace @remux/app run android
```

The app stores Remux host/port settings locally. For physical device testing, set the runtime host to an address reachable from the device.

## Generated And Local Files

The repo intentionally ignores local runtime state, generated native folders, build outputs, credentials, Rust targets, Playwright results, and local reference checkouts.

Important ignored paths include:

- `.remux/`
- `.codex-mobile/`
- `node_modules/`
- `target/`
- `dist/`
- `test-results/`
- `app/ios/`
- `app/android/`
- `app/.expo/`
- `codex/`
- `t3code/`
