Status: Implemented in working tree — automated tests green; host rehearsal (dry-run → --now → gate → rollback) pending, config table not yet written
Last verified: 2026-09-26 (cargo test -p remux 296 tests, npm run test:agent-server 433 tests, both typechecks, release build; card OTA published twice on preview)
Canonical code: `crates/remux/src/maintenance.rs`, `crates/remux/src/config.rs`, `crates/remux/src/cli/mod.rs`, `crates/remux/src/cli/agent.rs`, `crates/remux/src/http/mod.rs`, `crates/remux/src/rpc/ws.rs`, `crates/remux/src/runtime.rs`, `extensions/agent/shared/native-agent-protocol.ts`, `extensions/agent/server/src/provider-adapter.ts`, `extensions/agent/server/src/native-agent-server.ts`, `extensions/agent/server/src/native-runtime/native-coordinator.ts`, `extensions/agent/server/src/providers/published-version.ts`, `extensions/agent/server/src/providers/claude/claude-adapter.ts`, `extensions/agent/server/src/providers/codex/codex-adapter.ts`, `extensions/agent/tests/harness-autoupdate.test.ts`, `app/src/settings/SettingsOverview.tsx`, `app/src/settings/agentRuntimeApi.ts`, `app/src/settings/maintenanceApi.ts`

# Unattended agent harness updates

Keep the Claude and Codex harnesses current without the owner thinking about
it. Today Codex stays current because the Agent Runtimes card gives it an
`Update Codex` button, and Claude drifts because the same card gates its action
row on `runtime.provider === 'codex'`. Claude Code sat 25 releases behind
(2.1.258 against 2.1.283) while Codex tracked latest. The fix is not another
button: it is a runtime-owned job that installs, verifies, activates, and rolls
back on its own, plus the provider-agnostic seam that job and the card share.

No notifications. A job that needs the owner to read a push is a job that has
not finished its work. Everything the owner might want to know — what ran, what
it decided, what it is holding back from — is a status row on the card and a
line in the runtime log, read on demand.

## The three facts this rests on

**Installing is always safe; activating is the only risk.** A running Claude
turn holds its already-exec'd binary, and the native installer writes a new
`~/.local/share/claude/versions/<v>` before flipping the `~/.local/bin/claude`
symlink that `claude-adapter.ts` resolves at spawn (`pathToClaudeCodeExecutable:
'claude'`). A running Codex daemon holds its open binary inode. So `claude
update` and `codex update` can run at any time, mid-turn, with nothing gated.

**An idle restart costs almost nothing.** `claude-adapter.ts` already resumes a
native session after its process ends; what a restart destroys is an in-flight
model invocation, which cannot be restored without rerunning the prompt. A
restart with no turn in flight loses nothing — the conversation rebinds on its
next message. That reduces safety to one computable predicate, quiescence, and
is why this can be unattended at all.

**The SDK must never lead the CLI.** `@anthropic-ai/claude-agent-sdk` is the
wire schema for the CLI it spawns. CLI ahead of SDK is additive and fine; SDK
ahead of CLI breaks. So the CLI updates freely and the pin follows it, never the
reverse.

## Where the driver lives

In the runtime, `crates/remux/src/maintenance.rs`. The agent extension cannot
own this: it is the process being rebuilt and restarted, so it cannot supervise
its own replacement. The runtime already owns extension build and restart, has a
`Building` → `build-failed` lifecycle that fails without burning crash budget,
holds the config, and survives everything it restarts.

The driver takes its dependencies as injected seams in the style
`CodexRuntimeHost` already uses — a command runner, a clock, a quiescence
reader, a supervisor handle, a registry fetcher — so every branch below is
reachable from `cargo test -p remux` with no network, no npm, and no waiting for
a real release.

## The run

A tick fires every `tick_minutes` (default 15). Outside the maintenance window,
or while holding, it returns immediately. Stages, in order, each a gate:

1. **Preconditions.** `extensions/agent/package.json` and `package-lock.json`
   are clean in git and no merge or rebase is in progress. A dirty tree there
   means the owner is editing; skip the cycle. Every restore in this spec is
   scoped to exactly those two paths — the job never touches another file it did
   not write.

