import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { ModelSessionDurabilityHooks } from '../model-provider.ts';
import type { WorkUnitCompletion, WorkUnitEnterInput } from '../domain/work.ts';

export const PARENT_CONTEXT_TOOL_NAMES = [
  'history_search',
  'history_read',
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

const workUnitEnterSchema = Type.Object({
  boundary: Type.String({
    minLength: 1,
    maxLength: 4 * 1024,
    description: 'A brief, user-readable statement of the independently verifiable slice being entered and the evidence that will establish it.',
  }),
});

const workUnitReturnSchema = Type.Object({
  status: Type.Union([
    Type.Literal('completed'),
    Type.Literal('partial'),
    Type.Literal('blocked'),
  ], {
    description: 'Whether the declared boundary completed, reached a useful partial point, or is blocked.',
  }),
  result: Type.String({
    minLength: 1,
    description: 'The useful outcome, evidence, uncertainty, and next edge the parent needs. Markdown is allowed but no fixed template is required.',
  }),
  artifacts: Type.Optional(Type.Array(Type.String({
    minLength: 1,
    maxLength: 4 * 1024,
    description: 'A history:// reference or an absolute or working-directory-relative UTF-8 text file to retain as an immutable boundary snapshot.',
  }), {
    maxItems: 16,
    description: 'Optional exact artifacts worth retaining for later inspection. Contents are stored in History and are not injected into the continuing turn.',
  })),
});

export function createContextTools(
  durability: Pick<
    ModelSessionDurabilityHooks,
    'historySearch' | 'historyOpen' | 'workUnitEnter' | 'workUnitFinish'
  >,
  runtime?: {
    runWorkUnit(callId: string, input: WorkUnitEnterInput): Promise<WorkUnitCompletion>;
  },
): ToolDefinition[] {
  return [
    defineTool({
      name: 'history_search',
      label: 'Search History',
      description: [
        'Search exact prior messages, outcomes, and operations that are not currently shown.',
        'Ordinary operations are excluded unless include="operations" is requested.',
        'The result is temporary; search does not change later turn context.',
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
      name: 'work_unit_start',
      label: 'Start work unit',
      description: [
        'Open a disposable continuation segment inside the current turn.',
        'The same assistant retains the current request, reasoning, plan, and tool state; this is not delegation to another agent.',
        'Detailed reasoning and tool activity inside the segment remain in History but leave active context after work_unit_finish.',
      ].join(' '),
      promptSnippet: 'Open one coherent disposable work segment',
      promptGuidelines: [
        'Use a work unit for one independently verifiable slice of inspection, implementation, or validation that may consume substantial context. The main turn retains the overall request; do not assign the whole turn by default.',
        'Write one brief boundary statement containing both the work being entered and its natural closing condition. Do not restate the full request or emit separate narration that duplicates it.',
        'Continue the existing turn naturally; do not reorient as another agent or repeat context you already have.',
        'Work units cannot be nested.',
        'Finish by calling work_unit_finish.',
      ],
      parameters: workUnitEnterSchema,
      executionMode: 'sequential',
      async execute(callId, params) {
        const result = runtime
          ? await runtime.runWorkUnit(callId, params)
          : await durability.workUnitEnter(callId, params);
        return jsonResult(result);
      },
    }),
    defineTool({
      name: 'work_unit_finish',
      label: 'Finish work unit',
      description: [
        'Close the active disposable work segment and continue the original turn from a compact result.',
        'The status and result are required; artifact references are optional.',
        'Artifact contents are retained exactly in History but are not injected into continuing context.',
      ].join(' '),
      promptSnippet: 'Close the work unit and preserve what the continuing turn needs',
      promptGuidelines: [
        'Put the outcome, important changed state or findings, supporting validation, remaining uncertainty, and next useful edge in result.',
        'For implementation work, finish the focused validation this unit can perform before closing; identify validation that was impossible.',
        'Use partial or blocked to return honestly at a useful boundary instead of broadening the unit.',
        'List an artifact only when preserving an immutable boundary-time snapshot is useful for later inspection. Mentioning a path in result is enough otherwise.',
        'Only list exact file paths or history:// references. Do not list every file touched.',
        'Do not paste reasoning traces or raw command output.',
      ],
      parameters: workUnitReturnSchema,
      executionMode: 'sequential',
      async execute(callId, params) {
        return jsonResult(await durability.workUnitFinish(callId, params), true);
      },
    }),
  ];
}

function durableHistoryRef(ref: string) {
  if (!ref.startsWith('history://')) {
    throw new TypeError('History references must start with history://.');
  }
  return ref;
}

function jsonResult(value: unknown, terminate = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    details: value,
    ...(terminate ? { terminate: true } : {}),
  };
}
