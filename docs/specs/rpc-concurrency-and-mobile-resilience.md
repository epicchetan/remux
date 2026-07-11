# RPC Concurrency and Mobile Transport Resilience

Status: Active Spec
Last verified: 2026-07-11
Canonical code: `cli/src/rpc/`, `cli/src/extensions/`, `cli/src/{notifications,monitor,logs,fs}/`, `app/src/remote/`, `app/src/surfaces/viewer/ExtensionWebView.tsx`, `packages/viewer-kit/src/ipc.ts`, `extensions/{codex,terminal}/`.

## Purpose

Remux is primarily operated through an Expo app over Tailscale, often while the phone is on cellular data, crossing weak coverage, backgrounding, or switching between Wi-Fi and cellular. The transport must recover from a dead path without restarting a healthy runtime, and one slow RPC must never make the whole app appear down.

This pass fixes two coupled defects:

1. The Rust WebSocket port processes all frames from one client sequentially. A slow request blocks unrelated extensions, liveness probes, close detection, app diagnostics, and even responses to Remux-originated requests.
2. Request timeouts are untyped. The app cannot distinguish a failed immediate acknowledgement from a legitimately long operation, most viewer calls inherit a 300-second default, and a silent socket is recovered only on close or a resume-time ping.

The implementation restores non-blocking frame ingestion, introduces bounded ordered route lanes, makes request policy mandatory at every built-in caller, and treats ordinary RPC traffic as liveness evidence. A foreground idle ping remains a backstop rather than the primary detector.

## Incident and current-state findings

The motivating incident had this shape:

- an existing phone session stopped receiving RPC replies;
- several `remux/clients/register` calls timed out while React Native still considered the WebSocket open;
- extension viewers appeared unavailable even though the runtime and extension processes remained alive;
- a fresh WebSocket connected and completed its handshake immediately;
- manually rebuilding an extension and restarting Remux recovered the UI but obscured the initiating failure.

The code audit found a transport-level explanation at least as plausible as a network outage:

- The Node server used `void handleDownstreamFrame(...)` from the `message` event. Frame handlers overlapped.
- The Rust port awaits `handle_downstream_frame` inside `while stream.next().await`, accidentally changing the concurrency contract while describing the port as 1:1.
- `WsClient::request` sends host-to-app requests on the same socket and awaits their response. If issued while handling an app request, the response cannot be read until the handler returns. The host request times out, then its eventual response is logged as unmatched.
- The current 500ms notification visibility failures followed by `ignored unmatched downstream response: "remux-host:N"` are the observable signature of that self-deadlock.
- `WsClient` uses an unbounded outbound channel. A half-open or slow cellular client can accumulate responses and high-rate notifications without a per-client byte limit.
- Each extension stdout reader has a second copy of the same defect: it awaits notification delivery before reading the next child-protocol line. A 500ms visibility check or an Expo push request with no HTTP deadline can therefore hold a later extension RPC response unread.
- The extension actor mailbox, child stdin queue, child stdout line relay, host-pending map, app-pending map, and several notification/log burst queues are also unbounded. Newline-delimited child output has no explicit line-size ceiling.
- Viewer-kit, the app RPC client, and extension supervision each have 300-second defaults. Codex adds a 300-second downstream wait and currently retries every downstream error once, including protocol/application errors and mutations.
- The app currently couples `waitForConnectedClient` to the operation timeout. A 600-second build can therefore wait 600 seconds merely to acquire a connection before the operation even starts.
- Make-before-break needs a server identity fix as well as an app generation guard: when two sockets momentarily represent the same client/session, cleanup of the old socket must not remove registration/session state installed by the promoted socket.

This pass treats these as correctness and stability defects, not optional tuning.

## Goals

- The WebSocket reader always consumes response, close, ping/pong, diagnostic, and request frames promptly.
- A long Codex operation cannot block system liveness, client registration, Terminal, Ledger, filesystem reads, or disconnect detection.
- Ordering is explicit and narrow: preserve it where a target requires it, allow parallelism everywhere else.
- Every built-in request call site declares completion, timeout/liveness, and retry semantics. There is no default request policy.
- Every built-in handler and every extension-to-host request/notification is present in a registry too. Caller, host, and handler surface mismatches fail tests.
- A timeout from a health-bearing local-immediate RPC makes the current connection unhealthy immediately.
- A phone can establish and promote a replacement socket without waiting for a half-open socket to close.
- Long operations never cause the app to conclude that the runtime is dead solely because their own deadline expired.
- Queues and in-flight work are bounded. Overload causes an explicit error or connection reset, never unbounded memory growth.
- Mutations are never replayed automatically after an ambiguous timeout unless the protocol has a verified idempotency key and server-side deduplication.
- Logs identify which method was queued or executing when liveness failed.
- Existing terminal replay, resource re-read, notification registration, and extension lifecycle behavior survive reconnects.
- Built-in extension protocol readers cannot be stalled by slow notification delivery, and Codex/Terminal preserve only the ordering their mutable resources require.

## Non-goals

- Do not restart the runtime because one phone connection is unhealthy.
- Do not add Tailscale-specific health or control-plane integration. Transport truth comes from Remux requests and HTTP/WS reachability.
- Do not require an iOS/Android native network-state dependency. Network-change signals may accelerate recovery later, but correctness cannot depend on them.
- Do not require unknown third-party extension servers to become internally concurrent. Built-in Codex and Terminal are in scope because their current global serialization and blocking locks are known mobile reliability hazards.
- Do not introduce general exactly-once delivery. This pass makes ambiguity explicit and prohibits unsafe automatic replay.
- Do not convert every long operation into a durable job in this pass. The policy and lane design must leave that migration straightforward.

## Required invariants

1. **The reader never awaits business work.** It parses a frame, handles transport/control responses inline, or enqueues owned work and immediately resumes reading.
2. **Host responses bypass business queues.** A response to `remux-host:*` always resolves its waiter even when every extension lane is busy.
3. **Control capacity is reserved.** System ping/info, client registration, connection bookkeeping, and close handling cannot be starved by extension work.
4. **FIFO is per target, not per socket.** Requests for the same ordered target retain arrival order. Different extension targets may progress independently.
5. **Every queue is bounded.** Per-client in-flight work, route queues, outbound frames, and outbound bytes have named limits and observable overflow behavior.
6. **Every built-in request has a policy.** Type checking fails when a new app or viewer request omits one.
7. **Timeouts are typed errors.** Code never infers timeout behavior by comparing an error-message string.
8. **Retries follow policy.** Reads may retry once after a new connection; mutations default to never.
9. **Connection and service health are separate.** The UI may declare a socket degraded while `/healthz` and the runtime remain healthy.
10. **Reconnect is resynchronization, not replay of arbitrary requests.** Promote a new socket, re-register, then re-read/re-attach authoritative state.
11. **Old generations cannot win.** Late responses, status changes, and reconnect callbacks from a superseded client are ignored.
12. **One slow client cannot consume unbounded memory.** When a client cannot drain mandatory output within its budget, close it and rely on reconnect/resync.
13. **Registration is a barrier.** A connection's latest `remux/clients/register` must commit before a later audience-forming request from that connection is dispatched.
14. **Deadlines do not nest accidentally.** Connection acquisition, queue residence, server execution, downstream hops, and response transfer have separate bounds and one shared absolute operation budget.
15. **Policy exists at both trust boundaries.** The app may identify a policy, but the runtime derives and validates scheduling/retry semantics from its own registry.

## P0 — Restore non-blocking frame ingestion

### Frame classification

Refactor `WsServer::handle_socket` so the read loop classifies an owned parsed frame without awaiting routed work:

| Frame | Handling |
| --- | --- |
| JSON-RPC response | Resolve `WsClient.pending` inline. Never enqueue. |
| WebSocket close/error/ping/pong | Handle inline and update connection state. |
| `remux/app/log` notification | Journal inline; this is diagnostic evidence needed during stalls. |
| Host/viewer notification | Enqueue to its ordered target lane without a response. |
| Control request | Enqueue to the reserved control executor. |
| Core/extension request | Enqueue an owned `DispatchJob` to the derived route lane. |

`DispatchJob` carries at least:

```rust
struct DispatchJob {
    connection_id: u64,
    connection_sequence: u64,
    client: Weak<WsClient>,
    id: Value,
    method: String,
    params: Option<Value>,
    remux_context: Option<Value>,
    received_at: Instant,
}
```

The job owns its data; no task borrows the socket frame or read loop. Sending a response upgrades the weak client reference and silently drops the response when the connection is gone.

### Minimal correctness gate

Before broader lane parallelism lands, the following must be true:

- a deliberately blocked business RPC cannot prevent a later `remux/system/ping` response;
- a Remux-originated visibility request can receive its app response while the initiating app request remains in flight;
- close/error frames cause cleanup while a business request is running;
- app diagnostics continue to reach the journal during a slow request;
- the test suite asserts these behaviors on one socket, not by opening a second socket.

This is the P0 deploy boundary. It removes the regression without requiring extension-internal concurrency.

### Extension stdout protocol reader

Apply the same P0 rule to `ExtensionSupervisor`'s newline-delimited child protocol:

| Child line | Handling |
| --- | --- |
| JSON-RPC response | Resolve the extension pending map inline; never await notification delivery first. |
| Extension notification for an app | Validate/classify, then enqueue to bounded outbound delivery. |
| `remux/notifications/request` | Enqueue a bounded NotificationManager job; visibility and Expo HTTP work happen outside the reader. |
| `remux/notifications/audience/remove` | Enqueue ordered notification-control work. |
| Invalid/oversized line | Terminate or quarantine the extension with an explicit protocol error. |

