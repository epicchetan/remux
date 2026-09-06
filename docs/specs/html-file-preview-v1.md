Status: Active Spec — implementation pending
Last verified: 2026-09-06
Canonical code: `app/src/surfaces/viewer/`, `app/src/browser/`,
`app/src/files/`, `extensions/editor/viewer/src/editor/`,
`packages/viewer-kit/src/{fs,links}.ts`, `crates/remux/src/fs/core.rs`
Related: [tab-identity-and-routing.md](tab-identity-and-routing.md),
[agent-audit-remediation-pass-1.md](agent-audit-remediation-pass-1.md)

# HTML file preview v1

## Outcome and scope

Opening an HTML file from Agent or Files shows an interactive document in the
existing file tab. Preview and Source are modes of that tab. Returning to Agent
preserves its conversation and transcript position. HTML executes in an isolated
browser surface with no Remux command bridge.

The concrete acceptance case is Ledger's
`/home/ubuntu/ledger/research/runs/move-discovery-v2/review.html`: approximately
2.2 MB, embedded data, inline JavaScript and CSS, SVG charts, example selectors,
and a reveal slider. A static preview or a 1 MiB limit does not satisfy this task.
Companion links include CSV, JSON and a Markdown findings memo. The report's
financial conclusions are outside this implementation; its interactions are the
fixture for the viewer behavior.

This is a bounded platform feature alongside the Agent cleanup plan. It does not
reopen the transcript virtualizer, change provider output, or add Agent journal
records. This spec owns the feature's implementation and acceptance record.

## Grounding and architectural decision

Current file opens follow `openHostHref` / `host/file/open` to
`ViewerSurface.openFile`, which selects a registered file handler and calls
`openResource`. The Editor's wildcard handler displays CodeMirror source.
Markdown files have a separate Narrate handler; Markdown in Agent is rendered by
Agent's measured block layout. Raw HTML in that layout is text, by design.

The host already exposes `remux/fs/readFile` with a base64 mode capped at 5 MiB.
Ordinary text reads are capped at 1 MiB. Editor currently requests Git metadata
and base content on load. Preview can use the existing binary read without Git;
it needs neither a new file-serving endpoint nor a higher ordinary editor limit.

**The report must not execute inside the privileged `ExtensionWebView`.** Its
native `onMessage` handler accepts Remux messages without authenticating the
calling frame. Installed React Native WebView 13.16.1 uses a wildcard Android
web-message listener or `addJavascriptInterface`; the latter exposes the bridge
to child frames. An opaque-origin iframe alone does not remove that native
capability. The shared viewer IPC receiver also accepts DOM messages without a
sender-frame check. We will avoid exposing these channels to report code rather
than retrofit the entire extension bridge for this feature.

The implementation is an app-owned `HtmlFilePreview` surface using a **separate
React Native WebView with messaging disabled**. It occupies the same existing
Editor file tab. Source uses the existing Editor extension. A small HTML-file
mode controller in the app chooses the surface and owns its controls. There is
no new extension, tab kind, resource kind, or general embedded-app framework.

Browser sandbox and native bridge boundaries are different mechanisms; see
[MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox)
and [Android native bridge risks](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges).
Native isolation must be demonstrated before exposing interactive Preview.

## User behavior

| Situation | Required behavior |
| --- | --- |
| First open of `.html` / `.htm`, case insensitive | Preview in the existing Editor file tab. |
| Open HTML with an explicit source-line target | Source and the requested line, including reuse of an existing Preview tab. |
| Reopen the same file without a focus target | Reuse the tab and preserve its current mode and loaded document. |
| Switch Preview / Source | Same resource identity; no new tab or change to Agent state. |
| Navigate the tab to another file | Retire the old load/document; choose the new file's default or explicit Source target. |
| Open a non-HTML file | Existing handler and behavior. Narrate continues to own Markdown files. |
| Refresh in Preview | Re-read the selected file, then replace the document after successful validation. This is file refresh, not viewer-bundle reload. |
| File changes while viewing | Keep the loaded document until explicit refresh; do not reset a chart mid-review. |
| Source larger than the existing text limit | Explain the Source size limit and offer return to Preview; do not truncate or silently raise CodeMirror's limit. |
| Missing, unreadable, invalid UTF-8 or oversized document | Readable error with retry and working tab controls; no blank screen or endless spinner. |
| Preview process terminates or renderer fails | Show recoverable failure outside the document; explicit reload resets report state. Do not loop automatic reloads. |

