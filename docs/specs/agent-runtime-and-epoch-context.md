Status: Active Spec
Last verified: 2026-08-07
Canonical code: Owner-accepted Phase 0 and the automated Phase 1A.0 UI foundation are in `extensions/agent/`; Phase 1A.0 live owner acceptance, durable journal, epochs, coding tools, and process runtime remain open

# Agent runtime and epoch context

A Remux-native agent harness where the session is stored losslessly outside
the prompt and every model call receives a small, cache-stable, bounded view.
No manual compaction, no summary stacking, no context anxiety.

This is a single-provider product. It uses the owner's ChatGPT/Codex
subscription through Pi's `openai-codex` provider. It does not use Codex
app-server, `codex exec`, the OpenAI API-key surface, Anthropic, or an
automatic provider/model fallback.

The whole design answers one question:

> **What exactly is in the prompt for inference N, and how did it get there?**

Everything else — journal, artifacts, resources, records — exists only to
make that answer cheap, small, and reproducible.

## Operating assumptions

- **One provider: Codex subscription through Pi.** The only model provider is
  Pi's `openai-codex` provider authenticated with the owner's ChatGPT
  subscription. Models may be selected only from that provider's available
  subscription catalog. There is no Anthropic adapter, generic OpenAI API
  adapter, API-key fallback, or automatic model rerouting. A quota or auth
  failure is reported as such and never changes providers.
- **Pi is the harness kernel, not a subprocess-shaped vendor agent.** Remux
  embeds `@earendil-works/pi-coding-agent` and uses Pi's `AgentSessionRuntime`,
  `ModelRuntime`, tool loop, streaming events, provider serialization, and
  extension hooks. Remux owns the journal, context compiler, runtime tools,
  UI protocol, and recovery semantics. Pi's built-in compaction and session
  history are not authoritative.
- **The existing Remux UI is product code.** We port or copy the current Codex
  viewer's composer, transcript, thread list, streaming, virtualization, and
  resource-store code into a provider-neutral agent viewer. The viewer talks
  to Remux resources and commands; it never talks to Pi or a provider
  directly. Porting code does not imply carrying every Codex feature.
- **Small context beats big context.** Models degrade well before their
  maximum window. Regardless of a 200k–400k limit, every call targets a hard
  input budget of **~150k tokens, and smaller is better**. We optimize for
  the minimum sufficient view, not the maximum permissible one.
- **The models are excellent tool users.** Give them a lean exact view plus
  retrieval tools and they recover what they need. The harness squeezes
  context; it does not scaffold reasoning, classify workflow, or predict what
  the model wants next.
- **Remux owns execution policy.** The extension runs inside the existing
  configured Linux/Remux environment. Fixed tools execute through Remux's
  workspace and process boundaries; there is no model-side "auto" classifier
  deciding which calls are local, remote, or privileged. Operations outside
  that configured boundary fail; there is no model-driven approval or
  elicitation protocol.
- **Storage is only as rich as assembly needs.** The journal and derived
  state exist to build prompts, recover after restarts, and let the model and
  user inspect history. Nothing is stored for its own sake.
- **Single trusted owner, local machine.** Remux's trust model; no hostile-
  code sandboxing claims.

## Chosen architecture

```text
Remux agent viewer (ported from the current Codex viewer)
  -> Remux WebView IPC / websocket
  -> new `agent` extension server (Node/TypeScript)
       -> journal + artifacts + resources + epoch compiler
       -> embedded Pi AgentSessionRuntime
            -> fixed Remux tools + context/result hooks
            -> Pi ModelRuntime (`openai-codex` only)
            -> ChatGPT/Codex subscription transport
```

The extension server embeds the Pi SDK in-process. `pi --mode rpc` is useful
for a spike or protocol fixture, but it is not the target architecture: a
TypeScript server can use `AgentSession` directly, avoid a second subprocess
protocol, and reach the context, tool-result, request-payload, auth, and event
surfaces without projection loss.

The new extension is developed alongside the current `codex` app-server
extension so the latter remains a baseline for replay and live comparison.
There is no runtime fallback between them. At cutover, the normal Codex/agent
launcher targets the new extension and app-server lifecycle management is
removed from the shipping path. The old extension may remain temporarily as
an explicitly launched evaluation fixture, then is archived or deleted.

Pi is pinned to an exact package version and lockfile. We prefer public Pi
SDK and extension seams. If a required boundary is missing — for example,
observing the final websocket continuation payload or rotating cache affinity
at an epoch boundary — Remux carries a small tested Pi patch or vendored fork.
We do not preserve unused provider abstraction merely to ease hypothetical
future support.

## Deliberate product exclusions

This is not a reimplementation of every Codex product feature. Unless this
spec is explicitly superseded, the new agent does **not** ship:

- Codex review mode;
- Codex speed or service-tier controls;
- detailed subscription quota, credit, or reset-time UI (plain auth, rate,
  and exhausted-usage errors remain visible);
- App Server approval or elicitation request/response shapes;
- import or display of existing Codex rollout/history files;
- collaboration, subagent, or delegated-agent events and controls;
- first-class web search, browsing, or research integrations; or
- narration, speech generation, playback, or transcript highlighting.

These are exclusions, not a deferred parity backlog. The new extension has no
dormant controls, compatibility types, generated App Server schemas, or
feature flags for them. The old `codex` extension may exercise some of these
only while it exists as a separately launched evaluation baseline. Normal
sandboxed shell/network behavior is unchanged, but the harness exposes no
dedicated web or research tool.

