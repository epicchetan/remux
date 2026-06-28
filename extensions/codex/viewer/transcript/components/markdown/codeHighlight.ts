import type { BundledLanguage, BundledTheme, Highlighter, ThemedToken } from 'shiki';

export type CodeHighlightTheme = 'dark';

export type CodeHighlightToken = {
  color: string | null;
  fontStyle: 'italic' | null;
  fontWeight: 'bold' | null;
  text: string;
};

export type CodeHighlightLine = {
  tokens: CodeHighlightToken[];
};

export type CodeHighlightResult = {
  lines: CodeHighlightLine[];
};

const codeThemes = {
  dark: 'github-dark-default',
} as const satisfies Record<CodeHighlightTheme, BundledTheme>;

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
  theme,
}: {
  code: string;
  language: string | null;
  theme: CodeHighlightTheme;
}): CodeHighlightResult | null {
  return highlightCache.get(highlightCacheKey({ code, language, theme })) ?? null;
}

export async function highlightCode({
  code,
  language,
  theme,
}: {
  code: string;
  language: string | null;
  theme: CodeHighlightTheme;
}): Promise<CodeHighlightResult> {
  const key = highlightCacheKey({ code, language, theme });
  const cached = highlightCache.get(key);
  if (cached) {
    return cached;
  }

  const highlighter = await getHighlighter();
  const normalizedLanguage = normalizeCodeLanguage(language);
  const result = highlighter.codeToTokens(code, {
    lang: normalizedLanguage,
    theme: codeThemes[theme],
  });
  const highlighted = normalizeHighlightLines(code, result.tokens);
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
  theme,
}: {
  code: string;
  language: string | null;
  theme: CodeHighlightTheme;
}) {
  return `${theme}\0${normalizeCodeLanguage(language)}\0${code}`;
}

function normalizeHighlightLines(code: string, tokenLines: ThemedToken[][]): CodeHighlightResult {
  const sourceLines = code.length > 0 ? code.split('\n') : [''];
  return {
    lines: sourceLines.map((line, index) => {
      const tokens = tokenLines[index] ?? [];
      return {
        tokens: tokens.length > 0 ? tokens.map(mapToken) : line ? [{ color: null, fontStyle: null, fontWeight: null, text: line }] : [],
      };
    }),
  };
}

function mapToken(token: ThemedToken): CodeHighlightToken {
  const fontStyle = token.fontStyle ?? 0;
  return {
    color: token.color ?? null,
    fontStyle: fontStyle & 1 ? 'italic' : null,
    fontWeight: fontStyle & 2 ? 'bold' : null,
    text: token.content,
  };
}
