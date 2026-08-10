import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compileShadowContext } from '../server/src/context/compiler.ts';
import { AgentJournalRepository } from '../server/src/storage/repository.ts';

test('context workspace commits atomically, recalls ephemerally, releases, and survives reopen', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-context-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  await writeFile(join(workspace, 'accepted-spec.md'), '# Accepted spec\nExact contract body.\n');
  const ids = deterministicIds();
  let repository = await AgentJournalRepository.open({ dataRoot, idFactory: ids.next });
  const conversation = await repository.createConversation({
    operationId: uuid(1),
    cwd: workspace,
    modelId: 'gpt-5.6-sol',
    reasoning: 'high',
  });
  const turn = await repository.acceptTurn({
    operationId: uuid(2),
    conversationId: conversation.conversationId,
    clientMessageId: uuid(3),
    text: 'Implement the accepted context workspace.',
  });

  const committed = await repository.updateContext(turn, {
    set: [
      {
        key: 'active-implementation',
        value: {
          objective: 'Implement the accepted context workspace.',
          constraint: 'Never commit without explicit permission.',
          next: ['run the benchmark'],
        },
      },
    ],
    pin: [
      {
        ref: join(workspace, 'accepted-spec.md'),
        label: 'accepted spec',
      },
    ],
  });
  assert.equal(committed.revision, 1);
  assert.deepEqual(committed.state.map(({ key }) => key), ['active-implementation']);
  assert.equal(committed.pinned[0]?.state, 'pinned');

  const noOp = await repository.updateContext(turn, {
    set: [{
      key: 'active-implementation',
      value: {
        objective: 'Implement the accepted context workspace.',
        constraint: 'Never commit without explicit permission.',
        next: ['run the benchmark'],
      },
    }],
  });
  assert.equal(noOp.revision, 1);
  assert.match(noOp.warnings.join(' '), /No durable context change/u);
  const afterConflict = await repository.compileContext(conversation.conversationId);
  assert.equal(afterConflict.shadowSource.projectRevision, 1);
  const workingResource = afterConflict.shadowSource.authority.find(
    ({ kind }) => kind === 'working-resource',
  );
  assert.deepEqual(
    workingResource?.body,
    {
      byteLength: 37,
      contentHash: createHash('sha256').update('# Accepted spec\nExact contract body.\n').digest('hex'),
      label: 'accepted spec',
      resolvedPath: join(workspace, 'accepted-spec.md'),
      resource: join(workspace, 'accepted-spec.md'),
      retention: 'sticky',
      snapshotRef: `journal://artifact/${createHash('sha256').update('# Accepted spec\nExact contract body.\n').digest('hex')}`,
      text: '# Accepted spec\nExact contract body.\n',
      view: 'exact',
    },
  );
  assert.match(
    compileShadowContext(afterConflict.shadowSource, {
      modelId: 'gpt-5.6-sol',
      contextWindow: 258_400,
      fixedContractsHash: 'fixed-contracts',
      activeEstimatedInputTokens: 0,
    }).bootstrap,
    /Exact contract body\./u,
  );
  assert.deepEqual(
    afterConflict.shadowSource.authority.map(({ key, mode }) => ({ key, mode })),
    [
      { key: 'active-implementation', mode: 'inline' },
      { key: committed.pinned[0] ? `working:${workingKey(committed.pinned[0].ref)}` : '', mode: 'inline' },
    ],
  );

  const search = await repository.searchJournal(conversation.conversationId, {
    query: 'explicit permission',
    scope: 'project',
  });
  assert.equal(search.retention, 'ephemeral');
  assert.equal(search.hits.length > 0, true);
  const opened = await repository.openJournal(conversation.conversationId, {
    ref: search.hits[0]!.ref,
    maxBytes: 512,
  });
  assert.equal(opened.retention, 'ephemeral');
  assert.match(opened.content, /explicit permission/u);

  const released = await repository.updateContext(turn, {
    unpin: [{ ref: committed.pinned[0]!.ref }],
  });
  assert.equal(released.revision, 2);
  assert.equal(released.pinned[0]?.state, 'unpinned');
  const releasedContext = await repository.compileContext(conversation.conversationId);
  assert.equal(
    releasedContext.shadowSource.authority.find(({ kind }) => kind === 'working-resource')?.mode,
    'available',
  );

  await repository.finishTurn(turn, { status: 'completed' });
  await repository.close();
  repository = await AgentJournalRepository.open({ dataRoot, idFactory: ids.next });
  t.after(() => repository.close());
  const reopened = await repository.compileContext(conversation.conversationId);
  assert.equal(reopened.shadowSource.projectRevision, 2);
  assert.equal(
    reopened.shadowSource.authority.find(({ key }) => key === 'active-implementation')?.authority,
    'model',
  );
});