## Authentication and entitlement

The ChatGPT subscription is not a general OpenAI API entitlement. Remux uses
Pi's provider-owned OAuth implementation for provider ID `openai-codex`; it
does not read an API key or use the separately billed generic OpenAI API
endpoint.

- The extension creates one server-side `ModelRuntime`. By default it uses
  Pi's locked credential store at `~/.pi/agent/auth.json`, so a prior Pi login
  is immediately available and refreshes are shared safely. A Codex CLI login
  in `~/.codex` is separate and is neither copied nor parsed.
- Auth status is a server resource with only non-secret state:
  `signed-out | authenticating | ready | expired | error`, provider ID, and a
  safe display label. Access and refresh tokens never enter the viewer,
  journal, logs, prompt manifests, or telemetry.
- The viewer exposes **Sign in with ChatGPT** and **Sign out**. Login calls
  `ModelRuntime.login("openai-codex", "oauth", interaction)`. The interaction
  is bridged to UI events for auth URLs, device codes, progress, cancellation,
  and manual-code entry.
- Device-code login is the default for a phone or browser remote from the
  Linux host. Browser callback login is available when the callback is
  reachable; pasted redirects remain supported. Login survives viewer
  reconnect because the server owns the operation.
- Pi persists OAuth credentials mode `0600`, serializes refresh under the
  credential-store lock, and refreshes before requests. Remux never implements
  token exchange or refresh itself.
- Missing entitlement, exhausted usage, invalid refresh, and rate limiting
  are distinct user-visible states. None activates an API key, another
  account, another provider, or a lower model automatically.

An owner may bootstrap authentication with Pi's own `/login` flow before the
Remux UI exists. First-class UI login is nevertheless a release requirement,
not an optional setup convenience.

## Core invariants

1. **Journal is source; prompt is a view.** Everything is journaled before or
   with its derived state. Dropping something from the prompt never deletes
   it. The prompt is reproducible from the journal.
2. **Epochs are immutable + append-only.** Within an epoch nothing already in
   the prompt is edited, reordered, or removed. New context only appends.
   That is what makes every call a cache extension of the last.
3. **Every observation is bounded.** No tool result may inject unbounded
   bytes. Big results become a bounded projection plus an artifact handle.
4. **No model on the hot path.** Ordinary assembly is block selection and
   concatenation. No summarization call sits between a tool result and the
   next inference.
5. **Runtime identity outlives prompt residence.** Processes, commands, and
   files keep stable IDs the model can list and inspect after their prose has
   left the prompt.
6. **Hidden reasoning is not state.** Anything that must survive a rollover
   must exist in visible output, a tool result, an artifact, or a record.
7. **Omission is observable.** Every call records a manifest of what was
   included, what was omitted, and why. The prompt never pretends to be the
   whole session.

## The prompt

### Shape

Every request is an ordered list of immutable, content-addressed blocks:

```text
┌──────────────────────────────────────────────┬──────────────┐
│ 1. harness + personal + workspace contracts  │  ~3k tokens  │  stable for weeks
│ 2. tool schemas (fixed set, never varies)    │  ~4k         │  stable for weeks
│ 3. epoch snapshot (compiled frontier)        │  8–25k       │  frozen per epoch
│ 4. hot trace (messages + reduced results)    │  grows       │  append-only
│ 5. newest input (user msg or tool results)   │  varies      │  the suffix
└──────────────────────────────────────────────┴──────────────┘
```

Static precedes dynamic. Blocks 1–3 are byte-identical across every call in
an epoch; block 4 only ever grows at the end. Pi supplies a stable session
affinity/prompt-cache key to the Codex transport. The subscription transport
does not expose arbitrary application-defined cache breakpoints, so the
ordered exact prefix is the optimization surface. Serialization is
deterministic: stable field order, no timestamps unless semantically needed,
no volatile values.

A per-inference **manifest** records the ordered block IDs, hashes, source
resources, token estimates, model profile, and the Pi/provider serialization
version. It reconstructs the complete logical model input byte-exactly.
Transport continuation is recorded separately because a cached websocket may
send `previous_response_id` plus only the appended suffix rather than resend
the complete logical input.

### Budgets (defaults, tunable per model profile)

| Component | Target | Hard max |
| --- | --- | --- |
| Contracts + tool schemas | ≤ 8k | 12k |
| Epoch snapshot | ≤ 20k | 30k |
| Hot trace + retrieved evidence | the remainder | — |
| Output + reasoning reserve | 25k | — |
| **Total input per call** | **≤ ~120k** | **150k** |

The 150k cap applies even on 400k-window models. Output reserve is never
borrowed. Token counts are cached per block and reconciled against reported
usage — history is never retokenized per call.

### One inference step, concretely

