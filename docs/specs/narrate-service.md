# Narrate Service

Status: Implemented
Last verified: 2026-07-13
Canonical code: `extensions/narrate/server/`, `extensions/codex/server/src/structured_inference.rs`, `crates/remux-extension-rpc/`, `crates/remux-tts/`, `crates/remux/src/extensions/supervisor.rs`

## Outcome

Narrate owns narration as a reusable service. It owns transcript planning,
source mapping, synthesis profiles, Kokoro execution, artifact storage,
progress, cancellation, and progressive audio availability. Codex owns only
its app-server process and exposes a small structured-inference gateway.

The current Codex viewer continues to use its existing
`remux/codex/narration/*` contract. Those methods are compatibility proxies to
Narrate, so the UI migration can happen separately without duplicating the
pipeline. Narrate also emits the legacy Codex update notification until that
migration lands.

## Process and RPC topology

```text
Codex viewer
    -> remux/codex/narration/*
    -> Codex compatibility proxy
    -> remux/narrate/narration/*
    -> Narrate pipeline
         -> remux/codex/inference/structured/generate
         -> Codex app-server runtime
         -> remux-compute Kokoro task
```

Extension stdio is duplex JSON-RPC. An extension may emit a request with a
string or numeric id; Remux routes only namespaced `remux/<extension>/...`
methods and writes the correlated result or error back to the caller's stdin.
The host allows at most 32 concurrent outbound calls per extension and applies
a five-minute deadline. `remux-extension-rpc` supplies extension-side
correlation with the same bounded-pending design.

Host-issued requests use numeric IDs and extension-issued requests use their
own string or numeric IDs. The protocol reader classifies those domains
explicitly: extension-originated calls are never broadcast to viewers, and a
correlated result is written only to the calling extension. Integration tests
cover success, remote errors, disallowed core routes, target unavailability,
and target restart; unit tests cover correlation and overload rejection.

No RPC permissions are added to extension manifests. Extensions are trusted
code; the host boundary exists for lifecycle, overload containment, and
correct request correlation rather than authorization between first-party
extensions.

## Narrate API

- `remux/narrate/narration/start` starts or reuses the artifact identified by
  source document, message revision, planning profile, and synthesis profile.
- `remux/narrate/narration/resources/read` returns the current revision,
  status, stage, progress, available segments, compatibility audio chunks,
  available duration, and final manifest. `knownRevision` supports unchanged
  reads. Every available segment is immutable and includes its audio
  descriptor plus the exact units and cues needed for synchronized playback.
- `remux/narrate/narration/audio/read` returns one published WAV chunk. A
  chunk is readable as soon as it appears in `availableChunks`; completion of
  the entire artifact is not required.
- `remux/narrate/narration/cancel` cancels active Codex planning operations and
  the managed native synthesis task.
- `remux/narrate/narration/diagnostics/read` exposes bounded recent planning
  and synthesis diagnostics.
- `remux/narrate/narration/updated` invalidates one artifact resource.

The wire contract intentionally publishes immutable audio chunks rather than
an append-mutated media file or HLS playlist. This gives playback an HLS-like
progressive experience without a media server, range-request coordination, or
partially valid WAV files. Native synthesis publishes roughly 15-second
chunks in playback order while later work is still running.

## Structured inference gateway

Narrate supplies the instructions, compact block input, and output schema.
Codex supplies app-server mechanics through:

- `remux/codex/inference/structured/generate`
- `remux/codex/inference/structured/cancel`

The gateway is deliberately domain-neutral and closed: ephemeral threads,
read-only sandbox, no tools, web, apps, plugins, skills, or dynamic tools,
bounded request/output sizes, four active operations, and a four-minute turn
deadline. It validates the model, effort, service tier, and exactly one
authoritative agent message before returning parsed JSON.

Narrate currently partitions transformed Markdown into at most 20 blocks or
4,000 UTF-16 code units per planning call and runs up to three calls at once.
The first planning failure closes registration for later batches, preserves
the original error, and cancels every registered sibling operation. The
prompt, schema, batching policy, and cache identity all live in Narrate.

Structured inference cancellation is durable across lifecycle races. The
gateway records cancellation before thread or turn IDs may exist, checks it
before and after every app-server start boundary and while waiting for output,
and interrupts a turn discovered after cancellation. Global app-server
disconnects terminate every subscribed operation without requiring a thread
ID on the event.

## Storage and versioning

Completed artifacts live under:

```text
$REMUX_ROOT/.remux/cache/narrate/v1/<artifact-key>/
```

Generation uses a temporary sibling directory. Audio chunks are published
from that staging directory, then the complete directory is atomically
promoted. Reads tolerate the narrow promotion/state-update race by following
an already-published chunk to the final directory.

Each progressive publication writes and validates the WAV, atomically writes
an immutable segment sidecar containing the segment index, audio descriptor,
units, and cues, and only then emits `segmentReady`. The final manifest is
assembled from those exact segments and validation proves that they partition
the final units and cues without gaps or substitutions. Manifest version 3
and native task version 4 prevent older partial-segment artifacts from being
reused.

Terminal transitions are centralized. Failure and cancellation clear planning
operation IDs, progressive segments, progress counters, and staging
references, and remove the temporary directory. A repeated `start` joins an
active job, reuses a ready artifact, or replaces a failed/cancelled job with a
fresh run. If cancellation races after atomic promotion, the complete valid
artifact wins and the job becomes ready; before promotion, cancellation leaves
no published artifact.

Narrate resolves native assets from
`$REMUX_ROOT/.remux/models/narrate/<model-version>`. It may read the former
Codex model location as a compatibility fallback; new artifacts and ownership
do not depend on that legacy path. Prompt, source-mapping, synthesis-option,
and native task versions participate in cache identity, so behavior changes
regenerate rather than silently reuse incompatible artifacts.

## Deferred viewer work

This pass rebrands the Markdown extension to Narrate and moves the server
ownership, but does not redesign its file viewer. A future long-document mode
can add skip policies and consume the same progressive resource contract. It
should add a new Narrate request profile rather than teach Codex's gateway
about Markdown or narration semantics.