2. **Install both CLIs.** `claude update`, then `codex update`. Ungated: safe
   with turns in flight. Read the resulting `claude --version`.

3. **Resolve the pin target.** Fetch the published version list for
   `@anthropic-ai/claude-agent-sdk` and choose the highest version whose patch
   component does not exceed the installed CLI's patch (2.1.283 → 0.3.283). The
   CLI's own latest version never needs a registry lookup, because `claude
   update` self-checks and `claude --version` reports the result. If the target
   equals the current pin, skip to stage 9 — nothing needs rebuilding.

4. **Bump and install.** `npm install @anthropic-ai/claude-agent-sdk@<target>
   --workspace @remux/agent` from the repo root.

5. **Verify against sources, before touching any artifact.** `npm run
   typecheck` and `npm run test:agent-server`. Both read TypeScript sources, not
   `server/dist`, so a red gate here costs nothing but a restore — and it means
   the only step left after the build is the restart itself, leaving no window
   where a crash could bring the supervisor up on an unverified bundle. The full
   `test:agent` is deliberately not the gate: the Playwright viewer suites are
   too slow and too flaky to hold a nightly job hostage.

6. **Wait for quiescence**, polling within the window. Quiescence means: no
   conversation with an `activeTurnId`, no queued work, nothing compacting,
   nothing recovering, and no activity at all for `quiet_minutes` (default 20).
   The quiet period matters as much as the instantaneous check — without it the
   job can fire in the gap between two turns of a conversation the owner is
   sitting in. If the window closes first, restore and retry next cycle;
   restoring keeps the tree clean so stage 1 passes tomorrow.

7. **Build.** Copy `server/dist` to `server/dist.prev`, then run the extension's
   declared server build through the runtime's own build path.

8. **Activate and prove it.** Re-check quiescence, restart the agent extension,
   then verify the result: the extension returns to `ready`, its provider probe
   passes, and `listModels()` returns a non-empty catalog. On any failure,
   restore `dist.prev`, restore the pin, reinstall, re-point
   `~/.local/bin/claude` at the previous entry in `versions/`, restart again,
   and hold.

9. **Commit, last.** Only after the probe passes: commit the pin bump and
   lockfile locally (`chore(agent): bump claude-agent-sdk to <version>`) and do
   not push. Committing after verification is what keeps rollback from ever
   having to undo a commit.

10. **Codex activation.** If Codex reports `restartRequired` and its threads are
    idle, call the codex extension's existing idle-gated
    `remux/codex/app-server/restart`. That gate is not reimplemented here, and
    the agent extension never restarts that daemon — it is the same per-user
    `codex app-server daemon` backing the codex extension's own threads, and two
    owners of one lifecycle is a hazard.

**Holding.** Three consecutive failures against the same target version stop
attempts until the target changes. The hold, its reason, and its timestamp live
in the state file and surface on the card. Holding on last-known-good is the
correct terminal state, not an error to escalate.

State lives in `.remux/maintenance/agent-autoupdate.json`: last run, last
result, last defer reason, installed CLI version, pinned SDK version, and the
current hold if any.

## Configuration

A new `[agent_autoupdate]` table in `.remux/config.toml`, `deny_unknown_fields`
like its parent: `enabled` (default true), `window` (default `03:30-06:00`,
local), `quiet_minutes` (20), `tick_minutes` (15), `commit` (true), `registry`
(the npm registry base URL).

`RemuxConfig` rejects unknown keys, so an old runtime refuses to boot on a
config it does not know — the trap the `watch` key comment already records.
Deploy the runtime first, add the config second.

## Seams

**`remux agent update [--now] [--dry-run]`** runs exactly what the timer runs;
the scheduled path is never a separate untested branch. `--dry-run` prints the
plan and the gate decisions without mutating anything. The subcommand is a thin
loopback client over a new authenticated `POST /api/agent-autoupdate/run`,
resolving its token the same way `remux status` resolves it for `/api/status`.

**`remux/agent/maintenance/quiescence/read`** on the agent extension answers the
predicate from coordinator state that already exists — `activeTurnId`, queued
work, compaction, recovery:

```json
{ "quiescent": true, "observedAt": 0, "activeTurns": 0, "queuedMessages": 0,
  "compacting": 0, "recovering": 0, "activeSessions": 0,
  "lastActivityAt": null, "blockers": [] }
