# @remux/viewer-kit

SDK for building Remux viewers. See [`docs/specs/viewer-kit.md`](../../docs/specs/viewer-kit.md) for the full design and migration plan.

## Layering

The package is split by subpath so the host bridge stays framework-agnostic:

| Subpath | Purpose | May import React? |
| --- | --- | --- |
| `/host` `/ipc` `/fs` `/route` | Viewer-side host bridge (transport, host actions, fs, route parsing) | **No** |
| `/react` | `mountViewer` (and `useViewerResume`, planned) | Yes |
| `/ui` | `ActionBar`, `ActionButton`, `ActionMenu` | Yes |
| `/tokens.css` | Design tokens, generated from `src/tokens/primitives.ts` | n/a (CSS) |

**Boundary rule:** the host-bridge modules (`host`, `ipc`, `fs`, `route`) must not import React or any React-coupled module, so transport-only consumers never pull React into their graph. There is no ESLint in this repo yet (lint is `tsc --noEmit`); the rule is enforced by convention until one is added.

## Design tokens

`tokens.css` is generated — edit `src/tokens/primitives.ts` and run `npm run tokens:build`. Tokens are two-tier: primitive values and semantic role tokens (`--rmx-*`); components reference semantic tokens only, so a future light theme is a remap of that layer.

## History

The legacy `@remux/extension-api` and `@remux/extension-ui` packages have been folded into this one and removed; all viewers import from `@remux/viewer-kit` directly.
