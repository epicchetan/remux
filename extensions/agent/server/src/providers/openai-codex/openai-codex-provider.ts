import {
  type AssistantMessage,
  type ImageContent,
  type AuthEvent,
  getSupportedThinkingLevels,
  type Message,
  type Model,
} from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';

import type {
  AuthValue,
  ContextProbe,
  ModelInfo,
  ReasoningLevel,
} from '../../../../shared/protocol.ts';
import type {
  AssistantTextPhase,
  ModelProvider,
  ModelSession,
  ModelSessionEventSink,
} from '../../model-provider.ts';
import type {
  WorkUnitCompletion,
  WorkUnitEnterInput,
  WorkUnitView,
} from '../../domain/work.ts';
import {
  assertContextBudget,
  estimatePiContextTokens,
  hashRenderedMessages,
  parseProviderToolResultText,
  renderDurablePiPrefix,
  type LogicalContextMessage,
} from '../../logical-context.ts';
import type { ThreadContextFrameCandidate } from '../../context/manifest.ts';
import {
  createContextTools,
  PARENT_CONTEXT_TOOL_NAMES,
  WORK_UNIT_CONTEXT_TOOL_NAMES,
} from '../../context/tools.ts';
import { canonicalJson, canonicalJsonHash } from '../../storage/canonical-json.ts';
import { createRemuxAgentSession } from './pi-session.ts';
import { REMUX_SYSTEM_PROMPT } from '../../prompts.ts';
import {
  invalidateProviderLane,
  planProviderLaneRequest,
  type ProviderLaneState,
} from './provider-lanes.ts';
import {
  createWorkspaceReadTool,
  readWorkspaceFile,
  type WorkspaceReadExecutor,
} from '../../workspace-read.ts';

const PROVIDER = 'openai-codex';
const BASE_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'workspace_read'] as const;
const PARENT_ACTIVE_TOOL_NAMES = [...BASE_TOOL_NAMES, ...PARENT_CONTEXT_TOOL_NAMES];
const WORK_UNIT_ACTIVE_TOOL_NAMES = [...BASE_TOOL_NAMES, ...WORK_UNIT_CONTEXT_TOOL_NAMES];

type ProviderTransportStats = {
  requests: number;
  connectionsCreated: number;
  connectionsReused: number;
  fullContextRequests: number;
  deltaRequests: number;
  websocketFailures: number;
  sseFallbacks: number;
};

type ProviderTransportControls = {
  close(sessionId?: string): void;
  getStats(sessionId: string): ProviderTransportStats | undefined;
  resetStats(sessionId?: string): void;
};

function providerContract() {
  const systemPrompt = REMUX_SYSTEM_PROMPT;
  const tools = [
    'read@pi-0.84',
    'bash@pi-0.84',
    'edit@pi-0.84',
    'write@pi-0.84',
    'history@1',
    'thread@3',
    'work-unit@4',
    'provider-retry@1',
    'provider-lanes@1',
  ];
  return {
    systemPrompt,
    fixedContractsHash: canonicalJsonHash({
      piVersion: '0.84.0',
      systemPrompt,
      tools,
      activeToolProfiles: {
        parent: PARENT_ACTIVE_TOOL_NAMES,
        workUnit: WORK_UNIT_ACTIVE_TOOL_NAMES,
      },
    }),
  };
}

export class OpenAICodexProvider implements ModelProvider {
  private readonly modelRuntime: ModelRuntime;
  private readonly workspaceRead: WorkspaceReadExecutor;
  private readonly providerWebSocketFaultAfterEvents: (() => number | undefined) | undefined;

  private constructor(
    modelRuntime: ModelRuntime,
    workspaceRead: WorkspaceReadExecutor,
    providerWebSocketFaultAfterEvents: (() => number | undefined) | undefined,
  ) {
    this.modelRuntime = modelRuntime;
    this.workspaceRead = workspaceRead;
    this.providerWebSocketFaultAfterEvents = providerWebSocketFaultAfterEvents;
  }

