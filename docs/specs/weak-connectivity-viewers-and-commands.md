Status: Implemented
Last verified: 2026-07-12
Canonical code: `crates/remux/src/http/mod.rs`, `crates/remux/src/http/catalog.rs`, `crates/remux/src/http/viewers.rs`, `crates/remux/src/runtime.rs`, `crates/remux/src/rpc/ws.rs`, `crates/remux/src/extensions/manifest.rs`, `crates/remux/src/extensions/supervisor.rs`, `docs/guides/extension-authoring.md`, `app/src/remote/remuxExtensions.ts`, `app/src/remote/RemuxConnectionProvider.tsx`, `app/src/remote/remuxRpcClient.ts`, `app/src/browser/browserStore.ts`, `app/src/browser/browserSessionPersistence.ts`, `app/src/surfaces/viewer/ExtensionWebView.tsx`, `packages/viewer-kit/src/rpc.ts`, `packages/viewer-kit/src/ipc.ts`, `extensions/codex/remux-extension.json`, `extensions/codex/viewer/vite.config.ts`, `extensions/codex/viewer/ipc/threadCommands.ts`, `extensions/codex/viewer/composer/actions/turnAction.ts`, `extensions/codex/viewer/transcript/resourceStore.ts`, `extensions/codex/server/src/projection/mod.rs`, `extensions/codex/server/src/projection/segments.rs`, `extensions/codex/server/src/projection/render.rs`, `extensions/codex/server/src/thread_commands.rs`, `extensions/editor/remux-extension.json`, `extensions/editor/viewer/vite.config.ts`, `extensions/narrate/remux-extension.json`, `extensions/narrate/viewer/vite.config.ts`, `extensions/terminal/remux-extension.json`, `extensions/terminal/viewer/vite.config.ts`, `../ledger/remux-extension.json`, `../ledger/lens/vite.config.ts`

# Weak-connectivity viewer delivery and durable commands

Make Remux usable over a reachable but slow, high-latency, or intermittently
disconnecting link without turning the product into an offline-first system.
The target environment is plane Wi-Fi or a weak mobile connection to the
existing remote Remux host. Codex inference, rollout indexing, projection, and
extension execution remain on that host.

The implementation has four deliberately small parts:

1. serve immutable, revisioned viewer bundles through the ordinary WebView HTTP
   cache;
2. retain the last known extension catalog so a temporary catalog failure does
   not erase restorable tabs;
3. make side-effecting RPC commands with an `operationId` execute once and
   survive a phone WebSocket replacement;
4. replace base64 images in Codex transcript render frames with immutable
   authenticated media URLs.

Transcript queries remain disposable server verification. The existing Codex
Version 2 invalidation coordinator remains authoritative and is not replaced.

## Outcome

After one successful viewer load, reopening or reloading the same extension
revision should transfer only uncached resources and small control responses.
A Codex send acknowledged by Remux command admission should finish once even if
the phone socket disconnects before its response arrives. Reconnecting with the
same operation ID should return the original result rather than start another
turn. Missed transcript invalidations should continue to recover through one
fresh authoritative sync.

This is the intended weak-link flow:

```text
Cached revisioned viewer assets
             |
             v
Phone WebView ---- semantic RPC ---- Remux ---- local RPC ---- extension
      |                                  |
      |                                  +---- retained command outcome
      |
      +---- replaceable transcript query after reconnect
```

This is not a promise that Codex works with no route to the server. With no
connectivity, the user may retain already-mounted UI and a draft, but cannot
start new remote inference.

## Scope

This pass includes:

- a content revision for every extension view that opts into the generic
  immutable-bundle contract;
- compression and safe revalidation for views that do not opt in;
- immutable HTTP routes backed by server-side snapshots of published view
  directories;
- normal HTTP compression and cache headers for versioned assets;
- last-known extension catalog persistence in the Remux app;
- reconnect retry only for commands carrying an `operationId`;
- an in-memory, bounded Remux command outcome registry independent of a phone
  socket generation;
- Codex operation-ID coverage for send, start, edit, fork, interrupt, and
  compaction commands;
- Codex transcript image extraction into a content-addressed Remux media cache;
- focused metrics and weak-link/connection-replacement tests.

This pass explicitly does not include:

- local Codex inference;
- an offline transcript database;
- a durable multi-message mobile outbox;
- an eager native download or extraction of the complete viewer directory;
- service workers;
- WebSocket compression or a binary RPC envelope;
- token, text, segment, or JSON-patch streaming;
- a second Codex transcript scheduler;
- persistence of query requests;
- persistence of command outcomes across a Remux process restart;
- resumable/chunked attachment upload;
- image transcoding or thumbnail generation;
- a new projected-turn cache;
- adaptive streaming frame rate.

Those exclusions are intentional. They are not prerequisites for usable weak
connectivity and would materially expand the state model.

## Implementation checkpoint

Implemented on 2026-07-12. The generic immutable bundle registry, cacheable
catalog bootstrap, reconnect-durable ordinary-command registry, server process
identity handshake, and authenticated transcript media cache are now wired end
to end. Codex, Editor, Markdown, Terminal, and the externally discovered Ledger
view use the same manifest cache contract and relative Vite base.

The existing Version 2 Codex single-flight/trailing transcript coordinator and
semantic RPC contracts remain intact. Validation covers immutable A/B snapshot
retention, ETag/cache/compression behavior, authenticated media serving,
operation replay across a real WebSocket replacement, TypeScript compilation,
all Codex server tests, bundled viewer builds, the Ledger viewer build, and the
Remux unit/integration/chaos suites.

## Relationship to existing specs

