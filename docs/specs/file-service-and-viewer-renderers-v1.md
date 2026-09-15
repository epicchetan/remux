Status: Active Spec
Last verified: 2026-09-15
Canonical code (target): `crates/remux/src/fs/`, `crates/remux/src/http/`,
`crates/remux/src/rpc/router.rs`, `packages/viewer-kit/src/{fs,host,directHost}.ts`,
`extensions/editor/viewer/src/`, `app/src/files/`,
`app/src/surfaces/viewer/ExtensionWebView.tsx`
Related: [unified-file-viewer-v1.md](unified-file-viewer-v1.md),
[files-tab.md](files-tab.md), [tab-identity-and-routing.md](tab-identity-and-routing.md),
[../guides/extension-authoring.md](../guides/extension-authoring.md)

# File service and Viewer renderers

## Outcome

Remux gets a real file foundation. The runtime serves and accepts file bytes
over HTTP and exposes filesystem mutations over JSON-RPC. The Viewer keeps its
extension id, route and `(editor, main, file, path)` tab identity but becomes a
renderer host: it stats a file first, then hands it to a lazily loaded renderer
for source, Markdown, HTML, images, PDF, audio/video or a binary fallback. The
native Files tab gains upload, download/share, new folder, rename and delete.
Every capability is reachable from viewer-kit so a browser-hosted explorer can
be built later on the same contracts.

No new extension type is introduced. A format that the browser can render from
bytes is a renderer inside the Viewer. A format that needs a process is its own
extension: it declares a `server`, optionally the version 3 `gateway`, and claims
its extensions through `fileHandlers`, which already outscore the Viewer's
wildcard. iOS is the only supported app platform for this pass.

## Grounding

- `remux/fs/*` has five read-only methods (`crates/remux/src/fs/core.rs:27-31`),
  whitelisted in `rpc/router.rs` `is_core_method`. Text reads cap at 1 MiB,
  base64 at 5 MiB, inside an 8 MiB WebSocket frame. Paths resolve absolute or
  relative to the runtime cwd (`resolve_requested_path`), follow symlinks, and
  are not confined to a root; the trust model is same-user.
- No path-addressed HTTP file route exists. `/remux/media/sha256/{hash}` is
  content-addressed and only Codex writes into it. Responses marked with a
  response extension skip the compression layer (`http/mod.rs`
  `NotForExtensionGateway`); the raw route needs the same treatment so
  `Content-Length` and ranges survive.
- The auth middleware accepts a bearer header or the cookie the app hands off
  at WebView load, so viewer subresources and the browser direct host are
  already authenticated for same-origin HTTP.
- The sandboxed HTML preview iframe runs under `connect-src 'none'` and
  `img-src data: blob:` (`packages/viewer-kit/src/htmlPreview.ts`), so report
  code cannot reach a new raw route.
- `EditorFileController` owns path, host generation, revision, mode and
  windows with sound generation fencing. It always base64-reads, throws on
  binary, hardcodes `previewKind` by extension, and `EditorBody` hardcodes three
  renderers. The Vite build is one chunk.
- `matchingFileHandlers` scores exact extension 2, wildcard 1, ties by catalog
  order. The Viewer declares exact Markdown/HTML handlers plus `*`.
- The app has `expo-document-picker`, `expo-image-picker` and
  `expo-file-system` 56 (`File.downloadFileAsync` with headers,
  `File.upload`/`createUploadTask`, streams) and React Native `Share`. No new
  native dependency is available; the app is OTA-only.
- `host/attachments/pick` reads whole files into base64 data URLs for the Agent
  composer. That path is unchanged here.
- `remux/fs/didChange` is produced by the relay from watchers and git polling
  (`fs/relay.rs`), with `start(broadcast, invalidate)`.

## Runtime file service

All additions live in the core runtime; no extension is involved.

### `remux/fs/stat`

Query. Params `{path}` with the existing path resolution. Result:

