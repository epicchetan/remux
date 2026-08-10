import {
  type AssistantMessage,
  type ImageContent,
  type AuthEvent,
  getSupportedThinkingLevels,
  type Message,
  type Model,
} from '@earendil-works/pi-ai';
import {
  closeOpenAICodexWebSocketSessions,
  getOpenAICodexWebSocketDebugStats,
  resetOpenAICodexWebSocketDebugStats,
} from '@earendil-works/pi-ai/api/openai-codex-responses';
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
  assertContextBudget,
  estimatePiContextTokens,
  hashRenderedMessages,
  parseProviderToolResultText,
  renderDurablePiPrefix,
  type LogicalContextMessage,
} from './logical-context.ts';
import type { ThreadContextFrameCandidate } from './context/manifest.ts';
import { createContextTools } from './context/tools.ts';
import { canonicalJsonHash } from './storage/canonical-json.ts';
import { createRemuxAgentSession } from './pi-session.ts';
import {
  createWorkspaceReadTool,
  readWorkspaceFile,
  type WorkspaceReadExecutor,
} from './workspace-read.ts';

const PROVIDER = 'openai-codex';
const SYSTEM_PROMPT = `You are the Remux coding agent. The conversation cwd is your default location and orientation, not a filesystem boundary; use absolute paths when work legitimately spans elsewhere on this machine.

Your active context contains a branch-scoped thread.md collaboration brief, a bounded tail of completed-turn capsules, recent exact user/assistant dialogue, and exact scratch for the current turn. The immutable journal is the source of truth for omitted messages, commands, tool results, and evidence. journal_search and journal_open retrieve cold history temporarily; retrieval alone does not make it future thread state.

thread.md is living shared state, not a transcript or reasoning log. Use thread_read and thread_update when a meaningful transition changes the current objective, accepted decisions, constraints, implementation state, important resources, open questions, or near-term direction. Keep it coherent by revising and deleting stale text. Do not copy raw files, command output, tool traffic, reasoning traces, or facts needed only for the current answer. A terse user acceptance may update the relevant decision, but model-authored thread state never overrides the current user, an accepted contract, or observed repository state.

Use read, bash, edit, and write for normal coding work. Re-open exact journal evidence when an omitted fact matters instead of guessing, and re-read mutable files before editing or final validation. Preserve user work, validate changes in proportion to risk, and report honestly. Reasoning and tool scratch are local to the current turn and do not need to be summarized for their own sake.`;

const WORK_UNIT_PROMPT = `Use work_unit_enter only when a substantial coherent subproblem benefits from bounded scratch; ordinary short tool sequences stay in the parent turn. A work unit inherits the parent context but its reasoning and tools remain local. Work units cannot be nested. While inside one, do not answer the user or update thread.md directly: finish with work_unit_return containing a concise Markdown result for the parent, which will resume and integrate it.`;

function runtimeContract() {
  const systemPrompt = `${SYSTEM_PROMPT}\n\n${WORK_UNIT_PROMPT}`;
  const tools = [
    'read@pi-0.84',
    'bash@pi-0.84',
    'edit@pi-0.84',
    'write@pi-0.84',
    'journal@3',
    'thread@1',
    'work-unit@1',
  ];
  return {
    systemPrompt,
    fixedContractsHash: canonicalJsonHash({ piVersion: '0.84.0', systemPrompt, tools }),
  };
}

export class PiEngine implements AgentEngine {
  private readonly modelRuntime: ModelRuntime;
  private readonly workspaceRead: WorkspaceReadExecutor;