This spec extends
[`resource-governance-and-l0-5.md`](resource-governance-and-l0-5.md). It keeps
that spec's rule that ordinary business requests have no arbitrary response
deadline and makes the existing command `operationId` meaningful across a phone
connection replacement. It does not change cgroup placement, RPC lane capacity,
or job semantics.

It also extends
[`codex/server-authoritative-transcript-windows.md`](codex/server-authoritative-transcript-windows.md).
That spec remains authoritative for transcript windows, invalidation cadence,
background behavior, virtualized layout, and resource application. This pass
only changes how large immutable media is represented inside a frame.

The connection-generation and bounded-lane design in
[`rpc-concurrency-and-mobile-resilience.md`](rpc-concurrency-and-mobile-resilience.md)
remains in force. This spec adds server-instance identity and retained command
outcomes; it does not restore caller-authored timeout policy tables.

## Baseline verified before implementation

The following was measured against the live reference host on 2026-07-12:

| Surface | Measured value |
| --- | ---: |
| Codex main viewer JavaScript | 974,410 bytes |
| Same JavaScript with gzip level 6 | 296,996 bytes |
| Codex viewer CSS | approximately 68.5 KiB |
| Same CSS with gzip | approximately 12.4 KiB |
| Current thread, cold `tail(24)` transcript response | 841,002 bytes |
| Largest frame in that window | 601,669 bytes |
| Base64 screenshot inside that frame | 594,378 bytes |
| Unchanged warm range verification | approximately 7.6 KiB |
| Range verification with one changing active frame | approximately 10.7–11.5 KiB |
| Local warm range verification execution | approximately 77 ms median |

The live viewer HTTP response has no `Content-Encoding`, `Cache-Control`,
`ETag`, or `Last-Modified` header. No WebSocket compression extension is
negotiated.

The current Codex Version 2 transcript path already has the required request
discipline:

- streaming invalidations coalesce for 125 ms;
- structural invalidations coalesce for approximately 32 ms;
- one transcript sync is in flight per viewer generation;
- invalidations received during that read produce at most one trailing sync;
- unchanged loaded frames return `notModified` markers;
- work groups and entry details are read only when open.

This spec does not redesign that path.

## Design principles

### Cache immutable viewer revisions, not mutable routes

A long-lived cache header is safe only if a URL never changes content. The
existing Vite chunk names are usually content-hashed, but Remux supports generic
and external extensions and cannot assume a specific bundler or asset base.
Remux therefore publishes an immutable snapshot only for a view that declares
the generic immutable-bundle contract. The versioned URL points to that
snapshot. Views without the declaration keep their current route, receive
compression and validators, and never receive an unsafe immutable header.

### Revisioned bundles must be relocatable

A versioned entry is served below `<view.route>/_bundle/<revision>/`. Its local
HTML, JavaScript, CSS, workers, and dynamic imports must therefore resolve assets
relative to that entry or importing module. Root-relative output such as
`/viewers/codex/assets/index.js` would bypass the revision route.

The cache policy is an explicit generic view capability, not a Codex special
case. Existing views remain compatible when the field is absent. Remux's
bundled viewers and Ledger migrate their Vite `base` from the declared route to
`'./'` before opting in.

### Use the platform HTTP cache before inventing a package manager

The native app does not eagerly download the roughly 11 MiB Codex `dist`
directory. WKWebView and Android WebView cache the entry, CSS, JavaScript, and
dynamic chunks as they are requested. The app only persists catalog metadata
that names the last successfully published revision.

### Queries are replaceable; commands are durable

A stale transcript query should be discarded and reissued after reconnect. A
send command must not be blindly reissued because it may already have started a
turn. Durability therefore applies to state-changing commands with stable
operation IDs, not to resource reads.

### Durability begins at Remux admission

Before Remux admits a command, disconnecting may prevent it from running. After
admission, the command executes independently of the originating phone socket
and its outcome is retained for reconnect replay. The client never infers
acceptance merely because bytes were written to a socket.

### Keep the transcript server-authoritative

The app never appends an assistant token or user turn from transport guesses.
Command responses provide identity and immediate invalidations; the rendered
turn still comes from the transcript resource server.

### Move large immutable bytes out of semantic frames

An image does not need to be embedded every time another segment in its turn
changes. Transcript frames carry a stable authenticated media URL. The media
body uses ordinary HTTP caching and is downloaded at most once per device cache
lifetime.

## Part 1: revisioned viewer bundles

### Manifest cache contract

Extend each view declaration additively:

```json
{
  "views": {
    "main": {
      "route": "/viewers/codex",
      "entry": "viewer/dist/index.html",
      "cache": "immutable"
    }
  }
}
```

Shared manifest type:

```rust
pub enum ViewCachePolicy {
    Revalidate,
    Immutable,
}
```

Rules:

- missing `cache` and `cache: "revalidate"` preserve the existing mutable view
  route and never publish an immutable snapshot;
- `cache: "immutable"` asserts that every runtime-loaded local asset is
  relative to the entry or importing module;
- any other value fails manifest validation;
- the field is available to every discovered extension regardless of source
  repository or manifest root;
- no extension ID appears in cache-policy code.

For Vite, the authoring contract is:

```ts
export default defineConfig({
  base: './',
});
```

Update the extension authoring guide and current extension templates with this
exact pairing. Remux validates the copied entry's local `script src`,
`link href`, `img src`, and `source src` values and rejects immutable
publication if one begins with `/`. The manifest assertion remains responsible
for URLs constructed inside JavaScript, workers, and CSS.

### Published bundle model

Add a `ViewerBundleRegistry` owned by the Remux runtime in:

```text
crates/remux/src/http/viewer_bundles.rs
```

One published bundle record is:

```rust
pub struct PublishedViewerBundle {
    pub extension_id: String,
    pub view_id: String,
    pub revision: String,
    pub route: String,
    pub entry_relative_path: PathBuf,
    pub snapshot_root: PathBuf,
    pub published_at_ms: i64,
    pub total_bytes: u64,
}
```

Snapshots live under the Remux runtime root, not under the extension source:

```text
.remux/cache/viewers/<extension-id>/<view-id>/<revision>/
```

This works identically for bundled and externally discovered extensions and
does not assume that Remux owns the extension repository. An external extension
opts in through the same `views.<id>.cache` field and relative-bundle contract.
An unmodified external extension remains on the existing route.

### Revision algorithm

The revision format is `sha256-` followed by 64 lowercase hexadecimal
characters. Its digest is SHA-256 over the snapshot contents in lexical path
order. For every regular file, hash:

```text
relative path UTF-8 bytes
NUL
u64 big-endian file length
NUL
file bytes
```

Directories do not contribute directly. Symlinks are accepted only when their
canonical target remains under the view entry directory; they are copied as
regular files. Escaping or broken symlinks make publication fail without
replacing the last good revision.

The revision is content-derived. Timestamps, source absolute paths, extension
location, and build process IDs do not affect it.

### Snapshot publication

The source root is the parent directory of `View.entry`. Publication follows
this algorithm:

1. Verify that the declared entry exists and is a regular file.
2. Wait until the source tree has been quiet for 300 ms.
3. Walk the source tree in lexical relative-path order.
4. Reject a source tree above 128 MiB or 20,000 files. Keep serving the previous
   revision and log a bounded warning.
5. Copy regular files into a temporary directory under the target cache root
   while computing the content hash.
6. Record source file identity, length, and modification time before and after
   each copy.
7. Re-list the source tree and reread the entry after copying. If the file set
   or entry content changed, discard the temporary directory and retry after a
   new quiet period.
8. Verify that the copied entry exists in the temporary snapshot.
9. Rename the temporary directory atomically to the revision path. If that
   revision already exists, discard the duplicate temporary directory.
10. Atomically update the registry's current record.

The copied snapshot, rather than the mutable source directory, is served from a
versioned route. A build cannot change bytes behind a previously issued URL.

### Publication triggers

Publish an immutable-policy view:

- once during runtime startup when its built entry already exists;
- immediately after a managed one-shot view build reports success;
- after a debounced filesystem change beneath a view owned by a running watch
  sidecar;
- after the existing Rebuild & Restart flow completes its view phase.

The runtime already depends on `notify`; the registry owns one watcher per
distinct immutable-policy view root. Multiple events during a Vite watch
rebuild collapse into one 300 ms quiet-period publication. Publication failure
never removes the last good bundle. Revalidate-policy views do not create
snapshots or bundle watchers.

Add `Arc<ViewerBundleRegistry>` to the existing shared supervisor context. A
successful one-shot view build calls `registry.publish(extension_id, view_id)`.
The registry itself owns the debounced filesystem watchers used for watch
sidecars. The extension supervisor does not calculate revisions or serve files.

### Retention

Retain:

- the current revision for every published view;
- the two immediately previous revisions for that view;
- no more than 256 MiB of snapshots in total.

Evict oldest non-current revisions first. Never evict the current revision. If
all current revisions exceed the global target, retain them and emit one
throttled warning rather than breaking active extensions.

An evicted versioned route returns `404` with error code
`viewer_revision_unavailable`. The app then refreshes the catalog and reloads
the latest revision. A phone that already cached all requested assets continues
to use them without contacting that route.

### Catalog contract

Extend each catalog view additively:

```ts
export type RemuxExtensionView = {
  route: string;
  revision: string | null;
  entryUrl: string;
  url: string;
};
```

Server JSON:

```json
{
  "views": {
    "main": {
      "route": "/viewers/codex",
      "revision": "sha256-4d0f...",
      "entryUrl": "/viewers/codex/_bundle/sha256-4d0f.../"
    }
  }
}
```

`revision` is `null` for a revalidate-policy view or when no valid immutable
snapshot has been published. `entryUrl` then falls back to the existing
unversioned route. The app resolves relative URLs against the configured Remux
origin and does not construct the versioned route itself.

Existing clients ignore the additive fields and continue using `route`.

### HTTP routes and headers

The new route is scoped beneath each declared view route:

```text
<view.route>/_bundle/<revision>/
<view.route>/_bundle/<revision>/<relative-asset-path>
```

The same traversal protections as the current viewer provider apply after the
revision segment is removed. Missing SPA navigation paths fall back to that
revision's copied entry. Missing paths that contain a file extension return
`404`; they do not return HTML.

#### Entry URL rebasing

All current bundled Vite viewers emit route-absolute entry assets, for example:

```html
<script src="/viewers/codex/assets/index-ABC.js"></script>
```

Serving that HTML unchanged from a versioned entry would load the mutable
unversioned asset and defeat the cache. When the versioned provider serves the
copied entry HTML, parse the document and rebase URL-bearing attributes whose
value begins with the exact declared view route plus `/`:

```html
<script src="/viewers/codex/_bundle/sha256-.../assets/index-ABC.js"></script>
```

Handle `src`, `href`, `poster`, and every URL candidate in `srcset`. Do not use a
global string replacement. URLs outside the declared view route, data URLs,
fragments, and absolute external origins are unchanged. The rewritten entry is
a deterministic representation of the immutable source snapshot and uses an
ETag derived from revision plus relative entry path.

