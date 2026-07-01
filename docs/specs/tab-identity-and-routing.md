# Tab Identity & Resource Routing

Status: Active Spec
Last verified: 2026-07-01
Canonical code: `app/src/browser/` (store, types, persistence), `app/src/surfaces/viewer/` (host bridge), `app/src/notifications/RemuxNotificationProvider.tsx`, `app/src/remote/{remuxRpcClient.ts,RemuxConnectionProvider.tsx}`, `packages/viewer-kit/src/{host,ipc,route}.ts`, `cli/{wsServer,notifications,jsonRpc}.cjs`, `extensions/*/viewer` (navigate handling), `extensions/codex/viewer/ipc/` (bridge migration, P2).

## Goal

Make a tab's identity be **the resource it shows**, route every open through **one host choke point with reuse semantics**, make identity transitions **robust to suspended WebViews**, and keep the notification tray **consistent with what the user is viewing**. Concretely:

- Opening the same file N times yields **one** tab, focused N times.
- Tapping a notification focuses the tab that already shows (or initiated) that resource — never a duplicate surface.
- Arriving at a resource — by tab switch, in-tab navigation, or notification tap — **clears all presented remux notifications for that resource**.
- Extensions keep full freedom to retarget their own tab (codex switching threads); the user can hold two threads in two tabs on purpose.

## Current defects (evidence)

A tab's logical identity today is the 6-tuple `(extensionId, viewId, handlerId, launch, resourceKind, resourceId)`, and reuse exists in exactly one code path:

1. **No dedup on open.** `openExtensionTab` (`app/src/browser/browserStore.ts:162`) always appends. Callers: launchers (`BrowserBottomBar.tsx:105`), file taps (`app/src/files/FilesOverview.tsx:342`), extension `openHostFile` (`ViewerSurface.tsx:38`). Same file opened five times → five tabs, five WebViews.
2. **Reuse requires exact 6-field equality** (`matchesBrowserTabTarget`, `browserStore.ts:323`) and only runs for notification taps (`openNotificationTarget`, `browserStore.ts:178`). `handlerId` and `launch` are *provenance* (how the tab was opened), not identity — notification intents never carry them, so provenance mismatches manufacture duplicates:
   - **Terminal:** a launcher-opened tab keeps `launch='new-terminal'` forever — the viewer's identity updates (`TerminalSurface.tsx:455,487`) never clear it, and `updateTab`'s auto-clear (`browserStore.ts:303`) is a codex-only hack gated on `resourceKind==='thread'`. Terminal notification targets have `launch:null` (`cli/notifications.cjs:227`), so a terminal notification tap **always** creates a duplicate tab.
   - **Codex draft→thread race:** a new-chat tab is born `resourceKind:'draft'` with synthetic `resourceId` (`defaultResourceId`, `browserStore.ts:465`). It becomes a `thread` tab only when the WebView's JS round-trips `updateHostTab` (`extensions/codex/viewer/App.tsx`, `syncCodexTabLocation`). Send a message and background the app → WebView suspends → tab stays `draft` → the turn-complete notification targets `{thread, threadId}` (`cli/notifications.cjs:157-176`) → no match → **brand-new tab/WebView**. The runtime learns the threadId server-side (it observes the RPC result), but the tab registry learns it only viewer-side: two sources of truth that converge only while the WebView is awake.
3. **`openHostFile({path, line})` drops `line`** — `ViewerSurface.openFile` destructures `{path}` only (`ViewerSurface.tsx:28`). Even fresh opens never honor it.
4. **Suppression and dismissal misfire the same way.** The fragile matcher also drives foreground suppression (`shouldSuppressIntentForCurrentView`, `RemuxNotificationProvider.tsx:352`) and the existing auto-dismissal effect (`RemuxNotificationProvider.tsx:227-233` → `dismissPresentedNotificationsForTarget`, `:368`). In practice: terminal notifications **never** auto-clear from the tray (launch mismatch); codex thread notifications clear only after the viewer identity sync happens to land.

## Design

### 1. Identity = resource key

A tab's identity is the normalized tuple:

```
resourceKey = (extensionId, viewId, resourceKind, resourceId)
```