  static async create(options: {
    modelRuntime?: ModelRuntime;
    workspaceRead?: WorkspaceReadExecutor;
    /** Test-only hook for deterministic response-started WebSocket failure coverage. */
    providerWebSocketFaultAfterEvents?: () => number | undefined;
  } = {}) {
    const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
      allowModelNetwork: false,
    });
    return new OpenAICodexProvider(
      modelRuntime,
      options.workspaceRead ?? readWorkspaceFile,
      options.providerWebSocketFaultAfterEvents,
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

  async createSession(
    options: Parameters<ModelProvider['createSession']>[0],
  ): Promise<ModelSession> {
    const model = this.modelRuntime.getModel(PROVIDER, options.modelId);
    if (!model) throw new Error(`Unknown OpenAI Codex model: ${options.modelId}`);
    const { systemPrompt, fixedContractsHash } = providerContract();

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
    let pendingRetryOfInferenceId: string | null = null;
    let parentProviderSessionId = '';
    let activeProviderSessionId = '';
    let providerTransportControls: ProviderTransportControls | null = null;
    const providerSessionIds = new Set<string>();
    const providerLanes = new Map<string, ProviderLaneState>();
    let pendingTransport: {
      providerSessionId: string;
      plannedRequestMode: 'full' | 'continuation';
      startedAt: number;
      firstEventAt: number | null;
      requests: number;
      connectionsCreated: number;
      connectionsReused: number;
      fullContextRequests: number;
      deltaRequests: number;
      websocketFailures: number;
      sseFallbacks: number;
    } | null = null;
    let pendingContext: {
      providerSessionId: string;
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
    let pendingAgentEnd: Extract<AgentSessionEvent, { type: 'agent_end' }> | null = null;
    let activeChildSession: AgentSession | null = null;
    let activeChildCompletion: WorkUnitCompletion | null = null;
    let activeChildFinishAttempted = false;
    let activeChildFinishFailure: string | null = null;
    const directlyFinalizedToolCalls = new Set<string>();
    let interruptRequested = false;
    const assistantDurability = new WeakMap<AssistantMessage, Promise<void>>();
    const awaitProviderDurability = async () => {
      await providerDurabilityTail;
      if (providerDurabilityError) throw providerDurabilityError;
    };
    const ensureAssistantDurable = (message: AssistantMessage) => {
      const existing = assistantDurability.get(message);
      if (existing) return existing;
      const transport = pendingTransport;
      pendingTransport = null;
      const durability = (async () => {
        if (transport) {
          const completedAt = performance.now();
          const controls = requiredProviderTransportControls(providerTransportControls);
          const observation = observeProviderTransport(
            controls,
            transport.providerSessionId,
            transport,
          );
          const actualRequestMode = observedTransportMode(
            controls,
            transport.providerSessionId,
            transport,
          );
          await options.durability.afterProviderCall?.({
            plannedRequestMode: transport.plannedRequestMode,
            actualRequestMode,
            ...observation,
            dispatchToFirstEventMs: transport.firstEventAt === null
              ? null
              : Math.max(0, Math.round(transport.firstEventAt - transport.startedAt)),
            durationMs: Math.max(0, Math.round(completedAt - transport.startedAt)),
          });
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
          textPhase: assistantTextPhase(message),
          reasoning: content.reasoning,
          calls,
          providerMessage: message,
        });
      })();
      assistantDurability.set(message, durability);
      const settled = durability.catch((error) => {
        providerDurabilityError ??= error;
      });
      providerDurabilityTail = Promise.all([providerDurabilityTail, settled]).then(() => undefined);
      return durability;
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
          // durable state before compiling the next frame, both to prevent two
          // running inferences in one scope and to compile from the real head.
          await awaitProviderDurability();
          const compileStartedAt = performance.now();
          const compileFrame = async () => {
            const snapshot = await options.durability.compileContext(model.contextWindow);
            activeProviderSessionId = snapshot.scopeKind === 'work_unit'
              ? snapshot.scopeId
              : parentProviderSessionId;
            if (!providerSessionIds.has(activeProviderSessionId)) {
              providerSessionIds.add(activeProviderSessionId);
              requiredProviderTransportControls(providerTransportControls)
                .resetStats(activeProviderSessionId);
            }
            const dialogueTurnIds = new Set(snapshot.frame.dialogueTurnIds);
            const recentDialogue = snapshot.messages.filter((message) =>
              dialogueTurnIds.has(message.turnId));
            const activeScope = snapshot.messages.filter((message) =>
              !dialogueTurnIds.has(message.turnId));
            const messages: Message[] = [
              ...renderDurablePiPrefix(recentDialogue, model),
              contextFrameMessage(snapshot.frame, snapshot.scopeKind),
              ...renderDurablePiPrefix(activeScope, model),
            ];
            return {
              snapshot,
              messages,
              estimatedInputTokens: estimatePiContextTokens(messages, systemPrompt),
            };
          };
          let compiled = await compileFrame();
          if (
            compiled.estimatedInputTokens >= compiled.snapshot.frame.softContextLimit &&
            !compiled.snapshot.frame.pressureNoticed
          ) {
            const recorded = await options.durability.noticeContextPressure({
              estimatedInputTokens: compiled.estimatedInputTokens,
              softContextLimit: compiled.snapshot.frame.softContextLimit,
              hardContextLimit: compiled.snapshot.frame.hardContextLimit,
            });
            if (recorded) compiled = await compileFrame();
          }
          const { snapshot, messages, estimatedInputTokens } = compiled;
          const frameBuildDurationMs = Math.max(0, Math.round(performance.now() - compileStartedAt));
          const rendered = hashRenderedMessages(messages);
          pendingContext = {
            providerSessionId: activeProviderSessionId,
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
      pi.on('before_provider_request', (event) =>
        requestConciseReasoningSummary(event.payload));
      pi.on('message_end', async (event) => {
        if (event.message.role !== 'assistant') return;
        await ensureAssistantDurable(event.message);
      });
    };

    const finalizeDurableTool = async (input: {
      callId: string;
      name: string;
      content: unknown;
      details?: unknown;
      isError: boolean;
    }) => {
      const name = durableToolName(input.name);
      const result = durableToolResult({ content: input.content }, input.isError);
      if (name === 'work_unit_finish') {
        activeChildFinishAttempted = true;
        if (!input.isError) {
          const completion = workUnitCompletion(input.details ?? result);
          if (!completion) {
            throw new Error('work_unit_finish returned without a durable completion payload.');
          }
          activeChildCompletion = completion;
          activeChildFinishFailure = null;
          return completion;
        }
        activeChildFinishFailure = toolResultText(input.content) || 'The finish tool failed.';
      }
      await options.durability.afterTool({
        callId: input.callId,
        name,
        result,
        isError: input.isError,
      });
      return null;
    };

    const installDurableToolHooks = (target: AgentSession) => {
      const piBeforeToolCall = target.agent.beforeToolCall;
      const piAfterToolCall = target.agent.afterToolCall;
      target.agent.beforeToolCall = async (context, signal) => {
        try {
          const piResult = await piBeforeToolCall?.(context, signal);
          if (piResult?.block) return piResult;
          await awaitProviderDurability();
          const name = durableToolName(context.toolCall.name);
          if (name === 'work_unit_finish') activeChildFinishAttempted = true;
          await options.durability.beforeTool({
            callId: context.toolCall.id,
            name,
            args: context.args,
          });
          return piResult;
        } catch (error) {
          providerDurabilityError ??= error;
          throw error;
        }
      };
      target.agent.afterToolCall = async (context, signal) => {
        directlyFinalizedToolCalls.add(context.toolCall.id);
        try {
          const piResult = await piAfterToolCall?.(context, signal);
          const content = piResult?.content ?? context.result.content;
          const details = piResult?.details ?? context.result.details;
          const isError = piResult?.isError ?? context.isError;
          const completion = await finalizeDurableTool({
            callId: context.toolCall.id,
            name: context.toolCall.name,
            content,
            details,
            isError,
          });
          if (!completion) return piResult;
          return {
            ...piResult,
            content: [{ type: 'text' as const, text: JSON.stringify(completion) }],
            details: completion,
            isError: false,
            terminate: true,
          };
        } catch (error) {
          providerDurabilityError ??= error;
          const message = `Durable tool finalization failed: ${safeMessage(error)}`;
          return {
            content: [{ type: 'text' as const, text: message }],
            details: { error: message },
            isError: true,
            ...(context.toolCall.name === 'work_unit_finish' ? { terminate: true } : {}),
          };
        }
      };
    };

    const reconcileObservedToolEnd = (event: Extract<AgentSessionEvent, { type: 'tool_execution_end' }>) => {
      if (directlyFinalizedToolCalls.delete(event.toolCallId)) return;
      const priorDurability = providerDurabilityTail;
      const durability = (async () => {
        await priorDurability;
        if (providerDurabilityError) throw providerDurabilityError;
        await finalizeDurableTool({
          callId: event.toolCallId,
          name: event.toolName,
          content: event.result?.content,
          details: event.result?.details,
          isError: event.isError,
        });
      })();
      const settled = durability.catch((error) => {
        providerDurabilityError ??= error;
      });
      providerDurabilityTail = Promise.all([priorDurability, settled]).then(() => undefined);
    };

    const providerPreflight = async (payload: unknown) => {
      // Keep the provider fence defensive even if Pi changes its context hook
      // ordering: no request may overtake the preceding provider item's
      // durable terminal boundary.
      await awaitProviderDurability();
      if (options.reasoning !== 'off') assertConciseReasoningSummary(payload);
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
      const lanePlan = planProviderLaneRequest(
        providerLanes.get(context.providerSessionId),
        context.orderedMessageHashes,
      );
      const requestMode = lanePlan.requestMode;
      const estimatedInputTokens = Math.max(
        context.estimatedInputTokens,
        Math.ceil(Buffer.byteLength(JSON.stringify(payload), 'utf8') / 4),
      );
      await options.durability.beforeProviderCall({
        payload,
        requestMode,
        estimatedInputTokens,
        ...(pendingRetryOfInferenceId
          ? { retryOfInferenceId: pendingRetryOfInferenceId }
          : {}),
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
      pendingRetryOfInferenceId = null;
      assertContextBudget(estimatedInputTokens, model.contextWindow);
      const transportStats = requiredProviderTransportControls(providerTransportControls)
        .getStats(context.providerSessionId);
      pendingTransport = {
        providerSessionId: context.providerSessionId,
        plannedRequestMode: requestMode,
        startedAt: performance.now(),
        firstEventAt: null,
        requests: transportStats?.requests ?? 0,
        connectionsCreated: transportStats?.connectionsCreated ?? 0,
        connectionsReused: transportStats?.connectionsReused ?? 0,
        fullContextRequests: transportStats?.fullContextRequests ?? 0,
        deltaRequests: transportStats?.deltaRequests ?? 0,
        websocketFailures: transportStats?.websocketFailures ?? 0,
        sseFallbacks: transportStats?.sseFallbacks ?? 0,
      };
      providerLanes.set(context.providerSessionId, lanePlan.next);
      probe = { ...probe, providerRequestMode: requestMode };
      options.onEvent({ type: 'context-probe', probe });
    };

    let runWorkUnit: (callId: string, input: WorkUnitEnterInput) => Promise<WorkUnitCompletion>;

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 500,
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
    parentProviderSessionId = sessionId;
    activeProviderSessionId = sessionId;
    const { session } = await createRemuxAgentSession({
      cwd: options.cwd,
      modelRuntime: this.modelRuntime,
      model,
      thinkingLevel: options.reasoning,
      customTools: [
        createWorkspaceReadTool(options.cwd, undefined, this.workspaceRead),
        ...createContextTools(options.durability, {
          runWorkUnit: (callId, input) => runWorkUnit(callId, input),
        }),
      ],
      resourceLoader,
      sessionManager,
      settingsManager,
      providerSessionId: () => activeProviderSessionId,
      providerWebSocketFaultAfterEvents: this.providerWebSocketFaultAfterEvents,
      registerProviderTransportControls: (controls) => {
        providerTransportControls = controls;
      },
      providerPreflight,
    });
    installDurableToolHooks(session);
    session.setActiveToolsByName(PARENT_ACTIVE_TOOL_NAMES);
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'tool_execution_end') reconcileObservedToolEnd(event);
      if (event.type === 'message_update' && pendingTransport?.firstEventAt === null) {
        pendingTransport.firstEventAt = performance.now();
      }
      if (event.type === 'auto_retry_start') {
        const priorDurability = providerDurabilityTail;
        const durability = (async () => {
          await priorDurability;
          if (providerDurabilityError) throw providerDurabilityError;
          const superseded = await options.durability.supersedeProviderAttempt({
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            error: safeMessage(event.errorMessage),
          });
          pendingRetryOfInferenceId = superseded.inferenceId;
          // The first recovery attempt gets a fresh WebSocket. If that also
          // drops after streaming starts, Pi's per-session transport marker
          // deliberately routes the final bounded attempt through SSE.
          const controls = requiredProviderTransportControls(providerTransportControls);
          controls.close(activeProviderSessionId);
          if (event.attempt === 1) {
            controls.resetStats(activeProviderSessionId);
          }
          pendingTransport = null;
          providerLanes.set(
            activeProviderSessionId,
            invalidateProviderLane(providerLanes.get(activeProviderSessionId)),
          );
        })();
        const settled = durability.catch((error) => {
          providerDurabilityError ??= error;
        });
        providerDurabilityTail = Promise.all([priorDurability, settled]).then(() => undefined);
        return;
      }
      if (event.type === 'auto_retry_end' && event.success && event.attempt >= 2) {
        // The last bounded attempt may have succeeded through SSE. Clear Pi's
        // sticky fallback marker so the following inference returns to a fresh
        // scope-local WebSocket instead of degrading the rest of the thread.
        const controls = requiredProviderTransportControls(providerTransportControls);
        controls.close(activeProviderSessionId);
        controls.resetStats(activeProviderSessionId);
        providerLanes.set(
          activeProviderSessionId,
          invalidateProviderLane(providerLanes.get(activeProviderSessionId)),
        );
        return;
      }
      if (event.type === 'agent_end') {
        pendingAgentEnd = event;
        return;
      }
      projectPiEvent(event, options.onEvent);
    });

    runWorkUnit = async (callId, input) => {
      const entered = await options.durability.workUnitEnter(callId, input);
      const childSettings = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: {
          enabled: true,
          maxRetries: 2,
          baseDelayMs: 500,
          provider: { maxRetries: 0, maxRetryDelayMs: 0 },
        },
        transport: 'websocket-cached',
        enableAnalytics: false,
        enableInstallTelemetry: false,
      });
      const childResources = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: getAgentDir(),
        settingsManager: childSettings,
        extensionFactories: [{ name: 'remux-context-probe', factory: probeExtension, hidden: true }],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt,
      });
      await childResources.reload();
      const childSessionManager = SessionManager.inMemory(options.cwd);
      const { session: child } = await createRemuxAgentSession({
        cwd: options.cwd,
        modelRuntime: this.modelRuntime,
        model,
        thinkingLevel: options.reasoning,
        customTools: [
          createWorkspaceReadTool(options.cwd, undefined, this.workspaceRead),
          ...createContextTools(options.durability, {
            runWorkUnit: (nestedCallId, nestedInput) => runWorkUnit(nestedCallId, nestedInput),
          }),
        ],
        resourceLoader: childResources,
        sessionManager: childSessionManager,
        settingsManager: childSettings,
        providerSessionId: () => activeProviderSessionId,
        providerWebSocketFaultAfterEvents: this.providerWebSocketFaultAfterEvents,
        registerProviderTransportControls: (controls) => {
          providerTransportControls = controls;
        },
        providerPreflight,
      });
      installDurableToolHooks(child);
      child.setActiveToolsByName(WORK_UNIT_ACTIVE_TOOL_NAMES);
      const bootstrap = workUnitBootstrap(entered);
      child.agent.state.messages = [{
        role: 'toolResult',
        toolCallId: callId,
        toolName: 'work_unit_start',
        content: [{ type: 'text', text: canonicalJson(bootstrap) }],
        details: bootstrap,
        isError: false,
        timestamp: Date.now(),
      }];
      child.agent.shouldStopAfterTurn = ({ message, toolResults }) => {
        const calledFinish = message.content.some((block) =>
          block.type === 'toolCall' && block.name === 'work_unit_finish');
        const finished = toolResults.some((result) =>
          result.toolName === 'work_unit_finish' && !result.isError);
        return calledFinish && finished;
      };

      activeChildSession = child;
      activeChildCompletion = null;
      activeChildFinishAttempted = false;
      activeChildFinishFailure = null;
      let childAgentEnd: Extract<AgentSessionEvent, { type: 'agent_end' }> | null = null;
      const unsubscribeChild = child.subscribe((event) => {
        if (event.type === 'tool_execution_end') reconcileObservedToolEnd(event);
        if (event.type === 'message_update' && pendingTransport?.firstEventAt === null) {
          pendingTransport.firstEventAt = performance.now();
        }
        if (event.type === 'auto_retry_start') {
          const priorDurability = providerDurabilityTail;
          const durability = (async () => {
            await priorDurability;
            if (providerDurabilityError) throw providerDurabilityError;
            const superseded = await options.durability.supersedeProviderAttempt({
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              error: safeMessage(event.errorMessage),
            });
            pendingRetryOfInferenceId = superseded.inferenceId;
            const controls = requiredProviderTransportControls(providerTransportControls);
            controls.close(activeProviderSessionId);
            if (event.attempt === 1) controls.resetStats(activeProviderSessionId);
            pendingTransport = null;
            providerLanes.set(
              activeProviderSessionId,
              invalidateProviderLane(providerLanes.get(activeProviderSessionId)),
            );
          })();
          const settled = durability.catch((error) => {
            providerDurabilityError ??= error;
          });
          providerDurabilityTail = Promise.all([priorDurability, settled]).then(() => undefined);
          return;
        }
        if (event.type === 'auto_retry_end' && event.success && event.attempt >= 2) {
          const controls = requiredProviderTransportControls(providerTransportControls);
          controls.close(activeProviderSessionId);
          controls.resetStats(activeProviderSessionId);
          providerLanes.set(
            activeProviderSessionId,
            invalidateProviderLane(providerLanes.get(activeProviderSessionId)),
          );
          return;
        }
        if (event.type === 'agent_end') {
          childAgentEnd = event;
          return;
        }
        projectPiEvent(event, options.onEvent);
      });

      try {
        await child.continue();
        const agentEnd = childAgentEnd as Extract<AgentSessionEvent, { type: 'agent_end' }> | null;
        if (!agentEnd) throw new Error('Pi completed a work unit without an agent_end boundary.');
        const finalAssistant = [...agentEnd.messages]
          .reverse()
          .find((message): message is AssistantMessage => message.role === 'assistant');
        if (finalAssistant) await ensureAssistantDurable(finalAssistant);
        await providerDurabilityTail;
        if (providerDurabilityError) throw providerDurabilityError;
        const completion = activeChildCompletion as WorkUnitCompletion | null;
        if (!completion) {
          if (activeChildFinishAttempted) {
            throw new Error(activeChildFinishFailure
              ? `The work unit ended after work_unit_finish failed: ${activeChildFinishFailure}`
              : 'The work unit ended after work_unit_finish failed to commit.');
          }
          throw new Error('The work unit ended without calling work_unit_finish.');
        }
        return completion;
      } catch (error) {
        if (interruptRequested || activeChildCompletion) throw error;
        if (providerDurabilityError) throw error;
        const recovered = await options.durability.workUnitAbort({ reason: safeMessage(error) });
        pendingTransport = null;
        return recovered;
      } finally {
        unsubscribeChild();
        activeChildSession = null;
        activeChildCompletion = null;
        activeChildFinishAttempted = false;
        activeChildFinishFailure = null;
        try {
          await child.abort();
        } finally {
          child.dispose();
          const controls = requiredProviderTransportControls(providerTransportControls);
          controls.close(entered.scopeId);
          controls.resetStats(entered.scopeId);
          providerSessionIds.delete(entered.scopeId);
          providerLanes.delete(entered.scopeId);
        }
      }
    };

    return {
      async prompt(input) {
        providerDurabilityError = null;
        pendingAgentEnd = null;
        interruptRequested = false;
        await session.prompt(input.text, {
          expandPromptTemplates: false,
          images: input.images?.map((image): ImageContent => ({ type: 'image', ...image })),
        });
        const agentEnd = pendingAgentEnd as Extract<AgentSessionEvent, { type: 'agent_end' }> | null;
        if (!agentEnd) throw new Error('Pi completed a prompt without an agent_end boundary.');
        const finalAssistant = [...agentEnd.messages]
          .reverse()
          .find((message): message is AssistantMessage => message.role === 'assistant');
        // Pi extension callbacks are not guaranteed to settle before the
        // session-level agent_end notification. Always seal the exact final
        // AssistantMessage before the server can publish runtime idle. The
        // WeakMap makes this idempotent when message_end already registered
        // the same boundary; a conversation-wide boolean is unsafe because a
        // late hook from an earlier model cycle can satisfy it for the wrong
        // message.
        if (finalAssistant) await ensureAssistantDurable(finalAssistant);
        await providerDurabilityTail;
        if (providerDurabilityError) throw providerDurabilityError;
        projectPiEvent(agentEnd, options.onEvent);
      },
      async interrupt() {
        interruptRequested = true;
        await Promise.all([
          session.abort(),
          activeChildSession?.abort() ?? Promise.resolve(),
        ]);
      },
      async dispose() {
        unsubscribe();
        try {
          await Promise.all([
            session.abort(),
            activeChildSession?.abort() ?? Promise.resolve(),
          ]);
        } finally {
          session.dispose();
          for (const providerSessionId of providerSessionIds) {
            providerTransportControls?.close(providerSessionId);
            providerTransportControls?.resetStats(providerSessionId);
          }
        }
      },
    };
  }
}

