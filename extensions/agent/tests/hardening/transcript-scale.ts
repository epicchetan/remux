import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

import { AGENT_METHODS } from '../../shared/protocol.ts';
import {
  AGENT_TRANSCRIPT_PROJECTION_VERSION,
  AGENT_TRANSCRIPT_PROTOCOL_VERSION,
  MAX_TRANSCRIPT_RESPONSE_BYTES,
  type AgentTranscriptResourcesReadResult,
  type AgentTranscriptSyncRequest,
  type AgentTranscriptSyncResource,
  type AgentTurnRenderFrame,
  type AgentExecutionScopeResource,
  type AgentOperationDetailResource,
  type AgentWorkRenderSegment,
} from '../../shared/transcript.ts';
import { AgentServer } from '../../server/src/agent-server.ts';
import { FixtureProvider } from '../../server/src/fixture-provider.ts';
import { AgentStateStore } from '../../server/src/storage/agent-state-store.ts';
import { EphemeralTranscriptProjector } from '../../server/src/transcript-projector.ts';

const COMPLETED_TURNS = 250;
const LARGE_HISTORY_TURNS = 30;
const LARGE_BODY_BYTES = 2 * 1024 * 1024;
const TOOL_ROWS = 1_000;
const TOOL_RESULT_BYTES = 8 * 1024 * 1024;
const COLD_SAMPLES = 20;
const STARTUP_SAMPLES = 5;
const CHECKPOINT_SAMPLES = 100;
const CHECKPOINT_CADENCE_MS = 50;

const root = await mkdtemp(join(tmpdir(), 'remux-agent-hardening-'));
const dataRoot = join(root, 'data');
const workspace = join(root, 'workspace');
await mkdir(workspace);

