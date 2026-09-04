import { createInterface } from 'node:readline';

export class RpcFault extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcFault';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

export type JsonRpcRequestContext = {
  requestId: string | number | null;
  signal: AbortSignal;
};

type PendingRequestControllers = Map<string | number, AbortController>;

export class JsonRpcOutput {
  private queue = Promise.resolve();
  private readonly writeLine: (line: string) => Promise<void>;

  constructor(writeLine: (line: string) => Promise<void> = writeStdout) {
    this.writeLine = writeLine;
  }

  send(message: unknown) {
    const line = `${JSON.stringify(message)}\n`;
    this.queue = this.queue.then(() => this.writeLine(line)).catch((error) => {
      process.stderr.write(`agent stdout write failed: ${errorMessage(error)}\n`);
    });
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async flush() {
    await this.queue;
  }
}

export async function serveStdio(
  handle: (
    method: string,
    params: unknown,
    context: JsonRpcRequestContext,
  ) => Promise<unknown>,
  output: JsonRpcOutput,
  source: NodeJS.ReadableStream = process.stdin,
) {
  const input = createInterface({ input: source, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  const controllers: PendingRequestControllers = new Map();
  input.on('line', (line) => {
    const request = handleJsonRpcLine(line, handle, output, controllers);
    pending.add(request);
    void request.then(
      () => pending.delete(request),
      () => pending.delete(request),
    );
  });
  await new Promise<void>((resolve) => input.once('close', resolve));
  for (const controller of controllers.values()) {
    controller.abort(new Error('Agent RPC input closed.'));
  }
  await Promise.all(pending);
}

export async function handleJsonRpcLine(
  line: string,
  handle: (
    method: string,
    params: unknown,
    context: JsonRpcRequestContext,
  ) => Promise<unknown>,
  output: JsonRpcOutput,
  controllers: PendingRequestControllers = new Map(),
) {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    output.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (request.method === '$/cancelRequest') {
    const id = cancellationId(request.params);
    if (id !== undefined) {
      controllers.get(id)?.abort(new Error('Agent RPC request was cancelled by its caller.'));
    }
    return;
  }
  if (typeof request.method !== 'string') {
    output.send({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const requestId = typeof request.id === 'string' || typeof request.id === 'number'
    ? request.id
    : null;
  const controller = new AbortController();
  if (requestId !== null) controllers.set(requestId, controller);
  try {
    const result = await handle(request.method, request.params, {
      requestId,
      signal: controller.signal,
    });
    if (request.id !== undefined && !controller.signal.aborted) {
      output.send({ jsonrpc: '2.0', id: request.id, result });
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    const fault = isRpcFault(error)
      ? error
      : new RpcFault(-32603, 'Internal error');
    if (!isRpcFault(error)) {
      process.stderr.write(`agent request ${request.method} failed: ${errorMessage(error)}\n`);
    }
    if (request.id !== undefined) {
      output.send({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: fault.code,
          message: fault.message,
          ...(fault.data === undefined ? {} : { data: fault.data }),
        },
      });
    }
  } finally {
    if (requestId !== null && controllers.get(requestId) === controller) {
      controllers.delete(requestId);
    }
  }
}

function cancellationId(params: unknown) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const id = (params as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

function isRpcFault(error: unknown): error is { code: number; message: string; data?: unknown } {
  return error instanceof RpcFault || Boolean(
    error && typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'number' &&
    typeof (error as { message?: unknown }).message === 'string',
  );
}

function writeStdout(line: string) {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(line, (error) => error ? reject(error) : resolve());
  });
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}\b/gu, '[redacted]')
    .slice(0, 1_000);
}
