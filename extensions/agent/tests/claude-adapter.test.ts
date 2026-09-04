import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  Options as ClaudeQueryOptions,
  Query as ClaudeQuery,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import {
  ClaudeNativeAdapter,
  normalizeClaudeAccountUsage,
} from '../server/src/providers/claude/claude-adapter.ts';
import {
  PROVIDER_RUNTIME_LIMITS,
  type ProviderEventEnvelope,
} from '../shared/provider-runtime.ts';

test('Claude probe accepts native subscription auth and refuses API-key fallback', async () => {
  const subscription = new ClaudeNativeAdapter({
    runCli: async (args) => args[0] === '--version'
      ? '2.1.223 (Claude Code)'
      : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }),
  });
  const ready = await subscription.probe('claude-local');
  assert.equal(ready.state, 'ready');
  assert.equal(ready.capabilities?.auth, 'native-subscription');
  assert.equal(ready.capabilities?.session.resume, true);
  assert.equal(ready.capabilities?.session.forkNative, true);
  assert.equal(ready.capabilities?.session.contextBranching?.strategy, 'native');
  assert.equal(ready.capabilities?.turns.steer, false);
  assert.equal(ready.capabilities?.content.diffs, true);
  assert.equal(ready.capabilities?.usage.plan, 'read-and-push');
  assert.deepEqual(ready.capabilities?.interaction, {
    blockingApprovals: false,
    structuredUserInput: false,
  });

  const apiKey = new ClaudeNativeAdapter({
    runCli: async (args) => args[0] === '--version'
      ? '2.1.223 (Claude Code)'
      : JSON.stringify({ loggedIn: true, authMethod: 'apiKey', apiProvider: 'anthropic' }),
  });
  const incompatible = await apiKey.probe('claude-local');
  assert.equal(incompatible.state, 'incompatible');
  assert.equal(incompatible.diagnosticCode, 'claude_subscription_required');
});

test('Claude account usage read exposes subscription windows and closes its control query', async () => {
  const query = new FakeClaudeQuery({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 22.4, resets_at: '2026-09-02T18:00:00.000Z' },
      seven_day: { utilization: 61, resets_at: '2026-09-07T12:30:00.000Z' },
      seven_day_opus: { utilization: 74, resets_at: null },
      model_scoped: [{
        display_name: 'Fable',
        utilization: 35,
        resets_at: '2026-09-08T00:00:00.000Z',
      }],
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 12,
        utilization: 12,
      },
    },
  });
  const adapter = new ClaudeNativeAdapter({
    createQuery: () => query as unknown as ClaudeQuery,
    now: () => 1_700_000_000_000,
  });

  const usage = await adapter.readAccountUsage('claude-local');

  assert.equal(query.isClosed, true);
  assert.equal(usage?.availability, 'available');
  assert.equal(usage?.source, 'provider-read');
  assert.equal(usage?.freshness, 'live');
  assert.deepEqual(usage?.windows.map(({ label, model, usedPercent }) => [
    label,
    model,
    usedPercent,
  ]), [
    ['5 hour', null, 22.4],
    ['Weekly', null, 61],
    ['Weekly Opus', 'Opus', 74],
    ['Extra usage', null, 12],
    ['Weekly', 'Fable', 35],
  ]);
  assert.equal(usage?.windows[0]?.resetsAt, Date.parse('2026-09-02T18:00:00.000Z'));
});

test('Claude account usage distinguishes inapplicable plans from temporarily unknown usage', () => {
  assert.equal(normalizeClaudeAccountUsage({ rate_limits_available: false }, 10).availability,
    'not-applicable');
  assert.equal(normalizeClaudeAccountUsage({
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: null, resets_at: null } },
  }, 11).availability, 'unknown');
});

