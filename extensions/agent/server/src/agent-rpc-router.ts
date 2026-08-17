import {
  AGENT_METHODS,
  type AgentFileSearchParams,
  type ArtifactReadParams,
  type ConversationCreateParams,
  type LoginCancelParams,
  type MessageBranchParams,
  type MessageQueueMutationParams,
  type MessageSendParams,
  type ReasoningLevel,
  type ResourceReadParams,
  type TurnInterruptParams,
  type TurnReadParams,
  type TurnContextOverride,
  type TurnContextPlan,
} from '../../shared/protocol.ts';
import { agentPromptText, parseAgentComposerParts } from './user-input.ts';

const MAX_ARTIFACT_READ_BYTES = 48 * 1024;
const MAX_ARTIFACT_READ_LINES = 400;
const MAX_RESOURCE_READ_REQUESTS = 64;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

type AgentRpcHandlers = {
  readResources: (params: ResourceReadParams) => Promise<unknown>;
  readTranscriptResources: (params: unknown) => Promise<unknown>;
  readModels: () => Promise<unknown>;
  readArtifact: (params: ArtifactReadParams) => Promise<unknown>;
  readTurn: (params: TurnReadParams) => Promise<unknown>;
  searchFiles: (params: AgentFileSearchParams) => Promise<unknown>;
  startLogin: () => unknown;
  cancelLogin: (params: LoginCancelParams) => unknown;
  logout: () => Promise<unknown>;
  createConversation: (params: ConversationCreateParams) => Promise<unknown>;
  sendMessage: (params: MessageSendParams) => Promise<unknown>;
  removeQueuedMessage: (params: MessageQueueMutationParams) => Promise<unknown>;
  runQueuedMessageNow: (params: MessageQueueMutationParams) => Promise<unknown>;
  branchMessage: (
    params: MessageBranchParams,
    mode: 'edit' | 'fork',
  ) => Promise<unknown>;
  interruptTurn: (params: TurnInterruptParams) => unknown;
};

/** Owns the public RPC surface: method dispatch and wire-value validation. */
export class AgentRpcRouter {
  private readonly handlers: AgentRpcHandlers;

  constructor(handlers: AgentRpcHandlers) {
    this.handlers = handlers;
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case AGENT_METHODS.resourcesRead:
        return this.handlers.readResources(parseResourceRead(params));
      case AGENT_METHODS.transcriptResourcesRead:
        return this.handlers.readTranscriptResources(params);
      case AGENT_METHODS.modelsRead:
        return this.handlers.readModels();
      case AGENT_METHODS.artifactRead:
        return this.handlers.readArtifact(parseArtifactRead(params));
      case AGENT_METHODS.turnRead:
        return this.handlers.readTurn(parseTurnRead(params));
      case AGENT_METHODS.filesSearch:
        return this.handlers.searchFiles(parseFileSearch(params));
      case AGENT_METHODS.authLoginStart:
        return this.handlers.startLogin();
      case AGENT_METHODS.authLoginCancel:
        return this.handlers.cancelLogin(parseLoginCancel(params));
      case AGENT_METHODS.authLogout:
        return this.handlers.logout();
      case AGENT_METHODS.conversationCreate:
        return this.handlers.createConversation(parseConversationCreate(params));
      case AGENT_METHODS.messageSend:
        return this.handlers.sendMessage(parseMessageSend(params));
      case AGENT_METHODS.messageQueueRemove:
        return this.handlers.removeQueuedMessage(parseMessageQueueMutation(params));
      case AGENT_METHODS.messageQueueRunNow:
        return this.handlers.runQueuedMessageNow(parseMessageQueueMutation(params));
      case AGENT_METHODS.messageEdit:
        return this.handlers.branchMessage(parseMessageBranch(params), 'edit');
      case AGENT_METHODS.messageFork:
        return this.handlers.branchMessage(parseMessageBranch(params), 'fork');
      case AGENT_METHODS.turnInterrupt:
        return this.handlers.interruptTurn(parseTurnInterrupt(params));
      default:
        throw new RpcFault(-32601, `Method not found: ${method}`);
    }
  }
}

