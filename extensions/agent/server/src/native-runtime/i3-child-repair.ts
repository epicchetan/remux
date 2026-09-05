import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const I3_REPAIR_AUDIT_KEY = 'repair_i3_native_child_identity_v1';
export const I3_PHANTOM_REPAIR_AUDIT_KEY = 'repair_i3_phantom_grandchildren_v2';

export const I3_PHANTOM_INCIDENT = {
  conversationId: '8862392c-d732-4d21-9bbd-a952bbfb7677',
  rootExecutionId: 'ddf98df2-bd20-4541-8efc-755c80135809',
  rootNativeSessionId: '01a07179-6793-7520-9180-28baa6a320cf',
} as const;

type RepairDisposition = 'repair' | 'refuse';

export type I3PhantomRepairCandidate = {
  executionId: string;
  parentExecutionId: string | null;
  disposition: RepairDisposition;
  reasons: string[];
  blockIds: string[];
  evidenceSequences: number[];
  evidenceBlockIds: string[];
  evidenceSha256: string;
};

export type I3PhantomRepairPlan = {
  version: 2;
  conversationId: string;
  rootExecutionId: string;
  rootNativeSessionId: string;
  expectedSuffix: string;
  alreadyApplied: boolean;
  candidates: I3PhantomRepairCandidate[];
  repairExecutionIds: string[];
  refused: I3PhantomRepairCandidate[];
  planSha256: string;
};

export type I3RepairEvidence = { events: Array<{ sequence: number; envelope_json: string }> };

export const I3_INCIDENT = {
  conversationId: '8862392c-d732-4d21-9bbd-a952bbfb7677',
  ownerTurnId: 'e56a5d60-8f88-4016-bc0b-9eab3f2b5a1e',
  rootExecutionId: 'ddf98df2-bd20-4541-8efc-755c80135809',
  rootNativeSessionId: '01a07179-6793-7520-9180-28baa6a320cf',
  realExecutionId: 'ddf98df2-bd20-4541-8efc-755c80135809:codex-child-cf9e989274ed5f7f1f4b',
  childNativeSessionId: '01a0720f-ce20-7c71-9bbb-00d75cdc0207',
  childNativeTurnId: '01a0720f-ce51-7c10-a881-c35b07cc6214',
} as const;