```text
User: "implement the accepted transcript spec"

call 1   [contracts 3k][tools 4k][snapshot 12k: spec v7 excerpt, change set,
         no live tests, continuation][user msg]              ≈ 19k in
         → model calls workspace.read(server.rs)

harness: journal tool call → run read → reducer emits bounded text (≤2k)
         + artifact handle → append one hot block             (no model call)

call 2   same bytes as call 1 + [read observation 2k]        ≈ 21k in  (cache hit ≈ 19k)
         → model patches, runs tests

harness: test output is 400k bytes → artifact:test-91; reducer emits suite
         counts + 3 failing tests + bounded failure text (≤3k) → append

call 3   previous bytes + [edit obs][test obs]               ≈ 27k in  (cache hit ≈ 21k)
         → model reads failure detail via runtime.read(artifact:test-91, range)
         → harness appends that as a working-set block, model fixes, re-runs
...
call 41  preflight: 122k + next input + 25k reserve > 150k → ROLL

rollover (no model call): compile new snapshot at the committed journal
         boundary — unserved request, spec v7 ref, current change set,
         failing tests + artifact handles, live process inventory, last
         ~8k of raw conversation → freeze ≈ 15k

call 42  [contracts][tools][new snapshot 15k][empty hot trace][continuation]
         ≈ 23k in — same visible run, model keeps working
```

The user sees one uninterrupted run. The provider sees two epochs, each an
append-only cache chain. The expensive step (compilation) ran exactly once,
and involved no model.

## How context is assembled

There are only two paths: a **cheap append path** that runs on every event,
and an **expensive compile path** that runs only at rollover.

### The cheap path: append

On every event, the harness does three things — journal, materialize, append:

- **User message** → journal it → append it verbatim as a hot block.
- **Model output** → journal it → it is already in the trace by construction.
- **Tool result** → journal it → update the touched resources (command,
  process, file, change set) → run the **reducer** for that tool type →
  append one bounded observation block; overflow bytes go to the artifact
  store with a handle in the block.
- **External change** (watched file changed, process died, job finished) →
  journal it → coalesce into a bounded **runtime-delta block** appended
  before the next call. Deltas name the old and new resource revision; the
  greatest visible revision wins. Irrelevant churn is not appended — it stays
  queryable via `runtime.changes`.
- **Retrieved evidence** (model asked for a resource via `context`/`runtime`)
  → append a bounded working-set block. It stays for the rest of the epoch —
  never spliced into earlier positions.

Nothing above calls a model, edits an existing block, or reorders anything.

### Preflight

Before each call:

```text
input = contracts + tools + snapshot + hot trace + newest input
assert input + output_reserve + safety_margin <= min(150k, model limit)
```

Pressure states derived from the same numbers:

- `normal` &lt; 60% of budget — nothing to do;
- `watch` ≥ 60% — warm the background snapshot candidate; the model may be
  invited to write a continuation checkpoint (its current intent, unresolved
  meaning, next action, exact source refs) as a cheap tool call — useful but
  never required;
- `roll-next` ≥ 85% — finish the current tool boundary, then roll before the
  next call;
- `blocked` — a single mandatory input exceeds the budget; exceptional and
  user-visible (the input is artifact-stored and windowed instead).

### The expensive path: rollover compilation

Rollover happens between inference steps, after pending tool results are
journaled. It compiles a new snapshot **deterministically** — each section is
filled by a stated query against materialized state, not by judgment:

| Snapshot section | Filled by | Target |
| --- | --- | --- |
| **Continuation** | unserved user input verbatim (run state); last completed action and declared next action (last tool boundary); interruption/failure flag | ≤ 1k |
| **Authority** | workspace contract refs; records `status=accepted` scoped to this conversation/workspace; accepted spec excerpts by exact artifact revision (bounded, never paraphrased) | ≤ 6k |
| **Open work** | records `status=proposed/open` in scope; failures with no later success (latest command/test resources); explicitly deferred items | ≤ 3k |
| **Workspace** | branch/head/dirty (latest git observation); change set (paths, hashes, diffstat); latest build/test state; external invalidations | ≤ 4k |
| **Live runtime** | processes `state=active` owned by this conversation/workspace: id, short argv, health, endpoints; log tail only if unhealthy | ≤ 2k |
| **Raw tail** | the most recent conversation verbatim, newest-first until budget, never cut mid-message; sized assuming zero records were written | ≤ 8k |
| **Map** | prior epoch refs and close reasons; pinned resources; one-line retrieval instructions; basis cursor | ≤ 1k |

Typical snapshot: 12–18k tokens. The section layout is versioned rendering
policy (`policyVersion`) — changeable without migrating data. If a background
candidate snapshot was prepared at `watch`, rollover advances it through the
final committed events; a late or failed background pass never blocks.

Mandatory content (continuation, authority, open failures, live inventory)
is never evicted by optional content. If it cannot fit, the compiler shrinks
projections or externalizes to artifacts, and flags a degraded-context
diagnostic rather than silently dropping a constraint.

### What rollover never does

- Never calls a model. The continuation checkpoint, if the model wrote one,
  is an input; its absence changes nothing.
- Never summarizes the transcript. Old turns are indexed and retrievable,
  not paraphrased.
- Never blocks on anything asynchronous.
- Never carries provider reasoning blocks across the boundary — they cannot
  be re-attached. This is a real behavioral cliff: the continuation section
  and raw tail are the mitigation, and gate 3 measures it directly.

### Pi and Codex mechanics at the boundary

Pi's native session JSONL is disabled for the embedded runtime; the Remux
journal is the only durable source. One live Pi `AgentSession` runs the inner
model/tool loop, while its `context` hook supplies the compiled messages
before every inference. Pi compaction is disabled. Remux's fixed tools replace
Pi's built-in filesystem and shell tools so every effect and observation goes
through the journal, reducers, operation IDs, and Remux process scopes.

