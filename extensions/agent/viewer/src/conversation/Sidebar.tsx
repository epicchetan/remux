import { AlertTriangle, History, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
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
import type { AgentNewChatDraft } from './drafts.ts';
import { formatRelativeTime, shortenPath } from './format.ts';
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
        <SheetDescription className="sr-only">Agent conversation history.</SheetDescription>
        <div className="flex h-full min-h-0 flex-col overflow-hidden pb-0 pt-[max(1.25rem,env(safe-area-inset-top))]">
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
  const conversations = order.flatMap((id) => conversationsById[id] ? [conversationsById[id]!] : []);
  const finishSelection = () => {
    if (closeAfterSelection) closeMobile();
  };

  return (
    <>
      <SidebarHeader className="pb-3">
        <History className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 truncate text-base font-semibold leading-6">Agent History</div>
        <button
          aria-label="Start new chat"
          className="remux-composer-action-button remux-composer-send-button shrink-0"
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

      <SidebarContent>
        <div className="grid gap-1.5 px-3">
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
          {conversations.map((conversation) => (
            <ConversationRow
              active={!activeDraftId && conversation.id === activeConversationId}
              conversation={conversation}
              key={conversation.id}
              onSelect={() => {
                onSelectConversation(conversation.id);
                finishSelection();
              }}
            />
          ))}
        </div>
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

function ConversationRow({ active, conversation, onSelect }: {
  active: boolean;
  conversation: ConversationSummary;
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
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {conversation.title || 'New conversation'}
        </span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {formatRelativeTime(conversation.updatedAt)}
        </span>
      </div>
      <div className="truncate text-xs leading-5 text-muted-foreground">
        {conversation.preview || 'No messages yet'}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn(
          'size-2 shrink-0 rounded-full',
          conversation.status === 'running' ? 'bg-warning' : conversation.status === 'error' ? 'bg-destructive' : 'bg-success',
        )} />
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/85">
          {shortenPath(conversation.cwd)}
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
