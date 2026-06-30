import type { ReactNode } from 'react';

export type ActionBarProps = {
  className?: string;
  left?: ReactNode;
  right?: ReactNode;
  status?: ReactNode;
};

export function ActionBar({
  className,
  left,
  right,
  status,
}: ActionBarProps) {
  return (
    <div className={className ? `remux-extension-action-bar ${className}` : 'remux-extension-action-bar'}>
      <div className="remux-extension-action-group">{left}</div>
      <div className="remux-extension-action-group remux-extension-action-group-right">{right}</div>
      {status ? <div className="remux-extension-action-status">{status}</div> : null}
    </div>
  );
}

/** @deprecated Use ActionBar instead. */
export const ExtensionActionBar = ActionBar;

/** @deprecated Use ActionBarProps instead. */
export type ExtensionActionBarProps = ActionBarProps;