Within an epoch, logical input N+1 byte-extends logical input N. Pi's Codex
transport may either send the full serialized input or reuse a websocket
response and send `previous_response_id` plus the exact delta. These are
transport encodings of the same logical prompt and are not journal state.

At rollover, the context hook returns a new non-prefix input: frozen snapshot,
empty hot trace, and the pending continuation as the first user-role input.
Prior assistant tool-call turns are not replayed. A cached transport must
detect that the input no longer extends its continuation, clear
`previous_response_id`, and send a full request. Reusing provider continuation
across an epoch boundary is a correctness bug. The integration records enough
transport telemetry to prove whether a request was full or delta; if upstream
Pi does not expose that fact, the pinned Pi patch adds the smallest possible
post-serialization observation hook.

The only shipping transport is Pi's cache-aware Codex websocket mode. A
transient network error may retry the same request on that same transport
with the same operation identity and logical input; it never selects another
transport, provider, model, credential, or auth mechanism. Any alternate
transport used during development is an explicit benchmark target, not a
runtime fallback. Cache TTL is treated as observed telemetry, not a hard-coded
promise. The epoch scheduler may prefer an already-cold boundary only after
measurements show that doing so helps.

## Reducers: what the model sees per tool result

Deterministic, per tool type, with token caps (defaults; failures get more
than successes because failures drive the next action):

| Tool result | Model-visible observation | Cap | Externalized |
| --- | --- | --- | --- |
| File read | path, hash, range, exact text | 2k | remainder |
| Search | query, counts, top matches, truncation note | 1k | full match set |
| Command (ok) | command, shell, cwd, exit, duration, tail | 1k | full stdout/stderr |
| Command (failed) | + failure spans, larger tail | 3k | full stdout/stderr |
| Test run | suite counts, failed test IDs, failure text | 3k | full report |
| Edit | paths, hashes, diffstat, key hunks | 2k | complete diff |
| Process event | logical ID, state, readiness, endpoints, recent output | 1k | segmented logs |
| Runtime query | summaries, revisions, cursor, omitted count | 1k | exact resources |

Every observation states what was omitted and the handle that recovers it —
never a bare "output truncated". For streaming output the artifact writer and
reducer consume the stream concurrently; there is no accumulate-then-reduce
pass. Reducers preserve error text, exit codes, and truncation details
exactly.

## Tools

One fixed set, stable within and across epochs (tool-schema changes
invalidate the entire provider cache and force a rollover):

| Family | Purpose |
| --- | --- |
| `workspace` | bounded read/search/metadata/patch over configured roots |
| `shell` | finite commands → structured result + artifact handles |
| `process` | start/inspect/write/interrupt/terminate long-lived processes |
| `runtime` | list/read/search/related/changes over every resource kind |
| `record` | create/accept/resolve/supersede/pin records with provenance |
| `context` | pressure + manifest inspection, pull a resource into the working set, continuation checkpoint |

The read side is one uniform contract:

```ts
type RuntimeQuery =
  | { op: 'status' }
  | { op: 'list';    kind?: string; state?: string; scope?: string; cursor?: string; limit?: number }
  | { op: 'read';    uri: string; projection?: string; cursor?: string; limit?: number }
  | { op: 'search';  query: string; kinds?: string[]; scope?: string; cursor?: string; limit?: number }
  | { op: 'related'; uri: string; relation?: string; cursor?: string; limit?: number }
  | { op: 'changes'; since: number; kinds?: string[]; scope?: string; cursor?: string; limit?: number };
```

All reads are bounded and paginated; every response says whether more exists.
Effectful operations carry stable operation IDs so a retry cannot double-run.
The fixed set has no external-integration dispatcher or first-class web,
research, collaboration, or subagent tool.

## Storage

Three layers, each only as rich as assembly and recovery require.

**Journal** — append-only event log with one committed `sequence` cursor.
Every user/model message, tool call and result, command/process transition,
file observation, record change, and epoch boundary is an event with actor,
causal link, visibility (`model`/`user`/`restricted`), and payload or
artifact ref. Derived state is rebuildable from a journal prefix. Corrections
append; nothing mutates.

**Artifacts** — content-addressed immutable bytes (logs, reports, diffs,
fetched documents, prompt manifests). Support byte/line ranges, structured
projections (failed tests, diff hunks), dedup, provenance edges, retention
classes (pinned / active-runtime / ordinary / reproducible-cache /
restricted), and bounded reads with cursors. GC is reference-aware; a
removed-but-referenced artifact leaves a tombstone.

**Resources** — materialized current-state views over the journal, uniformly
addressable (`command:<id>`, `process:<id>`, `workspace:<ws>/<path>@<hash>`,
`changeset:<id>`, `turn:<conv>/<n>`, `record:<id>@<rev>`,
`epoch:<strand>/<n>`, `artifact:<hash>`, `inference:<id>`), each carrying
`state`, `basisEventSequence`, data, and typed relations (`produced`,
`modified`, `validated`, `depends-on`, `supersedes`, …). Snapshot queries and
`runtime` tool calls read these; graph edges beat embedding similarity for
selection.

Processes deserve one note: a managed process records logical ID (independent
of PID reuse), owner scope, cgroup/start-tick/boot identity for
reconciliation, lifecycle, endpoints, and log artifacts. Long-lived services
run in Remux-managed scopes, survive adapter restarts, and are reconciled by
identity — never by trusting a stale PID. Persistence is explicit; shell
backgrounding does not create an immortal service.

