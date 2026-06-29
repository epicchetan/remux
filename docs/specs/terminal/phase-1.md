# Terminal Extension Phase 1

Status: Active Spec
Last verified: 2026-06-28
Canonical code: Planned under `extensions/terminal/`, `packages/extension-api/`, and terminal-specific docs.

## Purpose

Phase 1 adds a mobile-first terminal extension to Remux. The goal is a reliable remote development terminal that works well from a phone against the trusted Remux runtime on a remote server.

This phase should produce a usable shell with correct PTY behavior, predictable mobile keyboard controls, and enough lifecycle handling that the implementation does not get stuck on reconnects, keyboard resizing, output bursts, or hidden tabs. It should not attempt first-class tmux, Vim, Claude Code, or Codex-specific modes yet, but it must leave clear extension points for those later modes.

## Reference Context

- Remux extensions are static viewers with optional stdio JSON-RPC servers. The runtime already routes extension-prefixed methods and broadcasts extension notifications to mounted viewers.
- The Codex extension is the closest backend pattern: Rust stdio server, React/Vite viewer, extension-prefixed RPC, and server-originated notifications.
- Editor and Markdown are the closest bottom-bar pattern: simple `@remux/extension-ui` icon buttons, status text, and host actions.
- The older `epicchetan/remux-web` prototype was cloned for design reference at `.remux/references/remux-web`, commit `7d5356d`. It is intentionally under `.remux/`, which is already gitignored.

Useful prototype ideas to carry forward:

- xterm with `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-unicode11`, and optional WebGL.
- Explicit mobile key row: `Esc`, `Tab`, `Shift`, `Ctrl`, `Alt`, arrows, Enter, `^C`, paste, keyboard toggle.
- Shift+Enter sends CSI-u `\x1b[13;2u` for terminal apps that distinguish it, including Claude-like apps.
- Resize debounce during keyboard animation to avoid resize storms.
- Output backpressure and batching; terminal output can overwhelm the client bridge.
- Touch scrolling needs special treatment for normal scrollback vs alternate-screen apps.

## Non-Goals

- No first-class tmux UI in phase 1.
- No terminal tabs inside the terminal extension. Remux browser tabs are enough for this phase.
- No persistent terminal transcript/search/history beyond an in-memory replay buffer.
- No remote auth, multi-user isolation, or permissioning. The current Remux trusted-runtime security model still applies.
- No custom terminal emulator. xterm owns terminal emulation.
- No direct native PTY ownership in the Expo mobile shell.

## Product Requirements

Phase 1 is successful when a user can:

- Launch Terminal from the Remux launcher.
- Get an interactive login shell in the runtime cwd by default.
- Use common terminal programs including shell prompts, `git`, `npm`, `vim`, `less`, `top`/`htop`, and Codex/Claude-style CLIs.
- Send core mobile shortcuts without relying on a hardware keyboard.
- Toggle or dismiss the software keyboard without losing terminal state.
- Rotate, resize, show/hide the keyboard, and keep the PTY size in sync with the visible terminal grid.
- Switch away from the tab and back without losing the live session while the app remains connected.
- Recover gracefully from viewer reload by attaching to the same session and replaying recent output.
- Close the Remux tab and have the host close the associated PTY session.
- See a clear exited/disconnected state and start a new shell.

## Architecture

The terminal should be a normal Remux extension:

```text
extensions/terminal/viewer
  React + Vite + xterm + Remux action strip
    |
Extension WebView IPC
    |
Remux websocket JSON-RPC
    |
extensions/terminal/server
  Rust stdio JSON-RPC server
    |
portable-pty native PTY
    |
shell / terminal application
```

The mobile shell should continue to own WebViews, keyboard metrics, safe areas, and tab lifecycle. The terminal extension server should own PTY processes, session state, output replay buffers, and PTY resize/write/kill operations.

## Rust Vs Node PTY

Use Rust for phase 1 unless implementation discovers a hard blocker.

Reasons:

- Remux already has the Rust stdio-server pattern through Codex.
- `portable-pty` gives a cross-platform native PTY API with `openpty`, `spawn_command`, `try_clone_reader`, `take_writer`, `resize`, `wait`, and `kill`.
- Terminal throughput bottlenecks are more likely to be WebView bridge, JSON serialization, xterm write latency, and resize churn than Node vs Rust PTY process IO.
- Rust avoids adding a Node native module build path to the extension server. `node-pty` is proven and fast enough, but it introduces native addon packaging and ABI concerns.

Risks:

- `portable-pty` adds more Rust dependencies than Codex currently has. Development mode can use `cargo run`, but release packaging should ship a built server binary with the extension.
- The current Remux runtime treats extension server crashes as runtime-fatal. Terminal PTY failures must be ordinary session failures, not server panics.

Fallback:

- If `portable-pty` proves unsuitable, use a small Node server with `node-pty` behind the same JSON-RPC contract. The viewer and Remux integration should not change.

Current dependency snapshot:

- `portable-pty`: latest crates.io version is `0.9.0` as of 2026-06-28.
- `@xterm/xterm`: latest npm version is `6.0.0` as of 2026-06-28.
- `@xterm/addon-fit`: latest npm version is `0.11.0` as of 2026-06-28.
- `@xterm/addon-web-links`: latest npm version is `0.12.0` as of 2026-06-28.
- `@xterm/addon-webgl`: latest npm version is `0.19.0` as of 2026-06-28.
- `@xterm/addon-unicode11`: latest npm version is `0.9.0` as of 2026-06-28.
- `node-pty`: latest npm version is `1.1.0` as of 2026-06-28, fallback only.

Primary references:

- `portable-pty`: https://docs.rs/portable-pty/latest/portable_pty/
- `xterm.js`: https://github.com/xtermjs/xterm.js
- `node-pty`: https://github.com/microsoft/node-pty

## Viewer Design

Use `@xterm/xterm` as the terminal emulator.

Initial addons:

- `@xterm/addon-fit`: fit rows/cols to the visible container.
- `@xterm/addon-web-links`: clickable URLs when feasible.
- `@xterm/addon-unicode11`: better width rules for terminal text.
- `@xterm/addon-webgl`: optional renderer, loaded defensively and disposed on context loss.

Defer:

- `@xterm/addon-search`: useful after basic scrollback/replay is stable.
- `@xterm/addon-serialize`: useful if we later persist terminal screen state across server restarts; not required for phase 1.

Viewer layout:

- Full-height terminal body.
- Bottom action strip anchored below the terminal, using Remux extension bottom-bar styling.
- No marketing/landing state inside the viewer. Launching Terminal should open a terminal.
- Use dark terminal colors that fit Remux but avoid making the whole extension a one-off visual system.

Keyboard and focus:

- xterm focus remains the default text input target.
- Buttons that inject keys must preserve focus and avoid causing keyboard flicker.
- The software keyboard toggle should use the xterm helper textarea where necessary, but prefer host APIs for dismissing keyboard when available.
- The terminal should call host viewport metrics APIs for keyboard-aware sizing rather than relying only on `visualViewport`.

## Phase 1 Action Strip

Keep it minimal and functional:

- `Esc`
- `Tab`
- `Shift` sticky modifier
- `Ctrl` sticky modifier
- `Alt` sticky modifier
- Up, Down, Left, Right
- Enter
- `^C`
- Paste
- Keyboard toggle/dismiss
- Tabs/overview button

Paste is best-effort in phase 1 using browser clipboard APIs. Mobile clipboard reliability and a possible host clipboard bridge are deferred until the rest of the terminal interaction model is stable.

Encoding rules:

- `Esc`: `\x1b`
- `Tab`: `\t`
- Enter: `\r`
- `^C`: `\x03`
- Arrow keys: `\x1b[A`, `\x1b[B`, `\x1b[D`, `\x1b[C`
- Ctrl + letter: byte `1..26`
- Alt + printable key: prefix `\x1b`
- Shift/Ctrl/Alt arrows: CSI modifier form, matching the old prototype approach.
- Shift+Enter from hardware/software keyboard interception: `\x1b[13;2u`
- Shift+Tab: `\x1b[Z`

The action strip should not try to be a full keyboard. Add more keys only when a phase 1 validation task proves they are required.

