#!/usr/bin/env node

const WebSocket = require('ws');

const url = process.env.REMUX_WS_URL || `ws://127.0.0.1:${process.env.REMUX_PORT || '48123'}/ws`;
const required = process.env.REMUX_TERMINAL_SMOKE_REQUIRED === '1';

main().catch((error) => {
  console.error(`[terminal-smoke] failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const socket = await connect(url).catch((error) => {
    if (required) {
      throw error;
    }

    console.log(`[terminal-smoke] skipped: ${error.message}`);
    console.log('[terminal-smoke] set REMUX_WS_URL or REMUX_PORT, or REMUX_TERMINAL_SMOKE_REQUIRED=1 to require it');
    return null;
  });

  if (!socket) {
    return;
  }

  const client = new RpcSocket(socket);
  const sessionId = `terminal-smoke:${Date.now()}`;

  try {
    await client.request('remux/terminal/session/start', {
      cols: 80,
      cwd: process.cwd(),
      rows: 24,
      sessionId,
    });

    const output = client.waitForTerminalOutput(sessionId, 'remux-terminal-ws-ok', 5_000);
    await client.request('remux/terminal/session/write', {
      dataBase64: Buffer.from("printf 'remux-terminal-ws-ok'\r", 'utf8').toString('base64'),
      sessionId,
    });
    await output;

    await client.request('remux/terminal/session/kill', { sessionId }, 2_000).catch(() => undefined);
    console.log(`[terminal-smoke] passed: ${url}`);
  } finally {
    await client.close();
  }
}

function connect(nextUrl, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(nextUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`could not connect to ${nextUrl}`));
    }, timeoutMs);

    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

class RpcSocket {
  constructor(socket) {
    this.nextId = 1;
    this.notificationHandlers = new Set();
    this.pending = new Map();
    this.socket = socket;

    socket.on('message', (frame) => this.handleMessage(frame));
    socket.on('close', () => this.rejectPending(new Error('websocket closed')));
    socket.on('error', (error) => this.rejectPending(error));
  }

  request(method, params, timeoutMs = 5_000) {
    const id = `terminal-smoke:${this.nextId++}`;
    const payload = params === undefined
      ? { jsonrpc: '2.0', id, method }
      : { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);

      this.pending.set(id, { reject, resolve, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }

  waitForTerminalOutput(sessionId, expected, timeoutMs) {
    return new Promise((resolve, reject) => {
      let collected = '';
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`timed out waiting for ${JSON.stringify(expected)}; collected=${JSON.stringify(collected)}`));
      }, timeoutMs);

      const unsubscribe = this.onNotification((message) => {
        if (message.method !== 'remux/terminal/session/output') {
          return;
        }

        const params = isRecord(message.params) ? message.params : {};
        const frame = isRecord(params.frame) ? params.frame : {};
        if (params.sessionId !== sessionId || typeof frame.dataBase64 !== 'string') {
          return;
        }

        collected += Buffer.from(frame.dataBase64, 'base64').toString('utf8');
        if (collected.includes(expected)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(collected);
        }
      });
    });
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  handleMessage(frame) {
    let message;
    try {
      message = JSON.parse(String(frame));
    } catch {
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || 'JSON-RPC request failed'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const handler of this.notificationHandlers) {
      handler(message);
    }
  }

  rejectPending(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  close() {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      this.socket.once('close', resolve);
      this.socket.close();
    });
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
