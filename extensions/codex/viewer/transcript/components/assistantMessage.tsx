import { useEffect, useRef, useState } from 'react';
import { Check, Copy, GitFork } from 'lucide-react';

import type { CodexAssistantMessageSegment, CodexTranscriptTurn } from '../../../shared/transcript';
import { useComposerStore } from '../../composer/store';
import { MarkdownBlock } from './markdown/MarkdownBlock';
import { useOperationQueueStore } from '../../threads/operationQueueStore';

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
  if (!segment.text.trim()) {
    return null;
  }

  const streaming = turnStatus === 'inProgress';

  return (
    <div className="codex-assistant-message">
      <MarkdownBlock streaming={streaming} width={width}>{segment.text}</MarkdownBlock>
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
  const startFork = useComposerStore((state) => state.startFork);
  const forkDisabled = useOperationQueueStore((state) =>
    state.queue?.threadId === threadId && state.queue.entries.length > 0);
  const [copied, setCopied] = useState(false);

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
    startFork({
      assistantMessageId: segment.id,
      threadId,
      turnId,
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