test('H4 references, search, provenance, anchors, runtime, and work units compose end to end', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-context-h4-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  await writeFile(join(workspace, 'tracked.txt'), 'base\n');
  const ids = deterministicIds();
  const repository = await AgentJournalRepository.open({ dataRoot, idFactory: ids.next });
  t.after(() => repository.close());
  const conversation = await repository.createConversation({
    operationId: uuid(20),
    cwd: workspace,
    modelId: 'gpt-5.6-sol',
    reasoning: 'high',
  });
  const first = await repository.acceptTurn({
    operationId: uuid(21),
    conversationId: conversation.conversationId,
    clientMessageId: uuid(22),
    text: 'Propose the H4 implementation boundary.',
  });
  await repository.appendAssistantCheckpoint(first, {
    textDelta: 'Proposal: use exact refs and one sequential child.',
    reasoningDelta: '',
  });
  await repository.finishTurn(first, { status: 'completed' });
  const second = await repository.acceptTurn({
    operationId: uuid(23),
    conversationId: conversation.conversationId,
    clientMessageId: uuid(24),
    text: 'Ok, proceed.',
  });
  const anchored = await repository.compileContext(conversation.conversationId);
  assert.match(anchored.shadowSource.turnAnchor.precedingAssistantRef ?? '', /#assistant$/u);
  const proposalRef = anchored.shadowSource.turnAnchor.precedingAssistantRef!;
  assert.match((await repository.openJournal(conversation.conversationId, { ref: proposalRef })).content, /Proposal:/u);
  const proposalMessageRef = (await repository.searchJournal(conversation.conversationId, {
    query: 'exact refs sequential child',
  })).hits.find(({ kind }) => kind.startsWith('assistant-'))?.ref;
  assert.match(proposalMessageRef ?? '', /^journal:\/\/message\//u);

  const beforeRevision = anchored.shadowSource.projectRevision;
  await assert.rejects(
    () => repository.updateContext(second, {
      set: [{
        key: 'ledger-feed-plan',
        value: { accepted: true },
        evidence: [proposalMessageRef!, 'journal://event/999999'],
      }],
    }),
    /does not exist/u,
  );
  assert.equal((await repository.compileContext(conversation.conversationId)).shadowSource.projectRevision, beforeRevision);
  const accepted = await repository.updateContext(second, {
    set: [{
      key: 'ledger-feed-plan',
      value: { accepted: true },
      evidence: [proposalMessageRef!],
    }],
    pin: [{ ref: join(workspace, 'tracked.txt') }],
  });
  assert.equal(accepted.revision, beforeRevision + 1);
  const acceptedContext = await repository.compileContext(conversation.conversationId);
  assert.equal(acceptedContext.shadowSource.turnAnchor.acceptedProposalRef, proposalMessageRef);
  const acceptedPrimary = acceptedContext.shadowSource.authority.find(({ key }) => key === 'ledger-feed-plan');
  assert.equal(acceptedPrimary?.primaryId !== undefined, true);
  assert.match(
    (await repository.openJournal(conversation.conversationId, {
      ref: `journal://primary/${encodeURIComponent(acceptedPrimary!.primaryId)}`,
    })).content,
    /ledger-feed-plan/u,
  );
  const exact = acceptedContext.shadowSource.authority.find(({ kind }) => kind === 'working-resource');
  const exactBody = exact?.body as { snapshotRef?: string };
  assert.match((await repository.openJournal(conversation.conversationId, {
    ref: exactBody.snapshotRef!,
  })).content, /base/u);
  const pinnedProposal = await repository.updateContext(second, {
    pin: [{ ref: proposalRef, label: 'accepted proposal' }],
  });
  assert.equal(pinnedProposal.pinned.some(({ ref }) => ref === proposalRef), true);

  await repository.recordToolStarted(second, {
    callId: 'search-fixture-call',
    name: 'bash',
    args: { command: 'secret-operation-only' },
  });
  await repository.recordToolFinished(second, {
    callId: 'search-fixture-call',
    result: { exitCode: 0, output: 'secret-operation-only' },
    isError: false,
  });
  assert.equal((await repository.searchJournal(conversation.conversationId, {
    query: 'secret-operation-only',
  })).hits.length, 0);
  const operationSearch = await repository.searchJournal(conversation.conversationId, {
    query: 'secret-operation-only',
    include: 'operations',
  });
  assert.deepEqual(operationSearch.hits.map(({ ref }) => ref), ['journal://tool/search-fixture-call']);

  const deterministicLeft = await repository.compileContext(conversation.conversationId);
  const deterministicRight = await repository.compileContext(conversation.conversationId);
  assert.deepEqual(deterministicLeft.shadowSource.observedRuntime, deterministicRight.shadowSource.observedRuntime);
  for (const ref of new Set(deterministicLeft.shadowSource.turnAnchor.steeringRefs.concat(
    deterministicLeft.shadowSource.turnAnchor.currentUser.ref,
    deterministicLeft.shadowSource.turnAnchor.precedingAssistantRef ?? [],
    deterministicLeft.shadowSource.turnAnchor.acceptedProposalRef ?? [],
    ...compileShadowContext(deterministicLeft.shadowSource, {
      modelId: 'gpt-5.6-sol',
      contextWindow: 400_000,
      fixedContractsHash: 'h4-contract',
      activeEstimatedInputTokens: 0,
    }).blocks.flatMap(({ sources }) => sources),
  ))) {
    await repository.openJournal(conversation.conversationId, { ref, maxBytes: 512 });
  }

  const entered = await repository.workUnit(second, {
    action: 'enter',
    objective: 'Inspect and validate the exact-reference implementation.',
    refs: [proposalRef, 'tracked.txt:1'],
    expectedEvidence: ['openable proposal and validation refs'],
  });
  assert.equal(entered.result.action, 'entered');
  assert.match((await repository.openJournal(conversation.conversationId, {
    ref: entered.result.capsuleRef!,
  })).content, /exact-reference implementation/u);
  const childContext = await repository.compileContext(conversation.conversationId);
  assert.equal(childContext.shadowSource.executionScope.kind, 'work_unit');
  await assert.rejects(() => repository.workUnit(entered.handle, {
    action: 'enter', objective: 'nested',
  }), /Nested or concurrent/u);
  await assert.rejects(() => repository.updateContext(entered.handle, {
    set: [{ scope: 'project', key: 'forbidden', value: true }],
  }), /cannot write project-scoped/u);
  const local = await repository.updateContext(entered.handle, {
    set: [{ key: 'child-progress', value: { status: 'validated' }, evidence: [proposalRef] }],
  });
  assert.equal(local.state.some(({ key }) => key === 'child-progress'), true);
  await assert.rejects(() => repository.workUnit(entered.handle, {
    action: 'return', status: 'completed', findings: [], commit: {},
  }), /between 1 and 16 total changes/u);
  assert.equal(
    (await repository.compileContext(conversation.conversationId)).shadowSource.executionScope.kind,
    'work_unit',
  );
  const returned = await repository.workUnit(entered.handle, {
    action: 'return',
    status: 'completed',
    findings: [{ text: 'The proposal is openable.', evidence: [proposalRef, 'tracked.txt:1'] }],
    validationRefs: ['journal://tool/search-fixture-call'],
    commit: {
      remember: [{
        key: 'unit-handoff',
        value: { status: 'validated', next: 'integrate' },
        evidence: ['tracked.txt:1'],
      }],
    },
  });
  const result = await repository.openJournal(conversation.conversationId, { ref: returned.result.resultRef! });
  assert.match(result.content, /The proposal is openable/u);
  assert.match(result.content, /journal:\/\/artifact\/[0-9a-f]{64}/u);
  assert.equal(returned.result.committed?.state.some(({ key }) => key === 'unit-handoff'), true);
  assert.match((await repository.openJournal(conversation.conversationId, {
    ref: returned.result.traceRef,
    maxBytes: 32 * 1024,
  })).content, /work_unit/u);
  const parentContext = await repository.compileContext(conversation.conversationId);
  assert.equal(parentContext.shadowSource.executionScope.kind, 'turn');
  assert.equal(parentContext.shadowSource.authority.some(({ key }) => key === 'child-progress'), false);
  assert.equal(parentContext.shadowSource.authority.some(({ key }) => key === 'unit-handoff'), true);
  assert.match(JSON.stringify(parentContext.shadowSource.observedRuntime), /recentWorkUnits/u);
  const next = await repository.workUnit(returned.handle, {
    action: 'enter', objective: 'Consume only the bounded shared handoff.',
  });
  const nextContext = await repository.compileContext(conversation.conversationId);
  assert.equal(nextContext.shadowSource.authority.some(({ key }) => key === 'unit-handoff'), true);
  assert.doesNotMatch(JSON.stringify(nextContext.shadowSource.messages), /The proposal is openable/u);
  const finished = await repository.workUnit(next.handle, {
    action: 'return', status: 'completed', findings: [],
    commit: { forget: ['unit-handoff'] },
  });
  await repository.finishTurn(finished.handle, { status: 'completed' });
});

test('an active work unit survives repository restart from its capsule', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-context-h4-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  const ids = deterministicIds();
  let repository = await AgentJournalRepository.open({ dataRoot, idFactory: ids.next });
  const conversation = await repository.createConversation({
    operationId: uuid(30), cwd: workspace, modelId: 'gpt-5.6-sol', reasoning: 'high',
  });
  const turn = await repository.acceptTurn({
    operationId: uuid(31), conversationId: conversation.conversationId,
    clientMessageId: uuid(32), text: 'Run restart-safe bounded work.',
  });
  const entered = await repository.workUnit(turn, {
    action: 'enter', objective: 'Resume from the exact capsule after restart.',
  });
  await repository.close();
  repository = await AgentJournalRepository.open({ dataRoot, idFactory: ids.next });
  t.after(() => repository.close());
  const resumed = await repository.resumeActiveWorkUnit(conversation.conversationId);
  assert.equal(resumed?.handle.scopeId, entered.handle.scopeId);
  const context = await repository.compileContext(conversation.conversationId);
  assert.equal(context.shadowSource.executionScope.capsuleRef, entered.result.capsuleRef);
  const latest = context.shadowSource.messages.at(-1);
  assert.match(latest?.role === 'user' ? latest.text : '', /runtime restart/u);
  const returned = await repository.workUnit(resumed!.handle, {
    action: 'return', status: 'completed', findings: [],
  });
  await repository.finishTurn(returned.handle, { status: 'completed' });
});

