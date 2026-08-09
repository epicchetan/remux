# Remux Agent

This extension contains the owner-accepted Phase 0 integration spine, Phase
1A UI and durable-history foundation, transcript hardening, and the first
authoritative context workspace described in
`docs/specs/agent-context-workspace-v1.md`. It runs beside the existing
`codex` extension and combines OpenAI Codex subscription auth,
model/reasoning selection, streaming, interruption, Pi read/bash/edit/write
tools, an Agent-owned SQLite journal, restart-safe conversation history,
bounded UI projection, exact artifact retrieval, atomic model-managed context
state through the model-facing `context_update` set/remove/pin/unpin tool,
journal search/open tools, deterministic provider context frames,
pressure rollover without compaction, and an inspectable full-versus-
continuation transport trail. The ported transcript, Markdown, work, composer,
virtualization, lifecycle, and responsive UI foundation now also includes
structured file mentions, artifact-backed image attachments, durable queued
follow-ups, and immutable edit/fork branches. Its provider-neutral styling and
interaction behavior stay aligned with the established Codex experience. The
phased parity boundary is defined in
`docs/specs/agent-ui-parity-and-phased-delivery.md`.

Phase 1A.1 and Phase 1A.2 owner acceptance are complete, including the
fault/scale closeout, clean-state restart smoke, and desktop/physical-phone
review. The context workspace and active frame compiler have also completed
their first real-subscription E0 comparison. Full-history remains an evaluation
control; stateful frames are the product default. Bounded child work scopes are
implemented behind an opt-in benchmark/runtime flag and are not part of the
default prompt or tool surface. A first-class persistent-process registry
remains future work.

## Local verification

```sh
npm run test:agent
npm --workspace @remux/agent run build
npm --workspace @remux/agent run test:server
npm --workspace @remux/agent run test:unit
npm --workspace @remux/agent run test:viewer
npm --workspace @remux/agent run test:hardening
npm --workspace @remux/agent run test:context-corpus
npm --workspace @remux/agent run benchmark -- list
```

`test:context-corpus` is a read-only structural pressure check over the local
historical rollout paths documented in
`docs/specs/agent-ledger-benchmark-corpus.md`. It prints hashes and aggregate
measurements only; it neither imports transcript content into product state nor
claims semantic task-quality coverage.

## Production-path benchmark

The E0 benchmark controller drives the same authenticated Codex or Agent RPC
commands used by the UI. Its first fixture replays the historical Ledger
feed/session workflow as four owner-style turns: read-only audit, implementation
authorization, focused FIFO correction, and final audit. Fixture workers get a
fresh repository containing only the historical base tree; the source rollout,
target commit, fixture manifest, and hidden reference tests remain outside the
worker workspace.

```sh
# Inspect entitled model IDs, then prepare or run the fixture.
npm --workspace @remux/agent run benchmark -- models --target codex
npm --workspace @remux/agent run benchmark -- prepare
npm --workspace @remux/agent run benchmark -- run \
  --target codex --model <model-id> --reasoning high

# Run the same scenario through the stateful Agent/Pi path.
npm --workspace @remux/agent run benchmark -- run \
  --target agent --context-mode managed-v1.1 --model <model-id> --reasoning high

# The run command stops after the collaboration turns so the working tree can
# be inspected. Evaluation is a separate, deterministic step.
npm --workspace @remux/agent run benchmark -- finalize --run <run-id>
```

`start`, `send`, and `status` expose the same flow one turn at a time. `replay`
copies only a prior run's recorded owner messages into a fresh fixture and a
different target. `resume --run <run-id>` continues an interrupted Agent run
in its original workspace and conversation without replaying completed owner
turns. Finalization captures the visible transcript, rollout hash
and tool metrics when available, complete patch (including untracked files),
scope and permission gates, formatting, and a managed full-workspace test run
with hidden historical reference tests overlaid. Generated workspaces and
evidence live under ignored `.remux-benchmarks/`; the Ledger source repository
is read-only and checked for mutation.

Set `REMUX_AGENT_FIXTURE=1` when launching `server/dist/main.mjs` to use the
deterministic fixture engine without auth or model traffic.

The opt-in replay smoke check uses the local Codex subscription and, by
default, snapshots the newest durable conversation before sending a sentinel
turn through the real Pi/provider path:

```sh
npm --workspace @remux/agent run test:live:replay
```

Pass `-- --conversation-id <id>` to select a thread. `--in-place` deliberately
appends the check to the source conversation and is reserved for explicit live
recovery verification; it is never part of the normal test suite.

The stateful clean acceptance check is opt-in. It requires an
already empty Agent journal, creates one two-turn real-provider conversation,
and restarts only the Agent extension between turns:

```sh
npm --workspace @remux/agent run test:live:clean
```

Afterward, the production viewer bundle can be checked against that real
conversation through the authenticated live RPC bridge at desktop and mobile
viewport sizes:

```sh
npm --workspace @remux/agent run test:live:viewer -- --conversation-id <id>
```

The viewer check is not a substitute for native physical-phone acceptance.

The explicit full artifact scrub is a maintenance/test command and is not run
on the startup hot path:

```sh
npm --workspace @remux/agent run storage:scrub -- --data-root <path>
```

## Live acceptance

The owner reported the Phase 0 interactive smoke test complete on 2026-08-07:

1. Launch **Agent Preview** in Remux.
2. Complete device-code sign-in and confirm the entitled model list.
3. Ask the agent to read `README.md` and report its first heading.
4. Interrupt a second active turn, close/reopen the viewer, restart the
   extension, and sign out.

This records owner confirmation without storing credential, provider payload,
or transport-secret output. Fixture success remains separate evidence and
must not replace the live gate on a future clean deployment.

The owner also completed and accepted the Phase 1A.0 desktop/physical-phone UI
comparison on 2026-08-07 with no blocking parity findings reported, then
completed the Phase 1A.1 live acceptance. Local conversations and history now
remain durable across Agent extension restarts; the recorded evidence is in
`docs/specs/agent-phase-1a1-implementation-report.md`.

## Pi 0.84.0 seam report

The pinned SDK provides the required context transform, provider-payload hook,
custom-tool replacement, in-memory session, disabled compaction/retry, OAuth,
and abort surfaces. Remux applies one exact-version postinstall patch that adds
an awaited, host-owned `providerPreflight` callback after extension payload
transforms. That fence durably commits the final provider request before any
network dispatch; installation fails if the expected Pi 0.84.0 source shape is
not present.

Two telemetry/isolation limitations remain explicit:

- `ModelRuntime` has no provider allowlist. Remux exposes, selects, authenticates,
  and requests only `openai-codex`, and disables catalog network refresh, but Pi
  still constructs its built-in provider registry and performs its normal
  create-time availability pass. A provider-scoped runtime constructor would
  make the isolation gate structural instead of adapter-enforced.
- `before_provider_request` exposes the final payload, so the probe can record
  initial-full versus `previous_response_id` continuation requests. The public
  session SDK does not expose stable response IDs, cache-hit accounting, or
  websocket cache utilization as normalized events. Those measurements need a
  small upstream Pi telemetry seam before Phase 1 cache-economics work.

No raw provider payload, credential, Pi message object, or provider response ID
is stored in a Remux resource. The context probe contains only counts, byte
estimates, ordered hashes, provider/model identity, hook version, and request
mode.
