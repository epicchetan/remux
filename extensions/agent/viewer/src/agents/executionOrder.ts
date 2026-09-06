import type { AgentExecutionResource } from '../../../shared/native-agent-protocol.ts';

export function newestAgentExecutions(
  executions: readonly AgentExecutionResource[],
): AgentExecutionResource[] {
  return [...executions].sort((left, right) =>
    right.startedAt - left.startedAt || right.executionId.localeCompare(left.executionId));
}
