Status: Active Spec
Last verified: 2026-08-08
Canonical code: Phase 1A.1 implementation, automated closeout, and owner live acceptance are complete; Phase 1A.2 supersedes its schema/protocol versions and closes the combined durable-transcript checkpoint

# Agent Phase 1A.1 implementation report

## Decision state

Phase 1A.1a–1A.1d implementation, automated hardening, and owner live
acceptance are complete. Phase 1A.2 was subsequently authorized, implemented,
and accepted, and now supersedes the schema/protocol versions recorded here;
this report remains the historical Phase 1A.1 closeout record.

## Source and version identity

- Implementation base: Phase 1A.0 closeout commit
  `818af4481aa8a40f71ca5e978835906dee34d5ac`.
- Accepted Phase 1A.0 code checkpoint:
  `8e96512f06ea354bd54f84f5e783161b786e1696`.
- Pi: exact `0.84.0`, single exposed and selected provider
  `openai-codex`.
- Agent journal: SQLite schema `agent-journal-v1`, `PRAGMA user_version = 1`.
- Durable projection digest: `agent-projection-v1`.
- Full logical replay: `agent-full-replay-v1`.
- Transcript protocol/projection: version `1` / `agent-turn-render-v1`.
- Conversation summaries: deterministic Agent-owned rendering; no model call.
- `extensions/codex/` source changes: none.

This slice is published as part of the combined durable-transcript checkpoint.

## Implemented closure

### Durable storage and identity

The extension now resolves a private Agent data root, opens a strict Node 24
SQLite database in WAL/FULL mode, validates the exact schema fingerprint, and
refuses malformed, unversioned, newer, or symlinked storage. One canonical
workspace root owns a project and root context space. Durable identity covers
projects, conversations, strands, turns, root execution scopes, ordinal-zero
epochs, inferences, operations, transcript items, resources, and immutable
artifacts.

Conversation creation and message admission are idempotent. A repeated
operation/client-message identity with identical arguments returns the
original durable identity; conflicting arguments fail without mutation.
Conversation, turn, scope, epoch, inference, tool, transcript, and operation
identities remain distinct.

Artifacts use content-addressed SHA-256 paths and are flushed before a SQL row
may reference them. Startup validates every referenced object's path, length,
and hash. Installed objects without a committed row are reported as orphans
and retained. `remux/agent/artifact/read` accepts only a lowercase hash and a
bounded byte or line range; it never accepts a filesystem path.

### Provider and recovery fence

The live Pi context hook compiles a provider-neutral logical replay from one
committed journal basis before every inference. It preserves Pi's exact warm
suffix when semantically aligned and prepends only a missing durable prefix
after hydration. A one-use context fence is consumed by an awaited provider
preflight after extension payload transforms.

Provider preflight commits the final request artifact and
`inference.started` row before dispatch, records full-versus-continuation mode
and context hashes, rejects stale journal bases, and enforces the full-replay
budget before provider I/O. `workspace.read` similarly commits its call before
the read and commits the terminal result before returning it to Pi. Assistant
content is coalesced into committed recovery checkpoints before transcript
publication.

On startup, a nonterminal turn, inference, scope, and epoch converge to one
visible `interrupted_by_restart` terminal state. No provider request or tool
effect is silently replayed. Reopening an idle conversation builds a fresh Pi
session and begins with a verified full provider request; response IDs are not
restored from disk.

### Durable resources and viewer

Conversation summaries and the recent conversation list are journal-derived,
deterministic resources. The singleton live-runtime resource is separate from
durable conversation state. Transcript reads route to the loaded projector or
to a bounded frozen projector reconstructed without creating a Pi session.
Sending in an unloaded conversation lazily hydrates it; a different active
runtime owner fails with typed `active_runtime_busy` state and no mutation.

The existing Agent transcript/composer surface now includes desktop history,
a phone safe-area history sheet/action, cold selection, host navigation,
configuration locking, and per-target plain-text draft snapshots. Rapid
selection and generation changes are fenced by conversation identity. The
latest closeout also corrects config-surface opacity, portable UUID generation,
and the phone transcript's padded-lane width measurement.

The project-state kernel separately proves context-space ancestry, flexible
primaries, bindings, masking, supersession, relations, optimistic versioning,
and deterministic rendering. It is deliberately not connected to live prompt
assembly in 1A.1. Child execution scopes and active epoch compilation remain
inactive.

## Deliberate adaptations and deviations

