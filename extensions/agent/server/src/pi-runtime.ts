import {
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
  alignDurableContextWithPi,
  assertContextBudget,
  estimatePiContextTokens,
  hashRenderedMessages,
  parseProviderToolResultText,
  type LogicalContextMessage,
} from './logical-context.ts';
import { compileShadowContext } from './context/compiler.ts';
import type { ShadowContextCandidate } from './context/manifest.ts';
import { contextPolicyForModel, type ContextPolicyOverrides } from './context/policy.ts';
import { createContextTools } from './context/tools.ts';
import { canonicalJsonHash } from './storage/canonical-json.ts';
import { createRemuxAgentSession } from './pi-session.ts';
import {
  createWorkspaceReadTool,
  readWorkspaceFile,
  type WorkspaceReadExecutor,
} from './workspace-read.ts';

const PROVIDER = 'openai-codex';
const SYSTEM_PROMPT_HEAD = `You are the Remux coding agent. The conversation cwd is your default location and orientation, not a filesystem boundary; use absolute paths when work legitimately spans elsewhere on this machine.

Recent messages, files, commands, and tool results are already hot context. Do not copy them into durable state. The durable journal is exact cold history: journal_search and journal_open recover omitted evidence temporarily, and retrieval alone does not keep it in later context. context_update is a small durable working context for information that must survive a frame rollover, restart, or later turn.

Use one stable key per active concern, replace it at meaningful phase changes, and remove it when resolved. Pin an exact governing specification or contract while it matters instead of summarizing it. Default to thread scope; use project scope only when other threads should inherit the state. Model-authored state is a fallible working aid, never source authority, and cannot override the current user request, an accepted specification, or observed repository state. Do not store raw files, logs, transcript prose, or speculative deviations.

When a terse user reply accepts the preceding proposal, make that judgment yourself and record the acceptance in a small state entry with the exact preceding-assistant reference as evidence; choose a clear key for the actual work instead of a harness-reserved name. The harness does not classify intent for you. When a pressure notice arrives, checkpoint only missing durable decisions, progress, exact evidence refs, or the next semantic step. If existing durable state is sufficient, continue without updating it.`;

const WORK_UNIT_GUIDANCE = `The optional work_unit tool creates one sequential child context for coherent work whose raw scratch can be discarded. It is not required for ordinary conversation or simple actions. Return bounded findings with exact evidence, change, and validation references; do not copy raw output into the handoff, and close obsolete scratch. Child state is local and project promotion is proposed to the parent, never automatic.`;

const SYSTEM_PROMPT_TAIL = `Context frames may replace old raw history under input pressure. Use journal retrieval when an omitted fact matters instead of guessing. User constraints and commit or push permission are authoritative and cannot be weakened by model state.

Use read, bash, edit, and write for normal coding work. Treat explicit scope boundaries and public API shapes in an accepted spec as contracts unless the user approves a deviation. Re-read the exact governing resource before implementation and final audit rather than trusting a model-authored summary. Preserve user work, validate changes in proportion to risk, and report honestly.`;

function runtimeContract(workUnits: boolean) {
  const systemPrompt = [
    SYSTEM_PROMPT_HEAD,
    ...(workUnits ? [WORK_UNIT_GUIDANCE] : []),
    SYSTEM_PROMPT_TAIL,
  ].join('\n\n');
  const tools = [
    'read@pi-0.84',
    'bash@pi-0.84',
    'edit@pi-0.84',
    'write@pi-0.84',
    'journal@2',
    'context_update@3',
    ...(workUnits ? ['work_unit@1'] : []),
  ];
  return {
    systemPrompt,
    fixedContractsHash: canonicalJsonHash({ piVersion: '0.84.0', systemPrompt, tools }),
  };
}

export class PiEngine implements AgentEngine {
  private readonly modelRuntime: ModelRuntime;
  private readonly workspaceRead: WorkspaceReadExecutor;
  private readonly contextPolicy: ContextPolicyOverrides;

  private constructor(
    modelRuntime: ModelRuntime,
    workspaceRead: WorkspaceReadExecutor,
    contextPolicy: ContextPolicyOverrides,
  ) {
    this.modelRuntime = modelRuntime;
    this.workspaceRead = workspaceRead;
    this.contextPolicy = { ...contextPolicy };
  }

