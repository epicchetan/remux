# Viewer Kit — Phase 3: Theme-readiness & ownership

Status: Active Spec
Last verified: 2026-07-01
Canonical code: `packages/viewer-kit/`, `extensions/{terminal,editor,markdown,codex}/viewer`. Builds over [viewer-kit-phase-2.md](viewer-kit-phase-2.md). **Prerequisite for** [viewer-kit-light-mode.md](viewer-kit-light-mode.md) — see **Ownership boundary**. Absorbs Phase 2's deferred satellite Tailwind port as an **optional sequel** (Phase 4), never as a completion requirement.

## Goal

Phase 3 makes every existing viewer **theme-ready** by removing **unowned dark-only styling**. That is the whole job — it is the prerequisite that lets light mode add light values without re-auditing. It is explicitly **not** "all extensions must use only kit tokens," and **not** Tailwind parity.

A viewer is **theme-ready** when there are **no unowned dark-only color literals in theme-sensitive surfaces**:

- **Shared frame/chrome colors route through kit roles** (`var(--rmx-*)`).
- **Viewer/domain-specific colors become named viewer-owned theme extensions** — dark values now, light values planned in [viewer-kit-light-mode.md](viewer-kit-light-mode.md).
- **Engine palettes are explicit theme objects or theme adapters**, not scattered literals. They may stay **viewer-owned** when the engine/domain owns them.

"Theme-ready" is **substrate-neutral**: a plain-CSS viewer that consumes tokens correctly is fully onboarded. Moving a viewer's authoring substrate onto codex's Tailwind is a separate optional sequel, not part of "done."

## Ownership model

Every theme-sensitive color gets classified into one of three tiers. The codebase already encodes the first two tiers in its naming, which we adopt as the convention:

- **Tier 1 — kit-owned roles** → the `--rmx-*` namespace (plus the shadcn `--background`/`--card`/… bindings). Common frame/chrome/design-system, shared across viewers:
  `surface`, `surface-raised`, `surface-hover`, `border`, `border-subtle`, `overlay`, `text`, `text-muted`, `accent`, `accent-strong`, `accent-foreground`, `focus-ring`, `danger`, `success`, `warning`, and `code-bg` / `code-border` / `code-text` (reused by editor + markdown + codex code containers).
- **Tier 2 — viewer-owned theme extensions** → the `--remux-*` namespace (distinct from kit `--rmx-*` — note `remux` vs `rmx` — so ownership is visible in the name). Specific to one viewer/domain but still theme-sensitive:
  codex `--chrome`/`--chrome-hover`/`--composer`, terminal ANSI/xterm palette, editor syntax/merge/diff palette (if not promoted), markdown alert/prose palette (where too markdown-specific), future trading-engine colors.
  **Namespace rule:** *new* extensions use `--remux-<viewer>-*` (e.g. `--remux-editor-syntax-*`, `--remux-markdown-alert-*`) so ownership is unambiguous. Pre-convention vars are **grandfathered — not renamed in Phase 3**: codex's bare `--chrome`/`--chrome-hover`/`--composer` and its un-infixed `--remux-*` domain vars (`--remux-turn-gap`, …), terminal's `--remux-terminal-*`/`--remux-extension-*`. They are already named and viewer-owned, which is all theme-readiness needs; an optional future rename would also have to update codex's `@theme inline` alias (`--color-chrome`), so it stays out of scope here.
- **Tier 3 — engine / generated-DOM styles** → named JS theme objects or scoped CSS. May stay raw, but must be **named** and carry an explicit **dark/light story** (an extension point light mode can flip):
  xterm theme object, CodeMirror theme + `HighlightStyle`, Shiki themes, Mermaid theme config.

The classifying question for a literal: *is it shared frame (→ Tier 1), one viewer's domain (→ Tier 2), or baked by an engine that can't read CSS (→ Tier 3)?* Promotion to Tier 1 requires ≥2 real consumers or a true frame/chrome role; otherwise it stays Tier 2.

