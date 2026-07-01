// GENERATED from src/tokens/primitives.ts — do not edit by hand.
// Regenerate: npm run tokens:build (in packages/viewer-kit).

export const nativeTokens = {
  "light": {
    "accent": "#f97316",
    "accentForeground": "#fff7ed",
    "accentStrong": "#c45424",
    "border": "#e4e4e7",
    "borderSubtle": "rgba(0, 0, 0, 0.08)",
    "codeBg": "#f4f4f5",
    "codeBorder": "rgba(0, 0, 0, 0.08)",
    "codeText": "#18181b",
    "danger": "#dc2626",
    "focusRing": "#2563eb",
    "link": "#2563eb",
    "overlay": "rgba(0, 0, 0, 0.08)",
    "success": "#15803d",
    "surface": "#fafafa",
    "surfaceHover": "#f4f4f5",
    "surfaceRaised": "#ffffff",
    "text": "#18181b",
    "textMuted": "#52525b",
    "warning": "#b45309"
  },
  "dark": {
    "accent": "#f97316",
    "accentForeground": "#fff7ed",
    "accentStrong": "#c45424",
    "border": "#3f3f46",
    "borderSubtle": "rgba(255, 255, 255, 0.08)",
    "codeBg": "#18181b",
    "codeBorder": "rgba(255, 255, 255, 0.08)",
    "codeText": "#f4f4f5",
    "danger": "#f87171",
    "focusRing": "#60a5fa",
    "link": "#60a5fa",
    "overlay": "rgba(255, 255, 255, 0.1)",
    "success": "#7fd49d",
    "surface": "#09090b",
    "surfaceHover": "#27272a",
    "surfaceRaised": "#18181b",
    "text": "#f4f4f5",
    "textMuted": "#a1a1aa",
    "warning": "#f5c56b"
  }
} as const;

export type NativeRemuxThemeName = keyof typeof nativeTokens;
export type NativeRemuxTokens = typeof nativeTokens[NativeRemuxThemeName];
