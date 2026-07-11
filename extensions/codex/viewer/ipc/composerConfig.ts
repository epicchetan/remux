import type {
  CodexComposerConfigReadResponse,
  CodexComposerConfigWriteParams,
  CodexComposerConfigWriteResponse,
} from '../../shared/composerConfig';
import { rpc } from '@remux/viewer-kit/ipc';

export const composerConfigReadMethod = 'remux/codex/composer/config/read';
export const composerConfigWriteMethod = 'remux/codex/composer/config/write';

export function readComposerConfig() {
  return rpc.query<CodexComposerConfigReadResponse>(composerConfigReadMethod);
}

export function writeComposerConfig(params: CodexComposerConfigWriteParams) {
  return rpc.command<CodexComposerConfigWriteResponse>(composerConfigWriteMethod, params);
}