  static async create(options: {
    contextPolicy?: ContextPolicyOverrides;
    modelRuntime?: ModelRuntime;
    workspaceRead?: WorkspaceReadExecutor;
  } = {}) {
    const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
      allowModelNetwork: false,
    });
    return new PiEngine(
      modelRuntime,
      options.workspaceRead ?? readWorkspaceFile,
      options.contextPolicy ?? {},
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
    const workUnits = options.workUnits ?? false;
    const { systemPrompt, fixedContractsHash } = runtimeContract(workUnits);

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
    let lastProviderFrameOrdinal: number | null | undefined;
    let pendingTransport: {
      plannedRequestMode: 'full' | 'continuation';
      fullContextRequests: number;
      deltaRequests: number;
    } | null = null;
    let frameOrdinal = -1;
    let frameOrdinalInitialized = false;
    let activeFrame: {
      ordinal: number;
      basisSequence: number;
      baseMessageCount: number;
      bootstrapHash: string;
      prefix: Message;
      scopeId: string;
      scopeKind: 'turn' | 'work_unit';
      pressureNoticeAtMessageCount: number | null;
    } | null = null;
    let pendingContext: {
      basisSequence: number;
      logicalHash: string;
      renderedHash: string;
      orderedMessageHashes: string[];
      messageCount: number;
      estimatedInputTokens: number;
      fixedContractsHash: string;
      shadow: ShadowContextCandidate;
      shadowBuildDurationMs: number;
      activeMessages: readonly LogicalContextMessage[];
      contextMode: 'full-history' | 'stateful';
      frameOrdinal: number | null;
      pressureNotice: boolean;
    } | null = null;
    let pendingContextError: unknown = null;
    let activeScopeKind: 'turn' | 'work_unit' = 'turn';
    let pendingParentIntegration: string | null = null;
    const probeExtension: ExtensionFactory = (pi) => {
      pi.on('context', async (event) => {
        // Extension failures are intentionally swallowed by Pi. Clearing the
        // one-use fence first ensures provider preflight still fails closed.
        pendingContext = null;
        pendingContextError = null;
        try {
          const snapshot = await options.durability.compileContext();
          activeScopeKind = snapshot.shadowSource.executionScope.kind;
          if (!frameOrdinalInitialized) {
            frameOrdinal = (snapshot.nextFrameOrdinal ?? 0) - 1;
            frameOrdinalInitialized = true;
          }
          const fullMessages = alignDurableContextWithPi(snapshot, event.messages, model);
          const fullEstimatedInputTokens = estimatePiContextTokens(fullMessages, systemPrompt);
          const statefulMode = (options.contextMode ?? 'stateful') === 'stateful';
          if (
            activeFrame && activeFrame.scopeId !== snapshot.shadowSource.scopeId &&
            (activeFrame.scopeKind === 'work_unit' || snapshot.shadowSource.executionScope.kind === 'work_unit')
          ) activeFrame = null;
          const activeFrameEstimate = statefulMode
            ? activeFrame
              ? estimatePiContextTokens(frameMessages(activeFrame, fullMessages), systemPrompt)
              : 0
            : fullEstimatedInputTokens;
          const compileStartedAt = performance.now();
          const shadow = compileShadowContext(snapshot.shadowSource, {
            modelId: model.id,
            contextWindow: model.contextWindow,
            fixedContractsHash,
            activeEstimatedInputTokens: activeFrameEstimate,
            policy: this.contextPolicy,
            pressureNoticeSent: Boolean(activeFrame && activeFrame.pressureNoticeAtMessageCount !== null),
          });
          const shadowBuildDurationMs = Math.max(0, Math.round(performance.now() - compileStartedAt));
          let messages = fullMessages;
          if (statefulMode) {
            const policy = contextPolicyForModel(model.contextWindow, this.contextPolicy);
            if (activeFrame) {
              messages = frameMessages(activeFrame, fullMessages);
              const activeEstimate = estimatePiContextTokens(messages, systemPrompt);
              if (
                activeEstimate >= policy.admissionLimitTokens ||
                activeEstimate >= policy.rollThresholdTokens &&
                  activeFrame.pressureNoticeAtMessageCount !== null
              ) {
                activeFrame = null;
              } else if (
                activeEstimate >= policy.softNoticeTokens &&
                activeFrame.pressureNoticeAtMessageCount === null
              ) {
                activeFrame.pressureNoticeAtMessageCount = fullMessages.length;
                messages = frameMessages(activeFrame, fullMessages);
              }
            }
            if (!activeFrame) {
              frameOrdinal += 1;
              activeFrame = {
                ordinal: frameOrdinal,
                basisSequence: snapshot.basisSequence,
                baseMessageCount: snapshot.messages.length,
                bootstrapHash: shadow.bootstrapHash,
                prefix: contextFrameMessage(shadow, snapshot.messages.at(-1)?.timestamp ?? Date.now()),
                scopeId: snapshot.shadowSource.scopeId,
                scopeKind: snapshot.shadowSource.executionScope.kind,
                pressureNoticeAtMessageCount: null,
              };
              messages = frameMessages(activeFrame, fullMessages);
            }
          }
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
            shadow,
            shadowBuildDurationMs,
            activeMessages: statefulMode && activeFrame
              ? snapshot.messages.slice(activeFrame.baseMessageCount)
              : snapshot.messages,
            contextMode: options.contextMode ?? 'stateful',
            frameOrdinal: (options.contextMode ?? 'stateful') === 'stateful'
              ? activeFrame?.ordinal ?? null
              : null,
            pressureNotice: Boolean(activeFrame && activeFrame.pressureNoticeAtMessageCount !== null),
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
        if (pendingTransport) {
          const actualRequestMode = observedTransportMode(sessionId, pendingTransport);
          await options.durability.afterProviderCall?.({
            plannedRequestMode: pendingTransport.plannedRequestMode,
            actualRequestMode,
          });
          pendingTransport = null;
        }
        const content = durableAssistantContent(event.message.content);
        const calls = event.message.content.flatMap((block) => block.type === 'toolCall'
          ? [{
              callId: block.id,
              name: durableToolName(block.name),
              args: block.arguments,
            }]
          : []);
        const transition = await options.durability.beforeAssistantMessageEnd({
          inferenceState: assistantInferenceState(event.message.stopReason),
          text: content.text,
          reasoning: content.reasoning,
          calls,
        });
        if (transition?.parentIntegrationPrompt) {
          pendingParentIntegration = transition.parentIntegrationPrompt;
        }
      });
      pi.on('tool_execution_start', async (event) => {
        await options.durability.beforeTool({
          callId: event.toolCallId,
          name: durableToolName(event.toolName),
          args: event.args,
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
      customTools: [createWorkspaceReadTool(
        options.cwd,
        options.durability,
        this.workspaceRead,
      ), ...createContextTools(options.durability, { workUnits })],
      resourceLoader,
      sessionManager,
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
        const requestMode = providerCallCount > 0 && context.frameOrdinal === lastProviderFrameOrdinal
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
            shadow: context.shadow,
            shadowBuildDurationMs: context.shadowBuildDurationMs,
            activeMessages: context.activeMessages,
            contextMode: context.contextMode,
            frameOrdinal: context.frameOrdinal,
            pressureNotice: context.pressureNotice,
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
        lastProviderFrameOrdinal = context.frameOrdinal;
        probe = {
          ...probe,
          providerRequestMode: requestMode,
        };
        options.onEvent({ type: 'context-probe', probe });
      },
    });
    const unsubscribe = session.subscribe((event) => {
      if (
        activeScopeKind === 'work_unit' &&
        (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') &&
        event.message.role === 'assistant'
      ) return;
      if (event.type === 'agent_end' && pendingParentIntegration) return;
      projectPiEvent(event, options.onEvent);
    });

    return {
      async prompt(input) {
        await session.prompt(input.text, {
          expandPromptTemplates: false,
          images: input.images?.map((image): ImageContent => ({ type: 'image', ...image })),
        });
        while (pendingParentIntegration) {
          const prompt = pendingParentIntegration;
          pendingParentIntegration = null;
          await session.prompt(prompt, { expandPromptTemplates: false });
        }
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

function contextFrameMessage(candidate: ShadowContextCandidate, timestamp: number): Message {
  return {
    role: 'user',
    content: [
      'The following is the authoritative Remux context frame. Treat its continuation request as the current user request. Omitted evidence remains available through journal tools.',
      candidate.bootstrap,
    ].join('\n\n'),
    timestamp,
  };
}

function frameMessages(
  frame: {
    baseMessageCount: number;
    prefix: Message;
    pressureNoticeAtMessageCount: number | null;
  },
  alignedMessages: readonly Message[],
) {
  if (alignedMessages.length < frame.baseMessageCount) {
    throw new Error('Durable context moved behind the active context frame.');
  }
  const tail = alignedMessages.slice(frame.baseMessageCount);
  if (frame.pressureNoticeAtMessageCount === null) return [frame.prefix, ...tail];
  const noticeIndex = Math.max(
    0,
    Math.min(tail.length, frame.pressureNoticeAtMessageCount - frame.baseMessageCount),
  );
  const timestamp = alignedMessages[Math.max(0, frame.pressureNoticeAtMessageCount - 1)]?.timestamp ?? Date.now();
  return [
    frame.prefix,
    ...tail.slice(0, noticeIndex),
    {
      role: 'user' as const,
      content: 'Context pressure is elevated. At the next meaningful action, checkpoint only durable decisions or progress that must survive a frame rollover; do not summarize raw logs.',
      timestamp,
    },
    ...tail.slice(noticeIndex),
  ];
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
