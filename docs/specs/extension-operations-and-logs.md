Status: Implemented — Pending Live Validation
Last verified: 2026-07-11
Canonical code: `cli/src/logs.rs`, `cli/src/extensions/supervisor.rs`, `cli/src/rpc/router.rs`, `extensions/codex/server/src/app_server.rs`, `extensions/codex/server/src/main.rs`, `app/src/settings/extensionServerApi.ts`, `app/src/settings/systemResourcesApi.ts`, `app/src/settings/ExtensionDetailSheet.tsx`, `app/src/settings/SettingsOverview.tsx`

# Extension operations and scoped logs

Clean up the extension detail sheet around the processes that actually exist.
Codex has a Remux-managed Extension Server, an independently managed Codex App
Server used by that extension, and a Viewer bundle/watcher. Each component owns
its status, controls, and logs. Replace hidden build/restart coupling with
explicit stage/apply actions, let the Codex App Server survive Extension Server
restarts, and stop treating stderr as an error severity.

This spec supersedes the Settings action-layout and log-routing portions of
[`view-build-watch.md`](view-build-watch.md). It preserves manifest-driven
Extension Server and Viewer supervision, watch process hygiene, and static
viewer serving. It adds a Codex-specific external-runtime facet; it does not
create a generic manifest facility for arbitrary service commands.

## Outcome

For Codex, the sheet is ordered as:

```text
Codex                                              Running

EXTENSION SERVER
State / PID / uptime / restarts / last exit / resources
[ Stop ]  [ Restart ]  [ Build ]

Logs
+-------------------------------------------------------+
| 08:24:35  lifecycle  starting                        |
| 08:24:36  process·stderr  ready                      |
+-------------------------------------------------------+

CODEX APP SERVER
State / uptime / installed version / running version
[ Stop ]  [ Restart ]  [ Update Codex ]

Logs
+-------------------------------------------------------+
| 08:24:36  connection  connected existing daemon     |
| 08:26:12  update      installed 0.145.0              |
+-------------------------------------------------------+

VIEWER
Build status / last build / watch status / resources
[ Build ]  [ Start Watch ]

Logs
+-------------------------------------------------------+
| 08:25:02  build  starting: npm run build             |
| 08:25:03  build  completed                           |
+-------------------------------------------------------+
```

Start/Stop labels are contextual. When the installed Codex CLI version differs
from the running App Server version, the App Server section shows **Restart
required to apply update**. An ordinary extension without an external runtime
keeps the simpler Extension Server and/or Viewer sections.

## Decisions

1. **Three components, two ownership domains.** Remux owns the Extension
   Server and Viewer watcher. The Codex daemon manager owns the Codex App
   Server. The extension connects to it over the existing Unix socket.
2. **Extension Server Build is build-only.** It stages a new binary while the
   current Extension Server and Codex App Server continue running. Restart or
   a later Start applies it.
3. **Codex Update is install-only.** `codex update` installs a new CLI but does
   not restart the running App Server. A later explicit App Server Restart
   applies it.
4. **Restarts are component-local.** Extension Server Restart must not restart
   the Codex App Server. App Server Restart must not restart the Extension
   Server or rebuild the Viewer.
5. **The Codex App Server survives Extension Server restarts.** Dropping the
   extension closes its socket connection only. It does not kill the daemon.
6. **Reconnect requires reconciliation.** After an Extension Server restart,
   reload authoritative thread/turn state before declaring the transcript
   ready. Missed notifications cannot leave a turn permanently Working.
7. **Potentially destructive App Server actions are turn-aware.** Stop and
   Restart require an idle runtime or an explicit interruption/confirmation
   flow. Update is allowed during a turn because it does not restart the
   running process.
8. **Logs are component-scoped at ingestion.** Every new log entry identifies
   its operational component. The UI does not infer ownership from text.
9. **Transport and severity are separate.** stdout/stderr identifies a pipe;
   it does not determine color or error state.
10. **No text severity heuristics.** Only runtime-known outcomes get explicit
    severity.
11. **Generalize presentation, not arbitrary execution.** Reuse operational
    section/action components in the app, but do not add manifest-defined
    shell actions until a second external-runtime use case exists.

### Why this is not a generic service manifest

