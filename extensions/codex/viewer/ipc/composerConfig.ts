import type {
  CodexComposerConfigReadResponse,
  CodexComposerConfigWriteParams,
  CodexComposerConfigWriteResponse,
} from '../../shared/composerConfig';
import { requestIpc } from '@remux/viewer-kit/ipc';
import { rpcPolicies } from '@remux/viewer-kit/rpc-policy';

export const composerConfigReadMethod = 'remux/codex/composer/config/read';
export const composerConfigWriteMethod = 'remux/codex/composer/config/write';

export function readComposerConfig() {
  return requestIpc<CodexComposerConfigReadResponse>(rpcPolicies['codex-config-read']);
}

export function writeComposerConfig(params: CodexComposerConfigWriteParams) {
  return requestIpc<CodexComposerConfigWriteResponse>(rpcPolicies['codex-config-write'], params);
}