test('Claude Agent SDK session preserves the native harness, MCP scope, and semantic events', async () => {
  const created: Array<{
    prompt: AsyncIterable<SDKUserMessage>;
    options?: ClaudeQueryOptions;
    query: FakeClaudeQuery;
  }> = [];
  const adapter = new ClaudeNativeAdapter({
    environment: {
      ANTHROPIC_API_KEY: 'must-not-leak',
      ANTHROPIC_AUTH_TOKEN: 'must-not-leak',
      REMUX_FEDERATION_MCP_BEARER_TOKEN: 'ambient-must-not-leak',
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
    },
    createQuery: ({ prompt, options }) => {
      assert.notEqual(typeof prompt, 'string');
      const query = new FakeClaudeQuery();
      created.push({ prompt: prompt as AsyncIterable<SDKUserMessage>, options, query });
      return query as unknown as ClaudeQuery;
    },
    now: monotonicClock(),
  });
  const session = await adapter.openSession({
    commandId: 'open-claude',
    providerInstanceId: 'claude-local',
    conversationId: 'conversation-claude',
    executionId: 'execution-claude',
    mode: 'create',
    cwd: '/workspace/remux',
    model: 'claude-sonnet-4-6',
    effort: 'high',
    access: 'read-only',
    developerInstructions: ['Use ordinary chat.', 'Use native same-provider subagents.'],
    federation: {
      endpoint: 'http://127.0.0.1:4242/mcp',
      authorizationHeader: 'Bearer scoped-test-token',
    },
  });
  try {
    const invocation = created[0];
    assert.ok(invocation);
    const options = invocation.options!;
    assert.deepEqual(options.systemPrompt, {
      type: 'preset',
      preset: 'claude_code',
      append: 'Use ordinary chat.\n\nUse native same-provider subagents.',
      snapshot: true,
    });
    assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
    assert.deepEqual(options.settings, {
      disableAllHooks: false,
      autoCompactEnabled: false,
      precomputeCompactionEnabled: false,
    });
    const preToolUseHook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    const sessionStartHook = options.hooks?.SessionStart?.[0]?.hooks[0];
    const fileChangedHook = options.hooks?.FileChanged?.[0]?.hooks[0];
    assert.ok(preToolUseHook);
    assert.ok(sessionStartHook);
    assert.ok(fileChangedHook);
    assert.deepEqual(await sessionStartHook({
      hook_event_name: 'SessionStart',
      session_id: session.nativeSession.sessionId,
      transcript_path: '/tmp/claude-transcript.jsonl',
      cwd: '/workspace/remux',
      source: 'startup',
    }, undefined, { signal: new AbortController().signal }), {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        watchPaths: ['/workspace/remux'],
      },
    });
    assert.deepEqual(options.tools, { type: 'preset', preset: 'claude_code' });
    assert.equal(options.includePartialMessages, true);
    assert.equal(options.forwardSubagentText, true);
    assert.equal(options.persistSession, true);
    assert.equal(options.sessionId, session.nativeSession.sessionId);
    assert.equal(options.permissionMode, 'dontAsk');
    assert.deepEqual(options.disallowedTools, [
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
      'REPL',
      'Workflow',
      'EnterWorktree',
      'ExitWorktree',
    ]);
    assert.deepEqual(options.allowedTools, [
      'mcp__remux-federation__remux_list_agents',
      'mcp__remux-federation__remux_spawn_agent',
      'mcp__remux-federation__remux_send_message',
      'mcp__remux-federation__remux_wait_agent',
      'mcp__remux-federation__remux_interrupt_agent',
      'mcp__remux-federation__remux_close_agent',
    ]);
    assert.equal(options.env?.ANTHROPIC_API_KEY, undefined);
    assert.equal(options.env?.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(options.env?.REMUX_FEDERATION_MCP_BEARER_TOKEN, undefined);
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, '/tmp/claude-config');
    assert.equal(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP, 'remux-agent/1');
    assert.deepEqual(options.mcpServers, {
      'remux-federation': {
        type: 'http',
        url: 'http://127.0.0.1:4242/mcp',
        headers: { Authorization: 'Bearer scoped-test-token' },
        timeout: 14_400_000,
        alwaysLoad: true,
      },
    });

    const hookInput = (toolName: string, toolInput: unknown) => ({
      hook_event_name: 'PreToolUse' as const,
      session_id: session.nativeSession.sessionId,
      transcript_path: '/tmp/claude-transcript.jsonl',
      cwd: '/workspace/remux',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: `tool-${toolName}`,
    });
    const hookOptions = { signal: new AbortController().signal };
    const ask = await preToolUseHook(hookInput('AskUserQuestion', {}), undefined, hookOptions);
    assert.deepEqual(ask, {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Remux uses ordinary chat. Ask the user in your response instead of opening a questionnaire.',
      },
    });
    const write = await preToolUseHook(
      hookInput('Write', { file_path: '/workspace/remux/README.md' }),
      undefined,
      hookOptions,
    );
    assert.deepEqual(write, {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'This delegated execution is read-only.',
      },
    });
    const outside = await preToolUseHook(
      hookInput('Read', { file_path: '/tmp/outside.txt' }),
      undefined,
      hookOptions,
    );
    assert.deepEqual(outside, {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'The requested path is outside the Remux workspace access ceiling.',
      },
    });
    const federation = await preToolUseHook(
      hookInput('mcp__remux-federation__remux_spawn_agent', { task: 'Inspect.' }),
      undefined,
      hookOptions,
    );
    assert.deepEqual(federation, { continue: true });

    const terminal = collectThroughTerminal(session.events);
    const turnInput = {
      commandId: 'claude-turn-command',
      conversationId: 'conversation-claude',
      executionId: 'execution-claude',
      turnId: 'turn-claude',
      content: [{ type: 'text' as const, text: 'Inspect this workspace.' }],
    };
    assert.deepEqual(await Promise.all([
      session.startTurn(turnInput),
      session.startTurn(structuredClone(turnInput)),
    ]), [{ accepted: true }, { accepted: true }]);
    await assert.rejects(() => session.startTurn({
      ...turnInput,
      content: [{ type: 'text', text: 'Changed input under the same command.' }],
    }), /reused with different input/iu);
    const userMessage = await invocation.prompt[Symbol.asyncIterator]().next();
    assert.equal(userMessage.done, false);
    assert.equal(userMessage.value?.type, 'user');
    assert.equal(userMessage.value?.session_id, undefined);
    assert.deepEqual(userMessage.value?.message.content, [{
      type: 'text',
      text: 'Inspect this workspace.',
    }]);
    await fileChangedHook({
      hook_event_name: 'FileChanged',
      session_id: session.nativeSession.sessionId,
      transcript_path: '/tmp/claude-transcript.jsonl',
      cwd: '/workspace/remux',
      file_path: '/workspace/remux/src/runtime.ts',
      event: 'change',
    }, undefined, { signal: new AbortController().signal });

    invocation.query.emit({
      type: 'system',
      subtype: 'init',
      session_id: session.nativeSession.sessionId,
    });
    invocation.query.emit({
      type: 'stream_event',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    });
    invocation.query.emit({
      type: 'stream_event',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working…' } },
    });
    invocation.query.emit({
      type: 'assistant',
      session_id: session.nativeSession.sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'task-tool', name: 'Task', input: { description: 'Review' } }],
      },
      parent_tool_use_id: null,
    });
    invocation.query.emit({
      type: 'assistant',
      session_id: session.nativeSession.sessionId,
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'large-output-tool',
          name: 'Bash',
          input: { command: 'generate verbose output' },
        }],
      },
      parent_tool_use_id: null,
    });
    invocation.query.emit({
      type: 'assistant',
      session_id: session.nativeSession.sessionId,
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'failed-write-tool',
          name: 'Write',
          input: { file_path: '/workspace/remux/src/must-not-be-reported.ts', content: 'nope' },
        }],
      },
      parent_tool_use_id: null,
    });
    invocation.query.emit({
      type: 'assistant',
      session_id: session.nativeSession.sessionId,
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'write-tool',
          name: 'Write',
          input: { file_path: '/workspace/remux/src/new-runtime.ts', content: 'export {};' },
        }],
      },
      parent_tool_use_id: null,
    });
    invocation.query.emit({
      type: 'system',
      subtype: 'task_started',
      session_id: session.nativeSession.sessionId,
      task_id: 'native-task-1',
      tool_use_id: 'task-tool',
      description: 'Native Claude review',
    });
    invocation.query.emit({
      type: 'system',
      subtype: 'task_notification',
      session_id: session.nativeSession.sessionId,
      task_id: 'native-task-1',
      status: 'completed',
      summary: 'Native child finished.',
    });
    invocation.query.emit({
      type: 'user',
      session_id: session.nativeSession.sessionId,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'task-tool', content: 'Done' }],
      },
      parent_tool_use_id: null,
    });
    invocation.query.emit({
      type: 'stream_event',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index: 99,
        content_block: { type: 'thinking', thinking: 'r'.repeat(300_000) },
      },
    });
    invocation.query.emit({
      type: 'stream_event',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 99,
        delta: { type: 'thinking_delta', thinking: 'Recovered projection.' },
      },
    });
    invocation.query.emit({
      type: 'stream_event',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      event: { type: 'content_block_stop', index: 99 },
    });
    invocation.query.emit({
      type: 'user',
      session_id: session.nativeSession.sessionId,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'large-output-tool',
          content: `${'\u001b[2K\r"😀" verbose output\n'.repeat(50_000)}CLAUDE-LAST-LINE`,
        }],
      },
      parent_tool_use_id: null,
    });
    invocation.query.emit({
      type: 'user',
      session_id: session.nativeSession.sessionId,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'failed-write-tool',
          content: 'Denied.',
          is_error: true,
        }],
      },
      parent_tool_use_id: null,
    });
    invocation.query.emit({
      type: 'user',
      session_id: session.nativeSession.sessionId,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'write-tool', content: 'Created.' }],
      },
      parent_tool_use_id: null,
    });
    invocation.query.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: session.nativeSession.sessionId,
      result: 'The workspace boundary is sound.',
      usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 4 },
    });

    const events = await terminal;
    assert.ok(events.some(({ event }) => event.type === 'session.materialized'));
    assert.ok(events.some(({ event }) => event.type.startsWith('turn.block.') &&
      'block' in event && event.block.kind === 'final-message'));
    assert.ok(events.some(({ event }) => event.type === 'turn.block.started' &&
      event.block.payload.kind === 'tool' && event.block.payload.tool.name === 'Task'));
    assert.ok(events.some(({ event }) => event.type === 'turn.block.started' &&
      event.block.payload.kind === 'native-child' &&
      event.block.payload.child.ownership === 'native' &&
      event.block.payload.child.provider === 'claude-code'));
    assert.ok(events.some(({ event }) => event.type === 'turn.block.completed' &&
      event.block.payload.kind === 'native-child' &&
      event.block.payload.summary === 'Native child finished.'));
    assert.ok(events.some(({ event }) => event.type === 'turn.usage-updated' &&
      event.usage.turn?.inputTokens === 20 && event.usage.turn.outputTokens === 8 &&
      event.usage.turn.cachedInputTokens === 4 && event.usage.turn.totalTokens === null));
    assert.ok(events.some(({ event }) => event.type === 'turn.file-changed' &&
      event.change.path === '/workspace/remux/src/runtime.ts' && event.change.kind === 'update'));
    assert.ok(events.some(({ event }) => event.type === 'turn.file-changed' &&
      event.change.path === '/workspace/remux/src/new-runtime.ts' && event.change.kind === 'add'));
    assert.ok(!events.some(({ event }) => event.type === 'turn.file-changed' &&
      event.change.path === '/workspace/remux/src/must-not-be-reported.ts'));
    const recoveredReasoning = events.filter(({ event }) => event.type.startsWith('turn.block.') &&
      'block' in event && event.block.payload.kind === 'reasoning-summary');
    assert.ok(events.some(({ event }) => event.type === 'turn.block.started' &&
      event.block.payload.kind === 'reasoning-summary' &&
      event.block.payload.text === 'Recovered projection.'),
    `a rejected Claude projection must not poison the block or end the native session: ${JSON.stringify(recoveredReasoning)}`);
    const largeOutput = events.find(({ event }) => event.type === 'turn.block.completed' &&
      event.block.payload.kind === 'tool' &&
      event.block.payload.tool.callId === 'large-output-tool');
    assert.ok(largeOutput?.event.type === 'turn.block.completed');
    if (largeOutput?.event.type === 'turn.block.completed' &&
        largeOutput.event.block.payload.kind === 'tool') {
      const output = largeOutput.event.block.payload.outputPreview;
      assert.ok(new TextEncoder().encode(JSON.stringify(output)).byteLength <=
        PROVIDER_RUNTIME_LIMITS.previewBytes);
      assert.match(String(output), /output truncated/u);
      assert.match(String(output), /CLAUDE-LAST-LINE/u);
    }
    const lastEvent = events.at(-1)?.event;
    assert.equal(lastEvent?.type, 'turn.completed');
    if (lastEvent?.type === 'turn.completed') {
      assert.equal(lastEvent.outcome, 'completed');
    }
    const compactEvents = collectThroughCompaction(session.events);
    assert.deepEqual(await session.compact!({
      commandId: 'claude-compact-command',
      conversationId: 'conversation-claude',
      executionId: 'execution-claude',
    }), { accepted: true, nativeOperationId: 'claude-compact-command' });
    const compactMessage = await invocation.prompt[Symbol.asyncIterator]().next();
    assert.equal(compactMessage.done, false);
    assert.equal(compactMessage.value?.type, 'user');
    assert.equal(compactMessage.value?.message.content, '/compact');
    assert.equal(compactMessage.value?.session_id, undefined);
    invocation.query.emit({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: session.nativeSession.sessionId,
      compact_metadata: { trigger: 'manual', pre_tokens: 90_000, post_tokens: 12_000 },
    });
    const compact = await compactEvents;
    assert.equal(compact.filter(({ event }) => event.type === 'context.compaction.started').length, 0,
      'the coordinator, not the adapter, authors the durable started boundary');
    assert.ok(compact.some(({ event }) => event.type === 'context.compaction.completed' &&
      event.trigger === 'manual' && event.operationId === 'claude-compact-command' &&
      event.beforeTokens === 90_000 && event.afterTokens === 12_000));
    const snapshot = await session.snapshot({ commandId: 'claude-snapshot' });
    assert.equal(snapshot.state, 'idle');
    assert.ok(snapshot.events.length >= events.length);
  } finally {
    await session.close();
  }
});

