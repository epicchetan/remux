import { requestIpc } from '@remux/viewer-kit/ipc';

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
  requestIpc<CodexNarrationReadResponse>(narrationReadMethod, params);

export const startNarration = (params: CodexNarrationStartParams) =>
  requestIpc<CodexNarrationStartResponse>(narrationStartMethod, params);

export const cancelNarration = (params: CodexNarrationCancelParams) =>
  requestIpc<CodexNarrationCancelResponse>(narrationCancelMethod, params);

export const readNarrationAudio = (params: CodexNarrationAudioReadParams) =>
  requestIpc<CodexNarrationAudioReadResponse>(narrationAudioReadMethod, params);
