# @remux/viewer-kit

SDK for building Remux viewers. See [`docs/specs/viewer-kit.md`](../../docs/specs/viewer-kit.md) for the full design and migration plan.

## Layering

The package is split by subpath so the host bridge stays framework-agnostic:

| Subpath | Purpose | May import React? |
| --- | --- | --- |
| `/host` `/ipc` `/fs` `/route` | Viewer-side host bridge (transport, host actions, fs, route parsing) | **No** |
| `/react` | `mountViewer` (and `useViewerResume`, planned) | Yes |
| `/ui` | `ActionBar`, `ActionButton`, `ActionMenu` | Yes |
| `/shadcn` | Tailwind/shadcn components (`Sheet`, `Sidebar`, `Separator`, `cn`) | Yes |
| `/tokens.css` | Design tokens, generated from `src/tokens/primitives.ts` | n/a (CSS) |
| `/theme.css` | Tailwind v4 `@theme inline` bindings for the kit token vocabulary | n/a (CSS) |

**Boundary rule:** the host-bridge modules (`host`, `ipc`, `fs`, `route`) must not import React or any React-coupled module, so transport-only consumers never pull React into their graph. There is no ESLint in this repo yet (lint is `tsc --noEmit`); the rule is enforced by convention until one is added.

## Design tokens

`tokens.css` and `theme.css` are generated — edit `src/tokens/primitives.ts` and run `npm run tokens:build`. Tokens are three-tier: primitive values, semantic role tokens (`--rmx-*`), and shadcn theme bindings (`--background`, `--foreground`, `--border`, and related roles). Components reference semantic/theme tokens only, so a future light theme is a remap of that layer.

Plain-CSS consumers import only `@remux/viewer-kit/tokens.css` and use `var(--rmx-*)` or the shadcn CSS variables directly. Tailwind consumers import both generated artifacts:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "@remux/viewer-kit/tokens.css";
@import "@remux/viewer-kit/theme.css";
```

## Tailwind shadcn Setup

Consumers of `@remux/viewer-kit/shadcn` must import `tw-animate-css` because `Sheet` uses its animation utilities, and must include the kit TSX files in Tailwind's source scan. In this workspace, Codex uses:

```css
@source "../../../packages/viewer-kit/src/shadcn/**/*.{ts,tsx}";
```

Adjust the relative path if a viewer's CSS entry file lives somewhere else.

## UI Primitives

The durable `/ui` exports are `ActionBar`, `ActionButton`, `ActionMenu`, and `ActionMenuItem`. The old `ExtensionAction*` names are still exported as deprecated aliases for one migration cycle.

## History

The legacy `@remux/extension-api` and `@remux/extension-ui` packages have been folded into this one and removed; all viewers import from `@remux/viewer-kit` directly.