test('Claude workspace-write sessions require the native filesystem sandbox', async () => {
  let options: ClaudeQueryOptions | undefined;
  const adapter = new ClaudeNativeAdapter({
    createQuery: (input) => {
      options = input.options;
      return new FakeClaudeQuery() as unknown as ClaudeQuery;
    },
  });
  const session = await adapter.openSession({
    commandId: 'open-claude-sandboxed',
    providerInstanceId: 'claude-local',
    conversationId: 'conversation-claude-sandboxed',
    executionId: 'execution-claude-sandboxed',
    mode: 'create',
    cwd: '/workspace/remux',
    model: 'claude-sonnet-4-6',
    access: 'workspace-write',
    developerInstructions: [],
  });
  try {
    assert.equal(options?.permissionMode, 'acceptEdits');
    assert.deepEqual(options?.sandbox, {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: ['/workspace/remux'] },
    });
  } finally {
    await session.close();
  }
});

test('Claude native file tools emit an exact unified diff from their before and after images', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'remux-claude-diff-'));
  const path = join(cwd, 'example.ts');
  await writeFile(path, 'export const value = 1;\n');
  const query = new FakeClaudeQuery();
  const adapter = new ClaudeNativeAdapter({
    createQuery: () => query as unknown as ClaudeQuery,
    now: monotonicClock(),
  });
  const session = await adapter.openSession({
    commandId: 'open-claude-diff',
    providerInstanceId: 'claude-local',
    conversationId: 'conversation-claude-diff',
    executionId: 'execution-claude-diff',
    mode: 'create',
    cwd,
    model: 'claude-sonnet-4-6',
    access: 'workspace-write',
    developerInstructions: [],
  });
  try {
    const terminal = collectThroughTerminal(session.events);
    await session.startTurn({
      commandId: 'turn-claude-diff',
      conversationId: 'conversation-claude-diff',
      executionId: 'execution-claude-diff',
      turnId: 'turn-claude-diff',
      content: [{ type: 'text', text: 'Update example.ts.' }],
    });
    query.emit({
      type: 'assistant',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'edit-example',
          name: 'Edit',
          input: { file_path: path, old_string: '1', new_string: '2' },
        }],
      },
    });
    await waitForClaudeEvent(session, ({ event }) =>
      event.type === 'turn.block.started' && event.block.payload.kind === 'tool' &&
      event.block.payload.tool.callId === 'edit-example');
    await writeFile(path, 'export const value = 2;\n');
    query.emit({
      type: 'user',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'edit-example', content: 'Updated.' }],
      },
    });
    query.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: session.nativeSession.sessionId,
      result: 'Updated example.ts.',
    });

    const events = await terminal;
    const fileChange = events.find(({ event }) => event.type === 'turn.file-changed' &&
      event.change.path === path);
    assert.ok(fileChange?.event.type === 'turn.file-changed');
    if (fileChange?.event.type !== 'turn.file-changed') return;
    assert.match(fileChange.event.change.diff ?? '', /--- a\/example\.ts/u);
    assert.match(fileChange.event.change.diff ?? '', /-export const value = 1;/u);
    assert.match(fileChange.event.change.diff ?? '', /\+export const value = 2;/u);
  } finally {
    await session.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Claude stream wrapper UUIDs do not split one native assistant message into reordered blocks', async () => {
  const query = new FakeClaudeQuery();
  const adapter = new ClaudeNativeAdapter({
    createQuery: () => query as unknown as ClaudeQuery,
    now: monotonicClock(),
  });
  const session = await adapter.openSession({
    commandId: 'open-claude-order',
    providerInstanceId: 'claude-local',
    conversationId: 'conversation-claude-order',
    executionId: 'execution-claude-order',
    mode: 'create',
    cwd: '/workspace/remux',
    model: 'claude-sonnet-4-6',
    access: 'read-only',
    developerInstructions: [],
  });
  try {
    const terminal = collectThroughTerminal(session.events);
    await session.startTurn({
      commandId: 'turn-command-order',
      conversationId: 'conversation-claude-order',
      executionId: 'execution-claude-order',
      turnId: 'turn-claude-order',
      content: [{ type: 'text', text: 'Check ordering.' }],
    });

    const stream = (uuid: string, event: unknown) => query.emit({
      type: 'stream_event', uuid, session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null, event,
    });
    stream('10000000-0000-4000-8000-000000000001', {
      type: 'message_start', message: { id: 'msg_native_first', role: 'assistant', content: [] },
    });
    stream('10000000-0000-4000-8000-000000000002', {
      type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' },
    });
    stream('10000000-0000-4000-8000-000000000003', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: 'Inspect first.' },
    });
    stream('10000000-0000-4000-8000-000000000004', {
      type: 'content_block_stop', index: 0,
    });
    stream('10000000-0000-4000-8000-000000000005', {
      type: 'content_block_start', index: 1,
      content_block: { type: 'tool_use', id: 'tool-native-first', name: 'Read', input: { file_path: 'a.ts' } },
    });
    stream('10000000-0000-4000-8000-000000000006', { type: 'message_stop' });
    query.emit({
      type: 'user', uuid: '10000000-0000-4000-8000-000000000007',
      session_id: session.nativeSession.sessionId, parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-native-first', content: 'ok' }],
      },
    });

    stream('10000000-0000-4000-8000-000000000008', {
      type: 'message_start', message: { id: 'msg_native_second', role: 'assistant', content: [] },
    });
    stream('10000000-0000-4000-8000-000000000009', {
      type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' },
    });
    stream('10000000-0000-4000-8000-000000000010', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: 'Then answer.' },
    });
    stream('10000000-0000-4000-8000-000000000011', {
      type: 'content_block_stop', index: 0,
    });
    stream('10000000-0000-4000-8000-000000000012', {
      type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' },
    });
    stream('10000000-0000-4000-8000-000000000013', {
      type: 'content_block_delta', index: 1,
      delta: { type: 'text_delta', text: 'Done.' },
    });
    query.emit({
      type: 'assistant', uuid: '10000000-0000-4000-8000-000000000014',
      session_id: session.nativeSession.sessionId, parent_tool_use_id: null,
      message: {
        id: 'msg_native_second', role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Then answer.', signature: 'signature' },
          { type: 'text', text: 'Done.' },
        ],
      },
    });
    stream('10000000-0000-4000-8000-000000000015', { type: 'message_stop' });
    query.emit({
      type: 'result', uuid: '10000000-0000-4000-8000-000000000016', subtype: 'success',
      is_error: false, session_id: session.nativeSession.sessionId, result: 'Done.',
    });

    const events = await terminal;
    const latest = new Map<string, Extract<ProviderEventEnvelope['event'], {
      type: 'turn.block.started' | 'turn.block.revised' | 'turn.block.completed';
    }>>();
    for (const { event } of events) {
      if (event.type !== 'turn.block.started' &&
          event.type !== 'turn.block.revised' &&
          event.type !== 'turn.block.completed') continue;
      latest.set(event.structure.blockId, event);
    }
    const blocks = [...latest.values()].sort((left, right) =>
      left.structure.passOrdinal - right.structure.passOrdinal ||
      left.structure.blockOrdinal - right.structure.blockOrdinal);
    assert.deepEqual(blocks.map(({ block }) => block.payload.kind === 'tool'
      ? block.payload.tool.name
      : 'text' in block.payload ? block.payload.text : block.payload.kind), [
      'Inspect first.', 'Read', 'Then answer.', 'Done.',
    ]);
    assert.equal(blocks[0]?.structure.passId, blocks[1]?.structure.passId);
    assert.equal(blocks[2]?.structure.passId, blocks[3]?.structure.passId);
    assert.notEqual(blocks[0]?.structure.passId, blocks[2]?.structure.passId);
    assert.deepEqual(
      blocks.filter(({ block }) => block.payload.kind === 'reasoning-summary')
        .map(({ block }) => block.payload.kind === 'reasoning-summary' ? block.payload.parts : null),
      [['Inspect first.'], ['Then answer.']],
    );
    const branchPoint = events.find(({ event }) => event.type === 'turn.branch-point');
    assert.ok(branchPoint?.event.type === 'turn.branch-point');
    if (branchPoint?.event.type === 'turn.branch-point') {
      const cursor = branchPoint.event.cursor as Record<string, unknown>;
      assert.equal(cursor.version, 1);
      assert.match(String(cursor.promptUuid), /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
      assert.equal(cursor.previousChainEntryUuid, null);
      assert.equal(cursor.lastChainEntryUuid, '10000000-0000-4000-8000-000000000014');
    }
  } finally {
    await session.close();
  }
});