Privacy: no environment dumps are ever journaled; known-secret fields are
redacted at ingestion; restricted artifacts are excluded before selection and
from semantic indexes; withheld evidence is recorded as withheld, not
absence.

## Records

Durable meaning that filesystem and process state cannot reconstruct:
decisions, constraints, directives, open questions, accepted specification
references, pins. One primitive:

```ts
type Record = {
  recordId: string; revision: string;
  kind: string;                    // open convention: 'decision', 'constraint', ...
  body: string | ArtifactRef;
  origin: 'contract' | 'workspace' | 'user' | 'user-accepted' | 'observation' | 'agent' | 'derived';
  status: 'proposed' | 'accepted' | 'rejected' | 'resolved' | 'superseded' | 'stale';
  scope: ResourceRef[]; relations: ResourceRef[]; provenance: ResourceRef[];
};
```

`kind` is a naming convention — compiler behavior depends only on **status,
origin, and relations**. Origins are typed authority, not a score: a process
observation is authoritative about liveness, a user decision about intent;
conflicts are surfaced, not silently ranked away. Accepted records change
only by supersession. The runtime auto-creates observations from typed
events; it never infers acceptance or intent from prose. The model may write
records via a cheap tool call mid-work; the user accepts/rejects/pins via
conversation or the inspector. Because voluntary emission is unvalidated
model behavior, the system must stay correct when it never happens — the raw
tail is sized for that (gate 11).

This is how workflow stays emergent with no mode machine: a spec is an
ordinary artifact until a user acceptance creates an authoritative edge to an
exact revision; implementation then pulls it into the snapshot's authority
section; a challenge later records a new proposal, and only explicit
acceptance supersedes. Small tasks create nothing beyond automatic
observations.

## Restart and recovery

Journal, artifacts, records, and manifests survive restarts.

1. Verify/replay the committed journal tail; rebuild or validate resources.
2. Reconcile processes by logical identity (cgroup, start ticks, boot ID);
   mark unrecoverable handles terminal or stale — never pretend.
3. Reconcile workspace hashes referenced by the active frontier.
4. Resume an open run only at a completed inference/tool boundary; continue
   an epoch only if its exact blocks reconstruct, else recovery-rollover.
5. Never repeat an accepted external effect because a response was lost —
   operation IDs are journaled before execution.

## UI and inspector

UI support is part of the harness, not a later wrapper. The server-authoritative
transcript stays the human view, independent of the prompt. The new agent
viewer ports or copies proven code from `extensions/codex/viewer` for the
composer, transcript rendering, virtualization/layout, thread list, file
mentions, model/reasoning controls, reconnect behavior, and
resource-driven streaming.

The viewer consumes a Remux-owned agent protocol. Pi events are translated
server-side into stable transcript items, turn/runtime state, usage, tool
activity, errors, and resource invalidations. Pi message IDs, provider
response IDs, websocket continuation IDs, Remux conversation IDs, and epoch
IDs remain separate typed identities. The UI never reconstructs authoritative
history by accumulating text deltas; as today, invalidations cause bounded
rereads of server resources.

Required product flows are: sign in/out and auth status; create/list/open/
edit/fork conversations; send, steer, follow up, and interrupt; stream
assistant text/reasoning/tool progress; select an available `openai-codex`
model and supported reasoning level; survive viewer and extension-server
reconnects; and inspect exact historical artifacts. There is no provider
picker and no API-key form.

The inspector shows: current epoch, pressure, rollover history; logical-full
versus transport-delta calls; per-call tokens/usage/cache/latency; each
snapshot section with its source resources; hot blocks; omitted candidates
with reasons; live processes and commands; record states with accept/reject/
pin/supersede controls; "why included?" and "read exact source" actions.
There is no Compact button; a user may deliberately fork or reset, but normal
work rolls silently.

Current App Server transcripts never enter the new agent. During development
the old viewer/backend remains a separate baseline with a separate launcher
and storage domain. At cutover it is archived or deleted; there is no import,
compatibility reader, or mixed history view.

## Phase 0: integration spine

Phase 0 proves the narrowest end-to-end product path before the journal,
branch model, full tools, or epoch compiler exist. It is intentionally an
**ephemeral, single-conversation vertical slice**. Its purpose is to retire
integration risk, not to be a usable coding harness or a persistence format.

### Required outcome

From the Remux UI, the owner can sign in with the Codex subscription, select
an entitled model and reasoning level, start one ephemeral conversation, send
a prompt, observe streamed assistant and custom-tool activity through
server-authoritative resources, interrupt the active turn, disconnect and
reconnect the viewer, then sign out. No Codex App Server process, Codex CLI
subprocess, API key, Pi session file, or Pi compaction participates.

Conversation state survives viewer reconnect only while the same extension-
server generation remains alive. An extension-server restart deliberately
returns an empty Phase 0 conversation and a new `serverGeneration`; it never
pretends to have resumed. OAuth credentials do survive because they are Pi's
provider credential state, not conversation state.

### Repository and process shape

The initial target is:

```text
extensions/agent/
  remux-extension.json
  package.json
  package-lock.json
  shared/
    protocol.ts              # Remux-owned commands, resources, transcript subset
  server/
    src/
      main.ts                # newline-delimited stdio JSON-RPC + output arbiter
      auth.ts                # ModelRuntime auth interaction -> safe resources
      pi-runtime.ts          # pinned Pi construction, event adapter, cancellation
      resources.ts           # in-memory revisions and authoritative reads
      tools/workspace-read.ts
  viewer/                    # copied/ported UI subset, no Codex protocol bindings
  tests/                     # server unit/fixture tests + viewer Playwright tests
```

