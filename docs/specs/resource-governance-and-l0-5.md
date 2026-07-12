Status: Active Spec
Last verified: 2026-07-11
Canonical code: `deploy/systemd/remux.service`, `deploy/systemd/remux*.slice`, `crates/remux/src/guardian.rs`, `crates/remux/src/resource/`, `crates/remux/src/cli/workload.rs`, `crates/remux/src/supervise.rs`, `crates/remux/src/runtime.rs`, `crates/remux/src/extensions/process.rs`, `crates/remux/src/extensions/supervisor.rs`, `crates/remux/src/extensions/manifest.rs`, `crates/remux/src/monitor.rs`, `crates/remux/src/watchdog.rs`, `crates/remux/src/rpc/ws.rs`, `crates/remux-compute/`, `packages/viewer-kit/src/rpc.ts`, `packages/viewer-kit/src/ipc.ts`, `packages/viewer-kit/src/host.ts`, `app/src/browser/BrowserShell.tsx`, `app/src/remote/RemuxConnectionProvider.tsx`, `app/src/remote/remuxRpcClient.ts`, `app/src/surfaces/viewer/ExtensionWebView.tsx`, `app/src/notifications/RemuxNotificationProvider.tsx`, `extensions/codex/remux-extension.json`, `extensions/codex/server/src/app_server.rs`, `extensions/codex/server/src/narration.rs`, `deploy/codex/skills/remux-workloads/`, `../ledger/remux-extension.json`

# Resource governance, equal extension isolation, and L0.5 recovery

Keep Remux controllable from the phone while trusted extensions use the host at
full throughput. Remux core has the highest scheduling importance. Every
discovered extension receives an equal extension-level resource share,
regardless of whether it is bundled under `remux/extensions`, discovered from
another repository such as `../ledger`, or loaded from another configured
extension root.

Extensions work without modification: their existing server, descendants,
builds, and watchers are automatically contained. An extension may later split
its own allocation into interactive, background, research, or persistent
workloads through one generic Remux workload API. Those children divide the
extension's existing share; creating more child scopes never grants an
extension more top-level CPU.

This is a resource and recovery platform, not a zero-trust plugin sandbox. The
current extensions are written and trusted by the Remux owner. Validation still
prevents accidental cross-extension placement and invalid lifecycle requests,
but the design does not add adversarial multi-tenant complexity.

This spec also replaces the deadline-heavy RPC policy that amplified the July
11 CPU-saturation incident into repeated `Superseded by healthy connection`
failures. Ordinary RPCs become semantic, cancellable operations with bounded
pending state; actual transport health keeps a small set of explicit deadlines.

## Outcome

The platform guarantee is:

> No extension workload may prevent the phone from reaching Remux control,
> identifying load, pausing work, or restarting the affected component.

The resource hierarchy is conceptually:

```text
Remux host
├── Remux core                              highest priority
│   ├── L0.5 guardian
│   └── Remux worker: HTTP, WebSocket, RPC
│
└── Extensions                              lower aggregate priority
    ├── Codex                               equal extension weight
    │   ├── Extension Server
    │   ├── persistent App Server daemon
    │   ├── narration
    │   └── research
    │
    ├── Ledger                              equal extension weight
    │   └── current all-in-one server
    │
    ├── Terminal                            equal extension weight
    │   └── sessions
    │
    └── any external extension              equal extension weight
        └── default contained server/tree
```

When Remux is idle, extensions may use all non-reserved CPU. When Remux needs
CPU, the kernel gives core a larger share. When multiple extensions are busy,
their parent extension slices compete equally. Within one extension, its
adapter/runtime/background weights only divide that extension's allocation.

## Scope

This implementation includes:

- a small L0.5 guardian separate from the Remux Tokio worker;
- a static top-level systemd/cgroup-v2 topology for core and extensions;
- dynamic, equal-weight per-extension slices created during discovery;
- automatic placement of current servers, builds, watchers, and descendants;
- a generic attach-and-exec workload primitive for optional subdivisions;
- a small Rust helper and language-neutral CLI for extension authors;
- persistent workload support needed by the Codex App Server daemon;
- resource accounting and phone pause/stop/restart controls;
- a reserved physical core for Remux core;
- a global Codex skill for deliberate heavy shell work;
- migration from caller-authored RPC timeout budgets to semantic query,
  command, job, subscription, and liveness contracts;
- end-to-end request cancellation, bounded pending work, and slow-request
  diagnostics that do not declare a connection unhealthy;
- conversion of long lifecycle, build, update, and generation operations from
  open RPCs into observable jobs;
- connection health, generation drain, and retry-coalescing corrections;
- migration and saturation tests.

This implementation does not require:

- Ledger to split its runtime from its adapter;
- a new Ledger snapshot format;
- shared memory, `memfd`, or a new Ledger IPC protocol;
- every extension to adopt manifest version 2;
- static systemd unit files for known extension IDs;
- arbitrary manifest-provided systemd properties;
- prompt or skill compliance for safety;
- hostile-extension isolation;
- real-time Linux scheduling;
- a fixed CPU quota that leaves capacity unused.

## Implementation checkpoint

The code implementation is present in the working tree as of 2026-07-11:
static and transient resource placement, the L0.5 guardian and phone recovery
surface, manifest-v2 workloads and the Rust/CLI launch helpers, Codex workload
adoption, cgroup accounting, semantic cancellable RPCs, bounded observable
jobs, connection generation draining, and the global heavy-compute skill.

The static units are installed on the reference host, Remux is running in
protected mode, and runtime, Codex, Ledger, Terminal, and the persistent Codex
App Server have verified cgroup placement. Initial saturation recovery passed.
The spec remains active for the broader soak/phone matrix and optional
extension-specific splits described below.

## Relationship to existing specs

This spec supersedes the timeout-health classification, connection replacement,
and old-generation drain details in
[`rpc-concurrency-and-mobile-resilience.md`](rpc-concurrency-and-mobile-resilience.md).
It preserves that spec's bounded lanes and reserved control concurrency. It
replaces exhaustive caller-authored timing policies with smaller semantic RPC
contracts owned by the transport and operation implementation.

It extends
[`extension-operations-and-logs.md`](extension-operations-and-logs.md). The
component UI and persistent Codex daemon lifecycle from commit `e85e562`
remain authoritative. Resource governance changes where processes run, not who
owns their application lifecycle.

## Baseline verified before implementation

1. `remux.service` currently contains the L1 supervisor, Remux worker,
   Extension Servers, Codex App Server, Codex descendants, Ledger, Terminal,
   builds, watchers, and R&D commands.
2. They normally run at nice level 0 with no internal CPU weights or affinity.
3. The installed unit has `Delegate=no`, no `CPUWeight`, and
   `KillMode=control-group`.
4. The host has eight physical cores and sixteen logical CPUs. `(0,8)` through
   `(7,15)` are SMT sibling pairs.
5. Remux already has reserved logical RPC lanes. Logical concurrency cannot
   guarantee OS scheduling when native workers saturate every core.
