import { Loader2, Send } from 'lucide-react';

export function ComposerSendButton({ busy, disabled, directLabel, onSend }: {
  busy: boolean;
  disabled: boolean;
  directLabel: string;
  onSend: () => void;
}) {
  return <button type="button"
    className={`remux-composer-action-button remux-composer-send-button${busy ? ' is-busy' : ''}`}
    aria-label={busy ? 'Sending message' : directLabel}
    title={directLabel}
    disabled={disabled}
    onPointerDown={event => event.preventDefault()}
    onClick={onSend}>
    {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
  </button>;
}
