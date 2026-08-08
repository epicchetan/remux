import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import WebSocket from 'ws';

const TRANSCRIPT_PROTOCOL_VERSION = 2;
const TRANSCRIPT_PROJECTION_VERSION = 'agent-turn-render-v2';
const FIRST_SENTINEL = 'REMUX_CLEAN_FIRST_OK';
const CONTEXT_NONCE = 'REMUX_CONTEXT_8AUG26';
const SECOND_SENTINEL = `${CONTEXT_NONCE} REMUX_CLEAN_SECOND_OK`;

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const token = (await readFile(options.tokenFile, 'utf8')).trim();
  if (!token) throw new Error(`Remux token file is empty: ${options.tokenFile}`);

  const client = await RemuxClient.connect(options.endpoint, token);
  try {
  const initial = await readAgentResources(client);
  assert.equal(initial.auth.state, 'signed-in', 'The live Agent credential must already be signed in.');
  assert.ok(initial.models.models.length > 0, 'The live Agent model catalog is empty.');
  assert.equal(initial.history.length, 0, 'Clean acceptance requires an empty Agent journal.');
  assert.equal(initial.runtime.state, 'unloaded');

  const modelId = options.modelId ?? initial.models.defaultModelId;
  assert.ok(modelId && initial.models.models.some((model) => model.id === modelId));
  const supported = initial.models.models.find((model) => model.id === modelId).supportedReasoning;
  assert.ok(supported.includes(options.reasoning), `${modelId} does not support ${options.reasoning} reasoning.`);

  const conversation = await client.command('remux/agent/conversation/create', {
    operationId: randomUUID(),
    cwd: options.cwd,
    modelId,
    reasoning: options.reasoning,
  });
  assert.match(conversation.conversationId, UUID_V4);

  const first = await sendAndWait(client, conversation.conversationId, [
    `This is a clean-state acceptance test. Remember the exact nonce ${CONTEXT_NONCE}.`,
    `Do not call tools. Reply with exactly ${FIRST_SENTINEL} and nothing else.`,
  ].join(' '), options.timeoutMs);
  const firstTranscript = await readTranscript(client, conversation.conversationId);
  assert.equal(assistantText(firstTranscript, first.turnId).trim(), FIRST_SENTINEL);

  const generationBeforeRestart = firstTranscript.serverGeneration;
  const restart = await restartAgent(client, generationBeforeRestart, options.timeoutMs);
  const afterRestart = await readAgentResources(client);
  assert.equal(afterRestart.auth.state, 'signed-in');
  assert.equal(afterRestart.runtime.state, 'unloaded');
  assert.deepEqual(afterRestart.history.map((entry) => entry.id), [conversation.conversationId]);

  const coldTranscript = await readTranscript(client, conversation.conversationId);
  assert.notEqual(coldTranscript.serverGeneration, generationBeforeRestart);
  assert.equal(assistantText(coldTranscript, first.turnId).trim(), FIRST_SENTINEL);

  const second = await sendAndWait(client, conversation.conversationId, [
    'Without calling tools, recover the exact nonce from the user message before the Agent restart.',
    `Reply with exactly "${SECOND_SENTINEL}" and nothing else.`,
  ].join(' '), options.timeoutMs);
  const finalTranscript = await readTranscript(client, conversation.conversationId);
  assert.equal(assistantText(finalTranscript, second.turnId).trim(), SECOND_SENTINEL);
  assert.deepEqual(finalTranscript.value.turnOrder, [first.turnId, second.turnId]);

  const final = await readAgentResources(client);
  assert.equal(final.history.length, 1);
  assert.equal(final.history[0].id, conversation.conversationId);
  assert.equal(final.runtime.state, 'idle');
  assert.equal(final.runtime.conversationId, conversation.conversationId);
  assert.equal(final.runtime.contextProbe.provider, 'openai-codex');
  assert.equal(final.runtime.contextProbe.providerRequestMode, 'full');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    conversationId: conversation.conversationId,
    firstTurnId: first.turnId,
    secondTurnId: second.turnId,
    modelId,
    reasoning: options.reasoning,
    generations: {
      beforeRestart: generationBeforeRestart,
      afterRestart: finalTranscript.serverGeneration,
    },
    providerRequestModeAfterRestart: final.runtime.contextProbe.providerRequestMode,
    restartPid: restart.pid,
    sentinels: [FIRST_SENTINEL, SECOND_SENTINEL],
  }, null, 2)}\n`);
  } finally {
    client.close();
  }
}

async function sendAndWait(client, conversationId, text, timeoutMs) {
  const accepted = await client.command('remux/agent/conversation/message/send', {
    operationId: randomUUID(),
    conversationId,
    clientMessageId: randomUUID(),
    text,
  });
  assert.equal(accepted.accepted, true);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readAgentResources(client);
    if (state.runtime.conversationId === conversationId && state.runtime.state === 'idle') {
      return accepted;
    }
    if (state.runtime.conversationId === conversationId && state.runtime.state === 'error') {
      throw new Error(state.runtime.error ?? 'The Agent runtime failed without a diagnostic.');
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting ${timeoutMs} ms for turn ${accepted.turnId}.`);
}