```jsonc
{ "path": "/abs/file", "name": "file", "kind": "file" | "directory" | "symlink" | "other",
  "targetKind": "file" | "directory" | null,      // symlinks only
  "sizeBytes": 123, "modifiedAtMs": 0, "version": "…",  // version as readFileWindow
  "mimeType": "image/png" | null, "isBinary": true | null }
```

`version` reuses the window token (identity, mtime, size); it is not a content
hash and does not promise transactional snapshots. `mimeType` comes from an
extended extension table (add pdf, svg, audio, video, fonts, archives, common
office and data types), with magic-byte sniffing of the first 8 KiB for PNG,
JPEG, GIF, WebP, PDF, and ZIP when the extension is unknown. `isBinary` reuses
`is_likely_binary` on that prefix and is null for non-files. Error `-32011`
with `data.kind` `notFound` or `io`.

### `GET|HEAD /remux/fs/raw?path=<absolute>`

Streams file bytes. `path` is URL-encoded and must be absolute; relative or
empty paths are 400. Symlinks are followed as in `readFile`; the opened
descriptor is verified as a regular file before reading so FIFOs and devices
are rejected. Headers: `Content-Type` from stat rules, `Content-Length`,
`Accept-Ranges: bytes`, `ETag` equal to the version token, `Last-Modified`,
`Cache-Control: private, no-cache`. `If-None-Match` answers 304; `Range`
answers 206 with `Content-Range` and 416 when unsatisfiable. Auth is the
existing bearer header or cookie only; the query token form is not used for
this route.

The route must never let a workspace file run as the runtime origin. Every
response carries `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: sandbox`. Inline disposition is allowed only for
`image/*`, `audio/*`, `video/*`, `font/*` and `application/pdf`; everything
else, including HTML, SVG documents opened top-level, XML and text, is served
as `Content-Disposition: attachment` with an RFC 5987 filename. `?download=1`
forces attachment for any type. Verify on device whether WKWebView renders a
PDF under the sandbox header; if it does not, exempt `application/pdf` from that
one header and record it. Responses carry a `RawFileResponse` extension so the
compression layer skips them. Concurrency is bounded by a semaphore of 16
streams with the gateway's 60 s body idle timeout; there is no size cap on GET.

### `PUT /remux/fs/raw?path=<absolute>`

Streams an upload into the parent directory as `.remux-upload-<random>`, fsyncs,
then renames atomically over the target. `Content-Length` is required and is
capped by a new config value `max_upload_bytes` (default 512 MiB); exceeding it
is 413 before any write. Default semantics are create-only: an existing target
is 409 unless the request carries `If-Match: <version>` matching the current
stat, or `?overwrite=1`. The parent must exist. Any failure removes the temp
file. Success returns the stat result as JSON. PUT concurrency is bounded at 4.

### Mutation RPCs

Commands, added to `is_core_method`, all returning the stat of the affected
path and erroring with `-32013` and `data.kind` in
`exists | notFound | notEmpty | versionChanged | crossDevice | tooLarge | io`
(`crossDevice` applies to rename only):

- `remux/fs/writeFile {path, content, expectedVersion?, create?}`: UTF-8 text
  up to 5 MiB, temp file plus atomic rename, preserves an existing file's
  mode. `expectedVersion` mismatch is `versionChanged`; `create: true` fails on
  an existing file.
- `remux/fs/createDirectory {path}`: single level, `exists` if present.
- `remux/fs/rename {from, to, overwrite?}`: `rename(2)` only; a cross-device
  move is `crossDevice` in this pass.
- `remux/fs/delete {path, recursive?}`: permanent removal. A file or empty
  directory is unlinked; a non-empty directory is `notEmpty` unless
  `recursive: true`. There is no trash: this is a remotely managed Linux box
  and the runtime behaves like `rm`. Preventing accidental deletion is the
  UI's job (see Files tab mutations). Symlinks are removed, never followed.

