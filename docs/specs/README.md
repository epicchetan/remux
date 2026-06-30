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

## Platform Specs

| Spec | Status | Notes |
| --- | --- | --- |
| [viewer-kit.md](viewer-kit.md) | Active Spec | `@remux/viewer-kit` SDK: host bridge, bootstrap, lifecycle, UI primitives, and the shared design-token contract. |
