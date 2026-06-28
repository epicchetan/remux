# Terminal Extension Phase 2: Validation And Hardening

Status: Active Spec
Last verified: 2026-06-28
Canonical code: Planned under `extensions/terminal/`, terminal test fixtures, and terminal-specific test scripts.

## Purpose

Phase 2 turns the Phase 1 terminal from a functional alpha into something we can reason about. The goal is not to add tmux or app-aware controls yet. The goal is to prove the terminal contract with automated tests, identify which mobile behaviors require real device validation, and fix the bugs found by those tests.

The output of this phase should be a repeatable validation harness plus a short real-device checklist. After this phase, we should know whether the terminal is good enough for everyday shell work and Claude Code-style terminal apps, and we should have concrete evidence for that answer.

## Current Baseline

Phase 1 already includes:

- Rust `portable-pty` server over Remux stdio JSON-RPC.
- xterm viewer with fit, Unicode, web links, and optional WebGL.
- One PTY session per Remux viewer tab.
- Viewer reload attach and replay.
- Host tab close killing the PTY session.
- Mobile key row for `Esc`, `Tab`, sticky `Shift`/`Ctrl`/`Alt`, arrows, Enter, `^C`, paste, keyboard, tabs, and restart.
- Keyboard-aware bottom bar offset and xterm refit using host viewport metrics and `visualViewport`.

Known weak spots:

- Fixture apps for high-output, alternate-screen, raw input, and resize now exist, but they are not yet wired into automated browser/server assertions.
- No real-device matrix recorded for iOS and Android keyboard behavior.
- No hands-on Claude Code session has been recorded against the terminal yet.
- Paste is still best-effort and not a phase 2 release blocker unless it breaks ordinary typing or app stability.

## Automated Harness Status

Implemented in the first Phase 2 pass:

- Rust server tests in `extensions/terminal/server/src/main.rs` cover PTY start/write/output, attach replay, resize via `stty size`, kill/write failure, normal shell exit, missing-session errors, and size clamping.
- Viewer key encoding is factored into `extensions/terminal/viewer/src/terminal/keyEncoding.ts`.
- Playwright tests in `extensions/terminal/tests/` cover direct key bytes, arrow/modifier CSI sequences, sticky modifier clearing, mocked host attach/start, keyboard-offset layout, one aligned horizontal action row, and exited restart affordance.
- Deterministic fixture apps live under `extensions/terminal/tests/fixtures/`.
- The websocket smoke runner `extensions/terminal/tests/ws-smoke.cjs` validates start/write/output/kill through a running Remux `/ws` endpoint.

Bugs found and fixed during this pass:

- The key encoder now ignores pure modifier keys internally instead of relying only on the document keydown guard.
- `ExtensionActionButton` preserved-focus buttons can activate immediately after mount; the debounce timestamp no longer starts at `0`.

Last local verification on 2026-06-28:

```bash
npm run typecheck
cargo test --manifest-path extensions/terminal/server/Cargo.toml
npm --workspace @remux/terminal run build
npm run test:terminal
REMUX_WS_URL=ws://127.0.0.1:48124/ws npm run test:terminal-smoke
```

All commands passed. The terminal build still emits Vite's existing large chunk warning.

## Validation Philosophy

Terminal correctness should be tested through invariants, not through developer familiarity with specific TUI apps.

Examples of invariants:

- Bytes written by the viewer reach the PTY unchanged.
- Bytes emitted by the PTY reach xterm unchanged.
- Resize changes produce the expected PTY row/column size.
- Reload attaches to the same session and replays output in order.
- Closing a terminal tab kills its session.
- Normal-buffer touch scroll changes scrollback.
- Alternate-buffer touch scroll sends arrow input.
- Sticky `Shift`, `Ctrl`, and `Alt` produce the expected byte sequences and clear predictably.
- The bottom bar remains visible above keyboard metrics.

Real applications like `vim`, `less`, `top`, `claude`, and `codex` should be used as end-to-end confidence checks after the invariants pass. They should not be the only validation strategy.

## What Automation Can Prove

Automation can provide high confidence for:

