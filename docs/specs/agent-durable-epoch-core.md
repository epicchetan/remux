Status: Active Spec
Last verified: 2026-08-07
Canonical code: Phase 0 and the automated Phase 1A.0 UI foundation live in `extensions/agent/`; Phase 1A.0 owner acceptance and the durable core described here remain open

# Agent durable epoch core

This is the implementation spec for the next Remux agent pass. The parent
architecture and product boundaries remain normative in
[`agent-runtime-and-epoch-context.md`](agent-runtime-and-epoch-context.md).
This document turns its former all-at-once “core loop” into independently
testable checkpoints. UI delivery and owner-review timing are further defined
by
[`agent-ui-parity-and-phased-delivery.md`](agent-ui-parity-and-phased-delivery.md).

The outcome is an operationally unbounded conversation: the complete useful
history remains durable and inspectable while every provider inference sees a
small, deterministic, cache-stable view. “Unbounded” describes the journal and
runtime, not a literal infinite model prompt. There is no compact button and no
model-written summary on the hot path.

## Decision summary

- Phase 0 was sealed by the owner with the real OAuth/model/restart smoke test
  on 2026-08-07, before committing a durable schema.
- Port the stable Codex UI foundation before durable storage, then activate
  parity capability-by-capability with the Agent protocol. UI parity is a
  continuous constraint, not late cutover cleanup.
- Use SQLite plus immutable content-addressed artifacts. The journal is the
  source of truth; Remux resources, transcript windows, runtime inventories,
  and prompts are projections.
- Prove journal replay and a shadow context compiler before changing what the
  model sees.
- Run context preflight before **every** provider inference, including the
  inferences after tool results inside one user turn. A turn may cross any
  number of epochs.
- Activate rollover while the tool surface is still read-only. Only then add
  filesystem mutation and finite shell execution.
- Add durable long-lived processes last. They run through a reconnectable
  process host inside a declared Remux persistent workload; a raw child PID or
  inherited stdio pipe is not durable identity.
- Keep the existing Codex extension as an explicit comparison target until the
  new agent passes realistic task comparisons. There is no runtime fallback.
- Do not import Phase 0 conversations or old Codex history. Sanitized old
  transcripts may become evaluation fixtures, never product state.

## What happens next

```text
Phase 0A       Phase 1A.0          Phase 1A.1–1A.3       Phase 1B
live seal  ->  UI foundation  ->   journal + replay  ->  active epochs
  complete      code complete       + shadow compiler    + forced rollover
                owner gate open
                                                               |
                                                               v
Phase 1D       Phase 1C.4          Phase 1C.1–1C.3
processes  <-  interaction UI  <-  reads + patch + finite shell
+ paired A/B    parity              + operation recovery
```

Each arrow is a stop/go gate. A failure changes the design at that boundary;
it is not papered over by starting the following slice.

### Phase 0A — acceptance seal

**Gate state: owner-completed on 2026-08-07.**

This phase adds no architecture. It validates the implementation already in
`extensions/agent/` against the real Remux supervisor and the owner's
subscription:

1. Rebuild and restart Remux so extension discovery sees `agent` while the
   existing `codex` extension remains available as a separate baseline.
2. Complete device-code login in the Agent viewer and list only entitled
   `openai-codex` models.
3. Start a conversation, confirm the selected model/reasoning values, and ask
   the model to read a known workspace file with `workspace.read`.
4. Interrupt an active turn and verify one terminal turn state with no later
   streaming mutations.
5. Disconnect and reconnect the viewer while the server-owned conversation is
   alive.
6. Restart the Agent extension. Confirm the Phase 0 conversation is explicitly
   unavailable, the credential remains usable, and the new
   `serverGeneration` prevents stale resource reuse.
7. Sign out and verify the credential is no longer usable.
8. Audit browser resources, logs, and process arguments for tokens and verify
   the Agent extension starts no App Server, generic OpenAI API-key, or
   non-Codex provider process. An already-running baseline Codex App Server is
   attributed separately.

The run records a short, redacted acceptance report in this spec or a linked
fixture. A failure at OAuth, the context hook, custom tools, interruption, or
resource recovery would have blocked Phase 1A. The owner's completion of this
gate authorizes planning the next checkpoint; it does not by itself authorize
starting all of Phase 1.

### Phase 1A.0 — UI port foundation

Before durable storage changes, copy the selected stable Codex viewer
subsystems into the Agent viewer and adapt them to the existing ephemeral
Phase 0 protocol. This checkpoint preserves transcript layout,
virtualization/scrolling, Markdown, work rows, composer behavior, lifecycle,
and responsive styling while removing narration and every other deliberate
product exclusion. It does not add database state, history, context rollover,
effectful tools, steering/queueing, edit, or fork.

The delivery policy is normative in
[`agent-ui-parity-and-phased-delivery.md`](agent-ui-parity-and-phased-delivery.md).
The exact source closure, protocol frames, tests, and owner-review gate for
this checkpoint are in
[`agent-phase-1a0-ui-port-scope.md`](agent-phase-1a0-ui-port-scope.md).

Exit gate: the copied viewer matches the existing Codex UI behavior for the
Phase 0 feature set on desktop and phone, its fixture tests pass, and the owner
approves proceeding to durable state.