test('Claude finalized snapshots reconcile text by semantic position when thinking is omitted', async () => {
  const query = new FakeClaudeQuery();
  const adapter = new ClaudeNativeAdapter({
    createQuery: () => query as unknown as ClaudeQuery,
    now: monotonicClock(),
  });
  const session = await adapter.openSession({
    commandId: 'open-claude-semantic-reconcile',
    providerInstanceId: 'claude-local',
    conversationId: 'conversation-claude-semantic-reconcile',
    executionId: 'execution-claude-semantic-reconcile',
    mode: 'create',
    cwd: '/workspace/remux',
    model: 'claude-sonnet-4-6',
    access: 'read-only',
    developerInstructions: [],
  });
  try {
    const terminal = collectThroughTerminal(session.events);
    await session.startTurn({
      commandId: 'turn-command-semantic-reconcile',
      conversationId: 'conversation-claude-semantic-reconcile',
      executionId: 'execution-claude-semantic-reconcile',
      turnId: 'turn-claude-semantic-reconcile',
      content: [{ type: 'text', text: 'Do not duplicate this response.' }],
    });
    const stream = (event: unknown) => query.emit({
      type: 'stream_event',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      event,
    });
    stream({ type: 'message_start', message: { id: 'msg_semantic', role: 'assistant', content: [] } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    stream({
      type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: 'Inspecting once.' },
    });
    stream({ type: 'content_block_stop', index: 0 });
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    stream({
      type: 'content_block_delta', index: 1,
      delta: { type: 'text_delta', text: 'One final answer.' },
    });
    stream({ type: 'content_block_stop', index: 1 });
    query.emit({
      type: 'assistant',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      message: {
        id: 'msg_semantic',
        role: 'assistant',
        // This is the real Claude failure shape: the finalized SDK snapshot
        // can omit thinking and reindex the visible text from 1 to 0.
        content: [{ type: 'text', text: 'One final answer.' }],
      },
    });
    stream({ type: 'message_stop' });
    query.emit({
      type: 'result', subtype: 'success', is_error: false,
      session_id: session.nativeSession.sessionId, result: 'One final answer.',
    });

    const events = await terminal;
    const latest = latestTurnBlocks(events);
    const final = latest.filter(({ block }) => block.payload.kind === 'final-message');
    assert.equal(final.length, 1);
    assert.equal(final[0]?.block.payload.kind === 'final-message'
      ? final[0].block.payload.text
      : null, 'One final answer.');
    assert.equal(latest.filter(({ block }) => block.payload.kind === 'reasoning-summary').length, 1);
  } finally {
    await session.close();
  }
});

test('Claude streamed tool JSON backfills one durable tool block with its real presentation', async () => {
  const query = new FakeClaudeQuery();
  const adapter = new ClaudeNativeAdapter({
    createQuery: () => query as unknown as ClaudeQuery,
    now: monotonicClock(),
  });
  const session = await adapter.openSession({
    commandId: 'open-claude-tool-json',
    providerInstanceId: 'claude-local',
    conversationId: 'conversation-claude-tool-json',
    executionId: 'execution-claude-tool-json',
    mode: 'create',
    cwd: '/workspace/remux',
    model: 'claude-sonnet-4-6',
    access: 'read-only',
    developerInstructions: [],
  });
  try {
    const terminal = collectThroughTerminal(session.events);
    await session.startTurn({
      commandId: 'turn-command-tool-json',
      conversationId: 'conversation-claude-tool-json',
      executionId: 'execution-claude-tool-json',
      turnId: 'turn-claude-tool-json',
      content: [{ type: 'text', text: 'Inspect the repository.' }],
    });
    const stream = (event: unknown) => query.emit({
      type: 'stream_event',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      event,
    });
    stream({ type: 'message_start', message: { id: 'msg_tool_json', role: 'assistant', content: [] } });
    stream({
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'bash-json', name: 'Bash', input: {} },
    });
    stream({
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":"pwd",' },
    });
    stream({
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '"description":"Inspect workspace"}' },
    });
    stream({ type: 'content_block_stop', index: 0 });
    query.emit({
      type: 'assistant',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      message: {
        id: 'msg_tool_json', role: 'assistant',
        content: [{
          type: 'tool_use', id: 'bash-json', name: 'Bash',
          input: { command: 'pwd', description: 'Inspect workspace' },
        }],
      },
    });
    query.emit({
      type: 'user',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'bash-json', content: '/workspace/remux' }],
      },
    });
    query.emit({
      type: 'result', subtype: 'success', is_error: false,
      session_id: session.nativeSession.sessionId, result: 'Inspected.',
    });

    const events = await terminal;
    const tools = latestTurnBlocks(events)
      .filter(({ block }) => block.payload.kind === 'tool');
    assert.equal(tools.length, 1);
    const payload = tools[0]?.block.payload;
    assert.equal(payload?.kind, 'tool');
    if (payload?.kind !== 'tool') return;
    assert.equal(payload.tool.title, 'Inspect workspace');
    assert.deepEqual(payload.inputPreview, { command: 'pwd', description: 'Inspect workspace' });
    assert.equal(tools[0]?.block.state, 'completed');
  } finally {
    await session.close();
  }
});

