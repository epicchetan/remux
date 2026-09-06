import { rpc } from './ipc';

export type FileSystemEntry = {
  git?: FileSystemGitStatus | null;
  itemCount?: number | null;
  kind: 'directory' | 'file' | 'other' | 'symlink';
  modifiedAtMs?: number | null;
  name: string;
  path: string;
  sizeBytes?: number | null;
};

export type FileSystemGitStatus = {
  staged?: boolean;
  status: 'added' | 'conflicted' | 'deleted' | 'modified' | 'renamed' | 'untracked';
};

export type GitFileStatus = FileSystemGitStatus['status'];

export type ReadFileGitBase = {
  content: string | null;
  encoding: 'base64' | 'utf8' | null;
  isBinary: boolean;
  path: string;
  ref: 'HEAD';
  repoRoot: string | null;
  sizeBytes: number | null;
  status: GitFileStatus | null;
  tooLarge: boolean;
  unavailableReason?: string | null;
};

export type ReadFileGitMetadata = {
  base: ReadFileGitBase | null;
  repoRoot: string | null;
  status: GitFileStatus | null;
};

export type ReadDirectoryResult = {
  entries: FileSystemEntry[];
  parentPath: string | null;
  path: string;
  version: string | null;
};

export type ReadDirectoriesResult = {
  results: Array<
    | {
        ok: true;
        path: string;
        value: ReadDirectoryResult;
      }
    | {
        message: string;
        ok: false;
        path: string;
      }
  >;
};

export type ReadFileResult = {
  content: string | null;
  dataBase64?: string | null;
  encoding: 'base64' | 'utf8' | null;
  isBinary: boolean;
  mimeType?: string | null;
  modifiedAtMs: number | null;
  name: string;
  path: string;
  sizeBytes: number;
  tooLarge: boolean;
  git?: ReadFileGitMetadata;
};

export type ReadFileWindowResult = {
  content: string;
  continuation: {
    endsMidLine: boolean;
    startsMidLine: boolean;
  };
  encoding: 'utf8';
  eof: boolean;
  nextOffset: number | null;
  path: string;
  previousOffset: number | null;
  range: { endByte: number; startByte: number };
  targetLine: { byteOffset: number; lineNumber: number } | null;
  totalSizeBytes: number;
  version: string;
};

export function readDirectory(path?: string | null, options: { force?: boolean } = {}) {
  return rpc.query<ReadDirectoryResult>(
    'remux/fs/readDirectory',
    path || options.force ? { force: options.force === true, ...(path ? { path } : {}) } : undefined,
    { resourceKey: `directory:${path ?? ''}` },
  );
}

export function readDirectories(paths: string[], options: { force?: boolean } = {}) {
  return rpc.query<ReadDirectoriesResult>(
    'remux/fs/readDirectories',
    {
      force: options.force === true,
      paths,
    },
    { resourceKey: `directories:${paths.join('\u0000')}` },
  );
}

export function readFile(
  path: string,
  options: {
    format?: 'base64' | 'text';
    git?: { includeBase?: boolean; includeStatus?: boolean };
    signal?: AbortSignal;
  } = {},
) {
  const format = options.format ?? 'text';
  const includeBase = options.git?.includeBase === true;
  const includeStatus = options.git?.includeStatus === true;
  return rpc.query<ReadFileResult>('remux/fs/readFile', {
    ...(options.format ? { format: options.format } : {}),
    ...(options.git ? { git: options.git } : {}),
    path,
  }, {
    resourceKey: `file:${path}:format:${format}:git:${includeStatus ? 1 : 0}:${includeBase ? 1 : 0}`,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function readFileWindow(
  path: string,
  options: {
    expectedVersion?: string;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
    targetLine?: number;
  } = {},
) {
  const target = options.targetLine == null ? `offset:${options.offset ?? 0}` : `line:${options.targetLine}`;
  return rpc.query<ReadFileWindowResult>('remux/fs/readFileWindow', {
    ...(options.expectedVersion ? { expectedVersion: options.expectedVersion } : {}),
    ...(options.limit == null ? {} : { limit: options.limit }),
    ...(options.offset == null ? {} : { offset: options.offset }),
    path,
    ...(options.targetLine == null ? {} : { targetLine: options.targetLine }),
  }, {
    resourceKey: `file-window:${path}:${options.expectedVersion ?? 'fresh'}:${target}:${options.limit ?? 'default'}`,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function readFileGit(
  path: string,
  options: { includeBase?: boolean; signal?: AbortSignal } = {},
) {
  const includeBase = options.includeBase === true;
  return rpc.query<ReadFileGitMetadata>('remux/fs/readFileGit', {
    includeBase,
    path,
  }, {
    resourceKey: `file-git:${path}:base:${includeBase ? 1 : 0}`,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function readFileDataUrl(path: string) {
  const result = await readFile(path, { format: 'base64' });
  if (!result.dataBase64 || result.tooLarge) {
    throw new Error(result.tooLarge ? 'File is too large to embed.' : 'File data was unavailable.');
  }

  return `data:${result.mimeType ?? mimeTypeFromFileName(result.name) ?? 'application/octet-stream'};base64,${result.dataBase64}`;
}

function mimeTypeFromFileName(fileName: string) {
  const extension = fileName.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'apng':
      return 'image/apng';
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}
