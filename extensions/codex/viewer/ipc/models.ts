import type {
  CodexModelsReadParams,
  CodexModelsReadResponse,
} from '../../shared/composerConfig';
import { rpc } from '@remux/viewer-kit/ipc';

export const modelsReadMethod = 'remux/codex/models/read';

export function readModels(params: CodexModelsReadParams = {}) {
  return rpc.query<CodexModelsReadResponse>(modelsReadMethod, params);
}
