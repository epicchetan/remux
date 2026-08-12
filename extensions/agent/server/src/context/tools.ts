import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { RuntimeDurabilityHooks } from '../engine.ts';

export const PARENT_CONTEXT_TOOL_NAMES = [
  'history_search',
  'history_read',
  'thread_read',
  'thread_patch',
  'thread_replace',
  'work_unit_start',
] as const;

export const WORK_UNIT_CONTEXT_TOOL_NAMES = [
  'history_search',
  'history_read',
  'work_unit_finish',
] as const;

const searchSchema = Type.Object({
  query: Type.String({ minLength: 1, description: 'Words or phrase to find in exact prior History.' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  scope: Type.Optional(Type.Union([Type.Literal('conversation'), Type.Literal('project')])),
  include: Type.Optional(Type.Literal('operations')),
});

const openSchema = Type.Object({
  ref: Type.String({ minLength: 1, description: 'Stable history:// reference returned by history_search.' }),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 256, maximum: 32 * 1024 })),
});

const threadReadSchema = Type.Object({});

const threadPatchSchema = Type.Object({
  baseVersionId: Type.String({
    minLength: 1,
    description: 'The exact versionId from active context, thread_read, or the prior successful edit.',
  }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({
      minLength: 1,
      maxLength: 96 * 1024,
      description: 'Exact non-empty text that occurs once in the current Thread.',
    }),
    newText: Type.String({
      maxLength: 96 * 1024,
      description: 'Replacement text. Use an empty string to delete the exact oldText.',
    }),
  }), {
    minItems: 1,
    maxItems: 32,
    description: 'Atomic exact replacements applied in order.',
  }),
});

const threadReplaceSchema = Type.Object({
  baseVersionId: Type.String({
    minLength: 1,
    description: 'The exact versionId from active context, thread_read, or the prior successful edit.',
  }),
  content: Type.String({
    maxLength: 96 * 1024,
    description: 'Deliberate complete replacement Markdown for the active Thread.',
  }),
});

const workUnitEnterSchema = Type.Object({
  objective: Type.String({
    minLength: 1,
    maxLength: 4 * 1024,
    description: 'One focused, coherent objective for the bounded child execution scope.',
  }),
  doneWhen: Type.Optional(Type.Array(Type.String({
    minLength: 1,
    maxLength: 4 * 1024,
    description: 'One observable condition that tells the child it has enough to return.',
  }), {
    minItems: 1,
    maxItems: 16,
    description: 'Semantic completion criteria for this work unit.',
  })),
  resources: Type.Optional(Type.Array(workUnitResourceSchema(), {
    maxItems: 16,
    description: 'Durable authorities, deliverables, or evidence the work unit should consult.',
  })),
});

const workUnitReturnSchema = Type.Object({
  status: Type.Union([
    Type.Literal('completed'),
    Type.Literal('partial'),
    Type.Literal('blocked'),
  ], {
    description: 'Whether the objective completed, reached a useful partial boundary, or is blocked.',
  }),
  result: Type.String({
    minLength: 1,
    description: 'Decision-ready Markdown continuation that lets the parent proceed without reconstructing the work-unit trace.',
  }),
  threadUpdate: Type.Optional(Type.String({
    minLength: 1,
    description: 'Proposed Markdown for the parent to merge into the Thread. It is not applied automatically.',
  })),
  resources: Type.Optional(Type.Array(workUnitResourceSchema(), {
    maxItems: 16,
    description: 'Selected exact authorities, deliverables, or evidence that prevent meaningful reconstruction or enable the next action.',
  })),
});

function workUnitResourceSchema() {
  return Type.Object({
    ref: Type.String({
      minLength: 1,
      maxLength: 4 * 1024,
      description: 'A history:// reference or an absolute or working-directory-relative UTF-8 text file. Directories are not resources; name specific files instead.',
    }),
    role: Type.Union([
      Type.Literal('authority'),
      Type.Literal('deliverable'),
      Type.Literal('evidence'),
    ]),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 2 * 1024 })),
  });
}

