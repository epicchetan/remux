import type { CodexModelsReadResponse } from '../../shared/composerConfig';
import { requestIpc } from '@remux/viewer-kit/ipc';

export const modelsReadMethod = 'remux/codex/models/read';

export function readModels() {
  return requestIpc<CodexModelsReadResponse>(modelsReadMethod);
}
