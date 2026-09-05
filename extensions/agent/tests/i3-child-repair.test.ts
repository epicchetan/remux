import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { I3_INCIDENT, repairI3NativeChildIdentity } from '../server/src/native-runtime/i3-child-repair.ts';

test('I3 copied-data repair is exact, transactional, diagnostic-preserving, and idempotent', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value_json TEXT);
    CREATE TABLE events(sequence INTEGER PRIMARY KEY,envelope_json TEXT,execution_id TEXT);
    CREATE TABLE executions(execution_id TEXT PRIMARY KEY,parent_execution_id TEXT,root_turn_id TEXT,state TEXT,outcome TEXT);
    CREATE TABLE turns(turn_id TEXT PRIMARY KEY,execution_id TEXT);
    CREATE TABLE native_child_handles(execution_id TEXT PRIMARY KEY);
    CREATE TABLE native_sessions(execution_id TEXT PRIMARY KEY);
    CREATE TABLE turn_passes(pass_id TEXT PRIMARY KEY,turn_id TEXT,ordinal INTEGER);
    CREATE TABLE turn_blocks(block_id TEXT PRIMARY KEY,turn_id TEXT,pass_id TEXT,kind TEXT,ordinal INTEGER,
      state TEXT,revision INTEGER,payload_json TEXT,content_hash TEXT,started_at INTEGER,completed_at INTEGER,
      created_at INTEGER,updated_at INTEGER);
  `);
  const real = I3_INCIDENT.realExecutionId;
  const phantom = `${real}:codex-child-65428429d1e409261d92`;
  const block = (id: string, executionId: string, state = 'running') => ({
    type: state === 'completed' ? 'turn.block.completed' : 'turn.block.started',
    structure: { passId: `pass-${id}`, blockId: id, passOrdinal: 0, blockOrdinal: 0 },
    ...(state === 'completed' ? { revision: 1 } : {}),
    block: { kind: 'native-child', state, payload: { kind: 'native-child',
      child: { executionId, ownership: 'native', provider: 'codex',
        ...(executionId === real ? { nativeSessionId: I3_INCIDENT.childNativeSessionId } : {}) },
      executionState: state === 'completed' ? 'idle' : 'running',
      ...(state === 'completed' ? { outcome: 'completed' } : {}) } },
  });
  const envelope = (sequence: number, event: any,
    executionId: string = I3_INCIDENT.rootExecutionId, nativeKind = 'child/started') =>
    JSON.stringify({ contractVersion: 5, eventId: `event-${sequence}`, provider: 'codex',
      scope: { kind: 'turn', providerInstanceId: 'codex-local', conversationId: I3_INCIDENT.conversationId,
        executionId, turnId: executionId === I3_INCIDENT.rootExecutionId ? I3_INCIDENT.ownerTurnId : 'child-turn' },
      native: { sessionId: executionId === real ? I3_INCIDENT.childNativeSessionId : I3_INCIDENT.rootNativeSessionId,
        ...(sequence === 142740 ? { itemId: `subagent-completed-${I3_INCIDENT.childNativeTurnId}` } : {}),
        kind: nativeKind }, observedAt: sequence, event });
  const evidence = { events: [
    { sequence: 142651, envelope_json: envelope(142651, block('canonical', real)) },
    { sequence: 142652, envelope_json: envelope(142652, block('duplicate', real)) },
    { sequence: 142709, envelope_json: envelope(142709, block('phantom-block', phantom), real, 'child/interacted') },
    { sequence: 142740, envelope_json: envelope(142740, block('canonical', real)) },
    { sequence: 142741, envelope_json: envelope(142741, block('duplicate', real, 'completed')) },
  ] };
  for (const entry of evidence.events) database.prepare('INSERT INTO events VALUES (?,?,?)')
    .run(entry.sequence, entry.envelope_json, JSON.parse(entry.envelope_json).scope.executionId);
  database.prepare('INSERT INTO executions VALUES (?,?,?,?,?)').run(real, I3_INCIDENT.rootExecutionId, I3_INCIDENT.ownerTurnId, 'idle', 'completed');
  database.prepare('INSERT INTO executions VALUES (?,?,?,?,?)').run(phantom, real, 'child-turn', 'running', null);
  for (const [id, executionId] of [['canonical', real], ['duplicate', real], ['phantom-block', phantom]]) {
    database.prepare('INSERT INTO turn_passes VALUES (?,?,?)').run(`pass-${id}`,
      executionId === phantom ? 'child-turn' : I3_INCIDENT.ownerTurnId, 0);
    const payload = (block(id, executionId) as any).block.payload;
    database.prepare('INSERT INTO turn_blocks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id, executionId === phantom ? 'child-turn' : I3_INCIDENT.ownerTurnId, `pass-${id}`, 'native-child', 0,
      'running', 0, JSON.stringify(payload), 'a'.repeat(64), 1, null, 1, 1);
  }
  database.exec(`CREATE TRIGGER reject_i3_audit BEFORE INSERT ON meta
    WHEN NEW.key = 'repair_i3_native_child_identity_v1' BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;`);
  assert.throws(() => repairI3NativeChildIdentity(database, evidence, 98), /forced audit failure/u);
  assert.equal((database.prepare('SELECT state FROM turn_blocks WHERE block_id=?').get('canonical') as any).state, 'running');
  assert.ok(database.prepare('SELECT 1 FROM executions WHERE execution_id=?').get(phantom));
  database.exec('DROP TRIGGER reject_i3_audit');
  const repaired = repairI3NativeChildIdentity(database, evidence, 99) as any;
  assert.equal(repaired.retainedBlockId, 'canonical');
  assert.deepEqual(repaired.removedBlockIds.sort(), ['duplicate', 'phantom-block']);
  assert.equal((database.prepare('SELECT state FROM turn_blocks WHERE block_id=?').get('canonical') as any).state, 'completed');
  assert.equal(database.prepare('SELECT 1 FROM executions WHERE execution_id=?').get(phantom), undefined);
  assert.equal((database.prepare('SELECT COUNT(*) count FROM events').get() as any).count, 5);
  assert.equal(JSON.stringify(repairI3NativeChildIdentity(database, evidence, 100)), JSON.stringify(repaired));
  database.close();
});

test('I3 repair rolls back on evidence mismatch', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value_json TEXT); CREATE TABLE events(sequence INTEGER PRIMARY KEY,envelope_json TEXT);');
  assert.throws(() => repairI3NativeChildIdentity(database, { events: [] }), /evidence mismatch/u);
  assert.equal((database.prepare('SELECT COUNT(*) count FROM meta').get() as any).count, 0);
  database.close();
});
