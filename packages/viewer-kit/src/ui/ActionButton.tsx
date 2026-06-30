import { useCallback, useRef, type ReactNode } from 'react';

export type ActionButtonProps = {
  ariaExpanded?: boolean;
  ariaHasPopup?: boolean | 'menu';
  activationDebounceMs?: number;
  busy?: boolean;
  className?: string;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  preserveFocus?: boolean;
  tone?: 'default' | 'primary';
};

export function ActionButton({
  ariaExpanded,
  ariaHasPopup,
  activationDebounceMs = 350,
  busy,
  className,
  disabled,
  icon,
  label,
  onClick,
  preserveFocus,
  tone = 'default',
}: ActionButtonProps) {
  const lastActivationMsRef = useRef(Number.NEGATIVE_INFINITY);
  const activateOnce = useCallback(() => {
    const now = performance.now();
    if (now - lastActivationMsRef.current < activationDebounceMs) {
      return;
    }

    lastActivationMsRef.current = now;
    onClick?.();
  }, [activationDebounceMs, onClick]);

  return (
    <button
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
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

/** @deprecated Use ActionButton instead. */
export const ExtensionActionButton = ActionButton;

/** @deprecated Use ActionButtonProps instead. */
export type ExtensionActionButtonProps = ActionButtonProps;
