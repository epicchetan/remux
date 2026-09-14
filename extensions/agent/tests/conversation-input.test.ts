import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { NativeFixtureAdapter } from '../server/src/native-fixture-adapter.ts';
import { NativeAgentCoordinator } from '../server/src/native-runtime/native-coordinator.ts';
import { NativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import { createNativeAgentSchema } from '../server/src/native-runtime/schema.ts';
import type { ProviderAdapter } from '../server/src/provider-adapter.ts';
import { projectNativeTurn } from '../viewer/src/nativeTranscriptViewModel.ts';

for (const unknown of [false, true]) {
  test(`active conversational input ${unknown ? 'holds uncertain delivery' : 'preserves message and turn identity'}`, async () => {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys=ON');
    createNativeAgentSchema(database);
    const journal = new NativeAgentJournal(database);
    const base = new NativeFixtureAdapter({ delayMs: 60_000 });
    let writes = 0;
    const adapter: ProviderAdapter = {
      probe: async (id) => {
        const probe = await base.probe(id);
        return { ...probe, capabilities: { ...probe.capabilities!, turns: {
          ...probe.capabilities!.turns, steer: true, activeInput: 'native-steer' as const,
        } } };
      },
      listModels: (id) => base.listModels(id),
      openSession: async (input) => {
        const session = await base.openSession(input);
        return Object.assign(session, { steer: async (_input: any, context: any) => {
          writes++;
          context.boundary.markPossiblySent(session.nativeSession.sessionId);
          return unknown
            ? { accepted: false as const, outcome: 'unknown' as const,
                crossing: { phase: 'possibly-sent' as const, detail: 'response-lost' as const },
                error: { code: 'lost', message: 'Response lost' } }
            : { accepted: true as const, outcome: 'accepted' as const,
                evidence: { kind: 'fixture-correlated-acceptance' as const,
                  sessionId: session.nativeSession.sessionId, commandId: _input.commandId } };
        } });
      },
    };
    const coordinator = new NativeAgentCoordinator({ journal, providers: [{
      providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture', adapter,
    }] });
    try {
      await coordinator.initialize();
      const created = await coordinator.createConversation({ commandId: 'create-input-test',
        providerInstanceId: 'fixture-local', cwd: '/workspace/remux', model: 'fixture-native-v1', access: 'read-only' });
      const message = (id: string, delivery: 'auto' | 'queue' = 'auto') => {
        const runtime = coordinator.projector.runtimeResource(created.conversationId)!;
        return { commandId: id, clientMessageId: `client-${id}`, conversationId: created.conversationId,
          content: [{ type: 'text' as const, text: id }], providerInstanceId: runtime.providerInstanceId,
          model: runtime.composer.nextTurn.model, effort: runtime.composer.nextTurn.effort,
          serviceTier: runtime.composer.nextTurn.serviceTier, access: runtime.composer.nextTurn.access,
          configurationRevision: runtime.composer.revision, delivery };
      };
      const first = await coordinator.sendMessage(message('first'));
      const originalNativeId = journal.turn(first.turnId)!.nativeTurnId;
      const secondInput = message('second');
      const admitted = await coordinator.sendMessage(secondInput);
      assert.equal(admitted.delivery, 'queued', 'receipt proves local admission, not provider delivery');
      await until(() => writes === 1 && journal.database.prepare(
        'SELECT state FROM delivery_attempts WHERE command_id=?').get('second')?.state === (unknown ? 'unknown' : 'accepted'));
      assert.deepEqual(await coordinator.sendMessage(secondInput), admitted, 'same command must not resend');
      assert.equal(writes, 1);
      assert.equal(journal.turns(created.conversationId).length, 1);
      assert.equal(journal.turn(first.turnId)!.nativeTurnId, originalNativeId);
      assert.deepEqual(journal.turn(first.turnId)!.userContent, [{ type: 'text', text: 'first' }]);
      if (unknown) {
        assert.equal(journal.additionalTurnMessages(first.turnId).length, 0);
        assert.equal(journal.hasUnresolvedRootDelivery(created.conversationId), true);
        await coordinator.sendMessage(message('third'));
        assert.equal(writes, 1);
      } else {
        assert.equal(journal.additionalTurnMessages(first.turnId)[0]?.clientMessageId, 'client-second');
        const frame = coordinator.projector.project(`agent/turn:${first.turnId}`) as import('../shared/native-agent-protocol.ts').NativeAgentTurnFrame;
        const messages = projectNativeTurn(frame).segments.filter((segment) => segment.type === 'userMessage');
        assert.deepEqual(messages.map((segment) => segment.text), ['first', 'second']);
        assert.equal(messages[1]!.branchUnavailable, true);
        await coordinator.sendMessage(message('explicit-queue', 'queue'));
        await coordinator.sendMessage(message('behind-queue'));
        assert.equal(writes, 1, 'later auto input cannot overtake explicit queue');
        assert.equal(journal.queuedMessages(created.conversationId).length, 2);
      }
    } finally { await coordinator.close(); journal.close(); }
  });
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Input delivery did not settle');
}
