import type { CodexFileBytesResource, CodexFilesReadResponse } from '../../shared/files';
import { readCodexFiles } from './fileResources';

export async function readLocalFileBase64(path: string) {
  const response = await readCodexFiles([{ path, type: 'fileBytes' }]);
  return unwrapFileBytes(response).dataBase64;
}

function unwrapFileBytes(response: CodexFilesReadResponse): CodexFileBytesResource {
  const resource = response.resources[0];

  if (!resource) {
    throw new Error('File resource missing');
  }

  if (resource.status !== 'ok') {
    throw new Error(resource.reason ?? 'File resource unavailable');
  }

  return resource.value as CodexFileBytesResource;
}
