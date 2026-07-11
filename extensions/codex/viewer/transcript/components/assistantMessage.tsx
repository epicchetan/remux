import { useEffect, useRef, useState } from 'react';
import { AudioLines, Check, Copy, GitFork, Loader2 } from 'lucide-react';

import type { CodexAssistantMessageSegment, CodexTranscriptTurn } from '../../../shared/transcript';
import { useComposerStore } from '../../composer/store';
import { MarkdownBlock } from './markdown/MarkdownBlock';
import { useOperationQueueStore } from '../../threads/operationQueueStore';
import { useThreadRuntimeStore } from '../../threads/runtimeStore';
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
  const narrationActiveTargets = useNarrationStore((state) => state.activeTargets);
  const narrationSourceTargets = useNarrationStore((state) => state.manifest?.targets ?? noNarrationTargets);
  if (!segment.text.trim()) {
    return null;
  }

  const streaming = turnStatus === 'inProgress';
  const narrationHighlight = narrationTargetMessageId === segment.id && narrationActiveTargets.length > 0
    ? { targets: narrationActiveTargets }
    : null;

  return (
    <div className="codex-assistant-message">
      <MarkdownBlock
        narrationAssistantMessageId={narrationTargetMessageId === segment.id ? segment.id : null}
        narrationHighlight={narrationHighlight}
        narrationTargets={narrationTargetMessageId === segment.id ? narrationSourceTargets : []}
        streaming={streaming}
        width={width}
      >{segment.text}</MarkdownBlock>
      {showActions && threadId && turnId ? (
        <AssistantMessageActions segment={segment} threadId={threadId} turnId={turnId} />
      ) : null}
    </div>
  );
}

function AssistantMessageActions({
  segment,
  threadId,
  turnId,
}: {
  segment: CodexAssistantMessageSegment;
  threadId: string;
  turnId: string;
}) {
  const copiedTimeoutRef = useRef<number | null>(null);
  const editTarget = useComposerStore((state) => state.editTarget);
  const forkTarget = useComposerStore((state) => state.forkTarget);
  const startFork = useComposerStore((state) => state.startFork);
  const runtimeStatus = useThreadRuntimeStore((state) => state.status);
  const narrationPhase = useNarrationStore((state) => state.phase);
  const narrationTargetMessageId = useNarrationStore((state) => state.target?.assistantMessageId ?? null);
  const playNarration = useNarrationStore((state) => state.play);
  const closeNarration = useNarrationStore((state) => state.close);
  const startNarration = useNarrationStore((state) => state.start);
  const forkDisabled = useOperationQueueStore((state) =>
    state.queue?.threadId === threadId && state.queue.entries.length > 0);
  const [copied, setCopied] = useState(false);
  const narrationIsTarget = narrationTargetMessageId === segment.id;
  const narrationPreparing = narrationIsTarget && narrationPhase === 'preparing';
  const narrationPlaying = narrationIsTarget && narrationPhase === 'playing';
  const narrationDisabled = Boolean(editTarget || forkTarget) || runtimeStatus === 'running' || runtimeStatus === 'stopping';

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