let repository: AgentStateStore | null = null;
let server: AgentServer | null = null;
try {
  repository = await AgentStateStore.open({ dataRoot });
  const conversation = await repository.createConversation({
    operationId: randomUUID(),
    cwd: workspace,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high',
  });
  const turnIds: string[] = [];
  let workTurnId = '';

  for (let index = 0; index < COMPLETED_TURNS; index += 1) {
    const largePrefix = `unselected-artifact-${index}:`;
    const text = index < LARGE_HISTORY_TURNS
      ? largePrefix + 'x'.repeat(LARGE_BODY_BYTES - Buffer.byteLength(largePrefix))
      : index % 7 === 0
        ? `## Durable turn ${index}\n\n- bounded\n- replayable\n`
        : `Durable request ${index}.`;
    const turn = await repository.acceptTurn({
      operationId: randomUUID(),
      conversationId: conversation.conversationId,
      clientMessageId: randomUUID(),
      contextPlan: { version: 1, automaticDialogueTurns: 2, overrides: [] },
      text,
    });
    turnIds.push(turn.turnId);

    if (index === 40) {
      const prefix = 'oversized-assistant:';
      await repository.appendAssistantCheckpoint(turn, {
        reasoningDelta: '',
        textDelta: prefix + 'a'.repeat(LARGE_BODY_BYTES - Buffer.byteLength(prefix)),
      });
    } else if (index % 11 === 0) {
      await repository.appendAssistantCheckpoint(turn, {
        reasoningDelta: `Reasoning ${index}.`,
        textDelta: `Completed ${index}.`,
      });
    }

    if (index === 50) {
      workTurnId = turn.turnId;
      const context = await repository.compileContext(conversation.conversationId);
      const inference = await repository.startInference(turn, {
        modelId: 'gpt-5.4-fixture',
        requestMode: 'full',
        estimatedInputTokens: 2_000,
        payload: { messages: [] },
        context: {
          basisSequence: context.basisSequence,
          logicalHash: context.logicalHash,
          renderedHash: 'a'.repeat(64),
          orderedMessageHashes: context.orderedMessageHashes,
          messageCount: context.messages.length + 1,
          fixedContractsHash: 'b'.repeat(64),
          frame: context.frame,
          frameBuildDurationMs: 1,
          activeMessages: context.messages,
        },
      });
      for (let row = 0; row < TOOL_ROWS; row += 1) {
        const callId = `hardening-call-${row}`;
        await repository.recordToolStarted(turn, {
          callId,
          name: 'workspace.read',
          args: { path: `generated-${row}.md` },
          sourceInferenceId: inference.inferenceId,
        });
        const result = row === 0
          ? { output: 'r'.repeat(TOOL_RESULT_BYTES) }
          : { path: `generated-${row}.md`, row };
        await repository.recordToolFinished(turn, { callId, result, isError: false });
        if ((row + 1) % 250 === 0) {
          process.stderr.write(`seeded ${row + 1}/${TOOL_ROWS} work rows\n`);
        }
      }
      await repository.finishInference(turn, { state: 'completed' });
    }

    await repository.finishTurn(turn, index === 45
      ? { status: 'failed', error: 'Injected durable failure.', errorCode: 'runtime_error' }
      : index === 46
        ? { status: 'interrupted' }
        : { status: 'completed' });

    if (index === 47) {
      const restartTurn: Awaited<ReturnType<AgentStateStore['acceptTurn']>> =
        await repository.acceptTurn({
        operationId: randomUUID(),
        conversationId: conversation.conversationId,
        clientMessageId: randomUUID(),
        contextPlan: { version: 1, automaticDialogueTurns: 2, overrides: [] },
        text: 'Recover this unfinished turn as interrupted by restart.',
        });
      await repository.appendAssistantCheckpoint(restartTurn, {
        reasoningDelta: '',
        textDelta: 'Partial restart output.',
      });
      await repository.close();
      repository = await AgentStateStore.open({ dataRoot });
      const recovery = await repository.resumeActiveTurn(conversation.conversationId);
      assert.equal(recovery?.rootHandle.turnId, restartTurn.turnId);
      await repository.finishTurn(recovery!.rootHandle, { status: 'interrupted' });
    }

    if ((index + 1) % 50 === 0) {
      process.stderr.write(`seeded ${index + 1}/${COMPLETED_TURNS} completed turns\n`);
    }
  }

  assert.ok(workTurnId);
  const activeTail = await repository.acceptTurn({
    operationId: randomUUID(),
    conversationId: conversation.conversationId,
    clientMessageId: randomUUID(),
    contextPlan: { version: 1, automaticDialogueTurns: 2, overrides: [] },
    text: 'Keep one streaming tail turn active for the corpus.',
  });

  let checkpointPublications = 0;
  const checkpointProjector = new EphemeralTranscriptProjector({
    conversationId: conversation.conversationId,
    invalidate: () => {
      checkpointPublications += 1;
    },
  });
  checkpointProjector.beginTurn({
    turnId: activeTail.turnId,
    scopeId: activeTail.scopeId,
    clientMessageId: activeTail.clientMessageId,
    text: 'Keep one streaming tail turn active for the corpus.',
    sequence: activeTail.transcriptSequence,
    basisSequence: activeTail.basisSequence,
    createdAt: activeTail.transcriptCreatedAt,
    userItemId: activeTail.userItemId,
    ...(activeTail.userContent ? { content: activeTail.userContent } : {}),
  });
  checkpointPublications = 0;
  const checkpointCommitDurations: number[] = [];
  const checkpointDurations: number[] = [];
  const checkpointPublicationDurations: number[] = [];
  for (let index = 0; index < CHECKPOINT_SAMPLES; index += 1) {
    if (index > 0) await delay(CHECKPOINT_CADENCE_MS);
    const delta = `${index.toString(16)}.`;
    const startedAt = performance.now();
    const mutation = await repository.appendAssistantCheckpoint(activeTail, {
      reasoningDelta: '',
      textDelta: delta,
    });
    const committedAt = performance.now();
    assert.ok(mutation);
    checkpointProjector.appendAssistantText(activeTail.turnId, delta, {
      sequence: mutation.basisSequence,
      basisSequence: mutation.basisSequence,
      createdAt: mutation.createdAt,
      itemId: mutation.itemId,
    });
    const publishedAt = performance.now();
    checkpointCommitDurations.push(committedAt - startedAt);
    checkpointPublicationDurations.push(publishedAt - committedAt);
    checkpointDurations.push(publishedAt - startedAt);
  }
  assert.equal(checkpointPublications, CHECKPOINT_SAMPLES);

  const database = new DatabaseSync(repository.databasePath, { readOnly: true });
  const oldArtifact = database.prepare(`
    SELECT a.storage_path
    FROM transcript_items ti
    JOIN artifacts a ON a.hash = json_extract(ti.value_json, '$.content.hash')
    WHERE ti.turn_id = ? AND ti.kind = 'user'
  `).get(turnIds[0]) as { storage_path: string };
  const artifactTotals = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes FROM artifacts
  `).get() as { count: number; bytes: number };
  const turnCount = (database.prepare(`
    SELECT COUNT(*) AS count FROM turns WHERE conversation_id = ?
  `).get(conversation.conversationId) as { count: number }).count;
  database.close();
  assert.ok(artifactTotals.bytes >= 68 * 1024 * 1024);
  assert.equal(turnCount, COMPLETED_TURNS + 2);

  const artifactPath = join(dataRoot, 'artifacts', oldArtifact.storage_path);
  const heldArtifactPath = join(root, 'held-unselected-artifact');
  await rename(artifactPath, heldArtifactPath);
  const tailDurations: number[] = [];
  const aroundDurations: number[] = [];
  let tailProjection;
  let aroundProjection;
  try {
    for (let sample = 0; sample < COLD_SAMPLES; sample += 1) {
      let startedAt = performance.now();
      tailProjection = await repository.readTranscriptWindowProjection({
        conversationId: conversation.conversationId,
        requests: [syncRequest({ kind: 'tail', count: 24 })],
      });
      tailDurations.push(performance.now() - startedAt);
      startedAt = performance.now();
      aroundProjection = await repository.readTranscriptWindowProjection({
        conversationId: conversation.conversationId,
        requests: [syncRequest({
          kind: 'around',
          turnId: turnIds[125]!,
          before: 19,
          after: 20,
        })],
      });
      aroundDurations.push(performance.now() - startedAt);
    }
  } finally {
    await rename(heldArtifactPath, artifactPath);
  }
  assert.ok(tailProjection && aroundProjection);
  assert.ok(tailProjection.selectedTurnIds.length <= 40);
  assert.equal(aroundProjection.selectedTurnIds.length, 40);
  assert.ok(tailProjection.estimatedBytes <= MAX_TRANSCRIPT_RESPONSE_BYTES);
  assert.ok(aroundProjection.estimatedBytes <= MAX_TRANSCRIPT_RESPONSE_BYTES);
  assert.ok(p95(tailDurations) <= 100, `cold tail p95 was ${p95(tailDurations)} ms`);
  assert.ok(p95(aroundDurations) <= 100, `cold around p95 was ${p95(aroundDurations)} ms`);
  assert.ok(
    p95(checkpointDurations) <= 25,
    `checkpoint commit/publication p95 was ${p95(checkpointDurations)} ms `
      + `(commit ${p95(checkpointCommitDurations)} ms, publication `
      + `${p95(checkpointPublicationDurations)} ms)`,
  );

  server = new AgentServer({
    provider: new FixtureProvider(),
    store: repository,
    notify: () => {},
  });
  await server.initialize();
  const workSync = await transcriptRead(server, conversation.conversationId, [syncRequest({
    kind: 'around',
    turnId: workTurnId,
    before: 0,
    after: 0,
  })]);
  const workFrame = requiredFrame(requiredSync(workSync).turns[0]);
  const work = workFrame.segments.find((segment): segment is AgentWorkRenderSegment =>
    segment.type === 'work');
  assert.ok(work);
  const scopeResult = await transcriptRead(server, conversation.conversationId, [{
    type: 'executionScope',
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    turnId: workFrame.id,
    scopeId: work.scopeId,
  }]);
  const scopeEntry = scopeResult.resources[0];
  assert.equal(scopeEntry?.status, 'ok');
  const scope = scopeEntry?.status === 'ok'
    ? scopeEntry.value as AgentExecutionScopeResource
    : null;
  assert.ok(scope);
  assert.equal(scope.inferences.length, 1);
  const calls = scope.inferences[0]?.actionGroup?.calls ?? [];
  assert.equal(calls.length, TOOL_ROWS);
  assert.equal(new Set(calls.map((call) => call.id)).size, TOOL_ROWS);
  const firstCall = calls[0];
  assert.ok(firstCall);

  const detailResult = await transcriptRead(server, conversation.conversationId, [{
    type: 'operationDetail',
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    turnId: workFrame.id,
    scopeId: work.scopeId,
    operationId: firstCall.id,
  }]);
  const detailEntry = detailResult.resources[0];
  assert.equal(detailEntry?.status, 'ok');
  const detail = detailEntry?.status === 'ok'
    ? detailEntry.value as AgentOperationDetailResource
    : null;
  assert.ok(detail?.truncation.truncated);
  assert.ok(detail.content?.output?.artifactHash);

  await server.close();
  server = null;
  await repository.close();
  repository = null;

  const startupDurations: number[] = [];
  for (let sample = 0; sample < STARTUP_SAMPLES; sample += 1) {
    const startedAt = performance.now();
    const opened = await AgentStateStore.open({ dataRoot });
    await opened.readResourceProjections(['conversation-list']);
    startupDurations.push(performance.now() - startedAt);
    await opened.close();
  }
  assert.ok(p95(startupDurations) <= 1_500, `startup p95 was ${p95(startupDurations)} ms`);

  const finalRepository = await AgentStateStore.open({ dataRoot });
  const scrubStartedAt = performance.now();
  const scrub = await finalRepository.scrubArtifacts();
  const scrubElapsedMs = performance.now() - scrubStartedAt;
  assert.deepEqual(scrub.orphanStoragePaths, []);
  assert.equal(scrub.referencedArtifacts, artifactTotals.count);
  assert.equal(scrub.verifiedBytes, artifactTotals.bytes);
  await finalRepository.close();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    corpus: {
      artifactBytes: artifactTotals.bytes,
      artifacts: artifactTotals.count,
      completedTurns: COMPLETED_TURNS,
      totalTurns: turnCount,
      workRows: calls.length,
    },
    p95Ms: {
      around: rounded(p95(aroundDurations)),
      checkpointCommit: rounded(p95(checkpointCommitDurations)),
      checkpointCommitToPublication: rounded(p95(checkpointDurations)),
      checkpointPublication: rounded(p95(checkpointPublicationDurations)),
      startup: rounded(p95(startupDurations)),
      tail: rounded(p95(tailDurations)),
    },
    scrub: {
      elapsedMs: rounded(scrubElapsedMs),
      verifiedBytes: scrub.verifiedBytes,
    },
  }, null, 2)}\n`);
} finally {
  await server?.close().catch(() => undefined);
  await repository?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

function syncRequest(window: AgentTranscriptSyncRequest['window']): AgentTranscriptSyncRequest {
  return {
    type: 'transcriptSync',
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
    window,
  };
}

async function transcriptRead(
  target: AgentServer,
  conversationId: string,
  requests: unknown[],
) {
  return target.handle(AGENT_METHODS.transcriptResourcesRead, {
    conversationId,
    requests,
  }) as Promise<AgentTranscriptResourcesReadResult>;
}

function requiredSync(result: AgentTranscriptResourcesReadResult) {
  const entry = result.resources[0];
  assert.equal(entry?.status, 'ok');
  return entry?.status === 'ok' ? entry.value as AgentTranscriptSyncResource : fail();
}

function requiredFrame(result: AgentTranscriptSyncResource['turns'][number]) {
  assert.equal(result?.status, 'ok');
  return result?.status === 'ok' ? result.frame as AgentTurnRenderFrame : fail();
}

function p95(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY;
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function fail(): never {
  throw new Error('Required hardening resource was unavailable.');
}
