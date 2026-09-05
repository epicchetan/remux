import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const I3_REPAIR_AUDIT_KEY = 'repair_i3_native_child_identity_v1';

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
