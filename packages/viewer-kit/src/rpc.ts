export type RpcContract =
  | Readonly<{ kind: 'query'; resourceKey?: string }>
  | Readonly<{
      kind: 'command';
      operationId?: string;
      preconditionRevision?: number;
    }>
  | Readonly<{ kind: 'job-start'; operationId: string }>
  | Readonly<{ kind: 'subscription'; resourceKey?: string }>;

export type RpcRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type RpcQueryOptions = RpcRequestOptions &
  Readonly<{
    resourceKey?: string;
  }>;

export type RpcCommandOptions = RpcRequestOptions &
  Readonly<{
    operationId?: string;
    preconditionRevision?: number;
  }>;

export type RpcJobOptions = RpcRequestOptions &
  Readonly<{
    operationId: string;
  }>;

export type RpcSubscriptionOptions = RpcRequestOptions &
  Readonly<{
    resourceKey?: string;
  }>;

export type RpcRequest = <T>(
  method: string,
  params: unknown,
  contract: RpcContract,
  options?: RpcRequestOptions,
) => Promise<T>;

export type SemanticRpcClient = Readonly<{
  command: <T>(method: string, params?: unknown, options?: RpcCommandOptions) => Promise<T>;
  query: <T>(method: string, params?: unknown, options?: RpcQueryOptions) => Promise<T>;
  startJob: <T>(method: string, params: unknown, options: RpcJobOptions) => Promise<T>;
  subscribe: <T>(
    method: string,
    params?: unknown,
    options?: RpcSubscriptionOptions,
  ) => Promise<T>;
}>;

export function createSemanticRpcClient(request: RpcRequest): SemanticRpcClient {
  return Object.freeze({
    command: <T>(method: string, params?: unknown, options: RpcCommandOptions = {}) =>
      request<T>(
        method,
        params,
        {
          kind: 'command',
          ...(options.operationId ? { operationId: options.operationId } : {}),
          ...(options.preconditionRevision !== undefined
            ? { preconditionRevision: options.preconditionRevision }
            : {}),
        },
        options,
      ),
    query: <T>(method: string, params?: unknown, options: RpcQueryOptions = {}) =>
      request<T>(
        method,
        params,
        {
          kind: 'query',
          ...(options.resourceKey ? { resourceKey: options.resourceKey } : {}),
        },
        options,
      ),
    startJob: <T>(method: string, params: unknown, options: RpcJobOptions) =>
      request<T>(method, params, { kind: 'job-start', operationId: options.operationId }, options),
    subscribe: <T>(
      method: string,
      params?: unknown,
      options: RpcSubscriptionOptions = {},
    ) =>
      request<T>(
        method,
        params,
        {
          kind: 'subscription',
          ...(options.resourceKey ? { resourceKey: options.resourceKey } : {}),
        },
        options,
      ),
  });
}

export function createAbortError(reason?: unknown): Error {
  const message = typeof reason === 'string' && reason.length > 0 ? reason : 'Request canceled';
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
