import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';
import { rpc } from '@remux/viewer-kit/ipc';

import {
  AGENT_METHODS,
  type ThreadCanvasValue,
  type ThreadCanvasVersion,
} from '../../../../shared/protocol.ts';
import { MarkdownBlock } from '../../transcript/components/markdown/MarkdownBlock.tsx';

export function ThreadCanvasButton({
  conversationId,
  latestTurnId,
  versionHint,
}: {
  conversationId: string;
  latestTurnId: string | null;
  versionHint: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<ThreadCanvasValue | null>(null);
  const [selected, setSelected] = useState<'current' | 'previous'>('current');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
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
    setOpen(false);
    setValue(null);
    setSelected('current');
    setError(null);
  }, [conversationId]);

  useEffect(() => {
    if (open) void load();
  }, [load, open, versionHint]);

  useLayoutEffect(() => {
    if (!open || !bodyRef.current) return;
    const element = bodyRef.current;
    const update = () => setMarkdownWidth(Math.max(240, element.getBoundingClientRect().width - 32));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  const shown = selected === 'previous' ? value?.previous ?? null : value?.current ?? null;
  const updatedByLatestTurn = value?.current.basedOnTurnId === latestTurnId && latestTurnId !== null;

  return (
    <>
      <button
        className="agent-thread-canvas-open"
        data-testid="thread-canvas-open"
        onClick={() => setOpen(true)}
        title={updatedByLatestTurn ? 'Thread updated in the latest turn' : 'Open Thread'}
        type="button"
      >
        <FileText className="size-3.5" />
        <span>Thread</span>
        {updatedByLatestTurn ? <span aria-label="Updated in latest turn" className="agent-thread-updated-dot" /> : null}
      </button>
      {open ? (
        <div className="agent-exact-content-backdrop" role="presentation">
          <section
            aria-label="Thread"
            aria-modal="true"
            className="agent-thread-canvas-dialog"
            data-testid="thread-canvas-dialog"
            role="dialog"
          >
            <header>
              <div>
                <strong>Thread</strong>
                <span>Living working document{value ? ` · version ${value.current.ordinal}` : ''}</span>
              </div>
              <div className="agent-thread-canvas-actions">
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
                <button aria-label="Close Thread" onClick={() => setOpen(false)} type="button">
                  <X className="size-4" />
                </button>
              </div>
            </header>
            <div className="agent-thread-canvas-body" ref={bodyRef}>
              {loading && !shown ? <p>Loading Thread…</p> : null}
              {shown ? <ThreadVersion content={shown.content} width={markdownWidth} /> : null}
              {!loading && !shown && !error ? <p>No thread version is available.</p> : null}
              {error ? <div className="codex-work-error" role="alert">{error}</div> : null}
            </div>
            <footer>
              <span>{shown ? `${formatBytes(shown.byteLength)} · ${shortId(shown.versionId)}` : 'No version loaded'}</span>
              <span>{shown?.basedOnTurnId ? `updated by turn ${shortId(shown.basedOnTurnId)}` : 'initial thread state'}</span>
            </footer>
          </section>
        </div>
      ) : null}
    </>
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
