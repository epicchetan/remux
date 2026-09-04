import { useEffect, useLayoutEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Separator } from '@remux/viewer-kit/shadcn';
import type { AgentWorkRenderSegment } from '../../../../../shared/transcript.ts';
import { useTranscriptResourceStore } from '../../resourceStore.ts';
import { ExecutionScopeContent } from './ExecutionScope.tsx';
import { WorkingDuration } from './WorkingDuration.tsx';
import { formatWorkDuration } from './workDuration.ts';

export function WorkSection({
  conversationId,
  isOpen,
  laneWidth,
  onAdditionalHeight,
  onToggle,
  responseStarted,
  rowId,
  segment,
  turnId,
  workKey,
}: {
  conversationId: string;
  isOpen: boolean;
  laneWidth: number;
  onAdditionalHeight: (workKey: string, rowId: string, height: number) => void;
  onToggle: (input: { rowId: string; segmentId: string; turnId: string }) => void;
  responseStarted: boolean;
  rowId: string;
  segment: AgentWorkRenderSegment;
  turnId: string;
  workKey: string;
}) {
  const ensureExecutionScope = useTranscriptResourceStore((state) => state.ensureExecutionScope);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const heightRafRef = useRef<number | null>(null);
  const pendingHeightRef = useRef<number | null>(null);
  const completed = segment.state !== 'running';

  useEffect(() => {
    if (isOpen) void ensureExecutionScope({ scopeId: segment.scopeId, turnId });
  }, [ensureExecutionScope, isOpen, segment.scopeId, turnId]);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || !isOpen) return;

    const publish = () => {
      pendingHeightRef.current = Math.max(0, Math.ceil(element.getBoundingClientRect().height));
      if (heightRafRef.current !== null) return;

      heightRafRef.current = window.requestAnimationFrame(() => {
        heightRafRef.current = null;
        const pendingHeight = pendingHeightRef.current;
        pendingHeightRef.current = null;
        if (pendingHeight !== null) onAdditionalHeight(workKey, rowId, pendingHeight);
      });
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (heightRafRef.current !== null) {
        window.cancelAnimationFrame(heightRafRef.current);
        heightRafRef.current = null;
      }
      pendingHeightRef.current = null;
    };
  }, [isOpen, onAdditionalHeight, rowId, workKey]);

  return (
    <section className="codex-work-section" data-state={segment.state}>
      <button
        aria-expanded={isOpen}
        className="codex-work-header"
        data-remux-no-composer-focus
        onClick={(event) => {
          event.currentTarget.blur();
          onToggle({ rowId, segmentId: segment.id, turnId });
        }}
        type="button"
      >
        <span className="codex-work-header-title">
          {completed && segment.durationMs !== null
            ? <>Worked for <span className="tabular-nums">{formatWorkDuration(segment.durationMs)}</span></>
            : <WorkingDuration completed={completed} turnId={turnId} />}
        </span>
        <span className="codex-work-header-chevron">
          {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
      </button>
      <Separator className="codex-work-separator" />
      {isOpen ? (
        <div className="codex-work-content" ref={contentRef}>
          <ExecutionScopeContent
            conversationId={conversationId}
            isRunning={!completed}
            laneWidth={laneWidth}
            responseStarted={responseStarted}
            scopeId={segment.scopeId}
            turnId={turnId}
            workKey={workKey}
          />
        </div>
      ) : null}
    </section>
  );
}
