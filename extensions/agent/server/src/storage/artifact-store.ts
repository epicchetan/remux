import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentDataPaths } from './data-root.ts';

export type StagedArtifact = {
  hash: string;
  byteLength: number;
  mediaType: string;
  storagePath: string;
};

type ArtifactReference = Pick<StagedArtifact, 'hash' | 'byteLength' | 'storagePath'>;

export class ArtifactIntegrityError extends Error {
  readonly code = 'durable_artifact_integrity';
  readonly reason: 'hash' | 'length' | 'missing' | 'path' | 'type';

  constructor(reason: 'hash' | 'length' | 'missing' | 'path' | 'type') {
    super('Durable artifact failed integrity verification.');
    this.name = 'ArtifactIntegrityError';
    this.reason = reason;
  }
}

/**
 * Immutable, content-addressed storage. Files are durable before a SQL row is
 * allowed to refer to them; an unreferenced object is therefore a safe crash
 * residue, while a committed row can never point at a partially-written file.
 */
export class AgentArtifactStore {
  private readonly paths: AgentDataPaths;
  private readonly verifiedHashes = new Set<string>();

  constructor(paths: AgentDataPaths) {
    this.paths = paths;
  }

  async put(bytes: Uint8Array, mediaType: string): Promise<StagedArtifact> {
    const buffer = Buffer.from(bytes);
    const hash = createHash('sha256').update(buffer).digest('hex');
    const storagePath = join('sha256', hash.slice(0, 2), hash);
    const destination = join(this.paths.artifacts, storagePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

    if (await matchesExisting(destination, buffer.byteLength, hash)) {
      this.verifiedHashes.add(hash);
      return { hash, byteLength: buffer.byteLength, mediaType, storagePath };
    }

    const temporary = join(this.paths.temporary, `artifact-${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await file.writeFile(buffer);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!isAlreadyExists(error) || !await matchesExisting(destination, buffer.byteLength, hash)) throw error;
      await unlink(temporary).catch(() => undefined);
    }
    if (process.platform !== 'win32') {
      const directory = await open(dirname(destination), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    this.verifiedHashes.add(hash);
    return { hash, byteLength: buffer.byteLength, mediaType, storagePath };
  }

  async validateMetadata(artifact: ArtifactReference) {
    const file = await this.openValidated(artifact);
    await file.close();
  }

  async verify(artifact: ArtifactReference, force = false) {
    const file = await this.openValidated(artifact);
    try {
      const bytes = await file.readFile();
      this.verifyBytes(artifact, bytes, force);
      return bytes.byteLength;
    } finally {
      await file.close();
    }
  }

  async read(artifact: ArtifactReference) {
    const file = await this.openValidated(artifact);
    try {
      const bytes = await file.readFile();
      this.verifyBytes(artifact, bytes, false);
      return bytes;
    } finally {
      await file.close();
    }
  }

  async readRange(
    artifact: ArtifactReference,
    offset: number,
    byteLength: number,
  ) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new TypeError('Artifact range must use non-negative safe integers.');
    }
    const file = await this.openValidated(artifact);
    try {
      if (!this.verifiedHashes.has(artifact.hash)) {
        this.verifyBytes(artifact, await file.readFile(), false);
      }
      const start = Math.min(offset, artifact.byteLength);
      const length = Math.min(byteLength, artifact.byteLength - start);
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await file.read(bytes, 0, length, start);
      if (bytesRead !== length) throw new Error(`Artifact ${artifact.hash} returned a short range read.`);
      return bytes;
    } finally {
      await file.close();
    }
  }

  private async openValidated(artifact: ArtifactReference) {
    const expectedStoragePath = artifactStoragePath(artifact);
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(
        join(this.paths.artifacts, expectedStoragePath),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      throw new ArtifactIntegrityError(isMissing(error) ? 'missing' : 'type');
    }
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new ArtifactIntegrityError('type');
      if (metadata.size !== artifact.byteLength) throw new ArtifactIntegrityError('length');
      return file;
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error instanceof ArtifactIntegrityError
        ? error
        : new ArtifactIntegrityError('type');
    }
  }

  private verifyBytes(artifact: ArtifactReference, bytes: Uint8Array, force: boolean) {
    if (bytes.byteLength !== artifact.byteLength) throw new ArtifactIntegrityError('length');
    if (!force && this.verifiedHashes.has(artifact.hash)) return;
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== artifact.hash) throw new ArtifactIntegrityError('hash');
    this.verifiedHashes.add(artifact.hash);
  }

  async listInstalledStoragePaths() {
    const paths: string[] = [];
    for (const prefix of await readdir(this.paths.artifactObjects, { withFileTypes: true })) {
      const prefixPath = join(this.paths.artifactObjects, prefix.name);
      if (prefix.isSymbolicLink() || !prefix.isDirectory() || !/^[0-9a-f]{2}$/u.test(prefix.name)) {
        throw new Error(`Artifact object prefix is invalid: ${prefixPath}`);
      }
      for (const entry of await readdir(prefixPath, { withFileTypes: true })) {
        const objectPath = join(prefixPath, entry.name);
        if (entry.isSymbolicLink() || !entry.isFile() || !/^[0-9a-f]{64}$/u.test(entry.name)) {
          throw new Error(`Artifact object is invalid: ${objectPath}`);
        }
        const metadata = await lstat(objectPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error(`Artifact object is not a regular file: ${objectPath}`);
        }
        paths.push(join('sha256', prefix.name, entry.name));
      }
    }
    return paths.sort();
  }
}

function artifactStoragePath(artifact: ArtifactReference) {
  if (!/^[0-9a-f]{64}$/u.test(artifact.hash)) throw new ArtifactIntegrityError('path');
  const expectedStoragePath = join('sha256', artifact.hash.slice(0, 2), artifact.hash);
  if (artifact.storagePath !== expectedStoragePath) throw new ArtifactIntegrityError('path');
  return expectedStoragePath;
}

async function matchesExisting(path: string, byteLength: number, hash: string) {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`Artifact object is not a regular file: ${path}`);
    if (metadata.size !== byteLength) throw new Error(`Artifact object has an unexpected size: ${path}`);
    const actualHash = createHash('sha256').update(await readFile(path)).digest('hex');
    if (actualHash !== hash) throw new Error(`Artifact object failed hash verification: ${path}`);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
