import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeContextUsage, claudeCompactWindow } from '../server/src/providers/claude/claude-context-usage.ts';

test('Claude context uses the latest request from the reported audit, not accumulated cache reads', () => {
  const context = new ClaudeContextUsage();
  const requests = [
    [2, 163292, 0], [56, 8988, 163292], [56, 4288, 172280],
    [56, 9810, 176568], [56, 2650, 186378], [56, 6330, 189028],
    [56, 3742, 195358], [56, 11778, 199100],
  ];
  for (const [index, [input, write, read]] of requests.entries()) {
    const message = {
      id: `request-${index}`, model: 'claude-fable-5-1',
      usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read },
    };
    context.observe(message, index);
    context.observe(message, index + 100); // repeated completed content blocks
  }
  assert.equal(context.snapshot('turn'), null, 'capacity must be known, not guessed');
  context.updateWindows({
    'claude-haiku-4-5': { contextWindow: 200_000 },
    'claude-fable-5-1[1m]': { contextWindow: 1_000_000 },
  });
  assert.deepEqual(context.snapshot('turn'), {
    usedTokens: 210934, windowTokens: 1000000, percent: 210934 / 1000000 * 100,
    autoCompactWindowTokens: 300000,
    measurement: 'derived', freshness: 'live', observedAt: 7, turnId: 'turn',
  });
});

test('Claude context rejects older frames and drops pre-compaction measurements', () => {
  const context = new ClaudeContextUsage();
  context.updateWindows({ root: { contextWindow: 1_000_000 } });
  const message = (id: string, input: number) => ({ id, model: 'root', usage: { input_tokens: input } });
  context.observe(message('first', 100000), 1);
  context.observe(message('second', 300000), 2);
  context.observe(message('first', 100000), 3);
  assert.equal(context.snapshot('turn')?.usedTokens, 300000);
  context.compact();
  context.observe(message('second', 300000), 4);
  assert.equal(context.snapshot('turn'), null);
  context.observe(message('third', 40000), 5);
  assert.equal(context.snapshot('turn')?.usedTokens, 40000);
  context.startTurn();
  assert.equal(context.snapshot('next'), null);
  context.observe(message('fourth', 45000), 6);
  assert.equal(context.snapshot('next')?.percent, 4.5);
});

test('Claude context resolves actual models and keeps unknown or ambiguous capacity unknown', () => {
  const context = new ClaudeContextUsage();
  context.observe({ id: 'one', model: 'root', usage: { input_tokens: 50000 } }, 1);
  context.updateWindows({ child: { contextWindow: 200000 } });
  assert.equal(context.snapshot('turn'), null);
  context.updateWindows({ deployment: { canonicalModel: 'root', contextWindow: 1000000 } });
  assert.equal(context.snapshot('turn')?.windowTokens, 1000000);
  context.updateWindows({
    deployment: { canonicalModel: 'root', contextWindow: 1000000 },
    other: { canonicalModel: 'root', contextWindow: 200000 },
  });
  assert.equal(context.snapshot('turn'), null);
  context.updateWindows({ root: { contextWindow: 200000 } });
  assert.equal(context.snapshot('turn')?.autoCompactWindowTokens, 200000);
  context.observe({ id: 'two', model: 'root', usage: { input_tokens: -1 } }, 2);
  assert.equal(context.snapshot('turn'), null);
});

test('Claude compaction policy reflects the native environment override and capacity bounds', () => {
  assert.equal(claudeCompactWindow({}), 300000);
  assert.equal(claudeCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }), 500000);
  assert.equal(claudeCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k' }), 100000);
  assert.equal(claudeCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '2000000' }), 1000000);
});
