import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, ImageIcon, Pencil } from 'lucide-react';

import type { CodexUserMessageSegment } from '../../../shared/transcript';
import {
  composerDocumentFromUserInput,
  composerUserInputCanStartEdit,
  plainTextFromUserInput,
} from '../../composer/model/userInputInterop';
import { useComposerStore } from '../../composer/store';
import {
  buildUserMessageLayout,
  type UserMessagePlacement,
  type UserMessageRailItem,
} from '../model/userMessageContent';
import { FileTypeIcon } from './file/fileTypeIcons';
import { MarkdownBlock } from './markdown/MarkdownBlock';
import { cn } from '@remux/viewer-kit/shadcn';
import { userBubbleContentWidth } from '../layout/constants';
import { useTranscriptLayoutStore } from '../layoutStore';
import type { TranscriptUserMessageDisclosure } from '../layout/types';

export function UserMessage({
  disclosure,
  editEnabled = true,
  laneWidth,
  placement = 'topLevel',
  segment,
  showActions = false,
  threadId,
  turnId,
}: {
  disclosure?: TranscriptUserMessageDisclosure;
  editEnabled?: boolean;
  laneWidth: number;
  placement?: UserMessagePlacement;
  segment: CodexUserMessageSegment;
  showActions?: boolean;
  threadId?: string | null;
  turnId?: string;
}) {
  const layout = buildUserMessageLayout(
    {
      content: segment.content,
      id: segment.id,
      type: 'userMessage',
    },
    placement,
  );
  const hasMessageContent = layout.railItems.length > 0 || Boolean(layout.bodyMarkdown);
  const toggleUserMessageDisclosure = useTranscriptLayoutStore((state) => state.toggleUserMessageDisclosure);
  const markdownMaxLines = disclosure?.collapsible && !disclosure.expanded ? disclosure.maxLines : undefined;

  return (
    <div className={cn('codex-user-message', placement === 'work' && 'codex-user-message-work')}>
      {layout.showSteeringLabel ? <div className="codex-user-steering-label">Steered conversation</div> : null}
      {hasMessageContent ? (
        <div className={cn('codex-user-bubble', layout.railItems.length > 0 && 'codex-user-bubble-with-rail')}>
          {layout.railItems.length > 0 ? <UserMessageRail items={layout.railItems} /> : null}
          {layout.bodyMarkdown ? (
            <MarkdownBlock density="user" maxLines={markdownMaxLines} width={userBubbleContentWidth(laneWidth, placement)}>
              {layout.bodyMarkdown}
            </MarkdownBlock>
          ) : null}
          {disclosure?.collapsible && turnId ? (
            <button
              aria-expanded={disclosure.expanded}
              className="codex-user-disclosure-button"
              data-remux-no-composer-focus
              onClick={(event) => {
                event.currentTarget.blur();
                toggleUserMessageDisclosure({ segmentId: segment.id, turnId });
              }}
              type="button"
            >
              {disclosure.expanded ? 'Collapse message' : 'Show full message'}
              {disclosure.expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          ) : null}
        </div>
      ) : null}
      {showActions && threadId && turnId ? (
        <UserMessageActions editEnabled={editEnabled} segment={segment} threadId={threadId} turnId={turnId} />
      ) : null}
    </div>
  );
}

function UserMessageActions({
  editEnabled,
  segment,
  threadId,
  turnId,
}: {
  editEnabled: boolean;
  segment: CodexUserMessageSegment;
  threadId: string;
  turnId: string;
}) {
  const copiedTimeoutRef = useRef<number | null>(null);
  const startEdit = useComposerStore((state) => state.startEdit);
  const [copied, setCopied] = useState(false);
  const editDisabled = !editEnabled || !composerUserInputCanStartEdit(segment.content);

  useEffect(() => () => {
    if (copiedTimeoutRef.current !== null) {
      window.clearTimeout(copiedTimeoutRef.current);
    }
  }, []);

  const copy = () => {
    void writeClipboardText(plainTextFromUserInput(segment.content));
    setCopied(true);
    if (copiedTimeoutRef.current !== null) {
      window.clearTimeout(copiedTimeoutRef.current);
    }
    copiedTimeoutRef.current = window.setTimeout(() => {
      copiedTimeoutRef.current = null;
      setCopied(false);
    }, 1100);
  };

  const edit = () => {
    if (editDisabled) {
      return;
    }

    const load = composerDocumentFromUserInput(segment.content);
    startEdit(
      {
        threadId,
        turnId,
        userMessageId: segment.id,
      },
      load.document,
      load.resources,
    );
  };

  return (
    <div className="codex-user-actions" data-remux-no-composer-focus>
      <button
        aria-label={copied ? 'Copied message' : 'Copy message'}
        className="codex-user-action-button"
        onClick={copy}
        type="button"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
      <button
        aria-label="Edit message"
        className="codex-user-action-button"
        disabled={editDisabled}
        onClick={edit}
        type="button"
      >
        <Pencil className="size-4" />
      </button>
    </div>
  );
}

function UserMessageRail({ items }: { items: UserMessageRailItem[] }) {
  return (
    <div className="codex-user-rail">
      {items.map((item) => (
        <UserMessageRailCard item={item} key={item.id} />
      ))}
    </div>
  );
}

function UserMessageRailCard({ item }: { item: UserMessageRailItem }) {
  return (
    <div className="codex-user-rail-card" title={railCardTitle(item)}>
      <div className="codex-user-rail-thumb">
        {item.type === 'image' ? (
          <img alt={item.alt} className="codex-user-rail-image" loading="lazy" src={item.src} />
        ) : item.type === 'localImage' ? (
          <ImageIcon className="size-5" />
        ) : (
          <FileTypeIcon extension={fileExtensionFromName(item.label)} fileName={item.label} />
        )}
      </div>
      <div className="codex-user-rail-copy">
        <div className="codex-user-rail-title">{railCardName(item)}</div>
        <div className="codex-user-rail-subtitle">{item.subtitle}</div>
      </div>
    </div>
  );
}

function railCardName(item: UserMessageRailItem) {
  switch (item.type) {
    case 'image':
    case 'localImage':
      return item.name;
    case 'reference':
      return item.label;
  }
}

function railCardTitle(item: UserMessageRailItem) {
  switch (item.type) {
    case 'image':
      return item.src;
    case 'localImage':
    case 'reference':
      return item.path;
  }
}

function fileExtensionFromName(name: string) {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match?.[1]?.toLowerCase() ?? null;
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