### Phase 1A.1–1A.3 — durable journal, replay, and shadow compiler

These checkpoints change persistence but deliberately do not activate
rollover. They land durable conversations/history, authoritative transcript
windows/work details, and then the shadow compiler/context inspector in that
order.

The exact proposed 1A.1 storage, replay, recovery, protocol, history UI, and
acceptance boundary is in
[`agent-phase-1a1-durable-history-scope.md`](agent-phase-1a1-durable-history-scope.md).

Required behavior:

- Create, list, reopen, and continue durable conversations.
- Persist canonical user, assistant, reasoning-summary, tool-call, tool-result,
  turn, and inference events before publishing their resource projections.
- Rebuild every materialized resource from a journal prefix and obtain the
  same canonical hash.
- Supply Pi with an exact full replay of the current logical conversation via
  the existing `context` hook. Only short runs are accepted; if replay plus
  reserve would exceed the hard budget, the turn stops before provider I/O
  with `context_rollover_not_enabled`.
- Compile an epoch candidate and prompt manifest in shadow mode after every
  completed inference/tool boundary. Shadow output is stored and inspected but
  does not alter the provider input.
- On extension restart, close any nonterminal turn as
  `interrupted_by_restart`. Do not silently repeat a provider call or effect.
- Replace the Phase 0 in-memory resource store with durable resource
  projections. Phase 0 conversations disappear; there is no migration.

The ported UI foundation remains in use throughout: 1A.1 activates durable
conversation list/new/open/history, 1A.2 activates authoritative transcript
windows and work details, and 1A.3 adds the developer-only shadow manifest
inspector. Steering/queueing, edit/fork, mentions, and attachments activate
with their server semantics in 1C.4 rather than being deferred to a bulk UI
phase.

Exit gate: deterministic replay, crash injection, resource revision, and
shadow-manifest tests pass. A live short conversation survives an extension
restart and can be continued in a fresh provider chain.

### Phase 1B — active epoch rollover

Phase 1B makes the shadow compiler authoritative while the only workspace
tool remains read-only.

Required behavior:

- Run preflight in Pi's `context` hook before every inference, not merely once
  per `session.prompt()` call.
- Keep logical input byte-prefix-stable inside an epoch.
- Roll at a committed inference/tool boundary when the next input would exceed
  policy. Never roll during an assistant stream or while an effect has an
  ambiguous result.
- Replace prior raw messages with one deterministic epoch bootstrap message
  plus an empty hot trace. The same user-visible turn then continues.
- Clear provider continuation at the new epoch. The first request must be a
  full request with no prior `previous_response_id`.
- Expose `context.status`, `context.manifest`, `context.pull`, and
  `context.pin` alongside `workspace.read`. These mutate only journaled context
  state and let the model inspect/recover exact sources while workspace and
  shell effects remain absent.
- Force many tiny-budget rollovers in fixtures, including a rollover after a
  tool result in the middle of one user turn.
- On extension restart, always open a recovery epoch rather than pretending
  the former provider transport chain survived.

Exit gate: manifests reproduce every logical input, prefix assertions hold
within epochs, transport telemetry proves a full request at rollover, and
forced-rollover tasks retain their required facts. If public Pi cannot enforce
or observe the transport reset, stop and add the smallest pinned Pi patch
before Phase 1C.

### Phase 1C.1–1C.4 — fixed coding effects and interaction parity

Phase 1C is delivered as owner-reviewed checkpoints: bounded reads/search and
artifact views (1C.1), patch/diff semantics (1C.2), finite shell execution
(1C.3), and steer/queue/edit/fork/mentions/attachments (1C.4). The effectful
checkpoints add a deliberately fixed tool vocabulary:

- `workspace.read`
- `workspace.search`
- `workspace.patch`
- `shell.run`
- `runtime.status`, `runtime.list`, `runtime.read`, `runtime.changes`
- the Phase 1B `context` tools

Provider-facing tool names use underscores when required by the provider
(`workspace_read`); Remux protocol, transcript, and documentation names remain
dotted. Tool schemas and ordering are versioned and stable for cache reuse.

Every effect has a stable operation ID, is accepted in the journal before
execution, and reaches exactly one terminal durable state. Retrying the same
ID with the same arguments returns the existing state/result; reusing it with
different arguments is a conflict. Large output is an artifact plus a bounded
observation, never an oversized model message.

Exit gate: mutation/path safety, bounded-output, interruption, and crash
recovery tests pass with no duplicate effects. Multi-epoch implementation
fixtures can edit a workspace and run finite tests without manual compaction;
the included interaction controls pass their protocol and UI parity gates.

### Phase 1D — durable process runtime and evaluation release

Phase 1D adds:

- `process.start`, `process.list`, `process.read`, `process.write`,
  `process.interrupt`, and `process.terminate`;
- stable logical process identity independent of PID, extension generation,
  conversation prompt, and viewer lifetime;
- persistent output spooling and reconnectable control;
- restart reconciliation using process metadata and Remux workload state; and
- the realistic comparison suite against the existing Codex/App Server agent.

This is the first point at which the agent is suitable for multi-hour Remux and
Ledger implementation work. Phase 1 is complete only when Phase 1D's recovery
and comparison gates pass.

