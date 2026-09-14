import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';

import type { AgentPendingQueueEntry, AgentPendingQueueValue } from '../../../../shared/protocol.ts';
import type { AgentRuntimeResource } from '../../../../shared/native-agent-protocol.ts';
import { agentCommands } from '../../ipc/agentCommands.ts';

export function OperationQueueTray({ onChanged, queue, runtime }: {
  onChanged: () => Promise<void>;
  queue: AgentPendingQueueValue | null;
  runtime: AgentRuntimeResource | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const operation = runtime?.compaction.operation;
  const pendingCompact = operation?.state === 'running' && runtime?.compaction.pendingPhase !== 'queued';
  if ((!queue || queue.entries.length === 0) && !pendingCompact) return null;

  const remove = async (turnId: string) => {
    setPendingId(turnId);
    try {
      await agentCommands.removeQueued(queue!.conversationId, turnId);
      await onChanged();
    } finally {
      setPendingId(null);
    }
  };
  const first = queue?.entries[0];
  const label = (entry: AgentPendingQueueEntry) => entry.kind === 'compact'
    ? `Compaction queued · ${runtime?.activeTurnId && queue?.entries[0]?.id === entry.id
      ? 'after this response' : 'after earlier work'}` : entryLabel(entry);
  return (
    <div className="remux-operation-queue" data-remux-no-composer-focus>
      {pendingCompact ? <div className="remux-composer-context-row" role="status">
        {runtime?.compaction.pendingPhase === 'requested'
          ? 'Compaction requested · waiting to start' : 'Compacting context…'}
      </div> : null}
      {first ? <div className="remux-composer-context-row remux-operation-queue-summary">
        <button
          aria-expanded={expanded}
          className="remux-operation-queue-disclosure"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          <span className="remux-operation-queue-count">Queued {queue!.entries.length}</span>
          <span className="remux-operation-queue-preview">{label(first)}</span>
        </button>
      </div> : null}
      {expanded && queue ? (
        <div className="remux-operation-queue-list">
          {queue.entries.map((entry, index) => (
            <div className="remux-operation-queue-row" key={entry.id}>
              <span className="remux-operation-queue-index">{index + 1}</span>
              <span className="remux-operation-queue-row-copy">
                <span className="remux-operation-queue-row-title">{label(entry)}</span>
              </span>
              <span className="remux-operation-queue-row-actions">
                <QueueIconButton
                  disabled={pendingId === entry.id || entry.state === 'dispatching'}
                  label="Delete queued entry"
                  onClick={() => {
                    void remove(entry.id);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </QueueIconButton>
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
  const message = entry.text || (entry.attachmentCount ? 'Image message' : 'Message');
  if (entry.state === 'dispatching') return `Sending — ${message}`;
  if (entry.state === 'delivery-unknown') return `Delivery uncertain — ${message}`;
  if (entry.state === 'delivery-failed') return `Not sent — ${message}`;
  if (entry.state === 'blocked') return `Waiting for provider — ${message}`;
  return message;
}