export function createContextTools(
  durability: Pick<
    RuntimeDurabilityHooks,
    'historySearch' | 'historyOpen' | 'threadRead' | 'threadPatch' | 'threadReplace' |
    'workUnitEnter' | 'workUnitReturn'
  >,
): ToolDefinition[] {
  return [
    defineTool({
      name: 'history_search',
      label: 'Search History',
      description: [
        'Search exact prior messages, outcomes, and operations that are not currently shown.',
        'Ordinary operations are excluded unless include="operations" is requested.',
        'The result is temporary; search does not change the Thread or later context.',
      ].join(' '),
      promptSnippet: 'Search exact earlier conversation and execution History',
      parameters: searchSchema,
      executionMode: 'parallel',
      async execute(callId, params) {
        const result = await durability.historySearch(callId, params);
        return jsonResult(result);
      },
    }),
    defineTool({
      name: 'history_read',
      label: 'Read History',
      description: [
        'Read bounded exact History from a reference returned by history_search or another tool.',
        'The result is temporary and supports byte continuations for large results.',
      ].join(' '),
      promptSnippet: 'Read exact prior evidence from History',
      parameters: openSchema,
      executionMode: 'parallel',
      async execute(_callId, params) {
        const result = await durability.historyOpen({
          ...params,
          ref: durableHistoryRef(params.ref),
        });
        return jsonResult(result);
      },
    }),
    defineTool({
      name: 'thread_read',
      label: 'Read Thread',
      description: 'Read the complete living Thread and the version required by the editing tools.',
      promptSnippet: 'Read the living working document for this conversation',
      parameters: threadReadSchema,
      executionMode: 'parallel',
      async execute() {
        return jsonResult(modelThreadView(await durability.threadRead()));
      },
    }),
    defineTool({
      name: 'thread_patch',
      label: 'Patch Thread',
      description: [
        'Update the living Thread when shared goals, decisions, design, contract, implementation state, evidence, or open questions materially change.',
        'Revise existing content rather than appending a turn log.',
        'Apply one or more atomic exact-text replacements.',
        'Use the version from active context, thread_read, or the previous successful edit.',
        'If the version changed or an old text is missing or ambiguous, nothing is modified.',
      ].join(' '),
      promptSnippet: 'Patch the living Thread with exact replacements',
      promptGuidelines: [
        'Each oldText must occur exactly once at the point its edit is applied.',
        'On conflict, read the current Thread and retry deliberately.',
      ],
      parameters: threadPatchSchema,
      executionMode: 'sequential',
      async execute(_callId, params) {
        return jsonResult(modelThreadView(await durability.threadPatch(params)));
      },
    }),
    defineTool({
      name: 'thread_replace',
      label: 'Replace Thread',
      description: [
        'Replace the complete living Thread using its exact current version.',
        'Use only to initialize it, deliberately reorganize it, recover it, or fundamentally change the subject.',
        'Ordinary maintenance belongs in thread_patch.',
      ].join(' '),
      promptSnippet: 'Deliberately replace the complete living Thread',
      parameters: threadReplaceSchema,
      executionMode: 'sequential',
      async execute(_callId, params) {
        return jsonResult(modelThreadView(await durability.threadReplace(params)));
      },
    }),
    defineTool({
      name: 'work_unit_start',
      label: 'Start work unit',
      description: [
        'Start a temporary child scope for one substantial, independently assessable research, implementation, or validation outcome.',
        'It inherits the current request, Thread, and parent context at this point; its reasoning and tool trace stay local.',
        'Resources are snapshotted and materialized into the child context.',
        'The parent resumes from the work_unit_finish continuation rather than the child trace.',
      ].join(' '),
      promptSnippet: 'Start one coherent unit of substantial disposable work',
      promptGuidelines: [
        'Keep brainstorming, ordinary dialogue, small changes, short tool sequences, Thread maintenance, integration, and response drafting in the parent.',
        'Keep the turn plan in the parent. State one outcome, observable doneWhen conditions, and the next decision or action this return should unlock.',
        'Ask for only the exact resources this child should have directly in context.',
        'Use the largest coherent unit the parent can independently assess while leaving room for the child to validate and return cleanly.',
        'Work units cannot be nested.',
        'Finish by calling work_unit_finish.',
      ],
      parameters: workUnitEnterSchema,
      executionMode: 'sequential',
      async execute(callId, params) {
        const result = await durability.workUnitEnter(callId, {
          ...params,
          resources: params.resources?.map(durableWorkUnitResource),
        });
        return jsonResult({
          ...result,
          resources: result.resources.map(modelWorkUnitResource),
        });
      },
    }),
    defineTool({
      name: 'work_unit_finish',
      label: 'Finish work unit',
      description: [
        'Finish the active work unit with a continuation that enables the parent\'s next decision or action without reconstructing the child trace.',
        'The status and result are required; a proposed Thread update and resources are optional.',
        'Returned resources are snapshotted and materialized into the parent context.',
        'Detailed scratch remains in History and is not replayed into the parent.',
      ].join(' '),
      promptSnippet: 'Finish the work unit and return what its parent needs',
      promptGuidelines: [
        'Put the established outcome, changed state or findings, supporting validation, remaining uncertainty, and next useful parent edge in result.',
        'Use partial or blocked to return honestly at a useful boundary instead of broadening the unit.',
        'Use threadUpdate only for shared state the parent should deliberately merge; do not treat recommendations as accepted user decisions.',
        'Return a resource when its exact contents prevent meaningful reconstruction or enable inspection, integration, audit, or later work; prefer the smallest useful surface.',
        'Only return a resource when you have its exact file path or history:// reference. Summarize other evidence in the result instead of inventing a reference.',
        'Do not return every file touched or unchanged material already inherited.',
        'Do not paste reasoning traces or raw command output.',
      ],
      parameters: workUnitReturnSchema,
      executionMode: 'sequential',
      async execute(callId, params) {
        return jsonResult(await durability.workUnitReturn(callId, {
          ...params,
          resources: params.resources?.map(durableWorkUnitResource),
        }));
      },
    }),
  ];
}

function modelThreadView<T extends { ref: string }>(view: T): T {
  return view;
}

function durableHistoryRef(ref: string) {
  if (!ref.startsWith('history://')) {
    throw new TypeError('History references must start with history://.');
  }
  return ref;
}

function modelWorkUnitResource<T extends { ref: string; snapshot?: { ref: string } }>(resource: T): T {
  return {
    ...resource,
    ref: resource.ref,
    ...(resource.snapshot ? {
      snapshot: resource.snapshot,
    } : {}),
  };
}

function durableWorkUnitResource<T extends { ref: string; snapshot?: { ref: string } }>(resource: T): T {
  return {
    ...resource,
    ref: resource.ref.startsWith('history://') ? durableHistoryRef(resource.ref) : resource.ref,
    ...(resource.snapshot ? {
      snapshot: {
        ...resource.snapshot,
        ref: resource.snapshot.ref.startsWith('history://')
          ? durableHistoryRef(resource.snapshot.ref)
          : resource.snapshot.ref,
      },
    } : {}),
  };
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    details: value,
  };
}
