# Agent Runtime Management v1

Status: Active Spec — daemon transport, local ownership, and runtime status UI implemented; host ownership pending
Last verified: 2026-09-04
Canonical code: `extensions/agent/server/src/providers/codex/codex-runtime-host.ts`, `extensions/agent/server/src/providers/codex/codex-app-server-connection.ts`, `extensions/agent/server/src/native-runtime/native-session-ownership.ts`, `extensions/codex/server/src/app_server.rs`, `app/src/settings/SettingsOverview.tsx`

## Purpose

Remux Agent is a client of provider-native coding harnesses. It must not make a
logical chat session synonymous with a provider process, and it must not make
the Agent viewer responsible for installing, updating, or globally restarting
those harnesses.

This amendment defines a host-owned runtime boundary that:

- keeps Codex and Claude Code current without silently promoting an unverified
  executable into live work;
- preserves the dedicated Codex extension as an independent UI and fallback;
- gives native session history one provider-authoritative owner;
- prevents two Remux clients from mutating the same native session;
- keeps the Agent journal a durable UI projection rather than a replacement
  provider history store; and
- exposes stable lifecycle and usage evidence to later Ledger work without
  letting Ledger own provider processes.

## Fixed boundaries

The runtime architecture has five layers:

1. **Installation registry** — provider kind, stable instance ID, configured
   executable, config/home directory, installation source, and update policy.
2. **Runtime supervisor** — daemon or child-process generations, readiness,
   installed/running versions, draining, restart, and diagnostics.
3. **Native-session ownership** — one mutation controller per provider
   instance and native session, with any number of passive readers.
4. **Provider adapter** — native protocol translation, session semantics,
   history/snapshot reads, commands, and federation configuration.
5. **Agent coordinator and journal** — durable command receipts, normalized UI
   projection, recovery, and resource invalidation.

The viewer consumes resources and sends commands. It owns none of these
lifecycles.

## Provider topology

### Codex

One Codex App Server daemon runs per `(resolved Codex executable, CODEX_HOME)`
runtime instance. Multiple logical sessions and Remux clients use independent
initialized WebSocket connections to that daemon.

Independent client connections are intentional for Version 1. They avoid a
premature notification multiplexer while preserving the critical invariant:
every loaded thread participates in one in-process Codex writer registry.

Opening, closing, or evicting a `ProviderSession` opens or closes a client
connection. It never starts a second stdio App Server and never stops the
daemon. `thread/start`, `thread/resume`, and `thread/fork` receive all mutable
configuration through their supported thread-local parameters.

The stdio transport remains test-only and as an explicit compatibility tool;
production never silently falls back to process-per-session behavior because
that recreates split writer ownership.

### Claude Code

The pinned Agent SDK remains in the Agent build. Each active logical Claude
session owns one long-lived SDK query backed by the configured Claude Code
executable. There is no synthetic shared daemon.

Runtime management still tracks Claude installation/version/auth state and
supervises session ownership. An executable update applies to newly created
query processes; an already-running query remains on the generation it opened
with until it closes.

SDK package updates are Remux code releases. They are never performed by a
host runtime Update button.

## Codex daemon acquisition

The Agent Codex runtime host performs this sequence:

1. Run the fixed `codex app-server daemon version` command.
2. Parse the machine-readable state, socket, managed executable, installed
   version, and running version.
3. Reuse a recent running status for a bounded interval to avoid spawning a
   CLI probe for every history/model connection.
4. Connect to the absolute Unix control socket using WebSocket framing.
5. If status is stopped or the socket races daemon exit, serialize one fixed
   `codex app-server daemon start` command and retry the socket until the
   startup deadline.
6. Initialize every connection once before any other App Server request.

Caller-supplied process arguments are rejected by the daemon transport. Native
provider configuration belongs on the thread request; federation credentials
must never be ambient process environment.

The connection contract enforces bounded messages, bounded request deadlines,
pending-request rejection on loss, contained notification projection errors,
and explicit responses to App Server requests. Closing a connection does not
stop or signal the daemon.

## Native-session ownership

Mutation ownership is keyed by:

```text
provider kind + provider instance ID + native session ID
```

The lease records the controlling Remux execution. A second controller fails
before it resumes or starts a provider process.

Version 1 implements this registry inside the Agent server and shares it across
the Codex and Claude adapters. The target host implementation extends the same
contract across the Agent and Codex extension clients.

Rules:

- history discovery and passive native reads require no lease;
- resume, turn start, steer, interrupt, compact, fork, edit, and rollback use a
  controlled logical session;
- a lease is released only when session close finishes or open fails;
- transport loss alone does not release ownership because reconciliation may
  still be closing or replacing the old session;
