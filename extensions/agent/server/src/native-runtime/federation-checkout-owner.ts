import type { ProviderEventEnvelope } from '../../../shared/provider-runtime.ts';
import type { CheckoutResolver, ResolvedCheckout } from './checkout-resolver.ts';
import { NativeAgentJournal, type CommandReceipt } from './native-journal.ts';

export class FederationCommandInProgressError extends Error {
  constructor(commandId: string) {
    super(`Command ${commandId} is already in progress.`);
    this.name = 'FederationCommandInProgressError';
  }
}

export class FederationCommandSettledError extends Error {
  readonly receipt: CommandReceipt;

  constructor(receipt: CommandReceipt) {
    super(`Command ${receipt.commandId} settled while checkout resolution was in progress.`);
    this.name = 'FederationCommandSettledError';
    this.receipt = receipt;
  }
}

export class FederationCheckoutOwner {
  private readonly journal: NativeAgentJournal;
  private readonly resolver: CheckoutResolver;

  constructor(journal: NativeAgentJournal, resolver: CheckoutResolver) {
    this.journal = journal;
    this.resolver = resolver;
  }

  settledOrUnresolved(commandId: string, kind: string, request: unknown) {
    return this.journal.inspectCommand(commandId, kind, request);
  }

  captureStartupOwners(now: number) {
    return this.journal.transaction(() => {
      const candidates = this.journal.database.prepare(`SELECT e.*, c.cwd,
          r.state AS reservation_state, r.checkout_key AS reservation_key,
          r.command_id AS reservation_command, r.updated_at AS reservation_updated
        FROM executions e JOIN conversations c USING(conversation_id)
        LEFT JOIN federation_checkout_reservations r USING(execution_id)
        WHERE e.ownership='federated'`).all() as Array<Record<string, unknown>>;
      const selected = candidates.filter((row) =>
        row.reservation_state === 'held' || row.reservation_state === 'unknown' ||
        row.state === 'running' || row.state === 'recovering' ||
        this.nativeDescendantState(String(row.execution_id)) !== 'clear');
      return selected.map((row) => {
      const executionId = String(row.execution_id);
      this.journal.database.prepare(`INSERT OR IGNORE INTO federation_checkout_reservations(
        execution_id,checkout_key,command_id,expected_turn_id,access,scheduling,state,created_at,updated_at
      ) VALUES (?,?,NULL,NULL,?,?, 'unknown',?,?)`).run(
        executionId, row.checkout_key === null ? null : String(row.checkout_key),
        typeof row.access === 'string' ? row.access : 'read-only',
        typeof row.federation_scheduling === 'string' ? row.federation_scheduling : 'background', now, now);
      this.journal.database.prepare(`UPDATE federation_checkout_reservations
        SET state='unknown', release_reason=NULL, released_at=NULL, updated_at=MAX(updated_at, ?)
        WHERE execution_id=? AND state='released'`).run(now, executionId);
      const captured = this.journal.database.prepare(`SELECT checkout_key,command_id,expected_turn_id,
          state,updated_at FROM federation_checkout_reservations WHERE execution_id=?`)
        .get(executionId) as { checkout_key: string | null; command_id: string | null;
          expected_turn_id: string | null; state: string; updated_at: number };
      return { executionId, cwd: String(row.cwd),
        executionCheckoutKey: row.checkout_key === null ? null : String(row.checkout_key), ...captured };
      });
    });
  }

  scopeCapturedStartupOwner(captured: ReturnType<FederationCheckoutOwner['captureStartupOwners']>[number],
    checkoutKey: string, now: number) {
    if (captured.checkout_key !== null || captured.command_id !== null ||
        captured.expected_turn_id !== null || captured.state !== 'unknown') return false;
    return this.journal.transaction(() => {
      const changed = this.journal.database.prepare(`UPDATE federation_checkout_reservations
        SET checkout_key=?, updated_at=MAX(updated_at, ?) WHERE execution_id=? AND state='unknown'
          AND checkout_key IS NULL AND command_id IS NULL AND expected_turn_id IS NULL AND updated_at=?
      `).run(checkoutKey, now, captured.executionId, captured.updated_at).changes;
      if (changed !== 1) return false;
      if (captured.executionCheckoutKey === null) this.journal.database.prepare(`UPDATE executions
        SET checkout_key=?, updated_at=MAX(updated_at, ?) WHERE execution_id=? AND checkout_key IS NULL
      `).run(checkoutKey, now, captured.executionId);
      return true;
    });
  }