Expo requests require explicit connect and total deadlines. Notification delivery failure is recorded per intent and never prevents later child responses from resolving. The stdout line relay, child stdin queue, extension actor mailbox, and pending map all receive count and byte limits in this pass.

Child egress receives its own monotonic line sequence. Resolving a successful response inline also enqueues its `record_client_request` audience side effect at that sequence before a later child line may commit `remux/notifications/audience/remove`. Audience recording and extension-emitted audience control share one ordered notification-control lane, preventing a response wakeup race from recreating an audience after a later removal.

For response-dependent event streams, inline resolution also creates a non-blocking egress barrier keyed by origin/resource. Later child notifications may continue to be parsed and buffered, but cannot enter that client's outbound queue until the corresponding app RPC response has been admitted. This preserves response-before-event activation without making the child stdout reader await the app writer.

### P0 unsafe retry removal

Remove Codex `AppServerRuntime`'s blanket retry at the same deploy boundary. Concurrency makes ambiguous mutation replay more likely, so the reader fix must not ship while `thread/start`, `thread/fork`, `thread/rollback`, `turn/start`, `turn/steer`, compaction, edit, or interrupt can be replayed after any error. Only a registered read or a failure proven to occur before bytes were written may retry.

## P1 — Bounded ordered route lanes

### Lane derivation

The dispatcher derives the lane; clients do not choose it.

| Request family | Lane |
| --- | --- |
| `remux/system/*`, `remux/clients/register`, client-scoped subscribe/unsubscribe | Reserved control lane |
| `remux/fs/*` | Bounded core-filesystem executor |
| `remux/extensions/{start,stop,restart,server/build,views/build,watch/*}` | Target extension lane from `params.extensionId` |
| `remux/extensions/status`, logs snapshot, system resources | Control/read lane; snapshot only |
| `remux/<extension>/*` | FIFO lane for that extension ID |
| App → extension notification | Same extension ingress lane/key as related requests unless explicitly registered as an unordered lossy signal |
| Child → runtime/app notification | Extension stdout egress sequence into bounded notification/outbound workers; never waits behind app → extension execution |
| Unknown/default-routed method | Reject before admission unless an installed extension manifest registers it explicitly |

Lifecycle and ordinary RPC work for one extension share a lane. A restart cannot race an RPC into a process being stopped. A Codex build may occupy the Codex lane, but it cannot occupy Terminal, Ledger, filesystem, or control lanes.

`remux/clients/register` is a connection-scoped control barrier. The dispatcher may continue parsing later frames, but it does not start audience-forming work from that connection until the latest registration has committed. Registration revisions are monotonic per connection generation so a stale retry cannot overwrite newer active-target or app-state data.

### Ordering

- Enqueue order is assigned in the socket reader before any task is spawned.
- One extension ingress lane assigns FIFO admission/start order across clients; it does not necessarily await each ordinary RPC's final response before admitting the next job to a built-in child sub-lane.
- Responses across lanes may arrive out of order; JSON-RPC IDs are the correlation contract.
- Core filesystem reads may execute concurrently up to a named limit because they are read-only and already have their own cache/gates.
- Control handlers must not call into a long extension operation. Extension status reads snapshots; they do not wait behind lifecycle work.
- If future methods require resource-level rather than extension-level ordering, add an explicit server-owned lane key. Do not accept arbitrary client-provided lane strings.
- Lifecycle/build jobs are barriers, not ordinary admissions: work admitted before a transition either finishes under the old generation or receives a lifecycle error; later work cannot enter the child until the barrier completes. Builds are exclusive. Mixed request/notification order is preserved at ingress.
- Third-party sequential children still receive protocol lines in deterministic admission order. Built-in children may complete out of order only through their declared keyed/read lanes and one ID-correlated response writer.
- Shared extension lanes enforce per-client admission caps and bounded round-robin fairness across clients while preserving per-client/resource order. One device cannot occupy all business capacity or starve another device indefinitely; strict global arrival order yields only where fairness selects the next eligible client.

### Built-in extension sub-lanes

The outer per-extension lane is the compatibility floor, not the final performance topology for built-ins:

- Codex mutations use FIFO lanes keyed by `threadId`; config writes use one global config lane; narration admission uses one global lane; filesystem/transcript/app-server reads use bounded read pools. Different threads may progress independently after the app-server adapter stops clearing all pending requests when one request fails.
- Terminal session mutations use FIFO lanes keyed by `(sessionId, sessionGeneration)`. Listing and context reads use bounded read lanes. At session creation, permanently transfer the PTY writer to one dedicated per-session writer worker; shared terminal state retains only its bounded command sender and generation metadata. No blocking `write_all` or `flush` occurs while holding global terminal state.
- A built-in extension's stdout writer remains a single serialization point for encoded response lines, but handler execution does not own the stdin reader or stdout writer for its full duration.

The built-in child dispatcher must assign order before spawning work and use one response writer task. This is P1, not a punt, because a single Codex request otherwise still blocks every Codex read and a blocked Terminal PTY write still blocks unrelated sessions.

### Capacity and overload

Implementation constants must be named, documented, and included in status/diagnostics. Initial values are implementation-tunable, but the contract is mandatory:

- per-client outstanding request cap;
- per-route queued job cap;
- global queued/in-flight cap;
- reserved control capacity that business work cannot consume.

When a request cannot be admitted, return a stable JSON-RPC `server busy` error with retry metadata for safe reads. Do not leave it pending until the caller's timeout. Notifications that cannot be admitted follow their method's delivery contract; lossless input is not silently dropped.

Queued jobs for a disconnected client are removed before execution. In-flight mutations may finish because cancellation could create a more dangerous partial outcome; their response is dropped and the caller treats the result as unknown.

### Extension-process boundary

`ExtensionSupervisor` already owns a mailbox and a pending-response map. This pass must:

- bound its mailbox and stdin writer queue;
- accept a per-request execution deadline rather than applying one 300-second default to every method;
- reject pending work promptly when the extension stops or restarts;
- log extension queue time separately from child execution time;
- preserve FIFO delivery to each extension child.

The Codex child currently reads stdio requests sequentially. Outer route lanes first isolate that limitation; the P1 built-in child dispatcher then admits work to the explicit per-thread/global/read lanes above. Mutable stores remain behind their named locks or lanes rather than gaining accidental concurrency.

## Mandatory request policy contract

### Type

Every app/viewer request uses an explicit immutable policy. The source form may be generated into TypeScript and Rust registries, but it contains at least:

```ts
export type RpcCompletion =
  | 'local-immediate'
  | 'bounded-local-work'
  | 'downstream-ack'
  | 'job-ack'
  | 'long-operation';

export type RpcTimeoutHealth =
  | 'connection-failed'
  | 'probe-connection'
  | 'route-only'
  | 'operation-only';

export type RpcRetry =
  | 'read-safe'
  | 'latest-state'
  | 'effect-idempotent-reconcile'
  | 'deduplicated'
  | 'never';

export type RpcDownstreamRetry =
  | 'read-safe'
  | 'only-definitely-not-written'
  | 'never';

export type RpcLaneResolver =
  | { kind: 'control'; key: 'connection' | 'global' }
  | { kind: 'read-pool'; pool: string }
  | { kind: 'extension'; extensionId: string }
  | { kind: 'param-keyed'; pool: string; field: string };

export type RpcRequestPolicy = Readonly<{
  name: string;
  effect: 'read' | 'convergent-mutation' | 'mutation';
  completion: RpcCompletion;
  lane: RpcLaneResolver;
  budget: {
    connectWaitMs: number;
    queueMs: number;
    executionMs: number;
    transferMs?: number;
    totalMs: number;
  };
  timeoutHealth: RpcTimeoutHealth;
  retry: RpcRetry;
  downstreamRetry: RpcDownstreamRetry;
  executionDeadlineOutcome:
    | 'canceled'
    | 'may-complete-outcome-unknown'
    | 'detached-queryable-job'
    | 'expected-disconnect';
  idempotency?: 'operation-id' | 'input-sequence' | 'state-revision';
  maxRequestBytes?: number;
  maxResponseBytes?: number | ((params: unknown) => number);
  expectsDisconnect?: boolean;
}>;
```

The exact field names may change during implementation, but the decisions may not collapse back into one timeout or one retry boolean.

`totalMs` is one absolute deadline created at the originating caller. Waiting for a native connection, crossing the WebView bridge, queueing at the runtime, extension execution, downstream calls, reconnect retry, and response transfer all consume that same budget. Within WebView/native code, use one device-monotonic deadline or forward remaining milliseconds. Across the socket, send only remaining duration plus stable policy identity: the runtime caps it against its registry and starts a server-local monotonic deadline. Device/server wall clocks or client-supplied queue/execution policy are never trusted. A retry never receives a fresh full deadline.

The default connection-acquisition cap is 6 seconds and is always shorter than a long operation. Queue deadlines begin at runtime admission, execution deadlines begin when a worker starts, and transfer deadlines cover large responses such as terminal replay, files, and narration audio. Queue expiry proves overload, not transport death.

Typed errors identify which phase expired: connection acquisition, queue, execution, transfer, or total. A safe retry is possible only after a phase timeout with positive total budget remaining; total-deadline exhaustion is final. `effect-idempotent-reconcile` never means replay the mutation—it means issue the named authoritative read and report the reconciled/unknown outcome.

