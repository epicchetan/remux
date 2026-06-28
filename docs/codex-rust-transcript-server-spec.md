# Rust Codex Transcript Server Spec

## Purpose

Replace the Codex extension's Node backend with a Rust stdio server focused on fast transcript resource reads.

This first phase does not hook up the client and does not implement streaming. The goal is a deterministic, read-optimized backend contract that can be validated against real Codex transcript history before the UI is rewired.

## Scope

In scope:

- Remove the current `extensions/codex/server/*.cjs` server implementation.
- Add a Rust binary for the Codex extension server.
- Update `extensions/codex/remux-extension.json` to launch the Rust binary.
- Implement a batch transcript resource read API.
- Implement disk-backed Codex history indexing and projection in Rust.
- Add tests for read correctness and invariants.
- Add a real-transcript validation command/test mode.

Out of scope for this phase:

- Client wiring.
- Streaming deltas.
- Server invalidation pushes.
- Runtime overlay state.
- Forwarding arbitrary Codex app-server RPCs.

## Server Contract

Transport remains stdio JSON-RPC, but the server is Rust.

Primary method:

```ts
method: "remux/codex/transcript/resources/read"

params: {
  threadId: string;
  requests: TranscriptResourceRequest[];
}

type TranscriptResourceRequest =
  | {
      type: "threadTranscript";
      knownRevision?: string;
      includeTailTurns?: number;
    }
  | {
      type: "turn";
      turnId: string;
      knownRevision?: string;
    }
  | {
      type: "workDetails";
      turnId: string;
      segmentId: string;
      knownRevision?: string;
    };
```

Response:

```ts
type TranscriptResourcesReadResponse = {
  threadId: string;
  resources: TranscriptResourceResult[];
};

type TranscriptResourceResult = {
  requestIndex: number;
  key: string;
  status: "ok" | "notModified" | "missing" | "error";
  revision?: string;
  value?: unknown;
  reason?: string;
};
```

Resource keys:

```text
threadTranscript:{threadId}
turn:{threadId}:{turnId}
workDetails:{threadId}:{turnId}:{segmentId}
```

`includeTailTurns` lets initial UI load fetch the transcript order and a tail window in one round trip.

## Resource Shapes

Thread transcript:

```ts
type ThreadTranscriptResource = {
  threadId: string;
  revision: string;
  turnOrder: string[];
  turns?: CodexTranscriptTurn[];
};
```

Turn:

```ts
type TurnResource = {
  threadId: string;
  turnId: string;
  revision: string;
  layoutRevision: string;
  turn: CodexTranscriptTurn;
};
```

Work details:

```ts
type WorkDetailsResource = {
  threadId: string;
  turnId: string;
  segmentId: string;
  revision: string;
  details: CodexWorkDetails;
};
```

## Rust Architecture

Crate layout:

```text
extensions/codex/server/
  Cargo.toml
  src/main.rs
  src/server.rs
  src/transcript.rs
  src/util.rs
  src/history/mod.rs
  src/projection/mod.rs
  src/projection/items.rs
  src/projection/segments.rs
  src/projection/work.rs
  src/resources/mod.rs
  src/resources/validate.rs
  src/resources/tests.rs
```

Core modules:

- `server`: JSON-RPC request/response types.
- `main`: stdio request loop and validation CLI.
- `transcript`: shared request, index, and validation report types.
- `history`: Codex JSONL discovery, session indexing, byte ranges, rollback handling, and bounded turn hydration.
- `projection`: raw Codex rows to transcript turns, segments, and work details.
- `resources`: batch read API implementation.
- `resources/validate`: real transcript scanner and invariant checks.
- `util`: stable revisions and shared JSON/text helpers.

## Cache Design

Use layered caches. Every cache entry must be invalidated by file identity/revision changes.

```text
Thread path cache:
  threadId -> session path

File index cache:
  path + fileRevision -> visible turn ranges

Turn cache:
  path + turnId + byteRange + fileRevision -> projected turn

Work details cache:
  path + turnId + segmentId + turnRevision -> projected details

Serialized resource cache:
  resourceKey + revision -> JSON value
```

File revision can start as:

```text
fileRevision = size + mtime_nsec
```

