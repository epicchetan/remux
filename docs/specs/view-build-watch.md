Status: Active Spec
Last verified: 2026-07-07
Canonical code: `cli/src/extensions/manifest.rs`, `cli/src/extensions/supervisor.rs`, `cli/src/extensions/runstate.rs`, `cli/src/runtime.rs`, `cli/src/rpc/router.rs`, `cli/src/config.rs`, `cli/src/http/viewers.rs`, `app/src/settings/*`

# View build + watch

Extend the pass-2 manifest `build` phase to views, and add a managed `watch`
sidecar for dev iteration. After this pass, a fresh checkout (or a wiped
`/tmp`) self-builds every extension end to end — server binary *and* viewer
bundle — and the dev loop for any viewer is: toggle Watch in Settings, edit
source, reload the view. The app manages watch and its logs from the same
extension detail sheet that already owns start/stop/restart/rebuild.

## Current state (facts this design leans on)

- **Serving reads from disk per request.** `ViewerProvider` does
  `tokio::fs::read` per hit with no cache (`http/viewers.rs`), falling back to
  the entry file. Anything that writes new files into a view's dist directory
  is live on the next reload. The serving path needs **zero changes**.
- **Every viewer dist is gitignored** (codex `viewer/dist`, ledger
  `lens/dist`, …). A fresh checkout serves 404s until someone hand-runs the
  viewer build. The server side already solved this exact problem with the
  manifest `build` phase; views are the missing half.
- **All five extensions have vite `build` + `watch` scripts** — codex,
  terminal, editor, markdown (extension-root `package.json`, config
  `viewer/vite.config.ts`), and ledger (`lens/package.json`). None is
  build-free today; the schema still keeps both fields optional for a future
  pure-vanilla-JS viewer that serves checked-in files.
- **editor and markdown have no server.** `runtime.rs` only creates
  supervisors for `server.is_some()`, so these extensions have no status
  entry: their Settings rows render "No server extension" and are *disabled*
  (`disabled={!hasServer}` where `hasServer = Boolean(status)`), so the
  detail sheet can't open for them at all. View builds force this to be
  fixed — a supervisor per managed extension, server or not. Note the
  flip side: once the runtime registers serverless supervisors, statuses
  appear and those rows enable themselves *even on old apps* (see
  §Compatibility).
- **Watch already exists as a hand-rolled convention**:
  `scripts/watch-viewers.cjs` spawns `vite build --watch` per extension
  outside the runtime — unsupervised, unswept, logs to a stray terminal. This
  pass moves that under the runtime's process hygiene and retires the script.
- **The build job and the server child are the two process shapes the
  supervisor already has.** A view build is `run_build` with a different
  command triple. A watcher is a supervised long-lived child like the server,
  minus the RPC stdio protocol. Nothing new has to be invented — this pass is
  plumbing existing primitives at view scope.

## Design overview

Two additions, one distinction:

- **`views.<id>.build` — a job.** Terminal process, same plumbing as
  `server.build`: pgroup, `[build]` log lines into the extension ring,
  10-minute timeout, failure lands `failed` with `lastExit.reason:
  "build-failed"` and consumes no crash budget.
- **`views.<id>.watch` — a service.** Long-lived supervised child, killed on
  worker shutdown via pgroup, recorded in the run-state file for the boot
  orphan sweep, crash-restarted with backoff, logs into the ring as a `watch`
  stream.

Watch is a **facet of extension status, not a lifecycle state**. The
`stopped/building/starting/running/stopping/backingOff/failed` machine stays
exactly as-is (the app's `parseServerState` has a closed set; new states
would degrade to `running`-derived fallbacks on older apps). Watch state
rides a new additive `watch` object on status responses and
`didChangeStatus` broadcasts.

Deliberately **not** in scope: vite dev-server / HMR proxying. Serving stays
static-from-disk; the watcher rewrites files; the user reloads the view. This
keeps the runtime out of the websocket-proxying business and matches the
`vite build --watch` convention every extension already uses.

## Manifest schema (additive)

```json
"views": {
  "main": {
    "route": "/viewers/ledger",
    "entry": "lens/dist/index.html",
    "build": { "command": "npm", "args": ["run", "build"], "cwd": "lens" },
    "watch": { "command": "npm", "args": ["run", "watch"], "cwd": "lens" }
  }
}
```

