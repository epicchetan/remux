import type { BundledLanguage, BundledTheme, Highlighter, ThemedTokenWithVariants } from 'shiki';

export type CodeHighlightToken = {
  color: string | null;
  fontStyle: 'italic' | null;
  fontWeight: 'bold' | null;
  lightColor: string | null;
  text: string;
};

export type CodeHighlightLine = {
  tokens: CodeHighlightToken[];
};

export type CodeHighlightResult = {
  lines: CodeHighlightLine[];
};

const codexShikiThemeDark = 'github-dark-default';
const codexShikiThemeLight = 'github-light-default';
const codeThemes = {
  dark: codexShikiThemeDark,
  light: codexShikiThemeLight,
} as const satisfies Record<'dark' | 'light', BundledTheme>;

const bundledLanguages = [
  'bash',
  'css',
  'diff',
  'ini',
  'javascript',
  'json',
  'jsx',
  'markdown',
  'tsx',
  'typescript',
] as const satisfies BundledLanguage[];

const highlightCache = new Map<string, CodeHighlightResult>();
let highlighterPromise: Promise<Highlighter> | null = null;

export function normalizeCodeLanguage(language: string | null): BundledLanguage | 'text' {
  switch (language?.trim().toLowerCase()) {
    case 'bash':
    case 'sh':
    case 'shell':
    case 'zsh':
      return 'bash';
    case 'css':
    case 'diff':
    case 'jsx':
    case 'json':
    case 'tsx':
    case 'typescript':
      return language.trim().toLowerCase() as BundledLanguage;
    case 'gitignore':
      return 'ini';
    case 'js':
      return 'javascript';
    case 'md':
    case 'mdown':
      return 'markdown';
    case 'ts':
      return 'typescript';
    default:
      return 'text';
  }
}

export function cachedCodeHighlight({
  code,
  language,
}: {
  code: string;
  language: string | null;
}): CodeHighlightResult | null {
  return highlightCache.get(highlightCacheKey({ code, language })) ?? null;
}

export async function highlightCode({
  code,
  language,
}: {
  code: string;
  language: string | null;
}): Promise<CodeHighlightResult> {
  const key = highlightCacheKey({ code, language });
  const cached = highlightCache.get(key);
  if (cached) {
    return cached;
  }

  const highlighter = await getHighlighter();
  const normalizedLanguage = normalizeCodeLanguage(language);
  const tokens = highlighter.codeToTokensWithThemes(code, {
    lang: normalizedLanguage,
    themes: codeThemes,
  });
  const highlighted = normalizeHighlightLines(code, tokens);
  highlightCache.set(key, highlighted);
  return highlighted;
}

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= import('shiki').then(({ createHighlighter }) =>
    createHighlighter({
      langs: bundledLanguages,
      themes: Object.values(codeThemes),
    }),
  );
  return highlighterPromise;
}

function highlightCacheKey({
  code,
  language,
}: {
  code: string;
  language: string | null;
}) {
  return `${normalizeCodeLanguage(language)}\0${code}`;
}

function normalizeHighlightLines(code: string, tokenLines: ThemedTokenWithVariants[][]): CodeHighlightResult {
  const sourceLines = code.length > 0 ? code.split('\n') : [''];
  return {
    lines: sourceLines.map((line, index) => {
      const tokens = tokenLines[index] ?? [];
      return {
        tokens: tokens.length > 0
          ? tokens.map(mapToken)
          : line ? [{ color: null, fontStyle: null, fontWeight: null, lightColor: null, text: line }] : [],
      };
    }),
  };
}

function mapToken(token: ThemedTokenWithVariants): CodeHighlightToken {
  const dark = token.variants.dark ?? {};
  const light = token.variants.light ?? {};
  const fontStyle = dark.fontStyle ?? light.fontStyle ?? 0;
  return {
    color: dark.color ?? null,
    fontStyle: fontStyle & 1 ? 'italic' : null,
    fontWeight: fontStyle & 2 ? 'bold' : null,
    lightColor: light.color ?? null,
    text: token.content,
  };
}