If this proves flaky, add a cheap tail hash or full-file hash only for suspicious cases.

Indexing should be incremental for append-only JSONL files:

```text
if current size > indexed_until_offset:
  scan appended bytes only
else if size changed backwards or metadata is inconsistent:
  rebuild index
```

Batch reads should share work:

- Stat the session file once per request.
- Load or update the index once per request.
- Hydrate each requested turn at most once.
- Project work details from the cached projected turn when possible.
- Return `notModified` when `knownRevision` matches.

## Segment Identity

Segment ids must be stable across rereads.

Avoid index-only work ids such as:

```text
{turnId}:work:0
```

Prefer ids based on stable underlying item identity:

```text
{turnId}:work:{firstItemId}:{lastItemId}
```

Requirements:

- Adding a later segment must not rename earlier work segments.
- Adding an earlier segment should not rename unrelated later work segments when the underlying item group is unchanged.
- Work details are keyed by `segmentId`.
- The client can preserve expanded work state when the same `segmentId` survives.

## Read Semantics

`threadTranscript`:

- Returns visible turn order.
- Applies rollback rows.
- Optionally includes tail turns.
- Does not hydrate all turns unless requested.

`turn`:

- Hydrates one visible turn from its byte range.
- Projects raw rows into `CodexTranscriptTurn`.
- Returns `missing` if the turn is not visible after rollback.

`workDetails`:

- Hydrates or reuses the projected turn.
- Finds the requested `segmentId`.
- Returns details only for that segment.
- Returns `missing` if the segment no longer exists.

## Replacement Plan

1. Add Rust server crate and binary.
2. Implement stdio JSON-RPC with only `resources/read`.
3. Implement read-only history indexing and projection.
4. Add validation command:

   ```bash
   cargo run --manifest-path extensions/codex/server/Cargo.toml --offline -- validate --codex-home ~/.codex --limit 100
   ```

5. Remove old Node server files.
6. Update `remux-extension.json` to launch the Rust server binary.
7. Keep frontend disconnected until the next phase.

## Tests

Use correctness tests for deterministic code paths and real-history validation for end-to-end confidence.

Always-on tests:

- JSON-RPC request/response parsing.
- JSONL line scanner handles partial lines and malformed rows.
- Indexer finds turn ranges.
- Indexer applies rollback rows.
- Hydration respects byte ranges.
- Projection produces unique segment ids per turn.
- Work detail reads reference existing segment ids only.
- `knownRevision` returns `notModified`.
- Batch reads do not hydrate the same turn more than once.

Real transcript validation:

- Discover recent Codex session files from the configured Codex home.
- Index each discovered transcript.
- Read `threadTranscript`.
- Read tail turns.
- Read a sample of older turns.
- For every turn sampled, read every work-details segment.
- Assert no duplicate segment ids within a turn.
- Assert every work-details response maps to an existing work segment.
- Assert no obvious duplicate user/assistant segments after projection.
- Assert rollback-hidden turns do not appear in `turnOrder`.
- Record timing and cache hit-rate summaries.

The real-transcript validation should be available as both:

- A developer command for manual confidence.
- An ignored or environment-gated integration test, for example:

  ```bash
  REMUX_VALIDATE_CODEX_HOME=~/.codex cargo test --manifest-path extensions/codex/server/Cargo.toml --offline real_transcripts -- --ignored
  ```

## Manual Verification Checklist

After the Rust read server is implemented, run validation against local Codex history and manually inspect a few projected resources.

Check:

- Recent thread loads return plausible tail turns.
- User messages are not duplicated.
- Assistant final answers are not duplicated.
- Work segments are not empty when raw work items exist.
- Work details correspond to their collapsed work segment.
- Segment ids remain stable across repeated reads.
- `knownRevision` returns `notModified` on repeated requests.
- Large command outputs or diffs are bounded/truncated intentionally.
- Rollback histories do not show removed turns.

## Success Criteria

The phase is complete when:

- Rust server responds to `resources/read`.
- Read API is documented by TypeScript-compatible schemas/types.
- Unit tests pass.
- Real transcript validation passes on local Codex history.
- Manual inspection of sampled projected resources shows no obvious repeats, missing turns, or unstable segment ids.
- Old Node backend has been removed from the Codex extension.
