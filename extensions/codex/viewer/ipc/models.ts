import type { CodexModelsReadResponse } from '../../shared/composerConfig';
import { rpc } from '@remux/viewer-kit/ipc';

export const modelsReadMethod = 'remux/codex/models/read';

export function readModels() {
  return rpc.query<CodexModelsReadResponse>(modelsReadMethod);
}
