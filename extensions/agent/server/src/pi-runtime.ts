import { createHash } from 'node:crypto';

import {
  type AuthEvent,
  getSupportedThinkingLevels,
  type Model,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
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
import { createWorkspaceReadTool } from './workspace-read.ts';

const PROVIDER = 'openai-codex';
const SYSTEM_PROMPT = `You are the Remux workspace agent. Work only inside the current workspace.
Use workspace_read when file contents are needed. It is the only tool available in this Phase 0 runtime.
Be direct, preserve user work, and say when the available tool surface prevents completing a request.`;

export class PiEngine implements AgentEngine {
  private readonly modelRuntime: ModelRuntime;

  private constructor(modelRuntime: ModelRuntime) {
    this.modelRuntime = modelRuntime;
  }

  static async create() {
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
    });
    return new PiEngine(modelRuntime);
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

  async createConversation(options: {
    cwd: string;
    modelId: string;
    reasoning: ReasoningLevel;
    onEvent: RuntimeEventSink;
  }): Promise<ConversationRuntime> {
    const model = this.modelRuntime.getModel(PROVIDER, options.modelId);
    if (!model) throw new Error(`Unknown OpenAI Codex model: ${options.modelId}`);

    let probe: ContextProbe = {
      hookVersion: 'phase0-v1',
      modelCallCount: 0,
      messageCount: 0,
      messageHash: null,
      orderedMessageHashes: [],
      estimatedBytes: 0,
      provider: PROVIDER,
      modelId: options.modelId,
      providerRequestMode: 'none',
    };
    const probeExtension: ExtensionFactory = (pi) => {
      pi.on('context', (event) => {
        const renderedMessages = event.messages.map((message) => JSON.stringify(message));
        probe = {
          ...probe,
          modelCallCount: probe.modelCallCount + 1,
          messageCount: event.messages.length,
          messageHash: createHash('sha256').update(renderedMessages.join('\n')).digest('hex'),
          orderedMessageHashes: renderedMessages.map((message) => createHash('sha256').update(message).digest('hex')),
          estimatedBytes: renderedMessages.reduce((total, message) => total + Buffer.byteLength(message), 0),
        };
        options.onEvent({ type: 'context-probe', probe });
        return { messages: event.messages };
      });
      pi.on('before_provider_request', (event) => {
        probe = {
          ...probe,
          providerRequestMode: hasPreviousResponseId(event.payload) ? 'continuation' : 'full',
        };
        options.onEvent({ type: 'context-probe', probe });
        return event.payload;
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
    const { session } = await createAgentSession({
      cwd: options.cwd,
      modelRuntime: this.modelRuntime,
      model,
      thinkingLevel: options.reasoning,
      noTools: 'builtin',
      customTools: [createWorkspaceReadTool(options.cwd)],
      resourceLoader,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager,
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
        await session.abort();
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
    case 'tool_execution_start':
      sink({
        type: 'tool-start',
        callId: event.toolCallId,
        name: projectedToolName(event.toolName),
        args: event.args,
      });
      return;
    case 'tool_execution_update':
      sink({
        type: 'tool-update',
        callId: event.toolCallId,
        name: projectedToolName(event.toolName),
        result: event.partialResult,
      });
      return;
    case 'tool_execution_end':
      sink({
        type: 'tool-end',
        callId: event.toolCallId,
        name: projectedToolName(event.toolName),
        result: event.result,
        isError: event.isError,
      });
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

function projectedToolName(name: string) {
  return name === 'workspace_read' ? 'workspace.read' : name;
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