### Enforcement

- Remove the 300-second default from `packages/viewer-kit/src/ipc.ts`. `requestIpc` requires a policy.
- Change `RemuxConnection.request` to require a policy instead of an optional numeric timeout.
- Keep raw numeric deadlines private to `RemuxRpcClient`; no feature code imports or calls the raw client.
- `ExtensionWebView` validates a stable policy name/method pair against the installed manifest and forwards only the identity and remaining absolute deadline. The runtime performs its own lookup and does not trust client-supplied lane, retry, or size metadata.
- Replace `isRetryableRemuxRequest(method)` with `policy.retry`.
- Add `RemuxRequestTimeoutError` carrying method, request ID, policy name, connection generation, sent time, last inbound time, and deadline.
- Built-in source must contain no direct request with an implicit policy. Type checking is the primary coverage gate; a repository audit test/lint rule forbids bypass imports.
- Every installed extension manifest declares its request and notification surface. Unknown and legacy/default-routed requests receive `PolicyMissingError`/method-not-found before lane admission; there is no permissive 300-second fallback. The current `legacy/ping` compatibility test is replaced with an explicit manifest-registration test.
- CI compares viewer call sites, native/core routes, extension manifest declarations, extension server handler declarations, and the normative registry. Any missing or duplicate entry fails.
- One layer owns timeout completion. A WebView timeout cancels/removes the native pending RPC; a late result is journaled and ignored, never promoted to a global bridge error or used to reject unrelated requests.

The canonical registry is machine-readable data co-located with core protocol declarations and extension manifests, not a manually duplicated switch in each caller. Generation produces typed viewer descriptors and Rust lookup tables plus a stable policy version/hash. Runtime startup rejects duplicate methods, out-of-namespace extension methods, invalid field selectors, unsafe policy combinations, and manifests whose declared server surface does not match the built artifact.

### Policy rules

| Completion | Deadline guidance | Timeout health | Retry default |
| --- | --- | --- | --- |
| `local-immediate` | 2–5s total | `connection-failed` for control, otherwise `probe-connection` | Reads safe; mutations reconcile/never |
| `bounded-local-work` | Method/size-specific, normally <=60s | `probe-connection` or `route-only` | Safe reads only |
| `downstream-ack` | Sum of bounded downstream hop budgets plus delivery margin | `probe-connection` or `route-only` | Never unless effect-deduped |
| `job-ack` | Admission/validation only, normally <=15s | `probe-connection` | Only with a verified operation ID/ledger |
| `long-operation` | Explicit upper bound, currently <=600s | `operation-only` | Never |

Additional invariants:

- `expectsDisconnect` is reserved for `remux/system/restart`; its successful response schedules the disconnect.
- A mutation with a client-generated ID is not retryable until server-side deduplication is tested and documented.
- Subscription setup may retry only when repeated registration is idempotent for the new connection generation.
- A policy name is stable diagnostic vocabulary, not a free-form label generated per call.
- `downstreamRetry` is independent from reconnect retry. Protocol/application errors are never retried. A downstream mutation may retry only when no request bytes were written or its deduplication contract covers the entire multi-step effect.
- Client total deadline must exceed the runtime/extension execution deadline by queue and response-delivery margins.
- Param-dependent methods use a closed resolver. For example, tmux `refresh` is read-safe while `new-window`, scrolling, detach, and close are mutations; no caller may override the resolver result.
- A timeout does not prove cancellation. Policies state whether work was canceled, detached, or may have completed with an unknown outcome, and mutations surface `OutcomeUnknownError` when appropriate.

## Timeout as liveness evidence

Track `lastInboundAt` whenever any frame arrives, before JSON parsing or subscriber dispatch.

### Immediate acknowledgement timeout

A `local-immediate` method with `connection-failed` is itself a liveness probe. On timeout:

1. transition the current generation to `suspect`;
2. start a replacement connection immediately;
3. do not wait for the periodic ping;
4. do not replay a mutation;
5. retry one safe read after the replacement connection is promoted.

Other inbound notifications do not excuse a failed control-plane acknowledgement. A control lane that cannot answer is unhealthy even if a data stream is still arriving.

### Bounded-work timeout

On `probe-connection`:

- if inbound traffic arrived after the request was sent, report a method/extension timeout without declaring the transport dead;
- if no inbound traffic arrived, start connection recovery and an out-of-band health classification probe;
- never replay a mutation automatically.

### Long-operation timeout

Report an operation failure and independently check connection health. Do not label the socket dead solely from that deadline. Re-read extension status to establish the authoritative outcome.

## Foreground idle heartbeat

The heartbeat is activity-driven:

- Run only while the Expo app is active.
- Any inbound response or notification postpones the heartbeat.
- After 10 seconds with no inbound traffic, issue `remux/system/ping` with the health-bearing local-immediate policy and a 3-second deadline.
- Only one heartbeat may be in flight.
- A missed heartbeat starts replacement-connection recovery immediately.
- On `AppState` transition to active, retain the existing immediate resume ping rather than waiting for the idle interval.
- Do not rely on background timers; iOS may suspend them.

After P0, system ping uses reserved control capacity and is valid evidence even while an extension operation is long-running.

## Make-before-break connection replacement

Closing a half-open React Native WebSocket is not a prerequisite for recovery. The provider may hold an active and a candidate client briefly.

The connection layer owns a `DesiredRegistrationStore` containing persistent client ID, session ID, current Expo token, AppState, active target, and a monotonic registration revision. Notification/UI providers update it through `setDesiredRegistration`; candidate handshake asks the store for a snapshot and awaits registration. If the revision changes during handshake, the candidate applies the newest revision before promotion. Stale revisions are rejected server-side and cannot overwrite newer target/token/app-state data.

1. A liveness failure starts one single-flight candidate connection for the current settings generation.
2. Candidate WebSocket connect retains the existing 6-second bound.
3. Candidate must complete a health-bearing `remux/system/ping`; silence never counts as compatibility. `system/info` follows for metadata but may not swallow timeout as a compatibility fallback.
4. Candidate completes `remux/clients/register` with the current client/session/target before it can receive audience-forming work.
5. Promotion atomically increments the connection generation, swaps `clientRef`, clears suspect state, and resolves connection waiters.
6. On registration, the server atomically marks the candidate as the session's broadcast-active socket and demotes the prior owner to response-draining only. The app buffers/withholds candidate events until its local promotion, so ordinary subscribers never observe duplicate pre-promotion delivery.
7. Safe reads eligible for one retry run only after promotion.
8. The old client drains only its already-sent work for a short bound, then closes best-effort. Its late callbacks and responses cannot affect new requests or connection state.
9. If the candidate fails while the old socket recovers, keep serving on the old socket and continue jittered backoff. If both are unusable, surface `reconnecting`.

Multiple timeout sources coalesce into one candidate attempt. Backoff includes jitter and resets only after the handshake, not merely TCP/WebSocket open.

Registration carries a monotonically increasing client connection generation in addition to its desired-state revision. The server atomically retires the prior owner on promotion: old-socket audience recording, origin/subscription mutations, and late registration side effects are rejected for the logical client/session, while direct responses for already-sent old requests may drain. Audiences and socket subscriptions record their owning generation. Disconnect removes state only when the stored owner is the disconnecting socket/generation. Host request IDs are scoped by connection and every host response returns on the socket that issued its request, even while active and candidate sockets coexist.

## HTTP classification probe

Use a fresh, aborted HTTP request diagnostically after a suspected WebSocket failure. `/healthz` is an unauthenticated transport/process reachability check; authenticated `/api/status` is the stronger runtime/control-path check. Neither is allowed to delay candidate WebSocket creation.

| WebSocket | HTTP probe | Classification |
| --- | --- | --- |
| Failed | `/api/status` succeeds | WebSocket generation/path or per-socket dispatch failure; runtime control path alive |
| Failed | `/healthz` succeeds, `/api/status` fails | Worker/process reachable but authenticated runtime work unhealthy or mismatched; log both results |
| Failed | Both fail | Network path or runtime unavailable; continue reconnect backoff |
| Works | HTTP fails | Inconsistent/captive/cache condition; log, do not restart automatically |

Use a 3–5 second `AbortSignal`, `cache: 'no-store'`, and URL parsing that handles query strings correctly. The HTTP result never gates opening a replacement WebSocket and never directly triggers runtime restart. The `/remux/extensions` catalog fetch also receives an abort deadline and must clear its deduplicated in-flight promise on timeout so a transient path failure cannot freeze extension loading indefinitely.

## Outbound backpressure and slow clients

Replace each unbounded WebSocket outbound channel with a bounded queue that accounts for frames and encoded bytes.

Delivery classes:

- **Mandatory:** RPC responses, host requests, connection control, close frames. Never silently drop.
- **State invalidation:** may coalesce identical resource/status invalidations because the receiver re-reads authoritative state.
- **Latest value:** resource samples may replace an older unsent sample.
- **Replayable stream:** terminal output may rely on session sequence/replay after reconnect, but a drop must force resync rather than create an invisible gap.

When mandatory data cannot be admitted, mark the client slow and close the socket with an explicit server-overload/try-again reason. Do not retain an unbounded tail in memory. Emit one structured event containing connection ID, queued frames/bytes, largest contributors, and last inbound age.

The writer must reserve capacity for control responses or use a priority queue with fairness. A terminal burst cannot starve the heartbeat response that causes the phone to recover.

