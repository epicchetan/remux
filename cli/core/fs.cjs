const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');

const { JsonRpcError } = require('../jsonRpc.cjs');

const execFileAsync = promisify(execFile);

const readDirectoryMethod = 'remux/fs/readDirectory';
const readDirectoriesMethod = 'remux/fs/readDirectories';
const readFileMethod = 'remux/fs/readFile';
const directoryBatchConcurrency = 4;
const directoryCacheTtlMs = 3000;
const directoryEntryConcurrency = 24;
const maxBinaryFileBytes = 5 * 1024 * 1024;
const maxTextFileBytes = 1024 * 1024;
const gitRepoRootCacheTtlMs = 5000;
const gitStatusCacheTtlMs = 1000;

function createFsCore({ rootDir = process.cwd() } = {}) {
  const defaultPath = path.resolve(rootDir);
  const directoryCache = new Map();
  const directoryInflight = new Map();
  const gitRepoRootCache = new Map();
  const gitStatusCache = new Map();

  return {
    async handleRpc({ method, params }) {
      if (method === readDirectoryMethod) {
        return readDirectory({
          defaultPath,
          directoryCache,
          directoryInflight,
          gitRepoRootCache,
          gitStatusCache,
          params,
        });
      }

      if (method === readDirectoriesMethod) {
        return readDirectories({
          defaultPath,
          directoryCache,
          directoryInflight,
          gitRepoRootCache,
          gitStatusCache,
          params,
        });
      }

      if (method === readFileMethod) {
        return readFile({
          defaultPath,
          gitRepoRootCache,
          gitStatusCache,
          params,
        });
      }

      throw new JsonRpcError(-32601, `Method not found: ${method}`);
    },
  };
}

async function readDirectory({
  defaultPath,
  directoryCache,
  directoryInflight,
  gitRepoRootCache,
  gitStatusCache,
  params,
}) {
  const targetPath = resolveRequestedPath(defaultPath, params);
  const force = isRecord(params) && params.force === true;
  return readDirectoryCached({
    directoryCache,
    directoryInflight,
    force,
    gitRepoRootCache,
    gitStatusCache,
    targetPath,
  });
}

async function readDirectories({
  defaultPath,
  directoryCache,
  directoryInflight,
  gitRepoRootCache,
  gitStatusCache,
  params,
}) {
  if (!isRecord(params) || !Array.isArray(params.paths)) {
    throw new JsonRpcError(-32602, 'Invalid remux/fs/readDirectories params');
  }

  const paths = params.paths;
  const force = params.force === true;
  if (!paths.every((entryPath) => typeof entryPath === 'string')) {
    throw new JsonRpcError(-32602, 'Invalid remux/fs/readDirectories paths');
  }

  const results = await mapWithConcurrency(paths, directoryBatchConcurrency, async (entryPath) => {
    const targetPath = resolveRequestedPath(defaultPath, { path: entryPath }, {
      method: readDirectoriesMethod,
    });

    try {
      const value = await readDirectoryCached({
        directoryCache,
        directoryInflight,
        force,
        gitRepoRootCache,
        gitStatusCache,
        targetPath,
      });
      return {
        ok: true,
        path: targetPath,
        value,
      };
    } catch (error) {
      return {
        message: errorMessage(error),
        ok: false,
        path: targetPath,
      };
    }
  });

  return { results };
}

async function readDirectoryCached({
  directoryCache,
  directoryInflight,
  force = false,
  gitRepoRootCache,
  gitStatusCache,
  targetPath,
}) {
  const cached = directoryCache.get(targetPath);
  const now = Date.now();
  if (!force && cached && now - cached.loadedAtMs < directoryCacheTtlMs) {
    return cached.result;
  }

  const inflight = directoryInflight.get(targetPath);
  if (inflight) {
    return inflight;
  }

  const promise = readDirectoryFresh({
    gitRepoRootCache,
    gitStatusCache,
    targetPath,
  })
    .then((result) => {
      directoryCache.set(targetPath, {
        loadedAtMs: Date.now(),
        result,
      });
      return result;
    })
    .finally(() => {
      directoryInflight.delete(targetPath);
    });

  directoryInflight.set(targetPath, promise);
  return promise;
}

