# Agent background working memory v1

Status: R&D evidence; superseded by `agent-explicit-turn-context-v1.md`
Last verified: 2026-08-09
Builds on: [`agent-context-workspace-v1.md`](agent-context-workspace-v1.md)

## Outcome

The Agent should treat provider context as a working cache rather than a
shrinking transcript. The immutable journal remains the exact source of truth.
A narrow GPT-5.6 Sol background inference continuously compiles completed work
into a bounded working-memory snapshot, while the foreground coding model keeps
an exact append-only hot tail and can explicitly retain or release information.

This is an experimental runtime mode, `working-memory`, and a benchmark arm,
`working-memory-v1`. The existing `stateful` mode remains an unchanged control
until the new mode has passed real evaluation.

## Non-goals

Version 1 does not introduce embeddings, a vector database, a second coding
agent, a mandatory task workflow, automatic file watching, or model-authored
truth. It does not rewrite the provider prefix after every tool call and does
not enable Pi compaction.

## Four layers

1. **Journal truth.** Messages, tool operations, files captured as artifacts,
   durable state, and terminal boundaries remain immutable and openable.
2. **Working-memory snapshot.** A disposable semantic projection contains a
   short orientation and a small set of keyed entries with exact journal or
   file references. It may be rebuilt from the journal.
3. **Epoch frame.** A frame freezes one snapshot, durable foreground holds,
   runtime facts, and the current request into a stable prefix.
4. **Hot tail.** Exact user, assistant, tool-call, and tool-result messages
   append after the frame. They are not summarized while the frame is active.

The snapshot is a cache, not a source of authority. The current user request,
accepted specification, observed repository state, and exact journal evidence
always win over it.

## Background compiler

After each terminal foreground turn, the runtime schedules a non-blocking,
coalescing compile. It supplies Sol with:

- the prior snapshot and its journal basis;
- completed journal delta since that basis, including bounded message and tool
  observations;
- current foreground-managed thread and project state;
- a strict output budget and schema.

Sol returns one JSON patch containing a replacement orientation, keyed upserts,
and removals. Entries have no fixed task taxonomy. Each entry contains a stable
key, concise body, scope, and evidence references. The host validates size,
shape, uniqueness, scope, and limits, applies the patch to the previous
snapshot, and commits the full derived snapshot as an immutable internal journal
event.

The compiler has no filesystem or coding tools and cannot mutate source state.
One failed or malformed background result records a diagnostic event and never
fails the foreground turn. If another turn finishes during a compile, the
scheduler coalesces the newer delta and runs again. Snapshot commit is
compare-and-swap against the prior snapshot sequence, so stale output cannot
replace newer memory.

The preferred compiler model is `gpt-5.6-sol` at low reasoning. If Sol is not in
the authenticated model catalog, the background compile is reported unavailable
rather than silently changing the foreground model or using a weaker fallback.

## Foreground control

The `working-memory` mode exposes a `memory` tool with three positive concepts:

- `remember`: keep a small semantic value under a stable key;
- `hold`: retain an exact workspace/absolute file path or `journal://` resource
  while it governs the work;
- `release`: remove a remembered key or held resource when it no longer matters.

The foreground surface deliberately does not accept free-form evidence strings:
semantic values are model-authored cache instructions, while exact support is
held as a resource or recovered from the journal. These operations reuse the
revisioned project/strand primaries. They are
durable, scoped, evidence-backed instructions to the context system and remain
separate from the background cache. Ordinary reads automatically enter the hot
tail and the next background delta; reading something does not permanently pin
it. The background compiler decides which observed details survive into its
cache, while explicit foreground state remains protected until release.

The legacy `context_update` tool and prompt remain unchanged in `stateful` mode
for a clean benchmark control.

## Epoch activation and KV-cache behavior

A committed background snapshot is a **candidate**. It does not rewrite the
active frame. The foreground continues from its frozen prefix plus exact tail,
preserving `previous_response_id` continuation and the provider KV cache.

The newest committed snapshot is activated only when a frame is created:

- a runtime starts or restarts;
- context pressure requires rollover; or
- the active frame can no longer reconcile with journal truth.

At activation, raw messages already covered by the snapshot basis are omitted
from the new bootstrap. Messages and tool results after the basis remain exact.
An immediate follow-up therefore works even if its background compile is still
running: the prior frame and exact hot tail remain sufficient.

## Snapshot contract

The durable event payload uses `agent-working-memory-v1` and contains:

```json
{
  "version": "agent-working-memory-v1",
  "coveredThroughSequence": 123,
  "baseSnapshotSequence": 99,
  "orientation": "Current objective and position in a few sentences.",
  "entries": [
    {
      "key": "feed-clock-contract",
      "scope": "thread",
      "body": "A regression must restart the outer loop before pacing.",
      "refs": ["journal://turn/example"]
    }
  ],
  "compiler": {
    "modelId": "gpt-5.6-sol",
    "durationMs": 1200,
    "inputTokens": 8000,
    "outputTokens": 900
  }
}
```

Limits for v1 are 32 entries, 1,600 UTF-8 bytes per body, eight references per
entry, 4,000 bytes for orientation, and a 24,000-byte canonical snapshot. The
compiler input keeps at most 96,000 bytes of newest completed delta. Older
omitted material remains recoverable from the journal and is represented by an
explicit omission range in the request.

