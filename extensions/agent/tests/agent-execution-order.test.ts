import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentExecutionResource } from '../shared/native-agent-protocol.ts';
import { newestAgentExecutions } from '../viewer/src/agents/executionOrder.ts';

test('orders subagents newest-first with a stable identity tie break', () => {
  const execution = (executionId: string, startedAt: number) => ({
    executionId,
    startedAt,
  } as AgentExecutionResource);
  const original = [execution('older', 10), execution('tie-a', 20), execution('tie-b', 20)];

  assert.deepEqual(
    newestAgentExecutions(original).map(({ executionId }) => executionId),
    ['tie-b', 'tie-a', 'older'],
  );
  assert.deepEqual(original.map(({ executionId }) => executionId), ['older', 'tie-a', 'tie-b']);
});