The Codex App Server is not equivalent to a normal foreground child. It has
its own daemon manager, stable Unix socket, self-updater, installed-versus-
running version state, durable threads, and turn-aware restart constraints.
A generic manifest service would immediately need health-command parsing,
daemonization contracts, update semantics, secrets/environment rules,
confirmation policy, progress/log transport, and orphan cleanup.

For this pass:

- `OperationalSection` and app action descriptors are reusable presentation.
- Extension Server and Viewer actions remain standard Remux capabilities.
- Codex App Server management is an explicit Codex extension capability with
  fixed RPCs and commands.
- A future second external runtime can justify extracting a constrained
  protocol from two concrete implementations.

## Current problems

### The Extension Server owns and kills the Codex App Server

`AppServerRuntime` currently starts `codex app-server --listen unix://` as a
direct child, stores its `Child` handle, and kills it from `Drop`. The child
also inherits the Extension Server process group. Remux stops the whole group
when the Extension Server is restarted, so both ownership paths terminate the
App Server.

The Unix control socket and `connect existing runtime` path already allow a
better boundary. The installed Codex CLI exposes `app-server daemon
start|stop|restart|version`; the extension should use that daemon manager and
own only its client connection.

### Restart loses live projection state

The Codex App Server writes durable thread history, but the extension keeps
live transcript, turn runtime, usage, and operation-queue coordination in
memory. Restarting the Extension Server drops its App Server connection and
may miss notifications emitted during the gap. Today a session with
`task_started` but no terminal event projects as `inProgress` forever until a
later user message incidentally closes it.

Keeping the App Server alive prevents the underlying turn from being killed,
but the restarted extension still has to reconcile authoritative thread/turn
state before serving a transcript.

### stderr is presented as an error

The supervisor records every server stderr line with `stream: "stderr"`, and
the app maps every such entry to a red `err` tag. That makes normal messages
such as `[codex:app-server] starting runtime` look like failures even when the
server is running and the preceding exit was code 0.

The root problem is the log shape: `{ ts, stream, line }` overloads `stream`
as both transport and severity. stderr is a byte channel, not a severity.

### Components and builds share an underspecified stream

`exec_build` currently writes both `server.build` and `views.<id>.build`
output as `stream: "build"`. The app can separate `watch`, but it has no
reliable way to know whether a build line belongs under Server or Viewer.
Consequently Viewer build output appears in the generic Server log area, and
Codex App Server connection/lifecycle messages are indistinguishable from
Extension Server process output.

### Extension Server Build has hidden restart semantics

`remux/extensions/server/build` currently compiles the server and, when the
server is running, stops and respawns it. The button changes its label to
Build & Restart, coupling two useful operations and making a compile-only
validation impossible from the phone.

### The visual hierarchy is inverted

All controls appear before a generic Logs section, followed by a separate
Watch section. This divorces each log from the process that produced it and
makes Viewer Build output look server-owned.

## Action contract

| Component | Control | Enabled when | Runtime behavior |
| --- | --- | --- | --- |
| Extension Server | Start | server is not running | Preserve current missing/failed-artifact build behavior, then start and connect to the existing Codex daemon. Do not restart that daemon. |
| Extension Server | Stop | server is running | Stop and reap only the Extension Server group. Leave Viewer Watch and Codex App Server running. |
| Extension Server | Restart | server is running | Stop and start without forcing a build. Apply a previously completed Extension Server Build. Reconnect and reconcile App Server state. |
| Extension Server | Build | `server.build` is declared | Force-run only `server.build`. Preserve the current Extension Server PID/lifecycle and the Codex App Server. |
| Codex App Server | Start | daemon is stopped and Extension Server is available | Run the fixed `codex app-server daemon start` command, reconnect, initialize, and reconcile. |
| Codex App Server | Stop | daemon is running and no active turn exists | Stop the daemon. Keep the Extension Server running and expose the disconnected state. Require confirmation/interruption if a turn may be active. |
| Codex App Server | Restart | daemon is running and no active turn exists | Run the fixed daemon restart, reconnect, initialize, and reconcile. Apply an installed Codex update. Require confirmation/interruption if a turn may be active. |
| Codex App Server | Update Codex | updater is available and no other management action is pending | Run the fixed `codex update` command. Do not restart the daemon. Refresh installed/running versions and show Restart required when they differ. |
| Viewer | Build | at least one view build is declared and Watch does not own it | Force-run declared view builds in manifest order. Do not restart either server. Reload open tabs after success. |
| Viewer | Start Watch | watch is declared and stopped/failed | Preserve the current initial-build gate and supervised watch start. Do not restart either server. |
| Viewer | Stop Watch | watch is running | Stop and reap the watch group. Do not stop either server. |

