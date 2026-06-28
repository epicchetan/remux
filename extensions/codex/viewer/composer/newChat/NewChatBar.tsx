import { FolderOpen } from 'lucide-react';

import { useThreadsStore } from '../../threads/store';
import { shortenPath } from '../../threads/threadFormat';

export function NewChatBar() {
  const draft = useThreadsStore((state) =>
    state.activeDraftId && state.draft?.id === state.activeDraftId ? state.draft : null);
  const openDirectoryPicker = useThreadsStore((state) => state.openDirectoryPicker);

  if (!draft?.cwd) {
    return null;
  }

  return (
    <div className="remux-new-chat-bar" data-remux-no-composer-focus>
      <button
        className="remux-new-chat-cwd-button"
        onClick={(event) => {
          event.currentTarget.blur();
          openDirectoryPicker();
        }}
        type="button"
      >
        <FolderOpen className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono">{shortenPath(draft.cwd)}</span>
      </button>
    </div>
  );
}
