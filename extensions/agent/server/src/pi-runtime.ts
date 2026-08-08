import {
  type AuthEvent,
  getSupportedThinkingLevels,
  type Model,
} from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';

import type {
  AuthValue,
  ContextProbe,
  ModelInfo,
  ReasoningLevel,
} from '../../shared/protocol.ts';
import type {
  AgentEngine,
  ConversationRuntime,
  RuntimeEventSink,
} from './engine.ts';
import {
  alignDurableContextWithPi,
  assertContextBudget,
  estimatePiContextTokens,
  hashRenderedMessages,
} from './logical-context.ts';
import { createRemuxAgentSession } from './pi-session.ts';
import {
  createWorkspaceReadTool,
  readWorkspaceFile,
  type WorkspaceReadExecutor,
} from './workspace-read.ts';

const PROVIDER = 'openai-codex';
const SYSTEM_PROMPT = `You are the Remux workspace agent. Work only inside the current workspace.
Use workspace_read when file contents are needed. It is the only tool available in this Phase 0 runtime.
Be direct, preserve user work, and say when the available tool surface prevents completing a request.`;

export class PiEngine implements AgentEngine {
  private readonly modelRuntime: ModelRuntime;
  private readonly workspaceRead: WorkspaceReadExecutor;

  private constructor(modelRuntime: ModelRuntime, workspaceRead: WorkspaceReadExecutor) {
    this.modelRuntime = modelRuntime;
    this.workspaceRead = workspaceRead;
  }