Every mutation and completed upload calls a new relay hook
`on_paths_mutated(paths)` that invalidates and broadcasts the containing
directories (both `from` and `to` for rename) immediately, so clients do not
wait for watcher latency. Watchers remain the general mechanism.

## Viewer as renderer host

### Descriptor-first controller

`retarget(path)` first runs `stat`. The result becomes a `FileDescriptor` on
controller state and selects a renderer before any bytes move. The document
union grows from `full | windowed` to:

```ts
| { kind: 'full' | 'windowed', … }                       // unchanged text shapes
| { kind: 'media', media: 'image' | 'pdf' | 'audio' | 'video', url, mimeType, sizeBytes, version }
| { kind: 'binary', mimeType, sizeBytes, version }
```

Media and binary documents never read bytes over RPC. `url` is the relative
raw route with `&v=<version>` appended so a reload after a change fetches
fresh bytes. Reload re-stats and replaces the document only when the version
changed or the load previously failed. Generation and host-generation fencing,
windows, line focus and Git behavior stay exactly as implemented.

### Renderer contract

`renderers/registry.ts` exports an ordered list of definitions:

```ts
type RendererDefinition = {
  id: 'source' | 'markdown' | 'html' | 'image' | 'pdf' | 'media' | 'binary';
  match(descriptor: FileDescriptor): number;         // 0 = no; higher wins
  modes: Array<'preview' | 'source'>;                // default first
  load(): Promise<{ Component: RendererComponent }>; // dynamic import()
  capabilities(descriptor): { copy: boolean; diff: boolean; download: boolean };
};
```

Resolution takes the highest score; a non-binary file falls back to `source`
and anything else to `binary`. `previewKind` and `defaultMode` are deleted in
favor of `modes`. Each renderer is its own chunk through dynamic import; the
shell chunk holds only the controller, toolbar and registry. Confirm the
immutable bundle snapshot publishes chunk files and that the browser test host
loads them. The toolbar is capability-driven: the Preview toggle appears only
for two-mode renderers, Copy and Diff only where the renderer allows, and a
Download button appears for every file and calls the host download action,
disabled with a short update message when the host lacks the capability.
Windowed text keeps its range controls.

### Renderers

- **source, markdown, html**: existing components moved behind the contract
  with no behavior change beyond lazy loading.
- **image**: `<img>` from the raw URL, fit-to-width by default, tap toggles
  1:1, pinch and drag through pointer events with `touch-action: none`, no
  library. Natural dimensions appear in the status text after load. SVG is
  only ever an `<img>` source, never inline markup. Load failure shows a
  retry card; nothing blanks the tab.
- **pdf**: an `<iframe>` on the raw URL; WKWebView renders PDFs natively.
  Android is unsupported and shows the binary fallback.
- **media**: `<audio controls>` or `<video controls playsinline>` on the raw
  URL, relying on range support for seeking.
- **binary**: name, type, size, version and the Download button.

The manifest keeps its exact Markdown/HTML handlers and the wildcard. Do not add
exact media handlers: a specialised extension claiming `png` or `pdf` must beat
the Viewer, and an exact Viewer handler would only tie with it.

## Host and app

### Download

New host command `host/file/download {path}` in `ExtensionWebView` and the
direct host, exposed by viewer-kit as `downloadHostFile`. The app fetches
`<runtimeOrigin>/remux/fs/raw?path=…&download=1` with `File.downloadFileAsync`
and the bearer header into `Paths.cache/remux-downloads/<name>`, then presents
`Share.share({ url })`, which offers Save to Files. The downloads directory is
cleared of entries older than one day at app start. The direct host opens the
same URL in a new tab and lets the browser save it with cookie auth. The host
capability list gains `fileDownload`.

### Upload

The Files tab gains Upload files and Upload photos actions. Files use
`DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true, type: '*/*' })`;
photos use the image picker without base64. Each asset is sent with
`new File(uri).upload(url, { uploadType: BINARY_CONTENT, headers })` including
`If-None-Match: *`, with per-file progress in the header area and a summary
line on completion. A 409 prompts Replace or Skip and retries with
`overwrite=1`. Nothing is read into JavaScript memory.

