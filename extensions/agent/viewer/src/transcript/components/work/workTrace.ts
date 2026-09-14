import type { AgentInferenceBlock, AgentInferenceTrace, AgentToolCallSummary } from '../../../../../shared/transcript.ts';

export type ActionTraceItem =
  | { kind: 'text'; block: Exclude<AgentInferenceBlock, { type: 'action' }> }
  | { kind: 'actions'; key: string; calls: AgentToolCallSummary[] }
  | { kind: 'scope'; call: AgentToolCallSummary };

/** Group display activity across provider passes without changing their stored order. */
export function scopeTraceItems(scopeId: string, inferences: AgentInferenceTrace[]): ActionTraceItem[] {
  const items: ActionTraceItem[] = [];
  let pending: AgentToolCallSummary[] = [];
  const flush = () => {
    if (!pending.length) return;
    items.push({
      kind: 'actions',
      // Appending a streamed call must not change the disclosure identity.
      key: `action-run:${scopeId}:${pending[0]!.id}`,
      calls: pending,
    });
    pending = [];
  };
  for (const inference of inferences) {
    for (const block of inference.blocks) {
      if (block.type !== 'action') {
        flush();
        items.push({ kind: 'text', block });
      } else if (block.call.childScopeId) {
        flush();
        items.push({ kind: 'scope', call: block.call });
      } else {
        pending.push(block.call);
      }
    }
  }
  flush();
  return items;
}