Only one management action from this sheet runs at a time. App Server controls
are unavailable while the Extension Server is stopped because the first
implementation routes the Codex-specific management RPC through that
extension. Starting the Extension Server restores control and reconnects to
the still-running daemon.

### Extension Server Build details

`handle_server_build` changes as follows:

- Run the declared server build with the existing timeout, pgroup, run-state,
  and failure plumbing.
- On success, clear `last_build_failed` and return the current status without
  calling `stop_child` or `spawn_child`.
- If the server is running, append an info marker such as `completed; restart
  to apply` after the normal build completion marker.
- If the server is stopped, append the ordinary `completed` marker; Start
  will use the built artifact.
- On failure, keep the running server and its PID untouched, set
  `last_build_failed`, append an explicit error marker, and return the current
  RPC error contract.
- A build-only action does not reload viewer tabs. Restart, Start, successful
  Viewer Build, and Start Watch (which may perform a gating build) retain
  their relevant reload behavior.

The wire method remains `remux/extensions/server/build`; only its previously
hidden auto-restart side effect is removed. The response still returns
`built: true` on success.

### Codex App Server daemon details

`AppServerRuntime` changes from child ownership to connection ownership:

- `connect_or_start` first connects to the existing Unix control socket.
- If unavailable, invoke the installed Codex CLI with `app-server daemon
  start`, then retry connection and initialization within the existing
  timeout.
- Do not store a daemon `Child` handle in `AppServerRuntime`.
- Do not put the daemon in the Extension Server process group.
- `Drop` marks the connection dead and drains pending extension requests, but
  never stops the daemon.
- Remove the direct `codex app-server --listen unix://` fallback for supported
  Codex versions. If compatibility requires retaining it temporarily, report
  the runtime as non-persistent and do not claim restart survival.
- Both the primary and narration `AppServerRuntime` instances connect to the
  same daemon; neither owns its lifetime.

The Codex extension adds fixed management RPCs for status, start, stop,
restart, and update. They execute only the known Codex CLI commands and accept
no caller-provided command or arguments:

```text
remux/codex/app-server/status/read
remux/codex/app-server/start
remux/codex/app-server/stop
remux/codex/app-server/restart
remux/codex/app-server/update
```

The WebSocket dispatcher treats status as a concurrent Codex read and
serializes all four mutations in one Codex App Server management lane.
Suggested timeouts are 10 seconds for status, 30 seconds for daemon
start/stop/restart, and the existing 10-minute build-class timeout for update.

Status normalizes `codex app-server daemon version` into:

```ts
type CodexAppServerStatus = {
  state: 'running' | 'stopped' | 'starting' | 'stopping' | 'failed';
  socketPath: string | null;
  installedVersion: string | null; // daemon version cliVersion
  runningVersion: string | null;   // daemon version appServerVersion
  restartRequired: boolean;
  lastError: string | null;
  activeTurnIds: string[];
};
```

PID and uptime are optional until the daemon exposes them through a stable
machine-readable interface. Do not scrape `ps` output for the UI contract.
Run every command with the same resolved Codex executable and `CODEX_HOME`
used for the socket connection. Retain the daemon response
`managedCodexPath` as diagnostic metadata so a path mismatch is observable.

The app feature-detects this facet by calling status only for extension id
`codex`. Method-not-found means unsupported and hides the section/actions; it
does not become a red Extension Server failure.

`Update Codex` runs `codex update` with a bounded timeout and streams its
output to the Codex App Server component log. Success refreshes status but
does not call daemon restart. The running process therefore remains on its
old version until explicit Restart. This install-only behavior is a release
gate: verify it against the supported Codex CLI with a fixture and manual
version-mismatch flow. If an installed updater restarts the daemon itself,
Update must be treated as a destructive App Server restart and disabled during
active turns rather than silently violating this contract.

### Process-lifetime invariants

- The Extension Server and Codex App Server have different process groups and
  different owners.
- Extension Server Stop, Restart, crash recovery, build, Remux orphan sweep,
  and Remux shutdown never signal the Codex daemon group.
