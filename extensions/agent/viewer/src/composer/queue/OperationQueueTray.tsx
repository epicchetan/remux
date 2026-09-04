import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';

import type { AgentPendingQueueEntry, AgentPendingQueueValue } from '../../../../shared/protocol.ts';
import { agentCommands } from '../../ipc/agentCommands.ts';

export function OperationQueueTray({ onChanged, queue }: {
  onChanged: () => Promise<void>;
  queue: AgentPendingQueueValue | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  if (!queue || queue.entries.length === 0) return null;

  const remove = async (turnId: string) => {
    setPendingId(turnId);
    try {
      await agentCommands.removeQueued(queue.conversationId, turnId);
      await onChanged();
    } finally {
      setPendingId(null);
    }
  };
  const first = queue.entries[0]!;
  return (
    <div className="remux-operation-queue" data-remux-no-composer-focus>
      <div className="remux-composer-context-row remux-operation-queue-summary">
        <button
          aria-expanded={expanded}
          className="remux-operation-queue-disclosure"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          <span className="remux-operation-queue-count">Queued {queue.entries.length}</span>
          <span className="remux-operation-queue-preview">{entryLabel(first)}</span>
        </button>
      </div>
      {expanded ? (
        <div className="remux-operation-queue-list">
          {queue.entries.map((entry, index) => (
            <div className="remux-operation-queue-row" key={entry.id}>
              <span className="remux-operation-queue-index">{index + 1}</span>
              <span className="remux-operation-queue-row-copy">
                <span className="remux-operation-queue-row-title">{entryLabel(entry)}</span>
              </span>
              <span className="remux-operation-queue-row-actions">
                <QueueIconButton disabled={pendingId === entry.id} label="Delete queued entry" onClick={() => {
                  void remove(entry.id);
                }}><Trash2 className="size-3.5" /></QueueIconButton>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QueueIconButton({ children, disabled, label, onClick }: {
  children: ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="remux-operation-queue-button"
      disabled={disabled}
      onClick={onClick}
      onPointerDown={(event) => event.preventDefault()}
      type="button"
    >
      {children}
    </button>
  );
}

function entryLabel(entry: AgentPendingQueueEntry) {
  return entry.text || (entry.attachmentCount ? 'Image message' : 'Message');
}