Once the main JavaScript and CSS load from the versioned path, their ordinary
relative dynamic imports and CSS resources resolve beneath the same snapshot.
An extension that intentionally hardcodes an unversioned route inside runtime
JavaScript continues to work through the compatibility provider, but that
specific request is not revision-cached. No extension is rejected for this
behavior.

Versioned snapshot responses use:

```http
Cache-Control: private, max-age=31536000, immutable
ETag: "<revision>:<relative-path-content-hash>"
```

The unversioned compatibility route uses:

```http
Cache-Control: no-cache
ETag: "<content-hash>"
```

This makes unchanged revalidate-policy assets inexpensive through conditional
requests without claiming that a stable path is immutable.

Add HTTP response compression at the merged Axum HTTP layer using
`tower-http`'s compression support:

- prefer Brotli, then gzip, according to `Accept-Encoding`;
- compress HTML, JavaScript, CSS, JSON, SVG, and plain text above 1 KiB;
- do not compress PNG, JPEG, WebP, audio, video, ZIP, or already encoded
  content;
- emit `Vary: Accept-Encoding`;
- do not alter WebSocket upgrade responses.

On-the-fly compression is accepted in this pass. A versioned asset is normally
requested once per phone cache and avoids a new post-build compression pipeline.

### App catalog cache

Add a small AsyncStorage-backed last-known catalog cache in:

```text
app/src/remote/remuxExtensionCatalogCache.ts
```

Storage key:

```text
remux.extensionCatalog.v1:<normalized-origin>
```

Stored value:

```ts
type CachedRemuxExtensionCatalog = {
  schemaVersion: 1;
  origin: string;
  fetchedAt: number;
  catalog: RemuxExtensionCatalog;
};
```

The origin is part of both the key and value. Auth tokens are never stored in
the catalog cache.

`loadExtensions()` behavior becomes:

1. Read and validate the cached catalog for the current origin.
2. If valid, expose it immediately, restore tabs, and mark the catalog source as
   `cache`.
3. Start the existing authenticated network fetch.
4. On success, replace the catalog, update tab view URLs only when the
   revision changes, persist the new catalog, and mark the source `network`.
5. On failure with a cached catalog, keep the cached extensions and tabs ready;
   store a non-blocking refresh error.
6. On failure without a cached catalog, retain the existing fatal catalog error
   behavior.

Increase only the catalog HTTP fetch boundary from 5 seconds to 15 seconds. A
cached catalog paints immediately and does not wait for this request. This
deadline bounds a transport/bootstrap fetch; it does not reintroduce business
RPC timeouts.

Add:

```ts
type BrowserCatalogSource = 'cache' | 'network' | null;
```

This is launch metadata caching, not offline transcript state.

### Tab and WebView behavior

`ViewerTab` and `PersistedViewerTab` add:

```ts
viewRevision: string | null;
```

The tab URL uses `view.entryUrl`; normal resource, tab, navigation, and theme
query parameters remain unchanged. Catalog refresh does not remount a tab when
its revision is unchanged. When a new revision arrives:

- inactive tabs adopt it the next time they become active;
- the active tab retains its current revision until the user reloads or an
  existing successful build/reload action explicitly reloads it;
- no background catalog refresh tears down a running extension UI.

`ExtensionWebView` sets caching on explicitly. Android uses
`LOAD_CACHE_ELSE_NETWORK` only for revisioned entry URLs. iOS uses the standard
WKWebView URL cache with the immutable server headers. Unversioned routes keep
the platform default policy.

The existing `remuxReload` query nonce remains because it changes only the
small entry-document cache key; all revisioned subresource paths remain shared
and immutable. It must not be appended to JavaScript, CSS, or dynamic chunk
URLs.

No `file://` origin, local HTTP proxy, service worker, or native archive
extraction is introduced.

## Part 2: reconnect-durable commands

### Existing wire contract

The semantic RPC contract already supports:

```ts
type RpcCommandContract = {
  kind: 'command';
  operationId?: string;
  preconditionRevision?: number;
};
```

Codex message send/start/edit/fork already uses `clientMessageId` as
`operationId`. Today Remux validates that field but does not retain or dedupe
ordinary command outcomes. Only `job-start` has an operation registry. The app
retries queries once after reconnect and does not retry commands.

This pass gives `command + operationId` a concrete durability contract without
changing the wire shape.

### Command identity

A durable command key is:

```text
(method, operationId)
```

The operation ID must be non-empty UTF-8 and at most 256 bytes. Compute a
parameter fingerprint from canonical JSON containing:

```json
{
  "method": "...",
  "params": {}
}
```

Canonical JSON recursively sorts object keys, preserves array order, and uses
normal `serde_json` scalar encoding. Hash the bytes with SHA-256.

`remuxContext`, request ID, phone connection ID, tab ID, resource key, and
transport generation do not contribute to command identity. A retry from a new
socket must resolve the same operation.

### Registry state

Add a registry owned by `WsServer` in:

```text
crates/remux/src/rpc/commands.rs
```

```rust
enum CommandState {
    InFlight,
    Completed(RpcOutcome),
}

struct CommandRecord {
    method: String,
    operation_id: String,
    params_fingerprint: String,
    admitted_at: Instant,
    completed_at: Option<Instant>,
    state: CommandState,
    completion: Arc<Notify>,
    retained_bytes: usize,
}
```

`RpcOutcome` stores either the JSON result or complete JSON-RPC error that the
first execution produced. It does not store a phone request ID.

Bounds:

- at most 256 records;
- at most 8 MiB of terminal outcome JSON;
- terminal retention for 30 minutes;
- in-flight records are never evicted;
- evict least-recently-completed terminal records first;
- if all capacity is in flight, reject new durable commands with a bounded
  `server busy` error and do not start the extension operation.

The registry is process-memory state. A Remux process restart clears it.

### Admission and execution semantics

When a command with `operationId` reaches its semantic dispatch lane:

1. Validate the ID and calculate the parameter fingerprint.
2. If no record exists, insert `InFlight`. This is the admission point.
3. Execute the routed command exactly once while retaining the existing
   extension/thread lane ordering.
4. Do not select command execution against the originating client's disconnect
   notification after admission.
5. Store the result or error as `Completed` and notify duplicate waiters.
6. Send the outcome to the original request only if that client is still
   connected.

If a matching record already exists:

- same fingerprint + `InFlight`: wait for completion and return that outcome;
- same fingerprint + `Completed`: return the retained outcome immediately;
- different fingerprint: reject with JSON-RPC invalid request and code detail
  `operation_id_conflict`;
- same operation ID under another method: it is a distinct key, though clients
  should still generate globally unique IDs.

A queued command whose socket disappears before registry admission does not
run. A retry on the next connection admits it normally.

### Cancellation

Cancellation remains asymmetric by contract:

- Before durable command admission, disconnect or `$/cancelRequest` may remove
  the queued request.
- After admission, disconnect cancels only that client's wait for the response;
  it does not cancel the command.
- After admission, `$/cancelRequest` likewise cancels the caller's wait but does
  not roll back the side effect.
- Domain cancellation remains an explicit command such as Codex turn
  interrupt or narration cancel.

This avoids claiming that transport cancellation can undo a command that may
already have reached an extension.

Commands without `operationId` keep current at-most-once-per-connection
behavior and are never automatically retried.

### Client retry behavior

Extend `remux/system/info` additively so the app can distinguish a phone socket
replacement from a Remux process replacement:

```ts
type RemuxSystemInfo = {
  cwd: string | null;
  serverInstanceId: string;
  capabilities: {
    durableCommandProtocolVersion: 1;
  };
};
```

`serverInstanceId` is the runtime journal `run_id` created once at worker
startup. It is stable across WebSocket generations and changes across every
Remux worker restart. It is opaque to clients and is not persisted as command
state. An older server without these fields is treated as not supporting
durable command retry.

`RemuxConnectionStatus` carries both the phone connection generation and the
server instance ID. Make-before-break promotion between two sockets connected
to the same worker changes only the connection generation. A promoted socket
that reports another server instance invokes the restart-boundary behavior
below.

In `RemuxConnectionProvider.routeRequest` classify:

```ts
const retryableQuery = contract.kind === 'query';
const durableCommand =
  contract.kind === 'command' && Boolean(contract.operationId);
```

Query behavior remains unchanged: one transport retry is allowed, and later
connection/resume synchronization supplies fresh state.

A durable command:

- retains the same method, params, and operation ID;
- waits for the normal connection backoff to produce a connected client;
- retries after `RemuxConnectionClosedError` while Remux connectivity remains
  enabled;
- has no caller-authored wall-clock timeout;
- stops on explicit abort, app teardown, settings/origin change, or a terminal
  JSON-RPC outcome;
- counts against the existing cap of eight reconnecting requests;
- never creates a new operation ID internally.

The pending promise remains owned by React Native. Persistence across a full
mobile process death is out of scope.

### Codex command adoption

The following commands must carry an operation ID:

| Command | Operation ID |
| --- | --- |
| message send | existing `clientMessageId` |
| new-thread message start | existing `clientMessageId` |
| edit | existing `clientMessageId` |
| fork | existing `clientMessageId` |
| interrupt | existing `interrupt:<threadId>:<turnId>` identity |
| compact | a new client-generated ID created once per button action |
| queued send/compact steering actions | existing queue entry operation ID |

The operation ID is created before the async call and remains stable through
every reconnect attempt. A UI retry for a terminal domain error is a new user
action and receives a new ID.

Composer submission state adds:

```ts
'waiting-for-connection'
```

The composer is not cleared while a durable command is waiting for admission or
outcome. When connected, it returns to the existing starting/awaiting-transcript
state. After a successful command outcome, the current immediate invalidations
and authoritative transcript refresh remain unchanged.

If the viewer itself is recreated after the command ran, no pending command
promise survives. The normal tail sync shows the server-authoritative user
message and active turn. This pass does not create a second mobile outbox.

### Runtime restart boundary

Because the registry is in memory, a Remux restart creates an ambiguous boundary
for an operation whose response was lost. The client must not automatically
replay an old operation after observing a new server process generation.

On a server process generation change:

1. stop automatic retry of durable commands admitted against the prior
   generation;
2. run normal resource reconciliation;
3. for Codex message operations, match the stable `clientMessageId` in the
   authoritative transcript when available;
4. if found, resolve the submission as delivered;
5. if not found, retain the draft and offer an explicit user retry with a new
   operation ID.

This rare server-restart case remains user-visible rather than risking a
duplicate turn. Phone socket replacement without server restart is automatic.

## Part 3: transcript query behavior

No new query queue is added.

The Version 2 transcript flow remains:

```text
app-server events
    -> semantic transcript invalidation
    -> one 125 ms content or 32 ms structural coalescing window
    -> one transcript sync
    -> one optional trailing sync
    -> atomic resource/layout publication
```

Weak-link rules:

- preserve the last ready transcript while a query is disconnected, loading,
  or failed;
- do not increment a transcript generation merely because an invalidation is
  queued behind an in-flight read;
