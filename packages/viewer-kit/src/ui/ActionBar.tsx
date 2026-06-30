import type { ReactNode } from 'react';

export type ExtensionActionBarProps = {
  className?: string;
  left?: ReactNode;
  right?: ReactNode;
  status?: ReactNode;
};

export function ExtensionActionBar({
  className,
  left,
  right,
  status,
}: ExtensionActionBarProps) {
  return (
    <div className={className ? `remux-extension-action-bar ${className}` : 'remux-extension-action-bar'}>
      <div className="remux-extension-action-group">{left}</div>
      <div className="remux-extension-action-group remux-extension-action-group-right">{right}</div>
      {status ? <div className="remux-extension-action-status">{status}</div> : null}
    </div>
  );
}