## Runtime and ownership boundaries

The Agent extension remains one Node/TypeScript server embedding Pi 0.84.0.
Pi owns the provider adapter, OAuth, model serialization, streaming, and inner
tool loop. Remux owns all durable state, prompt assembly, tools, processes,
resources, and UI protocol.

The implementation must preserve these boundaries:

- `SessionManager.inMemory()` remains in use. Pi JSONL is not a second source
  of history.
- Pi compaction, retries, built-in tools, skills, prompt templates, context
  files, analytics, and package discovery remain disabled.
- Phase 1 keeps at most one loaded Pi session: the currently open
  conversation. It remains alive across turns and viewer reconnects so its
  provider cache chain can be reused. Other durable conversations are journal
  data, not dormant Pi sessions.
- Switching conversations disposes the former Pi session. Opening an existing
  conversation reconstructs a fresh session from the durable logical view and
  opens a recovery epoch. It never restores a provider response ID from disk.
- At most one model turn runs per strand. Reads may be concurrent; journal
  commits and materialization use one ordered writer.
- Credentials stay in Pi's locked `~/.pi/agent/auth.json`. Agent data never
  duplicates them.

The supported extension runtime for this pass is Node 24.x; the current host
is Node 24.18.0 and exposes `node:sqlite`. Startup checks this capability before
opening or migrating data. An unsupported runtime fails clearly. It does not
silently switch database engines.

## Durable storage

### Data root

Resolve the data root in this order:

1. `REMUX_AGENT_DATA_DIR`, for tests and explicit deployments;
2. `$XDG_DATA_HOME/remux/agent` when `XDG_DATA_HOME` is nonempty; or
3. `<os.homedir()>/.local/share/remux/agent`.

Layout:

```text
agent/
  agent.sqlite3
  artifacts/
    sha256/ab/abcdef...       immutable raw bytes
  process-hosts/
    <process-id>/
      descriptor.json        atomic public recovery descriptor
      stdout.log              append-only spool
      stderr.log              append-only spool
      control.sock            live local control endpoint
  tmp/                        same-filesystem staging only
```

The root and process-host directories are mode `0700`; database, descriptors,
and artifacts are `0600`. Artifact hashes are lowercase SHA-256 hex. Temporary
files never become model-visible handles.

### SQLite discipline

Use `node:sqlite` `DatabaseSync` behind an async repository interface. Calls
are synchronous but transactions are short: no filesystem scans, model calls,
process waits, hashing of large files, or artifact writes occur while a
transaction is open.

On every connection:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

There is one writable connection in the extension process. Schema version is
stored in `PRAGMA user_version`; forward migrations are transactional and
covered by fixture upgrades. The server refuses a database newer than its
supported schema. There is no down migration in Phase 1.

### Minimum schema

Names below are normative; columns may gain indexes or non-semantic metadata
without revising the protocol.

```text
meta(
  key PRIMARY KEY, value_json
)

conversations(
  conversation_id PRIMARY KEY, title, cwd, model_id, reasoning,
  head_strand_id, state, created_at, updated_at
)

strands(
  strand_id PRIMARY KEY, conversation_id, parent_strand_id NULL,
  forked_from_sequence NULL, state, created_at
)

events(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id UNIQUE, conversation_id, strand_id, turn_id NULL,
  type, actor, visibility, causal_event_id NULL, operation_id NULL,
  payload_json NULL, artifact_hash NULL, created_at
)

transcript_items(
  item_id PRIMARY KEY, conversation_id, strand_id, turn_id,
  first_sequence, last_sequence, kind, status, value_json
)

resources(
  resource_key PRIMARY KEY, basis_sequence, value_json, updated_at
)

operations(
  operation_id PRIMARY KEY, conversation_id, strand_id, turn_id,
  kind, arguments_hash, state, accepted_sequence,
  terminal_sequence NULL, result_artifact_hash NULL, value_json
)

artifacts(
  hash PRIMARY KEY, byte_length, media_type, created_sequence,
  storage_path, redaction_state
)

epochs(
  epoch_id PRIMARY KEY, conversation_id, strand_id, ordinal,
  state, policy_version, opened_sequence, closed_sequence NULL,
  close_reason NULL, bootstrap_artifact_hash, basis_sequence
)

epoch_blocks(
  epoch_id, ordinal, block_hash, kind, source_json,
  estimated_tokens, artifact_hash, PRIMARY KEY(epoch_id, ordinal)
)

inferences(
  inference_id PRIMARY KEY, conversation_id, strand_id, turn_id,
  epoch_id, ordinal, basis_sequence, state, request_mode,
  manifest_artifact_hash, input_hash, estimated_input_tokens,
  reported_input_tokens NULL, reported_output_tokens NULL,
  started_sequence, terminal_sequence NULL
)
```

`strands` exists now so event and epoch identity will not change when fork/edit
arrives later. Phase 1 creates exactly one root strand and exposes no fork API.

`sequence` is the single committed ordering cursor. Resource revisions are
their `basis_sequence`, not an in-memory counter. `serverGeneration` remains a
separate random boot identity used to fence stale browser state.

### Journal and projections

The event log is append-only. The initial event taxonomy is also fixed:

- `conversation.created`, `conversation.updated`;
- `turn.accepted`, `turn.started`, `turn.completed`, `turn.interrupted`,
  `turn.failed`;
- `message.user`, `message.assistant.started`,
  `message.assistant.delta`, `message.assistant.completed`;
- `tool.called`, `tool.updated`, `tool.completed`;
- `operation.accepted`, `operation.started`, `operation.succeeded`,
  `operation.failed`, `operation.interrupted`, `operation.unknown`;
- `epoch.opened`, `epoch.closed`;
- `inference.started`, `inference.completed`, `inference.failed`; and
- `recovery.observed`, `runtime.changed`, `context.pinned`.

Assistant streaming deltas are coalesced before commit at the earlier of
50 milliseconds or 8 KiB. A completed message has a terminal event even when
its last delta is empty. The viewer consumes materialized transcript items; it
does not infer terminal state from a quiet stream.

An event payload is at most 32 KiB of canonical JSON. Larger exact bytes are
installed as an artifact and referenced by hash. Secret redaction occurs
before journal ingestion. A raw provider request, OAuth credential, bearer
header, or complete environment never enters the journal.

For each logical transition, one transaction appends the event or event group,
updates every affected projection and operation state, and advances resource
revisions. Resource invalidations are emitted only after commit. Replaying
events `[1, N]` into an empty projection database must yield the same canonical
projection hash as the live database at `N`.

### Canonical logical messages

The journal persists a versioned `LogicalMessageV1`, not a viewer transcript
row and not a raw provider payload:

```ts
type LogicalMessageV1 =
  | { role: 'user'; content: LogicalContent[] }
  | { role: 'assistant'; content: LogicalContent[]; stopReason?: string }
  | {
      role: 'toolResult';
      toolCallId: string;
      toolName: string;
      content: LogicalContent[];
      isError: boolean;
    };

type LogicalContent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text?: string; opaque?: string }
  | { type: 'toolCall'; id: string; name: string; argumentsJson: string }
  | { type: 'artifact'; hash: string; mediaType: string; projection: string };
```

Canonicalization uses UTF-8, LF newlines, sorted object keys, decimal integers,
and no volatile timestamps. Tool argument JSON is canonicalized before
hashing. Pi/provider round-trip fields required to continue the current epoch
may be retained as `visibility=restricted`; they are never shown in the UI,
embedded in a snapshot, or relied upon after rollover. Visible reasoning
summaries may be displayed and journaled. Opaque/encrypted reasoning remains
restricted and is not semantic state.

This gives two recovery levels:

- within a live epoch, Pi keeps its native in-memory messages and restricted
  round-trip fields, while Remux independently hashes the equivalent logical
  sequence; and
- after restart or rollover, Remux reconstructs from durable visible messages,
  tools, artifacts, and materialized state. It never needs hidden reasoning or
  a previous provider response ID.

If a Pi upgrade changes message conversion, the pinned converter version is
part of `policyVersion`; fixtures must be re-recorded deliberately.

### Artifact commit protocol

Artifact installation happens before the referencing database commit:

1. Stream bytes to `tmp/<uuid>` while hashing and enforcing the byte cap.
2. Flush and `fsync` the temporary file.
3. Create the hash prefix directory if required.
4. Atomically rename to `artifacts/sha256/<prefix>/<hash>`. If it already
   exists, verify size and discard the temporary copy.
5. Commit the event plus `artifacts` row that references the installed file.

A crash before step 5 may leave an unreferenced immutable file; startup
reconciliation records it as an orphan. A database reference to a missing or
wrong-sized artifact is corruption and blocks model continuation with a clear
diagnostic. Garbage collection and retention are outside Phase 1.

## Context compiler

### Compiler inputs and output

The compiler is a pure function over:

```text
(journal prefix, materialized resources, policy version, model profile,
 fixed system/tool contracts, current epoch, pending logical input)
  -> (ordered logical messages, ordered blocks, prompt manifest, decision)
```

`decision` is `append`, `roll`, or `blocked`. Given the same artifact bytes and
inputs, it must produce byte-identical blocks and hashes on another process.
Wall-clock time, random IDs, process PIDs, temporary paths, and live unordered
directory iteration cannot affect rendering.

### Block encoding

The system prompt and tool schemas stay in Pi's fixed provider positions.
Remux owns two message regions:

```text
epoch bootstrap  one harness-authored user message, immutable for the epoch
hot trace        exact normalized messages appended since epoch open
```

The bootstrap has versioned ASCII delimiters and source references:

```text
<remux_epoch version="1" epoch="7" basis_sequence="18422">
<continuation>...</continuation>
<authority>...</authority>
<open_work>...</open_work>
<workspace>...</workspace>
<runtime>...</runtime>
<raw_tail>...</raw_tail>
<retrieval_map>...</retrieval_map>
</remux_epoch>
```

Source references use event sequence, resource revision, and artifact hash.
Snapshot prose is generated only by fixed renderers. It never says that an
inference, test, process, or file is current unless the source projection says
so. Raw-tail selection walks backward over complete logical turns until the
budget is full, then renders the selected turns in chronological order. It
never reverses dialogue, cuts a message, or separates a tool call from its
result.

### Full replay in Phase 1A

