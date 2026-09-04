import type {
  AgentExecutionScopeResource,
} from '../../../../../shared/transcript.ts';

export function executionScopeIsWaitingForContent(
  scope: Pick<AgentExecutionScopeResource, 'inferences' | 'state'>,
) {
  if (scope.state !== 'running') return false;
  const lastInference = scope.inferences.at(-1);
  const blocks = lastInference?.blocks ?? [];
  const lastBlock = blocks.at(-1);
  if (!lastBlock) return true;
  if (lastBlock.type !== 'action') {
    return lastBlock.state !== 'streaming' || !lastBlock.text.trim();
  }
  if (lastBlock.call.childScopeId) return lastBlock.call.status !== 'running';

  // Consecutive ordinary actions render as one summary row. Keep that row
  // shimmering until every call in the visible run has settled, then append
  // Thinking while the provider is preparing the next transcript item.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block || block.type !== 'action' || block.call.childScopeId) break;
    if (block.call.status === 'running') return false;
  }
  return true;
}
