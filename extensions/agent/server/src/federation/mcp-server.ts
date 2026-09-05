import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v3';

import type { NativeSessionRef } from '../../../shared/provider-runtime.ts';
import type { NativeAgentCoordinator } from '../native-runtime/native-coordinator.ts';
import type {
  JournalConversation,
  JournalExecution,
  NativeAgentJournal,
} from '../native-runtime/native-journal.ts';
import {
  FEDERATION_TOOLS,
  FederationAuthorizationError,
  FederationCredentialRegistry,
  resolveFederationTarget,
  type FederationCredentialScope,
  type FederationToolName,
} from './credential-registry.ts';
import {
  FEDERATION_PROGRESS_INTERVAL_MS,
  FEDERATION_TOOL_TIMEOUT_MS,
} from './constants.ts';

const TASK_LIMIT = 64 * 1024;
const MESSAGE_LIMIT = 64 * 1024;
const ID_LIMIT = 256;

const artifactSchema = z.object({
  artifactId: z.string().min(1).max(ID_LIMIT),
  mimeType: z.string().min(1).max(256),
  name: z.string().min(1).max(1_024).optional(),
  byteLength: z.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
}).strict();

const spawnSchema = z.object({
  task: z.string().min(1).max(TASK_LIMIT),
  target: z.object({
    providerInstanceId: z.string().min(1).max(ID_LIMIT),
    model: z.string().min(1).max(ID_LIMIT).optional(),
    effort: z.string().min(1).max(128).optional(),
  }).strict(),
  access: z.enum(['read-only', 'workspace-write']),
  scheduling: z.enum(['background', 'foreground']),
  attachments: z.array(artifactSchema).max(16).optional(),
}).strict();

const sendSchema = z.object({
  executionId: z.string().min(1).max(ID_LIMIT),
  message: z.string().min(1).max(MESSAGE_LIMIT),
}).strict();

const waitSchema = z.object({
  executionIds: z.array(z.string().min(1).max(ID_LIMIT)).min(1).max(16),
}).strict();

const executionSchema = z.object({
  executionId: z.string().min(1).max(ID_LIMIT),
}).strict();

const listSchema = z.object({
  state: z.enum(['active', 'idle', 'terminal', 'all']).optional(),
  limit: z.number().int().min(1).max(128).optional(),
}).strict();

export type RemuxFederationServerOptions = {
  journal: NativeAgentJournal;
  credentials: FederationCredentialRegistry;
  coordinator: () => NativeAgentCoordinator;
  generation: () => string;
  readTextArtifact?: (scope: { conversationId: string; executionId: string }, artifactId: string, turnId: string) => Promise<{
    text: string;
    mimeType: string;
    byteLength: number;
    sha256: string;
  }>;
  progressIntervalMs?: number;
  waitTimeoutMs?: number;
  now?: () => number;
};

/** Loopback-only, stateless Streamable HTTP MCP bridge for explicit cross-provider work. */
export class RemuxFederationServer {
  private readonly journal: NativeAgentJournal;
  private readonly credentials: FederationCredentialRegistry;
  private readonly coordinator: () => NativeAgentCoordinator;
  private readonly generation: () => string;
  private readonly readTextArtifact?: RemuxFederationServerOptions['readTextArtifact'];
  private readonly progressIntervalMs: number;
  private readonly waitTimeoutMs: number;
  private readonly now: () => number;
  private readonly transports = new Set<StreamableHTTPServerTransport>();
  private server: Server | undefined;
  private endpointValue: string | undefined;