test('Claude background tasks never collide with tool ordinals in the same native pass', async () => {
  const query = new FakeClaudeQuery();
  const adapter = new ClaudeNativeAdapter({
    createQuery: () => query as unknown as ClaudeQuery,
    now: monotonicClock(),
  });
  const session = await adapter.openSession({
    commandId: 'open-claude-background-order',
    providerInstanceId: 'claude-local',
    conversationId: 'conversation-claude-background-order',
    executionId: 'execution-claude-background-order',
    mode: 'create',
    cwd: '/workspace/remux',
    model: 'claude-fable-5-1',
    access: 'workspace-write',
    developerInstructions: [],
  });
  try {
    await session.startTurn({
      commandId: 'turn-command-background-order',
      conversationId: 'conversation-claude-background-order',
      executionId: 'execution-claude-background-order',
      turnId: 'turn-claude-background-order',
      content: [{ type: 'text', text: 'Run both checks in the background.' }],
    });
    const stream = (event: unknown) => query.emit({
      type: 'stream_event',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      event,
    });
    stream({
      type: 'message_start',
      message: { id: 'msg_background_order', role: 'assistant', content: [] },
    });
    stream({
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'agent-background-1', name: 'Agent', input: {} },
    });
    stream({
      type: 'content_block_start', index: 1,
      content_block: { type: 'tool_use', id: 'bash-background-2', name: 'Bash', input: {} },
    });
    query.emit({
      type: 'system',
      subtype: 'task_started',
      session_id: session.nativeSession.sessionId,
      task_id: 'background-task-1',
      tool_use_id: 'agent-background-1',
      description: 'First background check',
    });

    await waitForClaudeEvent(session, ({ event }) =>
      event.type === 'turn.block.started' && event.block.payload.kind === 'native-child');
    const snapshot = await session.snapshot({ commandId: 'snapshot-background-order' });
    const started = snapshot.events.flatMap(({ event }) =>
      event.type === 'turn.block.started' ? [event] : []);
    const identities = started.map(({ structure }) =>
      `${structure.passId}:${structure.blockOrdinal}`);
    assert.equal(new Set(identities).size, identities.length,
      'every block in a native pass must own a distinct journal ordinal');
    const nativeChild = started.find(({ block }) => block.payload.kind === 'native-child');
    assert.equal(nativeChild?.structure.blockOrdinal, 2);
  } finally {
    await session.close();
  }
});

