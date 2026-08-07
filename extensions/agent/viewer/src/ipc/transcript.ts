import { rpc } from '@remux/viewer-kit/ipc';

import { AGENT_METHODS } from '../../../shared/protocol';
import type {
  AgentTranscriptResourceRequest,
  AgentTranscriptResourcesReadResult,
} from '../../../shared/transcript';

export function readTranscriptResources(
  conversationId: string,
  requests: AgentTranscriptResourceRequest[],
) {
  return rpc.query<AgentTranscriptResourcesReadResult>(
    AGENT_METHODS.transcriptResourcesRead,
    { conversationId, requests },
    { resourceKey: `transcript:${conversationId}` },
  );
}
