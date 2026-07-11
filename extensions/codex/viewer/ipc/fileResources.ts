import type {
  CodexFileResourceRequest,
  CodexFilesReadResponse,
} from '../../shared/files';
import { requestIpc } from '@remux/viewer-kit/ipc';
import { rpcPolicies } from '@remux/viewer-kit/rpc-policy';

export const codexFilesMethod = 'remux/codex/files';

export function readCodexFiles(requests: CodexFileResourceRequest[]) {
  return requestIpc<CodexFilesReadResponse>(rpcPolicies['codex-files-read'], {
    requests,
  });
}
