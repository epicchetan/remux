import type { DatabaseSync } from 'node:sqlite';

import {
  prepareAgentDataPaths,
  secureDatabaseFile,
  secureDatabaseSidecars,
  type AgentDataPaths,
  type AgentDataRootOptions,
} from './data-root.ts';
import {
  AGENT_JOURNAL_SCHEMA_VERSION,
  AgentSchemaError,
  agentSchemaFingerprint,
  createAgentSchemaV1,
  createAgentSchemaV2,
  listAgentDatabaseTables,
  migrateAgentSchemaV1ToV2,
  validateAgentSchemaV1,
  validateAgentSchemaV2,
} from './schema.ts';

export type AgentDatabaseDiagnostics = {
  userVersion: number;
  journalMode: string;
  foreignKeys: number;
  synchronous: number;
  busyTimeout: number;
};

export class AgentDatabase {
  readonly database: DatabaseSync;
  readonly paths: AgentDataPaths;
  private closed = false;

  constructor(database: DatabaseSync, paths: AgentDataPaths) {
    this.database = database;
    this.paths = paths;
  }

  transaction<T>(work: () => T) {
    this.assertOpen();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the error that caused the transaction to fail.
      }
      throw error;
    }
  }

  diagnostics(): AgentDatabaseDiagnostics {
    this.assertOpen();
    return {
      userVersion: pragmaNumber(this.database, 'user_version'),
      journalMode: pragmaString(this.database, 'journal_mode'),
      foreignKeys: pragmaNumber(this.database, 'foreign_keys'),
      synchronous: pragmaNumber(this.database, 'synchronous'),
      busyTimeout: pragmaNumber(this.database, 'busy_timeout'),
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private assertOpen() {
    if (this.closed) throw new Error('Agent database is closed.');
  }
}

export async function openAgentDatabase(options: AgentDataRootOptions = {}) {
  assertAgentStorageRuntime();
  const paths = await prepareAgentDataPaths(options);
  const sqlite = await import('node:sqlite').catch((error) => {
    throw new UnsupportedAgentStorageRuntimeError(
      `Node ${process.versions.node} does not provide the required node:sqlite API.`,
      { cause: error },
    );
  });
  const database = new sqlite.DatabaseSync(paths.database, { timeout: 5_000 });
  try {
    const version = pragmaNumber(database, 'user_version');
    if (version > AGENT_JOURNAL_SCHEMA_VERSION) {
      throw new AgentSchemaVersionError(
        `Agent journal schema ${version} is newer than supported version ${AGENT_JOURNAL_SCHEMA_VERSION}.`,
      );
    }
    if (version === 0) {
      const tables = listAgentDatabaseTables(database);
      if (tables.length > 0) {
        throw new AgentSchemaError(
          `Refusing to initialize an unversioned Agent database containing tables: ${tables.join(', ')}.`,
        );
      }
    } else if (version !== 1 && version !== AGENT_JOURNAL_SCHEMA_VERSION) {
      throw new AgentSchemaVersionError(`Unsupported Agent journal schema version ${version}.`);
    }

    await secureDatabaseFile(paths.database);
    applyConnectionPragmas(database);
    await secureDatabaseSidecars(paths.database);
    if (version === 0) {
      runTransaction(database, () => createAgentSchemaV2(database));
    } else if (version === 1) {
      const versionOneReference = new sqlite.DatabaseSync(':memory:');
      try {
        createAgentSchemaV1(versionOneReference);
        validateAgentSchemaV1(database, agentSchemaFingerprint(versionOneReference));
      } finally {
        versionOneReference.close();
      }
      runTransaction(database, () => migrateAgentSchemaV1ToV2(database));
    }
    const reference = new sqlite.DatabaseSync(':memory:');
    let expectedFingerprint: string;
    try {
      createAgentSchemaV2(reference);
      expectedFingerprint = agentSchemaFingerprint(reference);
    } finally {
      reference.close();
    }
    validateAgentSchemaV2(database, expectedFingerprint);
    runQuickCheck(database);
    return new AgentDatabase(database, paths);
  } catch (error) {
    database.close();
    throw error;
  }
}

export class UnsupportedAgentStorageRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnsupportedAgentStorageRuntimeError';
  }
}

export class AgentSchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSchemaVersionError';
  }
}

function assertAgentStorageRuntime() {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  if (major !== 24) {
    throw new UnsupportedAgentStorageRuntimeError(
      `Agent durable storage requires Node 24.x; running ${process.versions.node}.`,
    );
  }
}

function applyConnectionPragmas(database: DatabaseSync) {
  const journalMode = database.prepare('PRAGMA journal_mode = WAL').get() as
    | { journal_mode: string }
    | undefined;
  if (journalMode?.journal_mode.toLowerCase() !== 'wal') {
    throw new Error(`Agent database failed to enter WAL mode: ${journalMode?.journal_mode ?? 'unknown'}.`);
  }
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
  `);
  if (pragmaNumber(database, 'foreign_keys') !== 1) {
    throw new Error('Agent database failed to enable foreign keys.');
  }
}

function runTransaction<T>(database: DatabaseSync, work: () => T) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the migration error.
    }
    throw error;
  }
}

function pragmaNumber(database: DatabaseSync, name: string) {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid SQLite PRAGMA ${name} value.`);
  }
  return value;
}

function pragmaString(database: DatabaseSync, name: string) {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== 'string') throw new Error(`Invalid SQLite PRAGMA ${name} value.`);
  return value;
}

function runQuickCheck(database: DatabaseSync) {
  const rows = database.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
  if (
    rows.length !== 1 ||
    Object.values(rows[0] ?? {})[0] !== 'ok'
  ) {
    throw new Error('Agent database failed SQLite quick_check.');
  }
}
