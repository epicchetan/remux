import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import type { MarkdownLayoutBlock } from './markdownModel';
import {
  cachedCodeHighlight,
  highlightCode,
  type CodeHighlightResult,
  type CodeHighlightToken,
} from './codeHighlight';

type CodeLayoutBlock = Extract<MarkdownLayoutBlock, { type: 'code' }>;

type HighlightState =
  | { result: CodeHighlightResult; status: 'ready' }
  | { status: 'loading' }
  | { status: 'plain' };

export function CodeBlock({
  block,
  style,
}: {
  block: CodeLayoutBlock;
  style: CSSProperties;
}) {
  const highlightInput = useMemo(
    () => ({
      code: block.text,
      language: block.language,
    }),
    [block.language, block.text],
  );
  const [highlightState, setHighlightState] = useState<HighlightState>(() => {
    const cached = cachedCodeHighlight(highlightInput);
    return cached ? { result: cached, status: 'ready' } : { status: 'loading' };
  });

  useEffect(() => {
    let cancelled = false;
    const cached = cachedCodeHighlight(highlightInput);
    if (cached) {
      setHighlightState({ result: cached, status: 'ready' });
      return () => {
        cancelled = true;
      };
    }

    setHighlightState({ status: 'loading' });
    void highlightCode(highlightInput).then(
      (result) => {
        if (!cancelled) {
          setHighlightState({ result, status: 'ready' });
        }
      },
      () => {
        if (!cancelled) {
          setHighlightState({ status: 'plain' });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [highlightInput]);

  return (
    <pre
      className="codex-md-block codex-md-code-block"
      data-narration-surface="code"
      data-highlight-state={highlightState.status}
      data-language={block.language ?? undefined}
      style={{
        ...style,
        '--codex-md-code-line-height': `${block.lineHeight}px`,
      } as CSSProperties}
    >
      <code style={{ minHeight: `${block.textHeight}px` }}>
        {block.lines.map((line, index) => (
          <NarratedCodeLine
            fallbackText={line.text}
            key={`${index}:${line.text}`}
            tokens={highlightState.status === 'ready' ? highlightState.result.lines[index]?.tokens : null}
          />
        ))}
      </code>
    </pre>
  );
}

function NarratedCodeLine({
  fallbackText,
  tokens,
}: {
  fallbackText: string;
  tokens: CodeHighlightToken[] | null | undefined;
}) {
  return (
    <div className="codex-md-code-line">
      <CodeLineText fallbackText={fallbackText} tokens={tokens} />
    </div>
  );
}

function CodeLineText({
  fallbackText,
  tokens,
}: {
  fallbackText: string;
  tokens: CodeHighlightToken[] | null | undefined;
}) {
  if (!tokens?.length) {
    return fallbackText;
  }

  return (
    <>
      {tokens.map((token, index) => (
        <span
          className="codex-md-code-token"
          key={`${index}:${token.text}`}
          style={{
            '--shiki-light': token.lightColor ?? undefined,
            color: token.color ?? undefined,
            fontStyle: token.fontStyle ?? undefined,
            fontWeight: token.fontWeight ?? undefined,
          } as CSSProperties}
        >
          {token.text}
        </span>
      ))}
    </>
  );
}