File grouping may change, but the boundaries are normative. The manifest ID
is `agent`; its server is built to JavaScript and launched directly with
Node over Remux's existing stdio transport. Its launcher is visibly labeled
as a preview during Phase 0. The existing `codex` extension is untouched and
can run side by side.

The new extension may reuse generic Remux/viewer packages and copy UI source,
but it must not import generated App Server schemas, Codex protocol bindings,
the Codex Rust server, or Codex history readers. The manifest declares no
`app-server` workload. Pi packages are pinned exactly in the lockfile; no
provider abstraction or dependency for Anthropic is added by Remux code.

### Minimal Remux protocol

Phase 0 owns a small protocol rather than forwarding Pi or App Server types:

| Method | Contract |
| --- | --- |
| `remux/agent/resources/read` | Batch-read typed resources by key and optional known revision. |
| `remux/agent/auth/login/start` | Start one server-owned device-code login; return an operation ID immediately. |
| `remux/agent/auth/login/cancel` | Cancel the matching pending login. |
| `remux/agent/auth/logout` | Clear `openai-codex` credentials and invalidate auth/models. |
| `remux/agent/models/read` | Return only currently available `openai-codex` models and supported reasoning levels. |
| `remux/agent/conversation/start` | Replace any idle ephemeral conversation with a fresh one rooted at a validated `cwd`, selected model, and reasoning level; return its ID. |
| `remux/agent/conversation/message/send` | Accept one user message for the idle conversation and start its turn asynchronously. |
| `remux/agent/conversation/turn/interrupt` | Abort the identified active turn without blocking the RPC reader. |

The corresponding resource keys are `auth`, `models`,
`conversation:<conversationId>`, and `transcript:<conversationId>`. Every
resource contains a monotonic process-local `revision` and the current
`serverGeneration`. The server emits one
`remux/agent/resources/invalidated` notification carrying keys and reasons;
the viewer coalesces notifications and rereads resources. Notifications are
hints, never transcript state.

Commands return acceptance plus immediate invalidations; they do not remain
open for the duration of OAuth or inference. One serialized stdout arbiter
owns both JSON-RPC responses and server notifications. The stdin request loop
must remain able to process login cancellation, resource reads, and turn
interrupts while a login or `session.prompt()` is running.

Phase 0 has distinct `conversationId`, `turnId`, `itemId`,
`clientMessageId`, Pi message ID, and provider response ID fields. Only the
first four are Remux protocol identities. Raw Pi/provider IDs may appear in
server debug diagnostics, but never substitute for a Remux ID in the viewer.

The transcript schema is the smallest provider-neutral subset needed for the
slice: user message, assistant text, visible reasoning, tool call/result,
turn error, and terminal turn status. Partial deltas mutate server state and
bump its revision; the viewer never appends deltas itself.

### Pi construction

The server creates one `ModelRuntime` using Pi's default credential store and
allows only provider ID `openai-codex`. It creates the agent runtime with:

- `SessionManager.inMemory()` so no Pi JSONL session is created;
- in-memory settings with compaction disabled;
- automatic retry disabled for Phase 0 so transport/auth failures remain
  unambiguous during the spike;
- Pi built-in tools disabled while custom tools remain enabled;
- one fixed, minimal system prompt and one selected Codex model/reasoning
  level; and
- the canonical cache-aware Codex websocket transport.

There is no model fallback. A missing or unavailable selected model is a turn
error. Pi event subscriptions are attached before prompting and are disposed
when the ephemeral conversation is replaced.

Phase 0 installs the same pre-inference context hook intended for the final
harness, but its implementation simply renders the complete bounded in-memory
conversation. It records a safe debug manifest containing ordered message
hashes, provider/model, hook version, estimated size, and whether the request
was observed as full or continuation. It does not yet build blocks, snapshots,
records, artifacts, or epochs. This proves that Remux can replace logical
context on every inference before relying on the seam.

### Authentication flow

1. The viewer reads `auth` and renders signed-out, authenticating, ready,
   expired, or error state.
2. **Sign in with ChatGPT** calls `auth/login/start`.
3. The server calls `ModelRuntime.login("openai-codex", "oauth", interaction)`
   and selects device-code login for Phase 0.
4. Safe verification URL, user code, expiry/progress, and operation ID become
   auth-resource fields. Access and refresh tokens never do.
5. Completion invalidates auth and models. Viewer reconnect does not cancel
   the server-owned operation; explicit cancel does.
6. Sign-out uses Pi's provider logout and invalidates auth/models.

A prior Pi login may make the first auth read immediately ready. Browser-
callback and pasted-redirect login remain valid future auth transports, but
device code is the only Phase 0 UI path.

### One custom tool

Phase 0 exposes exactly one read-only custom tool, `workspace.read`, to prove
that Pi's built-in tools can be replaced and that tool events survive the
projection boundary. It accepts a workspace-relative path and optional bounded
range, rejects lexical or symlink-resolved traversal outside the conversation
`cwd`, and returns path, content hash, exact range, text, and `truncated`.
Model-visible text is capped at 32 KiB. There is no artifact overflow store
yet, so truncation is explicit and a subsequent ranged read is required.