async function readDirectoryFresh({ gitRepoRootCache, gitStatusCache, targetPath }) {
  let dirents;

  try {
    dirents = await fs.readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    throw new JsonRpcError(-32010, `Directory could not be read: ${errorMessage(error)}`);
  }

  const entries = await mapWithConcurrency(
    dirents,
    directoryEntryConcurrency,
    (dirent) => directoryEntry(targetPath, dirent),
  );
  const gitStatus = await readGitStatusForPath({
    repoRootCache: gitRepoRootCache,
    statusCache: gitStatusCache,
    targetPath,
  });
  const sortedEntries = entries.sort(compareEntries);
  const annotatedEntries = gitStatus
    ? sortedEntries.map((entry) => ({
        ...entry,
        git: gitStatusForEntry(gitStatus, entry),
      }))
    : sortedEntries;

  return {
    entries: annotatedEntries,
    parentPath: parentPath(targetPath),
    path: targetPath,
    version: directoryVersion(annotatedEntries),
  };
}

async function readFile({
  defaultPath,
  gitRepoRootCache,
  gitStatusCache,
  params,
}) {
  const targetPath = resolveRequestedPath(defaultPath, params, {
    method: readFileMethod,
  });
  const gitOptions = isRecord(params) && isRecord(params.git)
    ? params.git
    : null;
  const format = isRecord(params) && params.format === 'base64' ? 'base64' : 'text';
  const maxFileBytes = format === 'base64' ? maxBinaryFileBytes : maxTextFileBytes;
  let stats;

  try {
    stats = await fs.stat(targetPath);
  } catch (error) {
    throw new JsonRpcError(-32011, `File could not be read: ${errorMessage(error)}`);
  }

  if (!stats.isFile()) {
    throw new JsonRpcError(-32602, 'Invalid remux/fs/readFile path: expected file');
  }

  const metadata = {
    encoding: null,
    isBinary: false,
    modifiedAtMs: Number.isFinite(stats.mtimeMs) ? Math.trunc(stats.mtimeMs) : null,
    name: path.basename(targetPath),
    path: targetPath,
    sizeBytes: stats.size,
    tooLarge: stats.size > maxFileBytes,
  };

  if (metadata.tooLarge) {
    const result = {
      ...metadata,
      content: null,
    };
    return includeFileGit(result, {
      gitOptions,
      gitRepoRootCache,
      gitStatusCache,
      targetPath,
    });
  }

  let buffer;
  try {
    buffer = await fs.readFile(targetPath);
  } catch (error) {
    throw new JsonRpcError(-32011, `File could not be read: ${errorMessage(error)}`);
  }

  if (format === 'base64') {
    return includeFileGit({
      ...metadata,
      content: null,
      dataBase64: buffer.toString('base64'),
      encoding: 'base64',
      isBinary: isLikelyBinary(buffer),
      mimeType: mimeTypeFromPath(targetPath),
    }, {
      gitOptions,
      gitRepoRootCache,
      gitStatusCache,
      targetPath,
    });
  }

  if (isLikelyBinary(buffer)) {
    const result = {
      ...metadata,
      content: null,
      isBinary: true,
    };
    return includeFileGit(result, {
      gitOptions,
      gitRepoRootCache,
      gitStatusCache,
      targetPath,
    });
  }

  return includeFileGit({
    ...metadata,
    content: buffer.toString('utf8'),
    encoding: 'utf8',
  }, {
    gitOptions,
    gitRepoRootCache,
    gitStatusCache,
    targetPath,
  });
}

async function includeFileGit(
  result,
  {
    gitOptions,
    gitRepoRootCache,
    gitStatusCache,
    targetPath,
  },
) {
  if (!gitOptions) {
    return result;
  }

  const includeBase = gitOptions.includeBase === true;
  const includeStatus = gitOptions.includeStatus === true || includeBase;
  if (!includeBase && !includeStatus) {
    return result;
  }

  const git = await readFileGitMetadata({
    gitRepoRootCache,
    gitStatusCache,
    includeBase,
    targetPath,
  });

  return {
    ...result,
    git,
  };
}

