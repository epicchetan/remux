import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import type { MarkdownLayoutBlock } from './markdownModel';
import {
  cachedCodeHighlight,
  highlightCode,
  type CodeHighlightResult,
  type CodeHighlightToken,
} from './codeHighlight';
import type { CodexNarrationSourceTarget } from '../../../../shared/narration';
import { useNarrationTargetRef } from '../../../narration/targetRegistry';
import { cn } from '@remux/viewer-kit/shadcn';

type CodeLayoutBlock = Extract<MarkdownLayoutBlock, { type: 'code' }>;

type HighlightState =
  | { result: CodeHighlightResult; status: 'ready' }
  | { status: 'loading' }
  | { status: 'plain' };

export function CodeBlock({
  activeTargets,
  assistantMessageId,
  block,
  style,
  targets,
}: {
  activeTargets: CodexNarrationSourceTarget[];
  assistantMessageId: string | null;
  block: CodeLayoutBlock;
  style: CSSProperties;
  targets: CodexNarrationSourceTarget[];
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
            activeTargets={activeTargets}
            assistantMessageId={assistantMessageId}
            blockId={block.narrationId}
            fallbackText={line.text}
            key={`${index}:${line.text}`}
            line={index}
            targets={targets}
            tokens={highlightState.status === 'ready' ? highlightState.result.lines[index]?.tokens : null}
          />
        ))}
      </code>
    </pre>
  );
}

function NarratedCodeLine({
  activeTargets,
  assistantMessageId,
  blockId,
  fallbackText,
  line,
  targets,
  tokens,
}: {
  activeTargets: CodexNarrationSourceTarget[];
  assistantMessageId: string | null;
  blockId: string;
  fallbackText: string;
  line: number;
  targets: CodexNarrationSourceTarget[];
  tokens: CodeHighlightToken[] | null | undefined;
}) {
  const lineTargets = targets.filter((target) =>
    target.blockId === blockId && target.kind === 'codeLines' && line >= target.lineStart && line <= target.lineEnd);
  const active = activeTargets.some((target) => lineTargets.some((candidate) => candidate.id === target.id));
  const targetRef = useNarrationTargetRef(assistantMessageId, lineTargets.map((target) => target.id));
  return (
    <div className={cn('codex-md-code-line', active && 'codex-md-target-narrating')} ref={targetRef}>
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