function observedTransportMode(
  controls: ProviderTransportControls,
  sessionId: string,
  pending: {
    plannedRequestMode: 'full' | 'continuation';
    fullContextRequests: number;
    deltaRequests: number;
  },
): 'full' | 'continuation' {
  const stats = controls.getStats(sessionId);
  if (!stats) return pending.plannedRequestMode;
  if (stats.deltaRequests > pending.deltaRequests) return 'continuation';
  if (stats.fullContextRequests > pending.fullContextRequests) return 'full';
  return pending.plannedRequestMode;
}

function observeProviderTransport(
  controls: ProviderTransportControls,
  sessionId: string,
  pending: {
    requests: number;
    connectionsCreated: number;
    connectionsReused: number;
    websocketFailures: number;
    sseFallbacks: number;
  },
) {
  const stats = controls.getStats(sessionId);
  const websocketRequests = Math.max(0, (stats?.requests ?? 0) - pending.requests);
  const sseFallbacks = Math.max(0, (stats?.sseFallbacks ?? 0) - pending.sseFallbacks);
  return {
    carrier: sseFallbacks > 0
      ? 'sse' as const
      : websocketRequests > 0
        ? 'websocket' as const
        : 'unknown' as const,
    websocketRequests,
    connectionsCreated: Math.max(
      0,
      (stats?.connectionsCreated ?? 0) - pending.connectionsCreated,
    ),
    connectionsReused: Math.max(
      0,
      (stats?.connectionsReused ?? 0) - pending.connectionsReused,
    ),
    websocketFailures: Math.max(
      0,
      (stats?.websocketFailures ?? 0) - pending.websocketFailures,
    ),
    sseFallbacks,
  };
}