- Codex App Server Stop/Restart uses the Codex daemon command, never the Remux
  Extension Server group.
- Viewer Build/Watch never signal either server.
- An App Server crash/disconnect marks its facet failed/disconnected while the
  Extension Server remains responsive enough to report status and retry.
- App Server lazy start is idempotent when two extension clients (primary and
  narration) race to connect.
- Host-reboot autostart is not implied by process separation; that remains the
  Codex daemon bootstrap manager's responsibility.

### Turn-aware App Server stop/restart

Before Stop or Restart, refresh authoritative active-turn state. When a turn
is active, the normal action is disabled and the UI explains why. A later
explicit interruption flow may:

1. request `turn/interrupt`;
2. wait for the durable terminal notification/state;
3. synthesize an interrupted projection with reason `Codex App Server
   restarted` if the bounded wait expires;
4. perform the daemon action;
5. reconnect and reconcile.

Silent replay is forbidden because a partially completed turn may already
have changed files or external systems. Preserve durable thread history,
filesystem edits, queued-but-unsent local messages, and the composer draft.

### Extension restart reconciliation

After reconnecting to a surviving App Server, and before broadcasting Ready:

1. initialize a fresh socket client;
2. enumerate the active/recent threads needed by open resources;
3. read authoritative turns and current thread status;
4. rebuild live transcript/runtime/usage projections;
5. mark a persisted orphan `inProgress` turn interrupted only when the App
   Server proves no corresponding active turn exists;
6. invalidate transcript, thread, model, composer, usage, and queue resources
   affected during the gap;
7. resume live notification forwarding.

The Viewer also treats `transcript.inProgress` plus an authoritative ready or
failed runtime with no matching active turn as a reconciliation trigger,
never as permission to show Working forever.

## Structured extension-log contract

### Wire shape

Extend `ExtensionLogLine` additively:

```ts
type ExtensionLogLine = {
  ts: string;
  line: string;

  // New authoritative routing and presentation fields.
  area: 'server' | 'viewer';
  componentId: string;
  source: 'lifecycle' | 'process' | 'connection' | 'build' | 'watch' | 'update';
  channel: 'stdout' | 'stderr' | null;
  level: 'info' | 'warn' | 'error' | null;
  viewId: string | null;

  // Legacy projection retained during compatibility rollout.
  stream: string;
};
```

Field semantics:

- `area` keeps Server-side components separate from Viewer components.
- `componentId` selects the exact operational panel. Stable first-party ids
  are `extension-server`, `codex-app-server`, and `viewer:<viewId>`.
- `source` identifies the operation that produced the line.
- `channel` records the child-process pipe when applicable. It is `null` for
  runtime-generated lifecycle/build/watch markers.
- `level` is set only when Remux knows the severity. Raw child output uses
  `null`, including raw stderr.
- `viewId` is populated for a specific viewer build/watch and is otherwise
  `null`.
- `stream` remains during rollout so an old app can render new-runtime logs.
  It is not authoritative in the new app.

`ExtensionLogs::append` should accept typed metadata rather than independent
string literals. A Rust shape along these lines makes invalid combinations
harder to create:

```rust
struct ExtensionLogMeta {
    area: LogArea,
    component_id: String,
    source: LogSource,
    channel: Option<LogChannel>,
    level: Option<LogLevel>,
    view_id: Option<String>,
    legacy_stream: &'static str,
}
```

Do not infer metadata inside `ExtensionLogs`; callers know which operation
they are running and must supply it.

### Routing table

| Producer | area | componentId | source | channel | level |
| --- | --- | --- | --- | --- | --- |
| Extension Server start/stop/restart/exit | server | extension-server | lifecycle | null | info, or error for a known failed exit |
| Extension Server child stderr | server | extension-server | process | stderr | null |
| Extension Server build output | server | extension-server | build | matching pipe | null |
| Extension Server build marker | server | extension-server | build | null | info/error as known |
| App Server connect/disconnect/reconcile | server | codex-app-server | connection | null | info/warn/error as known |
| App Server daemon lifecycle action | server | codex-app-server | lifecycle | null | info/error as known |
| `codex update` stdout/stderr | server | codex-app-server | update | matching pipe | null |
| Codex update result marker | server | codex-app-server | update | null | info/error as known |
| Viewer build stdout/stderr | viewer | viewer:&lt;id&gt; | build | matching pipe | null |
| Viewer build marker | viewer | viewer:&lt;id&gt; | build | null | info/error as known |
| Watch stdout/stderr | viewer | viewer:&lt;id&gt; | watch | matching pipe | null |
| Watch supervision marker | viewer | viewer:&lt;id&gt; | watch | null | info/warn/error as known |

