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
  assert.match(markdown, /## History and execution/u);
  assert.match(markdown, /A prior turn may appear as dialogue only/u);
  assert.match(markdown, /complete parent reasoning and execution trajectory/u);
  assert.match(markdown, /disposable continuation segment/u);
  assert.match(markdown, /not delegation to another agent/u);
  assert.match(markdown, /There is no synthetic user request/u);
  assert.match(markdown, /one brief, user-readable boundary statement/u);
  assert.match(markdown, /Artifact contents are stored in History but are never injected automatically/u);
  assert.match(markdown, /Use `commentary` for sparse, user-readable progress/u);
  assert.match(markdown, /Do not repeat the visible reasoning summary/u);
  assert.match(markdown, /one independently verifiable slice/u);
  assert.match(markdown, /Do not assign the whole turn by default/u);
  assert.match(markdown, /enter a distinct remaining slice, perform missing cross-slice integration validation once, or answer the user/u);
  assert.match(markdown, /Do not reread files, repeat searches, or rerun focused validation already covered by the result/u);
  assert.match(markdown, /Most turns should not need them/u);
  assert.doesNotMatch(markdown, /continuation bundle|proposed Thread update/iu);
});

test('parent and child context-tool profiles expose only scope-valid actions', () => {
  assert.deepEqual(PARENT_CONTEXT_TOOL_NAMES, [
    'history_search',
    'history_read',
    'work_unit_start',
  ]);
  assert.deepEqual(WORK_UNIT_CONTEXT_TOOL_NAMES, [
    'history_search',
    'history_read',
    'work_unit_finish',
  ]);
  assert.ok(!PARENT_CONTEXT_TOOL_NAMES.includes('work_unit_finish' as never));
  assert.ok(!WORK_UNIT_CONTEXT_TOOL_NAMES.includes('work_unit_start' as never));
});
