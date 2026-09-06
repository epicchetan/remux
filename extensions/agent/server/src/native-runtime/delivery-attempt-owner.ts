import { createHash, randomUUID } from 'node:crypto';
import { parseProviderEventEnvelope, type ProviderEventEnvelope, type ProviderKind } from '../../../shared/provider-runtime.ts';
import type { NativeAgentJournal } from './native-journal.ts';
import { CodexRequestError } from '../providers/codex/codex-app-server-connection.ts';
import type {
  DeliveryAttemptKind, DispatchBoundary, FrozenDeliveryAttempt, ProviderAcceptanceEvidence,
  ProviderDispatchResult, ProviderPositiveRead, StagedProviderEnvelope,
} from './delivery-contract.ts';

const MAX_STAGE_BYTES = 64 * 1024 * 1024;
const MAX_STAGE_ROW_BYTES = 32 * 1024 * 1024;

export type PrepareDeliveryAttempt = {
  attemptId?: string; commandId: string; kind: DeliveryAttemptKind; provider: ProviderKind;
  providerInstanceId: string; conversationId: string; executionId: string;
  intendedTurnId?: string; clientMessageId?: string; nativeClientMessageId?: string;
  compactOperationId?: string; recoveryPayload: Record<string, unknown>; nativeSessionId: string;
  processGeneration?: string; ownerInstanceId: string; now: number;
};
export type PreparedDeliveryStage = {
  staged: readonly StagedProviderEnvelope[];
  sourceObservationIds: readonly string[];
};

function isPreparedDeliveryStage(
  value: readonly StagedProviderEnvelope[] | PreparedDeliveryStage,
): value is PreparedDeliveryStage {
  return !Array.isArray(value);
}

export class DeliveryAttemptOwner {
  private readonly journal: NativeAgentJournal;
  private readonly now: () => number;
  private readonly ownerInstanceId: string;

  constructor(journal: NativeAgentJournal, now: () => number, ownerInstanceId: string) {
    this.journal = journal;
    this.now = now;
    this.ownerInstanceId = ownerInstanceId;
  }

