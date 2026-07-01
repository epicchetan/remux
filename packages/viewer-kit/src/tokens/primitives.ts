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

type ThemeName = 'dark' | 'light';

type ThemedTokenValue = string | {
  dark: string;
  light: string;
};

type ThemedTokenGroup = {
  label: string;
  tokens: Record<string, ThemedTokenValue>;
};

const VAR_PREFIX = '--rmx-';
const LIGHT_THEME_SELECTOR = ':root[data-remux-theme="light"]';

// ---------------------------------------------------------------------------
// Tier 1 — primitives (raw, theme-independent)
// ---------------------------------------------------------------------------

export const primitiveGroups: TokenGroup[] = [
  {
    label: 'Neutral ramp (zinc) — terminal-derived reference palette',
    tokens: {
      'neutral-0': '#ffffff',
      'neutral-50': '#fafafa',
      'neutral-100': '#f4f4f5',
      'neutral-200': '#e4e4e7',
      'neutral-300': '#d4d4d8',
      'neutral-400': '#a1a1aa',
      'neutral-500': '#71717a',
      'neutral-600': '#52525b',
      'neutral-700': '#3f3f46',
      'neutral-800': '#27272a',
      'neutral-900': '#18181b',
      'neutral-950': '#09090b',
    },
  },
  {
    label: 'Accent — orange (brand / primary action)',
    tokens: {
      'orange-700': '#c45424',
      'orange-500': '#f97316',
      'orange-800': '#9f3a16',
      'orange-900': '#8f2f13',
      'orange-950': '#5f1d0d',
      'orange-50': '#fff7ed',
    },
  },
  {
    label: 'Status hues',
    tokens: {
      'blue-400': '#60a5fa',
      'blue-600': '#2563eb',
      'red-400': '#f87171',
      'red-600': '#dc2626',
      'green-400': '#7fd49d',
      'green-700': '#15803d',
      'amber-400': '#f5c56b',
      'amber-700': '#b45309',
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

export const semanticGroups: ThemedTokenGroup[] = [
  {
    label: 'Surfaces',
    tokens: {
      surface: { dark: 'var(--rmx-neutral-950)', light: 'var(--rmx-neutral-50)' },
      'surface-raised': { dark: 'var(--rmx-neutral-900)', light: 'var(--rmx-neutral-0)' },
      'surface-hover': { dark: 'var(--rmx-neutral-800)', light: 'var(--rmx-neutral-100)' },
      border: { dark: 'var(--rmx-neutral-700)', light: 'var(--rmx-neutral-200)' },
      'border-subtle': { dark: 'rgb(255 255 255 / 8%)', light: 'rgb(0 0 0 / 8%)' },
      overlay: { dark: 'rgb(255 255 255 / 10%)', light: 'rgb(0 0 0 / 8%)' },
      'code-bg': { dark: 'var(--rmx-surface-raised)', light: 'var(--rmx-surface-hover)' },
      'code-border': { dark: 'var(--rmx-border-subtle)', light: 'var(--rmx-border-subtle)' },
      'code-text': { dark: 'var(--rmx-text)', light: 'var(--rmx-text)' },
    },
  },
  {
    label: 'Text',
    tokens: {
      text: { dark: 'var(--rmx-neutral-100)', light: 'var(--rmx-neutral-900)' },
      'text-muted': { dark: 'var(--rmx-neutral-400)', light: 'var(--rmx-neutral-600)' },
    },
  },
  {
    label: 'Accent & status roles',
    tokens: {
      accent: 'var(--rmx-orange-500)',
      'accent-strong': 'var(--rmx-orange-700)',
      'accent-foreground': 'var(--rmx-orange-50)',
      'focus-ring': { dark: 'var(--rmx-blue-400)', light: 'var(--rmx-blue-600)' },
      danger: { dark: 'var(--rmx-red-400)', light: 'var(--rmx-red-600)' },
      success: { dark: 'var(--rmx-green-400)', light: 'var(--rmx-green-700)' },
      warning: { dark: 'var(--rmx-amber-400)', light: 'var(--rmx-amber-700)' },
    },
  },
  {
    label: 'Primary raised button recipe',
    tokens: {
      'primary-border': { dark: 'var(--rmx-orange-800)', light: 'var(--rmx-orange-700)' },
      'primary-edge': { dark: 'var(--rmx-orange-900)', light: 'var(--rmx-orange-800)' },
      'primary-shadow': { dark: 'var(--rmx-orange-950)', light: 'var(--rmx-orange-900)' },
      'primary-highlight': { dark: 'rgb(255 255 255 / 14%)', light: 'rgb(255 255 255 / 22%)' },
      'primary-shadow-inset': { dark: 'rgb(52 16 6 / 36%)', light: 'rgb(95 29 13 / 22%)' },
      'primary-shadow-drop': {
        dark: 'color-mix(in srgb, var(--rmx-primary-shadow) 88%, black)',
        light: 'color-mix(in srgb, var(--rmx-orange-700) 26%, transparent)',
      },
    },
  },
  {
    label: 'Elevation (button physicality — references --rmx-surface)',
    tokens: {
      'shadow-raised': {
        dark: 'inset 0 1px 0 rgb(255 255 255 / 9%), inset 0 -2px 0 rgb(0 0 0 / 32%), 0 2px 0 color-mix(in srgb, var(--rmx-surface) 78%, black)',
        light: '0 1px 2px rgb(0 0 0 / 0.06), 0 1px 1px rgb(0 0 0 / 0.04)',
      },
      'shadow-pressed': {
        dark: 'inset 0 1px 0 rgb(0 0 0 / 24%), inset 0 -1px 0 rgb(0 0 0 / 22%), 0 1px 0 color-mix(in srgb, var(--rmx-surface) 78%, black)',
        light: 'inset 0 1px 2px rgb(0 0 0 / 0.10)',
      },
      'shadow-menu': {
        dark: 'inset 0 1px 0 rgb(255 255 255 / 8%), inset 0 -2px 0 rgb(0 0 0 / 30%), 0 14px 36px rgb(0 0 0 / 38%)',
        light: '0 4px 16px rgb(0 0 0 / 0.12), 0 2px 6px rgb(0 0 0 / 0.08)',
      },
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

function renderThemedGroup(group: ThemedTokenGroup, theme: ThemeName, prefix = VAR_PREFIX): string {
  const lines = [`  /* ${group.label} */`];
  for (const [name, value] of Object.entries(group.tokens)) {
    lines.push(`  ${prefix}${name}: ${tokenValueForTheme(value, theme)};`);
  }
  return lines.join('\n');
}

function renderLightOverrideGroup(group: ThemedTokenGroup, prefix = VAR_PREFIX): string | null {
  const lines = [`  /* ${group.label} */`];
  for (const [name, value] of Object.entries(group.tokens)) {
    if (typeof value === 'string') {
      continue;
    }
    lines.push(`  ${prefix}${name}: ${value.light};`);
  }
  return lines.length > 1 ? lines.join('\n') : null;
}

function tokenValueForTheme(value: ThemedTokenValue, theme: ThemeName): string {
  return typeof value === 'string' ? value : value[theme];
}

export function renderTokensCss(): string {
  const header =
    '/* GENERATED from src/tokens/primitives.ts — do not edit by hand. */\n' +
    '/* Regenerate: npm run tokens:build (in packages/viewer-kit). */';
  const primitives = primitiveGroups.map((group) => renderGroup(group)).join('\n\n');
  const semantic = semanticGroups.map((group) => renderThemedGroup(group, 'dark')).join('\n\n');
  const lightSemantic = semanticGroups.flatMap((group) => {
    const rendered = renderLightOverrideGroup(group);
    return rendered ? [rendered] : [];
  }).join('\n\n');
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
    '}\n\n' +
    `${LIGHT_THEME_SELECTOR} {\n` +
    '  color-scheme: light;\n\n' +
    `${lightSemantic}\n` +
    '}\n\n' +
    '@media (prefers-color-scheme: light) {\n' +
    '  :root:not([data-remux-theme]) {\n' +
    '    color-scheme: light;\n\n' +
    indentCss(lightSemantic, '    ') +
    '\n' +
    '  }\n' +
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

const nativeTokenNames = {
  accent: 'accent',
  accentForeground: 'accent-foreground',
  accentStrong: 'accent-strong',
  border: 'border',
  borderSubtle: 'border-subtle',
  codeBg: 'code-bg',
  codeBorder: 'code-border',
  codeText: 'code-text',
  danger: 'danger',
  focusRing: 'focus-ring',
  link: 'focus-ring',
  overlay: 'overlay',
  success: 'success',
  surface: 'surface',
  surfaceHover: 'surface-hover',
  surfaceRaised: 'surface-raised',
  text: 'text',
  textMuted: 'text-muted',
  warning: 'warning',
} as const;

type Color = {
  a: number;
  b: number;
  g: number;
  r: number;
};

export function renderNativeTokensTs(): string {
  const header =
    '// GENERATED from src/tokens/primitives.ts — do not edit by hand.\n' +
    '// Regenerate: npm run tokens:build (in packages/viewer-kit).';
  const nativeTokens = {
    light: resolveNativeTheme('light'),
    dark: resolveNativeTheme('dark'),
  };

  return (
    `${header}\n\n` +
    `export const nativeTokens = ${JSON.stringify(nativeTokens, null, 2)} as const;\n\n` +
    'export type NativeRemuxThemeName = keyof typeof nativeTokens;\n' +
    'export type NativeRemuxTokens = typeof nativeTokens[NativeRemuxThemeName];\n'
  );
}

function resolveNativeTheme(theme: ThemeName) {
  return Object.fromEntries(
    Object.entries(nativeTokenNames).map(([nativeName, tokenName]) => [
      nativeName,
      resolveCssColor(`var(--rmx-${tokenName})`, theme),
    ]),
  );
}

function resolveCssColor(value: string, theme: ThemeName, seen = new Set<string>()): string {
  return colorToNativeString(resolveColor(resolveCssValue(value, theme, seen), theme, seen));
}

function resolveColor(value: string, theme: ThemeName, seen: Set<string>): Color {
  const resolved = resolveCssValue(value, theme, seen).trim();

  if (resolved === 'black') {
    return { r: 0, g: 0, b: 0, a: 1 };
  }

  if (resolved === 'white') {
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  if (resolved === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const hex = /^#([\da-f]{3}|[\da-f]{6})$/iu.exec(resolved);
  if (hex) {
    const value = hex[1].length === 3
      ? hex[1].split('').map((part) => `${part}${part}`).join('')
      : hex[1];
    const integer = Number.parseInt(value, 16);
    return {
      r: (integer >> 16) & 255,
      g: (integer >> 8) & 255,
      b: integer & 255,
      a: 1,
    };
  }

  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/u.exec(resolved);
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] ? parseAlpha(rgb[4]) : 1,
    };
  }

  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)(?:\s+([\d.]+)%)?\s*\)$/u.exec(resolved);
  if (mix) {
    const firstWeight = Number(mix[2]) / 100;
    const secondWeight = mix[4] ? Number(mix[4]) / 100 : 1 - firstWeight;
    return mixColors(
      resolveColor(mix[1], theme, seen),
      firstWeight,
      resolveColor(mix[3], theme, seen),
      secondWeight,
    );
  }

  throw new Error(`Cannot resolve native color token value: ${value}`);
}

function resolveCssValue(value: string, theme: ThemeName, seen: Set<string>): string {
  const trimmed = value.trim();
  const variable = /^var\(--rmx-([^)]+)\)$/u.exec(trimmed);
  if (!variable) {
    return trimmed;
  }

  const tokenName = variable[1];
  if (seen.has(tokenName)) {
    throw new Error(`Circular token reference: ${Array.from(seen).join(' -> ')} -> ${tokenName}`);
  }

  const primitive = primitiveValue(tokenName);
  if (primitive) {
    return primitive;
  }

  const semantic = semanticValue(tokenName, theme);
  if (!semantic) {
    throw new Error(`Unknown token reference: ${trimmed}`);
  }

  seen.add(tokenName);
  const resolved = resolveCssValue(semantic, theme, seen);
  seen.delete(tokenName);
  return resolved;
}

function primitiveValue(name: string) {
  for (const group of primitiveGroups) {
    const value = group.tokens[name];
    if (value) {
      return value;
    }
  }
  return null;
}

function semanticValue(name: string, theme: ThemeName) {
  for (const group of semanticGroups) {
    const value = group.tokens[name];
    if (value) {
      return tokenValueForTheme(value, theme);
    }
  }
  return null;
}

function parseAlpha(value: string) {
  return value.endsWith('%') ? Number(value.slice(0, -1)) / 100 : Number(value);
}

function mixColors(first: Color, firstWeight: number, second: Color, secondWeight: number): Color {
  const totalWeight = firstWeight + secondWeight;
  const normalizedFirstWeight = totalWeight === 0 ? 0 : firstWeight / totalWeight;
  const normalizedSecondWeight = totalWeight === 0 ? 0 : secondWeight / totalWeight;
  const a = first.a * normalizedFirstWeight + second.a * normalizedSecondWeight;

  if (a === 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  return {
    r: Math.round(((first.r * first.a * normalizedFirstWeight) + (second.r * second.a * normalizedSecondWeight)) / a),
    g: Math.round(((first.g * first.a * normalizedFirstWeight) + (second.g * second.a * normalizedSecondWeight)) / a),
    b: Math.round(((first.b * first.a * normalizedFirstWeight) + (second.b * second.a * normalizedSecondWeight)) / a),
    a,
  };
}

function colorToNativeString(color: Color) {
  if (color.a >= 1) {
    return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
  }

  return `rgba(${color.r}, ${color.g}, ${color.b}, ${trimAlpha(color.a)})`;
}

function toHex(value: number) {
  return value.toString(16).padStart(2, '0');
}

function trimAlpha(value: number) {
  return Number(value.toFixed(4)).toString();
}

function indentCss(css: string, indent: string) {
  return css.split('\n').map((line) => (line.trim() ? `${indent}${line.trimStart()}` : '')).join('\n');
}