Slow-client termination has an out-of-band cancellation/direct-close path or an independently reserved close slot. It never relies on enqueueing a close frame into the queue that is already saturated.

Bounds cover all protocol stages, not only the WebSocket writer: app pending requests, runtime host-pending requests, dispatcher lanes, extension actor mailboxes, child stdin/stdout relays, extension pending requests, NotificationManager/Expo delivery, log bursts, Terminal input/output, and WebView attach-resync buffers. Limits are count-and-byte aware. WebSocket frames and newline-delimited extension frames have explicit maximum encoded sizes; large supported transfers are chunked rather than exempted.

Extension disk log persistence uses a bounded dedicated writer/off-thread path; the in-memory ring and subscription batching do not hold the shared log-state mutex across file writes or rotation. Resource sampling is off-thread, single-flight, deadline-bounded, and cache-only from control handlers: before the first sample or after a slow sample, `system/resources` returns an explicit pending/stale snapshot rather than waiting.

## Codex downstream request policies

The Codex `AppServerRuntime` is a second RPC boundary and follows the same discipline.

Current blanket behavior is prohibited:

- no universal 300-second downstream deadline;
- no retry of every error;
- no automatic replay of mutations after a response timeout or connection loss;
- no second 300-second attempt that outlives the outer app and extension deadlines.

Define method policies for every app-server method used by the Codex extension:

- validation/protocol/application errors are never retried;
- a failure proven to occur before send may reconnect and retry according to method safety;
- read-only calls may retry once after reconnect;
- mutation calls never retry after send unless a verified idempotency key and deduplication contract exists;
- downstream deadline is shorter than the extension-supervisor and Expo client deadlines;
- logs include attempt, method, deadline, and whether send was known to occur.

The exhaustive Codex table in this spec is an implementation gate. New downstream methods must add a policy before compiling/tests pass.

## Reconnect resynchronization contracts

Promoting a new socket does not replay arbitrary pending work. Each surface restores authoritative state:

- **App notification identity:** register the client/session/active target on the promoted generation. Socket/origin event subscriptions are generation-scoped and recreated; push notification audiences are logical client/target/session state and are preserved, rebound, or explicitly reconciled without a delivery gap. They are not Terminal output subscriptions.
- **Extension status/resources/log subscriptions:** repeat idempotent subscription setup and re-read the current snapshot.
- **Codex:** invalidate/re-read thread, transcript, queue, model/config, and other declared resources needed by mounted viewers; do not resend a message mutation whose result is unknown.
- **Terminal:** re-attach with the last received output sequence and consume replay; a truncated replay remains an explicit stale/gap state.
- **Terminal input:** retain only bounded, acknowledged-sequence-safe input; reattach the same session generation before retrying an unacknowledged sequence. Reject stale input if the session generation changed.
- **Files:** re-read visible/expanded resources; filesystem change subscriptions are generation-scoped.
- **WebViews:** receive `host/connection` with a monotonically increasing generation. A mounted viewer must be able to distinguish initial connect from reconnect.

Every built-in extension audit must name its reconnect behavior. “The WebView will reload eventually” is not an accepted contract.

## Observability

### Server RPC lifecycle

Record structured events or metrics with:

```text
connectionId, connectionSequence, requestId, method, routeLane,
receivedAt, startedAt, completedAt, queueMs, executionMs,
policyName, policyVersion, operationId, retryAttempt,
outcome, ambiguityState, responseBytes, clientPresentAtCompletion
```

Do not emit a noisy info log for every fast request by default. Always journal:

- requests exceeding the slow threshold;
- queue admission failures;
- timeouts and cancellations;
- route queue high-water marks;
- responses completed after client disconnect;
- slow-client outbound overflow;
- control-lane latency above its target.

Expose in `/api/status`:

- route queue depth and oldest age;
- per-client last inbound age;
- in-flight counts;
- outbound queued frames/bytes;
- timeout/overload counters since worker start.
- per-phase timeout counts, oldest host-pending request, and registration owner/revision;
- extension child ingress/egress depth and last response-line age;
- Terminal per-session input bytes, accepted/deduped/gap sequences, output/replay gaps, and subscription count;
- Codex downstream connection generation, pending count, and retries by proof class per primary/narration adapter, plus quarantined operations.

### App incident ring

Persist a bounded local incident ring because a broken socket cannot deliver its own diagnostics. Entries include:

- connection generation and candidate generation;
- AppState and connection-state changes;
- last inbound/outbound times;
- request method/policy/timeouts;
- heartbeat start/result;
- WebSocket ready state and close code;
- `/healthz` classification;
- authenticated `/api/status` classification and catalog-fetch timeout;
- reconnect attempt, backoff, handshake, promotion, and resync outcome.

Flush the prior incident summary after a healthy connection is promoted, with redaction and a strict size cap.

## Exhaustive RPC policy tables

The tables below are normative for the built-in surface found on 2026-07-11. CI regenerates or compares them against handlers, manifests, and call sites. “Dynamic/default” routing is not an exemption.

Budget columns use `execution / total`; the generated policy still contains every phase. Unless overridden, local/control methods use at most 1 second to acquire a connection and 500ms in queue, ordinary routed methods use 3 seconds to acquire and 2 seconds in queue, and long operations use 6 seconds to acquire and 5 seconds in queue. All phases consume the one total budget. Large-transfer rows reserve the stated remainder for encoding/wire delivery.

Retry vocabulary:

- **read**: once, only after promotion of a new connection and within the original deadline;
- **latest**: reconcile the newest desired state rather than replaying an obsolete command;
- **reconcile**: do not promise the same response; re-read authoritative state after an ambiguous result;
- **dedupe**: retry only the same stable operation ID against a tested server ledger;
- **never**: surface outcome unknown after an ambiguous send.

### Core, runtime, app-host, filesystem, and extension management

| Method | Completion and lane | Budget | Timeout health | Retry/outcome contract |
| --- | --- | ---: | --- | --- |
| `remux/system/ping` | Local-immediate; reserved control | 1s / 3s | Connection failed | Read; active/candidate socket only, no connection wait |
| `remux/system/info` | Local-immediate; reserved control | 1s / 3s | Connection failed | Read; errors and silence are not compatibility fallbacks |
| `remux/system/restart` | Local-immediate; reserved control | 1s / 3s | Connection failed, `expectsDisconnect` | Never; one-shot scheduling, response writer barrier, then observe a new worker generation |
| `remux/system/resources` | Local-immediate snapshot; core read | 3s / 5s | Connection failed after sampling is moved off the runtime thread | Read; never perform first-use `/proc` sampling inline |
| `remux/clients/register` | Local-immediate; connection barrier | 1.5s / 3s | Connection failed | Latest registration revision only; persist token atomically off the request path |
| `remux/system/resources/subscribe` | Local-immediate; connection subscription | 1s / 3s | Connection failed | Latest desired socket-scoped set |
| `remux/system/resources/unsubscribe` | Local-immediate; connection subscription | 1s / 3s | Connection failed | Latest desired socket-scoped set |
| `remux/extensions/status` | Local-immediate snapshot; core read | 3s / 5s | Connection failed | Read; filesystem facet is bounded/off-thread |
| `remux/extensions/logs` | Bounded local snapshot; core read | 3s / 5s | Probe connection | Read; clamp `lines`, response bounded by the 500-line ring |
| `remux/extensions/logs/subscribe` | Local-immediate; connection subscription | 1s / 3s | Connection failed | Latest; subscribe commits before the following logs snapshot to avoid a gap |
| `remux/extensions/logs/unsubscribe` | Local-immediate; connection subscription | 1s / 3s | Connection failed | Latest desired socket-scoped set |
| `remux/extensions/start` | Long operation; target extension lifecycle FIFO | 580s / 600s shared operation budget | Operation only | Never; even `rebuild:false` may build missing/failed artifacts; reconcile with status |
| `remux/extensions/stop` | Long operation; target extension lifecycle FIFO | 30s / 40s | Operation only | Never; effect may have completed, reconcile with status |
| `remux/extensions/restart` | Long operation; target extension lifecycle FIFO | 580s / 600s shared operation budget | Operation only | Never; restart may implicitly build; repeated restart is a new interruption |
| `remux/extensions/watch/start` | Long operation; target extension lifecycle FIFO | 580s / 600s | Operation only | Never; reconcile with status |
| `remux/extensions/watch/stop` | Long operation; target extension lifecycle FIFO | 30s / 40s | Operation only | Never; reconcile with status |
| `remux/extensions/server/build` | Long operation; target extension exclusive FIFO | 580s / 600s | Operation only | Never; future job API preferred |
| `remux/extensions/views/build` | Long operation; target extension exclusive FIFO | 580s / 600s | Operation only | Never; future job API preferred |
| `remux/fs/readDirectory` | Bounded local work; global bounded FS pool/path dedup | 20s / 30s | Probe connection | Read |
| `remux/fs/readDirectories` | Bounded local work; global bounded FS pool | 45s / 60s | Probe connection | Read; cap path count and preserve internal concurrency cap |
| `remux/fs/readFile` | Bounded local work/transfer; global bounded FS pool | 30s / 60s | Probe connection | Read; reserve transfer budget, keep existing content-size caps |

The router admits only these exact built-in core methods. A new `remux/fs/*`, `remux/system/*`, or `remux/extensions/*` string does not inherit the family policy.

One lifecycle absolute deadline covers stop/spawn, server build, and every declared view build. Each subprocess receives only the remaining operation budget; later phases are canceled/skipped with a typed deadline result when no margin remains. Fast no-build starts still return immediately, but callers never assume artifacts exist from `rebuild:false`.

