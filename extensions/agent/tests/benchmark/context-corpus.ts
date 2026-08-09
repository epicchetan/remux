import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';

import {
  compileShadowContext,
  type ShadowContextSource,
} from '../../server/src/context/compiler.ts';
import {
  createDurableContextSnapshot,
  type LogicalContextMessage,
  type LogicalToolCall,
} from '../../server/src/logical-context.ts';

const FIXED_CONTRACTS_HASH = '0'.repeat(64);
const SAMPLE_EVERY_TOOL_RESULTS = 25;

const DEFAULT_CORPUS = [
  {
    label: 'projection-time-bars',
    path: '/home/ubuntu/.codex/sessions/2026/07/08/rollout-2026-07-08T02-01-24-019f3f75-6062-7b22-a7d4-288dadb9ce48.jsonl',
  },
  {
    label: 'session-transport',
    path: '/home/ubuntu/.codex/sessions/2026/07/08/rollout-2026-07-08T03-10-48-019f3fb4-e7e1-77a0-b49a-b1cb7b6dbc73.jsonl',
  },
  {
    label: 'replay-cleanup',
    path: '/home/ubuntu/.codex/sessions/2026/07/08/rollout-2026-07-08T20-47-16-019f437c-2382-7f20-9b06-ec84f0cbb397.jsonl',
  },
  {
    label: 'atomic-delivery',
    path: '/home/ubuntu/.codex/sessions/2026/07/09/rollout-2026-07-09T19-51-47-019f486f-b24c-7d93-9603-b309c81ae9cf.jsonl',
  },
  {
    label: 'projection-redesign',
    path: '/home/ubuntu/.codex/sessions/2026/07/20/rollout-2026-07-20T15-32-57-019f8028-afc1-75c0-bdea-27641cca9d29.jsonl',
  },
] as const;

type JsonObject = Record<string, unknown>;

type PendingAssistant = {
  text: string[];
  reasoning: string[];
  calls: LogicalToolCall[];
};

type ParsedTask = {
  turnId: string;
  timestamp: number;
  userText: string | null;
  fallbackUserText: string | null;
  body: LogicalContextMessage[];
  pending: PendingAssistant;
  callNames: Map<string, string>;
  toolResults: number;
  state: 'completed' | 'failed' | 'interrupted';
};

type ParsedRollout = {
  tasks: ParsedTask[];
  compactions: number;
  rollbacks: number;
  malformedLines: number;
};

type CheckpointMetric = {
  fullEstimatedTokens: number;
  candidateEstimatedTokens: number;
  omissions: number;
  compileMs: number;
  decision: 'append' | 'roll' | 'block';
};

