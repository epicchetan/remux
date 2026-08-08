import {
  createAssistantMessageEventStream,
  fauxProvider,
  lazyStream,
  type AssistantMessage,
  type Context,
  type Model,
  type Provider,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from '@earendil-works/pi-ai';

export const SCRIPTED_CODEX_MODEL_ID = 'gpt-remux-scripted-codex';

export type ScriptedCodexStep =
  | {
      kind: 'answer';
      text: string;
      reasoning?: string;
      responseId: string;
    }
  | {
      kind: 'tool-call';
      callId: string;
      name: string;
      args: Record<string, unknown>;
      responseId: string;
    };

export type ScriptedCodexRequest = {
  ordinal: number;
  payload: unknown;
  context: {
    systemPrompt?: string;
    messages: Context['messages'];
    tools?: Array<{ name: string; description: string }>;
  };
};

export type ScriptedCodexStreamBoundary = {
  type: 'after-text-delta';
  ordinal: number;
};

export function createScriptedCodexProvider(options: {
  steps: ScriptedCodexStep[];
  beforeDispatch?: (request: ScriptedCodexRequest) => void | Promise<void>;
  onDispatch?: (request: ScriptedCodexRequest) => void | Promise<void>;
  onStreamBoundary?: (boundary: ScriptedCodexStreamBoundary) => void | Promise<void>;
}) {
  const faux = fauxProvider({
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    models: [{
      id: SCRIPTED_CODEX_MODEL_ID,
      name: 'Scripted Codex',
      reasoning: true,
      contextWindow: 400_000,
      maxTokens: 128_000,
    }],
  });
  const pending = [...options.steps];
  const requests: ScriptedCodexRequest[] = [];
  const provider: Provider = {
    id: faux.provider.id,
    name: faux.provider.name,
    baseUrl: faux.provider.baseUrl,
    headers: faux.provider.headers,
    auth: faux.provider.auth,
    getModels: () => faux.provider.getModels(),
    stream: (model, context, streamOptions) => faux.provider.stream(model, context, streamOptions),
    streamSimple(model, context, streamOptions) {
      return lazyStream(model, async () => {
        const step = pending.shift();
        if (!step) throw new Error('The scripted Codex provider has no response remaining.');
        const previousResponseId = [...context.messages].reverse().find(
          (message): message is AssistantMessage =>
            message.role === 'assistant' && typeof message.responseId === 'string',
        )?.responseId;
        const payload = {
          input_roles: context.messages.map((message) => message.role),
          message_count: context.messages.length,
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        };
        const ordinal = requests.length;
        await options.beforeDispatch?.(snapshotRequest(ordinal, payload, context));
        const transformedPayload = await streamOptions?.onPayload?.(payload, model) ?? payload;
        const request = snapshotRequest(ordinal, transformedPayload, context);
        requests.push(request);
        await options.onDispatch?.(request);
        return scriptedResponse(model, step, ordinal, options.onStreamBoundary);
      });
    },
  };

  return {
    provider,
    requests,
    remainingResponses: () => pending.length,
  };
}

function snapshotRequest(
  ordinal: number,
  payload: unknown,
  context: Context,
): ScriptedCodexRequest {
  return {
    ordinal,
    payload: structuredClone(payload),
    context: {
      ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
      messages: structuredClone(context.messages),
      ...(context.tools
        ? {
            tools: context.tools.map(({ name, description }) => ({ name, description })),
          }
        : {}),
    },
  };
}

function scriptedResponse(
  model: Model<string>,
  step: ScriptedCodexStep,
  ordinal: number,
  onStreamBoundary?: (boundary: ScriptedCodexStreamBoundary) => void | Promise<void>,
) {
  const stream = createAssistantMessageEventStream();
  const finalMessage = assistantMessage(model, step);
  const partial: AssistantMessage = {
    ...finalMessage,
    content: [],
    stopReason: 'pending',
  };
  void emitScriptedResponse(stream, partial, finalMessage, step, ordinal, onStreamBoundary)
    .catch((error) => {
      stream.push({
        type: 'error',
        reason: 'error',
        error: {
          ...finalMessage,
          stopReason: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    });
  return stream;
}

async function emitScriptedResponse(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  partial: AssistantMessage,
  finalMessage: AssistantMessage,
  step: ScriptedCodexStep,
  ordinal: number,
  onStreamBoundary?: (boundary: ScriptedCodexStreamBoundary) => void | Promise<void>,
) {
  stream.push({ type: 'start', partial });

  if (step.kind === 'answer') {
    if (step.reasoning) {
      const reasoning: ThinkingContent = { type: 'thinking', thinking: '' };
      partial.content.push(reasoning);
      stream.push({
        type: 'thinking_start',
        contentIndex: partial.content.length - 1,
        partial,
      });
      // Intentionally publish no thinking_delta. The real Codex websocket can
      // reveal the complete summary only when the reasoning item is finalized.
      reasoning.thinking = step.reasoning;
      stream.push({
        type: 'thinking_end',
        contentIndex: partial.content.length - 1,
        content: step.reasoning,
        partial,
      });
    }
    const text: TextContent = { type: 'text', text: '' };
    partial.content.push(text);
    const contentIndex = partial.content.length - 1;
    stream.push({ type: 'text_start', contentIndex, partial });
    text.text = step.text;
    stream.push({ type: 'text_delta', contentIndex, delta: step.text, partial });
    await onStreamBoundary?.({ type: 'after-text-delta', ordinal });
    stream.push({ type: 'text_end', contentIndex, content: step.text, partial });
  } else {
    const toolCall: ToolCall = {
      type: 'toolCall',
      id: step.callId,
      name: step.name,
      arguments: step.args,
    };
    partial.content.push(toolCall);
    const contentIndex = partial.content.length - 1;
    stream.push({ type: 'toolcall_start', contentIndex, partial });
    stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial });
  }

  stream.push({
    type: 'done',
    reason: finalMessage.stopReason === 'toolUse' ? 'toolUse' : 'stop',
    message: finalMessage,
  });
}

function assistantMessage(model: Model<string>, step: ScriptedCodexStep): AssistantMessage {
  const content: AssistantMessage['content'] = step.kind === 'answer'
    ? [
        ...(step.reasoning ? [{ type: 'thinking' as const, thinking: step.reasoning }] : []),
        { type: 'text', text: step.text },
      ]
    : [{
        type: 'toolCall',
        id: step.callId,
        name: step.name,
        arguments: step.args,
      }];
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 41,
      output: 13,
      cacheRead: 7,
      cacheWrite: 0,
      totalTokens: 61,
      cost: {
        input: 0.00005125,
        output: 0.00013,
        cacheRead: 0.00000175,
        cacheWrite: 0,
        total: 0.000183,
      },
    },
    stopReason: step.kind === 'tool-call' ? 'toolUse' : 'stop',
    responseId: step.responseId,
    timestamp: Date.now(),
  };
}