`Shift`, `Ctrl`, and `Alt` should be sticky because mobile users often need to tap a modifier and then tap/type a second key. They reset after a successful encoded input and also auto-clear after 3 seconds of inactivity. Sticky `Shift` only affects terminal special keys such as Enter, Tab, and arrows; normal text capitalization remains owned by the keyboard/input method.

## Host API Work

Promote the viewport helpers that Codex already uses privately into `@remux/extension-api`:

- `getHostViewportMetrics()`
- `subscribeHostViewportMetrics(callback)`

The mobile bridge already supports:

- `host/viewport/get`
- `host/viewport/changed`
- `host/keyboard/dismiss`

Terminal should depend on these shared helpers instead of duplicating Codex IPC code.

## JSON-RPC Contract

Use extension-prefixed methods under `remux/terminal/*`.

Requests:

```ts
type TerminalSessionStartParams = {
  sessionId?: string | null;
  cwd?: string | null;
  cols: number;
  rows: number;
  shell?: string | null;
};

type TerminalSessionStartResponse = {
  sessionId: string;
  pid: number | null;
  cwd: string | null;
  shell: string;
  cols: number;
  rows: number;
};

type TerminalSessionAttachParams = {
  sessionId: string;
  cols: number;
  rows: number;
  replaySeq?: number | null;
};

type TerminalSessionAttachResponse = {
  sessionId: string;
  status: 'running' | 'exited';
  exitCode?: number | null;
  exitSignal?: string | null;
  nextSeq: number;
  replay: TerminalOutputFrame[];
  replayTruncated?: boolean;
};

type TerminalSessionWriteParams = {
  sessionId: string;
  dataBase64: string;
};

type TerminalSessionResizeParams = {
  sessionId: string;
  cols: number;
  rows: number;
  pixelWidth?: number;
  pixelHeight?: number;
};

type TerminalSessionKillParams = {
  sessionId: string;
};
```

Additional requests:

- `remux/terminal/session/list`
- `remux/terminal/session/start`
- `remux/terminal/session/attach`
- `remux/terminal/session/write`
- `remux/terminal/session/resize`
- `remux/terminal/session/kill`

Notifications:

```ts
type TerminalOutputFrame = {
  seq: number;
  dataBase64: string;
};
```

- `remux/terminal/session/output`
- `remux/terminal/session/exited`
- `remux/terminal/session/updated` is reserved for later metadata updates; phase 1 can run with `output` and `exited`.

All terminal byte payloads should be base64 in JSON-RPC. xterm can write `Uint8Array`, and the PTY reader should preserve bytes rather than lossy UTF-8 strings.

## Session Model

Phase 1 should support one PTY session per terminal viewer/tab. A terminal tab owns its session; closing the tab closes the PTY.

Session identity:

- The Terminal launcher uses `resourceKind: 'terminalSession'`.
- The host assigns a default `resourceId` for `terminalSession` tabs so tab-close cleanup has a session id before the viewer completes its first request.
- The viewer prefers `resourceId`; if it is missing, it falls back to `route.tabId`.
- `session/start` accepts optional `sessionId` so the viewer can create or recreate the PTY under the host-owned id.
- Viewer reload attaches to `resourceId`.

Lifecycle:

- A session starts on first viewer mount if no existing session id is present.
- A session remains alive when the viewer reloads or the tab is hidden.
- Closing a terminal Remux browser tab should make the host call `remux/terminal/session/kill` for that tab's `resourceId` before removing the tab, or fire-and-forget the kill if the host is already tearing down.
- The viewer should also expose a minimal restart/new-shell path for exited sessions, but it does not need a prominent kill button if host tab close is the primary close behavior.
- Server shutdown kills all child PTY sessions.
- Child exit marks the session exited and broadcasts exit state.

Replay:

- Keep an in-memory ring buffer per session, bounded by bytes and frames.
- Store monotonically increasing `seq` values.
- Attach may request replay after `replaySeq`.
- If requested replay is no longer available, return available tail replay and mark that the replay was truncated.
- Viewer-side replay must not forward xterm-generated terminal query responses back to the PTY. Replayed device-attribute or OSC color queries are historical output, not fresh input from the current terminal instance.

