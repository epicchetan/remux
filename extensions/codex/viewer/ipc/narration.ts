import { rpc } from '@remux/viewer-kit/ipc';

import type {
  CodexNarrationCancelParams,
  CodexNarrationCancelResponse,
  CodexNarrationReadParams,
  CodexNarrationReadResponse,
  CodexNarrationStartParams,
  CodexNarrationStartResponse,
} from '../../shared/narration';

export const narrationCancelMethod = 'remux/narrate/narration/cancel';
export const narrationReadMethod = 'remux/narrate/narration/resources/read';
export const narrationStartMethod = 'remux/narrate/narration/start';

export const readNarration = (params: CodexNarrationReadParams) =>
  rpc.query<CodexNarrationReadResponse>(narrationReadMethod, params, {
    resourceKey: `narration:${params.artifactKey}`,
  });

export const startNarration = (params: CodexNarrationStartParams) =>
  rpc.startJob<CodexNarrationStartResponse>(narrationStartMethod, params, {
    operationId: `narration:${documentOperationKey(params)}`,
  });

export const cancelNarration = (params: CodexNarrationCancelParams) =>
  rpc.command<CodexNarrationCancelResponse>(narrationCancelMethod, params, {
    operationId: `narration:${params.artifactKey}`,
  });

function documentOperationKey(params: CodexNarrationStartParams) {
  const value = JSON.stringify(params.document);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
