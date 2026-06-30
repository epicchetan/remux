# Terminal Extension Phase 4: Input Latency and Background Resync

Status: Active Spec
Last verified: 2026-06-30
Canonical code: `extensions/terminal/viewer`, `extensions/terminal/server`, `packages/viewer-kit`, `app/src/surfaces/viewer`, `app/src/remote`, `cli`.

## Purpose

Two felt problems on mobile:

1. **Typing lags every couple of characters.** Input is fine most of the time but periodically stutters and catches up in a burst.
2. **Backgrounding the app and returning shows stale output.** The terminal (e.g. Claude Code) does not show the latest content until a keypress (arrow up/down) forces the TUI to repaint.

This phase fixes both without rewriting the terminal. The backend PTY is already fast (benchmarked p50 `0.015ms`, p99 `0.067ms` for one-byte writes; p99 `0.175ms` through the local websocket/router). The latency and staleness live in the mobile bridge, the per-keystroke RPC, and the lifecycle wiring — all hops we own.

## Communication Map (current)

Input, per character — every keystroke is a full request/response round trip whose `{ok:true}` ack is discarded:

```
xterm.onData → sendBytes → writeTerminalSession            [TerminalSurface.tsx:809,329]
  └ requestIpc('session/write')  Promise + 300s timer, base64, JSON.stringify   [ipc.ts:72]
    └ RN postMessage → ExtensionWebView.handleMessage → remux.request           [ExtensionWebView.tsx:761]
      └ RemuxRpcClient.request  Promise + 300s timer → ws.send(JSON)            [remuxRpcClient.ts:193]
        └ wsServer → router.handleRequest → extensionProcess.handleRpc → stdin  [extensionProcess.cjs:123]
          └ Rust write_session: base64-decode, lock, write_all+flush to PTY     [main.rs:272]
            └ returns {ok:true} ──────── all the way back up ────────→ discarded
```

Output:

```
PTY → reader thread → 3ms coalescer → output_tx → stdout          [main.rs:1018,1046]
  └ extensionProcess broadcast → wsServer.broadcast(all open sockets)  [wsServer.cjs:26]
    └ RemuxRpcClient.onMessage → every subscriber                  [RemuxConnectionProvider.tsx:214]
      └ EACH ExtensionWebView.remux.subscribe → postMessage into its webview  [ExtensionWebView.tsx:801]
        └ ipc.enqueueEvent → requestAnimationFrame flush → filter by sessionId → terminal.write  [ipc.ts:154]
```

The shell does **not** echo locally — xterm only paints a character after it round-trips to the PTY and back. So perceived keystroke latency equals the full up-and-back loop, and the ack is pure overhead riding alongside it.

## Diagnosis

### Why typing stutters

1. **The ack round trip is wasted work.** Every keystroke allocates two Promises + two 300s timers (`ipc.ts:78`, `remuxRpcClient.ts:199`), does four JSON encode/decode passes and two RN bridge crossings up — all to deliver an `{ok:true}` that `sendBytes` throws away. It is fire-and-forget already, so it does not block the next key, but it is steady per-key GC and bridge pressure.
2. **Every echo eats up to one animation frame.** Inbound output is queued and flushed on `requestAnimationFrame` (`ipc.ts:161`), adding up to ~16ms (more when the JS thread is busy) on the critical "see the character I typed" path.
3. **The stutter is main-thread contention, dominated by the output fanout.** `ActiveSurface` keeps every viewer tab mounted (`ActiveSurface.tsx:52`) and every `ExtensionWebView` subscribes to every websocket message (`ExtensionWebView.tsx:801`). So each PTY output frame is JSON-serialized and `postMessage`d into all mounted webviews — terminal and codex/editor/markdown alike — and all but one parse it and discard it after filtering by `sessionId`. Cost scales with total open tabs, on the single RN JS thread. When that thread stalls, acks and echoes queue and then flush together. Dev logging (`socket:message` per frame; the console monkey-patch re-posting every webview `console.*` over the bridge — `ExtensionWebView.tsx:1382`) adds more bridge work.
4. **Tmux polling can block input at the server.** The Rust stdio loop processes terminal requests and notifications serially (`main.rs:63`). A `tmux/context/get` request runs several external `tmux` commands (`tmux.rs:334`) before the next stdin frame is handled. Even after keystrokes become fire-and-forget notifications, an active tmux scan can sit ahead of `session/write` in the same queue and create exactly the periodic "a few chars, then a pause" pattern. Visibility-gating removes background load, but the active terminal still needs a non-blocking or cached tmux path.

### Why backgrounding loses output