Phase 1A's active message region is the exact durable logical replay. The
compiler separately produces the bootstrap it would use at that boundary and
stores a shadow manifest. This lets the tests compare:

- active full-replay input;
- proposed bootstrap + hot trace;
- facts included, omitted, and retrievable; and
- estimated size and build latency.

No shadow output can affect the live prompt.

### Preflight and token policy

Preflight runs synchronously in the Pi `context` hook before every inference:

```text
estimated_input = fixed_overhead + estimate(bootstrap + hot trace + pending)
limit = min(150_000, model_context_window - output_reserve)

append when estimated_input + safety_margin <= roll_threshold
roll   when a deterministic snapshot can fit under limit
block  when mandatory input cannot fit even after externalization
```

Defaults:

```text
output reserve       25,000 tokens
safety margin         5,000 tokens
roll threshold      120,000 estimated input tokens
hard input limit    150,000 estimated input tokens
snapshot target      12,000–18,000 tokens
snapshot hard max    30,000 tokens
```

Estimation uses the pinned Pi `estimateTokens` result and a conservative UTF-8
byte estimate; the larger value wins. Fixed system/tool overhead is cached by
model/tool-schema version. Reported provider usage is stored and may only
increase the model-profile safety multiplier. It never retroactively changes
an existing manifest. The final provider-request hook asserts the policy and
aborts before network I/O if serialization reveals an unexplained overrun.

Tests may set a tiny threshold to force epochs. Production may tune thresholds
by versioned model profile, but no call may exceed the 150k hard input policy.

### Mid-turn rollover

One user turn can use the whole window. Rollover therefore occurs at this
sequence:

```text
assistant emits tool call
  -> journal tool call
  -> accept/run tool operation
  -> journal terminal result + bounded observation
  -> Pi requests its next inference
  -> context hook runs preflight
  -> close old epoch and open new epoch if required
  -> return bootstrap + empty hot trace to Pi
  -> provider receives a full request
  -> assistant continues the same Remux turn
```

The closed tool call/result pair is represented by the snapshot's state and
continuation; an orphan `toolResult` is never placed in the new hot trace. If
an effect is `running` or `unknown`, rollover waits until it is durably
terminal or renders the ambiguity as mandatory open work. It never guesses.

The bootstrap is user-role harness context because provider protocols do not
offer an arbitrary durable memory role. It clearly labels itself as Remux
state, includes the unserved user request and last completed action, and asks
the model to continue rather than restart the task.

### Active rollover transaction

Rollover does not hold the database transaction while compiling:

1. Read a stable journal basis sequence and compile candidate artifacts.
2. Recheck that no newer boundary event invalidates the candidate.
3. Install the bootstrap and manifest artifacts.
4. In one transaction, close the current epoch, append `epoch.closed`, open the
   next epoch, attach its ordered blocks, and append `epoch.opened` at the same
   committed basis.
5. Publish context-resource invalidation after commit.
6. Return the new logical message list from the context hook.

If step 2 fails, advance/recompile. If the process crashes before step 4, the
old epoch remains authoritative. If it crashes after step 4 but before the
provider call, recovery closes the unused epoch with a recovery reason and
opens another epoch. It may reuse the byte-identical bootstrap artifact, but
the epoch identity and provider chain are new.

### Provider continuation rule

Within an epoch, logical input inference `N+1` must be the exact byte prefix of
`N` plus appended messages. At rollover or process recovery, this invariant
starts over.

`before_provider_request` records only a sanitized request mode and hashes:

- `full`: no `previous_response_id`;
- `continuation`: a prior response ID exists and only an append suffix may be
  transported; or
- `unknown`: the pinned Pi version cannot prove either.

The first inference in every epoch must be `full`. `continuation` at that
boundary is a correctness failure, not a performance warning. If the public Pi
hooks cannot reset the cached websocket after the `context` hook returns a
non-prefix message list, Remux patches/vendors that exact seam and pins the
patch. Phase 1C does not proceed while mode is `unknown` at rollover.

### Prompt manifest

Every inference stores one immutable manifest artifact containing:

```ts
type PromptManifestV1 = {
  inferenceId: string;
  epochId: string;
  basisSequence: number;
  policyVersion: string;
  piVersion: '0.84.0';
  provider: 'openai-codex';
  modelId: string;
  requestMode: 'full' | 'continuation' | 'unknown';
  fixedContractsHash: string;
  orderedMessageHashes: string[];
  orderedBlocks: Array<{
    kind: string;
    hash: string;
    estimatedTokens: number;
    sources: string[];
  }>;
  omissions: Array<{
    source: string;
    reason: string;
    retrieval: string;
  }>;
  inputHash: string;
  estimatedInputTokens: number;
};
```

The manifest reproduces the exact **logical** input owned by Remux. Exact
provider request bytes, credentials, response IDs, headers, and raw payloads
are neither claimed nor stored. Until Pi provides normalized cache telemetry,
missing cache fields remain absent rather than inferred.

The context hook creates a manifest draft. The async
`before_provider_request` hook derives sanitized request mode from the final
payload, performs the last budget assertion, installs the immutable manifest,
and commits `inference.started` before returning the payload for network I/O.
Provider completion appends terminal inference events and reported usage to the
`inferences` projection; it never mutates the request manifest. A later
immutable receipt artifact may combine manifest hash and terminal metrics for
evaluation.

