import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  cn,
} from '@remux/viewer-kit/shadcn';

import type { ConversationSummary } from '../../../shared/protocol.ts';
import { useComposerStore } from '../composer/store.ts';
import type { AgentNewChatDraft } from './drafts.ts';
import { formatRelativeTime, shortenPath } from './format.ts';
import {
  conversationHistorySubtitle,
  conversationHistoryTitle,
  nativeModelId,
  providerLabel,
} from './historyPresentation.ts';
import { useConversationHistoryStore } from './historyStore.ts';
import { useAgentSidebarStore } from './sidebarStore.ts';

type AgentSidebarProps = {
  activeConversationId: string | null;
  activeDraftId: string | null;
  draft: AgentNewChatDraft | null;
  onSelectConversation: (conversationId: string) => void;
  onSelectDraft: () => void;
  onStartNewChat: () => void;
};

export function AgentSidebar(props: AgentSidebarProps) {
  return (
    <Sidebar aria-label="Agent history">
      <AgentSidebarContent {...props} />
    </Sidebar>
  );
}

AgentSidebar.Mobile = function AgentMobileSidebar(props: AgentSidebarProps) {
  const mobileOpen = useAgentSidebarStore((state) => state.mobileOpen);
  const setMobileOpen = useAgentSidebarStore((state) => state.setMobileOpen);
  return (
    <Sheet onOpenChange={setMobileOpen} open={mobileOpen}>
      <SheetContent className="gap-0 p-0 md:hidden" side="left">
        <SheetTitle className="sr-only">Agent History</SheetTitle>
        <SheetDescription className="sr-only">
          Recent agent conversations. Tap outside, press Escape, or use the platform back action to close.
        </SheetDescription>
        <div className="flex h-full min-h-0 flex-col overflow-hidden pb-[max(1rem,env(safe-area-inset-bottom),var(--remux-safe-area-bottom,0px))] pt-[max(1.25rem,env(safe-area-inset-top),var(--remux-safe-area-top,0px))]">
          <AgentSidebarContent {...props} closeAfterSelection />
        </div>
      </SheetContent>
    </Sheet>
  );
};

function AgentSidebarContent({
  activeConversationId,
  activeDraftId,
  closeAfterSelection = false,
  draft,
  onSelectConversation,
  onSelectDraft,
  onStartNewChat,
}: AgentSidebarProps & { closeAfterSelection?: boolean }) {
  const closeMobile = useAgentSidebarStore((state) => state.closeMobile);
  const error = useConversationHistoryStore((state) => state.error);
  const load = useConversationHistoryStore((state) => state.load);
  const order = useConversationHistoryStore((state) => state.order);
  const status = useConversationHistoryStore((state) => state.status);
  const conversationsById = useConversationHistoryStore((state) => state.conversationsById);
  const models = useComposerStore((state) => state.models);
  const modelNames = useMemo(
    () => new Map(models?.models.map((model) => [model.id, model.name] as const) ?? []),
    [models],
  );
  const conversations = useMemo(
    () => order
      .flatMap((id) => conversationsById[id] ? [conversationsById[id]!] : [])
      .sort((left, right) =>
        right.lastActivityAt - left.lastActivityAt || left.id.localeCompare(right.id)),
    [conversationsById, order],
  );
  const finishSelection = () => {
    if (closeAfterSelection) closeMobile();
  };

  return (
    <>
      <SidebarHeader className="pb-3">
        <History className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="agent-sidebar-title min-w-0 flex-1 truncate text-base font-semibold leading-6">
          Agent History
        </div>
        <button
          aria-label="Start new chat"
          className="remux-composer-action-button remux-composer-send-button size-11 shrink-0"
          onClick={(event) => {
            event.currentTarget.blur();
            onStartNewChat();
            finishSelection();
          }}
          type="button"
        >
          <Plus className="size-4" />
        </button>
      </SidebarHeader>

      <SidebarContent className="flex flex-col overflow-hidden">
        <div className="grid shrink-0 gap-1.5 px-3">
          {draft ? (
            <DraftRow
              active={draft.id === activeDraftId}
              draft={draft}
              onSelect={() => {
                onSelectDraft();
                finishSelection();
              }}
            />
          ) : null}
          {status === 'loading' && conversations.length === 0 ? (
            <HistoryStatus icon="loading" message="Loading history" />
          ) : null}
          {status === 'failed' && conversations.length === 0 ? (
            <HistoryError message={error ?? 'History unavailable'} onRetry={() => void load()} />
          ) : null}
          {status === 'ready' && conversations.length === 0 ? (
            <HistoryStatus icon="empty" message="No recent conversations" />
          ) : null}
        </div>
        <VirtualizedConversationList
          activeConversationId={activeConversationId}
          activeDraftId={activeDraftId}
          conversations={conversations}
          modelNames={modelNames}
          onSelect={(conversationId) => {
            onSelectConversation(conversationId);
            finishSelection();
          }}
        />
      </SidebarContent>
    </>
  );
}

