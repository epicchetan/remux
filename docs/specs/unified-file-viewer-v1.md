Status: Viewer and app migration deployed; Narrate removal awaits client update
Date: 2026-09-06
Owner: primary agent; bounded Sol implementation lanes with primary review
Supersedes target architecture: [html-file-preview-v1.md](html-file-preview-v1.md)
Related: [tab-identity-and-routing.md](tab-identity-and-routing.md), [viewer-kit.md](viewer-kit.md)

# Unified file viewer

## Outcome

The existing Editor extension becomes the user-facing **Viewer**. Keep its
technical `editor` extension ID, route and `(editor, main, file, path)` identity
to avoid a gratuitous resource migration. It remains read-only. Markdown and
HTML open in Preview by default; other text files open in Source. A shared web
toolbar switches modes within the same file tab. Remove Narrate and the native
HTML viewer after their replacements and migration are deployed.

This spec records the implementation agreement. The current native HTML
release remains the deployed implementation until the staged replacement lands.
Do not describe the new architecture or retirement as already implemented.

## Grounding

- `extensions/editor/viewer/src/editor/CodeMirrorViewer.tsx` already sets
  `EditorState.readOnly` and disables editing. Correct user-facing labels that
  still imply editing, including the unsupported-file message.
- Editor uses shared web `ActionBar` / `ActionButton`, with Reload immediately
  before Copy. Its store eagerly requests Git status and base content on every
  read. `markersFromMergeContent` computes differences even when Diff is hidden.
- Host text reads and Git base reads are capped at 1 MiB; base64 reads at 5 MiB.
  The current HTML preview bypasses the text limit using the base64 read. Source
  consequently rejects files that Preview successfully opens.
- Narrate owns `.md`, `.markdown`, `.mdown`. It also serves old Codex narration;
  deleting only its directory leaves playback controls with a missing backend.
- Browser restore and live catalog reconciliation discard missing-extension
  tabs. Migration must run before that filtering.
- Other manifests have no file handlers. Images already appear in attachments,
  transcripts/artifacts and Markdown; there is no generic image, PDF or audio
  file-tab viewer to migrate. Preserve those contextual image views.

## Web architecture and ownership

One trusted web viewer shell owns file state, toolbar, navigation, copy and diff.
It uses viewer-kit host APIs, never React Native UI imports. Mobile embeds this
shell through the ordinary extension host; eventual Remux web uses a browser
host transport for the same shell. Do not build a new web host in this change.

Inside the shell:

- Source: existing read-only CodeMirror component.
- Markdown Preview: migrated sanitized React Markdown renderer, directly in
  the shell DOM. Markdown is data, not an executable script surface.
- HTML Preview: one inner sandboxed iframe containing the generated document.
  Source and Markdown do not need additional iframes. There are no separate
  extension instances or tabs for the modes.

One small controller owns target path, host generation, document revision,
selected mode, content load, source-window state and lazy Git state. Renderers
consume that state rather than owning competing loads. Content is a discriminated
union: `full { revision, text, size }` or
`windowed { version, totalSize, range, text, continuations }`. A windowed file
has no full-content or full-copy field; never concatenate windows to manufacture
one. Line scanning returns a target window, not the reconstructed file prefix.
Separate modules for
loading, mode transitions, Markdown, HTML and Source; no general plugin system
or state-machine dependency. Reuse the proven bounded decoding and generation
fencing from the native HTML loader by moving platform-independent logic.

## Toolbar and mode behavior

Left controls: **Tabs → Reload → Preview toggle → Copy**. Use Lucide `Eye` for
the toggle, orange while Preview is selected, neutral in Source, with
`aria-pressed` and an action label of Show source / Show preview. Keep the glyph
stable. Omit the toggle for unsupported preview formats. Existing Diff and Close
remain on the right. HTML preview has no additional floating controls.
Reuse actual shared components and theme tokens, not lookalike native controls.

| Event | Result |
| --- | --- |
| First ordinary open of Markdown or HTML | Preview. |
| Explicit line-target open, including reused tab | Source; retain and acknowledge the requested line once applied. |
| Reopen same file without line target | Preserve selected mode and loaded revision. |
| Toggle | Same bytes, identity and toolbar; no network read or viewer reload. |
| Select Diff | Source plus lazy Git request; remember ordinary Source state. |
| Return to Preview from Diff | Hide Diff; do not paint diff state into Preview. |
| Reload button | Explicitly reread file, retaining mode; replace revision only on success. It resets report state. |
| Failed reload | Keep prior content and show the failure outside the document. |
| New file or host | Retire old requests/renderers before installing the new document. |
| Source too large for full-document mode | Bounded Source windows, with clear range and copy semantics. |
| Preview unavailable/too complex | Explain why and provide Source; never blank the whole tab. |

