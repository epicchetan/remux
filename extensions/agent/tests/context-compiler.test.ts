import assert from 'node:assert/strict';
import test from 'node:test';

import { compileThreadContext, type ThreadContextSource } from '../server/src/context/compiler.ts';
import type { LogicalContextMessage } from '../server/src/logical-context.ts';

test('thread context compilation is deterministic and preserves exact active-turn scratch', () => {
  const source = fixtureSource();
  const left = compileThreadContext(source, { contextWindow: 400_000 });
  const right = compileThreadContext(source, { contextWindow: 400_000 });
  assert.deepEqual(left, right);
  assert.equal(left.frame.compilerVersion, 'agent-thread-compiler-v2');
  assert.deepEqual(left.frame.dialogueTurnIds, ['turn:prior']);
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
  assert.doesNotMatch(left.frame.bootstrap, /Prior outcome/u);
  assert.equal(left.frame.scopeKind, 'turn');
  assert.equal(left.frame.pressureNoticed, false);
});

test('recent dialogue evicts oldest exact turns as whole user/assistant groups', () => {
  const source = fixtureSource();
  source.messages = [
    ...completedDialogue('turn:old', 'old '.repeat(400)),
    ...completedDialogue('turn:new', 'new compact'),
    ...source.messages.filter(({ turnId }) => turnId === source.turnId),
  ];
  const compiled = compileThreadContext(source, {
    contextWindow: 400_000,
    recentDialogueTokens: 100,
  });
  assert.deepEqual(compiled.frame.dialogueTurnIds, ['turn:new']);
  assert.equal(compiled.frame.omittedDialogueTurns, 1);
  assert.ok(compiled.frame.omissions.some(({ reason }) => reason === 'recent-dialogue-budget'));
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
    scopeKind: 'turn',
    threadVersionId: 'thread-version:2',
    threadMarkdown: '# Thread\n\nCurrent objective: implement the runtime.\n',
    messages,
    pressureNoticed: false,
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
