import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react';

import type { AgentUserMessageSegment } from '../../../../shared/transcript';
import { cn } from '@remux/viewer-kit/shadcn';
import { useTranscriptLayoutStore } from '../layoutStore';
import type { TranscriptUserMessageDisclosure } from '../layout/types';
import { buildUserMessageLayout } from '../model/userMessageContent';
import { userBubbleContentWidth } from '../layout/constants';
import { MarkdownBlock } from './markdown/MarkdownBlock';

export function UserMessage({
  disclosure,
  laneWidth,
  placement = 'topLevel',
  segment,
  showActions = false,
  turnId,
}: {
  disclosure?: TranscriptUserMessageDisclosure;
  laneWidth: number;
  placement?: 'topLevel' | 'work';
  segment: AgentUserMessageSegment;
  showActions?: boolean;
  turnId?: string;
}) {
  const layout = buildUserMessageLayout(segment, placement);
  const toggleDisclosure = useTranscriptLayoutStore((state) => state.toggleUserMessageDisclosure);
  const maxLines = disclosure?.collapsible && !disclosure.expanded
    ? disclosure.maxLines
    : undefined;

  return (
    <div className={cn('codex-user-message', placement === 'work' && 'codex-user-message-work')}>
      {layout.bodyMarkdown ? (
        <div className="codex-user-bubble">
          <MarkdownBlock
            density="user"
            maxLines={maxLines}
            width={userBubbleContentWidth(laneWidth, placement)}
          >
            {layout.bodyMarkdown}
          </MarkdownBlock>
          {disclosure?.collapsible && turnId ? (
            <button
              aria-expanded={disclosure.expanded}
              className="codex-user-disclosure-button"
              data-remux-no-composer-focus
              onClick={(event) => {
                event.currentTarget.blur();
                toggleDisclosure({ segmentId: segment.id, turnId });
              }}
              type="button"
            >
              {disclosure.expanded ? 'Collapse message' : 'Show full message'}
              {disclosure.expanded
                ? <ChevronUp className="size-3.5" />
                : <ChevronDown className="size-3.5" />}
            </button>
          ) : null}
        </div>
      ) : null}
      {showActions ? <CopyAction label="message" text={segment.text} /> : null}
    </div>
  );
}

function CopyAction({ label, text }: { label: string; text: string }) {
  const timeout = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => () => {
    if (timeout.current !== null) window.clearTimeout(timeout.current);
  }, []);

  return (
    <div className="codex-user-actions" data-remux-no-composer-focus>
      <button
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
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
