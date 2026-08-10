import assert from 'node:assert/strict';
import test from 'node:test';

import { compileThreadContext, type ThreadContextSource } from '../server/src/context/compiler.ts';
import type { LogicalContextMessage } from '../server/src/logical-context.ts';

test('thread context compilation is deterministic and preserves exact active-turn scratch', () => {
  const source = fixtureSource();
  const left = compileThreadContext(source, { contextWindow: 400_000 });
  const right = compileThreadContext(source, { contextWindow: 400_000 });
  assert.deepEqual(left, right);
  assert.equal(left.frame.compilerVersion, 'agent-thread-compiler-v1');
  assert.deepEqual(left.frame.dialogueTurnIds, ['turn:prior']);
  assert.deepEqual(left.frame.capsuleTurnIds, ['turn:prior']);
  assert.deepEqual(left.messages.map(({ role }) => role), [
    'user', 'assistant', 'user', 'assistant', 'tool',
  ]);
  const priorAssistant = left.messages[1];
  assert.equal(priorAssistant?.role, 'assistant');
  if (priorAssistant?.role === 'assistant') {
    assert.equal(priorAssistant.reasoning, '');
    assert.deepEqual(priorAssistant.toolCalls, []);
  }
  const activeAssistant = left.messages[3];
  assert.equal(activeAssistant?.role, 'assistant');
  if (activeAssistant?.role === 'assistant') {
    assert.equal(activeAssistant.reasoning, 'active private reasoning');
    assert.equal(activeAssistant.toolCalls.length, 1);
  }
  assert.match(left.frame.bootstrap, /Current objective/u);
  assert.match(left.frame.bootstrap, /Prior outcome/u);
});

test('dialogue and capsule tails evict oldest whole turns independently', () => {
  const source = fixtureSource();
  source.messages = [
    ...completedDialogue('turn:old', 'old '.repeat(400)),
    ...completedDialogue('turn:new', 'new compact'),
    ...source.messages.filter(({ turnId }) => turnId === source.turnId),
  ];
  source.capsules = [
    { turnId: 'turn:old', ref: 'journal://capsule/old', markdown: 'old capsule '.repeat(400) },
    { turnId: 'turn:new', ref: 'journal://capsule/new', markdown: 'new capsule' },
  ];
  const compiled = compileThreadContext(source, {
    contextWindow: 400_000,
    dialogueTailTokens: 100,
    capsuleTailTokens: 100,
  });
  assert.deepEqual(compiled.frame.dialogueTurnIds, ['turn:new']);
  assert.deepEqual(compiled.frame.capsuleTurnIds, ['turn:new']);
  assert.ok(compiled.frame.omissions.some(({ reason }) => reason === 'dialogue-budget'));
  assert.ok(compiled.frame.omissions.some(({ reason }) => reason === 'capsule-budget'));
  assert.ok(compiled.messages.every(({ turnId }) => turnId !== 'turn:old'));
});

function fixtureSource(): ThreadContextSource {
  const messages: LogicalContextMessage[] = [
    ...completedDialogue('turn:prior', 'Prior answer'),
    { role: 'user', turnId: 'turn:active', text: 'Continue', timestamp: 3 },
    {
      role: 'assistant',
      turnId: 'turn:active',
      text: '',
      reasoning: 'active private reasoning',
      toolCalls: [{ callId: 'call:1', name: 'bash', args: { command: 'pwd' } }],
      state: 'completed',
      timestamp: 4,
    },
    {
      role: 'tool',
      turnId: 'turn:active',
      callId: 'call:1',
      name: 'bash',
      result: { stdout: '/workspace' },
      isError: false,
      timestamp: 5,
    },
  ];
  return {
    basisSequence: 42,
    projectId: 'project:1',
    conversationId: 'conversation:1',
    strandId: 'strand:1',
    turnId: 'turn:active',
    scopeId: 'scope:active',
    threadVersionId: 'thread-version:2',
    threadMarkdown: '# Thread\n\nCurrent objective: implement the runtime.\n',
    messages,
    capsules: [{
      turnId: 'turn:prior',
      ref: 'journal://capsule/prior',
      markdown: '# Prior outcome\n\nThe storage foundation is complete.\n',
    }],
  };
}

function completedDialogue(turnId: string, answer: string): LogicalContextMessage[] {
  return [
    { role: 'user', turnId, text: `Question for ${turnId}`, timestamp: 1 },
    {
      role: 'assistant',
      turnId,
      text: answer,
      reasoning: 'prior reasoning must be cold',
      toolCalls: [{ callId: `${turnId}:call`, name: 'bash', args: { command: 'secret' } }],
      state: 'completed',
      timestamp: 2,
    },
    {
      role: 'tool',
      turnId,
      callId: `${turnId}:call`,
      name: 'bash',
      result: { raw: 'old scratch must be cold' },
      isError: false,
      timestamp: 2,
    },
  ];
}
