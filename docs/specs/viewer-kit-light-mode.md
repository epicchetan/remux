# System Theming — Light Mode (app-wide, system-tied)

Status: Active Spec
Last verified: 2026-07-01
Canonical code: `app/`, `app/src/surfaces/viewer/ExtensionWebView.tsx`, `packages/viewer-kit/src/{tokens,host}`, `extensions/*/viewer`. Builds over [viewer-kit.md](viewer-kit.md) (Phase 1), [viewer-kit-phase-2.md](viewer-kit-phase-2.md) (Phase 2), and [viewer-kit-phase-3.md](viewer-kit-phase-3.md) (theme-readiness — prerequisite; the dark side is now fully tokenized). Supersedes Phase 1's "light mode deferred" note.

> **Scope note.** This spec was originally scoped to viewer-kit only. It is now **app-wide**: the React Native shell (nav, files, settings), the host→viewer theme signal, and every extension viewer all switch together. The filename keeps its `viewer-kit-` prefix for continuity; the subject is system theming across the whole product. (Rename to `system-theming.md` is a reasonable follow-up, deferred to avoid churning cross-refs.)

## Goal & constraints

Ship a light theme that is **as polished and legible as dark**, across the *entire app* — native shell and every webview — driven by the OS. The user runs this outdoors a lot, so light is a first-class surface, not a fallback.

