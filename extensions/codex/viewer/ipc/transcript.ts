import type {
  CodexTranscriptResourceRequest,
  CodexTranscriptResourcesReadResponse,
} from '../../shared/transcript';
import { requestIpc } from './client';

export const transcriptResourcesReadMethod = 'remux/codex/transcript/resources/read';

export function readTranscriptResources(threadId: string, requests: CodexTranscriptResourceRequest[]) {
  return requestIpc<CodexTranscriptResourcesReadResponse>(transcriptResourcesReadMethod, {
    requests,
    threadId,
  });
}
