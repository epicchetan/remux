import { createInterface } from 'node:readline';

import { RpcFault } from './agent-server.ts';

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

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

export function serveStdio(handle: (method: string, params: unknown) => Promise<unknown>, output: JsonRpcOutput) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    void handleJsonRpcLine(line, handle, output);
  });
}

export async function handleJsonRpcLine(
  line: string,
  handle: (method: string, params: unknown) => Promise<unknown>,
  output: JsonRpcOutput,
) {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    output.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (request.method === '$/cancelRequest') return;
  if (typeof request.method !== 'string') {
    output.send({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  try {
    const result = await handle(request.method, request.params);
    if (request.id !== undefined) output.send({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    const fault = error instanceof RpcFault
      ? error
      : new RpcFault(-32603, 'Internal error');
    if (!(error instanceof RpcFault)) {
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
  }
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