- Server lifecycle: start, attach, list, write, resize, kill, exit.
- Server byte transport: base64 decode/encode without lossy string conversion.
- Replay ordering and truncation flags.
- PTY resize propagation through `stty size`.
- Basic shell execution.
- High-output handling at the server and viewer bridge boundaries.
- Viewer key encoding for mobile controls and hardware keyboard modifiers.
- Viewer response to mocked host viewport and keyboard metrics.
- Viewer attach/replay behavior with mocked Remux IPC.
- Layout invariants such as one horizontal key row and bottom bar offset.

Automation cannot fully prove:

- iOS and Android native keyboard animation behavior inside Expo WebView.
- OS-level clipboard permission behavior.
- Actual network quality against a remote server.
- External app behavior that changes over time, such as Claude Code or Codex CLI releases.
- GPU/WebGL stability on every mobile device.

The harness should still mock and stress those boundaries where possible, but real-device checks remain required before calling the terminal reliable.

## Test Layers

### 1. Rust Server Unit Tests

Extend `extensions/terminal/server/src/main.rs` tests for pure server behavior:

- Parameter validation for start, attach, write, resize, and kill.
- PTY size clamping and invalid dimensions.
- Session id selection when `sessionId` is provided vs generated.
- Session state transitions: missing -> running -> exited -> killed.
- Replay sequencing and bounded replay trimming.
- `replayTruncated` when attach requests a sequence older than the replay tail.
- Unknown session errors.

These tests should avoid depending on a real shell unless the specific test is marked integration-style.

### 2. Rust Server Integration Tests

Add tests that spawn a real PTY-backed shell through the terminal server code:

- Start a session in the repo cwd.
- Write `printf 'remux-terminal-ok'\r` and assert output notification contains the text.
- Resize to a known size, run `stty size`, and assert rows/cols are reflected.
- Attach to an existing session and verify replay after a known sequence.
- Kill the session and assert subsequent write fails.
- Exit the shell normally and assert the exited notification/state is recorded.

These should run with `cargo test --manifest-path extensions/terminal/server/Cargo.toml`. If an environment lacks `/bin/sh` or `stty`, skip only the specific integration test with a clear reason.

### 3. Wire Protocol Smoke Tests

Add a small Node-based smoke test that talks to the Remux websocket, not directly to Rust:

- Connect to `/ws`.
- Call `remux/terminal/session/start`.
- Send input through `remux/terminal/session/write`.
- Observe `remux/terminal/session/output`.
- Call `remux/terminal/session/kill`.

This validates extension routing through:

```text
viewer/client shape -> Remux websocket -> CLI router -> stdio extension process -> Rust PTY server
```

This smoke test can be skipped unless a local Remux runtime is running, or wrapped in a script that starts Remux on a temporary port.

### 4. Viewer Unit Tests

Add focused TypeScript tests for byte-level behavior:

