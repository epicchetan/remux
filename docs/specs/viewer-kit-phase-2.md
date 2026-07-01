# Viewer Kit — Phase 2: Frame Depth

Status: Active Spec
Last verified: 2026-06-30
Canonical code: `packages/viewer-kit/`. Consumers: `extensions/*/viewer`. Builds over [viewer-kit.md](viewer-kit.md) (Phase 1).

## Where Phase 1 left us

Phase 1 ([viewer-kit.md](viewer-kit.md)) shipped the package and the foundation: the React-free host bridge (`/host /ipc /fs /route`), `mountViewer()`, the two-tier `--rmx-*` token system generated from `primitives.ts`, and the `/ui` primitives. The three satellite viewers (terminal, editor, markdown) were migrated, and editor/markdown were pulled onto the near-black `--rmx-surface` ladder so all three share the terminal's stage. `@remux/extension-api` / `@remux/extension-ui` were folded in and deleted.

What Phase 1 did **not** do: codex is still fully standalone (its own tokens, its own Tailwind setup, its own component copies), and the kit only speaks one styling substrate (framework-agnostic CSS). Phase 2 deepens the **frame** so codex onboards and so a fifth, more complex viewer can be built on the kit rather than beside it.

Phase 2 is deliberately scoped to the frame. The codex transcript/composer (its *content*) stays codex-owned, and lifecycle/resume is out of scope (see Out of Scope).

## The model: opt-in layers, universal → specialized

The kit is a stack of layers exposed as subpaths. A viewer imports only the layers it needs; depth is never forced. The token layer reaches all the way down — every higher layer is themed by it.

| Layer | Subpath | Imported by | Substrate |
| --- | --- | --- | --- |
| 1. Design system | `/tokens.css` `/theme.css` | everyone | CSS vars + Tailwind `@theme` |
| 2. Host bridge | `/host` `/ipc` `/fs` `/route` | anything host-connected | TS, no React |
| 3. Runtime | `/react` (`mountViewer`, host hooks) | any React viewer | React |
| 4. Chrome primitives | `/ui` (`ExtensionActionBar`/`Button`/`Menu`) | any viewer wanting consistent chrome | framework-agnostic CSS |
| 5. shadcn components | `/shadcn` (`Sheet`, `Separator`, `Sidebar`, `cn`) | Tailwind viewers | Tailwind + kit theme |
| 6. **Chat primitives** | `/chat` (headless feed/composer-chrome) | chat viewers — **deferred** | — |

A markdown viewer touches 1–4. Codex touches 1–5. The deferred layer 6 is the only one with an unproven API (see Out of Scope). Layers 4–5 are a **transitional** split, not a permanent one: the direction is Tailwind-first authored components with a raw-CSS escape hatch for engine surfaces (see Authoring model), so the plain-CSS `/ui` set converges into the Tailwind component library over time.

## Three governing rules

These decide every "kit or viewer?" and "now or later?" question in this phase and after.