6. Resource monitoring currently aggregates `/proc` records by process group.
   A descendant that starts a new process group can escape extension accounting
   while remaining inside `remux.service`.
7. The L1 watchdog detects a roughly 30-second worker event-loop hang. The
   incident involved repeated 2–5 second latency breaches, so no restart was
   appropriate.
8. Codex now uses `codex app-server daemon start|stop|restart|version` and the
   extension no longer directly owns the App Server child.
9. The daemon currently inherits the cgroup of the command that started it and
   remains inside `remux.service`, so an explicit service stop can still kill it
   despite the new independent application ownership.
10. Ledger currently combines Remux RPC, sessions, projection execution, and
    cache reads in one `ledger-remux` process.
11. `packages/viewer-kit/src/rpcPolicy.ts` requires each method to declare
    connect-wait, queue, execution, transfer, and total budgets plus completion,
    retry, timeout-health, deadline-outcome, and lane details.
12. `RemuxConnectionProvider` currently adds queue, execution, and transfer
    budgets into one client response timer. Those phases are not independently
    observed, so the apparent precision does not describe where time was spent.
13. `crates/remux/src/rpc/ws.rs` separately hard-codes extension execution budgets by
    method, while `crates/remux/src/extensions/supervisor.rs` consumes an injected
    `_remuxExecutionTimeoutMs` field and starts another response timer. A new
    extension RPC therefore requires policy knowledge in both TypeScript and
    Rust.
14. `requestIpc` requires the policy object at each call boundary. This makes
    ordinary extension requests verbose and makes external-extension adoption
    depend on editing a central Remux method registry.

## Design principles

### Core before extensions

Remux core is the only privileged application resource class. It includes the
guardian and Remux worker, not bundled extensions. Codex does not receive a
higher extension weight because its source lives inside the Remux repository.

### Equal extension parents

Every discovered extension receives the same parent `CPUWeight`. Source path,
manifest root, build system, and first-party versus external-repository status
do not affect its parent share.

### Hierarchical subdivision

Optional child scopes divide the owning extension's share:

```text
extensions
├── codex       weight 100
│   ├── server       weight 100
│   ├── app-server   weight 80
│   ├── narration    weight 20
│   └── research     weight 5
│
└── ledger      weight 100
    └── server       uses Ledger's whole current share
```

Codex still competes with Ledger as `100` versus `100`. Its four children do
not become four top-level competitors.

### Automatic baseline, optional adoption

Manifest-v1 extensions are contained automatically and need no code changes.
The optional workload API exists only for an extension that has a measured
reason to separate control, interactive runtime, background work, or persistent
runtime.

### Trusted but mistake-resistant

Extensions are trusted. The host still infers the caller's owning extension and
refuses core or cross-extension placement because that prevents accidental
misconfiguration and makes the API easier to reason about. It is not intended
as a strong same-UID security boundary.

### Measure before splitting

The first pass protects Remux from every extension. An extension is split only
when measurements show that it cannot keep its own control surface responsive
inside its fair parent slice. Ledger is explicitly deferred under this rule.

## Systemd and cgroup model

Systemd does not discover extension manifests or understand Cargo, Vite,
Codex, or Ledger. Responsibilities are separate:

```text
remux-extension.json   describes commands and views
          │
          ▼
Remux                   discovers, builds, launches, and interprets exit state
          │
          ▼
systemd                 creates slices/scopes and tracks process membership
          │
          ▼
Linux cgroup v2         schedules and accounts CPU, memory, PIDs, and pressure
```

### Static installed topology

Only the host-level units are installed:

```text
remux.slice
├── remux-core.slice
│   ├── remux.service
│   └── remux-core-worker-<generation>.scope
│
└── remux-extensions.slice
```

`remux install` installs or updates:

- `remux.slice`;
- `remux-core.slice`;
- `remux-extensions.slice`;
- `remux.service` with `Slice=remux-core.slice`;
- the global Codex workload skill described later.

No per-extension systemd unit is installed.

### Dynamic extension topology

As Remux discovers each extension, it creates transient units through the
systemd user manager:

```text
remux-extensions.slice
├── remux-extensions-codex.slice
├── remux-extensions-ledger.slice
├── remux-extensions-terminal.slice
└── remux-extensions-<escaped-id>-<hash>.slice
```

The ID is validated and escaped for readability. A short hash of the canonical
extension root prevents collisions between invalidly duplicated IDs during
diagnostics. Duplicate active extension IDs remain a discovery error; the hash
does not make duplicates valid.

Every extension slice has the same parent weight. Transient scopes inside it
are created for:

- Extension Server;
- server build;
- each Viewer build;
- each Viewer Watch process;
- declared or ad-hoc workload operations;
- declared persistent workloads.

Systemd units are collected after they become empty. Remux continues to own
build success, restart policy, logs, status, and UI semantics.

### Initial weights and affinity

Weights compare only among siblings.

| Domain | CPUWeight | nice | CPUs |
| --- | ---: | ---: | --- |
| `remux-core.slice` | 1000 | 0 | all |
| guardian service | 1000 | 0 | all |
| core worker | 500 | 0 | all |
| `remux-extensions.slice` | 400 | 0 | excludes reserved pair |
| each extension parent | 100 | 0 | inherited |
| default/all-in-one server | 100 | 0 | inherited |
| interactive workload | 100 | 0 | inherited |
| persistent runtime | 80 | 0 | inherited |
| background workload | 20 | 10 | inherited |
| build | 20 | 10 | inherited |
| watch | 10 | 10 | inherited |
| research | 5 | 15 | inherited |

The values are initial production constants, not manifest settings. Because
weights are work-conserving, one busy extension can use all non-reserved CPU
when Remux and other extensions are idle.

On the current host the reserved physical core pair is logical CPUs `0,8`.
`remux-extensions.slice` is restricted to `1-7,9-15`; core may use all CPUs.
The actual pair is discovered from Linux CPU topology at install/startup and
recorded in status.

Prefer cgroup `AllowedCPUs` when available. If the user systemd manager cannot
delegate `cpuset`, the launcher applies `sched_setaffinity` before the extension
or workload program executes.

### Ordinary and persistent lifetimes

Ordinary scopes are bound to `remux.service` and the current worker generation.
They include servers, builds, watches, Terminal sessions, and operation
workloads. Guardian cleanup stops them and waits for cgroup `populated 0`
before L1 respawn.

A persistent workload is a named scope under its extension parent without
`BindsTo=remux.service`. It survives adapter, worker, and service restarts and
is stopped only by its own explicit lifecycle. Codex App Server is the first
consumer. Persistent workloads are declared in the manifest so accidental
one-off commands cannot silently outlive Remux.

### Capability state

The guardian publishes:

```ts
type ResourceCapabilities = {
  cgroupVersion: 2 | null;
  systemdUserManager: boolean;
  cpuWeight: boolean;
  memoryAccounting: boolean;
  pidAccounting: boolean;
  pressure: boolean;
  freeze: boolean;
  processAffinity: boolean;
  protectedMode: boolean;
  reasons: string[];
};
```

