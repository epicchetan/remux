import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentInferenceBlock, AgentInferenceTrace, AgentToolCallSummary } from '../shared/transcript.ts';
import { scopeTraceItems } from '../viewer/src/transcript/components/work/workTrace.ts';
import { summarizeActionRun } from '../viewer/src/transcript/components/work/workPresentation.ts';

test('completed activity uses one natural grouped summary', () => {
  const calls = [
    ...Array.from({ length: 4 }, (_, index) => call('read', `Read file-${index}.ts`, `src/file-${index}.ts`)),
    ...Array.from({ length: 3 }, (_, index) => call('edit', `Edited edit-${index}.ts`, `src/edit-${index}.ts`)),
    ...Array.from({ length: 4 }, () => call('command', 'Ran npm test', null)),
  ];
  assert.equal(summarizeActionRun(calls), 'Read 4 files, edited 3 files, and ran 4 shell calls');
});

test('running activity reports the latest operation instead of settled counts', () => {
  const calls = [
    call('read', 'Read existing.ts', 'src/existing.ts'),
    call('edit', 'Edited previous.ts', 'src/previous.ts'),
    call('edit', 'Editing current.ts', 'src/current.ts', 'running'),
  ];
  assert.equal(summarizeActionRun(calls), 'Editing current.ts · 2 completed');
});

function call(
  category: AgentToolCallSummary['presentation']['category'],
  label: string,
  subject: string | null,
  status: AgentToolCallSummary['status'] = 'completed',
): AgentToolCallSummary {
  return {
    id: `${category}:${label}`,
    callId: `${category}:${label}`,
    name: category,
    presentation: { category, label, subject },
    status,
    revision: '1',
    detailPreview: null,
    outputPreview: null,
    durationMs: null,
    childScopeId: null,
    childBoundary: null,
    childState: null,
    childDurationMs: null,
    childOperationCount: 0,
    childArtifactCount: 0,
    hasDetail: false,
  };
}


test('single completed shell calls keep their descriptions and failures remain visible during later work', () => {
  const inspected = call('command', 'Inspect snapshot delivery', null);
  assert.equal(summarizeActionRun([inspected]), 'Inspect snapshot delivery');
  const failed = call('command', 'Probe bars', null, 'failed');
  assert.equal(summarizeActionRun([failed]), 'Failed · Probe bars');
  assert.equal(summarizeActionRun([inspected, failed]), 'Ran 1 shell call · 1 failed');
  assert.equal(summarizeActionRun([inspected, failed, call('command', 'Check host logs', null, 'running')]),
    'Running · Check host logs · 1 completed · 1 failed');
  assert.equal(summarizeActionRun([failed, call('command', 'Wait', null, 'interrupted')]), '1 failed · 1 interrupted');
});

test('tool groups span provider passes and retain their disclosure key as streaming calls append or settle', () => {
  const first = action('first');
  const second = action('second', 'running');
  const before = scopeTraceItems('root', [pass([first])]);
  const during = scopeTraceItems('root', [pass([first]), pass([second])]);
  assert.equal(during.length, 1);
  assert.ok(before[0]?.kind === 'actions' && during[0]?.kind === 'actions');
  assert.equal(during[0].key, before[0].key);
  assert.deepEqual(during[0].calls.map(c => c.callId), [first.call.callId, second.call.callId]);
  const after = scopeTraceItems('root', [pass([first]), pass([action('second')])]);
  assert.ok(after[0]?.kind === 'actions');
  assert.equal(after[0].key, before[0].key);
});

test('commentary, reasoning, notices, and native children preserve boundaries and exact action order', () => {
  const child = action('child');
  child.call.childScopeId = 'child-scope';
  const commentary: AgentInferenceBlock = { id: 'update', type: 'commentary', state: 'final', revision: '1', text: 'Progress' };
  const reasoning: AgentInferenceBlock = { ...commentary, id: 'reasoning', type: 'reasoning' };
  const notice: AgentInferenceBlock = { ...commentary, id: 'notice', type: 'notice', code: 'context-compaction' };
  const items = scopeTraceItems('root', [
    pass([action('a')]), pass([action('b'), commentary, action('c')]),
    pass([reasoning, action('d'), child, action('e'), notice, action('f')]),
  ]);
  assert.deepEqual(items.map(i => i.kind), ['actions', 'text', 'actions', 'text', 'actions', 'scope', 'actions', 'text', 'actions']);
  assert.deepEqual(items.flatMap(i => i.kind === 'actions' ? i.calls.map(c => c.presentation.label) : []), ['a', 'b', 'c', 'd', 'e', 'f']);
});

function action(label: string, status: AgentToolCallSummary['status'] = 'completed'): Extract<AgentInferenceBlock, { type: 'action' }> {
  return { id: label, type: 'action', state: status, revision: '1', call: call('command', label, null, status) };
}

function pass(blocks: AgentInferenceBlock[]): AgentInferenceTrace {
  return { id: blocks[0]!.id, ordinal: 0, state: 'completed', revision: '1', startedAt: 0, completedAt: 1, durationMs: 1, blocks };
}
