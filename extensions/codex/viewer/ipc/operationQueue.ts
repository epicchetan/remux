import type {
  CodexQueueEntryMutationParams,
  CodexQueueMutationResponse,
} from '../../shared/operationQueue';
import { rpc } from '@remux/viewer-kit/ipc';

export const queueRemoveMethod = 'remux/codex/thread/queue/remove';
export const queueRunNowMethod = 'remux/codex/thread/queue/run-now';

export const removeThreadOperation = (params: CodexQueueEntryMutationParams) =>
  rpc.command<CodexQueueMutationResponse>(queueRemoveMethod, params, {
    operationId: params.operationId,
  });

export const runThreadOperationNow = (params: CodexQueueEntryMutationParams) =>
  rpc.command<CodexQueueMutationResponse>(queueRunNowMethod, params, {
    operationId: params.operationId,
  });