Mount renderers lazily. For ordinary toggles within the active tab, retain the
visited renderer so Markdown/Source scroll positions and HTML chart state are
not reset by the toggle. Hidden content is inert for keyboard/accessibility.
CodeMirror must remeasure when revealed. Bound retention to the current file;
do not cache prior revisions or files. A hidden HTML iframe can still execute
JavaScript: hiding is not suspension. Destroy it on tab inactivity/host change,
close, or revision replacement; recreating it may reset report-local state.
Do not promise arbitrary JavaScript pause/resume or persistence across reloads.
Exercise hidden-frame CPU behavior as well as focus/ARIA in acceptance; iframe
sandboxing is not a guarantee of process isolation from a runaway script.

Copy means original source bytes decoded as text in either mode, not rendered
HTML, generated policy markup, or visible prose. Only show Copied after success.
For paged Source, disable full-file Copy with an explanation; native/browser
text selection still supports copying the selected visible text. Never silently
copy only the loaded window under a full-file label.

## HTML isolation: first implementation slice

The iframe uses a scripts-only sandbox, without same-origin, forms, popups,
downloads or top navigation permissions. Preserve the existing self-contained
HTML contract: inline scripts/styles/data and charts, no dependency server or
arbitrary network access. Reuse structural document preparation; keep original
source separate from the prepared document.

An iframe alone does **not** isolate the current native host bridge. Installed
Android WebView code exposes messaging to child frames and discards the native
`isMainFrame` argument. The shared IPC receiver also accepts DOM messages without
checking the sender. Address both before enabling executable HTML in this shell.

Preferred bounded approach to prove in V0: an app-issued per-document capability
held only by the trusted top-frame transport, validated in a bounded envelope
before parsing or dispatching the inner native message;
plus explicit sender validation for incoming viewer messages. Never put the
capability in report HTML, URLs, shared injected objects or child-frame messages.
Prove that document-start injection never installs the secret in child frames
on either platform, including Android fallback behavior. Exercise direct child
`ReactNativeWebView.postMessage` and WebKit message-handler calls, not only
`parent.postMessage`. DOM sender checks cannot substitute for native validation.
Reject legacy/unwrapped messages on the protected viewer. Rotate on document
replacement and reject stale capabilities. If reliable native frame metadata is
needed instead, record the native-library/build consequence before proceeding.
Do not treat a child-supplied origin/frame flag as authentication.

Prove parent CSP / iframe navigation restrictions as well as initial document
CSP. Sandbox does not prohibit every navigation of the iframe itself. Exercise
location changes, meta refresh, data/blob URLs, nested frames and redirects so a
document cannot navigate to a host page or remote page and shed its restrictions.
Use supported browser policies; do not depend on experimental iframe `csp` or
credentialless behavior. Exact source installation and policy follow the V0
browser/native transport proof rather than guessing at portability.

Generated pages receive no generic RPC proxy. Fragments stay inside the report.
Companion-link navigation is outside the current viewer UI scope; the Links
menu was removed at user request. An optional report event must be a narrowly
validated document event, never forwarded to host IPC.

Expose a host capability so updated web assets cannot mount executable HTML on
an older unprotected app. Source/Markdown remain available there with a concise
app-update message for HTML. The future browser host must implement equivalent
sender checks before advertising support. Capability checks are release-order
compatibility, not an extra user approval workflow.

## Source size and performance

Treat transport limits, text rendering, preview rendering and Git diff as
separate budgets. Do not raise the global RPC frame limit or eagerly attach
large Git base strings to every file response.

1. Full-document source and HTML support at least the current **5 MiB** preview
   budget. One validated read supplies Preview, Source and Copy. Use bounded
   base64 reads initially; fix viewer-kit query identity to distinguish format
   and Git options. No duplicate read when toggling.
2. Source above **1 MiB**, or with pathological long lines, uses lightweight
   CodeMirror configuration: virtualized plain text, line numbers and selection,
   with expensive language parsing, merge view and diff markers omitted. The
   final long-line threshold comes from measured fixtures, not byte size alone.