function DraftRow({ active, draft, onSelect }: {
  active: boolean;
  draft: AgentNewChatDraft;
  onSelect: () => void;
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(
        'grid min-w-0 gap-1 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-secondary/75',
        active && 'bg-secondary',
      )}
      onClick={onSelect}
      type="button"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">New chat</span>
        <span className="shrink-0 text-xs text-muted-foreground">Draft</span>
      </div>
      <div className="truncate text-xs leading-5 text-muted-foreground">
        {draft.snapshot.plainText.trim() || 'Choose a directory and send a message'}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-warning" />
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/85">
          {shortenPath(draft.cwd) || 'Pick a directory'}
        </span>
      </div>
    </button>
  );
}

const CONVERSATION_ROW_HEIGHT = 68;
const CONVERSATION_OVERSCAN = 5;

function VirtualizedConversationList({
  activeConversationId,
  activeDraftId,
  conversations,
  modelNames,
  onSelect,
}: {
  activeConversationId: string | null;
  activeDraftId: string | null;
  conversations: ConversationSummary[];
  modelNames: ReadonlyMap<string, string>;
  onSelect: (conversationId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setViewportHeight(element.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const index = conversations.findIndex(({ id }) => id === activeConversationId);
    const element = scrollRef.current;
    if (index < 0 || !element) return;
    const top = index * CONVERSATION_ROW_HEIGHT;
    const bottom = top + CONVERSATION_ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, bottom - element.clientHeight);
    }
    setScrollTop(element.scrollTop);
  }, [activeConversationId, conversations]);
  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / CONVERSATION_ROW_HEIGHT) - CONVERSATION_OVERSCAN,
  );
  const visibleCount = Math.ceil(viewportHeight / CONVERSATION_ROW_HEIGHT) +
    CONVERSATION_OVERSCAN * 2;
  const endIndex = Math.min(conversations.length, startIndex + Math.max(1, visibleCount));
  const focusRow = (index: number) => {
    const nextIndex = Math.max(0, Math.min(conversations.length - 1, index));
    const element = scrollRef.current;
    if (!element || conversations.length === 0) return;
    const top = nextIndex * CONVERSATION_ROW_HEIGHT;
    const bottom = top + CONVERSATION_ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
    setScrollTop(element.scrollTop);
    window.requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-history-index="${nextIndex}"]`)?.focus();
    });
  };
  return (
    <div
      aria-label="Conversation history"
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={scrollRef}
      role="list"
    >
      <div className="relative" style={{ height: conversations.length * CONVERSATION_ROW_HEIGHT }}>
        {conversations.slice(startIndex, endIndex).map((conversation, offset) => {
          const index = startIndex + offset;
          return (
            <div
              className="absolute inset-x-0"
              key={conversation.id}
              role="listitem"
              style={{
                height: CONVERSATION_ROW_HEIGHT,
                transform: `translateY(${index * CONVERSATION_ROW_HEIGHT}px)`,
              }}
            >
              <ConversationRow
                active={!activeDraftId && conversation.id === activeConversationId}
                conversation={conversation}
                focusable={conversation.id === activeConversationId || (!activeConversationId && index === 0)}
                modelName={conversation.lastUsedModelId
                  ? modelNames.get(conversation.lastUsedModelId) ?? nativeModelId(conversation.lastUsedModelId)
                  : null}
                onNavigate={(direction) => focusRow(index + direction)}
                onSelect={() => onSelect(conversation.id)}
                rowIndex={index}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConversationRow({
  active,
  conversation,
  focusable,
  modelName,
  onNavigate,
  onSelect,
  rowIndex,
}: {
  active: boolean;
  conversation: ConversationSummary;
  focusable: boolean;
  modelName: string | null;
  onNavigate: (direction: -1 | 1) => void;
  onSelect: () => void;
  rowIndex: number;
}) {
  const title = conversationHistoryTitle(conversation);
  const subtitle = conversationHistorySubtitle(conversation);
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(
        'grid h-full w-full min-w-0 content-center gap-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-secondary/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        active && 'bg-secondary',
      )}
      data-history-index={rowIndex}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        onNavigate(event.key === 'ArrowDown' ? 1 : -1);
      }}
      tabIndex={focusable ? 0 : -1}
      type="button"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {formatRelativeTime(conversation.lastActivityAt)}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs leading-5 text-muted-foreground">
        {conversation.status !== 'idle' ? (
          <span className={cn(
            'size-2 shrink-0 rounded-full',
            conversation.status === 'running' ? 'bg-warning' : 'bg-destructive',
          )} />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{subtitle}</span>
        <span
          className="max-w-[48%] shrink-0 truncate font-mono text-[11px] text-muted-foreground/85"
          title={modelName ?? providerLabel(conversation.provider)}
        >
          {modelName ?? providerLabel(conversation.provider)}
        </span>
      </div>
    </button>
  );
}

function HistoryStatus({ icon, message }: { icon: 'empty' | 'loading'; message: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2.5 text-xs text-muted-foreground">
      {icon === 'loading'
        ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        : <History className="size-3.5 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 truncate">{message}</span>
    </div>
  );
}

function HistoryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid min-w-0 gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2.5 text-xs text-destructive">
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 overflow-hidden text-ellipsis">{message}</span>
      </div>
      <button
        className="inline-flex min-w-0 items-center gap-1.5 justify-self-start rounded-md px-1.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/15"
        onClick={onRetry}
        type="button"
      >
        <RefreshCw className="size-3.5 shrink-0" aria-hidden="true" />
        <span>Retry</span>
      </button>
    </div>
  );
}