function parseResourceRead(params: unknown): ResourceReadParams {
  const value = objectValue(params);
  if (!Array.isArray(value.requests)) throw new RpcFault(-32602, 'requests must be an array.');
  if (value.requests.length > MAX_RESOURCE_READ_REQUESTS) {
    throw new RpcFault(-32602, `requests exceeds the ${MAX_RESOURCE_READ_REQUESTS} item limit.`);
  }
  const seen = new Set<string>();
  return {
    requests: value.requests.map((request) => {
      const item = objectValue(request);
      if (typeof item.key !== 'string' || !isResourceKey(item.key)) {
        throw new RpcFault(-32602, 'Unknown resource key.');
      }
      if (seen.has(item.key)) {
        throw new RpcFault(-32602, 'requests contains a duplicate resource key.');
      }
      seen.add(item.key);
      if (
        item.ifNoneMatch !== undefined &&
        (!Number.isInteger(item.ifNoneMatch) || Number(item.ifNoneMatch) < 0)
      ) {
        throw new RpcFault(-32602, 'ifNoneMatch must be a non-negative integer.');
      }
      return {
        key: item.key,
        ...(item.ifNoneMatch === undefined ? {} : { ifNoneMatch: Number(item.ifNoneMatch) }),
      };
    }),
  };
}

function parseConversationCreate(params: unknown): ConversationCreateParams {
  const value = objectValue(params);
  return {
    operationId: requiredUuidV4(value.operationId, 'operationId'),
    cwd: requiredString(value.cwd, 'cwd'),
    modelId: requiredString(value.modelId, 'modelId'),
    reasoning: reasoningLevel(value.reasoning),
  };
}

function parseArtifactRead(params: unknown): ArtifactReadParams {
  const value = objectValue(params);
  const hash = requiredString(value.hash, 'hash');
  if (!SHA256.test(hash)) throw new RpcFault(-32602, 'hash must be a lowercase SHA-256 digest.');
  const range = objectValue(value.range);
  if (range.kind === 'bytes') {
    return {
      hash,
      range: {
        kind: 'bytes',
        offset: boundedInteger(range.offset, 'range.offset', 0, Number.MAX_SAFE_INTEGER),
        byteLength: boundedInteger(range.byteLength, 'range.byteLength', 1, MAX_ARTIFACT_READ_BYTES),
      },
    };
  }
  if (range.kind === 'utf8') {
    return {
      hash,
      range: {
        kind: 'utf8',
        offset: boundedInteger(range.offset, 'range.offset', 0, Number.MAX_SAFE_INTEGER),
        byteLength: boundedInteger(range.byteLength, 'range.byteLength', 1, MAX_ARTIFACT_READ_BYTES),
      },
    };
  }
  if (range.kind === 'lines') {
    return {
      hash,
      range: {
        kind: 'lines',
        startLine: boundedInteger(range.startLine, 'range.startLine', 1, Number.MAX_SAFE_INTEGER),
        lineCount: boundedInteger(range.lineCount, 'range.lineCount', 1, MAX_ARTIFACT_READ_LINES),
      },
    };
  }
  throw new RpcFault(-32602, 'range.kind must be bytes, utf8, or lines.');
}

function parseTurnRead(params: unknown): TurnReadParams {
  const value = objectValue(params);
  return {
    conversationId: requiredUuidV4(value.conversationId, 'conversationId'),
    turnId: requiredUuidV4(value.turnId, 'turnId'),
  };
}

function parseFileSearch(params: unknown): AgentFileSearchParams {
  const value = objectValue(params);
  return {
    cwd: requiredString(value.cwd, 'cwd'),
    limit: value.limit === undefined ? 80 : boundedInteger(value.limit, 'limit', 1, 80),
    query: requiredString(value.query, 'query'),
  };
}

function parseMessageSend(params: unknown): MessageSendParams {
  const value = objectValue(params);
  if (value.parts === undefined) {
    return {
      operationId: requiredUuidV4(value.operationId, 'operationId'),
      conversationId: requiredUuidV4(value.conversationId, 'conversationId'),
      clientMessageId: requiredUuidV4(value.clientMessageId, 'clientMessageId'),
      modelId: requiredString(value.modelId, 'modelId'),
      contextPlan: parseTurnContextPlan(value.contextPlan),
      reasoning: reasoningLevel(value.reasoning),
      text: requiredString(value.text, 'text'),
    };
  }
  let parts;
  try {
    parts = parseAgentComposerParts(value.parts);
  } catch (error) {
    throw new RpcFault(-32602, safeMessage(error));
  }
  return {
    operationId: requiredUuidV4(value.operationId, 'operationId'),
    conversationId: requiredUuidV4(value.conversationId, 'conversationId'),
    clientMessageId: requiredUuidV4(value.clientMessageId, 'clientMessageId'),
    modelId: requiredString(value.modelId, 'modelId'),
    contextPlan: parseTurnContextPlan(value.contextPlan),
    reasoning: reasoningLevel(value.reasoning),
    parts,
    text: agentPromptText(parts),
  };
}

