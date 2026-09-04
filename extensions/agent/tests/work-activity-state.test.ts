import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentExecutionScopeResource,
  AgentInferenceBlock,
} from '../shared/transcript.ts';
import {
  executionScopeIsWaitingForContent,
} from '../viewer/src/transcript/components/work/workActivityState.ts';

test('shows Thinking only while a running scope has no row carrying live activity', () => {
  assert.equal(executionScopeIsWaitingForContent(scope([])), true);
  assert.equal(executionScopeIsWaitingForContent(scope([textBlock('streaming')])), false);
  assert.equal(executionScopeIsWaitingForContent(scope([textBlock('streaming', '')])), true);
  assert.equal(executionScopeIsWaitingForContent(scope([textBlock('final')])), true);
  assert.equal(executionScopeIsWaitingForContent(scope([actionBlock('running')])), false);
  assert.equal(executionScopeIsWaitingForContent(scope([actionBlock('completed')])), true);
  assert.equal(
    executionScopeIsWaitingForContent(scope([actionBlock('running'), actionBlock('completed')])),
    false,
  );
  assert.equal(executionScopeIsWaitingForContent({ ...scope([]), state: 'completed' }), false);
});

function scope(blocks: AgentInferenceBlock[]): Pick<AgentExecutionScopeResource, 'inferences' | 'state'> {
  return {
    state: 'running',
    inferences: blocks.length ? [{
      id: 'inference-1',
      ordinal: 0,
      state: 'running',
      revision: '1',
      startedAt: 0,
      completedAt: null,
      durationMs: null,
      blocks,
    }] : [],
  };
}

function textBlock(state: 'streaming' | 'final', text = 'Inspecting'): AgentInferenceBlock {
  return {
    id: 'text-1',
    type: 'reasoning',
    state,
    revision: '1',
    text,
  };
}

function actionBlock(status: 'running' | 'completed'): AgentInferenceBlock {
  const suffix = status === 'running' ? 'running' : 'completed';
  return {
    id: `action-${suffix}`,
    type: 'action',
    state: status,
    revision: '1',
    call: {
      id: `operation-${suffix}`,
      callId: `call-${suffix}`,
      name: 'bash',
      presentation: { category: 'command', label: 'Run tests', subject: null },
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
    },
  };
}