async function main() {
  const requested = process.argv.slice(2).filter((value) => value !== '--');
  const corpus = requested.length > 0
    ? requested.map((path) => ({ label: basename(path, '.jsonl'), path }))
    : [...DEFAULT_CORPUS];
  const reports = [];
  const missing: string[] = [];
  for (const fixture of corpus) {
    try {
      await access(fixture.path);
    } catch {
      missing.push(fixture.path);
      continue;
    }
    reports.push(await benchmarkRollout(fixture.label, fixture.path));
  }
  if (reports.length === 0) {
    throw new Error('No context-corpus rollout files were available.');
  }
  const metrics = reports.flatMap((report) => report.checkpointMetrics);
  const result = {
    format: 'agent-context-corpus-report-v1',
    compilerMode: 'shadow',
    activeProviderMode: 'unchanged-full-replay',
    caveat: 'Structural retained-history pressure benchmark. Compaction and rollback rows are counted but not replayed, so full estimates are upper bounds rather than historical provider usage; this does not score semantic recall or task quality.',
    sampleEveryToolResults: SAMPLE_EVERY_TOOL_RESULTS,
    aggregate: summarizeMetrics(metrics),
    fixtures: reports.map(({ checkpointMetrics: _checkpointMetrics, ...report }) => report),
    missing,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function benchmarkRollout(label: string, path: string) {
  const [parsed, sourceSha256, source] = await Promise.all([
    parseRollout(path),
    hashFile(path),
    stat(path),
  ]);
  const history: LogicalContextMessage[] = [];
  const seenTurns = new Set<string>();
  const checkpointMetrics: CheckpointMetric[] = [];
  let turns = 0;
  let toolResults = 0;
  let skippedTasks = 0;
  for (const task of parsed.tasks) {
    if (seenTurns.has(task.turnId)) continue;
    seenTurns.add(task.turnId);
    const userText = task.userText ?? task.fallbackUserText;
    if (!userText) {
      skippedTasks += 1;
      continue;
    }
    turns += 1;
    toolResults += task.toolResults;
    const messages: LogicalContextMessage[] = [
      {
        role: 'user',
        turnId: task.turnId,
        text: userText,
        timestamp: task.timestamp,
      },
      ...task.body,
    ];
    const checkpointCounts = sampledMessageCounts(messages);
    for (const count of checkpointCounts) {
      const visible = [...history, ...messages.slice(0, count)];
      checkpointMetrics.push(compileCheckpoint(label, task, visible, checkpointMetrics.length + 1));
    }
    history.push(...messages);
  }
  if (checkpointMetrics.length === 0) {
    throw new Error(`Rollout ${label} produced no compilable checkpoints.`);
  }
  return {
    label,
    sourceFile: basename(path),
    sourceSha256,
    sourceBytes: source.size,
    turns,
    toolResults,
    checkpoints: checkpointMetrics.length,
    compactionsObserved: parsed.compactions,
    rollbacksObserved: parsed.rollbacks,
    malformedLines: parsed.malformedLines,
    skippedTasks,
    deterministic: true,
    ...summarizeMetrics(checkpointMetrics),
    checkpointMetrics,
  };
}

function compileCheckpoint(
  label: string,
  task: ParsedTask,
  messages: LogicalContextMessage[],
  sequence: number,
): CheckpointMetric {
  const snapshot = createDurableContextSnapshot(sequence, messages);
  const fullEstimatedTokens = Math.ceil(snapshot.estimatedBytes / 4) + 1_000;
  const currentUser = [...messages].reverse().find((message): message is Extract<LogicalContextMessage, { role: 'user' }> =>
    message.role === 'user' && message.turnId === task.turnId);
  if (!currentUser) throw new Error(`Corpus task ${task.turnId} has no current user message.`);
  const source: ShadowContextSource = {
    basisSequence: sequence,
    projectId: `corpus:${label}`,
    projectRevision: 0,
    conversationId: `corpus:${label}`,
    strandId: `corpus:${label}:main`,
    turnId: task.turnId,
    scopeId: `corpus:${task.turnId}:scope`,
    epochId: `corpus:${task.turnId}:epoch`,
    targetContextSpaceId: `corpus:${label}:space`,
    workspaceRoot: '/benchmark/workspace',
    reasoning: 'high',
    messages,
    authority: [],
    turnAnchor: {
      currentUser: { ref: `journal://turn/${encodeURIComponent(task.turnId)}#user`, body: currentUser.text },
      precedingAssistantRef: null,
      acceptedProposalRef: null,
      steeringRefs: [],
    },
    observedRuntime: { cwd: '/benchmark/workspace' },
    executionScope: { kind: 'turn', parentScopeId: null, objective: {}, capsuleRef: null },
  };
  const profile = {
    modelId: 'corpus-model',
    contextWindow: 258_000,
    fixedContractsHash: FIXED_CONTRACTS_HASH,
    activeEstimatedInputTokens: fullEstimatedTokens,
  };
  const started = performance.now();
  const candidate = compileShadowContext(source, profile);
  const compileMs = performance.now() - started;
  const repeated = compileShadowContext(source, profile);
  if (candidate.semanticHash !== repeated.semanticHash || candidate.bootstrap !== repeated.bootstrap) {
    throw new Error(`Context compilation was not deterministic for ${label}/${task.turnId}.`);
  }
  return {
    fullEstimatedTokens,
    candidateEstimatedTokens: candidate.estimatedInputTokens,
    omissions: candidate.omissions.reduce((total, omission) => total + omission.count, 0),
    compileMs,
    decision: candidate.decision.kind,
  };
}

function sampledMessageCounts(messages: readonly LogicalContextMessage[]) {
  const counts: number[] = [];
  let toolResults = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== 'tool') continue;
    toolResults += 1;
    if (toolResults % SAMPLE_EVERY_TOOL_RESULTS === 0) counts.push(index + 1);
  }
  if (counts.at(-1) !== messages.length) counts.push(messages.length);
  return counts;
}

function summarizeMetrics(metrics: readonly CheckpointMetric[]) {
  const full = metrics.map(({ fullEstimatedTokens }) => fullEstimatedTokens);
  const candidate = metrics.map(({ candidateEstimatedTokens }) => candidateEstimatedTokens);
  const compile = metrics.map(({ compileMs }) => compileMs);
  const ratio = metrics.map(({ fullEstimatedTokens, candidateEstimatedTokens }) =>
    Math.round(candidateEstimatedTokens / Math.max(1, fullEstimatedTokens) * 1_000));
  return {
    peakFullEstimatedTokens: Math.max(...full),
    peakCandidateEstimatedTokens: Math.max(...candidate),
    medianCandidateToFullPermille: percentile(ratio, 0.5),
    compileMsP50: roundDuration(percentile(compile, 0.5)),
    compileMsP95: roundDuration(percentile(compile, 0.95)),
    appendDecisions: metrics.filter(({ decision }) => decision === 'append').length,
    rollDecisions: metrics.filter(({ decision }) => decision === 'roll').length,
    blockDecisions: metrics.filter(({ decision }) => decision === 'block').length,
    peakOmittedUnits: Math.max(...metrics.map(({ omissions }) => omissions)),
  };
}