- Output is a fire-and-forget broadcast to currently-open sockets only (`wsServer.cjs:26-33`). No per-client buffer, no replay on reconnect at the CLI layer.
- The Rust server keeps a 4MB / 10k-frame replay buffer (`main.rs:517`), but it is only consulted on explicit `attach` (`main.rs:234`).
- `TerminalSurface` attaches exactly once, at mount (`TerminalSurface.tsx:842`). There is **no reconnect handler.** When iOS suspends/drops the socket on background, `RemuxConnectionProvider` reconnects on resume (`RemuxConnectionProvider.tsx:301`) — but nobody tells the terminal to re-attach, so every frame emitted while away is lost and `lastSeqRef` stays behind.
- A keypress makes the full-screen TUI repaint, which is what "refreshes" it. The session itself survives in the long-lived extension process, so the replay data is sitting there unused.

## Design Overview

Split the webview bridge into a **control plane** (host → viewer lifecycle events: connection status and active/foreground state) and keep the **data plane** (broadcast events) but gate it to the active tab. The control plane lets the active viewer re-sync after a reconnect or after it becomes foreground; that re-sync is what makes gating the data plane safe.

### Shared protocol additions

Two new host → viewer **events** (control plane), one new viewer → host **notification** (data plane):

```jsonc
// host → webview, posted as { type: 'remux/event', message: {...} }
{ "method": "host/connection", "params": { "status": "connected" | "connecting" | "reconnecting" | "disconnected" } }
{ "method": "host/active",     "params": { "active": true | false } }

// webview → RN, no id, no response
{ "type": "remux/notify", "method": "remux/terminal/session/write", "params": { "sessionId": "...", "dataBase64": "..." } }
```

The notification reuses the existing method name; the only difference from a request is the absent `id`, which signals "do not reply" the whole way down. All additions are backward compatible — requests are unchanged.

---

## Tier 1.1 — Re-attach + replay on reconnect/activate

**`packages/viewer-kit/src/host.ts`** — add subscriptions next to `subscribeHostViewportMetrics`:

```ts
export type RemuxHostConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

export function subscribeHostConnection(cb: (status: RemuxHostConnectionStatus) => void) {
  return subscribeIpcEvents((events) => {
    for (const e of events) if (e.method === 'host/connection') cb(paramsOf<{ status: RemuxHostConnectionStatus }>(e).status);
  });
}
export function subscribeHostActive(cb: (active: boolean) => void) {
  return subscribeIpcEvents((events) => {
    for (const e of events) if (e.method === 'host/active') cb(paramsOf<{ active: boolean }>(e).active);
  });
}
```

**`app/src/surfaces/viewer/ExtensionWebView.tsx`** — emit the connection event. The component already re-renders on `remux.status` (`postStatus` effect, line 810):

```ts
const postConnection = useCallback(() => {
  postToWebView({ type: 'remux/event', message: { method: 'host/connection', params: { status: remux.status.type } } });
}, [postToWebView, remux.status.type]);

useEffect(() => { postConnection(); }, [postConnection]);
```

Also emit it in the `remux/ready` case after `postStatus()` (line 582) so a freshly loaded viewer learns it is connected. `remux.status.type` already maps to the four values (`RemuxConnectionProvider.tsx:44`).

**`extensions/terminal/viewer/src/terminal/TerminalSurface.tsx`** — add `resyncSession`, reusing the suppressed-replay path (`writeReplay`, line 312; `attachTerminalSession`, `terminalRpc.ts:146`):

```ts
const resyncInFlightRef = useRef(false);
const connectionRef = useRef<RemuxHostConnectionStatus>('connecting');
const initialAttachCompletedRef = useRef(false);

const resyncSession = useCallback(async () => {
  const id = sessionIdRef.current;
  if (!id || resyncInFlightRef.current) return;
  resyncInFlightRef.current = true;
  try {
    const size = currentSize();
    const attached = await attachTerminalSession({
      cols: size.cols, rows: size.rows,
      sessionId: id,
      replaySeq: lastSeqRef.current > 0 ? lastSeqRef.current + 1 : null,
    });
    if (attached.replayTruncated) {        // gap too big → cannot reconstruct screen
      terminalRef.current?.clear();
      lastSeqRef.current = 0;
      setReplayGap(true);                   // separate UI state; do not change TerminalStatus
      return;
    }
    setReplayGap(false);
    writeReplay(attached.replay);           // writeFrame dedups by seq → idempotent
    if (attached.status === 'exited') {
      setStatus({ code: attached.exitCode ?? null, signal: attached.exitSignal ?? null, type: 'exited' });
    }
  } catch {
    /* session gone after a server restart → leave as-is; user can hit "Start new shell" */
  } finally {
    resyncInFlightRef.current = false;
  }
}, [currentSize, writeReplay]);

useEffect(() => subscribeHostConnection((status) => {
  const prev = connectionRef.current;
  connectionRef.current = status;
  if (status === 'connected' && prev !== 'connected' && initialAttachCompletedRef.current) {
    void resyncSession();                   // reconnect transition after initial attach
  }
}), [resyncSession]);

useEffect(() => subscribeHostActive((active) => {
  if (active) void resyncSession();         // became foreground after fanout was gated off
}), [resyncSession]);
```