function parseTurnContextPlan(value: unknown): TurnContextPlan {
  const plan = objectValue(value);
  if (plan.version !== 1) throw new RpcFault(-32602, 'contextPlan.version must be 1.');
  const automaticDialogueTurns = boundedInteger(
    plan.automaticDialogueTurns,
    'contextPlan.automaticDialogueTurns',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (!Array.isArray(plan.overrides)) {
    throw new RpcFault(-32602, 'contextPlan.overrides must be an array.');
  }
  const seen = new Set<string>();
  const overrides = plan.overrides.map((entry, index) => {
    const override = objectValue(entry);
    const turnId = requiredUuidV4(override.turnId, `contextPlan.overrides[${index}].turnId`);
    if (seen.has(turnId)) throw new RpcFault(-32602, `contextPlan override ${turnId} is duplicated.`);
    seen.add(turnId);
    if (
      override.resolution !== 'off' &&
      override.resolution !== 'dialogue' &&
      override.resolution !== 'full'
    ) {
      throw new RpcFault(-32602, `contextPlan override ${turnId} has an invalid resolution.`);
    }
    return { turnId, resolution: override.resolution as TurnContextOverride['resolution'] };
  });
  return { version: 1, automaticDialogueTurns, overrides };
}

function parseMessageQueueMutation(params: unknown): MessageQueueMutationParams {
  const value = objectValue(params);
  return {
    conversationId: requiredUuidV4(value.conversationId, 'conversationId'),
    operationId: requiredUuidV4(value.operationId, 'operationId'),
  };
}

function parseMessageBranch(params: unknown): MessageBranchParams {
  const value = objectValue(params);
  let parts;
  try {
    parts = parseAgentComposerParts(value.parts);
  } catch (error) {
    throw new RpcFault(-32602, safeMessage(error));
  }
  return {
    operationId: requiredUuidV4(value.operationId, 'operationId'),
    clientMessageId: requiredUuidV4(value.clientMessageId, 'clientMessageId'),
    modelId: requiredString(value.modelId, 'modelId'),
    contextPlan: parseTurnContextPlan(value.contextPlan),
    reasoning: reasoningLevel(value.reasoning),
    sourceConversationId: requiredUuidV4(value.sourceConversationId, 'sourceConversationId'),
    sourceTurnId: requiredUuidV4(value.sourceTurnId, 'sourceTurnId'),
    sourceMessageId: requiredUuidV4(value.sourceMessageId, 'sourceMessageId'),
    parts,
    text: agentPromptText(parts),
  };
}

function parseLoginCancel(params: unknown): LoginCancelParams {
  const value = objectValue(params);
  return { operationId: requiredUuidV4(value.operationId, 'operationId') };
}

function parseTurnInterrupt(params: unknown): TurnInterruptParams {
  const value = objectValue(params);
  return {
    conversationId: requiredUuidV4(value.conversationId, 'conversationId'),
    turnId: requiredUuidV4(value.turnId, 'turnId'),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcFault(-32602, 'Expected an object.');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcFault(-32602, `${name} must be a non-empty string.`);
  }
  return value;
}

function requiredUuidV4(value: unknown, name: string) {
  const id = requiredString(value, name);
  if (!UUID_V4.test(id)) throw new RpcFault(-32602, `${name} must be a lowercase UUID v4.`);
  return id;
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RpcFault(-32602, `${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function reasoningLevel(value: unknown): ReasoningLevel {
  if (
    value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' ||
    value === 'high' || value === 'xhigh' || value === 'max'
  ) {
    return value;
  }
  throw new RpcFault(-32602, 'Unknown reasoning level.');
}

function isResourceKey(value: string): value is ResourceReadParams['requests'][number]['key'] {
  return value === 'auth' || value === 'models' || value === 'conversation-list' ||
    value === 'runtime' ||
    (value.startsWith('conversation:') && UUID_V4.test(value.slice('conversation:'.length))) ||
    (value.startsWith('context:') && UUID_V4.test(value.slice('context:'.length))) ||
    (value.startsWith('queue:') && UUID_V4.test(value.slice('queue:'.length)));
}

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .slice(0, 1_000);
}