### Viewer-kit additions

`fs.ts` gains `statFile`, `writeFile`, `createDirectory`, `renameEntry`,
`deleteEntry`, and `rawFileUrl(path, version?)`. `host.ts` gains
`downloadHostFile`. The app's `filesApi.ts` uses the same method names.

## Files tab mutations

Row long-press opens the existing native sheet pattern with Download,
Rename, Delete and Copy path; directories offer New folder and Upload as well.
The header menu offers New folder, Upload files and Upload photos for the
current directory. Rename and New folder use a native text prompt with the
current name preselected. Delete is never one tap: the sheet action opens a
destructive confirmation that names the entry and, for a non-empty directory,
states that everything inside is removed and requires typing the entry name
before the button enables. The confirmation is the only place `recursive` is
set. Each
action awaits the RPC, then forces a refresh of the affected directories
through `refreshVisibleDirectories`; the relay broadcast also lands. Errors
surface in the existing summary line, never as silent no-ops. An open tab on a
renamed or deleted file is left alone; its next reload reports not found.

## Out of scope

Editing text in the Viewer (the write RPC enables it later). Android PDF.
Cross-device moves. A web explorer for the browser host, which will use the
viewer-kit fs API defined here. Changes to the Agent composer attachment path.
Directory download as an archive. Root confinement or per-client permissions.

## Delivery

| Slice | Owner and scope | Exit evidence |
| --- | --- | --- |
| S1 runtime file service | Astra lane, Rust only: stat, raw GET/HEAD/PUT, mutations, relay hook, router whitelist, config value. | Unit tests for ranges, ETag, disposition rules, sandbox header, symlink and FIFO rejection, create-only and If-Match, atomic temp cleanup, non-recursive delete refusal, relay broadcast; `npm run test:runtime` green; release build. |
| S2 viewer-kit and Viewer | Descriptor-first controller, registry, lazy chunks, image/pdf/media/binary renderers, capability toolbar, kit wrappers. | Controller tests for stat-first fencing and reload-by-version; browser integration with PNG, SVG, PDF, MP4 and binary fixtures; existing Editor suite green; chunked immutable bundle served. |
| S3 host download | ExtensionWebView and direct host command, capability flag, cache cleanup. | App typecheck; viewer-host contract test; device check that Share offers Save to Files. |
| S4 Files tab | Upload, new folder, rename, delete, share, conflict prompts. | Store action tests; device run of each action with relay-driven refresh. |
| S5 deploy | Runtime rebuild and worker restart from outside any Remux session; `viewers:build`; Expo OTA publish. | Live raw route and stat verified through the running host; served Viewer hash changed; published update id recorded here. |

S1 lands first. S2 and S3 run in parallel on disjoint files. S4 follows S3.
Commit and push each reviewed green slice to main.

## Acceptance

- Open a 20 MB PNG, a 30 MB PDF and an MP4 from Files: each renders in one
  Viewer tab, reopening reuses it, reload after the file changes shows new
  bytes, and Source, Markdown and HTML behave exactly as before.
- Navigating a WebView directly to a raw `.html` or `.svg` path downloads or
  renders in an opaque origin; the sandboxed report iframe cannot fetch the raw
  route.
- Upload two files and a photo into a folder from the phone, rename one,
  delete one, delete a non-empty folder through the typed confirmation, create
  a folder; the listing and git badges update without pull-to-refresh.
- Download a file from the Viewer and from a Files row to the iOS Files app.
- Upload above `max_upload_bytes` fails before writing; a conflicting upload
  prompts and resolves correctly; a killed upload leaves no temp file.

## Implementation record

