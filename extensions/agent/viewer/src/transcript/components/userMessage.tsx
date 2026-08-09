import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, ImageIcon, Loader2, Pencil } from 'lucide-react';

import type { AgentUserMessageSegment } from '../../../../shared/transcript';
import { cn } from '@remux/viewer-kit/shadcn';
import { useTranscriptLayoutStore } from '../layoutStore';
import type { TranscriptUserMessageDisclosure } from '../layout/types';
import {
  buildUserMessageLayout,
  plainTextFromUserMessage,
  type UserMessageRailItem,
} from '../model/userMessageContent';
import { userBubbleContentWidth } from '../layout/constants';
import { readArtifactDataUrl } from '../../ipc/artifacts.ts';
import { FileTypeIcon } from './file/fileTypeIcons.tsx';
import { MarkdownBlock } from './markdown/MarkdownBlock';
import { ExactContent } from './ExactContent';
import { composerDocumentFromUserInput } from '../../composer/model/userInputInterop.ts';
import { useComposerStore } from '../../composer/store.ts';
import { useConversationRuntimeStore } from '../../conversation/runtimeStore.ts';

export function UserMessage({
  conversationId,
  disclosure,
  laneWidth,
  placement = 'topLevel',
  segment,
  showActions = false,
  turnId,
}: {
  conversationId?: string | null;
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
      {layout.bodyMarkdown || layout.railItems.length > 0 ? (
        <div className={cn('codex-user-bubble', layout.railItems.length > 0 && 'codex-user-bubble-with-rail')}>
          {layout.railItems.length > 0 ? <UserMessageRail items={layout.railItems} /> : null}
          {layout.bodyMarkdown ? (
            <MarkdownBlock
              density="user"
              maxLines={maxLines}
              width={userBubbleContentWidth(laneWidth, placement)}
            >
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
          <ExactContent content={segment.content} preview={segment.text} title="message" />
        </div>
      ) : null}
      {showActions && conversationId && turnId ? (
        <UserActions conversationId={conversationId} segment={segment} turnId={turnId} />
      ) : null}
    </div>
  );
}

function UserMessageRail({ items }: { items: UserMessageRailItem[] }) {
  return <div className="codex-user-rail">{items.map((item) => (
    <div className="codex-user-rail-card" key={item.id} title={item.type === 'image' ? item.name : item.path}>
      <div className="codex-user-rail-thumb">
        {item.type === 'image' ? <DurableImage item={item} /> : (
          <FileTypeIcon extension={fileExtension(item.label)} fileName={item.label} />
        )}
      </div>
      <div className="codex-user-rail-copy">
        <div className="codex-user-rail-title">{item.type === 'image' ? item.name : item.label}</div>
        <div className="codex-user-rail-subtitle">{item.subtitle}</div>
      </div>
    </div>
  ))}</div>;
}

function DurableImage({ item }: { item: Extract<UserMessageRailItem, { type: 'image' }> }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readArtifactDataUrl(item.artifactHash, item.mimeType, item.sizeBytes)
      .then((value) => {
        if (!cancelled) setSrc(value);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [item.artifactHash, item.mimeType, item.sizeBytes]);
  return src
    ? <img alt={item.name} className="codex-user-rail-image" loading="lazy" src={src} />
    : <ImageIcon className="size-5" />;
}

function fileExtension(name: string) {
  return /\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toLowerCase() ?? null;
}

function UserActions({ conversationId, segment, turnId }: {
  conversationId: string;
  segment: AgentUserMessageSegment;
  turnId: string;
}) {
  const timeout = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const startEdit = useComposerStore((state) => state.startEdit);
  const runtimeConversationId = useConversationRuntimeStore((state) => state.activeConversationId);
  const runtimeStatus = useConversationRuntimeStore((state) => state.status);
  const working = runtimeConversationId === conversationId &&
    (runtimeStatus === 'running' || runtimeStatus === 'interrupting');
  const text = plainTextFromUserMessage(segment);
  useEffect(() => () => {
    if (timeout.current !== null) window.clearTimeout(timeout.current);
  }, []);

  return (
    <div className="codex-user-actions" data-remux-no-composer-focus>
      <button
        aria-label={copied ? 'Copied message' : 'Copy message'}
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
      <button
        aria-label="Edit message"
        className="codex-user-action-button"
        disabled={working || loadingEdit}
        onClick={() => {
          if (working || loadingEdit) return;
          setLoadingEdit(true);
          void hydrateUserInput(segment)
            .then((parts) => {
              const load = composerDocumentFromUserInput(parts);
              startEdit({ conversationId, turnId, userMessageId: segment.id }, load.document, load.resources);
            })
            .finally(() => setLoadingEdit(false));
        }}
        type="button"
      >
        {loadingEdit ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
      </button>
    </div>
  );
}

async function hydrateUserInput(segment: AgentUserMessageSegment) {
  const parts = segment.parts ?? [{ text: segment.text, type: 'text' as const }];
  return Promise.all(parts.map(async (part) => {
    if (part.type !== 'image') return part;
    return {
      ...part,
      dataUrl: part.dataUrl ?? await readArtifactDataUrl(
        part.artifactHash,
        part.mimeType,
        part.sizeBytes,
      ),
    };
  }));
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