```

**`remux/agent/runtime/update`** takes `{ providerInstanceId }` and dispatches to
a new `ProviderAdapter.updateRuntime()`, returning the refreshed runtime status
and the command's log lines. Claude's implementation is `claude update` through
the adapter's existing `runCli`, followed by a `--version` re-probe and an
`agent/runtime:*` invalidation.

**`remux/agent/runtime/restart`** takes `{ providerInstanceId }` and is
implemented by the coordinator, not the adapter: it closes every idle session of
that provider through the same path idle eviction uses, so each one resumes on
its next message with nothing lost — now on the installed binary. A session
with a turn, queue, compaction, or child work in flight keeps its process and
is counted in the response log. This is what "Restart" on the Claude card does,
and it is the by-hand version of what stage 8 does to every session at once.
`updateRuntime` also re-probes the provider afterwards, because the model
catalog was read from the binary that was installed at startup and the new one
may know models the old one did not.

**`ProviderRuntimeStatus`** gains `availableVersion`, `updateCheckedAt`,
`supportsUpdate`, `supportsRestart`, and `sessionVersions` — a
`{ version, sessions }[]` breakdown of what live sessions are actually running.
`runningVersion` becomes the single version when the breakdown has one entry and
null otherwise, replacing today's claim in `claude-adapter.ts` that the running
version simply equals the installed one. After auto-update lands, sessions
routinely outlive their binary, and the card should say so: Claude reports
`restartRequired` whenever a live cohort differs from the install.

**`CLAUDE_AGENT_SDK_VERSION`** in `claude-adapter.ts` is a hand-copied literal
sitting next to the real dependency in `package.json`. Read it from the
installed package; a version the card reports must not be able to lie.

## Card

`AgentRuntimeCard` renders its action row from `supportsUpdate` /
`supportsRestart` instead of the `provider === 'codex'` check, so Claude gets
Update and Restart and both providers get one code path. "Version" is always
the installed version on both cards; an "Available" row appears when the
registry knows a newer release and a "Running" row only when live sessions are
on something else (`2.1.258 · 1 session`, or `2×2.1.258 · 1×2.1.283` across
cohorts), so the cards read identically at rest. Add and an auto-update line reading from a new runtime RPC
`remux/maintenance/agent-autoupdate/read`: last run, next window, or the hold
and its reason. That read returns `MaintenanceStatus` — the persisted state
flattened under the schedule it runs on (`enabled`, `window`, `inWindow`,
`quietMinutes`) — so the card never reads config, and it renders once per
section rather than once per card because one driver serves both harnesses.
Generalize the Codex-specific restart copy. This is the only
part that ships by Expo OTA, and it needs the usual fingerprint swap
(`git show 27ab393:app/package.json`) or the update never reaches the phone.

## How this gets proven

The pending 2.1.258 → 2.1.283 upgrade is the test fixture, which is why the
one-off manual update must not happen first — it would burn the only real
upgrade available and defer the first live exercise to an unobserved night weeks
out.

Deterministic tests in `cargo test -p remux` cover what production almost never
exercises: dirty tree skips; typecheck or test failure restores the pin; the
window closing mid-wait defers with a clean tree; a failed post-restart probe
rolls back dist, pin, and the CLI symlink and then holds; three failures against
one target stop attempts; a target equal to the pin is a no-op; an active turn
blocks the restart.

Then, on the real host, in order: `remux agent update --now --dry-run` to read
the plan (`--now` because a plain `--dry-run` outside the window correctly
reports the window gate and stops there); `--now` with nothing live to perform
the real upgrade end to end; `--now` again with a deliberately long turn in
flight to confirm it defers rather than restarts; `--now` against a pin known to
fail the build to confirm the restore path lands back on the working version and
holds. Then enable the schedule.

`--now` bypasses the window but never the quiet period, so the rehearsal needs
`quiet_minutes` set low (1) while it runs and back to 20 before the schedule is
trusted — otherwise every attempt defers on the activity that set it up.

Deployment order is fixed by the config gate: build and deploy the runtime,
restart the agent extension from outside any agent session, then write the
`[agent_autoupdate]` table.