test('Claude background Bash lifecycle stays folded into its command block', async () => {
  const query = new FakeClaudeQuery();
  const adapter = new ClaudeNativeAdapter({
    createQuery: () => query as unknown as ClaudeQuery,
    now: monotonicClock(),
  });
  const session = await adapter.openSession({
    commandId: 'open-claude-background-bash',
    providerInstanceId: 'claude-local',
    conversationId: 'conversation-claude-background-bash',
    executionId: 'execution-claude-background-bash',
    mode: 'create',
    cwd: '/workspace/remux',
    model: 'claude-fable-5-1',
    access: 'workspace-write',
    developerInstructions: [],
  });
  try {
    await session.startTurn({
      commandId: 'turn-command-background-bash',
      conversationId: 'conversation-claude-background-bash',
      executionId: 'execution-claude-background-bash',
      turnId: 'turn-claude-background-bash',
      content: [{ type: 'text', text: 'Run a background shell check.' }],
    });
    const stream = (event: unknown) => query.emit({
      type: 'stream_event',
      session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      event,
    });
    stream({
      type: 'message_start',
      message: { id: 'msg_background_bash', role: 'assistant', content: [] },
    });
    stream({
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'bash-background', name: 'Bash', input: {} },
    });
    query.emit({
      type: 'system', subtype: 'task_started',
      session_id: session.nativeSession.sessionId,
      task_id: 'background-shell-task',
      tool_use_id: 'bash-background',
      description: 'Background shell check',
    });
    query.emit({
      type: 'system', subtype: 'task_notification',
      session_id: session.nativeSession.sessionId,
      task_id: 'background-shell-task',
      status: 'completed',
      summary: 'Background shell check completed.',
    });
    query.emit({
      type: 'system', subtype: 'task_notification',
      session_id: session.nativeSession.sessionId,
      task_id: 'background-shell-task',
      status: 'completed',
      summary: 'Repeated native completion notification.',
    });

    await waitForClaudeEvent(session, ({ native }) => native.kind === 'stream/tool_start');
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    const snapshot = await session.snapshot({ commandId: 'snapshot-background-bash' });
    assert.equal(snapshot.events.some(({ event }) => event.type.startsWith('turn.block.') &&
      'block' in event && event.block.payload.kind === 'native-child'), false);
    assert.equal(latestTurnBlocks(snapshot.events)
      .filter(({ block }) => block.payload.kind === 'tool').length, 1);
  } finally {
    await session.close();
  }
});