- on reconnect, verify the active range or tail exactly once through the
  existing lifecycle/generation dedupe;
- do not replay missed invalidation events;
- do not persist `transcriptSync` request objects;
- do not increase the 125 ms target cadence to compensate for a slow link;
- do not allow parallel transcript reads;
- keep group/detail reads lazy and cancellable.

The network RTT naturally bounds streaming frequency because another transcript
read cannot begin while one is in flight. No adaptive cadence is required in
this pass.

## Part 4: Codex transcript media de-inlining

### Scope decision

This pass changes transcript delivery, not composer upload. The phone may still
send one base64 image to Codex when the user attaches it. That one-time upload is
acceptable for the weak-connectivity target. The failure being removed is
resending the same base64 body with every changing turn frame.

No image resizing, thumbnailing, chunked upload, or generic attachment service
is added.

### Shared media cache

Remux creates:

```text
.remux/cache/media/sha256/<first-two-hex>/<full-hash>.blob
.remux/cache/media/sha256/<first-two-hex>/<full-hash>.json
```

The runtime passes the absolute cache directory to extension server processes:

```text
REMUX_MEDIA_DIR=/absolute/remux/root/.remux/cache/media
```

This is platform plumbing, but Codex is the only producer in this pass.

Metadata:

```json
{
  "schemaVersion": 1,
  "sha256": "...",
  "mimeType": "image/png",
  "sizeBytes": 445000,
  "createdAtMs": 0,
  "lastAccessAtMs": 0
}
```

Writes use a temporary file plus atomic rename. If an identical hash already
exists with matching size, reuse it. MIME type is allowlisted to image types
supported by the viewer; do not trust a data-URL type to create an arbitrary
response header.

### Projection conversion

When Codex projection normalizes a `UserInput` image whose URL is a base64 data
URL:

1. Parse and validate the data URL.
2. Reject decoded content above 20 MiB and retain the existing projection
   fallback behavior.
3. Decode bytes once.
4. Compute SHA-256 over decoded bytes.
5. Atomically ensure the media blob and metadata exist.
6. Replace the render-frame URL with:

```text
/remux/media/sha256/<full-hash>
```

7. Calculate segment and frame revisions from the media URL, not the original
   base64 text.

Remote `http:`/`https:` URLs and `localImage` paths retain current behavior in
this pass. Codex turn-start input still receives the original composer data
URL; only the transcript render projection is rewritten.

If media materialization fails, log one throttled warning and retain the
original data URL so the message remains renderable. The response-size guard
continues to apply.

### Media HTTP route

Add:

```text
GET /remux/media/sha256/<64-lowercase-hex>
```

The existing auth middleware protects the route. The handler:

- accepts exactly 64 lowercase hexadecimal characters;
- never accepts a path separator or extension from the request;
- reads MIME type and length from validated sidecar metadata;
- confirms the blob length matches metadata;
- returns `404` for absent or inconsistent entries;
- returns `Content-Type`, `Content-Length`, and the hash as `ETag`;
- returns:

```http
Cache-Control: private, max-age=31536000, immutable
```

Image bytes are already compressed and bypass HTTP compression.

The existing WebView auth-cookie handoff authenticates image subresource loads.
No token appears in the media URL.

### Media cache bound

Cap the media cache at 1 GiB. Cleanup runs at startup and no more than once per
hour after a new materialization. Evict oldest `lastAccessAtMs` entries first.
Update access metadata at most once per hour per blob to avoid a write per HTTP
read.

Media extracted from rollout data is reproducible. If evicted, a later
projection containing the original data URL recreates it. The current pass does
not treat this cache as user data storage.

### Expected payload effect

The measured 594,378-byte screenshot string becomes an approximately 100-byte
URL in every transcript response. The image body is fetched once through HTTP
and then served from the WebView cache. A changing assistant segment no longer
causes the screenshot bytes to be resent.

## Failure matrix

| Failure | Required behavior |
| --- | --- |
| Catalog network fetch times out | Use cached catalog for the same origin; retain a non-blocking refresh error. |
| No cached catalog exists | Show the current catalog connection error. |
| View build is mid-write | Keep last published revision; retry snapshot after quiet period. |
| New viewer revision publication fails | Keep serving and advertising the last good revision. |
| Old revision was evicted and an asset cache misses | Return revision-unavailable; refresh catalog and load current revision. |
| Phone disconnects before command admission | Command does not run; retry may admit it after reconnect. |
| Phone disconnects after command admission | Command completes once; retry with same ID returns retained outcome. |
| Duplicate command uses different params | Reject `operation_id_conflict`; never execute the second payload. |
| Extension returns a domain error | Retain and replay the same error for that operation ID. |
| Remux restarts during uncertain command | Do not auto-replay; reconcile Codex client message ID, then require explicit retry if absent. |
| Transcript read disconnects | Preserve ready content; fresh sync after reconnect. |
| Transcript invalidations are missed | Fresh authoritative sync recovers current state. |
| Media cache write fails | Fall back to original data URL and log; transcript remains correct. |
| Media blob is evicted | Later projection recreates it from rollout/live input. |

## Observability

Use existing structured Remux and extension logs. Do not add a telemetry
backend. Add bounded fields without message content:

### Viewer bundle publication

```text
extensionId
viewId
revision
fileCount
totalBytes
durationMs
result: published | unchanged | failed
```

### Static serving

Add these fields to HTTP access logging:

```text
viewRevision
encodedBytes
contentEncoding
```

Do not attempt to infer a client cache hit from the server; a cache hit makes no
request.

### Durable commands

