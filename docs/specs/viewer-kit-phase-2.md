# Viewer Kit — Phase 2: Frame Depth

Status: Active Spec
Last verified: 2026-06-30
Canonical code: `packages/viewer-kit/`. Consumers: `extensions/*/viewer`. Builds over [viewer-kit.md](viewer-kit.md) (Phase 1).

## Where Phase 1 left us

Phase 1 ([viewer-kit.md](viewer-kit.md)) shipped the package and the foundation: the React-free host bridge (`/host /ipc /fs /route`), `mountViewer()`, the two-tier `--rmx-*` token system generated from `primitives.ts`, and the `/ui` primitives. The three satellite viewers (terminal, editor, markdown) were migrated, and editor/markdown were pulled onto the near-black `--rmx-surface` ladder so all three share the terminal's stage. `@remux/extension-api` / `@remux/extension-ui` were folded in and deleted.

What Phase 1 did **not** do: codex is still fully standalone (its own tokens, its own Tailwind setup, its own component copies), and the kit only speaks one styling substrate (framework-agnostic CSS). Phase 2 deepens the **frame** so codex onboards and so a fifth, more complex viewer can be built on the kit rather than beside it.

Phase 2 is deliberately scoped to the frame. The codex transcript/composer (its *content*) stays codex-owned, and lifecycle/resume is pushed out entirely (see Out of Scope).

## The model: opt-in layers, universal → specialized

The kit is a stack of layers exposed as subpaths. A viewer imports only the layers it needs; depth is never forced. The token layer reaches all the way down — every higher layer is themed by it.

| Layer | Subpath | Imported by | Substrate |
| --- | --- | --- | --- |
| 1. Design system | `/tokens.css` `/theme.css` | everyone | CSS vars + Tailwind `@theme` |
| 2. Host bridge | `/host` `/ipc` `/fs` `/route` | anything host-connected | TS, no React |
| 3. Runtime | `/react` (`mountViewer`, lifecycle) | any React viewer | React |
| 4. Chrome primitives | `/ui` (ActionBar, Button, Menu) | any viewer wanting consistent chrome | framework-agnostic CSS |
| 5. shadcn components | `/shadcn` (Sheet, Separator, Sidebar, `cn`) | Tailwind viewers | Tailwind + kit theme |
| 6. **Chat primitives** | `/chat` (headless feed/composer-chrome) | chat viewers — **deferred** | — |

A markdown viewer touches 1–4. Codex touches 1–5. The deferred layer 6 is the only one with an unproven API (see Out of Scope).

## Two governing rules

These decide every "kit or viewer?" and "now or later?" question in this phase and after.