The host owns a compact Preview / Source mode strip for HTML files. Preview
has native refresh, companion Links, tab navigation and close controls. Source
keeps the existing Editor action bar and copy/diff behavior; only the mode strip
remains above it. Do not duplicate Source actions natively or add an Editor
embedding protocol to unify the bars. Preserve source-line intent until the Source viewer acknowledges it;
do not clear it merely because Preview mounted.

Keep report scrolling within the available document surface. App safe areas and
controls stay outside it. Do not impose Remux fonts/colors on authored content.
Do not initialize CodeMirror or load Git metadata before Preview can be used.

## Ownership and lifecycle

Use the existing identity `(editor, main, file, path)` and `openResource` reuse.
Handler provenance and Preview / Source mode must not enter the resource key.
The app's surface choice applies only to Editor HTML-file resources; it is not
a replacement for manifest handler selection for other extensions.

One small per-tab controller owns path, selected mode, load generation and
document state: `idle`, `loading`, `ready`, `refreshing`, or `error`. Prefer a
reducer/plain module with explicit transitions over several effects competing
to load the same file. Do not introduce a state-machine library.

Fence every asynchronous completion by path and generation. A late read for A
cannot overwrite B, a closed tab, or a newer refresh. A failed refresh retains
the previous ready document with a visible error; it does not mislabel old
content as newly loaded. Reads after a host connection change use the current
connection and cannot install a previous host's response.

Cache at most the current document per tab, plus an in-flight replacement.
Release temporary decoded/base64 copies after installation where possible; do
not retain version history. Closing or retargeting releases the renderer and
document. Switching to Source unmounts the report renderer; switching back may
recreate its in-document state from the same bytes without a filesystem re-read.
Persist file/tab identity using existing persistence, not report DOM/JavaScript
state. App restoration defaults to Preview unless a new source-line intent wins.

Unmount the report renderer on tab inactivity and recreate it from retained
bytes when selected; report-local state may reset. Use the existing app/tab
active signal rather than building a new suspension controller. Verify normal
app background/foreground behavior without introducing custom pause machinery.
No fake extension-ready/heartbeat messages or new Agent lifecycle state are
needed for this bridge-free surface. Keep tab-overview capture working through
the existing containing view.

## Loading and content contract

Use the authenticated app connection to query
`remux/fs/readFile({path, format: 'base64'})`, with no Git options. Accept at most
5 MiB decoded bytes, matching the host's current binary limit; validate the
returned size and UTF-8 before rendering. Treat malformed base64, truncated
responses and binary data as errors. Do not send credentials or an authenticated
server URL into the report WebView.
Install decoded content as an HTML source document, not a multi-megabyte data
URL. Keep parsing/decoding compatible with the React Native JavaScript runtime;
do not assume browser DOM APIs are available in the app shell.

Keep request identities for Preview bytes distinct from Source text/Git reads
if the implementation shares a semantic query client. The existing viewer-kit
helper uses `file:${path}` irrespective of format; do not accidentally replace
one mode's in-flight query with the other. Keep any helper adjustment focused
on the caller/contract actually used.

The host presently checks metadata size before an unbounded `fs::read`. Add a
bounded read of at most the applicable limit plus one byte and check actual
length before encoding, so file growth during read cannot defeat the advertised
cap or overflow the 8 MiB RPC response budget. Keep existing text/binary caps
and response shape. No arbitrary caller-supplied size limit. A file being
rewritten in place is not a transactional snapshot: a subsequent explicit
refresh is the recovery; do not add watchers or a snapshot store here.