  constructor(options: RemuxFederationServerOptions) {
    this.journal = options.journal;
    this.credentials = options.credentials;
    this.coordinator = options.coordinator;
    this.generation = options.generation;
    this.readTextArtifact = options.readTextArtifact;
    this.progressIntervalMs = options.progressIntervalMs ?? FEDERATION_PROGRESS_INTERVAL_MS;
    this.waitTimeoutMs = options.waitTimeoutMs ?? FEDERATION_TOOL_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  get endpoint() {
    if (!this.endpointValue) throw new Error('Remux federation server has not started.');
    return this.endpointValue;
  }

  async start() {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.requestTimeout = FEDERATION_TOOL_TIMEOUT_MS + 60_000;
    // The provider-specific MCP deadline is the hard wall-clock bound. Do not
    // let Node's socket-idle timer terminate an otherwise healthy SSE wait.
    server.timeout = 0;
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', failed);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Remux federation server did not acquire a loopback TCP port.');
    }
    this.server = server;
    this.endpointValue = `http://127.0.0.1:${address.port}/mcp`;
  }

  issueForSession(input: {
    conversationId: string;
    executionId: string;
    providerInstanceId: string;
  }) {
    const execution = this.journal.execution(input.executionId);
    const conversation = this.journal.conversation(input.conversationId);
    if (!execution || !conversation || execution.conversationId !== conversation.conversationId ||
        execution.providerInstanceId !== input.providerInstanceId) {
      throw new Error('Cannot issue federation credentials for an unknown provider execution.');
    }
    const credential = this.credentials.issue({
      generation: this.generation(),
      conversationId: conversation.conversationId,
      executionId: execution.executionId,
      provider: execution.provider,
      providerInstanceId: execution.providerInstanceId,
      access: execution.access ?? conversation.access,
      depth: execution.federationDepth,
      tools: FEDERATION_TOOLS,
      targetCatalog: this.coordinator().federationTargetCatalog(execution.provider),
    });
    return {
      endpoint: this.endpoint,
      authorizationHeader: `Bearer ${credential.token}`,
      bindNativeSession: (nativeSession: NativeSessionRef) => credential.bindNativeSession(nativeSession),
      touch: () => credential.touch(),
      revoke: () => credential.revoke(),
    };
  }

  async close() {
    this.credentials.revokeAll();
    const transports = [...this.transports];
    this.transports.clear();
    await Promise.allSettled(transports.map((transport) => transport.close()));
    const server = this.server;
    this.server = undefined;
    this.endpointValue = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    try {
      if (!this.isLoopbackRequest(request)) {
        this.writeHttpError(response, 403, 'Forbidden.');
        return;
      }
      if (request.method !== 'POST' || request.url !== '/mcp') {
        this.writeHttpError(response, 405, 'Method not allowed.');
        return;
      }
      const token = bearerToken(request.headers.authorization);
      if (!token) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        this.writeHttpError(response, 401, 'Unauthorized.');
        return;
      }
      const scope = this.credentials.resolve(token, this.generation());
      this.validateLiveScope(scope);
      const mcp = this.createMcpServer(scope, token);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: false,
        keepAliveMs: FEDERATION_PROGRESS_INTERVAL_MS,
      });
      this.transports.add(transport);
      try {
        await mcp.connect(transport);
        await transport.handleRequest(request, response);
      } finally {
        this.transports.delete(transport);
        await Promise.allSettled([transport.close(), mcp.close()]);
      }
    } catch (error) {
      if (!response.headersSent) {
        this.writeHttpError(
          response,
          error instanceof FederationAuthorizationError ? 401 : 500,
          safeError(error),
        );
      }
      else if (!response.writableEnded) response.end();
    }
  }

  private createMcpServer(scope: FederationCredentialScope, token: string) {
    const server = new McpServer({ name: 'remux-federation', version: '1.0.0' });
    const descriptions = federationToolDescriptions(scope);
    server.registerResource(
      'federated-final-answer',
      new ResourceTemplate('remux-federation://result/{executionId}/{turnId}', { list: undefined }),
      {
        title: 'Federated child final answer',
        description: 'Complete terminal answer for an owned federated child turn.',
        mimeType: 'text/plain; charset=utf-8',
      },
      async (uri, variables) => {
        const executionId = templateVariable(variables.executionId, 'executionId');
        const turnId = templateVariable(variables.turnId, 'turnId');
        this.requireOwnedExecution(scope, executionId);
        const turn = this.journal.turn(turnId);
        if (!turn || turn.executionId !== executionId || !turn.assistantArtifactId || !turn.outcome) {
          throw new Error('Federated final-answer artifact is unavailable.');
        }
        if (!this.readTextArtifact) throw new Error('Federated artifact storage is unavailable.');
        const artifact = await this.readTextArtifact({
          conversationId: turn.conversationId,
          executionId,
        }, turn.assistantArtifactId, turnId);
        return {
          contents: [{
            uri: uri.href,
            mimeType: artifact.mimeType,
            text: artifact.text,
          }],
        };
      },
    );
    // The MCP SDK's Zod-v3/v4 compatibility generic currently exceeds
    // TypeScript's instantiation depth. Keep that instability at this one seam
    // and parse again in every handler so the coordinator only sees strict,
    // bounded inputs.
    const registerTool = server.registerTool.bind(server) as unknown as LooseRegisterTool;
    registerTool('remux_list_agents', {
      description: descriptions.list,
      inputSchema: listSchema,
    }, async (unparsed) => {
      const input = listSchema.parse(unparsed);
      this.requireTool(scope, 'remux_list_agents');
      this.activeContext(scope);
      const limit = input.limit ?? 32;
      const state = input.state ?? 'all';
      const candidates = this.journal.executionsForConversation(scope.conversationId)
        .filter((execution) => execution.ownership === 'federated' &&
          this.isOwnedExecution(scope, execution))
        .map((execution) => {
          const closed = this.journal.nativeSessionState(execution.executionId) === 'closed';
          const active = execution.state === 'running' || execution.state === 'recovering';
          const idle = execution.state === 'idle' && !closed;
          const capabilities = this.journal.providerInstance(execution.providerInstanceId)
            ?.probe.capabilities;
          return {
            execution,
            category: active ? 'active' as const : idle ? 'idle' as const : 'terminal' as const,
            value: {
              executionId: execution.executionId,
              providerInstanceId: execution.providerInstanceId,
              provider: execution.provider,
              model: execution.model ?? null,
              state: execution.state,
              scheduling: execution.federationScheduling ?? 'background',
              access: execution.access ?? 'read-only',
              summary: execution.summary ? boundedDescriptor(execution.summary, 4_096) : null,
              canSendMessage: !active && !closed,
              canWait: active,
              canInterrupt: active && capabilities?.turns.interrupt === true,
              canClose: !closed,
              createdAt: execution.createdAt,
              updatedAt: execution.updatedAt,
            },
          };
        })
        .filter(({ category }) => state === 'all' || category === state)
        .sort((left, right) => {
          const leftRank = left.category === 'active' ? 0 : left.category === 'idle' ? 1 : 2;
          const rightRank = right.category === 'active' ? 0 : right.category === 'idle' ? 1 : 2;
          return leftRank - rightRank || right.execution.updatedAt - left.execution.updatedAt ||
            left.execution.executionId.localeCompare(right.execution.executionId);
        });
      return toolResult({
        agents: candidates.slice(0, limit).map(({ value }) => value),
        truncated: candidates.length > limit,
      });
    });

    registerTool('remux_spawn_agent', {
      description: descriptions.spawn,
      inputSchema: spawnSchema,
    }, async (unparsed, extra) => {
      const input = spawnSchema.parse(unparsed);
      this.requireTool(scope, 'remux_spawn_agent');
      const context = this.activeContext(scope);
      const target = resolveFederationTarget(scope, input.target);
      const commandId = commandIdentity(token, context.callerTurnId, 'spawn', extra.requestId);
      const spawned = await this.coordinator().spawnFederatedAgent({
        commandId,
        parentConversationId: scope.conversationId,
        parentExecutionId: scope.executionId,
        rootTurnId: context.rootTurnId,
        targetProviderInstanceId: target.providerInstanceId,
        task: input.task,
        access: input.access,
        scheduling: input.scheduling,
        depth: scope.depth + 1,
        model: target.model,
        ...(target.effort ? { effort: target.effort } : {}),
        ...(input.attachments ? {
          attachments: input.attachments.map((artifact) => ({
            type: 'image-artifact' as const,
            ...artifact,
          })),
        } : {}),
      });
      if (input.scheduling === 'background') return toolResult(spawned);
      return toolResult(await this.waitWithProgress(
        [spawned.executionId],
        extra,
        (signal) => this.coordinator().waitForFederatedExecution(spawned.executionId, signal),
      ));
    });

    registerTool('remux_send_message', {
      description: descriptions.send,
      inputSchema: sendSchema,
    }, async (unparsed, extra) => {
      const input = sendSchema.parse(unparsed);
      this.requireTool(scope, 'remux_send_message');
      this.requireOwnedExecution(scope, input.executionId);
      const context = this.activeContext(scope);
      const commandId = commandIdentity(token, context.callerTurnId, 'send', extra.requestId);
      await this.coordinator().sendFederatedMessage({
        commandId,
        executionId: input.executionId,
        message: input.message,
      });
      return toolResult(await this.waitWithProgress(
        [input.executionId],
        extra,
        (signal) => this.coordinator().waitForFederatedExecution(input.executionId, signal),
      ));
    });

    registerTool('remux_wait_agent', {
      description: descriptions.wait,
      inputSchema: waitSchema,
    }, async (unparsed, extra) => {
      const input = waitSchema.parse(unparsed);
      this.requireTool(scope, 'remux_wait_agent');
      for (const executionId of input.executionIds) this.requireOwnedExecution(scope, executionId);
      const results = await this.waitWithProgress(input.executionIds, extra, (signal) =>
        Promise.all(input.executionIds.map((executionId) =>
          this.coordinator().waitForFederatedExecution(executionId, signal))));
      return toolResult(results);
    });

    registerTool('remux_interrupt_agent', {
      description: descriptions.interrupt,
      inputSchema: executionSchema,
    }, async (unparsed, extra) => {
      const input = executionSchema.parse(unparsed);
      this.requireTool(scope, 'remux_interrupt_agent');
      this.requireOwnedExecution(scope, input.executionId);
      const context = this.activeContext(scope);
      return toolResult(await this.coordinator().interruptFederatedExecution(
        commandIdentity(token, context.callerTurnId, 'interrupt', extra.requestId),
        input.executionId,
      ));
    });

    registerTool('remux_close_agent', {
      description: descriptions.close,
      inputSchema: executionSchema,
    }, async (unparsed, extra) => {
      const input = executionSchema.parse(unparsed);
      this.requireTool(scope, 'remux_close_agent');
      this.requireOwnedExecution(scope, input.executionId);
      const context = this.activeContext(scope);
      return toolResult(await this.coordinator().closeFederatedExecution(
        commandIdentity(token, context.callerTurnId, 'close', extra.requestId),
        input.executionId,
      ));
    });
    return server;
  }

  private async waitWithProgress<T>(
    executionIds: readonly string[],
    extra: LooseHandlerExtra,
    wait: (signal: AbortSignal) => Promise<T>,
  ) {
    const progressToken = extra._meta?.progressToken;
    const startedAt = this.now();
    let sequence = 0;
    let notificationTail = Promise.resolve();
    const notify = (message: string) => {
      if (progressToken === undefined || !extra.sendNotification) return notificationTail;
      const progress = ++sequence;
      notificationTail = notificationTail
        .then(() => extra.sendNotification!({
          method: 'notifications/progress',
          params: { progressToken, progress, message },
        }))
        // A progress notification is advisory. A disconnected parent will
        // abort the request through extra.signal; a notification failure must
        // not mutate or replay the already accepted child turn.
        .catch(() => undefined);
      return notificationTail;
    };
    await notify(progressMessage(executionIds, 'started', 0));
    const timer = setInterval(() => {
      const elapsedMs = Math.max(0, this.now() - startedAt);
      void notify(progressMessage(executionIds, 'running', elapsedMs));
    }, this.progressIntervalMs);
    timer.unref();
    const waitController = new AbortController();
    let deadlineExpired = false;
    const callerAborted = () => waitController.abort();
    if (extra.signal?.aborted) callerAborted();
    else extra.signal?.addEventListener('abort', callerAborted, { once: true });
    const deadline = setTimeout(() => {
      deadlineExpired = true;
      waitController.abort();
    }, this.waitTimeoutMs);
    deadline.unref();
    try {
      const result = await wait(waitController.signal);
      await notificationTail;
      await notify(progressMessage(executionIds, 'completed', Math.max(0, this.now() - startedAt)));
      return result;
    } catch (error) {
      if (deadlineExpired) {
        throw new Error(
          `Federation wait exceeded ${this.waitTimeoutMs} ms; the accepted child continues in the background.`,
        );
      }
      throw error;
    } finally {
      clearInterval(timer);
      clearTimeout(deadline);
      extra.signal?.removeEventListener('abort', callerAborted);
      await notificationTail;
    }
  }

  private activeContext(scope: FederationCredentialScope) {
    this.validateLiveScope(scope);
    const conversation = this.journal.conversation(scope.conversationId)!;
    const execution = this.journal.execution(scope.executionId)!;
    const activeTurn = this.activeTurn(execution, conversation);
    if (!activeTurn) throw new Error('Federation is available only while the calling execution has an active turn.');
    const rootTurnId = execution.ownership === 'root'
      ? activeTurn.turnId
      : execution.rootTurnId;
    if (!rootTurnId) throw new Error('Federation caller has no owning root turn.');
    return { conversation, execution, rootTurnId, callerTurnId: activeTurn.turnId };
  }

  private activeTurn(execution: JournalExecution, conversation: JournalConversation) {
    if (execution.ownership === 'root') {
      return conversation.activeTurnId ? this.journal.turn(conversation.activeTurnId) : undefined;
    }
    return this.journal.turnsForExecution(execution.executionId)
      .filter((turn) =>
        (turn.state === 'running' || turn.state === 'recovering'))
      .at(-1);
  }

  private validateLiveScope(scope: FederationCredentialScope) {
    const execution = this.journal.execution(scope.executionId);
    const conversation = this.journal.conversation(scope.conversationId);
    const nativeSession = this.journal.nativeSession(scope.executionId);
    if (!execution || !conversation || execution.conversationId !== scope.conversationId ||
        execution.provider !== scope.provider ||
        execution.providerInstanceId !== scope.providerInstanceId ||
        nativeSession?.sessionId !== scope.nativeSessionId) {
      throw new FederationAuthorizationError(
        'Federation credential no longer matches its native provider execution.',
      );
    }
  }

  private requireOwnedExecution(scope: FederationCredentialScope, executionId: string) {
    this.activeContext(scope);
    let current = this.journal.execution(executionId);
    if (!current || current.ownership !== 'federated' || current.conversationId !== scope.conversationId) {
      throw new Error('Federated execution is outside this credential scope.');
    }
    if (this.isOwnedExecution(scope, current)) return current;
    throw new Error('Federated execution is outside this credential scope.');
  }

  private isOwnedExecution(scope: FederationCredentialScope, execution: JournalExecution) {
    let current: JournalExecution | undefined = execution;
    while (current.parentExecutionId) {
      if (current.parentExecutionId === scope.executionId) return true;
      current = this.journal.execution(current.parentExecutionId);
      if (!current) break;
    }
    return false;
  }

  private requireTool(scope: FederationCredentialScope, tool: FederationToolName) {
    if (!scope.tools.includes(tool)) throw new Error(`Federation tool ${tool} is outside this credential scope.`);
  }

  private isLoopbackRequest(request: IncomingMessage) {
    const remote = request.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false;
    if (!this.endpointValue) return false;
    const endpoint = new URL(this.endpointValue);
    if (request.headers.host !== endpoint.host) return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
    } catch {
      return false;
    }
  }

  private writeHttpError(response: ServerResponse, status: number, message: string) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: message.slice(0, 1_000) },
      id: null,
    }));
  }
}