```text
method
operationIdHash
admission: new | joined | replayed | conflict | capacity-rejected
executionMs
retainedBytes
connectionGeneration
```

Log only a short hash of the operation ID, not its full value or params.

### Transcript resources

Keep or add:

```text
windowKind
windowTurns
changedTurns
notModifiedTurns
encodedBytes
projectionMs
```

### Media

```text
mediaHashPrefix
sourceBytes
cache: materialized | reused | failed
```

No image bytes, data URLs, prompts, or transcript text enter logs.

## Implementation phases

### Phase 1: immutable viewer revisions

Files:

- `crates/remux/src/http/viewer_bundles.rs` — new;
- `crates/remux/src/http/viewers.rs`;
- `crates/remux/src/http/catalog.rs`;
- `crates/remux/src/http/mod.rs`;
- `crates/remux/src/runtime.rs`;
- `crates/remux/src/extensions/manifest.rs`;
- `crates/remux/src/extensions/supervisor.rs`;
- `docs/guides/extension-authoring.md`;
- `app/src/remote/remuxExtensions.ts`;
- `app/src/remote/remuxExtensionCatalogCache.ts` — new;
- `app/src/browser/browserTypes.ts`;
- `app/src/browser/browserStore.ts`;
- `app/src/browser/browserSessionPersistence.ts`;
- `app/src/surfaces/viewer/ExtensionWebView.tsx`;
- bundled extension manifests and Vite configs;
- `../ledger/remux-extension.json` and `../ledger/lens/vite.config.ts`.

Steps:

1. Add the generic `ViewCachePolicy` manifest field with revalidate default.
2. Change Codex, Editor, Markdown, Terminal, and Ledger Vite bases to `'./'`
   and opt those views into immutable caching.
3. Add the bundle registry and startup publication.
4. Wire build/watch publication triggers.
5. Serve versioned snapshot routes and compression/cache headers.
6. Add catalog revision/entry URL fields.
7. Add cached-catalog bootstrap and tab revision ownership.
8. Opt revisioned WebViews into cache-first loading.

Exit gate:

- Build Codex revision A and open it.
- Build revision B while the A tab remains mounted.
- Prove the A entry and a previously unloaded A dynamic chunk still resolve
  from the A snapshot.
- Prove a new/reloaded tab uses B.
- Disconnect the catalog endpoint temporarily and prove saved tabs restore from
  the cached catalog without clearing the extension list.

### Phase 2: durable command admission

Files:

- `crates/remux/src/rpc/commands.rs` — new;
- `crates/remux/src/rpc/ws.rs`;
- `app/src/remote/RemuxConnectionProvider.tsx`;
- `app/src/remote/remuxRpcClient.ts`;
- `packages/viewer-kit/src/rpc.ts`;
- `extensions/codex/viewer/ipc/threadCommands.ts`;
- `extensions/codex/viewer/composer/actions/turnAction.ts`;
- relevant composer submission model/store files.

Steps:

1. Add registry identity, bounds, admission, completion, and replay.
2. Detach admitted command execution from client-disconnect cancellation while
   preserving semantic lane ordering.
3. Retry only commands with operation IDs across socket replacement.
4. Add waiting-for-connection presentation.
5. Add compaction operation IDs and audit all Codex command call sites.
6. Add server-generation uncertainty reconciliation for Codex message IDs.

Exit gate:

- Force-close the phone WebSocket immediately after Remux command admission but
  before the response frame.
- Reconnect and resend the identical operation.
- Observe one extension invocation, one Codex turn, and the original retained
  result.

### Phase 3: Codex media de-inlining

Files:

- `crates/remux/src/http/media.rs` — new;
- `crates/remux/src/http/mod.rs`;
- `crates/remux/src/runtime.rs`;
- `crates/remux/src/extensions/process.rs`;
- `extensions/codex/server/src/media.rs` — new;
- `extensions/codex/server/src/projection/mod.rs`;
- `extensions/codex/server/src/projection/segments.rs`;
- `extensions/codex/server/src/projection/render.rs`;
- Codex projection/resource tests.

Steps:

1. Create and inject the shared media directory.
2. Add atomic Codex data-URL materialization.
3. Rewrite only render-projection image URLs.
4. Serve authenticated immutable media.
5. Add bounded cleanup.

Exit gate:

- Start a Codex turn with a roughly 600 KiB screenshot.
- Stream at least ten assistant updates.
- Prove the transcript response contains no `data:image` string and that the
  media body is requested no more than once after cache warm-up.

### Phase 4: weak-link system validation

No new product subsystem is added in this phase. Exercise the complete path
under a network proxy or Linux traffic control profile approximating:

```text
bandwidth: 512 Kbit/s and 1 Mbit/s
RTT: 300 ms, 750 ms, and 1,200 ms
packet loss: 0%, 2%, and 5%
disconnects: 2–15 seconds during send and streaming
```

Validate:

- cached viewer startup;
- first viewer startup;
- text-only send and streaming;
- screenshot send and streaming;
- phone background/foreground;
- WebSocket replacement before and after command admission;
- extension restart separately from phone reconnect;
- Remux restart as the explicit ambiguous-command boundary.

## Test plan

### Rust unit tests

Viewer bundles:

- stable revision for identical content;
- revision changes for content or relative-path changes;
- timestamps do not change revision;
- missing cache policy retains revalidate behavior;
- immutable policy with a root-relative entry asset fails publication without
  breaking the unversioned route;
- escaping symlink rejected;
- mutation during copy retries and preserves previous revision;
- identical publication reuses snapshot;
- retention never evicts current revisions;
- versioned route never reads mutable source files;
- versioned entry rebases same-route `src`, `href`, `poster`, and `srcset`
  attributes without rewriting external or data URLs;