  static async create(options: {
    modelRuntime?: ModelRuntime;
    workspaceRead?: WorkspaceReadExecutor;
  } = {}) {
    const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
      allowModelNetwork: false,
    });
    return new PiEngine(modelRuntime, options.workspaceRead ?? readWorkspaceFile);
  }

  async authStatus(): Promise<AuthValue> {
    const auth = await this.modelRuntime.checkAuth(PROVIDER);
    if (!auth) return signedOutAuth();
    return {
      ...signedOutAuth(),
      state: 'signed-in',
      displayLabel: auth.source ?? (auth.type === 'oauth' ? 'OpenAI subscription' : 'OpenAI credentials'),
    };
  }

  async login(operationId: string, signal: AbortSignal, onUpdate: (value: AuthValue) => void) {
    const pending = (): AuthValue => ({
      ...signedOutAuth(),
      state: 'signing-in',
      operationId,
    });
    onUpdate(pending());
    await this.modelRuntime.login(PROVIDER, 'oauth', {
      signal,
      async prompt(prompt) {
        if (prompt.type === 'select' && prompt.options.some((option) => option.id === 'device_code')) {
          return 'device_code';
        }
        throw new Error('This preview supports the OpenAI device-code sign-in flow only.');
      },
      notify(event) {
        onUpdate(authEventValue(pending(), event));
      },
    });
  }

  async logout() {
    await this.modelRuntime.logout(PROVIDER);
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = await this.modelRuntime.getAvailable(PROVIDER);
    return models.map(toModelInfo).sort((left, right) => left.name.localeCompare(right.name));
  }

  async createConversation(
    options: Parameters<AgentEngine['createConversation']>[0],
  ): Promise<ConversationRuntime> {
    const model = this.modelRuntime.getModel(PROVIDER, options.modelId);
    if (!model) throw new Error(`Unknown OpenAI Codex model: ${options.modelId}`);

    let probe: ContextProbe = {
      hookVersion: 'agent-durable-v1',
      modelCallCount: 0,
      messageCount: 0,
      messageHash: null,
      orderedMessageHashes: [],
      estimatedBytes: 0,
      provider: PROVIDER,
      modelId: options.modelId,
      providerRequestMode: 'none',
    };
    let providerCallCount = 0;
    let pendingContext: {
      basisSequence: number;
      logicalHash: string;
      renderedHash: string;
      messageCount: number;
      estimatedInputTokens: number;
    } | null = null;
    let pendingContextError: unknown = null;
    const probeExtension: ExtensionFactory = (pi) => {
      pi.on('context', async (event) => {
        // Extension failures are intentionally swallowed by Pi. Clearing the
        // one-use fence first ensures provider preflight still fails closed.
        pendingContext = null;
        pendingContextError = null;
        try {
          const snapshot = await options.durability.compileContext();
          const messages = alignDurableContextWithPi(snapshot, event.messages, model);
          const rendered = hashRenderedMessages(messages);
          const estimatedInputTokens = estimatePiContextTokens(messages, SYSTEM_PROMPT);
          pendingContext = {
            basisSequence: snapshot.basisSequence,
            logicalHash: snapshot.logicalHash,
            renderedHash: rendered.hash,
            messageCount: messages.length,
            estimatedInputTokens,
          };
          probe = {
            ...probe,
            modelCallCount: probe.modelCallCount + 1,
            messageCount: messages.length,
            messageHash: rendered.hash,
            orderedMessageHashes: rendered.orderedHashes,
            estimatedBytes: rendered.estimatedBytes,
          };
          options.onEvent({ type: 'context-probe', probe });
          return { messages };
        } catch (error) {
          pendingContextError = error;
          throw error;
        }
      });
      pi.on('message_end', async (event) => {
        if (event.message.role !== 'assistant') return;
        const content = durableAssistantContent(event.message.content);
        const calls = event.message.content.flatMap((block) => block.type === 'toolCall'
          ? [{
              callId: block.id,
              name: durableToolName(block.name),
              args: block.arguments,
            }]
          : []);
        await options.durability.beforeAssistantMessageEnd({
          inferenceState: assistantInferenceState(event.message.stopReason),
          text: content.text,
          reasoning: content.reasoning,
          calls,
        });
      });
      pi.on('tool_execution_end', async (event) => {
        await options.durability.afterTool({
          callId: event.toolCallId,
          name: durableToolName(event.toolName),
          result: durableToolResult(event.result, event.isError),
          isError: event.isError,
        });
      });
    };

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: {
        enabled: false,
        maxRetries: 0,
        provider: { maxRetries: 0, maxRetryDelayMs: 0 },
      },
      transport: 'websocket-cached',
      enableAnalytics: false,
      enableInstallTelemetry: false,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: getAgentDir(),
      settingsManager,
      extensionFactories: [{ name: 'remux-context-probe', factory: probeExtension, hidden: true }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: SYSTEM_PROMPT,
    });
    await resourceLoader.reload();
    const { session } = await createRemuxAgentSession({
      cwd: options.cwd,
      modelRuntime: this.modelRuntime,
      model,
      thinkingLevel: options.reasoning,
      noTools: 'builtin',
      customTools: [createWorkspaceReadTool(
        options.cwd,
        options.durability,
        this.workspaceRead,
      )],
      resourceLoader,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager,
      providerPreflight: async (payload) => {
        const context = pendingContext;
        pendingContext = null;
        if (!context) {
          if (pendingContextError) {
            throw new Error(
              `Durable context compilation failed: ${safeMessage(pendingContextError)}`,
              { cause: pendingContextError },
            );
          }
          throw new Error('Provider dispatch has no committed durable context fence.');
        }
        const requestMode = hasPreviousResponseId(payload) ? 'continuation' : 'full';
        if (providerCallCount === 0 && requestMode !== 'full') {
          throw new Error('A fresh Pi runtime must begin with a full provider request.');
        }
        const estimatedInputTokens = Math.max(
          context.estimatedInputTokens,
          Math.ceil(Buffer.byteLength(JSON.stringify(payload), 'utf8') / 4),
        );
        await options.durability.beforeProviderCall({
          payload,
          requestMode,
          estimatedInputTokens,
          context: {
            basisSequence: context.basisSequence,
            logicalHash: context.logicalHash,
            renderedHash: context.renderedHash,
            messageCount: context.messageCount,
          },
        });
        // The rejected inference is now itself durable. Throwing here still
        // precedes provider I/O; Pi emits its normal failed inference boundary.
        assertContextBudget(estimatedInputTokens, model.contextWindow);
        providerCallCount += 1;
        probe = {
          ...probe,
          providerRequestMode: requestMode,
        };
        options.onEvent({ type: 'context-probe', probe });
      },
    });
    const unsubscribe = session.subscribe((event) => projectPiEvent(event, options.onEvent));

    return {
      async prompt(text) {
        await session.prompt(text, { expandPromptTemplates: false });
      },
      async interrupt() {
        await session.abort();
      },
      async dispose() {
        unsubscribe();
        try {
          await session.abort();
        } finally {
          session.dispose();
        }
      },
    };
  }
}

