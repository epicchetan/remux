# Extension Authoring

Status: Current
Last verified: 2026-07-11

A Remux extension is a directory rooted by `remux-extension.json`. It can
contain static WebView assets, an optional newline-delimited stdio JSON-RPC
server, and any application code those two surfaces own. Extensions do not
need to live in the Remux repository.

## Discovery and layout

The default extension root is `extensions/`. Add parent directories for
out-of-tree extensions in `.remux/config.toml`:

```toml
extension_roots = ["extensions", "/home/me/remux-extensions"]
```

Each configured path is a parent whose immediate child directories are
scanned for manifests. Relative paths resolve from the Remux checkout root;
configured roots replace the default, so retain `"extensions"` when bundled
extensions should remain visible. `REMUX_EXTENSION_ROOTS` is the environment
override.

A practical extension starts this small:

```text
example/
├── remux-extension.json
└── viewer/
    └── dist/
        └── index.html
```

Add source/build metadata, icons, or a server only when the extension needs
them. The runtime derives ownership from the manifest root, so external and
in-repository extensions receive the same supervision and top-level resource
weight.

## Manifest versions

Versions `1` and `2` are accepted. Version 1 describes views, entry points, and
an optional server. Version 2 is required only when declaring managed child
workloads under `resources`.

```json
{
  "version": 2,
  "id": "example",
  "name": "Example",
  "display": {
    "title": "Example",
    "icon": "assets/example.png",
    "iconDark": "assets/example-dark.png"
  },
  "views": {
    "main": {
      "route": "/viewers/example",
      "entry": "viewer/dist/index.html",
      "cache": "immutable",
      "build": {
        "command": "npm",
        "args": ["run", "build"],
        "cwd": "."
      },
      "watch": {
        "command": "npm",
        "args": ["run", "watch"],
        "cwd": "."
      }
    }
  },
  "launchers": [
    {
      "id": "open",
      "view": "main",
      "label": "Example",
      "route": {
        "kind": "launch",
        "launch": "open",
        "resourceKind": "example"
      }
    }
  ],
  "fileHandlers": []
}
```

Important rules enforced by the runtime:

- `id`, `version`, and `views.main.entry` are required;
- view routes start with `/` and default to `/viewers/<extension-id>`;
- icon paths must point to raster images, because the app does not render SVG
  extension icons;
- command `cwd` and asset paths resolve from the extension root;
- launchers and file handlers may reference any declared view; and
- development proxy URLs are not supported—Remux serves built static assets.

## Viewers

Viewers are static web applications served from the directory containing each
view's entry HTML. Requests below the view route fall back to that entry, so a
client-side router works without a separate web server.

Use `"cache": "immutable"` when the built viewer is relocatable and all local
assets resolve relative to the entry document or importing module. Remux then
publishes a content-addressed snapshot and advertises its immutable entry URL
in the extension catalog. Vite viewers should pair that manifest field with:

```ts
export default defineConfig({
  base: './',
});
```

Omit `cache` (or use `"cache": "revalidate"`) for compatibility with viewers
that construct root-relative asset URLs. Those views remain compressed and use
ETag revalidation, but their stable route is never marked immutable.

`views.<id>.build` is a finite artifact build. `views.<id>.watch` is a
long-lived development sidecar supervised independently. The app Settings
surface can build, rebuild, start watch, stop watch, and inspect logs. A fresh
checkout may omit `dist/`; declaring a build step tells Remux how to create it.

Use `@remux/viewer-kit` for typed semantic RPC and host IPC. Useful host actions
include opening files or Settings, updating a tab target, reloading the view,
dismissing the native keyboard, and reading viewport/theme signals.

The host sets `data-remux-theme="light"` or `"dark"` and `color-scheme` on the
document element before paint. Keep the dark palette as the safe CSS default
and put light overrides under `:root[data-remux-theme="light"]`. JavaScript
renderers can use `getHostTheme` and `subscribeHostTheme`.