function mimeTypeFromPath(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.apng':
      return 'image/apng';
    case '.avif':
      return 'image/avif';
    case '.gif':
      return 'image/gif';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

async function readFileGitMetadata({
  gitRepoRootCache,
  gitStatusCache,
  includeBase,
  targetPath,
}) {
  const repoStatus = await readGitStatusForPath({
    repoRootCache: gitRepoRootCache,
    statusCache: gitStatusCache,
    targetPath: path.dirname(targetPath),
  });
  if (!repoStatus) {
    return {
      base: includeBase
        ? emptyGitFileBase({
            path: targetPath,
            reason: 'File is not in a git repository.',
          })
        : null,
      repoRoot: null,
      status: null,
    };
  }

  const relativePath = relativeGitPath(repoStatus.repoRoot, targetPath);
  if (!relativePath) {
    return {
      base: includeBase
        ? emptyGitFileBase({
            path: targetPath,
            reason: 'File is outside the git repository.',
            repoRoot: repoStatus.repoRoot,
          })
        : null,
      repoRoot: repoStatus.repoRoot,
      status: null,
    };
  }

  const status = gitStatusForRelativePath(repoStatus, relativePath);
  return {
    base: includeBase
      ? await readGitFileBase({
          relativePath,
          repoRoot: repoStatus.repoRoot,
          status,
          targetPath,
        })
      : null,
    repoRoot: repoStatus.repoRoot,
    status: status?.status ?? null,
  };
}

async function readGitFileBase({
  relativePath,
  repoRoot,
  status,
  targetPath,
}) {
  if (!status) {
    return emptyGitFileBase({
      path: targetPath,
      reason: 'File has no local git changes.',
      repoRoot,
      status: null,
    });
  }

  if (status.status === 'untracked' || status.status === 'added') {
    return {
      content: '',
      encoding: 'utf8',
      isBinary: false,
      path: targetPath,
      ref: 'HEAD',
      repoRoot,
      sizeBytes: 0,
      status: status.status,
      tooLarge: false,
      unavailableReason: null,
    };
  }

  const baseSpec = `HEAD:${relativePath}`;
  let sizeBytes;
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoRoot,
      'cat-file',
      '-s',
      baseSpec,
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    sizeBytes = Number.parseInt(stdout.trim(), 10);
  } catch {
    return emptyGitFileBase({
      path: targetPath,
      repoRoot,
      status: status.status,
    });
  }

  if (!Number.isFinite(sizeBytes)) {
    return emptyGitFileBase({
      path: targetPath,
      reason: 'Base file size could not be read.',
      repoRoot,
      status: status.status,
    });
  }

  if (sizeBytes > maxTextFileBytes) {
    return {
      content: null,
      encoding: null,
      isBinary: false,
      path: targetPath,
      ref: 'HEAD',
      repoRoot,
      sizeBytes,
      status: status.status,
      tooLarge: true,
      unavailableReason: `Base file is larger than ${formatBytes(maxTextFileBytes)}.`,
    };
  }

  let buffer;
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoRoot,
      'show',
      '--no-ext-diff',
      '--no-color',
      baseSpec,
    ], {
      encoding: 'buffer',
      maxBuffer: maxTextFileBytes + 1024,
      windowsHide: true,
    });
    buffer = stdout;
  } catch (error) {
    return emptyGitFileBase({
      path: targetPath,
      reason: `Base file could not be read: ${errorMessage(error)}`,
      repoRoot,
      status: status.status,
    });
  }

  if (isLikelyBinary(buffer)) {
    return {
      content: null,
      encoding: null,
      isBinary: true,
      path: targetPath,
      ref: 'HEAD',
      repoRoot,
      sizeBytes,
      status: status.status,
      tooLarge: false,
      unavailableReason: 'Base file is binary.',
    };
  }

  return {
    content: buffer.toString('utf8'),
    encoding: 'utf8',
    isBinary: false,
    path: targetPath,
    ref: 'HEAD',
    repoRoot,
    sizeBytes,
    status: status.status,
    tooLarge: false,
    unavailableReason: null,
  };
}

function resolveRequestedPath(defaultPath, params, {
  method = readDirectoryMethod,
} = {}) {
  if (params === undefined || params === null) {
    return defaultPath;
  }

  if (!isRecord(params)) {
    throw new JsonRpcError(-32602, `Invalid ${method} params`);
  }

  const requestedPath = params.path;
  if (requestedPath === undefined || requestedPath === null || requestedPath === '') {
    return defaultPath;
  }

  if (typeof requestedPath !== 'string') {
    throw new JsonRpcError(-32602, `Invalid ${method} path`);
  }

  return path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(defaultPath, requestedPath);
}

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) {
    return true;
  }

  let suspicious = 0;
  for (const byte of sample) {
    const isAllowedControl = byte === 7 || byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 27;
    const isControl = byte < 32 || byte === 127;
    if (isControl && !isAllowedControl) {
      suspicious += 1;
    }
  }

  return sample.length > 0 && suspicious / sample.length > 0.1;
}

