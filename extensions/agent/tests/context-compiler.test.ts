import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileShadowContext,
  type ContextAuthorityEntry,
  type ShadowContextSource,
} from '../server/src/context/compiler.ts';
import type { LogicalContextMessage } from '../server/src/logical-context.ts';

const FIXED_HASH = 'a'.repeat(64);

test('shadow compilation is byte-deterministic and authority input order independent', () => {
  const first = authority('primary:z', 'zeta', { text: 'Keep the journal authoritative.' });
  const second = authority('primary:a', 'alpha', { text: 'Keep thread intent local.' });
  const source = fixtureSource([first, second]);
  const left = compileShadowContext(source, profile(2_000));
  const right = compileShadowContext({ ...source, authority: [second, first] }, profile(2_000));

  assert.equal(left.semanticHash, right.semanticHash);
  assert.equal(left.bootstrap, right.bootstrap);
  assert.deepEqual(left.blocks, right.blocks);
  assert.match(left.bootstrapHash, /^[0-9a-f]{64}$/u);
  assert.equal(left.decision.kind, 'append');
  const changedContracts = compileShadowContext(source, {
    ...profile(2_000),
    fixedContractsHash: 'b'.repeat(64),
  });
  assert.notEqual(changedContracts.semanticHash, left.semanticHash);
});

test('thread-local authority changes only the targeted candidate', () => {
  const shared = authority('primary:shared', 'architecture', { text: 'Shared project architecture.' });
  const threadA = authority('primary:a', 'goal', { text: 'Implement the context compiler.' });
  const threadB = authority('primary:b', 'goal', { text: 'Repair an unrelated viewer bug.' });
  const source = fixtureSource([shared, threadA]);
  const candidateA = compileShadowContext(source, profile(2_000));
  const candidateB = compileShadowContext({
    ...source,
    strandId: 'strand:b',
    targetContextSpaceId: 'space:b',
    authority: [shared, threadB],
  }, profile(2_000));

  assert.match(candidateA.bootstrap, /Implement the context compiler/u);
  assert.doesNotMatch(candidateA.bootstrap, /unrelated viewer bug/u);
  assert.match(candidateB.bootstrap, /unrelated viewer bug/u);
  assert.doesNotMatch(candidateB.bootstrap, /Implement the context compiler/u);
  assert.notEqual(candidateA.semanticHash, candidateB.semanticHash);
});

test('selection keeps complete tool exchanges and externalizes oversized values', () => {
  const oversized = 'x'.repeat(24 * 1024);
  const source = fixtureSource([
    authority('primary:large', 'large', { text: oversized }),
  ], [
    user('turn:prior', 'Inspect README.'),
    assistant('turn:prior', 'Reading.', [{ callId: 'call:read', name: 'workspace.read', args: { path: 'README.md' } }]),
    tool('turn:prior', 'call:read', { path: 'README.md', text: oversized }),
    user('turn:current', 'Continue from the prior evidence.'),
  ]);
  const candidate = compileShadowContext(source, profile(2_000, {
    snapshotTargetTokens: 12_000,
    snapshotHardMaxTokens: 16_000,
    oversizedValueBytes: 2_048,
  }));
  const raw = candidate.blocks.find(({ kind }) => kind === 'raw_tail');
  assert.ok(raw);
  const rawValue = JSON.parse(raw.text) as { messages: Array<{ role?: string; externalized?: boolean }> };
  const roles = rawValue.messages.map(({ role }) => role).filter(Boolean);
  assert.deepEqual(roles.slice(0, 2), ['user', 'assistant']);
  assert.equal(rawValue.messages.some(({ externalized }) => externalized === true), true);
  assert.equal(candidate.omissions.some(({ reason }) => reason === 'oversized-primary-body'), true);
  assert.equal(candidate.omissions.some(({ reason }) => reason === 'oversized-tool-message'), true);
  assert.ok(candidate.omissions.every(({ retrieval }) => retrieval.startsWith('agent://')));
});

