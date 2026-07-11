import type { CodexModelsReadResponse } from '../../shared/composerConfig';
import { requestIpc } from '@remux/viewer-kit/ipc';
import { rpcPolicies } from '@remux/viewer-kit/rpc-policy';

export const modelsReadMethod = 'remux/codex/models/read';

export function readModels() {
  return requestIpc<CodexModelsReadResponse>(rpcPolicies['codex-models-read']);
}
