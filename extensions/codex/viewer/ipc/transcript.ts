import type {
  CodexTranscriptCapabilities,
  CodexTranscriptResourceRequest,
  CodexTranscriptResourcesReadResponse,
} from '../../shared/transcript';
import { rpc } from '@remux/viewer-kit/ipc';

export const transcriptResourcesReadMethod = 'remux/codex/transcript/resources/read';
export const transcriptCapabilitiesReadMethod = 'remux/codex/transcript/capabilities/read';

export function readTranscriptCapabilities() {
  return rpc.query<CodexTranscriptCapabilities>(transcriptCapabilitiesReadMethod, undefined, {
    resourceKey: 'transcript:capabilities',
  });
}

export function readTranscriptResources(threadId: string, requests: CodexTranscriptResourceRequest[]) {
  return rpc.query<CodexTranscriptResourcesReadResponse>(transcriptResourcesReadMethod, {
    requests,
    threadId,
  }, { resourceKey: `transcript:${threadId}` });
}
