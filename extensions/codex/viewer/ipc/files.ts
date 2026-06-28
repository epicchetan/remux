import type {
  CodexDirectoryDetailsResource,
  CodexDirectoryListingResource,
  CodexFileSearchResource,
  CodexFilesReadResponse,
} from '../../shared/files';
import { defaultCodexCwd } from '../config/defaults';
import type { ComposerMentionItem } from '../composer/mentions/mentionSearch';
import { parseComposerMentionQuery } from '../composer/mentions/mentionSearch';
import { readCodexFiles } from './fileResources';

export async function readDirectory(path: string) {
  const response = await readCodexFiles([{ path, type: 'directoryListing' }]);
  return unwrapFileResource<CodexDirectoryListingResource>(response);
}

export async function getFileMetadata(path: string) {
  const response = await readCodexFiles([{ path, type: 'directoryDetails' }]);
  return unwrapFileResource<CodexDirectoryDetailsResource>(response);
}

export async function readDirectoryStats(path: string): Promise<{
  itemCount: number | null;
  modifiedAtMs: number | null;
}> {
  const details = await getFileMetadata(path);

  return {
    itemCount: details.itemCount,
    modifiedAtMs: details.modifiedAtMs && details.modifiedAtMs > 0 ? details.modifiedAtMs : null,
  };
}

export async function searchComposerMentionFiles(query: string, cwd = defaultCodexCwd): Promise<ComposerMentionItem[]> {
  const parsed = parseComposerMentionQuery(query);

  if (!parsed.normalizedQuery) {
    return [];
  }

  const response = await readCodexFiles([
    {
      includeDirectories: true,
      includeFiles: true,
      limit: 80,
      query: parsed.normalizedQuery,
      roots: [cwd],
      type: 'fileSearch',
    },
  ]);
  const resource = unwrapFileResource<CodexFileSearchResource>(response);

  return resource.results;
}

export async function searchDirectories(query: string, root: string): Promise<ComposerMentionItem[]> {
  const results = await searchComposerMentionFiles(query, root);
  return results.filter((result) => result.kind === 'directory');
}

function unwrapFileResource<T>(response: CodexFilesReadResponse): T {
  const resource = response.resources[0];

  if (!resource) {
    throw new Error('File resource missing');
  }

  if (resource.status !== 'ok') {
    throw new Error(resource.reason ?? 'File resource unavailable');
  }

  return resource.value as T;
}