  async resolveNew(commandId: string, kind: string, request: unknown, cwd: string, now: number) {
    const resolution = await this.resolver(cwd);
    if (resolution.state === 'resolved') return resolution.value;
    const claim = this.journal.transaction(() => {
      const current = this.journal.claimCommand(commandId, kind, request, now);
      if (current.created) this.journal.rejectCommand(commandId,
        `Workspace checkout could not be resolved: ${resolution.reason}`, now);
      return current;
    });
    if (!claim.created) {
      if (claim.receipt.state === 'accepted' || claim.receipt.state === 'rejected' ||
          claim.receipt.state === 'recovery_failed') throw new FederationCommandSettledError(claim.receipt);
      throw new FederationCommandInProgressError(commandId);
    }
    throw new Error(`Workspace checkout could not be resolved: ${resolution.reason}`);
  }

  claimAndReserve<T>(input: {
    commandId: string;
    kind: string;
    request: unknown;
    executionId: string;
    expectedTurnId: string;
    checkout: ResolvedCheckout;
    access: 'read-only' | 'workspace-write' | 'full-access';
    scheduling: 'background' | 'foreground';
    now: number;
    validateAndCreate: () => T;
  }): { value: T } | { receipt: CommandReceipt } {
    const outcome = this.journal.transaction(() => {
      const claim = this.journal.claimCommand(input.commandId, input.kind, input.request, input.now);
      if (!claim.created) return { receipt: claim.receipt };
      try {
        const value = this.journal.transaction(() => {
          const created = input.validateAndCreate();
          this.journal.reserveFederatedCheckout({
            executionId: input.executionId, checkoutKey: input.checkout.checkoutKey,
            commandId: input.commandId, expectedTurnId: input.expectedTurnId,
            access: input.access, scheduling: input.scheduling, now: input.now,
          });
          return created;
        });
        return { value };
      } catch (error) {
        this.journal.rejectCommand(input.commandId, messageOf(error), input.now);
        return { error };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome;
  }

  beforeDispatchFailure(executionId: string, commandId: string, expectedTurnId: string,
    message: string, now: number) {
    return this.journal.transaction(() => {
      const released = this.journal.releaseFederatedCheckout({ executionId, commandId,
        expectedTurnId, reason: 'pre-dispatch-failure', now });
      if (released) this.journal.rejectCommand(commandId, message, now);
      return released;
    });
  }

  dispatchUnknown(executionId: string, commandId: string, expectedTurnId: string, now: number) {
    return this.journal.markFederatedCheckoutUnknown(executionId, commandId, expectedTurnId, now);
  }

  terminal(event: ProviderEventEnvelope, source: 'live-provider' | 'authoritative-snapshot', now: number) {
    if (event.scope.kind !== 'turn') return false;
    if (event.event.type !== 'turn.completed') {
      const outcome = event.event.type === 'execution.completed'
        ? event.event.outcome
        : event.event.type === 'turn.block.completed' &&
            event.event.block.payload.kind === 'native-child'
          ? event.event.block.payload.outcome
          : undefined;
      const childExecutionId = event.event.type === 'execution.completed' && outcome !== 'recovery_failed'
        ? event.event.childExecutionId
        : event.event.type === 'turn.block.completed' &&
            event.event.block.payload.kind === 'native-child' &&
            ['completed', 'failed', 'interrupted'].includes(outcome ?? '') &&
            !['running', 'recovering'].includes(event.event.block.payload.executionState)
          ? event.event.block.payload.child.executionId
          : undefined;
      if (childExecutionId) {
        const child = this.journal.execution(childExecutionId);
        const ownerTurn = this.journal.turn(event.scope.turnId);
        const parent = this.journal.execution(event.scope.executionId);
        const session = this.journal.nativeSession(event.scope.executionId);
        const handle = this.journal.nativeChildHandle(event.scope.executionId);
        const parentBound = parent?.ownership === 'native'
          ? handle?.nativeSessionId === event.native.sessionId
          : session?.providerInstanceId === event.scope.providerInstanceId &&
            session.sessionId === event.native.sessionId;
        if (child?.ownership === 'native' && child.conversationId === event.scope.conversationId &&
            child.parentExecutionId === event.scope.executionId && child.rootTurnId === event.scope.turnId &&
            ownerTurn?.executionId === event.scope.executionId && ownerTurn.nativeTurnId === event.native.turnId &&
            parent?.provider === event.provider &&
            parent.providerInstanceId === event.scope.providerInstanceId && parentBound) {
          this.reevaluateAncestors(child.executionId, now);
        }
      }
      return false;
    }
    if (event.event.outcome === 'recovery_failed') return false;
    const turn = this.journal.turn(event.scope.turnId);
    if (!turn || turn.executionId !== event.scope.executionId || !turn.nativeTurnId ||
        turn.nativeTurnId !== event.native.turnId) return false;
    const execution = this.journal.execution(event.scope.executionId);
    const session = this.journal.nativeSession(event.scope.executionId);
    const childHandle = this.journal.nativeChildHandle(event.scope.executionId);
    const bound = execution?.ownership === 'native'
      ? childHandle?.nativeSessionId === event.native.sessionId
      : session?.providerInstanceId === event.scope.providerInstanceId &&
        session.sessionId === event.native.sessionId;
    if (!execution || execution.provider !== event.provider ||
        execution.providerInstanceId !== event.scope.providerInstanceId || !bound) return false;
    const evidence = {
      source, eventId: event.eventId,
      executionId: event.scope.executionId, turnId: turn.turnId,
      nativeSessionId: event.native.sessionId, nativeTurnId: event.native.turnId,
      outcome: event.event.outcome, observedAt: event.observedAt,
    };
    if (this.nativeDescendantState(event.scope.executionId) !== 'clear') {
      return this.journal.recordFederatedTerminalEvidence({ executionId: event.scope.executionId,
        commandId: turn.commandId, expectedTurnId: turn.turnId, evidence, now });
    }
    const released = this.journal.releaseFederatedCheckout({
      executionId: event.scope.executionId,
      commandId: turn.commandId,
      expectedTurnId: turn.turnId,
      reason: 'native-terminal',
      evidence,
      now,
    });
    this.reevaluateAncestors(event.scope.executionId, now);
    return released;
  }

  private nativeDescendantState(executionId: string): 'clear' | 'active' | 'invalid' {
    const root = this.journal.execution(executionId);
    if (!root) return 'invalid';
    const reachable = this.journal.database.prepare(`WITH RECURSIVE descendants(execution_id) AS (
      SELECT execution_id FROM executions WHERE parent_execution_id=?
      UNION SELECT e.execution_id FROM executions e JOIN descendants
        ON e.parent_execution_id=descendants.execution_id
    ) SELECT execution_id FROM descendants LIMIT 258`).all(executionId) as Array<{ execution_id: string }>;
    if (reachable.length > 256 || reachable.some(({ execution_id: id }) => id === executionId)) return 'invalid';
    if (reachable.length === 0) return 'clear';
    const placeholders = reachable.map(() => '?').join(',');
    const rows = this.journal.database.prepare(`SELECT * FROM executions
      WHERE execution_id IN (${placeholders})`).all(...reachable.map(({ execution_id }) => execution_id)) as
      Array<Record<string, unknown>>;
    const children = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const parent = String(row.parent_execution_id);
      const list = children.get(parent) ?? [];
      list.push(row);
      children.set(parent, list);
    }
    const stack = [{ id: executionId, depth: 0, access: root.access, path: new Set([executionId]) }];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.depth >= 64 && (children.get(current.id)?.length ?? 0) > 0) return 'invalid';
      for (const row of children.get(current.id) ?? []) {
        const id = String(row.execution_id);
        if (current.path.has(id) || String(row.conversation_id) !== root.conversationId) return 'invalid';
        const access = row.access === null ? current.access : row.access as typeof root.access;
        if (access !== 'read-only' && access !== 'workspace-write' && access !== 'full-access') return 'invalid';
        if (row.ownership === 'native' &&
            (row.state === 'running' || row.state === 'recovering' || row.outcome === 'recovery_failed') &&
            (access === 'workspace-write' || access === 'full-access')) return 'active';
        stack.push({ id, depth: current.depth + 1, access, path: new Set([...current.path, id]) });
      }
    }
    return 'clear';
  }

