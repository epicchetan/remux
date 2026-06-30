// Single source of truth for Remux viewer design tokens.
//
// Edit values here, then regenerate the CSS artifact:
//   npm run tokens:build            (from packages/viewer-kit)
//
// Two tiers (see docs/specs/viewer-kit.md):
//   - primitive tokens: raw, theme-independent values.
//   - semantic tokens:  role tokens that components reference; the only layer a
//     future light theme has to remap.
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
// Renderer — turns the groups into a :root { ... } CSS block.
// ---------------------------------------------------------------------------

function renderGroup(group: TokenGroup): string {
  const lines = [`  /* ${group.label} */`];
  for (const [name, value] of Object.entries(group.tokens)) {
    lines.push(`  ${VAR_PREFIX}${name}: ${value};`);
  }
  return lines.join('\n');
}

export function renderTokensCss(): string {
  const header =
    '/* GENERATED from src/tokens/primitives.ts — do not edit by hand. */\n' +
    '/* Regenerate: npm run tokens:build (in packages/viewer-kit). */';
  const primitives = primitiveGroups.map(renderGroup).join('\n\n');
  const semantic = semanticGroups.map(renderGroup).join('\n\n');
  return (
    `${header}\n\n` +
    ':root {\n' +
    '  color-scheme: dark;\n\n' +
    `${primitives}\n\n` +
    '  /* ===================== Semantic (dark theme) ===================== */\n\n' +
    `${semantic}\n` +
    '}\n'
  );
}
