Status: Active Spec
Last verified: 2026-07-01
Canonical code: `packages/viewer-kit/src/ui/styles.css`, `packages/viewer-kit/src/tokens/`, `extensions/codex/viewer/styles.css`, `extensions/terminal/viewer/src/styles.css`, `extensions/terminal/assets/terminal.svg`, `app/src/browser/BrowserBottomBar.tsx`

# Light-mode polish: composer buttons, active keys, launcher icon

Follow-up cleanup to [viewer-kit-light-mode.md](viewer-kit-light-mode.md). That pass landed the host-driven theme signal, the semantic-tier remap, and the engine palettes. In use, three light-mode defects remain. They are not three unrelated bugs — they reduce to **two recurring bug-classes plus one asset gap**:

- **Bug-class A — near-white foreground used off an accent fill.** `--rmx-accent-foreground` (`var(--rmx-orange-50)`, `#fff7ed`) is a *single, unthemed* value (`primitives.ts:146`). It is legible **only on the orange accent fill**. Used as text on any theme-adaptive surface it stays near-white and vanishes in light mode.
- **Bug-class B — hardcoded `black` / `rgb(0 0 0 …)` elevation.** Semantic shadows (`--rmx-shadow-raised/pressed/menu`) are themed (soft/diffuse in light). Any shadow that hardcodes black instead does not invert, so it reads as a heavy dark line/halo on a light button.
- **Asset gap C — non-self-contained extension icon.** Every extension icon except terminal's is a self-contained badge (own background + light glyph) that reads on any surface. `terminal.png` is a bare near-white `>_` glyph on transparent, rendered untinted, so it disappears on light chrome.

The fix in every case is to route through the themed tokens that already exist. **No new tokens or generator changes are required.**

Grounding note: Tier-3 shadcn vars bind to Tier-2 (`tokens.css:106-123`: `--foreground: var(--rmx-text)`, `--border: var(--rmx-border)`, `--muted-foreground: var(--rmx-text-muted)`, …), so button *text and border already adapt* to light. Only elevation, the accent-foreground misuse, and the icon asset are wrong.

---

## Issue 1 — Codex composer buttons don't match the other viewers in light mode

**What's wrong.** The default composer action buttons (Open-tabs, history, scroll, config, attachment) look heavier / muddier in light mode than the equivalent buttons in terminal / editor / markdown.

**Root cause.** Codex re-implements the action-button recipe locally instead of using the shared one:

- Component: `extensions/codex/viewer/composer/actions/ActionButtons.tsx` → `ComposerActionKey` renders a bespoke `<button className="remux-composer-action-button">` (not viewer-kit `ActionButton`).
- Recipe: `extensions/codex/viewer/styles.css:1729` `.remux-composer-action-button`. Its text/border read `--muted-foreground`/`--foreground`/`--border` (adapt fine), **but its elevation is hardcoded dark** — bug-class B:
  - `:1741` gradient bottom stop `color-mix(in srgb, var(--chrome) 90%, black 10%)` — the `black 10%` dirties the light chrome.
  - `:1747` `inset 0 -2px 0 rgb(0 0 0 / 32%)` — a hard 2px black underline on a white button.
  - `:1748` / `:1763-1765` `0 2px 0 color-mix(var(--background) 78%, black)` and active insets — all dark-tuned.
- The shared standard `packages/viewer-kit/src/ui/styles.css:55` `.remux-extension-action-button` instead uses `background: surface-hover → surface-raised` (no black) and `box-shadow: var(--rmx-shadow-raised)` (themed → soft in light). That's why terminal/editor/markdown buttons stay crisp in light and codex's don't.
- The **send** button `.remux-composer-send-button` (`:1793`) already uses the shared `--rmx-primary-*` recipe and matches — only the *default* action buttons diverge.

**Fix (lead).** Re-point `.remux-composer-action-button` at the shared recipe: `surface-hover → surface-raised` gradient (drop `black 10%`), `border: color-mix(var(--rmx-border) 88%, transparent)`, `color: color-mix(var(--rmx-text-muted) 86%, var(--rmx-text) 14%)`, `box-shadow: var(--rmx-shadow-raised)`, active `var(--rmx-shadow-pressed)`. In other words make it identical to `.remux-extension-action-button`. Keep the codex class name and `ComposerActionKey` behavior, so codex retains ownership of composer layout/behavior — only the button *visual recipe* is standardized.

**Cleaner (optional, larger).** Delete the duplicated CSS and have `ComposerActionKey` render viewer-kit `ActionButton` (`tone="primary"` for send). Higher blast radius on codex-owned composer; do the CSS realignment first.

**Dark-mode tradeoff to decide.** Codex's `--chrome` (`#1f232b`, bluish) currently gives dark-mode composer buttons a slightly bluer tint than the neutral standard. Standardizing makes them neutral like the others.
- *Recommended:* accept the neutral look ("get things under a standard," the stated goal).
- *If codex wants to keep the bluish dark chrome:* keep `--chrome`/`--chrome-hover` in the gradient stops but **still** swap the hardcoded black shadows for `--rmx-shadow-raised`/`--rmx-shadow-pressed`. Fixes light mode, preserves the dark tint.

---

## Issue 2 — Terminal modifier keys (Shift / Ctrl / Alt) unreadable when active in light mode

**What's wrong.** When a modifier is toggled on, its label ("Shift", "Ctrl", "Alt", "^C") becomes unreadable in light mode.

**Root cause (bug-class A + B).** `extensions/terminal/viewer/src/styles.css:207` `.remux-terminal-key.is-active`:

- `:209` `color: var(--rmx-accent-foreground)` — near-white text, **with no background fill**. The active state only recolors text + border and relies on the base button background.
- Base `TerminalKey` (`TerminalSurface.tsx:1644`) is a viewer-kit `ActionButton`, whose background adapts: dark button in dark mode (near-white text reads), **light button in light mode (near-white text vanishes)**.
- `:210-214` box-shadow hardcodes `black 36%` — also heavy on a light key.

**Fix (lead).** Make the active/selected key a **filled accent** key so the near-white foreground is on orange in both themes. `ActionButton` already supports this: forward a tone from `TerminalKey`:

```tsx
// TerminalSurface.tsx TerminalKey
<ActionButton tone={active ? 'primary' : 'default'} className="remux-terminal-key …" … />
```

That reuses `.remux-extension-action-button-primary` (orange gradient fill + `--rmx-accent-foreground` text + themed `--rmx-primary-*` shadows) — legible in both themes — and lets the broken `.is-active` block be deleted (or reduced to terminal-only tweaks). Selected keys become clearly "on" (filled orange), matching the accent language of the send/primary buttons.

**Alt (CSS-only, no component change).** Rewrite `.is-active` to a fill: `background: linear-gradient(to bottom, color-mix(--rmx-accent-strong 86%, --rmx-accent 14%), color-mix(--rmx-primary-edge 88%, --rmx-primary-shadow 12%))`, keep `color: var(--rmx-accent-foreground)`, and replace the black box-shadow with the `--rmx-primary-*` tokens. Same result; prefer the tone approach (less bespoke CSS).

---

## Issue 3 — Terminal launcher icon not readable in light mode

**What's wrong.** The Terminal launcher in the bottom bar shows a barely-visible glyph in light mode. (Same asset is also low-contrast on light tab cards and light settings rows.)

**Root cause (asset gap C).** `extensions/terminal/assets/terminal.png` is a **bare near-white `>_` glyph on a transparent background**. The catalog server maps manifest `icon → iconUrl` (`cli/httpServer.cjs:93`), and `app/src/browser/BrowserBottomBar.tsx:119-124` renders it via `<Image>` with **no per-theme tint**. On the light glass capsule in light mode the near-white glyph disappears.

Every other extension icon is a **self-contained badge** that carries its own contrast, so it reads on any surface in both themes:
- `codex.png` — filled blue/purple gradient badge, white glyph.
- `editor.svg` / `markdown.svg` — dark rounded-square (`#27272a`/`#18181b`) + light glyph.

Terminal is the lone outlier. It also feeds `BrowserOverview.tsx:173` (tab cards) and `SettingsOverview.tsx:357` (settings rows), so the same glyph is low-contrast there in light mode.

**Fix (lead).** Replace `terminal.png` with a **badge-style icon that matches the house style** — a rounded-square background (e.g., `#27272a`/`#18181b` like editor/markdown, or a colored fill) with a light `>_` reversed out. Ship it as an **SVG** for crispness and consistency with editor/markdown. One asset fixes launcher + tabs + settings in both themes, with zero host/tinting changes.

**Alt (general mechanism, more infra).** Support theme-adaptive monochrome icons at the host: render the launcher/tab/settings `<Image>` as an iOS template image tinted with `theme.text` (RN `tintColor`), gated by a manifest `"template": true` (or `"monochrome"`) flag; or ship explicit light+dark icon variants and pick by host theme. Only worth it if we want arbitrary adaptive extension glyphs — not needed to resolve this issue.

---

## Adjacent offenders (same bug-classes — clean up in the same pass)

Surfaced by sweeping for the two patterns; fix together for consistency:

- `packages/viewer-kit/src/ui/styles.css:190` — `.remux-extension-action-menu-item` inset `color-mix(black 20%, transparent)`. A dark line inside **every** viewer's action menu in light mode. Swap for a themed inset (mix against `--rmx-text`, or a `--rmx-shadow-*` token).
- `extensions/codex/viewer/styles.css:1523,1527,1528,1566` — codex composer config/menu panel chrome: hardcoded `black 10%` gradient + `rgb(0 0 0 / 30-38%)` insets/drop. Same dark-tuned elevation as Issue 1; realign to `--rmx-*` / themed shadows.

**Guardrail (worth a lint/grep in CI or review):**
- `--rmx-accent-foreground` may only be used as text on an accent fill. Never as text on a theme-adaptive surface.
- Extension/viewer CSS should not hardcode `black` / `rgb(0 0 0 …)` / `#000` in shadows — use `--rmx-shadow-*` (themed) or `--rmx-primary-*` for accent fills.

---

## Verification

Changes are CSS + one asset (+ optionally a 1-line TSX tone forward). No token regeneration → determinism unchanged.

- Gates stay green: `viewers:build` (codex, terminal, editor, markdown), root `typecheck`, `app:typecheck`, `test:codex`, token determinism (md5 stable).
- On-device, **cold-launch on a light-OS and a dark-OS**, then flip appearance live:
  1. Codex composer default buttons are visually identical to terminal/editor/markdown action buttons in light mode (crisp soft elevation, no dark underline).
  2. Toggling Shift/Ctrl/Alt shows a legible **filled orange** key in both themes.
  3. Terminal launcher icon is clearly visible on the light bottom bar, and on light tab cards and light settings rows.

## Out of scope

- The host theme contract, token tiers/generator, and engine palettes (parent spec) — unchanged.
- RN files/settings cleanup — covered by the parent spec.
- No new design tokens: reuse `--rmx-shadow-raised/pressed`, `--rmx-primary-*`, and semantic surface/text roles.
