import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBenchmarkTarget } from './benchmark/adapters.ts';
import type { BenchmarkScenario } from './benchmark/contracts.ts';
import { evaluateLifecycleRegressions, summarizeCodexRollout } from './benchmark/evidence.ts';
import { prepareFixture } from './benchmark/fixture.ts';
import { run } from './benchmark/process.ts';
import { LEDGER_FEED_SESSION_SCENARIO } from './benchmark/scenarios.ts';
import type { RemuxBenchmarkClient } from './benchmark/remux-client.ts';

test('ledger benchmark stages preserve the collaborative permission envelope', () => {
  const scenario = LEDGER_FEED_SESSION_SCENARIO;
  assert.deepEqual(scenario.stages.map(({ id }) => id), ['audit', 'implement', 'fifo-correction', 'final-audit']);
  assert.equal(scenario.stages[0].permissions.mayWrite, false);
  assert.ok(scenario.stages.slice(1).every(({ permissions }) => permissions.mayCommit === false && permissions.mayPush === false));
  assert.ok(scenario.stages.every(({ defaultPrompt }) => !defaultPrompt.includes(scenario.hiddenTargetCommit)));
  assert.ok(scenario.stages.length <= scenario.maxUserTurns);
  assert.ok(scenario.hiddenValidationPaths.length > 0);
});

test('fixture preparation creates deterministic, isolated Git history', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-benchmark-fixture-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'docs'), { recursive: true });
  await mustRun('git', ['init', '--quiet', '--initial-branch=main'], source);
  await mustRun('git', ['config', 'user.name', 'Fixture Test'], source);
  await mustRun('git', ['config', 'user.email', 'fixture@example.invalid'], source);
  await writeFile(join(source, 'docs', 'spec.md'), '# Accepted spec\n');
  await writeFile(join(source, 'base.txt'), 'base\n');
  await mustRun('git', ['add', '--all'], source);
  await mustRun('git', ['commit', '--quiet', '--message', 'base'], source);
  const baseCommit = await git(source, ['rev-parse', 'HEAD']);
  const baseTree = await git(source, ['rev-parse', 'HEAD^{tree}']);
  await writeFile(join(source, 'target.txt'), 'hidden target\n');
  await mustRun('git', ['add', '--all'], source);
  await mustRun('git', ['commit', '--quiet', '--message', 'target'], source);
  const targetCommit = await git(source, ['rev-parse', 'HEAD']);
  const rollout = join(root, 'source-rollout.jsonl');
  await writeFile(rollout, '{"type":"historical"}\n');
  const scenario = testScenario(source, baseCommit, targetCommit, rollout);

  const first = await prepareFixture(scenario, join(root, 'data-a'));
  const second = await prepareFixture(scenario, join(root, 'data-b'));
  assert.equal(first.manifest.template.tree, baseTree);
  assert.equal(first.manifest.template.headCommit, second.manifest.template.headCommit);
  assert.equal(await git(first.manifest.template.path, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  assert.equal(await git(first.manifest.template.path, ['remote']), '');
  assert.notEqual((await run('git', ['cat-file', '-e', `${targetCommit}^{commit}`], { cwd: first.manifest.template.path })).code, 0);
  assert.equal(await readFile(join(first.manifest.template.path, 'base.txt'), 'utf8'), 'base\n');
  await assert.rejects(readFile(join(first.manifest.template.path, 'target.txt'), 'utf8'));
});

