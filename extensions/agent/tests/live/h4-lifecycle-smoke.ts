import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import {
  AGENT_METHODS,
  AGENT_RESOURCE_KEYS,
  type AgentRuntimeValue,
  type ResourceReadResult,
} from '../../shared/protocol.ts';
import { AgentServer } from '../../server/src/agent-server.ts';
import { PiEngine } from '../../server/src/pi-runtime.ts';
import { AgentJournalRepository } from '../../server/src/storage/repository.ts';

const execFileAsync = promisify(execFile);
const PROPOSAL_MARKER = 'H4_PROPOSAL_READY';
const CHILD_MARKER = 'H4_CHILD_RESULT';
const PARENT_MARKER = 'H4_PARENT_DONE';
const RESTART_MARKER = 'H4_RESTART_OK';

type Options = {
  keepData: boolean;
  modelId: string;
  reasoning: 'high' | 'xhigh' | 'max';
  timeoutMs: number;
  workspace: string;
};

type ActiveRuntime = {
  repository: AgentJournalRepository;
  server: AgentServer;
};

const options = parseOptions(process.argv.slice(2));

void run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

async function run() {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-h4-smoke-'));
  const dataRoot = join(root, 'data');
  const beforeStatus = await gitStatus(options.workspace);
  const startedAt = Date.now();
  let runtime: ActiveRuntime | null = null;
  let conversationId = '';
  try {
    runtime = await openRuntime(dataRoot);
    const resources = await readReadiness(runtime.server);
    assert.equal(resources.authState, 'signed-in', 'The real Agent provider must already be signed in.');
    assert.ok(resources.models.includes(options.modelId), `${options.modelId} is not available.`);

    const created = await runtime.server.handle(AGENT_METHODS.conversationCreate, {
      operationId: randomUUID(),
      cwd: options.workspace,
      modelId: options.modelId,
      reasoning: options.reasoning,
      contextMode: 'stateful',
      workUnits: true,
    }) as { conversationId: string };
    conversationId = created.conversationId;

    const proposal = await sendAndWait(runtime, conversationId, [
      'This is a real-provider H4 lifecycle acceptance. Do not call tools or change files in this turn.',
      'Propose a concise plan to inspect package.json and README.md in one bounded child work unit,',
      'return exact evidence, and preserve the working tree. End the proposal with the exact marker',
      `${PROPOSAL_MARKER}.`,
    ].join(' '));
    assert.match(await assistantText(runtime.repository, conversationId, proposal.turnId), new RegExp(PROPOSAL_MARKER));

    const execution = await sendAndWait(runtime, conversationId, [
      'This looks good. Proceed.',
      'Treat the preceding proposal as accepted. First use context_update to set project key',
      '`accepted-proposal`; cite the exact preceding-assistant journal ref as evidence and keep',
      `${PROPOSAL_MARKER} in the small value. Then enter one work_unit.`,
      'Inside the child, make these actions sequentially so each result is seen before the next action:',
      'read package.json, then read README.md, then run `git status --short` with bash.',
      'If the harness reports context pressure, checkpoint the exact read refs and next step in child-local',
      'context before continuing.',
      'Do not edit or write anything. Explicitly return the child with bounded findings and exact openable',
      `evidence refs; include ${CHILD_MARKER} in a finding. In the restored parent, integrate the bounded`,
      `result and finish with ${PARENT_MARKER}.`,
    ].join(' '));
    assert.match(await assistantText(runtime.repository, conversationId, execution.turnId), new RegExp(PARENT_MARKER));

    const beforeRestart = inspectJournal(runtime.repository.databasePath, conversationId);
    assert.equal(beforeRestart.acceptedProposalEntries, 1, 'The accepted proposal was not pinned durably.');
    assert.ok(beforeRestart.acceptedProposalSources >= 1, 'The accepted proposal has no exact provenance source.');
    assert.equal(beforeRestart.workUnitsEntered, 1, 'The model did not enter exactly one work unit.');
    assert.equal(beforeRestart.explicitWorkUnitReturns, 1, 'The work unit did not return explicitly.');
    assert.equal(beforeRestart.implicitWorkUnitReturns, 0, 'The work unit unexpectedly returned implicitly.');
    assert.ok(beforeRestart.pressureNotices >= 1, 'The forced low-threshold frame emitted no pressure notice.');
    assert.ok(beforeRestart.contextRollovers >= 1, 'The forced low-threshold frame did not roll over.');
    assert.equal(beforeRestart.compactionEvents, 0, 'Pi compaction must remain disabled.');
    assert.equal(beforeRestart.contextLimitErrors, 0, 'The smoke encountered a context-limit failure.');
    assert.ok(beforeRestart.resultRef, 'The work unit did not publish a bounded result reference.');
    const boundedResult = await runtime.repository.openJournal(conversationId, { ref: beforeRestart.resultRef! });
    assert.match(boundedResult.content, new RegExp(CHILD_MARKER));

    await closeRuntime(runtime);
    runtime = await openRuntime(dataRoot);
    const followUp = await sendAndWait(runtime, conversationId, [
      'After this runtime restart, recover the accepted proposal and the bounded child result from durable',
      'context. Do not reread the filesystem and do not open the raw child trace. Briefly state what was',
      `accepted and what the child established. Include ${PROPOSAL_MARKER}, ${CHILD_MARKER}, and end with`,
      `${RESTART_MARKER}.`,
    ].join(' '));
    const followUpText = await assistantText(runtime.repository, conversationId, followUp.turnId);
    assert.match(followUpText, new RegExp(PROPOSAL_MARKER));
    assert.match(followUpText, new RegExp(CHILD_MARKER));
    assert.match(followUpText, new RegExp(`${RESTART_MARKER}\\s*$`));

    const afterRestart = inspectJournal(runtime.repository.databasePath, conversationId);
    assert.ok(afterRestart.fullRequests >= beforeRestart.fullRequests + 1, 'Restart did not create a fresh full provider request.');
    assert.equal(afterRestart.contextLimitErrors, 0);
    assert.equal(await gitStatus(options.workspace), beforeStatus, 'The supposedly read-only smoke changed the working tree.');

    console.log(JSON.stringify({
      ok: true,
      conversationId,
      dataRoot,
      elapsedMs: Date.now() - startedAt,
      modelId: options.modelId,
      reasoning: options.reasoning,
      turnIds: [proposal.turnId, execution.turnId, followUp.turnId],
      lifecycle: afterRestart,
      markers: [PROPOSAL_MARKER, CHILD_MARKER, PARENT_MARKER, RESTART_MARKER],
    }, null, 2));
  } finally {
    if (runtime) await closeRuntime(runtime).catch(() => undefined);
    if (!options.keepData) await rm(root, { recursive: true, force: true });
  }
}