- `Esc`, `Tab`, Enter, `^C`.
- Arrows with no modifier.
- `Ctrl` + letters -> bytes `1..26`.
- `Ctrl` + `[`, `\`, `]`.
- `Alt` + printable -> `ESC` prefix.
- `Shift`/`Ctrl`/`Alt` arrows -> CSI modifier sequences.
- Shift+Enter -> `\x1b[13;2u`.
- Shift+Tab -> `\x1b[Z`.
- Sticky modifier clears after a successful encoded input.
- Sticky modifier auto-clears after 3 seconds.

Key encoding should be factored enough to test without rendering the full xterm surface.

### 5. Viewer Browser Tests

Use Playwright or the existing viewer test pattern with a mocked Remux host bridge.

Required assertions:

- Terminal viewer sends `session/start` with measured rows/cols.
- Mocked `session/output` writes to xterm in order.
- Mocked viewer reload attaches to the same `resourceId`.
- Mocked host `viewport/changed` with keyboard height updates the terminal shell offset.
- All terminal action buttons are in one horizontal scroll row.
- The bottom bar remains within the visible viewport after mocked keyboard metrics.
- The xterm container height changes when the action bar moves above the keyboard.
- Error/exited state displays restart affordance.

These tests validate browser and layout behavior. They do not replace real mobile WebView checks.

### 6. Fixture Apps

Add small deterministic fixtures instead of relying on manual knowledge of TUI apps:

- `raw-input`: puts stdin in raw mode, prints received bytes as hex, exits on a known byte.
- `resize-probe`: prints initial size, traps resize, prints updated size.
- `alternate-screen-probe`: enters alternate screen, reads arrow keys, prints which arrows arrived, exits cleanly.
- `burst-output`: emits enough data to stress output handling without running forever.

Preferred implementation:

- Use shell scripts where portable.
- Use Python standard library only if shell cannot express the behavior safely.
- Keep fixtures under `extensions/terminal/tests/fixtures/` if they are test-only.

The fixture apps should let us test behavior that `vim`, `less`, and `top` depend on without requiring a tester to know those apps.

## Real-Device Checklist

Run this on at least one iPhone and one Android device before claiming phase 2 complete.

Baseline:

- Open Terminal from Remux launcher.
- Type `echo ok` and press Enter.
- Tap keyboard toggle open/closed.
- Confirm bottom row stays above keyboard.
- Confirm action row is horizontally scrollable and visually aligned.

Keyboard and resize:

- Rotate portrait to landscape and back.
- Confirm shell redraws without the prompt being hidden.
- Open keyboard, rotate, close keyboard.
- Confirm terminal remains usable.

Session lifecycle:

- Switch to another Remux tab and return.
- Reload the terminal viewer.
- Confirm the same session is attached.
- Close the terminal tab.
- Confirm a write to that session fails or the session disappears from `session/list`.

Common terminal behavior:

- Run `less package.json`, scroll, then quit with `q`.
- Run `vim`, use arrows, press `Esc`, quit with `:q`.
- Run `top` or `htop`, confirm alternate screen renders, then quit.
- Run a noisy command such as `find . -maxdepth 3 -type f`.

Claude Code-style behavior:

- Start Claude Code or a comparable terminal CLI.
- Type a short prompt and submit.
- Test Shift+Enter for multiline input if the app supports it.
- Test `Ctrl+C` to cancel.
- Paste a short multiline snippet.
- Switch away and back while the CLI is idle.

Record:

- Device model.
- OS version.
- Remux host environment.
- Pass/fail notes.
- Any screenshot or screen recording for layout failures.

## Claude Code Readiness Gate

The terminal can be considered Claude Code-ready for alpha use when:

- The automated byte-level key tests pass.
- The mocked keyboard-offset layout tests pass.
- The high-output test does not freeze the viewer.
- `Ctrl+C`, arrows, Enter, Shift+Enter, and paste work in at least one real Claude Code session.
- Viewer reload or tab switch does not lose the Claude Code terminal session.
- A real-device tester can complete one short Claude Code task without using a hardware keyboard.

This does not require first-class Claude Code UI detection or custom buttons. Those belong to a later app-aware controls phase.

## Phase 2 Implementation Sequence

Automated steps 1-7 are now implemented for the first pass. Step 8 remains required before this phase can be called complete, and step 9 should follow after real-device results are known.

1. Add Rust server integration tests for PTY start/write/resize/attach/kill.
2. Extract terminal key encoding into a small testable module.
3. Add viewer unit tests for key encoding and sticky modifier timing.
4. Add Playwright or equivalent mocked-host viewer tests for keyboard offset and single-row action bar layout.
5. Add deterministic fixture apps for raw input, alternate screen, resize, and burst output.
6. Add a Remux websocket smoke test or script.
7. Fix bugs found by the automated tests.
8. Run the real-device checklist on iPhone and Android.
9. Update this spec with results and promote reliable behaviors into user-facing docs.

## Phase 2 Exit Criteria

- `npm run typecheck` passes.
- `npm --workspace @remux/terminal run build` passes.
- `cargo test --manifest-path extensions/terminal/server/Cargo.toml` includes and passes terminal integration tests.
- Terminal viewer tests pass in CI or the local test command chosen for this phase.
- Remux websocket terminal smoke test passes locally.
- Real-device checklist is completed on iOS and Android, with failures either fixed or tracked as explicit follow-up work.
- Claude Code readiness gate is answered explicitly: ready for alpha use, blocked by named issue, or deferred.

## Deferred Beyond Phase 2

- First-class tmux control-mode support.
- App-aware bottom rows for tmux, Vim, Claude Code, or Codex.
- Persistent terminal sessions across Remux runtime restart.
- Search and serialized screen restore.
- Configurable shells, font sizes, themes, and cwd presets.
- Host clipboard bridge.
- Full flow-control protocol with viewer-driven pause/resume.