- `viewId` defaults to `'main'`; all parts trimmed; `resourceKind`/`resourceId` null ⇒ the tab has **no key** and is never match-eligible.
- **Canonical serialized form**: `JSON.stringify([extensionId, viewId, resourceKind, resourceId])`. JSON-array joining is unambiguous for arbitrary resourceIds (paths, thread ids) and trivially identical to produce in the app (TS) and the runtime (CJS); one tiny helper per side, no shared package needed. It is used in **exactly two places**: app-side key comparison (reuse matching, suppression, dismissal) and origin transport (`remuxContext` frames + intent enrichment, §4). The `remux/clients/register` `activeTarget` payload **stays object-shaped** — the runtime parses it as an object (`parseBrowserTabTarget`, `cli/notifications.cjs:622`) and uses it only informationally (visibility is a live round-trip, not an `activeTarget` lookup), so P1 recomputes the app-side `targetKey`/`activeBrowserTabTarget` helpers on resource keys without touching that wire shape.
- `handlerId` and `launch` are demoted to **provenance metadata**: kept on `ViewerTab` and in the launch URL (first load needs them), excluded from all matching. The `updateTab` launch-clearing hack (`browserStore.ts:303-305`) is deleted — it existed only because `launch` polluted identity.
- **No alias history.** A tab has exactly one key: its current one. Viewer-driven retargeting (codex sidebar thread switch → `updateHostTab`) simply replaces the key; the old key is forgotten. Confirmed targets (notifications, file opens) always address *confirmed* resource ids — they never legitimately address a key a tab used to have. The one case where a former key matters — the draft→thread race — is handled by origin attribution (§4), which compares against the tab's **current** key only. This deliberately keeps suppression, dismissal, and reuse from ever treating "tab that used to show A" as "tab showing A".
- Two tabs *may* hold the same key (viewer-driven switching can converge two codex tabs on one thread). Matching resolves to the **most recently active** (`lastActiveAt`). No merge/close is forced.

### 2. One open choke point: `openResource`

`openExtensionTab` and `openNotificationTarget` are replaced by a single store action:

```ts
type ResourceTarget = {
  extensionId: string;
  viewId?: string | null;
  resourceKind?: string | null;
  resourceId?: string | null;
  focusKind?: string | null;   // e.g. 'turn' | 'line'
  focusId?: string | null;
  handlerId?: string | null;   // provenance, creation only
  launch?: string | null;      // provenance, creation only
  title?: string | null;
  status?: string | null;
  origin?: { resourceKey: string | null; tabId: string | null } | null;  // serialized key; see §4
};

openResource(target: ResourceTarget, opts?: { disposition?: 'reuse' | 'new' }):
  { type: 'selected' | 'created' | 'ignored'; tabId?: string }
```

Resolution order for `disposition: 'reuse'` (the default):

1. **Exact key match** → select the tab (most recent `lastActiveAt` on ties), bump `lastActiveAt`, stage the focus payload as `pendingNavigation` (§3).
2. **Origin fallback** — only when `target.origin` is set: if a tab with `id === origin.tabId` exists **and its current serialized key equals `origin.resourceKey`**, select it, **update its identity to the target key host-side** (`updateTab` — this also rebuilds `tab.url`, so even a dead WebView reloads directly into the right resource), and stage `pendingNavigation`. This is the authoritative fix for the draft→thread race: the notification itself proves that the hinted tab's pending resource became this thread. If the origin tab has *moved on* (its current key no longer equals the origin key — the viewer synced and the user deliberately switched elsewhere), the fallback does **not** yank it; resolution falls through to create.
3. **Create.** Focus params go into the launch URL as `remuxFocusKind`/`remuxFocusId` (extending `withViewerTabParams`, `browserStore.ts:476`, and `parseRemuxViewerRoute`, `packages/viewer-kit/src/route.ts`).

`disposition: 'new'` skips 1–2. Caller mapping:

| Caller | Disposition |
| --- | --- |
| Launchers (`BrowserBottomBar.tsx:105`) | `new` (fresh draft/session ids are unique by construction; two deliberate threads/terminals stay two tabs) |
| File taps (`FilesOverview.tsx:342`) | `reuse` |
| `host/file/open` (`ViewerSurface.tsx:38`) | `reuse`, now forwarding `line` as `focusKind:'line', focusId:String(line)` |
| Notification taps (`RemuxNotificationProvider.tsx:199`) | `reuse` + `origin` |

### 3. Reuse delivers intent: `host/navigate`

