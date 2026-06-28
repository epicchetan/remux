import type {
  CodexComposerConfigReadResponse,
  CodexComposerConfigWriteParams,
  CodexComposerConfigWriteResponse,
} from '../../shared/composerConfig';
import { requestIpc } from './client';

export const composerConfigReadMethod = 'remux/codex/composer/config/read';
export const composerConfigWriteMethod = 'remux/codex/composer/config/write';

export function readComposerConfig() {
  return requestIpc<CodexComposerConfigReadResponse>(composerConfigReadMethod);
}

export function writeComposerConfig(params: CodexComposerConfigWriteParams) {
  return requestIpc<CodexComposerConfigWriteResponse>(composerConfigWriteMethod, params);
}