test('Claude resume keeps a lost turn bound until native handshake evidence closes only that turn', async () => {
  const query = new FakeClaudeQuery();
  const adapter = new ClaudeNativeAdapter({
    createQuery: () => query as unknown as ClaudeQuery,
    now: monotonicClock(),
  });
  const activeTurnBinding = {
    turnId: 'turn-claude-recovery',
    nativeTurnId: 'native-turn-claude-recovery',
  };
  const session = await adapter.openSession({
    commandId: 'open-claude-recovery',
    providerInstanceId: 'claude-local',
    conversationId: 'conversation-claude-recovery',
    executionId: 'execution-claude-recovery',
    mode: 'resume',
    nativeSession: {
      provider: 'claude-code',
      providerInstanceId: 'claude-local',
      sessionId: 'session-claude-recovery',
    },
    cwd: '/workspace/remux',
    model: 'claude-sonnet-4-6',
    access: 'read-only',
    developerInstructions: [],
    nativeTurnBindings: [activeTurnBinding],
    activeTurnBinding,
  });
  try {
    const initial = await session.snapshot({ commandId: 'snapshot-claude-recovery-initial' });
    assert.equal(initial.authority, 'session-local');
    assert.equal(initial.state, 'idle');

    const terminal = collectThroughTerminal(session.events);
    const events = await terminal;
    const completed = events.find(({ event }) => event.type === 'turn.completed');
    assert.equal(completed?.event.type, 'turn.completed');
    if (completed?.event.type === 'turn.completed') {
      assert.equal(completed.event.outcome, 'recovery_failed');
      assert.equal(completed.event.error?.code, 'claude_inflight_turn_not_resumable');
      assert.equal(completed.event.error?.retryable, true);
    }

    // Claude may emit its own internal resume bookkeeping, but it is not the
    // accepted turn and must remain invisible after that turn is closed.
    query.emit({
      type: 'system', subtype: 'init', session_id: session.nativeSession.sessionId,
    });
    query.emit({
      type: 'assistant', session_id: session.nativeSession.sessionId,
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] },
    });
    query.emit({
      type: 'result', subtype: 'success', is_error: false, num_turns: 0,
      session_id: session.nativeSession.sessionId, result: 'No response requested.',
    });
    assert.equal(events.some(({ event }) => event.type.startsWith('turn.block.')), false,
      'the SDK resume handshake must not become accepted-turn transcript content');
    await waitForClaudeEvent(session, ({ event }) =>
      event.type === 'session.health' && event.state === 'ready');
    assert.equal((await session.snapshot({ commandId: 'snapshot-claude-recovery-ready' })).state, 'idle');

    assert.deepEqual(await session.startTurn({
      commandId: 'turn-after-claude-recovery',
      conversationId: 'conversation-claude-recovery',
      executionId: 'execution-claude-recovery',
      turnId: 'turn-after-claude-recovery',
      content: [{ type: 'text', text: 'Continue from the last durable boundary.' }],
    }), { accepted: true });
  } finally {
    await session.close();
  }
});