Suggested initial bounds:

- 2-5 MB per session.
- 5,000-10,000 frames per session.
- Batch output frames to roughly animation-frame cadence or a small millisecond window.

## Server Thread Model

The Rust server can stay simple:

- Main thread reads stdin JSON-RPC requests.
- One stdout writer thread serializes responses and notifications.
- Session manager owns a map of session id to session state.
- Each PTY session has:
  - child handle
  - master writer
  - reader thread forwarding output bytes to the session manager/output channel
  - wait thread or polling path to report exit
  - last known PTY size
  - replay buffer

Avoid blocking the stdin request loop on PTY reads, writes, or child waits.

PTY spawn defaults:

- Shell: `$SHELL` if valid, else `/bin/sh`.
- Cwd: runtime cwd from environment/process by default, with optional explicit cwd later.
- Env:
  - preserve base environment
  - set `TERM=xterm-256color`
  - set `COLORTERM=truecolor`
  - set a Remux marker such as `REMUX_TERMINAL=1`

## Backpressure

There are two pressure points:

- PTY reader to extension server stdout.
- Viewer receiving notifications and xterm writes.

Phase 1 should include at least coarse protection:

- Batch PTY output before sending JSON-RPC notifications.
- Cap per-notification payload size.
- Cap total queued bytes per session.
- If the viewer is behind, drop from replay tail only after preserving session liveness; never block the PTY reader indefinitely.
- In the viewer, queue output and call `term.write(data, callback)`; if pending writes exceed a threshold, stop draining until callbacks catch up.

True server-client pause/resume can be deferred, but the protocol should not preclude adding:

- `remux/terminal/session/flow/pause`
- `remux/terminal/session/flow/resume`

## Resize Behavior

Resize must be precise enough for full-screen terminal apps but calm enough for mobile keyboard animation.

Rules:

- Fit xterm to the terminal container.
- Send resize only when cols or rows change.
- Debounce resizes during keyboard animation.
- Use host viewport metrics to calculate available height when the software keyboard is visible.
- Send initial size before or with session start.
- Server calls `MasterPty::resize` with rows, cols, and best-effort pixel dimensions.

Validation should include keyboard show/hide and device rotation.

## Touch And Scroll

Phase 1 should support basic touch scrolling:

- Normal buffer: touch scroll moves xterm scrollback.
- Alternate buffer: touch scroll sends arrow key input to the running app.
- Tap should not automatically open the keyboard if the explicit keyboard button is the chosen UX.

Momentum scrolling is nice to keep from the prototype, but it can be simplified if it delays the first pass.

## Error States

Viewer should handle:

- Server unavailable.
- Start failure.
- Attach failure.
- Session exited.
- Viewer disconnected/reconnecting.
- Replay truncated.
- PTY resize/write errors.

User-visible copy should be terse. Terminal output may include small status lines for reconnect and exit, but avoid noisy banners on normal launch.

## Build And Manifest

Add:

- `extensions/terminal/remux-extension.json`
- `extensions/terminal/package.json`
- `extensions/terminal/viewer/`
- `extensions/terminal/server/Cargo.toml`
- `extensions/terminal/server/src/`

Remux does not build extensions. It serves the prebuilt viewer HTML declared by the manifest and starts the server command declared by the manifest. Extension authors may keep whatever build scripts, dev commands, Cargo files, generated artifacts, or packaging helpers they want inside the extension, but the runtime contract is only:

- `views.main.entry` points at an already built HTML entry.
- `server.command` and `server.args` start a server that already exists in the extension or can be run by the developer's chosen dev tooling.

Development manifest shape:

```json
{
  "version": 1,
  "id": "terminal",
  "name": "Terminal",
  "display": {
    "title": "Terminal",
    "icon": "assets/terminal.svg"
  },
  "server": {
    "transport": "stdio",
    "command": "cargo",
    "args": [
      "run",
      "--manifest-path",
      "server/Cargo.toml",
      "--target-dir",
      "/tmp/remux-terminal-server-target",
      "--quiet",
      "--"
    ],
    "cwd": "."
  },
  "views": {
    "main": {
      "route": "/viewers/terminal",
      "entry": "viewer/dist/index.html"
    }
  },
  "launchers": [
    {
      "id": "new-terminal",
      "view": "main",
      "label": "Terminal",
      "icon": "assets/terminal.svg",
      "route": {
        "kind": "launch",
        "launch": "new-terminal",
        "resourceKind": "terminalSession"
      }
    }
  ],
  "fileHandlers": []
}
```

