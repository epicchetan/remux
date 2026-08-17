import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileTurnContext,
  type TurnContextSource,
} from '../server/src/context/compiler.ts';
import type { LogicalContextMessage } from '../server/src/logical-context.ts';

test('turn context compilation is deterministic and defaults to exact recent dialogue', () => {
  const source = fixtureSource();
  const left = compileTurnContext(source);
  const right = compileTurnContext(source);
  assert.deepEqual(left, right);
  assert.equal(left.frame.compilerVersion, 'agent-turn-context-v1');
  assert.deepEqual(left.frame.resolvedTurns, [{
    turnId: 'turn:prior', resolution: 'dialogue', origin: 'automatic',
  }]);
  assert.deepEqual(left.messages.map(({ role }) => role), [
    'user', 'assistant', 'user', 'assistant', 'tool',
  ]);
  const priorAssistant = left.messages[1];
  assert.equal(priorAssistant?.role, 'assistant');
  if (priorAssistant?.role === 'assistant') {
    assert.equal(priorAssistant.reasoning, '');
    assert.equal(priorAssistant.providerMessage, undefined);
    assert.deepEqual(priorAssistant.toolCalls, []);
  }
  const activeAssistant = left.messages[3];
  assert.equal(activeAssistant?.role, 'assistant');
  if (activeAssistant?.role === 'assistant') {
    assert.equal(activeAssistant.reasoning, 'active private reasoning');
    assert.equal(activeAssistant.toolCalls.length, 1);
  }
  assert.equal(left.frame.scopeKind, 'turn');
});

test('explicit selection can disable recent dialogue and retain an older full trajectory', () => {
  const source = fixtureSource();
  source.messages = [
    ...completedDialogue('turn:old', 'old result'),
    ...source.messages,
  ];
  source.contextPlan = {
    version: 1,
    automaticDialogueTurns: 1,
    overrides: [
      { turnId: 'turn:old', resolution: 'full' },
      { turnId: 'turn:prior', resolution: 'off' },
    ],
  };
  const compiled = compileTurnContext(source);
  assert.deepEqual(compiled.frame.resolvedTurns, [{
    turnId: 'turn:old', resolution: 'full', origin: 'explicit',
  }]);
  assert.deepEqual(
    compiled.messages.filter(({ turnId }) => turnId === 'turn:old').map(({ role }) => role),
    ['user', 'assistant', 'tool'],
  );
  const oldAssistant = compiled.messages.find((message) =>
    message.turnId === 'turn:old' && message.role === 'assistant');
  assert.equal(oldAssistant?.role, 'assistant');
  if (oldAssistant?.role === 'assistant') {
    assert.equal(oldAssistant.reasoning, 'prior reasoning');
    assert.equal(oldAssistant.toolCalls.length, 1);
  }
  assert.ok(compiled.messages.every(({ turnId }) => turnId !== 'turn:prior'));
  assert.ok(compiled.frame.omissions.some(({ reason }) => reason === 'not-selected'));
});

function fixtureSource(): TurnContextSource {
  const messages: LogicalContextMessage[] = [
    ...completedDialogue('turn:prior', 'Prior answer'),
    { role: 'user', turnId: 'turn:active', text: 'Continue', timestamp: 3 },
    {
      role: 'assistant', turnId: 'turn:active', text: '', reasoning: 'active private reasoning',
      toolCalls: [{ callId: 'call:1', name: 'bash', args: { command: 'pwd' } }],
      state: 'completed', timestamp: 4,
    },
    {
      role: 'tool', turnId: 'turn:active', callId: 'call:1', name: 'bash',
      result: { stdout: '/workspace' }, isError: false, timestamp: 5,
    },
  ];
  return {
    basisSequence: 42,
    projectId: 'project:1',
    conversationId: 'conversation:1',
    turnId: 'turn:active',
    scopeId: 'scope:active',
    scopeKind: 'turn',
    contextPlan: { version: 1, automaticDialogueTurns: 2, overrides: [] },
    messages,
  };
}

function completedDialogue(turnId: string, answer: string): LogicalContextMessage[] {
  return [
    { role: 'user', turnId, text: `Question for ${turnId}`, timestamp: 1 },
    {
      role: 'assistant', turnId, text: answer, reasoning: 'prior reasoning',
      toolCalls: [{ callId: `${turnId}:call`, name: 'bash', args: { command: 'secret' } }],
      state: 'completed', timestamp: 2,
    },
    {
      role: 'tool', turnId, callId: `${turnId}:call`, name: 'bash',
      result: { raw: 'old scratch' }, isError: false, timestamp: 2,
    },
  ];
}
