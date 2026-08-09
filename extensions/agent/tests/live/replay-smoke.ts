import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { backup, DatabaseSync } from 'node:sqlite';

import {
  AGENT_METHODS,
  AGENT_RESOURCE_KEYS,
  contextResourceKey,
  type AgentRuntimeValue,
  type ContextInspectorValue,
  type ResourceReadResult,
} from '../../shared/protocol.ts';
import { AgentServer } from '../../server/src/agent-server.ts';
import { PiEngine } from '../../server/src/pi-runtime.ts';
import { agentDataPaths, resolveAgentDataRoot } from '../../server/src/storage/data-root.ts';
import { AgentJournalRepository } from '../../server/src/storage/repository.ts';

type Options = {
  sourceDataRoot: string;
  conversationId: string | null;
  inPlace: boolean;
  keepSnapshot: boolean;
  prompt: string;
  expect: string;
  timeoutMs: number;
};

const DEFAULT_SENTINEL = 'REMUX_REPLAY_OK';
const options = parseOptions(process.argv.slice(2));

void run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

async function run() {
  const sourceDataRoot = resolve(options.sourceDataRoot);
  const conversationId = options.conversationId ?? latestConversationId(sourceDataRoot);
  const snapshotRoot = options.inPlace
    ? null
    : await mkdtemp(join(tmpdir(), 'remux-agent-live-replay-'));
  const dataRoot = snapshotRoot ? join(snapshotRoot, 'data') : sourceDataRoot;
  if (snapshotRoot) await snapshotDataRoot(sourceDataRoot, dataRoot);

  const startedAt = Date.now();
  let server: AgentServer | null = null;
  let repository: AgentJournalRepository | null = null;
  try {
    repository = await AgentJournalRepository.open({ dataRoot });
    const engine = await PiEngine.create();
    server = new AgentServer({ engine, journal: repository, notify: () => {} });
    await server.initialize();
    const accepted = await server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
      conversationId,
      clientMessageId: randomUUID(),
      text: options.prompt,
    }) as { turnId: string };
    await waitForIdle(server, conversationId, options.timeoutMs);

    const context = await repository.compileContext(conversationId);
    const response = context.messages
      .filter((message) => message.role === 'assistant' && message.turnId === accepted.turnId)
      .map((message) => message.role === 'assistant' ? message.text : '')
      .join('');
    if (!response.includes(options.expect)) {
      throw new Error(
        `The live replay response did not contain the expected sentinel ${JSON.stringify(options.expect)}.`,
      );
    }
    const contextRead = await server.handle(AGENT_METHODS.resourcesRead, {
      requests: [{ key: contextResourceKey(conversationId) }],
    }) as ResourceReadResult;
    const contextResource = contextRead.resources[0];
    if (contextResource?.status !== 'ok') {
      throw new Error('The live replay did not publish its durable shadow context resource.');
    }
    const inspector = contextResource.value as ContextInspectorValue;
    if (inspector.decision.kind === 'block') {
      throw new Error('The live replay shadow compiler unexpectedly produced a blocking candidate.');
    }
    if (inspector.version !== 2 || !inspector.actual) {
      throw new Error('The live replay did not publish the inference-scoped context truth projection.');
    }
    const dispatchArtifact = await repository.readArtifact(inspector.actual.dispatchArtifact.hash);
    if (!dispatchArtifact?.bytes.toString('utf8').includes(options.prompt)) {
      throw new Error('The captured provider dispatch does not contain the replay prompt.');
    }
    const database = new DatabaseSync(repository.databasePath, { readOnly: true });
    const inferences = database.prepare(`
      SELECT ordinal, state, request_mode, estimated_input_tokens,
             reported_input_tokens, reported_output_tokens, manifest_version
      FROM inferences WHERE turn_id = ? ORDER BY ordinal
    `).all(accepted.turnId).map((row) => ({ ...row }));
    const compilations = database.prepare(`
      SELECT mode, compiler_version, policy_version, decision,
             manifest_artifact_hash, bootstrap_artifact_hash, semantic_hash,
             active_estimated_input_tokens, candidate_estimated_input_tokens,
             build_duration_ms
      FROM context_compilations WHERE turn_id = ? ORDER BY created_sequence
    `).all(accepted.turnId).map((row) => ({ ...row }));
    const conversation = database.prepare(`
      SELECT model_id, reasoning FROM conversations WHERE conversation_id = ?
    `).get(conversationId) as { model_id: string; reasoning: string };
    database.close();
    if (compilations.length === 0) {
      throw new Error('The live replay committed no durable shadow context compilation.');
    }
    if (inferences.some((row) =>
      row.manifest_version !== 'agent-prompt-manifest-v1' &&
      row.manifest_version !== 'agent-prompt-manifest-v2' &&
      row.manifest_version !== 'agent-prompt-manifest-v3')) {
      throw new Error('The live replay did not use the versioned prompt manifest.');
    }
    const latestCompilation = compilations.at(-1) as {
      semantic_hash: string;
      manifest_artifact_hash: string;
      bootstrap_artifact_hash: string;
    };
    if (
      latestCompilation.semantic_hash !== inspector.semanticHash ||
      latestCompilation.manifest_artifact_hash !== inspector.manifestArtifact.hash ||
      latestCompilation.bootstrap_artifact_hash !== inspector.bootstrapArtifact.hash
    ) {
      throw new Error('The live replay context inspector does not match its durable compilation row.');
    }
    console.log(JSON.stringify({
      ok: true,
      mode: options.inPlace ? 'in-place' : 'snapshot',
      conversationId,
      turnId: accepted.turnId,
      modelId: conversation.model_id,
      reasoning: conversation.reasoning,
      elapsedMs: Date.now() - startedAt,
      responseBytes: Buffer.byteLength(response, 'utf8'),
      expectedSentinel: options.expect,
      inferences,
      shadowContext: {
        compilations: compilations.length,
        decision: inspector.decision.kind,
        activeEstimatedInputTokens: inspector.activeEstimatedInputTokens,
        candidateEstimatedInputTokens: inspector.candidateEstimatedInputTokens,
        buildDurationMs: inspector.buildDurationMs,
        semanticHash: inspector.semanticHash,
        manifestArtifactHash: inspector.manifestArtifact.hash,
        bootstrapArtifactHash: inspector.bootstrapArtifact.hash,
        dispatchArtifactHash: inspector.actual.dispatchArtifact.hash,
        transportMode: inspector.actual.transportMode,
        messageCount: inspector.actual.messageCount,
        turnCount: inspector.actual.turnCount,
      },
      ...(snapshotRoot && options.keepSnapshot ? { snapshotRoot } : {}),
    }, null, 2));
  } finally {
    await server?.close().catch(() => undefined);
    await repository?.close().catch(() => undefined);
    if (snapshotRoot && !options.keepSnapshot) {
      await rm(snapshotRoot, { force: true, recursive: true });
    }
  }
}