The build executor therefore takes an explicit target:

```rust
enum BuildTarget {
    ExtensionServer,
    Viewer { view_id: String },
}
```

`exec_build(BuildTarget, &BuildSpec)` uses the target for every raw line and
runtime marker. This fixes Viewer routing for manual builds, start-flow builds,
and watch-gating builds with the same mechanism.

The CLI owns logs for processes it supervises. The Codex extension owns
connection/reconciliation and updater context, so it emits a reserved,
structured `remux/extension/managementLog` notification. The supervisor intercepts that
notification, overwrites the extension identity, validates the component and
metadata, appends it to the existing ring, and does not forward it as a normal
Viewer notification. This is a log-ingestion primitive, not an arbitrary
action facility.

The detached daemon no longer inherits Extension Server stderr. Its panel
therefore guarantees connection, reconciliation, lifecycle-command, update
output, and known failures. Raw internal daemon diagnostics are included only
if the Codex daemon later exposes a stable log interface; do not scrape a
system journal or process stderr heuristically.

### Severity presentation

The UI colors from `level`, never `channel`:

- `error`: red tag/text accent.
- `warn`: warning accent.
- `info`: muted or normal informational accent.
- `null`: neutral raw output.

Source/channel tags remain useful but neutral. Examples:

- `build` for a runtime-generated build marker.
- `build·stderr` for raw compiler stderr, still neutral unless accompanied by
  a runtime-known error entry.
- `stderr` for an Extension Server process line, muted rather than red.
- `connection` for a Codex App Server reconnect marker.
- `update·stderr` for raw updater stderr, still neutral.
- `watch` or `watch·stderr` in the Viewer panel.

The runtime always emits a separate explicit `level: error` marker when a
spawn fails, a build times out/exits nonzero, a server exits unsuccessfully,
or watch supervision reaches a known failure. This preserves visible errors
without guessing about raw output.

### Storage, ring, and subscription behavior

- Keep the existing per-extension 500-line in-memory ring, live subscription,
  100 ms batching, and rotated-file limits for this pass.
- Snapshot and `didAppend` response envelopes stay unchanged; only each line
  gains additive fields.
- The app keeps an independent 500-line array per rendered component after
  routing a snapshot/live batch. A noisy Viewer or updater panel therefore
  does not evict another component in app state after receipt, although the
  runtime aggregate ring remains the ultimate snapshot bound.
- Preserve chronological ordering within each panel.
- Update rotated text-file formatting so component is visible, for example:
  `timestamp [viewer/viewer:main/build:stderr] line`. Files remain
  human-readable text rather than changing to JSONL.
- Prefixes embedded in `line` (`[build]`, `[watch]`) become unnecessary for
  new entries because metadata carries the same information. Remove them
  from new writes; keep parser/display fallback for old entries.

## App layout and behavior

### Section composition

Replace the generic bottom Logs/Watch composition with reusable
operational sections:

```tsx
<OperationalSection
  title="Extension Server"
  status={extensionServerStatusRows}
  actions={extensionServerActions}
  logs={extensionServerLines}
/>

<OperationalSection
  title="Codex App Server"
  status={appServerStatusRows}
  actions={appServerActions}
  logs={appServerLines}
/>

<OperationalSection
  title="Viewer"
  status={viewerStatusRows}
  actions={viewerActions}
  logs={viewerLines}
/>
```

The exact component name is not contractual; component ownership and order
are. The rendering component accepts ordinary app-owned action descriptors
(`id`, labels, disabled/busy state, tone, handler). It does not execute
manifest-provided commands.

Extension Server status rows:

- State
- PID
- Uptime
- Restarts
- Last exit
- Server-role resources, when sampled

Codex App Server status rows:

- State
- Installed Codex version
- Running App Server version
- Restart required, when versions differ
- Socket path only in diagnostic detail, not the default compact rows
- Active turns, when nonzero
- Last management/reconciliation error

