const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const WebSocket = require('ws');

const { attachRemuxWebSocketServer } = require('../wsServer.cjs');

test('logs app diagnostics notifications without routing them as RPC requests', async () => {
  const messages = [];
  const warnings = [];
  let resolveDiagnosticLog;
  const diagnosticLogged = new Promise((resolve) => {
    resolveDiagnosticLog = resolve;
  });

  const server = http.createServer();
  const remux = attachRemuxWebSocketServer({
    log: {
      error(message) {
        messages.push(String(message));
      },
      log(message) {
        messages.push(String(message));
        if (String(message).includes('[remux:app]')) {
          resolveDiagnosticLog();
        }
      },
      warn(message) {
        warnings.push(String(message));
      },
    },
    router: {
      async handleRequest() {
        throw new Error('App diagnostics should be JSON-RPC notifications');
      },
    },
    server,
  });

  await listen(server);

  const socket = await connect(`ws://127.0.0.1:${server.address().port}/ws`);
  socket.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'remux/app/log',
    params: {
      detail: { state: 'background' },
      label: 'app:state:change',
      timestamp: '2026-06-20T00:00:00.000Z',
    },
  }));

  await withTimeout(diagnosticLogged, 1000);

  assert.equal(warnings.length, 0);
  assert.ok(messages.some((message) => (
    message.includes('[remux:app] 2026-06-20T00:00:00.000Z app:state:change')
    && message.includes('"state":"background"')
  )));

  socket.close();
  remux.close();
  await close(server);
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for diagnostic log')), timeoutMs);
    }),
  ]);
}
