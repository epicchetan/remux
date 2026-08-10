import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { RuntimeDurabilityHooks } from '../engine.ts';

const searchSchema = Type.Object({
  query: Type.String({ minLength: 1, description: 'Words or phrase to find in durable journal evidence.' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  scope: Type.Optional(Type.Union([Type.Literal('conversation'), Type.Literal('project')])),
  include: Type.Optional(Type.Literal('operations')),
});

const openSchema = Type.Object({
  ref: Type.String({ minLength: 1, description: 'Stable journal:// reference returned by journal_search.' }),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 256, maximum: 32 * 1024 })),
});

const threadReadSchema = Type.Object({});

const threadUpdateSchema = Type.Object({
  baseVersionId: Type.String({
    minLength: 1,
    description: 'The exact versionId returned by thread_read or the prior successful update.',
  }),
  content: Type.String({
    maxLength: 96 * 1024,
    description: 'Complete replacement Markdown for the active branch thread.md.',
  }),
});

const workUnitEnterSchema = Type.Object({
  objective: Type.String({
    minLength: 1,
    maxLength: 4 * 1024,
    description: 'One focused, coherent objective for the bounded child execution scope.',
  }),
  evidenceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    maxItems: 8,
    description: 'Optional journal:// references that orient the child without copying their contents.',
  })),
});

const workUnitReturnSchema = Type.Object({
  result: Type.String({
    minLength: 1,
    maxLength: 16 * 1024,
    description: 'Bounded Markdown result containing conclusions, changes, validation, and unresolved issues.',
  }),
});

export function createContextTools(
  durability: Pick<
    RuntimeDurabilityHooks,
    'journalSearch' | 'journalOpen' | 'threadRead' | 'threadUpdate' |
    'workUnitEnter' | 'workUnitReturn'
  >,
): ToolDefinition[] {
  return [
    defineTool({
      name: 'journal_search',
      label: 'Search journal',
      description: [
        'Search exact durable project or conversation history that is not in the active frame.',
        'Ordinary operations are excluded unless include="operations" is requested.',
        'Results are ephemeral: searching does not automatically add them to thread.md or later turns.',
      ].join(' '),
      promptSnippet: 'Search durable messages, outcomes, artifacts, and prior operations',
      parameters: searchSchema,
      executionMode: 'parallel',
      async execute(_callId, params) {
        return jsonResult(await durability.journalSearch(params));
      },
    }),
    defineTool({
      name: 'journal_open',
      label: 'Open journal evidence',
      description: [
        'Open a bounded exact journal reference returned by search or present in thread context.',
        'The result is ephemeral and supports byte continuations.',
      ].join(' '),
      promptSnippet: 'Open exact durable evidence by journal reference',
      parameters: openSchema,
      executionMode: 'parallel',
      async execute(_callId, params) {
        return jsonResult(await durability.journalOpen(params));
      },
    }),
    defineTool({
      name: 'thread_read',
      label: 'Read thread state',
      description: 'Read the current branch-scoped thread.md and its compare-and-swap version.',
      promptSnippet: 'Read current collaborative thread state',
      parameters: threadReadSchema,
      executionMode: 'parallel',
      async execute() {
        return jsonResult(await durability.threadRead());
      },
    }),
    defineTool({
      name: 'thread_update',
      label: 'Update thread state',
      description: [
        'Replace branch-scoped thread.md using its exact base version.',
        'Keep current objectives, accepted decisions, constraints, progress, important resources, open questions, and next direction.',
        'It is a bounded collaboration brief, not a transcript, log, scratchpad, or copy of files.',
      ].join(' '),
      promptSnippet: 'CAS-replace the current thread.md collaboration brief',
      promptGuidelines: [
        'Update only at a meaningful state transition or before completing a turn whose outcome changes future context.',
        'Prefer revising or deleting stale text over appending another status block.',
        'Do not store reasoning traces, raw command output, or facts that matter only to the current response.',
      ],
      parameters: threadUpdateSchema,
      executionMode: 'sequential',
      async execute(_callId, params) {
        return jsonResult(await durability.threadUpdate(params));
      },
    }),
    defineTool({
      name: 'work_unit_enter',
      label: 'Enter work unit',
      description: [
        'Branch the current turn into one bounded child execution scope for a coherent subproblem.',
        'The child inherits current parent context and may retrieve exact journal evidence.',
        'Its reasoning and tool trace stay child-local; only an explicit bounded return reaches the parent.',
      ].join(' '),
      promptSnippet: 'Enter a bounded child context for one focused subproblem',
      promptGuidelines: [
        'Use only when isolating substantial scratch or a coherent subproblem improves the work; ordinary short tool sequences stay in the parent.',
        'Work units cannot be nested.',
        'Once entered, finish by calling work_unit_return rather than answering the user directly.',
      ],
      parameters: workUnitEnterSchema,
      executionMode: 'sequential',
      async execute(callId, params) {
        return jsonResult(await durability.workUnitEnter(callId, params));
      },
    }),
    defineTool({
      name: 'work_unit_return',
      label: 'Return work unit',
      description: [
        'Close the active work unit and return one bounded Markdown result to its parent turn.',
        'The child trace remains in the journal and is not replayed into the parent.',
      ].join(' '),
      promptSnippet: 'Fold a bounded child result into the parent context',
      promptGuidelines: [
        'Include conclusions, material changes, validation evidence, and unresolved issues needed by the parent.',
        'Do not paste reasoning traces or raw command output.',
      ],
      parameters: workUnitReturnSchema,
      executionMode: 'sequential',
      async execute(callId, params) {
        return jsonResult(await durability.workUnitReturn(callId, params));
      },
    }),
  ];
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    details: value,
  };
}
