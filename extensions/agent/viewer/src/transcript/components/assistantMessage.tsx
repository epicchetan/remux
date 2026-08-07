import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

import type {
  AgentAssistantMessageSegment,
  AgentTurnRenderFrame,
} from '../../../../shared/transcript';
import { MarkdownBlock } from './markdown/MarkdownBlock';

export function AssistantMessage({
  segment,
  showActions = false,
  turnStatus,
  width,
}: {
  segment: AgentAssistantMessageSegment;
  showActions?: boolean;
  turnStatus: AgentTurnRenderFrame['status'];
  width: number;
}) {
  if (!segment.text.trim()) return null;
  return (
    <div className="codex-assistant-message">
      <MarkdownBlock streaming={turnStatus === 'inProgress'} width={width}>
        {segment.text}
      </MarkdownBlock>
      {showActions ? <AssistantCopyAction text={segment.text} /> : null}
    </div>
  );
}

function AssistantCopyAction({ text }: { text: string }) {
  const timeout = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => () => {
    if (timeout.current !== null) window.clearTimeout(timeout.current);
  }, []);

  return (
    <div className="codex-assistant-actions" data-remux-no-composer-focus>
      <button
        aria-label={copied ? 'Copied response' : 'Copy response'}
        className="codex-user-action-button"
        onClick={() => {
          void writeClipboardText(text);
          setCopied(true);
          if (timeout.current !== null) window.clearTimeout(timeout.current);
          timeout.current = window.setTimeout(() => setCopied(false), 1_100);
        }}
        type="button"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
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
