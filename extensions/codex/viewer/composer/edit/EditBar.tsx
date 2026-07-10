import { GitFork, Pencil, X } from 'lucide-react';

import { useComposerStore } from '../store';

export function ComposerEditBar() {
  const cancelEdit = useComposerStore((state) => state.cancelEdit);
  const cancelFork = useComposerStore((state) => state.cancelFork);
  const editTarget = useComposerStore((state) => state.editTarget);
  const forkTarget = useComposerStore((state) => state.forkTarget);

  if (!editTarget && !forkTarget) {
    return null;
  }

  const mode = editTarget
    ? {
        icon: <Pencil className="size-3.5" />,
        label: 'Editing message',
        cancelLabel: 'Cancel edit',
        onCancel: cancelEdit,
      }
    : {
        icon: <GitFork className="size-3.5" />,
        label: 'Forking from response',
        cancelLabel: 'Cancel fork',
        onCancel: cancelFork,
      };

  return (
    <div className="remux-composer-context-row remux-composer-edit-bar" data-remux-no-composer-focus>
      <span className="remux-composer-edit-label">
        {mode.icon}
        {mode.label}
      </span>
      <button
        aria-label={mode.cancelLabel}
        className="remux-composer-edit-cancel"
        onClick={mode.onCancel}
        onPointerDown={(event) => {
          event.preventDefault();
        }}
        type="button"
      >
        <X className="size-4" />
        Cancel
      </button>
    </div>
  );
}