Focusing is not enough — a reused tab must receive what the open *meant* (jump to line, scroll to turn, switch thread). Runtime events are only forwarded to the **active** WebView (`ExtensionWebView.tsx:871`), and a background/suspended WebView can't receive anything, so delivery is state-based, not fire-and-forget:

- `ViewerTab.pendingNavigation: { resourceKind, resourceId, focusKind, focusId, nonce } | null`, set by `openResource` on reuse.
- **Delivery boundary:** `postToWebView` is private to `ExtensionWebView` and the imperative handle exposes only preview/keyboard methods (`ExtensionWebView.tsx:227,302`), so delivery is declarative: `ExtensionWebView` gains a `pendingNavigation` prop and an `onNavigationDelivered(nonce)` callback. When the WebView is ready, active, and `pendingNavigation` is set, it posts a `remux/event` with method `host/navigate` (guarded by the existing ready/epoch machinery) and invokes the callback on successful post. `ViewerSurface` wires the prop from its tab and the callback to a store action that clears `pendingNavigation` iff the nonce still matches. If the WebView reloads before delivery, no replay is needed — the rebuilt `tab.url` already carries the resource identity; only the ephemeral focus hint is lost (acceptable).
- Viewer-kit adds `subscribeHostNavigate(handler)` (`packages/viewer-kit/src/host.ts`), symmetric with `subscribeHostTheme` et al.; the nonce lets viewers dedupe replays. **The kit is the only bridge that gains it** — codex today ships a parallel local bridge (`extensions/codex/viewer/ipc/{client,host}.ts`, `App.tsx:9`) that would otherwise need a duplicate; instead codex migrates onto the kit first (P2).

Viewer behavior:

