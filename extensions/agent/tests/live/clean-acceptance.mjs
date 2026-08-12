import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

import WebSocket from 'ws';

const TRANSCRIPT_PROTOCOL_VERSION = 2;
const TRANSCRIPT_PROJECTION_VERSION = 'agent-turn-render-v2';
const FIRST_SENTINEL = 'REMUX_THREAD_FIRST_OK';
const CONTEXT_NONCE = 'REMUX_CONTEXT_8AUG26';
const SECOND_SENTINEL = `${CONTEXT_NONCE} REMUX_THREAD_SECOND_OK`;
const CHILD_SECRET = 'REMUX_CHILD_TRACE_MUST_STAY_PRIVATE';
const WORK_UNIT_RESULT = 'REMUX_WORK_UNIT_RESULT_OK';
const THIRD_SENTINEL = 'REMUX_WORK_UNIT_PARENT_OK';

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
    'This is a Thread Runtime v2 acceptance test.',
    'Use thread_read, then call thread_replace to create a Markdown collaboration canvas containing',
    `the exact unique line "Durable nonce: ${CONTEXT_NONCE}".`,
    'After replacement succeeds, call thread_patch with its returned version and replace that exact line with',
    `"Durable nonce: ${CONTEXT_NONCE}; canvas patch verified."`,
    `After both edits succeed, reply with exactly ${FIRST_SENTINEL} and nothing else.`,
  ].join(' '), options.timeoutMs);
  const firstTranscript = await readTranscript(client, conversation.conversationId);
  assert.equal(assistantText(firstTranscript, first.turnId).trim(), FIRST_SENTINEL);
  const firstContext = await readContext(client, conversation.conversationId);
  assert.equal(firstContext.version, 4);
  assert.deepEqual(firstContext.layers.map(({ kind }) => kind), [
    'recent_dialogue', 'thread_document', 'active_scope',
  ]);

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
    'Without calling tools, recover the exact durable nonce from the compiled thread context after the Agent restart.',
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
  const secondContext = await readContext(client, conversation.conversationId);
  assert.equal(secondContext.version, 4);
  assert.equal(secondContext.transportMode, 'full');
  assert.equal(
    secondContext.groups.reduce((count, group) => count + group.roles.tool, 0),
    0,
    'Prior-turn tool traffic leaked into the next provider frame.',
  );

  const third = await sendAndWait(client, conversation.conversationId, [
    'Exercise the bounded work-unit runtime exactly once.',
    'First call work_unit_start with the objective "Validate the live child-context boundary."',
    `Inside that work unit, call bash with command "printf ${CHILD_SECRET}",`,
    `then call work_unit_finish with status completed and a concise Markdown result containing exactly the marker ${WORK_UNIT_RESULT}`,
    `but not the child-only marker ${CHILD_SECRET}.`,
    `After the parent context resumes, reply with exactly ${THIRD_SENTINEL} and nothing else.`,
  ].join(' '), options.timeoutMs);
  const workUnitTranscript = await readTranscript(client, conversation.conversationId);
  assert.equal(assistantText(workUnitTranscript, third.turnId).trim(), THIRD_SENTINEL);
  assert.deepEqual(workUnitTranscript.value.turnOrder, [first.turnId, second.turnId, third.turnId]);

  const durability = await inspectDurability(options.dataRoot, conversation.conversationId);
  assert.equal(durability.schemaId, 'agent-thread-runtime-v2');
  assert.equal(durability.contextFrames, durability.inferences);
  assert.equal(durability.providerItems, durability.inferences);
  assert.equal(durability.runningTurns, 0);
  assert.equal(durability.runningInferences, 0);
  assert.ok((durability.requestModes.continuation ?? 0) >= 2);
  assert.equal(durability.completedAssistantMessages, 3);
  assert.ok(durability.searchRows >= 7);
  assert.ok(durability.threadUpdates >= 2);
  assert.match(durability.threadContent, new RegExp(CONTEXT_NONCE));
  assert.equal(durability.workUnits.length, 1);
  assert.equal(durability.workUnits[0].state, 'completed');
  assert.match(durability.workUnits[0].result, new RegExp(WORK_UNIT_RESULT));
  assert.doesNotMatch(durability.workUnits[0].result, new RegExp(CHILD_SECRET));
  assert.deepEqual(durability.childToolNames, ['bash', 'work_unit_finish']);
  assert.ok(durability.visibleToolNames.includes('thread_read'));
  assert.ok(durability.visibleToolNames.includes('thread_replace'));
  assert.ok(durability.visibleToolNames.includes('thread_patch'));
  assert.equal(durability.visibleToolNames.filter((name) => name === 'work_unit_start').length, 1);
  assert.equal(durability.visibleToolNames.includes('bash'), false);
  assert.equal(durability.visibleToolNames.includes('work_unit_finish'), false);
  assert.equal(durability.childProviderCalls >= 2, true);
  assert.equal(durability.finalScopeKind, 'turn');
  const workUnitTurn = workUnitTranscript.value.turns.find(({ turnId }) => turnId === third.turnId);
  assert.ok(workUnitTurn?.frame, 'The bounded work-unit turn is missing from the transcript.');
  assert.doesNotMatch(
    JSON.stringify(workUnitTurn.frame.segments.filter(({ type }) => type !== 'userMessage')),
    new RegExp(CHILD_SECRET),
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    conversationId: conversation.conversationId,
    firstTurnId: first.turnId,
    secondTurnId: second.turnId,
    thirdTurnId: third.turnId,
    modelId,
    reasoning: options.reasoning,
    generations: {
      beforeRestart: generationBeforeRestart,
      afterRestart: finalTranscript.serverGeneration,
    },
    providerRequestModeAfterRestart: final.runtime.contextProbe.providerRequestMode,
    durability,
    restartPid: restart.pid,
    sentinels: [FIRST_SENTINEL, SECOND_SENTINEL, THIRD_SENTINEL],
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

async function readContext(client, conversationId) {
  const response = await client.query('remux/agent/resources/read', {
    requests: [{ key: `context:${conversationId}` }],
  }, `agent-context:${conversationId}`);
  const resource = response.resources[0];
  assert.equal(resource?.status, 'ok', 'The actual inference context resource is missing.');
  return resource.value;
}

async function inspectDurability(dataRoot, conversationId) {
  const database = new DatabaseSync(join(dataRoot, 'agent.sqlite3'), { readOnly: true });
  try {
    const scalar = (sql, ...params) => database.prepare(sql).get(...params).value;
    const thread = database.prepare(`
      SELECT a.storage_path
      FROM conversations c
      JOIN state_documents d
        ON d.conversation_id = c.conversation_id AND d.strand_id = c.head_strand_id
       AND d.scope_kind = 'strand' AND d.key = 'thread.md'
      JOIN document_versions v ON v.version_id = d.head_version_id
      JOIN artifacts a ON a.hash = v.content_artifact_hash
      WHERE c.conversation_id = ?
    `).get(conversationId);
    assert.ok(thread?.storage_path, 'The live thread.md artifact is missing.');
    const workUnitRows = database.prepare(`
      SELECT s.scope_id, s.state, a.storage_path
      FROM execution_scopes s
      LEFT JOIN artifacts a ON a.hash = s.result_artifact_hash
      WHERE s.conversation_id = ? AND s.kind = 'work_unit'
      ORDER BY s.created_sequence
    `).all(conversationId);
    const workUnits = await Promise.all(workUnitRows.map(async (row) => ({
      scopeId: row.scope_id,
      state: row.state,
      result: row.storage_path
        ? await readFile(join(dataRoot, 'artifacts', row.storage_path), 'utf8')
        : '',
    })));
    const childToolNames = database.prepare(`
      SELECT json_extract(e.payload_json, '$.name') AS name
      FROM events e
      JOIN execution_scopes s ON s.scope_id = e.scope_id
      WHERE e.conversation_id = ? AND s.kind = 'work_unit' AND e.type = 'tool.called'
      ORDER BY e.sequence
    `).all(conversationId).map(({ name }) => name);
    const visibleToolNames = database.prepare(`
      SELECT json_extract(value_json, '$.name') AS name
      FROM transcript_items
      WHERE conversation_id = ? AND kind = 'tool'
      ORDER BY first_sequence
    `).all(conversationId).map(({ name }) => name);
    return {
      schemaId: JSON.parse(scalar("SELECT value_json AS value FROM meta WHERE key = 'journal_schema'")),
      inferences: scalar('SELECT COUNT(*) AS value FROM inferences WHERE conversation_id = ?', conversationId),
      contextFrames: scalar('SELECT COUNT(*) AS value FROM context_frames WHERE conversation_id = ?', conversationId),
      providerItems: scalar('SELECT COUNT(*) AS value FROM provider_items WHERE conversation_id = ?', conversationId),
      runningTurns: scalar("SELECT COUNT(*) AS value FROM turns WHERE conversation_id = ? AND state = 'running'", conversationId),
      runningInferences: scalar("SELECT COUNT(*) AS value FROM inferences WHERE conversation_id = ? AND state = 'running'", conversationId),
      requestModes: Object.fromEntries(database.prepare(`
        SELECT request_mode, COUNT(*) AS count
        FROM inferences WHERE conversation_id = ? GROUP BY request_mode
      `).all(conversationId).map(({ request_mode, count }) => [request_mode, count])),
      completedAssistantMessages: scalar("SELECT COUNT(*) AS value FROM messages WHERE conversation_id = ? AND role = 'assistant' AND state = 'completed'", conversationId),
      searchRows: scalar('SELECT COUNT(*) AS value FROM journal_search_index WHERE conversation_id = ?', conversationId),
      pressureNotices: scalar("SELECT COUNT(*) AS value FROM events WHERE conversation_id = ? AND type = 'context.pressure'", conversationId),
      threadUpdates: scalar("SELECT COUNT(*) AS value FROM events WHERE conversation_id = ? AND type = 'thread.document.updated'", conversationId),
      threadContent: await readFile(join(dataRoot, 'artifacts', thread.storage_path), 'utf8'),
      workUnits,
      childToolNames,
      visibleToolNames,
      childProviderCalls: scalar(`
        SELECT COUNT(*) AS value
        FROM inferences i JOIN execution_scopes s ON s.scope_id = i.scope_id
        WHERE i.conversation_id = ? AND s.kind = 'work_unit'
      `, conversationId),
      finalScopeKind: scalar(`
        SELECT s.kind AS value
        FROM context_frames f JOIN execution_scopes s ON s.scope_id = f.scope_id
        WHERE f.conversation_id = ? ORDER BY f.created_sequence DESC LIMIT 1
      `, conversationId),
    };
  } finally {
    database.close();
  }
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
    dataRoot: resolve(values.get('--data-root') ?? defaultDataRoot()),
    reasoning: values.get('--reasoning') ?? 'high',
    timeoutMs,
    tokenFile: resolve(values.get('--token-file') ?? resolve(repositoryRoot, '.remux/auth-token')),
  };
}

function defaultDataRoot() {
  if (process.env.REMUX_AGENT_DATA_DIR?.trim()) return process.env.REMUX_AGENT_DATA_DIR;
  const base = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(base, 'remux', 'agent');
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