function requiredProviderTransportControls(
  controls: ProviderTransportControls | null,
): ProviderTransportControls {
  if (!controls) {
    throw new Error('Pi did not register provider transport controls from its active pi-ai runtime.');
  }
  return controls;
}

function workUnitBootstrap(entered: WorkUnitView) {
  return {
    boundary: 'work_unit',
    historyRef: `history://scope/${encodeURIComponent(entered.scopeId)}`,
    resources: entered.resources,
    scopeId: entered.scopeId,
    state: entered.state,
  };
}

function contextFrameMessage(
  candidate: ThreadContextFrameCandidate,
  scopeKind: 'turn' | 'work_unit',
): Message {
  const scopeBoundary = scopeKind === 'work_unit'
    ? 'Current work: focused work unit. Keep scratch local and finish with work_unit_finish.'
    : 'Current work: parent conversation. work_unit_finish is valid only after work_unit_start has opened a work unit.';
  return {
    role: 'user',
    content: [
      'The following is the living Thread for this conversation. The exact user message after it is the current request. Exact earlier activity remains available through History tools.',
      scopeBoundary,
      candidate.contextEnvelope,
    ].join('\n\n'),
    // This synthetic control message is stable while its content is stable.
    // Event timestamps belong to the durable messages below; changing this
    // timestamp on every inference would invalidate the provider prefix cache.
    timestamp: 0,
  };
}

