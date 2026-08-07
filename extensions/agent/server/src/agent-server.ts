import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';

import {
  AGENT_METHODS,
  AGENT_RESOURCE_KEYS,
  conversationResourceKey,
  type AuthValue,
  type ConversationStartParams,
  type ConversationValue,
  type LoginCancelParams,
  type MessageSendParams,
  type ModelsValue,
  type ReasoningLevel,
  type ResourceReadParams,
  type TurnInterruptParams,
} from '../../shared/protocol.ts';
import type { AgentResourceInvalidation } from '../../shared/transcript.ts';
import type { AgentEngine, ConversationRuntime, RuntimeEvent } from './engine.ts';
import { ResourceStore } from './resources.ts';
import {
  EphemeralTranscriptProjector,
  parseTranscriptResourcesReadParams,
  TranscriptProtocolError,
} from './transcript-projector.ts';

export class RpcFault extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcFault';
    this.code = code;
    this.data = data;
  }
}

export class AgentServer {
  readonly resources: ResourceStore;
  private readonly engine: AgentEngine;
  private runtime: ConversationRuntime | null = null;
  private projector: EphemeralTranscriptProjector | null = null;
  private loginController: AbortController | null = null;
  private conversationId: string | null = null;
  private readonly notify: (method: string, params: unknown) => void;

  constructor(
    engine: AgentEngine,
    notify: (method: string, params: unknown) => void,
  ) {
    this.engine = engine;
    this.notify = notify;
    this.resources = new ResourceStore((params) => notify(AGENT_METHODS.resourcesInvalidated, params));
  }