function projectPiEvent(event: AgentSessionEvent, sink: RuntimeEventSink) {
  switch (event.type) {
    case 'message_start':
      if (event.message.role === 'assistant') sink({ type: 'assistant-start' });
      return;
    case 'message_update':
      if (event.assistantMessageEvent.type === 'text_delta') {
        sink({ type: 'assistant-text', delta: event.assistantMessageEvent.delta });
      } else if (event.assistantMessageEvent.type === 'thinking_delta') {
        sink({ type: 'assistant-reasoning', delta: event.assistantMessageEvent.delta });
      }
      return;
    case 'message_end':
      if (event.message.role === 'assistant') {
        sink({
          type: 'inference-end',
          state: event.message.stopReason === 'error'
            ? 'failed'
            : event.message.stopReason === 'aborted'
              ? 'interrupted'
              : 'completed',
        });
      }
      return;
    case 'agent_end': {
      const finalAssistant = [...event.messages].reverse().find((message) => message.role === 'assistant');
      const error = finalAssistant?.role === 'assistant' && finalAssistant.stopReason === 'error'
        ? finalAssistant.errorMessage
        : undefined;
      const interrupted = finalAssistant?.role === 'assistant' && finalAssistant.stopReason === 'aborted';
      sink({ type: 'assistant-complete', interrupted, ...(error ? { error: safeMessage(error) } : {}) });
      return;
    }
    default:
      return;
  }
}

function assistantInferenceState(stopReason: string): 'completed' | 'failed' | 'interrupted' {
  return stopReason === 'error' ? 'failed' : stopReason === 'aborted' ? 'interrupted' : 'completed';
}

function durableToolName(name: string) {
  return name === 'workspace_read' ? 'workspace.read' : name;
}

function durableAssistantContent(
  content: Array<{ type: string; text?: string; thinking?: string }>,
) {
  let text = '';
  let reasoning = '';
  for (const block of content) {
    if (block.type === 'text') text += block.text ?? '';
    else if (block.type === 'thinking') reasoning += block.thinking ?? '';
  }
  return { text, reasoning };
}

function durableToolResult(value: unknown, isError: boolean): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as { content?: unknown; details?: unknown };
  const text = toolResultText(result.content);
  if (isError) return { error: text };
  if (result.details !== undefined) return result.details;
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toolResultText(content: unknown) {
  if (!Array.isArray(content)) return '';
  return content.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const block = entry as { type?: unknown; text?: unknown };
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n');
}

function toModelInfo(model: Model<string>): ModelInfo {
  return {
    id: model.id,
    name: model.name,
    provider: PROVIDER,
    contextWindow: model.contextWindow,
    supportedReasoning: getSupportedThinkingLevels(model) as ReasoningLevel[],
  };
}

function signedOutAuth(): AuthValue {
  return {
    state: 'signed-out',
    operationId: null,
    displayLabel: null,
    verificationUri: null,
    userCode: null,
    expiresAt: null,
    progress: null,
    error: null,
  };
}

function authEventValue(current: AuthValue, event: AuthEvent): AuthValue {
  switch (event.type) {
    case 'device_code':
      return {
        ...current,
        verificationUri: event.verificationUri,
        userCode: event.userCode,
        expiresAt: event.expiresInSeconds
          ? new Date(Date.now() + event.expiresInSeconds * 1_000).toISOString()
          : null,
        progress: 'Open the verification page and enter the code.',
      };
    case 'auth_url':
      return { ...current, verificationUri: event.url, progress: event.instructions ?? 'Continue in your browser.' };
    case 'progress':
      return { ...current, progress: event.message };
    case 'info':
      return { ...current, progress: event.message };
  }
}

function hasPreviousResponseId(payload: unknown) {
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    'previous_response_id' in payload &&
    typeof payload.previous_response_id === 'string' &&
    payload.previous_response_id.length > 0,
  );
}

function safeMessage(value: unknown) {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/gu, '[redacted]')
    .slice(0, 1_000);
}