- Both fields optional and independent (build without watch, watch without
  build, neither).
- Parsed with the existing `parse_command_triple`; validated with the same
  error-string style as `server.build` (`views.main.build must be an
  object`, `views.main.build.command must be a non-empty string`, …).
- Validation must **not** stat `entry` when the view has a `build` — the
  bundle legitimately doesn't exist on a fresh checkout. (Validation does not
  stat entry today; this pins that with a test.)
- `ExtensionManifest` grows a helper: `has_managed_views()` — any view with
  `build` or `watch` — and `has_build()` — `server.build` or any view build.

### Rollout table (all extensions)

| Extension | server.build | views.main.build | views.main.watch | build/watch cwd |
| --- | --- | --- | --- | --- |
| codex | cargo (landed, pass 2) | `npm run build` | `npm run watch` | `.` |
| terminal | cargo (landed, pass 2) | `npm run build` | `npm run watch` | `.` |
| editor | — (no server) | `npm run build` | `npm run watch` | `.` |
| markdown | — (no server) | `npm run build` | `npm run watch` | `.` |
| ledger (external repo) | cargo (landed, uncommitted) | `npm run build` | `npm run watch` | `lens` |

For the in-repo extensions, npm scripts run against hoisted workspace deps
(root `package.json` declares `extensions/*` workspaces), so `npm install` at
the repo root is a build precondition exactly like the cargo toolchain is for
server builds. Ledger is a separate repo and is **not** workspace-hoisted —
`lens/` carries its own `node_modules`, so it needs its own install (see
§Deploy checklist). The build phase never runs `npm install` itself —
installs are a deliberate operator act.

## Runtime changes (`cli/`)

### 1. Supervisors for view-only extensions

`runtime.rs` changes its filter from `ext.server.is_some()` to
`ext.server.is_some() || ext.has_managed_views()`. The supervisor actor is
unchanged in shape; with `server: None` it simply has no child to spawn:

- `start_flow` runs the needed builds, then — no server — settles back to
  `stopped` (not a fake `running` with no pid; the app renders serverless
  rows from the build/watch facets instead, see §App).
- Build failure works unchanged: `failed`, `lastExit.reason: "build-failed"`,
  manual retry.
- Editor and markdown thereby gain real status rows, log rings, and working
  detail-sheet actions for the first time.

### 2. Build sequencing in `start_flow`

```
start(rebuild) →
  [Building]  server.build   (if declared and needed)
  [Building]  view builds    (manifest order, if declared and needed)
  spawn server child         (if server declared)
```

- One `Building` state covers the whole sequence; builds run sequentially in
  the actor (start/restart RPCs keep blocking through `building`).
- Server build first: it gates the spawn, so it fails fastest where it
  matters.
- **Per-view needed rule** (mirrors the server rule): view `entry` missing,
  or `rebuild: true`, or that view's last build failed.
- Each build step logs its own `starting: <command> <args>` line into the
  `[build]` stream; per-step 10-minute timeout (`build_timeout_ms`).
- Any step failing aborts the sequence → `failed` / `build-failed` / no crash
  budget consumed.
- **Dist ownership rule**: a view whose watcher is currently running is
  *skipped* by the build sequence (the watcher owns that dist; racing it
  produces torn bundles). The skip is logged: `[build] skipping view main:
  watch owns the bundle`.
- `hasBuild` on status responses becomes the aggregate `manifest.has_build()`
  — the app's Rebuild & Restart button lights up for editor/markdown/ledger
  with zero app changes.

### 3. Watch sidecar

Lifecycle:

- `watch/start`: if any watched view's `entry` is missing, run that view's
  `build` first (one-shot) so the first page load never races vite's initial
  compile. This gating build runs **under the watch facet, not the lifecycle
  `Building` state** — the server may be `running` while it happens, and
  `running: state == Running` must stay truthful (the state machine has no
  Running→Building edge). Build lines stream into the `[build]` log as
  usual; gating-build failure sets the *watch facet* to `failed` (journal
  event, `didChangeStatus`) and leaves the extension lifecycle untouched.
  The build still runs inline in the actor, so other commands (stop,
  restart) queue behind it — same mailbox semantics as a rebuild, and why
  the app's `watch/start` timeout is 600s. Then spawn every declared view
  watch spec as one supervised child each (in practice: one view, one
  child), pgroup-led, `kill_on_drop`, PDEATHSIG via the existing
  `harden_command`.
