import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  applyI3PhantomGrandchildren,
  I3_PHANTOM_INCIDENT,
  I3_PHANTOM_REPAIR_AUDIT_KEY,
  planI3PhantomGrandchildren,
} from '../server/src/native-runtime/i3-child-repair.ts';

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE meta(key TEXT PRIMARY KEY,value_json TEXT);
    CREATE TABLE executions(execution_id TEXT PRIMARY KEY,conversation_id TEXT,parent_execution_id TEXT,
      root_turn_id TEXT,ownership TEXT,provider TEXT,state TEXT,outcome TEXT);
    CREATE TABLE native_sessions(execution_id TEXT PRIMARY KEY,native_session_id TEXT);
    CREATE TABLE native_child_handles(execution_id TEXT PRIMARY KEY,native_session_id TEXT);
    CREATE TABLE native_turn_bindings(native_binding_id TEXT PRIMARY KEY,native_session_execution_id TEXT);
    CREATE TABLE turns(turn_id TEXT PRIMARY KEY,conversation_id TEXT,execution_id TEXT);
    CREATE TABLE events(sequence INTEGER PRIMARY KEY,conversation_id TEXT,execution_id TEXT,turn_id TEXT,
      native_kind TEXT,envelope_json TEXT);
    CREATE TABLE turn_passes(pass_id TEXT PRIMARY KEY,turn_id TEXT,ordinal INTEGER);
    CREATE TABLE turn_blocks(block_id TEXT PRIMARY KEY,turn_id TEXT,pass_id TEXT,kind TEXT,payload_json TEXT);
  `);
  database.prepare('INSERT INTO executions VALUES (?,?,?,?,?,?,?,?)').run(
    I3_PHANTOM_INCIDENT.rootExecutionId, I3_PHANTOM_INCIDENT.conversationId, null, 'root-turn',
    'root', 'codex', 'idle', 'completed',
  );
  database.prepare('INSERT INTO native_sessions VALUES (?,?)').run(
    I3_PHANTOM_INCIDENT.rootExecutionId, I3_PHANTOM_INCIDENT.rootNativeSessionId,
  );
  return database;
}

const suffix = `:codex-child-${createHash('sha256').update(I3_PHANTOM_INCIDENT.rootNativeSessionId)
  .digest('hex').slice(0, 20)}`;

function addCandidate(database: DatabaseSync, ordinal: number, options: {
  ownTurn?: boolean; wrongParent?: boolean; mismatchedSession?: boolean;
} = {}) {
  const parent = `${I3_PHANTOM_INCIDENT.rootExecutionId}:codex-child-parent${ordinal}`;
  const phantom = `${parent}${suffix}`;
  const parentOfParent = options.wrongParent ? 'some-other-root' : I3_PHANTOM_INCIDENT.rootExecutionId;
  if (options.wrongParent) database.prepare('INSERT INTO executions VALUES (?,?,?,?,?,?,?,?)').run(
    parentOfParent, I3_PHANTOM_INCIDENT.conversationId, null, 'other-root-turn', 'root', 'codex', 'idle', 'completed');
  database.prepare('INSERT INTO executions VALUES (?,?,?,?,?,?,?,?)').run(
    parent, I3_PHANTOM_INCIDENT.conversationId, parentOfParent, `owner-${ordinal}`, 'native', 'codex', 'idle', 'completed');
  const nativeSession = `native-parent-${ordinal}`;
  database.prepare('INSERT INTO native_child_handles VALUES (?,?)').run(parent, nativeSession);
  database.prepare('INSERT INTO executions VALUES (?,?,?,?,?,?,?,?)').run(
    phantom, I3_PHANTOM_INCIDENT.conversationId, parent, `turn-${ordinal}`, 'native', 'codex', 'running', null);
  const turnId = `turn-${ordinal}`;
  const blockId = `block-${ordinal}`;
  database.prepare('INSERT INTO turns VALUES (?,?,?)').run(turnId, I3_PHANTOM_INCIDENT.conversationId, parent);
  database.prepare('INSERT INTO turn_passes VALUES (?,?,?)').run(`pass-${ordinal}`, turnId, 0);
  const payload = { kind: 'native-child', child: { executionId: phantom, ownership: 'native', provider: 'codex' },
    executionState: 'running' };
  database.prepare('INSERT INTO turn_blocks VALUES (?,?,?,?,?)').run(
    blockId, turnId, `pass-${ordinal}`, 'native-child', JSON.stringify(payload));
  const envelope = { scope: { conversationId: I3_PHANTOM_INCIDENT.conversationId, executionId: parent, turnId },
    native: { kind: 'child/interacted', sessionId: options.mismatchedSession ? 'wrong-session' : nativeSession },
    event: { structure: { blockId }, block: { payload } } };
  database.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(
    10_000 + ordinal, I3_PHANTOM_INCIDENT.conversationId, parent, turnId, 'child/interacted', JSON.stringify(envelope));
  if (options.ownTurn) database.prepare('INSERT INTO turns VALUES (?,?,?)').run(
    `genuine-${ordinal}`, I3_PHANTOM_INCIDENT.conversationId, phantom);
  return { parent, phantom, blockId, turnId };
}

test('plans and atomically repairs ten proven phantom grandchildren while preserving evidence', () => {
  const database = fixture();
  const proven = Array.from({ length: 10 }, (_, index) => addCandidate(database, index));
  database.prepare('DELETE FROM turn_blocks WHERE block_id=?').run(proven[9]!.blockId);
  database.prepare('DELETE FROM turn_passes WHERE pass_id=?').run('pass-9');
  const ambiguous = addCandidate(database, 20, { ownTurn: true });
  const wrongParent = addCandidate(database, 21, { wrongParent: true });
  const wrongSession = addCandidate(database, 22, { mismatchedSession: true });

  const plan = planI3PhantomGrandchildren(database);
  assert.equal(plan.repairExecutionIds.length, 10);
  assert.equal(plan.refused.length, 3);
  assert.match(plan.refused.find((entry) => entry.executionId === ambiguous.phantom)!.reasons.join(' '), /genuine turns/u);
  assert.match(plan.refused.find((entry) => entry.executionId === wrongParent.phantom)!.reasons.join(' '), /approved root/u);
  assert.match(plan.refused.find((entry) => entry.executionId === wrongSession.phantom)!.reasons.join(' '), /exact child\/interacted/u);

  database.exec(`CREATE TRIGGER reject_repair_audit BEFORE INSERT ON meta
    WHEN NEW.key = '${I3_PHANTOM_REPAIR_AUDIT_KEY}' BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;`);
  assert.throws(() => applyI3PhantomGrandchildren(database, 77), /forced audit failure/u);
  assert.equal((database.prepare('SELECT COUNT(*) count FROM executions WHERE execution_id LIKE ?')
    .get(`%${suffix}`) as any).count, 13);
  database.exec('DROP TRIGGER reject_repair_audit');

  const audit = applyI3PhantomGrandchildren(database, 78) as any;
  assert.equal(audit.removedExecutionIds.length, 10);
  assert.equal(audit.removedBlockIds.length, 9);
  assert.equal(audit.suppressedBlockIds.length, 10);
  assert.ok(audit.suppressedBlockIds.includes(proven[9]!.blockId));
  assert.equal(audit.preservedEvidenceSequences.length, 13);
  for (const candidate of proven) {
    assert.equal(database.prepare('SELECT 1 FROM executions WHERE execution_id=?').get(candidate.phantom), undefined);
    assert.equal(database.prepare('SELECT 1 FROM turn_blocks WHERE block_id=?').get(candidate.blockId), undefined);
  }
  for (const candidate of [ambiguous, wrongParent, wrongSession]) {
    assert.ok(database.prepare('SELECT 1 FROM executions WHERE execution_id=?').get(candidate.phantom));
    assert.ok(database.prepare('SELECT 1 FROM turn_blocks WHERE block_id=?').get(candidate.blockId));
  }
  assert.equal((database.prepare('SELECT COUNT(*) count FROM events').get() as any).count, 13);
  assert.deepEqual(applyI3PhantomGrandchildren(database, 79), audit);
  database.close();
});

test('refuses a name/hash match without an exact parent interaction event', () => {
  const database = fixture();
  const candidate = addCandidate(database, 30);
  database.prepare('DELETE FROM events WHERE sequence=?').run(10_030);
  const plan = planI3PhantomGrandchildren(database);
  assert.deepEqual(plan.repairExecutionIds, []);
  assert.match(plan.refused[0]!.reasons.join(' '), /lacks exact child\/interacted/u);
  const audit = applyI3PhantomGrandchildren(database, 80) as any;
  assert.deepEqual(audit.removedExecutionIds, []);
  assert.ok(database.prepare('SELECT 1 FROM executions WHERE execution_id=?').get(candidate.phantom));
  database.close();
});
