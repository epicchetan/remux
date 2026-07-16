import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { AudioLines, Check, Copy, GitFork, Loader2 } from 'lucide-react';

import type { CodexAssistantMessageSegment, CodexTranscriptTurn } from '../../../shared/transcript';
import { useComposerStore } from '../../composer/store';
import { MarkdownBlock } from './markdown/MarkdownBlock';
import { useOperationQueueStore } from '../../threads/operationQueueStore';
import { narrationSourceDocument } from './markdown/markdownModel';
import { narrationSourceHash, useNarrationStore } from '../../narration/store';

const noNarrationTargets: never[] = [];

export function AssistantMessage({
  segment,
  showActions = false,
  threadId,
  turnStatus,
  turnId,
  width,
}: {
  segment: CodexAssistantMessageSegment;
  showActions?: boolean;
  threadId?: string | null;
  turnStatus: CodexTranscriptTurn['status'];
  turnId?: string;
  width: number;
}) {
  const narrationTargetMessageId = useNarrationStore((state) => state.target?.assistantMessageId ?? null);
  const narrationSourceTargets = useNarrationStore((state) => state.manifest?.targets ?? noNarrationTargets);
  const narrationPhase = useNarrationStore((state) => state.phase);
  const seekNarrationToBlock = useNarrationStore((state) => state.seekToBlock);
  if (!segment.text.trim()) {
    return null;
  }

  const streaming = turnStatus === 'inProgress';
  // Tap-to-seek is narration-only and block-level: while this message is the
  // playback target, tapping a narrated block seeks the audio to its start.
  const narrationSeekable = narrationTargetMessageId === segment.id &&
    (narrationPhase === 'ready' || narrationPhase === 'playing' || narrationPhase === 'buffering' || narrationPhase === 'paused');
  const seekToTappedBlock = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('a, button, [data-remux-no-composer-focus]')) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const blockId = event.target
      .closest('[data-narration-block-id]')
      ?.getAttribute('data-narration-block-id');
    if (!blockId) return;
    void seekNarrationToBlock(blockId);
  };
  return (
    <div
      className="codex-assistant-message"
      onClick={narrationSeekable ? seekToTappedBlock : undefined}
    >
      <MarkdownBlock
        narrationAssistantMessageId={narrationTargetMessageId === segment.id ? segment.id : null}
        narrationTargets={narrationTargetMessageId === segment.id ? narrationSourceTargets : []}
        streaming={streaming}
        width={width}
      >{segment.text}</MarkdownBlock>
      {showActions && threadId && turnId ? (
        <AssistantMessageActions
          segment={segment}
          streaming={streaming}
          threadId={threadId}
          turnId={turnId}
        />
      ) : null}
    </div>
  );
}

function AssistantMessageActions({
  segment,
  streaming,
  threadId,
  turnId,
}: {
  segment: CodexAssistantMessageSegment;
  streaming: boolean;
  threadId: string;
  turnId: string;
}) {
  const copiedTimeoutRef = useRef<number | null>(null);
  const editTarget = useComposerStore((state) => state.editTarget);
  const forkTarget = useComposerStore((state) => state.forkTarget);
  const startFork = useComposerStore((state) => state.startFork);
  const narrationPhase = useNarrationStore((state) => state.phase);
  const narrationTargetMessageId = useNarrationStore((state) => state.target?.assistantMessageId ?? null);
  const playNarration = useNarrationStore((state) => state.play);
  const closeNarration = useNarrationStore((state) => state.close);
  const startNarration = useNarrationStore((state) => state.start);
  const queueBlocksFork = useOperationQueueStore((state) =>
    state.queue?.threadId === threadId && state.queue.entries.length > 0);
  const [copied, setCopied] = useState(false);
  const narrationIsTarget = narrationTargetMessageId === segment.id;
  const narrationPreparing = narrationIsTarget && narrationPhase === 'preparing';
  const narrationPlaying = narrationIsTarget && narrationPhase === 'playing';
  // A message in an in-progress turn is still mutable: codex rejects it as a
  // fork point and its text would go stale under a narration. Completed
  // messages stay forkable and narratable while a newer turn runs.
  const forkDisabled = queueBlocksFork || streaming;
  const narrationDisabled = Boolean(editTarget || forkTarget) || streaming;

  useEffect(() => () => {
    if (copiedTimeoutRef.current !== null) {
      window.clearTimeout(copiedTimeoutRef.current);
    }
  }, []);

  const copy = () => {
    void writeClipboardText(segment.text);
    setCopied(true);
    if (copiedTimeoutRef.current !== null) {
      window.clearTimeout(copiedTimeoutRef.current);
    }
    copiedTimeoutRef.current = window.setTimeout(() => {
      copiedTimeoutRef.current = null;
      setCopied(false);
    }, 1100);
  };

  const fork = () => {
    if (forkDisabled) return;
    closeNarration();
    startFork({
      assistantMessageId: segment.id,
      threadId,
      turnId,
    });
  };

  const narrate = () => {
    if (narrationDisabled || narrationPreparing || narrationPlaying) return;
    if (narrationIsTarget && (narrationPhase === 'ready' || narrationPhase === 'paused')) {
      void playNarration();
      return;
    }
    const sourceHash = narrationSourceHash(segment.text);
    void startNarration({
      document: narrationSourceDocument(segment.text, {
        messageId: segment.id,
        messageRevision: segment.revision,
        sourceHash,
      }),
      sourceText: segment.text,
      target: {
        assistantMessageId: segment.id,
        messageRevision: segment.revision,
        sourceHash,
        threadId,
        turnId,
      },
    });
  };

  return (
    <div className="codex-assistant-actions" data-remux-no-composer-focus>
      <button
        aria-label={copied ? 'Copied response' : 'Copy response'}
        className="codex-user-action-button"
        onClick={copy}
        type="button"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
      <button
        aria-label="Fork from response"
        className="codex-user-action-button"
        disabled={forkDisabled}
        onClick={fork}
        type="button"
      >
        <GitFork className="size-4" />
      </button>
      <button
        aria-label={narrationPreparing
          ? 'Preparing narration'
          : narrationPlaying
            ? 'Narration playing'
          : narrationIsTarget && narrationPhase !== 'failed'
            ? 'Play narration'
            : narrationIsTarget && narrationPhase === 'failed'
              ? 'Narration failed; retry'
              : 'Narrate response'}
        className={`codex-user-action-button${narrationIsTarget ? ' is-active' : ''}`}
        disabled={narrationDisabled || narrationPreparing || narrationPlaying}
        onClick={narrate}
        type="button"
      >
        {narrationPreparing ? <Loader2 className="size-4 animate-spin" /> : <AudioLines className="size-4" />}
      </button>
    </div>
  );
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for WebView contexts where Clipboard API exists but rejects.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  textarea.select();

  try {
    document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}