- **System-tied.** Light when the OS is light, dark when dark (like iOS). No in-app toggle, no persistence, no picker in v1. (The chosen mechanism leaves the door open for an override later — see Open Decisions — but we don't build it now.)
- **One product, one palette.** The RN shell and the webviews must read as one surface. Both derive from the **same authored palette** (`primitives.ts`), so app chrome and viewer chrome can't drift.
- **Extensions theme themselves — kit-optional.** An extension must be able to go light/dark **without depending on `@remux/viewer-kit`**. The theme is delivered as a plain **host-level signal** (a DOM attribute + an event) any webview can read. viewer-kit consumes that signal for you, but using the kit is not required.
- **No dark flash.** A light-OS cold launch must never show a black frame — native chrome, splash, and each webview paint light from the first frame.
- **Outdoor-grade legibility.** Every text/role pair matches the *dark* theme's contrast ratio (muted ≈ 7:1, body ≈ 17:1), so light isn't a washed-out afterthought.

## The core decision: how theme reaches a webview

This is the crux the rest of the spec hangs on, and the question the original spec got wrong. There are two candidate mechanisms:

1. **Browser-native inference** — rely on `@media (prefers-color-scheme)` inside each webview, letting the WebView inherit the system scheme.
2. **Host-driven value** — the RN host reads the system scheme and *pushes* it into each webview; CSS/JS key off what the host set.

**Recommendation: host-driven value, delivered over the browser-native mechanism.** Concretely: read the system scheme natively (`useColorScheme()`), then stamp it onto the webview's `<html>` and keep the CSS `color-scheme` property in sync. This is "browser-native mechanism, host-controlled value" — which is the honest reconciliation of the instinct that "it's more browser-native since viewers are webviews." It *is* browser-native plumbing; we just don't trust the WebView to infer the value.

Why not pure `prefers-color-scheme` inference:

- **Android is unreliable.** `prefers-color-scheme` inside Android System WebView only tracks the app when you opt into `WebSettingsCompat.setAlgorithmicDarkeningAllowed` *and* the app is in the matching night mode; behavior is version-dependent. iOS/WKWebView works only if the app stops forcing `userInterfaceStyle: dark` (which we're doing anyway). We'd be depending on the flakiest link.
- **Engines need a JS trigger regardless.** xterm (canvas) and Mermaid (baked SVG) can't react to a CSS media change — they need an explicit "theme changed" callback. If we're firing a JS signal anyway, having *two* sources of truth (a media query for CSS + something else for engines) invites disagreement. One host signal drives both.
- **The host already has the pipes.** `ExtensionWebView.tsx` already ships an `injectedJavaScriptBeforeContentLoaded` hook (line ~1032), `injectJavaScript` (line ~427), and a `remux/event` channel that already carries `host/connection` / `host/active` / `host/viewport/changed`. Adding `host/theme` is a drop-in on an existing bus, not a new subsystem.
- **It's exactly the "IPC that theme changed" you described,** and it's the only option that satisfies "don't force extensions onto viewer-kit" while staying a single source of truth. It also future-proofs an in-app override (the host can push any value, not just the OS one).

We still set the CSS `color-scheme` property (so native form controls, scrollbars, and default UA colors follow) and may optionally emit a `prefers-color-scheme` fallback for standalone dev (see Mechanism).

## Host theme contract (kit-independent)

The host guarantees this for **every** webview it mounts. This is the whole public surface an extension needs — no kit import required.

**At load (before first paint).** The host injects, via `injectedJavaScriptBeforeContentLoaded`, a snippet that sets on `document.documentElement`:

```
data-remux-theme = "light" | "dark"
style.colorScheme = "light" | "dark"
```

So the correct theme is present in the DOM before any page script runs or any pixel paints — no flash, deterministic, identical on iOS and Android.

**On change.** When the OS scheme flips, the host:

- updates both attributes on the live document (via `injectJavaScript`), and
- dispatches `window.dispatchEvent(new CustomEvent('remux:theme', { detail: { theme } }))`, and
- emits it over the existing IPC bus as a `remux/event` with method `host/theme` (so kit consumers receive it through `subscribeIpcEvents` like every other host event).

**What an extension does with it** (pick any; all kit-free):

- **CSS:** author overrides under `:root[data-remux-theme="light"] { … }`. Dark stays the unscoped `:root` default (fails safe to dark if the host ever fails to inject).
- **JS / engines:** `window.addEventListener('remux:theme', e => swap(e.detail.theme))`.
- **Boot value:** `document.documentElement.dataset.remuxTheme` (default `'dark'` if absent).

**viewer-kit sugar (optional).** `host.ts` gains `getHostTheme(): 'light' | 'dark'` and `subscribeHostTheme(cb)` — thin wrappers over the same event, mirroring the existing `subscribeHostActive` / `subscribeHostConnection` helpers. And the kit's generated tokens already key their light block off `[data-remux-theme="light"]`, so kit-based viewers flip with zero per-viewer code. None of this is required to theme; it's convenience.

Documentation deliverable: a short "Theming your extension" section in the extensions/host docs describing the three lines above, so a non-kit extension author has a contract to code against.

## App-native theming standard (RN shell)

Today the shell is hard-dark and inconsistent: `app.json` forces `userInterfaceStyle: "dark"`, `App.tsx` pins `StatusBar style="light"`, `app/src/theme/tokens.ts` is 5 ad-hoc colors, and Settings / BrowserOverview / Files hardcode 40+ / 12+ / mixed hex literals. "Files and settings were just thrown together" == those literals. The standard:

- **One generated palette, shared with the web — but *resolved* for RN.** This is the load-bearing detail: the web tokens are CSS strings RN can't parse. `primitives.ts` semantic roles are `var(--rmx-neutral-950)`, `rgb(255 255 255 / 8%)`, `color-mix(in srgb, … )` — none of which React Native's style engine accepts. So the generator needs a **resolver pass**, not just a re-serialize:
  1. **Flatten** each semantic role's `var(--rmx-*)` chain down to the concrete primitive hex (both themes), so `surface` → `#09090b` (dark) / `#fafafa` (light), not `var(...)`.
  2. **Convert to RN-safe forms:** space-separated `rgb(r g b / N%)` alpha veils → `rgba(r, g, b, a)`; precompute the two `color-mix()` recipes (`primary-shadow-drop`, `code-*`) to literal hex/rgba at build time (there are only a handful). Anything that can't reduce to a flat color is **excluded** from the native module (see shadows).
  3. **Emit** `packages/viewer-kit/src/tokens/tokens.native.ts` as a **standalone plain-data module** — `export const nativeTokens = { light: {...}, dark: {...} } as const`, no kit-runtime imports — so Metro transpiles it with zero resolution friction. Keys are camelCase RN roles (`surface`, `surfaceRaised`, `surfaceHover`, `border`, `text`, `textMuted`, `accent`, `accentStrong`, `accentForeground`, `focusRing`/`link`, `danger`, `success`, `warning`). **Colors only** — RN's shadow model (`shadowColor`/`shadowOffset`/`shadowRadius`/`elevation`) doesn't map to web `box-shadow` strings, so shadows stay hand-authored per-screen (the module may expose a resolved `shadowColor` for tinting, but not the web strings).
  4. **Wire the boundary that doesn't exist yet:** add a `"./tokens.native": "./src/tokens/tokens.native.ts"` entry to `packages/viewer-kit/package.json` `exports`, add `"@remux/viewer-kit": "*"` to `app/package.json` dependencies (the app has **no** kit dependency today), and import `nativeTokens` from `@remux/viewer-kit/tokens.native`.

  This makes `primitives.ts` the single source of truth for app **and** viewers; they cannot drift. Verify the resolved values by round-trip: the native hex for each role must equal the flattened CSS value. (Lower-effort fallback if we don't extend the generator: hand-author `tokens.light.ts`/`tokens.dark.ts` in the app from the same values — but that reintroduces the drift the request wants gone.)
- **`useTheme()` hook.** A tiny provider at the app root reads `useColorScheme()` (reactive to OS changes) and exposes the active role map. Native screens consume roles, never hex. Retire `app/src/theme/tokens.ts`'s ad-hoc set.
- **Refactor the thrown-together screens onto roles.** `SettingsOverview.tsx`, `BrowserOverview.tsx`, and `FilesOverview.tsx` move their literals to `theme.*` roles (e.g. `#202126`→`surfaceRaised`, `#22c55e`→`success`, `#ef4444`→`danger`, the active-tab `#5f97ff`→`focusRing`). `FilesOverview`'s native `@expo/ui/swift-ui` modifiers (e.g. `foregroundStyle('#f4f4f5')`) take the role value; the native glass in `BrowserBottomBar` adapts to `userInterfaceStyle` on its own once we stop forcing dark, so it needs little beyond icon-tint roles.
- **Unforce dark + kill the flash.** `app.json`: `userInterfaceStyle` → `"automatic"`. **Splash needs a real plugin — the app has none today.** It only has the deprecated top-level `splash.backgroundColor: "#000000"` (and android `backgroundColor: "#111111"`); the `plugins` array holds `expo-image-picker`/`expo-status-bar`/`expo-notifications` but **not** `expo-splash-screen`. So: add `expo-splash-screen` to `app/package.json`, add it to `plugins` with a `dark` variant — `["expo-splash-screen", { "backgroundColor": "#fafafa", "dark": { "backgroundColor": "#09090b" } }]` — and drop the legacy top-level `splash` key (the plugin supersedes it). Reconcile the android window/adaptive bg the same way (`#111111` → dark `#09090b`, light `#fafafa`). `StatusBar` becomes theme-driven via `expo-status-bar` (**note the inversion:** light theme → `style="dark"` content). The native view **behind** each webview is set from `theme.surface`, so a light launch never flashes black.

## Token strategy (kit) — route through tokens, then remap once

Phase 3 already tokenized the dark side, so the remaining work is small: the semantic Tier-2 layer is the **sole** CSS remap seam. Convert any lingering inlined literal to `var(--rmx-*)` / `color-mix(var(--rmx-*) N%, transparent)`, then a single light override block flips everything. Tier-3 (shadcn) and `theme.css` resolve through Tier-2 at use-site, so they need **zero** changes — the proof the semantic tier was the right seam.

**Generator change (the one mechanism edit).** `primitives.ts` gains a `light` value alongside each **semantic** token (and shadow). `build-tokens.mjs` emits dark in `:root` and a single trailing override block keyed on the **host attribute** (not a media query):

```css
:root { color-scheme: dark; /* Tier 1 + Tier 2 dark + Tier 3 */ }

:root[data-remux-theme="light"] {
  /* Tier 2 semantic + shadow light overrides ONLY */
  --rmx-surface: var(--rmx-neutral-50);
  --rmx-text: var(--rmx-neutral-900);
  /* … */
}
```

New Tier-1 light primitives are added unconditionally (harmless palette entries). `color-scheme` per-webview is set by the host on `documentElement.style` (contract above); the generator's `:root { color-scheme: dark }` stays as the safe default. The vestigial codex `@custom-variant dark` line can be dropped (no `.dark` class is ever applied).

*Optional standalone-dev fallback:* additionally emit `@media (prefers-color-scheme: light) { :root:not([data-remux-theme]) { …same overrides… } }` so a viewer opened directly in a desktop browser (no host) still themes by system. Nice-to-have; the host attribute is canonical.

### White-alpha veils → sign-flipping tokens

Dark-only `rgb(255 255 255 / N%)` veils are invisible on light. Phase 3 already introduced `--rmx-border-subtle` / `--rmx-overlay` / `--rmx-code-bg`; give them light values so they flip:

```
--rmx-border-subtle:  dark rgb(255 255 255 / 8%)    | light rgb(0 0 0 / 8%)
--rmx-overlay:        dark rgb(255 255 255 / 10%)   | light rgb(0 0 0 / 8%)
--rmx-code-bg:        dark var(--rmx-surface-raised) | light var(--rmx-surface-hover)
```

Status-hue alphas already went to `color-mix(in srgb, var(--rmx-success) 28%, transparent)` in Phase 3 — they flip for free on the light hue.

## Palette — zinc + orange, the light counterpart

Same brand family as dark (neutral = zinc, brand = orange), so the two themes read as one product. Elevation **mirrors** dark: dark raises surfaces toward light; light raises them toward white (canvas → white cards). Status hues **deepen** for legibility on white (dark's pastels pop on black; light uses saturated `-600/-700` that pass AA on white). The values below were validated by eye against dark in a throwaway palette mockup; the contrast column is the acceptance bar.

### Tier 1 — primitives to ADD (theme-independent)

```
neutral-0:   #ffffff      neutral-300: #d4d4d8      neutral-600: #52525b
neutral-50:  #fafafa      neutral-500: #71717a
neutral-200: #e4e4e7
blue-600: #2563eb   red-600: #dc2626   green-700: #15803d   amber-700: #b45309
```

Orange is unchanged — `accent`/`accent-strong`/`accent-foreground` (`#f97316`/`#c45424`/`#fff7ed`) stay identical in both themes. `#c45424` already clears AA on white (5.4:1), so the orange primary CTA is a shared brand anchor across themes; only its shadow softens.

### Tier 2 — semantic remap (dark unchanged; light in the override block)

| Role | Light | primitive | Dark (ref) | Note |
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

Body text is `zinc-900 #18181b`, the symmetric counterpart to dark's off-white `zinc-100` (both one step off the extreme; softer for long reading, still ~17:1). Pure-black and pure-white-base alternatives in Open Decisions.

### Editor syntax — light values (viewer-owned `--remux-editor-syntax-*`)

Kept **editor-owned**, not promoted to kit tokens: only CodeMirror consumes CSS-var syntax colors (codex/markdown use Shiki, which bakes its own palette), so a kit-level `--rmx-syntax-*` group would have exactly one consumer. The editor already routes 4 of its 13 tokens through kit roles (`atom`→accent, `name`→code-text, `operator`→text-muted, `link`→focus-ring) — those flip for free. The 9 literal ones get light values in the editor's own `:root[data-remux-theme="light"]` block (GitHub-light-derived, to read consistently with Shiki's `github-light`):

| token | dark (current) | light |
| --- | --- | --- |
| `comment` | `#71717a` | `#8a8f98` |
| `keyword` | `#c084fc` | `#8250df` |
| `string` | `#86efac` | `#0a7b34` |
| `number` | `#f59e0b` | `#b45309` |
| `function` | `#7dd3fc` | `#0550ae` |
| `type` | `#fbbf24` | `#953800` |
| `property` | `#93c5fd` | `#0550ae` |
| `regexp` | `#fca5a5` | `#c2185b` |
| `tag` | `#fb7185` | `#c2185b` |

### Markdown alerts — light values (viewer-owned `--remux-markdown-alert-*`)

Add light values to the markdown viewer's own override block (note/tip/important/warning/caution border+bg+title). The dark bgs lean on white-alpha veils; light uses `color-mix(var(--rmx-<hue>) N%, transparent)` on the deepened light hues so they stay legible on white.

### Shadows — light variants (soft/diffuse; no white inset)

Dark's skeuomorphic inset-highlight shadows read wrong on white. Light emits soft diffuse drops:

```
shadow-raised:  0 1px 2px rgb(0 0 0 / 0.06), 0 1px 1px rgb(0 0 0 / 0.04)
shadow-pressed: inset 0 1px 2px rgb(0 0 0 / 0.10)
shadow-menu:    0 4px 16px rgb(0 0 0 / 0.12), 0 2px 6px rgb(0 0 0 / 0.08)
```

### Primary button recipe — light values (the `--rmx-primary-*` group)

The global shadows above aren't enough: Phase 3 gave the raised orange CTA its own six-token bevel recipe (`primitives.ts:133-138`), consumed by both kit buttons and the codex send button (`ui/styles.css:116`). It's authored for a *dark* canvas (deep orange-black cast + brown inset), which reads muddy on white. The **orange fill stays identical** across themes (brand anchor — `accent`/`accent-strong` unchanged); only the bevel edges and the cast onto the canvas soften:

| token | dark (current) | light | why |
| --- | --- | --- | --- |
| `primary-border` | `var(--rmx-orange-800)` | `var(--rmx-orange-700)` | slightly lighter top edge reads cleaner against white |
| `primary-edge` | `var(--rmx-orange-900)` | `var(--rmx-orange-800)` | bottom bevel one step up |
| `primary-shadow` | `var(--rmx-orange-950)` | `var(--rmx-orange-900)` | feeds the drop; less near-black |
| `primary-highlight` | `rgb(255 255 255 / 14%)` | `rgb(255 255 255 / 22%)` | brighter inner top highlight pops on the lighter context |
| `primary-shadow-inset` | `rgb(52 16 6 / 36%)` | `rgb(95 29 13 / 22%)` | softer inner bottom shadow |
| `primary-shadow-drop` | `color-mix(in srgb, var(--rmx-primary-shadow) 88%, black)` | `color-mix(in srgb, var(--rmx-orange-700) 26%, transparent)` | soft orange-tinted cast instead of a hard dark drop |

(Values are tunable in review; the constraint is "fill identical, cast/bevel softened for white.")

## Engines — re-keyed off the host signal

Engines can't consume CSS vars at paint time, so each gets a parallel light palette, **triggered by the one `remux:theme` event** (not `matchMedia` — single source of truth):

- **CodeMirror → compartment, no remount.** Syntax colors already reference `var(--remux-editor-syntax-*)` and render to the **DOM**, so they flip for free with the attribute. Only the `EditorView.theme({}, { dark: true })` chrome flag (selection, cursor, gutter) isn't CSS-reactive — wrap it in a `Compartment` and `reconfigure` it on `remux:theme`. (Correction to an earlier read that claimed a full remount is needed — the compartment avoids it.)
- **Shiki (markdown `codeToHtml`) → dual theme, CSS-only flip.** Shiki 4.2.0. Today it's single-theme (`codeToHtml(source, { lang, theme })`, `MarkdownCodeBlock.tsx:56`). Convert to `codeToHtml(source, { lang, themes: { light: 'github-light-default', dark: 'github-dark-default' }, defaultColor: 'dark' })`. With `defaultColor: 'dark'`, Shiki sets `color`/`background-color` to the **dark** value (our default) and emits the light values as **`--shiki-light`** and **`--shiki-light-bg`** custom props (note: keyed by the theme-object key, so `--shiki-light`, *not* `--shiki`). A rule under `:root[data-remux-theme="light"]` flips `color`/`background` to `var(--shiki-light)` / `var(--shiki-light-bg)`. No JS on change. Cache key includes both theme names.
- **Shiki (codex custom `codeToTokens`) → dual variants, renderer builds the var.** Today single-theme (`codeHighlight.ts:96`). Switch to `codeToTokensWithThemes({ themes: { light, dark } })`, which returns each token with a **`variants` record** (`token.variants.light` / `token.variants.dark`, each `{ color, … }`) — **not** CSS vars. So codex's custom renderer reads both variants and emits, per span, the default (dark) `color` inline **plus a `--shiki-light` custom prop it constructs itself** from `variants.light.color`; the same `[data-remux-theme="light"]` rule flips `color` to `var(--shiki-light)`. Keeps codex's virtualizer stable — no re-highlight/remeasure on theme change.
- **xterm → listener swap.** Add `terminalThemeLight`; on `remux:theme`, `terminal.options.theme = …`. One subscription (canvas; irreducible JS).
- **Mermaid → setConfig + re-render.** On `remux:theme`, `mermaid.setConfig` light/dark (`theme: 'default'` / `'dark'`) and re-render mounted diagrams.

## Codex cleanup (small, grounded — lands in S1)

Folded into S1 (not S3) so the "codex flips coherently after S1" claim actually holds — without these three vars, codex's config panel, file-mention picker, and directory-picker icon would stay dark/broken while everything around them flipped.

- Define `--composer-accent` (referenced at `codex/viewer/styles.css:1365` but **never declared** — a latent bug; point it at `--rmx-accent`).
- Give `--chrome` (`#1f232b`) and `--chrome-hover` (`#272b34`) light values in codex's override block — the only genuinely hardcoded codex chrome. `--composer: var(--card)` and the recent user-bubble `--secondary` lift both flip for free.

## Slices

Each ends with `npm run typecheck` + `npm run app:typecheck` + `npm run viewers:build` green (+ `npm run test:codex` where codex is touched). Ordered by dependency. **S0 is a build-only step (no runtime flip until the host wires the signal in S1);** codex is *coherently* lit after S1 except its Shiki code blocks, which wait for S4.

```text
S0  Token foundation (kit)     primitives.ts: light Tier-2 + shadow values; light values for the six
   (build-only, no flip yet)   --rmx-primary-* recipe tokens; add Tier-1 light primitives; light values for
                               --rmx-border-subtle/overlay/code-bg. Generator: emit the
                               :root[data-remux-theme=light] override block; AND emit the *resolved* native
                               module (flatten var-chains -> primitive hex, rgb()->rgba(), precompute the
                               color-mix recipes) as tokens.native.ts + add the ./tokens.native export.
                               Deterministic; theme.css diff empty. [kit builds; tokens ready for host + app]

S1  Host theme bridge          RN useColorScheme() source of truth in a root ThemeProvider; ExtensionWebView
   (the contract, linchpin)    before-load inject stamps data-remux-theme + colorScheme; on change,
                               injectJavaScript updates attrs + dispatches remux:theme, and emit remux/event
                               host/theme; viewer-kit host.ts gains getHostTheme()/subscribeHostTheme();
                               write the "Theming your extension" doc. FOLD IN codex's tiny cleanup so its
                               claim is true: define --composer-accent, add light --chrome/--chrome-hover.
                               [signal arrives; every already-tokenized surface flips: codex chrome, bubbles,
                               diff, and send button (primary recipe, from S0). Codex CODE BLOCKS stay dark
                               until S4 (Shiki); editor/markdown/terminal prose lands in S3.]

S2  App native theme + cleanup useTheme() over the resolved native tokens (add @remux/viewer-kit to app deps;
                               import @remux/viewer-kit/tokens.native); refactor Settings / BrowserOverview /
                               Files literals onto roles; app.json userInterfaceStyle "automatic"; add
                               expo-splash-screen plugin (light+dark, drop legacy splash key); android bg;
                               StatusBar + native webview bg theme-driven; retire app/src/theme/tokens.ts.
                               [whole shell themes; files/settings under one standard; no dark flash]

S3  Kit UI + satellite CSS     tokenize any remaining literals in /ui/styles.css and editor/markdown/terminal
                               styles.css so they flip; add editor --remux-editor-syntax-* and markdown
                               --remux-markdown-alert-* light values; update each viewer index.html's static
                               dark <meta name="theme-color"> to dual media metas + <meta name="color-scheme"
                               content="light dark"> (standalone/dev polish). [all chrome + prose flip]

S4  Engine themes              CodeMirror dark-flag compartment; Shiki dual-theme (markdown codeToHtml +
                               codex codeToTokensWithThemes, --shiki-light var); xterm light palette +
                               listener; Mermaid setConfig + re-render — all on remux:theme.
                               [code, terminal output, diagrams themed]
```

S1 delivers a coherent switch for codex chrome + all tokenized surfaces (code blocks excepted). S2 flips the native app and cleans up the thrown-together screens. S3 catches remaining CSS literals + viewer metas; S4 themes engine *content*. All of S0–S4 are needed to hit "as nice as dark."

## Verification

- **After S0:** re-run `tokens:build`; deterministic; `theme.css` diff **empty** (proves Tier-3 untouched). Native module compiles under Metro *and* round-trips — each resolved native color equals the flattened CSS value for that role (no stray `var()`/`color-mix()` leaked into the RN output).
- **After S1:** toggle OS light/dark with codex open — chrome, bubbles, status/diff colors, and the send button flip live with no reload, no flash (codex **code blocks stay dark** until S4 — expected); a deliberately kit-free test page that only reads `data-remux-theme` also flips (proves the contract is kit-independent).
- **Per slice:** `npm run typecheck` + `npm run app:typecheck` + `npm run viewers:build`; `npm run test:codex`.
- **Contrast gate:** body/muted/link/status pairs meet the table's ratios on light surfaces (AA text, 3:1 UI/icons), native *and* web.
- **Flash gate (S2):** cold-launch in light — no black frame before first paint; splash, status bar, native canvas, and every webview are light from frame one.
- **Engine gate (S4):** light OS shows light xterm (legible ANSI, no invisible bright-yellow), light Shiki (both viewers), light CodeMirror syntax, light Mermaid — each flipping on OS toggle without a stuck dark diagram/pane.

## Open Decisions

- **Mechanism** — *Recommended: host-driven attribute (this spec).* Alternative: pure `prefers-color-scheme`. Rejected for Android unreliability, dual-source-of-truth with engines, and losing host control; but the optional media-query fallback for standalone dev is cheap to keep. Decide whether to ship that fallback.
- **Native palette source** — *Recommended: generate `tokens.native.ts` from `primitives.ts`* (one source of truth for app + web). Alternative: hand-author `tokens.{light,dark}.ts` in the app (less generator work, drift risk).
- **Surface model — canvas vs pure white.** *Recommended: canvas* (`surface #fafafa` + white raised) — mirrors dark's elevation-by-lightness and makes codex bubbles/composer pop. Alternative: pure-white base (crisper/more iOS-standard, but codex's `color-mix(card 92%)` bubbles vanish on white).
- **Body text darkness.** *Recommended: `zinc-900 #18181b`* (symmetric with dark). Alternative: pure `#09090b` for max outdoor punch (~19:1). One primitive to switch.
- **Orange primary contrast.** *Recommended: keep the vibrant orange CTA + cream text in both themes* (brand parity; ~2.9:1 label — the same tradeoff dark ships). If AA on the CTA label is required, use `zinc-950` text on orange (6.5:1).
- **In-app override (future).** Out of scope for v1, but the host-driven model supports it for free (host pushes any value). If we ever add a toggle, it slots in at the ThemeProvider with no viewer changes.

## Out of Scope

- **Manual toggle / persistence / per-viewer override** — system-tied only in v1 (mechanism leaves room for a later override).
- **Light-specific art/illustration swaps** beyond tokens (none exist today).
- **Full shadcn/Tailwind convergence** — that's the optional Phase-4 sequel from Phase 3, independent of theming.
