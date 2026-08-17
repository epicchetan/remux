import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { createBenchmarkTarget } from './adapters.ts';
import type {
  BenchmarkDriverEvent,
  BenchmarkReport,
  BenchmarkRun,
  BenchmarkTarget,
  BenchmarkTurnRecord,
  PreparedFixtureManifest,
} from './contracts.ts';
import {
  captureTranscript,
  evaluateRun,
  preflightScenario,
  snapshotWorkspace,
} from './evidence.ts';
import { createRunWorkspace, prepareFixture } from './fixture.ts';
import { RemuxBenchmarkClient } from './remux-client.ts';
import { benchmarkScenario, benchmarkScenarios } from './scenarios.ts';
import type {
  TurnContextPlan,
  TurnContextResolution,
} from '../../shared/protocol.ts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');
const DEFAULT_DATA_ROOT = join(homedir(), '.local', 'state', 'remux', 'benchmarks');
const DEFAULT_ENDPOINT = 'ws://127.0.0.1:48123/ws';
const DEFAULT_TOKEN_FILE = join(REPOSITORY_ROOT, '.remux', 'auth-token');
const DEFAULT_SCENARIO = 'ledger-projection-time-bars-strict-v1';

await main(process.argv.slice(2));

async function main(argv: string[]) {
  const command = argv[0] ?? 'help';
  const options = parseOptions(argv.slice(1));
  try {
    switch (command) {
      case 'list':
        printJson(benchmarkScenarios().map((scenario) => ({
          suite: scenario.suite,
          fixtureId: scenario.fixtureId,
          title: scenario.title,
          goal: scenario.driverBrief.goal,
          maxUserTurns: scenario.maxUserTurns,
          maxDurationMs: scenario.maxDurationMs,
        })));
        return;
      case 'prepare':
        await commandPrepare(options);
        return;
      case 'preflight':
        await commandPreflight(options);
        return;
      case 'models':
        await withClient(options, (client) => commandModels(options, client));
        return;
      case 'start':
        await withClient(options, (client) => commandStart(options, client));
        return;
      case 'observe':
        await withClient(options, (client) => commandObserve(options, client));
        return;
      case 'send':
        await withClient(options, (client) => commandSend(options, client));
        return;
      case 'stop':
        await commandStop(options);
        return;
      case 'status':
        await commandStatus(options);
        return;
      case 'evaluate':
        await commandEvaluate(options);
        return;
      case 'compare':
        await commandCompare(options);
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

async function commandPreflight(options: Options) {
  const scenario = benchmarkScenario(options.scenario);
  const prepared = await prepareFixture(scenario, options.dataRoot);
  const report = await preflightScenario({ scenario, manifest: prepared.manifest, dataRoot: options.dataRoot });
  printJson(report);
  if (!report.passed) process.exitCode = 1;
}

async function commandModels(options: Options, client: RemuxBenchmarkClient) {
  const cwd = options.cwd ?? REPOSITORY_ROOT;
  const result = options.target === 'codex'
    ? await client.query('remux/codex/models/read', { cwd }, `benchmark:models:${cwd}`)
    : await client.query('remux/agent/resources/read', { requests: [{ key: 'auth' }, { key: 'models' }] }, 'benchmark:models:agent');
  printJson(result);
}

async function commandStart(options: Options, client: RemuxBenchmarkClient) {
  const scenario = benchmarkScenario(options.scenario);
  const text = await turnText(options, scenario.fixedPrompt);
  const driverEvent = await readDriverEvent(options.driverEventPath);
  const prepared = await prepareFixture(scenario, options.dataRoot);
  const runId = newRunId(options.target);
  const runPath = join(options.dataRoot, 'runs', runId);
  const workspacePath = await createRunWorkspace(prepared.manifest, runPath);
  const target = createBenchmarkTarget(options.target, client);
  const modelId = requiredOption(options.modelId, '--model');
  const contextPlan = resolveContextPlan(options.target, options, []);
  const startedAt = new Date().toISOString();
  const sourceBefore = await snapshotWorkspace(scenario.sourceRepository);
  const started = await target.start({
    cwd: workspacePath,
    modelId,
    reasoning: options.reasoning,
    reviewMode: options.reviewMode,
    speed: options.speed,
    text,
    contextPlan,
  });
  const runRecord: BenchmarkRun = {
    version: 3,
    runId,
    fixtureId: scenario.fixtureId,
    suite: scenario.suite,
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
    contextArchitecture: options.target === 'agent' ? 'explicit-turn-context-v1' : 'codex-app-server',
    stopReason: null,
    driverAssessment: null,
    startedAt,
    updatedAt: startedAt,
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
    await finishTurn({
      runRecord,
      runPath,
      text,
      driverNote: options.driverNote,
      driverEvent,
      authority: turnAuthority(scenario.driverBrief.defaultAuthority, options),
      contextPlan,
      turnId: started.turnId,
      startedAt,
      target,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    await markInfrastructureFailure(runRecord, runPath, error);
    throw error;
  }
  printRunProgress(runRecord);
}

async function commandObserve(options: Options, client: RemuxBenchmarkClient) {
  const { runRecord } = await loadRequiredRun(options);
  const target = createBenchmarkTarget(runRecord.target, client);
  const [transcript, workspace] = await Promise.all([
    target.readTranscript(runRecord.conversationId),
    snapshotWorkspace(runRecord.workspacePath),
  ]);
  const last = runRecord.turns.at(-1);
  printJson({
    runId: runRecord.runId,
    state: runRecord.state,
    stopReason: runRecord.stopReason,
    turns: runRecord.turns.length,
    latest: last ? {
      sequence: last.sequence,
      turnId: last.turnId,
      user: last.text,
      assistant: transcript.assistantTextByTurn[last.turnId] ?? '',
      status: transcript.turnStatusByTurn[last.turnId] ?? null,
    } : null,
    workspace,
  });
}

async function commandSend(options: Options, client: RemuxBenchmarkClient) {
  const { runRecord, runPath } = await loadRequiredRun(options);
  const scenario = benchmarkScenario(runRecord.fixtureId);
  const text = await turnText(options, null);
  const driverEvent = await readDriverEvent(options.driverEventPath);
  if (runRecord.state !== 'running') throw new Error(`Run ${runRecord.runId} is ${runRecord.state}, not running.`);
  assertWithinBudget(runRecord, scenario);
  const priorAuthority = runRecord.turns.at(-1)?.authority ?? scenario.driverBrief.defaultAuthority;
  const target = createBenchmarkTarget(runRecord.target, client);
  const contextPlan = resolveContextPlan(runRecord.target, options, runRecord.turns);
  const startedAt = new Date().toISOString();
  try {
    const started = await target.send({
      conversationId: runRecord.conversationId,
      modelId: runRecord.modelId,
      reasoning: runRecord.reasoning,
      text,
      contextPlan,
    });
    await finishTurn({
      runRecord,
      runPath,
      text,
      driverNote: options.driverNote,
      driverEvent,
      authority: turnAuthority(priorAuthority, options),
      contextPlan,
      turnId: started.turnId,
      startedAt,
      target,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    await markInfrastructureFailure(runRecord, runPath, error);
    throw error;
  }
  printRunProgress(runRecord);
}

async function commandStop(options: Options) {
  const { runRecord, runPath } = await loadRequiredRun(options);
  if (runRecord.state !== 'running' && runRecord.state !== 'infrastructure-failed') {
    throw new Error(`Run ${runRecord.runId} is ${runRecord.state}; only active runs can be stopped.`);
  }
  const reason = stopReason(requiredOption(options.stopReason, '--reason'));
  runRecord.state = 'stopped';
  runRecord.stopReason = reason;
  runRecord.driverAssessment = options.note;
  runRecord.updatedAt = new Date().toISOString();
  await persistRun(runRecord, runPath);
  printRunProgress(runRecord);
}

async function commandStatus(options: Options) {
  const { runRecord } = await loadRequiredRun(options);
  printRunProgress(runRecord);
}

async function commandEvaluate(options: Options) {
  const { runRecord, runPath } = await loadRequiredRun(options);
  if (!['stopped', 'completed', 'failed'].includes(runRecord.state)) {
    throw new Error(`Run ${runRecord.runId} is ${runRecord.state}; only terminal runs can be evaluated.`);
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

async function commandCompare(options: Options) {
  const agentRunId = requiredOption(options.agentRunId, '--agent-run');
  const codexRunId = requiredOption(options.codexRunId, '--codex-run');
  const [agent, codex] = await Promise.all([
    readJson<BenchmarkReport>(join(options.dataRoot, 'runs', agentRunId, 'report.json')),
    readJson<BenchmarkReport>(join(options.dataRoot, 'runs', codexRunId, 'report.json')),
  ]);
  if (agent.target !== 'agent' || codex.target !== 'codex') {
    throw new Error('Comparison requires --agent-run to target Agent and --codex-run to target Codex.');
  }
  if (agent.fixtureId !== codex.fixtureId || agent.suite !== 'parity' || codex.suite !== 'parity') {
    throw new Error('Comparison arms must use the same parity fixture.');
  }
  const comparisonId = `${agentRunId}--${codexRunId}`;
  const comparisonRoot = join(options.dataRoot, 'comparisons', comparisonId);
  await mkdir(comparisonRoot, { recursive: true });
  const value = {
    version: 3,
    comparisonId,
    fixtureId: agent.fixtureId,
    model: { agent: agent.modelId, codex: codex.modelId },
    reasoning: { agent: agent.reasoning, codex: codex.reasoning },
    correctness: {
      agentPassed: agent.passed,
      codexPassed: codex.passed,
      agentFailedGates: agent.gates.filter((gate) => !gate.passed).map((gate) => gate.id),
      codexFailedGates: codex.gates.filter((gate) => !gate.passed).map((gate) => gate.id),
    },
    runtime: {
      agentActiveTurnMs: agent.activeTurnMs,
      codexActiveTurnMs: codex.activeTurnMs,
      deltaMs: agent.activeTurnMs - codex.activeTurnMs,
      ratio: codex.activeTurnMs > 0 ? agent.activeTurnMs / codex.activeTurnMs : null,
    },
    context: {
      agentProviderCalls: agent.metrics.providerCalls,
      codexFunctionCalls: codex.metrics.functionCalls,
      agentFunctionCalls: agent.metrics.functionCalls,
      agentWorkUnits: agent.metrics.workUnitsEntered,
      agentPeakRootTokens: agent.metrics.peakRootEstimatedInputTokens,
      agentPeakChildTokens: agent.metrics.peakChildEstimatedInputTokens,
      codexContextWindow: codex.metrics.modelContextWindow,
      agentCompactions: agent.metrics.compactionEvents,
      codexCompactions: codex.metrics.compactionEvents,
      agentCacheReadRatio: agent.metrics.cacheReadRatio,
      codexCacheReadRatio: codex.metrics.cacheReadRatio,
    },
    reports: {
      agent: join(options.dataRoot, 'runs', agentRunId, 'report.json'),
      codex: join(options.dataRoot, 'runs', codexRunId, 'report.json'),
    },
  };
  const jsonPath = join(comparisonRoot, 'comparison.json');
  const markdownPath = join(comparisonRoot, 'comparison.md');
  await writeFile(jsonPath, `${JSON.stringify(value, null, 2)}\n`);
  await writeFile(markdownPath, renderComparisonMarkdown(value));
  printJson({ ...value, artifacts: { json: jsonPath, markdown: markdownPath } });
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
    modelId: requiredOption(options.modelId, '--model'),
    reasoning: options.reasoning,
    text: 'Do not call tools or change files. Reply exactly: BENCHMARK_SENTINEL_TWO',
  });
  await target.waitForTerminal({ conversationId: first.conversationId, turnId: second.turnId, timeoutMs: options.timeoutMs });
  const transcript = await target.readTranscript(first.conversationId);
  const workspace = await snapshotWorkspace(cwd);
  const firstText = transcript.assistantTextByTurn[first.turnId] ?? '';
  const secondText = transcript.assistantTextByTurn[second.turnId] ?? '';
  const passed = firstText.includes('BENCHMARK_SENTINEL_ONE') &&
    secondText.includes('BENCHMARK_SENTINEL_TWO') && workspace.status === '';
  printJson({ passed, target: options.target, conversationId: first.conversationId, turnIds: [first.turnId, second.turnId], firstText, secondText, workspace });
  if (!passed) process.exitCode = 1;
}

async function finishTurn(input: {
  runRecord: BenchmarkRun;
  runPath: string;
  text: string;
  driverNote: string | null;
  driverEvent: BenchmarkDriverEvent | null;
  authority: BenchmarkTurnRecord['authority'];
  contextPlan: TurnContextPlan | null;
  turnId: string;
  startedAt: string;
  target: ReturnType<typeof createBenchmarkTarget>;
  timeoutMs: number;
}) {
  const { runRecord, runPath, target } = input;
  await target.waitForTerminal({ conversationId: runRecord.conversationId, turnId: input.turnId, timeoutMs: input.timeoutMs });
  const [transcript, workspace] = await Promise.all([
    target.readTranscript(runRecord.conversationId),
    snapshotWorkspace(runRecord.workspacePath),
  ]);
  const completedAt = new Date().toISOString();
  runRecord.turns.push({
    sequence: runRecord.turns.length + 1,
    text: input.text,
    driverNote: input.driverNote,
    driverEvent: input.driverEvent,
    authority: input.authority,
    turnId: input.turnId,
    startedAt: input.startedAt,
    completedAt,
    activeDurationMs: Math.max(0, Date.parse(completedAt) - Date.parse(input.startedAt)),
    workspaceHeadAfter: workspace.head,
    workspaceStatusAfter: workspace.status,
    contextPlan: input.contextPlan,
  });
  await persistTurnEvidence({
    runPath,
    turn: runRecord.turns.at(-1)!,
    assistant: transcript.assistantTextByTurn[input.turnId] ?? '',
  });
  const scenario = benchmarkScenario(runRecord.fixtureId);
  const exhausted = runRecord.turns.length >= scenario.maxUserTurns ||
    Date.now() - Date.parse(runRecord.startedAt) >= scenario.maxDurationMs;
  if (exhausted) {
    runRecord.state = 'stopped';
    runRecord.stopReason = scenario.suite === 'parity' ? 'accepted' : 'budget-exhausted';
    runRecord.driverAssessment = scenario.suite === 'parity'
      ? 'The fixed parity prompt completed; the evaluator determines implementation correctness.'
      : 'The adaptive run reached its configured turn or duration budget.';
  }
  runRecord.updatedAt = new Date().toISOString();
  runRecord.transcriptPath = await captureTranscript(runRecord, transcript);
  await persistRun(runRecord, runPath);
  process.stdout.write(`\n[turn ${runRecord.turns.length}] ${input.turnId}\n${transcript.assistantTextByTurn[input.turnId] ?? '<no assistant text>'}\n`);
}

async function markInfrastructureFailure(runRecord: BenchmarkRun, runPath: string, error: unknown) {
  runRecord.state = 'infrastructure-failed';
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

function assertWithinBudget(runRecord: BenchmarkRun, scenario: ReturnType<typeof benchmarkScenario>) {
  if (runRecord.turns.length >= scenario.maxUserTurns) throw new Error('The adaptive run exhausted its user-turn budget.');
  if (Date.now() - Date.parse(runRecord.startedAt) >= scenario.maxDurationMs) {
    throw new Error('The adaptive run exhausted its duration budget.');
  }
}

function turnAuthority(
  prior: BenchmarkTurnRecord['authority'],
  options: Options,
): BenchmarkTurnRecord['authority'] {
  return {
    mayWrite: options.mayWrite ?? prior.mayWrite,
    mayCommit: options.mayCommit ?? prior.mayCommit,
    mayPush: options.mayPush ?? prior.mayPush,
  };
}

function printRunProgress(runRecord: BenchmarkRun) {
  printJson({
    runId: runRecord.runId,
    state: runRecord.state,
    stopReason: runRecord.stopReason,
    target: runRecord.target,
    conversationId: runRecord.conversationId,
    turns: runRecord.turns.map(({ sequence, turnId, authority, contextPlan }) => ({
      sequence,
      turnId,
      authority,
      contextPlan,
    })),
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
  const target = values.get('--target') ?? 'agent';
  if (target !== 'codex' && target !== 'agent') throw new Error('--target must be codex or agent.');
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
    text: values.get('--text') ?? null,
    textFile: values.has('--text-file') ? resolve(values.get('--text-file')!) : null,
    driverNote: values.get('--driver-note') ?? null,
    driverEventPath: values.has('--driver-event') ? resolve(values.get('--driver-event')!) : null,
    agentRunId: values.get('--agent-run') ?? null,
    codexRunId: values.get('--codex-run') ?? null,
    note: values.get('--note') ?? null,
    stopReason: values.get('--reason') ?? null,
    mayWrite: optionalBoolean(values.get('--may-write'), '--may-write'),
    mayCommit: optionalBoolean(values.get('--may-commit'), '--may-commit'),
    mayPush: optionalBoolean(values.get('--may-push'), '--may-push'),
    automaticDialogueTurns: optionalNonNegativeInteger(
      values.get('--automatic-dialogue-turns'),
      '--automatic-dialogue-turns',
    ),
    contextDialogue: optionalSequenceList(values.get('--context-dialogue'), '--context-dialogue'),
    contextFull: optionalSequenceList(values.get('--context-full'), '--context-full'),
    contextOff: optionalSequenceList(values.get('--context-off'), '--context-off'),
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
  text: string | null;
  textFile: string | null;
  driverNote: string | null;
  driverEventPath: string | null;
  agentRunId: string | null;
  codexRunId: string | null;
  note: string | null;
  stopReason: string | null;
  mayWrite: boolean | null;
  mayCommit: boolean | null;
  mayPush: boolean | null;
  automaticDialogueTurns: number | null;
  contextDialogue: number[];
  contextFull: number[];
  contextOff: number[];
};

function resolveContextPlan(
  target: BenchmarkTarget,
  options: Options,
  priorTurns: BenchmarkTurnRecord[],
): TurnContextPlan | null {
  const hasExplicitOptions = options.automaticDialogueTurns !== null ||
    options.contextDialogue.length > 0 ||
    options.contextFull.length > 0 ||
    options.contextOff.length > 0;
  if (target === 'codex') {
    if (hasExplicitOptions) {
      throw new Error('Codex owns its context policy; context-selection options are Agent-only.');
    }
    return null;
  }

  const resolutions = new Map<number, TurnContextResolution>();
  const add = (sequences: number[], resolution: TurnContextResolution) => {
    for (const sequence of sequences) {
      const prior = resolutions.get(sequence);
      if (prior && prior !== resolution) {
        throw new Error(`Prior turn ${sequence} has conflicting ${prior} and ${resolution} resolutions.`);
      }
      resolutions.set(sequence, resolution);
    }
  };
  add(options.contextDialogue, 'dialogue');
  add(options.contextFull, 'full');
  add(options.contextOff, 'off');

  return {
    version: 1,
    automaticDialogueTurns: options.automaticDialogueTurns ?? 2,
    overrides: [...resolutions.entries()]
      .sort(([left], [right]) => left - right)
      .map(([sequence, resolution]) => {
        const turn = priorTurns[sequence - 1];
        if (!turn || turn.sequence !== sequence) {
          throw new Error(
            `Context selection references prior turn ${sequence}, but only ${priorTurns.length} turn(s) exist.`,
          );
        }
        return { turnId: turn.turnId, resolution };
      }),
  };
}

function optionalBoolean(value: string | undefined, name: string) {
  if (value === undefined) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function optionalNonNegativeInteger(value: string | undefined, name: string) {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return parsed;
}

function optionalSequenceList(value: string | undefined, name: string) {
  if (value === undefined || value.trim() === '') return [];
  const sequences = value.split(',').map((entry) => Number(entry.trim()));
  if (sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 1)) {
    throw new Error(`${name} must be a comma-separated list of positive turn numbers.`);
  }
  return [...new Set(sequences)];
}

function stopReason(value: string): NonNullable<BenchmarkRun['stopReason']> {
  if (value === 'accepted' || value === 'abandoned' || value === 'budget-exhausted') return value;
  throw new Error('--reason must be accepted, abandoned, or budget-exhausted.');
}

function requiredOption(value: string | null, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function turnText(options: Options, fallback: string | null) {
  if (options.textFile) {
    const value = (await readFile(options.textFile, 'utf8')).trim();
    if (!value) throw new Error(`Benchmark text file is empty: ${options.textFile}`);
    return value;
  }
  if (options.text?.trim()) return options.text.trim();
  if (fallback) return fallback;
  throw new Error('--text or --text-file is required for this scenario.');
}

async function readDriverEvent(path: string | null): Promise<BenchmarkDriverEvent | null> {
  if (!path) return null;
  const value = JSON.parse(await readFile(path, 'utf8')) as BenchmarkDriverEvent;
  if (!value || typeof value !== 'object' || typeof value.stage !== 'string' || typeof value.intent !== 'string') {
    throw new Error(`Invalid benchmark driver event: ${path}`);
  }
  if (!Array.isArray(value.introducedConstraints) || !Array.isArray(value.decisions)) {
    throw new Error(`Invalid benchmark driver event arrays: ${path}`);
  }
  return value;
}

async function persistTurnEvidence(input: {
  runPath: string;
  turn: BenchmarkTurnRecord;
  assistant: string;
}) {
  const root = join(input.runPath, 'turns', String(input.turn.sequence).padStart(2, '0'));
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, 'user.md'), `${input.turn.text}\n`),
    writeFile(join(root, 'assistant.md'), `${input.assistant}\n`),
    writeFile(join(root, 'driver-event.json'), `${JSON.stringify(input.turn.driverEvent, null, 2)}\n`),
    writeFile(join(root, 'context-plan.json'), `${JSON.stringify(input.turn.contextPlan, null, 2)}\n`),
    writeFile(join(root, 'workspace-status.txt'), `${input.turn.workspaceStatusAfter}\n`),
  ]);
}

function renderComparisonMarkdown(value: {
  fixtureId: string;
  correctness: { agentPassed: boolean; codexPassed: boolean; agentFailedGates: string[]; codexFailedGates: string[] };
  runtime: { agentActiveTurnMs: number; codexActiveTurnMs: number; deltaMs: number; ratio: number | null };
  context: Record<string, unknown>;
}) {
  const duration = (ms: number) => `${(ms / 60_000).toFixed(2)} min`;
  return [
    `# ${value.fixtureId} parity comparison`,
    '',
    '| | Agent | Codex |',
    '| --- | ---: | ---: |',
    `| Passed | ${value.correctness.agentPassed ? 'yes' : 'no'} | ${value.correctness.codexPassed ? 'yes' : 'no'} |`,
    `| Active turn time | ${duration(value.runtime.agentActiveTurnMs)} | ${duration(value.runtime.codexActiveTurnMs)} |`,
    '',
    `Agent/Codex active-time ratio: ${value.runtime.ratio?.toFixed(2) ?? 'n/a'}.`,
    '',
    `Agent failed gates: ${value.correctness.agentFailedGates.join(', ') || 'none'}.`,
    `Codex failed gates: ${value.correctness.codexFailedGates.join(', ') || 'none'}.`,
    '',
    '## Context evidence',
    '',
    '```json',
    JSON.stringify(value.context, null, 2),
    '```',
    '',
  ].join('\n');
}

function newRunId(target: BenchmarkTarget) {
  return `${new Date().toISOString().replace(/[:.]/gu, '-')}-${target}-${randomBytes(3).toString('hex')}`;
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`Remux adaptive production-path benchmark\n\n` +
    `  benchmark list\n` +
    `  benchmark prepare [--scenario id]\n` +
    `  benchmark preflight [--scenario id]\n` +
    `  benchmark models --target codex|agent [--cwd path]\n` +
    `  benchmark start --target agent|codex --model id [--text prompt|--text-file path] [--driver-event path]\n` +
    `  benchmark observe --run id\n` +
    `  benchmark send --run id [--text prompt|--text-file path] [--driver-event path] [--may-write true]\n` +
    `    Agent context: [--automatic-dialogue-turns n] [--context-full 1,2] [--context-dialogue 1] [--context-off 2]\n` +
    `  benchmark stop --run id --reason accepted|abandoned|budget-exhausted [--note assessment]\n` +
    `  benchmark status --run id\n` +
    `  benchmark evaluate --run id\n` +
    `  benchmark compare --agent-run id --codex-run id\n` +
    `  benchmark sentinel --target agent --model id\n`);
}