Correctness notes:

- `writeFrame` already ignores `seq <= lastSeqRef` (line 304), so replay is idempotent even if some frames did arrive — no double-paint.
- Set `initialAttachCompletedRef.current = true` after `startOrAttachSession` binds the initial session. Guarding on that flag avoids a redundant attach from the first `host/connection: connected` event, while still resyncing after later reconnects.
- `replayTruncated` is set by the server (`main.rs:253`) when its buffer rolled past your `lastSeq`. The server stores output frames, not a terminal screen snapshot, so missing frames cannot be reconstructed. Do **not** write a partial retained tail after clearing and call it repaired. Mark the view stale and wait for the next real TUI repaint/output, or add a future server-side snapshot/repaint mechanism if guaranteed recovery is required.

---

## Tier 1.2 — Gate the broadcast fanout to the active tab

**`app/src/browser/ActiveSurface.tsx`** — pass the `visible` flag it already computes (line 53):

```tsx
<ViewerSurface active={visible} onOpenOverview={onOpenOverview} surfaceRef={visible ? surfaceRef : undefined} tab={tab} />
```

**`app/src/surfaces/viewer/ViewerSurface.tsx`** — thread `active` through to `<ExtensionWebView active={active} … />`.

**`app/src/surfaces/viewer/ExtensionWebView.tsx`** — gate the data plane via a ref so the subscription closure is not recreated, and announce active state on the control plane:

```ts
const activeRef = useRef(active);
useEffect(() => {
  const wasActive = activeRef.current;
  activeRef.current = active;
  postActive(active);                        // host/active event (control plane — always sent)
  if (active && !wasActive) postConnection(); // nudge the now-active viewer to resync
}, [active, postActive, postConnection]);

useEffect(() => remux.subscribe((message) => {
  if (!activeRef.current) return;            // ← the fix: inactive tabs no longer re-serialize every frame
  postToWebView({ message, type: 'remux/event' });
}), [postToWebView, remux]);
```

`postActive` mirrors `postConnection`, posting `{ type: 'remux/event', message: { method: 'host/active', params: { active } } }`.

Also call `postActive(active)` in the `remux/ready` case immediately after `postStatus()` / `postConnection()`. The early effect can run before the WebView is ready and `postToWebView` will return false; a newly loaded inactive tab must still learn it is inactive, otherwise terminal-side defaults can briefly start polling or resyncing as if visible.

Safe because app-level notifications do not flow through here — `RemuxNotificationProvider` subscribes independently (`RemuxNotificationProvider.tsx:239`), so the bell / "Claude paused" / badges still fire for background tabs. The only thing inactive viewers lose is live UI updates, which Tier 1.1 repairs on activation.

---

## Tier 2.3 — Make keystrokes fire-and-forget notifications

**`packages/viewer-kit/src/ipc.ts`** — add (and extend the `WebViewRequest` union with `remux/notify`):

```ts
export function notifyIpc(method: string, params?: unknown) {
  initializeIpc();
  postMessage(params === undefined ? { type: 'remux/notify', method } : { type: 'remux/notify', method, params });
}
```

**`extensions/terminal/viewer/src/terminal/terminalRpc.ts`** — add a notify variant:

```ts
export function writeTerminalSessionInput(sessionId: string, data: Uint8Array) {
  notifyIpc('remux/terminal/session/write', { dataBase64: bytesToBase64(data), sessionId });
}
```

In **`TerminalSurface.tsx`** `sendBytes` (line 323) replace `void writeTerminalSession(...)` with `writeTerminalSessionInput(currentSessionId, data)` and drop the `.catch(setStatus error)` — session death already arrives via the `exited` event (line 922). Keep the acked `writeTerminalSession` only if a verified path for paste is still wanted; otherwise remove it.

*Optional batching:* buffer bytes in `sendBytes` and flush on `queueMicrotask` to merge same-task bursts (key-repeat) without adding a frame of latency to a lone keystroke. The dominant win is removing the ack/promise/timer, so batching is secondary.

