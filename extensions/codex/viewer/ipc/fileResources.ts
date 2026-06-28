import type {
  CodexFileResourceRequest,
  CodexFilesReadResponse,
} from '../../shared/files';
import { requestIpc } from './client';

export const codexFilesMethod = 'remux/codex/files';

export function readCodexFiles(requests: CodexFileResourceRequest[]) {
  return requestIpc<CodexFilesReadResponse>(codexFilesMethod, {
    requests,
  });
}