export function repairI3NativeChildIdentity(database: DatabaseSync, evidence: I3RepairEvidence, repairedAt = Date.now()) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const previous = database.prepare('SELECT value_json FROM meta WHERE key = ?')
      .get(I3_REPAIR_AUDIT_KEY) as { value_json: string } | undefined;
    if (previous) {
      database.exec('COMMIT');
      return JSON.parse(previous.value_json) as Record<string, unknown>;
    }
    const bySequence = new Map(evidence.events.map((entry) => [entry.sequence, entry.envelope_json]));
    const required = [142651, 142652, 142709, 142740, 142741];
    for (const sequence of required) {
      const expected = bySequence.get(sequence);
      const stored = database.prepare('SELECT envelope_json FROM events WHERE sequence = ?')
        .get(sequence) as { envelope_json: string } | undefined;
      if (!expected || stored?.envelope_json !== expected) {
        throw new Error(`I3 repair evidence mismatch at event ${sequence}.`);
      }
    }
    const envelope = (sequence: number) => JSON.parse(bySequence.get(sequence)!) as any;
    const canonicalEvent = envelope(142651);
    const duplicateEvent = envelope(142741);
    const phantomEvent = envelope(142709);
    const canonicalId = canonicalEvent.event.structure.blockId as string;
    const duplicateId = duplicateEvent.event.structure.blockId as string;
    const phantomId = phantomEvent.event.structure.blockId as string;
    const realExecutionId = canonicalEvent.event.block.payload.child.executionId as string;
    const phantomExecutionId = phantomEvent.event.block.payload.child.executionId as string;
    const expectedPhantomId = `${I3_INCIDENT.realExecutionId}:codex-child-${createHash('sha256')
      .update(I3_INCIDENT.rootNativeSessionId).digest('hex').slice(0, 20)}`;
    const exactIncident = canonicalEvent.scope.conversationId === I3_INCIDENT.conversationId &&
      canonicalEvent.scope.turnId === I3_INCIDENT.ownerTurnId &&
      canonicalEvent.scope.executionId === I3_INCIDENT.rootExecutionId &&
      canonicalEvent.native.sessionId === I3_INCIDENT.rootNativeSessionId &&
      realExecutionId === I3_INCIDENT.realExecutionId &&
      canonicalEvent.event.block.payload.child.nativeSessionId === I3_INCIDENT.childNativeSessionId &&
      duplicateEvent.scope.turnId === I3_INCIDENT.ownerTurnId &&
      duplicateEvent.event.block.payload.child.executionId === realExecutionId &&
      duplicateEvent.event.block.state === 'completed' &&
      duplicateEvent.event.block.payload.outcome === 'completed' &&
      envelope(142740).native.itemId === `subagent-completed-${I3_INCIDENT.childNativeTurnId}` &&
      phantomExecutionId === expectedPhantomId;
    if (!exactIncident) throw new Error('I3 evidence does not describe the approved incident identities.');
    const canonical = database.prepare('SELECT * FROM turn_blocks WHERE block_id = ?').get(canonicalId) as any;
    if (!canonical || canonical.turn_id !== canonicalEvent.scope.turnId || canonical.kind !== 'native-child') {
      throw new Error('I3 canonical child block is missing or no longer matches the evidence.');
    }
    const duplicateBefore = database.prepare('SELECT * FROM turn_blocks WHERE block_id = ?').get(duplicateId) as any;
    const phantomBlockBefore = database.prepare('SELECT * FROM turn_blocks WHERE block_id = ?').get(phantomId) as any;
    const canonicalCurrentPayload = JSON.parse(canonical.payload_json);
    const realExecution = database.prepare('SELECT * FROM executions WHERE execution_id = ?').get(realExecutionId) as any;
    if (canonicalCurrentPayload?.child?.executionId !== realExecutionId ||
        realExecution?.state !== 'idle' || realExecution?.outcome !== 'completed') {
      throw new Error('I3 real child has changed or has a later active follow-up; no repair was applied.');
    }
    if (duplicateBefore && (duplicateBefore.turn_id !== duplicateEvent.scope.turnId ||
        duplicateBefore.pass_id !== duplicateEvent.event.structure.passId ||
        duplicateBefore.kind !== 'native-child' ||
        JSON.parse(duplicateBefore.payload_json)?.child?.executionId !== realExecutionId)) {
      throw new Error('I3 duplicate block no longer matches captured evidence.');
    }
    if (!phantomBlockBefore || phantomBlockBefore.turn_id !== phantomEvent.scope.turnId ||
        phantomBlockBefore.pass_id !== phantomEvent.event.structure.passId ||
        phantomBlockBefore.kind !== 'native-child' ||
        JSON.parse(phantomBlockBefore.payload_json)?.child?.executionId !== phantomExecutionId) {
      throw new Error('I3 phantom block no longer matches captured evidence.');
    }
    const phantom = database.prepare('SELECT * FROM executions WHERE execution_id = ?').get(phantomExecutionId) as any;
    if (!phantom || phantom.parent_execution_id !== realExecutionId ||
        database.prepare('SELECT COUNT(*) AS count FROM turns WHERE execution_id = ?').get(phantomExecutionId)?.count !== 0 ||
        database.prepare('SELECT COUNT(*) AS count FROM native_child_handles WHERE execution_id = ?').get(phantomExecutionId)?.count !== 0 ||
        database.prepare('SELECT COUNT(*) AS count FROM native_sessions WHERE execution_id = ?').get(phantomExecutionId)?.count !== 0 ||
        database.prepare('SELECT COUNT(*) AS count FROM events WHERE execution_id = ?').get(phantomExecutionId)?.count !== 0 ||
        database.prepare('SELECT COUNT(*) AS count FROM executions WHERE parent_execution_id = ?').get(phantomExecutionId)?.count !== 0) {
      throw new Error('I3 phantom execution is ambiguous; no repair was applied.');
    }
    const interacted = phantomEvent.native.kind === 'child/interacted' &&
      phantomEvent.scope.executionId === realExecutionId &&
      phantomEvent.event.block.payload.child.executionId === phantomExecutionId &&
      phantomEvent.native.sessionId === I3_INCIDENT.childNativeSessionId;
    if (!interacted) throw new Error('I3 phantom edge lacks exact interaction evidence.');
    const phantomSuffix = phantomExecutionId.slice(realExecutionId.length);
    const ambiguous = (database.prepare(`SELECT execution_id FROM executions
      WHERE execution_id != ? AND execution_id LIKE ? ORDER BY execution_id`)
      .all(phantomExecutionId, `%${phantomSuffix}`) as Array<{ execution_id: string }>)
      .map(({ execution_id }) => ({ executionId: execution_id, reason: 'similar identity without supplied event evidence' }));

    const canonicalPayload = JSON.parse(canonical.payload_json);
    canonicalPayload.executionState = 'idle';
    canonicalPayload.outcome = 'completed';
    const block = { kind: 'native-child', state: 'completed', payload: canonicalPayload };
    const terminalAt = Math.max(Number(duplicateEvent.observedAt), Number(canonical.started_at ?? 0));
    const canonicalEnvelope = structuredClone(duplicateEvent);
    canonicalEnvelope.eventId = `repair-i3-${canonicalId}`;
    const canonicalPass = database.prepare('SELECT ordinal FROM turn_passes WHERE pass_id = ?')
      .get(canonical.pass_id) as { ordinal: number };
    canonicalEnvelope.event.structure = {
      passId: canonical.pass_id,
      blockId: canonical.block_id,
      passOrdinal: canonicalPass.ordinal,
      blockOrdinal: canonical.ordinal,
    };
    canonicalEnvelope.event.block = block;
    canonicalEnvelope.event.revision = Math.max(Number(canonical.revision), Number(duplicateEvent.event.revision));
    canonicalEnvelope.event.contentHash = createHash('sha256').update(JSON.stringify(block)).digest('hex');
    canonicalEnvelope.observedAt = terminalAt;
    database.prepare(`UPDATE turn_blocks SET state = 'completed', revision = MAX(revision, ?),
      payload_json = ?, content_hash = ?, completed_at = ?, updated_at = MAX(updated_at, ?)
      WHERE block_id = ?`).run(
      Number(duplicateEvent.event.revision), JSON.stringify(canonicalPayload),
      createHash('sha256').update(JSON.stringify(block)).digest('hex'), terminalAt,
      terminalAt, canonicalId,
    );
    const removedBlocks: string[] = [];
    for (const blockId of [duplicateId, phantomId]) {
      const row = database.prepare('SELECT pass_id FROM turn_blocks WHERE block_id = ?').get(blockId) as
        { pass_id: string } | undefined;
      if (!row) continue;
      database.prepare('DELETE FROM turn_blocks WHERE block_id = ?').run(blockId);
      database.prepare(`DELETE FROM turn_passes WHERE pass_id = ?
        AND NOT EXISTS (SELECT 1 FROM turn_blocks WHERE pass_id = ?)`).run(row.pass_id, row.pass_id);
      removedBlocks.push(blockId);
    }
    database.prepare('DELETE FROM executions WHERE execution_id = ?').run(phantomExecutionId);
    const audit = {
      version: 1, repairedAt,
      evidenceSha256: createHash('sha256').update(required.map((id) => bySequence.get(id)).join('\n')).digest('hex'),
      conversationId: canonicalEvent.scope.conversationId,
      retainedBlockId: canonicalId,
      removedBlockIds: removedBlocks,
      removedExecutionIds: [phantomExecutionId],
      preservedEventSequences: required,
      before: { canonicalBlock: canonical, duplicateBlock: duplicateBefore ?? null,
        phantomBlock: phantomBlockBefore ?? null, phantomExecution: phantom },
      directives: {
        suppressedBlockIds: [duplicateId, phantomId],
        terminalSequence: 142741,
        canonicalEnvelope,
      },
      ambiguous,
    };
    database.prepare('INSERT INTO meta(key, value_json) VALUES (?, ?)')
      .run(I3_REPAIR_AUDIT_KEY, JSON.stringify(audit));
    database.exec('COMMIT');
    return audit;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Builds a bounded repair plan from durable rows. Identity text only selects rows
 * for inspection; every deletion requires the native-session and event checks
 * below. A refused candidate is deliberately retained.
 */
