Status: Active Spec
Last verified: 2026-07-03
Canonical code: `app/src/files/`, `app/src/browser/BrowserOverview.tsx`, `cli/core/fs.cjs`, `cli/core/coreRouter.cjs`, `cli/wsServer.cjs`, `cli/previewRelay.cjs`

# Files tab: freshness model, pull-to-refresh, and icon redesign

Three user-visible complaints — stale listings, git badges that "don't propagate up," and janky folder/file icons — reduce to **two root causes plus one visual gap**:

- **Root cause A — pull-only, action-scoped freshness.** Directory data is only ever fetched when the user *acts on that exact record* (navigate/expand). There is no push channel, no refresh on returning to the tab, and no manual refresh. Anything already on screen — including expanded subtrees and the rows of the directory you're sitting in — can go stale indefinitely.
- **Root cause B — a folder's git badge lives in its *parent's* snapshot.** The server rolls descendant git status up into directory entries correctly (`cli/core/fs.cjs:842-928`). But that rollup is baked into the listing of the folder's *parent* at fetch time. When a file changes three levels deep, every ancestor listing above it is now stale, and nothing invalidates that chain. "Git doesn't propagate to parents" is a **client invalidation bug, not a server computation bug**.
- **Visual gap C — hand-composited View icons.** The folder is two overlapping `View`s tinted with `focusRing` at 0.58 alpha (washed-out, mismatched corners where tab meets body); the file icon is a bordered rect with an 8px uppercase extension caption and a 4px accent bar with only three real color mappings. Meanwhile the app already renders SF Symbols natively (`app/src/ui/NativeGlassIconButton.tsx:64`).

---

## As-is architecture

```
FilesOverview (FlatList of flattened tree rows, glass header overlay)
  └─ filesStore (zustand): directoriesByPath{entries, loadedAt, version, refreshStatus},
     expandedPaths, currentPath; SWR refresh gated on directoryStaleMs = 5s
       └─ filesApi: remux/fs/readDirectory | readDirectories (batch, force flag)
            └─ cli/core/fs.cjs: per-dir cache (TTL 3s, force bypass) + inflight dedup
               git: repo-root cache (5s) + `git status --porcelain=v1 -z` per repo (TTL 1s)
               → entries annotated exact + descendant-rollup, version = sha1(entries)
```

Refresh triggers today: `navigateToDirectory`, `navigateToParentDirectory`, `toggleFolder` (`app/src/files/filesStore.ts:90-144,197-226`) — each refreshes **only the target record**, and only if `loadedAt` is older than 5s. Viewport preloading (`FilesOverview.tsx:86-160`) only fetches *never-loaded* directories; it never refreshes loaded ones.

---

## Audit findings

