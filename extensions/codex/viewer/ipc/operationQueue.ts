import type {
  CodexQueueEntryMutationParams,
  CodexQueueMutationResponse,
} from '../../shared/operationQueue';
import { requestIpc } from '@remux/viewer-kit/ipc';
import { rpcPolicies } from '@remux/viewer-kit/rpc-policy';

export const queueRemoveMethod = 'remux/codex/thread/queue/remove';
export const queueRunNowMethod = 'remux/codex/thread/queue/run-now';

export const removeThreadOperation = (params: CodexQueueEntryMutationParams) =>
  requestIpc<CodexQueueMutationResponse>(rpcPolicies['codex-queue-remove'], params);

export const runThreadOperationNow = (params: CodexQueueEntryMutationParams) =>
  requestIpc<CodexQueueMutationResponse>(rpcPolicies['codex-queue-run-now'], params);