  async initialize() {
    const auth = await this.engine.authStatus().catch((error): AuthValue => ({
      ...signedOutAuth(),
      state: 'error',
      error: safeMessage(error),
    }));
    this.resources.set(AGENT_RESOURCE_KEYS.auth, sanitizeAuth(auth), false);
    await this.refreshModels(false);
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case AGENT_METHODS.resourcesRead:
        return this.readResources(parseResourceRead(params));
      case AGENT_METHODS.transcriptResourcesRead:
        return this.readTranscriptResources(params);
      case AGENT_METHODS.modelsRead:
        return this.refreshModels();
      case AGENT_METHODS.authLoginStart:
        return this.startLogin();
      case AGENT_METHODS.authLoginCancel:
        return this.cancelLogin(parseLoginCancel(params));
      case AGENT_METHODS.authLogout:
        return this.logout();
      case AGENT_METHODS.conversationStart:
        return this.startConversation(parseConversationStart(params));
      case AGENT_METHODS.messageSend:
        return this.sendMessage(parseMessageSend(params));
      case AGENT_METHODS.turnInterrupt:
        return this.interrupt(parseTurnInterrupt(params));
      default:
        throw new RpcFault(-32601, `Method not found: ${method}`);
    }
  }

  private async refreshModels(notify = true): Promise<ModelsValue> {
    const auth = this.resources.get<AuthValue>(AGENT_RESOURCE_KEYS.auth);
    let value: ModelsValue;
    if (auth?.state !== 'signed-in') {
      value = { models: [], defaultModelId: null, error: null };
    } else {
      try {
        const models = await this.engine.listModels();
        value = { models, defaultModelId: models[0]?.id ?? null, error: null };
      } catch (error) {
        value = { models: [], defaultModelId: null, error: safeMessage(error) };
      }
    }
    this.resources.set(AGENT_RESOURCE_KEYS.models, value, notify);
    return value;
  }

  private startLogin() {
    if (this.loginController) throw new RpcFault(-32010, 'A sign-in operation is already running.');
    const operationId = randomUUID();
    const controller = new AbortController();
    this.loginController = controller;
    this.resources.set(AGENT_RESOURCE_KEYS.auth, {
      ...signedOutAuth(),
      state: 'signing-in',
      operationId,
      progress: 'Starting OpenAI device sign-in…',
    });

    void this.engine.login(operationId, controller.signal, (value) => {
      if (this.loginController === controller) {
        this.resources.set(AGENT_RESOURCE_KEYS.auth, sanitizeAuth(value));
      }
    }).then(async () => {
      if (this.loginController !== controller) return;
      const auth = await this.engine.authStatus();
      this.resources.set(AGENT_RESOURCE_KEYS.auth, sanitizeAuth(auth));
      await this.refreshModels();
    }).catch((error) => {
      if (this.loginController !== controller) return;
      this.resources.set(AGENT_RESOURCE_KEYS.auth, controller.signal.aborted
        ? signedOutAuth()
        : { ...signedOutAuth(), state: 'error', error: publicAuthError(error) });
    }).finally(() => {
      if (this.loginController === controller) this.loginController = null;
    });

    return { accepted: true as const, operationId };
  }

  private cancelLogin(params: LoginCancelParams) {
    const auth = this.resources.get<AuthValue>(AGENT_RESOURCE_KEYS.auth);
    if (!this.loginController || auth?.operationId !== params.operationId) {
      throw new RpcFault(-32016, 'The sign-in operation is no longer active.');
    }
    this.loginController?.abort(new DOMException('Sign-in canceled', 'AbortError'));
    this.loginController = null;
    this.resources.set(AGENT_RESOURCE_KEYS.auth, signedOutAuth());
    return { accepted: true as const };
  }

  private async logout() {
    this.loginController?.abort(new DOMException('Sign-in canceled', 'AbortError'));
    this.loginController = null;
    await this.disposeConversation();
    await this.engine.logout();
    this.resources.set(AGENT_RESOURCE_KEYS.auth, signedOutAuth());
    await this.refreshModels();
    return { ok: true as const };
  }

  private async startConversation(params: ConversationStartParams) {
    const auth = this.resources.get<AuthValue>(AGENT_RESOURCE_KEYS.auth);
    if (auth?.state !== 'signed-in') throw new RpcFault(-32011, 'Sign in before starting a conversation.');
    const models = this.resources.get<ModelsValue>(AGENT_RESOURCE_KEYS.models);
    const selected = models?.models.find((model) => model.id === params.modelId);
    if (!selected) throw new RpcFault(-32602, 'The selected model is unavailable.');
    if (!selected.supportedReasoning.includes(params.reasoning)) {
      throw new RpcFault(-32602, 'The selected reasoning level is unavailable for this model.');
    }
    if (this.conversationId) {
      const current = this.resources.get<ConversationValue>(conversationResourceKey(this.conversationId));
      if (current?.status === 'running' || current?.status === 'interrupting') {
        throw new RpcFault(-32013, 'Interrupt the active turn before replacing the conversation.');
      }
    }

    const cwd = await canonicalDirectory(params.cwd);
    await this.disposeConversation();
    const conversationId = randomUUID();
    const conversation: ConversationValue = {
      id: conversationId,
      cwd,
      modelId: params.modelId,
      reasoning: params.reasoning,
      status: 'idle',
      activeTurnId: null,
      activeTurnElapsedMs: null,
      contextProbe: {
        hookVersion: 'phase0-v1',
        modelCallCount: 0,
        messageCount: 0,
        messageHash: null,
        orderedMessageHashes: [],
        estimatedBytes: 0,
        provider: 'openai-codex',
        modelId: params.modelId,
        providerRequestMode: 'none',
      },
      error: null,
    };
    this.runtime = await this.engine.createConversation({
      cwd,
      modelId: params.modelId,
      reasoning: params.reasoning,
      onEvent: (event) => this.applyRuntimeEvent(conversationId, event),
    });
    this.projector = new EphemeralTranscriptProjector({
      conversationId,
      invalidate: (invalidations) => this.publishProjectorInvalidations(invalidations),
    });
    this.conversationId = conversationId;
    this.resources.set(conversationResourceKey(conversationId), conversation);
    return { conversationId };
  }

  private sendMessage(params: MessageSendParams) {
    const conversation = this.requiredConversation(params.conversationId);
    if (!this.runtime) throw new RpcFault(-32012, 'The conversation runtime is unavailable.');
    if (conversation.status === 'running' || conversation.status === 'interrupting') {
      throw new RpcFault(-32013, 'A turn is already running.');
    }
    const text = params.text.trim();
    if (!text) throw new RpcFault(-32602, 'Message text cannot be empty.');
    if (Buffer.byteLength(text) > 64 * 1024) throw new RpcFault(-32602, 'Message text exceeds the 64 KiB Phase 0 limit.');
    if (this.projector?.hasClientMessageId(params.clientMessageId)) {
      throw new RpcFault(-32017, 'clientMessageId was already used in this conversation.');
    }
    const turnId = randomUUID();
    conversation.status = 'running';
    conversation.activeTurnId = turnId;
    conversation.activeTurnElapsedMs = 0;
    conversation.error = null;
    this.resources.set(conversationResourceKey(conversation.id), conversation);
    this.projector?.beginTurn({
      turnId,
      clientMessageId: params.clientMessageId,
      text,
    });

    const runtime = this.runtime;
    void runtime.prompt(text).then(() => {
      this.finishTurn(conversation.id, false);
    }).catch((error) => {
      this.finishTurn(conversation.id, false, safeMessage(error));
    });
    return { accepted: true as const, turnId };
  }

  private interrupt(params: TurnInterruptParams) {
    const conversation = this.requiredConversation(params.conversationId);
    if (conversation.activeTurnId !== params.turnId || conversation.status === 'idle') {
      throw new RpcFault(-32014, 'The requested turn is no longer active.');
    }
    conversation.status = 'interrupting';
    this.resources.set(conversationResourceKey(conversation.id), conversation);
    const runtime = this.runtime;
    if (runtime) {
      void runtime.interrupt().catch((error) => this.finishTurn(conversation.id, true, safeMessage(error)));
    }
    return { accepted: true as const };
  }

  private applyRuntimeEvent(conversationId: string, event: RuntimeEvent) {
    const conversation = this.resources.get<ConversationValue>(conversationResourceKey(conversationId));
    if (!conversation || conversation.id !== conversationId) return;
    const turnId = conversation.activeTurnId;
    let conversationChanged = false;
    switch (event.type) {
      case 'assistant-start':
        if (turnId) this.projector?.assistantStarted(turnId);
        break;
      case 'assistant-text':
        if (turnId) this.projector?.appendAssistantText(turnId, event.delta);
        break;
      case 'assistant-reasoning':
        if (turnId) this.projector?.appendReasoning(turnId, event.delta);
        break;
      case 'assistant-complete':
        this.finishTurn(conversationId, event.interrupted, event.error);
        return;
      case 'tool-start':
        if (turnId) {
          this.projector?.startTool(turnId, {
            callId: event.callId,
            name: event.name,
            args: event.args,
          });
        }
        break;
      case 'tool-update': {
        if (turnId) this.projector?.updateTool(turnId, { callId: event.callId, result: event.result });
        break;
      }
      case 'tool-end': {
        if (turnId) {
          this.projector?.endTool(turnId, {
            callId: event.callId,
            result: event.result,
            isError: event.isError,
          });
        }
        break;
      }
      case 'context-probe':
        conversation.contextProbe = event.probe;
        conversationChanged = true;
        break;
    }
    if (conversationChanged) {
      this.resources.set(conversationResourceKey(conversationId), conversation);
    }
  }

  private finishTurn(conversationId: string, interrupted: boolean, error?: string) {
    const conversation = this.resources.get<ConversationValue>(conversationResourceKey(conversationId));
    if (!conversation || conversation.id !== conversationId || !conversation.activeTurnId) return;
    const turnId = conversation.activeTurnId;
    conversation.status = error ? 'error' : 'idle';
    conversation.activeTurnId = null;
    conversation.activeTurnElapsedMs = null;
    conversation.error = error ?? null;
    this.resources.set(conversationResourceKey(conversationId), conversation);
    this.projector?.finishTurn(turnId, {
      status: error ? 'failed' : interrupted ? 'interrupted' : 'completed',
      error: error ? { code: 'provider_error', message: error } : null,
    });
  }

  private requiredConversation(id: string) {
    if (this.conversationId !== id) throw new RpcFault(-32015, 'Conversation not found.');
    const conversation = this.resources.get<ConversationValue>(conversationResourceKey(id));
    if (!conversation) throw new RpcFault(-32015, 'Conversation not found.');
    return conversation;
  }

  private async disposeConversation() {
    const previous = this.runtime;
    this.runtime = null;
    this.projector = null;
    if (previous) await previous.dispose();
    if (this.conversationId) {
      this.resources.delete(conversationResourceKey(this.conversationId));
      this.conversationId = null;
    }
  }

  private readResources(params: ResourceReadParams) {
    return this.resources.read(params, (key, value) => {
      if (
        key.startsWith('conversation:') &&
        this.projector &&
        value &&
        typeof value === 'object' &&
        'activeTurnElapsedMs' in value
      ) {
        return {
          ...value,
          activeTurnElapsedMs: this.projector.activeElapsedMs(),
        } as ConversationValue;
      }
      return value;
    });
  }

  private readTranscriptResources(params: unknown) {
    if (!this.projector) throw new RpcFault(-32015, 'Conversation not found.');
    try {
      const parsed = parseTranscriptResourcesReadParams(params);
      return this.projector.read(parsed, this.resources.serverGeneration);
    } catch (error) {
      if (error instanceof TranscriptProtocolError) {
        throw new RpcFault(error.code, error.message);
      }
      throw error;
    }
  }

  private publishProjectorInvalidations(invalidations: AgentResourceInvalidation[]) {
    this.notify(AGENT_METHODS.resourcesInvalidated, {
      invalidations,
      serverGeneration: this.resources.serverGeneration,
    });
  }
}