test('Codex adapter uses public start/send/runtime/transcript contracts', async () => {
  const calls: Array<{ kind: string; method: string; params: unknown }> = [];
  const fake = {
    async query(method: string, params: unknown) {
      calls.push({ kind: 'query', method, params });
      if (method === 'remux/codex/models/read') {
        return { models: [{ model: 'gpt-test', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] };
      }
      if (method === 'remux/codex/thread/resources/read') {
        return { resources: [{ status: 'ok', value: { status: 'ready', activeTurnId: null } }] };
      }
      return {
        resources: [{ status: 'ok', value: {
          turnOrder: ['turn-1'], activeTurnId: null,
          turns: [{ status: 'ok', turnId: 'turn-1', frame: { segments: [{ type: 'assistantMessage', text: 'done' }] } }],
        } }],
      };
    },
    async command(method: string, params: unknown) {
      calls.push({ kind: 'command', method, params });
      if (method.endsWith('/start')) return { threadId: 'thread-1', turnId: 'turn-1' };
      return { delivery: 'sent', turnId: 'turn-2' };
    },
  };
  const target = createBenchmarkTarget('codex', fake as unknown as RemuxBenchmarkClient);
  const started = await target.start({ cwd: '/fixture', modelId: 'gpt-test', reasoning: 'high', reviewMode: 'full-access', speed: 'default', text: 'audit' });
  assert.deepEqual(started, { conversationId: 'thread-1', turnId: 'turn-1', modelId: 'gpt-test' });
  await target.waitForTerminal({ conversationId: 'thread-1', turnId: 'turn-1', timeoutMs: 1_000 });
  const transcript = await target.readTranscript('thread-1');
  assert.equal(transcript.assistantTextByTurn['turn-1'], 'done');
  assert.ok(calls.some(({ method }) => method === 'remux/codex/thread/message/start'));
  assert.ok(calls.some(({ method }) => method === 'remux/codex/thread/resources/read'));
  assert.ok(calls.some(({ method }) => method === 'remux/codex/transcript/resources/read'));
});

test('Agent adapter uses public create/send/runtime/transcript contracts', async () => {
  const calls: string[] = [];
  const fake = {
    async query(method: string) {
      calls.push(method);
      if (method === 'remux/agent/resources/read' && calls.length === 1) {
        return { resources: [
          { key: 'auth', status: 'ok', value: { state: 'signed-in' } },
          { key: 'models', status: 'ok', value: { models: [{ id: 'gpt-test', supportedReasoning: ['high'] }] } },
        ] };
      }
      if (method === 'remux/agent/resources/read') {
        return { resources: [{ status: 'ok', value: { conversationId: 'conversation-1', state: 'idle' } }] };
      }
      return { resources: [{ status: 'ok', value: {
        turnOrder: ['turn-1'], activeTurnId: null,
        turns: [{ status: 'ok', turnId: 'turn-1', frame: { segments: [{ type: 'assistantMessage', text: 'agent done' }] } }],
      } }] };
    },
    async command(method: string) {
      calls.push(method);
      if (method === 'remux/agent/conversation/create') return { conversationId: 'conversation-1' };
      return { accepted: true, turnId: 'turn-1' };
    },
  };
  const target = createBenchmarkTarget('agent', fake as unknown as RemuxBenchmarkClient);
  const started = await target.start({ cwd: '/fixture', modelId: 'gpt-test', reasoning: 'high', reviewMode: 'full-access', speed: 'default', text: 'audit' });
  assert.deepEqual(started, { conversationId: 'conversation-1', turnId: 'turn-1', modelId: 'gpt-test' });
  await target.waitForTerminal({ conversationId: 'conversation-1', turnId: 'turn-1', timeoutMs: 1_000 });
  const transcript = await target.readTranscript('conversation-1');
  assert.equal(transcript.assistantTextByTurn['turn-1'], 'agent done');
  assert.ok(calls.includes('remux/agent/conversation/create'));
  assert.ok(calls.includes('remux/agent/conversation/message/send'));
  assert.ok(calls.includes('remux/agent/transcript/resources/read'));
});

test('Agent adapter waits for a failed turn to settle durably before returning the error', async () => {
  let transcriptReads = 0;
  const fake = {
    async query(method: string) {
      if (method === 'remux/agent/resources/read') {
        return { resources: [{ status: 'ok', value: {
          conversationId: 'conversation-failed', state: 'error', error: 'provider failed',
        } }] };
      }
      transcriptReads += 1;
      return { resources: [{ status: 'ok', value: {
        turnOrder: ['turn-failed'],
        activeTurnId: transcriptReads === 1 ? 'turn-failed' : null,
        turns: [{
          status: transcriptReads === 1 ? 'ok' : 'error',
          turnId: 'turn-failed',
          frame: { segments: [] },
        }],
      } }] };
    },
    async command() {
      throw new Error('not used');
    },
  };
  const target = createBenchmarkTarget('agent', fake as unknown as RemuxBenchmarkClient);

  await assert.rejects(
    target.waitForTerminal({
      conversationId: 'conversation-failed', turnId: 'turn-failed', timeoutMs: 2_000,
    }),
    /Agent turn failed: provider failed/u,
  );
  assert.equal(transcriptReads, 2);
});

test('Agent adapter waits for a successful turn to settle durably after runtime idle', async () => {
  let transcriptReads = 0;
  const fake = {
    async query(method: string) {
      if (method === 'remux/agent/resources/read') {
        return { resources: [{ status: 'ok', value: {
          conversationId: 'conversation-completed', state: 'idle', activeTurnId: null,
        } }] };
      }
      transcriptReads += 1;
      return { resources: [{ status: 'ok', value: {
        turnOrder: ['turn-completed'],
        activeTurnId: transcriptReads === 1 ? 'turn-completed' : null,
        turns: [{ status: 'ok', turnId: 'turn-completed', frame: { segments: [] } }],
      } }] };
    },
    async command() {
      throw new Error('not used');
    },
  };
  const target = createBenchmarkTarget('agent', fake as unknown as RemuxBenchmarkClient);

  await target.waitForTerminal({
    conversationId: 'conversation-completed', turnId: 'turn-completed', timeoutMs: 2_000,
  });
  assert.equal(transcriptReads, 2);
});

test('Agent benchmark always enters the single production context architecture', async () => {
  const creates: Array<Record<string, unknown>> = [];
  const fake = {
    async query() {
      return { resources: [
        { key: 'auth', status: 'ok', value: { state: 'signed-in' } },
        { key: 'models', status: 'ok', value: { models: [{ id: 'gpt-test', supportedReasoning: ['high'] }] } },
      ] };
    },
    async command(method: string, params: unknown) {
      if (method === 'remux/agent/conversation/create') {
        creates.push(params as Record<string, unknown>);
        return { conversationId: `conversation-${creates.length}` };
      }
      return { accepted: true, turnId: `turn-${creates.length}` };
    },
  };
  const target = createBenchmarkTarget('agent', fake as unknown as RemuxBenchmarkClient);
  await target.start({
    cwd: '/fixture', modelId: 'gpt-test', reasoning: 'high', reviewMode: 'full-access',
    speed: 'default', text: 'audit',
  });
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0], {
    operationId: creates[0]?.operationId,
    cwd: '/fixture',
    modelId: 'gpt-test',
    reasoning: 'high',
  });
  assert.equal('contextMode' in creates[0]!, false);
  assert.equal('workUnits' in creates[0]!, false);
});

