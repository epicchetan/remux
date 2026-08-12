# Remux session-transport workflow driver card

## Goal

Collaboratively audit and implement the accepted session transport from the
checked-in specification. Let the model establish the architecture and risks
before the owner authorizes code, then test whether it can carry those decisions
through a cross-layer implementation and skeptical review.

## Stable constraints

- `docs/ledger_session_transport_implementation_spec.md` is the governing
  authority.
- The transport reuses the existing Ledger session/feed/projection APIs. Its
  only Ledger addition is the specified clock-key accessor.
- Streams are cache-watch-backed push notifications. Do not introduce polling,
  per-client subscription state, a render registry, or multiple active sessions.
- Session replacement and closure must not let stale watcher tasks publish as
  the new session.
- Playback controls are thin adapters. Successful RPC completion means the
  write was submitted; committed state is observed through the clock stream.
- Lens, cache, runtime, store, and the existing CLI are out of scope.
- Do not commit or push.

## Natural situations

1. Ask for a read-only, repository-grounded audit of the governing spec and the
   existing Remux/Ledger seams. Ask for a concrete implementation decomposition
   and the most failure-prone lifecycle boundaries. Do not authorize writes.
2. Respond naturally to the audit. Preserve the stable constraints above,
   resolve any real ambiguity it found, and authorize implementation with tests.
3. Once implementation completes, ask it to skeptically inspect replacement,
   close, and watcher cancellation for stale-notification races, plus the
   distinction between submitted controls and committed clock notifications.
   Authorize focused corrections when evidence warrants them.
4. Ask for a final audit against the governing spec, actual diff, and important
   validation. The response should distinguish proven behavior from residual
   risk rather than merely repeat that tests pass.
5. Use an optional continuity question only when it tests an early accepted
   decision that should still be present after the implementation work.

These are situations, not fixed messages. Follow the implementation that the
model actually produced and record accepted, rejected, revised, and open
decisions per turn.