1. **Mechanism vs policy.** The kit owns *mechanism* — how to theme, how to talk to the host, how to render chrome, how to window a list. The viewer owns *policy* — what a codex turn is, what *send* does, the codex protocol. A windowed list is mechanism; the row renderer is policy. When the two are entangled in one module (codex's virtualizer), that module is not yet a kit primitive.
2. **Standard vs novel abstractions.** Promote a *standard* component (shadcn's Sheet/Separator — API already proven by the ecosystem) to the kit eagerly, even from one consumer: the API risk is already retired. Defer a *novel/bespoke* abstraction (codex's hand-rolled virtualizer) until a second real consumer reveals the true seam. The rule-of-three applies to abstractions we'd be *inventing*, not ones we're *hosting*.

## Track A — Theme system depth

Goal: one source (`primitives.ts`) emits the design system in **both** substrates so plain-CSS viewers and Tailwind viewers consume the identical palette.

Token tiers become three:

- **Tier 1 — primitives** (`--rmx-neutral-950`, `--rmx-orange-500`, scales). Unchanged.
- **Tier 2 — roles** (`--rmx-surface`, `--rmx-surface-raised`, `--rmx-text`, `--rmx-border`, `--rmx-accent`, …). Unchanged; the framework-agnostic semantic layer the satellites already use.
- **Tier 3 — theme bindings** (shadcn vocabulary: `--background`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--border`, `--input`, `--ring`, `--destructive`, plus remux extras `--success` `--warning` `--link`). Each binds to a Tier-2 role, e.g. `--background: var(--rmx-surface)`. This is the shadcn ecosystem's required vocabulary, authored **once in the kit** — not a per-extension mapper.

The generator emits two artifacts:

- **`tokens.css`** — `:root` containing tiers 1–3. Everyone imports it; plain-CSS viewers stop here and use `var(--rmx-surface)` or `var(--background)`.
- **`theme.css`** — `@theme inline { --color-background: var(--background); --color-card: var(--card); --radius: …; --font-sans: …; }`. Tailwind viewers `@import` it (after `@import "tailwindcss"`) to mint `bg-background`, `border-border`, `ring-ring`, etc. It is inert for non-Tailwind viewers, so they never import it.

Scope of the Tailwind face: **color, radius, and font only.** Spacing is deliberately excluded — the kit's `space` scale is for chrome-primitive internals, and codex's transcript spacing stays its own (see the spacing note below). Codex keeps Tailwind's default spacing utilities.

### Codex color onboarding (the payoff)

Codex's `app.css` collapses from "define everything" to "import + extend":

```css
@import "tailwindcss";
@import "@remux/viewer-kit/tokens.css";   /* tiers 1–3 */
@import "@remux/viewer-kit/theme.css";    /* Tailwind utilities */

:root {
  /* codex-only, untouched: transcript rhythm, composer, syntax palettes */
  --remux-turn-gap: 20px;  --remux-block-gap: 20px;  --composer: var(--card);
}
```

Codex deletes its duplicated `--background/--card/--ring/…` block and its color `@theme inline` mappings (the kit supplies both); its shadcn components keep working because the kit speaks their names. Visible value shifts to eyeball: base `#171717 → #09090b` (near-black), card `#202020 → #18181b`. Codex may still **override** any role locally ("modified how they see fit") — the kit theme is a starting point, not a straitjacket.

## Track B — Component library

Goal: the kit is a real, token-themed component library you import — never shadcn's copy-the-tsx model.

- **B1 — Universal chrome primitives (`/ui`).** Formalize ActionBar/Button/Menu (largely landed in Phase 1) as the framework-agnostic, token-themed primitive set every viewer can use with no Tailwind dependency. Mostly a documentation + API-surface confirmation step.
- **B2 — shadcn component set (`/shadcn`).** Host codex's generic shadcn components — `Sheet`, `Separator`, `Sidebar`, `cn` — in the kit, themed by the Tier-3 tokens, so future complex viewers get them for free. Justified from one consumer by the standard-vs-novel rule: these are stock shadcn, not an abstraction we're inventing. Clearly codex-specific items (e.g. `KeyboardPicker`) stay in codex pending review. Adds `clsx` + `tailwind-merge` as kit deps; this subpath requires Tailwind + the kit theme, which is why it is segmented from `/ui`.

The two substrates coexist on purpose: `/ui` serves every viewer Tailwind-free; `/shadcn` serves Tailwind viewers. Both are themed by the same tokens, so they stay visually identical across the boundary.

## Spacing stays split (reaffirmed)

The kit spacing scale is a **chrome/component** scale (primitive-internal padding). The codex transcript's `--remux-turn-gap`, work/row gaps, feed width, and virtualizer measurements are **content-domain** values tuned against the feed and the virtualizer; they remain codex-owned and are not pulled into the kit or the Tailwind face. Colors unify; layout rhythm does not have to.

## Out of Scope

- **Layer 6 — chat primitives (the virtualizer).** Codex's `VirtualizedTranscript` is welded to 5 codex stores, 4 codex row components, and codex types, with codex policy (user-message anchoring, streaming stickiness, work-disclosure remeasure) baked into the engine. The pure math is already factored (`virtualizerRange.ts`, `virtualizerScroll.ts`) — keep it that way. Extraction waits for a second real chat viewer (opencode/pi); the diff between the two *is* the `/chat` API. Building it from one example would generalize wrong.
- **Lifecycle / resume.** Deferred indefinitely from viewer-kit work. It will be planned as part of a larger **terminal-lifecycle + stability** effort (its own spec), where the app-owned resume signal, `useViewerResume`, and codex's `resumeSync` rewire are designed alongside terminal reliability fixes rather than in isolation. Phase 1's slice 6 is superseded by that effort.
- **Light mode, RN app-shell token source.** Unchanged from Phase 1 — still deferred, tokens stay authored light-ready.

## Slices

Each ends with `npm run typecheck` + `npm run viewers:build` green.

```text
A1  Theme generator     primitives.ts gains Tier-3 bindings; build-tokens
                        emits theme.css + Tier-3 in tokens.css; add
                        /theme.css export.                         [kit builds; no consumer change yet]
A2  Codex colors        codex imports kit tokens.css + theme.css;
                        delete its dup color block + color @theme;
                        keep --remux-* spacing, --composer, syntax;
                        resolve --primary.                         [codex builds; near-black + kit palette; rhythm unchanged]
B1  /ui confirm         formalize + document ActionBar/Button/Menu
                        as the universal primitive set.            [no behavior change; clean API surface]
B2  /shadcn             move codex Sheet/Separator/Sidebar/cn into
                        the kit; codex imports from kit.           [codex builds from kit components]
-- deferred --          layer 6 chat primitives (2nd chat viewer);
                        lifecycle/resume (terminal-lifecycle spec).
```

A1→A2 is the high-value path (codex joins the design system); B1→B2 makes the kit a library future viewers build on. A and B are independent and can interleave.

## Verification

- `npm run typecheck` + `npm run app:typecheck` after each slice; `npm run viewers:build` for all viewers.
- After A1: re-run `tokens:build` and confirm `tokens.css` / `theme.css` are deterministic (empty diff on re-run).
- After A2: launch codex, confirm near-black surfaces, status colors intact, and transcript spacing/scroll unchanged; `npm run test:codex`.
- After B2: codex renders Sheet/Sidebar/Separator identically from the kit.

## Open Decisions

- **`--primary`: white vs orange.** Codex's primary is currently white (`#ececec`) — a deliberate monochrome look. Proper shadcn semantics make `--primary` the brand action → orange (`var(--rmx-accent)`). Decision is an identity call, best made by eyeballing the composer send button. Lean: orange on the primary CTA, neutral everywhere high-frequency.
- **`/shadcn` subpath name.** Working name. Alternatives: `/ui/tw`, `/components`. Confirm before B2.
- **Kit owns `--composer` / `--chrome`?** Codex has `--composer`, `--chrome`, `--chrome-hover`. Decide whether these are shared chrome roles (promote to Tier 2/3) or stay codex-local. Default: codex-local until a second viewer needs them.
