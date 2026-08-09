import WebSocket from 'ws';

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class RemuxBenchmarkClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly socket: WebSocket;

  static connect(endpoint: string, token: string): Promise<RemuxBenchmarkClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint, { headers: { authorization: `Bearer ${token}` } });
      socket.once('open', () => resolve(new RemuxBenchmarkClient(socket)));
      socket.once('error', reject);
    });
  }

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as {
        id?: number;
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message ?? 'Remux request failed'} (${message.error.code ?? 'unknown'})`));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Remux WebSocket closed before the RPC completed.'));
      }
      this.pending.clear();
    });
  }

  query(method: string, params?: unknown, resourceKey?: string) {
    return this.request(method, params, {
      kind: 'query',
      ...(resourceKey ? { resourceKey } : {}),
    });
  }

  command(method: string, params?: unknown) {
    return this.request(method, params, { kind: 'command' });
  }

  close() {
    this.socket.close();
  }

  private request(method: string, params: unknown, remuxContract: Record<string, unknown>) {
    return new Promise<unknown>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        remuxContract,
        ...(params === undefined ? {} : { params }),
      }));
    });
  }
}
