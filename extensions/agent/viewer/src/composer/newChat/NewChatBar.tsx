import { FolderOpen } from 'lucide-react';

import { shortenPath } from '../../conversation/format.ts';

export function NewChatBar({ cwd, onOpenDirectory }: {
  cwd: string;
  onOpenDirectory: () => void;
}) {
  if (!cwd) return null;
  return (
    <div className="remux-new-chat-bar" data-remux-no-composer-focus>
      <button
        aria-label="Choose workspace"
        className="remux-new-chat-cwd-button"
        onClick={(event) => {
          event.currentTarget.blur();
          onOpenDirectory();
        }}
        type="button"
      >
        <FolderOpen className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono">{shortenPath(cwd)}</span>
      </button>
    </div>
  );
}
