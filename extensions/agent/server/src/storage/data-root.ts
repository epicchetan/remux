import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type AgentDataPaths = {
  root: string;
  database: string;
  artifacts: string;
  artifactObjects: string;
  temporary: string;
};

export type AgentDataRootOptions = {
  dataRoot?: string;
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
};

export function resolveAgentDataRoot(options: AgentDataRootOptions = {}) {
  if (options.dataRoot) return resolve(options.dataRoot);
  const env = options.env ?? process.env;
  const explicit = nonempty(env.REMUX_AGENT_DATA_DIR);
  if (explicit) return resolve(explicit);
  const xdg = nonempty(env.XDG_DATA_HOME);
  if (xdg) return resolve(xdg, 'remux', 'agent');
  return join(options.homeDirectory ?? homedir(), '.local', 'share', 'remux', 'agent');
}

export function agentDataPaths(root: string): AgentDataPaths {
  const resolved = resolve(root);
  const artifacts = join(resolved, 'artifacts');
  return {
    root: resolved,
    database: join(resolved, 'agent.sqlite3'),
    artifacts,
    artifactObjects: join(artifacts, 'sha256'),
    temporary: join(resolved, 'tmp'),
  };
}

export async function prepareAgentDataPaths(options: AgentDataRootOptions = {}) {
  const paths = agentDataPaths(resolveAgentDataRoot(options));
  await secureDirectory(paths.root);
  await secureDirectory(paths.artifacts);
  await secureDirectory(paths.artifactObjects);
  await secureDirectory(paths.temporary);
  await createDatabaseFile(paths.database);
  await secureDatabaseSidecars(paths.database);
  return paths;
}

export async function secureDatabaseFile(path: string) {
  const file = await openRegularFileNoFollow(path);
  try {
    if (process.platform !== 'win32') await file.chmod(0o600);
  } finally {
    await file.close();
  }
}

export async function secureDatabaseSidecars(databasePath: string) {
  await secureSidecarIfPresent(`${databasePath}-wal`);
  await secureSidecarIfPresent(`${databasePath}-shm`);
}

async function secureDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Agent data path is not a directory: ${path}`);
  }
  if (process.platform === 'win32') return;
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.chmod(0o700);
  } finally {
    await directory.close();
  }
}

async function createDatabaseFile(path: string) {
  try {
    const file = await open(path, 'wx', 0o600);
    await file.close();
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const file = await openRegularFileNoFollow(path);
    await file.close();
  }
}

async function secureSidecarIfPresent(path: string) {
  try {
    const file = await openRegularFileNoFollow(path);
    try {
      if (process.platform !== 'win32') await file.chmod(0o600);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function openRegularFileNoFollow(path: string) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Agent database path is not a regular file: ${path}`);
  }
  const flags = process.platform === 'win32'
    ? constants.O_RDWR
    : constants.O_RDWR | constants.O_NOFOLLOW;
  const file = await open(path, flags);
  const openedMetadata = await file.stat();
  if (!openedMetadata.isFile()) {
    await file.close();
    throw new Error(`Agent database path is not a regular file: ${path}`);
  }
  return file;
}

function nonempty(value: string | undefined) {
  return value && value.length > 0 ? value : null;
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
