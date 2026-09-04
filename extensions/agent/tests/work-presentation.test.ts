import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentToolCallSummary } from '../shared/transcript.ts';
import { summarizeActionRun } from '../viewer/src/transcript/components/work/workPresentation.ts';

test('completed activity uses one natural grouped summary', () => {
  const calls = [
    ...Array.from({ length: 4 }, (_, index) => call('read', `Read file-${index}.ts`, `src/file-${index}.ts`)),
    ...Array.from({ length: 3 }, (_, index) => call('edit', `Edited edit-${index}.ts`, `src/edit-${index}.ts`)),
    ...Array.from({ length: 4 }, () => call('command', 'Ran npm test', null)),
  ];
  assert.equal(summarizeActionRun(calls), 'Read 4 files, edited 3 files, and ran 4 commands');
});

test('running activity reports the latest operation instead of settled counts', () => {
  const calls = [
    call('read', 'Read existing.ts', 'src/existing.ts'),
    call('edit', 'Edited previous.ts', 'src/previous.ts'),
    call('edit', 'Editing current.ts', 'src/current.ts', 'running'),
  ];
  assert.equal(summarizeActionRun(calls), 'Editing current.ts');
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
