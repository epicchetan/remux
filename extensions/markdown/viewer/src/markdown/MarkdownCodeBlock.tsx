import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from 'react';

import { MermaidBlock } from './MermaidBlock';

type MarkdownCodeBlockProps = ComponentPropsWithoutRef<'code'> & {
  node?: unknown;
};

const maxHighlightedCodeLength = 80_000;
const highlightedCodeCache = new Map<string, string>();

export function MarkdownCodeBlock({
  children,
  className,
  ...props
}: MarkdownCodeBlockProps) {
  const source = String(children ?? '').replace(/\n$/u, '');
  const language = languageFromClassName(className);

  if (!language) {
    return <code className={className} {...props}>{children}</code>;
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
  const cacheKey = useMemo(() => `github-dark:${language}:${source}`, [language, source]);
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
        lang: language,
        theme: 'github-dark',
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
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <div className="remux-markdown-code-highlight remux-markdown-code-highlight-pending">
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