type LooseRegisterTool = (
  name: string,
  config: { description: string; inputSchema: unknown },
  handler: (
    input: unknown,
    extra: LooseHandlerExtra,
  ) => Promise<ReturnType<typeof toolResult>>,
) => void;

type LooseHandlerExtra = {
  requestId: unknown;
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message: string };
  }) => Promise<void>;
};

function progressMessage(
  executionIds: readonly string[],
  state: 'started' | 'running' | 'completed',
  elapsedMs: number,
) {
  const subject = executionIds.length === 1
    ? `Federated child ${executionIds[0]}`
    : `${executionIds.length} federated children`;
  if (state === 'started') return `${subject} accepted; waiting for native completion.`;
  const elapsedSeconds = Math.floor(elapsedMs / 1_000);
  if (state === 'completed') return `${subject} reached a terminal boundary after ${elapsedSeconds}s.`;
  return `${subject} is still running · ${elapsedSeconds}s elapsed.`;
}

function federationToolDescriptions(scope: FederationCredentialScope) {
  const catalog = formatTargetCatalog(scope);
  return {
    list: [
      'List bounded handles for federated children owned by this execution lineage.',
      'Use this after compaction or when an executionId is no longer in context; it returns addresses and status, not transcripts.',
      'Active work sorts first. Filters are active, idle, terminal, or all.',
    ].join(' '),
    spawn: [
      'Start a new native agent session on a different provider for an explicit, self-contained task.',
      'Use the provider\'s native subagents instead when the work should stay on the same provider.',
      'Write a complete, testable brief because hidden reasoning and the parent transcript are not copied.',
      'foreground waits until the child is idle and returns its final answer; background returns an execution handle for remux_wait_agent.',
      'workspace-write requires foreground scheduling. Reuse the returned executionId with remux_send_message for focused corrections.',
      catalog,
    ].join(' '),
    send: [
      'Send ordinary follow-up text to an idle federated child and wait for its new turn to finish.',
      'The same native provider session continues with its full context, so prefer this over spawning another child for a focused correction.',
      'The result contains the new turn\'s final answer and observed changed files.',
    ].join(' '),
    wait: [
      'Wait for one or more owned background federated children without creating another session or turn.',
      'Each terminal result contains that child\'s final answer and observed changed files.',
    ].join(' '),
    interrupt: [
      'Request interruption of a running owned federated child.',
      'This does not delete its provider-native history; the child may remain recovering until its provider confirms a terminal state.',
    ].join(' '),
    close: [
      'Close an owned federated child, revoke its scoped federation credential, and release its scheduler resources.',
      'This does not delete provider-native history, but the execution can no longer receive follow-ups through this session.',
    ].join(' '),
  };
}