- 2026-09-15: spec drafted from repository inspection (c66b2a3).
- 2026-09-15: S1 landed (0554080). `remux/fs/stat`, `writeFile`,
  `createDirectory`, `rename`, `delete`, `GET|HEAD|PUT /remux/fs/raw`,
  `max_upload_bytes`, relay hook. Two runtime tests
  (`chaos::manifest_gateway_receives_generation_socket_and_requires_stdio_readiness`,
  `extension_gateway::authenticated_http_and_websocket_gateway_is_generation_fenced`)
  fail inside the Claude sandbox on the pristine spec commit too, so they are
  environmental; the full suite passed outside the sandbox (271 tests).
- 2026-09-15: S3 landed (0047307). `host/file/download` in ExtensionWebView
  and the direct host; `downloadAndShareFile` streams to
  `Paths.cache/remux-downloads` and opens the Share sheet; 24 h cache cleanup at
  app start. Decision: the app injects `fileDownload: true` only into the
  Viewer extension WebView (the same scope as the protected transport), so
  third-party views see the capability as absent until that is widened
  deliberately.
- 2026-09-15: S2 landed (53cc6e9). viewer-kit `statFile`, `writeFile`,
  `createDirectory`, `renameEntry`, `deleteEntry`, `rawFileUrl`; stat-first
  controller; renderer registry with lazy chunks (Source 666 kB, Markdown
  443 kB, HTML 4.7 kB, Image 3 kB, PDF 0.4 kB, Media 0.4 kB, Binary 1.2 kB;
  shell 211 kB); capability toolbar with Download. The static CSP meta in
  `index.html` became a runtime-appended meta so `frame-src` can name the
  host's exact `/remux/fs/raw` path (CSP cannot combine `'self'` with a
  path). Editor suite, typecheck and build green.
- 2026-09-15: S4 landed (969d41e). Files tab long-press sheet and directory
  menu: Download, Rename, Copy path, Delete, New folder, Upload files, Upload
  photos. Uploads stream from the picker URI through
  `File.createUploadTask` with `httpMethod: 'PUT'` and
  `UploadType.BINARY_CONTENT`; conflicts prompt Replace or Skip. Delete
  escalates in place to the typed-name confirmation on `notEmpty`; that is
  the only call site passing `recursive`. `RemuxRpcError` now carries the
  JSON-RPC `code` and `data` so `data.kind` is readable. App typecheck and
  all `test:*` scripts green except the Vite handshake script, which cannot
  run in the sandbox. Not yet verified on a device: sheet detent heights,
  keyboard growth, and `autoFocus` inside `RNHostView`.
- 2026-09-15: S5 staged, not yet live. `npm run build:runtime` produced
  `target/release/remux` (the `~/.local/bin/remux` symlink target the
  service runs); the Viewer bundle rebuilt with the renderer chunks. Pending
  outside any Remux session: Settings → Restart runtime so the supervisor
  respawns the worker from the new binary, then an OTA publish for the app
  slices (S3, S4). Live `remux/fs/stat` and `/remux/fs/raw` verification and
  the published update id go here once that is done. `npm run viewers:build`
  fails at the terminal extension's state-worker step because the optional
  `@esbuild/linux-x64` package is missing from `node_modules`; the terminal
  extension is unchanged by this work, so its existing dist stands.
- 2026-09-15: main pushed (11a74b1). OTA published to the `preview` branch.
  The first publish landed on runtime fingerprint `11b00fff…` because
  `@expo/fingerprint` hashes the `scripts` block of `app/package.json`, which
  gained test scripts since the installed build; every earlier update sits on
  `a100fc36…`. Republished with the July `scripts` block swapped in
  temporarily (`git show 27ab393:app/package.json`, `eas fingerprint:compare`
  confirmed the match), giving iOS update
  `01a0a707-a109-7d32-8744-239d24b58df2` (group
  `ce69a8bc-e54b-48a6-beef-c3926ae5130d`) on `a100fc36…`. The next native
  build should add a `fingerprint.config.js` with
  `sourceSkips: PackageJsonScriptsAll` so script edits stop moving the
  fingerprint.
