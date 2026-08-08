import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  conversationResourceKey,
  type ConversationListValue,
  type ConversationSummary,
} from '../shared/protocol.ts';
import {
  AGENT_TRANSCRIPT_PROJECTION_VERSION,
  AGENT_TRANSCRIPT_PROTOCOL_VERSION,
} from '../shared/transcript.ts';
import { canonicalJson } from '../server/src/storage/canonical-json.ts';
import { ArtifactIntegrityError } from '../server/src/storage/artifact-store.ts';
import { openAgentDatabase, AgentSchemaVersionError } from '../server/src/storage/database.ts';
import { resolveAgentDataRoot } from '../server/src/storage/data-root.ts';
import {
  AgentJournalRepository,
  OperationConflictError,
} from '../server/src/storage/repository.ts';
import { AGENT_JOURNAL_TABLES, AgentSchemaError } from '../server/src/storage/schema.ts';

const RECORDED_AT = 1_700_000_000_000;

test('Agent data-root resolution follows explicit, environment, XDG, and home precedence', () => {
  assert.equal(
    resolveAgentDataRoot({ dataRoot: '/explicit', env: { REMUX_AGENT_DATA_DIR: '/ignored' } }),
    resolve('/explicit'),
  );
  assert.equal(
    resolveAgentDataRoot({ env: { REMUX_AGENT_DATA_DIR: '/environment', XDG_DATA_HOME: '/xdg' } }),
    resolve('/environment'),
  );
  assert.equal(
    resolveAgentDataRoot({ env: { REMUX_AGENT_DATA_DIR: '', XDG_DATA_HOME: '/xdg' } }),
    resolve('/xdg/remux/agent'),
  );
  assert.equal(
    resolveAgentDataRoot({ env: {}, homeDirectory: '/owner' }),
    '/owner/.local/share/remux/agent',
  );
});

test('clean storage creates and validates schema v2, pragmas, and private modes', async (t) => {
  const fixture = await storageFixture(t, 'create');
  await mkdir(fixture.dataRoot, { recursive: true, mode: 0o777 });
  await chmod(fixture.dataRoot, 0o777);
  const databasePath = join(fixture.dataRoot, 'agent.sqlite3');
  await writeFile(databasePath, '');
  await chmod(databasePath, 0o666);

  const storage = await openAgentDatabase({ dataRoot: fixture.dataRoot });
  assert.deepEqual(storage.diagnostics(), {
    userVersion: 2,
    journalMode: 'wal',
    foreignKeys: 1,
    synchronous: 2,
    busyTimeout: 5_000,
  });
  assert.deepEqual(userTables(storage.database), [...AGENT_JOURNAL_TABLES].sort());
  assert.equal(indexNames(storage.database).includes('transcript_items_by_turn_sequence'), true);
  assert.equal(await mode(fixture.dataRoot), 0o700);
  assert.equal(await mode(databasePath), 0o600);
  assert.equal(await mode(`${databasePath}-wal`), 0o600);
  assert.equal(await mode(`${databasePath}-shm`), 0o600);
  storage.close();

  const reopened = await openAgentDatabase({ dataRoot: fixture.dataRoot });
  assert.equal(reopened.diagnostics().userVersion, 2);
  assert.deepEqual(userTables(reopened.database), [...AGENT_JOURNAL_TABLES].sort());
  reopened.close();
});

