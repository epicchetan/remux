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
  assert.match(markdown, /## Working with the user/u);
  assert.match(markdown, /## Context/u);
  assert.match(markdown, /## Work units/u);
  assert.match(markdown, /A prior turn may appear as dialogue only/u);
  assert.match(markdown, /complete parent reasoning and execution trajectory/u);
  assert.match(markdown, /Omitted messages, commands, results, and work-unit traces remain exact in History/u);
  assert.match(markdown, /Use the supplied context and current repository state first/u);
  assert.match(markdown, /Work in the main turn by default/u);
  assert.match(markdown, /Do not start a work unit merely because work is substantial, tool-heavy/u);
  assert.match(markdown, /when the user requests it, or when an accepted plan already contains/u);
  assert.match(markdown, /It is not delegation and there is no synthetic user message/u);
  assert.match(markdown, /always providing `status` and a compact `result`/u);
  assert.match(markdown, /Use `commentary` for sparse, user-readable progress/u);
  assert.match(markdown, /repeat the visible reasoning summary/u);
  assert.match(markdown, /The final answer must stand alone/u);
  assert.doesNotMatch(markdown, /continuation bundle|proposed Thread update/iu);
});

test('parent and child context-tool profiles expose only scope-valid actions', () => {
  assert.deepEqual(PARENT_CONTEXT_TOOL_NAMES, [
    'history_search',
    'history_read',
    'context_compact',
    'work_unit_start',
  ]);
  assert.deepEqual(WORK_UNIT_CONTEXT_TOOL_NAMES, [
    'history_search',
    'history_read',
    'context_compact',
    'work_unit_finish',
  ]);
  assert.ok(!PARENT_CONTEXT_TOOL_NAMES.includes('work_unit_finish' as never));
  assert.ok(!WORK_UNIT_CONTEXT_TOOL_NAMES.includes('work_unit_start' as never));
});
