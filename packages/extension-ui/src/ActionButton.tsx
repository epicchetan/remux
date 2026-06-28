import { useCallback, useRef, type ReactNode } from 'react';

export type ExtensionActionButtonProps = {
  busy?: boolean;
  className?: string;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  preserveFocus?: boolean;
  tone?: 'default' | 'primary';
};

export function ExtensionActionButton({
  busy,
  className,
  disabled,
  icon,
  label,
  onClick,
  preserveFocus,
  tone = 'default',
}: ExtensionActionButtonProps) {
  const lastActivationMsRef = useRef(0);
  const activateOnce = useCallback(() => {
    const now = performance.now();
    if (now - lastActivationMsRef.current < 350) {
      return;
    }

    lastActivationMsRef.current = now;
    onClick?.();
  }, [onClick]);

  return (
    <button
      aria-label={label}
      className={[
        'remux-extension-action-button',
        tone === 'primary' ? 'remux-extension-action-button-primary' : '',
        busy ? 'is-busy' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      data-remux-preserve-focus={preserveFocus ? 'true' : undefined}
      disabled={disabled}
      onClick={(event) => {
        if (preserveFocus) {
          event.preventDefault();
          event.stopPropagation();
          activateOnce();
          return;
        }

        event.currentTarget.blur();
        onClick?.();
      }}
      onMouseDown={preserveFocus ? (event) => event.preventDefault() : undefined}
      onPointerDown={preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
      } : undefined}
      onPointerUp={preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        activateOnce();
      } : undefined}
      onTouchEnd={preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        activateOnce();
      } : undefined}
      onTouchStart={preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
      } : undefined}
      type="button"
    >
      {icon}
    </button>
  );
}
