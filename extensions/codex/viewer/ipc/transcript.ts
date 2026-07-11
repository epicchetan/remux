import type {
  CodexTranscriptResourceRequest,
  CodexTranscriptResourcesReadResponse,
} from '../../shared/transcript';
import { requestIpc } from '@remux/viewer-kit/ipc';
import { rpcPolicies } from '@remux/viewer-kit/rpc-policy';

export const transcriptResourcesReadMethod = 'remux/codex/transcript/resources/read';

export function readTranscriptResources(threadId: string, requests: CodexTranscriptResourceRequest[]) {
  return requestIpc<CodexTranscriptResourcesReadResponse>(rpcPolicies['codex-transcript-read'], {
    requests,
    threadId,
  });
}