V1 supports self-contained HTML: inline scripts/styles, embedded data, SVG,
canvas and embedded images/fonts. It does not fetch sibling assets, remote
scripts, remote data, or run a development server. No npm/build pipeline is
started to open a report. Show a concise app-owned note that external assets
are unavailable; do not claim success implies every document dependency loaded.

## Execution and navigation boundary

Construct an isolated HTML source document with a restrictive content policy
installed before any authored content. Use `parse5` (already installed transitively
at 7.3.0) as an explicit app dependency: parse the document without executing it,
insert the policy as the first child of the normalized head, remove authored
base elements, collect anchor targets, and serialize. P0 must prove its Metro/
Hermes compatibility and preserve inline script/style text and report behavior
for full-document, headless and malformed-input fixtures. Do not invent a custom
HTML parser or silently fall back to raw content if preparation fails.
Inline JavaScript and inline styles are
allowed; dynamic evaluation is not required. Default-deny network requests,
including fetch, XHR, WebSocket, external scripts/styles, remote images, forms,
nested frames, objects and workers (`worker-src 'none'`). Omit `unsafe-eval`.
Permit only the embedded image/font/media
forms explicitly needed by v1. An authored policy cannot relax the host policy.
Parse/construct the wrapper structurally; do not use regex to sanitize HTML.

The preview WebView has no Remux `onMessage` dispatcher, injected IPC/diagnostic
scripts, auth headers, host-origin base URL, or file/universal-file URL access.
Disable automatic windows and downloads.
Use a synthetic, non-Remux document origin and verify the platform's storage
behavior: the report cannot read Remux cookies/storage or make credential-bearing
requests. Omitting headers alone does not establish that property; the content
policy and navigation restrictions also apply. A separate nonpersistent store
is optional defense where supported, not a reason to fork the native library. Do not
clear shared cookies or otherwise disturb existing authenticated Agent tabs
while establishing the preview's isolation.
Do not attach an `onMessage` handler for convenience later; that would change
this feature's security boundary. The report must not receive RPC responses,
host events, connection state, clipboard access or file contents other than
the selected document. Never feed raw report markup to `ExtensionWebView` or
its DOM, even during loading/error fallback.

Native navigation policy blocks document redirects and network navigation;
network egress is also blocked by the document content policy. Preserve
same-document fragment navigation and JavaScript `location.hash` updates used
by this report. Cover `location`, meta refresh, popups, forms and nested frames
in validation; a navigation callback alone is not the network policy.

Companion files are exposed through an app-owned **Links** control populated
from anchors in the loaded document. Resolve relative paths against the file's
directory with the shared path/link rules, including `../` in this report.
Deduplicate and bound the list (first 100 supported targets, with a visible
limit indication). Ignore authored `<base>` overrides. Fragment-only anchors
stay in the report; unsupported schemes do not become host actions.

Selecting a file in this trusted control calls the existing file-open routing;
selecting an HTTP(S) link uses the existing explicit external-link behavior.
It does not prefetch target contents or return them to report scripts. Inline
cross-document navigation is blocked in v1; explain that linked files are under
Links. This avoids inventing a privileged report-to-host message channel.
Automatic sibling JS/CSS/image loading and inline host-link interception are
deferred; they are not required for the Ledger chart interactions.

## Implementation slices and review cadence

Primary owns integration, review, the checkpoint below, commits/pushes, builds
and deployment. Sol subagents implement bounded slices. Start with P0; then
P1 and P2 may run concurrently with disjoint ownership and a frozen interface.
Do not let multiple agents edit the same host surface. Agents freeze files at
handoff; primary runs integrated checks against that frozen tree.