async function restartAgent(client, priorGeneration, timeoutMs) {
  const before = await extensionStatus(client, 'agent');
  assert.equal(before.state, 'running');
  const operationId = `extension:agent:restart:clean-acceptance-${Date.now()}`;
  await client.job('remux/extensions/restart', { extensionId: 'agent' }, operationId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await extensionStatus(client, 'agent');
    if (status.state === 'failed') throw new Error('Agent entered the failed supervisor state.');
    if (status.running && status.state === 'running' && status.pid !== before.pid) {
      try {
        const resources = await readAgentResources(client);
        if (resources.serverGeneration !== priorGeneration) return status;
      } catch {
        // The replacement process may be running just before its RPC bridge is ready.
      }
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting ${timeoutMs} ms for the Agent restart.`);
}

async function extensionStatus(client, extensionId) {
  const response = await client.query('remux/extensions/status', undefined, 'extension-statuses');
  const status = response.extensions.find((entry) => entry.extensionId === extensionId);
  if (!status) throw new Error(`Extension status is missing ${extensionId}.`);
  return status;
}

async function readAgentResources(client) {
  const response = await client.query('remux/agent/resources/read', {
    requests: [
      { key: 'auth' },
      { key: 'models' },
      { key: 'conversation-list' },
      { key: 'runtime' },
    ],
  }, 'agent-clean-acceptance');
  const value = (key) => response.resources.find((entry) => entry.key === key && entry.status === 'ok')?.value;
  const auth = value('auth');
  const models = value('models');
  const runtime = value('runtime');
  assert.ok(auth && models && runtime, 'Agent readiness resources are incomplete.');
  const history = value('conversation-list')?.conversations ?? [];
  return {
    auth,
    history,
    models,
    runtime,
    serverGeneration: response.resources[0].serverGeneration,
  };
}

async function readTranscript(client, conversationId) {
  const response = await client.query('remux/agent/transcript/resources/read', {
    conversationId,
    requests: [{
      type: 'transcriptSync',
      protocolVersion: TRANSCRIPT_PROTOCOL_VERSION,
      projectionVersion: TRANSCRIPT_PROJECTION_VERSION,
      window: { kind: 'tail', count: 24 },
    }],
  }, `agent-transcript:${conversationId}`);
  const resource = response.resources[0];
  assert.equal(resource?.status, 'ok', resource?.reason ?? 'Transcript sync failed.');
  return { serverGeneration: response.serverGeneration, value: resource.value };
}

function assistantText(transcript, turnId) {
  const result = transcript.value.turns.find((turn) => turn.turnId === turnId);
  assert.ok(result && (result.status === 'ok' || result.status === 'error'));
  return result.frame.segments
    .filter((segment) => segment.type === 'assistantMessage')
    .map((segment) => segment.text)
    .join('');
}

function parseOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments; received ${key ?? '<end>'}.`);
    }
    values.set(key, value);
    index += 1;
  }
  const repositoryRoot = resolve(import.meta.dirname, '../../../..');
  const timeoutMs = Number(values.get('--timeout-ms') ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be a safe integer of at least 1000.');
  }
  return {
    cwd: resolve(values.get('--cwd') ?? repositoryRoot),
    endpoint: values.get('--endpoint') ?? 'ws://127.0.0.1:48123/ws',
    modelId: values.get('--model-id') ?? null,
    reasoning: values.get('--reasoning') ?? 'high',
    timeoutMs,
    tokenFile: resolve(values.get('--token-file') ?? resolve(repositoryRoot, '.remux/auth-token')),
  };
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class RemuxClient {
  #nextId = 1;
  #pending = new Map();
  #socket;

  static connect(endpoint, token) {
    return new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(endpoint, {
        headers: { authorization: `Bearer ${token}` },
      });
      socket.once('open', () => resolvePromise(new RemuxClient(socket)));
      socket.once('error', reject);
    });
  }

  constructor(socket) {
    this.#socket = socket;
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.on('close', () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error('Remux WebSocket closed before the RPC completed.'));
      }
      this.#pending.clear();
    });
  }

  query(method, params, resourceKey) {
    return this.#request(method, params, {
      kind: 'query',
      ...(resourceKey ? { resourceKey } : {}),
    });
  }

  command(method, params) {
    return this.#request(method, params, { kind: 'command' });
  }

  job(method, params, operationId) {
    return this.#request(method, params, { kind: 'job-start', operationId });
  }

  close() {
    this.#socket.close();
  }

  #request(method, params, remuxContract) {
    return new Promise((resolvePromise, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { reject, resolve: resolvePromise });
      this.#socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        remuxContract,
        ...(params === undefined ? {} : { params }),
      }));
    });
  }
}

await main();
