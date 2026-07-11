import { requestIpc } from '@remux/viewer-kit/ipc';
import { rpcPolicies } from '@remux/viewer-kit/rpc-policy';

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
  requestIpc<CodexNarrationReadResponse>(rpcPolicies['codex-narration-read'], params);

export const startNarration = (params: CodexNarrationStartParams) =>
  requestIpc<CodexNarrationStartResponse>(rpcPolicies['codex-narration-start'], params);

export const cancelNarration = (params: CodexNarrationCancelParams) =>
  requestIpc<CodexNarrationCancelResponse>(rpcPolicies['codex-narration-cancel'], params);

export const readNarrationAudio = (params: CodexNarrationAudioReadParams) =>
  requestIpc<CodexNarrationAudioReadResponse>(rpcPolicies['codex-narration-audio-read'], params);
