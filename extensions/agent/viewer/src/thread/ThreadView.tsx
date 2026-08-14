import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { rpc } from '@remux/viewer-kit/ipc';

import {
  AGENT_METHODS,
  type ThreadCanvasValue,
  type ThreadCanvasVersion,
} from '../../../shared/protocol.ts';
import { MarkdownBlock } from '../transcript/components/markdown/MarkdownBlock.tsx';

export function ThreadView({
  conversationId,
  latestTurnId,
  versionHint,
}: {
  conversationId: string;
  latestTurnId: string | null;
  versionHint: string | null;
}) {
  const [value, setValue] = useState<ThreadCanvasValue | null>(null);
  const [selected, setSelected] = useState<'current' | 'previous'>('current');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const documentRef = useRef<HTMLDivElement | null>(null);
  const [markdownWidth, setMarkdownWidth] = useState(760);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await rpc.query<ThreadCanvasValue>(AGENT_METHODS.threadRead, { conversationId });
      setValue(next);
      setSelected((current) => current === 'previous' && !next.previous ? 'current' : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    setValue(null);
    setSelected('current');
    setError(null);
    void load();
  }, [load, versionHint]);

  useLayoutEffect(() => {
    const element = documentRef.current;
    if (!element) return;
    const update = () => setMarkdownWidth(Math.max(240, element.getBoundingClientRect().width - 32));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const shown = selected === 'previous' ? value?.previous ?? null : value?.current ?? null;
  const updatedByLatestTurn = value?.current.basedOnTurnId === latestTurnId && latestTurnId !== null;

  return (
    <section aria-label="Thread" className="agent-thread-view" data-testid="thread-view">
      <header className="agent-thread-view-header">
        <div className="agent-thread-view-heading">
          <strong>Thread</strong>
          <span>
            Living working document{value ? ` · version ${value.current.ordinal}` : ''}
            {updatedByLatestTurn ? ' · updated in the latest turn' : ''}
          </span>
        </div>
        <div className="agent-thread-view-tabs" role="group" aria-label="Thread version">
          <button
            aria-pressed={selected === 'current'}
            className={selected === 'current' ? 'is-active' : undefined}
            onClick={() => setSelected('current')}
            type="button"
          >
            Current
          </button>
          <button
            aria-pressed={selected === 'previous'}
            className={selected === 'previous' ? 'is-active' : undefined}
            disabled={!value?.previous}
            onClick={() => setSelected('previous')}
            type="button"
          >
            Previous
          </button>
        </div>
      </header>
      <div className="agent-thread-view-body">
        <div className="agent-thread-view-document" ref={documentRef}>
          {loading && !shown ? <p>Loading Thread…</p> : null}
          {shown ? <ThreadVersion content={shown.content} width={markdownWidth} /> : null}
          {!loading && !shown && !error ? <p>No Thread version is available.</p> : null}
          {error ? <div className="codex-work-error" role="alert">{error}</div> : null}
        </div>
      </div>
      <footer className="agent-thread-view-footer">
        <span>{shown ? `${formatBytes(shown.byteLength)} · ${shortId(shown.versionId)}` : 'No version loaded'}</span>
        <span>{shown?.basedOnTurnId ? `updated by turn ${shortId(shown.basedOnTurnId)}` : 'initial Thread state'}</span>
      </footer>
    </section>
  );
}

function ThreadVersion({ content, width }: { content: string; width: number }) {
  return content.trim()
    ? <MarkdownBlock width={width}>{content}</MarkdownBlock>
    : <p>The Thread is empty.</p>;
}

function shortId(value: string) {
  return value.slice(0, 10);
}

function formatBytes(value: number) {
  return value >= 1024 ? `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} KiB` : `${value} B`;
}