No shell, edit, process, runtime, record, context-retrieval, integration, or
effectful tool ships in Phase 0.

### Viewer cut line

Port only the existing host bridge, theme/frame, composer editor, transcript
layout/virtualization, model/reasoning picker, loading/error states, and
resource invalidation/reread behavior needed by this slice. The visible Phase
0 UI is:

- auth status, sign in, cancel sign-in, and sign out;
- one **New preview chat** action that consumes the launch `cwd` or the
  existing directory picker before creating the conversation;
- model and supported reasoning selection;
- composer send and active-turn interrupt;
- user, assistant, visible reasoning, `workspace.read`, and error transcript
  rows; and
- connection/reconnect status.

Do not copy or render narration, review, speed/service-tier, quota/reset,
approval/elicitation, collaboration/subagent, research/web, compact, or old-
history UI. Thread history, edit, fork, steer/follow-up queues, file mentions,
attachments, and the context inspector are planned product features but are
not Phase 0 controls.

### Turn flow

1. `conversation/start` canonicalizes and validates `cwd`, then creates the
   in-memory conversation and Pi runtime.
2. `message/send` validates auth, provider/model, idle state, conversation ID,
   client message ID, and bounded non-empty input.
3. The server records the user item and running turn before replying
   `accepted`, then runs `session.prompt()` on a background task.
4. Pi events update authoritative transcript items and turn state. Each
   meaningful update bumps a resource revision and schedules a coalesced
   invalidation.
5. A `workspace.read` request executes in the extension server, appears as a
   tool call/result, and returns to Pi's loop.
6. Completion marks the turn completed or failed. Interrupt calls Pi abort,
   waits asynchronously for terminal state, and records `interrupted` exactly
   once.
7. Viewer reconnect rereads conversation and transcript resources from the
   server; no special delta replay path exists.

### Phase 0 acceptance gates

Phase 0 is complete only when all of these hold:

1. Remux discovers and launches `agent` beside the unchanged `codex`
   extension, and repeated start/stop/restart leaves no orphan server.
2. A clean signed-out flow completes device-code OAuth, persists/reuses the Pi
   credential across extension restart, lists only `openai-codex` models, and
   signs out.
3. Browser state, RPC payload captures, logs, transcript resources, and debug
   manifests contain no access or refresh token.
4. A real subscription prompt streams user and assistant rows through
   invalidation plus resource reread, with no viewer-owned transcript append.
5. A real prompt such as “read `README.md` and report its first heading”
   completes one bounded custom `workspace.read` round trip and renders its
   call/result.
6. Interrupt remains callable while inference is active and converges on one
   terminal `interrupted` state; the stdio reader is not blocked by the turn.
7. Closing and reopening the viewer during streaming reconstructs the current
   transcript and turn state from the same extension-server generation.
8. Restarting the extension server changes `serverGeneration` and shows the
   Phase 0 conversation as intentionally unavailable rather than fabricating
   a resume.
9. A filesystem/process audit proves no Pi session JSONL, `codex app-server`,
   `codex exec`, generic OpenAI API-key transport, or Anthropic client was
   created or started; Pi compaction remains disabled.
10. Context-hook telemetry proves the hook ran before every real inference;
    provider telemetry distinguishes the initial full request from any
    continuation or records the exact missing Pi seam to patch.
11. The preview viewer contains none of the deliberate product exclusions and
    imports no generated Codex/App Server protocol bindings.
12. Unit tests cover JSON-RPC framing/output serialization, resource
    revisions, auth redaction, ID separation, event projection, tool bounds,
    and interrupt races; Playwright covers signed-out, streaming fixture,
    reconnect, and error UI. Live OAuth/model execution is verified by the
    separate owner-run smoke test.

The owner completed these live acceptance gates on 2026-08-07. Phase 0
produces a pinned Pi version, captured event-to-transcript mapping,
sanitized transport/context telemetry, and a written list of any Pi patch
required. It does not freeze the durable conversation schema. Passing the
gates authorizes Phase 1; failure at the auth, context-hook, custom-tool, or
interrupt boundary stops the build and revises the architecture before any
journal format is committed.

## Build order

The implementation-ready storage, protocol, recovery, and evaluation contract
for steps 0A–1D is in
[`agent-durable-epoch-core.md`](agent-durable-epoch-core.md). UI reuse,
checkpoint timing, owner review, and cutover are defined in
[`agent-ui-parity-and-phased-delivery.md`](agent-ui-parity-and-phased-delivery.md).
The first implementation boundary is fixed by
[`agent-phase-1a0-ui-port-scope.md`](agent-phase-1a0-ui-port-scope.md). Those
companion specs are normative where this overview is conceptual.

0. **Integration spine (implemented and owner-accepted)** — the bounded
   Phase 0 contract above exists in `extensions/agent/` with Pi 0.84.0,
   fixture/server/viewer tests, and a written Pi seam report.
0A. **Acceptance seal (completed 2026-08-07)** — the owner exercised the live
   OAuth/model/read/interrupt/reconnect/restart/signout flow through the real
   Remux supervisor and completed the credential/process audit.
1A.0. **UI port foundation (implemented; owner acceptance pending)** — copy the proven Codex transcript, renderer,
   composer, lifecycle, responsive-layout, and fixture-test foundation into
   Agent; adapt it to the existing ephemeral protocol; remove narration and
   other excluded product surfaces. No durable schema is added in this
   checkpoint.
