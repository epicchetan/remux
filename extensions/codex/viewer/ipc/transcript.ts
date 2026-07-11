import type {
  CodexTranscriptResourceRequest,
  CodexTranscriptResourcesReadResponse,
} from '../../shared/transcript';
import { rpc } from '@remux/viewer-kit/ipc';

export const transcriptResourcesReadMethod = 'remux/codex/transcript/resources/read';

export function readTranscriptResources(threadId: string, requests: CodexTranscriptResourceRequest[]) {
  return rpc.query<CodexTranscriptResourcesReadResponse>(transcriptResourcesReadMethod, {
    requests,
    threadId,
  }, { resourceKey: `transcript:${threadId}` });
}