| Slice | Scope and owner boundary | Exit evidence |
| --- | --- | --- |
| P0 — isolated renderer proof | One Sol: minimal bridge-free native surface, wrapper/policy and hostile document fixture. Primary reviews current native-library behavior and surface contract. | Inline chart/slider works; native bridge attempts and network/navigation escape fail on supported native platforms. Record device/simulator availability honestly. No interactive feature publication until isolation passes. |
| P1 — file loading | One Sol: bounded host read, focused Rust tests, app read/decode helper and pure load controller. Does not edit `ViewerSurface`. | 2.2 MB case, exact/over-limit, invalid data, failed refresh and late-response cases pass. |
| P2 — file-tab integration | One Sol after P0 contract: mode routing, trusted controls/Links, source-line delivery, error/reload and existing Source surface integration. | Existing resource reuse, source behavior, supported link resolution and native surface lifecycle pass. |
| P3 — integration and publication | Primary reviews final diff and evidence; delegate a bounded regression check if useful. | Actual report works, negative isolation checks pass, relevant existing app/editor tests pass, builds published and acceptance status recorded. |

Commit and push reviewed green slices on `main`; do not accumulate the whole
feature uncommitted. Keep incomplete interactive Preview unreachable until P0
and integration gates pass. A failed isolation proof means revise this design
before expanding implementation, not silently ship static or unsafe HTML.

Use Remux workload scopes for builds and sustained tests. Run focused checks
once per changed slice; broaden only for shared-code changes or failures. Add
runnable test scripts for new coverage rather than leaving unwired fixtures.
Do not copy the 2.2 MB private research dataset into the repo: commit a synthetic
interactive fixture, generate size-boundary fixtures, and use the real file for
read-only acceptance.

This feature requires an **app update** because the native app shell owns the
new surface; refreshing Agent alone cannot install it. Reuse the installed
WebView library; no native-library fork is planned. Verify whether the current
Expo runtime can receive the change via its normal update channel and record
what was actually published. The bounded Rust read fix requires a host rebuild
and coordinated worker restart. Deploy reviewed assets in batches; do not
restart the Codex daemon or interrupt active Agent turns for this feature.
Keep implementation-complete, automated-validation and physical-device
acceptance statuses separate.

## Acceptance matrix

| Area | Required evidence |
| --- | --- |
| Actual report | Example selection, reveal slider, minute/ten-second switch, morning charts and hash changes work at desktop-sized and phone-sized dimensions. |
| File routing | Agent link and Files open Preview; repeated open reuses tab; `.HTM` recognized; line-target open selects Source; Markdown still routes to Narrate. |
| Sizes | Below/equal/above 5 MiB, malformed/invalid text, file growth past cap, encoded response remains below the transport limit; Preview works above 1 MiB while Source reports its existing limit. |
| Load lifecycle | A-to-B race, close during read, refresh failure retains prior bytes, explicit refresh updates charts, reconnect/stale response, process loss recovery. |
| Tabs/UI | Return to Agent preserves position and running turn; safe areas, scrolling, Source switching, close/reopen and overview capture remain usable. Inactive report behavior is verified. |
| Links | This report's sibling CSV/JSON and `../../` Markdown targets resolve correctly through trusted controls; fragments remain local; no source file auto-read on listing links. |
| Isolation | Attempt direct RN/WebKit bridge calls, forged Remux RPC/notifications, parent messages, cookie/storage/auth access, HTTP/WS/image beacons, forms, external scripts, redirects, popups, nested frames and file URLs. Verify zero privileged host actions and zero prohibited requests. |
| Platform proof | Browser tests validate content behavior, not native bridge isolation. Run native tests on iOS and Android for each platform enabled for rollout; unsupported/unverified platforms keep interactive Preview unavailable with an honest fallback. |

## Deferred

Inline HTML execution in chat; Markdown renderer changes; arbitrary websites or
multi-file apps; sibling dependency serving; downloads/export/sharing; editing
HTML in Preview; persistent report UI state; live file watching; generic plugin
or artifact management; changing every extension's host bridge; broad Editor
refactoring. No new agent/server protocol or journal migration is required.

## Implementation checkpoint

- 2026-09-06: spec drafted from repository and installed WebView inspection.
  Sol read-only review confirmed the bridge, read-size, relative-link and tab
  identity constraints. Interactive content is assigned to a bridge-free native
  surface rather than the initially considered iframe inside Editor.
- P0, P1, P2 and P3: pending. No feature code, builds, restart or device acceptance
  is implied by this document. Update this section after each reviewed slice
  with commit, tests, deployment and remaining limitations.