async function parseRollout(path: string): Promise<ParsedRollout> {
  const tasks: ParsedTask[] = [];
  let active: ParsedTask | null = null;
  let compactions = 0;
  let rollbacks = 0;
  let malformedLines = 0;
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    let row: JsonObject;
    try {
      row = objectValue(JSON.parse(line));
    } catch {
      malformedLines += 1;
      continue;
    }
    const payload = optionalObject(row.payload);
    const payloadType = stringValue(payload?.type);
    if (row.type === 'compacted') compactions += 1;
    if (payloadType === 'thread_rolled_back') rollbacks += 1;
    if (row.type === 'event_msg' && payloadType === 'task_started') {
      if (active) finishTask(active, 'interrupted', tasks);
      const turnId = stringValue(payload?.turn_id);
      if (!turnId) continue;
      active = newTask(turnId, timestampValue(row.timestamp));
      continue;
    }
    if (!active || !payload) continue;
    if (row.type === 'event_msg' && payloadType === 'user_message') {
      active.userText = stringValue(payload.message) ?? active.userText;
      continue;
    }
    if (row.type === 'event_msg' && payloadType === 'task_complete') {
      finishTask(active, 'completed', tasks);
      active = null;
      continue;
    }
    if (row.type === 'event_msg' && payloadType === 'turn_aborted') {
      finishTask(active, 'interrupted', tasks);
      active = null;
      continue;
    }
    if (row.type !== 'response_item') continue;
    consumeResponseItem(active, payload, timestampValue(row.timestamp));
  }
  if (active) finishTask(active, 'interrupted', tasks);
  return { tasks, compactions, rollbacks, malformedLines };
}

function consumeResponseItem(task: ParsedTask, payload: JsonObject, timestamp: number) {
  const type = stringValue(payload.type);
  if (type === 'message') {
    const text = contentText(payload.content);
    if (!text) return;
    const role = stringValue(payload.role);
    if (role === 'user' && !task.fallbackUserText) task.fallbackUserText = text;
    if (role === 'assistant') task.pending.text.push(text);
    return;
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.flatMap((item) => {
          const value = optionalObject(item);
          const text = stringValue(value?.text);
          return text ? [text] : [];
        }).join('\n')
      : '';
    if (summary) task.pending.reasoning.push(summary);
    return;
  }
  if (type === 'function_call' || type === 'custom_tool_call') {
    const callId = stringValue(payload.call_id);
    const name = stringValue(payload.name);
    if (!callId || !name) return;
    task.callNames.set(callId, name);
    task.pending.calls.push({
      callId,
      name,
      args: stringValue(payload.arguments) ?? stringValue(payload.input) ?? '',
    });
    return;
  }
  if (type !== 'function_call_output' && type !== 'custom_tool_call_output') return;
  const callId = stringValue(payload.call_id);
  if (!callId) return;
  flushAssistant(task, timestamp);
  const name = task.callNames.get(callId) ?? 'unknown_tool';
  task.body.push({
    role: 'tool',
    turnId: task.turnId,
    callId,
    name,
    result: serializedValue(payload.output),
    isError: payload.is_error === true,
    timestamp,
  });
  task.toolResults += 1;
}

function flushAssistant(task: ParsedTask, timestamp: number) {
  const { pending } = task;
  if (pending.text.length === 0 && pending.reasoning.length === 0 && pending.calls.length === 0) return;
  task.body.push({
    role: 'assistant',
    turnId: task.turnId,
    text: pending.text.join('\n'),
    reasoning: pending.reasoning.join('\n'),
    toolCalls: pending.calls,
    state: task.state,
    timestamp,
  });
  task.pending = { text: [], reasoning: [], calls: [] };
}

function finishTask(
  task: ParsedTask,
  state: ParsedTask['state'],
  tasks: ParsedTask[],
) {
  task.state = state;
  flushAssistant(task, task.timestamp + task.body.length + 1);
  tasks.push(task);
}

function newTask(turnId: string, timestamp: number): ParsedTask {
  return {
    turnId,
    timestamp,
    userText: null,
    fallbackUserText: null,
    body: [],
    pending: { text: [], reasoning: [], calls: [] },
    callNames: new Map(),
    toolResults: 0,
    state: 'completed',
  };
}

function contentText(value: unknown) {
  if (!Array.isArray(value)) return '';
  return value.flatMap((item) => {
    const content = optionalObject(item);
    const type = stringValue(content?.type);
    const text = stringValue(content?.text);
    return text && (type === 'input_text' || type === 'output_text') ? [text] : [];
  }).join('\n');
}

function serializedValue(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable tool output]';
  }
}

async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected object.');
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function timestampValue(value: unknown) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function percentile(values: readonly number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? 0;
}

function roundDuration(value: number) {
  return Math.round(value * 100) / 100;
}

await main();
