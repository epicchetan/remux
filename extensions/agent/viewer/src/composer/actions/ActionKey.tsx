import { useCallback, useRef, type ReactNode } from 'react';

export type ComposerAction = {
  busy?: boolean;
  className?: string;
  testId?: string;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  preserveFocus?: boolean;
  tone?: 'default' | 'send';
  title?: string;
};

export function ComposerActionKey({ action }: { action: ComposerAction }) {
  const lastActivationRef = useRef<number | null>(null);
  const activateOnce = useCallback(() => {
    const now = performance.now();
    if (lastActivationRef.current !== null && now - lastActivationRef.current < 350) return;
    lastActivationRef.current = now;
    action.onClick?.();
  }, [action]);

  return (
    <button
      aria-label={action.label}
      className={`remux-composer-action-button${action.tone === 'send' ? ' remux-composer-send-button' : ''}${action.busy ? ' is-busy' : ''}${action.className ? ` ${action.className}` : ''}`}
      data-testid={action.testId}
      data-remux-preserve-focus={action.preserveFocus ? 'true' : undefined}
      disabled={action.disabled}
      onClick={(event) => {
        if (action.preserveFocus) {
          event.preventDefault();
          event.stopPropagation();
          activateOnce();
          return;
        }
        event.currentTarget.blur();
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
      type="button"
      title={action.title}
    >
      {action.icon}
    </button>
  );
}