Restart uses a one-shot atomic guard. Shutdown delay begins after the response occupies reserved outbound capacity and the writer reports write/flush acceptance, with a short hard fallback so a malicious or non-reading client cannot prevent restart forever. Duplicate restart requests observe the already-scheduled state and cannot schedule a second shutdown.

#### Viewer-to-native local host bridge

These calls never enter the Remux socket and never influence backend connection health, but they use the same mandatory registry and one-deadline rule so WebView IPC cannot surprise callers.

| Method | Completion | Total | Retry/outcome |
| --- | --- | ---: | --- |
| `host/viewport/get` | Local-immediate read | 1s | Read |
| `host/theme/get` | Local-immediate read | 1s | Read |
| `host/keyboard/dismiss` | Local-immediate convergent action | 1s | Latest |
| `host/clipboard/read` | Bounded device read | 3s | Read |
| `host/tab/update` | Local-immediate latest-state mutation | 1s | Latest with tab epoch/version |
| `host/tab/close` | Local-immediate ACK before deferred close | 1s | Never after ACK loss/page disappearance |
| `host/view/reload` | Local-immediate ACK before deferred reload | 1s | Never |
| `host/overview/open` | Local-immediate navigation | 3s | Dedupe by navigation operation ID |
| `host/file/open` | Local-immediate navigation | 3s | Dedupe by navigation operation ID |
| `host/link/open` | Bounded external side effect | 3s | Never |
| `host/attachments/pick` | Long user operation | 120s | Never; timeout health is operation only |

### Codex extension and Codex app-server downstream calls

#### Viewer-to-Codex requests

| Method | Completion and lane | Budget | Timeout health | Retry/outcome contract |
| --- | --- | ---: | --- | --- |
| `remux/codex/composer/config/read` | Local-immediate; config read | 1s / 3s | Probe connection | Read |
| `remux/codex/models/read` | Downstream ACK (`model/list`); app-server read pool | 10s / 15s | Route only, then probe if socket silent | Read; downstream read retry once |
| `remux/codex/files` listing/details | Bounded local work; Codex FS pool | 7s / 10s | Route only | Read; cap batch/result size |
| `remux/codex/files` recursive search | Bounded local work; Codex FS pool | 15s / 20s | Route only | Read; retain/codify 30,000-entry ceiling |
| `remux/codex/files` bytes | Bounded local work/transfer; Codex FS pool | 30s / 60s | Operation only | Read; resolver scales transfer budget, target caps below replace the unsafe 64MiB single-line ceiling |
| `remux/codex/transcript/resources/read` | Bounded local work; per-thread transcript/cache read | 20s / 30s | Route only | Read; cache mutation remains synchronized |
| `remux/codex/thread/resources/read` local-only resources | Bounded local work; per-thread read | 3s / 5s | Route only | Read |
| `remux/codex/thread/resources/read` app-server-backed resources | Downstream ACK; per-thread/app-server read pool | 15s / 20s | Route only | Read; batch subrequests share the one deadline |
| `remux/codex/narration/resources/read` | Local-immediate; artifact read | 1s / 3s | Probe connection | Read |
| `remux/codex/narration/audio/read` | Bounded local work/transfer; Codex FS pool/artifact | 30s / 60s | Operation only | Read; existing 8MiB WAV cap |
| `remux/codex/composer/config/write` | Bounded local work; global config mutation | 3s / 5s | Probe connection | Reconcile by config read; identical state write is convergent |
| `remux/codex/thread/queue/remove` | Local-immediate; thread FIFO | 1s / 3s | Probe connection | Reconcile queue; missing operation is accepted |
| `remux/codex/narration/cancel` | Local-immediate admission; artifact/global narration lane | 1s / 3s | Probe connection | Reconcile narration state; detached interrupt is best effort |
| `remux/codex/narration/start` | Job ACK after bounded validation; global narration admission/artifact | 10s / 15s | Probe connection | Dedupe only within the same extension generation by deterministic artifact/operation ID; request/job caps below apply; completed disk cache remains reusable |
| `remux/codex/thread/queue/run-now` | Downstream ACK when active; thread FIFO | 25s / 30s | Route only | On ambiguous steer, quarantine as `outcomeUnknown`; do not retain/redrive until authoritative reconciliation |
| `remux/codex/thread/message/send` | Downstream ACK or local queue acceptance; thread FIFO | 25s / 30s | Route only | Never until one client operation ID dedupes both queue admission and downstream turn creation |
| `remux/codex/thread/compact` | Downstream ACK or local queue acceptance; thread FIFO | 25s / 30s | Route only | Never until operation ID dedupes queue and direct paths |
| `remux/codex/thread/message/start` | Multi-hop downstream ACK; new-thread operation lane | 35s / 45s | Route only | Never until one ledger covers thread creation plus turn creation |
| `remux/codex/thread/message/edit` | Multi-hop downstream ACK; thread-exclusive FIFO | 35s / 45s | Route only | Never; ambiguous replay can roll back twice |
| `remux/codex/thread/message/fork` | Multi-hop downstream ACK; source-thread exclusive until fork ID exists | 80s / 90s | Route only | Never; covers 30s bounded pagination plus mutation hops; ambiguous replay can create multiple forks or roll back twice |
| `remux/codex/thread/turn/interrupt` | Downstream ACK; thread FIFO | 10s / 15s | Route only | Reconcile runtime/queue; no raw downstream replay |

`thread/resources/read` and `files` are closed param-resolved policies, not wildcards. For thread resources, `threadRuntime`, `threadOperationQueue`, and `threadTokenUsage` are local; `threadHistory` uses `thread/list`; `threadSummary` uses `thread/read`; and `threadComposerState` uses `thread/read` plus rollout-file work. A heterogeneous batch is validated once, split into bounded local and app-server read subjobs, and rejoined by `requestIndex`; app-server subjobs use one global bounded read pool while per-thread cache work retains its keyed synchronization.

Normative admission caps are 32 file subrequests, 64 thread-resource descriptors, and 64 transcript-resource descriptors. Encoded responses are capped at 12MiB for `remux/codex/files` and 8MiB for thread/transcript resource reads. A files byte subrequest is capped at 8MiB raw, replacing the current 64MiB single-line allowance; search returns at most 200 results while visiting at most 30,000 entries, plus the encoded-response limit. Oversized work receives a typed too-large error and must be split/paged by the caller. The extension child protocol caps an encoded line at 16MiB, large enough for the allowed single response plus envelope but not an exemption from response caps.

Narration admission is bounded before deserialization/validation performs expensive cloning, hashing, or transcript work:

- `narration/start` params are at most 2MiB encoded and `sourceText` is at most 512KiB UTF-8;
- a source document contains at most 2,048 blocks, 8,192 targets, and 32,768 total inline-range/target-reference associations;
- individual IDs and paths are at most 1KiB UTF-8;
- only one narration job is active, and the in-memory job index retains at most 128 inactive entries with LRU eviction of ready/failed/cancelled metadata; validated completed artifacts remain authoritative on disk;
- at most one planning-event subscription belongs to an attempt and at most four exist globally as a defensive cap; every exit path removes its subscription.

The Kokoro worker boundary is bounded independently of the Codex child protocol. Its encoded request and any one stdout event are at most 8MiB; its event relay holds at most 64 events/16MiB, coalescing progress to the latest value while preserving terminal manifest/error events. Captured stderr is capped at 1MiB with explicit truncation. Oversized/no-newline output or relay overflow terminates and reaps the worker, fails the job, and cleans temporary artifacts rather than growing memory.

The Codex queue is process-memory state, so `send` and `compact` are not described as durable jobs. A later queue-first/durable operation protocol may make them retryable, but P0/P1 reports ambiguous outcomes honestly.

#### Codex-to-app-server downstream requests

Interactive calls consume the outer request's remaining absolute deadline. Detached narration work instead receives its own job-owned monotonic deadline context at admission; downstream calls consume the job's remainder. The per-hop cap below is a maximum, not a fresh budget.

| App-server method | Per-hop cap | Safety and downstream retry |
| --- | ---: | --- |
| `initialize` | 10s including connect | Handshake request; never generic-retry on application/protocol error; a new connection attempt gets a new handshake budget within caller/job total |
| `initialized` notification | Immediate after matched initialize ACK | Must follow successful handshake once per downstream connection; no response/retry |
| `model/list` | 10s | Read; retry once on a promoted downstream connection |
| `thread/list` | 10s | Read; retry once |
| `thread/read` | 10s | Read; retry once |
| `thread/turns/list` | 5s per page, 30s aggregate | Read; retry current page once; maximum 8 pages and 2,000 turns, reject repeated/cyclic cursors |
| `thread/resume` | 10s | Convergent effect, but response may be ambiguous; retry only if definitely not written, otherwise reconcile |
| `thread/start` | 15s | Mutation; never after write. Caller operation ledger must cover the created thread before any future retry is enabled |
| `thread/rollback` | 10s | Destructive mutation; never after write |
| `thread/fork` | 15s | Creating mutation; never after write |
| `turn/start` | 15s | Mutation; never after write unless the entire outer operation is server-deduplicated |
| `turn/steer` | 10s | Mutation/additive input; never after write |
| `thread/compact/start` | 15s | Mutation; never after write |
| `turn/interrupt` | 10s | Convergent intent, ambiguous response; only definitely-not-written retry, otherwise reconcile |

