import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Folder, Images, Paperclip } from 'lucide-react';

import { type ComposerAttachmentPickerKind, useComposerStore } from '../store';

const attachmentActions: Array<{
  icon: ReactNode;
  kind: ComposerAttachmentPickerKind;
  label: string;
}> = [
  { icon: <Images className="size-4" />, kind: 'photo-library', label: 'Photo Library' },
  { icon: <Folder className="size-4" />, kind: 'files', label: 'Choose Files' },
];

export function ComposerAttachmentButton() {
  const isSubmitting = useComposerStore((state) => state.isSubmitting);
  const openAttachmentPicker = useComposerStore((state) => state.openAttachmentPicker);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isSubmitting) {
      setOpen(false);
    }
  }, [isSubmitting]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="remux-composer-config remux-composer-attachment-menu" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-label="Attach"
        className="remux-composer-action-button"
        disabled={isSubmitting}
        onClick={(event) => {
          event.currentTarget.blur();
          setOpen((current) => !current);
        }}
        onPointerDown={(event) => event.preventDefault()}
        type="button"
      >
        <Paperclip className="size-4" />
      </button>

      {open ? (
        <div className="remux-composer-config-panel remux-composer-attachment-panel">
          {attachmentActions.map((action) => (
            <button
              className="remux-composer-config-row"
              key={action.kind}
              onClick={(event) => {
                event.currentTarget.blur();
                setOpen(false);
                openAttachmentPicker(action.kind);
              }}
              onPointerDown={(event) => event.preventDefault()}
              type="button"
            >
              <span className="remux-composer-config-icon" aria-hidden="true">
                {action.icon}
              </span>
              <span className="remux-composer-config-label">{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
