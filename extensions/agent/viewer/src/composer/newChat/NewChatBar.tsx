import { FolderOpen, Plus } from 'lucide-react';

import { shortenPath } from '../../conversation/format.ts';

export function NewChatBar({ cwd, locked, onNewChat, onOpenDirectory }: {
  cwd: string;
  locked: boolean;
  onNewChat: () => void;
  onOpenDirectory: () => void;
}) {
  if (!cwd) return null;
  return (
    <div className="remux-new-chat-bar" data-remux-no-composer-focus>
      <button
        aria-label="Choose workspace"
        className="remux-new-chat-cwd-button"
        disabled={locked}
        onClick={onOpenDirectory}
        type="button"
      >
        <FolderOpen className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono">{shortenPath(cwd)}</span>
      </button>
      {locked ? (
        <button aria-label="New chat" className="remux-new-chat-action" onClick={onNewChat} type="button">
          <Plus className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
