import {
  forwardRef,
  useCallback,
  useRef,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

type KeyboardPickerFrameProps = Omit<ComponentPropsWithoutRef<'section'>, 'children'> & {
  children: ReactNode;
  laneClassName?: string;
};

export const KeyboardPickerFrame = forwardRef<HTMLElement, KeyboardPickerFrameProps>(function KeyboardPickerFrame(
  { children, laneClassName, ...props },
  ref,
) {
  return (
    <section {...props} data-remux-no-composer-focus ref={ref}>
      <div className={laneClassName}>{children}</div>
    </section>
  );
});

type KeyboardPickerListProps = ComponentPropsWithoutRef<'div'>;

export function KeyboardPickerList({ role = 'listbox', ...props }: KeyboardPickerListProps) {
  return <div {...props} role={role} />;
}

type KeyboardPickerRowProps = Omit<ComponentPropsWithoutRef<'div'>, 'onSelect'> & {
  active?: boolean;
  children: ReactNode;
  focusable?: boolean;
  onActivate: () => void;
};

export const KeyboardPickerRow = forwardRef<HTMLDivElement, KeyboardPickerRowProps>(function KeyboardPickerRow(
  {
    active,
    children,
    focusable = false,
    onActivate,
    onKeyDown,
    onMouseDown,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    role = 'option',
    tabIndex,
    ...props
  },
  ref,
) {
  const tapRef = useRef<{ moved: boolean; pointerId: number; x: number; y: number } | null>(null);
  const lastActivationMsRef = useRef(0);
  const activateOnce = useCallback(() => {
    const now = performance.now();
    if (now - lastActivationMsRef.current < 350) {
      return;
    }

    lastActivationMsRef.current = now;
    onActivate();
  }, [onActivate]);

  return (
    <div
      {...props}
      aria-selected={active}
      data-remux-keyboard-picker-row="true"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !keyboardActivationKey(event)) {
          return;
        }

        event.preventDefault();
        activateOnce();
      }}
      onMouseDown={(event) => {
        onMouseDown?.(event);
        if (!event.defaultPrevented) {
          event.preventDefault();
        }
      }}
      onPointerCancel={(event) => {
        tapRef.current = null;
        onPointerCancel?.(event);
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (event.defaultPrevented || !event.isPrimary || event.button !== 0) {
          return;
        }

        event.preventDefault();
        tapRef.current = {
          moved: false,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        };
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        const tap = tapRef.current;
        if (!tap || tap.pointerId !== event.pointerId || tap.moved) {
          return;
        }

        if (Math.abs(event.clientX - tap.x) > 8 || Math.abs(event.clientY - tap.y) > 8) {
          tap.moved = true;
        }
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        const tap = tapRef.current;
        tapRef.current = null;

        if (event.defaultPrevented || !tap || tap.pointerId !== event.pointerId || tap.moved) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        activateOnce();
      }}
      ref={ref}
      role={role}
      tabIndex={focusable ? (tabIndex ?? 0) : tabIndex}
    >
      {children}
    </div>
  );
});

function keyboardActivationKey(event: KeyboardEvent<HTMLElement>) {
  return event.key === 'Enter' || event.key === ' ';
}