export function planI3PhantomGrandchildren(database: DatabaseSync): I3PhantomRepairPlan {
  const incident = I3_PHANTOM_INCIDENT;
  const expectedSuffix = `:codex-child-${createHash('sha256')
    .update(incident.rootNativeSessionId).digest('hex').slice(0, 20)}`;
  const previous = database.prepare('SELECT value_json FROM meta WHERE key = ?')
    .get(I3_PHANTOM_REPAIR_AUDIT_KEY) as { value_json: string } | undefined;
  const root = database.prepare(`SELECT e.execution_id, e.parent_execution_id, e.ownership, e.provider,
      s.native_session_id
    FROM executions e LEFT JOIN native_sessions s ON s.execution_id = e.execution_id
    WHERE e.execution_id = ? AND e.conversation_id = ?`)
    .get(incident.rootExecutionId, incident.conversationId) as any;
  if (!root || root.parent_execution_id !== null || root.ownership !== 'root' || root.provider !== 'codex' ||
      root.native_session_id !== incident.rootNativeSessionId) {
    throw new Error('I3 repair root identity or durable native session does not match the approved incident.');
  }

  const rows = database.prepare(`SELECT execution_id, parent_execution_id, ownership, provider
    FROM executions WHERE conversation_id = ? AND execution_id LIKE ? ORDER BY execution_id`)
    .all(incident.conversationId, `%${expectedSuffix}`) as any[];
  const candidates = rows.map((row): I3PhantomRepairCandidate => inspectPhantomCandidate(
    database, row, expectedSuffix,
  ));
  const digestInput = candidates.map(({ executionId, parentExecutionId, disposition, reasons, blockIds,
    evidenceSequences, evidenceBlockIds, evidenceSha256 }) => ({ executionId, parentExecutionId, disposition,
      reasons, blockIds, evidenceSequences, evidenceBlockIds, evidenceSha256 }));
  const planSha256 = createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
  return {
    version: 2,
    conversationId: incident.conversationId,
    rootExecutionId: incident.rootExecutionId,
    rootNativeSessionId: incident.rootNativeSessionId,
    expectedSuffix,
    alreadyApplied: Boolean(previous),
    candidates,
    repairExecutionIds: candidates.filter((entry) => entry.disposition === 'repair').map((entry) => entry.executionId),
    refused: candidates.filter((entry) => entry.disposition === 'refuse'),
    planSha256,
  };
}