test('Claude event identity is stable for replay and distinct for a later turn after restart', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const eventIds = async (commandId: string, turnId: string) => {
    const adapter = new ClaudeNativeAdapter({
      createQuery: () => new FakeClaudeQuery() as unknown as ClaudeQuery,
      now: monotonicClock(),
    });
    const session = await adapter.openSession({
      commandId: `open-${commandId}`,
      providerInstanceId: 'claude-local',
      conversationId: 'conversation-claude-restart',
      executionId: 'execution-claude-restart',
      mode: 'resume',
      nativeSession: {
        provider: 'claude-code',
        providerInstanceId: 'claude-local',
        sessionId,
        resumeCursor: { sessionId },
      },
      cwd: '/workspace/remux',
      model: 'claude-sonnet-4-6',
      access: 'read-only',
      developerInstructions: ['Use ordinary chat.'],
    });
    try {
      await session.startTurn({
        commandId,
        conversationId: 'conversation-claude-restart',
        executionId: 'execution-claude-restart',
        turnId,
        content: [{ type: 'text', text: 'Continue.' }],
      });
      const snapshot = await session.snapshot({ commandId: `snapshot-${commandId}` });
      return snapshot.events
        .filter((event) => event.scope.kind === 'turn' && event.scope.turnId === turnId)
        .map(({ eventId }) => eventId);
    } finally {
      await session.close();
    }
  };

  const first = await eventIds('command-first', 'turn-first');
  const replay = await eventIds('command-first', 'turn-first');
  const later = await eventIds('command-later', 'turn-later');
  assert.deepEqual(replay, first, 'the same native lifecycle replay keeps the same event IDs');
  assert.equal(first.some((eventId) => later.includes(eventId)), false,
    'a resumed process cannot collide with an earlier turn merely because its counter reset');
});

async function waitForClaudeEvent(
  session: Awaited<ReturnType<ClaudeNativeAdapter['openSession']>>,
  predicate: (event: ProviderEventEnvelope) => boolean,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await session.snapshot({ commandId: `wait-for-event-${attempt}` });
    if (snapshot.events.some(predicate)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for the Claude fixture event.');
}

function latestTurnBlocks(events: readonly ProviderEventEnvelope[]) {
  const latest = new Map<string, Extract<ProviderEventEnvelope['event'], {
    type: 'turn.block.started' | 'turn.block.revised' | 'turn.block.completed';
  }>>();
  for (const { event } of events) {
    if (event.type === 'turn.block.started' ||
        event.type === 'turn.block.revised' ||
        event.type === 'turn.block.completed') {
      latest.set(event.structure.blockId, event);
    }
  }
  return [...latest.values()];
}

test('Claude native fork uses the persisted chain boundary and guarded dropped turn', async () => {
  const invocations: Array<{ options?: ClaudeQueryOptions; query: FakeClaudeQuery }> = [];
  const adapter = new ClaudeNativeAdapter({
    createQuery: ({ options }) => {
      const query = new FakeClaudeQuery();
      invocations.push({ options, query });
      if (invocations.length > 1) {
        query.emit({ type: 'system', subtype: 'init', session_id: options?.sessionId });
      }
      return query as unknown as ClaudeQuery;
    },
  });
  const session = await adapter.openSession({
    commandId: 'open-fork-source',
    providerInstanceId: 'claude-local',
    conversationId: 'conversation-fork-source',
    executionId: 'execution-fork-source',
    mode: 'create',
    cwd: '/workspace/remux',
    model: 'claude-sonnet-4-6',
    access: 'workspace-write',
    developerInstructions: [],
  });
  try {
    const destinationSessionId = '22222222-2222-4222-8222-222222222222';
    const fork = await session.fork!({
      commandId: 'fork-claude-before',
      destinationSessionId,
      beforeNativeTurnId: 'native-turn-current',
      branchCursor: {
        version: 1,
        promptUuid: '33333333-3333-4333-8333-333333333333',
        previousChainEntryUuid: '44444444-4444-4444-8444-444444444444',
        lastChainEntryUuid: '55555555-5555-4555-8555-555555555555',
      },
    });
    assert.equal(fork.sessionId, destinationSessionId);
    assert.equal(invocations[1]?.options?.resume, session.nativeSession.sessionId);
    assert.equal(invocations[1]?.options?.forkSession, true);
    assert.equal(invocations[1]?.options?.sessionId, destinationSessionId);
    assert.equal(invocations[1]?.options?.resumeSessionAt,
      '44444444-4444-4444-8444-444444444444');
    assert.equal(invocations[1]?.options?.resumeDropsTurn,
      '33333333-3333-4333-8333-333333333333');
  } finally {
    await session.close();
  }
});

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly values: SDKMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];
  private closed = false;
  readonly usageResult: unknown;
  readonly modelChanges: string[] = [];
  readonly flags: unknown[] = [];
  interrupts = 0;

  constructor(usageResult: unknown = { rate_limits_available: true, rate_limits: {} }) {
    this.usageResult = usageResult;
  }

  emit(value: unknown) {
    const message = value as SDKMessage;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.values.push(message);
  }

  async supportedModels() {
    return [];
  }

  async supportedCommands() {
    return [{ name: 'compact', description: 'Compact context', argumentHint: '' }];
  }

  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
    return this.usageResult;
  }

  get isClosed() {
    return this.closed;
  }

  async setModel(model: string) {
    this.modelChanges.push(model);
  }

  async applyFlagSettings(flags: unknown) {
    this.flags.push(flags);
  }

  async interrupt() {
    this.interrupts += 1;
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

async function collectThroughTerminal(events: AsyncIterable<ProviderEventEnvelope>) {
  const collected: ProviderEventEnvelope[] = [];
  for await (const event of events) {
    collected.push(event);
    if (event.event.type === 'turn.completed') return collected;
  }
  throw new Error('Claude event stream ended before terminal completion.');
}

async function collectThroughCompaction(events: AsyncIterable<ProviderEventEnvelope>) {
  const collected: ProviderEventEnvelope[] = [];
  for await (const event of events) {
    collected.push(event);
    if (event.event.type === 'context.compaction.completed') return collected;
  }
  throw new Error('Claude event stream ended before compact completion.');
}

function monotonicClock() {
  let value = 1_000;
  return () => ++value;
}
