# Viewer Kit — Light Mode (system-tied)

Status: Active Spec
Last verified: 2026-07-01
Canonical code: `packages/viewer-kit/src/tokens/`, `extensions/*/viewer`, `app/`. Builds over [viewer-kit.md](viewer-kit.md) (Phase 1) and [viewer-kit-phase-2.md](viewer-kit-phase-2.md) (Phase 2). Supersedes Phase 1's "light mode deferred; tokens stay authored light-ready" note.

## Goal & constraints

Ship a light theme that is **as polished and legible as dark** — the user runs this outdoors a lot, so light mode is a first-class surface, not a fallback. Constraints:

- **System-tied only.** Driven by `@media (prefers-color-scheme: light)`. No in-app toggle, no persistence, no theme picker. When the OS is light, the app is light.
- **One token source.** Reuses the Phase 1/2 pipeline (`primitives.ts → tokens.css → theme.css`). Light mode is a **remap of the semantic tier**, emitted as a media-query block — Tier-3 (shadcn) and `theme.css` need **zero** changes (they resolve through Tier-2 at use-site).
- **Outdoor-grade legibility.** Every text/role pair is chosen to match the *dark* theme's contrast ratio (muted text ≈ 7:1, body ≈ 17:1 in both), so light isn't a washed-out afterthought.

## What the audit found (grounded inventory)

