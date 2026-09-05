import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { NativeAgentJournal, openNativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import { NativeFixtureAdapter } from '../server/src/native-fixture-adapter.ts';
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

test('partial version 2 delta fixture adds execution scheduling before rejecting incomplete v13 parents', () => {
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
    assert.throws(() => migrateNativeAgentSchema(database, 2), /Version 13 requires/u);
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
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
    const turnColumns = database.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>;
    assert.ok(turnColumns.some(({ name }) => name === 'assistant_artifact_id'));
  } finally {
    database.close();
  }
});

test('partial version 3 delta fixture adds terminal output before rejecting incomplete v13 parents', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE turns (turn_id TEXT PRIMARY KEY);
      PRAGMA user_version = 3;
    `);
    assert.throws(() => migrateNativeAgentSchema(database, 3), /Version 13 requires/u);
    const columns = database.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>;
    assert.ok(columns.some(({ name }) => name === 'assistant_artifact_id'));
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
  } finally {
    database.close();
  }
});

test('partial version 5 delta fixture adds history state before rejecting incomplete v13 parents', () => {
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
    assert.throws(() => migrateNativeAgentSchema(database, 5), /Version 13 requires/u);
    const rows = database.prepare(`
      SELECT conversation_id, history_state, history_error
      FROM conversations ORDER BY conversation_id
    `).all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => ({ ...row })), [{
      conversation_id: 'empty-new-1', history_state: 'ready', history_error: null,
    }, {
      conversation_id: 'history-1', history_state: 'indexed', history_error: null,
    }]);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5);
  } finally {
    database.close();
  }
});

test('partial version 6 delta fixture adds legacy strands before rejecting incomplete v13 parents', () => {
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

    assert.throws(() => migrateNativeAgentSchema(database, 6), /Version 13 requires/u);

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

test('partial version 7 delta fixture adds freshness metadata before rejecting incomplete v13 parents', () => {
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

    assert.throws(() => migrateNativeAgentSchema(database, 7), /Version 13 requires/u);

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
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
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

test('native Agent schema migrates version 8 queued execution envelopes', () => {
  const database = new DatabaseSync(':memory:');
  try {
    createNativeAgentSchema(database);
    database.exec(`
      ALTER TABLE queued_messages DROP COLUMN access;
      ALTER TABLE queued_messages DROP COLUMN state;
      INSERT INTO provider_instances(
        provider_instance_id, provider, label, probe_state, probe_json,
        capability_revision, updated_at
      ) VALUES (
        'fixture-local', 'fixture', 'Fixture', 'ready',
        '{"state":"ready"}', 'fixture-capabilities', 1
      );
      INSERT INTO conversations(
        conversation_id, provider_instance_id, root_execution_id,
        parent_conversation_id, root_conversation_id, title, preview, cwd,
        model, access, state, resumable, subtree_updated_at, created_at, updated_at
      ) VALUES (
        'conversation-1', 'fixture-local', 'execution-1', NULL,
        'conversation-1', 'Queue migration', '', '/workspace',
        'fixture-native-v1', 'workspace-write', 'idle', 1, 1, 1, 1
      );
      PRAGMA user_version = 8;
    `);

    migrateNativeAgentSchema(database, 8);

    const columns = database.prepare('PRAGMA table_info(queued_messages)')
      .all() as Array<{ name: string }>;
    assert.ok(columns.some(({ name }) => name === 'access'));
    assert.ok(columns.some(({ name }) => name === 'state'));
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      NATIVE_AGENT_SCHEMA_VERSION);
  } finally {
    database.close();
  }
});

test('native Agent schema migrates version 9 native child handles', () => {
  const database = new DatabaseSync(':memory:');
  try {
    createNativeAgentSchema(database);
    database.exec(`
      DROP TABLE native_child_handles;
      PRAGMA user_version = 9;
    `);

    migrateNativeAgentSchema(database, 9);

    assert.ok(listNativeAgentTables(database).includes('native_child_handles'));
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      NATIVE_AGENT_SCHEMA_VERSION);
  } finally {
    database.close();
  }
});

test('partial version 11 delta fixture pins service tier before rejecting incomplete v13 parents', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE provider_instances(provider_instance_id TEXT, provider TEXT);
      CREATE TABLE conversations(conversation_id TEXT, provider_instance_id TEXT);
      CREATE TABLE executions(execution_id TEXT, provider TEXT);
      CREATE TABLE turns(turn_id TEXT);
      CREATE TABLE composer_preferences(
        scope TEXT, provider_instance_id TEXT, model TEXT, effort TEXT
      );
      CREATE TABLE queued_messages(turn_id TEXT, conversation_id TEXT);

      INSERT INTO provider_instances VALUES ('codex-local', 'codex'), ('claude-local', 'claude-code');
      INSERT INTO conversations VALUES ('codex-conversation', 'codex-local'), ('claude-conversation', 'claude-local');
      INSERT INTO executions VALUES ('codex-execution', 'codex'), ('claude-execution', 'claude-code');
      INSERT INTO turns VALUES ('historical-codex-turn');
      INSERT INTO composer_preferences VALUES ('provider', 'codex-local', 'gpt-test', 'high');
      INSERT INTO composer_preferences VALUES ('default-provider', 'codex-local', NULL, NULL);
      INSERT INTO queued_messages VALUES ('queued-codex-turn', 'codex-conversation');
      PRAGMA user_version = 11;
    `);

    assert.throws(() => migrateNativeAgentSchema(database, 11), /Version 13 requires/u);

    assert.equal((database.prepare(`
      SELECT service_tier FROM conversations WHERE conversation_id = 'codex-conversation'
    `).get() as { service_tier: string }).service_tier, 'default');
    assert.equal((database.prepare(`
      SELECT service_tier FROM conversations WHERE conversation_id = 'claude-conversation'
    `).get() as { service_tier: null }).service_tier, null);
    assert.equal((database.prepare(`
      SELECT service_tier FROM queued_messages WHERE turn_id = 'queued-codex-turn'
    `).get() as { service_tier: string }).service_tier, 'default');
    assert.equal((database.prepare(`
      SELECT service_tier FROM composer_preferences WHERE scope = 'provider'
    `).get() as { service_tier: string }).service_tier, 'default');
    assert.equal((database.prepare(`
      SELECT service_tier FROM composer_preferences WHERE scope = 'default-provider'
    `).get() as { service_tier: null }).service_tier, null);
    assert.equal((database.prepare(`
      SELECT service_tier FROM turns WHERE turn_id = 'historical-codex-turn'
    `).get() as { service_tier: null }).service_tier, null);
  } finally {
    database.close();
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

test('faithful schema v12 migrates grants, exclusions, constraints, and rollback atomically', async () => {
  const fixtureSql = await readFile(new URL('./fixtures/native-agent-schema-v12.sql', import.meta.url), 'utf8');
  const database = new DatabaseSync(':memory:');
  database.exec(`PRAGMA foreign_keys = ON; ${fixtureSql}; PRAGMA user_version = 12;
    PRAGMA application_id = ${NATIVE_AGENT_APPLICATION_ID};`);
  database.prepare('INSERT INTO meta(key, value_json) VALUES (?, ?)')
    .run('schema_id', JSON.stringify(NATIVE_AGENT_SCHEMA_ID));
  const journal = new NativeAgentJournal(database);
  try {
    const probe = await new NativeFixtureAdapter().probe('fixture-local');
    journal.upsertProviderInstance({ providerInstanceId: 'fixture-local', provider: 'fixture',
      label: 'Fixture', probe, now: 1 });
    journal.createConversation({ conversationId: 'conversation-1', rootExecutionId: 'root-current',
      provider: 'fixture', providerInstanceId: 'fixture-local', title: 'Migration', cwd: '/workspace',
      model: 'fixture-native-v1', access: 'read-only', now: 1 });
    database.exec(`BEGIN;
      INSERT INTO executions(
        execution_id, conversation_id, strand_id, parent_execution_id, root_turn_id,
        ownership, provider, provider_instance_id, model, effort, service_tier, access,
        federation_scheduling, federation_depth, title, state, transcript_available,
        created_at, updated_at
      ) SELECT 'root-older', conversation_id, 'strand-older', NULL, NULL, ownership,
        provider, provider_instance_id, model, effort, service_tier, access, NULL, 0,
        'Older', 'recovering', 1, 2, 2 FROM executions WHERE execution_id = 'root-current';
      INSERT INTO conversation_strands(
        strand_id, conversation_id, source_strand_id, source_path_entry_id,
        cutoff_kind, reason, root_execution_id, state, created_at, ready_at
      ) VALUES ('strand-older', 'conversation-1', NULL, NULL, 'before', 'edit',
        'root-older', 'preparing', 2, NULL);
      COMMIT;
    `);
    const images = [['image-current', 'a'], ['image-older', 'b'], ['image-unproven', 'c']] as const;
    for (const [artifactId, nibble] of images) journal.registerArtifact({ artifactId,
      sha256: nibble.repeat(64), byteLength: 4, mediaType: 'image/png', visibility: 'viewer',
      storagePath: `${nibble}/${artifactId}`, createdAt: 2 });
    const addTurn = (turnId: string, executionId: string, commandId: string, artifactId: string) =>
      journal.createTurn({ turnId, conversationId: 'conversation-1', executionId,
        clientMessageId: `message-${turnId}`, commandId,
        content: [{ type: 'image-artifact', artifactId, mimeType: 'image/png' }],
        model: 'fixture-native-v1', state: 'running', now: 3 });
    journal.claimCommand('send-current', 'turn.send', { destination: 'current' }, 3);
    addTurn('turn-current', 'root-current', 'send-current', 'image-current');
    journal.acceptCommand('send-current', { accepted: true, conversationId: 'conversation-1',
      turnId: 'turn-current' }, 3);
    journal.claimCommand('edit-older', 'conversation.edit', { destination: 'older' }, 3);
    addTurn('turn-older', 'root-older', 'edit-older', 'image-older');
    journal.acceptCommand('edit-older', { accepted: true, conversationId: 'conversation-1',
      turnId: 'turn-older' }, 3);
    addTurn('turn-unproven', 'root-older', 'native-import-command:turn-unproven', 'image-unproven');

    database.exec('BEGIN IMMEDIATE');
    migrateNativeAgentSchema(database, 12);
    database.exec('COMMIT');
    validateNativeAgentSchema(database);
    assert.deepEqual(database.prepare(`
      SELECT artifact_id, conversation_id, execution_id, provenance
      FROM artifact_grants ORDER BY artifact_id
    `).all().map((row) => ({ ...row })), [{
      artifact_id: 'image-current', conversation_id: 'conversation-1', execution_id: null,
      provenance: 'viewer-message',
    }, {
      artifact_id: 'image-older', conversation_id: 'conversation-1', execution_id: null,
      provenance: 'viewer-message',
    }]);
    const report = JSON.parse((database.prepare(`
      SELECT value_json FROM meta WHERE key = 'schema_v13_artifact_grants'
    `).get() as { value_json: string }).value_json);
    assert.deepEqual(report.message, {
      candidates: 3, inserted: 2, excluded: { 'missing-or-nonaccepted-receipt': 1 },
    });
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((database.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
      .integrity_check, 'ok');
    const fresh = new DatabaseSync(':memory:');
    createNativeAgentSchema(fresh);
    const grantObjects = (db: DatabaseSync) => db.prepare(`
      SELECT type, name, replace(replace(sql, char(10), ''), ' ', '') AS sql
      FROM sqlite_schema
      WHERE name = 'artifact_grants' OR name LIKE 'artifact_grants_%'
      ORDER BY type, name
    `).all().map((row) => ({ ...row }));
    assert.deepEqual(grantObjects(database), grantObjects(fresh));
    fresh.close();
    assert.throws(() => database.prepare(`
      INSERT INTO artifact_grants(artifact_id, conversation_id, execution_id, provenance, created_at)
      VALUES ('image-current', 'conversation-1', 'missing-execution', 'execution-output', 4)
    `).run(), /FOREIGN KEY constraint failed/u);
  } finally {
    journal.close();
  }

  const rollbackRoot = await mkdtemp(join(tmpdir(), 'remux-schema-v12-rollback-'));
  const rollbackPath = join(rollbackRoot, 'agent.sqlite3');
  try {
    let rollback = new DatabaseSync(rollbackPath);
    rollback.exec(`PRAGMA foreign_keys = ON; ${fixtureSql}; PRAGMA user_version = 12;
      PRAGMA application_id = ${NATIVE_AGENT_APPLICATION_ID};`);
    rollback.prepare('INSERT INTO meta(key, value_json) VALUES (?, ?)')
      .run('schema_id', JSON.stringify(NATIVE_AGENT_SCHEMA_ID));
    rollback.exec(`CREATE TRIGGER fail_v13_audit BEFORE INSERT ON meta
      WHEN NEW.key = 'schema_v13_artifact_grants'
      BEGIN SELECT RAISE(ABORT, 'injected v13 audit failure'); END;`);
    rollback.close();
    await assert.rejects(() => openNativeAgentJournal({ dataRoot: rollbackRoot }),
      /injected v13 audit failure/u);
    rollback = new DatabaseSync(rollbackPath);
    assert.equal((rollback.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 12);
    assert.equal((rollback.prepare(`SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name = 'artifact_grants'`).get() as { count: number }).count, 0);
    rollback.exec('DROP TRIGGER fail_v13_audit');
    rollback.close();
    const reopened = await openNativeAgentJournal({ dataRoot: rollbackRoot });
    assert.equal((reopened.database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version, 16);
    reopened.close();
  } finally {
    await rm(rollbackRoot, { recursive: true, force: true });
  }
});

test('incomplete historical parent schema cannot commit version 13', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY);
      CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY);
      CREATE TABLE executions(execution_id TEXT PRIMARY KEY);
      CREATE TABLE turns(turn_id TEXT PRIMARY KEY);
      PRAGMA user_version = 12; BEGIN IMMEDIATE;`);
    assert.throws(() => migrateNativeAgentSchema(database, 12), /requires executions.conversation_id/u);
    database.exec('ROLLBACK');
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 12);
    assert.equal((database.prepare(`SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name = 'artifact_grants'`).get() as { count: number }).count, 0);
  } finally {
    database.close();
  }
});

test('faithful committed schema v8 upgrades through v16', async () => {
  const fixtureSql = await readFile(new URL('./fixtures/native-agent-schema-v8.sql', import.meta.url), 'utf8');
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`PRAGMA foreign_keys = ON; ${fixtureSql}; PRAGMA user_version = 8;
      PRAGMA application_id = ${NATIVE_AGENT_APPLICATION_ID};`);
    database.prepare('INSERT INTO meta(key, value_json) VALUES (?, ?)')
      .run('schema_id', JSON.stringify(NATIVE_AGENT_SCHEMA_ID));
    database.exec('BEGIN IMMEDIATE');
    migrateNativeAgentSchema(database, 8);
    database.exec('COMMIT');
    validateNativeAgentSchema(database);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.ok(listNativeAgentTables(database).includes('artifact_grants'));
  } finally {
    database.close();
  }
});

test('faithful accepted schema v13 upgrades to the fresh v16 shape', async () => {
  const fixtureSql = await readFile(new URL('./fixtures/native-agent-schema-v13.sql', import.meta.url), 'utf8');
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`${fixtureSql}; PRAGMA user_version = 13;
      PRAGMA application_id = ${NATIVE_AGENT_APPLICATION_ID}; BEGIN IMMEDIATE;`);
    database.prepare('INSERT INTO meta(key, value_json) VALUES (?, ?)')
      .run('schema_id', JSON.stringify(NATIVE_AGENT_SCHEMA_ID));
    migrateNativeAgentSchema(database, 13);
    database.exec('COMMIT');
    validateNativeAgentSchema(database);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16);
    assert.ok(listNativeAgentTables(database).includes('federation_checkout_reservations'));
    assert.ok((database.prepare('PRAGMA table_info(executions)').all() as Array<{ name: string }>)
      .some(({ name }) => name === 'checkout_key'));
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    const fresh = new DatabaseSync(':memory:');
    createNativeAgentSchema(fresh);
    const reservationObjects = (db: DatabaseSync) => db.prepare(`SELECT type,name,
        replace(replace(sql,char(10),''),' ','') sql FROM sqlite_schema
      WHERE name='federation_checkout_reservations'
         OR name LIKE 'federation_checkout_reservations_%'
         OR name='executions_checkout_key_idx' ORDER BY type,name`).all().map((row) => ({ ...row }));
    assert.deepEqual(reservationObjects(database), reservationObjects(fresh));
    assert.deepEqual(database.prepare(`PRAGMA foreign_key_list(federation_checkout_reservations)`).all()
      .map((row) => ({ ...row })), fresh.prepare(`PRAGMA foreign_key_list(federation_checkout_reservations)`).all()
      .map((row) => ({ ...row })));
    fresh.close();
  } finally {
    database.close();
  }
});

test('schema v15 opener rolls back a mid-migration failure and reopens cleanly', async () => {
  const fixtureSql = await readFile(new URL('./fixtures/native-agent-schema-v13.sql', import.meta.url), 'utf8');
  const dataRoot = await mkdtemp(join(tmpdir(), 'remux-schema-v14-rollback-'));
  const path = join(dataRoot, 'agent.sqlite3');
  const seed = new DatabaseSync(path);
  try {
    seed.exec(`${fixtureSql}; PRAGMA user_version = 13;
      PRAGMA application_id = ${NATIVE_AGENT_APPLICATION_ID};
      CREATE TABLE federation_checkout_reservations(execution_id TEXT PRIMARY KEY) STRICT;`);
    seed.prepare('INSERT INTO meta(key, value_json) VALUES (?, ?)')
      .run('schema_id', JSON.stringify(NATIVE_AGENT_SCHEMA_ID));
  } finally {
    seed.close();
  }
  try {
    await assert.rejects(openNativeAgentJournal({ dataRoot }), /Version 14|checkout_key/u);
    const rolledBack = new DatabaseSync(path);
    try {
      assert.equal((rolledBack.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 13);
      assert.equal((rolledBack.prepare(`SELECT count(*) AS count FROM pragma_table_info('executions')
        WHERE name='checkout_key'`).get() as { count: number }).count, 0);
      rolledBack.exec('DROP TABLE federation_checkout_reservations');
    } finally {
      rolledBack.close();
    }
    const reopened = await openNativeAgentJournal({ dataRoot });
    assert.equal((reopened.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16);
    reopened.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('faithful schema v14 adds the exact fresh delivery objects', () => {
  const migrated = new DatabaseSync(':memory:');
  const fresh = new DatabaseSync(':memory:');
  try {
    createNativeAgentSchema(migrated);
    migrated.exec(`DROP TABLE delivery_attempt_staging;
      DROP INDEX delivery_attempts_execution;
      DROP INDEX delivery_attempts_lane;
      DROP TABLE delivery_attempts;
      PRAGMA user_version = 14;
      BEGIN IMMEDIATE;`);
    migrateNativeAgentSchema(migrated, 14);
    migrated.exec('COMMIT');
    createNativeAgentSchema(fresh);
    const objects = (database: DatabaseSync) => database.prepare(`SELECT type,name,
      replace(replace(sql,char(10),''),' ','') AS sql FROM sqlite_schema
      WHERE name IN ('delivery_attempts','delivery_attempts_lane',
        'delivery_attempts_execution','delivery_attempt_staging') ORDER BY type,name`).all()
      .map((row) => ({ ...row }));
    assert.deepEqual(objects(migrated), objects(fresh));
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_list(delivery_attempts)').all()
      .map((row) => ({ ...row })), fresh.prepare('PRAGMA foreign_key_list(delivery_attempts)').all()
      .map((row) => ({ ...row })));
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_list(delivery_attempt_staging)').all()
      .map((row) => ({ ...row })), fresh.prepare('PRAGMA foreign_key_list(delivery_attempt_staging)').all()
      .map((row) => ({ ...row })));
  } finally {
    migrated.close();
    fresh.close();
  }
});

test('schema v15 migration rejects and rolls back a conflicting delivery object', () => {
  const database = new DatabaseSync(':memory:');
  try {
    createNativeAgentSchema(database);
    database.exec(`DROP TABLE delivery_attempt_staging;
      DROP INDEX delivery_attempts_execution;
      DROP INDEX delivery_attempts_lane;
      DROP TABLE delivery_attempts;
      CREATE TABLE delivery_attempts(attempt_id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 14;
      BEGIN IMMEDIATE;`);
    assert.throws(() => migrateNativeAgentSchema(database, 14), /conflicting preexisting object/u);
    database.exec('ROLLBACK');
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 14);
    assert.deepEqual((database.prepare('PRAGMA table_info(delivery_attempts)').all() as Array<{ name: string }>)
      .map(({ name }) => name), ['attempt_id']);
  } finally {
    database.close();
  }
});

test('schema v16 migration rejects a malformed future Stop owner table before stamping', () => {
  const database = new DatabaseSync(':memory:');
  try {
    createNativeAgentSchema(database);
    database.exec(`DROP INDEX stop_intents_outstanding_scope;
      DROP TABLE stop_intent_targets;
      DROP TABLE stop_intents;
      CREATE TABLE stop_intents(intent_id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 15;
      BEGIN IMMEDIATE;`);
    assert.throws(() => migrateNativeAgentSchema(database, 15), /conflicting preexisting object/u);
    database.exec('ROLLBACK');
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 15);
  } finally {
    database.close();
  }
});

test('schema v15 opener preserves a v14 database after a delivery-object collision', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'remux-schema-v15-delivery-rollback-'));
  const path = join(dataRoot, 'agent.sqlite3');
  const seed = new DatabaseSync(path);
  try {
    createNativeAgentSchema(seed);
    seed.exec(`DROP TABLE delivery_attempt_staging;
      DROP INDEX delivery_attempts_execution;
      DROP INDEX delivery_attempts_lane;
      DROP TABLE delivery_attempts;
      CREATE TABLE delivery_attempts(attempt_id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 14;`);
    seed.prepare('INSERT OR REPLACE INTO meta(key,value_json) VALUES(?,?)')
      .run('rollback-sentinel', JSON.stringify('preserved'));
  } finally {
    seed.close();
  }
  try {
    await assert.rejects(openNativeAgentJournal({ dataRoot }), /conflicting preexisting object/u);
    const rolledBack = new DatabaseSync(path);
    try {
      assert.equal((rolledBack.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 14);
      assert.equal((rolledBack.prepare(`SELECT value_json FROM meta WHERE key='rollback-sentinel'`)
        .get() as { value_json: string }).value_json, JSON.stringify('preserved'));
      assert.deepEqual((rolledBack.prepare('PRAGMA table_info(delivery_attempts)').all() as
        Array<{ name: string }>).map(({ name }) => name), ['attempt_id']);
      rolledBack.exec('DROP TABLE delivery_attempts');
    } finally {
      rolledBack.close();
    }
    const reopened = await openNativeAgentJournal({ dataRoot });
    assert.equal((reopened.database.prepare('PRAGMA user_version').get() as
      { user_version: number }).user_version, 16);
    reopened.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('an older source cannot smuggle a malformed future delivery table through migration', () => {
  const database = new DatabaseSync(':memory:');
  try {
    createNativeAgentSchema(database);
    database.exec(`DROP TABLE delivery_attempt_staging;
      DROP INDEX delivery_attempts_execution;
      DROP INDEX delivery_attempts_lane;
      DROP TABLE delivery_attempts;
      CREATE TABLE delivery_attempts(attempt_id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 13;
      BEGIN IMMEDIATE;`);
    assert.throws(() => migrateNativeAgentSchema(database, 13), /conflicting preexisting object/u);
    database.exec('ROLLBACK');
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 13);
  } finally {
    database.close();
  }
});
