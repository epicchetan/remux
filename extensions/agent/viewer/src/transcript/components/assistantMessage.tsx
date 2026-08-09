import { useEffect, useRef, useState } from 'react';
import { Check, Copy, GitFork } from 'lucide-react';

import type {
  AgentAssistantMessageSegment,
  AgentTurnRenderFrame,
} from '../../../../shared/transcript';
import { MarkdownBlock } from './markdown/MarkdownBlock';
import { ExactContent } from './ExactContent';
import { useComposerStore } from '../../composer/store.ts';
import { useConversationRuntimeStore } from '../../conversation/runtimeStore.ts';

export function AssistantMessage({
  conversationId,
  segment,
  showActions = false,
  turnStatus,
  turnId,
  width,
}: {
  conversationId?: string | null;
  segment: AgentAssistantMessageSegment;
  showActions?: boolean;
  turnStatus: AgentTurnRenderFrame['status'];
  turnId?: string;
  width: number;
}) {
  if (!segment.text.trim()) return null;
  return (
    <div className="codex-assistant-message">
      <MarkdownBlock streaming={turnStatus === 'inProgress'} width={width}>
        {segment.text}
      </MarkdownBlock>
      <ExactContent content={segment.content} preview={segment.text} title="response" />
      {showActions && conversationId && turnId ? (
        <AssistantActions
          conversationId={conversationId}
          segment={segment}
          streaming={turnStatus === 'inProgress'}
          turnId={turnId}
        />
      ) : null}
    </div>
  );
}

function AssistantActions({ conversationId, segment, streaming, turnId }: {
  conversationId: string;
  segment: AgentAssistantMessageSegment;
  streaming: boolean;
  turnId: string;
}) {
  const timeout = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const startFork = useComposerStore((state) => state.startFork);
  const runtimeConversationId = useConversationRuntimeStore((state) => state.activeConversationId);
  const runtimeStatus = useConversationRuntimeStore((state) => state.status);
  const working = runtimeConversationId === conversationId &&
    (runtimeStatus === 'running' || runtimeStatus === 'interrupting');
  useEffect(() => () => {
    if (timeout.current !== null) window.clearTimeout(timeout.current);
  }, []);

  return (
    <div className="codex-assistant-actions" data-remux-no-composer-focus>
      <button
        aria-label={copied ? 'Copied response' : 'Copy response'}
        className="codex-user-action-button"
        onClick={() => {
          void writeClipboardText(segment.text);
          setCopied(true);
          if (timeout.current !== null) window.clearTimeout(timeout.current);
          timeout.current = window.setTimeout(() => setCopied(false), 1_100);
        }}
        type="button"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
      <button
        aria-label="Fork from response"
        className="codex-user-action-button"
        disabled={streaming || working}
        onClick={() => {
          if (streaming || working) return;
          startFork({ assistantMessageId: segment.id, conversationId, turnId });
        }}
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
      // WebViews can expose Clipboard API while denying the call.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}
