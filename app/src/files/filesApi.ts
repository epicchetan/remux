import type { RemuxConnection } from '../remote/RemuxConnectionProvider';
import type { FileTreeEntry, FileTreeGitStatus } from './filesTypes';

const readDirectoryMethod = 'remux/fs/readDirectory';
const readDirectoriesMethod = 'remux/fs/readDirectories';

export const fsDidChangeMethod = 'remux/fs/didChange';

export type RemuxFsDidChangeParams = {
  changedPaths: string[];
  gitDirtyRoots: string[];
};

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
  query: RemuxConnection['query'],
  path?: string | null,
  options: { force?: boolean } = {},
): Promise<RemuxReadDirectoryResponse> {
  const response = await query<unknown>(
    readDirectoryMethod,
    path || options.force ? { force: options.force === true, ...(path ? { path } : {}) } : undefined,
    { resourceKey: `directory:${path ?? ''}` },
  );

  return parseReadDirectoryResponse(response);
}

export async function readRemuxDirectories(
  query: RemuxConnection['query'],
  paths: string[],
  options: { force?: boolean } = {},
): Promise<RemuxReadDirectoriesResponse> {
  const response = await query<unknown>(
    readDirectoriesMethod,
    { force: options.force === true, paths },
    { resourceKey: `directories:${paths.join('\u0000')}` },
  );

  return parseReadDirectoriesResponse(response);
}

export function parseFsDidChangeParams(params: unknown): RemuxFsDidChangeParams | null {
  if (!isRecord(params)) {
    return null;
  }

  const changedPaths = stringArray(params.changedPaths);
  const gitDirtyRoots = stringArray(params.gitDirtyRoots);
  if (changedPaths.length === 0 && gitDirtyRoots.length === 0) {
    return null;
  }

  return { changedPaths, gitDirtyRoots };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
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
    targetKind: parseTargetKind(raw.targetKind),
  }];
}

function parseTargetKind(targetKind: unknown): FileTreeEntry['targetKind'] {
  switch (targetKind) {
    case 'directory':
    case 'file':
    case 'other':
      return targetKind;
    default:
      return null;
  }
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