export function applyI3PhantomGrandchildren(database: DatabaseSync, repairedAt = Date.now()) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const previous = database.prepare('SELECT value_json FROM meta WHERE key = ?')
      .get(I3_PHANTOM_REPAIR_AUDIT_KEY) as { value_json: string } | undefined;
    if (previous) {
      database.exec('COMMIT');
      return JSON.parse(previous.value_json) as Record<string, unknown>;
    }
    const plan = planI3PhantomGrandchildren(database);
    const removedBlockIds: string[] = [];
    const removedPassIds: string[] = [];
    for (const candidate of plan.candidates.filter((entry) => entry.disposition === 'repair')) {
      for (const blockId of candidate.blockIds) {
        const block = database.prepare('SELECT pass_id FROM turn_blocks WHERE block_id = ?')
          .get(blockId) as { pass_id: string } | undefined;
        if (!block) throw new Error(`I3 repair plan changed: block ${blockId} disappeared.`);
        database.prepare('DELETE FROM turn_blocks WHERE block_id = ?').run(blockId);
        removedBlockIds.push(blockId);
        const result = database.prepare(`DELETE FROM turn_passes WHERE pass_id = ?
          AND NOT EXISTS (SELECT 1 FROM turn_blocks WHERE pass_id = ?)`).run(block.pass_id, block.pass_id);
        if (Number(result.changes) === 1) removedPassIds.push(block.pass_id);
      }
      const result = database.prepare('DELETE FROM executions WHERE execution_id = ?').run(candidate.executionId);
      if (Number(result.changes) !== 1) throw new Error(`I3 repair plan changed: execution ${candidate.executionId} disappeared.`);
    }
    const audit = {
      ...plan,
      applied: true,
      repairedAt,
      removedExecutionIds: plan.repairExecutionIds,
      removedBlockIds,
      removedPassIds,
      suppressedBlockIds: [...new Set(plan.candidates
        .filter((entry) => entry.disposition === 'repair')
        .flatMap((entry) => entry.evidenceBlockIds))].sort(),
      preservedEvidenceSequences: [...new Set(plan.candidates.flatMap((entry) => entry.evidenceSequences))].sort((a, b) => a - b),
    };
    database.prepare('INSERT INTO meta(key, value_json) VALUES (?, ?)')
      .run(I3_PHANTOM_REPAIR_AUDIT_KEY, JSON.stringify(audit));
    database.exec('COMMIT');
    return audit;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function inspectPhantomCandidate(database: DatabaseSync, row: any, expectedSuffix: string): I3PhantomRepairCandidate {
  const reasons: string[] = [];
  const executionId = String(row.execution_id);
  const parentExecutionId = typeof row.parent_execution_id === 'string' ? row.parent_execution_id : null;
  if (!executionId.endsWith(expectedSuffix)) reasons.push('identity does not have the incident-derived suffix');
  if (!parentExecutionId || executionId !== `${parentExecutionId}${expectedSuffix}`) {
    reasons.push('identity is not the exact derived child of its recorded parent');
  }
  if (row.ownership !== 'native' || row.provider !== 'codex') reasons.push('execution is not a Codex native child');
  const parent = parentExecutionId ? database.prepare(`SELECT e.execution_id, e.parent_execution_id,
      e.conversation_id, e.provider, h.native_session_id
    FROM executions e LEFT JOIN native_child_handles h ON h.execution_id = e.execution_id
    WHERE e.execution_id = ?`).get(parentExecutionId) as any : undefined;
  if (!parent || parent.parent_execution_id !== I3_PHANTOM_INCIDENT.rootExecutionId ||
      parent.conversation_id !== I3_PHANTOM_INCIDENT.conversationId || parent.provider !== 'codex') {
    reasons.push('recorded parent is not a direct Codex child of the approved root');
  }
  if (!parent?.native_session_id) reasons.push('recorded parent has no durable native child handle');

  const count = (sql: string) => Number((database.prepare(sql).get(executionId) as any)?.count ?? 0);
  if (count('SELECT COUNT(*) count FROM turns WHERE execution_id = ?')) reasons.push('execution has genuine turns');
  if (count('SELECT COUNT(*) count FROM native_child_handles WHERE execution_id = ?')) reasons.push('execution has a native child handle');
  if (count('SELECT COUNT(*) count FROM native_sessions WHERE execution_id = ?')) reasons.push('execution has a native session');
  if (count('SELECT COUNT(*) count FROM events WHERE execution_id = ?')) reasons.push('execution owns scoped events');
  if (count('SELECT COUNT(*) count FROM executions WHERE parent_execution_id = ?')) reasons.push('execution has descendants');
  for (const [table, column] of [['native_turn_bindings', 'native_session_execution_id'],
    ['federation_checkout_reservations', 'execution_id']] as const) {
    if (tableHasColumn(database, table, column) &&
        count(`SELECT COUNT(*) count FROM ${table} WHERE ${column} = ?`)) reasons.push(`execution has durable ${table} rows`);
  }
  const explicitlyChecked = new Set([
    'executions.parent_execution_id', 'turns.execution_id', 'native_child_handles.execution_id',
    'native_sessions.execution_id', 'events.execution_id', 'native_turn_bindings.native_session_execution_id',
    'federation_checkout_reservations.execution_id',
  ]);
  for (const reference of executionForeignKeys(database)) {
    if (explicitlyChecked.has(`${reference.table}.${reference.column}`)) continue;
    if (count(`SELECT COUNT(*) count FROM ${reference.table} WHERE ${reference.column} = ?`)) {
      reasons.push(`execution has durable ${reference.table}.${reference.column} references`);
    }
  }

  const blocks = database.prepare(`SELECT block_id, turn_id, kind, payload_json FROM turn_blocks
    WHERE json_extract(payload_json, '$.child.executionId') = ? ORDER BY block_id`).all(executionId) as any[];
  const references = database.prepare(`SELECT sequence, execution_id, turn_id, native_kind, envelope_json FROM events
    WHERE conversation_id = ? AND json_extract(envelope_json, '$.event.block.payload.child.executionId') = ?
    ORDER BY sequence`).all(I3_PHANTOM_INCIDENT.conversationId, executionId) as any[];
  if (references.length === 0) reasons.push('execution has no archived interaction evidence');
  const blockIds = blocks.map((block) => String(block.block_id));
  for (const block of blocks) {
    let payload: any;
    try { payload = JSON.parse(block.payload_json); } catch { reasons.push(`block ${block.block_id} has invalid payload`); continue; }
    if (block.kind !== 'native-child' || payload?.kind !== 'native-child' ||
        payload?.child?.executionId !== executionId || payload?.child?.ownership !== 'native' ||
        payload?.child?.provider !== 'codex') reasons.push(`block ${block.block_id} is not an exact native-child projection`);
    const turn = database.prepare('SELECT execution_id, conversation_id FROM turns WHERE turn_id = ?').get(block.turn_id) as any;
    if (!turn || turn.execution_id !== parentExecutionId || turn.conversation_id !== I3_PHANTOM_INCIDENT.conversationId) {
      reasons.push(`block ${block.block_id} is not owned by the recorded parent turn`);
    }
    if (!references.some((event) => eventMatchesBlock(event, block, parentExecutionId, parent?.native_session_id))) {
      reasons.push(`block ${block.block_id} lacks exact child/interacted evidence from the parent native session`);
    }
  }
  for (const event of references) {
    const envelope = safeEnvelope(event.envelope_json);
    const block = blocks.find((entry) => entry.block_id === envelope?.event?.structure?.blockId);
    if (block ? !eventMatchesBlock(event, block, parentExecutionId, parent?.native_session_id) :
      !eventMatchesArchivedProjection(database, event, executionId, parentExecutionId, parent?.native_session_id)) {
      reasons.push(`event ${event.sequence} is an ambiguous reference to the execution`);
    }
  }
  return {
    executionId,
    parentExecutionId,
    disposition: reasons.length === 0 ? 'repair' : 'refuse',
    reasons: [...new Set(reasons)],
    blockIds,
    evidenceSequences: references.map((event) => Number(event.sequence)),
    evidenceBlockIds: [...new Set(references.map((event) => safeEnvelope(event.envelope_json)?.event?.structure?.blockId)
      .filter((blockId): blockId is string => typeof blockId === 'string'))].sort(),
    evidenceSha256: createHash('sha256').update(references.map((event) => event.envelope_json).join('\n')).digest('hex'),
  };
}

