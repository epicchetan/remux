import type {
  CodexThreadResourceRequest,
  CodexThreadResourcesReadResponse,
} from '../../shared/threads';
import { rpc } from '@remux/viewer-kit/ipc';

export const threadResourcesReadMethod = 'remux/codex/thread/resources/read';

export function readThreadResources(requests: CodexThreadResourceRequest[]) {
  return rpc.query<CodexThreadResourcesReadResponse>(threadResourcesReadMethod, {
    requests,
  });
}
