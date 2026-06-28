import type {
  CodexThreadResourceRequest,
  CodexThreadResourcesReadResponse,
} from '../../shared/threads';
import { requestIpc } from './client';

export const threadResourcesReadMethod = 'remux/codex/thread/resources/read';

export function readThreadResources(requests: CodexThreadResourceRequest[]) {
  return requestIpc<CodexThreadResourcesReadResponse>(threadResourcesReadMethod, {
    requests,
  });
}
