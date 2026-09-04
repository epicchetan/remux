import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openNativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import {
  NATIVE_AGENT_APPLICATION_ID,
  NATIVE_AGENT_SCHEMA_ID,
  NATIVE_AGENT_SCHEMA_VERSION,
  NATIVE_AGENT_TABLES,
  createNativeAgentSchema,
  listNativeAgentTables,
  migrateNativeAgentSchema,
  validateNativeAgentSchema,
} from '../server/src/native-runtime/schema.ts';

test('native Agent schema has a distinct application identity and only provider-runtime tables', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    createNativeAgentSchema(database);
    validateNativeAgentSchema(database);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      NATIVE_AGENT_SCHEMA_VERSION);
    assert.equal((database.prepare('PRAGMA application_id').get() as { application_id: number }).application_id,
      NATIVE_AGENT_APPLICATION_ID);
    assert.equal(JSON.parse((database.prepare('SELECT value_json FROM meta WHERE key = ?')
      .get('schema_id') as { value_json: string }).value_json), NATIVE_AGENT_SCHEMA_ID);
    assert.deepEqual(listNativeAgentTables(database).sort(), [...NATIVE_AGENT_TABLES].sort());
    const schemaText = (database.prepare(`
      SELECT group_concat(sql, '\n') AS sql FROM sqlite_schema WHERE type = 'table'
    `).get() as { sql: string }).sql;
    assert.doesNotMatch(schemaText, /context_frame|work_unit|inference|provider_item/iu);
  } finally {
    database.close();
  }
});

test('native Agent schema migrates version 2 execution scheduling state without data loss', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE executions (
        execution_id TEXT PRIMARY KEY,
        effort TEXT,
        access TEXT
      );
      INSERT INTO executions(execution_id, effort, access)
        VALUES ('execution-1', 'high', 'workspace-write');
      CREATE TABLE turns (
        turn_id TEXT PRIMARY KEY
      );
      PRAGMA user_version = 2;
    `);
    migrateNativeAgentSchema(database, 2);
    const row = database.prepare(`
      SELECT effort, access, federation_scheduling, federation_depth
      FROM executions WHERE execution_id = 'execution-1'
    `).get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, {
      effort: 'high',
      access: 'workspace-write',
      federation_scheduling: null,
      federation_depth: 0,
    });
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      NATIVE_AGENT_SCHEMA_VERSION);
    const turnColumns = database.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>;
    assert.ok(turnColumns.some(({ name }) => name === 'assistant_artifact_id'));
  } finally {
    database.close();
  }
});

test('native Agent schema migrates version 3 terminal-output references', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE turns (turn_id TEXT PRIMARY KEY);
      PRAGMA user_version = 3;
    `);
    migrateNativeAgentSchema(database, 3);
    const columns = database.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>;
    assert.ok(columns.some(({ name }) => name === 'assistant_artifact_id'));
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      NATIVE_AGENT_SCHEMA_VERSION);
  } finally {
    database.close();
  }
});