3. Files above **5 MiB** use an explicit paged Source mode. Add a bounded host
   read-window operation; begin with 256 KiB windows and a 512 KiB server cap.
   Bound reads and response expansion even for a single enormous line. Handle
   UTF-8 boundaries and show continuation when a line spans windows. Previous,
   Next and start/end navigation must not concatenate the file into memory.
   Show the loaded range and total size, without pretending it is the full file.
4. Range reads carry a file-version token and byte offsets. Detect changes
   between windows and require refresh instead of silently combining revisions.
   Document the filesystem identity/mtime/size token's limits for in-place writes;
   do not promise transactional snapshots. Empty/binary/deleted/invalid UTF-8
   files have explicit results. Never return a successful truncated document.
5. Line targets in large files resolve through bounded, cancellable scanning,
   with progress/error handling and generation fencing. No persistent whole-file
   index or unbounded main-thread scan. Large-file find/copy/diff must not imply
   whole-file behavior when only a range exists.
6. Git base/diff is lazy and separately capped. Ordinary small Source can retain
   current change markers after lazy metadata resolves; Preview and large Source
   must not wait for Git or compute a diff. Explain unavailable large-file Diff.
7. Preview has its own complexity budget. Do not force a multi-megabyte Markdown
   AST/DOM or pathological Mermaid diagram into the UI merely because the bytes
   fit. Measure representative documents; contain per-block failures and offer
   Source when the document exceeds the supported preview budget.

V1 settles exact range API/cancellation and measured thresholds before V2
implements against them. Paged Source is a separate bounded slice but is required
for completion of this spec; do not call a 1-to-5 MiB cap increase the entire fix.

## Markdown migration and Narrate deletion

Move the reading components and their tests into Editor, then delete the old
workspace. Preserve sanitized GFM, tables, task lists, footnotes, alerts, KaTeX,
Mermaid, bounded Shiki highlighting, duplicate-aware heading anchors, fragments,
relative file links, local images, error placeholders and light/dark styles.
Strip narration models, bindings, word painting, follow/seek and audio CSS.
Do not keep an `@remux/narrate` import or a hidden Narrate server dependency.

Full retirement includes `extensions/narrate`, Codex narration UI/client/model
bindings, `packages/narration-client`, narration-only `crates/remux-tts` and R&D
tools, workspace/dependency/build/test entries, runtime narration special cases,
and obsolete active product documentation. Mark still-useful research/spec
records historical rather than deleting documents just to eliminate a keyword.
Git history supplies recovery of removed implementation and tooling.
Retain generic media infrastructure used by other features. Inventory generated
local models/caches separately; source retirement does not authorize broad
deletion of unrelated machine data or artifacts.

Editor declares exact Markdown/HTML file handlers plus its existing wildcard.
Before both restore and live catalog filtering, migrate Narrate Markdown file
tabs to Editor. Preserve active selection and tab identity where possible, path,
timestamps and pending navigation; regenerate handler, URL, revision and icons.
If an Editor tab already exists for the same resource, deduplicate deterministically
and remap selection/navigation to the survivor (prefer the active tab). Persist
the result. The migration is idempotent and remains after Narrate code is gone.

## Delivery and acceptance

| Slice | Work and exit evidence |
| --- | --- |
| V0 | Primary-led architecture proof, Sol implementation: iframe/native bridge boundary, forged/stale messages and navigation escapes; record supported host capability and release order. |
| V1 | Agree shared file controller and bounded read-window contract; fixtures for UTF-8, changes, large lines, cancellation, line focus and copy semantics. |
| V2a | Sol lane: Editor shell, toggle, lazy Source/Git and full-document source against V1. |
| V2c | Separate bounded Sol slice: paged Source UI and cancellable line targeting against V1. |
| V2b | Parallel Sol lane on separate files: migrate Markdown renderers/dependencies/tests, removing narration bindings. |
| V3 | Integrate HTML iframe, retain current report interactions, mode state and original-source copy. Remove app-owned HTML surface after replacement is usable. |
| V4a | Ship app migration for restored/live Narrate tabs, with active selection and dedup tests, while the Narrate catalog entry still exists. Establish the supported client is running this update. |
| V4b | Then remove Narrate from the catalog and remove narration product consumers in reviewed commits: Codex playback; server/client; TTS/tools/workspace/runtime references. Verify no dangling controls, imports or startup builds. |
| V5 | Build and publish coordinated host/viewer/app changes; verify actual deployed versions and return to this Agent thread without interrupting its provider. |

