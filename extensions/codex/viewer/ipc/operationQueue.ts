import type {
  CodexQueueEntryMutationParams,
  CodexQueueMutationResponse,
} from '../../shared/operationQueue';
import { requestIpc } from '@remux/viewer-kit/ipc';

export const queueRemoveMethod = 'remux/codex/thread/queue/remove';
export const queueRunNowMethod = 'remux/codex/thread/queue/run-now';

export const removeThreadOperation = (params: CodexQueueEntryMutationParams) =>
  requestIpc<CodexQueueMutationResponse>(queueRemoveMethod, params);

export const runThreadOperationNow = (params: CodexQueueEntryMutationParams) =>
  requestIpc<CodexQueueMutationResponse>(queueRunNowMethod, params);
