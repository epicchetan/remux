import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { createBenchmarkTarget } from './adapters.ts';
import type { BenchmarkRun, BenchmarkTarget, PreparedFixtureManifest } from './contracts.ts';
import { captureTranscript, evaluateRun, snapshotWorkspace } from './evidence.ts';
import { createRunWorkspace, prepareFixture } from './fixture.ts';
import { RemuxBenchmarkClient } from './remux-client.ts';
import { benchmarkScenario, benchmarkScenarios } from './scenarios.ts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');
const DEFAULT_DATA_ROOT = join(REPOSITORY_ROOT, '.remux-benchmarks');
const DEFAULT_ENDPOINT = 'ws://127.0.0.1:48123/ws';
const DEFAULT_TOKEN_FILE = join(REPOSITORY_ROOT, '.remux', 'auth-token');
const DEFAULT_SCENARIO = 'ledger-feed-session-collaboration-v1';

await main(process.argv.slice(2));

async function main(argv: string[]) {
  const command = argv[0] ?? 'help';
  const options = parseOptions(argv.slice(1));
  try {
    switch (command) {
      case 'list':
        printJson(benchmarkScenarios().map(({ fixtureId, title, stages, maxUserTurns }) => ({
          fixtureId,
          title,
          stages: stages.map(({ id, title: stageTitle }) => ({ id, title: stageTitle })),
          maxUserTurns,
        })));
        return;
      case 'prepare':
        await commandPrepare(options);
        return;
      case 'models':
        await withClient(options, (client) => commandModels(options, client));
        return;
      case 'start':
        await withClient(options, (client) => commandStart(options, client));
        return;
      case 'send':
        await withClient(options, (client) => commandSend(options, client));
        return;
      case 'resume':
        await withClient(options, (client) => commandResume(options, client));
        return;
      case 'status':
        await commandStatus(options);
        return;
      case 'finalize':
        await commandFinalize(options);
        return;
      case 'run':
        await withClient(options, (client) => commandRun(options, client));
        return;
      case 'replay':
        await withClient(options, (client) => commandReplay(options, client));
        return;
      case 'sentinel':
        await withClient(options, (client) => commandSentinel(options, client));
        return;
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        return;
      default:
        throw new Error(`Unknown benchmark command: ${command}`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function commandPrepare(options: Options) {
  const scenario = benchmarkScenario(options.scenario);
  const prepared = await prepareFixture(scenario, options.dataRoot);
  printJson({ fixtureId: scenario.fixtureId, manifestPath: prepared.manifestPath, template: prepared.manifest.template });
}

async function commandModels(options: Options, client: RemuxBenchmarkClient) {
  const cwd = options.cwd ?? REPOSITORY_ROOT;
  const result = options.target === 'codex'
    ? await client.query('remux/codex/models/read', { cwd }, `benchmark:models:${cwd}`)
    : await client.query('remux/agent/resources/read', { requests: [{ key: 'auth' }, { key: 'models' }] }, 'benchmark:models:agent');
  printJson(result);
}

async function commandStart(options: Options, client: RemuxBenchmarkClient) {
  const runRecord = await startScenarioRun(options, client);
  printRunProgress(runRecord);
}

async function commandSend(options: Options, client: RemuxBenchmarkClient) {
  const { runRecord, runPath } = await loadRequiredRun(options);
  const scenario = benchmarkScenario(runRecord.fixtureId);
  if (runRecord.state !== 'running') throw new Error(`Run ${runRecord.runId} is ${runRecord.state}, not running.`);
  if (runRecord.stageIndex >= scenario.stages.length) throw new Error(`Run ${runRecord.runId} has no remaining scenario stage.`);
  const stage = scenario.stages[runRecord.stageIndex];
  const text = options.text ?? stage.defaultPrompt;
  await executeTurn(runRecord, runPath, stage.id, text, client);
  printRunProgress(runRecord);
}

async function commandResume(options: Options, client: RemuxBenchmarkClient) {
  const { runRecord, runPath } = await loadRequiredRun(options);
  const scenario = benchmarkScenario(runRecord.fixtureId);
  if (runRecord.state !== 'failed' && runRecord.state !== 'interrupted') {
    throw new Error(`Run ${runRecord.runId} is ${runRecord.state}, not failed or interrupted.`);
  }
  if (runRecord.stageIndex >= scenario.stages.length) {
    throw new Error(`Run ${runRecord.runId} has no remaining scenario stage.`);
  }
  runRecord.state = 'running';
  runRecord.error = null;
  runRecord.updatedAt = new Date().toISOString();
  await persistRun(runRecord, runPath);
  while (runRecord.stageIndex < scenario.stages.length) {
    const stage = scenario.stages[runRecord.stageIndex];
    await executeTurn(runRecord, runPath, stage.id, stage.defaultPrompt, client);
  }
  printRunProgress(runRecord);
  process.stdout.write(`Run ${runRecord.runId} is ready. Finalize it with npm --workspace @remux/agent run benchmark -- finalize --run ${runRecord.runId}\n`);
}

async function commandStatus(options: Options) {
  const { runRecord } = await loadRequiredRun(options);
  printRunProgress(runRecord);
}

async function commandFinalize(options: Options) {
  const { runRecord, runPath } = await loadRequiredRun(options);
  if (runRecord.state !== 'ready-for-evaluation' && runRecord.state !== 'failed') {
    throw new Error(`Run ${runRecord.runId} is ${runRecord.state}; complete all stages before finalizing.`);
  }
  const scenario = benchmarkScenario(runRecord.fixtureId);
  const manifest = await readJson<PreparedFixtureManifest>(runRecord.fixtureManifestPath);
  runRecord.state = 'evaluating';
  runRecord.updatedAt = new Date().toISOString();
  await persistRun(runRecord, runPath);
  try {
    const report = await evaluateRun({ runRecord, scenario, manifest, runPath });
    runRecord.state = report.passed ? 'completed' : 'failed';
    runRecord.evidencePath = report.artifacts.evidence;
    runRecord.reportPath = join(runPath, 'report.json');
    runRecord.updatedAt = new Date().toISOString();
    runRecord.error = report.passed ? null : 'One or more benchmark gates failed.';
    await persistRun(runRecord, runPath);
    printJson(report);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    runRecord.state = 'failed';
    runRecord.updatedAt = new Date().toISOString();
    runRecord.error = error instanceof Error ? error.message : String(error);
    await persistRun(runRecord, runPath);
    throw error;
  }
}

async function commandRun(options: Options, client: RemuxBenchmarkClient) {
  const runRecord = await startScenarioRun(options, client);
  const runPath = dirname(runRecord.workspacePath);
  const scenario = benchmarkScenario(runRecord.fixtureId);
  while (runRecord.stageIndex < scenario.stages.length) {
    const stage = scenario.stages[runRecord.stageIndex];
    await executeTurn(runRecord, runPath, stage.id, stage.defaultPrompt, client);
  }
  printRunProgress(runRecord);
  process.stdout.write(`Run ${runRecord.runId} is ready. Finalize it with npm --workspace @remux/agent run benchmark -- finalize --run ${runRecord.runId}\n`);
}

async function commandReplay(options: Options, client: RemuxBenchmarkClient) {
  if (!options.sourceRun) throw new Error('replay requires --source-run <run-id>.');
  const source = await readJson<BenchmarkRun>(join(options.dataRoot, 'runs', options.sourceRun, 'run.json'));
  const replayOptions = { ...options, scenario: source.fixtureId };
  const prompts = source.turns.map(({ text }) => text);
  if (prompts.length === 0) throw new Error(`Source run ${source.runId} has no turns to replay.`);
  const runRecord = await startScenarioRun(replayOptions, client, prompts[0]);
  const runPath = dirname(runRecord.workspacePath);
  const scenario = benchmarkScenario(runRecord.fixtureId);
  while (runRecord.stageIndex < prompts.length && runRecord.stageIndex < scenario.stages.length) {
    const stage = scenario.stages[runRecord.stageIndex];
    await executeTurn(runRecord, runPath, stage.id, prompts[runRecord.stageIndex], client);
  }
  printRunProgress(runRecord);
}

async function commandSentinel(options: Options, client: RemuxBenchmarkClient) {
  const scenario = benchmarkScenario(options.scenario);
  const prepared = await prepareFixture(scenario, options.dataRoot);
  const sentinelRoot = join(options.dataRoot, 'sentinels', newRunId(options.target));
  const cwd = await createRunWorkspace(prepared.manifest, sentinelRoot);
  const target = createBenchmarkTarget(options.target, client);
  const first = await target.start({
    cwd,
    modelId: requiredOption(options.modelId, '--model'),
    reasoning: options.reasoning,
    reviewMode: options.reviewMode,
    speed: options.speed,
    text: 'This is a production-path adapter sentinel. Do not call tools or change files. Reply exactly: BENCHMARK_SENTINEL_ONE',
  });
  await target.waitForTerminal({ conversationId: first.conversationId, turnId: first.turnId, timeoutMs: options.timeoutMs });
  const second = await target.send({
    conversationId: first.conversationId,
    text: 'Do not call tools or change files. Reply exactly: BENCHMARK_SENTINEL_TWO',
  });
  await target.waitForTerminal({ conversationId: first.conversationId, turnId: second.turnId, timeoutMs: options.timeoutMs });
  const transcript = await target.readTranscript(first.conversationId);
  const workspace = await snapshotWorkspace(cwd);
  const firstText = transcript.assistantTextByTurn[first.turnId] ?? '';
  const secondText = transcript.assistantTextByTurn[second.turnId] ?? '';
  const passed = firstText.includes('BENCHMARK_SENTINEL_ONE')
    && secondText.includes('BENCHMARK_SENTINEL_TWO')
    && workspace.status === '';
  printJson({ passed, target: options.target, conversationId: first.conversationId, turnIds: [first.turnId, second.turnId], firstText, secondText, workspace });
  if (!passed) process.exitCode = 1;
}

async function startScenarioRun(options: Options, client: RemuxBenchmarkClient, firstPrompt?: string) {
  const scenario = benchmarkScenario(options.scenario);
  const prepared = await prepareFixture(scenario, options.dataRoot);
  const runId = newRunId(options.target);
  const runPath = join(options.dataRoot, 'runs', runId);
  const workspacePath = await createRunWorkspace(prepared.manifest, runPath);
  const stage = scenario.stages[0];
  const target = createBenchmarkTarget(options.target, client);
  const modelId = requiredOption(options.modelId, '--model');
  const text = firstPrompt ?? options.text ?? stage.defaultPrompt;
  const turnStartedAt = new Date().toISOString();
  const sourceBefore = await snapshotWorkspace(scenario.sourceRepository);
  const started = await target.start({
    cwd: workspacePath,
    modelId,
    reasoning: options.reasoning,
    reviewMode: options.reviewMode,
    speed: options.speed,
    text,
  });
  const runRecord: BenchmarkRun = {
    version: 1,
    runId,
    fixtureId: scenario.fixtureId,
    target: options.target,
    state: 'running',
    dataRoot: options.dataRoot,
    workspacePath,
    fixtureManifestPath: prepared.manifestPath,
    conversationId: started.conversationId,
    modelId: started.modelId,
    reasoning: options.reasoning,
    reviewMode: options.reviewMode,
    speed: options.speed,
    contextArchitecture: options.target === 'agent' ? 'thread-runtime-v1' : 'codex-app-server',
    stageIndex: 0,
    startedAt: turnStartedAt,
    updatedAt: turnStartedAt,
    sourceHeadBefore: sourceBefore.head,
    sourceStatusBefore: sourceBefore.status,
    turns: [],
    transcriptPath: null,
    evidencePath: null,
    reportPath: null,
    error: null,
  };
  await persistRun(runRecord, runPath);
  try {
    await finishTurn(runRecord, runPath, stage.id, text, started.turnId, turnStartedAt, target, options.timeoutMs);
  } catch (error) {
    await markRunFailed(runRecord, runPath, error);
    throw error;
  }
  return runRecord;
}

async function executeTurn(
  runRecord: BenchmarkRun,
  runPath: string,
  stageId: string,
  text: string,
  client: RemuxBenchmarkClient,
) {
  const target = createBenchmarkTarget(runRecord.target, client);
  const startedAt = new Date().toISOString();
  try {
    const started = await target.send({ conversationId: runRecord.conversationId, text });
    await finishTurn(runRecord, runPath, stageId, text, started.turnId, startedAt, target, 45 * 60_000);
  } catch (error) {
    await markRunFailed(runRecord, runPath, error);
    throw error;
  }
}

async function finishTurn(
  runRecord: BenchmarkRun,
  runPath: string,
  stageId: string,
  text: string,
  turnId: string,
  startedAt: string,
  target: ReturnType<typeof createBenchmarkTarget>,
  timeoutMs: number,
) {
  await target.waitForTerminal({ conversationId: runRecord.conversationId, turnId, timeoutMs });
  const [transcript, workspace] = await Promise.all([
    target.readTranscript(runRecord.conversationId),
    snapshotWorkspace(runRecord.workspacePath),
  ]);
  runRecord.turns.push({
    stageId,
    text,
    turnId,
    startedAt,
    completedAt: new Date().toISOString(),
    workspaceHeadAfter: workspace.head,
    workspaceStatusAfter: workspace.status,
  });
  runRecord.stageIndex = runRecord.turns.length;
  runRecord.state = runRecord.stageIndex >= benchmarkScenario(runRecord.fixtureId).stages.length
    ? 'ready-for-evaluation'
    : 'running';
  runRecord.updatedAt = new Date().toISOString();
  runRecord.transcriptPath = await captureTranscript(runRecord, transcript);
  await persistRun(runRecord, runPath);
  process.stdout.write(`\n[${stageId}] ${turnId}\n${transcript.assistantTextByTurn[turnId] ?? '<no assistant text>'}\n`);
}

async function markRunFailed(runRecord: BenchmarkRun, runPath: string, error: unknown) {
  runRecord.state = 'failed';
  runRecord.error = error instanceof Error ? error.message : String(error);
  runRecord.updatedAt = new Date().toISOString();
  await persistRun(runRecord, runPath);
}

async function loadRequiredRun(options: Options) {
  const runId = requiredOption(options.runId, '--run');
  const runPath = join(options.dataRoot, 'runs', runId);
  return { runRecord: await readJson<BenchmarkRun>(join(runPath, 'run.json')), runPath };
}

async function withClient(options: Options, action: (client: RemuxBenchmarkClient) => Promise<void>) {
  const token = (await readFile(options.tokenFile, 'utf8')).trim();
  const client = await RemuxBenchmarkClient.connect(options.endpoint, token);
  try {
    await action(client);
  } finally {
    client.close();
  }
}

async function persistRun(runRecord: BenchmarkRun, runPath: string) {
  await mkdir(runPath, { recursive: true });
  const path = join(runPath, 'run.json');
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(runRecord, null, 2)}\n`);
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function printRunProgress(runRecord: BenchmarkRun) {
  const scenario = benchmarkScenario(runRecord.fixtureId);
  printJson({
    runId: runRecord.runId,
    state: runRecord.state,
    target: runRecord.target,
    conversationId: runRecord.conversationId,
    completedStages: runRecord.turns.map(({ stageId, turnId }) => ({ stageId, turnId })),
    nextStage: scenario.stages[runRecord.stageIndex]?.id ?? null,
    workspacePath: runRecord.workspacePath,
    reportPath: runRecord.reportPath,
    error: runRecord.error,
  });
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments; received ${key ?? '<end>'}.`);
    }
    values.set(key, value);
    index += 1;
  }
  const target = values.get('--target') ?? 'codex';
  if (target !== 'codex' && target !== 'agent') throw new Error('--target must be codex or agent.');
  if (values.has('--context-mode')) {
    throw new Error('--context-mode was removed; the Agent benchmark always uses Thread Runtime v1.');
  }
  const timeoutMs = Number(values.get('--timeout-ms') ?? 45 * 60_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('--timeout-ms must be a safe integer of at least 1000.');
  return {
    target,
    scenario: values.get('--scenario') ?? DEFAULT_SCENARIO,
    dataRoot: resolve(values.get('--data-root') ?? DEFAULT_DATA_ROOT),
    endpoint: values.get('--endpoint') ?? DEFAULT_ENDPOINT,
    tokenFile: resolve(values.get('--token-file') ?? DEFAULT_TOKEN_FILE),
    cwd: values.has('--cwd') ? resolve(values.get('--cwd')!) : null,
    modelId: values.get('--model') ?? null,
    reasoning: values.get('--reasoning') ?? 'high',
    reviewMode: values.get('--review-mode') ?? 'full-access',
    speed: values.get('--speed') ?? 'default',
    timeoutMs,
    runId: values.get('--run') ?? null,
    sourceRun: values.get('--source-run') ?? null,
    text: values.get('--text') ?? null,
  };
}

type Options = {
  target: BenchmarkTarget;
  scenario: string;
  dataRoot: string;
  endpoint: string;
  tokenFile: string;
  cwd: string | null;
  modelId: string | null;
  reasoning: string;
  reviewMode: string;
  speed: string;
  timeoutMs: number;
  runId: string | null;
  sourceRun: string | null;
  text: string | null;
};

function requiredOption(value: string | null, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function newRunId(target: BenchmarkTarget) {
  return `${new Date().toISOString().replace(/[:.]/gu, '-')}-${target}-${randomBytes(3).toString('hex')}`;
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`Remux production-path benchmark\n\n` +
    `  benchmark list\n` +
    `  benchmark prepare [--scenario id]\n` +
    `  benchmark models --target codex|agent [--cwd path]\n` +
    `  benchmark start --target codex|agent --model id [--reasoning high]\n` +
    `  benchmark send --run id [--text prompt]\n` +
    `  benchmark resume --run id\n` +
    `  benchmark status --run id\n` +
    `  benchmark finalize --run id\n` +
    `  benchmark run --target codex|agent --model id\n` +
    `  benchmark replay --source-run id --target codex|agent --model id\n` +
    `  benchmark sentinel --target agent --model id\n`);
}