Use at most two independent implementation lanes, with named file ownership and
primary review at each handoff. Freeze edits for integration checks. Commit and
push each reviewed green slice to main; do not collect a week of uncommitted work.
Only deploy coherent slices. Stage app migration/capability before removing the
old catalog entry; older clients may otherwise lose Narrate tabs. V4a and V4b
are distinct deployments, not just code ordering. If an older app must remain
supported, provide catalog compatibility before V4b; do not silently close its
tabs. Avoid restarting
the provider daemon. Record each commit, checks, deployment and remaining work here.

Required evidence includes real Ledger HTML (~2.2 MB), exact/over 5 MiB source,
a larger paged file and a multi-megabyte single line; Source/Preview/Source without
reread; scroll/selection/chart retention on normal toggles; line-focus reuse;
failed refresh; host retarget; iframe denial tests; Markdown feature parity;
phone/desktop layout and light/dark themes; app restore and live catalog migration
with duplicate tabs; and complete narration removal with contextual images intact.
Browser tests prove web behavior, not native frame isolation; record native
evidence and any limitations explicitly. The UI itself must run in a browser test
host without React Native. Building the full future Remux web app is out of scope.

## References

- [Lucide Eye](https://lucide.dev/icons/eye)
- [MDN iframe sandbox and lifecycle](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [Android native bridge frame exposure](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)


## Implementation record

- V0/V1 started 2026-09-06. Sol owns the protected native transport and bounded
  host Source windows in independent lanes; primary owns iframe policy proof.
- Browser proof: blob-backed scripts-only iframe, parent `frame-src blob:` and
  report CSP preserve inline execution and deny parent DOM access, remote/host/
  data self-navigation, dynamic meta refresh, nested frames and blob navigation
  network escapes in Chromium. Test: `extensions/editor/tests/iframe-boundary.mjs`.
  This is browser evidence, not native-device proof. WebKit tooling downloaded
  but this host lacks its system libraries; no WebKit result is claimed yet.
- V1 contract frozen: `remux/fs/readFileWindow` accepts `path`, optional `offset`
  or one-based `targetLine` (mutually exclusive), `limit` (4..524288, default
  262144), and `expectedVersion`. Success returns UTF-8 `content`, `path`,
  `version`, `totalSizeBytes`, half-open `range:{startByte,endByte}`,
  `continuation:{startsMidLine,endsMidLine}`, `previousOffset`, `nextOffset`,
  `eof`, and optional `targetLine:{lineNumber,byteOffset}`. Error -32012 carries
  `data.kind` of changed/binary/invalidUtf8/targetLineNotFound/read; malformed
  params use -32602. Scanning is cancellable chunked async work, not a detached
  task or an accumulating prefix. Consumer code must use this exact contract.
- V1 host windows reviewed and implemented. Filesystem unit/integration and
  router tests passed; primary added a nonblocking regular-file check regression
  so opening a FIFO cannot hang before validation. Final window tests: 6 passed
  (`/tmp/remux-html-preview/source-window-review.log`). Host not deployed yet.
- V0 protected Editor transport reviewed by primary and a second Sol review.
  App-issued native UUID capability is held in a top-frame closure and pinned to
  the trusted document URL. Native dispatch rejects raw/stale child messages;
  DOM IPC rejects child senders. Delayed protected and legacy host handshake,
  canceled queued reads, stale tokens, payload bounds and iframe navigation
  browser tests passed, plus app typecheck and viewer-host contract. Evidence:
  `/tmp/remux-html-preview/viewer-v0-final-check.log`;
  `app/scripts/test-viewer-transport-handshake.mjs`. No native-device proof is
  claimed. The runtime capability enables the supported path; there is no new
  manual device-approval gate. Native app update not published yet.
- V4a migration implemented for restored and live `narrate/main` Markdown tabs.
  It preserves active identity and pending line navigation, deduplicates using
  existing browser resource identity, and waits for the Editor `document-viewer`
  handler. Tests cover active selection, pending navigation, repeat application,
  old catalogs, distinct paths and distinct views; app typecheck passed.
  Publication and installed-client evidence remain pending.
- V2/V3 integrated: one web shell owns Preview/Source and original-source Copy;
  app-owned HTML surfaces removed. Markdown renderers moved without narration,
  HTML moved to a blob-backed sandboxed child frame, and Git metadata is lazy.
  Full Source supports 5 MiB, lightweight Source starts above 1 MiB or 20,000
  characters in a line, and larger files use bounded windows with continuation
  labels. Markdown preview is capped at 512,000 characters/10,000 lines;
  Mermaid at 20,000 characters/200 edges, with readable Source fallbacks.
- Controller, strict base64/UTF-8, HTML preparation and browser iframe tests pass.
  Root/linked-viewer/app typechecks and Editor production build pass. Actual
  Editor browser integration verifies toolbar order/pressed state, one initial
  read, no toggle reread, original Copy, HTML state retention, same-byte reload
  reset, failed-refresh retention, line focus and paged Copy disabled. Primary
  corrected the first-host-generation duplicate-read race during review.
- V0/V1/V2/V3 and V4a are pushed on main through `3ecb23d` (migration
  `0f89c10`, transport `0d179a8`, windows `532115f`). Host deployed by guardian
  worker restart; live window RPC and immutable Editor bundle/CSP/styles verified.
  Codex daemon PID 848265 retained its original start time. Host proof:
  `/tmp/remux-html-preview/unified-host-proof.json`.
- V4b retirement prepared in an isolated scratch checkout and reviewed against
  current main. Patch `/tmp/remux-html-preview/narrate-retirement.patch`, SHA256
  `3cee4054d71dffabe394ed7c7435c4f505a3260a52ba64f39ac458a3ab62f305`;
  inventory `/tmp/remux-html-preview/narrate-retirement-files.txt`. Removes
  24,103 lines across 162 files, including the extension, old Codex playback,
  client package, TTS crate, R&D, runtime references and active documentation.
  Scratch Codex build and 226 retained desktop/mobile tests passed; runtime
  library tests 148 passed, with a later baseline Agent-manifest integration
  assertion failing. Locks must be regenerated and integrated checks rerun when
  applied. Do not apply until the V4a client migration deployment is established.
- Final browser parity checks passed: GFM tables/tasks/footnotes, KaTeX,
  Mermaid, decoded local image, local links, sanitization, phone 390px and
  desktop light/dark no-body-overflow. Exact 5 MiB single-line Source rendered
  with bounded DOM text (371 ms in this desktop Chromium fixture; not a phone
  performance guarantee). Run via `npm --workspace @remux/editor test`.
- iOS preview update published 2026-09-06 18:04 UTC from `f2c4836`:
  **Unified Viewer: Markdown and HTML preview/source**. Group
  `46636c69-2482-482d-ba20-3b54375db5c0`; update
  `01a077e4-37a8-7d2c-bebe-c86686e80d7d`; existing native runtime
  `a100fc36093abfc62b43b2d93750f92f9bf78430`. Expo-selected launch asset verified
  byte-for-byte against the new local export, 1,811,960 bytes, SHA256
  `724387563739a43bbb412391d9a5dab8d320a198bb87fffa8c12e3fc6767764e`.
  Source map confirms tab migration/protected bridge/native HTML override
  removal. Proof `/tmp/remux-html-preview/expo-unified-proof.json`.
- User can install through Settings → Updates → Check for updates → Restart
  to update. Publication is verified; installation on the user's client is not
  yet established. Narrate remains in the live catalog until that migration
  update is running, per V4a/V4b ordering. No native-device isolation result is
  claimed by the browser tests.
- Final Markdown review preserves sanitized explicit heading IDs and resolves
  sanitizer-prefixed footnote targets. Actual footnote navigation regression
  passes with the integrated browser suite; Editor production build refreshed.
- V4b validated again against committed `f2c4836` with an isolated clean npm
  install. Root/linked/app typechecks, Agent style-parity/UI-boundary 8/8 and
  app migration checks passed. No retirement integration blockers found.
  Supplementary regenerated-lock patch:
  `/tmp/remux-html-preview/narrate-retirement-locks.patch`, SHA256
  `e0d0a82435445a0b97ccfb9d1760c8e61fc2893fbcef9b2bd59882b4e153b3b5`.
  Both patches apply cleanly to main; apply both after client-update confirmation,
  run the integrated checks, commit/push and redeploy the retired catalog.

- Follow-up UI decision: remove the floating HTML Links button and its menu.
  Preview keeps the shared bottom toolbar; iframe isolation and interactions
  retain their existing behavior. This is a web viewer asset update.