Protected mode requires cgroup v2, systemd user scopes, CPU weights, freezer,
and affinity. Remux remains usable in degraded mode but Settings and
`remux doctor` must state which guarantee is missing. A nice-only fallback must
not claim protected mode.

## L0.5 guardian

The current std-only L1 supervisor becomes a small guardian process. It remains
the `remux.service` main process and stays independent of the Remux Tokio
worker.

It owns only:

- worker generation start/stop/backoff;
- systemd slice/scope creation and reconciliation;
- resource and pressure sampling;
- workload admission and pause/stop;
- a local control socket for the worker and workload wrapper;
- a minimal authenticated emergency HTTP endpoint;
- protection state and journal events.

It does not own WebSocket routing, transcripts, files, extension protocols,
build interpretation, or viewer state.

### Worker lifecycle

1. Guardian creates `remux-core-worker-<generation>.scope`.
2. Guardian starts the existing Remux worker in that scope.
3. Worker sends a heartbeat every 250 ms from a dedicated OS thread.
4. On worker exit, guardian stops all ordinary scopes for that generation.
5. Guardian waits until those scopes are empty.
6. Persistent extension workloads are excluded.
7. Existing L1 backoff chooses the next worker start time.

The current in-worker 30-second watchdog remains a final independent hang
backstop. L0.5 does not merely lower its timeout.

### Protection behavior

Guardian watches:

- worker heartbeat age;
- local core health latency;
- core RPC p95/p99 supplied by the worker;
- CPU and memory PSI;
- connection-generation churn;
- per-extension CPU and memory usage.

High CPU usage by itself is healthy. Protection begins only when load and core
delay occur together.

```text
HEALTHY
  │ sustained core delay under pressure
  ▼
PROTECTING
  ├── freeze research workloads
  ├── freeze background workloads
  ├── freeze builds not awaited by the phone
  └── retain core and extension servers
  │
  ├── recovered ─► gradual thaw ─► HEALTHY
  │
  └── still stale ─► freeze highest-CPU extension if necessary
                      expose phone recovery
                      restart worker only as final escalation
```

An all-in-one manifest-v1 Extension Server cannot preserve an internal control
thread while frozen. Normally its parent weight and reserved core are enough.
If it is the remaining source of severe pressure, guardian may freeze the whole
extension; phone control remains available through guardian even though that
extension cannot answer until resumed.

### Emergency phone endpoint

Guardian listens on `guardian_port`, default `48124`, on the same configured
host interface as Remux.

```text
GET  /healthz
GET  /control/v1/status
GET  /control/v1/extensions
POST /control/v1/protection/engage
POST /control/v1/protection/release
POST /control/v1/extensions/:id/pause
POST /control/v1/extensions/:id/resume
POST /control/v1/extensions/:id/stop
POST /control/v1/extensions/:id/restart
POST /control/v1/worker/restart
```

Only `/healthz` is unauthenticated and it returns no details. Other routes use
the existing Remux bearer token. Mutations require an operation ID and are
idempotent.

When the normal socket repeatedly fails but guardian responds, the phone shows
a native recovery surface with extension usage, Pause, Resume, Stop, Extension
Restart, and Remux Worker Restart. It does not depend on a WebView or extension
route.

## Automatic extension placement

### Current manifest-v1 extension

The existing schema remains valid:

```json
{
  "version": 1,
  "id": "example",
  "name": "Example",
  "display": {
    "title": "Example",
    "icon": "assets/icon.png"
  },
  "server": {
    "transport": "stdio",
    "build": {
      "command": "cargo",
      "args": ["build", "--release"],
      "cwd": "."
    },
    "command": "target/release/example-remux",
    "args": [],
    "cwd": "."
  },
  "views": {
    "main": {
      "route": "/viewers/example",
      "entry": "viewer/dist/index.html",
      "build": {
        "command": "npm",
        "args": ["run", "build"],
        "cwd": "viewer"
      },
      "watch": {
        "command": "npm",
        "args": ["run", "watch"],
        "cwd": "viewer"
      }
    }
  },
  "launchers": [],
  "fileHandlers": []
}
```

Remux reads the manifest. Systemd never does.

Build flow:

1. Remux decides a build is required or receives a Build action.
2. Remux creates a build scope under that extension's slice.
3. Remux starts the declared command inside it.
4. systemd/cgroup tracks and schedules the process tree.
5. Remux reads stdout/stderr and exit status.
6. Remux applies existing build success/failure semantics.
7. Remux launches or preserves the server according to the existing operation.

Watch and runtime launch follow the same division of responsibility.

### Discovery from outside the repository

The existing configured extension roots remain authoritative. Discovery may
return paths under Remux, `../ledger`, or another absolute root. Resource policy
uses only the validated extension identity and canonical root; it never checks
whether the path is inside the Remux repository.

Every discovered extension gets:

- an equal parent slice;
- server scope;
- build/watch child scopes;
- cgroup accounting;
- Settings resource status;
- guardian pause/stop/restart controls;
- inherited containment for unclassified descendants.

No extension-specific systemd file or host configuration is required.

## Optional manifest-v2 workloads

An extension adopts manifest version 2 only when it wants named internal
workloads.

```json
{
  "version": 2,
  "id": "ledger",
  "resources": {
    "workloads": {
      "runtime": {
        "class": "interactive",
        "lifetime": "extension",
        "threads": "auto"
      },
      "catch-up": {
        "class": "background",
        "lifetime": "operation",
        "threads": "auto"
      }
    }
  }
}
```

Codex declares:

```json
{
  "version": 2,
  "id": "codex",
  "resources": {
    "workloads": {
      "app-server": {
        "class": "interactive",
        "lifetime": "persistent",
        "threads": "auto"
      },
      "narration": {
        "class": "background",
        "lifetime": "operation",
        "threads": 7
      },
      "research": {
        "class": "research",
        "lifetime": "operation",
        "threads": "auto"
      }
    }
  }
}
```

Schema:

```ts
type ExtensionResources = {
  workloads: Record<string, {
    class: 'interactive' | 'background' | 'research';
    lifetime?: 'operation' | 'extension' | 'persistent';
    threads?: 'auto' | number;
  }>;
};
```

Defaults:

- lifetime: `operation`;
- threads: `auto`;
- workload names: lowercase `[a-z0-9][a-z0-9-]{0,47}`;
- number of declared workloads: at most 32;
- numeric threads: 1–number of logical CPUs, bounded by guardian capacity.

Lifetime semantics are fixed:

- `operation`: one scope per operation ID; it is collected when the command and
  descendants exit, and cancel stops only that operation;
- `extension`: one stable named scope per Extension Server generation; repeated
  launches attach to it, Extension Server stop/restart stops it, and a worker
  generation sweep reaps it;
