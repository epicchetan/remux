# Ledger feed/session workflow driver card

## Goal

Collaboratively design and implement the accepted Ledger feed/session system
from the checked-in implementation specification while preserving the owner's
ability to question and refine the design before code is written.

## Stable constraints

- Deterministic replay, cursor/clock behavior, cell ownership, and clean session
  shutdown are required.
- The checked-in feed-system specification remains the governing authority.
- Existing public compatibility expected by Ledger callers must be preserved:
  the exact contract in `docs/benchmark_feed_public_compatibility.md` is
  acceptance-critical, not an evaluator-only assumption.
- Cache and runtime internals are out of scope.
- Do not commit or push.

## Natural situations

1. Ask for a read-only repository-grounded audit, with no implementation yet.
2. Respond to the audit: accept sound safety clarifications but explicitly keep
   the governing public compatibility contract. Authorize implementation.
3. After implementation, introduce the historical FIFO regression concern:
   multiple queued seeks must remain ordered and every request must complete.
4. Ask for a skeptical final audit against the authority, accepted decisions,
   actual diff, and important validation.
5. Optionally ask a continuity question about one early decision if the prior
   turns produced enough context to make it useful.

These are situations, not fixed messages. The driver should respond naturally
to what the model actually says and record every accepted/rejected decision.