Viewer status rows:

- Build: Built / Not built (when view builds are declared)
- Last build (when known)
- Watch: Running / Stopped / Failed
- Watch PID, uptime, and restarts when relevant
- Watch-role resources, when sampled

The runtime already returns `roles.server` and `roles.watch` resource
breakdowns; `systemResourcesApi.ts` currently discards them and keeps only the
aggregate extension totals. Parse those existing role fields so resources are
not attributed to the wrong surface. Against an older runtime without role
breakdowns, show the aggregate once in a small shared summary near the header
rather than assigning it to Server or Viewer.

The header badge continues to summarize the Extension Server lifecycle when
one exists. A Codex App Server failure appears inside its section rather than
replacing a truthful Running Extension Server badge. Viewer-only extensions
summarize the Viewer facet: Watching, Watch failed, Built, or Not built.

### Scrolling

All sections must remain reachable at the medium and large native detents:

- The sheet's section content is vertically scrollable when it cannot fit.
- Each log panel has a bounded height and its own vertical ScrollView.
- Each panel independently implements the existing stick-to-bottom-unless-
  scrolled behavior.
- New lines in one component never scroll another.
- Empty text is component-specific: `No Extension Server output yet.`, `No
  Codex App Server output yet.`, and `No Viewer output yet — Build or start
  Watch to see output here.`

### Parsing legacy lines

The new app accepts both log shapes:

- New structured fields are authoritative when valid.
- Legacy `watch` routes to `viewer:main`.
- Legacy `lifecycle` and `stderr` route to `extension-server`.
- Legacy `build` is inherently ambiguous and temporarily routes to
  `extension-server`;
  message-text or command-name heuristics are explicitly forbidden.
- Legacy stderr renders as neutral `stderr`, fixing the false red-error issue
  even when the new app talks to an old runtime.

Legacy `[codex:app-server]` stderr remains in Extension Server logs; the app
must not use that prefix as a routing heuristic. Once upgraded, App Server
connection and action logs arrive structurally under `codex-app-server`.
No persisted-ring migration is required because the ring is process memory.

## Runtime and API changes

### `cli/src/logs.rs`

- Add typed area/component/source/channel/level metadata to
  `ExtensionLogLine`.
- Serialize the additive fields in snapshots and live batches.
- Update readable rotated-file formatting.
- Preserve the legacy `stream` projection during rollout.

### `cli/src/extensions/supervisor.rs`

- Pass `BuildTarget` through every Extension Server/Viewer build path.
- Route Extension Server lifecycle and raw process output with
  `extension-server` metadata.
- Route view build and watch output with `viewer:<id>` metadata.
- Add explicit runtime-known error markers.
- Remove the stop/spawn block from successful manual Extension Server Build.
- Intercept and validate the reserved extension management-log notification
  used for `codex-app-server`.

### `extensions/codex/server/src/app_server.rs`

- Replace direct child ownership with `codex app-server daemon` management.
- Connect first; use daemon start only when the socket is unavailable.
- Close connections without stopping the daemon on `Drop`.
- Add fixed status/start/stop/restart/update helpers with bounded timeouts.
- Emit typed App Server connection/lifecycle/update log events.

### `extensions/codex/server/src/main.rs`

- Expose the Codex-specific App Server management RPCs.
- Serialize them separately from ordinary read traffic.
- Report installed/running versions and active-turn preflight state.
- Reconcile thread/turn projections after every reconnect before Ready.
- Invalidate affected resources after reconciliation.

### `app/src/settings/extensionServerApi.ts`

- Parse and validate the new optional log metadata.
- Normalize new and legacy records into one app-owned structured type.
- Update Extension Server Build documentation to build-only semantics.
- Add typed Codex App Server status/action API helpers and RPC policies.

### `app/src/settings/systemResourcesApi.ts`

- Parse the runtime's existing optional `roles.server` and `roles.watch`
  resource samples.
- Preserve aggregate resource fields as the compatibility fallback.

### `app/src/settings/ExtensionDetailSheet.tsx`

- Replace stream-based filtering with normalized component routing.
- Render Extension Server status, actions, then logs.
- For Codex, render Codex App Server status, actions, then logs.
- Render Viewer status, actions, then Viewer Logs.
- Label the Extension Server action `Build` in all lifecycle states.
- Show Update Codex separately from App Server Restart.
- Show Restart required when installed/running versions differ.
- Disable App Server Stop/Restart while an active turn is known.
- Color from explicit severity; show stderr as a neutral channel tag.
- Maintain independent scroll/stick state for every panel.