  private constructor(
    modelRuntime: ModelRuntime,
    workspaceRead: WorkspaceReadExecutor,
  ) {
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
    return new PiEngine(
      modelRuntime,
      options.workspaceRead ?? readWorkspaceFile,
    );
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
    const { systemPrompt, fixedContractsHash } = runtimeContract();

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
    let pendingTransport: {
      plannedRequestMode: 'full' | 'continuation';
      fullContextRequests: number;
      deltaRequests: number;
    } | null = null;
    let lastRenderedHashes: readonly string[] | null = null;
    let pendingContext: {
      basisSequence: number;
      logicalHash: string;
      renderedHash: string;
      orderedMessageHashes: string[];
      messageCount: number;
      estimatedInputTokens: number;
      fixedContractsHash: string;
      frame: ThreadContextFrameCandidate;
      frameBuildDurationMs: number;
      activeMessages: readonly LogicalContextMessage[];
    } | null = null;
    let pendingContextError: unknown = null;
    let providerDurabilityTail: Promise<void> = Promise.resolve();
    let providerDurabilityError: unknown = null;
    const awaitProviderDurability = async () => {
      await providerDurabilityTail;
      if (providerDurabilityError) throw providerDurabilityError;
    };
    const probeExtension: ExtensionFactory = (pi) => {
      pi.on('context', async () => {
        // Extension failures are intentionally swallowed by Pi. Clearing the
        // one-use fence first ensures provider preflight still fails closed.
        pendingContext = null;
        pendingContextError = null;
        try {
          // Pi does not wait for asynchronous message_end extension handlers
          // before it begins the following tool/model cycle. The exact
          // provider item and terminal inference boundary must reach the
          // journal before compiling the next frame, both to prevent two
          // running inferences in one scope and to compile from the real head.
          await awaitProviderDurability();
          const compileStartedAt = performance.now();
          const snapshot = await options.durability.compileContext();
          const messages: Message[] = [
            contextFrameMessage(
              snapshot.frame,
              snapshot.scopeKind,
              snapshot.messages.at(-1)?.timestamp ?? Date.now(),
            ),
            ...renderDurablePiPrefix(snapshot.messages, model),
          ];
          const frameBuildDurationMs = Math.max(0, Math.round(performance.now() - compileStartedAt));
          const rendered = hashRenderedMessages(messages);
          const estimatedInputTokens = estimatePiContextTokens(messages, systemPrompt);
          pendingContext = {
            basisSequence: snapshot.basisSequence,
            logicalHash: snapshot.logicalHash,
            renderedHash: rendered.hash,
            orderedMessageHashes: rendered.orderedHashes,
            messageCount: messages.length,
            estimatedInputTokens,
            fixedContractsHash,
            frame: snapshot.frame,
            frameBuildDurationMs,
            activeMessages: snapshot.messages,
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
        const message = event.message;
        const durability = (async () => {
          if (pendingTransport) {
            const actualRequestMode = observedTransportMode(sessionId, pendingTransport);
            await options.durability.afterProviderCall?.({
              plannedRequestMode: pendingTransport.plannedRequestMode,
              actualRequestMode,
            });
            pendingTransport = null;
          }
          const content = durableAssistantContent(message.content);
          const calls = message.content.flatMap((block) => block.type === 'toolCall'
            ? [{
                callId: block.id,
                name: durableToolName(block.name),
                args: block.arguments,
              }]
            : []);
          await options.durability.beforeAssistantMessageEnd({
            inferenceState: assistantInferenceState(message.stopReason),
            text: content.text,
            reasoning: content.reasoning,
            calls,
            providerMessage: message,
          });
        })();
        const settled = durability.catch((error) => {
          providerDurabilityError ??= error;
        });
        providerDurabilityTail = Promise.all([providerDurabilityTail, settled]).then(() => undefined);
        await durability;
      });
      // tool_call/tool_result are Pi's awaited execution gates. The similarly
      // named tool_execution_* events are observational notifications and Pi
      // does not wait for asynchronous extension handlers there.
      pi.on('tool_call', async (event) => {
        await awaitProviderDurability();
        await options.durability.beforeTool({
          callId: event.toolCallId,
          name: durableToolName(event.toolName),
          args: event.input,
        });
      });
      pi.on('tool_result', async (event) => {
        await options.durability.afterTool({
          callId: event.toolCallId,
          name: durableToolName(event.toolName),
          result: durableToolResult({ content: event.content }, event.isError),
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
      systemPrompt,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(options.cwd);
    const sessionId = sessionManager.getSessionId();
    resetOpenAICodexWebSocketDebugStats(sessionId);
    const { session } = await createRemuxAgentSession({
      cwd: options.cwd,
      modelRuntime: this.modelRuntime,
      model,
      thinkingLevel: options.reasoning,
      customTools: [
        // The awaited tool_call/tool_result gates above own durability for all
        // tools. Avoid a second direct durability wrapper on workspace_read.
        createWorkspaceReadTool(options.cwd, undefined, this.workspaceRead),
        ...createContextTools(options.durability),
      ],
      resourceLoader,
      sessionManager,
      settingsManager,
      providerPreflight: async (payload) => {
        // Keep the provider fence defensive even if Pi changes its context
        // hook ordering: no request may overtake the preceding provider
        // item's durable terminal boundary.
        await awaitProviderDurability();
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
        const requestMode = providerCallCount > 0 && lastRenderedHashes !== null &&
            lastRenderedHashes.length <= context.orderedMessageHashes.length &&
            lastRenderedHashes.every((hash, index) => context.orderedMessageHashes[index] === hash)
          ? 'continuation'
          : 'full';
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
            orderedMessageHashes: context.orderedMessageHashes,
            messageCount: context.messageCount,
            fixedContractsHash: context.fixedContractsHash,
            frame: context.frame,
            frameBuildDurationMs: context.frameBuildDurationMs,
            activeMessages: context.activeMessages,
          },
        });
        // The rejected inference is now itself durable. Throwing here still
        // precedes provider I/O; Pi emits its normal failed inference boundary.
        assertContextBudget(estimatedInputTokens, model.contextWindow);
        const transportStats = getOpenAICodexWebSocketDebugStats(sessionId);
        pendingTransport = {
          plannedRequestMode: requestMode,
          fullContextRequests: transportStats?.fullContextRequests ?? 0,
          deltaRequests: transportStats?.deltaRequests ?? 0,
        };
        providerCallCount += 1;
        lastRenderedHashes = context.orderedMessageHashes;
        probe = {
          ...probe,
          providerRequestMode: requestMode,
        };
        options.onEvent({ type: 'context-probe', probe });
      },
    });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'agent_end') {
        void providerDurabilityTail.then(() => {
          if (!providerDurabilityError) projectPiEvent(event, options.onEvent);
        });
        return;
      }
      projectPiEvent(event, options.onEvent);
    });

    return {
      async prompt(input) {
        providerDurabilityError = null;
        await session.prompt(input.text, {
          expandPromptTemplates: false,
          images: input.images?.map((image): ImageContent => ({ type: 'image', ...image })),
        });
        await providerDurabilityTail;
        if (providerDurabilityError) throw providerDurabilityError;
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
          closeOpenAICodexWebSocketSessions(sessionId);
          resetOpenAICodexWebSocketDebugStats(sessionId);
        }
      },
    };
  }
}

