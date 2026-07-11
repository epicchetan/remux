import type {
  CodexThreadResourceRequest,
  CodexThreadResourcesReadResponse,
} from '../../shared/threads';
import { requestIpc } from '@remux/viewer-kit/ipc';
import { rpcPolicies } from '@remux/viewer-kit/rpc-policy';

export const threadResourcesReadMethod = 'remux/codex/thread/resources/read';

export function readThreadResources(requests: CodexThreadResourceRequest[]) {
  return requestIpc<CodexThreadResourcesReadResponse>(rpcPolicies['codex-thread-resources-read'], {
    requests,
  });
}