### `app/src/settings/SettingsOverview.tsx`

- Do not reload Viewer tabs after Extension Server Build or Codex Update.
- Continue reloading after successful Viewer Build.
- Reload after Extension Server Start/Restart and Start Watch only where the
  existing Viewer recovery behavior requires it.
- Refresh App Server status after every daemon/update action and after
  Extension Server reconnect.

Codex App Server management requires new Codex-specific RPC methods. The
generic extension-management RPC surface remains unchanged.

## Compatibility and rollout

| Pairing | Behavior |
| --- | --- |
| Old app + new runtime | Additive log fields are ignored. Existing generic layout remains; legacy `stream` keeps lines visible. Extension Server Build no longer restarts despite the old dynamic label. App Server controls are absent. |
| New app + old Remux runtime | New component layout and neutral stderr work, but legacy build routing remains ambiguous and Extension Server Build may still auto-restart. Hide unsupported App Server controls. |
| New app/runtime + old Codex extension | Extension Server and Viewer sections work. Codex App Server section shows management unavailable; do not infer status by process scraping. |
| New app/runtime + new Codex extension | Full three-component action, persistence, reconciliation, and scoped-log contract. |

Because each mixed-version pairing has one visible semantic limitation, deploy
runtime, app, and Codex extension in the same release window. Runtime-first
establishes build-only and component-log support; the Codex extension then
adopts persistent daemon ownership; the app exposes controls last.

## Testing

### Remux runtime Rust tests

- `ExtensionLogLine` serializes area/component/source/channel/level/viewId
  plus legacy stream.
- Rotated-file formatting includes the component id and remains one line per
  entry.
- Extension Server lifecycle and raw stderr route to `extension-server`; raw
  stderr has no severity.
- Extension Server build stdout/stderr and markers route to
  `extension-server`.
- Manual Viewer Build, automatic missing-entry build, and watch-gating build
  all route to `viewer:<id>` with the correct `viewId`.
- Watch stdout/stderr and supervision markers route to `viewer:<id>`.
- A valid reserved management-log notification is appended under
  `codex-app-server`; invalid metadata/component spoofing is rejected.
- Spawn failure, timeout, and nonzero exit create explicit error-level markers.
- Successful Extension Server Build preserves PID, startedAtMs, running state,
  restart count, watcher state, and the App Server daemon.
- Failed Extension Server Build preserves both live servers and returns an
  error.
- Explicit Restart after Build changes PID and starts the newly built binary.

### Codex extension Rust tests

- An available socket connects without invoking daemon start.
- An unavailable socket invokes fixed `app-server daemon start` once and then
  connects within the timeout.
- Dropping every `AppServerRuntime` connection does not invoke daemon stop or
  kill the daemon process.
- Primary and narration runtimes share the same daemon without claiming child
  ownership.
- Daemon-version JSON normalizes running/stopped state, socket path, installed
  version, running version, and `restartRequired`.
- Update invokes only `codex update`, streams component-scoped output, refreshes
  versions, and never invokes daemon restart.
- Start/Stop/Restart invoke only their fixed commands and reject overlapping
  management actions.
- Stop/Restart is rejected while authoritative active-turn preflight reports a
  turn.
- Reconnect rebuilds projection state after a completion occurred during the
  connection gap.
- Reconnect preserves a genuinely active turn as Working.
- Reconnect marks an orphaned persisted in-progress turn interrupted and
  invalidates the transcript.
- A failed reconnect exposes a failed/disconnected App Server facet while the
  Extension Server remains alive and responsive.

### App tests

- Structured component metadata routes entries into exactly one panel.
- Viewer build/watch entries never appear in either Server panel.
- App Server connection/update entries never appear in Extension Server Logs.
- Legacy stderr is neutral, not an `err` severity.
- Explicit error entries render with the danger tone.
- Legacy build fallback is deterministic and does not inspect message text.
- Codex sections are ordered Extension Server, Codex App Server, Viewer; each
  section orders status, actions, logs.
- Extension Server Build is always labeled Build and does not trigger a tab
  reload.
