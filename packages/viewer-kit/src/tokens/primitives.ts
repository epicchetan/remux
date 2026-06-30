// Single source of truth for Remux viewer design tokens.
//
// Edit values here, then regenerate the CSS artifact:
//   npm run tokens:build            (from packages/viewer-kit)
//
// Token tiers (see docs/specs/viewer-kit.md and viewer-kit-phase-2.md):
//   - primitive tokens: raw, theme-independent values.
//   - semantic tokens:  role tokens that components reference; the only layer a
//     future light theme has to remap.
//   - theme bindings:  shadcn/Tailwind vocabulary bound to semantic tokens.
//
// Authored as plain data plus a pure renderer, so the same values can later
// also emit a JS object for the React Native app shell.

export type TokenGroup = {
  label: string;
  tokens: Record<string, string>;
};

const VAR_PREFIX = '--rmx-';

// ---------------------------------------------------------------------------
// Tier 1 — primitives (raw, theme-independent)
// ---------------------------------------------------------------------------

export const primitiveGroups: TokenGroup[] = [
  {
    label: 'Neutral ramp (zinc) — terminal-derived reference palette',
    tokens: {
      'neutral-950': '#09090b',
      'neutral-900': '#18181b',
      'neutral-800': '#27272a',
      'neutral-700': '#3f3f46',
      'neutral-400': '#a1a1aa',
      'neutral-100': '#f4f4f5',
    },
  },
  {
    label: 'Accent — orange (brand / primary action)',
    tokens: {
      'orange-700': '#c45424',
      'orange-500': '#f97316',
      'orange-50': '#fff7ed',
    },
  },
  {
    label: 'Status hues',
    tokens: {
      'blue-400': '#60a5fa',
      'red-400': '#f87171',
      'green-400': '#7fd49d',
      'amber-400': '#f5c56b',
    },
  },
  {
    label: 'Spacing scale',
    tokens: {
      'space-1': '4px',
      'space-2': '6px',
      'space-3': '8px',
      'space-4': '10px',
      'space-5': '12px',
      'space-6': '16px',
      'space-7': '20px',
    },
  },
  {
    label: 'Radius scale',
    tokens: {
      'radius-sm': '6px',
      'radius-md': '8px',
      'radius-lg': '10px',
      'radius-full': '999px',
    },
  },
  {
    label: 'Typography',
    tokens: {
      'text-xs': '11px',
      'text-sm': '13px',
      'text-base': '15px',
      'font-sans': 'Arial, "Helvetica Neue", sans-serif',
      'font-mono': 'Menlo, Consolas, "Liberation Mono", monospace',
    },
  },
];

// ---------------------------------------------------------------------------
// Tier 2 — semantic (dark theme). Values reference primitive vars so a future
// light theme only has to remap this layer.
// ---------------------------------------------------------------------------

export const semanticGroups: TokenGroup[] = [
  {
    label: 'Surfaces',
    tokens: {
      surface: 'var(--rmx-neutral-950)',
      'surface-raised': 'var(--rmx-neutral-900)',
      'surface-hover': 'var(--rmx-neutral-800)',
      border: 'var(--rmx-neutral-700)',
    },
  },
  {
    label: 'Text',
    tokens: {
      text: 'var(--rmx-neutral-100)',
      'text-muted': 'var(--rmx-neutral-400)',
    },
  },
  {
    label: 'Accent & status roles',
    tokens: {
      accent: 'var(--rmx-orange-500)',
      'accent-strong': 'var(--rmx-orange-700)',
      'accent-foreground': 'var(--rmx-orange-50)',
      'focus-ring': 'var(--rmx-blue-400)',
      danger: 'var(--rmx-red-400)',
      success: 'var(--rmx-green-400)',
      warning: 'var(--rmx-amber-400)',
    },
  },
  {
    label: 'Elevation (button physicality — references --rmx-surface)',
    tokens: {
      'shadow-raised':
        'inset 0 1px 0 rgb(255 255 255 / 9%), inset 0 -2px 0 rgb(0 0 0 / 32%), 0 2px 0 color-mix(in srgb, var(--rmx-surface) 78%, black)',
      'shadow-pressed':
        'inset 0 1px 0 rgb(0 0 0 / 24%), inset 0 -1px 0 rgb(0 0 0 / 22%), 0 1px 0 color-mix(in srgb, var(--rmx-surface) 78%, black)',
      'shadow-menu':
        'inset 0 1px 0 rgb(255 255 255 / 8%), inset 0 -2px 0 rgb(0 0 0 / 30%), 0 14px 36px rgb(0 0 0 / 38%)',
    },
  },
];

// ---------------------------------------------------------------------------
// Tier 3 — theme bindings. These are the shadcn vocabulary consumed by
// Tailwind utilities and shared components. They intentionally bind to Tier 2
// roles, so viewers can consume either --rmx-* or shadcn names without forking
// the palette.
// ---------------------------------------------------------------------------

