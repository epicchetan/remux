# Specs

Specs capture design intent and implementation plans. They are useful for rationale, but they are not automatically current runtime documentation.

## Statuses

- `Active Spec`: still informs ongoing implementation or design.
- `Implemented`: the pass landed; use it for rationale and verify details against code.
- `Archived`: historical phase plan, superseded by later implementation or architecture docs.

Every spec should start with:

```md
Status: ...
Last verified: YYYY-MM-DD
Canonical code: ...
```

## Codex Specs

| Spec | Status | Notes |
| --- | --- | --- |
| [codex/transcript-identity-reconciliation.md](codex/transcript-identity-reconciliation.md) | Active Spec | Canonical item identity model for persisted and live transcript items. |
| [codex/transcript-store-scroll.md](codex/transcript-store-scroll.md) | Implemented | Transcript resource/layout/viewport ownership and scroll model. |
| [codex/archive/app-server-facade-thread-history.md](codex/archive/app-server-facade-thread-history.md) | Archived | Historical thread-history read phase. |
| [codex/archive/client-transcript-read-api.md](codex/archive/client-transcript-read-api.md) | Archived | Historical client read API phase. |
| [codex/archive/current-thread-send-invalidation.md](codex/archive/current-thread-send-invalidation.md) | Archived | Historical send/invalidation phase. |
| [codex/archive/rust-transcript-server.md](codex/archive/rust-transcript-server.md) | Archived | Historical Rust transcript server phase. |

## Terminal Specs

| Spec | Status | Notes |
| --- | --- | --- |
| [terminal/phase-1.md](terminal/phase-1.md) | Active Spec | Phase 1 mobile-first terminal extension design. |
| [terminal/phase-2-validation.md](terminal/phase-2-validation.md) | Active Spec | Validation harness and hardening plan for terminal reliability. |
| [terminal/phase-3-local-tmux.md](terminal/phase-3-local-tmux.md) | Active Spec | Local tmux detection, session/window/pane context, and mobile tmux controls. |
| [terminal/phase-4-input-latency-and-resync.md](terminal/phase-4-input-latency-and-resync.md) | Active Spec | Input latency and background-resync plan: control/data plane split, reconnect replay, fire-and-forget input, fanout gating. |

## Platform Specs

| Spec | Status | Notes |
| --- | --- | --- |
| [viewer-kit.md](viewer-kit.md) | Active Spec | `@remux/viewer-kit` SDK Phase 1: host bridge, bootstrap, UI primitives, and the shared design-token contract. Satellites migrated; lifecycle deferred. |
| [viewer-kit-phase-2.md](viewer-kit-phase-2.md) | Active Spec | Phase 2 frame depth: dual-substrate theme system, codex color onboarding, and the component library. Chat primitives + lifecycle out of scope. |
| [viewer-kit-phase-3.md](viewer-kit-phase-3.md) | Active Spec | Theme-readiness & ownership: classify every theme-sensitive color as kit role / viewer extension / engine palette and tokenize the dark side. Substrate-neutral; Tailwind convergence is an optional Phase 4. Prerequisite for light mode. |
| [viewer-kit-light-mode.md](viewer-kit-light-mode.md) | Active Spec | App-wide system-tied light mode: host-driven theme signal (kit-optional extension contract), RN shell + files/settings cleanup on generated native tokens, semantic-tier remap, engine light palettes (xterm/CodeMirror/Shiki/Mermaid). |
| [light-mode-polish.md](light-mode-polish.md) | Active Spec | Light-mode cleanup: codex composer buttons, terminal active-key legibility, terminal launcher icon. Roots to two bug-classes (accent-foreground off an accent fill; hardcoded-black elevation) + one non-self-contained icon asset. |
| [files-tab.md](files-tab.md) | Active Spec | Files tab overhaul: freshness model (tab re-entry + expanded-descendant refresh with an explicit concurrency/failure contract), `remux/fs/didChange` push invalidation (3-layer detection: served-dir watchers + `.git` watchers + git-status poller; fs-core invalidate/subscribe API; shared `isPathWithin` contract), SF Symbol icon redesign with PNG fallback. |
| [tab-identity-and-routing.md](tab-identity-and-routing.md) | Active Spec | Tab identity = resource key (no alias history); single `openResource` choke point with reuse dispositions; `host/navigate` intent delivery on reuse; codex host-bridge migration to viewer-kit (P2); RPC origin attribution to fix the codex draft→thread notification race; key-based tray dismissal so arriving at a resource clears its notifications. |
| [cli-rust-port.md](cli-rust-port.md) | Active Spec | CLI audit (EPIPE crash root cause, restart-policy and orphan-process defects) + Rust port roadmap: four-layer supervision (systemd/supervisor/crash containment/process hygiene), extension lifecycle state machine, per-extension logs, resource monitoring. |
| [cli-rust-port-pass-1.md](cli-rust-port-pass-1.md) | Implemented | Pass 1 implementation spec: full Rust replacement of the Node CLI in one pass — L1 crash-restart supervisor, L2 extension state machine with crash budget, EOF→SIGTERM→SIGKILL stop with confirmed reap, per-extension logs RPC, journal rotation, chaos test suite, cutover. Punts L0/systemd, full L3, resource monitoring (pass 2). Landed as the `cli/` Rust crate. |
| [cli-rust-port-pass-2.md](cli-rust-port-pass-2.md) | Implemented | Pass 2 implementation spec: L0 systemd user service, worker hang watchdog, full L3 process hygiene (pgroups + PDEATHSIG + boot orphan sweep), manifest `build` phase (no `cargo run` in production), `/proc` resource monitoring + `remux/system/resources*` RPCs, failed-state push notifications, and the app Settings ops UI (live badges, log tail, System section). Punts auth token and CLI subcommands to pass 3. |
| [cli-rust-port-pass-3b-cli.md](cli-rust-port-pass-3b-cli.md) | Active Spec | Pass 3b (final): `remux` on PATH via `~/.local/bin` symlink (rebuild-transparent), root discovery so every subcommand works from any cwd, systemd-first `start|stop|restart`, `status` (new authenticated `GET /api/status` + binary-staleness check), file-based `logs -f`, 12-check `doctor`, idempotent `install` (embedded unit, node/npm symlinks — fixes the unit-PATH deploy blocker), role-keyed resource sampling so watch sidecars hit the memory ceiling. |
| [cli-rust-port-pass-3-auth.md](cli-rust-port-pass-3-auth.md) | Implemented | Pass 3a: shared bearer token on `/ws` + HTTP — token file (`.remux/auth-token`, 0600) + `remux token` subcommand, one axum middleware (health exempt, constant-time compare), cookie hand-off for WebView subresources, app token setting + header plumbing, app-before-runtime rollout. TLS/public exposure rejected; tailnet stays the transport layer. |
| [view-build-watch.md](view-build-watch.md) | Active Spec | Manifest `build` phase extended to views + managed `watch` sidecar: supervisors for view-only extensions (editor/markdown), build sequencing with watch-owned dist rule, run-state v2 (role-keyed), watch RPCs + status facets, app Settings watch controls + `watch` log stream, all-extension rollout. Rejects HMR/dev-server proxying; serving stays static-from-disk. |
