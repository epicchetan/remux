import type { TurnContextPlan, TurnReadValue } from '../../../shared/protocol.ts';
import { normalizeTurnContextPlan } from '../context/compiler.ts';
import { safeInteger, safeTimestamp } from './state-codec.ts';
import { WorkUnitState } from './work-unit-state.ts';

/** Durable turn inspection layered above work-unit state. */
export abstract class TurnState extends WorkUnitState {
  async readTurn(conversationId: string, turnId: string): Promise<TurnReadValue> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT t.state, t.terminal_sequence, t.context_plan_json,
             t.created_at, t.updated_at,
             json_extract(e.payload_json, '$.error') AS error,
             json_extract(e.payload_json, '$.errorCode') AS error_code
      FROM turns t
      LEFT JOIN events e ON e.sequence = t.terminal_sequence AND e.type = 'turn.terminal'
      WHERE t.conversation_id = ? AND t.turn_id = ?
    `).get(conversationId, turnId) as {
      state: string;
      terminal_sequence: number | null;
      context_plan_json: string;
      created_at: number;
      updated_at: number;
      error: string | null;
      error_code: string | null;
    } | undefined;
    if (!row) throw new Error(`Turn ${turnId} does not exist in conversation ${conversationId}.`);
    return {
      conversationId,
      turnId,
      state: durableTurnReadState(row.state),
      terminal: row.terminal_sequence !== null,
      terminalSequence: row.terminal_sequence === null
        ? null
        : safeInteger(row.terminal_sequence, 'turn terminal sequence'),
      error: row.error,
      errorCode: durableTurnErrorCode(row.error_code),
      contextPlan: normalizeTurnContextPlan(JSON.parse(row.context_plan_json) as TurnContextPlan),
      createdAt: safeTimestamp(row.created_at),
      updatedAt: safeTimestamp(row.updated_at),
    };
  }
}

function durableTurnReadState(value: string): TurnReadValue['state'] {
  if (
    value !== 'running' && value !== 'completed' && value !== 'failed' &&
    value !== 'interrupted' && value !== 'interrupted_by_restart'
  ) {
    throw new Error('Durable turn state is invalid.');
  }
  return value;
}

function durableTurnErrorCode(value: string | null): TurnReadValue['errorCode'] {
  if (value === null) return null;
  if (value !== 'provider_error' && value !== 'runtime_error' && value !== 'storage_error') {
    throw new Error('Durable turn error code is invalid.');
  }
  return value;
}
