import { AlertTriangle, History, LoaderCircle, Plus, RefreshCw } from 'lucide-react';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui/Sheet';
import { Sidebar, SidebarContent, SidebarHeader } from '../ui/Sidebar';
import { cn } from '../ui/cn';
import { useComposerStore } from '../composer/store';

import type { CodexThreadSummary } from '../../shared/threads';
import { useThreadHistoryStore } from './historyStore';
import { formatRelativeTime, shortenPath, threadTitle } from './threadFormat';
import { useSidebarStore } from './sidebarStore';
import { useThreadsStore } from './store';

export function CodexSidebar() {
  return (
    <Sidebar aria-label="Codex history">
      <CodexSidebarContent />
    </Sidebar>
  );
}

CodexSidebar.Mobile = function CodexMobileSidebar() {
  const mobileOpen = useSidebarStore((state) => state.mobileOpen);
  const setMobileOpen = useSidebarStore((state) => state.setMobileOpen);

  return (
    <Sheet onOpenChange={setMobileOpen} open={mobileOpen}>
      <SheetContent className="gap-0 p-0 md:hidden" side="left">
        <SheetTitle className="sr-only">Codex History</SheetTitle>
        <SheetDescription className="sr-only">Codex thread history.</SheetDescription>
        <div className="flex h-full min-h-0 flex-col overflow-hidden pb-0 pt-[max(1.25rem,env(safe-area-inset-top))]">
          <CodexSidebarContent onSelectThread={() => setMobileOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
};

function CodexSidebarContent({ onSelectThread }: { onSelectThread?: () => void }) {
  const activeDraftId = useThreadsStore((state) => state.activeDraftId);
  const activeThreadId = useThreadsStore((state) => state.activeThreadId);
  const clearComposer = useComposerStore((state) => state.clearComposer);
  const clearComposerMode = useComposerStore((state) => state.clearMode);
  const composerSnapshot = useComposerStore((state) => state.snapshot);
  const draft = useThreadsStore((state) => state.draft);
  const saveActiveDraftSnapshot = useThreadsStore((state) => state.saveActiveDraftSnapshot);
  const selectDraft = useThreadsStore((state) => state.selectDraft);
  const selectThread = useThreadsStore((state) => state.selectThread);
  const startNewChat = useThreadsStore((state) => state.startNewChat);
  const historyError = useThreadHistoryStore((state) => state.error);
  const historyStatus = useThreadHistoryStore((state) => state.status);
  const loadThreadHistory = useThreadHistoryStore((state) => state.loadThreadHistory);
  const threadOrder = useThreadHistoryStore((state) => state.threadOrder);
  const threadsById = useThreadHistoryStore((state) => state.threadsById);
  const threads = threadOrder
    .map((threadId) => threadsById[threadId])
    .filter((thread): thread is CodexThreadSummary => Boolean(thread));

  return (
    <>
      <SidebarHeader className="pb-3">
        <History className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 truncate text-base font-semibold leading-6">Codex History</div>
        <button
          aria-label="Start new chat"
          className="remux-composer-action-button remux-composer-send-button shrink-0"
          onClick={(event) => {
            event.currentTarget.blur();
            clearComposerMode();
            clearComposer();
            startNewChat();
            onSelectThread?.();
          }}
          type="button"
        >
          <Plus className="size-4" />
        </button>
      </SidebarHeader>

      <SidebarContent>
        <div className="grid gap-1.5 px-3">
          {draft ? (
            <NewChatRow
              active={draft.id === activeDraftId}
              cwd={draft.cwd}
              onSelect={() => {
                clearComposerMode();
                selectDraft();
                onSelectThread?.();
              }}
            />
          ) : null}
          {historyStatus === 'loading' && threads.length === 0 ? (
            <HistoryStatusRow icon="loading" message="Loading history" />
          ) : null}
          {historyStatus === 'failed' && threads.length === 0 ? (
            <HistoryErrorRow
              message={historyError ?? 'History unavailable'}
              onRetry={() => {
                void loadThreadHistory();
              }}
            />
          ) : null}
          {historyStatus === 'ready' && threads.length === 0 ? (
            <HistoryStatusRow icon="empty" message="No recent threads" />
          ) : null}
          {threads.map((thread) => (
            <ThreadRow
              active={!activeDraftId && thread.id === activeThreadId}
              key={thread.id}
              onSelect={() => {
                clearComposerMode();
                if (activeDraftId && draft?.cwd) {
                  saveActiveDraftSnapshot(composerSnapshot);
                  clearComposer();
                } else if (draft) {
                  clearComposer();
                }
                void selectThread(thread.id);
                onSelectThread?.();
              }}
              thread={thread}
            />
          ))}
        </div>
      </SidebarContent>
    </>
  );
}

function HistoryStatusRow({ icon, message }: { icon: 'empty' | 'loading'; message: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2.5 text-xs text-muted-foreground">
      {icon === 'loading' ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <History className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate">{message}</span>
    </div>
  );
}

function HistoryErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
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

function NewChatRow({
  active,
  cwd,
  onSelect,
}: {
  active: boolean;
  cwd: string | null;
  onSelect: () => void;
}) {
  const label = cwd ? shortenPath(cwd) : 'Pick a directory';

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
      <div className="truncate text-xs leading-5 text-muted-foreground">Choose a directory and send a message</div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-warning" />
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/85">{label}</span>
      </div>
    </button>
  );
}

function ThreadRow({ active, thread, onSelect }: { active: boolean; thread: CodexThreadSummary; onSelect: () => void }) {
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
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{threadTitle(thread)}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatRelativeTime(thread.updatedAt)}</span>
      </div>
      <div className="truncate text-xs leading-5 text-muted-foreground">{thread.preview || 'No preview available'}</div>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('size-2 shrink-0 rounded-full', isActiveThreadStatus(thread.status) ? 'bg-warning' : 'bg-success')} />
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/85">{shortenPath(thread.cwd)}</span>
      </div>
    </button>
  );
}

function isActiveThreadStatus(status: unknown) {
  return Boolean(status && typeof status === 'object' && (status as { type?: unknown }).type === 'active');
}
