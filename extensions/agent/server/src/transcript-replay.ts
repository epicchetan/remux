import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { AgentResourceInvalidation } from '../../shared/transcript.ts';
import type {
  DurableTranscriptAction,
  DurableTranscriptProjectionAction,
} from './storage/repository.ts';
import { EphemeralTranscriptProjector } from './transcript-projector.ts';

type ReplayAction = DurableTranscriptAction | DurableTranscriptProjectionAction;

export function createReplayedTranscriptProjector(options: {
  conversationId: string;
  actions: readonly ReplayAction[];
  basisSequence?: number;
  live: boolean;
  invalidate?: (invalidations: AgentResourceInvalidation[]) => void;
}) {
  const clock = new ProjectionClock();
  let replaying = true;
  const projector = new EphemeralTranscriptProjector({
    conversationId: options.conversationId,
    createId: projectionIdFactory(options.conversationId),
    now: () => clock.now(),
    monotonicNow: () => clock.monotonicNow(),
    invalidate: (invalidations) => {
      if (!replaying) options.invalidate?.(invalidations);
    },
  });
  replayTranscriptActions(projector, options.actions, (timestamp) => clock.replayAt(timestamp));
  if (options.basisSequence !== undefined) projector.fenceBasis(options.basisSequence);
  replaying = false;
  if (options.live) clock.useLiveTime();
  return projector;
}

export function replayTranscriptActions(
  projector: EphemeralTranscriptProjector,
  actions: readonly ReplayAction[],
  beforeAction: (timestamp: number) => void = () => {},
) {
  for (const [index, action] of actions.entries()) {
    beforeAction('createdAt' in action ? action.createdAt : index);
    switch (action.type) {
      case 'turn':
        projector.beginTurn({
          turnId: action.turnId,
          clientMessageId: action.clientMessageId,
          text: action.text,
          ...('parts' in action && action.parts ? { parts: action.parts } : {}),
          ...('content' in action && action.content ? { content: action.content } : {}),
          ...('sequence' in action
            ? {
                sequence: action.sequence,
                basisSequence: action.sequence,
                createdAt: action.createdAt,
                userItemId: action.itemId ?? undefined,
              }
            : {}),
        });
        break;
      case 'assistant':
        if (action.reasoningDelta) projector.appendReasoning(
          action.turnId,
          action.reasoningDelta,
          {
            ...projectionMutation(action),
            ...('reasoningContent' in action && action.reasoningContent
              ? { content: action.reasoningContent }
              : {}),
          },
        );
        if (action.textDelta) projector.appendAssistantText(
          action.turnId,
          action.textDelta,
          {
            ...projectionMutation(action),
            ...('textContent' in action && action.textContent
              ? { content: action.textContent }
              : {}),
          },
        );
        break;
      case 'tool-start':
        projector.startTool(action.turnId, {
          callId: action.callId,
          name: action.name,
          args: action.args,
          ...('detailText' in action && action.detailText !== undefined
            ? { detailText: action.detailText }
            : {}),
          ...('detailContent' in action && action.detailContent
            ? { detailContent: action.detailContent }
            : {}),
          ...projectionMutation(action),
        });
        break;
      case 'tool-end':
        projector.endTool(action.turnId, {
          callId: action.callId,
          result: action.result,
          isError: action.isError,
          ...('outputText' in action && action.outputText !== undefined
            ? { outputText: action.outputText }
            : {}),
          ...('outputContent' in action && action.outputContent
            ? { outputContent: action.outputContent }
            : {}),
          ...projectionMutation(action),
        });
        break;
      case 'terminal':
        projector.finishTurn(action.turnId, {
          status: action.status,
          error: action.error
            ? { code: action.errorCode ?? 'provider_error', message: action.error }
            : null,
          ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
          ...('sequence' in action
            ? {
                sequence: action.sequence,
                basisSequence: action.sequence,
                createdAt: action.createdAt,
              }
            : {}),
        });
        break;
    }
  }
}

function projectionMutation(action: ReplayAction) {
  return 'sequence' in action
    ? {
        sequence: action.sequence,
        basisSequence: action.sequence,
        createdAt: action.createdAt,
        itemId: action.itemId,
      }
    : {};
}

class ProjectionClock {
  private replayTimestamp = 0;
  private live = false;

  replayAt(timestamp: number) {
    this.replayTimestamp = timestamp;
  }

  useLiveTime() {
    this.live = true;
  }

  now() {
    return this.live ? Date.now() : this.replayTimestamp;
  }

  monotonicNow() {
    return this.live ? performance.now() : this.replayTimestamp;
  }
}

function projectionIdFactory(conversationId: string) {
  let ordinal = 0;
  return () => {
    const bytes = createHash('sha256')
      .update(conversationId)
      .update('\0')
      .update(String(ordinal++))
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
