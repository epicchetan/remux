import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ListPlus, Loader2, Send } from 'lucide-react';
import type { ComposerDeliveryState } from '../model/deliveryChoice.ts';

type Delivery = 'auto' | 'queue';
type OpenMenu = { choices: Delivery[]; keyboard: boolean };

export function ComposerSendButton({ busy, disabled, directLabel, delivery, useMenu, scopeKey, onSend, onDelivery }: {
  busy: boolean;
  disabled: boolean;
  directLabel: string;
  delivery: ComposerDeliveryState;
  useMenu: boolean;
  scopeKey: string;
  onSend: () => void;
  onDelivery: (delivery: Delivery) => void;
}) {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pointerMenu = useRef<OpenMenu | null | undefined>(undefined);
  const id = useId();
  const usesMenu = useMenu && delivery.menu;
  const choices = (): Delivery[] => delivery.currentAllowed ? ['auto', 'queue'] : delivery.queueAllowed ? ['queue'] : [];
  const close = (restoreFocus = false) => {
    setOpen(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };

  useEffect(() => { setOpen(null); pointerMenu.current = undefined; }, [scopeKey, busy]);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (open?.keyboard) (menu.current?.querySelector<HTMLElement>('[role="menuitem"]') ?? menu.current)?.focus();
  }, [open]);

  return <div className="remux-composer-config remux-composer-send-menu" ref={root}
    data-remux-no-composer-focus
    onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(null);
    }}>
    <button ref={trigger} id={`${id}-trigger`} type="button"
      className={`remux-composer-action-button remux-composer-send-button${busy ? ' is-busy' : ''}`}
      aria-label={busy ? 'Sending message' : usesMenu || open ? 'Choose message delivery' : directLabel}
      aria-haspopup={usesMenu || open ? 'menu' : undefined}
      aria-expanded={usesMenu || open ? Boolean(open) : undefined}
      aria-controls={open ? `${id}-menu` : undefined}
      title={usesMenu ? 'Choose how to send this message' : directLabel}
      disabled={disabled}
      onPointerDown={(event) => {
        // Remember that this press opened options even if the parent finishes before release.
        pointerMenu.current = usesMenu ? { choices: choices(), keyboard: false } : null;
        event.preventDefault();
      }}
      onPointerCancel={() => { pointerMenu.current = undefined; }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' && usesMenu) {
          event.preventDefault();
          setOpen({ choices: choices(), keyboard: true });
        }
      }}
      onClick={(event) => {
        const requestedMenu = pointerMenu.current;
        pointerMenu.current = undefined;
        if (open) { close(); return; }
        if (requestedMenu || usesMenu) {
          setOpen(requestedMenu ?? { choices: choices(), keyboard: event.detail === 0 });
        } else onSend();
      }}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
      {!busy && (usesMenu || open) ? <ChevronDown className="remux-composer-send-chevron" aria-hidden="true" /> : null}
    </button>
    {open ? <div ref={menu} id={`${id}-menu`} role="menu" aria-label="Message delivery"
      className="remux-composer-config-panel remux-composer-send-panel" tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Tab') { close(true); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {delivery.reason || open.choices.length === 0 ? <p className="remux-composer-delivery-reason" role="status">
        {delivery.reason ?? 'Delivery is available again. Reopen Send to choose how to send.'}
      </p> : null}
      {open.choices.map((choice, index) => {
        const enabled = !disabled && (choice === 'auto' ? delivery.currentAllowed : delivery.queueAllowed);
        const label = choice === 'auto' ? (delivery.active ? 'Send to current turn' : 'Send message') : delivery.queueLabel;
        const description = choice === 'auto'
          ? delivery.active ? 'Let the agent incorporate this into its ongoing response.' : 'The parent is ready for a new message.'
          : delivery.queueDescription;
        return <button key={choice} role="menuitem" type="button" tabIndex={index === 0 ? 0 : -1}
          aria-label={label} aria-disabled={!enabled}
          className="remux-composer-delivery-option"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!enabled) return;
            close();
            onDelivery(choice);
          }}>
          {choice === 'auto' ? <Send className="size-4" aria-hidden="true" /> : <ListPlus className="size-4" aria-hidden="true" />}
          <span><strong>{label}</strong><span>{description}</span></span>
        </button>;
      })}
    </div> : null}
  </div>;
}
