# Terminal Extension Phase 3: Local Tmux Awareness

Status: Active Spec
Last verified: 2026-06-28
Canonical code: Planned under `extensions/terminal/server`, `extensions/terminal/viewer`, and terminal-specific tests.

## Purpose

Phase 3 makes the terminal extension tmux-aware without turning Remux into a custom tmux client. The default Terminal viewer remains a normal native terminal. When the user manually enters a local tmux client, Remux should notice and add a small mobile-friendly window strip.

The goal is to help a mobile user operate the tmux client they are currently inside without memorizing prefix shortcuts. Remote tmux sessions reached through `ssh` are not in scope for this phase.

## Verified Feasibility

Local checks on 2026-06-28 showed this is practical with tmux CLI introspection:

- Host tmux version: `tmux 3.4`.
- `tmux list-sessions`, `list-windows`, `list-panes`, and `list-clients` expose enough structured state for a mobile UI.
- Existing local tmux state showed one detached session with two windows and panes running Remux dev/watch processes:
  - session `$0`, name `0`, detached, two windows.
  - window `@0`, pane `%0`, `pane_tty=/dev/pts/1`, command `npm`, cwd `/home/ubuntu/remux`.
  - window `@1`, pane `%1`, `pane_tty=/dev/pts/4`, command `npm`, cwd `/home/ubuntu/remux`.
- A throwaway attached tmux client proved the detection path:
  - `tmux list-clients` reported the outer client TTY, for example `client_tty=/dev/pts/0`.
  - `tmux list-panes` reported separate pane TTYs, for example `pane_tty=/dev/pts/2`.
  - Therefore Remux can identify "this terminal viewer is inside local tmux" by matching the viewer PTY slave TTY to `client_tty`.
- `portable-pty 0.9.0` exposes `MasterPty::tty_name()` on Unix, so the terminal server can record the viewer PTY TTY at session start.

The useful `epicchetan/remux-cli` reference was cloned to `.remux/references/remux-cli` at commit `9938147`. Relevant ideas:

- `src/shared_session.rs`: PTY lifecycle, replay, and multi-client sizing.
- `src/local/mod.rs`: terminal mode tracking using `alacritty_terminal`.
- `src/local/input.rs`: key, mouse, and scroll parsing.

For this phase, tmux state should come from tmux itself. Terminal output/state tracking can support later app-aware modes, but it should not be the primary tmux detector.

## Product Goals

Phase 3 is successful when a user can:

- Open a normal Remux Terminal and use it as before.
- Type `tmux`, `tmux attach`, or similar local tmux commands manually.
- Have Remux detect that the current terminal is now inside a local tmux client.
- See current tmux windows as a compact mobile tab strip.
- Switch windows without remembering tmux prefix shortcuts.
- Page tmux scrollback up/down without sending arrow-key input into the foreground program.
- Create a new tmux window from the tmux action menu.
- Close the current tmux window from the tmux action menu.
- Detach the current terminal from tmux from the tmux action menu.
- Continue using the normal terminal key row while tmux-aware UI is visible.

## Non-Goals

- No remote tmux support over `ssh`.
- No tmux control-mode renderer in this phase.
- No replacement for xterm rendering.
- No requirement that Remux launch tmux for detection to work.
- No custom tmux config management.
- No automatic modification of user tmux key bindings.
- No attempt to infer tmux state from raw keystrokes as the primary mechanism.
- No guaranteed support for tmux servers owned by another Unix user.
- No detached-session UI in this phase.
- No pane-management UI in this phase.
- No broad destructive tmux actions in this phase. The only scoped destructive helper is closing the currently active tmux window.

## Detection Model

Detection should use local process and tmux state, not terminal text heuristics.

1. When the terminal server starts a PTY session, record:
   - Remux terminal `sessionId`.
   - PTY child pid.
   - PTY slave TTY from `MasterPty::tty_name()`.
   - Clear inherited `TMUX` and `TMUX_PANE` env vars before spawning the shell so a terminal opened from a Remux process running inside host tmux can still start its own tmux client.