function eventMatchesBlock(event: any, block: any, parentExecutionId: string | null, nativeSessionId: string | undefined) {
  const envelope = safeEnvelope(event.envelope_json);
  return event.native_kind === 'child/interacted' && event.execution_id === parentExecutionId &&
    event.turn_id === block.turn_id && envelope?.scope?.conversationId === I3_PHANTOM_INCIDENT.conversationId &&
    envelope?.scope?.executionId === parentExecutionId && envelope?.scope?.turnId === block.turn_id &&
    envelope?.native?.kind === 'child/interacted' && envelope?.native?.sessionId === nativeSessionId &&
    envelope?.event?.structure?.blockId === block.block_id &&
    envelope?.event?.block?.payload?.child?.executionId === JSON.parse(block.payload_json).child.executionId;
}

function eventMatchesArchivedProjection(database: DatabaseSync, event: any, executionId: string,
  parentExecutionId: string | null, nativeSessionId: string | undefined) {
  const envelope = safeEnvelope(event.envelope_json);
  const turn = database.prepare('SELECT execution_id, conversation_id FROM turns WHERE turn_id = ?').get(event.turn_id) as any;
  const child = envelope?.event?.block?.payload?.child;
  return event.native_kind === 'child/interacted' && event.execution_id === parentExecutionId &&
    turn?.execution_id === parentExecutionId && turn?.conversation_id === I3_PHANTOM_INCIDENT.conversationId &&
    envelope?.scope?.conversationId === I3_PHANTOM_INCIDENT.conversationId &&
    envelope?.scope?.executionId === parentExecutionId && envelope?.scope?.turnId === event.turn_id &&
    envelope?.native?.kind === 'child/interacted' && envelope?.native?.sessionId === nativeSessionId &&
    typeof envelope?.event?.structure?.blockId === 'string' && envelope?.event?.block?.payload?.kind === 'native-child' &&
    child?.executionId === executionId && child?.ownership === 'native' && child?.provider === 'codex';
}

function safeEnvelope(value: string) {
  try { return JSON.parse(value) as any; } catch { return undefined; }
}

function tableHasColumn(database: DatabaseSync, table: string, column: string) {
  const exists = database.prepare('SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?').get('table', table);
  if (!exists) return false;
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((entry) => entry.name === column);
}

function executionForeignKeys(database: DatabaseSync) {
  const references: Array<{ table: string; column: string }> = [];
  const tables = database.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/iu.test(name)) continue;
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${name})`).all() as
      Array<{ table: string; from: string; to: string }>;
    for (const foreignKey of foreignKeys) {
      if (foreignKey.table === 'executions' && foreignKey.to === 'execution_id' &&
          /^[a-z_][a-z0-9_]*$/iu.test(foreignKey.from)) references.push({ table: name, column: foreignKey.from });
    }
  }
  return references;
}