test('work-unit line ranges remain openable when identical evidence is reused by another project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-context-work-unit-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'data');
  const ids = deterministicIds();
  const repository = await AgentJournalRepository.open({ dataRoot, idFactory: ids.next });
  t.after(() => repository.close());

  const evidenceRefs: string[] = [];
  for (const [index, workspaceName] of ['workspace-a', 'workspace-b'].entries()) {
    const workspace = join(root, workspaceName);
    await mkdir(workspace);
    await writeFile(join(workspace, 'shared.txt'), 'zero\none\ntwo\nthree\n');
    const conversation = await repository.createConversation({
      operationId: uuid(40 + index * 3),
      cwd: workspace,
      modelId: 'gpt-5.6-sol',
      reasoning: 'high',
    });
    const turn = await repository.acceptTurn({
      operationId: uuid(41 + index * 3),
      conversationId: conversation.conversationId,
      clientMessageId: uuid(42 + index * 3),
      text: 'Inspect the shared evidence range.',
    });
    const entered = await repository.workUnit(turn, {
      action: 'enter',
      objective: 'Inspect only the cited evidence range.',
      refs: ['shared.txt:2-3'],
    });
    const capsule = JSON.parse((await repository.openJournal(conversation.conversationId, {
      ref: entered.result.capsuleRef!,
    })).content) as { refs: Array<{ source: string; ref: string }> };
    const evidenceRef = capsule.refs.find(({ source }) => source === 'shared.txt:2-3')?.ref;
    assert.match(evidenceRef ?? '', /^journal:\/\/artifact\/[0-9a-f]{64}$/u);
    const evidence = await repository.openJournal(conversation.conversationId, { ref: evidenceRef! });
    assert.equal(evidence.content, 'shared.txt:2-3\none\ntwo\n');
    evidenceRefs.push(evidenceRef!);
    const returned = await repository.workUnit(entered.handle, {
      action: 'return',
      status: 'completed',
      findings: [{ text: 'The cited range is exact.', evidence: ['shared.txt:2-3'] }],
    });
    await repository.finishTurn(returned.handle, { status: 'completed' });
  }
  assert.equal(evidenceRefs[0], evidenceRefs[1]);
});

function deterministicIds() {
  let counter = 1;
  return {
    next: () => `00000000-0000-4000-8000-${(counter++).toString(16).padStart(12, '0')}`,
  };
}

function uuid(value: number) {
  return `f0000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function workingKey(resource: string) {
  return createHash('sha256').update(resource).digest('hex').slice(0, 24);
}