async function snapshotDataRoot(sourceRoot: string, destinationRoot: string) {
  const source = agentDataPaths(sourceRoot);
  const destination = agentDataPaths(destinationRoot);
  await mkdir(destination.root, { recursive: true });
  const database = new DatabaseSync(source.database, { readOnly: true });
  try {
    await backup(database, destination.database);
  } finally {
    database.close();
  }
  await cp(source.artifacts, destination.artifacts, { recursive: true });
}

function latestConversationId(dataRoot: string) {
  const database = new DatabaseSync(agentDataPaths(dataRoot).database, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT conversation_id FROM conversations ORDER BY updated_at DESC LIMIT 1
    `).get() as { conversation_id: string } | undefined;
    if (!row) throw new Error('The Agent journal has no conversation to replay.');
    return row.conversation_id;
  } finally {
    database.close();
  }
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
        throw new Error(runtime.error ?? 'The Agent runtime failed without an error message.');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting ${timeoutMs}ms for live replay completion.`);
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--in-place' || argument === '--keep-snapshot') {
      flags.add(argument);
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  const timeoutMs = Number(values.get('--timeout-ms') ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer of at least 1000.');
  }
  return {
    sourceDataRoot: values.get('--data-root') ?? resolveAgentDataRoot(),
    conversationId: values.get('--conversation-id') ?? null,
    inPlace: flags.has('--in-place'),
    keepSnapshot: flags.has('--keep-snapshot'),
    prompt: values.get('--prompt') ??
      `This is an automated replay health check. Do not call tools. Reply with exactly ${DEFAULT_SENTINEL}.`,
    expect: values.get('--expect') ?? DEFAULT_SENTINEL,
    timeoutMs,
  };
}