async function openRuntime(dataRoot: string): Promise<ActiveRuntime> {
  const repository = await AgentJournalRepository.open({ dataRoot });
  try {
    const engine = await PiEngine.create({
      contextPolicy: {
        version: 'agent-context-policy-h4-smoke-v1',
        softNoticeTokens: 10_500,
        rollThresholdTokens: 12_500,
        snapshotTargetTokens: 7_000,
        snapshotHardMaxTokens: 12_000,
      },
    });
    const server = new AgentServer({ engine, journal: repository, notify: () => {} });
    await server.initialize();
    return { repository, server };
  } catch (error) {
    await repository.close();
    throw error;
  }
}

async function closeRuntime(runtime: ActiveRuntime) {
  await runtime.server.close();
  await runtime.repository.close();
}

async function sendAndWait(runtime: ActiveRuntime, conversationId: string, text: string) {
  const accepted = await runtime.server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(),
    conversationId,
    clientMessageId: randomUUID(),
    text,
  }) as { accepted: true; turnId: string };
  await waitForIdle(runtime.server, conversationId, options.timeoutMs);
  return accepted;
}

async function waitForIdle(server: AgentServer, conversationId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const read = await server.handle(AGENT_METHODS.resourcesRead, {
      requests: [{ key: AGENT_RESOURCE_KEYS.runtime }],
    }) as ResourceReadResult;
    const resource = read.resources[0];
    if (resource?.status === 'ok') {
      const runtime = resource.value as AgentRuntimeValue;
      if (runtime.conversationId === conversationId && runtime.state === 'idle') return;
      if (runtime.conversationId === conversationId && runtime.state === 'error') {
        throw new Error(runtime.error ?? 'The Agent runtime failed without a diagnostic.');
      }
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting ${timeoutMs}ms for conversation ${conversationId}.`);
}

async function readReadiness(server: AgentServer) {
  const read = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: AGENT_RESOURCE_KEYS.auth }, { key: AGENT_RESOURCE_KEYS.models }],
  }) as ResourceReadResult;
  const auth = read.resources.find(({ key }) => key === AGENT_RESOURCE_KEYS.auth);
  const models = read.resources.find(({ key }) => key === AGENT_RESOURCE_KEYS.models);
  assert.equal(auth?.status, 'ok');
  assert.equal(models?.status, 'ok');
  return {
    authState: (auth.value as { state: string }).state,
    models: (models.value as { models: Array<{ id: string }> }).models.map(({ id }) => id),
  };
}

async function assistantText(repository: AgentJournalRepository, conversationId: string, turnId: string) {
  const context = await repository.compileContext(conversationId);
  return context.messages
    .filter((message) => message.role === 'assistant' && message.turnId === turnId)
    .map((message) => message.role === 'assistant' ? message.text : '')
    .join('');
}

function inspectJournal(databasePath: string, conversationId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const scalar = (sql: string) => (database.prepare(sql).get(conversationId) as { count: number }).count;
    const primary = database.prepare(`
      SELECT provenance_json FROM project_primaries
      WHERE project_id = (SELECT project_id FROM conversations WHERE conversation_id = ?)
        AND key = 'accepted-proposal' AND lifecycle = 'active'
    `).get(conversationId) as { provenance_json: string } | undefined;
    const returned = database.prepare(`
      SELECT payload_json FROM events
      WHERE conversation_id = ? AND type = 'work_unit.returned'
      ORDER BY sequence DESC LIMIT 1
    `).get(conversationId) as { payload_json: string } | undefined;
    const returnedPayload = returned ? JSON.parse(returned.payload_json) as {
      resultRef?: string;
      returnMode?: string;
    } : {};
    return {
      acceptedProposalEntries: primary ? 1 : 0,
      acceptedProposalSources: primary ? (JSON.parse(primary.provenance_json) as unknown[]).length : 0,
      workUnitsEntered: scalar(`SELECT COUNT(*) AS count FROM events WHERE conversation_id = ? AND type = 'work_unit.entered'`),
      explicitWorkUnitReturns: scalar(`SELECT COUNT(*) AS count FROM events WHERE conversation_id = ? AND type = 'work_unit.returned' AND json_extract(payload_json, '$.returnMode') = 'explicit'`),
      implicitWorkUnitReturns: scalar(`SELECT COUNT(*) AS count FROM events WHERE conversation_id = ? AND type = 'work_unit.returned' AND json_extract(payload_json, '$.returnMode') = 'implicit'`),
      pressureNotices: scalar(`SELECT COUNT(*) AS count FROM events WHERE conversation_id = ? AND type = 'inference.started' AND json_extract(payload_json, '$.pressureNotice') = 1`),
      contextRollovers: scalar(`SELECT COUNT(*) AS count FROM context_compilations WHERE conversation_id = ? AND mode = 'active' AND decision = 'roll'`),
      compactionEvents: scalar(`SELECT COUNT(*) AS count FROM events WHERE conversation_id = ? AND type LIKE '%compact%'`),
      contextLimitErrors: scalar(`
        SELECT COUNT(*) AS count FROM events WHERE conversation_id = ? AND (
          lower(payload_json) LIKE '%context requires%' OR
          lower(payload_json) LIKE '%context-limit%' OR
          lower(payload_json) LIKE '%input limit%'
        )
      `),
      fullRequests: scalar(`SELECT COUNT(*) AS count FROM inferences WHERE conversation_id = ? AND request_mode = 'full'`),
      continuationRequests: scalar(`SELECT COUNT(*) AS count FROM inferences WHERE conversation_id = ? AND request_mode = 'continuation'`),
      resultRef: returnedPayload.resultRef ?? null,
      lastReturnMode: returnedPayload.returnMode ?? null,
    };
  } finally {
    database.close();
  }
}

async function gitStatus(workspace: string) {
  const result = await execFileAsync('git', ['status', '--short', '--untracked-files=all'], {
    cwd: workspace,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  let keepData = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (key === '--keep-data') {
      keepData = true;
      continue;
    }
    const value = args[index + 1];
    if (!key.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments; received ${key}.`);
    }
    values.set(key, value);
    index += 1;
  }
  const timeoutMs = Number(values.get('--timeout-ms') ?? 300_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be a safe integer of at least 1000.');
  }
  const reasoning = values.get('--reasoning') ?? 'high';
  if (reasoning !== 'high' && reasoning !== 'xhigh' && reasoning !== 'max') {
    throw new Error('--reasoning must be high, xhigh, or max.');
  }
  return {
    keepData,
    modelId: values.get('--model') ?? 'gpt-5.6-sol',
    reasoning,
    timeoutMs,
    workspace: resolve(values.get('--cwd') ?? resolve(import.meta.dirname, '../../../..')),
  };
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
