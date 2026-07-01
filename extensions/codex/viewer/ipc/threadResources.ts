import type {
  CodexThreadResourceRequest,
  CodexThreadResourcesReadResponse,
} from '../../shared/threads';
import { requestIpc } from '@remux/viewer-kit/ipc';

export const threadResourcesReadMethod = 'remux/codex/thread/resources/read';

export function readThreadResources(requests: CodexThreadResourceRequest[]) {
  return requestIpc<CodexThreadResourcesReadResponse>(threadResourcesReadMethod, {
    requests,
  });
}