## Tool and operation contracts

### Common result envelope

All tools return the same outer shape:

```ts
type ToolResult<T> = {
  ok: boolean;
  operationId?: string;
  summary: string;
  data: T;
  artifact?: { hash: string; mediaType: string; byteLength: number };
  truncated: boolean;
  retrieval?: string;
};
```

The model-visible JSON/text projection is capped per the parent spec. Full
exact output is in the artifact. Reducers are pure, versioned functions and
store their version in the tool-result event.

### Context and runtime tools

The Phase 1B context tools operate only on revisioned Remux state:

- `context.status()` returns epoch, basis sequence, pressure, budget, and the
  current/predicted rollover decision;
- `context.manifest(inferenceId?)` returns a bounded manifest projection and
  its artifact handle;
- `context.pull(uri, projection?, cursor?, limit?)` reads a bounded exact
  resource and appends that returned evidence to the current hot trace; and
- `context.pin(uri, expectedRevision, projection?, pinned)` appends a durable
  pin/unpin event. It affects future snapshots and never rewrites the current
  epoch prefix.

A pin is a provenance guarantee, not permission to inject unbounded bytes. The
compiler includes the pinned exact projection when it fits; otherwise it
includes the revisioned source handle plus the largest policy-bounded exact
excerpt and records the omission. Pin reason text is a label, not a substitute
for the referenced source.

Phase 1C runtime tools expose the parent spec's uniform bounded query over
transcript turns, commands, artifacts, file observations, context pins, and,
after Phase 1D, processes. Every URI includes stable logical identity; every
result includes its basis revision and pagination cursor. This is how the model
polls old turns or commands after their raw prose leaves the prompt.

### Workspace tools

- `workspace.read(path, startLine?, lineCount?)` canonicalizes a path beneath
  the conversation workspace, rejects symlink escapes, and returns exact text,
  line range, content hash, truncation, and an artifact when needed.
- `workspace.search(query, paths?, maxMatches?)` uses `rg` with fixed argument
  construction, never a shell string. It returns counts and bounded exact
  matches with a full artifact.
- `workspace.patch(path, mode, expectedHash, patch)` changes exactly one
  regular file per call. `mode` is `create`, `update`, or `delete`; create
  requires the path to be absent, while update/delete require the exact
  expected hash. It rejects symlinks and hash mismatches. Create/update compute
  target bytes before mutation, write a same-directory temporary file, flush,
  rename atomically, and journal before/after hashes. Delete journals the exact
  prior hash and resulting absence. Multiple files use multiple calls, which
  makes crash reconciliation exact.

There is no unrestricted write tool in Phase 1C. A later measurement may
justify one; it is not assumed.

### Finite shell

`shell.run(command, cwd?, timeoutMs?, environment?)` accepts a command string
and runs it with the pinned `/bin/bash -lc` semantics expected by coding-agent
workflows, including pipes, redirection, and compound finite commands. The
exact string, shell version, cwd, and non-secret environment keys are part of
the operation hash and manifest. The working directory stays inside the
workspace. Environment entries use an allowlist and secret values are never
echoed into events.

The command has bounded runtime and output. stdout/stderr stream to artifacts;
the prompt sees status, duration, exit/signal, and bounded diagnostic excerpts.
Backgrounding (`&`, `nohup`, detached children) is unsupported here. A command
that must outlive the call uses `process.start` in Phase 1D.

On extension restart, a nonterminal finite command is marked interrupted. It
is never automatically re-run because its external side effects are unknown.

### Operation recovery

Tool-call operation IDs are derived from conversation, strand, turn, and Pi
tool-call ID. UI command operation IDs are opaque random UUIDs generated once
by the caller. The operation state machine is:

```text
accepted -> running -> succeeded | failed | interrupted | unknown
```

Recovery rules are tool-specific:

- read/search may safely be reissued, but their original observation remains
  tied to its recorded file hashes and sequence;
- patch compares current bytes with recorded before/after hashes: after means
  succeeded, before means not applied, anything else means unknown;
- finite shell becomes interrupted and is not reissued; and
- process start reconnects to the process host or becomes unknown, never
  starts a duplicate host for the same operation.

`unknown` is mandatory snapshot open work and a visible UI state. Only an
explicit user/model action may resolve it.

## Durable processes

A persistent process cannot be represented by `child.pid` plus pipes owned by
the Agent extension: both control and output continuity are lost when the
extension restarts. Phase 1D therefore adds a small `agent-process-host`
sidecar.

For every `process.start`:

1. Journal the operation and allocate a logical `processId`.
2. Atomically write a mode-`0600` descriptor containing process ID, workspace,
   command hash, cwd, created sequence, random control nonce, and expected
   spool paths. Only the nonce hash enters the database/journal.
3. Launch the process host with the stable `REMUX_WORKLOAD_EXEC` launcher:

   ```text
   remux workload exec --workload process \
     --operation agent-process:<processId> -- \
     node process-host.mjs --descriptor <absolute-descriptor-path>
   ```

4. The host creates a Unix socket, starts the child in its own process group,
   spools stdout/stderr, records PID/start ticks/boot ID, and reports `ready`.