function parseResourceRead(params: unknown): ResourceReadParams {
  const value = objectValue(params);
  if (!Array.isArray(value.requests)) throw new RpcFault(-32602, 'requests must be an array.');
  return {
    requests: value.requests.map((request) => {
      const item = objectValue(request);
      if (typeof item.key !== 'string' || !isResourceKey(item.key)) {
        throw new RpcFault(-32602, 'Unknown resource key.');
      }
      if (item.ifNoneMatch !== undefined && (!Number.isInteger(item.ifNoneMatch) || Number(item.ifNoneMatch) < 0)) {
        throw new RpcFault(-32602, 'ifNoneMatch must be a non-negative integer.');
      }
      return {
        key: item.key,
        ...(item.ifNoneMatch === undefined ? {} : { ifNoneMatch: Number(item.ifNoneMatch) }),
      };
    }),
  };
}

function parseConversationStart(params: unknown): ConversationStartParams {
  const value = objectValue(params);
  return {
    cwd: requiredString(value.cwd, 'cwd'),
    modelId: requiredString(value.modelId, 'modelId'),
    reasoning: reasoningLevel(value.reasoning),
  };
}

function parseMessageSend(params: unknown): MessageSendParams {
  const value = objectValue(params);
  return {
    conversationId: requiredString(value.conversationId, 'conversationId'),
    clientMessageId: requiredString(value.clientMessageId, 'clientMessageId'),
    text: requiredString(value.text, 'text'),
  };
}

