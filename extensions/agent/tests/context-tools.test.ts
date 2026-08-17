import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createContextTools } from '../server/src/context/tools.ts';

test('model-facing context tools use History and work-unit start/finish language', async () => {
  const seen: {
    searchCallId?: string;
    openedRef?: string;
    boundary?: string;
    artifacts?: string[];
  } = {};
  const tools = createContextTools({
    async historySearch(callId, input) {
      seen.searchCallId = callId;
      return {
        query: input.query,
        scope: input.scope ?? 'conversation',
        hits: [{ ref: 'history://turn/prior', kind: 'assistant-outcome', excerpt: 'Prior result.' }],
        truncated: false,
        retention: 'ephemeral',
      };
    },
    async historyOpen(input) {
      seen.openedRef = input.ref;
      return {
        ref: input.ref,
        content: 'Prior result.',
        contentHash: 'a'.repeat(64),
        offset: 0,
        byteLength: 13,
        totalByteLength: 13,
        nextOffset: null,
        retention: 'ephemeral',
      };
    },
    async workUnitEnter(_callId, input) {
      seen.boundary = input.boundary;
      return {
        scopeId: 'child',
        parentScopeId: 'parent',
        boundary: input.boundary,
        state: 'running',
      };
    },
    async workUnitFinish(_callId, input) {
      seen.artifacts = input.artifacts;
      return {
        scopeId: 'child',
        status: input.status,
        result: input.result,
        artifacts: [],
        resultRef: `history://artifact/${'b'.repeat(64)}`,
        historyRef: 'history://scope/child',
      };
    },
  });
  assert.deepEqual(tools.map(({ name }) => name), [
    'history_search',
    'history_read',
    'context_compact',
    'work_unit_start',
    'work_unit_finish',
  ]);
  assert.doesNotMatch(
    tools.map(({ description, promptGuidelines, promptSnippet }) =>
      [description, promptSnippet, ...(promptGuidelines ?? [])].join(' ')).join(' '),
    /thread\.md|journal_search|journal_open|work_unit_enter|work_unit_return|cold history/iu,
  );

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const finishSchema = byName.get('work_unit_finish')!.parameters as {
    required?: string[];
    properties?: { result?: { maxLength?: number } };
  };
  assert.deepEqual(finishSchema.required, ['status', 'result']);
  assert.equal(finishSchema.properties?.result?.maxLength, undefined);
  assert.equal('threadUpdate' in (finishSchema.properties ?? {}), false);
  assert.equal('artifacts' in (finishSchema.properties ?? {}), true);
  const context = {} as ExtensionContext;
  const search = await byName.get('history_search')!.execute(
    'search', { query: 'prior' }, undefined, undefined, context,
  );
  assert.equal((search.details as { hits: Array<{ ref: string }> }).hits[0]?.ref, 'history://turn/prior');
  assert.equal(seen.searchCallId, 'search');
  const opened = await byName.get('history_read')!.execute(
    'read', { ref: 'history://turn/prior' }, undefined, undefined, context,
  );
  assert.equal(seen.openedRef, 'history://turn/prior');
  assert.equal((opened.details as { ref: string }).ref, 'history://turn/prior');
  const compacted = await byName.get('context_compact')!.execute(
    'compact', {}, undefined, undefined, context,
  );
  assert.deepEqual(compacted.details, {
    requested: true,
    continuation: 'Compaction will occur before the next inference.',
  });
  const work = await byName.get('work_unit_start')!.execute(
    'work', {
      boundary: 'Inspect the seam and close when its exact contract is verified.',
    },
    undefined, undefined, context,
  );
  assert.equal(seen.boundary, 'Inspect the seam and close when its exact contract is verified.');
  assert.equal((work.details as { boundary: string }).boundary, seen.boundary);
  const finished = await byName.get('work_unit_finish')!.execute(
    'finish', {
      status: 'completed',
      result: 'The seam is sound.',
      artifacts: ['history://turn/prior', 'src/seam.ts'],
    },
    undefined, undefined, context,
  );
  assert.deepEqual(seen.artifacts, [
    'history://turn/prior',
    'src/seam.ts',
  ]);
  assert.equal(finished.terminate, true);
  assert.equal((finished.details as { status: string }).status, 'completed');

  const formerBoundary = `## Detailed result\n\n${'repository-grounded finding\n'.repeat(800)}`;
  assert.ok(Buffer.byteLength(formerBoundary, 'utf8') > 16 * 1024);
  await byName.get('work_unit_finish')!.execute(
    'finish-large', { status: 'partial', result: formerBoundary }, undefined, undefined, context,
  );
});