2. The tmux scanner discovers local tmux sockets.
3. For each socket, query clients with `tmux list-clients`.
4. If a client has `client_tty` equal to the Remux PTY TTY, the terminal session is inside local tmux.
5. Query sessions, windows, panes, options, and client state for that socket.
6. Emit or return a tmux context for the viewer.

The scanner may still report detached local sessions as backend context, but the Phase 3 viewer does not surface any UI unless the current terminal session is attached to local tmux.

## Socket Discovery

Phase 3 should support ordinary local tmux usage first:

- The default tmux socket.
- The socket from the Remux runtime `TMUX` env var, when present.
- Same-user sockets under `/tmp/tmux-$UID/*`, when available.

Socket scanning should be bounded:

- Skip paths that are not Unix sockets.
- Run each tmux command with a short timeout.
- Treat inaccessible or stale sockets as unavailable, not fatal.
- Keep socket identity in returned state so later commands target the same tmux server.

Custom sockets are supported only if discovered by the rules above. Cross-user sockets and remote sockets are deferred.

## Tmux State

The server should normalize tmux CLI output into a stable context shape.

```ts
type TmuxContext = {
  mode: 'none' | 'available' | 'attached';
  terminalSessionId: string;
  terminalTty: string | null;
  currentClient: TmuxClient | null;
  sockets: TmuxSocketState[];
  generatedAt: number;
};

type TmuxSocketState = {
  socketPath: string | null;
  available: boolean;
  error: string | null;
  options: TmuxOptions;
  sessions: TmuxSession[];
};

type TmuxOptions = {
  prefix: string | null;
  prefix2: string | null;
  mouse: boolean | null;
};

type TmuxClient = {
  tty: string;
  pid: number | null;
  sessionId: string | null;
  sessionName: string;
  width: number | null;
  height: number | null;
  controlMode: boolean;
  socketPath: string | null;
};

type TmuxSession = {
  id: string;
  name: string;
  attached: number;
  windowCount: number;
  activeWindowId: string | null;
  windows: TmuxWindow[];
};

type TmuxWindow = {
  id: string;
  sessionId: string;
  index: number;
  name: string;
  active: boolean;
  last: boolean;
  paneCount: number;
  layout: string;
  panes: TmuxPane[];
};

type TmuxPane = {
  id: string;
  windowId: string;
  index: number;
  active: boolean;
  inMode: boolean;
  currentCommand: string;
  currentPath: string;
  tty: string;
  pid: number | null;
  width: number;
  height: number;
};
```

Use tmux ids (`$`, `@`, `%`) as command targets whenever possible. Names are display labels, not primary identifiers.

## Server RPC

Add tmux-specific terminal methods under `remux/terminal/tmux/*`.

Requests:

```ts
type TerminalTmuxContextParams = {
  sessionId: string;
};

type TerminalTmuxActionParams = {
  sessionId: string;
  socketPath?: string | null;
  action:
    | 'close-window'
    | 'exit-tmux'
    | 'refresh'
    | 'select-window'
    | 'scroll-up'
    | 'scroll-down'
    | 'new-window'
    | 'switch-session';
  lines?: number | null;
  target?: {
    tmuxSessionId?: string;
    tmuxWindowId?: string;
  };
};
```

Responses:

```ts
type TerminalTmuxContextResponse = {
  context: TmuxContext;
};

type TerminalTmuxActionResponse = {
  ok: true;
  context?: TmuxContext;
};
```

Notifications:

```ts
type TerminalTmuxContextChanged = {
  sessionId: string;
  context: TmuxContext;
};
```

The first implementation can use viewer polling through `context/get`, backed by a short-lived server cache. Push notifications can be added once the behavior is stable.

## Action Semantics

When the current terminal session is attached to local tmux, helpers should use direct tmux CLI commands. Examples:

- `select-window`: `tmux -S <socket> select-window -t @1`
- `switch-session`: `tmux -S <socket> switch-client -c /dev/pts/N -t $1`
- `scroll-up`: `tmux -S <socket> copy-mode -e -t %1 \; send-keys -X -N <lines> -t %1 scroll-up`
- `scroll-down`: `tmux -S <socket> send-keys -X -N <lines> -t %1 scroll-down` when the pane is already in copy mode
- `new-window`: `tmux -S <socket> new-window -t $0:`
- `close-window`: `tmux -S <socket> kill-window -t @1`
- `exit-tmux`: `tmux -S <socket> detach-client -t /dev/pts/N`