- a rebased main script's relative dynamic import resolves beneath the same
  revision snapshot;
- cache headers and compression negotiation;
- unversioned compatibility route remains functional.

Commands:

- first admission executes once;
- duplicate in-flight request waits and replays;
- duplicate terminal request replays result;
- errors replay identically;
- parameter mismatch rejects without execution;
- socket disconnect after admission does not cancel execution;
- disconnect before admission permits later execution;
- explicit request cancellation after admission cancels only the waiter;
- registry TTL and byte/count eviction;
- all-in-flight capacity rejection;
- non-operation-ID command retains current semantics;
- per-thread command ordering remains serial.

Media:

- valid PNG/JPEG/WebP data URL materializes once;
- malformed or oversized data URL follows fallback;
- identical bytes dedupe across turns;
- URL/revision does not contain base64;
- media route rejects invalid hashes and traversal;
- auth is required;
- MIME type, ETag, immutable cache, and length are correct;
- cleanup evicts oldest non-recent entries;
- missing media is recreated by the next projection.

### TypeScript unit tests

- additive catalog fields parse correctly;
- old catalogs produce `revision: null` and unversioned URLs;
- cached catalog is isolated by normalized origin;
- corrupt cache is ignored;
- network failure keeps a valid cached catalog;
- unchanged revision does not remount tabs;
- changed revision updates inactive tabs without tearing down the active tab;
- durable command classification requires an operation ID;
- durable retry preserves the exact operation ID and params;
- non-idempotent commands do not retry;
- origin/settings change aborts pending retry.

### Process and WebSocket integration tests

- extension fixture counts command invocations while the first client drops;
- second client repeats the operation and receives the retained result;
- first response cannot be queued to the dead client but completion remains;
- duplicate conflict returns the documented error;
- query disconnect still results in a fresh read, not command-registry use;
- build/watch fixture publishes immutable A/B snapshots;
- old revision dynamic asset remains available after source rebuild.

### Codex Playwright tests

- existing Version 2 streaming invalidation tests continue asserting one
  single-flight range sync and one trailing refresh;
- a simulated reconnect during transcript sync preserves ready content and
  refreshes once;
- a simulated send reconnect keeps the composer pending and renders exactly one
  server-authored user message;
- screenshot user message uses the HTTP media URL and retains current layout;
- repeated assistant updates do not embed or refetch the image body.

### Manual iOS validation

- warm reopen after terminating and relaunching the app;
- active and inactive tab revision changes;
- background during viewer bundle fetch;
- background immediately after send;
- network switch between Wi-Fi and cellular/Tailscale;
- cached viewer with temporarily unavailable catalog endpoint;
- large screenshot turn over a shaped weak link;
- no duplicate Codex turn after reconnect.

## Acceptance criteria

The pass is complete when all of the following hold:

1. A successfully published viewer revision is immutable and addressable after
   the mutable extension build directory changes.
2. Current route-absolute bundled viewer entries are rebased to their snapshot,
   and their JavaScript and CSS return immutable cache headers and negotiated
   compression.
3. A cached catalog can restore saved extension tabs during a temporary catalog
   fetch failure for the same Remux origin.
4. A normal reload of an unchanged viewer revision does not redownload its main
   JavaScript body after the WebView cache is warm.
5. Commands with operation IDs execute once across phone socket replacement and
   replay their original result or error.
6. Commands without operation IDs retain current non-retry semantics.
7. Remux restart remains an explicit ambiguity boundary and never triggers a
   blind automatic command replay.
8. Codex Version 2 continues to perform at most one transcript read in flight
   and one trailing read.
9. A Codex transcript frame containing an image does not contain the image's
   base64 body.
10. Streaming an image-containing turn does not transfer that image body on
    every assistant update.
11. Cache implementation contains no extension-ID branches; current bundled
    extensions and Ledger use the same generic manifest and relative-base
    contract available to any external extension.
12. Existing unversioned viewers and clients remain compatible during rollout.

## Rollout and compatibility

Roll out in server-first order:

1. Deploy Remux bundle registry, versioned routes, additive catalog fields, and
   command registry while the app still ignores them.
2. Verify existing unversioned viewers and command behavior.
3. Deploy the app catalog cache, revisioned entry URLs, and durable-command
   retries.
4. Verify connection replacement with fixture extensions before enabling Codex
   command retry.
5. Deploy Codex media projection after the core media HTTP route is live.
6. Run the shaped-link matrix and remove temporary diagnostic verbosity.

Compatibility rules:

- Older apps ignore `revision` and `entryUrl` and keep using `route`.
- New apps accept `revision: null` from older servers and use the old route.
- Older Remux servers receive the existing command contract; the new app does
  not enable durable retry unless server capabilities advertise it.
- Add `durableCommandProtocolVersion: 1` and the opaque `serverInstanceId`
  described above to the existing system info response. The app retries
  commands only when this capability is present and the server instance remains
  unchanged.
- Media URLs use the existing `UserInput.image.url` shape, so older Codex
  viewers render them without a shared-type migration.
- Versioned snapshot publishing is derived from discovered manifests. External
  extensions without the new field keep working unchanged; an external
  extension opts into immutable caching by using the same relative-bundle
  contract as bundled extensions.

## Final implementation rule

Do not solve weak connectivity by layering another queue over transcript reads
or another scheduler over Codex invalidations. The durable unit is a
side-effecting command identified by `operationId`; the recoverable unit is
server-authored resource state; the cacheable unit is immutable content named
by a revision or hash.