- Extension Server Restart is disabled when that server is not running.
- App Server Stop/Restart is disabled while an active turn is reported.
- Update Codex stays enabled during an active turn, does not reload tabs, and
  never implies that the running version changed.
- A version mismatch renders Restart required to apply update.
- Unsupported/old Codex extensions hide App Server actions without process
  scraping.
- Viewer Build is disabled while Watch owns the bundle.
- Viewer-only extensions omit both Server sections and retain usable
  Build/Watch controls.
- Extension Server and watch resource rows use corresponding role samples; an
  unscoped legacy aggregate is shown only once.
- Each log panel sticks independently and preserves position when scrolled up.

### Manual acceptance

1. Record both PIDs. Restart the Extension Server. Its PID changes; the Codex
   App Server PID and running version do not.
2. Start a Codex turn, restart only the Extension Server, and confirm the turn
   remains active or completes, the transcript reconciles, and no second user
   message is needed to clear Working.
3. Tap Extension Server Build while it is running. Build output appears only
   there and neither server PID changes.
4. Tap Extension Server Restart. Only its PID changes and it reconnects to the
   existing App Server.
5. Open Codex details after reconnect. Connection narration appears under
   Codex App Server with neutral/info severity, not as red Extension Server
   stderr.
6. Verify App Server Stop/Restart is unavailable during an active turn. After
   the turn completes, Restart changes only the App Server PID and the
   extension reconnects/reconciles.
7. Run Update Codex in a controlled environment. The installed version
   refreshes, the running daemon remains alive, and a mismatch shows Restart
   required. Restart then applies the installed version.
8. Tap Viewer Build. npm/vite output appears only under Viewer, open Codex
   tabs reload, and neither server restarts.
9. Start Watch, edit Viewer source, and confirm rebuild notices appear only
   under Viewer. Stop Watch and confirm both servers remain running.
10. Open editor or markdown details and confirm the sheet begins with Viewer.

## Non-goals

- Arbitrary extension-defined buttons, labels, RPC methods, or shell commands
  in the manifest.
- Versioned binary slots, rollback, or restarting an old Extension/App Server
  binary after a new one has been staged.
- Silent replay of interrupted Codex turns.
- Guaranteeing survival across host reboot. `app-server daemon bootstrap` may
  provide durable host integration, but this pass guarantees survival across
  Extension Server and Remux process restarts only; reboot behavior follows
  the installed Codex daemon manager.
- Scraping `ps`, system journals, or undocumented daemon files for status or
  logs.
- Merging raw internal Codex daemon diagnostics into the Remux ring when no
  stable daemon log interface exists.

## Development isolation and first cutover

The pre-migration App Server is a child in the live Extension Server process
group. It cannot be detached after exec, so the first cutover has one
intentional idle-only interruption. Development before that point must not
touch the live daemon or shared production artifact.

- Build/test the Codex extension with a branch-specific target directory, not
  `/tmp/remux-codex-server-target`.
- Give daemon tests a fake command runner, temporary `CODEX_HOME`, and fixture
  socket. Unit/integration tests must never call the real daemon commands.
- Do not exercise live Settings Build/Restart or `codex app-server daemon
  stop|restart` while an implementation turn is active.
- Do not run `codex update` against the live installation until its
  install-only behavior is validated.
- Commit and verify the implementation before the real cutover.
- For first cutover, wait for idle, stop the coupled Extension/App Server,
  start the managed daemon, start the new Extension Server, and verify
  reconnect/reconciliation.
- After cutover, first prove idle Extension Server restart preserves the App
  Server PID. Validate active-turn survival only after that invariant passes.

## Implementation sequence

1. Land typed component log metadata, `BuildTarget`, reserved management-log
   ingestion, and compatibility fields.
2. Make manual Extension Server Build build-only and pin PID-preservation
   tests.
3. Move `AppServerRuntime` from child ownership to Codex daemon connection
   ownership; add daemon status/start/stop/restart/update helpers.
4. Add reconnect reconciliation and orphaned-turn recovery before claiming
   restart continuity.
5. Add Codex-specific management RPCs and app API policies.
6. Update app normalization, resource parsing, severity rendering, and the
   ordered three-component layout.
7. Update tab-reload triggers and mixed-version behavior.
8. Run Remux and Codex Rust tests, app typecheck/lint/tests, and the native
   manual acceptance flow.
