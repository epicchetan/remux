import type { ReactNode } from 'react';
import {
  Bot,
  Brain,
  FilePenLine,
  FolderOpen,
  Search,
  TerminalSquare,
  Wrench,
} from 'lucide-react';

import { cn } from '@remux/viewer-kit/shadcn';
import type {
  AgentToolPresentation,
} from '../../../../../shared/transcript.ts';

export type LiveActivityKind = AgentToolPresentation['category'] | 'agent' | 'thinking';

export function LiveActivity({
  animated = true,
  className,
  kind,
  label,
}: {
  animated?: boolean;
  className?: string;
  kind: LiveActivityKind;
  label: string;
}) {
  const icon = liveActivityIcon(kind);
  return (
    <span
      aria-label={animated ? label : undefined}
      className={cn('agent-live-activity', className)}
      data-animated={animated ? 'true' : 'false'}
      role={animated ? 'status' : undefined}
    >
      <ActivityContent icon={icon} label={label} />
      {animated ? (
        <span aria-hidden="true" className="agent-live-activity-focus">
          <span className="agent-live-activity-focus-counter">
            <span className="agent-live-activity-focus-aligned">
              <ActivityContent icon={icon} label={label} />
            </span>
          </span>
        </span>
      ) : null}
    </span>
  );
}

function ActivityContent({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="agent-live-activity-content">
      <span className="agent-live-activity-icon">{icon}</span>
      <span className="agent-live-activity-label">{label}</span>
    </span>
  );
}

function liveActivityIcon(kind: LiveActivityKind) {
  const Icon = kind === 'command'
    ? TerminalSquare
    : kind === 'edit'
      ? FilePenLine
      : kind === 'read'
        ? FolderOpen
        : kind === 'search'
          ? Search
          : kind === 'agent'
            ? Bot
            : kind === 'thinking'
              ? Brain
              : Wrench;
  return <Icon className="size-4" />;
}
