import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from 'react';

import { MermaidBlock } from './MermaidBlock';

type MarkdownCodeBlockProps = ComponentPropsWithoutRef<'code'> & {
  node?: unknown;
};

const maxHighlightedCodeLength = 80_000;
const highlightedCodeCache = new Map<string, string>();
const markdownShikiThemes = {
  dark: 'github-dark-default',
  light: 'github-light-default',
} as const;

export function MarkdownCodeBlock({
  children,
  className,
  node: _node,
  ...props
}: MarkdownCodeBlockProps) {
  const source = String(children ?? '').replace(/\n$/u, '');
  const language = languageFromClassName(className);

  if (!language) {
    return (
      <code
        {...props}
        className={className}
        data-narration-render-surface="code"
      >
        {children}
      </code>
    );
  }

  if (language === 'mermaid') {
    return <MermaidBlock source={source} />;
  }

  return <HighlightedCodeBlock className={className} language={language} source={source} />;
}

function HighlightedCodeBlock({
  className,
  language,
  source,
}: {
  className?: string;
  language: string;
  source: string;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const cacheKey = useMemo(
    () => `${markdownShikiThemes.dark}:${markdownShikiThemes.light}:${language}:${source}`,
    [language, source],
  );
  const shouldHighlight = source.length <= maxHighlightedCodeLength;

  useEffect(() => {
    let cancelled = false;
    const cachedHtml = highlightedCodeCache.get(cacheKey) ?? null;
    setHtml(cachedHtml);
    setFailed(false);

    if (!shouldHighlight || cachedHtml) {
      return;
    }

    void import('shiki')
      .then(({ codeToHtml }) => codeToHtml(source, {
        defaultColor: 'dark',
        lang: language,
        themes: markdownShikiThemes,
      }))
      .then((value) => {
        highlightedCodeCache.set(cacheKey, value);
        if (!cancelled) {
          setHtml(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, language, shouldHighlight, source]);

  if (shouldHighlight && html && !failed) {
    return (
      <div
        className="remux-markdown-code-highlight"
        data-narration-render-surface="code"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <div
      className="remux-markdown-code-highlight remux-markdown-code-highlight-pending"
      data-narration-render-surface="code"
    >
      <pre>
        <code className={className ?? undefined}>{source}</code>
      </pre>
    </div>
  );
}

function languageFromClassName(className: string | undefined) {
  const match = /(?:^|\s)language-([\w-]+)/u.exec(className ?? '');
  return match?.[1]?.toLowerCase() ?? null;
}