- **F1 — Returning to the Files tab never refreshes.** `FilesOverview` unmounts/remounts on section switch (`BrowserOverview.tsx:272`), but the store is module-global, and `loadRootDirectory` early-returns when `currentPath` is already set (`filesStore.ts:81-89`). After the first visit, re-entering the tab renders whatever was cached — indefinitely.
- **F2 — Expanded descendants and on-screen rows never refresh in place.** All refresh triggers are user actions scoped to one record (F1 above). If you're viewing `~/project` with `src/` expanded and an agent edits `src/utils/helper.ts`, nothing refetches. Even collapsing/re-expanding `src/utils` refreshes only *its own* listing — the badge on the `src` row lives in `~/project`'s record and stays stale (root cause B).
- **F3 — Server-side rollup is correct.** `indexGitStatus` builds `descendantByDirectoryPath` (`fs.cjs:842-862`) and `gitStatusForEntry` merges exact + descendant statuses for directory entries (`fs.cjs:917-929`), ranked conflicted > added/untracked > modified/renamed > deleted. No server fix needed for propagation — only invalidation.
- **F4 — No push channel for fs changes, but the precedent exists.** `wsServer.cjs` exposes `broadcast`; `previewRelay.cjs` throttles `remux/previews/invalidate` (1/s per resource, trailing send); the app consumes it via `remux.subscribe` (`BrowserShell.tsx:104`). The files tab uses none of this. (Note: the preview relay's `start.cjs` wiring is being reworked in the current working tree — the fs relay below defines its own lifecycle rather than piggybacking on that seam.)
- **F5 — No pull-to-refresh.** The `FlatList` (`FilesOverview.tsx:164`) has no `refreshControl`.
- **F6 — `itemCount` is dead code.** The server always sets `itemCount: null` (`fs.cjs:592`), so the "N items" meta (`FilesOverview.tsx:486`) never renders.
- **F7 — Repo-boundary blind spot.** Git status is resolved for *the listed directory*, not per entry (`fs.cjs:189-193`). Listing a non-repo directory (e.g. `~`) shows no badge on a repo folder inside it, even with dirty files. Accepted limitation for now (per-entry repo-root resolution is a follow-up; see Workstream 4).
- **F8 — Symlinked directories are inert.** `kind: 'symlink'` rows get no chevron, no navigation, no handler match (`fileHandlers.ts:11`). A symlink to a directory can't be entered.
- **F9 — Dotfile icon captions are garbage.** `fileExtensionForName('.gitignore')` returns `gitignore` (`fileHandlers.ts:28-35`), sliced to `GITI` in the icon (`FilesOverview.tsx:515-517`). Note the same function drives *handler matching* — the icon fix must not change which viewer opens dotfiles.
- **F10 — Cache interplay is sound.** Client `force: true` bypasses the server directory cache; git status cache TTL is 1s. Pull-to-refresh and push-invalidation can rely on `force` for correctness. Worst-case git staleness on a forced read is 1s — acceptable.

---

## Path containment helper (shared contract)

Both workstreams need "is this path inside that root?" — it must be a tested helper, not ad-hoc prose, and it must include the root itself:

```
isPathWithin(root, target) := target === root || target.startsWith(root + sep)
```

- Both arguments are absolute, resolved paths. `target === root` **must** match — the repo root's own listing carries badges and must invalidate with `gitDirtyRoots`.
- The `root + sep` boundary prevents `/repo2` matching `/repo`.
- **Server** (`cli/fsRelay.cjs`, exported for tests): compare via the existing `pathComparisonCandidates` (`fs.cjs:981-996`) so the macOS `/var` ↔ `/private/var` duality can't split root and target.
- **Client** (`app/src/files/`): compare the server-sent strings verbatim with `'/'` as separator — every client path originated from the server, so no re-resolution, no candidate expansion. Unit-test both sides (`X` vs `X/child` vs `X2/child` vs `X` itself).

---

## Workstream 1 — Freshness model + pull-to-refresh (client-only)

**New store action** `refreshVisibleDirectories(request)`:

1. Collect the refresh set: `currentPath` + every loaded record reachable from it through `expandedPaths` (walk the same expansion state `visibleFileTreeRows` uses — refresh what's renderable, not every record ever cached).
2. Issue **one** `readRemuxDirectories(request, paths, { force: true })` batch (`filesApi.ts:42`), applying results through the existing `applyDirectoryResult`. The `version` hash short-circuit (`filesStore.ts:373-381`) already preserves entry identity when nothing changed, so unchanged directories don't churn the list.
3. Track `isRefreshingAll: boolean` and `refreshError: string | null` on the store.

**Concurrency and failure contract** (acceptance criteria):

- **Reentrancy:** `refreshVisibleDirectories` is a no-op while `isRefreshingAll` is true. Pull-to-refresh gestures cannot stack batches.
- **In-flight records:** paths whose record is already fetching (`isDirectoryFetching`) are *excluded* from the batch — don't cancel, don't duplicate. Any residual race is benign: each batched path gets a fresh `nextDirectoryRequestId()` recorded before dispatch (exactly the `preloadDirectories` pattern, `filesStore.ts:156-171`), and `applyDirectoryResult`/`applyDirectoryError` already drop responses whose `requestId` is stale (`filesStore.ts:356-358,404-406`).
- **Partial failures:** per-path results apply independently (the batch RPC already returns per-path `ok`/`message`, `filesApi.ts:14-27`). A failed path that *has entries* keeps its stale entries and gets no row-level error (the existing `visible: false` semantics of `applyDirectoryError`). A failed path with *no entries* keeps its current empty/error state.
- **Surfacing errors:** row-level error display is unchanged. Additionally, if any batch item fails (or the whole RPC rejects), set `refreshError` to a single summary ("Couldn't refresh N of M directories"), rendered as one compact line under the header; cleared on the next successful refresh or navigation. Errors never clear previously good data.
- **Spinner lifecycle:** `isRefreshingAll` flips true before dispatch and false when the batch RPC settles (resolve *or* reject), independent of partial failures.
- **Batch size:** unbounded by design — the server already caps directory concurrency at 4 (`fs.cjs:14`), and real expansion sets are small.

**Trigger 1 — pull-to-refresh.** Add `refreshControl={<RefreshControl … />}` to the FlatList:

- `refreshing={isRefreshingAll}`, `onRefresh={() => refreshVisibleDirectories(request)}`, `tintColor={theme.textMuted}`.
- Layout gotcha: the header is an absolutely-positioned glass overlay and the top spacing is *content padding* (`FilesOverview.tsx:128-134`), so the default spinner would draw at the physical top, behind the header. Set `progressViewOffset` to `listTopPadding` and verify on device (app is iOS-only; `progressViewOffset` is supported on iOS in RN 0.85 but has a history of quirks). Fallback if it misbehaves: temporarily suppress the header's glass background while `isRefreshingAll` so the spinner reads through it.

**Trigger 2 — refresh on tab re-entry.** On mount, when `currentPath` is already set (the F1 early-return path), fire `refreshVisibleDirectories` as a *background* SWR pass — no spinner (skip `isRefreshingAll`, reuse per-record `refreshStatus: 'refreshing'`), no layout shift (version hash guarantees identity when clean). This alone fixes the everyday "I came back and it's stale" complaint.

**Trigger 3 — refresh expanded descendants alongside their parent.** When `navigateToDirectory` / `toggleFolder` decide to background-refresh a directory (`shouldRefreshDirectory`), extend the refresh to that directory's *expanded, loaded* descendants via the same batch call, instead of the single record. This closes the "collapse/re-expand shows fresh children but stale ancestor badges" hole from the user-action side. (Push invalidation in Workstream 2 closes it fully.)

No server changes. `directoryStaleMs`/`shouldRefreshDirectory` semantics stay.

---

## Workstream 2 — Push invalidation: `remux/fs/didChange`

Same downstream shape as the preview pipeline (throttled relay → `broadcast` → `remux.subscribe` → store invalidation), but the *source* differs: previews are fed by extension notifications through `handleExtensionNotification` (`wsServer.cjs:58-64`), whereas fs changes are **server-originated** — the relay produces its own events and never participates in the extension-notification path.

### Detection model (three layers)

No single mechanism covers everything. In particular, per-directory watchers on *served* directories cannot see the canonical bug — "repo root or `src/` is on screen, `src/utils/file.ts` changes" — when `src/utils` was never loaded, and `.git/HEAD`/`.git/index` do not change on ordinary unstaged edits. Hence:

1. **Served-directory watchers (instant, listing-level).** Non-recursive `fs.watch` per directory the fs core has served. Catches create/delete/rename and direct-child writes in any directory a client may be rendering. LRU-cap the handle set (~256), drop watchers untouched for ~10 min.
2. **Git metadata watchers (instant, badge-level for index/HEAD ops).** For each known repo root, watch `.git/HEAD` and `.git/index`. Catches commits, stages/unstages, branch switches, rebases — none of which touch worktree files. Any event here also triggers an immediate run of layer 3 for that root. The status baseline is **seeded at repo-root registration** (not lazily at the first poll), so layers 2/3 diff against the state the client actually saw — otherwise changes landing between the first read and the first poll tick are invisible.
3. **Git status poller (bounded-lag, badge-level for deep worktree edits).** While ≥1 websocket client is connected: every ~2.5 s per known repo root, run the same `git status --porcelain=v1 -z` the fs core uses and compare against the previous snapshot (hash of the raw output suffices). On change, diff the entry sets to get the changed relative paths → emit their containing directories as `changedPaths` and the root as `gitDirtyRoots`. **This is the layer that catches nested unstaged edits under never-loaded directories.** Poll work is off the request path; skip a tick if the previous run hasn't finished.

*Honest freshness claim:* propagation is **instant** for changes inside any on-screen (served) directory and for git index/HEAD operations, and **within poll cadence (~2–3 s)** for worktree edits deep under unloaded directories. Not "instant always" — the spec deliberately does not promise that.

*Alternative considered:* one recursive `fs.watch` per repo root. Cheap on macOS (FSEvents) but expensive/fragile on Linux for large trees, and `node_modules`/build churn floods the event stream. Rejected as the primary mechanism; acceptable later as a macOS-only replacement for layer 3 if poll latency ever matters.

### fs-core invalidation + registration API

`directoryCache`/`gitStatusCache` are private to `createFsCore` (`fs.cjs:22-27`), and `createCoreRouter` exposes only `handleRpc` (`coreRouter.cjs:12-20`). Extend both — this is a required part of the workstream, not an implementation detail:

```js
// cli/core/fs.cjs
const fsCore = createFsCore({ rootDir });
fsCore.handleRpc(request)                       // existing
fsCore.subscribe(listener) => unsubscribe       // NEW: emits after each successful fresh
                                                //   read: { type: 'directoryServed',
                                                //           path, repoRoot: string|null }
fsCore.invalidate({ paths = [], underRoots = [] })  // NEW
```

`invalidate` semantics:

- `paths`: delete those exact `directoryCache` keys.
- `underRoots`: for each root, delete **every** `directoryCache` key `k` where `isPathWithin(root, k)` — git annotations are baked into cached listing results, so a dirty repo invalidates *all* cached listings under (and including) its root — **and** delete the root's `gitStatusCache` entry, so the next read recomputes status instead of serving up-to-1s-stale data.
- In-flight reads are not cancelled; they can be at most one event behind, and the relay's trailing broadcast (below) re-covers them.

```js
// cli/core/coreRouter.cjs
return { handleRpc, fs: fsCore };               // expose the core for start.cjs wiring
```

### Relay lifecycle (`cli/fsRelay.cjs`)

```js
const fsWatch = createFsRelay({ log, minIntervalMs, pollIntervalMs });
fsWatch.onDirectoryServed({ path, repoRoot })   // fed via fsCore.subscribe; registers
                                                //   layer-1 watcher + repo root for 2/3
fsWatch.start({ broadcast, fs })                // begins watching; `fs` = fsCore, used
                                                //   for invalidate() before broadcasts
fsWatch.onClientCountChanged(count)             // gates the poller (layer 3): runs only
                                                //   while count > 0; layers 1-2 always on
fsWatch.close()                                 // idempotent: unwatch all, clear timers,
                                                //   stop poller
```

Wiring in `start.cjs`: construct the relay next to the router; `coreRouter.fs.subscribe(fsWatch.onDirectoryServed)`; call `fsWatch.start({ broadcast: remuxWs.broadcast, fs: coreRouter.fs })` after `attachRemuxWebSocketServer` returns; call `fsWatch.close()` in **both** the startup-failure catch path and `shutdown()`. Client-count gating mirrors the existing `notifications?.onClientDisconnected?.(client)` precedent (`wsServer.cjs:86,93`): `attachRemuxWebSocketServer` additionally accepts the relay and reports `clients.size` on open/close/error.

### Event contract

Debounce ~250 ms after the first dirty event, then broadcast at most one notification per second with trailing send (reuse the `previewRelay` throttle shape). **Before** each broadcast, call `fs.invalidate({ paths: changedPaths, underRoots: gitDirtyRoots })` so even non-force client reads that race the notification get fresh data.

```jsonc
{ "method": "remux/fs/didChange",
  "params": { "changedPaths": ["/abs/dir", …],   // dirs whose listings may differ
              "gitDirtyRoots": ["/abs/repo", …] } // repos whose badges may differ
}
```

A worktree file event maps to its containing directory in `changedPaths` **and** its repo root in `gitDirtyRoots`; a `.git` event maps to `gitDirtyRoots` only (after the immediate layer-3 confirm).

**Tests:** `cli/tests/fs-relay.test.js` mirroring `preview-relay.test.js` — throttle + trailing send, watcher registration/LRU eviction, `.git`-event mapping, poller snapshot diffing, client-count gating, `isPathWithin` boundary cases, `invalidate` called before broadcast. Runs under the existing `npm run test:cli` (`node --test`).

### Client: subscription + invalidation rule

Subscribe once (effect in `FilesOverview`, or alongside the preview subscription in `BrowserShell.tsx:104`):

- A loaded record `R` is **dirty** iff `R.path ∈ changedPaths`, **or** `isPathWithin(root, R.path)` for some `root ∈ gitDirtyRoots` (client-side string variant of the shared helper — this includes the repo root's own listing, and is what finally makes rollups propagate to every on-screen ancestor).
- Dirty **and currently renderable** (in the `visibleFileTreeRows` expansion set) → batch force-refresh via `refreshVisibleDirectories`' machinery, debounced ~300 ms, only while `section === 'files'`. Dirty and *not* renderable → set `loadedAt: null` so the next navigate/expand refetches for free through the existing `shouldRefreshDirectory` gate.
- On section activation, flush any accumulated dirt (subsumes Workstream 1 Trigger 2 once this lands — keep Trigger 2 anyway as the fallback for missed events).

---

## Workstream 3 — Icon redesign

**Constraint (OTA-only app):** no new native dependencies — no `react-native-svg`, no `expo-symbols`. Two viable substrates, both already in the tree: **SF Symbols via `@expo/ui/swift-ui` `Image`** (`systemName`, proven in `NativeGlassIconButton.tsx:64`) and **PNG assets via RN `Image`** (the launcher-icon pattern, regenerated via the existing Playwright pipeline).

**Lead: SF Symbols.**

- **Folder:** `folder.fill`, ~22pt, tinted `theme.focusRing` at **full opacity** (the current 0.58-alpha tint is the main source of "jank"; SF's folder shape also kills the tab/body corner mismatch for free). Delete `FolderIcon`/`folderTab`/`folderBody` styles (`FilesOverview.tsx:430-437,683-711`).
- **Files:** family-mapped symbol + tint, dropping the 8px extension caption and accent bar entirely (the glyph + name carry it):

  | Family (extensions) | Symbol | Tint |
  | --- | --- | --- |
  | code — ts, tsx, js, jsx, py, rs, go, rb, swift, c, cpp, java, cjs, mjs | `chevron.left.forwardslash.chevron.right` | `focusRing` |
  | docs — md, mdx, txt, rst | `text.document` (fallback `doc.text`) | `textMuted` |
  | data/config — json, yaml, yml, toml, plist, env, lock | `gearshape` | `warning` |
  | images — png, jpg, jpeg, gif, webp, avif, svg | `photo` | `success` |
  | shell — sh, bash, zsh, command | `terminal` | `text` |
  | archives — zip, tar, gz, tgz | `archivebox` | `textMuted` |
  | fallback / dotfiles / no extension | `doc` | `textMuted` |

- **F9 fix:** derive the *icon* family from a new `iconExtensionForName` that treats leading-dot names as extensionless — do **not** change `fileExtensionForName`, which also drives handler matching (`fileHandlers.ts:7-26`).
- **Perf gate (blocking):** this puts one SwiftUI `Host` per row (~12–15 mounted, recycled by FlatList at `rowHeight` 64). Before committing, scroll a large directory (e.g. `node_modules`) on device and watch for blank-cell flashes / frame drops from native-view churn. Keep the chevron and git badge as RN views regardless — no reason to nativize them. **Gate outcome: FAILED on device** — see the post-implementation revisions section at the end.
- **Fallback if the gate fails: PNG glyph set.** Pre-render the same table (symbol shapes, light/dark pairs, opaque backgrounds per the launcher-icon contract) through the existing Playwright icon-regen pipeline into app assets, rendered with RN `Image`. Zero native views per row; cost is asset weight (~14 glyphs × 2 themes) and a regen step when the table grows.

**Row polish while in there:** current chevron (rotated-border square, `FilesOverview.tsx:639-651`) is acceptable but should get the same full-opacity treatment; git badge stays as-is (it reads well). Optionally tint a folder's glyph toward `warning` when it carries a rolled-up `modified` status — decide after seeing badges + new icons together, not before.

---

## Workstream 4 — Small fixes and accepted limitations

- **F6 (`itemCount`):** derive client-side — when a directory row's children are loaded, `visibleFileTreeRows` already has `children.length`; surface it as `itemCount` on the row instead of the always-null server field. Zero server cost, and the meta line finally earns its keep. Keep the wire field for a future server count.
- **F8 (symlinked dirs):** in `directoryEntry` (`fs.cjs:589-611`), `stat` the link target when `lstat` says symlink and expose `targetKind`; client treats `symlink + targetKind === 'directory'` as navigable. Low effort, real papercut.
- **F7 (repo-boundary):** accept for now; document in the tab. If it grates, the fix is per-*directory-entry* repo-root resolution with the existing `gitRepoRootCache` — bounded cost, but do it only on demand.

---

## Phasing

1. **Phase 1 — freshness + pull-to-refresh (client-only):** Workstream 1 + F6 + F9's icon-extension split. Fixes the daily "stale when I come back" and gives users the manual escape hatch immediately.
2. **Phase 2 — push invalidation:** fs-core API + `cli/fsRelay.cjs` + client subscription (Workstream 2). Git badges then propagate to on-screen ancestors instantly for served-directory and index/HEAD changes, and within poll cadence (~2–3 s) for deep unstaged edits.
3. **Phase 3 — icons:** Workstream 3 behind the perf gate, plus F8.

Phases 1 and 3 are independent; 2 builds on 1's `refreshVisibleDirectories`.

---

## Post-implementation revisions (2026-07-03)

- **SF Symbols per row failed the perf gate.** On device, per-row SwiftUI `Host` views ghosted/overlapped during expand/collapse (FlatList cell recycling detaches/reattaches native hosts asynchronously) and the symbol did not center reliably inside its host frame. Rows must not contain native hosted views. Replaced with **pure RN-drawn glyphs** (`filesIcons.tsx`): a full-opacity two-part folder silhouette and a bordered "page" with a family-tinted accent bar — same family→tint table, no assets, no native views. The PNG glyph set (Playwright pipeline) remains the option if richer shapes are ever wanted. The header's single `NativeGlassIconButton` Host is fine — it is never recycled.
- **`getItemLayout` added.** Rows are fixed 64pt, so the virtualizer now does exact position math instead of async cell measurement — removes layout thrash when expand/collapse shifts rows. One `FlatList` remains the right structure; the overlap was native-host recycling, not a virtualization deficiency.
- **Baseline seeding (Phase 2).** The relay seeds each repo root's porcelain baseline at registration rather than at the first poll tick; otherwise changes landing in the gap are invisible to layers 2/3 (caught by an end-to-end smoke test).
- **Header collapse button (supersedes the sticky folder bar).** Large expanded folders needed a collapse affordance without scrolling up. `stickyHeaderIndices` was rejected (RN has no CSS-style `position: sticky`; native sticky rows pin at viewport y=0 *behind* the absolutely-positioned glass header and need opaque backgrounds), and a first-pass floating bar was removed as unnecessary chrome. Instead the header's right side shows a `chevron.up` glass button whenever the nearest expanded ancestor of the topmost visible row has scrolled off-screen; tapping it collapses that folder and scrolls its row back under the header (`paddingTop === listTopPadding` cancels `getItemLayout`'s padding-blind `scrollToIndex` offset exactly). The right side is always reserved so the centered title doesn't shift when the button appears.
