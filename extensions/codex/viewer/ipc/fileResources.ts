import type {
  CodexFileResourceRequest,
  CodexFilesReadResponse,
} from '../../shared/files';
import { rpc } from '@remux/viewer-kit/ipc';

export const codexFilesMethod = 'remux/codex/files';

export function readCodexFiles(requests: CodexFileResourceRequest[]) {
  return rpc.query<CodexFilesReadResponse>(codexFilesMethod, {
    requests,
  });
}