- `persistent`: one stable named scope independent of Extension Server and
  Remux worker generations; repeated lifecycle commands attach to the existing
  scope, and only explicit workload stop or host reboot ends it.

For a persistent restart, the lifecycle command is attached to the existing
scope before execution. It keeps the scope populated while the old runtime
exits and its replacement is spawned, ensuring the replacement inherits the
same extension parent and workload policy.

Manifest declarations express intent. Extensions cannot set CPU weights,
systemd unit names, CPU sets, nice values, core membership, or arbitrary memory
protection.

`persistent` means the scope may outlive Remux. The extension still owns the
actual lifecycle command and must expose appropriate status/stop/restart
semantics. Persistent scopes appear prominently in Settings and `remux doctor`.

## Trusted workload API

The generic API is intentionally small. It does not attempt to be a workflow
engine, job database, distributed scheduler, or security sandbox.

### Language-neutral command

```text
remux workload exec \
  --workload runtime \
  --operation session:abc \
  --threads 6 \
  -- <program> <args...>
```

For ad-hoc Codex research, the declared workload name is `research`:

```text
remux workload exec \
  --workload research \
  --operation codex-rd:kokoro-onnx \
  --threads 7 \
  -- python benchmark.py
```

### Rust API

Provide a small `remux-compute` crate for finite, typed work:

```rust
use remux_compute::{Registry, TaskOptions};

let compute = Registry::new().register::<RebuildIndex>()?;
if compute.dispatch_worker_if_requested()? {
    return Ok(());
}
let task = compute.spawn::<RebuildIndex>(
    TaskOptions::new("rebuild-index", format!("index:{revision}")),
    input,
)?;
```

Task definitions, input, progress, and output types live in Rust rather than
the extension manifest. The registry re-executes the current extension binary
through `remux workload exec`, uses a bounded private protocol, and owns
kill-on-drop and child-wait behavior. It is intentionally synchronous and
finite: no generic process handles, daemon API, or persistent job database.

Node or other extensions can call the language-neutral command directly. A
small `@remux/extension-host` wrapper may be added when a Node extension needs
it; it is not required for the first Rust consumers.

### Placement flow

1. The wrapper starts inside the owning extension scope.
2. It connects to the guardian's local Unix socket.
3. Guardian identifies the owner from the caller's current cgroup and finds the
   named workload declaration.
4. Guardian creates or reuses the correct transient scope under that extension.
5. Wrapper is attached before the real program executes.
6. Wrapper applies granted affinity, nice level, and thread environment.
7. Wrapper calls `execve`; descendants inherit the scope.

The extensions are trusted, so authorization remains pragmatic:

- caller UID must be the Remux service user;
- caller must already belong to a discovered extension or Codex runtime scope;
- named workload must belong to that extension;
- no caller may request core or another extension;
- malformed/stale requests fail before exec.

This protects against bugs and ambiguous ownership, not a malicious same-user
extension.

### Thread normalization

The granted thread count is exposed through:

```text
REMUX_WORKLOAD_THREADS=N
OMP_NUM_THREADS=N
OPENBLAS_NUM_THREADS=N
MKL_NUM_THREADS=N
NUMEXPR_NUM_THREADS=N
RAYON_NUM_THREADS=N
ORT_NUM_THREADS=N
```

Provider-specific code should still configure its own runtime explicitly.

### Failure behavior

- Guardian unavailable: fail before executing the real workload.
- Unknown workload: name the extension and valid declarations.
- Protected mode unavailable: fail for background/research unless a human
  explicitly opts into degraded execution.
- Scope placement failure: do not exec.
- Real command failure: preserve conventional 126/127 and child exit semantics.
- Guardian protection freeze: process remains alive and resumes later; status
  records frozen duration.

There is no durable generic job queue in v1. Extension code owns operation
state and retry semantics exactly as it does today.

## Extension developer experience

### Baseline extension

An author creates the same manifest as today. Remux automatically supplies:

- equal extension placement;
- resource accounting;
- build/watch isolation;
- guardian controls;
- environment describing protection state.

Environment:

```text
REMUX_EXTENSION_ID=<id>
REMUX_EXTENSION_ROOT=<canonical-root>
REMUX_RESOURCE_PROTECTED=1|0
REMUX_RESOURCE_SOCKET=<guardian-socket>
REMUX_WORKLOAD_EXEC=<stable-remux-launcher-path>
```

The launcher path must remain spawnable across an atomic release-binary
replacement. Installed services use `%h/.local/bin/remux`; ad-hoc runs retain
their live launch pathname. Never derive a newly supervised extension's value
from a `current_exe()` identity ending in ` (deleted)`.

No knowledge of systemd is required.

### Extension with a heavy child

1. Upgrade manifest to version 2.
2. Declare a semantic workload name and generic class.
3. Launch that child with `WorkloadCommand` or the CLI wrapper.
4. Keep application progress/cancel state in the extension.
5. Resource status and pause/stop appear automatically.

### Tooling

Add:

```text
remux extension validate <path>
remux workload capacity
remux workload status [--extension <id>]
remux workload exec ...
remux doctor
```

`extension validate` checks manifest schema, workload names, lifetime rules,
commands, cwd paths, and duplicate IDs. It does not require running systemd.

Settings labels:

- `Contained`: version 1 or no named children;
- `Workload aware`: at least one named child scope;
- `Persistent runtime`: at least one active persistent scope;
- `Unprotected`: required host capability missing.

## Codex onboarding

Codex is the first extension to use all workload lifetimes.

```text
Codex parent slice                    equal with Ledger and other extensions
├── Extension Server                 ordinary server scope
├── App Server daemon                persistent interactive workload
├── Kokoro narration                 background operation workload
└── deliberate R&D                   research operation workload
```

### Preserve the daemon architecture

The existing behavior from commit `e85e562` remains:

- the extension connects through the App Server Unix control socket;
- `codex app-server daemon start|stop|restart|version` owns daemon lifecycle;
- Extension Server restart never stops the daemon;
- primary and narration clients connect to the same daemon;
- reconnect reconciles durable thread state;
- Codex update is install-only and a later explicit restart applies it.

The manifest declares `app-server` as a persistent interactive workload. Every
daemon lifecycle command runs through `WorkloadCommand("app-server", ...)`.
The stable scope therefore remains the parent of the replacement daemon after
`daemon restart`.

An already-running daemon outside the expected scope is
`running-unmanaged`. Do not scrape `ps` or depend on Codex's private PID file.
Settings offers an idle-aware `Restart to enable resource protection`. The
replacement starts in the declared persistent scope.

### Narration

Replace the direct Kokoro Python spawn with:

```rust
WorkloadCommand::new("narration", python)
    .operation(format!("narration:{artifact_key}"))
    .threads(granted_threads)
    .arg(worker)
    .spawn()?;
```

Artifact generation, cancellation, caching, and publication semantics remain
owned by the Codex extension. Guardian may freeze narration during core
pressure; frozen duration is not counted as provider compute time.

### Codex shell and global skill

