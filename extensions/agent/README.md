# Remux Agent

This extension contains the owner-accepted Phase 0 integration spine and
Phase 1A.0 UI foundation described in
`docs/specs/agent-runtime-and-epoch-context.md`. It runs beside the existing
`codex` extension and combines OpenAI Codex subscription auth, one ephemeral
Pi conversation, model/reasoning selection, streaming, interruption, and the
bounded `workspace_read` tool with the ported transcript, Markdown, work,
composer, virtualization, lifecycle, and responsive UI foundation. The phased
parity boundary is defined in
`docs/specs/agent-ui-parity-and-phased-delivery.md`.

Durable conversations, history, epoch context management, coding tools beyond
bounded reads, and persistent processes are not implemented yet.

## Local verification

```sh
npm run test:agent
npm --workspace @remux/agent run build
npm --workspace @remux/agent run test:server
npm --workspace @remux/agent run test:unit
npm --workspace @remux/agent run test:viewer
```

Set `REMUX_AGENT_FIXTURE=1` when launching `server/dist/main.mjs` to use the
deterministic fixture engine without auth or model traffic.

## Live acceptance

The owner reported this interactive smoke test complete on 2026-08-07:

1. Launch **Agent Preview** in Remux.
2. Complete device-code sign-in and confirm the entitled model list.
3. Ask the agent to read `README.md` and report its first heading.
4. Interrupt a second active turn, close/reopen the viewer, restart the
   extension, and sign out.

This records owner confirmation without storing credential, provider payload,
or transport-secret output. Fixture success remains separate evidence and
must not replace the live gate on a future clean deployment.

The owner also completed and accepted the Phase 1A.0 desktop/physical-phone UI
comparison on 2026-08-07 with no blocking parity findings reported. The
accepted checkpoint remains intentionally ephemeral: an Agent extension
restart makes its current conversation unavailable.

## Pi 0.84.0 seam report

The pinned SDK provides the required context transform, provider-payload hook,
custom-tool replacement, in-memory session, disabled compaction/retry, OAuth,
and abort surfaces without a local patch.

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