function parseLoginCancel(params: unknown): LoginCancelParams {
  const value = objectValue(params);
  return { operationId: requiredString(value.operationId, 'operationId') };
}

function parseTurnInterrupt(params: unknown): TurnInterruptParams {
  const value = objectValue(params);
  return {
    conversationId: requiredString(value.conversationId, 'conversationId'),
    turnId: requiredString(value.turnId, 'turnId'),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcFault(-32602, 'Expected an object.');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0) throw new RpcFault(-32602, `${name} must be a non-empty string.`);
  return value;
}

function reasoningLevel(value: unknown): ReasoningLevel {
  if (value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value;
  }
  throw new RpcFault(-32602, 'Unknown reasoning level.');
}

async function canonicalDirectory(path: string) {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new RpcFault(-32602, 'cwd must name an existing directory.');
  }
}

function isResourceKey(value: string): value is ResourceReadParams['requests'][number]['key'] {
  return value === 'auth' || value === 'models' || /^conversation:[0-9a-f-]{36}$/u.test(value);
}

function sanitizeAuth(value: AuthValue): AuthValue {
  return {
    ...value,
    displayLabel: value.displayLabel ? safeMessage(value.displayLabel) : null,
    progress: value.progress ? safeMessage(value.progress) : null,
    error: value.error ? safeMessage(value.error) : null,
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

function publicAuthError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Sign-in was canceled.';
  return 'OpenAI sign-in failed. Please try again.';
}

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .slice(0, 1_000);
}
