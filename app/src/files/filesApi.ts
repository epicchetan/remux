import type { RemuxConnection } from '../remote/RemuxConnectionProvider';
import type { FileTreeEntry, FileTreeGitStatus } from './filesTypes';

const readDirectoryMethod = 'remux/fs/readDirectory';
const readDirectoriesMethod = 'remux/fs/readDirectories';

export type RemuxReadDirectoryResponse = {
  entries: FileTreeEntry[];
  parentPath: string | null;
  path: string;
  version: string | null;
};

export type RemuxReadDirectoriesResponse = {
  results: Array<
    | {
        ok: true;
        path: string;
        value: RemuxReadDirectoryResponse;
      }
    | {
        message: string;
        ok: false;
        path: string;
      }
  >;
};

export async function readRemuxDirectory(
  request: RemuxConnection['request'],
  path?: string | null,
  options: { force?: boolean } = {},
): Promise<RemuxReadDirectoryResponse> {
  const response = await request<unknown>(
    readDirectoryMethod,
    path || options.force ? { force: options.force === true, ...(path ? { path } : {}) } : undefined,
  );

  return parseReadDirectoryResponse(response);
}

export async function readRemuxDirectories(
  request: RemuxConnection['request'],
  paths: string[],
  options: { force?: boolean } = {},
): Promise<RemuxReadDirectoriesResponse> {
  const response = await request<unknown>(
    readDirectoriesMethod,
    { force: options.force === true, paths },
  );

  return parseReadDirectoriesResponse(response);
}

function parseReadDirectoryResponse(response: unknown): RemuxReadDirectoryResponse {
  if (!isRecord(response) || typeof response.path !== 'string' || !Array.isArray(response.entries)) {
    throw new Error('Invalid Remux directory response');
  }

  return {
    entries: response.entries.flatMap(parseEntry),
    parentPath: typeof response.parentPath === 'string' ? response.parentPath : null,
    path: response.path,
    version: typeof response.version === 'string' ? response.version : null,
  };
}

function parseReadDirectoriesResponse(response: unknown): RemuxReadDirectoriesResponse {
  if (!isRecord(response) || !Array.isArray(response.results)) {
    throw new Error('Invalid Remux directories response');
  }

  return {
    results: response.results.flatMap((result): RemuxReadDirectoriesResponse['results'] => {
      if (!isRecord(result) || typeof result.path !== 'string') {
        return [];
      }

      if (result.ok === true) {
        return [{
          ok: true,
          path: result.path,
          value: parseReadDirectoryResponse(result.value),
        }];
      }

      if (result.ok === false) {
        return [{
          message: typeof result.message === 'string' ? result.message : 'Directory could not be read',
          ok: false,
          path: result.path,
        }];
      }

      return [];
    }),
  };
}

function parseEntry(raw: unknown): FileTreeEntry[] {
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.path !== 'string') {
    return [];
  }

  const kind = parseKind(raw.kind);
  return [{
    git: parseGitStatus(raw.git),
    itemCount: typeof raw.itemCount === 'number' ? raw.itemCount : null,
    kind,
    modifiedAtMs: typeof raw.modifiedAtMs === 'number' ? raw.modifiedAtMs : null,
    name: raw.name,
    path: raw.path,
    sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : null,
  }];
}

function parseGitStatus(raw: unknown): FileTreeEntry['git'] {
  if (!isRecord(raw)) {
    return null;
  }

  const status = parseGitStatusValue(raw.status);
  if (!status) {
    return null;
  }

  return {
    staged: typeof raw.staged === 'boolean' ? raw.staged : undefined,
    status,
  };
}

function parseGitStatusValue(status: unknown): FileTreeGitStatus['status'] | null {
  switch (status) {
    case 'added':
    case 'conflicted':
    case 'deleted':
    case 'modified':
    case 'renamed':
    case 'untracked':
      return status;
    default:
      return null;
  }
}

function parseKind(kind: unknown): FileTreeEntry['kind'] {
  switch (kind) {
    case 'directory':
    case 'file':
    case 'other':
    case 'symlink':
      return kind;
    default:
      return 'other';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
