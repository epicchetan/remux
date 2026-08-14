import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  PARENT_CONTEXT_TOOL_NAMES,
  WORK_UNIT_CONTEXT_TOOL_NAMES,
} from '../server/src/context/tools.ts';
import { REMUX_SYSTEM_PROMPT, renderWorkUnitPrompt } from '../server/src/prompts.ts';

const PROMPTS_ROOT = resolve(import.meta.dirname, '../server/prompts');

test('the production system prompt is the repository-owned Markdown file', async () => {
  const markdown = (await readFile(resolve(PROMPTS_ROOT, 'system.md'), 'utf8')).trim();
  assert.equal(REMUX_SYSTEM_PROMPT, markdown);
  assert.match(markdown, /## Runtime model/u);
  assert.match(markdown, /## Working cycle/u);
  assert.match(markdown, /## Thread/u);
  assert.match(markdown, /## History/u);
  assert.match(markdown, /The parent owns the overall turn/u);
  assert.match(markdown, /Resources are selective exact context bridges/u);
  assert.match(markdown, /Accept and continue/u);
  assert.match(markdown, /Spot-check a named seam/u);
  assert.match(markdown, /Start an independent audit work unit/u);
  assert.match(markdown, /without reconstructing the child trace/u);
  assert.match(markdown, /Use `commentary` for sparse, user-readable progress/u);
  assert.match(markdown, /generally 8–15 words/u);
  assert.match(markdown, /do not repeat the visible reasoning headline/u);
  assert.match(markdown, /Do not mechanically split ordinary work into audit, implementation, and final-audit units/u);
  assert.match(markdown, /same model rereading the same surface is usually repetition/u);
  assert.match(markdown, /The current user message and observed repository state override/u);
});

test('the repository-owned work-unit prompt renders its objective and typed resources', () => {
  const rendered = renderWorkUnitPrompt({
    objective: 'Implement the projection-cell ownership slice.',
    doneWhen: ['The ownership behavior is implemented and validated.'],
    resources: [
      promptResource('docs/projection.md', 'authority', 'Governing contract.', 'contract body'),
      promptResource('history://event/42', 'evidence', 'Prior failure.', 'failure body'),
    ],
  });
  assert.match(rendered, /Implement the projection-cell ownership slice\./u);
  assert.match(rendered, /## Done when/u);
  assert.match(rendered, /ownership behavior is implemented/u);
  assert.match(rendered, /## Resources in context/u);
  assert.match(rendered, /docs\/projection\.md/u);
  assert.match(rendered, /history:\/\/event\/42/u);
  assert.match(rendered, /authority/u);
  assert.match(rendered, /contract body/u);
  assert.match(rendered, /enable the parent's next decision or action/u);
  assert.match(rendered, /prevent meaningful reconstruction/u);
  assert.match(rendered, /Complete the stated outcome as one closed loop/u);
  assert.match(rendered, /Do not hand routine validation back to the parent/u);
  assert.match(rendered, /generally 8–15 words/u);
  assert.match(rendered, /repeat the visible reasoning headline/u);
  assert.doesNotMatch(rendered, /\{\{/u);

  const withoutResources = renderWorkUnitPrompt({ objective: 'Audit validation.', doneWhen: [], resources: [] });
  assert.doesNotMatch(withoutResources, /## Resources in context/u);
  assert.doesNotMatch(withoutResources, /\n{3,}/u);
});

function promptResource(
  ref: string,
  role: 'authority' | 'deliverable' | 'evidence',
  description: string,
  content: string,
) {
  return {
    ref,
    role,
    description,
    content,
    inclusion: 'materialized' as const,
    snapshot: {
      ref: `history://artifact/${'a'.repeat(64)}`,
      hash: 'a'.repeat(64),
      byteLength: Buffer.byteLength(content, 'utf8'),
      mediaType: 'text/plain; charset=utf-8',
      source: ref.startsWith('history://') ? 'history' as const : 'file' as const,
    },
  };
}

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