async function directoryEntry(parent, dirent) {
  const entryPath = path.join(parent, dirent.name);
  const fallback = {
    itemCount: null,
    kind: kindFromDirent(dirent),
    modifiedAtMs: null,
    name: dirent.name,
    path: entryPath,
    sizeBytes: null,
  };

  try {
    const stats = await fs.lstat(entryPath);
    return {
      ...fallback,
      kind: kindFromStats(stats, dirent),
      modifiedAtMs: Number.isFinite(stats.mtimeMs) ? Math.trunc(stats.mtimeMs) : null,
      sizeBytes: stats.isFile() ? stats.size : null,
    };
  } catch {
    return fallback;
  }
}

function kindFromStats(stats, dirent) {
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }
  if (stats.isDirectory()) {
    return 'directory';
  }
  if (stats.isFile()) {
    return 'file';
  }

  return kindFromDirent(dirent);
}

function kindFromDirent(dirent) {
  if (dirent.isSymbolicLink()) {
    return 'symlink';
  }
  if (dirent.isDirectory()) {
    return 'directory';
  }
  if (dirent.isFile()) {
    return 'file';
  }

  return 'other';
}

function compareEntries(first, second) {
  const firstRank = kindRank(first.kind);
  const secondRank = kindRank(second.kind);
  if (firstRank !== secondRank) {
    return firstRank - secondRank;
  }

  return first.name.localeCompare(second.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function kindRank(kind) {
  switch (kind) {
    case 'directory':
      return 0;
    case 'file':
      return 1;
    case 'symlink':
      return 2;
    default:
      return 3;
  }
}

function parentPath(targetPath) {
  const parent = path.dirname(targetPath);
  return parent === targetPath ? null : parent;
}

function directoryVersion(entries) {
  const hash = crypto.createHash('sha1');
  for (const entry of entries) {
    hash.update(JSON.stringify({
      git: entry.git ?? null,
      itemCount: entry.itemCount ?? null,
      kind: entry.kind,
      modifiedAtMs: entry.modifiedAtMs ?? null,
      name: entry.name,
      path: entry.path,
      sizeBytes: entry.sizeBytes ?? null,
    }));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function emptyGitFileBase({
  path: filePath,
  reason = null,
  repoRoot = null,
  status = null,
}) {
  return {
    content: null,
    encoding: null,
    isBinary: false,
    path: filePath,
    ref: 'HEAD',
    repoRoot,
    sizeBytes: null,
    status,
    tooLarge: false,
    unavailableReason: reason,
  };
}

async function readGitStatusForPath({ repoRootCache, statusCache, targetPath }) {
  const repoRoot = await gitRepoRootCached({ cache: repoRootCache, targetPath });
  if (!repoRoot) {
    return null;
  }

  const cached = statusCache.get(repoRoot);
  const now = Date.now();
  if (cached && now - cached.loadedAtMs < gitStatusCacheTtlMs) {
    return cached.status;
  }

  const entries = await gitStatusEntries(repoRoot);
  const status = indexGitStatus({
    entries,
    repoRoot,
  });
  statusCache.set(repoRoot, {
    loadedAtMs: now,
    status,
  });
  return status;
}

async function gitRepoRootCached({ cache, targetPath }) {
  const resolvedPath = path.resolve(targetPath);
  const cached = cache.get(resolvedPath);
  const now = Date.now();
  if (cached && now - cached.loadedAtMs < gitRepoRootCacheTtlMs) {
    return cached.repoRoot;
  }

  const repoRoot = await gitRepoRoot(resolvedPath);
  cache.set(resolvedPath, {
    loadedAtMs: now,
    repoRoot,
  });
  return repoRoot;
}

async function gitRepoRoot(targetPath) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      targetPath,
      'rev-parse',
      '--show-toplevel',
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const repoRoot = stdout.trim();
    return repoRoot ? path.resolve(repoRoot) : null;
  } catch {
    return null;
  }
}

async function gitStatusEntries(repoRoot) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoRoot,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return parseGitPorcelain(stdout);
  } catch {
    return [];
  }
}

function parseGitPorcelain(output) {
  const records = output.split('\0').filter(Boolean);
  const entries = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) {
      continue;
    }

    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const relativePath = normalizeGitPath(record.slice(3));
    const git = gitStatusFromPorcelain(indexStatus, worktreeStatus);
    if (relativePath && git) {
      entries.push({
        git,
        relativePath,
      });
    }

    if (indexStatus === 'R' || indexStatus === 'C') {
      index += 1;
    }
  }

  return entries;
}

