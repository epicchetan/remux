# Viewer Kit SDK

Status: Active Spec (Phase 1 — foundation)
Last verified: 2026-06-30
Canonical code: `packages/viewer-kit/`. Consumers: `extensions/*/viewer`.
Continued by: [viewer-kit-phase-2.md](viewer-kit-phase-2.md) (frame depth: dual-substrate theme, codex onboarding, component library).
Progress: slices 0–5 landed; satellites migrated and on the near-black surface ladder. Slice 6 (lifecycle/resume) is **deferred** into a future terminal-lifecycle + stability effort, not done here.

## Purpose

Remux has four viewers (terminal, editor, markdown, codex) that each re-implement the same plumbing: React root bootstrap, host IPC wiring, a per-extension token block, and (in one case) resume-on-activation. Building a fifth viewer means copying that plumbing again, and the copies have already drifted.

This spec defines `@remux/viewer-kit`: a single SDK that makes building a viewer easy and consistent. It owns the host bridge, the React bootstrap, viewer lifecycle, UI primitives, and a shared design-token contract. The goal is that a new viewer's entry file is a few lines and its chrome is correct and on-brand on day one.

This is a **package (SDK)**, not a runtime base-extension. Everything it solves is a compile-time concern; a runtime-shared bundle is explicitly out of scope (see Non-Goals).

## Reference Context

Findings from the current tree that motivate the design:

- **Bootstrap is copy-pasted 4×.** `extensions/{terminal,editor,markdown,codex}/viewer/.../main.tsx` each repeat ~50 lines of `createRoot` + `window.__remux<Name>Root` tracking + HMR `dispose` + a legacy untracked-root reload migration. Only the name string and the `initialize` call differ (satellites call `initializeIpc()`; codex calls `useHostStore.getState().initialize()`).
- **`@remux/extension-api` is pure, React-free, viewer-side code.** Exports `host`, `ipc`, `fs`, `route`. Every consumer is a viewer; the app never imports it (the app owns the native end of the bridge). The only "React" reference is the `window.ReactNativeWebView` typing in `ipc.ts`.
- **Lifecycle exists in exactly one viewer and is structurally incomplete.** Only codex implements resume, via `resumeSync.ts` listening to `document.visibilitychange` / `pageshow`. But `app/src/browser/ActiveSurface.tsx` keeps every viewer tab mounted at once and switches between them with pure CSS (`opacity:0`, `zIndex:0`, `pointerEvents:none`); it never unmounts background viewers. So `visibilitychange` does **not** fire on intra-app tab switches — codex's resume only catches OS-level app background/foreground, not "this tab became active again." A background viewer cannot detect its own re-activation; only the app knows. The host→viewer event channel already exists (`host/viewport/changed` flows through `subscribeIpcEvents`). **Update: this has since been implemented as `host/active` — the app emits it from `ActiveSurface`'s active-tab state, `/host` exposes `subscribeHostActive`, and terminal consumes it. The intra-app resume signal is no longer future; see [viewer-kit-phase-2.md](viewer-kit-phase-2.md).**
- **There is no design system — there are four uncoordinated token sets** that disagree on hue family and accent:
  - Terminal: zinc ramp `09090b → 18181b → 27272a → 3f3f46`, orange accent `#f97316`, focus `#60a5fa`.
  - Editor / markdown: same zinc family, shifted one stop lighter (their "background" is terminal's "chrome").
  - Codex: neutral-gray ramp `171717 → 202020 → 2a2a2a → 303030`, blue accent/focus `#8ab4f8` (and an internally inconsistent cool `--chrome: #1f232b`).
  - App shell (`app/src/theme/tokens.ts`, React Native): cool blue-gray `000000`, `20242c`, `2b3038`.
- **Terminal is the reference palette** (near-black zinc stage), and the strongest design signature is the `@remux/extension-ui` button elevation — layered inset highlight + a 2px bottom "lip" + `translateY(1px)` on press. Both are currently expressed as ad-hoc literals with no scales (`space`, `radius`, `text`, `shadow` are all inline magic numbers).

## Non-Goals

- **No base-extension / runtime-shared bundle.** Sharing happens at compile time via the package. Revisit only if OTA updates to shared UI or a plugin marketplace become real.
- **Codex styling migration is deferred.** Codex adopts non-visual SDK parts (runtime, lifecycle) when convenient; its tokens and components stay as-is. Codex is treated as a theme override later, not conformed now.
- **Spacing scale rollout to codex is deferred.** The codex transcript layout depends on its existing spacing variables; do not retune them under this work.
- **Light mode is deferred.** Tokens must be authored light-ready (two-tier, semantic indirection), but only the dark theme ships now.
- **React Native app-shell token migration is deferred.** The app cannot consume CSS variables. The token source may later emit a JS object for the app; for now the app keeps its own `tokens.ts` and we only align values by eye.
- **No new viewer features.** This is plumbing and design-language consolidation only.

## Package Boundary

`@remux/viewer-kit` is one package with subpath exports that preserve a hard internal layer boundary: the host bridge stays React-free so it never drags React into transport-only code.

```text
@remux/viewer-kit
  /host  /ipc  /fs  /route   <- today's @remux/extension-api, moved verbatim. NO react import.
  /react                     <- mountViewer(), useViewerResume()        (depends on react)
  /ui                        <- ActionBar, ActionButton, ActionMenu      (depends on react)
  /tokens  (tokens.css)      <- generated from primitives.ts; framework-agnostic CSS
  .        (index)           <- re-exports /react + /ui for the common case
```

Rules:

- `/host`, `/ipc`, `/fs`, `/route` must not import React. The repo has no ESLint yet (lint is `tsc --noEmit`), so this is convention-enforced and documented in the package README; promote to an `no-restricted-imports` rule when ESLint is introduced. This boundary is the only thing the separate `extension-api` package was buying us.
- `@remux/extension-api` continues to exist as a **thin re-export shim** of the kit's host subpaths so current imports keep working. Consumers migrate import paths one at a time; `main` never goes red between slices.
- Package name `@remux/viewer-kit` is confirmed.

## Design Token Contract

Two tiers, so light mode and per-extension themes are a remap, never a component rewrite. Components reference **semantic** tokens only.

- **Tier 1 — primitives**: raw, theme-independent values. The neutral ramp is the refined terminal zinc ramp (`zinc-950 09090b`, `zinc-900 18181b`, `zinc-800 27272a`, `zinc-700 3f3f46`, `zinc-400 a1a1aa`, `zinc-100 f4f4f5`). Brand accent is orange (`#f97316`/`#c45424`). Status hues: blue (`#60a5fa`), red (`#f87171`), green (`#7fd49d`), amber (`#f5c56b`). Plus scales: `space` (4/6/8/10/12/16/20), `radius` (sm 6 / md 8 / lg 10 / full 999), `text` (xs 11 / sm 13 / base 15), and `shadow` (the button elevation stack formalized as `--rmx-shadow-raised` / `--rmx-shadow-pressed`, plus `--rmx-shadow-menu`).
- **Tier 2 — semantic**: role tokens that components use — `--rmx-surface`, `--rmx-surface-raised`, `--rmx-surface-hover`, `--rmx-border`, `--rmx-text`, `--rmx-text-muted`, `--rmx-accent`, `--rmx-accent-foreground`, `--rmx-focus-ring`, `--rmx-danger`, `--rmx-success`, `--rmx-warning`.

Source of truth is `packages/viewer-kit/src/tokens/primitives.ts`; `tokens.css` is generated from it (one source, ready to also emit a JS object for the RN app later). Dark theme ships now; light is a future `:root.light { /* remap tier 2 */ }` block. Existing `--remux-extension-*` variable names are bridged to the new `--rmx-*` semantic names during component migration so nothing breaks mid-flight.

Working accent decision: **orange primary action + blue focus ring** (orange-on-orange focus reads poorly). Codex's blue accent and gray ramp are handled later as a theme override.

## Lifecycle Contract

Minimal and resume-only for now (codex is the sole real implementer).

> **Status (superseded in part):** the app-owned signal below shipped as `host/active` (not the working name `host/lifecycle/resume`): the app emits it from `ActiveSurface`'s active-tab `visible` state, `/host` exposes `subscribeHostActive`, and terminal already consumes it for resync-on-foreground. What remains is codex's rewire and the optional kit hook, both deferred into the terminal-lifecycle + stability effort. See [viewer-kit-phase-2.md](viewer-kit-phase-2.md) → Out of Scope.

- **App owns the signal.** ✅ Implemented as `host/active`, emitted on intra-app tab activation (and re-posted on connection) over the `remux/event` channel.
- **Kit owns the ergonomics.** Partially — `/host` exposes `subscribeHostActive`. An optional `useViewerResume(callback)` wrapper in `/react` is still open.
- **Viewer owns the reaction.** Codex's `resumeSync.ts` still triggers off `document.visibilitychange`; rewiring it onto `host/active` is deferred (terminal already does this correctly via `subscribeHostActive`).

## Runtime Contract

`mountViewer(node, options)` encapsulates the duplicated bootstrap:

```ts
mountViewer(<App />, {
  name: 'terminal',                 // drives the window root key + legacy migration key
  initialize: () => initializeIpc() // codex passes () => useHostStore.getState().initialize()
})
```

It owns: root element lookup, `window.__remux<Name>Root` tracking, the legacy untracked-root reload migration, `createRoot`/`render`, HMR `dispose`/`unmount`, and calling `initialize` once after mount. Each viewer's `main.tsx` collapses to an import plus one call.

## UI Primitives

`ActionBar`, `ActionButton`, `ActionMenu` move from `@remux/extension-ui` into `/ui`, restyled against semantic tokens, authored as slot/compound components.

Guiding rule: **share the frame, not the painting.** The kit provides the bottom-bar *shell* (positioning, safe-area inset, top border, token chrome) and the button/menu primitives. It never models bottom-bar *contents*. The codex composer keeps 100% of its structure and store; it consumes primitives and tokens only. `@remux/extension-ui` becomes a re-export shim of `/ui` for the duration of migration.

## Migration Plan

Vertical slices. Each ends with `npm run typecheck` and `npm run viewers:build` green and the app runnable. Terminal is the proof-of-concept (closest to target, lowest risk). Order is foundation-first; the app-touching lifecycle slice is isolated last.

```text
0. Spec doc        This document.                                          [done criteria: merged]
1. Package + fold  Create @remux/viewer-kit; move extension-api in as
                   React-free /host /ipc /fs /route; add lint boundary;
                   leave @remux/extension-api as a re-export shim.         [typecheck green, zero consumer edits]
2. Tokens          primitives.ts -> tokens.css (dark, light-ready).         [imports cleanly; nobody consumes yet]
3. Runtime         mountViewer(); migrate terminal main.tsx only.          [terminal builds + runs from kit bootstrap]
4. UI + tokens     ActionBar/Button/Menu into /ui on semantic tokens;
                   terminal adopts; extension-ui becomes a shim.           [terminal visually unchanged or improved]
5. Roll out        editor + markdown repeat the terminal pattern.          [all satellites on kit; shims still pass]
6. Lifecycle       DEFERRED — moved to a future terminal-lifecycle +
                   stability spec (app emits host/lifecycle/resume;
                   useViewerResume; rewire codex resumeSync).             [planned outside this spec]
-- next --         codex color onboarding + component library: see
                   viewer-kit-phase-2.md.
-- deferred --     codex spacing migration; light mode; RN app-shell
                   token source.
```

The shim in slice 1 is what makes the work safe across sessions: consumers move one at a time and `main` stays green throughout. Resume work at any time by reading this spec and the slice checklist.

## Verification

- `npm run typecheck` (root `tsc --noEmit`) and `npm run app:typecheck` after every slice.
- `npm run viewers:build` to confirm all viewers still build.
- Playwright smoke for the touched viewer: `npm run test:terminal` (slices 3–4), `npm run test:codex` (slice 6).
- Manual: launch each migrated viewer; for slice 6, switch away from a codex tab and back and confirm a resume sync fires.

## Open Decisions

- **Package name.** `@remux/viewer-kit` is provisional. Confirm before slice 1.
- **Accent identity.** Working default is orange action + single blue focus ring (`#60a5fa`). Confirm, or go single-hue.
- **RN app-shell source of truth.** Defer (keep `app/src/theme/tokens.ts` hand-aligned) vs. make `primitives.ts` emit a JS object the app imports. Deferred for v0; revisit after slice 5.
