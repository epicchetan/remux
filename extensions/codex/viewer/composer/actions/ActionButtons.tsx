import { useCallback, useRef, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Check, History, Loader2, PanelRightOpen, Send, Square } from 'lucide-react';

import { openHostOverview } from '../../ipc/host';
import { useSidebarStore } from '../../threads/sidebarStore';
import { parentDirectory, useThreadsStore } from '../../threads/store';
import { useTranscriptViewportControls } from '../../transcript';
import { ComposerAttachmentButton } from '../attachments/AttachmentButton';
import { ComposerConfigButton } from '../config/ConfigButton';
import { useComposerTurnAction } from './turnAction';

type ComposerAction = {
  busy?: boolean;
  className?: string;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  preserveFocus?: boolean;
  tone?: 'default' | 'send';
};

export function ComposerActionButtons() {
  const { canScrollDown, canScrollUp, scrollDown, scrollUp } = useTranscriptViewportControls();
  const openMobileSidebar = useSidebarStore((state) => state.openMobile);
  const directoryPickerOpen = useThreadsStore((state) => state.directoryPickerOpen);
  const directoryPickerPath = useThreadsStore((state) => state.directoryPickerPath);
  const draft = useThreadsStore((state) =>
    state.activeDraftId && state.draft?.id === state.activeDraftId ? state.draft : null);
  const goToParentDirectory = useThreadsStore((state) => state.goToParentDirectory);
  const selectDirectoryPickerPath = useThreadsStore((state) => state.selectDirectoryPickerPath);
  const turn = useComposerTurnAction();
  const pickingDirectory = Boolean(draft && directoryPickerOpen);
  const directoryParent = directoryPickerPath ? parentDirectory(directoryPickerPath) : null;

  const leftActions: ComposerAction[] = [
    {
      className: 'remux-composer-overview-button',
      icon: <PanelRightOpen className="size-4" />,
      label: 'Open tabs',
      onClick: () => {
        void openHostOverview({ section: 'tabs' });
      },
    },
    {
      className: 'remux-composer-sidebar-button',
      icon: <History className="size-4" />,
      label: 'Open history',
      onClick: openMobileSidebar,
    },
  ];
  const scrollActions: ComposerAction[] = [
    { disabled: !canScrollUp, icon: <ArrowUp className="size-4" />, label: 'Previous turn', onClick: scrollUp },
    {
      disabled: !canScrollDown,
      icon: <ArrowDown className="size-4" />,
      label: 'Next turn or bottom',
      onClick: scrollDown,
    },
  ];
  const turnAction: ComposerAction = {
    busy: turn.isSubmitting || turn.isStopping,
    disabled: turn.sendDisabled,
    icon: turn.isSubmitting || turn.isStopping
      ? <Loader2 className="size-4 animate-spin" />
      : turn.isWorking
        ? <Square className="size-4 fill-current" />
        : <Send className="size-4" />,
    label: turn.isStopping
      ? 'Stopping turn'
      : turn.isSubmitting
      ? 'Sending message'
      : turn.isWorking
        ? 'Stop turn'
        : turn.editTarget
          ? 'Save edited message'
          : turn.forkTarget
            ? 'Send forked message'
            : 'Send message',
    onClick: turn.handleTurnAction,
    tone: 'send',
  };
  const directoryActions: ComposerAction[] = [
    {
      disabled: !directoryParent,
      icon: <ArrowLeft className="size-4" />,
      label: 'Parent directory',
      onClick: goToParentDirectory,
      preserveFocus: true,
    },
    {
      disabled: !directoryPickerPath,
      icon: <Check className="size-4" />,
      label: 'Select directory',
      onClick: selectDirectoryPickerPath,
      preserveFocus: true,
      tone: 'send',
    },
  ];

  return (
    <div className="remux-composer-actions">
      <div className="remux-composer-action-group">
        {leftActions.map((action) => (
          <ComposerActionKey action={action} key={action.label} />
        ))}
        <ComposerConfigButton disabled={pickingDirectory} />
      </div>
      <div className="remux-composer-action-group remux-composer-action-group-right">
        {(pickingDirectory ? directoryActions : scrollActions).map((action) => (
          <ComposerActionKey action={action} key={action.label} />
        ))}
        {pickingDirectory ? null : (
          <>
            <ComposerAttachmentButton />
            <ComposerActionKey action={turnAction} />
          </>
        )}
      </div>
    </div>
  );
}

function ComposerActionKey({ action }: { action: ComposerAction }) {
  const lastActivationMsRef = useRef<number | null>(null);
  const activateOnce = useCallback(() => {
    const now = performance.now();
    if (lastActivationMsRef.current !== null && now - lastActivationMsRef.current < 350) {
      return;
    }

    lastActivationMsRef.current = now;
    action.onClick?.();
  }, [action]);

  return (
    <button
      aria-label={action.label}
      className={`remux-composer-action-button${action.tone === 'send' ? ' remux-composer-send-button' : ''}${action.busy ? ' is-busy' : ''}${action.className ? ` ${action.className}` : ''}`}
      data-remux-preserve-focus={action.preserveFocus ? 'true' : undefined}
      disabled={action.disabled}
      onClick={(event) => {
        if (action.preserveFocus) {
          event.preventDefault();
          event.stopPropagation();
          activateOnce();
          return;
        }

        if (!action.preserveFocus) {
          event.currentTarget.blur();
        }
        action.onClick?.();
      }}
      onMouseDown={action.preserveFocus ? (event) => event.preventDefault() : undefined}
      onPointerDown={action.preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
      } : undefined}
      onPointerUp={action.preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        activateOnce();
      } : undefined}
      onTouchStart={action.preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
      } : undefined}
      onTouchEnd={action.preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        activateOnce();
      } : undefined}
      type="button"
    >
      {action.icon}
    </button>
  );
}
