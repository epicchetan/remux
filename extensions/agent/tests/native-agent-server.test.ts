import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { NativeAgentServer } from '../server/src/native-agent-server.ts';
import { NativeFixtureAdapter } from '../server/src/native-fixture-adapter.ts';
import { NativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import { createNativeAgentSchema } from '../server/src/native-runtime/schema.ts';
import { NATIVE_AGENT_METHODS } from '../shared/native-agent-protocol.ts';

test('native Agent JSON-RPC surface serves versioned resources and commands only', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  const notifications: Array<{ method: string; params: unknown }> = [];
  const server = new NativeAgentServer({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter: new NativeFixtureAdapter(),
    }],
    notify: (method, params) => notifications.push({ method, params }),
  });
  try {
    await server.initialize();
    const providers = await server.handle(NATIVE_AGENT_METHODS.resourcesRead, {
      _remuxOrigin: 'host-owned-opaque-origin',
      _remuxViewerKey: 'host-owned-viewer-key',
      visibility: 'foreground',
      requests: [{ key: 'agent/providers' }, { key: 'agent/models:fixture-local' }],
    }) as { protocolVersion: number; resources: Array<{ status: string }> };
    assert.equal(providers.protocolVersion, 6);
    assert.ok(providers.resources.every(({ status }) => status === 'ok'));

    const created = await server.handle(NATIVE_AGENT_METHODS.conversationCreate, {
      commandId: 'create-1',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    }) as { conversationId: string };
    const runtimeRead = await server.handle(NATIVE_AGENT_METHODS.resourcesRead, {
      requests: [{ key: `agent/runtime:${created.conversationId}` }],
    }) as {
      resources: Array<{ status: string; value?: {
        providerInstanceId: string;
        composer: { revision: string; nextTurn: { model: string; effort: string | null } };
      } }>;
    };
    const runtime = runtimeRead.resources[0]?.value;
    assert.ok(runtime);
    const sent = await server.handle(NATIVE_AGENT_METHODS.messageSend, {
      commandId: 'send-1',
      conversationId: created.conversationId,
      clientMessageId: 'message-1',
      content: [{ type: 'text', text: 'Implement.' }],
      providerInstanceId: runtime.providerInstanceId,
      model: runtime.composer.nextTurn.model,
      effort: runtime.composer.nextTurn.effort,
      access: 'workspace-write',
      configurationRevision: runtime.composer.revision,
      delivery: 'auto',
    }) as { turnId: string };
    assert.ok(sent.turnId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(notifications.some(({ method }) => method === NATIVE_AGENT_METHODS.resourcesInvalidated));
    assert.ok(!notifications.some(({ params }) => /resumeCursor|nativeSession/u.test(JSON.stringify(params))));
    await assert.rejects(server.handle('remux/agent/legacy/context/compile', {}), /Method not found/u);
  } finally {
    await server.close();
    journal.close();
  }
});