Application/protocol errors are final for the attempt. A downstream connection failure affects only requests actually tied to that connection; it must not clear the adapter and drain every unrelated pending request. Pending calls retain their own IDs and deadlines, and reconnect is single-flight. Codex's current “retry every error once for another 300 seconds” behavior is a P0 removal gate.

Both current app-server adapters—the primary interactive adapter and narration's dedicated adapter—use the same mandatory downstream registry, handshake rules, pending isolation, and bounded reconnect machinery. They retain separate connection generations, pending maps, budgets, and metrics; failure or reset of one adapter cannot drain or reconnect the other. Narration requests additionally carry their job-owned remaining budget.

Each app-server transport handshake is policy-covered: connect plus JSON-RPC `initialize` has a 10-second total budget, and `initialized` is emitted only after the matching successful response. Initialization application/protocol errors end that connection attempt; wrong-ID traffic is dispatched/ignored within bounds and cannot extend the deadline. Silent, malformed, and deadline-exhausted initialization closes only that candidate downstream connection.

The current substring-triggered second `thread/resume` call for missing `persistExtendedHistory` is removed in favor of capability/version negotiation during initialization. During a versioned migration only, a typed invalid-params response that proves the first call was not applied may select the legacy payload once; no message-substring or generic application-error retry remains.

Narration jobs have a named 15-minute absolute budget and a 60-second no-progress/stall budget. Expiry cancels the job, terminates the synthesis child, waits up to 5 seconds, kills/reaps if necessary, cleans temporary files, records a terminal job state, and emits the resource invalidation. In-progress deduplication is extension-generation-local: a socket reconnect may retry the same operation against the same generation, but an extension restart never auto-replays it. Startup cleans/tolerates orphaned internal narration turns and reuses only completed validated artifacts.

Narration planning does not retry `plan_complex_blocks` after an arbitrary error. It may make at most one explicit semantic-output retry, and only after a matched `turn/completed` proves the prior turn finished but its returned JSON failed the declared schema/semantic validation. Transport timeout/disconnect, ambiguous `thread/start` or `turn/start`, cancellation, and app-server protocol/application errors are final for that job attempt. Before an allowed second semantic attempt, the first attempt's subscription is removed and any still-active internal turn is interrupted/cleaned; an RAII/finally guard enforces cleanup on every return path. Both attempts share the job deadline, carry distinct `planningAttemptId` values, and are observable as intentional job sub-attempts rather than transport retries.

If `turn/steer` may have been written but its response is lost, `queue/run-now` moves the entry to an explicit `outcomeUnknown` quarantine rather than ordinary `retained`. Automatic queue drive and manual retry are blocked until transcript/runtime reconciliation finds the `clientMessageId` or the user explicitly resolves the ambiguous entry.

### Terminal extension

| Method | Completion and lane | Budget | Timeout health | Retry/outcome contract |
| --- | --- | ---: | --- | --- |
| `remux/terminal/session/list` | Local-immediate snapshot; terminal read lane | 1s / 3s | Probe connection | Read; declared even though no current viewer wrapper uses it |
| `remux/terminal/session/start` | Bounded PTY spawn plus atomic origin output subscription; session FIFO | 7s / 10s | Probe connection | Dedupe by `operationId` plus stable session ID/generation; returns output/replay/input cursors; only “not found” permits attach→start fallback |
| `remux/terminal/session/attach` | Bounded metadata ACK plus atomic origin-scoped output subscription; session FIFO | 5s / 10s | Probe connection | Read/reconcile with identical session generation; returns replay and input cursors |
| `remux/terminal/session/replay/read` *(new)* | Bounded immutable-snapshot page; per-session transfer/read lane | 3s / 5s per page, 30s attach total | Route only | Same-connection read retry only; after disconnect reattach from last rendered sequence for a new cursor |
| `remux/terminal/session/detach` *(new)* | Local-immediate origin subscription removal; connection/session control | 1s / 3s | Probe connection | Latest/convergent; does not kill PTY |
| `remux/terminal/session/write` | Local-immediate ACK into bounded per-session writer queue; session FIFO | 1s / 3s | Connection failed | Dedupe by generation + `inputStreamId` + monotonic `inputSeq`; never replay raw bytes without dedupe |
| `remux/terminal/session/resize` | Local-immediate convergent mutation; session FIFO with latest-value coalescing | 1s / 3s | Probe connection | Latest `resizeSeq`; track desired separately from acknowledged size |
| `remux/terminal/session/kill` | Bounded local mutation; session-generation barrier | 2s / 3s | Probe connection | Dedupe by operation ID and expected generation; ambiguous kill is not followed by an unconditional start |
| `remux/terminal/tmux/context/get` | Local-immediate cached read; keyed tmux read lane | 1s / 3s | Probe connection | Read; background scan is single-flight/coalesced |
| `remux/terminal/tmux/action` with `refresh` | Bounded read/scan; keyed tmux read lane | 10s / 15s | Route only | Read; one outstanding refresh per target |
| `remux/terminal/tmux/action` mutation | Bounded local work through targeted command completion; keyed tmux action FIFO | 2s / 3s target; temporary 10s total until refresh is split | Route only | Dedupe every mutation. Scroll/new-window/close/detach are never raw-retried |
| `remux/system/info` from Terminal | Core local-immediate control policy above | 1s / 3s | Connection failed | Read; only a typed method-not-found permits compatibility fallback |

#### Terminal input contract

The live UI must stop calling `notifyIpc` for writes. Each input chunk carries `{sessionId, sessionGeneration, inputStreamId, inputSeq, data}` and receives an ACK meaning “accepted into the bounded session writer queue.” `inputStreamId` is server-issued and stable for one producer across socket reconnects; the native tab host may retain it across a WebView reload only if it also retains that producer's bounded unacknowledged queue. A new producer/viewer epoch requests a new stream during start/attach. The server dedupes by `(sessionGeneration, inputStreamId, inputSeq)`, while the session FIFO establishes total accepted order across producers.

Start and attach return `{sessionGeneration, nextInputSeq}` for the supplied input stream. Write ACKs return the accepted/next sequence and gap errors return `expectedInputSeq`. Thus a newly attached producer can seed its counter without colliding with another producer or having new input mistaken for a duplicate.

The server remembers the next expected/accepted sequence for each input stream in the session generation:

- the same accepted sequence is acknowledged without writing twice;
- a gap is rejected with `expectedInputSeq`;
- a stale session generation is rejected;
- per-session input bytes and chunks are bounded;
- large paste is split into bounded wire chunks;
- a dedicated session writer performs blocking PTY `write_all`/`flush` outside the global terminal-state mutex.

At most 8 input streams are active per session generation. Each stores only its next contiguous sequence and lease metadata, so every lower sequence is a known duplicate without retaining payload history. Server-issued stream IDs are monotonic within the session generation; detached/expired IDs below the allocator high-water mark are rejected rather than recreated, so expiry cannot execute an old chunk twice. A disconnected stream receives a 2-minute reconnect lease; explicit detach retires it immediately. The 9th stream receives `TerminalInputStreamLimit` until a stream retires.

The viewer keeps a bounded ordered unacknowledged-input queue and retries the same stream/sequence after reconnect/reattach. If disconnected buffering is disabled, input is visibly gated; accepting and silently discarding keystrokes is prohibited.

Every session protocol object carries `sessionGeneration`: list summaries; start/attach responses; detach/write/resize/kill params and ACKs; output/exited events; and replay cursors/pages. Every PTY reader, writer, and wait worker captures `(sessionId, sessionGeneration)` and mutates shared state only while that exact generation remains current. Reusing a session ID cannot let an old reader append output to, or an old wait thread mark exit on, the replacement shell.

#### Terminal output/replay contract

`remux/terminal/session/start` and `session/attach` atomically create or renew a subscription keyed by `(connectionId, remuxOrigin, viewerEpoch, sessionId, sessionGeneration)` before shell output can escape routing. Both return `firstAvailableSeq`, `nextOutputSeq`, `nextInputSeq`, exit state, and a bounded immutable replay snapshot cursor. This preserves output emitted during shell startup, including the initial prompt.

The subscription is not live to the app until the start/attach response has been admitted to that origin's mandatory outbound queue. The Terminal child may buffer/replay output during PTY spawn, and the runtime child-egress sequencer may parse later output lines, but it releases live frames only after the response barrier. The returned `nextOutputSeq` is the exact boundary: snapshot/replay covers lower sequences and released live delivery begins there, so every early sequence renders once.

Live output at or after `nextOutputSeq` may then arrive and is buffered while the viewer pages the fixed pre-start/attach snapshot with `remux/terminal/session/replay/read`. One snapshot holds at most 4MiB/10,000 frames, expires after 30 seconds, and releases on completion/detach/disconnect. Limits are 2 snapshots/8MiB per session, 2 snapshots/8MiB per client, and 64MiB globally; admission failure returns explicit busy/gap metadata so the viewer rebases to the retained tail. Live replay-ring eviction does not mutate an admitted snapshot. Same-socket page retry is safe; after disconnect the cursor is invalid and the viewer reattaches on the promoted socket from its last rendered sequence.

Each page is size-capped, generation-checked, and cannot monopolize the control writer between pages. `remux/terminal/session/detach` removes the origin subscription and retires its input stream without killing the shell; socket close, WebView epoch replacement, tab close, and lease expiry also clean subscription state. Hidden tabs either retain a bounded subscription intentionally or detach and reattach when visible.

