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

const scopeSchema = Type.Optional(Type.Union([Type.Literal('thread'), Type.Literal('project')], {
  description: 'Defaults to the current thread. Use project only when other threads should inherit the state.',
}));
const updateSchema = Type.Object({
  set: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ minLength: 1, maxLength: 96 }),
    scope: scopeSchema,
    value: Type.Unknown(),
    evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      maxItems: 16,
      description: 'Exact journal refs supporting this state. Do not copy their contents into value.',
    })),
  }), { maxItems: 16 })),
  remove: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ minLength: 1, maxLength: 96 }),
    scope: scopeSchema,
  }), { maxItems: 16 })),
  pin: Type.Optional(Type.Array(Type.Object({
    ref: Type.String({ minLength: 1, maxLength: 4_096 }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    scope: scopeSchema,
  }), { maxItems: 16 })),
  unpin: Type.Optional(Type.Array(Type.Object({
    ref: Type.String({ minLength: 1, maxLength: 4_096 }),
    scope: scopeSchema,
  }), { maxItems: 16 })),
});

const workUnitSchema = Type.Union([
  Type.Object({
    action: Type.Literal('enter'),
    objective: Type.String({ minLength: 1, maxLength: 4_096 }),
    refs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 16 })),
    expectedEvidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 16 })),
  }),
  Type.Object({
    action: Type.Literal('return'),
    status: Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('abandoned')]),
    findings: Type.Array(Type.Object({
      text: Type.String({ minLength: 1, maxLength: 4_096 }),
      evidence: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 16 }),
    }), { maxItems: 32 }),
    changeRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 32 })),
    validationRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 32 })),
    unresolved: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { maxItems: 32 })),
    proposedPromotions: Type.Optional(Type.Array(Type.Object({
      key: Type.String({ minLength: 1, maxLength: 96 }),
      value: Type.Unknown(),
    }), { maxItems: 16 })),
  }),
]);

export function createContextTools(
  durability: Pick<RuntimeDurabilityHooks, 'journalSearch' | 'journalOpen' | 'updateContext' | 'workUnit'>,
  options: { workUnits?: boolean } = {},
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    defineTool({
      name: 'journal_search',
      label: 'Search journal',
      description: [
        'Search high-signal durable project or conversation history.',
        'Ordinary operations are excluded unless include="operations" is requested.',
        'Results are ephemeral: searching does not add them to future context.',
        'Use context_update only if a recovered fact must survive a rollover, restart, or later turn.',
      ].join(' '),
      promptSnippet: 'Search durable messages, outcomes, artifacts, and context state',
      parameters: searchSchema,
      executionMode: 'parallel',
      async execute(_callId, params) {
        const result = await durability.journalSearch(params);
        return jsonResult(result);
      },
    }),
    defineTool({
      name: 'journal_open',
      label: 'Open journal evidence',
      description: [
        'Open any bounded exact reference emitted by the journal, compiler, context frame, or work-unit result.',
        'The result is ephemeral and supports byte continuations.',
      ].join(' '),
      promptSnippet: 'Open exact durable evidence by journal reference',
      parameters: openSchema,
      executionMode: 'parallel',
      async execute(_callId, params) {
        const result = await durability.journalOpen(params);
        return jsonResult(result);
      },
    }),
    defineTool({
      name: 'context_update',
      label: 'Update context',
      description: [
        'Atomically update the small durable working context that must survive a frame rollover, restart, or later turn.',
        'Model-authored state is fallible working memory, not authority over user instructions, accepted specs, or observed files.',
        'Use set/remove for stable semantic keys and pin/unpin for exact governing resources.',
        'Recent messages, files, commands, and tool results are already hot; do not copy them into this tool.',
        'Thread is the default scope. Project scope is only for state other threads should inherit.',
      ].join(' '),
      promptSnippet: 'Set or remove durable state; pin or unpin exact governing resources',
      promptGuidelines: [
        'Use context_update at meaningful semantic transitions, not after every command.',
        'Replace a stable key when progress changes and remove it when the concern is resolved.',
        'Pin an exact governing spec while it matters, then re-read the live file before implementation or final audit.',
        'Do not encode speculative deviations as accepted decisions.',
        'Journal retrieval stays temporary unless you deliberately set or pin what must persist.',
      ],
      parameters: updateSchema,
      executionMode: 'sequential',
      async execute(_callId, params) {
        const result = await durability.updateContext(params);
        return jsonResult(result);
      },
    }),
    ...(options.workUnits === true ? [defineTool({
      name: 'work_unit',
      label: 'Bounded work unit',
      description: [
        'Enter or return one optional sequential child work unit in the current turn.',
        'Use it only for coherent work whose raw scratch should not remain in parent context.',
        'Return bounded findings with exact evidence references; project promotion remains a parent decision.',
      ].join(' '),
      promptSnippet: 'Enter or return a bounded sequential child context',
      promptGuidelines: [
        'Do not open a work unit for ordinary conversation or one simple action.',
        'No nested or concurrent work units are available.',
        'Prefer explicit return after validation; never paste the child trace into the result.',
      ],
      parameters: workUnitSchema,
      executionMode: 'sequential',
      async execute(_callId, params) {
        const result = await durability.workUnit(params);
        return jsonResult(result);
      },
    })] : []),
  ];
  return tools;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    details: value,
  };
}