test('a newer schema is refused before WAL or schema mutation', async (t) => {
  const fixture = await storageFixture(t, 'newer');
  await mkdir(fixture.dataRoot, { recursive: true });
  const databasePath = join(fixture.dataRoot, 'agent.sqlite3');
  const newer = new DatabaseSync(databasePath);
  newer.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE sentinel (value TEXT NOT NULL);
    INSERT INTO sentinel (value) VALUES ('preserve-me');
    PRAGMA user_version = 3;
  `);
  newer.close();

  await assert.rejects(
    () => openAgentDatabase({ dataRoot: fixture.dataRoot }),
    AgentSchemaVersionError,
  );
  const inspector = new DatabaseSync(databasePath);
  assert.equal(pragmaNumber(inspector, 'user_version'), 3);
  assert.equal(pragmaString(inspector, 'journal_mode'), 'delete');
  assert.equal(
    (inspector.prepare('SELECT value FROM sentinel').get() as { value: string }).value,
    'preserve-me',
  );
  assert.deepEqual(userTables(inspector), ['sentinel']);
  inspector.close();
});

test('an unversioned partial schema and a malformed v1 schema fail closed', async (t) => {
  const partial = await storageFixture(t, 'partial');
  await mkdir(partial.dataRoot, { recursive: true });
  const partialPath = join(partial.dataRoot, 'agent.sqlite3');
  const partialDb = new DatabaseSync(partialPath);
  partialDb.exec('CREATE TABLE conversations (conversation_id TEXT)');
  partialDb.close();
  await assert.rejects(() => openAgentDatabase({ dataRoot: partial.dataRoot }), AgentSchemaError);

  const malformed = await storageFixture(t, 'malformed');
  await mkdir(malformed.dataRoot, { recursive: true });
  const malformedPath = join(malformed.dataRoot, 'agent.sqlite3');
  const malformedDb = new DatabaseSync(malformedPath);
  malformedDb.exec('CREATE TABLE meta (key TEXT); PRAGMA user_version = 1;');
  malformedDb.close();
  await assert.rejects(() => openAgentDatabase({ dataRoot: malformed.dataRoot }), AgentSchemaError);
});

test('schema v2 refuses a lookalike with altered indexes', async (t) => {
  const fixture = await storageFixture(t, 'lookalike');
  const storage = await openAgentDatabase({ dataRoot: fixture.dataRoot });
  storage.close();

  const lookalike = new DatabaseSync(join(fixture.dataRoot, 'agent.sqlite3'));
  lookalike.exec(`
    DROP INDEX events_by_operation_sequence;
    CREATE INDEX events_by_operation_sequence ON events(sequence);
  `);
  lookalike.close();

  await assert.rejects(
    () => openAgentDatabase({ dataRoot: fixture.dataRoot }),
    /schema structure does not match version 2/u,
  );
});

test('an exact schema v1 database migrates in place without losing conversations', async (t) => {
  const fixture = await storageFixture(t, 'migrate-v1');
  const repository = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  const created = await repository.createConversation({
    operationId: testUuid(9_001),
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  await repository.close();

  const databasePath = join(fixture.dataRoot, 'agent.sqlite3');
  const versionOne = new DatabaseSync(databasePath);
  versionOne.exec('DROP INDEX transcript_items_by_turn_sequence');
  versionOne.prepare('UPDATE meta SET value_json = ? WHERE key = ?').run(
    canonicalJson('agent-journal-v1'),
    'journal_schema',
  );
  versionOne.exec('PRAGMA user_version = 1');
  versionOne.close();

  const migrated = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  assert.equal(migrated.diagnostics().userVersion, 2);
  const inspector = new DatabaseSync(migrated.databasePath, { readOnly: true });
  assert.equal(
    indexNames(inspector).includes('transcript_items_by_turn_sequence'),
    true,
  );
  inspector.close();
  const [summary] = await migrated.readResourceProjections([
    conversationResourceKey(created.conversationId),
  ]);
  assert.equal((summary?.value as ConversationSummary).id, created.conversationId);
  await migrated.close();
});

test('database and WAL sidecar symlinks are rejected without touching their targets', async (t) => {
  const fixture = await storageFixture(t, 'symlink');
  await mkdir(fixture.dataRoot, { recursive: true });
  const databasePath = join(fixture.dataRoot, 'agent.sqlite3');
  const outside = join(fixture.root, 'outside');
  await writeFile(outside, 'preserve-me');
  await chmod(outside, 0o666);
  await symlink(outside, databasePath);

  await assert.rejects(
    () => openAgentDatabase({ dataRoot: fixture.dataRoot }),
    /not a regular file/u,
  );
  assert.equal(await readFile(outside, 'utf8'), 'preserve-me');
  assert.equal(await mode(outside), 0o666);

  await rm(databasePath);
  await writeFile(databasePath, '');
  await symlink(outside, `${databasePath}-wal`);
  await assert.rejects(
    () => openAgentDatabase({ dataRoot: fixture.dataRoot }),
    /not a regular file/u,
  );
  assert.equal(await readFile(outside, 'utf8'), 'preserve-me');
  assert.equal(await mode(outside), 0o666);
});

test('conversation creation commits one replayable semantic event group', async (t) => {
  const fixture = await storageFixture(t, 'trace');
  const ids = deterministicIds();
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: ids.next,
    now: () => RECORDED_AT,
  });
  t.after(() => repository.close());
  const operationId = '10000000-0000-4000-8000-000000000001';
  const params = {
    operationId,
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high' as const,
  };
  const created = await repository.createConversation(params);
  assert.equal(created.replayed, false);
  assert.equal(created.basisSequence, 4);

  const events = await repository.readEvents();
  assert.deepEqual(events.map((event) => event.type), [
    'operation.accepted',
    'project.created',
    'conversation.created',
    'operation.succeeded',
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.ok(events.every((event) =>
    event.actor === 'harness' &&
    event.visibility === 'internal' &&
    event.projectId === created.projectId &&
    event.operationId === operationId &&
    event.createdAt === RECORDED_AT));
  assert.deepEqual(events[1]?.payload, {
    projectId: created.projectId,
    revision: 0,
    rootPath: fixture.workspace,
    rootSpaceId: created.rootSpaceId,
    state: 'active',
    title: 'workspace',
  });
  assert.deepEqual(events[2]?.payload, {
    conversationId: created.conversationId,
    cwd: fixture.workspace,
    forkedFromSequence: null,
    headStrandId: created.rootStrandId,
    modelId: 'gpt-5.4',
    parentStrandId: null,
    projectId: created.projectId,
    reasoning: 'high',
    rootSpaceId: created.rootSpaceId,
    state: 'idle',
    strandState: 'active',
    title: 'New conversation',
  });
  const inspector = new DatabaseSync(repository.databasePath);
  assert.deepEqual(rowCounts(inspector), {
    projects: 1,
    context_spaces: 1,
    project_primaries: 0,
    context_bindings: 0,
    project_relations: 0,
    conversations: 1,
    strands: 1,
    turns: 0,
    execution_scopes: 0,
    events: 4,
    operations: 1,
    epochs: 0,
    transcript_items: 0,
    resources: 2,
    artifacts: 0,
    epoch_blocks: 0,
    inferences: 0,
  });
  const operation = inspector.prepare(`
    SELECT state, accepted_sequence, terminal_sequence, value_json
    FROM operations WHERE operation_id = ?
  `).get(operationId) as {
    state: string;
    accepted_sequence: number;
    terminal_sequence: number;
    value_json: string;
  };
  assert.equal(operation.state, 'succeeded');
  assert.equal(operation.accepted_sequence, 1);
  assert.equal(operation.terminal_sequence, 4);
  assert.equal(operation.value_json, canonicalJson({
    accepted: true,
    conversationId: created.conversationId,
    operationId,
    projectId: created.projectId,
    rootSpaceId: created.rootSpaceId,
  }));
  assert.deepEqual({ ...inspector.prepare(`
    SELECT project_id, root_path, root_space_id, revision, state,
           created_sequence, updated_sequence
    FROM projects
  `).get() }, {
    project_id: created.projectId,
    root_path: fixture.workspace,
    root_space_id: created.rootSpaceId,
    revision: 0,
    state: 'active',
    created_sequence: 2,
    updated_sequence: 2,
  });
  assert.deepEqual({ ...inspector.prepare(`
    SELECT space_id, project_id, parent_space_id, key, descriptor_json,
           created_revision, created_sequence
    FROM context_spaces
  `).get() }, {
    space_id: created.rootSpaceId,
    project_id: created.projectId,
    parent_space_id: null,
    key: 'root',
    descriptor_json: canonicalJson({ rootPath: fixture.workspace, title: 'workspace' }),
    created_revision: 0,
    created_sequence: 2,
  });
  inspector.close();

  const replay = await repository.createConversation(params);
  assert.deepEqual(replay, { ...created, replayed: true });
  assert.equal(await repository.journalHead(), 4);

  const forkedHead = '90000000-0000-4000-8000-000000000009';
  const mutator = new DatabaseSync(repository.databasePath);
  mutator.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
  mutator.prepare(`
    INSERT INTO strands (
      strand_id, conversation_id, parent_strand_id, forked_from_sequence,
      state, created_at
    ) VALUES (?, ?, ?, 4, 'active', ?)
  `).run(forkedHead, created.conversationId, created.rootStrandId, RECORDED_AT + 1);
  mutator.prepare(`
    UPDATE conversations
    SET head_strand_id = ?, updated_at = ?
    WHERE conversation_id = ?
  `).run(forkedHead, RECORDED_AT + 1, created.conversationId);
  mutator.exec('COMMIT');
  mutator.close();
  assert.deepEqual(
    await repository.createConversation(params),
    { ...created, replayed: true },
  );
  await repository.close();

  const reopened = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  const reopenedReplay = await reopened.createConversation(params);
  assert.deepEqual(reopenedReplay, { ...created, replayed: true });
  assert.equal((await reopened.readEvents()).length, 4);
  await assert.rejects(
    () => reopened.createConversation({ ...params, reasoning: 'xhigh' }),
    OperationConflictError,
  );
  assert.equal(await reopened.journalHead(), 4);
  const firstClose = reopened.close();
  const secondClose = reopened.close();
  assert.strictEqual(secondClose, firstClose);
  await Promise.all([firstClose, secondClose]);
});

test('a direct turn owns one root execution scope and scope-local epoch', async (t) => {
  const fixture = await storageFixture(t, 'root-scope');
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: deterministicIds().next,
    now: () => RECORDED_AT,
  });
  const created = await repository.createConversation({
    operationId: '50000000-0000-4000-8000-000000000005',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });

  const database = new DatabaseSync(repository.databasePath);
  database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
  const turnId = '60000000-0000-4000-8000-000000000006';
  const scopeId = '70000000-0000-4000-8000-000000000007';
  const epochId = '80000000-0000-4000-8000-000000000008';
  const operationId = '90000000-0000-4000-8000-000000000009';
  const clientMessageId = 'a0000000-0000-4000-8000-00000000000a';
  const insertEvent = database.prepare(`
    INSERT INTO events (
      event_id, project_id, conversation_id, strand_id, turn_id, scope_id,
      type, actor, visibility, causal_event_id, operation_id, payload_json,
      artifact_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'harness', 'internal', NULL, ?, ?, NULL, ?)
    RETURNING sequence
  `);
  const event = (id: string, type: string, payload: unknown) =>
    (insertEvent.get(
      id,
      created.projectId,
      created.conversationId,
      created.rootStrandId,
      turnId,
      scopeId,
      type,
      operationId,
      canonicalJson(payload),
      RECORDED_AT + 1,
    ) as { sequence: number }).sequence;
  const acceptedOperationSequence = event(
    'b0000000-0000-4000-8000-00000000000b',
    'operation.accepted',
    { kind: 'message.send' },
  );
  const acceptedTurnSequence = event(
    'c0000000-0000-4000-8000-00000000000c',
    'turn.accepted',
    { clientMessageId, rootScopeId: scopeId, turnId },
  );
  const scopeSequence = event(
    'd0000000-0000-4000-8000-00000000000d',
    'execution_scope.created',
    { kind: 'turn', parentScopeId: null, scopeId, turnId },
  );
  const epochSequence = event(
    'e0000000-0000-4000-8000-00000000000e',
    'epoch.opened',
    { epochId, mode: 'full_replay', ordinal: 0, scopeId },
  );
  const terminalOperationSequence = event(
    'f0000000-0000-4000-8000-00000000000f',
    'operation.succeeded',
    { kind: 'message.send', result: { turnId } },
  );

  database.prepare(`
    INSERT INTO turns (
      turn_id, project_id, conversation_id, strand_id, client_message_id,
      root_scope_id, mode, state, accepted_sequence, terminal_sequence,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'implement', 'running', ?, NULL, ?, ?)
  `).run(
    turnId,
    created.projectId,
    created.conversationId,
    created.rootStrandId,
    clientMessageId,
    scopeId,
    acceptedTurnSequence,
    RECORDED_AT + 1,
    RECORDED_AT + 1,
  );
  database.prepare(`
    INSERT INTO execution_scopes (
      scope_id, project_id, conversation_id, strand_id, turn_id,
      parent_scope_id, kind, objective_json, state, created_sequence,
      terminal_sequence, result_artifact_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'turn', ?, 'running', ?, NULL, NULL, ?, ?)
  `).run(
    scopeId,
    created.projectId,
    created.conversationId,
    created.rootStrandId,
    turnId,
    canonicalJson({ intent: 'Serve the accepted user turn.' }),
    scopeSequence,
    RECORDED_AT + 1,
    RECORDED_AT + 1,
  );
  database.prepare(`
    INSERT INTO epochs (
      epoch_id, project_id, conversation_id, strand_id, turn_id, scope_id,
      ordinal, state, policy_version, opened_sequence, closed_sequence,
      close_reason, bootstrap_artifact_hash, basis_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 'open', 'agent-full-replay-v1', ?, NULL, NULL, NULL, ?)
  `).run(
    epochId,
    created.projectId,
    created.conversationId,
    created.rootStrandId,
    turnId,
    scopeId,
    epochSequence,
    scopeSequence,
  );
  database.prepare(`
    INSERT INTO operations (
      operation_id, project_id, conversation_id, strand_id, turn_id, scope_id,
      kind, arguments_hash, state, accepted_sequence, terminal_sequence,
      result_artifact_hash, value_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'message.send', ?, 'succeeded', ?, ?, NULL, ?)
  `).run(
    operationId,
    created.projectId,
    created.conversationId,
    created.rootStrandId,
    turnId,
    scopeId,
    '0'.repeat(64),
    acceptedOperationSequence,
    terminalOperationSequence,
    canonicalJson({ accepted: true, turnId }),
  );
  database.exec('COMMIT');

  assert.deepEqual({ ...database.prepare(`
    SELECT t.turn_id, t.root_scope_id, s.parent_scope_id, s.kind,
           e.scope_id AS epoch_scope_id, e.ordinal
    FROM turns t
    JOIN execution_scopes s ON s.scope_id = t.root_scope_id
    JOIN epochs e ON e.scope_id = s.scope_id
  `).get() }, {
    turn_id: turnId,
    root_scope_id: scopeId,
    parent_scope_id: null,
    kind: 'turn',
    epoch_scope_id: scopeId,
    ordinal: 0,
  });
  assert.throws(() => database.prepare(`
    INSERT INTO epochs (
      epoch_id, project_id, conversation_id, strand_id, turn_id, scope_id,
      ordinal, state, policy_version, opened_sequence, closed_sequence,
      close_reason, bootstrap_artifact_hash, basis_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 'open', 'agent-full-replay-v1', ?, NULL, NULL, NULL, ?)
  `).run(
    '10000000-0000-4000-8000-000000000010',
    created.projectId,
    created.conversationId,
    created.rootStrandId,
    turnId,
    scopeId,
    epochSequence,
    scopeSequence,
  ), /UNIQUE constraint failed/u);
  database.close();
  await repository.close();
});

test('conversations at one canonical workspace share one durable project root', async (t) => {
  const fixture = await storageFixture(t, 'shared-project');
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: deterministicIds().next,
    now: () => RECORDED_AT,
  });
  const first = await repository.createConversation({
    operationId: '11000000-0000-4000-8000-000000000011',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  const second = await repository.createConversation({
    operationId: '12000000-0000-4000-8000-000000000012',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'medium',
  });
  assert.equal(second.projectId, first.projectId);
  assert.equal(second.rootSpaceId, first.rootSpaceId);
  assert.notEqual(second.conversationId, first.conversationId);
  assert.notEqual(second.rootStrandId, first.rootStrandId);
  assert.deepEqual((await repository.readEvents()).map(({ type }) => type), [
    'operation.accepted',
    'project.created',
    'conversation.created',
    'operation.succeeded',
    'operation.accepted',
    'conversation.created',
    'operation.succeeded',
  ]);
  const database = new DatabaseSync(repository.databasePath);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count, 1);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM context_spaces').get() as { count: number }).count, 1);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM conversations').get() as { count: number }).count, 2);
  database.close();
  await repository.close();
});

test('project spaces, primaries, bindings, and relations persist as canonical projections', async (t) => {
  const fixture = await storageFixture(t, 'project-projections');
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: deterministicIds().next,
    now: () => RECORDED_AT,
  });
  const created = await repository.createConversation({
    operationId: '13000000-0000-4000-8000-000000000013',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  const database = new DatabaseSync(repository.databasePath);
  database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
  const sequence = (database.prepare(`
    INSERT INTO events (
      event_id, project_id, conversation_id, strand_id, turn_id, scope_id,
      type, actor, visibility, causal_event_id, operation_id, payload_json,
      artifact_hash, created_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, 'project.state.updated', 'harness',
              'internal', NULL, NULL, ?, NULL, ?)
    RETURNING sequence
  `).get(
    '14000000-0000-4000-8000-000000000014',
    created.projectId,
    created.conversationId,
    created.rootStrandId,
    canonicalJson({ basisRevision: 0, operationId: 'operation:seed', revision: 1 }),
    RECORDED_AT + 1,
  ) as { sequence: number }).sequence;
  const spaceId = 'space:harness';
  const primaryId = 'primary:architecture';
  database.prepare(`
    INSERT INTO context_spaces (
      space_id, project_id, parent_space_id, key, descriptor_json,
      created_revision, created_sequence
    ) VALUES (?, ?, ?, 'harness', ?, 1, ?)
  `).run(spaceId, created.projectId, created.rootSpaceId, canonicalJson({ title: 'Harness' }), sequence);
  database.prepare(`
    INSERT INTO project_primaries (
      primary_id, project_id, home_space_id, key, kind, descriptor_json,
      body_json, authority, provenance_json, lifecycle, superseded_by,
      version, created_revision, updated_revision, created_sequence,
      updated_sequence
    ) VALUES (?, ?, ?, 'architecture', 'model', ?, ?, 'user', ?, 'active',
              NULL, 1, 1, 1, ?, ?)
  `).run(
    primaryId,
    created.projectId,
    spaceId,
    canonicalJson({ title: 'Harness architecture' }),
    canonicalJson({ text: 'Journal evidence feeds layered project context.' }),
    canonicalJson(['journal:event-design-accepted']),
    sequence,
    sequence,
  );
  database.prepare(`
    INSERT INTO context_bindings (
      space_id, primary_id, project_id, mode, provenance_json, version,
      created_revision, updated_revision, created_sequence, updated_sequence
    ) VALUES (?, ?, ?, 'inline', ?, 1, 1, 1, ?, ?)
  `).run(
    spaceId,
    primaryId,
    created.projectId,
    canonicalJson(['journal:event-design-accepted']),
    sequence,
    sequence,
  );
  database.prepare(`
    INSERT INTO project_relations (
      relation_id, project_id, from_type, from_id, predicate, to_type, to_id,
      attributes_json, provenance_json, version, created_revision,
      created_sequence
    ) VALUES ('relation:architecture-home', ?, 'primary', ?, 'belongs-to',
              'space', ?, ?, ?, 1, 1, ?)
  `).run(
    created.projectId,
    primaryId,
    spaceId,
    canonicalJson({ reason: 'Scoped harness context.' }),
    canonicalJson(['journal:event-design-accepted']),
    sequence,
  );
  database.prepare(`
    UPDATE projects
    SET revision = 1, updated_sequence = ?, updated_at = ?
    WHERE project_id = ?
  `).run(sequence, RECORDED_AT + 1, created.projectId);
  database.exec('COMMIT');
  database.close();
  await repository.close();

  const reopened = await openAgentDatabase({ dataRoot: fixture.dataRoot });
  assert.deepEqual({ ...reopened.database.prepare(`
    SELECT p.revision, s.parent_space_id, r.authority, r.lifecycle, b.mode,
           rel.predicate
    FROM projects p
    JOIN context_spaces s ON s.project_id = p.project_id AND s.space_id = ?
    JOIN project_primaries r ON r.project_id = p.project_id
    JOIN context_bindings b ON b.project_id = p.project_id
    JOIN project_relations rel ON rel.project_id = p.project_id
  `).get(spaceId) }, {
    revision: 1,
    parent_space_id: created.rootSpaceId,
    authority: 'user',
    lifecycle: 'active',
    mode: 'inline',
    predicate: 'belongs-to',
  });
  reopened.close();
});

test('a live turn journals admission, inference, tool, transcript, and terminal boundaries', async (t) => {
  const fixture = await storageFixture(t, 'live-turn');
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: deterministicIds().next,
    now: () => RECORDED_AT,
  });
  const conversation = await repository.createConversation({
    operationId: '21000000-0000-4000-8000-000000000021',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  const messageOperationId = testUuid(10_001);
  const clientMessageId = testUuid(10_002);
  assert.equal(await repository.reconcileTurn({
    operationId: messageOperationId,
    conversationId: conversation.conversationId,
    clientMessageId,
    text: 'Preserve this exact message.\n',
  }), null);
  const accepted = await repository.acceptTurn({
    operationId: messageOperationId,
    conversationId: conversation.conversationId,
    clientMessageId,
    text: 'Preserve this exact message.\n',
  });
  assert.equal(accepted.replayed, false);
  assert.deepEqual((await repository.readEvents({ conversationId: conversation.conversationId }))
    .slice(4).map(({ type }) => type), [
    'operation.accepted',
    'turn.accepted',
    'execution_scope.created',
    'epoch.opened',
    'message.user',
    'turn.started',
    'operation.succeeded',
  ]);

  const dispatchContext = await repository.compileContext(conversation.conversationId);
  await repository.startInference(accepted, {
    payload: { messages: [{ content: 'Preserve this exact message.\n', role: 'user' }] },
    requestMode: 'full',
    estimatedInputTokens: 9,
    context: {
      basisSequence: dispatchContext.basisSequence,
      logicalHash: dispatchContext.logicalHash,
      renderedHash: 'rendered-context-fixture',
      messageCount: dispatchContext.messages.length,
    },
  });
  await repository.appendAssistantCheckpoint(accepted, {
    reasoningDelta: 'Inspect the workspace. ',
    textDelta: 'I will check. ',
  });
  await repository.finishInference(accepted, { state: 'completed' });
  await repository.recordToolStarted(accepted, {
    callId: 'call:readme',
    name: 'workspace.read',
    args: { path: 'README.md' },
  });
  await repository.recordToolFinished(accepted, {
    callId: 'call:readme',
    result: { path: 'README.md', text: 'hello' },
    isError: false,
  });
  await repository.appendAssistantCheckpoint(accepted, {
    reasoningDelta: '',
    textDelta: 'Done.',
  });
  assert.ok(await repository.finishTurn(accepted, { status: 'completed' }));
  assert.equal(await repository.finishTurn(accepted, { status: 'completed' }), null);

  assert.deepEqual(await repository.readTranscriptActions(conversation.conversationId), [
    {
      type: 'turn',
      turnId: accepted.turnId,
      clientMessageId,
      text: 'Preserve this exact message.\n',
    },
    {
      type: 'assistant',
      turnId: accepted.turnId,
      reasoningDelta: 'Inspect the workspace. ',
      textDelta: 'I will check. ',
    },
    {
      type: 'tool-start',
      turnId: accepted.turnId,
      callId: 'call:readme',
      name: 'workspace.read',
      args: { path: 'README.md' },
    },
    {
      type: 'tool-end',
      turnId: accepted.turnId,
      callId: 'call:readme',
      result: { path: 'README.md', text: 'hello' },
      isError: false,
    },
    {
      type: 'assistant',
      turnId: accepted.turnId,
      reasoningDelta: '',
      textDelta: 'Done.',
    },
    { type: 'terminal', turnId: accepted.turnId, status: 'completed', error: null, durationMs: 0 },
  ]);

  const context = await repository.compileContext(conversation.conversationId);
  assert.deepEqual(context.messages.map((message) => message.role), [
    'user', 'assistant', 'tool', 'assistant',
  ]);
  assert.deepEqual(context.messages[1], {
    role: 'assistant',
    turnId: accepted.turnId,
    text: 'I will check. ',
    reasoning: 'Inspect the workspace. ',
    toolCalls: [{
      callId: 'call:readme',
      name: 'workspace.read',
      args: { path: 'README.md' },
    }],
    state: 'completed',
    timestamp: RECORDED_AT,
  });
  assert.match(context.logicalHash, /^[a-f0-9]{64}$/u);
  assert.equal(context.orderedMessageHashes.length, 4);
  const inferenceStarted = (await repository.readEvents({ conversationId: conversation.conversationId }))
    .find((event) => event.type === 'inference.started');
  assert.ok(inferenceStarted?.payload && typeof inferenceStarted.payload === 'object');
  assert.deepEqual(
    Object.fromEntries(Object.entries(inferenceStarted.payload).filter(([key]) => key.startsWith('context'))),
    {
      contextLogicalHash: dispatchContext.logicalHash,
      contextMessageCount: 1,
      contextRenderedHash: 'rendered-context-fixture',
    },
  );

  const replay = await repository.acceptTurn({
    operationId: messageOperationId,
    conversationId: conversation.conversationId,
    clientMessageId,
    text: 'Preserve this exact message.\n',
  });
  assert.deepEqual(replay, { ...accepted, replayed: true });
  assert.deepEqual(await repository.reconcileTurn({
    operationId: messageOperationId,
    conversationId: conversation.conversationId,
    clientMessageId,
    text: 'Preserve this exact message.\n',
  }), { ...accepted, replayed: true });
  await assert.rejects(() => repository.reconcileTurn({
    operationId: messageOperationId,
    conversationId: conversation.conversationId,
    clientMessageId,
    text: 'Different content.',
  }), /different arguments/u);
  await assert.rejects(() => repository.acceptTurn({
    operationId: testUuid(10_013),
    conversationId: conversation.conversationId,
    clientMessageId,
    text: 'Different content.',
  }), /different content/u);

  const database = new DatabaseSync(repository.databasePath);
  assert.deepEqual({ ...database.prepare(`
    SELECT t.state AS turn_state, s.state AS scope_state, e.state AS epoch_state,
           i.state AS inference_state, c.state AS conversation_state
    FROM turns t
    JOIN execution_scopes s ON s.scope_id = t.root_scope_id
    JOIN epochs e ON e.scope_id = s.scope_id
    JOIN inferences i ON i.epoch_id = e.epoch_id
    JOIN conversations c ON c.conversation_id = t.conversation_id
    WHERE t.turn_id = ?
  `).get(accepted.turnId) }, {
    turn_state: 'completed',
    scope_state: 'completed',
    epoch_state: 'closed',
    inference_state: 'completed',
    conversation_state: 'idle',
  });
  database.close();
  await repository.close();

  const reopened = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  assert.deepEqual(await reopened.compileContext(conversation.conversationId), context);
  await reopened.close();
});

test('provider preflight refuses a context compiled from a stale journal basis', async (t) => {
  const fixture = await storageFixture(t, 'stale-context-basis');
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: deterministicIds().next,
    now: () => RECORDED_AT,
  });
  t.after(() => repository.close());
  const conversation = await repository.createConversation({
    operationId: '23000000-0000-4000-8000-000000000023',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  const accepted = await repository.acceptTurn({
    operationId: testUuid(10_003),
    conversationId: conversation.conversationId,
    clientMessageId: testUuid(10_004),
    text: 'Compile me once.',
  });
  const stale = await repository.compileContext(conversation.conversationId);
  await repository.appendAssistantCheckpoint(accepted, {
    textDelta: 'A later committed boundary.',
    reasoningDelta: '',
  });

  await assert.rejects(() => repository.startInference(accepted, {
    payload: { input: 'must not dispatch' },
    requestMode: 'full',
    estimatedInputTokens: 10,
    context: {
      basisSequence: stale.basisSequence,
      logicalHash: stale.logicalHash,
      renderedHash: stale.logicalHash,
      messageCount: stale.messages.length,
    },
  }), /context basis .* is stale/u);
  assert.equal(
    (await repository.readEvents({ conversationId: conversation.conversationId }))
      .some((event) => event.type === 'inference.started'),
    false,
  );
  await repository.finishTurn(accepted, { status: 'failed', error: 'stale context rejected' });
  await repository.close();
});

test('large exact messages verify on first use per repository generation', async (t) => {
  const fixture = await storageFixture(t, 'large-message');
  const repository = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  const conversation = await repository.createConversation({
    operationId: '22000000-0000-4000-8000-000000000022',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  const text = `leading whitespace is exact\n${'ledger-context-'.repeat(6_000)}\n`;
  const accepted = await repository.acceptTurn({
    operationId: testUuid(10_005),
    conversationId: conversation.conversationId,
    clientMessageId: testUuid(10_006),
    text,
  });
  await repository.finishTurn(accepted, { status: 'completed' });
  const database = new DatabaseSync(repository.databasePath);
  const artifact = database.prepare(`
    SELECT hash, byte_length, storage_path FROM artifacts
    WHERE media_type = 'text/plain; charset=utf-8'
  `).get() as { hash: string; byte_length: number; storage_path: string };
  database.close();
  assert.equal(artifact.byte_length, Buffer.byteLength(text));
  assert.equal(
    await readFile(join(fixture.dataRoot, 'artifacts', artifact.storage_path), 'utf8'),
    text,
  );
  assert.equal((await repository.readTranscriptActions(conversation.conversationId))[0]?.type, 'turn');
  const turn = (await repository.readTranscriptActions(conversation.conversationId))[0];
  assert.ok(turn?.type === 'turn');
  assert.equal(turn.text, text);
  await repository.close();
  await writeFile(
    join(fixture.dataRoot, 'artifacts', artifact.storage_path),
    Buffer.alloc(artifact.byte_length, 0x78),
  );
  const reopened = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  await assert.rejects(
    () => reopened.readArtifact(artifact.hash),
    (error) => error instanceof ArtifactIntegrityError && error.reason === 'hash',
  );
  await assert.rejects(
    () => reopened.scrubArtifacts(),
    (error) => error instanceof ArtifactIntegrityError && error.reason === 'hash',
  );
  await reopened.close();
});

test('assistant checkpoints stay compact and terminal projection promotes exact aggregates', async (t) => {
  const fixture = await storageFixture(t, 'assistant-projection');
  const repository = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  const conversation = await repository.createConversation({
    operationId: testUuid(10_050),
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  const turn = await repository.acceptTurn({
    operationId: testUuid(10_051),
    conversationId: conversation.conversationId,
    clientMessageId: testUuid(10_052),
    text: 'Keep the write-side projection append oriented.',
  });
  const first = `${'assistant-checkpoint-'.repeat(1_800)} `;
  const second = 'continues without losing its summary boundary';
  const reasoning = 'reasoning-checkpoint-'.repeat(1_100);
  await repository.appendAssistantCheckpoint(turn, {
    textDelta: first,
    reasoningDelta: reasoning,
  });
  await repository.appendAssistantCheckpoint(turn, {
    textDelta: second,
    reasoningDelta: '',
  });

  const database = new DatabaseSync(repository.databasePath);
  const running = database.prepare(`
    SELECT value_json FROM transcript_items
    WHERE turn_id = ? AND kind = 'assistant'
  `).get(turn.turnId) as { value_json: string };
  const runningValue = JSON.parse(running.value_json) as Record<string, unknown>;
  assert.deepEqual(Object.keys(runningValue).sort(), [
    'reasoningByteLength',
    'summaryPendingSpace',
    'summaryText',
    'textByteLength',
    'version',
  ]);
  assert.equal(runningValue.version, 2);
  assert.equal(runningValue.textByteLength, Buffer.byteLength(first + second));
  assert.equal(runningValue.reasoningByteLength, Buffer.byteLength(reasoning));
  assert.match(String(runningValue.summaryText), /assistant-checkpoint-/u);
  assert.doesNotMatch(running.value_json, /continues without losing its summary boundary.*reasoning-checkpoint-/u);

  await repository.finishTurn(turn, { status: 'completed' });
  const terminal = database.prepare(`
    SELECT value_json FROM transcript_items
    WHERE turn_id = ? AND kind = 'assistant'
  `).get(turn.turnId) as { value_json: string };
  const terminalValue = JSON.parse(terminal.value_json) as {
    version: number;
    text: { content: { kind: string; hash?: string } };
    reasoningRuns: Array<{ content: { kind: string; hash?: string } }>;
  };
  assert.equal(terminalValue.version, 2);
  assert.equal(terminalValue.text.content.kind, 'artifact');
  assert.equal(terminalValue.reasoningRuns[0]?.content.kind, 'artifact');
  assert.equal(typeof terminalValue.text.content.hash, 'string');
  assert.equal(typeof terminalValue.reasoningRuns[0]?.content.hash, 'string');
  database.close();

  const assistantText = (await repository.readTranscriptActions(conversation.conversationId))
    .filter((action) => action.type === 'assistant')
    .map((action) => action.type === 'assistant' ? action.textDelta : '')
    .join('');
  assert.equal(assistantText, first + second);
  await repository.close();
});

test('selected transcript windows do not touch unselected artifact bodies', async (t) => {
  const fixture = await storageFixture(t, 'selected-transcript-window');
  const repository = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  const conversation = await repository.createConversation({
    operationId: testUuid(10_060),
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  const turnIds: string[] = [];
  for (const [index, text] of [
    `${'cold-old-artifact-'.repeat(2_000)}`,
    'middle inline turn',
    'latest inline turn',
  ].entries()) {
    const turn = await repository.acceptTurn({
      operationId: testUuid(10_061 + index * 2),
      conversationId: conversation.conversationId,
      clientMessageId: testUuid(10_062 + index * 2),
      text,
    });
    turnIds.push(turn.turnId);
    await repository.finishTurn(turn, { status: 'completed' });
  }

  const database = new DatabaseSync(repository.databasePath, { readOnly: true });
  const oldArtifact = database.prepare(`
    SELECT a.storage_path
    FROM transcript_items ti
    JOIN artifacts a ON a.hash = json_extract(ti.value_json, '$.content.hash')
    WHERE ti.turn_id = ? AND ti.kind = 'user'
    LIMIT 1
  `).get(turnIds[0]) as { storage_path: string } | undefined;
  database.close();
  assert.ok(oldArtifact);
  await rm(join(fixture.dataRoot, 'artifacts', oldArtifact.storage_path));

  const tail = await repository.readTranscriptWindowProjection({
    conversationId: conversation.conversationId,
    requests: [{
      type: 'transcriptSync',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
      window: { kind: 'tail', count: 1 },
    }],
  });
  assert.deepEqual(tail?.selectedTurnIds, [turnIds[2]]);
  assert.deepEqual(tail?.windows[0], {
    requestIndex: 0,
    startIndex: 2,
    endIndexExclusive: 3,
    hasEarlier: true,
    hasLater: false,
    turnIds: [turnIds[2]],
  });
  await assert.rejects(
    () => repository.readTranscriptWindowProjection({
      conversationId: conversation.conversationId,
      requests: [{
        type: 'transcriptSync',
        protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
        projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
        window: { kind: 'around', turnId: turnIds[0]!, before: 0, after: 0 },
      }],
    }),
    (error) => error instanceof ArtifactIntegrityError && error.reason === 'missing',
  );
  await repository.close();
});

test('startup reports installed artifact objects that have no committed reference', async (t) => {
  const fixture = await storageFixture(t, 'artifact-orphan');
  const initial = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  await initial.close();

  const bytes = Buffer.from('installed before the database reference committed', 'utf8');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const storagePath = join('sha256', hash.slice(0, 2), hash);
  const objectPath = join(fixture.dataRoot, 'artifacts', storagePath);
  await mkdir(join(fixture.dataRoot, 'artifacts', 'sha256', hash.slice(0, 2)), {
    mode: 0o700,
    recursive: true,
  });
  await writeFile(objectPath, bytes, { mode: 0o600 });

  const reopened = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  assert.deepEqual(reopened.artifactDiagnostics(), { orphanStoragePaths: [storagePath] });
  assert.deepEqual(await reopened.scrubArtifacts(), {
    orphanStoragePaths: [storagePath],
    referencedArtifacts: 0,
    verifiedBytes: 0,
  });
  assert.deepEqual(await readFile(objectPath), bytes);
  await reopened.close();
});

test('artifact staging failure admits no durable turn or operation', async (t) => {
  const fixture = await storageFixture(t, 'artifact-write-failure');
  const repository = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  const conversation = await repository.createConversation({
    operationId: testUuid(10_080),
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  await rm(join(fixture.dataRoot, 'tmp'), { recursive: true, force: true });
  await writeFile(join(fixture.dataRoot, 'tmp'), 'block artifact staging');
  const headBefore = await repository.journalHead();
  await assert.rejects(
    () => repository.acceptTurn({
      operationId: testUuid(10_081),
      conversationId: conversation.conversationId,
      clientMessageId: testUuid(10_082),
      text: 'artifact-write-failure-'.repeat(2_000),
    }),
    /ENOTDIR|not a directory/u,
  );
  assert.equal(await repository.journalHead(), headBefore);
  assert.equal((await repository.readTranscriptActions(conversation.conversationId)).length, 0);
  const database = new DatabaseSync(repository.databasePath);
  assert.equal((database.prepare(`
    SELECT COUNT(*) AS count FROM operations WHERE operation_id = ?
  `).get(testUuid(10_081)) as { count: number }).count, 0);
  database.close();
  await repository.close();
});

test('SQLite busy waits converge to one committed operation without replay', async (t) => {
  const fixture = await storageFixture(t, 'sqlite-busy');
  const repository = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  const locker = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import { DatabaseSync } from 'node:sqlite';
     const database = new DatabaseSync(process.env.REMUX_TEST_DATABASE);
     database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
     process.stdout.write('locked\\n');
     setTimeout(() => { database.exec('COMMIT'); database.close(); }, 250);`,
  ], {
    env: { ...process.env, REMUX_TEST_DATABASE: repository.databasePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => locker.kill());
  await new Promise<void>((resolve, reject) => {
    locker.once('error', reject);
    locker.stdout.once('data', () => resolve());
  });
  const operationId = testUuid(10_083);
  const created = await repository.createConversation({
    operationId,
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  assert.equal(created.replayed, false);
  assert.equal((await repository.createConversation({
    operationId,
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  })).replayed, true);
  assert.equal((await repository.readEvents({ conversationId: created.conversationId })).length, 4);
  await new Promise<void>((resolve, reject) => {
    locker.once('error', reject);
    locker.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`SQLite locker exited ${code}.`)));
  });
  await repository.close();
});