5. Only after `ready` does `process.start` succeed.

`process.start(command, cwd?, environment?)` uses the same pinned
`/bin/bash -lc` contract as `shell.run`, but the command must remain in the
foreground. Shell backgrounding or daemonization is unsupported because the
process host, not an untracked descendant, owns lifetime and exit status.

The Agent manifest moves to version 2 and declares:

```json
{
  "resources": {
    "workloads": {
      "process": {
        "class": "interactive",
        "lifetime": "persistent",
        "threads": "auto"
      }
    }
  }
}
```

The socket protocol is local, length-bounded, versioned, and authenticated by
the descriptor nonce. It supports status, bounded output read, stdin write,
interrupt, and terminate. Logs are authoritative spool bytes, not dependent on
an attached viewer or extension. Phase 1D may begin with pipes; PTY semantics
are a separate tool capability and must not be implied.

At startup, the Agent server scans journal-owned nonterminal processes only,
validates descriptor ownership and paths, connects to their sockets, and
cross-checks PID start ticks, boot ID, and Remux workload state. It never adopts
an arbitrary matching PID. Outcomes are `running`, `exited`, `unreachable`, or
`identity_mismatch`; the latter two are not auto-restarted.

Persistent means the process may outlive Remux, so the viewer and `remux
doctor` must expose it. User termination sends the host protocol first and
uses the Remux workload stop operation only as a bounded fallback. The journal
records signal, timeout, and final spool offsets.

## Remux protocol and UI

Phase 0's protocol is preview-only and may break once. Phase 1 uses the same
server-authoritative read/invalidation pattern with durable revisions.

### Methods

```text
remux/agent/resources/read
remux/agent/auth/login/start
remux/agent/auth/login/cancel
remux/agent/auth/logout
remux/agent/models/read

remux/agent/conversation/create
remux/agent/conversation/message/send
remux/agent/conversation/turn/interrupt
remux/agent/artifact/read

# Phase 1D
remux/agent/process/write
remux/agent/process/interrupt
remux/agent/process/terminate
```

Opening/listing is resource reading rather than an effectful `open` command.
`conversation/create` and `message/send` carry caller-stable operation IDs.
Duplicate identical calls return the original conversation/turn ID.

### Resource keys

```text
auth
models
conversation-list
conversation:<conversationId>
transcript:<conversationId>:latest:<limit>
transcript:<conversationId>:before:<sequence>:<limit>
turn:<turnId>
context:<strandId>
manifest:<inferenceId>
operation:<operationId>
process:<processId>
```

Latest transcript windows invalidate on append. A `before:<sequence>` window
is immutable once returned. Limits are from a fixed allowlist so resource keys
cannot create an unbounded cache. Each resource response carries
`basisSequence`, `serverGeneration`, value, and `notModified` support.

`artifact/read` is a command-like bounded read, not a cached resource. It takes
hash plus byte or line range, returns at most the configured cap, and states
the next range. It cannot read arbitrary paths.

### Viewer slices

UI parity is delivered continuously according to
[`agent-ui-parity-and-phased-delivery.md`](agent-ui-parity-and-phased-delivery.md):

- 1A.0 ports the stable transcript, composer, renderer, work-row, lifecycle,
  responsive-layout, and fixture-test foundation onto the Phase 0 protocol;
- 1A.1 activates durable conversation history;
- 1A.2 activates authoritative transcript windows and complete work details;
- 1A.3 activates the shadow manifest/context inspector;
- 1B adds epoch ordinal, pressure, rollover reason, estimated tokens, and
  request-mode diagnostics;
- 1C.1–1C.3 add read/search/artifact, patch/diff, and finite-shell views;
- 1C.4 activates mentions, attachments, steering/queueing, edit, and fork; and
- 1D adds process inventory/control and closes remaining measured parity gaps.

No checkpoint introduces a clickable control before its server semantics.
Every checkpoint retains the existing stable UI behavior already brought over
and passes owner desktop/phone review before the next begins.

The normal conversational surface remains quiet: no mandatory record forms,
workflow classifier, compaction control, or context ceremony. The inspector is
available when needed, not injected into every turn.

## Verification and realistic evaluation

The release decision is not “use it for two weeks and see.” Owner dogfooding is
valuable after deterministic gates, but it is not the only evidence.

### Deterministic fixture corpus

Fixtures use a fake Pi/provider and temporary data root:

1. short brainstorm with no tools;
2. brainstorm → accepted spec excerpt → implementation;
3. one turn with many tool calls crossing several forced epochs;
4. a 400 KiB command result reduced to an artifact and bounded observation;
5. file patch followed by failing then passing tests;
6. accepted constraint and exact source revision surviving multiple epochs;
7. restart with an open turn;
8. crash after artifact rename but before database commit;
9. crash after operation acceptance, during patch rename, and after terminal
   operation commit;
10. restart and reconcile a live process host;
11. corrupt/missing artifact; and
12. zero-record free exploration, proving the harness remains natural without
   explicit workflow structure.

Every fixture can replay from event 1 to any boundary, rebuild projections,
and regenerate manifests. Sanitized historical transcripts may be converted
into this format to add realistic distributions. Conversion is one-way test
data; it does not create a history-import feature.