## Allowed literals

"No unowned dark-only literals" is not "no literals." These are explicitly allowed and are **not** findings:

- **`transparent` / `black` / `white` (and `rgb(0 0 0 / N%)` / `rgb(255 255 255 / N%)`)** — only as **opacity/shadow math that is not theme-sensitive**. If the literal must flip between themes (e.g. a white-on-dark veil that becomes black-on-light), it must be wrapped in a semantic token (`--rmx-border-subtle`, `--rmx-overlay`) — that is precisely what those roles are for.
- **Brand constants** (orange, status hues) — allowed **only through tokens or named viewer theme vars**, never as bare hex in a rule.
- **Engine palette literals** — allowed **only inside a named theme object** that has (or is wired to gain) dark/light counterparts.

## Implementation inventory (starting map — T0 finalizes)

Grounded from the Phase-2/light-mode audits; representative literals, not exhaustive (T0 produces the authoritative version).

| Surface | Current literals (representative) | Owner after Phase 3 | Action in Phase 3 | Light-mode follow-up |
| --- | --- | --- | --- | --- |
| **Terminal chrome CSS** `terminal/…/styles.css` | `#09090b`, `#f4f4f5`, `--remux-extension-{background #09090b, chrome #18181b, chrome-hover #27272a, border #3f3f46, muted-foreground #a1a1aa}`, spinner `#f97316` | **Tier 1 kit roles** | replace literals with `var(--rmx-*)`; **collapse `--remux-extension-*`** to kit-role aliases, then remove | none — roles flip |
| **xterm theme** `TerminalSurface.tsx:801-822` | 19-color ANSI literal (`background #09090b`, `red #f87171`, `cursor #f97316`, …) | **Tier 2/3 terminal-owned engine palette** | extract inline literal → named `terminalThemeDark` object | light adds `terminalThemeLight` + `matchMedia` adapter |
| **Editor chrome CSS** `editor/…/styles.css` | text `#e4e4e7`, gutter `#71717a`, empty `#f4f4f5`/`#a1a1aa`, spinner `#f97316`, diff alphas `rgb(34 197 94 / 28%)`…, deleted `#fecaca` | **Tier 1 kit roles** (chrome + diff via `danger`/`success`/`focus-ring`) | tokenize → `var(--rmx-*)` and `color-mix(var(--rmx-<status>) N%, transparent)` | none |
| **CodeMirror theme/highlight** `CodeMirrorViewer.tsx:40-58` | `EditorView.theme({}, { dark: true })` + 13 syntax hexes | **Tier 2 editor-owned syntax ext + Tier 3 adapter** | move 13 colors → named `--remux-editor-syntax-*` (dark), consumed by `HighlightStyle` | light adds syntax light values **and** a `Compartment`/adapter to flip the `dark` flag (colors alone don't) |
| **Markdown prose CSS** `markdown/…/styles.css` | headings `#fafafa`, body `#e4e4e7`, link `#93c5fd`, blockquote `#3f3f46`/`#c4c4cc`, tables/footnotes, veils `rgb(255 255 255 / 8%)` | **Tier 1 kit roles** (`text`/`text-muted`/`border`/`focus-ring` + `border-subtle`/`overlay` + `code-*`) | tokenize prose frame → kit roles | none |
| **Markdown alerts** (note/tip/important/warning/caution) | blue / green / **purple `#a78bfa`** / amber / red + title & bg tints | **Tier 2 markdown-owned ext** | move → named `--remux-markdown-alert-*` (dark); alias kit status roles where the hue matches (`caution→danger`, `tip→success`, `warning→warning`, `note→focus-ring`); **own the purple `important`** locally | light adds alert light values |
| **Shiki** markdown `codeToHtml theme:'github-dark'`; codex `codeThemes.dark:'github-dark-default'` | bundled theme-name literals | **Tier 3 engine palette** | name the theme constant (markdown's inline string → named); single dark theme now | light adds a light theme + dual-theme CSS-var switching |
| **Mermaid** `MermaidBlock.tsx:88,92` | `theme:'dark'`, `darkMode:true` | **Tier 3 engine palette** | make the config a named constant with the dark setting explicit | light adds `matchMedia` swap + re-render |
| **Kit `/ui/styles.css`** | action-bar border `rgb(255 255 255 / 8%)`, primary `#c45424`/`#f97316`/`#8f2f13`/`#9f3a16`/`#5f1d0d`, danger `#fecaca`/`#fca5a5`, hover `#f4f4f5`/`#ffffff` | **Tier 1 kit roles** | **tokenize fully** → `accent*`/`--rmx-primary-*`/`danger`/`border-subtle`/`text`/shadow roles; residual pure opacity-math literals documented as Allowed | shadows may gain light variants (light-mode) |
| **Codex send button** `codex/…/styles.css:1773-1808` | `#9f3a16`/`#c45424`/`#8f2f13`/`#5f1d0d`/`#fff7ed`; blends `var(--warning)` | **Tier 1 via shared button tokens** | re-express through `--rmx-primary-*` + `accent*` (mechanism in T2); ruleset stays in codex CSS, hex removed — **not** a shared component | none — button palette is kit-owned |
| **Codex chrome** `--chrome #1f232b`/`--chrome-hover #272b34`; folder icon `#a8b0bf` | named `--chrome*` vars (grandfathered namespace) + one SVG stroke literal | **Tier 2 codex-owned ext** | keep `--chrome*`/`--composer` as-is — grandfathered, already named viewer-owned (no rename in Phase 3); route folder-icon stroke through `text-muted` or a codex var | light adds codex `--chrome*` + icon light values |

## Completion criteria

Phase 3 is complete when:

1. every satellite viewer imports kit tokens and **uses kit roles for shared frame/chrome**;
2. any remaining color literals are **either non-theme-sensitive (Allowed) or moved into named viewer-owned theme extensions / engine palettes**;
3. **duplicated chrome that is clearly shared is extracted, or explicitly deferred with a written rationale**;
4. the **light-mode spec can add light values without rediscovering ownership** — every theme-sensitive color has a named home and a stated dark/light story.

**Tailwind convergence is not part of "done"** (see Optional sequel). A plain-CSS viewer that satisfies 1–4 is fully onboarded.

## Ownership boundary with light mode

- **Phase 3 owns ownership + the dark side:** classification, kit-role additions, viewer-extension naming, engine-palette extraction — all with **dark values only**.
- **Light mode owns the light side:** light values for every role/extension, the `@media (prefers-color-scheme: light)` remap, engine light palettes (xterm/CodeMirror/Shiki/Mermaid), and the RN/native flash fixes.
- **[viewer-kit-light-mode.md](viewer-kit-light-mode.md) is revised *after* Phase 3** to consume this ownership map instead of re-auditing from scratch — its current S0–S2 (token-adding + satellite/`/ui` de-hardcoding) collapse into Phase 3's map; it keeps only light values + engines + shell. That revision is deferred (per prior decision) and not made here.

Mental model: **Phase 3 = give every theme-sensitive color a named owner and a dark value; light mode = give each owner a light value and wire the switch.**

## Staged plan

Each stage ends with the Verification suite green.

- **T0 — Inventory & ownership map.** Produce the authoritative surface table (above is the seed). Classify **every** theme-sensitive literal as: kit role, viewer extension, engine palette, or allowed non-theme literal. Output is the contract the rest of Phase 3 (and light mode) executes against.
- **T1 — Kit token additions.** Add **only** the common roles that ≥2 viewers or true frame/chrome need: `--rmx-border-subtle`, `--rmx-overlay`, `--rmx-code-bg`, `--rmx-code-border`, `--rmx-code-text`, and a `--rmx-primary-*` raised-button group — `--rmx-primary-border` (`#9f3a16`), `--rmx-primary-edge` (`#8f2f13`, gradient foot), `--rmx-primary-shadow` (`#5f1d0d`), the deep-orange physicality shades with no existing role (as roles, or `color-mix(var(--rmx-accent-strong) …, black)`); the fill/label reuse existing `accent`/`accent-foreground`. All dark values. Regenerate deterministically from `primitives.ts`. **Keep `theme.css` stable** — these are CSS-var roles for plain-CSS consumers; no new Tailwind utilities unless a Tailwind viewer needs them (no role-name changes).
- **T2 — Shared `/ui` cleanup.** Tokenize `/ui/styles.css` fully. **Consolidate the primary button via shared tokens, not a shared component.** Codex does not import `/ui/styles.css` (its send button is codex-local CSS), so a shared CSS class or a React/Tailwind `<Button>` is out of Phase-3 scope — that is Phase 4. Instead, both `.remux-extension-action-button-primary` (kit `/ui`) and codex's `.remux-composer-send-button` re-express their gradient/border/shadow through the `--rmx-primary-*` + `accent`/`accent-foreground` tokens; the duplicated hex literals are deleted from **both rulesets, which stay where they live**. (The copies have already drifted — kit blends `#f97316`, codex blends `var(--warning)`; T2 unifies both on the canonical kit recipe, so tokenizing also de-drifts them.) **Public component export names/props stay stable** (Phase 2 B1).
- **T3 — Satellite chrome tokenization.** Terminal/editor/markdown **frame & chrome** CSS consume kit roles (or viewer-extension vars). Terminal's `--remux-extension-*` becomes thin aliases to kit roles, then is removed.
- **T4 — Viewer-owned extensions & engine adapters.** Introduce the named **dark** theme objects/vars: `terminalThemeDark` (xterm), `--remux-editor-syntax-*` + CodeMirror wiring, `--remux-markdown-alert-*`, named Shiki/Mermaid constants. **Do not add light values here** unless light mode is being implemented immediately — just make ownership and the extension points clean.
- **T5 — Handoff to light mode.** Revise [viewer-kit-light-mode.md](viewer-kit-light-mode.md) to consume the T0 map. Light mode then adds light values and the media-query/engine switching. **Required reconciliations** (light-mode predates this spec and names tokens that Phase 3 has since settled): it names only `--rmx-code-bg` → add `--rmx-code-border` / `--rmx-code-text`; it lists a kit `--rmx-syntax-*` group → replace with editor-owned `--remux-editor-syntax-*` (syntax is Tier 2 here, not a kit role); and fold its S0–S2 into this map.

## Verification

- `npm run typecheck`
- `npm run app:typecheck`
- `npm run viewers:build`
- `npm run test:codex`
- Per viewer: grep/audit that every **remaining** color literal is either inside a **named theme object/extension** or matches the **Allowed literals** rules — no unowned dark-only literal in a theme-sensitive surface.

## Optional sequel — substrate convergence (Tailwind) [Phase 4]

**Not required for onboarding.** The follow to Phase 2's deferred satellite Tailwind port; most valuable for **editor/markdown**, and **terminal (≈all engine CSS) likely opts out.** If pursued, each satellite: add `@tailwindcss/vite` + `tailwindcss` (+ `tw-animate-css` only if it adopts shadcn animations) and wire `tailwindcss()` into its `vite.config.ts` (today `plugins: [react()]`; codex is `[react(), tailwindcss()]`); `@import "tailwindcss"` + `theme.css` + an `@source` for any moved kit components; re-author authored chrome in utilities with export names/props stable; **engine surfaces stay raw CSS via tokens.**

## Out of scope

- **Engine *light* themes / light values** — [viewer-kit-light-mode.md](viewer-kit-light-mode.md). Phase 3 only names the dark palettes and their extension points.
- **Codex refactors** beyond consolidating the shared primary button and routing the folder-icon stroke — codex is already onboarded; its domain roles (`--chrome*`, composer) stay viewer-owned.
- **New viewer features / a fifth viewer.**