test('startup closes nonterminal work as interrupted without replaying effects', async (t) => {
  const fixture = await storageFixture(t, 'restart-recovery');
  const repository = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  const conversation = await repository.createConversation({
    operationId: '23000000-0000-4000-8000-000000000023',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  const accepted = await repository.acceptTurn({
    operationId: testUuid(10_007),
    conversationId: conversation.conversationId,
    clientMessageId: testUuid(10_008),
    text: 'Do not replay this provider call.',
  });
  await repository.startInference(accepted, {
    payload: { request: 'already dispatched before crash' },
    requestMode: 'full',
    estimatedInputTokens: 8,
  });
  await repository.close();

  const reopened = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  const actions = await reopened.readTranscriptActions(conversation.conversationId);
  const terminal = actions.at(-1);
  assert.ok(terminal?.type === 'terminal');
  assert.equal(terminal.turnId, accepted.turnId);
  assert.equal(terminal.status, 'interrupted_by_restart');
  assert.equal(terminal.error, null);
  assert.ok((terminal.durationMs ?? -1) >= 0);
  const database = new DatabaseSync(reopened.databasePath);
  assert.deepEqual({ ...database.prepare(`
    SELECT t.state AS turn_state, i.state AS inference_state,
           e.close_reason, c.state AS conversation_state
    FROM turns t
    JOIN inferences i ON i.turn_id = t.turn_id
    JOIN epochs e ON e.turn_id = t.turn_id
    JOIN conversations c ON c.conversation_id = t.conversation_id
    WHERE t.turn_id = ?
  `).get(accepted.turnId) }, {
    turn_state: 'interrupted_by_restart',
    inference_state: 'interrupted',
    close_reason: 'interrupted_by_restart',
    conversation_state: 'idle',
  });
  database.close();
  await reopened.close();
});

test('ownership constraints reject cross-conversation operation sequences', async (t) => {
  const fixture = await storageFixture(t, 'ownership');
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: deterministicIds().next,
    now: () => RECORDED_AT,
  });
  const first = await repository.createConversation({
    operationId: 'a0000000-0000-4000-8000-00000000000a',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  await repository.createConversation({
    operationId: 'b0000000-0000-4000-8000-00000000000b',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'medium',
  });
  const inspector = new DatabaseSync(repository.databasePath);
  inspector.exec('PRAGMA foreign_keys = ON');
  assert.throws(() => inspector.prepare(`
    UPDATE operations SET terminal_sequence = 6 WHERE conversation_id = ?
  `).run(first.conversationId), /FOREIGN KEY constraint failed/u);
  inspector.close();
  await repository.close();
});

test('startup refuses valid JSON that is not in the canonical journal domain', async (t) => {
  const fixture = await storageFixture(t, 'noncanonical');
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: deterministicIds().next,
    now: () => RECORDED_AT,
  });
  await repository.createConversation({
    operationId: 'c0000000-0000-4000-8000-00000000000c',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  await repository.close();

  const corrupt = new DatabaseSync(repository.databasePath);
  corrupt.prepare('UPDATE events SET payload_json = ? WHERE sequence = 1').run('{"z":1,"a":2}');
  corrupt.close();
  await assert.rejects(
    () => openAgentDatabase({ dataRoot: fixture.dataRoot }),
    /is not canonical JSON/u,
  );
});

test('failed terminal insertion rolls the entire creation transaction back', async (t) => {
  const fixture = await storageFixture(t, 'rollback');
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: deterministicIds().next,
    now: () => RECORDED_AT,
  });
  const inspector = new DatabaseSync(repository.databasePath);
  inspector.exec(`
    CREATE TRIGGER reject_operation_success
    BEFORE INSERT ON events
    WHEN NEW.type = 'operation.succeeded'
    BEGIN
      SELECT RAISE(ABORT, 'injected terminal failure');
    END;
  `);
  inspector.close();

  const operationId = '20000000-0000-4000-8000-000000000002';
  await assert.rejects(() => repository.createConversation({
    operationId,
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  }), /injected terminal failure/u);
  assert.equal(await repository.journalHead(), 0);
  const afterFailure = new DatabaseSync(repository.databasePath);
  assert.deepEqual(rowCounts(afterFailure), {
    projects: 0,
    context_spaces: 0,
    project_primaries: 0,
    context_bindings: 0,
    project_relations: 0,
    conversations: 0,
    strands: 0,
    turns: 0,
    execution_scopes: 0,
    events: 0,
    operations: 0,
    epochs: 0,
    transcript_items: 0,
    resources: 0,
    artifacts: 0,
    epoch_blocks: 0,
    inferences: 0,
  });
  afterFailure.exec('DROP TRIGGER reject_operation_success');
  afterFailure.close();

  const retried = await repository.createConversation({
    operationId,
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  assert.equal(retried.replayed, false);
  assert.equal(await repository.journalHead(), 4);
  await repository.close();
});

test('a committed journal prefix stays byte-identical after later conversations and reopen', async (t) => {
  const fixture = await storageFixture(t, 'prefix');
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: deterministicIds().next,
    now: () => RECORDED_AT,
  });
  await repository.createConversation({
    operationId: '30000000-0000-4000-8000-000000000003',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  const prefix = canonicalJson(await repository.readEvents({ throughSequence: 4 }));
  await repository.createConversation({
    operationId: '40000000-0000-4000-8000-000000000004',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'medium',
  });
  assert.equal(canonicalJson(await repository.readEvents({ throughSequence: 4 })), prefix);
  assert.equal((await repository.readEvents()).length, 7);
  await repository.close();

  const reopened = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  assert.equal(canonicalJson(await reopened.readEvents({ throughSequence: 4 })), prefix);
  await reopened.close();
});

test('the canonical durable projection hash survives resource rebuild and reopen', async (t) => {
  const fixture = await storageFixture(t, 'projection-hash');
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: deterministicIds().next,
    now: () => RECORDED_AT,
  });
  const created = await repository.createConversation({
    operationId: '10000000-0000-4000-8000-000000000201',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  const turn = await repository.acceptTurn({
    operationId: testUuid(10_009),
    conversationId: created.conversationId,
    clientMessageId: testUuid(10_010),
    text: 'Inspect the durable projection.',
  });
  await repository.startInference(turn, {
    payload: { messages: [{ role: 'user', content: 'Inspect the durable projection.' }] },
    requestMode: 'full',
    estimatedInputTokens: 12,
  });
  await repository.appendAssistantCheckpoint(turn, {
    textDelta: 'Projection checkpoint.',
    reasoningDelta: 'Visible reasoning summary.',
  });
  await repository.finishInference(turn, { state: 'completed' });
  await repository.recordToolStarted(turn, {
    callId: 'projection-read',
    name: 'workspace.read',
    args: { path: 'README.md' },
  });
  await repository.recordToolFinished(turn, {
    callId: 'projection-read',
    result: { path: 'README.md', text: '# Remux' },
    isError: false,
  });
  await repository.finishTurn(turn, { status: 'completed' });

  const before = await repository.projectionDigest();
  assert.match(before.hash, /^[0-9a-f]{64}$/u);
  assert.equal(before.projectionVersion, 'agent-projection-v1');
  await repository.rebuildConversationResources();
  assert.deepEqual(await repository.projectionDigest(), before);
  await repository.close();

  const reopened = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  assert.deepEqual(await reopened.projectionDigest(), before);
  await reopened.close();
});

test('conversation resources are exact, isolated, rebuildable, and restart durable', async (t) => {
  const fixture = await storageFixture(t, 'conversation-resources');
  const ids = deterministicIds();
  let recordedAt = RECORDED_AT;
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: ids.next,
    now: () => recordedAt,
  });
  const created = await repository.createConversation({
    operationId: '10000000-0000-4000-8000-000000000101',
    cwd: fixture.workspace,
    modelId: 'gpt-5.4',
    reasoning: 'high',
  });
  const initial = await repository.readResourceProjections([
    conversationResourceKey(created.conversationId),
    'conversation-list',
  ]);
  assert.equal((initial[0]?.value as ConversationSummary).title, 'New conversation');
  assert.equal((initial[0]?.value as ConversationSummary).preview, '');
  assert.equal((initial[1]?.value as ConversationListValue).conversations.length, 1);

  recordedAt += 10;
  const turn = await repository.acceptTurn({
    operationId: testUuid(10_011),
    conversationId: created.conversationId,
    clientMessageId: testUuid(10_012),
    text: `  ${'🙂'.repeat(55)}\u00a0 user tail  `,
  });
  recordedAt += 10;
  await repository.appendAssistantCheckpoint(turn, {
    textDelta: '  Assistant\nanswer  ',
    reasoningDelta: 'PRIVATE_REASONING_MUST_NOT_LEAK',
  });
  const beforeTool = await repository.readResourceProjections([
    conversationResourceKey(created.conversationId),
    'conversation-list',
  ]);
  recordedAt += 10;
  await repository.recordToolStarted(turn, {
    callId: 'call-1',
    name: 'private_tool',
    args: { secret: 'PRIVATE_TOOL_ARGS_MUST_NOT_LEAK' },
  });
  await repository.recordToolFinished(turn, {
    callId: 'call-1',
    result: { secret: 'PRIVATE_TOOL_RESULT_MUST_NOT_LEAK' },
    isError: false,
  });
  assert.deepEqual(await repository.readResourceProjections([
    conversationResourceKey(created.conversationId),
    'conversation-list',
  ]), beforeTool);
  recordedAt += 10;
  await repository.finishTurn(turn, {
    status: 'failed',
    error: 'PRIVATE_ERROR_MUST_NOT_LEAK',
  });

  const projected = await repository.readResourceProjections([
    conversationResourceKey(created.conversationId),
    'conversation-list',
  ]);
  const summary = projected[0]?.value as ConversationSummary;
  assert.equal(summary.title, '🙂'.repeat(48));
  assert.equal(summary.preview, 'Assistant answer');
  assert.equal(summary.status, 'error');
  assert.equal(summary.latestTurnId, turn.turnId);
  assert.equal(summary.createdAt, RECORDED_AT);
  assert.equal(summary.updatedAt, recordedAt);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /PRIVATE_/u);
  assert.deepEqual(
    (projected[1]?.value as ConversationListValue).conversations,
    [summary],
  );

  const before = readResourceRows(repository.databasePath);
  await repository.rebuildConversationResources();
  assert.deepEqual(readResourceRows(repository.databasePath), before);
  await repository.close();

  const reopened = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
  const afterRestart = await reopened.readResourceProjections([
    conversationResourceKey(created.conversationId),
    'conversation-list',
  ]);
  assert.deepEqual(afterRestart, projected);
  await reopened.close();
});

