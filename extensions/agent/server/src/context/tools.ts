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
const memorySchema = Type.Object({
  remember: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ minLength: 1, maxLength: 96 }),
    scope: scopeSchema,
    value: Type.Unknown(),
  }), { maxItems: 16 })),
  hold: Type.Optional(Type.Array(Type.Object({
    resource: Type.String({
      minLength: 1,
      maxLength: 4_096,
      description: 'Workspace-relative or absolute file path, or an exact journal:// reference.',
    }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    scope: scopeSchema,
  }), { maxItems: 16 })),
  release: Type.Optional(Type.Array(Type.Object({
    key: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    resource: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    scope: scopeSchema,
  }), { maxItems: 16 })),
});

const workUnitSchema = Type.Union([
  Type.Object({
    action: Type.Literal('enter'),
    objective: Type.String({ minLength: 1, maxLength: 4_096 }),
    refs: Type.Optional(Type.Array(Type.String({
      minLength: 1,
      maxLength: 4_096,
      description: 'Exact journal ref, readable file path, or file:start-end citation. Directories and prose labels are not refs.',
    }), { maxItems: 16 })),
    expectedEvidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 16 })),
  }),
  Type.Object({
    action: Type.Literal('return'),
    status: Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('abandoned')]),
    findings: Type.Array(Type.Object({
      text: Type.String({ minLength: 1, maxLength: 4_096 }),
      evidence: Type.Array(Type.String({
        minLength: 1,
        maxLength: 4_096,
        description: 'Exact journal ref, readable file path, or file:start-end citation supporting this finding.',
      }), { maxItems: 16 }),
    }), { maxItems: 32 }),
    changeRefs: Type.Optional(Type.Array(Type.String({
      minLength: 1,
      maxLength: 4_096,
      description: 'Exact journal refs or readable file citations for changed resources; not summaries or directory names.',
    }), { maxItems: 32 })),
    validationRefs: Type.Optional(Type.Array(Type.String({
      minLength: 1,
      maxLength: 4_096,
      description: 'Exact journal refs to validation tool calls/results. Put command names and outcome summaries in findings, not here.',
    }), { maxItems: 32 })),
    unresolved: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { maxItems: 32 })),
    proposedPromotions: Type.Optional(Type.Array(Type.Object({
      key: Type.String({ minLength: 1, maxLength: 96 }),
      value: Type.Unknown(),
    }), { maxItems: 16 })),
    commit: Type.Optional(Type.Object({
      remember: Type.Optional(Type.Array(Type.Object({
        key: Type.String({ minLength: 1, maxLength: 96 }),
        value: Type.Unknown(),
        evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
          maxItems: 16,
          description: 'Journal refs, workspace paths, or path:line citations supporting the value.',
        })),
      }), { maxItems: 16 })),
      forget: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 96 }), { maxItems: 16 })),
      hold: Type.Optional(Type.Array(Type.Object({
        resource: Type.String({
          minLength: 1,
          maxLength: 4_096,
          description: 'Workspace-relative or absolute path, or an exact journal reference.',
        }),
        label: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      }), { maxItems: 16 })),
      release: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 16 })),
    }, {
      description: 'State authored by the child and committed to the parent thread when the return succeeds.',
    })),
  }),
]);

export function createContextTools(
  durability: Pick<RuntimeDurabilityHooks, 'journalSearch' | 'journalOpen' | 'updateContext' | 'workUnit'>,
  options: { workUnits?: boolean; workingMemory?: boolean; boundedWorkUnits?: boolean } = {},
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    defineTool({
      name: 'journal_search',
      label: 'Search journal',
      description: [
        'Search high-signal durable project or conversation history.',
        'Ordinary operations are excluded unless include="operations" is requested.',
        'Results are ephemeral: searching does not add them to future context.',
        `Use ${options.workingMemory === true ? 'memory' : 'context_update'} only if a recovered fact must survive a rollover, restart, or later turn.`,
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
    options.workingMemory === true ? defineTool({
      name: 'memory',
      label: 'Manage working memory',
      description: [
        'Guide the working-context cache only when information must survive beyond the exact hot tail.',
        'Use remember for a small stable semantic value, hold for an exact governing resource, and release when it no longer matters.',
        'A held resource may be a workspace-relative or absolute file path, or an exact journal:// reference.',
        'Ordinary reads are automatically visible to the background compiler; do not remember logs, whole messages, or file contents.',
        'Thread is the default scope. Project scope is only for facts sibling threads should inherit.',
      ].join(' '),
      promptSnippet: 'Remember, hold, or release information in working memory',
      promptGuidelines: [
        'Let the background cache handle ordinary admission and eviction.',
        'Use stable keys and replace them at meaningful phase changes.',
        'Release resolved work and re-read mutable sources before editing or final validation.',
      ],
      parameters: memorySchema,
      executionMode: 'sequential',
      async execute(_callId, params) {
        const release = params.release ?? [];
        for (const item of release) {
          if (Boolean(item.key) === Boolean(item.resource)) {
            throw new TypeError('Each memory release must contain exactly one of key or resource.');
          }
        }
        const result = await durability.updateContext({
          ...(params.remember ? { set: params.remember } : {}),
          ...(params.hold ? {
            pin: params.hold.map(({ resource, ...item }) => ({ ...item, ref: resource })),
          } : {}),
          ...(release.some(({ key }) => key) ? {
            remove: release.flatMap(({ key, scope }) => key ? [{ key, scope }] : []),
          } : {}),
          ...(release.some(({ resource }) => resource) ? {
            unpin: release.flatMap(({ resource, scope }) => resource ? [{ ref: resource, scope }] : []),
          } : {}),
        });
        return jsonResult(result);
      },
    }) : defineTool({
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
      label: options.boundedWorkUnits ? 'Checkpoint work unit' : 'Bounded work unit',
      description: options.boundedWorkUnits ? [
        'Enter or return one sequential child work unit inside the current user turn.',
        'Enter with one coherent objective and optional journal refs, readable workspace files, or file:start-end citations.',
        'Return at a semantic boundary with bounded findings and exact evidence; commit may remember, forget, hold, or release parent-thread state for later units and turns.',
        'Project promotion remains a deliberate parent action.',
      ].join(' ') : [
        'Enter or return one optional sequential child work unit in the current turn.',
        'Use it only for coherent work whose raw scratch should not remain in parent context.',
        'Return bounded findings with exact evidence references; project promotion remains a parent decision.',
      ].join(' '),
      promptSnippet: 'Enter or return a bounded sequential child context',
      promptGuidelines: options.boundedWorkUnits ? [
        'The parent coordinates; use children for nontrivial tool-heavy work but not ordinary conversation.',
        'No nested or concurrent work units are available.',
        'A child should return after one coherent objective or when a checkpoint notice appears.',
        'Commit only compact state needed after the child hot tail disappears; never paste raw logs, files, or the child trace.',
        'Cite readable files or file:start-end ranges directly; the host snapshots them into journal evidence.',
        'validationRefs contain journal refs to actual tool results, never command labels. Summarize validation outcomes in findings.',
      ] : [
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