Direct commands are preferred because they do not depend on the user's prefix key, current terminal input mode, or a timing-sensitive macro. The terminal screen will update because tmux redraws through the existing PTY client.

Phase 3 tmux helpers must not inject raw keystrokes into the terminal. Scroll helpers use tmux copy-mode commands so mobile touch or button scrolling does not pollute foreground program input. A tap scrolls a 5-line batch; holding a scroll button repeats smaller 3-line batches until release. The server clamps requested scroll counts to a small bounded range.

Session switching is scoped to sessions on the same tmux socket/server as the current attached client. Cross-socket attach remains deferred because it is a different operation from `switch-client` and could unexpectedly move the user into a different tmux server.

## Detached Session Handling

Listing detached local sessions is backend-supported but not part of the Phase 3 viewer surface. Automatically attaching them into the current PTY is more delicate and deferred.

The viewer should show no tmux UI for `mode === 'available'`. A dedicated "open attached terminal" route can be added later once terminal session launching supports command argv in addition to the default shell.

The default Terminal launcher should still open a normal shell. Tmux attach is an explicit action, not the only way to get tmux awareness.

## Viewer UX

The viewer should add tmux UI only when the current terminal is attached to local tmux.

When `mode === 'attached'`:

- Show one compact tmux row above the existing terminal key row.
- Render that row inside the same bottom action bar, not as a separate toolbar.
- Use the same terminal action-button styling and sizing as the normal terminal keys.
- Show a fixed icon-only session picker at the left edge of the tmux row.
- The session picker lists one row per session from the current attached socket.
- Each session row includes a compact summary of its tabs.
- Selecting a session calls `switch-session` with `$sessionId` only, allowing tmux to use that session's current active window.
- Each window appears as a horizontally scrollable tab with index and name.
- The active window is visually distinct.
- Tapping a window calls `select-window`.
- The left side is the scrollable window tab strip.
- The right side has exactly three fixed buttons:
  - scroll tmux copy-mode up, repeating while held.
  - scroll tmux copy-mode down, repeating while held.
  - open a tmux action menu.
- The tmux action menu contains:
  - new tab, backed by `new-window`.
  - close current tab, backed by `close-window`.
  - exit tmux, backed by `exit-tmux`.
- Touch scrolling is disabled while attached to tmux so Remux does not send arrow-key fallback input into the foreground program.

The existing terminal key row remains available:

- `Esc`, `Tab`, modifiers, arrows, Enter, `^C`, paste, keyboard, and tabs stay functional.
- Tmux controls should not displace basic terminal recovery controls.

When `mode === 'available'`:

- Do not show tmux UI.

When `mode === 'none'`:

- Do not add tmux UI.

## Terminal State Tracking

The `remux-cli` prototype shows that server-side terminal state tracking can be useful for alternate screen, mouse mode, cwd/title, and scroll behavior. For Phase 3, do not make tmux detection depend on a terminal parser.

Acceptable Phase 3 use:

- Record `OSC 0/2` title if cheap.
- Record `OSC 7` cwd if cheap.
- Record alternate-screen/mouse-mode flags only if needed for UI gating.

Deferred:

- Full server-side terminal screen model.
- Using keystroke history to infer app mode.
- App-aware controls for Vim, Claude Code, Codex, or arbitrary TUIs.

## Security And Robustness

- Use `std::process::Command` with argv arrays. Do not shell out with interpolated strings.
- Only send targets that came from tmux scanner output or strict id validation.
- Validate tmux ids before invoking actions:
  - session ids start with `$`.
  - window ids start with `@`.
- Use command timeouts.
- Cache scanner results briefly to avoid spawning many tmux commands during rapid UI updates.
- Treat missing `tmux` as a normal unavailable state.
- Treat tmux command failure as an action error, not a terminal server crash.
- Never kill a tmux session as part of closing a Remux terminal tab. Closing the tab should close only that Remux PTY/client.

## Testing

Server parser tests:

- Parse sessions, clients, windows, panes, options, and empty outputs.
- Handle detached sessions with no clients.
- Match `terminalTty` to `client_tty`.
- Ignore stale sockets and command failures.

Server integration tests:

- Skip clearly if `tmux` is not installed.
- Use an isolated socket, for example `tmux -L remux-test-$PID`.
- Create a detached session, list it, and assert sessions/windows/panes are present.
- Attach a temporary client through a PTY and assert client TTY detection.
- Run `select-window`, `scroll-up`, `scroll-down`, `new-window`, `close-window`, and `exit-tmux` against the isolated server where practical.

Viewer tests:

- Mock `mode: attached` and verify window tabs render.
- The session picker lists one row per session with tab summary text.
- Selecting another session from the session picker sends `switch-session` with `$sessionId`.
- Tapping a window sends `select-window`.
- Scroll buttons send `scroll-up` and `scroll-down` tmux actions, not terminal input.
- Rapidly tapping a scroll button sends 5-line scroll actions.
- Holding a scroll button repeats 3-line scroll actions and stops after release.
- Tmux action menu sends `new-window`, `close-window`, and `exit-tmux`.
- Mock `mode: available` and verify no tmux UI is shown.
- Mock tmux unavailable and verify the terminal UI stays unchanged.
- Confirm the added tmux strip remains above the keyboard and does not break the existing terminal key row layout.
- Confirm touch scrolling is disabled while attached to tmux so alternate-buffer scroll fallback does not pollute input.

Manual validation:

- Start a normal Terminal, type `tmux`, and verify the tmux strip appears.
- Attach to an existing local session and switch windows from the strip.
- Switch sessions from the session picker and verify the window strip redraws for the selected session's active window.
- Use scroll up/down buttons and verify tmux copy-mode scrolls without arrow-key input.
- Rapidly tap scroll up/down buttons and verify each tap moves a larger 5-line batch.
- Hold scroll up/down buttons and verify scrolling continues in smaller 3-line batches while held and stops when released.
- Use the tmux action menu to create a new window.
- Use the tmux action menu to detach and verify the strip disappears.
- Confirm existing detached Remux dev sessions do not show a tmux UI until the current terminal attaches to one.
- Confirm `ssh other-host; tmux` does not falsely present local tmux controls.

## Implementation Sequence

1. Record PTY slave TTY in `SessionRecord` and include it in session summaries.
2. Add a `tmux` server module with socket discovery, command runner, parsers, and normalized context types.
3. Add `remux/terminal/tmux/context/get`.
4. Add safe action execution for scoped tmux commands.
5. Add attached-mode scroll actions backed by tmux copy-mode commands.
6. Add viewer polling and `mode` handling.
7. Add attached-only window strip with scroll buttons and a tmux action menu.
8. Disable touch-scroll fallback while inside tmux.
9. Add server parser/integration tests and viewer tests.
10. Run manual validation against the local tmux sessions used for Remux development.

## Exit Criteria

- Existing terminal Phase 2 tests still pass.
- Tmux parser tests pass.
- Tmux integration tests pass when tmux is installed and skip cleanly otherwise.
- A normal terminal with no tmux does not show tmux UI.
- Typing `tmux` manually in a terminal causes Remux to detect attached local tmux.
- Existing detached local tmux sessions do not show viewer UI by themselves.
- Sessions on the current attached tmux socket can be selected from the session picker.
- Session switching uses `switch-client` against the current Remux tmux client and lets tmux choose the session's active window.
- Window selection works without sending prefix-key macros.
- Scroll buttons use tmux copy-mode actions rather than terminal arrow-key fallback input.
- Rapid taps send 5-line tmux copy-mode scroll actions.
- Holding a scroll button repeats 3-line tmux copy-mode scroll actions until release.
- Tmux action menu works for new window, close current window, and detach current client.
- Closing a Remux terminal tab does not kill the underlying tmux session.
- Remote tmux over ssh does not produce false local tmux controls.

## Deferred Beyond Phase 3

- Remote tmux helpers.
- Full tmux control-mode client.
- Persisted tmux layout metadata owned by Remux.
- Rich copy-mode UI.
- App-aware controls for Vim, Claude Code, Codex, or other TUIs.
- Full server-side terminal screen tracking.
