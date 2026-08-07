import {
  forwardRef,
  useCallback,
  useRef,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

type FrameProps = Omit<ComponentPropsWithoutRef<'section'>, 'children'> & {
  children: ReactNode;
  laneClassName?: string;
};

export const KeyboardPickerFrame = forwardRef<HTMLElement, FrameProps>(function KeyboardPickerFrame(
  { children, laneClassName, ...props },
  ref,
) {
  return <section {...props} data-remux-no-composer-focus ref={ref}><div className={laneClassName}>{children}</div></section>;
});

export function KeyboardPickerList({ role = 'listbox', ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div {...props} role={role} />;
}

type RowProps = Omit<ComponentPropsWithoutRef<'div'>, 'onSelect'> & {
  active?: boolean;
  children: ReactNode;
  onActivate: () => void;
};

export const KeyboardPickerRow = forwardRef<HTMLDivElement, RowProps>(function KeyboardPickerRow(
  { active, children, onActivate, onKeyDown, onPointerCancel, onPointerDown, onPointerMove, onPointerUp, role = 'option', ...props },
  ref,
) {
  const tapRef = useRef<{ moved: boolean; pointerId: number; x: number; y: number } | null>(null);
  const lastActivationRef = useRef<number | null>(null);
  const activateOnce = useCallback(() => {
    const now = performance.now();
    if (lastActivationRef.current !== null && now - lastActivationRef.current < 350) return;
    lastActivationRef.current = now;
    onActivate();
  }, [onActivate]);

  return (
    <div
      {...props}
      aria-selected={active}
      data-remux-keyboard-picker-row="true"
      onClick={(event) => {
        event.preventDefault();
        activateOnce();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented && keyboardActivationKey(event)) {
          event.preventDefault();
          activateOnce();
        }
      }}
      onMouseDown={(event) => event.preventDefault()}
      onPointerCancel={(event) => {
        tapRef.current = null;
        onPointerCancel?.(event);
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (event.defaultPrevented || !event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        tapRef.current = { moved: false, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        const tap = tapRef.current;
        if (tap && tap.pointerId === event.pointerId && !tap.moved
          && (Math.abs(event.clientX - tap.x) > 8 || Math.abs(event.clientY - tap.y) > 8)) {
          tap.moved = true;
        }
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        const tap = tapRef.current;
        tapRef.current = null;
        if (event.defaultPrevented || !tap || tap.pointerId !== event.pointerId || tap.moved) return;
        event.preventDefault();
        event.stopPropagation();
        activateOnce();
      }}
      ref={ref}
      role={role}
      tabIndex={0}
    >
      {children}
    </div>
  );
});

function keyboardActivationKey(event: KeyboardEvent<HTMLElement>) {
  return event.key === 'Enter' || event.key === ' ';
}