- a new native session is claimed immediately after the provider returns its
  ID and before it is exposed to the coordinator;
- a lease release is idempotent and token-fenced so a stale owner cannot
  release a replacement lease; and
- cross-client takeover while a turn is active is forbidden.

The future host registry adds client heartbeat, observed/controlled modes, and
an explicit idle handoff. It must reconcile provider state before expiring an
apparently abandoned controller.

## Codex extension coexistence

The Codex extension is retained. Its viewer, projection, commands, and server
remain independently testable from Agent.

Both clients converge on the same daemon instance. Agent failure therefore
does not kill the provider runtime, while Codex extension failure does not
corrupt Agent UI state. Neither client owns native history.

The migration is complete only when both clients participate in the shared
host ownership registry. Until then, the App Server daemon remains the common
writer authority and both clients must avoid silently resuming a thread solely
to display history.

## Host settings contract

Remux Settings gains an **Agent Runtimes** section independent from extension
build/watch controls. Each configured runtime reports:

- provider and stable provider instance ID;
- configured and resolved executable paths;
- installation source (`system` or `remux-managed`);
- installed provider version;
- running provider version and runtime generation, when applicable;
- Agent adapter and SDK version;
- authentication/readiness state;
- compatibility state (`supported`, `unverified`, or `incompatible`);
- update availability and restart requirement;
- active logical sessions and active turns; and
- last bounded diagnostic.

Fixed actions are Check, Sign in/out, Update, Restart/Apply, and View Logs. No
caller supplies an executable, shell command, or arbitrary arguments through
the management RPC.

## Update and promotion

The default policy is detect and notify, not silent auto-promotion.

For Codex, Update installs a candidate but does not restart a daemon with
active turns. Installed and running versions remain separately visible. A
restart drains active controllers, advances the runtime generation, reconnects
clients, and reconciles provider history.

For Claude, the executable and Agent SDK are separate compatibility axes. The
host detects executable drift, while the SDK version changes only with the
Agent build. Existing query processes are never rewritten in place.

A candidate runtime is promoted only after bounded canaries cover:

- initialize and auth state;
- model and account usage reads;
- create, resume, and passive history read;
- turn start and terminal event;
- interrupt;
- native fork plus edit/resume of the destination;
- compaction capability discovery; and
- the maximum supported transcript resource envelope.

System/PATH installations may delegate rollback to their package manager.
Remux-managed installations use versioned slots and retain one known-good
candidate for atomic rollback.

## Persistence

Provider-native history remains provider truth. Agent SQLite retains normalized
events, command receipts, lineage, UI metadata, and resource revisions.

Runtime settings persist only installation selection, update policy,
compatibility evidence, and management state. Process IDs, active connections,
controller heartbeats, and runtime generations are live supervisor state and
must be reconciled after restart.

Stable provider instance IDs already stored by conversations are never renamed
as part of this migration. `codex-local` and `claude-local` remain valid aliases
until an explicit data migration introduces configurable instances.

## Delivery

### Landed in the initial pass

- transport-neutral Codex JSON-RPC connection core;
- Unix WebSocket daemon client with fixed status/start commands;
- bounded running-status cache and serialized daemon startup;
- Agent Codex default cutover from per-session stdio children to the daemon;
- provider-neutral process-local session control leases for Codex and Claude;
- provider-neutral runtime status exposed through the Agent RPC boundary;
- an Agent Runtimes settings surface with Codex lifecycle actions and Claude
  SDK/process visibility;
- retained stdio fixture transport; and
- Agent `research` workload declaration for protected validation and native
  agent work.

### Remaining host pass

1. Move installation and lifecycle status behind a shared Remux host service.
2. Add cross-extension observe/control leases and idle handoff.
3. Migrate Codex extension status and management RPCs to that service without
   replacing the Codex extension UI or projection.
4. Add Claude executable drift and SDK compatibility reporting.
5. Add upgrade canary, drain, promotion, and rollback flows.
6. Run failure drills for Agent crash, Codex extension fallback, daemon restart,
   active-update refusal, two-client contention, and rollback.

## Acceptance gates

- Fork/edit never resumes a destination in a second App Server process.
- Closing or restarting Agent never terminates the Codex daemon.
- The Codex extension can reopen an idle native thread after Agent failure.
- Two Agent executions cannot control one Codex or Claude native session.
- Passive history reads do not seize control.
- Federation authorization remains thread/session scoped under daemon sharing.
- Runtime status distinguishes installed from running versions.
- Updates cannot restart active work without an explicit destructive action.
- Provider and viewer tests retain their existing transcript semantics.
