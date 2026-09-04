import { RotateCcw, X } from 'lucide-react';
import type { RefObject } from 'react';

import { transcriptLayout } from '../layout/constants';
import type { TranscriptMeasuredTurn } from '../layout/types';
import type { TranscriptStatus } from '../resourceStore';
import { TranscriptViewportBody } from './TranscriptViewportBody';

export function TranscriptViewport({
  anchorExtentFloorHeight,
  anchorRunwayHeight,
  anchorRunwayRef,
  bottomSpacerHeight,
  contentRef,
  conversationId,
  error,
  focusError,
  onDismissFocusError,
  onRetryFocus,
  onRetryTranscript,
  status,
  topSpacerHeight,
  totalTurnCount,
  transcriptBodyRef,
  turns,
  viewportRef,
  width,
}: {
  anchorExtentFloorHeight: number;
  anchorRunwayHeight: number;
  anchorRunwayRef: RefObject<HTMLDivElement | null>;
  bottomSpacerHeight: number;
  contentRef: RefObject<HTMLDivElement | null>;
  conversationId: string | null;
  error: string | null;
  focusError: string | null;
  onDismissFocusError: (() => void) | null;
  onRetryFocus: (() => void) | null;
  onRetryTranscript: () => void;
  status: TranscriptStatus;
  topSpacerHeight: number;
  totalTurnCount: number;
  transcriptBodyRef: RefObject<HTMLDivElement | null>;
  turns: TranscriptMeasuredTurn[];
  viewportRef: RefObject<HTMLDivElement | null>;
  width: number | null;
}) {
  return (
    <div
      className="remux-transcript-viewport h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-background"
      data-testid="agent-transcript-scroll"
      ref={viewportRef}
    >
      <div className="codex-transcript-lane mx-auto min-h-full w-full min-w-0 max-w-[var(--remux-feed-max-width)] px-[var(--remux-feed-pad-x)]">
        <div
          className="codex-transcript-content relative flex min-w-0 max-w-full flex-col"
          data-layout-width={width ?? undefined}
          data-testid="agent-transcript-content"
          ref={contentRef}
          style={{
            minHeight: anchorExtentFloorHeight > 0 ? `${anchorExtentFloorHeight}px` : undefined,
            paddingBottom: `${transcriptLayout.viewport.padY}px`,
            paddingTop: `max(${transcriptLayout.viewport.padY}px, env(safe-area-inset-top), var(--remux-safe-area-top, 0px))`,
          }}
        >
          {focusError ? (
            <div className="agent-transcript-focus-error" role="alert">
              <span>{focusError}</span>
              {onRetryFocus ? (
                <button onClick={onRetryFocus} type="button">
                  <RotateCcw className="size-3" /> Retry
                </button>
              ) : null}
              {onDismissFocusError ? (
                <button
                  aria-label="Dismiss turn focus error"
                  onClick={onDismissFocusError}
                  type="button"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
          ) : null}
          {status === 'failed' ? (
            <button className="agent-transcript-retry" onClick={onRetryTranscript} type="button">
              <RotateCcw className="size-3" /> {error ?? 'Retry transcript'}
            </button>
          ) : null}
          <div
            data-testid="agent-transcript-body"
            ref={transcriptBodyRef}
            style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
          >
            {width === null ? null : (
              <TranscriptViewportBody
                bottomSpacerHeight={bottomSpacerHeight}
                conversationId={conversationId}
                status={status}
                topSpacerHeight={topSpacerHeight}
                totalTurnCount={totalTurnCount}
                turns={turns}
                width={width}
              />
            )}
          </div>
          <div
            aria-hidden="true"
            data-testid="agent-transcript-anchor-runway"
            ref={anchorRunwayRef}
            style={{ height: `${anchorRunwayHeight}px` }}
          />
        </div>
      </div>
    </div>
  );
}
