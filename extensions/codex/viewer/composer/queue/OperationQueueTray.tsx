import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Play, Trash2 } from 'lucide-react';

import type { CodexPendingQueueEntry } from '../../../shared/operationQueue';
import { removeThreadOperation, runThreadOperationNow } from '../../ipc/operationQueue';
import { applyCodexResourceInvalidations } from '../../ipc/resourceInvalidations';
import { refreshActiveOperationQueue, useOperationQueueStore } from '../../threads/operationQueueStore';

export function OperationQueueTray() {
  const queue = useOperationQueueStore((state) => state.queue);
  const [expanded, setExpanded] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (!queue || queue.entries.length === 0) return null;

  const mutate = async (
    entryId: string,
    request: () => ReturnType<typeof removeThreadOperation>,
  ) => {
    setPendingId(entryId);
    try {
      const response = await request();
      await applyCodexResourceInvalidations(response.invalidations);
      if (response.status === 'retained') await refreshActiveOperationQueue();
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
                {entry.kind === 'message' ? (
                  <QueueIconButton
                    disabled={pendingId === entry.id}
                    label="Send now"
                    onClick={() => void mutate(entry.id, () => runThreadOperationNow({
                      operationId: entry.id,
                      threadId: queue.threadId,
                    }))}
                  >
                    <Play className="size-3.5" />
                  </QueueIconButton>
                ) : null}
                <QueueIconButton
                  disabled={pendingId === entry.id}
                  label="Delete queued entry"
                  onClick={() => void mutate(entry.id, () => removeThreadOperation({
                    operationId: entry.id,
                    threadId: queue.threadId,
                  }))}
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

function QueueIconButton({
  children,
  disabled,
  label,
  onClick,
}: {
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

function entryLabel(entry: CodexPendingQueueEntry) {
  if (entry.kind === 'compact') return 'Compact context';
  return entry.preview.text || (entry.preview.attachmentCount ? 'Image message' : 'Message');
}