test('native Agent schema migrates indexed history state from version 5', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY,
        root_execution_id TEXT NOT NULL
      );
      CREATE TABLE turns (conversation_id TEXT NOT NULL);
      CREATE TABLE native_sessions (execution_id TEXT PRIMARY KEY);
      INSERT INTO conversations(conversation_id, root_execution_id)
        VALUES ('history-1', 'execution-1'), ('empty-new-1', 'execution-2');
      INSERT INTO native_sessions(execution_id) VALUES ('execution-1');
      PRAGMA user_version = 5;
    `);
    migrateNativeAgentSchema(database, 5);
    const rows = database.prepare(`
      SELECT conversation_id, history_state, history_error
      FROM conversations ORDER BY conversation_id
    `).all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => ({ ...row })), [{
      conversation_id: 'empty-new-1', history_state: 'ready', history_error: null,
    }, {
      conversation_id: 'history-1', history_state: 'indexed', history_error: null,
    }]);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      NATIVE_AGENT_SCHEMA_VERSION);
  } finally {
    database.close();
  }
});

test('native Agent schema migrates version 6 conversations into ordered legacy strands', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE provider_instances (provider_instance_id TEXT PRIMARY KEY);
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY,
        provider_instance_id TEXT NOT NULL,
        root_execution_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE executions (
        execution_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL
      );
      CREATE TABLE turns (
        turn_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        native_turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE command_receipts (command_id TEXT PRIMARY KEY);
      INSERT INTO provider_instances VALUES ('codex-local');
      INSERT INTO conversations VALUES ('conversation-1', 'codex-local', 'execution-1', 10, 40);
      INSERT INTO executions VALUES ('execution-1', 'conversation-1', 'codex', 'codex-local');
      INSERT INTO turns VALUES
        ('turn-later', 'conversation-1', 'execution-1', 'native-later', 30, 30),
        ('turn-first', 'conversation-1', 'execution-1', 'native-first', 20, 20);
      PRAGMA user_version = 6;
    `);

    migrateNativeAgentSchema(database, 6);

    const conversation = database.prepare(`
      SELECT root_conversation_id, subtree_updated_at FROM conversations
      WHERE conversation_id = 'conversation-1'
    `).get() as Record<string, unknown>;
    assert.deepEqual({ ...conversation }, {
      root_conversation_id: 'conversation-1',
      subtree_updated_at: 40,
    });
    assert.deepEqual(database.prepare(`
      SELECT strand_id, ordinal, turn_id FROM strand_turn_path ORDER BY ordinal
    `).all().map((row) => ({ ...row })), [{
      strand_id: 'legacy-strand:conversation-1', ordinal: 0, turn_id: 'turn-first',
    }, {
      strand_id: 'legacy-strand:conversation-1', ordinal: 1, turn_id: 'turn-later',
    }]);
    const bindings = database.prepare(`
      SELECT turn_id, binding_state FROM native_turn_bindings ORDER BY turn_id
    `).all().map((row) => ({ ...row }));
    assert.deepEqual(bindings, [{ turn_id: 'turn-first', binding_state: 'authoritative' }, {
      turn_id: 'turn-later', binding_state: 'authoritative',
    }]);
  } finally {
    database.close();
  }
});

test('native Agent schema migrates version 7 history freshness metadata', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY,
        history_state TEXT NOT NULL DEFAULT 'ready',
        history_error TEXT
      );
      INSERT INTO conversations(conversation_id) VALUES ('conversation-1');
      PRAGMA user_version = 7;
    `);

    migrateNativeAgentSchema(database, 7);

    const columns = database.prepare('PRAGMA table_info(conversations)')
      .all() as Array<{ name: string }>;
    assert.ok(columns.some(({ name }) => name === 'native_history_revision'));
    assert.ok(columns.some(({ name }) => name === 'native_history_updated_at'));
    assert.ok(columns.some(({ name }) => name === 'history_synced_revision'));
    assert.ok(columns.some(({ name }) => name === 'history_synced_at'));
    const row = database.prepare(`
      SELECT native_history_revision, native_history_updated_at,
        history_synced_revision, history_synced_at
      FROM conversations WHERE conversation_id = 'conversation-1'
    `).get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, {
      native_history_revision: null,
      native_history_updated_at: null,
      history_synced_revision: null,
      history_synced_at: null,
    });
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      NATIVE_AGENT_SCHEMA_VERSION);
  } finally {
    database.close();
  }
});

test('native Agent journal opener migrates a file-backed version 7 database', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'remux-native-schema-v7-'));
  const databasePath = join(dataRoot, 'agent.sqlite3');
  let journal: Awaited<ReturnType<typeof openNativeAgentJournal>> | undefined;
  try {
    const versionSeven = new DatabaseSync(databasePath);
    try {
      createNativeAgentSchema(versionSeven);
      versionSeven.exec(`
        ALTER TABLE conversations DROP COLUMN native_history_revision;
        ALTER TABLE conversations DROP COLUMN native_history_updated_at;
        ALTER TABLE conversations DROP COLUMN history_synced_revision;
        ALTER TABLE conversations DROP COLUMN history_synced_at;
        PRAGMA user_version = 7;
      `);
    } finally {
      versionSeven.close();
    }

    journal = await openNativeAgentJournal({ dataRoot });

    assert.equal((journal.database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version, NATIVE_AGENT_SCHEMA_VERSION);
    const columns = journal.database.prepare('PRAGMA table_info(conversations)')
      .all() as Array<{ name: string }>;
    assert.ok(columns.some(({ name }) => name === 'native_history_revision'));
    assert.ok(columns.some(({ name }) => name === 'native_history_updated_at'));
    assert.ok(columns.some(({ name }) => name === 'history_synced_revision'));
    assert.ok(columns.some(({ name }) => name === 'history_synced_at'));
  } finally {
    journal?.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('native Agent schema rejects another application identity', () => {
  const database = new DatabaseSync(':memory:');
  try {
    createNativeAgentSchema(database);
    database.exec('PRAGMA application_id = 1');
    assert.throws(() => validateNativeAgentSchema(database), /identity mismatch/u);
  } finally {
    database.close();
  }
});
