import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { PROVIDER_RUNTIME_CONTRACT_VERSION } from '../shared/provider-runtime.ts';

import { NativeFixtureAdapter } from '../server/src/native-fixture-adapter.ts';
import { NativeAgentArtifacts } from '../server/src/native-runtime/native-artifacts.ts';
import { NativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import { NativeAgentProjector } from '../server/src/native-runtime/native-projector.ts';
import { createNativeAgentSchema } from '../server/src/native-runtime/schema.ts';
import { prepareAgentDataPaths } from '../server/src/storage/data-root.ts';
import type { NativeTranscriptWindow } from '../shared/native-agent-protocol.ts';

test('authoritative large assistant output is stored and read through bounded viewer ranges', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'remux-agent-output-'));
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  try {
    const probe = await new NativeFixtureAdapter().probe('fixture-local');
    journal.upsertProviderInstance({
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      probe,
      now: 1,
    });
    journal.createConversation({
      conversationId: 'conversation-1',
      rootExecutionId: 'execution-1',
      provider: 'fixture',
      providerInstanceId: 'fixture-local',
      title: 'Large output',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'read-only',
      now: 1,
    });
    journal.claimCommand('send-1', 'turn.send', { text: 'large' }, 2);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Return the large result.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 2,
    });
    const text = `${'bounded-output\n'.repeat(5_000)}🙂`;
    journal.appendProviderEvent({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: 'assistant-large',
      provider: 'fixture',
      scope: {
        kind: 'turn',
        providerInstanceId: 'fixture-local',
        conversationId: 'conversation-1',
        executionId: 'execution-1',
        turnId: 'turn-1',
      },
      native: {
        sessionId: 'native-1',
        turnId: 'native-turn-1',
        position: { kind: 'native-sequence', sequence: 1, subIndex: 0 },
        kind: 'assistant/final',
      },
      observedAt: 3,
      event: {
        type: 'turn.block.completed',
        structure: {
          passId: 'pass-1', blockId: 'assistant-final', passOrdinal: 0, blockOrdinal: 0,
        },
        revision: 1,
        contentHash: 'a'.repeat(64),
        block: {
          kind: 'final-message',
          state: 'completed',
          payload: { kind: 'final-message', text },
        },
      },
    });
    const artifacts = new NativeAgentArtifacts({
      journal,
      paths: await prepareAgentDataPaths({ dataRoot }),
      now: () => 4,
    });
    const artifact = await artifacts.sealAssistantText('turn-1', text);
    assert.ok(artifact);
    assert.equal(journal.turn('turn-1')?.assistantArtifactId, artifact.artifactId);

    const transcript = new NativeAgentProjector(journal).project(
      'agent/transcript:conversation-1:tail-24',
    ) as NativeTranscriptWindow;
    const frame = transcript.turns[0]!;
    assert.ok(Buffer.byteLength(frame.assistantText, 'utf8') <= 48 * 1024);
    assert.equal(frame.assistantContent?.artifactId, artifact.artifactId);
    const range = await artifacts.read({
      artifactId: artifact.artifactId,
      offset: frame.assistantContent!.returnedBytes,
      byteLength: 256 * 1024,
    });
    assert.equal(
      Buffer.concat([Buffer.from(frame.assistantText), Buffer.from(range.base64, 'base64')]).toString('utf8'),
      text,
    );
  } finally {
    journal.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('exact diffs are sealed as viewer-readable content-addressed artifacts', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'remux-agent-diff-'));
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  try {
    const artifacts = new NativeAgentArtifacts({
      journal,
      paths: await prepareAgentDataPaths({ dataRoot }),
      now: () => 7,
    });
    const diff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const sealed = await artifacts.sealDiffText(diff);
    assert.match(sealed.artifactId, /^[0-9a-f]{64}$/u);
    assert.equal(sealed.mediaType, 'text/x-diff; charset=utf-8');
    const range = await artifacts.read({
      artifactId: sealed.artifactId,
      offset: 0,
      byteLength: 256 * 1024,
    });
    assert.equal(Buffer.from(range.base64, 'base64').toString('utf8'), diff);
  } finally {
    journal.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