1. **Pinned Pi preflight seam.** Pi 0.84.0 awaits extension payload transforms
   but swallows extension-handler failures. A version-checked postinstall patch
   adds one mandatory host-owned `providerPreflight` callback after those
   transforms. `createRemuxAgentSession` makes the callback structurally
   required. Fixtures prove rejection causes zero provider calls.
2. **Transactional normalized journal instead of a second database reducer.**
   Immutable semantic events and normalized durable rows commit in the same
   SQLite transaction. Conversation/list resources are disposable and can be
   rebuilt from normalized journal state. The implementation does not also
   contain a generic reducer that recreates every normalized row from events
   `[1, N]`; doing so would introduce two implementations of the same state
   transition. Closeout evidence instead combines immutable prefix-byte tests,
   foreign-key/transaction constraints, crash injection, resource rebuilding,
   and a canonical `agent-projection-v1` digest that survives rebuild and
   reopen. This narrows the scope document's literal every-prefix reducer
   requirement while preserving its corruption/recovery objective.
3. **Terminal event consolidation.** The journal uses one `turn.terminal`
   event with a typed status and updates root-scope/epoch terminal rows in the
   same transaction, rather than emitting separate duplicated terminal events
   for each materialized identity. Inference terminal events remain explicit.
4. **Module consolidation.** Artifact storage, canonical JSON, resource
   rebuilding, replay, recovery, and summaries are split by runtime ownership,
   not by every proposed filename. Tests are likewise grouped by behavioral
   boundary rather than mirroring the proposed file list.
5. **No standalone navigation store.** Selection is viewer-local and remains
   in `App.tsx`; the transcript store already owns generation/conversation
   fencing. A second navigation authority would duplicate that state.
6. **Compatibility revision alias.** Agent resources retain `revision` equal
   to `basisSequence` for the shared viewer IPC shape. Both fields are assigned
   from the same value at every durable read and cannot diverge.
7. **Orphans are startup diagnostics.** Unreferenced installed artifact paths
   are reported in repository diagnostics and retained; they are not inserted
   into schema-v1 semantic tables and are never garbage-collected in 1A.1.
8. **Selected viewer corrections.** The closeout incorporates the current
   stable inner content-rail measurement used by the Codex viewer and adds an
   Agent-specific mobile overflow fixture. No Codex protocol, history, queue,
   narration, or source dependency was introduced.

## Automated evidence

Recorded on 2026-08-08. Temporary fixture data roots were created below the
system temporary directory and removed by test cleanup.

| Command | Result |
| --- | --- |
| `npm --workspace @remux/agent run build` | Pass; server and viewer production bundles built. The existing large Shiki chunk warning remains non-blocking. |
| `npm run test:agent` | Final cumulative pass: server 74/74, unit 24/24, viewer 54 pass with two intentional desktop skips for mobile-only cases. |
| `npm run typecheck` | Pass on the final closeout tree. |
| `npm run test:codex` | Pass: unchanged Codex baseline 354/354. |
| `npm --workspace @remux/agent run test:live:replay` | Pass against a snapshot of the newest real durable conversation using `gpt-5.3-codex-spark`, high reasoning. Fresh hydration dispatched one full request at an estimated 47,802 input tokens and returned `REMUX_REPLAY_OK` in 3.492 seconds. The source conversation was not mutated. |
| `git diff --check` | Pass; `extensions/codex/` has no source diff. |

The deterministic matrix covers schema creation/reopen/refusal, permissions,
canonical JSON in another process, operation and message conflicts, large
artifact-backed messages, bounded artifact reads, orphan reporting, immutable
event prefixes, canonical projection digests, resource rebuilding, stale
provider bases, zero-call provider-fence failures, three abrupt Pi crash
boundaries, real Pi tool/replay ordering, restart interruption, lazy hydration,
busy-runtime fencing, frozen transcript routing, 50-row recent history with
older direct addressing, auth redaction, transcript windows/details,
desktop/mobile navigation, drafts, reconnect, lifecycle, config paint,
portable UUIDs, Markdown containment, and the explicit feature exclusions.

## Live acceptance record

Accepted by the owner in chat on 2026-08-08 after exercising the live Agent on
the physical phone and reporting/fixing config opacity, portable UUID,
long-context estimation, and transcript-width findings. The accepted gate
covered:

1. new conversation → first send → durable history row;
2. switch between two conversations while preserving each draft/config;
3. restart the Agent extension and continue an existing conversation;
4. view another conversation while one is active and confirm busy-send safety;
5. phone history sheet, keyboard, safe areas, long message wrapping, and
   light/dark surfaces; and
6. sign out/in without losing local history.

This statement records the owner's explicit acceptance; it is not inferred
from automated tests or ordinary use.