function projectPiEvent(event: AgentSessionEvent, sink: ModelSessionEventSink) {
  switch (event.type) {
    case 'message_start':
      if (event.message.role === 'assistant') sink({ type: 'assistant-start' });
      return;
    case 'message_update':
      if (event.assistantMessageEvent.type === 'text_delta') {
        if (event.message.role !== 'assistant') return;
        sink({
          type: 'assistant-text',
          delta: event.assistantMessageEvent.delta,
          phase: streamingAssistantTextPhase(event.message),
        });
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

function streamingAssistantTextPhase(message: AssistantMessage): AssistantTextPhase {
  return message.stopReason === 'stop' ? 'final_answer' : 'commentary';
}

function assistantTextPhase(message: AssistantMessage): AssistantTextPhase {
  const phases = new Set<AssistantTextPhase>(message.content.flatMap((block): AssistantTextPhase[] => {
    if (block.type !== 'text' || !block.textSignature) return [];
    try {
      const value = JSON.parse(block.textSignature) as { phase?: unknown };
      return value.phase === 'commentary' || value.phase === 'final_answer'
        ? [value.phase]
        : [];
    } catch {
      return [];
    }
  }));
  if (phases.size === 1) return [...phases][0]!;
  return streamingAssistantTextPhase(message);
}

export function requestConciseReasoningSummary(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const request = payload as Record<string, unknown>;
  const reasoning = request.reasoning;
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) return payload;
  return {
    ...request,
    reasoning: {
      ...reasoning,
      summary: 'concise',
    },
  };
}

function assertConciseReasoningSummary(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Provider request is missing the reasoning summary contract.');
  }
  const reasoning = (payload as Record<string, unknown>).reasoning;
  if (
    !reasoning ||
    typeof reasoning !== 'object' ||
    Array.isArray(reasoning) ||
    (reasoning as Record<string, unknown>).summary !== 'concise'
  ) {
    throw new Error('Provider request must ask OpenAI for a concise reasoning summary.');
  }
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

function workUnitCompletion(value: unknown): WorkUnitCompletion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.scopeId !== 'string' ||
    !['completed', 'partial', 'blocked'].includes(String(candidate.status)) ||
    typeof candidate.result !== 'string' ||
    !Array.isArray(candidate.resources) ||
    typeof candidate.resultRef !== 'string' ||
    typeof candidate.historyRef !== 'string'
  ) return null;
  return candidate as WorkUnitCompletion;
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