`remux/terminal/session/output` remains replayable and sequenced per session generation. The viewer detects `frame.seq > lastSeq + 1`, buffers later frames within a byte cap, and immediately attaches from `lastSeq + 1`. On truncation the viewer clears stale xterm state, displays the retained tail, and exposes a gap indicator; it must not discard the retained replay by returning early. A new generation resets the output cursor and is always rendered rather than compared to the prior generation's `lastSeq`.

Output frames are capped near 32–64KiB raw. A slow client may be disconnected or receive an explicit gap requiring replay, but the runtime never silently advances its client cursor. Session output is routed only to subscribed sockets/origins instead of broadcast to every Terminal WebView. `session/exited` is a final per-session barrier and missed exit is recovered by attach status.

Tmux action mutations are FIFO per tmux socket/client and do not share the terminal input lane. Post-action context refresh is asynchronous/coalesced so a multi-socket scan cannot hold the command ACK or block typing.

### Notifications and server-originated requests

Notifications have a separate mandatory policy with `lane`, `orderingKey`, `delivery`, `maxBytes`, and `overflow`. Delivery is one of `best-effort`, `coalesce-latest`, `coalesce-union`, `replayable-sequenced`, or `must-deliver-or-disconnect`. A request method marked must-ack cannot be sent through `notifyIpc`.

| Direction and method | Policy |
| --- | --- |
| App → runtime `remux/app/log` | Best-effort bounded diagnostic sink, handled without business dispatch; never replay |
| App → extension registered notification | Same keyed extension FIFO as related requests; manifest supplies ordering/delivery; unknown notification is rejected/journaled rather than inheriting a default route |
| Runtime → app `remux/extensions/didChangeStatus` | Coalesce latest per extension; receiver re-reads status |
| Runtime → app `remux/extensions/logs/didAppend` | Preserve bounded tail per subscribed extension; overflow disconnects and receiver snapshots on reconnect |
| Runtime → app `remux/system/resources/didSample` | Coalesce latest sample per client |
| Runtime → app `remux/fs/didChange` | Coalesce union of paths/dirty roots within bounds; overflow degrades to a root/global invalidation |
| Codex → app `remux/codex/resources/invalidated` | Coalesce by resource key; receiver re-reads authoritative resource |
| Codex → app `remux/codex/narration/updated` | Coalesce latest by artifact key |
| Terminal → app `remux/terminal/session/output` | Replayable sequenced per session; explicit gap/reattach on loss or overflow |
| Terminal → app `remux/terminal/session/exited` | Must-deliver-or-recover-by-attach; final session barrier |
| Extension → runtime `remux/notifications/request` | Current notification form: admit to bounded notification-control worker or journal explicit admission failure by stable intent ID; stable intent ID dedupes Expo sends |
| Extension → runtime `remux/notifications/audience/remove` | Ordered notification-control mutation; latest/convergent by audience key |
| Viewer → native `host/preview/invalidate` | Local best-effort/coalesced signal; never enters the Remux socket or health model |
| Native → viewer `host/active` | Coalesce latest AppState/visibility value by viewer epoch |
| Native → viewer `host/connection` | Coalesce latest connection state/generation, must deliver after promotion so resync runs |
| Native → viewer `host/navigate` | Must-deliver-or-explicitly-reject navigation intent, ordered by viewer epoch/resource |
| Native → viewer `host/theme` | Coalesce latest theme value |
| Native → viewer `host/viewport/changed` | Coalesce latest metrics per viewer |
| Other built-in extension event | Explicit manifest policy; non-replayable/non-coalescible events are must-deliver-or-disconnect, never silently dropped |

The sole runtime-originated JSON-RPC request is `remux/notifications/visibility/check`. It uses the control path, has a 500ms operation fallback today, and its response is resolved inline before business lanes. P1 records its send/result as client-liveness evidence and uses a 1-second total deadline calibrated by telemetry. One miss falls back to “not visible.” Two consecutive misses within 10 seconds, with no inbound frame after the first send, mark that client suspect and close only that socket with a liveness-timeout reason; other traffic resets the consecutive-miss counter. Request IDs and pending maps are connection-scoped under dual sockets.

Because `remux/notifications/request` is currently a notification, admission failure cannot be returned to the extension. The implementation must journal it and expose a counter/outcome by intent ID. If extensions require synchronous admission knowledge later, promote it to a registered request/ACK protocol rather than pretending a notification is acknowledged.

Expo notification HTTP calls have explicit connect and total deadlines, a bounded concurrency/queue, stable intent deduplication, and observable outcomes. They never execute on the extension stdout protocol reader. The non-RPC extension-catalog fetch has its own named `extensions-catalog-read` policy: 3-second connect, 5-second total, abort, no-store, and safe retry after clearing the in-flight promise.

## Testing

### Rust WebSocket and dispatcher tests

- Block one extension RPC; verify same-socket `system/ping`, host-response resolution, app diagnostics, and close cleanup remain prompt.
- Reproduce the visibility-check cycle and prove there is no timeout/unmatched late response.
- Send requests to two extension lanes; block one and complete the other.
- Verify FIFO arrival order within one extension lane across two clients.
- Verify response IDs correlate when responses complete out of order across lanes.
- Saturate a business lane; control ping still succeeds and excess work gets `server busy`.
- Disconnect with queued and in-flight work; queued jobs are removed, in-flight response is dropped, and no client state leaks.
- Stop/restart an extension with pending RPCs; all pending callers resolve with the documented lifecycle error.
- Exercise outbound frame and byte limits with a non-reading client; memory remains bounded and the client is closed.
- Verify latest-value coalescing and terminal replay-gap behavior where implemented.
- Hang Expo HTTP delivery behind one extension notification; the next child RPC response still resolves and the HTTP worker deadline releases capacity.
- Feed an oversized/no-newline child protocol frame; memory remains bounded and the extension receives the documented protocol failure.
- Register candidate and active sockets with the same session; closing the old socket cannot remove the candidate registration.
- Under dual sockets, a host response resolves only the pending request on its source socket even when request IDs collide.
- Registration commits before a following audience-forming request; a stale registration revision cannot overwrite newer app-state/target/token state.
- An old socket's late audience-forming response cannot install state after a newer connection generation owns the client/session.
- Subscribe → snapshot ordering for logs/resources has no event gap.
- Mixed same-extension request/notification order and ordinary-request → restart/build → ordinary-request barrier behavior are deterministic.
- A successful child response's audience record commits before a later child-line audience removal.
- Same-extension requests may complete out of admission order only where inner policies allow it; third-party sequential delivery stays ordered.
- Global FS concurrency remains bounded across simultaneous batches; excessive path count and unknown `remux/fs/*` fail before execution.
- Slow off-thread resource sampling is single-flight and returns cached/pending data while ping remains fast.
- Build/stderr log flood cannot hold the runtime mutex or exceed control-lane latency target.
- Restart duplicates schedule one shutdown, the normal response is written before close, and a stalled writer cannot block restart indefinitely.
- Ordinary start with missing artifacts, restart after failed build, and server + multiple view builds all consume one shared operation deadline.
- Exhausted ordinary/reserved output queues still close through the out-of-band path.
- A client at its business cap cannot starve another client, another extension, or reserved control capacity.

### Policy coverage tests

- TypeScript compilation fails for `requestIpc` or `RemuxConnection.request` without policy.
- Lint/test forbids raw `RemuxRpcClient` use outside the connection module.
- Every built-in method in the audit tables has at least one named policy test.
- Policy validation rejects invalid combinations such as `long-operation + connection-failed` or `mutation + safe retry` without a dedup contract.
- Server-side request deadline never exceeds the client deadline minus delivery margin.
- Codex downstream policy coverage fails when a new app-server method is called without registration.
- Protocol/application errors are not retried; safe pre-send/read failures are retried at most once.
- Compare exact Rust core routes, extension server match arms, installed manifest methods, viewer call sites, and generated registries in both directions.
- Fail when a must-ack method such as Terminal write is sent through `notifyIpc`.
- Cover closed param resolvers for Codex resource/file requests and every tmux action variant.
- Assert no generic 300-second fallback remains at viewer, native socket, extension supervisor, or Codex downstream layers.
- Queue/execution/transfer timeout with remaining total budget may perform only its declared safe recovery; total-deadline exhaustion never retries.
- `effect-idempotent-reconcile` dispatches an authoritative read and never replays the original mutation.

### Expo connection tests

Use an injectable WebSocket factory, clock, AppState source, and health fetcher.

- `OPEN` socket that never replies to a hard-ack request becomes suspect and starts one candidate connection.
- Candidate promotion is make-before-break and ignores every late callback from the old generation.
- Ordinary inbound traffic postpones the idle ping.
- Foreground idle at 10 seconds sends one ping; success reschedules, timeout recovers.
- Background suspends periodic heartbeat; resume sends an immediate ping.
- Multiple simultaneous timeouts coalesce into one reconnect attempt.
- Safe read retries once after promotion; mutation returns outcome-unknown and is not replayed.
- Bounded-work timeout plus newer inbound traffic remains a method failure, not a transport failure.
- `/healthz` result classifies diagnostics but never restarts Remux.
- Registration/subscriptions bind to the promoted generation exactly once.
- A WebView timeout cancels/removes its native pending request; late success/error is ignored without poisoning bridge status or unrelated requests.
- One absolute deadline is reduced across connection wait, bridge forwarding, queue, reconnect retry, execution, and transfer.
- `/remux/extensions` fetch aborts, clears the deduplicated promise, and succeeds on a later retry.
- Candidate handshake consumes the latest desired-registration revision if token/target/AppState changes mid-handshake.
- Two consecutive visibility misses with no inbound traffic close only the suspect socket; intervening traffic resets the counter.
- HTTP probes use no-store and abort deadlines, health paths work with query strings, and neither probe delays reconnect or restarts the runtime.
- Incident ring persistence enforces redaction and byte/entry caps.