**`app/src/surfaces/viewer/ExtensionWebView.tsx`** — parse and route the new type:

- In `parseWebViewMessage` (line 1046) accept `{ type: 'remux/notify', method, params }`.
- In `handleMessage` add `case 'remux/notify': remux.notify(message.method, message.params); break;` (no response posted).

**`app/src/remote/RemuxConnectionProvider.tsx`** — expose `notify` on the connection value (line 477):

```ts
notify: (method, params) => { clientRef.current?.tryNotify(method, params); },
```

`tryNotify` already exists (`remuxRpcClient.ts:229`) and silently drops when disconnected — correct, since input typed while offline is moot and resync repaints.

**`cli/wsServer.cjs`** — route client notifications instead of dropping them (lines 120-133), where it currently warns "ignored downstream notification":

```js
if (message.method === 'remux/app/log') { logAppDiagnostic(message.params, log); return; }
if (router.handleNotification) { void router.handleNotification({ method: message.method, params: message.params }); return; }
```

**`cli/rpcRouter.cjs`** — add `handleNotification`:

```js
async handleNotification({ method, params }) {
  const extensionId = extensionIdFromMethod(method) || defaultExtensionId;
  const server = extensionId ? servers.get(extensionId) : null;
  server?.handleNotification?.({ method, params });   // fire-and-forget
}
```

**`cli/extensionProcess.cjs`** — add `handleNotification` next to `handleRpc` (line 123): write the frame with no `id`, register nothing in `pending`:

```js
handleNotification({ method, params }) {
  if (!child || !child.stdin.writable) return;
  const message = params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
  child.stdin.write(`${JSON.stringify(message)}\n`);
}
```

**`extensions/terminal/server/src/main.rs`** — accept id-less frames and suppress their replies. This is a small JSON-RPC refactor, not just an `Option<Value>` type change:

- Parse stdin into an envelope whose `id` is `Option<Value>` and whose `method` is required.
- Keep request responses exactly as today when `id` is present.
- For id-less notifications, run the same handler but drop both success and error responses.
- For malformed JSON / invalid request objects, only send a JSON-RPC error when an id is known; otherwise log/drop. Notifications do not have a caller waiting for an error.
- Keep `JsonRpcResponse` carrying a concrete `Value` id so ordinary request responses stay type-safe.

In `run_stdio_server` (line 69), emit a response only when `id` was present:

```rust
match serde_json::from_str::<JsonRpcEnvelope>(&line) {
    Ok(envelope) => {
        let id = envelope.id.clone();
        let response = handle_request(&server, envelope.into_request());
        if id.is_some() {
            output_tx.send(serde_json::to_value(response)?)?;
        }
    }
    Err(error) => {
        // Parse errors have no reliable request id here. Log/drop for notifications;
        // normal clients still get request errors at the CLI websocket boundary.
        eprintln!("ignored invalid terminal protocol frame: {error}");
    }
}
```

`write_session` already flushes immediately (line 291), so a notification write hits the PTY with no added latency. Ordering is preserved because the single stdin reader processes notifications (writes) and requests (resize/attach) in arrival order on the same pipe.

---

## Tier 2.4 — Cut a frame of echo latency

**`packages/viewer-kit/src/ipc.ts`** `enqueueEvent` (line 154) currently defers every inbound frame to `requestAnimationFrame`. Switch to a microtask:

```ts
function enqueueEvent(message: JsonRpcMessage) {
  eventQueue.push(message);
  if (eventFlushHandle) return;
  eventFlushHandle = true;
  queueMicrotask(() => {
    eventFlushHandle = false;
    const events = eventQueue.splice(0);
    for (const s of eventSubscribers) s(events);
  });
}
```

This still coalesces synchronous bursts but fires sub-millisecond instead of waiting for the next paint. xterm's renderer throttles painting, so it does not over-render under a flood — it only removes the artificial up-to-16ms delay on the interactive echo path.

---

## Tier 2.5 — Gate high-volume dev logging

**`app/src/remote/remuxRpcClient.ts`** — the `socket:message` log fires per frame (line 140). Drop or gate it.

**`app/src/remote/remuxDebug.ts`** — add a `verbose` gate so `socket:message`, `rpc:request`, `rpc:result` only `console.log` when explicitly enabled (early-return in `logRemuxDebug` when `!VERBOSE && highVolume.has(label)`).