Viewer requests choose a semantic contract rather than a timeout policy:

- `query` for idempotent reads;
- `command` for mutations, with an operation ID when the outcome matters;
- `subscription` for subscribe/unsubscribe operations;
- `job-start` for admitting observable long work; and
- `liveness` only for transport health.

The host and runtime own admission lanes, cancellation, reconnect behavior, and
transport deadlines. Extension code should own domain progress and expose long
work as resources/jobs instead of keeping a multi-minute request open.

## Optional stdio server

Declare a server when the viewer needs native code, filesystem integration, a
long-lived backend, or application state that should outlive the WebView:

```json
{
  "server": {
    "transport": "stdio",
    "build": {
      "command": "cargo",
      "args": ["build", "--release", "--manifest-path", "server/Cargo.toml"],
      "cwd": "."
    },
    "command": "server/target/release/example-server",
    "args": [],
    "cwd": "."
  }
}
```

Only `stdio` is supported. Remux sends one JSON-RPC object per line on stdin
and reads the same framing from stdout; diagnostics belong on stderr. Methods
under `remux/example/*` route to the `example` server. The server should honor
`$/cancelRequest` for cancellable operations when practical.

The supervisor owns build/start/stop/restart, crash backoff, logs, process
groups, and stale-process cleanup. An extension crash is isolated from the
runtime; repeated crashes move only that extension to `failed` until a manual
start.

## Managed child workloads

An extension server that needs a separate model, runtime, projection engine,
or benchmark process can declare it without knowing systemd details:

```json
{
  "version": 2,
  "resources": {
    "workloads": {
      "runtime": {
        "class": "interactive",
        "lifetime": "extension",
        "threads": "auto"
      },
      "rebuild-index": {
        "class": "background",
        "lifetime": "operation",
        "threads": 6
      }
    }
  }
}
```

Classes are `interactive`, `background`, and `research`. Lifetimes are
`operation` (default), `extension`, and `persistent`; they describe intent and
unit identity, while the extension still owns its application protocol and
domain state. `threads` is `"auto"` or a positive logical CPU count.

Remux injects these variables into a supervised server:

```text
REMUX_EXTENSION_ID
REMUX_EXTENSION_ROOT
REMUX_RESOURCE_PROTECTED
REMUX_WORKLOAD_EXEC
```

Rust servers can add a path dependency on
`crates/remux-extension-host` and launch a declared workload with
`remux_extension_host::WorkloadCommand`. Other languages may execute
`REMUX_WORKLOAD_EXEC workload exec ...`; the CLI validates the manifest owner,
class, lifetime, and thread ceiling before entering the child scope. See the
[crate README](../../crates/remux-extension-host/README.md) for the Rust API.
The value is a stable launcher pathname rather than the running executable's
inode identity, so rebuilding the release binary does not strand an already
running extension with an unspawnable `(... deleted)` path.

A workload subdivides its extension's existing allocation. It never gives the
extension additional top-level CPU weight. Background and research launches
fail closed if protected resource placement is unavailable.

## Launchers and file handlers

Launchers create app entry points such as “new terminal” or “new chat.” File
handlers map filename extensions to a view. Both can select a declared view,
override matched light/dark raster icons, and attach route metadata. That
metadata becomes the browser tab target and is also used for notification
target matching.

## Development loop

1. Add the extension's parent directory to `extension_roots` if it is external.
2. Build the initial viewer artifact or declare `views.main.build`.
3. Restart the runtime after adding or removing a manifest.
4. Use Settings to start viewer watch or rebuild/restart the server.
5. Read `remux logs <extension-id> -f` and `remux status` when a build or process
   is unhealthy.
6. Test viewer host behavior against `@remux/viewer-kit`, and test the server as
   an ordinary process before relying on the mobile surface.

Remux trusts installed extensions. Resource scopes prevent accidental
starvation; bearer authentication protects the network surface. Neither is a
zero-trust sandbox for same-user code.
