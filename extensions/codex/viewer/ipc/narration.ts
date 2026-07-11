import { rpc } from '@remux/viewer-kit/ipc';

import type {
  CodexNarrationAudioReadParams,
  CodexNarrationAudioReadResponse,
  CodexNarrationCancelParams,
  CodexNarrationCancelResponse,
  CodexNarrationReadParams,
  CodexNarrationReadResponse,
  CodexNarrationStartParams,
  CodexNarrationStartResponse,
} from '../../shared/narration';

export const narrationAudioReadMethod = 'remux/codex/narration/audio/read';
export const narrationCancelMethod = 'remux/codex/narration/cancel';
export const narrationReadMethod = 'remux/codex/narration/resources/read';
export const narrationStartMethod = 'remux/codex/narration/start';

export const readNarration = (params: CodexNarrationReadParams) =>
  rpc.query<CodexNarrationReadResponse>(narrationReadMethod, params, {
    resourceKey: `narration:${params.artifactKey}`,
  });

export const startNarration = (params: CodexNarrationStartParams) =>
  rpc.startJob<CodexNarrationStartResponse>(narrationStartMethod, params, {
    operationId: `narration:${params.document.sourceHash}`,
  });

export const cancelNarration = (params: CodexNarrationCancelParams) =>
  rpc.command<CodexNarrationCancelResponse>(narrationCancelMethod, params, {
    operationId: `narration:${params.artifactKey}`,
  });

export const readNarrationAudio = (params: CodexNarrationAudioReadParams) =>
  rpc.query<CodexNarrationAudioReadResponse>(narrationAudioReadMethod, params, {
    resourceKey: `narration-audio:${params.artifactKey}:${params.chunkId}`,
  });