**`app/src/surfaces/viewer/ExtensionWebView.tsx`** — the diagnostics script monkey-patches `console.*` to post every log over the bridge (lines 1382-1388). Wrap that block in a flag so a chatty page does not generate a bridge crossing per log line; keep the low-volume `error` / `unhandledrejection` / lifecycle hooks always on. Inject the flag via the existing `injectedJavaScriptBeforeContentLoaded` template.

Once Tier 2.3 lands, per-keystroke `rpc:request`/`rpc:result` logs disappear anyway (writes stop using the request path).

---

## Tier 2.6 — Keep tmux off the input lane

There are two required parts. The first removes background work; the second prevents active tmux scans from blocking keystrokes behind external subprocesses.

**Part A — viewer visibility gate.** In **`extensions/terminal/viewer/src/terminal/TerminalSurface.tsx`**, the poll effect (line 932) runs a 2.5s interval for every mounted terminal. Gate it on the `active` + `connected` signals from Tier 1:

```ts
const [hostActive, setHostActive] = useState(true);
const [connected, setConnected] = useState(true);
useEffect(() => subscribeHostActive(setHostActive), []);
useEffect(() => subscribeHostConnection((s) => setConnected(s === 'connected')), []);

useEffect(() => {
  if (!sessionId || status.type !== 'running' || !hostActive || !connected) { /* clear, return */ }
  // poll once immediately, then setInterval(tmuxPollMs) as today
}, [sessionId, status.type, hostActive, connected]);
```

Inactive and backgrounded tabs stop spawning `tmux list-*` subprocesses entirely; on re-activation it polls once immediately then resumes. A later refinement could make it event-driven (refresh after a tmux action or on focus), but visibility-gating removes the background load with no behavior change for the active tab.

**Part B — server-side tmux worker/cache.** Move tmux scans out of the terminal server's main stdin request loop:

- Add a tmux context worker per terminal server (or a small shared worker pool) that runs `scan_context` asynchronously.
- `tmux/context/get` should return the most recent cached context immediately when it is fresh enough, and kick a background refresh when stale. Target freshness: 1s for active terminals; longer is acceptable for inactive ones because Part A stops their polling.
- `tmux/action` can remain acked and should refresh context after the action, but it must not block `session/write`: run the action/scan in the worker and answer when done, while the main loop continues processing subsequent stdin frames.
- Protect the worker with "one scan in flight per session/socket set" coalescing so repeated polls do not queue multiple `tmux list-*` batches.
- If no cached context exists yet, return a cheap `"none"`/`"unknown"` context and refresh in the background rather than blocking input. The UI can update on the next poll or on a `remux/terminal/tmux/context` notification if one is added.

This is the part that closes the remaining latency hole. Fire-and-forget input removes response overhead, but it does not help if a long `tmux/context/get` request is already ahead of the input frame in the same stdin loop.

---

## Build, Test, Rollout

- **Rust:** `cargo test` in `extensions/terminal/server`; add a test that an id-less `session/write` frame writes to the PTY and emits no stdout response. Add a tmux-worker/cache test or harness proving `session/write` is processed while a tmux scan/action is in flight.
- **CLI:** extend `cli/tests/extension-process.test.js` and `ws-server.test.js` for `handleNotification` (frame written without an `id`, no `pending` entry) and notification routing (not dropped).
- **Back-compat:** every change is additive — an old viewer still sends requests; an old server still answers them. Ship server/CLI first, then switch the viewer to notifications.
- **Manual verification (maps to the reported symptoms):**
  1. Type fast in Claude Code → no periodic stutter (fanout + ack gone, active tmux scans off the input lane).
  2. Open a second viewer tab, type in the terminal → typing stays smooth (was O(tabs) bridge cost).
  3. Background the app for 30s while Claude Code streams, foreground → screen catches up automatically with no keypress (resync-on-activate).
  4. Drop the socket / flip airplane mode briefly → on reconnect the terminal repaints from replay.
- **Instrument first:** add a dev-only echo-RTT timer (stamp `onData`, match the first output frame) to quantify each tier. The backend is already ~0.18ms p99, so every millisecond measured is bridge + main-thread + scheduler — exactly what these changes target.

## Suggested Order

1. Instrument first — echo RTT plus a server-side "write while tmux scan is in flight" probe, so each tier has numbers.
2. Tier 1.1 + 1.2 together — they interlock and deliver the staleness fix plus the biggest fanout win. Include Tier 2.6 Part A here because it depends on `host/active`.
3. Tier 2.3 — the protocol change that removes the per-key ack/request path.
4. Tier 2.6 Part B — tmux worker/cache. This is required before calling the periodic typing stutter fixed.
5. Tier 2.4 / 2.5 — small, independent scheduler/logging follow-ups.