function observedTransportMode(
  sessionId: string,
  pending: {
    plannedRequestMode: 'full' | 'continuation';
    fullContextRequests: number;
    deltaRequests: number;
  },
): 'full' | 'continuation' {
  const stats = getOpenAICodexWebSocketDebugStats(sessionId);
  if (!stats) return pending.plannedRequestMode;
  if (stats.deltaRequests > pending.deltaRequests) return 'continuation';
  if (stats.fullContextRequests > pending.fullContextRequests) return 'full';
  return pending.plannedRequestMode;
}

function contextFrameMessage(
  candidate: ThreadContextFrameCandidate,
  scopeKind: 'turn' | 'work_unit',
  _timestamp: number,
): Message {
  const scopeBoundary = scopeKind === 'work_unit'
    ? 'Active execution scope: bounded work unit. Keep scratch local and finish with work_unit_return.'
    : 'Active execution scope: parent turn. work_unit_return is invalid unless work_unit_enter has opened a child scope.';
  return {
    role: 'user',
    content: [
      'The following is the active Remux thread context. The exact user message after it is the current request. Omitted evidence remains available through journal tools.',
      scopeBoundary,
      candidate.bootstrap,
    ].join('\n\n'),
    // This synthetic control message is stable while its content is stable.
    // Event timestamps belong to the durable messages below; changing this
    // timestamp on every inference would invalidate the provider prefix cache.
    timestamp: 0,
  };
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
      // The awaited Pi extension hook owns the durable provider/inference
      // boundary. Emitting a second asynchronous boundary here races the exact
      // provider item and can terminalize an inference before it is recorded.
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
  const reasoning: string[] = [];
  for (const block of content) {
    if (block.type === 'text') text += block.text ?? '';
    else if (block.type === 'thinking') reasoning.push(block.thinking ?? '');
  }
  // OpenAI may finalize one streamed reasoning trace as several signed
  // thinking blocks. Pi renders those summaries as Markdown paragraphs, so
  // preserve the same paragraph boundary when reconciling the final message.
  return { text, reasoning: reasoning.join('\n\n') };
}

function assistantText(message: AssistantMessage) {
  return message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
}

function durableToolResult(value: unknown, isError: boolean): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as { content?: unknown };
  const text = toolResultText(result.content);
  if (isError) return { error: text };
  if (text === '') return null;
  return parseProviderToolResultText(text);
}

function toolResultText(content: unknown) {
  if (!Array.isArray(content)) return '';
  return content.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const block = entry as { type?: unknown; text?: unknown };
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('');
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
