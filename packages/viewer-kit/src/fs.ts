import { requestIpc } from './ipc';

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

export function readDirectory(path?: string | null, options: { force?: boolean } = {}) {
  return requestIpc<ReadDirectoryResult>(
    'remux/fs/readDirectory',
    path || options.force ? { force: options.force === true, ...(path ? { path } : {}) } : undefined,
  );
}

export function readDirectories(paths: string[], options: { force?: boolean } = {}) {
  return requestIpc<ReadDirectoriesResult>('remux/fs/readDirectories', {
    force: options.force === true,
    paths,
  });
}

export function readFile(
  path: string,
  options: {
    format?: 'base64' | 'text';
    git?: { includeBase?: boolean; includeStatus?: boolean };
  } = {},
) {
  return requestIpc<ReadFileResult>('remux/fs/readFile', {
    ...(options.format ? { format: options.format } : {}),
    ...(options.git ? { git: options.git } : {}),
    path,
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
