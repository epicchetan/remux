import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { ExtensionActionButton } from './ActionButton';

type ActionMenuContextValue = {
  close: () => void;
  preserveFocus: boolean;
};

const ActionMenuContext = createContext<ActionMenuContextValue | null>(null);

export type ExtensionActionMenuProps = {
  align?: 'end' | 'start';
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  panelClassName?: string;
  preserveFocus?: boolean;
  triggerClassName?: string;
};

export function ExtensionActionMenu({
  align = 'end',
  children,
  className,
  disabled = false,
  icon,
  label,
  panelClassName,
  preserveFocus = false,
  triggerClassName,
}: ExtensionActionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (!open) {
      return undefined;
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
    <div
      className={[
        'remux-extension-action-menu',
        className ?? '',
      ].filter(Boolean).join(' ')}
      ref={rootRef}
    >
      <ExtensionActionButton
        activationDebounceMs={80}
        ariaExpanded={open}
        ariaHasPopup="menu"
        className={[
          'remux-extension-action-menu-trigger',
          triggerClassName ?? '',
        ].filter(Boolean).join(' ')}
        disabled={disabled}
        icon={icon}
        label={label}
        onClick={() => setOpen((current) => !current)}
        preserveFocus={preserveFocus}
      />

      {open ? (
        <ActionMenuContext.Provider value={{ close: () => setOpen(false), preserveFocus }}>
          <div
            className={[
              'remux-extension-action-menu-panel',
              `remux-extension-action-menu-panel-${align}`,
              panelClassName ?? '',
            ].filter(Boolean).join(' ')}
            role="menu"
          >
            {children}
          </div>
        </ActionMenuContext.Provider>
      ) : null}
    </div>
  );
}

export type ExtensionActionMenuItemProps = {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onSelect?: () => void;
  tone?: 'danger' | 'default';
};

export function ExtensionActionMenuItem({
  disabled = false,
  icon,
  label,
  onSelect,
  tone = 'default',
}: ExtensionActionMenuItemProps) {
  const menu = useContext(ActionMenuContext);
  const preserveFocus = menu?.preserveFocus ?? false;

  return (
    <button
      className={[
        'remux-extension-action-menu-item',
        tone === 'danger' ? 'is-danger' : '',
      ].filter(Boolean).join(' ')}
      disabled={disabled}
      onClick={(event) => {
        if (!preserveFocus) {
          event.currentTarget.blur();
        }

        if (disabled) {
          return;
        }

        menu?.close();
        onSelect?.();
      }}
      onPointerDown={preserveFocus ? (event) => event.preventDefault() : undefined}
      role="menuitem"
      type="button"
    >
      <span className="remux-extension-action-menu-item-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="remux-extension-action-menu-item-label">{label}</span>
    </button>
  );
}