- stdout+stderr stream into the extension ring as stream `watch` with a
  `[watch] ` line prefix (same shape as `build`).
- **Crash policy**: exponential backoff restart with the existing
  backoff/budget parameters but a **separate crash counter** from the
  server's. During backoff the facet **stays `running`** — its semantics are
  "watch is enabled and being kept alive", so the Settings toggle doesn't
  flap while `restartCount` climbs; `failed` is the only terminal state.
  Budget exhausted → watch facet state `failed`, journal event,
  `didChangeStatus` broadcast — **no system push notification** (a dev
  watcher dying is not an ops page; the server's failed-state push stays
  server-only).
- `watch/stop`: EOF is meaningless to vite, so: SIGTERM to the group → 2s →
  SIGKILL to the group → confirmed reap (the existing escalation minus the
  EOF step).
- Extension `stop`/`restart` do **not** touch the watcher (a server bounce
  shouldn't kill your dev loop). Worker shutdown and the L1 supervisor's
  group cleanup kill it like everything else.
- Watch state is **ephemeral across worker restarts** except for config
  autostart (below). A worker bounce with watch enabled comes back with watch
  off unless configured on — acceptable for a dev facility, and the Settings
  toggle makes re-enabling a one-tap act.

Config autostart (`.remux/config.toml`, additive key):

```toml
watch = ["ledger", "codex"]
```

Extensions listed start their watch at boot (after their initial
build-if-needed). Unknown ids journal a warning and are ignored. Absent key =
no autostart; watch stays a manual, per-session act. `deny_unknown_fields`
means an old runtime given a config containing `watch` doesn't just reject
the key — `load_remux_config` errors and the **worker fails to boot**, so
the unit crash-loops until an ssh fix. On a phone-managed box that's a real
lockout: runtime deploys strictly before config edits (see §Rollout).

### 4. Run-state file v2

Two concurrent live groups per extension (server + watch) breaks v1's
one-entry-per-id map. Version bump, role-keyed:

```json
{
  "version": 2,
  "extensions": {
    "codex":  { "server": { "pid": 1, "pgid": 1, "startTicks": 2, "startedAtMs": 3 },
                "watch":  { "pid": 4, "pgid": 4, "startTicks": 5, "startedAtMs": 6 } },
    "editor": { "build":  { "pid": 7, "pgid": 7, "startTicks": 8, "startedAtMs": 9 } }
  }
}
```

- Roles: `server`, `build`, `watch`. Build gets its own role instead of
  borrowing the extension's single slot (v1 behavior) — a build and a watcher
  can coexist.
- `RunState::record`/`remove` take `(extension_id, role, entry)`.
- **Migration**: the reader accepts both shapes — a v1 file's bare entries
  are read as `{ "server": entry }`. No rewrite step: the boot sweep
  *deletes* the file after sweeping (v1 behavior, `runstate.rs:154`) and the
  first `record` of the new run writes v2. No downgrade path.
- **Boot sweep**: iterate every role of every extension; same
  liveness + start-ticks pid-reuse guard per entry; `killpg` matches and
  journal `sweep:killed` with extension id *and role*. Same hard guards
  (never pgid ≤ 1, never self).

### 5. RPC surface (additive)

- `remux/extensions/watch/start` `{extensionId}` → full management status
  object (below). Errors: unknown extension; `watch not declared` when no
  view has a watch spec. Idempotent: already running → current status,
  `started: false`.
- `remux/extensions/watch/stop` `{extensionId}` → status. Idempotent.
- App-side timeout for `watch/start` uses the rebuild timeout (600s) — it may
  gate on an initial view build; `watch/stop` uses the standard 30s.
- `remux/extensions/status`, start/stop/restart responses, and
  `didChangeStatus` params all gain (stable order, after `hasBuild`):

```json
"hasServer": true,
"views": { "declared": 1, "built": true, "lastBuildAtMs": 0 },
"watch": { "declared": true, "state": "running", "pid": 0,
           "startedAtMs": 0, "restartCount": 0 }
```

- `hasServer`: lets the app distinguish "stopped server" from "nothing to
  run" (editor/markdown).
- `views`: `declared` counts views with a build; `built` is true when every
  declared view's entry exists — computed by statting each declared entry at
  snapshot time (cheap, always fresh; no cache to invalidate);
  `null`-equivalent shape (`declared: 0`) when no view builds exist.
- `watch`: `declared: false` (and nothing else) when no view has a watch
  spec; states are `stopped | running | failed` — a *facet*, not the
  extension lifecycle.
- `didChangeStatus` broadcasts on watch transitions (start, exit, backoff
  restart, failed) with the same full payload — the app's existing
  subscription picks watch changes up for free.

### 6. Logs

- New ring stream `watch`, lines prefixed `[watch] ` (mirroring `[build] `).
  Rotated-file lines carry the same `ts [stream] line` shape as today.
- No retention change: watch output is line-buffered vite recompile notices,
  low volume by nature. The 500-line ring and existing file rotation absorb
  it.

## App changes (`app/src/settings/`)

### `extensionServerApi.ts`

- `ExtensionServerStatus` gains `hasServer: boolean`, `views: { declared:
  number; built: boolean; lastBuildAtMs: number | null }`, `watch: {
  declared: boolean; state: 'stopped' | 'running' | 'failed'; pid: number |
  null; startedAtMs: number | null; restartCount: number }`.
- `parseExtensionServerStatus` defaults all three against a pass-2 runtime:
  `hasServer: true`, `views: { declared: 0, built: false, lastBuildAtMs:
  null }`, `watch: { declared: false, … }` — every new control hides itself
  against an old runtime.
- New calls: `startExtensionWatch` / `stopExtensionWatch` (watch RPCs above;
  600s / 30s timeouts).

### `ExtensionDetailSheet.tsx`

- `ExtensionDetailAction` gains `'watch-start' | 'watch-stop'`.
- **Actions row**: when `status.watch.declared`, add a Watch button —
  `Start Watch` / `Stop Watch` by facet state, busy-spinner plumbed through
  `busyAction` like every other action. `Rebuild & Restart` already keys off
  `hasBuild` and needs no change (aggregation happens runtime-side). For
  serverless extensions (`hasServer: false`), hide Start/Stop/Restart —
  Rebuild and Watch are the only meaningful verbs.
- **Status block**: add a `Watch` row when declared — `running · pid 1234 ·
  3m` / `stopped` / `failed (n restarts)`.
- **Log tags**: `logStreamTag` gains `case 'watch'` with its own tone
  (reuse the build accent or a distinct muted-accent); `logMessage` strips
  the `[watch] ` prefix like it strips `[build] `. (Unpatched apps render
  `watch` lines with the default muted stream tag — graceful.)

### `SettingsOverview.tsx`

- `runDetailAction` routes the two watch actions to the new API calls and
  merges the returned status like the others.
- **Row gating**: rows are currently disabled when no status entry exists
  (`hasServer = Boolean(status)`). Serverless extensions now *have* status
  entries, so that check silently opens them up — re-key the disabled/chevron
  gating off the new `status.hasServer` field's presence semantics instead:
  a row is tappable whenever a status exists, and the sheet decides which
  verbs to show (per `ExtensionDetailSheet` above).
- **Row badges**: rows currently derive their badge purely from lifecycle
  state, which would show serverless extensions as permanently `Stopped`.
  With the new facets: `hasServer: false` rows badge from build/watch
  instead —
  `Watching` (busy tone) when watch runs, `Built` (ok tone) when
  `views.built`, `Build failed` (bad tone) when `lastExit.reason ==
  'build-failed'`, `Not built` (idle) otherwise. Server rows keep today's
  badge, plus a small `· watching` suffix in the row meta line when the
  watch facet is running.

## Compatibility

| Pairing | Result |
| --- | --- |
| old app + new runtime | Unknown status fields ignored by the existing parser; `watch` log stream renders with the default muted tag; no watch controls. One rough edge: serverless rows enable themselves (statuses now exist) and the old sheet shows Start/Stop/Restart — Start runs the view build then settles `stopped`, which looks like a no-op but is harmless. Fully usable. |
| new app + pass-2 runtime | Facets default off (`watch.declared: false`, `hasServer: true`); watch controls and serverless badges hide themselves. Fully usable. |
| new runtime + old config | `watch` key absent — no autostart. Fine. |
| old runtime + new config | `deny_unknown_fields` rejects `watch` — deploy runtime before adding the key (§Rollout). |
| v1 run-state file + new runtime | Read as `{server: entry}`, swept, rewritten v2. |

## Testing

**Manifest** (`manifest.rs`): parses view build/watch triples with cwd
resolution; rejects malformed shapes with the exact error strings; parsing a
view with `build` does not stat `entry`; `has_managed_views` /
`has_build` truth tables.

**Supervisor** (`supervisor.rs`): serverless start runs view build then
lands `stopped` with `views.built: true`; view build failure lands `failed`
/ `build-failed` / no crash budget; `rebuild: true` re-runs view builds;
build sequence skips watch-owned views and logs the skip; watch start gates
on initial build when entry missing; gating-build failure sets the watch
facet `failed` and leaves the extension lifecycle (and a running server)
untouched; watch crash → backoff restart on its own counter with the facet
staying `running` through backoff; watch budget exhaustion → facet `failed`,
no push; extension stop/restart leave the watcher untouched;
`didChangeStatus` fires on watch transitions.

**Run-state** (`runstate.rs`): v2 round-trip; v1 migration; sweep kills
per-role groups with the start-ticks guard; record/remove per role leaves
sibling roles intact.

**Router** (`router.rs`): watch RPC happy paths, unknown-extension and
not-declared errors, idempotency flags; status field order and defaults.

**Chaos** (`tests/chaos.rs`): `kill -9` the worker with a live watcher →
boot sweep kills the orphaned watch group (the v2 analog of the existing
orphan tests).

**App**: parser defaults against pass-2-shaped payloads; sheet renders watch
controls only when declared; serverless rows badge from facets.

## Rollout

1. **Runtime step 1 — view builds.** Manifest schema + validation, serverless
   supervisors, build sequencing, `hasBuild` aggregation, `hasServer` +
   `views` status facets. Lands alone: fresh checkouts self-build, Rebuild &
   Restart covers viewers, no watch yet.
2. **Runtime step 2 — watch.** Run-state v2 + migration + sweep, watch
   sidecar + crash policy, watch RPCs + `watch` status facet, config
   autostart key, `watch` log stream.
3. **App.** Facet parsing, watch controls + status row + log tag, serverless
   row badges. (Order vs step 2 is free — each degrades gracefully against
   the other.)
4. **Manifests.** All four in-repo extensions + ledger's (external repo).
   Retire `scripts/watch-viewers.cjs` and the `viewers:watch` root script in
   the same change; `viewers:build` stays (CI convenience).
5. **Config.** Add `watch = [...]` on the dev box after the runtime deploy.

### Deploy checklist

- **systemd PATH must gain node/npm.** The unit currently exports
  `PATH=%h/.cargo/bin:/usr/local/sbin:...` (the cargo fix); node lives under
  nvm (`~/.nvm/versions/node/v24.18.0/bin`) and is invisible to the unit.
  Pin the nvm bin dir into the unit's `Environment=PATH=…` or (better)
  symlink `node`/`npm` into `/usr/local/bin` so version bumps don't edit the
  unit. Without this, every npm build phase fails at spawn — readable from
  the phone, but still down.
- `npm install` run at the repo root (workspace deps hoist; build phases
  never install) **and** in `~/ledger/lens` (separate repo, own
  `node_modules` — not covered by the remux workspace install).
- Ledger repo: `remux-extension.json` gains its view build/watch blocks
  (`cwd: "lens"`); ledger's `.env`/cwd semantics are untouched (the manifest
  `cwd` only scopes build/watch commands).

## Non-goals / punts

- **HMR / vite dev-server proxying** — rejected above; static-from-disk is
  the contract.
- **Per-view watch granularity** — watch start/stop is per-extension,
  aggregating its views. Every current extension has exactly one view; revisit
  only if a multi-view extension materializes.
- **Watch-state persistence across worker restarts** beyond the config list.
- **Build caching/fingerprinting** (skip build when sources unchanged) — vite
  and cargo already no-op fast on warm caches; the entry-missing rule is
  enough.
- **A phone toggle that edits `config.toml`** — the Settings watch button
  controls the live runtime only; autostart stays an operator config act.
- **Watch children in the resource monitor** — the monitor samples
  `status().pid` (the server child), so vite watchers — the most RAM-hungry
  thing this pass adds — go unsampled and are invisible to the memory
  ceiling. The resource-guardrails pass should pick up per-role pids from
  run-state v2.