  private reevaluateAncestors(executionId: string, now: number) {
    let current = this.journal.execution(executionId);
    const seen = new Set<string>();
    const ancestors: NonNullable<typeof current>[] = [];
    for (let depth = 0; current?.parentExecutionId && depth < 64; depth += 1) {
      if (seen.has(current.executionId)) return;
      seen.add(current.executionId);
      const parent = this.journal.execution(current.parentExecutionId);
      if (!parent || parent.conversationId !== current.conversationId) return;
      ancestors.push(parent);
      current = parent;
    }
    if (current?.parentExecutionId || (current && seen.has(current.executionId))) return;
    for (const parent of ancestors) {
      const row = this.journal.database.prepare(`SELECT command_id, expected_turn_id,
          terminal_evidence_json FROM federation_checkout_reservations
        WHERE execution_id=? AND state IN ('held','unknown') AND terminal_evidence_json IS NOT NULL
      `).get(parent.executionId) as { command_id: string | null; expected_turn_id: string | null;
        terminal_evidence_json: string } | undefined;
      if (row?.command_id && row.expected_turn_id &&
          this.nativeDescendantState(parent.executionId) === 'clear') {
        this.journal.releaseFederatedCheckout({ executionId: parent.executionId,
          commandId: row.command_id, expectedTurnId: row.expected_turn_id,
          reason: 'native-terminal', evidence: JSON.parse(row.terminal_evidence_json), now });
      }
    }
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