1. **Mechanism vs policy.** The kit owns *mechanism* — how to theme, how to talk to the host, how to render chrome, how to window a list. The viewer owns *policy* — what a codex turn is, what *send* does, the codex protocol. A windowed list is mechanism; the row renderer is policy. When the two are entangled in one module (codex's virtualizer), that module is not yet a kit primitive.
2. **Standard vs novel abstractions.** Promote a *standard* component (shadcn's Sheet/Separator — API already proven by the ecosystem) to the kit eagerly, even from one consumer: the API risk is already retired. Defer a *novel/bespoke* abstraction (codex's hand-rolled virtualizer) until a second real consumer reveals the true seam. The rule-of-three applies to abstractions we'd be *inventing*, not ones we're *hosting*.
3. **One token source, two consumption styles — never hard-coded values.** Authored DOM uses Tailwind utilities; engine/generated DOM uses raw CSS via `var(--rmx-*)`; neither hard-codes a color. Tailwind-first is the default for everything we author; raw CSS is the principled escape hatch for surfaces we don't (see Authoring model). This is the rule Phase 1's surface unification was already obeying, and it sets the satellite-port direction.

## Authoring model: one token source, two consumption styles

The kit has a single design source. Viewers consume it two ways, and which one applies is a function of **who owns the DOM**, not which viewer it is. The whole pipeline is one directed chain:

```text
primitives.ts
  → tokens.css         --rmx-surface … ; --background: var(--rmx-surface) …   (canonical vars + shadcn names)
  → theme.css          @theme inline { --color-background: var(--background); --radius-lg: … }
  → Tailwind utilities  bg-background  text-foreground  border-border  rounded-lg
  → shared components   <Sheet className="bg-background text-foreground border-border" />
```

- **You author the DOM (your JSX/components) → Tailwind utilities.** The default. Components never hard-code colors; they use utilities that resolve to the token vars.

  ```tsx
  <Sheet className="bg-background border-border rounded-lg" />
  ```
- **You style DOM you do *not* author (engine / third-party / generated) → raw CSS rules using `var(--rmx-*)`.** xterm's `.xterm-*`, CodeMirror's `.cm-*`, and the rendered-markdown HTML tree are produced by engines — you can't hang a `className` on them, so you write CSS targeting their selectors, drawn from the same tokens.

  ```css
  .xterm-viewport { background: var(--rmx-surface); }
  ```

Same design source, two consumption styles, **no literal colors in either**. Tailwind-first is the direction; the raw-CSS path is the permanent, principled escape hatch — not a wart to migrate away.

A corollary: a viewer is often *mixed*. The markdown viewer's chrome (shell, empty state) is authored DOM → Tailwind, while its document styles (`h1`, `code`, `blockquote` over generated HTML) stay token-CSS. "Port to Tailwind" means moving the *authored* surfaces; it never means deleting the engine stylesheets.

## Track A — Theme system depth

Goal: one source (`primitives.ts`) emits the design system in **both** substrates so plain-CSS viewers and Tailwind viewers consume the identical palette.

Token tiers become three:

- **Tier 1 — primitives** (`--rmx-neutral-950`, `--rmx-orange-500`, scales). Unchanged.
- **Tier 2 — roles** (`--rmx-surface`, `--rmx-surface-raised`, `--rmx-text`, `--rmx-border`, `--rmx-accent`, …). Unchanged; the framework-agnostic semantic layer the satellites already use.
- **Tier 3 — theme bindings** (shadcn vocabulary). Each binds to a Tier-2 role, authored **once in the kit** — not a per-extension mapper.

The generator emits two artifacts:

- **`tokens.css`** — `:root` containing tiers 1–3. Everyone imports it; plain-CSS viewers stop here and use `var(--rmx-surface)` or `var(--background)`.
- **`theme.css`** — `@theme inline { --color-background: var(--background); …; --radius: …; --radius-sm/md/lg/xl: … }`. Tailwind viewers `@import` it (after `@import "tailwindcss"`) to mint `bg-background`, `border-border`, `ring-ring`, `rounded-lg`, etc. Inert for non-Tailwind viewers, so they never import it.

Tailwind face scope is **color + radius only**. Fonts stay plain vars (`--rmx-font-sans/mono`; codex consumes its own `--remux-font-*`), and spacing is excluded — the kit `space` scale is for chrome-primitive internals; codex keeps Tailwind's default spacing utilities and its own transcript rhythm (see Spacing).

### Tier-3 must be the COMPLETE set codex's `@theme inline` provides

Grounding: codex's `app.css` `@theme inline` (lines 56–86) maps **25** `--color-*` roles plus a `--radius` scale. A2 deletes that block, so A1 must reproduce every role codex's components compile against or codex breaks. Verified against `app.css` and the components in `extensions/codex/viewer/ui/`:

Kit-owned (A1 emits these; bind to Tier-2 roles, near-black ladder):

| `--color-*` role(s) | binds to | value | was (codex) |
| --- | --- | --- | --- |
| `background` | surface | `#09090b` | `#171717` |
| `foreground`, `card-foreground`, `popover-foreground`, `secondary-foreground`, `accent-foreground` | text | `#f4f4f5` | `#ececec`/`#f2f2f2` |
| `card`, `popover` | surface-raised | `#18181b` | `#202020` |
| `secondary`, `muted`, `accent` | surface-hover | `#27272a` | `#2a2a2a`/`#303030` |
| `muted-foreground` | text-muted | `#a1a1aa` | `#9ca0a8` |
| `border`, `input` | border | `#3f3f46` | `#2a2a2a`/`#303030` |
| `ring`, `link` | focus-ring | `#60a5fa` | `#8ab4f8` |
| `destructive` | danger | `#f87171` | `#f87171` (same) |
| `success` / `warning` | success / warning | `#7fd49d` / `#f5c56b` | same |
| `sidebar` / `sidebar-foreground` | surface / text | `#09090b` / `#f4f4f5` | `var(--background)` / `#ececec` |
| `primary` / `primary-foreground` | **open decision** | see below | `#ececec` / `#171717` |

Eyeball items at A2 (real value shifts, not just background): **borders lighten markedly** (`#2a2a2a → #3f3f46`) — codex's dense UI may want a subtler border; `accent` loses one lightness step (`#303030 → #27272a`); `ring`/`link` blue shifts (`#8ab4f8 → #60a5fa`). Any of these codex may override locally — the kit theme is a starting point, not a straitjacket.

`sidebar`/`sidebar-foreground` are **kit-owned (emitted in A1)**, not codex-local: they are standard shadcn sidebar roles (`sidebar → surface`, `sidebar-foreground → text`) and are referenced by the `Sheet`/`Sidebar` components that move to the kit in B2 — a kit-hosted component may only depend on kit-owned roles, so they must exist before the move, and A2 deletes codex's copies. The other six shadcn `sidebar-*` sub-roles (`sidebar-primary`, `sidebar-accent`, `sidebar-border`, `sidebar-ring`, …) have no consumer and are omitted until one appears.

Codex-local (A1 does **not** emit; codex keeps a small local `@theme inline` extension): `chrome`, `chrome-hover` (codex's blue-tinted bottom-bar surfaces — not a standard shadcn role), and `--composer` (a plain var, never a `--color-*`). These are referenced only by codex's own components, never by a moved one, so they stay codex-local indefinitely unless a second viewer needs them.

### Codex color onboarding (the payoff)

Codex's `app.css` collapses to import-and-extend:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "@remux/viewer-kit/tokens.css";   /* tiers 1–3 */
@import "@remux/viewer-kit/theme.css";    /* Tailwind color + radius utilities */

:root {
  /* codex-only, untouched: transcript rhythm, composer, fonts, syntax palettes */
  --remux-turn-gap: 20px;  --remux-block-gap: 20px;  --composer: var(--card);
  --chrome: #1f232b;  --chrome-hover: #272b34;
}
@theme inline {
  /* codex-only color roles the kit doesn't own */
  --color-chrome: var(--chrome);
  --color-chrome-hover: var(--chrome-hover);
}
```

A2 deletes only the `--color-*` block + `:root` color tokens the kit now provides; codex keeps `--remux-*` spacing/type, `--composer`, `--chrome*`, fonts, and syntax-highlight palettes. Its shadcn components keep working because the kit speaks their names.

## Track B — Component library

Goal: the kit is a real, token-themed component library you import — never shadcn's copy-the-tsx model.

- **B1 — Universal chrome primitives (`/ui`).** The set already exists and is exported as `ExtensionActionBar`, `ExtensionActionButton`, `ExtensionActionMenu`, `ExtensionActionMenuItem` (`src/ui/index.ts`). B1 is the API-naming + docs step: the `Extension*` prefix is a fossil of the deleted `@remux/extension-ui`. **Rename to `ActionBar`/`ActionButton`/`ActionMenu`/`ActionMenuItem`, re-export the `Extension*` names as deprecated aliases for one cycle**, and update the three satellite consumers. No behavior change. The plain-CSS internals here are transitional — the satellite Tailwind port will re-author them in utilities — but the export names set now are the **durable public API** that survives the substrate change, so the rename is not wasted work.
- **B2 — shadcn component set (`/shadcn`).** Host codex's generic shadcn components so future complex viewers get them. Justified from one consumer by the standard-vs-novel rule. Concretely:
  - **New deps on the kit:** `@radix-ui/react-dialog` (Sheet), `clsx` + `tailwind-merge` (`cn`). `class-variance-authority` is **not** needed — the moved components use `cn` only (verified).
  - **Peer/setup requirement** (documented in the package README, since the kit cannot bundle CSS-layer imports): a `/shadcn` consumer must `@import "tailwindcss"`, `@import "tw-animate-css"` (Sheet's `animate-in`/`slide-*`/`fade-*` classes), and the kit `theme.css`.
  - **Tailwind `@source` for the moved TSX (critical).** Tailwind v4 only generates utilities for class strings it *scans*, and it excludes `node_modules` by default. Codex's `@source "./**/*.{ts,tsx}"` (`app.css:4`) covers only its own tree — once `Sheet`/`Sidebar` live in the kit, their `bg-sidebar` / `slide-in-from-left` strings go unscanned and the components render **unstyled**. Each `/shadcn` consumer must add a source for the kit, e.g. `@source "../../../node_modules/@remux/viewer-kit/src/shadcn/**/*.{ts,tsx}";` (resolves through the workspace symlink; confirm the exact relative path against hoisting at implementation). Alternative considered: ship a pre-built `shadcn.css` from the kit instead of relying on consumer scanning — heavier, deferred unless scanning proves fragile.
  - The `sidebar`/`sidebar-foreground` roles already exist (kit-owned, A1), so no role work is needed at move time.
  - **Move:** `cn`, `Separator` (border only — zero new deps), `Sidebar` (`bg-sidebar`, kit role), `Sheet` (radix + tw-animate). `KeyboardPicker` is codex-specific and **stays in codex**.
  - Codex imports these from `@remux/viewer-kit/shadcn`, deletes its `ui/` copies (except `KeyboardPicker`), and adds the `@source` line above.

The two substrates are **transitional, not a permanent split**: Tailwind-first (see Authoring model) is the destination, and the plain-CSS `/ui` primitives persist only until the satellite Tailwind port retires them into the Tailwind library. The public component API (export names, props) is stable across that change — a viewer importing `ActionBar` doesn't care whether it's authored in BEM CSS today or Tailwind tomorrow. Until then, `/ui` serves Tailwind-free viewers and `/shadcn` serves Tailwind viewers; both draw from the same tokens, so they stay visually identical.

## Spacing stays split (reaffirmed)

The kit spacing scale is a **chrome/component** scale (primitive-internal padding). The codex transcript's `--remux-turn-gap`, work/row gaps, feed width, and virtualizer measurements are **content-domain** values tuned against the feed and the virtualizer; they remain codex-owned and are not pulled into the kit or the Tailwind face. Colors unify; layout rhythm does not have to.

## Out of Scope

- **Layer 6 — chat primitives (the virtualizer).** Codex's `VirtualizedTranscript` is welded to 5 codex stores, 4 codex row components, and codex types, with codex policy (user-message anchoring, streaming stickiness, work-disclosure remeasure) baked into the engine. The pure math is already factored (`virtualizerRange.ts`, `virtualizerScroll.ts`) — keep it that way. Extraction waits for a second real chat viewer (opencode/pi); the diff between the two *is* the `/chat` API.
- **Lifecycle / resume.** The app-owned activation signal already exists: the app emits `host/active` from `ActiveSurface`'s intra-app `visible` state (`ExtensionWebView.tsx`), `/host` exposes `subscribeHostActive`, and **terminal already consumes it** to resync on background→foreground (`TerminalSurface.tsx`). So this is not greenfield. What remains out of scope here: codex's `resumeSync.ts` still listens to `document.visibilitychange` and should be reconciled onto `host/active`, and the kit may add an ergonomic `/react` hook (e.g. `useViewerResume`) wrapping `subscribeHostActive`. Both are deferred into the larger **terminal-lifecycle + stability** effort (its own spec), not done under Phase 2. (This supersedes Phase 1's slice 6, whose "the signal is future" framing predates `host/active`.)
- **Later: satellite Tailwind port (substrate convergence).** The direction (governing rule 3) is to author most viewer *chrome* in Tailwind — editor, markdown, and the terminal shell — so the shared component library becomes one Tailwind-first set and the plain-CSS `/ui` primitives retire. **Deferred past Phase 2** and sequenced after the frame lands. Each satellite gains the Tailwind setup (`@import "tailwindcss"`, the kit `theme.css`, an `@source` for kit components) and re-authors its chrome with utilities, while its **engine surfaces stay token-CSS** — xterm `.xterm-*`, CodeMirror `.cm-*`, and rendered-markdown HTML are not component DOM and keep their `var(--rmx-*)` stylesheets. Only the *authored* surfaces move; the public component API is stable across the change. Now tracked in [viewer-kit-phase-3.md](viewer-kit-phase-3.md) as the optional substrate-convergence sequel (Phase 4) to theme-readiness — which itself only requires ownership classification + dark-side tokenization, and is substrate-neutral.
- **Light mode.** Now specced separately in [viewer-kit-light-mode.md](viewer-kit-light-mode.md) (system-tied `prefers-color-scheme`, semantic-tier remap). No longer deferred. **RN app-shell token source** (a JS token export from `primitives.ts`) stays deferred; tokens stay authored light-ready.

## Slices

Each ends with `npm run typecheck` + `npm run viewers:build` green.

```text
A1  Theme generator     primitives.ts gains Tier-3 (full shadcn color set
                        incl. sidebar + radius); build-tokens emits theme.css
                        + Tier-3 in tokens.css; add /theme.css export.  [kit builds; tokens deterministic; no consumer change]
A2  Codex colors        codex imports kit tokens.css + theme.css; delete its
                        dup :root color block + color @theme; keep --remux-*,
                        --composer, --chrome*, fonts, syntax; resolve --primary. [codex builds; near-black + kit palette; rhythm unchanged]
B1  /ui rename          rename Extension* -> ActionBar/Button/Menu(+Item) with
                        deprecated aliases; update satellites; document.        [no behavior change; clean API]
B2  /shadcn             add /shadcn export + radix/clsx/tailwind-merge deps;
                        move cn/Separator/Sidebar/Sheet; codex imports from kit,
                        adds @source for kit shadcn; document tw-animate peer.    [codex builds from kit components, fully styled]
-- deferred --          layer 6 chat primitives (2nd chat viewer);
                        lifecycle/resume (terminal-lifecycle spec).
```

A1→A2 is the high-value path (codex joins the design system); B1→B2 makes the kit a library future viewers build on. A and B are independent and can interleave.

## Verification

- `npm run typecheck` + `npm run app:typecheck` after each slice; `npm run viewers:build` for all viewers.
- After A1: re-run `tokens:build`; confirm `tokens.css` / `theme.css` are deterministic (empty diff on re-run). Diff `theme.css`'s `--color-*` set against codex's current `@theme inline` (lines 61–85) and confirm every role — including `sidebar`/`sidebar-foreground` — is present except the codex-local pair `chrome`/`chrome-hover`.
- After A2: `git grep -h "bg-\|text-\|border-\|ring-" extensions/codex/viewer` sanity — every utility resolves to a kit-provided or codex-local token (no undefined var). Launch codex; confirm near-black surfaces, status colors intact, transcript spacing/scroll unchanged; `npm run test:codex`.
- After B2: codex renders `Sheet`/`Sidebar`/`Separator` identically from the kit. Prove Tailwind scanned the kit source — grep the built codex CSS for a class that appears *only* in the moved components (e.g. `.bg-sidebar`, `.slide-in-from-left`); its presence confirms the `@source` line works, its absence means scanning is broken and the components are unstyled.

## Open Decisions

- **`--primary`: white vs orange.** Codex's primary is white (`#ececec`, dark text). Proper shadcn semantics make `--primary` the brand action → `primary: var(--rmx-accent)` (orange `#f97316`) with `primary-foreground: var(--rmx-accent-foreground)` (`#fff7ed`). White keeps `primary: var(--rmx-text)` / `primary-foreground: var(--rmx-surface)`. Identity call; eyeball the composer send button. Lean: orange on the primary CTA, neutral everywhere high-frequency.
- **Radix dependency placement.** `@radix-ui/react-dialog` as a kit `dependency` (simple, workspace dedups) vs `peerDependency` (avoids any chance of duplicate React-context copies breaking Radix portals). Lean: `dependency`, revisit if a second Tailwind viewer hoists a different Radix version.
- **`/shadcn` subpath name.** Working name. Alternatives: `/ui/tw`, `/components`. Confirm before B2.
- **`chrome` / `composer` ownership.** Stay codex-local by default (no kit component needs them). Promote to shared roles only when a second viewer does.
