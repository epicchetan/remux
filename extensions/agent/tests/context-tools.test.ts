import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createContextTools } from '../server/src/context/tools.ts';

test('model-facing context tools use Thread, History, and work-unit start/finish language', async () => {
  const seen: {
    searchCallId?: string;
    openedRef?: string;
    resources?: Array<{ ref: string }>;
    returnedResources?: Array<{ ref: string }>;
    threadUpdate?: string;
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
    async threadRead() {
      return { documentId: 'thread', versionId: 'v1', content: '# Thread\n', ref: 'history://document-version/v1' };
    },
    async threadPatch() {
      return { documentId: 'thread', versionId: 'v2', content: '# Thread\n\nUpdated.\n', ref: 'history://document-version/v2' };
    },
    async threadReplace() {
      return { documentId: 'thread', versionId: 'v3', content: '# Thread\n\nReplaced.\n', ref: 'history://document-version/v3' };
    },
    async workUnitEnter(_callId, input) {
      seen.resources = input.resources;
      return {
        scopeId: 'child',
        parentScopeId: 'parent',
        objective: input.objective,
        doneWhen: input.doneWhen ?? [],
        resources: (input.resources ?? []).map((resource) => ({
          ...resource,
          inclusion: 'materialized' as const,
          snapshot: {
            ref: `history://artifact/${'a'.repeat(64)}`,
            hash: 'a'.repeat(64),
            byteLength: 13,
            mediaType: 'text/plain; charset=utf-8',
            source: resource.ref.startsWith('history://') ? 'history' as const : 'file' as const,
          },
        })),
        state: 'running',
      };
    },
    async workUnitReturn(_callId, input) {
      seen.returnedResources = input.resources;
      seen.threadUpdate = input.threadUpdate;
      return { scopeId: 'child', state: 'returning' };
    },
  });
  assert.deepEqual(tools.map(({ name }) => name), [
    'history_search',
    'history_read',
    'thread_read',
    'thread_patch',
    'thread_replace',
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
    properties?: { result?: { maxLength?: number }; threadUpdate?: { maxLength?: number } };
  };
  assert.deepEqual(finishSchema.required, ['status', 'result']);
  assert.equal(finishSchema.properties?.result?.maxLength, undefined);
  assert.equal(finishSchema.properties?.threadUpdate?.maxLength, undefined);
  assert.equal('artifacts' in (finishSchema.properties ?? {}), false);
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
  const thread = await byName.get('thread_read')!.execute(
    'thread', {}, undefined, undefined, context,
  );
  assert.equal((thread.details as { ref: string }).ref, 'history://document-version/v1');
  const work = await byName.get('work_unit_start')!.execute(
    'work', {
      objective: 'Inspect the seam.',
      doneWhen: ['The seam has exact evidence.'],
      resources: [
        { ref: 'history://turn/prior', role: 'evidence' },
        { ref: 'docs/contract.md', role: 'authority' },
      ],
    },
    undefined, undefined, context,
  );
  assert.deepEqual(seen.resources?.map(({ ref }) => ref), ['history://turn/prior', 'docs/contract.md']);
  assert.deepEqual(
    (work.details as { resources: Array<{ ref: string }> }).resources.map(({ ref }) => ref),
    ['history://turn/prior', 'docs/contract.md'],
  );
  await byName.get('work_unit_finish')!.execute(
    'finish', {
      status: 'completed',
      result: 'The seam is sound.',
      threadUpdate: 'Mark the seam verified.',
      resources: [
        { ref: 'history://turn/prior', role: 'evidence' },
        { ref: 'src/seam.ts', role: 'deliverable' },
      ],
    },
    undefined, undefined, context,
  );
  assert.equal(seen.threadUpdate, 'Mark the seam verified.');
  assert.deepEqual(seen.returnedResources?.map(({ ref }) => ref), [
    'history://turn/prior',
    'src/seam.ts',
  ]);

  const formerBoundary = `## Detailed result\n\n${'repository-grounded finding\n'.repeat(800)}`;
  assert.ok(Buffer.byteLength(formerBoundary, 'utf8') > 16 * 1024);
  await byName.get('work_unit_finish')!.execute(
    'finish-large', { status: 'partial', result: formerBoundary }, undefined, undefined, context,
  );
});