### Live paired scenarios

Run the existing Codex/App Server extension and new Agent extension from the
same clean git commit, cwd, model, reasoning level, prompt, and prepared
fixtures:

1. explore an unfamiliar area, write a spec, then implement it;
2. freeform architecture exploration with no requested code change;
3. diagnose and fix a failing test;
4. handle a build/test command with very large output;
5. start, inspect, and stop a development server;
6. resume useful work after extension restart and after an idle gap; and
7. obey an old accepted constraint that is no longer in the raw tail.

Each scenario has an outcome rubric: tests, required constraints, forbidden
changes, expected process state, and a blind owner rating. Order is alternated
to reduce learning effects. Five to ten representative owner tasks are enough
for a release decision after deterministic correctness passes; they are not
enough to claim broad statistical superiority.

### Metrics

Collect per inference, turn, and scenario:

- rubric/task success, test result, forbidden changes, owner corrections;
- wall time, time to first token, number of inferences and tool calls;
- estimated and reported input/output tokens;
- cache-read tokens or normalized cache telemetry when the provider exposes
  it; missing telemetry remains missing;
- epoch count, rollover compile latency, rollover continuation failures;
- artifact bytes versus model-visible bytes;
- retrieval calls and whether retrieved evidence was useful;
- facts later judged necessary that were omitted and never retrieved;
- manifest reproduction and prefix-stability results; and
- crash/restart recovery result and duplicate-effect count.

### Quantitative gates

- 100% byte-identical projection and manifest rebuild for deterministic
  fixtures.
- 100% exact logical prefix extension between adjacent inferences in an epoch.
- 100% full transport requests at epoch/recovery boundaries.
- Zero provider calls above the configured hard input limit.
- Zero duplicate effects across the crash matrix.
- 100% process identity reconciliation in supported restart cases; identity
  uncertainty is surfaced, never guessed.
- Cheap-path assembly p95 at or below 10 ms on the reference Linux box.
- Rollover compilation p95 at or below 50 ms when all referenced artifacts are
  local and indexed.
- Typical bootstrap 12–18k tokens and always at or below 30k.
- The forced-rollover fixture meets the same task rubric as full replay.
- On the paired owner scenarios, the new agent has no correctness regression
  and shows a credible context/cost or recovery advantage on the cases the
  design targets.

Latency thresholds measure compiler/store work, not provider latency. If a
threshold fails, profile and revise the local path; do not add a model call to
hide it.

## Implementation map

The intended code boundaries are:

```text
extensions/agent/server/src/
  storage/
    data-root.ts
    database.ts
    migrations.ts
    artifact-store.ts
    journal.ts
    projector.ts
  context/
    logical-message.ts
    canonical-json.ts
    estimator.ts
    compiler.ts
    manifest.ts
    policy-v1.ts
  tools/
    workspace-read.ts
    workspace-search.ts
    workspace-patch.ts
    shell-run.ts
    runtime-tools.ts
    context-tools.ts
  process/
    process-manager.ts
    process-protocol.ts
    process-host.ts
  conversation-manager.ts
  pi-runtime.ts
  agent-server.ts
```

Tests are split into storage/replay, compiler golden fixtures, Pi context-hook
integration, operation crash injection, process-host recovery, protocol, and
Playwright UI suites. Production code receives clock, ID source, data root,
process runner, and provider runtime as injected interfaces; deterministic
tests never need network or the owner's credential store.

## Stop/go checklist

| Gate | Must be true before |
| --- | --- |
| Phase 0A live acceptance — completed 2026-08-07 | starting the 1A.0 UI foundation port |
| Phase 1A.0 UI parity foundation | creating the durable schema |
| Phase 1A.1–1A.3 replay + shadow determinism | activating rollover |
| Phase 1B context and transport reset | adding effectful tools |
| Phase 1C.1–1C.4 idempotency, recovery, and interaction parity | adding persistent processes |
| Phase 1D recovery + paired evaluation | default-launcher cutover |

## Explicitly deferred

- model-writable records and acceptance workflow;
- semantic retrieval, embeddings, background annotators, and learned pruning;
- artifact retention/garbage collection;
- PTY/terminal emulation for durable processes;
- migration/import of Phase 0 or Codex/App Server history; and
- every deliberate product exclusion in the parent spec.

These are not prerequisites for proving the context architecture. Included UI
parity—such as steering/queueing, edit/fork, mentions, and attachments—is
scheduled in 1C.4 rather than deferred. Fork-ready identity and source
provenance are stored earlier so that checkpoint does not require rewriting
the journal.

## Remaining implementation questions

Only these questions may change local details without reopening the design:

1. Whether `node:sqlite` throughput on the reference box needs a dedicated
   writer worker after measurement; the schema and transaction semantics do
   not change.
2. The exact visible reasoning-summary fields Pi exposes for the pinned Codex
   model; opaque fields remain restricted regardless.
3. Whether the Pi continuation reset is sufficient at 0.84.0 or needs the
   already anticipated minimal patch.
4. The initial fixed transcript window limit allowlist.
5. Whether process stdin without PTY covers the first Ledger/Remux server
   workflows; PTY support remains a measured follow-up.