function indexGitStatus({ entries, repoRoot }) {
  const exactByPath = new Map();
  const descendantByDirectoryPath = new Map();

  for (const entry of entries) {
    pushGitStatus(exactByPath, entry.relativePath, entry.git);

    let parent = path.posix.dirname(entry.relativePath);
    while (parent && parent !== '.') {
      pushGitStatus(descendantByDirectoryPath, parent, entry.git);
      parent = path.posix.dirname(parent);
    }
  }

  return {
    descendantByDirectoryPath,
    entries,
    exactByPath,
    repoRoot,
  };
}

function pushGitStatus(map, relativePath, git) {
  const statuses = map.get(relativePath);
  if (statuses) {
    statuses.push(git);
    return;
  }

  map.set(relativePath, [git]);
}

function gitStatusFromPorcelain(indexStatus, worktreeStatus) {
  if (indexStatus === '!' && worktreeStatus === '!') {
    return null;
  }

  const staged = indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '!';
  if (
    indexStatus === 'U' ||
    worktreeStatus === 'U' ||
    (indexStatus === 'A' && worktreeStatus === 'A') ||
    (indexStatus === 'D' && worktreeStatus === 'D')
  ) {
    return { staged, status: 'conflicted' };
  }

  if (indexStatus === '?' && worktreeStatus === '?') {
    return { staged: false, status: 'untracked' };
  }

  if (indexStatus === 'A' || worktreeStatus === 'A') {
    return { staged, status: 'added' };
  }

  if (indexStatus === 'D' || worktreeStatus === 'D') {
    return { staged, status: 'deleted' };
  }

  if (indexStatus === 'R' || worktreeStatus === 'R') {
    return { staged, status: 'renamed' };
  }

  if (
    indexStatus === 'M' ||
    worktreeStatus === 'M' ||
    indexStatus === 'T' ||
    worktreeStatus === 'T'
  ) {
    return { staged, status: 'modified' };
  }

  return null;
}

function gitStatusForEntry(gitStatus, entry) {
  const relativePath = relativeGitPath(gitStatus.repoRoot, entry.path);
  if (!relativePath) {
    return null;
  }

  const statuses = [
    ...(gitStatus.exactByPath.get(relativePath) ?? []),
    ...(entry.kind === 'directory' ? gitStatus.descendantByDirectoryPath.get(relativePath) ?? [] : []),
  ];

  return summarizeGitStatuses(statuses);
}

function gitStatusForRelativePath(gitStatus, relativePath) {
  return summarizeGitStatuses(gitStatus.exactByPath.get(relativePath) ?? []);
}

function summarizeGitStatuses(statuses) {
  if (statuses.length === 0) {
    return null;
  }

  const sorted = [...statuses].sort((first, second) => gitStatusRank(first.status) - gitStatusRank(second.status));
  return {
    staged: statuses.some((status) => status.staged),
    status: sorted[0].status,
  };
}

function gitStatusRank(status) {
  switch (status) {
    case 'conflicted':
      return 0;
    case 'added':
    case 'untracked':
      return 1;
    case 'modified':
    case 'renamed':
      return 2;
    case 'deleted':
      return 3;
    default:
      return 4;
  }
}

function relativeGitPath(repoRoot, entryPath) {
  for (const candidateRoot of pathComparisonCandidates(repoRoot)) {
    for (const candidateEntryPath of pathComparisonCandidates(entryPath)) {
      const relative = path.relative(candidateRoot, candidateEntryPath);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return normalizeGitPath(relative);
      }
    }
  }

  return null;
}

function normalizeGitPath(value) {
  return value.replaceAll(path.sep, '/').replace(/^\/+/u, '').replace(/\/+$/u, '');
}

function pathComparisonCandidates(value) {
  const resolved = path.resolve(value);
  if (process.platform !== 'darwin') {
    return [resolved];
  }

  if (resolved.startsWith('/private/var/')) {
    return [resolved, resolved.slice('/private'.length)];
  }

  if (resolved.startsWith('/var/')) {
    return [resolved, `/private${resolved}`];
  }

  return [resolved];
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
  createFsCore,
  readDirectoriesMethod,
  readDirectoryMethod,
  readFileMethod,
};
