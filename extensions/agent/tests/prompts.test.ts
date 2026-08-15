import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  PARENT_CONTEXT_TOOL_NAMES,
  WORK_UNIT_CONTEXT_TOOL_NAMES,
} from '../server/src/context/tools.ts';
import { REMUX_SYSTEM_PROMPT } from '../server/src/prompts.ts';

const PROMPTS_ROOT = resolve(import.meta.dirname, '../server/prompts');

test('the production system prompt is the repository-owned Markdown file', async () => {
  const markdown = (await readFile(resolve(PROMPTS_ROOT, 'system.md'), 'utf8')).trim();
  assert.equal(REMUX_SYSTEM_PROMPT, markdown);
  assert.match(markdown, /## Runtime/u);
  assert.match(markdown, /## How to work/u);
  assert.match(markdown, /## Thread/u);
  assert.match(markdown, /## History/u);
  assert.match(markdown, /The parent owns any subsequent Thread update/u);
  assert.match(markdown, /Resources are selective exact context bridges/u);
  assert.match(markdown, /accept and continue/u);
  assert.match(markdown, /spot-check a named acceptance-critical seam/u);
  assert.match(markdown, /start an independent audit unit/u);
  assert.match(markdown, /The parent remains parked at that exact provider response/u);
  assert.match(markdown, /There is no synthetic user request between them/u);
  assert.match(markdown, /terminal call resolves the parent's still-pending `work_unit_start`/u);
  assert.match(markdown, /Use `commentary` for sparse, user-readable progress/u);
  assert.match(markdown, /Do not repeat the visible reasoning summary/u);
  assert.match(markdown, /Owning acceptance does not mean replaying the child's implementation/u);
  assert.match(markdown, /The current user message and observed repository state override/u);
  assert.match(markdown, /current shared planning, design, and alignment document/u);
  assert.match(markdown, /not general memory, a transcript, an activity log, an execution summary/u);
  assert.match(markdown, /A turn beginning, a tool running, or a work unit completing is not by itself a reason/u);
  assert.match(markdown, /coherent semantic slice that can ordinarily complete comfortably inside one model context/u);
  assert.match(markdown, /do not put the entire task into one child/u);
  assert.match(markdown, /Do not repeat the same inspection or validation merely to gain confidence/u);
  assert.match(markdown, /generic correctness, and the possibility of hidden bugs are not by themselves specific risks/u);
  assert.match(markdown, /Most turns should not need them/u);
  assert.doesNotMatch(markdown, /continuation bundle|proposed Thread update/iu);
});

test('parent and child context-tool profiles expose only scope-valid actions', () => {
  assert.deepEqual(PARENT_CONTEXT_TOOL_NAMES, [
    'history_search',
    'history_read',
    'thread_read',
    'thread_patch',
    'thread_replace',
    'work_unit_start',
  ]);
  assert.deepEqual(WORK_UNIT_CONTEXT_TOOL_NAMES, [
    'history_search',
    'history_read',
    'work_unit_finish',
  ]);
  assert.ok(!PARENT_CONTEXT_TOOL_NAMES.includes('work_unit_finish' as never));
  assert.ok(!WORK_UNIT_CONTEXT_TOOL_NAMES.includes('thread_patch' as never));
  assert.ok(!WORK_UNIT_CONTEXT_TOOL_NAMES.includes('work_unit_start' as never));
});