export const themeBindingGroups: TokenGroup[] = [
  {
    label: 'shadcn radius bindings',
    tokens: {
      radius: 'var(--rmx-radius-lg)',
    },
  },
  {
    label: 'shadcn color bindings',
    tokens: {
      background: 'var(--rmx-surface)',
      foreground: 'var(--rmx-text)',
      card: 'var(--rmx-surface-raised)',
      'card-foreground': 'var(--rmx-text)',
      popover: 'var(--rmx-surface-raised)',
      'popover-foreground': 'var(--rmx-text)',
      primary: 'var(--rmx-accent)',
      'primary-foreground': 'var(--rmx-accent-foreground)',
      secondary: 'var(--rmx-surface-hover)',
      'secondary-foreground': 'var(--rmx-text)',
      muted: 'var(--rmx-surface-hover)',
      'muted-foreground': 'var(--rmx-text-muted)',
      accent: 'var(--rmx-surface-hover)',
      'accent-foreground': 'var(--rmx-text)',
      destructive: 'var(--rmx-danger)',
      border: 'var(--rmx-border)',
      input: 'var(--rmx-border)',
      ring: 'var(--rmx-focus-ring)',
      success: 'var(--rmx-success)',
      warning: 'var(--rmx-warning)',
      link: 'var(--rmx-focus-ring)',
      sidebar: 'var(--rmx-surface)',
      'sidebar-foreground': 'var(--rmx-text)',
    },
  },
];

export const tailwindThemeGroups: TokenGroup[] = [
  {
    label: 'Radius scale',
    tokens: {
      'radius-sm': 'var(--rmx-radius-sm)',
      'radius-md': 'var(--rmx-radius-md)',
      'radius-lg': 'var(--radius)',
      'radius-xl': 'calc(var(--radius) + 4px)',
    },
  },
  {
    label: 'Color roles',
    tokens: {
      'color-background': 'var(--background)',
      'color-foreground': 'var(--foreground)',
      'color-card': 'var(--card)',
      'color-card-foreground': 'var(--card-foreground)',
      'color-popover': 'var(--popover)',
      'color-popover-foreground': 'var(--popover-foreground)',
      'color-primary': 'var(--primary)',
      'color-primary-foreground': 'var(--primary-foreground)',
      'color-secondary': 'var(--secondary)',
      'color-secondary-foreground': 'var(--secondary-foreground)',
      'color-muted': 'var(--muted)',
      'color-muted-foreground': 'var(--muted-foreground)',
      'color-accent': 'var(--accent)',
      'color-accent-foreground': 'var(--accent-foreground)',
      'color-destructive': 'var(--destructive)',
      'color-border': 'var(--border)',
      'color-input': 'var(--input)',
      'color-ring': 'var(--ring)',
      'color-success': 'var(--success)',
      'color-warning': 'var(--warning)',
      'color-link': 'var(--link)',
      'color-sidebar': 'var(--sidebar)',
      'color-sidebar-foreground': 'var(--sidebar-foreground)',
    },
  },
];

// ---------------------------------------------------------------------------
// Renderer — turns the groups into generated CSS artifacts.
// ---------------------------------------------------------------------------

function renderGroup(group: TokenGroup, prefix = VAR_PREFIX): string {
  const lines = [`  /* ${group.label} */`];
  for (const [name, value] of Object.entries(group.tokens)) {
    lines.push(`  ${prefix}${name}: ${value};`);
  }
  return lines.join('\n');
}

export function renderTokensCss(): string {
  const header =
    '/* GENERATED from src/tokens/primitives.ts — do not edit by hand. */\n' +
    '/* Regenerate: npm run tokens:build (in packages/viewer-kit). */';
  const primitives = primitiveGroups.map((group) => renderGroup(group)).join('\n\n');
  const semantic = semanticGroups.map((group) => renderGroup(group)).join('\n\n');
  const themeBindings = themeBindingGroups.map((group) => renderGroup(group, '--')).join('\n\n');
  return (
    `${header}\n\n` +
    ':root {\n' +
    '  color-scheme: dark;\n\n' +
    `${primitives}\n\n` +
    '  /* ===================== Semantic (dark theme) ===================== */\n\n' +
    `${semantic}\n` +
    '\n' +
    '  /* ===================== Theme bindings ===================== */\n\n' +
    `${themeBindings}\n` +
    '}\n'
  );
}

export function renderThemeCss(): string {
  const header =
    '/* GENERATED from src/tokens/primitives.ts — do not edit by hand. */\n' +
    '/* Regenerate: npm run tokens:build (in packages/viewer-kit). */';
  const theme = tailwindThemeGroups.map((group) => renderGroup(group, '--')).join('\n\n');
  return `${header}\n\n@theme inline {\n${theme}\n}\n`;
}