For local terminal development, `cargo run --manifest-path server/Cargo.toml --target-dir /tmp/remux-terminal-server-target --quiet --` is acceptable. Cargo's `--offline` flag means "do not access the network while resolving/building dependencies"; it is useful only when the dependency set is already present locally. It is not part of the Remux extension contract.

Release packaging should point the manifest at a shipped executable instead of `cargo run`, for example:

```json
{
  "server": {
    "transport": "stdio",
    "command": "./server/bin/remux-terminal-server",
    "args": [],
    "cwd": "."
  }
}
```

## Testing Plan

Server unit tests:

- JSON-RPC parameter validation.
- Session create/attach/list/kill state transitions.
- Replay buffer sequencing and truncation.
- Resize validation clamps invalid sizes.
- Output batching does not exceed configured limits.

Server integration tests:

- Spawn `/bin/sh` or configured shell.
- Write `printf` and assert bytes return.
- Resize and query `stty size` where available.
- Kill session and observe exit notification.

Viewer tests:

- Terminal component starts or attaches with measured cols/rows.
- Key strip sends expected byte sequences.
- Ctrl/Alt sticky modifiers reset after use and auto-clear after 3 seconds.
- Host viewport metrics change triggers fit and resize.
- Output queue drains in order.
- Replay that contains terminal queries does not emit `session/write` input back to the PTY.

Manual mobile validation:

- iPhone/Android keyboard show/hide.
- Rotation.
- Paste from clipboard.
- `vim`, `less`, `top`, `npm test`, `git status`.
- Claude/Codex-like CLI Shift+Enter behavior.
- App tab switch and viewer reload reattach.
- Closing a terminal tab kills the PTY session.

## Implementation Sequence

1. Scaffold `extensions/terminal` with manifest, Vite viewer, Rust stdio server, and launcher.
2. Promote host viewport helpers into `@remux/extension-api`.
3. Render xterm with fit, keyboard-aware sizing, and a placeholder local transcript.
4. Implement Rust JSON-RPC session manager without PTY, then add `portable-pty` spawn/write/resize/kill.
5. Wire viewer start/attach/write/resize/output/exited flows.
6. Add replay buffer and viewer reload attach.
7. Add mobile action strip and key encoding tests.
8. Add output batching/backpressure guardrails.
9. Add touch scroll behavior and manual mobile validation.

This ordering keeps the hard unknowns early: Rust PTY spawn, byte transport, mobile resize, and xterm focus behavior.

## Phase 1 Exit Criteria

- Terminal extension appears as a launcher.
- Shell starts through Rust PTY server.
- xterm renders output and sends typed input.
- Bottom action strip covers minimal mobile controls.
- PTY resizes correctly with keyboard and rotation.
- Viewer reload reattaches to the same live session with replay.
- Session exit and kill are handled without crashing the Remux runtime.
- Typecheck/build/test commands for touched packages pass.
- A short terminal architecture doc or this spec is updated with any deviations discovered during implementation.

## Open Questions

- Should launch always create a fresh shell, or should the launcher reopen the most recent live terminal if one exists?
- Is host-side terminal cleanup implemented as a terminal-specific `session/kill` call from browser tab close, or as a generic extension tab-close lifecycle hook that terminal handles?
- Should the 3 second `Ctrl`/`Alt` auto-clear timer reset on every pointer/key interaction with the terminal, or only interactions with the action strip?

## Deferred Later Work

- First-class tmux control-mode integration.
- Terminal-managed tabs/windows/panes.
- Saved terminal sessions across runtime restart.
- Search and serialized screen restore.
- Configurable shells, cwd picker, and env profiles.
- Theme/font settings.
- Sixel/image protocol support.
- Deeper terminal app detection and adaptive action rows for Vim/tmux/Claude/Codex.