The token *architecture* is light-ready (the semantic tier is the only remap point). The *consumers* are not: a repo grep finds only ~17 `var(--rmx-*)` references across the three satellite viewers — the rest **inline the dark token values as raw hex**. So most "dark-locked" surfaces are just duplicated dark tokens, and the fix is to route them back through tokens (which also removes the duplication debt and satisfies Phase 2's governing rule 3, "no hard-coded values"). A minority are genuine engine palettes that can't read CSS vars.

Two categories:

**(1) Token-driven — flips for free once it uses a role.** Codex is almost entirely here (Phase 2 put it on shadcn tokens; ~100+ `var(--*)` rules, incl. diff colors via `var(--success/destructive/link)`). Editor/markdown/terminal use tokens only for a handful of surfaces (`var(--rmx-surface)` on shells/bodies).

**(2) Dark-locked — needs explicit light handling.** Grounded sites:

| Surface | Where | Why locked |
| --- | --- | --- |
| Terminal xterm ANSI theme (19 colors) | `terminal/…/TerminalSurface.tsx:801-822` | static JS literal; xterm renders to canvas, can't read CSS vars |
| Terminal shell/keys/tmux CSS | `terminal/…/src/styles.css` (`:root`, `.remux-terminal-*`, local `--remux-extension-*` vars, `.xterm-viewport` bg) | inlined dark hex, duplicates tokens instead of referencing them |
| CodeMirror theme + 13 syntax colors | `editor/…/CodeMirrorViewer.tsx:40-58` | `EditorView.theme({}, { dark: true })` + static `HighlightStyle.define` |
| Editor CSS (text, gutter, diff line bg, empty state) | `editor/…/src/styles.css` | inlined hex + status-hue alphas (`rgb(34 197 94 / 28%)` …) |
| Markdown Shiki | `markdown/…/MarkdownCodeBlock.tsx:56-59` | `codeToHtml(…, { theme: 'github-dark' })` bakes colors into HTML |
| Markdown Mermaid | `markdown/…/MermaidBlock.tsx:88,92` | `theme: 'dark'`, `darkMode: true` bakes SVG colors |
| Markdown CSS (40+ literals: headings, links, blockquote, 5 alert schemes, tables, footnotes, code, hr, images) | `markdown/…/src/styles.css` | inlined hex + heavy use of `rgb(255 255 255 / N%)` white-alpha veils (invisible on light) |
| Kit UI primitives (primary button gradient, danger, ActionBar border, hover text) | `packages/viewer-kit/src/ui/styles.css` (`#c45424/#f97316/#8f2f13`, `#fecaca/#fca5a5`, `rgb(255 255 255 / 8%)`) | inlined hex in the shared component CSS |
| Codex Shiki | `codex/…/codeHighlight.ts:3,20-22`, `CodeBlock.tsx:18` | `type CodeHighlightTheme = 'dark'`, only `github-dark-default`; custom token renderer |
| Codex send button + folder icon | `codex/…/styles.css:1773-1808`, `composer/editor/nodes.tsx:279` (`#a8b0bf`) | inlined orange gradient (dup of kit button) + SVG stroke |
| App shell (RN) — dark flash risk | `app/app.json` (`userInterfaceStyle:"dark"`, splash `#000000`), `app/App.tsx:19` (`StatusBar style="light"`), `app/src/theme/tokens.ts` (`background:#000000`), webview/native bgs | native chrome behind/around the webview is hard-dark; would flash black on load in light |
| Per-viewer `theme-color` metas | `*/viewer/index.html` (codex `#171717`, editor `#18181b`, terminal `#09090b`) | static dark address-bar/status color |

Also confirmed: `color-scheme: dark` is globally set (`tokens.css:5`) and must flip; codex's `@custom-variant dark (&:is(.dark *))` is **vestigial** (no `.dark` class is ever applied at runtime, no `dark:` utilities used) — so the media-query approach needs no `.dark` wiring and that line can be dropped.

## Strategy

**Route through tokens, then remap once.** Convert inlined literals to `var(--rmx-*)` / `color-mix(var(--rmx-*) N%, transparent)`; then the single Tier-2 light remap flips them all. Only true engine palettes (xterm, CodeMirror syntax, Shiki, Mermaid) get a parallel light palette because they can't consume CSS vars at paint time.

Engine dispositions (chosen to avoid runtime churn where possible):

- **CodeMirror → token-driven.** Move the 13 syntax colors and chrome onto new `--rmx-syntax-*` semantic tokens; wrap the `{ dark: true }` flag in a `Compartment` toggled by `matchMedia`. Result: syntax **flips for free**; only the internal dark-flag reconfigures.
- **Shiki (markdown, `codeToHtml`) → dual theme.** `themes: { light: 'github-light-default', dark: 'github-dark-default' }` with `defaultColor: false`; Shiki emits both colors as `--shiki`/`--shiki-dark` CSS vars, toggled by a **media-query** CSS rule (no JS, no `.dark` class). Cache key includes both theme names.
- **Shiki (codex, `codeToTokens` custom renderer) → dual variants.** Switch to `codeToTokensWithThemes({ themes: { light, dark } })`; emit `color: var(--shiki)` + `--shiki-dark` per span, flipped by the same media-query rule. Keeps codex's virtualizer stable — no re-highlight/remeasure on theme change. `CodeHighlightTheme` type drops (both always emitted).
- **xterm → matchMedia swap.** Provide a light ANSI palette; on `prefers-color-scheme` change set `terminal.options.theme = …`. Irreducible JS listener (canvas). One `matchMedia` subscription.
- **Mermaid → matchMedia re-render.** Swap `theme: 'default'/'neutral'` and re-render affected diagrams on change.

## Proposed palette — zinc + orange, the light counterpart

Same brand family as dark (neutral = zinc, brand = orange), so the two themes read as one product. Elevation **mirrors** dark: dark raises surfaces *toward light*; light raises them *toward white* (canvas → white cards). Status hues **deepen** for legibility on white (dark uses pastels that pop on black; light uses saturated `-600/-700` that pass AA on white). Contrast ratios are tuned to *match* dark, not merely pass.

### Tier 1 — primitives to ADD (theme-independent)

```
neutral-0:   #ffffff      neutral-300: #d4d4d8      neutral-600: #52525b
neutral-50:  #fafafa      neutral-500: #71717a
neutral-200: #e4e4e7
blue-600:  #2563eb   red-600: #dc2626   green-700: #15803d   amber-700: #b45309
```

Orange is unchanged — `accent`/`accent-strong`/`accent-foreground` (`#f97316`/`#c45424`/`#fff7ed`) stay identical in both themes. `#c45424` already clears AA on white (5.4:1), so orange-as-text needs no new primitive, and the orange primary CTA can stay visually identical across themes (brand anchor; only its shadow softens).

### Tier 2 — semantic remap (dark unchanged; light emitted in the media block)

| Role | Light | primitive | Dark (ref) | Light contrast |
| --- | --- | --- | --- | --- |
| `surface` | `#fafafa` | neutral-50 | `#09090b` | app canvas |
| `surface-raised` | `#ffffff` | neutral-0 | `#18181b` | cards pop off canvas |
| `surface-hover` | `#f4f4f5` | neutral-100 | `#27272a` | hover / muted fill |
| `border` | `#e4e4e7` | neutral-200 | `#3f3f46` | hairline |
| `text` | `#18181b` | neutral-900 | `#f4f4f5` | 16.9:1 on canvas |
| `text-muted` | `#52525b` | neutral-600 | `#a1a1aa` | 7.0:1 (matches dark's 7:1) |
| `accent` | `#f97316` | orange-500 | same | fills |
| `accent-strong` | `#c45424` | orange-700 | same | orange text/links 5.4:1 |
| `accent-foreground` | `#fff7ed` | orange-50 | same | on-orange label |
| `focus-ring` / `link` | `#2563eb` | blue-600 | `#60a5fa` | 5.2:1 (AA) |
| `danger` | `#dc2626` | red-600 | `#f87171` | 4.8:1 (AA) |
| `success` | `#15803d` | green-700 | `#7fd49d` | 4.7:1 (AA) |
| `warning` | `#b45309` | amber-700 | `#f5c56b` | 5.5:1 (AA) |

Body text is `zinc-900 #18181b`, not pure black — the symmetric counterpart to dark's off-white `zinc-100` text (both one step off the extreme; softer for long reading, still ~17:1). See Open Decisions for the pure-black and pure-white-base alternatives.

### New semantic tokens (both themes — to retire the alpha literals so they flip)

The white-alpha veils (`rgb(255 255 255 / 8%)`) are dark-only constructs (invisible on light). Promote them to sign-flipping tokens:

```
--rmx-border-subtle:  dark rgb(255 255 255 / 8%)   | light rgb(0 0 0 / 8%)
--rmx-overlay:        dark rgb(255 255 255 / 10%)  | light rgb(0 0 0 / 8%)
--rmx-code-bg:        dark var(--rmx-surface-raised)| light var(--rmx-surface-hover)
```

Status-hue alphas (`rgb(34 197 94 / 28%)` etc.) become `color-mix(in srgb, var(--rmx-success) 28%, transparent)` — they then flip for free using the light hue.

### Syntax palette (new `--rmx-syntax-*` group — CodeMirror consumes directly)

| token | dark (current CM) | light |
| --- | --- | --- |
| `comment` | `#71717a` | `#8a8f98` |
| `keyword` | `#c084fc` | `#8250df` |
| `string` | `#86efac` | `#0a7b34` |
| `number` | `#f59e0b` | `#b45309` |
| `function` | `#7dd3fc` | `#0550ae` |
| `type` | `#fbbf24` | `#953800` |
| `variable`/`name` | `#e4e4e7` | `#1f2328` |
| `operator` | `#a1a1aa` | `#57606a` |
| `tag`/`heading` | `#fb7185` | `#c2185b` |
| `link` | `#60a5fa` | `#0550ae` |

(A GitHub-light-derived palette so CodeMirror and Shiki's `github-light-default` read consistently. Unifying Shiki onto `--rmx-syntax-*` via a custom Shiki theme is a possible later refinement, not required now.)

### Shadows — light variants (soft/diffuse; no white inset)

Dark's skeuomorphic inset-highlight shadows read wrong on white. Light emits soft diffuse drops:

```
shadow-raised:  0 1px 2px rgb(0 0 0 / 0.06), 0 1px 1px rgb(0 0 0 / 0.04)
shadow-pressed: inset 0 1px 2px rgb(0 0 0 / 0.10)
shadow-menu:    0 4px 16px rgb(0 0 0 / 0.12), 0 2px 6px rgb(0 0 0 / 0.08)
```

## Mechanism (generator)

`primitives.ts` gains a `light` value alongside the dark value for each **semantic** token (and shadow). The renderer emits dark in `:root` and a single trailing block:

```css
:root { color-scheme: dark; /* Tier 1 + Tier 2 dark + Tier 3 */ }

@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    /* Tier 2 semantic + shadow light overrides ONLY */
    --rmx-surface: var(--rmx-neutral-50);
    --rmx-text: var(--rmx-neutral-900);
    /* … */
  }
}
```

New Tier-1 primitives are added unconditionally (palette entries; harmless to both themes). Tier-3 and `theme.css` are **untouched** — `--background: var(--rmx-surface)` follows the remap automatically. This is the architecture's payoff and the proof that the semantic tier was the right seam.

## Slices

Each ends with `npm run typecheck` + `npm run viewers:build` green. Ordered by leverage; independently landable.

```text
S0  Token foundation (kit)   primitives.ts: light values for Tier-2 + shadows; add Tier-1
                             light primitives; add --rmx-border-subtle/overlay/code-bg + --rmx-syntax-*;
                             generator emits @media(light) block; color-scheme flips.
                             [kit builds; deterministic; codex already flips substantially]
S1  Kit UI primitives        tokenize /ui/styles.css (button gradient, danger, borders, hover).
                             [terminal/editor/markdown action bars flip]
S2  Satellite CSS            editor + markdown + terminal styles.css: replace inlined hex with
                             var(--rmx-*)/color-mix; terminal local --remux-extension-* re-point to
                             kit tokens; white-alpha veils -> --rmx-border-subtle/overlay.
                             [all satellite chrome + markdown prose flip]
S3  Engine themes            CodeMirror -> --rmx-syntax-* + dark-flag compartment; Shiki dual-theme
                             (markdown codeToHtml + codex codeToTokensWithThemes) + media-query glue;
                             xterm light ANSI + matchMedia swap; Mermaid matchMedia re-render;
                             codex send-button/folder-icon tokenized.
                             [code, terminal output, diagrams all themed]
S4  App shell (RN)           useColorScheme() -> userInterfaceStyle "automatic", StatusBar, native
                             backgrounds, splash; per-viewer index.html: <meta color-scheme="light dark">
                             + dual <meta theme-color media=…>; reconcile native #000000 -> #09090b.
                             [no dark flash on load; correct status bar/native canvas]
```

S0→S2 delivers a coherent light mode for **all chrome, codex, and prose** — the bulk of the visible UI. S3 themes the engine *content* (code/terminal/diagrams). S4 removes the load flash and fixes native chrome. Shipping only S0–S2 leaves dark code blocks and a dark terminal pane, so all of S0–S3 are needed to hit the "as nice as dark" bar; S4 is the polish that makes it feel native.

## Verification

- After S0: re-run `tokens:build`; confirm deterministic; confirm `theme.css` diff is **empty** (proves Tier-3 untouched). Toggle OS to light; codex should already show near-white surfaces with correct status colors and unchanged spacing.
- Per slice: `npm run typecheck` + `npm run app:typecheck` + `npm run viewers:build`; `npm run test:codex`.
- Contrast gate: body/muted/link/status pairs meet the table's ratios on the light surfaces (AA for text, 3:1 for UI/icons).
- Flash gate (S4): cold-launch each viewer with OS in light — no black frame before first paint; status bar and native canvas are light.
- Engine gate (S3): light OS shows light xterm (legible ANSI, no invisible bright-yellow), light Shiki code (both viewers), light CodeMirror syntax, light Mermaid.

## Open Decisions

- **Surface model — canvas vs pure white.** *Recommended: canvas* (`surface #fafafa` + white raised) — mirrors dark's elevation-by-lightness and makes codex chat bubbles/composer pop. Alternative: pure-white base (`surface #ffffff`, elevation by border+shadow) — crisper/more iOS-standard but codex's `color-mix(card 92%)` bubbles would vanish on white. Eyeball codex + markdown before locking.
- **Body text darkness.** *Recommended: `zinc-900 #18181b`* (symmetric with dark's off-white text, softer). Alternative: pure `#09090b` for maximum outdoor punch (~19:1). Trivial to switch — one primitive.
- **Orange primary contrast.** *Recommended: keep the vibrant orange CTA + cream text in both themes* (brand parity; ~2.9:1 label — the same tradeoff dark already ships). If AA on the CTA label is required, deepen the light fill or use `zinc-950` text on orange (6.5:1). Same call the Phase 2 `--primary` decision raised.
- **App-shell slice timing.** S4 (RN) is needed to avoid a dark flash but is native work separate from the web token change. Land it in this effort, or fast-follow right after S0–S3? Recommend within this effort so light never flashes dark.
- **Shiki palette unification (later).** Optionally author a custom Shiki theme from `--rmx-syntax-*` so Shiki and CodeMirror share one palette. Deferred; bundled `github-light-default` is fine to start.

## Out of Scope

- **Manual theme toggle / persistence / per-viewer override.** System-tied only by request.
- **Light-specific art/illustration swaps** beyond tokens (none exist today).
- **RN app-shell token *generator*** (a JS token export from `primitives.ts`) — still deferred from Phase 1; S4 hand-authors the light native palette and aligns it to the web values.