function formatTargetCatalog(scope: FederationCredentialScope) {
  if (scope.targetCatalog.length === 0) {
    return 'No different-provider target is currently ready; do not call this tool until one appears.';
  }
  const entries = scope.targetCatalog.map((target) => {
    const models = target.models.length === 0
      ? 'no models advertised'
      : target.models.map((model) => {
          const effort = model.supportedEffort.length > 0
            ? `; effort: ${model.supportedEffort.join('|')}`
            : '';
          return `${model.id} (${boundedDescriptor(model.name, 160)}${model.isDefault ? '; default' : ''}${effort})`;
        }).join(', ');
    return `${target.providerInstanceId} [${target.provider}; ${boundedDescriptor(target.label, 160)}]: ${models}`;
  });
  return `Available cross-provider targets: ${boundedDescriptor(entries.join(' ; '), 12_000)}.`;
}

function boundedDescriptor(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function bearerToken(header: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header ?? '');
  return match?.[1];
}

export function commandIdentity(
  token: string,
  callerTurnId: string,
  operation: string,
  requestId: unknown,
) {
  const digest = createHash('sha256')
    .update(token)
    .update('\0')
    .update(callerTurnId)
    .update('\0')
    .update(operation)
    .update('\0')
    .update(stableJson(requestId))
    .digest('hex');
  return `federation-${digest}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function toolResult(value: unknown): CallToolResult {
  const resourceLinks = federatedResultResourceLinks(value);
  return {
    content: [
      { type: 'text', text: JSON.stringify(value) },
      ...resourceLinks,
    ],
  };
}

type FederationResultResourceLink = {
  type: 'resource_link';
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  size: number;
};

function federatedResultResourceLinks(value: unknown): FederationResultResourceLink[] {
  const links = new Map<string, FederationResultResourceLink>();
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    const record = candidate as Record<string, unknown>;
    const finalAnswer = record.finalAnswer;
    if (finalAnswer && typeof finalAnswer === 'object' && !Array.isArray(finalAnswer)) {
      const answer = finalAnswer as Record<string, unknown>;
      const artifact = answer.artifact;
      if (answer.kind === 'artifact' && artifact && typeof artifact === 'object' && !Array.isArray(artifact)) {
        const metadata = artifact as Record<string, unknown>;
        if (typeof metadata.uri === 'string' && typeof metadata.mimeType === 'string' &&
            typeof metadata.byteLength === 'number') {
          links.set(metadata.uri, {
            type: 'resource_link',
            uri: metadata.uri,
            name: `Federated child final answer${typeof record.turnId === 'string' ? ` · ${record.turnId}` : ''}`,
            description: 'Complete final answer; read this resource before reviewing the child result.',
            mimeType: metadata.mimeType,
            size: metadata.byteLength,
          });
        }
      }
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
  return [...links.values()];
}

function templateVariable(value: string | string[], name: string) {
  const resolved = Array.isArray(value) ? value[0] : value;
  if (!resolved || resolved.length > ID_LIMIT) throw new Error(`Invalid federated result ${name}.`);
  return resolved;
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .slice(0, 1_000);
}