Thread entries are available only to the strand that produced them. Project
entries may be inherited by sibling strands, but the background model may not
promote a thread observation to project scope on its own in v1; project scope
comes from explicit foreground state.

## Failure and freshness

- Invalid output, provider errors, cancellation, and stale CAS results leave the
  last good snapshot active.
- A snapshot with no new completed journal delta is not recompiled.
- File-derived entries must retain a file/artifact reference. They are hints;
  the foreground re-reads mutable files before editing or final validation.
- Closing or switching a runtime aborts best-effort background transport but
  does not roll back a snapshot already committed.
- Background failures are visible in journal evidence and benchmark metrics but
  never appear as failed user turns.

## Instrumentation

Every background attempt records model, basis, previous snapshot, duration,
reported input/output/cache tokens, result state, entry counts, and snapshot
bytes. Every foreground inference manifest records the snapshot sequence and
basis selected by its frame.

The benchmark must report foreground and background costs separately:

- background attempts, commits, failures, and stale commits;
- background input/output/cache tokens and wall time;
- snapshot entries and bytes at the final basis;
- foreground full versus continuation requests and frame count;
- journal retrieval, repeated reads, and explicit memory operations;
- **retention hit:** a later answer or implementation uses an entry whose source
  is no longer in the exact hot tail;
- **eviction regret:** the foreground reopens evidence that a prior snapshot
  contained and a newer snapshot removed;
- stale-memory reliance and cross-thread pollution, both of which must be zero.

## Implementation slices

1. Add the mode, memory types, prompt/patch validator, immutable snapshot commit,
   CAS, and scoped snapshot read.
2. Add the non-blocking Sol scheduler and foreground `memory` surface.
3. Include the latest snapshot in new frame compilation and trim covered raw
   turns while preserving exact post-basis tail.
4. Add deterministic tests for patch validation, commit races, failure
   isolation, scoping, frame stability, rollover activation, and scheduler
   coalescing.
5. Add benchmark extraction and the `working-memory-v1` arm; run the same E0
   Ledger fixture and compare it with the retained `stateful` and Codex runs.

## Completion criteria

- The background compiler runs after every newly completed turn without adding
  latency to durable turn settlement.
- A malformed or failed background call cannot fail a user turn.
- Two overlapping completions cannot commit snapshots out of order.
- A new turn sent before compilation completes retains the prior exact tail.
- Ordinary tool calls do not change the active frame bootstrap or force a full
  request.
- Restart or pressure rollover activates the latest snapshot and excludes raw
  turns at or before its covered basis.
- Foreground remember/hold/release operations survive restart and remain scoped.
- The journal can reconstruct every snapshot and open every cited reference.
- Pi manual and automatic compaction remain disabled.
- Focused tests, production build, real-stack smoke, and one complete E0 Ledger
  benchmark pass far enough to produce auditable quality and efficiency
  evidence.

The first benchmark is diagnostic. Working memory is promoted to the product
default only if it preserves or improves task correctness while eliminating
manual compaction and does not introduce stale reliance or thread pollution.

## First measured result

The clean E0 run is
`2026-08-09T23-41-19-231Z-agent-0b0db7`. It exercised four real turns through
the production UI/API path: read-only audit, terse implementation
authorization, focused FIFO correction, and final audit. The benchmark waiter
required the durable transcript terminal before advancing, and evaluation was
delayed long enough to capture all four background compiles.

Compared with the retained stateful control
`2026-08-09T21-00-03-940Z-agent-eab4b1`:

| Measure | Stateful | Working memory | Change |
| --- | ---: | ---: | ---: |
| foreground provider calls | 95 | 78 | -17.9% |
| estimated foreground input tokens | 12,798,057 | 9,604,020 | -25.0% |
| foreground tool calls | 192 | 163 | -15.1% |
| parent-visible tool-result bytes | 987,347 | 789,454 | -20.0% |
| peak estimated input | 223,656 | 225,897 | +1.0% |
| task wall time | 25m 47s | 26m 26s | +2.5% |
| compactions / context-limit failures | 0 / 0 | 0 / 0 | equal |

The four background calls committed four snapshots with zero failures or stale
commits. They separately consumed 133,596 reported input tokens, 5,040 output
tokens, and 98.5 seconds of aggregate model time; this work was concurrent with
foreground turns. The final cache contained five entries in 4,361 bytes. One
pressure rollover activated working memory without an unannounced rollover or
journal recovery call.

Task correctness was parity with the stateful control, not with the Codex
baseline. Both Agent runs failed the hidden historical API-shape tests and the
dual playback/shutdown error gate while passing the FIFO clock re-read gate.
Codex failed only the historical API-shape tests. Working memory therefore
demonstrated a meaningful efficiency improvement, but not a quality win yet.

The run also exposed one lifecycle issue: the foreground successfully held the
29 KB accepted spec, but did not release that exact resource after final audit.
Background eviction correctly cannot override an explicit hold, so stale hold
cleanup and its UI/telemetry remain a follow-up design problem. The compiler
also reported zero cache-read tokens in this run. Neither issue blocks the v1
experiment, but both prevent promoting it to the default context mode.