  prepare(input: PrepareDeliveryAttempt): FrozenDeliveryAttempt {
    if (input.ownerInstanceId !== this.ownerInstanceId) {
      throw new Error('Delivery attempt preparation owner does not match this owner instance.');
    }
    const payloadJson = canonicalJson(input.recoveryPayload);
    const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
    if (Buffer.byteLength(payloadJson) > 64 * 1024 * 1024) throw new Error('Delivery recovery payload exceeds 64 MiB.');
    validatePrepareIdentifiers(input);
    const previous = this.byCommand(input.commandId);
    if (previous) {
      if (previous.kind !== input.kind || previous.recoveryPayloadHash !== payloadHash ||
          previous.provider !== input.provider || previous.providerInstanceId !== input.providerInstanceId ||
          previous.conversationId !== input.conversationId || previous.executionId !== input.executionId ||
          previous.intendedTurnId !== input.intendedTurnId || previous.clientMessageId !== input.clientMessageId ||
          previous.nativeClientMessageId !== input.nativeClientMessageId || previous.nativeSessionId !== input.nativeSessionId ||
          previous.compactOperationId !== input.compactOperationId ||
          (input.processGeneration !== undefined && previous.processGeneration !== input.processGeneration)) {
        throw new Error('Delivery command ID was reused with different immutable input.');
      }
      return previous;
    }
    this.validateScope(input, payloadJson);
    this.journal.database.prepare(`INSERT INTO delivery_attempts(
      attempt_id,command_id,kind,provider,provider_instance_id,conversation_id,execution_id,
      intended_turn_id,client_message_id,native_client_message_id,compact_operation_id,
      recovery_payload_hash,recovery_payload_json,native_session_id,process_generation,
      owner_instance_id,state,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.attemptId ?? randomUUID(), input.commandId, input.kind, input.provider,
      input.providerInstanceId, input.conversationId, input.executionId,
      input.intendedTurnId ?? null, input.clientMessageId ?? null, input.nativeClientMessageId ?? null,
      input.compactOperationId ?? null, payloadHash, payloadJson, input.nativeSessionId,
      input.processGeneration ?? null, input.ownerInstanceId, 'preparing', input.now, input.now,
    );
    return this.byCommand(input.commandId)!;
  }

  async dispatch<T>(attemptId: string,
    invoke: (boundary: DispatchBoundary) => Promise<ProviderDispatchResult>,
    admit: (attempt: FrozenDeliveryAttempt, staged: readonly StagedProviderEnvelope[]) => T,
    prepare?: (staged: readonly StagedProviderEnvelope[]) => Promise<readonly StagedProviderEnvelope[] | PreparedDeliveryStage>,
  ): Promise<{ outcome: ProviderDispatchResult['outcome']; result: ProviderDispatchResult; value?: T }> {
    const initial = this.require(attemptId);
    if (initial.ownerInstanceId !== this.ownerInstanceId) {
      throw new Error('Delivery attempt belongs to another owner instance.');
    }
    if (initial.state !== 'preparing') {
      throw new Error('Only a preparing delivery attempt can be dispatched.');
    }
    let crossed = false;
    const boundary: DispatchBoundary = { markPossiblySent: (sessionId, generation) => {
      if (crossed) throw new Error('Delivery crossing marker may only be used once.');
      const attempt = this.require(attemptId);
      if (attempt.ownerInstanceId !== this.ownerInstanceId) {
        throw new Error('Delivery attempt belongs to another owner instance.');
      }
      if (sessionId !== attempt.nativeSessionId ||
          (attempt.processGeneration !== undefined && generation !== attempt.processGeneration)) {
        throw new Error('Delivery crossing scope does not match the frozen native session.');
      }
      const now = this.transitionTime(attemptId);
      const changed = this.journal.database.prepare(`UPDATE delivery_attempts SET state='dispatching',
        crossed_at=?,native_session_id=?,process_generation=COALESCE(?,process_generation),updated_at=?
        WHERE attempt_id=? AND state='preparing' AND owner_instance_id=? AND native_session_id=?`).run(
          now, sessionId, generation ?? null, now, attemptId, this.ownerInstanceId, attempt.nativeSessionId).changes;
      if (changed !== 1) throw new Error('Delivery attempt cannot cross from its current state.');
      crossed = true;
    }};
    let result: ProviderDispatchResult;
    try { result = await invoke(boundary); }
    catch (error) {
      const persistedCrossing = this.get(attemptId)?.crossedAt !== undefined;
      const signalledCrossing = providerPossiblySent(error);
      if (!persistedCrossing && signalledCrossing) {
        this.markProviderSignalledCrossing(attemptId, 'thrown-possibly-sent-without-marker');
      }
      result = persistedCrossing || signalledCrossing
        ? { accepted: false, outcome: 'unknown', crossing: { phase: 'possibly-sent', detail: 'response-lost' }, error: deliveryError(error) }
        : { accepted: false, outcome: 'rejected', crossing: { phase: 'not-sent', detail: 'preparation' }, error: deliveryError(error) };
    }
    const persistedCrossing = this.require(attemptId).crossedAt !== undefined;
    if (result.outcome === 'rejected') {
      if (persistedCrossing) {
        this.unknown(attemptId, { ...result.error, boundaryViolation: 'rejected-after-crossing' });
        return { outcome: 'unknown', result };
      }
      this.reject(attemptId, result.error);
      return { outcome: 'rejected', result };
    }
    if (result.outcome === 'unknown') {
      if (!persistedCrossing) this.markProviderSignalledCrossing(attemptId, 'unknown-without-marker');
      this.unknown(attemptId, result.error);
      return { outcome: 'unknown', result };
    }
    if (!persistedCrossing) this.markProviderSignalledCrossing(attemptId, 'accepted-without-marker');
    if ((result.evidence.kind === 'codex-turn-start-response' && result.nativeTurnId !== result.evidence.turnId) ||
        (result.evidence.kind === 'fixture-correlated-acceptance' && result.evidence.nativeTurnId !== undefined &&
          result.nativeTurnId !== result.evidence.nativeTurnId)) {
      throw new Error('Provider native turn result contradicts its acceptance evidence.');
    }
    this.recordAcceptance(attemptId, result.evidence, result.nativeTurnId, result.nativeOperationId);
    const staged = this.staged(attemptId);
    let prepared = staged;
    let sourceObservationIds = staged.map(({ observationId }) => observationId);
    try {
      if (prepare) {
        const result = await prepare(staged);
        if (isPreparedDeliveryStage(result)) {
          prepared = [...result.staged];
          sourceObservationIds = [...result.sourceObservationIds];
        } else prepared = [...result];
      }
    } catch (error) {
      this.markGap(attemptId, `preparation:${deliveryError(error).message}`, this.now());
      return { outcome: 'unknown', result: {
        accepted: false, outcome: 'unknown',
        crossing: { phase: 'possibly-sent', detail: 'response-lost' },
        error: deliveryError(error),
      } };
    }
    return { outcome: 'accepted', result, value: this.admit(
      attemptId,
      admit,
      prepared,
      sourceObservationIds,
    ) };
  }

  recordAcceptance(attemptId: string, evidence: ProviderAcceptanceEvidence, nativeTurnId?: string, nativeOperationId?: string) {
    const attempt = this.require(attemptId);
    if (evidence.kind === 'claude-manual-compact-boundary' && attempt.transcriptGap &&
        !attempt.acceptanceEvidence) {
      throw new Error('Claude Compact boundary cannot prove acceptance after a transcript gap.');
    }
    this.validateEvidence(attempt, evidence);
    const json = JSON.stringify(evidence); if (Buffer.byteLength(json) > 65536) throw new Error('Acceptance evidence exceeds 64 KiB.');
    this.journal.transaction(() => {
      const current = this.require(attemptId);
      if (current.acceptanceEvidence) {
        this.validateEvidence(current, current.acceptanceEvidence);
        if (!evidenceCompatible(current.acceptanceEvidence, evidence)) {
          throw new Error('Contradictory delivery acceptance evidence.');
        }
        if (nativeTurnId && current.nativeTurnId && nativeTurnId !== current.nativeTurnId) {
          throw new Error('Contradictory native turn identity in delivery acceptance evidence.');
        }
        return;
      }
      const changed = this.journal.database.prepare(`UPDATE delivery_attempts SET acceptance_evidence_json=?,
        native_turn_id=COALESCE(?,native_turn_id),native_operation_id=COALESCE(?,native_operation_id),updated_at=?
        WHERE attempt_id=? AND state IN ('dispatching','unknown')`).run(json, nativeTurnId ?? null,
          nativeOperationId ?? null, this.transitionTime(attemptId), attemptId).changes;
      if (changed !== 1) throw new Error('Delivery acceptance proof could not be persisted.');
    });
  }

  observe(attemptId: string, envelope: ProviderEventEnvelope) {
    const attempt = this.require(attemptId);
    const observedExecutionId = envelope.scope.kind === 'account' ? undefined : envelope.scope.executionId;
    const declaredChildSession = observedExecutionId !== undefined && observedExecutionId !== attempt.executionId
      ? this.staged(attemptId).map(({ envelope: parent }) =>
          declaredNativeChildSession(parent, observedExecutionId)).find(Boolean)
      : undefined;
    validateEnvelopeScope(attempt, envelope, declaredChildSession);
    const json = JSON.stringify(envelope); const bytes = Buffer.byteLength(json); const now = envelope.observedAt;
    return this.journal.transaction(() => {
      const duplicate = this.journal.database.prepare(`SELECT envelope_json FROM delivery_attempt_staging
        WHERE attempt_id=? AND observation_id=?`).get(attemptId, envelope.eventId) as
        { envelope_json: string } | undefined;
      if (duplicate) {
        if (duplicate.envelope_json === json) return { staged: false, duplicate: true } as const;
        this.markGap(attemptId, 'observation_identity_conflict', now);
        return { staged: false, conflict: true } as const;
      }
      const row = this.journal.database.prepare(`SELECT COUNT(*) count,
        COALESCE(SUM(byte_length),0) bytes FROM delivery_attempt_staging WHERE attempt_id=?`
      ).get(attemptId) as { count: number; bytes: number };
      if (row.count >= 256 || bytes > MAX_STAGE_ROW_BYTES || row.bytes + bytes > MAX_STAGE_BYTES) {
        this.markGap(attemptId, 'stage_overflow', now); return { staged: false, overflow: true } as const;
      }
      this.journal.database.prepare(`INSERT INTO delivery_attempt_staging(
        attempt_id,ordinal,observation_id,envelope_json,byte_length,observed_at
      ) VALUES(?,?,?,?,?,?)`)
        .run(attemptId, row.count, envelope.eventId, json, bytes, now);
      return { staged: true } as const;
    });
  }

  ownsObservation(attemptId: string, envelope: ProviderEventEnvelope) {
    const attempt = this.require(attemptId);
    if (envelope.scope.kind !== 'turn' ||
        envelope.scope.providerInstanceId !== attempt.providerInstanceId ||
        envelope.scope.conversationId !== attempt.conversationId) return false;
    if (envelope.scope.executionId === attempt.executionId) {
      return envelope.scope.turnId === attempt.intendedTurnId &&
        envelope.native.sessionId === attempt.nativeSessionId;
    }
    const childExecutionId = envelope.scope.executionId;
    const childSession = this.staged(attemptId).map(({ envelope: parent }) =>
      declaredNativeChildSession(parent, childExecutionId)).find(Boolean);
    return childSession !== undefined && envelope.native.sessionId === childSession;
  }

  markStreamGap(executionId: string, generation: string, reason: string) {
    const rows = this.journal.database.prepare(`SELECT attempt_id FROM delivery_attempts WHERE execution_id=? AND process_generation=? AND state IN ('dispatching','unknown')`).all(executionId, generation) as Array<{ attempt_id: string }>;
    for (const row of rows) this.markGap(row.attempt_id, reason, this.transitionTime(row.attempt_id));
  }

  async reconcile<T>(attemptId: string, read: ProviderPositiveRead,
    admit: (attempt: FrozenDeliveryAttempt, staged: readonly StagedProviderEnvelope[]) => T,
    prepare?: (staged: readonly StagedProviderEnvelope[]) => Promise<readonly StagedProviderEnvelope[] | PreparedDeliveryStage>) {
    let attempt = this.require(attemptId);
    if (attempt.acceptanceEvidence) {
      const staged = this.staged(attemptId);
      const result = prepare ? await prepare(staged) : staged;
      const prepared = isPreparedDeliveryStage(result) ? result.staged : result;
      const sourceIds = isPreparedDeliveryStage(result)
        ? result.sourceObservationIds : staged.map(({ observationId }) => observationId);
      return { outcome: 'accepted' as const, value: this.admit(attemptId, admit, prepared, sourceIds) };
    }
    const presence = await read(attempt);
    if (presence.presence !== 'present') return { outcome: 'unknown' as const };
    const nativeTurnId = presence.evidence.kind === 'codex-history-client-id'
      ? presence.evidence.nativeTurnId : presence.evidence.kind === 'fixture-correlated-acceptance'
        ? presence.evidence.nativeTurnId : undefined;
    this.recordAcceptance(attemptId, presence.evidence, nativeTurnId); attempt = this.require(attemptId);
    const staged = this.staged(attemptId);
    const result = prepare ? await prepare(staged) : staged;
    const prepared = isPreparedDeliveryStage(result) ? result.staged : result;
    const sourceIds = isPreparedDeliveryStage(result)
      ? result.sourceObservationIds : staged.map(({ observationId }) => observationId);
    return { outcome: 'accepted' as const, value: this.admit(attemptId, admit, prepared, sourceIds) };
  }

  unresolvedLane(conversationId: string) {
    const row = this.journal.database.prepare(`SELECT attempt_id FROM delivery_attempts WHERE conversation_id=? AND state IN ('preparing','dispatching','unknown') ORDER BY created_at LIMIT 1`).get(conversationId) as { attempt_id: string } | undefined;
    return row ? this.get(row.attempt_id) : undefined;
  }
  acceptedWithStage(executionId: string) {
    const row = this.journal.database.prepare(`SELECT a.attempt_id FROM delivery_attempts a
      WHERE a.execution_id=? AND a.state='accepted' AND EXISTS(
        SELECT 1 FROM delivery_attempt_staging s WHERE s.attempt_id=a.attempt_id)
      ORDER BY a.created_at LIMIT 1`).get(executionId) as { attempt_id: string } | undefined;
    return row ? this.require(row.attempt_id) : undefined;
  }
  drainAccepted(attemptId: string, prepared: readonly StagedProviderEnvelope[],
    sourceObservationIds: readonly string[], append: (events: readonly ProviderEventEnvelope[]) => void) {
    this.journal.transaction(() => {
      if (this.require(attemptId).state !== 'accepted') throw new Error('Only an accepted attempt can drain its suffix.');
      append(prepared.map(({ envelope }) => envelope));
      this.deleteStagedPrefix(attemptId, sourceObservationIds);
    });
  }
  get(id: string) {
    const row = this.journal.database.prepare(
      'SELECT * FROM delivery_attempts WHERE attempt_id=?',
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.decodeVerified(row) : undefined;
  }

  byCommand(id: string) {
    const row = this.journal.database.prepare(
      'SELECT * FROM delivery_attempts WHERE command_id=?',
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.decodeVerified(row) : undefined;
  }

  staged(id: string): StagedProviderEnvelope[] {
    const rows = this.journal.database.prepare(`SELECT * FROM delivery_attempt_staging
      WHERE attempt_id=? ORDER BY ordinal`).all(id) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ordinal: Number(row.ordinal),
      observationId: String(row.observation_id),
      envelope: parseProviderEventEnvelope(JSON.parse(String(row.envelope_json))),
      byteLength: Number(row.byte_length),
      observedAt: Number(row.observed_at),
    }));
  }

  recover() {
    let cursorCreatedAt = -1;
    let cursorAttemptId = '';
    while (true) {
      const rows = this.journal.database.prepare(`SELECT attempt_id,created_at FROM delivery_attempts
        WHERE state IN ('preparing','dispatching')
          AND (created_at>? OR (created_at=? AND attempt_id>?))
        ORDER BY created_at,attempt_id LIMIT 256`).all(
          cursorCreatedAt, cursorCreatedAt, cursorAttemptId,
        ) as Array<{ attempt_id: string; created_at: number }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const attempt = this.require(row.attempt_id);
        const now = this.transitionTime(attempt.attemptId);
        if (attempt.state === 'preparing' && attempt.ownerInstanceId !== this.ownerInstanceId) {
          this.markRecovery(attempt.attemptId, 'owner_unresolved', now);
        } else if (attempt.state === 'dispatching') {
          this.journal.database.prepare(`UPDATE delivery_attempts SET state='unknown',
            unknown_at=?,updated_at=? WHERE attempt_id=? AND state='dispatching'`)
            .run(now, now, attempt.attemptId);
        }
      }
      const last = rows.at(-1)!;
      cursorCreatedAt = last.created_at;
      cursorAttemptId = last.attempt_id;
    }
  }

  private admit<T>(id: string,
    fn: (attempt: FrozenDeliveryAttempt, staged: readonly StagedProviderEnvelope[]) => T,
    prepared?: readonly StagedProviderEnvelope[], drainedIds?: readonly string[]) {
    return this.journal.transaction(() => {
      const attempt = this.require(id);
      if (attempt.state === 'accepted') return undefined as T;
      if (!attempt.acceptanceEvidence) {
        throw new Error('Delivery admission requires durable positive evidence.');
      }
      const staged = prepared ?? this.staged(id);
      const value = fn(attempt, staged);
      const now = this.transitionTime(id);
      const changed = this.journal.database.prepare(`UPDATE delivery_attempts SET state='accepted',
        accepted_at=?,unknown_at=NULL,updated_at=? WHERE attempt_id=?
        AND state IN ('dispatching','unknown')`).run(now, now, id).changes;
      if (changed !== 1) throw new Error('Delivery attempt acceptance CAS failed.');
      const ids = drainedIds ?? staged.map(({ observationId }) => observationId);
      this.deleteStagedPrefix(id, ids);
      return value;
    });
  }

  private reject(id: string, error: unknown) {
    const now = this.transitionTime(id);
    const changed = this.journal.database.prepare(`UPDATE delivery_attempts SET state='rejected',
      rejected_at=?,rejection_json=?,updated_at=? WHERE attempt_id=? AND state='preparing'`)
      .run(now, JSON.stringify(boundedDeliveryError(error)), now, id).changes;
    if (changed !== 1) throw new Error('Delivery rejection CAS failed.');
  }

  private unknown(id: string, error: unknown) {
    const now = this.transitionTime(id);
    this.journal.database.prepare(`UPDATE delivery_attempts SET state='unknown',
      unknown_at=?,recovery_json=?,updated_at=? WHERE attempt_id=? AND state='dispatching'`)
      .run(now, this.recoveryDetail(id, { transport: boundedDeliveryError(error) }), now, id);
  }

  private markProviderSignalledCrossing(id: string, violation: string) {
    const attempt = this.require(id);
    const now = this.transitionTime(id);
    const changed = this.journal.database.prepare(`UPDATE delivery_attempts
      SET state='dispatching',crossed_at=?,updated_at=?,recovery_json=?
      WHERE attempt_id=? AND state='preparing' AND owner_instance_id=?`).run(
        now, now, this.recoveryDetail(id, { boundary_violation: violation }), id,
        attempt.ownerInstanceId,
      ).changes;
    if (changed !== 1) throw new Error('Provider crossing signal could not retain its delivery hold.');
  }

  private markGap(id: string, reason: string, _observedAt: number) {
    const now = this.transitionTime(id);
    const recovery = this.recoveryDetail(id, { stage_overflow: { reason: reason.slice(0, 4_096) } });
    this.journal.database.prepare(`UPDATE delivery_attempts SET transcript_gap=1,
      recovery_json=?,state=CASE WHEN state='dispatching' THEN 'unknown' ELSE state END,
      unknown_at=CASE WHEN state='dispatching' THEN ? ELSE unknown_at END,updated_at=?
      WHERE attempt_id=?`).run(recovery, now, now, id);
  }

  private markRecovery(id: string, reason: string, now: number) {
    this.journal.database.prepare(
      'UPDATE delivery_attempts SET recovery_json=?,updated_at=? WHERE attempt_id=?',
    ).run(this.recoveryDetail(id, { [reason]: true }), now, id);
  }

  private recoveryDetail(id: string, detail: Record<string, unknown>) {
    const row = this.journal.database.prepare(
      'SELECT recovery_json FROM delivery_attempts WHERE attempt_id=?',
    ).get(id) as { recovery_json: string | null } | undefined;
    const previous = row?.recovery_json ? JSON.parse(row.recovery_json) as Record<string, unknown> : {};
    const encoded = JSON.stringify({ ...previous, ...detail });
    if (Buffer.byteLength(encoded) <= 65_536) return encoded;
    return JSON.stringify({ truncated: true, latest: boundedDeliveryError(detail) });
  }

  private deleteStagedPrefix(attemptId: string, observationIds: readonly string[]) {
    if (observationIds.length === 0) return;
    this.journal.database.prepare(`DELETE FROM delivery_attempt_staging
      WHERE attempt_id=? AND observation_id IN (${observationIds.map(() => '?').join(',')})`
    ).run(attemptId, ...observationIds);
    const retained = this.journal.database.prepare(`SELECT observation_id,envelope_json,byte_length,observed_at
      FROM delivery_attempt_staging WHERE attempt_id=? ORDER BY ordinal`).all(attemptId) as Array<{
        observation_id: string; envelope_json: string; byte_length: number; observed_at: number;
      }>;
    this.journal.database.prepare(
      'DELETE FROM delivery_attempt_staging WHERE attempt_id=?',
    ).run(attemptId);
    const insert = this.journal.database.prepare(`INSERT INTO delivery_attempt_staging(
      attempt_id,ordinal,observation_id,envelope_json,byte_length,observed_at
    ) VALUES(?,?,?,?,?,?)`);
    for (let index = 0; index < retained.length; index += 1) {
      const row = retained[index]!;
      insert.run(attemptId, index, row.observation_id, row.envelope_json,
        row.byte_length, row.observed_at);
    }
  }

  private require(id: string) {
    const attempt = this.get(id);
    if (!attempt) throw new Error('Delivery attempt not found.');
    return attempt;
  }

  private decodeVerified(row: Record<string, unknown>) {
    const json = requiredString(row.recovery_payload_json, 'recovery_payload_json', 64 * 1024 * 1024);
    const storedHash = requiredString(row.recovery_payload_hash, 'recovery_payload_hash', 64);
    const hash = createHash('sha256').update(json).digest('hex');
    if (hash !== storedHash) {
      throw new Error('Delivery recovery payload hash does not match its durable body.');
    }
    const attempt = decodeAttempt(row);
    validateDecodedRootPayload(attempt);
    if (attempt.acceptanceEvidence) this.validateEvidence(attempt, attempt.acceptanceEvidence);
    return attempt;
  }

  private transitionTime(id: string) {
    const row = this.journal.database.prepare(`SELECT created_at,updated_at,crossed_at
      FROM delivery_attempts WHERE attempt_id=?`).get(id) as Record<string, unknown> | undefined;
    return Math.max(this.now(), Number(row?.created_at ?? 0), Number(row?.updated_at ?? 0),
      Number(row?.crossed_at ?? 0));
  }
  private validateScope(input: PrepareDeliveryAttempt, payloadJson: string) {
    validatePrepareIdentifiers(input);
    const provider = this.journal.database.prepare(
      'SELECT provider FROM provider_instances WHERE provider_instance_id=?',
    ).get(input.providerInstanceId) as { provider: string } | undefined;
    const conversation = this.journal.database.prepare(
      'SELECT provider_instance_id,root_execution_id,active_turn_id FROM conversations WHERE conversation_id=?',
    ).get(input.conversationId) as Record<string, unknown> | undefined;
    const execution = this.journal.database.prepare(
      'SELECT conversation_id,provider_instance_id FROM executions WHERE execution_id=?',
    ).get(input.executionId) as Record<string, unknown> | undefined;
    const session = this.journal.database.prepare(
      'SELECT native_session_id,provider_instance_id FROM native_sessions WHERE execution_id=?',
    ).get(input.executionId) as Record<string, unknown> | undefined;
    if (provider?.provider !== input.provider ||
        conversation?.provider_instance_id !== input.providerInstanceId ||
        conversation.root_execution_id !== input.executionId ||
        execution?.conversation_id !== input.conversationId ||
        execution.provider_instance_id !== input.providerInstanceId ||
        session?.native_session_id !== input.nativeSessionId ||
        session.provider_instance_id !== input.providerInstanceId) {
      throw new Error('Delivery attempt scope does not match its provider, conversation, execution, and native session.');
    }
    const payload = parseRecordJson(payloadJson, 'delivery recovery payload');
    if (input.kind === 'steer') {
      const allowed = new Set(['turnId', 'clientMessageId', 'nativeClientMessageId', 'content',
        'model', 'effort', 'serviceTier', 'access', 'expectedNativeTurnId']);
      const receipt = this.journal.database.prepare(
        'SELECT kind,state FROM command_receipts WHERE command_id=?',
      ).get(input.commandId) as Record<string, unknown> | undefined;
      const turn = this.journal.database.prepare(`SELECT turn_id,conversation_id,execution_id,
        native_turn_id,state FROM turns WHERE turn_id=?`).get(input.intendedTurnId!) as
        Record<string, unknown> | undefined;
      if (!exactKeys(payload, allowed) || payload.turnId !== input.intendedTurnId ||
          payload.clientMessageId !== input.clientMessageId ||
          payload.nativeClientMessageId !== input.nativeClientMessageId ||
          receipt?.kind !== 'turn.send' || receipt.state !== 'dispatching' ||
          turn?.conversation_id !== input.conversationId || turn.execution_id !== input.executionId ||
          conversation.active_turn_id !== input.intendedTurnId ||
          !['running', 'recovering'].includes(String(turn.state)) ||
          turn.native_turn_id !== payload.expectedNativeTurnId) {
        throw new Error('Delivery steer attempt does not match its active turn and frozen input.');
      }
      return;
    }
    if (input.kind === 'manual-compact') {
      const allowed = new Set(['operationId', 'nativeInputUuid']);
      const operation = this.journal.database.prepare(`SELECT command_id,conversation_id,trigger,state
        FROM compaction_operations WHERE operation_id=?`).get(input.compactOperationId!) as
        Record<string, unknown> | undefined;
      const receipt = this.journal.database.prepare(
        'SELECT kind,state FROM command_receipts WHERE command_id=?',
      ).get(input.commandId) as Record<string, unknown> | undefined;
      if (!exactKeys(payload, allowed) || payload.operationId !== input.compactOperationId ||
          (payload.nativeInputUuid ?? undefined) !== input.nativeClientMessageId ||
          operation?.command_id !== input.commandId || operation.conversation_id !== input.conversationId ||
          receipt?.kind !== 'conversation.compact' ||
          !['dispatching', 'accepted'].includes(String(receipt.state)) ||
          operation.trigger !== 'manual' || operation.state !== 'running') {
        throw new Error('Delivery Compact attempt does not match its running manual operation.');
      }
      return;
    }
    const allowed = new Set(['turnId', 'clientMessageId', 'nativeClientMessageId', 'content',
      'model', 'effort', 'serviceTier', 'access']);
    if (!exactKeys(payload, allowed) ||
        payload.turnId !== input.intendedTurnId ||
        payload.clientMessageId !== input.clientMessageId ||
        payload.nativeClientMessageId !== input.nativeClientMessageId) {
      throw new Error('Delivery payload identities or fields do not match the root-turn allowlist.');
    }
    const receipt = this.journal.database.prepare(
      'SELECT kind,state FROM command_receipts WHERE command_id=?',
    ).get(input.commandId) as Record<string, unknown> | undefined;
    const queued = this.journal.database.prepare(`SELECT turn_id,client_message_id,content_json,
      model,effort,service_tier,access FROM queued_messages WHERE command_id=? AND conversation_id=?`
    ).get(input.commandId, input.conversationId) as Record<string, unknown> | undefined;
    if (receipt?.kind !== 'turn.send' || receipt.state !== 'accepted' || !queued ||
        queued.turn_id !== input.intendedTurnId || queued.client_message_id !== input.clientMessageId ||
        canonicalJson(JSON.parse(requiredString(queued.content_json, 'queued content', 64 * 1024 * 1024))) !== canonicalJson(payload.content) ||
        queued.model !== payload.model || (queued.effort ?? undefined) !== payload.effort ||
        (queued.service_tier ?? undefined) !== payload.serviceTier || queued.access !== payload.access) {
      throw new Error('Delivery root attempt does not match its accepted queued intent.');
    }
  }

  private validateEvidence(attempt: FrozenDeliveryAttempt, evidence: ProviderAcceptanceEvidence) {
    validateRootEvidence(attempt, evidence);
  }
}

function validateEnvelopeScope(attempt: FrozenDeliveryAttempt, envelope: ProviderEventEnvelope,
  declaredChildSession?: string) {
  if (envelope.provider !== attempt.provider || envelope.scope.kind === 'account' ||
      envelope.scope.providerInstanceId !== attempt.providerInstanceId ||
      envelope.scope.conversationId !== attempt.conversationId) {
    throw new Error('Provider observation does not match delivery scope.');
  }
  if (envelope.scope.executionId !== attempt.executionId && !declaredChildSession) {
    throw new Error('Provider observation execution is outside the unresolved root boundary.');
  }
  if (attempt.kind !== 'manual-compact' && envelope.scope.kind === 'turn' &&
      envelope.scope.executionId === attempt.executionId &&
      envelope.scope.turnId !== attempt.intendedTurnId) {
    throw new Error('Provider observation turn is outside the unresolved root boundary.');
  }
  const expectedSession = envelope.scope.executionId === attempt.executionId
    ? attempt.nativeSessionId : declaredChildSession;
  if (envelope.native.sessionId !== expectedSession) {
    throw new Error('Provider observation native session does not match delivery scope.');
  }
  if (attempt.kind === 'manual-compact' &&
      (envelope.event.type === 'context.compaction.started' ||
       envelope.event.type === 'context.compaction.completed' ||
       envelope.event.type === 'context.compaction.failed') &&
      envelope.event.operationId !== attempt.compactOperationId) {
    throw new Error('Provider Compact observation does not match the frozen operation.');
  }
}

function declaredNativeChildSession(envelope: ProviderEventEnvelope, executionId: string) {
  if (envelope.event.type !== 'turn.block.started' &&
      envelope.event.type !== 'turn.block.revised' &&
      envelope.event.type !== 'turn.block.completed') return undefined;
  const payload = envelope.event.block.payload;
  return payload.kind === 'native-child' && payload.child.executionId === executionId
    ? payload.child.nativeSessionId : undefined;
}
function deliveryError(error: unknown) {
  return boundedDeliveryError({
    code: 'provider_delivery_failed',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  });
}

function boundedDeliveryError(value: unknown) {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const originalMessage = typeof record.message === 'string' ? record.message : String(value);
  const message = originalMessage.slice(0, 8_192);
  return {
    code: typeof record.code === 'string' ? record.code.slice(0, 256) : 'provider_delivery_failed',
    message,
    ...(message.length < originalMessage.length ? { truncated: true } : {}),
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
    ...(record.boundaryViolation
      ? { boundaryViolation: String(record.boundaryViolation).slice(0, 256) }
      : {}),
  };
}

function providerPossiblySent(error: unknown) {
  if (error instanceof CodexRequestError) return error.phase === 'possibly-sent';
  if (!isRecord(error) || !isRecord(error.crossing)) return false;
  return error.deliveryOutcome === 'unknown' && error.crossing.phase === 'possibly-sent';
}

function validateRootEvidence(attempt: FrozenDeliveryAttempt, raw: unknown): asserts raw is ProviderAcceptanceEvidence {
  const evidence = requireRecord(raw, 'acceptance evidence');
  const kind = requiredString(evidence.kind, 'acceptance evidence kind', 64);
  if (kind === 'codex-turn-start-response') {
    requireExactKeys(evidence, ['kind', 'threadId', 'turnId', 'nativeClientMessageId']);
    const threadId = identifier(evidence.threadId, 'threadId');
    const turnId = identifier(evidence.turnId, 'turnId');
    const clientId = identifier(evidence.nativeClientMessageId, 'nativeClientMessageId');
    if (attempt.kind !== 'root-turn' || attempt.provider !== 'codex' ||
        threadId !== attempt.nativeSessionId || clientId !== attempt.nativeClientMessageId ||
        (attempt.nativeTurnId !== undefined && turnId !== attempt.nativeTurnId)) {
      throw new Error('Codex acceptance evidence does not match frozen delivery scope.');
    }
    return;
  }
  if (kind === 'codex-history-client-id') {
    requireExactKeys(evidence, ['kind', 'threadId', 'nativeClientMessageId'], ['nativeTurnId']);
    const threadId = identifier(evidence.threadId, 'threadId');
    const clientId = identifier(evidence.nativeClientMessageId, 'nativeClientMessageId');
    const turnId = optionalIdentifier(evidence.nativeTurnId, 'nativeTurnId');
    const payload = parseRecordJson(attempt.recoveryPayloadJson, 'delivery recovery payload');
    const validRoot = attempt.kind === 'root-turn' &&
      (attempt.nativeTurnId === undefined || turnId === undefined || turnId === attempt.nativeTurnId);
    const validSteer = attempt.kind === 'steer' && turnId !== undefined &&
      turnId === payload.expectedNativeTurnId;
    if ((!validRoot && !validSteer) || attempt.provider !== 'codex' ||
        threadId !== attempt.nativeSessionId || clientId !== attempt.nativeClientMessageId ||
        (attempt.kind === 'steer' && turnId === undefined)) {
      throw new Error('Codex history evidence does not match frozen delivery scope.');
    }
    return;
  }
  if (kind === 'codex-turn-steer-response') {
    requireExactKeys(evidence, ['kind', 'threadId', 'turnId', 'nativeClientMessageId']);
    const payload = parseRecordJson(attempt.recoveryPayloadJson, 'delivery recovery payload');
    if (attempt.kind !== 'steer' || attempt.provider !== 'codex' ||
        identifier(evidence.threadId, 'threadId') !== attempt.nativeSessionId ||
        identifier(evidence.nativeClientMessageId, 'nativeClientMessageId') !== attempt.nativeClientMessageId ||
        identifier(evidence.turnId, 'turnId') !== payload.expectedNativeTurnId) {
      throw new Error('Codex steer evidence does not match frozen delivery scope.');
    }
    return;
  }
  if (kind === 'codex-compact-response') {
    requireExactKeys(evidence, ['kind', 'threadId', 'requestId', 'connectionGeneration']);
    if (attempt.kind !== 'manual-compact' || attempt.provider !== 'codex' ||
        identifier(evidence.threadId, 'threadId') !== attempt.nativeSessionId ||
        !Number.isSafeInteger(evidence.requestId) || Number(evidence.requestId) < 0 ||
        identifier(evidence.connectionGeneration, 'connectionGeneration') !== attempt.processGeneration) {
      throw new Error('Codex Compact evidence does not match frozen delivery scope.');
    }
    return;
  }
  if (kind === 'claude-root-processing') {
    requireExactKeys(evidence, ['kind', 'sessionId', 'userMessageUuid', 'observationUuid']);
    const sessionId = identifier(evidence.sessionId, 'sessionId');
    const inputUuid = identifier(evidence.userMessageUuid, 'userMessageUuid');
    identifier(evidence.observationUuid, 'observationUuid');
    if (attempt.kind !== 'root-turn' || attempt.provider !== 'claude-code' ||
        sessionId !== attempt.nativeSessionId || inputUuid !== attempt.nativeClientMessageId) {
      throw new Error('Claude acceptance evidence does not match frozen delivery scope.');
    }
    return;
  }
  if (kind === 'claude-manual-compact-boundary') {
    requireExactKeys(evidence, ['kind', 'sessionId', 'boundaryUuid', 'processGeneration', 'trigger']);
    if (attempt.kind !== 'manual-compact' || attempt.provider !== 'claude-code' ||
        identifier(evidence.sessionId, 'sessionId') !== attempt.nativeSessionId ||
        identifier(evidence.processGeneration, 'processGeneration') !== attempt.processGeneration ||
        identifier(evidence.boundaryUuid, 'boundaryUuid').length === 0 || evidence.trigger !== 'manual') {
      throw new Error('Claude Compact evidence does not match frozen delivery scope.');
    }
    return;
  }
  if (kind === 'fixture-correlated-acceptance') {
    requireExactKeys(evidence, ['kind', 'sessionId', 'commandId'], ['nativeTurnId']);
    const sessionId = identifier(evidence.sessionId, 'sessionId');
    const commandId = identifier(evidence.commandId, 'commandId');
    const turnId = optionalIdentifier(evidence.nativeTurnId, 'nativeTurnId');
    const expectedCommandId = attempt.kind === 'manual-compact'
      ? attempt.compactOperationId : attempt.commandId;
    if (attempt.provider !== 'fixture' ||
        sessionId !== attempt.nativeSessionId || commandId !== expectedCommandId ||
        (attempt.nativeTurnId !== undefined && turnId !== undefined && turnId !== attempt.nativeTurnId)) {
      throw new Error('Fixture acceptance evidence does not match frozen delivery scope.');
    }
    return;
  }
  throw new Error(`Evidence ${kind} cannot accept a root-turn delivery attempt in S2a1.`);
}

function evidenceCompatible(left: ProviderAcceptanceEvidence, right: ProviderAcceptanceEvidence) {
  if (left.kind === 'claude-root-processing' && right.kind === 'claude-root-processing') {
    return left.sessionId === right.sessionId && left.userMessageUuid === right.userMessageUuid;
  }
  if (left.kind === 'fixture-correlated-acceptance' && right.kind === 'fixture-correlated-acceptance') {
    return left.sessionId === right.sessionId && left.commandId === right.commandId &&
      left.nativeTurnId === right.nativeTurnId;
  }
  if (left.kind === 'codex-turn-steer-response' && right.kind === 'codex-turn-steer-response') {
    return left.threadId === right.threadId && left.turnId === right.turnId &&
      left.nativeClientMessageId === right.nativeClientMessageId;
  }
  if (left.kind === 'codex-compact-response' && right.kind === 'codex-compact-response') {
    return left.threadId === right.threadId && left.requestId === right.requestId &&
      left.connectionGeneration === right.connectionGeneration;
  }
  if (left.kind === 'claude-manual-compact-boundary' &&
      right.kind === 'claude-manual-compact-boundary') {
    return left.sessionId === right.sessionId && left.boundaryUuid === right.boundaryUuid &&
      left.processGeneration === right.processGeneration && left.trigger === right.trigger;
  }
  const codexIdentity = (value: ProviderAcceptanceEvidence) => {
    if (value.kind === 'codex-turn-start-response') return {
      threadId: value.threadId, clientId: value.nativeClientMessageId, turnId: value.turnId,
    };
    if (value.kind === 'codex-history-client-id') return {
      threadId: value.threadId, clientId: value.nativeClientMessageId, turnId: value.nativeTurnId,
    };
    return undefined;
  };
  const a = codexIdentity(left);
  const b = codexIdentity(right);
  return Boolean(a && b && a.threadId === b.threadId && a.clientId === b.clientId &&
    (!a.turnId || !b.turnId || a.turnId === b.turnId));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Delivery payload contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) throw new Error('Delivery payload contains an unsupported value.');
  return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

function decodeAttempt(row: Record<string, unknown>): FrozenDeliveryAttempt {
  const kind = enumString(row.kind, 'kind', ['root-turn', 'steer', 'manual-compact'] as const);
  const provider = enumString(row.provider, 'provider', ['codex', 'claude-code', 'fixture'] as const);
  const state = enumString(row.state, 'state', ['preparing', 'dispatching', 'accepted', 'rejected', 'unknown'] as const);
  const acceptanceEvidence = row.acceptance_evidence_json === null
    ? undefined
    : parseRecordJson(requiredString(row.acceptance_evidence_json, 'acceptance_evidence_json', 65_536),
      'acceptance evidence');
  const attempt: FrozenDeliveryAttempt = {
    attemptId: identifier(row.attempt_id, 'attempt_id'),
    commandId: identifier(row.command_id, 'command_id'),
    kind,
    provider,
    providerInstanceId: identifier(row.provider_instance_id, 'provider_instance_id'),
    conversationId: identifier(row.conversation_id, 'conversation_id'),
    executionId: identifier(row.execution_id, 'execution_id'),
    ...(row.intended_turn_id === null ? {} : { intendedTurnId: identifier(row.intended_turn_id, 'intended_turn_id') }),
    ...(row.client_message_id === null ? {} : { clientMessageId: identifier(row.client_message_id, 'client_message_id') }),
    ...(row.native_client_message_id === null ? {} : { nativeClientMessageId: identifier(row.native_client_message_id, 'native_client_message_id') }),
    ...(row.compact_operation_id === null ? {} : { compactOperationId: identifier(row.compact_operation_id, 'compact_operation_id') }),
    recoveryPayloadHash: requiredString(row.recovery_payload_hash, 'recovery_payload_hash', 64),
    recoveryPayloadJson: requiredString(row.recovery_payload_json, 'recovery_payload_json', 64 * 1024 * 1024),
    nativeSessionId: identifier(row.native_session_id, 'native_session_id'),
    ...(row.process_generation === null ? {} : { processGeneration: identifier(row.process_generation, 'process_generation') }),
    ...(row.native_turn_id === null ? {} : { nativeTurnId: identifier(row.native_turn_id, 'native_turn_id') }),
    ...(row.native_operation_id === null ? {} : { nativeOperationId: identifier(row.native_operation_id, 'native_operation_id') }),
    ownerInstanceId: identifier(row.owner_instance_id, 'owner_instance_id'),
    state,
    ...(row.crossed_at === null ? {} : { crossedAt: nonnegativeInteger(row.crossed_at, 'crossed_at') }),
    ...(acceptanceEvidence === undefined ? {} : { acceptanceEvidence: acceptanceEvidence as ProviderAcceptanceEvidence }),
    transcriptGap: row.transcript_gap === 1,
  };
  const validShape = kind === 'manual-compact'
    ? attempt.intendedTurnId === undefined && attempt.clientMessageId === undefined &&
      attempt.compactOperationId !== undefined
    : attempt.intendedTurnId !== undefined && attempt.clientMessageId !== undefined &&
      attempt.nativeClientMessageId !== undefined && attempt.compactOperationId === undefined;
  if ((row.transcript_gap !== 0 && row.transcript_gap !== 1) || !validShape) {
    throw new Error('Durable delivery attempt has an invalid frozen shape.');
  }
  return attempt;
}

function validatePrepareIdentifiers(input: PrepareDeliveryAttempt) {
  for (const [name, value] of Object.entries({ attemptId: input.attemptId, commandId: input.commandId,
    providerInstanceId: input.providerInstanceId, conversationId: input.conversationId,
    executionId: input.executionId, intendedTurnId: input.intendedTurnId,
    clientMessageId: input.clientMessageId, nativeClientMessageId: input.nativeClientMessageId,
    nativeSessionId: input.nativeSessionId, processGeneration: input.processGeneration,
    ownerInstanceId: input.ownerInstanceId })) {
    if (value !== undefined) identifier(value, name);
  }
}

function validateDecodedRootPayload(attempt: FrozenDeliveryAttempt) {
  const payload = parseRecordJson(attempt.recoveryPayloadJson, 'delivery recovery payload');
  if (attempt.kind === 'manual-compact') {
    const allowed = new Set(['operationId', 'nativeInputUuid']);
    if (!exactKeys(payload, allowed) || payload.operationId !== attempt.compactOperationId ||
        (payload.nativeInputUuid ?? undefined) !== attempt.nativeClientMessageId) {
      throw new Error('Durable Compact payload does not match its frozen attempt shape.');
    }
    return;
  }
  const allowed = new Set(['turnId', 'clientMessageId', 'nativeClientMessageId', 'content',
    'model', 'effort', 'serviceTier', 'access', ...(attempt.kind === 'steer' ? ['expectedNativeTurnId'] : [])]);
  if (!exactKeys(payload, allowed) || payload.turnId !== attempt.intendedTurnId ||
      payload.clientMessageId !== attempt.clientMessageId ||
      payload.nativeClientMessageId !== attempt.nativeClientMessageId ||
      !Array.isArray(payload.content) || typeof payload.model !== 'string' || payload.model.length === 0 ||
      (payload.effort !== undefined && typeof payload.effort !== 'string') ||
      (payload.serviceTier !== undefined && typeof payload.serviceTier !== 'string') ||
      (attempt.kind === 'steer' && optionalIdentifier(payload.expectedNativeTurnId,
        'expectedNativeTurnId') === undefined) ||
      !['read-only', 'workspace-write', 'full-access'].includes(String(payload.access))) {
    throw new Error('Durable root recovery payload does not match its frozen attempt shape.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requireRecord(value: unknown, name: string) {
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
  return value;
}
function parseRecordJson(json: string, name: string) {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error(`${name} is not valid JSON.`); }
  return requireRecord(value, name);
}
function requiredString(value: unknown, name: string, maxLength: number) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maxLength) {
    throw new Error(`${name} must be a non-empty bounded string.`);
  }
  return value;
}
function identifier(value: unknown, name: string) {
  const result = requiredString(value, name, 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(result)) {
    throw new Error(`${name} contains unsupported identifier characters.`);
  }
  return result;
}
function optionalIdentifier(value: unknown, name: string) {
  return value === undefined ? undefined : identifier(value, name);
}
function nonnegativeInteger(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer.`);
  }
  return value;
}
function enumString<const T extends readonly string[]>(value: unknown, name: string, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${name} has an unsupported value.`);
  return value as T[number];
}
function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}
function requireExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key)) || !exactKeys(value, allowed)) {
    throw new Error('Acceptance evidence contains missing or unsupported fields.');
  }
}
