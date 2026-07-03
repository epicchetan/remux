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

const syntheticClickWindowMs = 500;

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
  const lastPointerUpMsRef = useRef(Number.NEGATIVE_INFINITY);
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
          // Pointer gestures already activated on pointerup; the browser's
          // synthetic click can arrive arbitrarily late, so gate it on recent
          // pointer activity instead of the activation debounce alone. Clicks
          // with no pointer history (keyboard, assistive tech) still activate.
          if (performance.now() - lastPointerUpMsRef.current > syntheticClickWindowMs) {
            activateOnce();
          }
          return;
        }

        event.currentTarget.blur();
        onClick?.();
      }}
      onMouseDown={preserveFocus ? (event) => event.preventDefault() : undefined}
      onPointerDown={preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        // A fresh press starts a new gesture: the activation debounce only
        // dedupes the pointerup/touchend/click fan-out of a single tap, so it
        // must never carry across into the next deliberate tap.
        lastActivationMsRef.current = Number.NEGATIVE_INFINITY;
      } : undefined}
      onPointerUp={preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        lastPointerUpMsRef.current = performance.now();
        activateOnce();
      } : undefined}
      onTouchEnd={preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        lastPointerUpMsRef.current = performance.now();
        activateOnce();
      } : undefined}
      onTouchStart={preserveFocus ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.touches.length === 1) {
          lastActivationMsRef.current = Number.NEGATIVE_INFINITY;
        }
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