- **codex** — if `resourceId` differs from the active thread, `selectThread(resourceId)`; with `focusKind:'turn'`, scroll to that turn (best-effort via the transcript scroll model). Consumes the kit bridge post-P2.
- **editor** — if the path differs, `loadFile`; with `focusKind:'line'`, reveal that line in CodeMirror. (This plus §2 finally makes `openHostFile`'s `line` work end-to-end.)
- **markdown** — reload if the path differs; focus kinds are a no-op for now.
- **terminal** — no-op beyond focus; a terminal tab is its session.

**Viewer resource state must be mutable.** Editor and markdown currently derive `filePath` once from the immutable `route` prop and feed that same value to their `updateHostTab` metadata effects (`EditorSurface.tsx:17`, `MarkdownSurface.tsx:17`). Navigate handlers must not be written against that: each viewer seeds a mutable current-resource state from the route, updates it on `host/navigate`, and points its `updateHostTab` effect at that state — otherwise a navigation could render one file while tab identity reports another. (Under §2's rules a file tab's navigate today always carries its own path — same-key reuse — so this is contract hygiene rather than a live bug; codex is already store-driven.)

Viewers that ignore `host/navigate` simply get focused — the contract is additive and optional.

### 4. Origin attribution — identity without a live WebView

The fix for "the runtime knows, the tab registry doesn't". Exact shapes, end to end:

- **Tag forwarded RPCs with their tab.** Every viewer RPC already flows WebView → `ExtensionWebView.handleMessage` → `remux.request(...)` (`ExtensionWebView.tsx:826`) over the app's single registered socket. `remuxRpcClient.request` (and the `RemuxConnectionProvider` wrapper) gain an optional `context` argument serialized as a top-level frame member:
  ```jsonc
  { "jsonrpc": "2.0", "id": "…", "method": "remux/codex/thread/message/start", "params": { … },
    "remuxContext": { "tabId": "codex-1719…-3", "resourceKey": "[\"codex\",\"main\",\"draft\",\"codex:draft:1719…:3\"]" } }
  ```
  `resourceKey` is the canonical serialized form of the tab's key at send time, or `null` if the tab has no key. `ExtensionWebView` fills it from its tab (pass `tab` down from `ViewerSurface`). `parseJsonRpcFrame` (`cli/jsonRpc.cjs`) already preserves unknown members and `recordClientRequest` already receives the raw frame (`wsServer.cjs:157`) — no protocol surgery, but `cli/jsonRpc.cjs` is load-bearing here and must keep returning the full parsed object.
- **Record origin on the audience.** `recordNotificationAudience` (`cli/notifications.cjs:238`) stores `originTabId: string | null` and `originResourceKey: string | null` from `request.remuxContext` alongside the existing target.
- **Enrich the delivered intent.** `deliverNotification` (`cli/notifications.cjs:386`) constructs the delivered intent as `{ ...intent, target: { ...intent.target, originTabId, originResourceKey } }` from the audience record before the visibility check and push. Extension servers never set these fields; the runtime overwrites them unconditionally. **No extension-server (Rust) changes.**
- **Parse on both ends.** Both `parseNotificationIntent` implementations currently whitelist target fields and would silently drop the origin — each adds the two optional string fields: `cli/notifications.cjs:569` (harmless for extension-sent intents, needed so enrichment round-trips through the runtime's own parse) and `RemuxNotificationProvider.tsx:460`. `tabTargetFromIntent` maps them to `ResourceTarget.origin`.
- **Consume on tap.** `RemuxNotificationProvider` passes `origin` to `openResource`, activating resolution step 2 of §2.

The viewer-driven `updateHostTab` path stays authoritative for user-driven switching; origin attribution only adds a server-observed path for server-caused transitions, and it works even if the app's JS slept through the entire turn — the hint rides inside the notification payload itself.

### 5. Notification dismissal — the tray follows the user

The machinery exists (`getPresentedNotificationsAsync`/`dismissNotificationAsync`, `RemuxNotificationProvider.tsx:368`; activation effect at `:227-233`; tap-time sibling dismissal at `:200`) but is keyed on the fragile 6-field matcher, so it silently fails for terminal (always) and codex (until the identity sync lands). This spec re-keys it and pins down the trigger set — arriving at a resource clears **all** presented remux notifications for that resource key:

- **Matching:** dismissal and foreground suppression (`shouldSuppressIntentForCurrentView`) compare the intent's target key against the tab's **current** serialized resource key — exact key only, no origin/provenance involvement. `notificationTargetMatchesBrowserTarget` and `targetKey`/`activeBrowserTabTarget` (used for runtime `activeTarget` registration) collapse onto the same helper.
- **Triggers:**
  1. A keyed tab becomes active while the app is foreground (exists today, re-keyed).
  2. The **active tab's key changes** — this is what clears thread notifications when the user switches threads *inside* a codex tab: the viewer's `updateHostTab` lands, `activeTarget` recomputes, the effect fires. (The existing effect already keys on `activeTargetKey`; it inherits correctness from the re-key.)
  3. **Notification tap** — dismiss all presented siblings with the same target key as the tapped intent (exists today at `:200`, re-keyed). In the race case the tapped tab's identity is fixed up by origin fallback *before* this dismissal runs, so the freshly-confirmed key matches the siblings.
  4. **`host/navigate` delivery** needs no extra trigger: navigation that changes the viewed resource flows back as an identity update (trigger 2).
- Multiple notifications for one thread (several completed turns) share the same target key and differ only in `focusId` — one arrival clears them all, which is the desired "I'm caught up on this thread" semantics.

### Persistence

`PersistedViewerTab` (`browserSessionPersistence.ts`) gains optional `pendingNavigation`; parsing tolerates its absence, so the storage key stays `remux.browser.session.v1`. `handlerId`/`launch` continue to persist as provenance.

## Staged plan

Each phase lands independently and ends with the Verification suite green.

- **P1 — Resource-key identity + unified open + re-keyed hygiene.** Introduce the resource-key model and serialized-key helper; implement `openResource` (without `origin` handling); migrate all four caller groups; delete `openExtensionTab`, `openNotificationTarget`, the 6-field `matchesBrowserTabTarget`, and the `updateTab` launch hack; switch suppression, dismissal (all three triggers), and the app-side `targetKey`/`activeBrowserTabTarget` helpers to key comparison (registration wire shape unchanged, §1).
  *Fixes immediately:* same-file duplicates; terminal-notification duplicates; terminal/codex tray never/late clearing; editor/markdown handler-provenance mismatches.
- **P2 — Codex host-bridge migration to viewer-kit.** Codex predates the kit and ships a parallel bridge: `ipc/client.ts` (transport) + `ipc/host.ts` (host methods), with domain modules (`files`, `threadCommands`, `transcript`, `threadResources`, `resourceInvalidations`, `composerConfig`, `media`, `fileResources`) and `hostStore` riding on it. Duplicating `subscribeHostNavigate` into that bridge would compound the debt, so the debt is paid here instead:
  1. **Kit absorbs the two capabilities codex's transport has and the kit lacks:** `remux/status` frames — kit `ipc.ts` currently drops them (`parseNativeMessage` accepts only response/error/event) while codex's `client.ts` consumes them for the full host status *including `cwd`* (`ipc/client.ts:40,164`, `CodexViewHostStatus`), so the kit gains a status snapshot + subscription (and matching pending-request rejection semantics on closed/error); and `pickHostAttachments` (`host/attachments/pick` — already served host-side, `ExtensionWebView.tsx:737`; the kit just lacks the wrapper).
  2. **Codex deletes `ipc/client.ts` + `ipc/host.ts`**, re-points the domain modules at kit `requestIpc`/`subscribeIpcEvents`, rebuilds `hostStore` on the kit status APIs, and drops local types that now overlap kit exports (`RemuxHostViewportMetrics`, host param types).
  Behavior-neutral; `npm run test:codex` is the regression gate. Discharges the viewer-kit Phase-1 "satellites migrated" debt for codex.
- **P3 — Navigate delivery.** `remuxFocusKind`/`remuxFocusId` URL params; `pendingNavigation` staging in the store + `pendingNavigation` prop / `onNavigationDelivered` ack through `ViewerSurface` → `ExtensionWebView`; viewer-kit `subscribeHostNavigate`; viewer implementations on the kit bridge (codex thread-switch/turn-scroll, editor line reveal + `line` plumbed through `host/file/open`, markdown/terminal minimal) with mutable viewer resource state (§3); persistence addition. Depends on P2 for the codex handler.
- **P4 — Origin attribution.** `context` parameter on `remuxRpcClient.request`/`RemuxConnectionProvider` + `remuxContext` frame member filled by `ExtensionWebView`; audience `originTabId`/`originResourceKey`; intent enrichment in `deliverNotification`; both `parseNotificationIntent` implementations extended; `origin` fallback in `openResource`. Depends only on P1 — may land before or in parallel with P2/P3.
  *Fixes:* the codex draft→thread notification race, including the suspended-WebView case — tap focuses the originating tab, fixes its identity, and clears sibling notifications.
- **P5 — Polish (optional, not completion criteria).** Empty-draft launcher reuse (tapping "new chat" twice shouldn't stack pristine drafts — needs a host-visible "untouched" signal, deferred); duplicate-collision UX (two tabs converged on one key — today: most-recent-wins, no merge); multi-host keys (`hostId` joins the resource key when multi-host lands).

## Verification

- `npm run typecheck` · `npm run app:typecheck` · `npm run viewers:build` · `npm run test:codex` · `npm run test:cli` (extend cli tests to cover origin recording on audiences and intent enrichment at delivery).
- Manual scenarios:
  1. Open the same file from Files twice, and via a codex `openHostFile` mention → one editor tab, focused each time; `line` reveals.
  2. Start a codex turn from a new chat, background the app before the turn completes, tap the turn-complete notification → the **originating tab** opens on the thread (no new tab), even after a WebView reload.
  3. Terminal launcher tab → trigger a terminal notification → tap focuses the existing session tab.
  4. Two codex tabs on two threads: notifications for each focus their respective tab; switching a tab's thread in-viewer keeps working (`updateHostTab` path) and a notification for the *old* thread opens a new tab rather than yanking the switched one.
  5. Notification for a resource with no open tab → creates exactly one tab, focused correctly (turn scroll / line reveal).
  6. Accumulate several notifications for one thread; open that thread by tab switch **and** (separately) by in-tab sidebar switch → all presented notifications for the thread clear. Tap one of several → the siblings clear.
  7. Terminal notification while its session tab is open → arriving at the tab clears it from the tray.

## Out of scope

- Extension-initiated cross-tab opens (an `openHostResource` viewer API targeting arbitrary resources) — the choke point makes this cheap later, but no extension needs it yet.
- Tab groups/panes/split view; any change to the one-tab-one-WebView surface model (`ActiveSurface.tsx`).
- Runtime audience keying redesign (`notificationAudienceKey` still carries handler/launch slots internally; both sides are consistently empty today).
- Notification content/UX changes; Expo push transport; server-side (runtime) tray state — dismissal is client-local.