### Built-in extension concurrency and recovery tests

- Two Codex commands for one thread execute in ingress order; different threads progress independently once the app-server adapter is safe for concurrent pending calls.
- One failed Codex downstream request does not clear unrelated pending reads/commands; application errors never reconnect/retry.
- Edit replay cannot roll back twice; fork/start cannot create two threads; send/compact cannot enqueue twice.
- Terminal input ACK lost after acceptance, then retried with the same sequence, reaches the PTY exactly once.
- Terminal duplicate input is acknowledged without a second write; a sequence gap reports the expected sequence; stale session generation is rejected.
- Large paste is chunked, ordered, and bounded; queue saturation returns explicit busy.
- A blocked PTY writer for session A does not hold global terminal state or block session B, list, attach, ping, or tmux input.
- Resize coalesces to the latest revision without permanently suppressing a failed desired size.
- Kill is a session-generation barrier and ambiguous kill does not trigger unconditional start.
- Tmux mutations are FIFO per target while Terminal input remains responsive; polling/refresh is single-flight.
- A live output sequence jump triggers attach immediately; truncated replay renders the retained tail and exposes a gap.
- Replay transfer is chunked so control ping can complete between chunks.
- Codex app-server connect/`initialize` covers silence, wrong IDs, malformed/error responses, and deadline exhaustion; `initialized` follows one matched success.
- Narration background downstream calls consume a job deadline independent of the completed viewer request; a permanently hung worker is terminated/reaped and temporary files are cleaned.
- Primary and narration app-server adapters both pass policy/handshake coverage; a failure/reset in either adapter leaves the other's pending calls and connection generation untouched.
- Narration planning transport ambiguity, timeout, cancellation, and app-server errors never start a second internal thread/turn; a known-completed schema-invalid result permits at most one labeled semantic retry after subscription/turn cleanup.
- Every narration planning return path removes its event subscription, including `turn/start` failure and timeout; semantic retry cannot leak the first attempt's internal subscription or active turn.
- Narration start rejects encoded payload, source-text, block, target, association, ID/path, active-job, and retained-job limits before expensive work.
- Narration job-index churn evicts only inactive metadata within its LRU bound while completed disk artifacts remain readable.
- Kokoro progress flood, oversized/no-newline stdout, excessive stderr, and relay saturation stay within event/byte caps, terminate/reap the worker when required, and clean temporary artifacts.
- Resume compatibility uses negotiated capability or the one typed not-applied fallback, never error-substring matching.
- Fork pagination rejects cyclic cursors and the 9th page/2,001st turn; its 30-second pagination aggregate leaves the remaining 50-second execution budget for resume/fork/optional rollback/turn-start hops.
- Every `thread/resources/read` discriminator and a heterogeneous multi-thread batch returns results by `requestIndex` within pool bounds.
- Codex request-count, raw-byte, encoded-response, and child-line caps reject oversized batches deterministically.
- A `turn/steer` that applies but loses its response quarantines the queue entry and cannot redrive automatically.
- Narration start retry is deduplicated across socket reconnect in one extension generation and is not auto-replayed across extension restart.
- Kill/start with the same Terminal session ID cannot accept old reader output or an old wait-thread exit into the new generation.
- New-generation output with reset sequence renders independently of the old cursor.
- Fresh attach seeds the correct next input sequence; two producers have distinct streams and cannot collide/dedupe one another.
- Attach/replay/detach subscription state cleans up on tab close, WebView reload/epoch, socket replacement, disconnect, and lease expiry.
- Output emitted immediately during session start, including the initial prompt, is delivered live or present in the atomic start snapshot without a gap.
- When the shell emits before `session/start` completes, the response/cursor is admitted before live activation and the replay/live boundary renders every sequence exactly once.
- Heavy live output can evict the replay ring while a slow client pages an immutable snapshot; admitted pages stay stable within byte/lease limits and control remains responsive.
- A disconnected replay cursor is rejected; reattach from the last rendered sequence obtains a new snapshot without raw page replay.
- Churn through more than 8 input producer epochs returns a bounded stream-limit error, retires streams safely, and never reactivates an old stream ID or grows dedupe memory.

### End-to-end and chaos tests

- Long Codex/build request while Terminal input, Ledger reads, system status, and ping remain responsive.
- Pause one client transport without a close frame; app replaces it and resynchronizes.
- Switch a test client between reachable/unreachable proxies while preserving server process and extension sessions.
- Slow-reader soak with terminal output and resource notifications proves bounded worker RSS.
- Repeated reconnects leave no stale origins, subscriptions, audiences, pending host requests, or route jobs.
- Runtime worker restart still reconnects and resynchronizes all mounted surface types.

### Manual phone matrix

- Wi-Fi to cellular and cellular to Wi-Fi while a Codex turn and terminal session are active.
- Weak/packet-loss cellular period followed by recovery.
- Tailscale disconnected/reconnected while the app remains foregrounded.
- Background for short and long intervals, then resume.
- Long extension build while using another extension.
- Kill the runtime worker, one extension, and the app process separately; verify the UI identifies and recovers the correct layer.
- Confirm no recovery path requires pressing Restart Remux for a client-only failure.

## Implementation order and deploy boundaries

1. **Audit freeze:** land the generated/declared registries, exhaustive tables, and bidirectional coverage tests for the current surface.
2. **P0 deadline/retry safety:** establish one absolute deadline owner, typed errors, and remove Codex blanket downstream retry before adding concurrency.
3. **P0 protocol readers:** non-blocking app WebSocket and extension stdout ingest, host/child-response bypass, bounded notification worker, regression tests.
4. **RPC lifecycle telemetry:** slow/queued/in-flight diagnostics before adding more parallelism.
5. **P1 route dispatcher:** reserved control, per-extension/core lanes, registration barrier, capacity/overload, disconnect cleanup.
6. **P1 built-in extension dispatch:** Codex per-thread/read lanes, safe app-server pending behavior, Terminal per-session/tmux lanes and non-blocking PTY writers.
7. **Bound every delivery stage:** frame/byte accounting, child protocol caps, slow-client close, Terminal input/output bounds, status counters.
8. **TypeScript policy migration:** required policy identities, typed timeout/outcome errors, remove implicit defaults and method-name retry heuristic.
9. **Terminal protocol hardening:** sequenced input ACK/dedup, generation-checked lifecycle, output gap detection, chunked replay/subscription routing.
10. **App liveness:** passive activity, foreground idle heartbeat, timeout health decisions, bounded HTTP/catalog probes.
11. **Make-before-break:** candidate ping/register/promotion, session-owner-safe cleanup, source-socket host responses, jitter, generation isolation.
12. **Resynchronization:** notification/subscription reconcile, Codex re-read, Terminal attach/replay/input resolution, Files refresh.
13. **Chaos and phone validation:** complete the full matrix before marking Implemented.

Server P0 reader isolation can roll out before the app migration. Strict policy admission and Terminal's sequenced-input protocol require coordinated app/viewer/runtime deployment or a version-negotiated transition. Do not ship timeout-driven reconnect before system ping has reserved control capacity; otherwise a legitimate long sequential RPC can create false liveness failures.

## Acceptance

- A blocked request cannot prevent same-socket ping, host-response processing, diagnostics, or close cleanup.
- No visibility-check request self-times out because its response is unread.
- One extension's long operation does not raise p95 latency for another extension's immediate request beyond the control/route target.
- Every core, local host, Codex, Terminal, server-originated, downstream, and notification method appears in the normative audit with an enforced policy; registry parity tests pass in both directions.
- No built-in viewer or app feature uses an implicit 300-second default.
- No mutation is automatically replayed after an ambiguous send/timeout.
- Narration cannot repeat its internal thread/turn flow after transport ambiguity; its sole optional semantic retry is known-completed, bounded, labeled, and cleans the prior attempt.
- Narration request/job/worker memory and event streams remain inside their declared count/byte caps under malformed input, progress flood, and worker stalls.
- Terminal cannot silently discard accepted UI input: every chunk is visibly gated or sequence-ACKed, bounded, and deduplicated; live output gaps always trigger replay/resync.
- A fast-ack timeout replaces the client socket without restarting the worker.
- Candidate registration/promotion cannot be undone by closing the old same-session socket, and source-socket host responses remain correct during overlap.
- Foreground idle failure is detected within 13 seconds under the default heartbeat policy.
- Wi-Fi/cellular/Tailscale handoffs recover without manual runtime restart and preserve recoverable Terminal/Codex state.
- Slow clients and overload cannot cause unbounded queue memory.
- `/api/status` and the incident ring make the responsible lane/method/connection generation identifiable after a failure.
- All Rust, TypeScript, extension, chaos, and manual phone gates pass before status changes to Implemented.

## Punts after this pass

- Durable operation IDs and progress APIs for builds/lifecycle.
- General server-side idempotency storage and exactly-once mutation semantics.
- Durable, cross-process Codex command outcome ledger beyond the methods explicitly deduplicated here.
- Native network-type listeners used only as a recovery accelerator.
- Cross-device synthetic availability monitoring outside the phone and Remux host.
