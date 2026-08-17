import { useEffect, useLayoutEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Separator } from '@remux/viewer-kit/shadcn';
import type { AgentWorkRenderSegment } from '../../../../../shared/transcript.ts';
import {
  transcriptWorkDisclosureKey,
  useTranscriptLayoutStore,
} from '../../layoutStore.ts';
import { useTranscriptResourceStore } from '../../resourceStore.ts';
import { ExecutionScopeContent } from './ExecutionScope.tsx';
import { WorkingDuration } from './WorkingDuration.tsx';
import { formatWorkDuration } from './workDuration.ts';

export function WorkSection({
  conversationId,
  laneWidth,
  rowId,
  segment,
  turnId,
}: {
  conversationId: string;
  laneWidth: number;
  rowId: string;
  segment: AgentWorkRenderSegment;
  turnId: string;
}) {
  const workKey = transcriptWorkDisclosureKey(turnId, segment.id);
  const openWork = useTranscriptLayoutStore((state) => state.disclosure.openWorkByKey[workKey]);
  const toggleWork = useTranscriptLayoutStore((state) => state.toggleWorkDisclosure);
  const setAdditionalHeight = useTranscriptLayoutStore((state) => state.setOpenWorkAdditionalHeight);
  const ensureExecutionScope = useTranscriptResourceStore((state) => state.ensureExecutionScope);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const heightRafRef = useRef<number | null>(null);
  const pendingHeightRef = useRef<number | null>(null);
  const isOpen = Boolean(openWork);

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
        if (pendingHeight !== null) setAdditionalHeight(workKey, rowId, pendingHeight);
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
  }, [isOpen, rowId, setAdditionalHeight, workKey]);

  const completed = segment.state !== 'running';
  return (
    <section className="codex-work-section" data-state={segment.state}>
      <button
        aria-expanded={isOpen}
        className="codex-work-header"
        data-remux-no-composer-focus
        onClick={(event) => {
          event.currentTarget.blur();
          toggleWork({ rowId, segmentId: segment.id, turnId });
        }}
        type="button"
      >
        <span className="codex-work-header-chevron">
          {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
        <span className="codex-work-header-title">
          {completed && segment.durationMs !== null
            ? <>Worked for <span className="tabular-nums">{formatWorkDuration(segment.durationMs)}</span></>
            : <WorkingDuration completed={completed} turnId={turnId} />}
        </span>
        <span className="codex-work-header-status">{segment.state}</span>
      </button>
      <Separator className="codex-work-separator" />
      {isOpen ? (
        <div className="codex-work-content" ref={contentRef}>
          <ExecutionScopeContent
            conversationId={conversationId}
            laneWidth={laneWidth}
            scopeId={segment.scopeId}
            turnId={turnId}
            workKey={workKey}
          />
        </div>
      ) : null}
    </section>
  );
}