test('policy emits append, roll, and block without changing candidate determinism', () => {
  const source = fixtureSource([]);
  const policy = {
    outputReserveTokens: 1_000,
    safetyMarginTokens: 0,
    hardInputLimitTokens: 10_000,
    rollThresholdTokens: 2_000,
    snapshotTargetTokens: 4_000,
    snapshotHardMaxTokens: 5_000,
  };
  assert.equal(compileShadowContext(source, profile(1_999, policy)).decision.kind, 'append');
  assert.equal(compileShadowContext(source, {
    ...profile(2_000, policy),
    pressureNoticeSent: true,
  }).decision.kind, 'roll');

  const blocked = compileShadowContext(fixtureSource([], [
    user('turn:current', 'u'.repeat(24 * 1024)),
  ]), profile(2_000, {
    ...policy,
    snapshotTargetTokens: 1_200,
    snapshotHardMaxTokens: 1_500,
  }));
  assert.equal(blocked.decision.kind, 'block');
  assert.ok(blocked.estimatedInputTokens > 1_500);
});

function fixtureSource(
  entries: readonly ContextAuthorityEntry[],
  messages: readonly LogicalContextMessage[] = [
    user('turn:old', 'Earlier project question.'),
    assistant('turn:old', 'Earlier answer.'),
    user('turn:current', 'Implement the next context phase.'),
  ],
): ShadowContextSource {
  return {
    basisSequence: 42,
    projectId: 'project:remux',
    projectRevision: 7,
    conversationId: 'conversation:context',
    strandId: 'strand:a',
    turnId: 'turn:current',
    scopeId: 'scope:current',
    epochId: 'epoch:current',
    targetContextSpaceId: 'space:a',
    workspaceRoot: '/workspace/remux',
    reasoning: 'high',
    messages,
    authority: entries,
    turnAnchor: {
      currentUser: {
        ref: 'journal://event/42',
        body: messages.find((message): message is Extract<LogicalContextMessage, { role: 'user' }> =>
          message.role === 'user' && message.turnId === 'turn:current')?.text ?? '',
      },
      precedingAssistantRef: 'journal://turn/turn%3Aold#assistant',
      acceptedProposalRef: null,
      steeringRefs: [],
    },
    observedRuntime: {
      cwd: '/workspace/remux',
      gitRoot: '/workspace/remux',
      head: 'a'.repeat(40),
      dirtyPaths: [],
      statusHash: 'b'.repeat(64),
      observedAt: 1,
      activeOperations: [],
      recentCommands: [],
      recentFailures: [],
      recentWorkUnits: [],
      changedPaths: [],
    },
    executionScope: {
      kind: 'turn',
      parentScopeId: null,
      objective: { intent: 'Serve the accepted user turn.' },
      capsuleRef: null,
    },
  };
}

function profile(activeEstimatedInputTokens: number, policy: Record<string, number> = {}) {
  return {
    modelId: 'gpt-5.4',
    contextWindow: 128_000,
    fixedContractsHash: FIXED_HASH,
    activeEstimatedInputTokens,
    policy,
  };
}

function authority(primaryId: string, key: string, body: { text: string }): ContextAuthorityEntry {
  return {
    primaryId,
    key,
    kind: 'record',
    authority: 'user',
    mode: 'inline',
    descriptor: { title: key },
    body,
    sourceSpaceIds: ['space:root', 'space:a'],
    version: 1,
  };
}

function user(turnId: string, text: string): LogicalContextMessage {
  return { role: 'user', turnId, text, timestamp: 1 };
}

function assistant(
  turnId: string,
  text: string,
  toolCalls: Array<{ callId: string; name: string; args: unknown }> = [],
): LogicalContextMessage {
  return {
    role: 'assistant',
    turnId,
    text,
    reasoning: '',
    toolCalls,
    state: 'completed',
    timestamp: 2,
  };
}

function tool(turnId: string, callId: string, result: unknown): LogicalContextMessage {
  return {
    role: 'tool',
    turnId,
    callId,
    name: 'workspace.read',
    result,
    isError: false,
    timestamp: 3,
  };
}