1A.1–1A.3. **Journal + shadow compiler** — add the SQLite journal, immutable
   artifacts, durable conversations/history, authoritative transcript
   windows/work details, deterministic replay, shadow epoch manifests, and the
   context inspector in gated slices. Active provider input remains full
   replay and refuses an over-budget turn.
1B. **Active epochs** — preflight before every inference, deterministic
   rollover inside a turn, recovery epochs, exact prefix assertions, and
   verified full provider requests at boundaries. The tool remains read-only.
1C.1–1C.4. **Coding effects + interaction parity** — activate bounded
   read/search/artifacts, patch/diffs, finite shell, runtime/context retrieval,
   reducers, idempotent crash-recoverable operations, then mentions,
   attachments, steering/queueing, edit, and fork.
1D. **Durable processes + evaluation release** — reconnectable persistent
   process hosts, restart reconciliation, and realistic paired comparison with
   the existing Codex/App Server baseline.
2. **Cutover** — close any parity findings discovered during the cumulative
   checkpoint reviews, run old and new agents as explicit comparison targets,
   then switch the default launcher and remove App Server from the shipping
   lifecycle. This is not a late bulk UI port; included UI behavior is already
   present and tested by this point. Deliberate product exclusions stay absent.
3. **Records** — model-writable records, acceptance flow, inspector
   controls. Vocabulary grows from observed use. Exercises the lightweight-
   task and zero-record correctness gates.
4. **Accelerators** — semantic candidate search, background annotators,
   task-conditioned pruning: each adopted only on measured improvement over
   the deterministic baseline.

## Validation gates

1. A fresh Remux installation can sign in to `openai-codex` from the UI by
   device code, restart, refresh the token, list entitled models, and sign
   out without any credential reaching browser state, journal, logs, or
   manifests.
2. The planned core UI workflows — new/open/list/edit/fork, send/steer/
   follow-up/interrupt, streaming, tool progress, file mentions, attachments,
   model/reasoning selection, and reconnect — pass against the new server-
   authoritative protocol.
3. A multi-hour tool-heavy run crosses several epochs with the task intact —
   measured specifically across mid-run rollovers, where provider reasoning
   state is lost.
4. Within an epoch, every logical input byte-extends the previous one and
   cache reuse is high. Transport telemetry shows deltas within an epoch and
   a full request with no prior continuation at rollover.
5. No tool output, file, or user artifact can push a call over the input
   budget.
6. A process started before a rollover and an adapter restart remains
   discoverable, controllable, and correctly reconciled.
7. An accepted specification survives exploration → implementation rollovers
   with exact provenance.
8. Anything omitted from the prompt is findable and restorable in bounded
   tool calls, and the unnoticed-missing-context rate (needed but never
   retrieved) is measured and acceptably low.
9. Assembly adds negligible latency at tool boundaries; manifests reproduce
   exact logical inputs; shadow compilation explains differences from the
   current app-server baseline on the same tasks.
10. Small conversational tasks stay natural — no record or process ceremony.
11. Record-emission frequency is measured; the system remains correct at
   zero.
12. Every call stays ≤ the input budget, and cache economics hold across
    realistic idle gaps on the Codex subscription transport.
13. A dependency/process audit proves the shipping path starts no
    `codex app-server`, `codex exec`, Claude/Anthropic client, or generic
    OpenAI API-key transport. Auth, usage, and provider errors stay visible
    and do not trigger a fallback. A UI/protocol/dependency audit also proves
    that the deliberate product exclusions have no shipping controls,
    compatibility types, or background processes.

## Open questions

1. Raw-tail sizing per conversation style (coding vs exploration), assuming
   zero voluntary records.
2. Spec projection when relevant sections exceed the authority budget.
3. Conversation-owned vs project-shared processes; adopting another
   conversation's server.
4. How conservative the pinned Pi token estimator must be after calibration
   against reported Codex usage, and which cache/continuation metrics require
   a small upstream Pi seam.
5. Retention policy that keeps replay realistic without unbounded growth.
6. Whether the new extension ultimately keeps the product/route name
   `codex` or becomes `agent` after the old baseline is retired.

## Grounding

One line per bet: OpenAI explicitly supports using Codex in tools including
Pi, while Pi exposes subscription OAuth, an embeddable SDK, pre-inference
context transforms, provider-payload hooks, custom tools, and disabled native
compaction
([OpenAI Codex for Open Source](https://developers.openai.com/community/codex-for-oss),
[Pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md),
[Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md),
[Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[Pi settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md));
append-only cache-stable prefixes and stable tool schemas
([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus),
[OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching));
deterministic reduction over model summarization
([Complexity Trap](https://arxiv.org/abs/2508.21433), replicated);
typed recoverable eviction at scale
([Beyond Compaction](https://arxiv.org/abs/2606.11213), 80M tokens);
fresh-boundary resets over summary stacking
([Amp handoff](https://ampcode.com/news/handoff),
[OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction));
small-context performance
([context rot](https://www.trychroma.com/research/context-rot)); lossless
retention with replaceable views
([Volt](https://github.com/Martian-Engineering/volt)). Counterpoint we accept:
RL-trained summarization ([Cursor](https://cursor.com/blog/self-summarization))
may have a higher ceiling — our mechanisms stay cheap, deterministic, and
cache-preserving so they remain net-positive as models improve. No cited
system validates the whole design; the gates do.