test('conversation list keeps fifty deterministic rows while older conversations remain addressable', async (t) => {
  const fixture = await storageFixture(t, 'conversation-list-limit');
  const ids = deterministicIds();
  const repository = await AgentJournalRepository.open({
    dataRoot: fixture.dataRoot,
    idFactory: ids.next,
    now: () => RECORDED_AT,
  });
  const createdIds: string[] = [];
  for (let index = 0; index < 52; index += 1) {
    const created = await repository.createConversation({
      operationId: `10000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      cwd: fixture.workspace,
      modelId: 'gpt-5.4',
      reasoning: 'medium',
    });
    createdIds.push(created.conversationId);
  }

  const [listProjection, oldestProjection] = await repository.readResourceProjections([
    'conversation-list',
    conversationResourceKey(createdIds[0]!),
  ]);
  const list = listProjection?.value as ConversationListValue;
  assert.equal(list.conversations.length, 50);
  assert.equal(list.truncated, true);
  assert.deepEqual(
    list.conversations.map((summary) => summary.id),
    [...createdIds].sort().reverse().slice(0, 50),
  );
  assert.equal((oldestProjection?.value as ConversationSummary).id, createdIds[0]);
  assert.equal(list.conversations.some((summary) => summary.id === createdIds[0]), false);
  await repository.close();
});

async function storageFixture(t: TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), `remux-agent-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return { root, dataRoot: join(root, 'data'), workspace };
}

function deterministicIds() {
  let counter = 1;
  return {
    next: () => `00000000-0000-4000-8000-${(counter++).toString(16).padStart(12, '0')}`,
  };
}

function testUuid(value: number) {
  return `f0000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function userTables(database: DatabaseSync) {
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function indexNames(database: DatabaseSync) {
  return (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name);
}

function rowCounts(database: DatabaseSync) {
  const tables = [
    'projects', 'context_spaces', 'project_primaries', 'context_bindings',
    'project_relations', 'conversations', 'strands', 'turns',
    'execution_scopes', 'events', 'operations', 'epochs', 'transcript_items',
    'resources', 'artifacts', 'epoch_blocks', 'inferences',
  ];
  return Object.fromEntries(tables.map((table) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number };
    return [table, row.count];
  }));
}

function readResourceRows(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT resource_key, basis_sequence, value_json, updated_at
      FROM resources ORDER BY resource_key
    `).all();
  } finally {
    database.close();
  }
}

async function mode(path: string) {
  return (await stat(path)).mode & 0o777;
}

function pragmaNumber(database: DatabaseSync, name: string) {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  assert.equal(typeof row[name], 'number');
  return row[name] as number;
}

function pragmaString(database: DatabaseSync, name: string) {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  assert.equal(typeof row[name], 'string');
  return row[name] as string;
}