test('rollout evidence reports token, compaction, tool, and leakage signals', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-benchmark-rollout-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const workspace = join(root, '.remux-benchmarks', 'runs', 'run', 'workspace');
  const path = join(root, 'rollout.jsonl');
  const scenario = { ...LEDGER_FEED_SESSION_SCENARIO, sourceRepository: source };
  await writeFile(path, [
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `git -C ${source} show HEAD` }) } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: `await tools.exec_command({cmd: 'git status', workdir: '${workspace}'})` } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 234, reasoning_output_tokens: 50, total_tokens: 1234 },
      model_context_window: 258400,
    } } }),
  ].join('\n'));
  const summary = await summarizeCodexRollout(path, workspace, scenario);
  assert.equal(summary.functionCalls, 2);
  assert.equal(summary.commandCalls, 2);
  assert.equal(summary.compactionEvents, 1);
  assert.equal(summary.totalTokenUsage, 1234);
  assert.equal(summary.inputTokens, 1000);
  assert.equal(summary.cachedInputTokens, 900);
  assert.equal(summary.modelContextWindow, 258400);
  assert.ok(summary.leakageFindings.some((finding) => finding.includes(source)));
});

test('frozen lifecycle checks catch stale-clock and discarded-shutdown regressions', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-benchmark-lifecycle-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const feedPath = join(root, 'crates/ledger/src/feed/es_replay');
  const cliPath = join(root, 'crates/cli/src');
  await Promise.all([mkdir(feedPath, { recursive: true }), mkdir(cliPath, { recursive: true })]);
  await writeFile(join(feedPath, 'feed.rs'), `
    write.replace_array(&cells.batches, kept);
    ctx.submit(write).await?;
    continue;
    while batch_idx < total_batches {}
  `);
  await writeFile(join(cliPath, 'main.rs'), `
    let run_result = drive().await;
    let shutdown_result = session.shutdown().await;
    match (run_result, shutdown_result) {
      (Err(error), Err(shutdown_error)) => return Err(error.context(format!("session shutdown also failed: \${shutdown_error}"))),
      _ => todo!(),
    }
  `);
  assert.deepEqual(await evaluateLifecycleRegressions(root), {
    feedRereadsClock: true,
    dualErrorsPreserved: true,
  });

  await writeFile(join(feedPath, 'feed.rs'), 'write.replace_array(&cells.batches, kept); ctx.submit(write).await?; while due {}');
  await writeFile(join(cliPath, 'main.rs'), 'let run_result = drive().await; let shutdown_result = session.shutdown().await; run_result?; shutdown_result?;');
  assert.deepEqual(await evaluateLifecycleRegressions(root), {
    feedRereadsClock: false,
    dualErrorsPreserved: false,
  });
});

function testScenario(source: string, baseCommit: string, targetCommit: string, rollout: string): BenchmarkScenario {
  return {
    version: 1,
    fixtureId: 'fixture-test',
    title: 'fixture test',
    sourceRepository: source,
    baseCommit,
    acceptedSpecPath: 'docs/spec.md',
    hiddenTargetCommit: targetCommit,
    sourceRollouts: [rollout],
    sourceTurnIds: ['turn-source-only'],
    maxUserTurns: 1,
    stages: [{
      id: 'audit', title: 'audit', ownerIntent: ['audit'], defaultPrompt: 'audit',
      permissions: { mayWrite: false, mayCommit: false, mayPush: false },
    }],
    forbiddenPaths: [],
    hiddenValidationPaths: [],
    requiredCommands: [],
  };
}

async function mustRun(file: string, args: string[], cwd: string) {
  const result = await run(file, args, { cwd });
  assert.equal(result.code, 0, result.stderr);
}

async function git(cwd: string, args: string[]) {
  const result = await run('git', args, { cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}
