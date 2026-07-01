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