A repository `AGENTS.md` applies to that repository/subtree. It is not the
right way to make a Remux host capability available across arbitrary projects.

Install one global skill:

```text
$HOME/.agents/skills/remux-workloads/SKILL.md
```

The skill triggers for CPU-intensive inference, benchmarks, data generation,
parallel research, or long-running local computation. It teaches Codex to:

- inspect `remux workload capacity`;
- use Codex's declared `research` workload;
- select a bounded thread count;
- name operations;
- avoid contaminating benchmarks with parallel jobs;
- inspect, pause, or cancel work;
- distinguish wall time from frozen/compute time.

The Codex App Server environment includes the Remux resource variables, so the
skill works in any repository opened through this Remux Codex extension.

The skill improves classification but is not required for safety. A normal
Codex shell command that ignores it remains inside the Codex parent/runtime
scope and cannot outrank Remux core or another extension parent.

Skill installation is checksum-aware:

- install when absent;
- update an unchanged Remux-managed copy;
- preserve and warn about a user-modified copy;
- report divergence in `remux doctor` without disabling cgroup protection.

Do not inject resource instructions through every repository's `AGENTS.md`.
Do not replace base model instructions with `model_instructions_file`. Do not
depend on `PreToolUse`, whose unified shell interception is incomplete. Do not
introduce an unrestricted dynamic command tool that might execute outside the
normal Codex sandbox. Official Codex guidance positions `AGENTS.md` as durable
project guidance and skills as reusable progressively disclosed workflows:
[Codex customization](https://learn.chatgpt.com/docs/customization/overview).

## Ledger onboarding and later subdivision

Ledger initially remains an unchanged all-in-one extension process:

```text
Ledger parent slice
└── ledger-remux
    ├── Remux RPC
    ├── sessions
    ├── projection runtime
    └── cache/snapshot reads
```

That is sufficient to protect Remux and make Ledger fair with Codex. No new
snapshot transport, shared memory, or IPC is part of the first implementation.

### Snapshot terminology

A Ledger snapshot means a coherent read of values belonging to one revision,
for example bars, live bar, status, and cursor observed together. It does not
imply a new copy, file format, process boundary, or shared-memory mechanism.

The cgroup implementation does not alter Ledger snapshot semantics.

### When Ledger should subdivide

Measure Ledger under its fair parent slice. Subdivide only if heavy projection
work makes Ledger's own status, cancel, subscription, or viewer delivery
unacceptably slow.

At that time Ledger may declare:

```json
{
  "resources": {
    "workloads": {
      "runtime": {
        "class": "interactive",
        "lifetime": "extension"
      },
      "catch-up": {
        "class": "background",
        "lifetime": "operation"
      }
    }
  }
}
```

Ledger may later move projection execution to a child process after its actual
lifecycle and communication needs are measured. The first compute API does not
add a generic long-running process abstraction merely for that possible use.

The extension owns the adapter/runtime protocol. Start with the simplest
ordinary Unix socket or pipe protocol that satisfies measured needs. Do not
introduce `memfd`, shared-memory snapshots, or a generic Remux runtime protocol
without benchmark evidence.

If keeping the runtime in-process is materially better, Ledger may instead use
a dedicated OS thread pool and a future threaded-cgroup helper. That is not part
of v1 because process workloads cover current Codex needs and are simpler to
supervise.

## Terminal and other extensions

Terminal initially receives one equal extension parent. Its adapter and shell
sessions remain within that share. A later manifest-v2 adoption may declare
long-lived sessions as interactive extension-lifetime workloads, but it is not
required for core protection.

Every other manifest-v1 extension receives automatic containment. A direct
child or daemonized grandchild inherits the extension parent scope even if it
creates a new Unix process group or session. Cgroup membership becomes the
resource accounting authority; process groups remain only for existing signal
semantics during migration.

## Resource accounting and app model

Replace public process-group aggregation with cgroup/systemd scope accounting:

```ts
type ExtensionResourceSnapshot = {
  extensionId: string;
  root: string;
  protection: 'protected' | 'degraded';
  mode: 'contained' | 'workload-aware';
  cpuPercent: number;
  cpuUsageUsec: number;
  memoryCurrentBytes: number;
  memoryPeakBytes: number;
  processCount: number;
  cpuPressure: PressureSnapshot;
  memoryPressure: PressureSnapshot;
  workloads: WorkloadSnapshot[];
};

type WorkloadSnapshot = {
  name: string;
  operationId: string | null;
  class: 'server' | 'interactive' | 'background' | 'research' | 'build' | 'watch';
  lifetime: 'operation' | 'extension' | 'persistent';
  state: 'starting' | 'running' | 'frozen' | 'stopping' | 'exited' | 'failed';
  threads: number | null;
  cpuPercent: number;
  memoryCurrentBytes: number;
  processCount: number;
  startedAtMs: number;
  frozenDurationMs: number;
  lastError: string | null;
};
```

Existing resource RPCs may be extended or a versioned resource-governance read
may be added. The public contract is revisioned and the app coalesces updates to
at most 2 Hz.

### Settings

System section:

```text
Resource protection                         Protected
Core latency                                42 ms p99
Reserved CPU                                core 0 · CPUs 0,8

Codex                                       632% CPU
Ledger                                       94% CPU
Terminal                                      2% CPU

[ Pause background work ]
```

Extension detail:

```text
LEDGER
Contained · Equal extension share
Server                       Running · 94% CPU · 1.2 GB

CODEX
Workload aware · Equal extension share
Server                       Running
App Server                   Persistent · Protected
Narration                    Background · 612% CPU · Pause | Cancel
```

The UI never describes a bundled extension as higher priority than an external
one.

## RPC contract and connection lifecycle migration

Resource protection makes scheduling predictable, but arbitrary response
deadlines would still turn expected contention into false failures. The current
five-part budgets are mostly duplicated configuration: the client collapses
three phases into one timer, the CLI owns a second method-to-budget table, and
the Extension Supervisor starts a third timer. This implementation removes that
contract rather than tuning its numbers.

### Public semantic API

Viewer and extension code use a small API whose options describe correctness,
not guessed duration:

```ts
rpc.query<T>(method, params, { signal, resourceKey? })
rpc.command<T>(method, params, { signal, operationId? })
rpc.startJob<T>(method, params, { signal, operationId })
rpc.subscribe<T>(method, params, { signal, resourceKey? }, onEvent)
```

The internal transport additionally exposes `connection.ping({ signal })` for
system liveness. An equivalent IPC wrapper carries the same semantics through
the native app bridge and `ExtensionWebView`.

The operation contract is:

| Kind | Intended use | Retry/reconciliation rule |
| --- | --- | --- |
| `query` | Read-only snapshot or resource fetch | May coalesce by resource key and retry after a generation change |
| `command` | Bounded mutation | Retry only with an operation ID or explicit state-revision precondition; otherwise report outcome unknown after disconnect |
| `job-start` | Admission of durable or observable long work | Operation ID makes admission idempotent; subsequent progress is a resource, not an open RPC |
| `subscription` | Resource invalidation or progress stream | Resubscribe on a healthy new generation and refresh the canonical resource once |
| `liveness` | Transport-owned ping/handshake | Has a short transport deadline and may influence connection health |

The semantic kind travels in the request envelope; it is not inferred from a
method-name registry:

```ts
type RpcContract =
  | { kind: 'query'; resourceKey?: string }
  | { kind: 'command'; operationId?: string; preconditionRevision?: number }
  | { kind: 'job-start'; operationId: string }
  | { kind: 'subscription'; resourceKey?: string };
```

The app bridge uses `{type: 'remux/request', id, method, params, contract}` and
`{type: 'remux/cancel', id, reason}`. The WebSocket request carries the same
contract. When the request has reached an Extension Server, the CLI forwards a
best-effort JSON-RPC `$/cancelRequest` notification with the routed request ID.
Extension Servers may initially ignore that notification, but the CLI and
caller must still release their pending state and discard a late response.

Callers do not provide queue, execution, transfer, or total budgets. They also
do not choose transport lanes, downstream retry counts, or timeout-health
classification. Remux assigns lanes by semantic kind and reserves control
capacity internally. An external extension can add a query or command without
editing a central per-method timing table.

Routing chooses the lane after it knows the destination: liveness and guardian
control use reserved core capacity; core queries and commands use bounded core
lanes; extension queries, commands, and job admission use the owning
extension's bounded lanes. A command is serialized only where its subsystem or
resource contract requires ordering. The client cannot elevate an extension
request by naming a lane.

The current registry migrates deterministically:

| Current family | New contract |
| --- | --- |
| system ping and candidate handshake | internal `liveness` |
| system info/resources, extension status/logs, files, Codex reads, Terminal list/replay/context | `query`, with a resource key where coalescing is useful |
| registration, resource/log streams, Terminal attach/detach | `subscription` or a subscription lifecycle command |
| settings writes, message/queue actions, Terminal writes/resizes/kills, host actions | `command`; retain existing operation ID, input sequence, or revision semantics |
| extension start/stop/restart/watch/build, viewer build, Codex daemon lifecycle/update, narration generation | `job-start`, then operation resources |
| attachment picker and other native user interaction | caller-lifetime `command`; user dismissal or view teardown aborts it |

The two existing policies for `remux/terminal/tmux/action` become an explicit
`query` for refresh and `command` for mutations at the call site. This is the
only distinction the caller supplies; it supplies no timing or lane values.

External-extension DX is therefore local and does not require a Remux source
change or manifest policy block:

```ts
const snapshot = await rpc.query(
  'remux/ledger/projection/read',
  { projectionId },
  { signal, resourceKey: `projection:${projectionId}` },
);

await rpc.command(
  'remux/ledger/session/pause',
  { sessionId },
  { signal, operationId },
);
```

`requestIpc(policy, params)` becomes a transport-internal primitive; extension
viewers consume the semantic client. Notifications are a separate internal
event path and cannot be used as an unacknowledged substitute for commands. No
new per-method section is added to `remux-extension.json`.

During migration, the old registry may exist only as a private adapter for
tests and staged call-site conversion. Removing that adapter and every old
budget field is an exit gate for this implementation pass; permanent dual APIs
are not accepted.

### Cancellation and request lifetime

Ordinary requests have no default hard response timeout. They remain pending
until one of these concrete lifetime boundaries occurs:

- a response arrives;
- the caller's `AbortSignal` fires;
- the view, tab, or owning resource closes or is superseded;
- the actual WebSocket closes;
- the Extension Server exits, restarts, or changes generation; or
- the user cancels an observable job.

Cancellation propagates through viewer-kit IPC, the native app bridge, the
WebSocket client, the CLI router, and the Extension Supervisor. The CLI sends a
best-effort cancellation envelope to an extension that supports it, removes its
pending entry immediately, and ignores a late reply by request ID. Cancellation
does not imply rollback: a command that may already have committed reports
`outcome-unknown` and reconciles from authoritative state.

Every caller-owned component creates one controller for its lifetime. Resource
supersession aborts the previous read before starting its replacement. This
prevents abandoned screens and WebViews from accumulating work without forcing
extension authors to invent timeout values.

### Slow operations are telemetry, not failure

The transport records first-slow and periodic-still-pending events without
rejecting the request or replacing the connection. Initial diagnostic
thresholds are intentionally coarse:

| Operation | First slow event |
| --- | ---: |
| core control/query | 500 ms |
| ordinary query | 2 s |
| bounded command | 5 s |
| job without progress | 10 s |

These are SLO/UX thresholds, not public request options and not correctness
deadlines. Metrics distinguish queue age, extension execution age, and response
transfer only when the transport actually observes those boundaries. The app
may show a pending/slow row with a Cancel action; it must not show a false
connection failure.

### Structural bounds replace duration guesses

No timeout means unbounded waiting is forbidden. Admission is explicitly
bounded:

- keep the existing per-client WebSocket outstanding-request ceiling of 64;
- allow at most 64 pending routed requests per extension generation;
- bound each lane queue and reject new admission immediately with `busy` when
  full;
- allow one active coalesced query per canonical resource key; and
- cap cross-generation read retries globally at eight.

Rejected admission never enters an ambiguous state. Pending entries are removed
on response, cancellation, connection close, or extension generation change,
and are asserted empty during teardown tests.

### Long operations become jobs

Work that is naturally measured in tens of seconds or minutes does not hold a
request open. The first migration covers:

- Extension Server start, stop, restart, watch, and build operations;
- viewer builds;
- Codex App Server start, stop, restart, and update/apply operations;
- narration generation, retaining its existing operation model; and
- future Ledger rebuild or projection-recovery work when introduced.

Job admission returns promptly:

```ts
type JobAdmission = {
  operationId: string;
  accepted: boolean;
  revision: number;
};
```

Progress, terminal state, logs, and cancellation are addressed by operation ID
through resources/subscriptions and commands. A reconnect reads authoritative
job state instead of retrying a ten-minute RPC. A slow admission remains
cancellable and observable; it does not introduce a new acknowledgement
deadline.

### Deadlines retained at real protocol boundaries

Hard deadlines remain where lack of an acknowledgement prevents the protocol or
process lifecycle from advancing:

- WebSocket connect;
- `system-ping` and candidate-connection handshake;
- guardian HTTP health/control;
- Extension Server and Codex App Server initialization handshakes;
- daemon lifecycle/status OS commands;
- EOF, SIGTERM, and SIGKILL escalation; and
- external network calls whose owning subsystem defines the remote-service
  deadline.

These deadlines are transport- or subsystem-owned constants. They are not
inherited by ordinary RPCs and a subsystem timeout cannot by itself label the
active WebSocket unhealthy.

### Health and promotion

- Actual socket close, failed handshake, and failed `system-ping` are
  transport-health signals.
- A slow or canceled registration, status, resources, files, logs, or extension
  route request never directly declares the connection dead.
- Suspect transport behavior starts one single-flight ping on the active
  generation.
- Ping success keeps the socket and degrades only the affected route.
- Ping failure permits one make-before-break candidate.
- At most one candidate exists.
- More than two promotions in 30 seconds opens a 30-second breaker.
- A ping-healthy active connection is retained while the breaker is open.
- Guardian health is included in diagnostics but does not itself replace the
  WebSocket.

### Old-generation drain and retry coalescing

- New requests move to the promoted client.
- The previous client accepts no new requests and drains existing ones.
- It closes when pending count reaches zero or after a 30-second transport drain
  ceiling. This is connection cleanup, not an operation response deadline.
- A command still pending at the ceiling follows its semantic outcome-unknown
  reconciliation rule.
- The fixed 250 ms `Superseded by healthy connection` close is removed.
- Read retries are keyed by method and canonical resource key.
- A generation change creates at most one refresh per key.
- Global retry concurrency is eight with jitter.
- WebViews receive invalidations rather than independently reloading every
  resource.
- `RemuxConnectionProvider` owns registration. The notification provider
  publishes desired registration state and does not independently repeat it on
  every transient status change.

### Removed policy surface

The completed migration deletes:

- the five-part `connectWaitMs`, `queueMs`, `executionMs`, `transferMs`, and
  `totalMs` request budget;
- caller-authored `timeoutHealth`, `lane`, and `downstreamRetry` choices;
- the public `resolveRpcPolicy`/registered-request-method dependency and
  per-method policy-name plumbing;
- the CLI `extension_execution_budget_ms` method table;
- `_remuxExecutionTimeoutMs` injection into extension parameters; and
- the Extension Supervisor's default response-deadline timer.

Semantic idempotency, completion, outcome-unknown, and resource-coalescing data
remain where correctness requires them. They are properties of the operation
kind or implementation, not disguised timing configuration.

## Observability

Journal events include:

```text
guardian:capabilities
guardian:worker-started
guardian:worker-stale
guardian:protection-engaged
guardian:protection-released
resource:extension-created
resource:scope-created
resource:scope-attached
resource:scope-frozen
resource:scope-thawed
resource:scope-stopped
resource:persistent-reconciled
connection:health-probe
connection:breaker-opened
connection:generation-drained
rpc:slow
rpc:canceled
rpc:admission-rejected
job:admitted
job:progress
job:completed
```

Metrics:

- guardian/core heartbeat age;
- local health and control RPC histograms;
- connection promotions and pending requests by generation;
- pending requests by semantic kind and extension generation;
- pending age, slow-event count, caller cancellations, and ignored late replies;
- admission rejections and leaked-pending teardown assertions;
- active jobs, progress age, cancellation, and terminal outcome;
- retries coalesced versus issued;
- per-extension and per-workload CPU/memory/PSI;
- frozen duration;
- scope creation/attach/stop latency;
- stale or unmanaged persistent scopes.

Do not log environment values, auth tokens, secret-bearing argv, transcript
data, or file contents.

## Implementation plan

### Phase 1 — dynamic equal extension isolation

Files:

- `deploy/systemd/remux.service`
- new top-level slice units
- new `crates/remux/src/resource/systemd.rs`
- new `crates/remux/src/resource/topology.rs`
- `crates/remux/src/cli/systemd.rs`
- `crates/remux/src/cli/doctor.rs`
- `crates/remux/src/extensions/supervisor.rs`
- `crates/remux/src/extensions/process.rs`
- `crates/remux/src/monitor.rs`

Work:

1. Install core/extensions slices.
2. Add systemd D-Bus operations for transient slices/scopes.
3. Detect reserved physical core pair.
4. Create equal per-extension slices from discovery.
5. Place current servers, builds, and watchers automatically.
6. Read cgroup resource statistics.
7. Keep process-group accounting as a diagnostic comparison only.

Exit gate: Codex, Ledger, Terminal, and a fixture external extension appear as
equal extension parents; full CPU load does not block local Remux ping.

### Phase 2 — L0.5 guardian and phone control

Files:

- `crates/remux/src/supervise.rs`
- new `crates/remux/src/guardian.rs`
- `crates/remux/src/runtime.rs`
- guardian HTTP client/server
- app System settings and native emergency UI

Work:

1. Start worker in a core generation scope.
2. Add heartbeat and pressure monitoring.
3. Add automatic protection/freeze/thaw.
4. Add authenticated emergency endpoint.
5. Add phone fallback and controls.
6. Preserve L1 backoff and existing watchdog.

Exit gate: under full extension saturation, phone guardian control remains
usable and can pause/stop the offending extension without SSH.

### Phase 3 — RPC contract and connection lifecycle migration

Files:

- `packages/viewer-kit/src/rpc.ts`
- `packages/viewer-kit/src/ipc.ts`
- `packages/viewer-kit/src/host.ts`
- `app/src/remote/RemuxConnectionProvider.tsx`
- `app/src/remote/remuxRpcClient.ts`
- `app/src/surfaces/viewer/ExtensionWebView.tsx`
- `app/src/notifications/RemuxNotificationProvider.tsx`
- `crates/remux/src/rpc/ws.rs`
- `crates/remux/src/extensions/supervisor.rs`
- settings, files, build, update, and extension viewer RPC call sites
- resource stores

Work:

1. Add semantic query, command, job-start, subscription, and liveness helpers.
2. Propagate `AbortSignal` through IPC, the app bridge, WebSocket routing, and
   extension supervision; cancel pending entries and ignore late responses.
3. Assign lanes internally, bound per-extension pending work, and coalesce
   resource reads.
4. Replace ordinary response deadlines with slow-operation telemetry.
5. Convert Extension Server lifecycle/watch/build, viewer builds, Codex App
   Server lifecycle/update/apply, and narration admission to observable jobs.
6. Migrate every built-in and external-extension-facing caller to the semantic
   API.
7. Delete the old budget registry adapter, CLI execution-budget map, injected
   deadline parameter, and Extension Supervisor response timer.
8. Add single-flight liveness probe, promotion breaker, and old-generation
   drain.
9. Centralize registration ownership and cap/coalesce retries.

Exit gate: production code has no references to the five budget fields,
`timeoutHealth`, `_remuxExecutionTimeoutMs`, or
`extension_execution_budget_ms`; injected delays remain visible and cancellable
without replacing a ping-healthy connection; every migrated long operation is
a job, not an open request.

### Phase 4 — generic workload API

Files:

- `crates/remux/src/extensions/manifest.rs`
- `crates/remux/src/cli/workload.rs`
- `crates/remux/src/resource/systemd.rs`
- CLI `remux workload *`
- new `crates/remux-compute` Rust workspace crate
- Settings workload rows

Work:

1. Add manifest-v2 optional resource schema.
2. Add attach-and-exec wrapper.
3. Add the typed Rust task registry and same-binary worker dispatch.
4. Add thread environment and affinity.
5. Add operation/extension/persistent lifetimes.
6. Add workload status/pause/resume/stop.

Exit gate: a fixture extension launches interactive, background, and persistent
children; all remain within its parent allocation and lifecycle behaves as
declared.

### Phase 5 — Codex adoption

Files:

- `extensions/codex/remux-extension.json`
- `extensions/codex/server/src/app_server.rs`
- `extensions/codex/server/src/narration.rs`
- `deploy/codex/skills/remux-workloads/`
- install/doctor integration

Work:

1. Declare App Server, narration, and research workloads.
2. Run every daemon lifecycle command in its persistent scope.
3. Detect and migrate `running-unmanaged` through idle-aware restart.
4. Move Kokoro to background workload.
5. Install the global skill.
6. Add Codex workload rows to Settings.

Exit gate: Extension Server, worker, and service restarts preserve the daemon;
daemon restart keeps its replacement in the same persistent scope; narration
cannot starve Remux.

### Phase 6 — optional extension adoption and cleanup

1. Measure Ledger under the equal parent hierarchy.
2. Split Ledger runtime only if its own control latency requires it.
3. Let Terminal adopt session workloads only if useful.
4. Add Node helper only when a Node extension needs named workloads.
5. Remove public process-group resource aggregation after cgroup telemetry
   matches through soak testing.

This phase has no requirement to split Ledger. A measured no-change decision is
a valid result.

## Test matrix

### Unit tests

- extension ID escaping and duplicate-root diagnostics;
- equal parent weights independent of source path;
- hierarchical child weights do not change parent share;
- manifest-v1 default containment;
- manifest-v2 workload parsing/defaults;
- caller extension inference and workload lookup;
- lifetime cleanup and persistent exclusion;
- SMT reserved-core selection;
- protection hysteresis;
- semantic RPC kind defaults and server-owned lane assignment;
- caller cancellation removes pending state and ignores late responses;
- resource supersession aborts and coalesces the previous query;
- pending admission rejects immediately at the configured bound;
- slow thresholds emit diagnostics without rejecting the request;
- command disconnect produces the declared reconciliation outcome;
- idempotent job admission returns the same operation ID;
- connection health classification and generation drain;
- retry coalescing.

### Linux integration tests

- dynamic extension slice creation/collection;
- extension outside Remux root receives equal placement;
- build/watch/server enter child scopes;
- fork/setsid descendants remain accounted;
- freeze/thaw/stop and populated-zero completion;
- affinity inheritance by Python/ONNX threads;
- guardian and worker scope separation;
- persistent workload survives worker/service restart;
- workload wrapper preserves stdin/stdout/stderr and exit status;
- an extension that never replies remains slow/pending until caller cancellation,
  then leaves no supervisor pending entry;
- a view teardown cancels IPC, WebSocket, and Extension Supervisor state;
- a build job continues across view teardown and is recovered by operation ID;
- external fixture queries and commands require no central timing-policy edit.

### Saturation and chaos

- saturate all extension CPUs with one extension;
- saturate Codex and Ledger together and verify equal parent usage;
- run Kokoro, Ledger, Cargo, and Vite together;
- kill worker while ordinary and persistent scopes run;
- kill guardian and allow systemd restart;
- delay control RPCs while ping remains healthy;
- delay an ordinary extension RPC beyond every soft threshold and verify that it
  remains cancellable without connection promotion;
- cancel while an extension races a late response;
- disconnect during a mutation and reconcile authoritative state;
- reconnect while builds, Codex update, and narration jobs remain active;
- close a draining connection with reads and mutations pending;
- freeze and resume every workload class from the phone;
- daemonize an external-extension grandchild.

### Acceptance targets

| Metric | Required |
| --- | ---: |
| guardian health p99 | < 100 ms local, < 500 ms phone |
| Remux system ping p99 under extension saturation | < 250 ms local |
| core RPC p99 | < 500 ms |
| manual pause response | < 1 s |
| protection engagement after sustained breach | < 3 s |
| non-reserved CPU use while core idle | > 90% |
| parent CPU share for two saturated equal extensions | within 10% over 60 s |
| connection promotions while ping succeeds | 0 |
| read retries per resource key per generation | <= 1 |
| ordinary RPCs with a hard response deadline | 0 |
| leaked pending requests after caller teardown | 0 |
| migrated long operations represented as jobs | 100% |
| populated ordinary scopes after stop/restart | 0 |

## Rollout

1. Install static top-level slices and restart Remux once.
2. Verify protected mode with `remux doctor`.
3. Move all current extensions into equal dynamic parent slices.
4. Soak automatic containment before enabling guardian freezes.
5. Enable phone guardian control.
6. Land the semantic RPC/cancellation/job migration and remove the legacy
   timeout policy before intentional saturation.
7. Add generic workload API.
8. Migrate Codex daemon and narration.
9. Measure Ledger and decide whether internal separation is warranted.
10. Remove legacy accounting after comparison telemetry is clean.

Rollback stops ordinary transient scopes, restores the prior unit and binary,
and restarts Remux. A persistent Codex daemon remains explicitly owned and is
not killed as an incidental rollback side effect.

## Completion criteria

- Remux core remains responsive under full extension load.
- Guardian is independently reachable and usable from the phone.
- Every discovered extension receives equal parent weight regardless of source
  repository.
- Existing manifest-v1 extensions require no resource-specific edits.
- Builds and watchers stay under their owning extension parent.
- Named child workloads divide rather than multiply an extension's share.
- Codex daemon persistence from `e85e562` is preserved and correctly scoped.
- Kokoro and explicit Codex research use the generic workload mechanism.
- The global skill makes managed heavy compute available in any Codex repo.
- Ledger is protected without an up-front process/IPC redesign.
- Queries and commands do not require caller-authored timing budgets or central
  per-method deadline registration.
- Ordinary RPCs have no hard response timer; cancellation and structural bounds
  prevent leaked or unbounded pending work.
- Extension lifecycle/builds, Codex App Server lifecycle/update, narration
  admission, and future long compute use operation-ID jobs with observable
  state.
- A slow extension route cannot cause a supersession retry storm while system
  ping succeeds.
- Settings and emergency control provide recovery without SSH.
- No safety guarantee depends on an agent following `AGENTS.md` or a skill.

## Technical references

- [Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html): hierarchy, inherited membership, weights, freezer, accounting, and pressure files.
- [Linux PSI](https://docs.kernel.org/accounting/psi.html): CPU, memory, and I/O stall measurement.
- [systemd resource control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html): slices, scopes, weights, memory controls, and CPU sets.
- [systemd D-Bus API](https://www.freedesktop.org/wiki/Software/systemd/dbus/): transient units, process attachment, properties, and lifecycle operations.
- [Codex customization](https://learn.chatgpt.com/docs/customization/overview): repository guidance versus reusable skills.
- [Codex hooks](https://learn.chatgpt.com/docs/hooks#pretooluse): current interception limits.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): persistent daemon/client integration and experimental dynamic tools.
