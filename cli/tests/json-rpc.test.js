const assert = require('node:assert/strict');
const test = require('node:test');

const {
  JsonRpcError,
  errorMessage,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseJsonRpcFrame,
  responseMessage,
  withJsonRpcVersion,
} = require('../jsonRpc.cjs');

test('classifies requests, responses, and server-originated requests distinctly', () => {
  assert.equal(isJsonRpcRequest({ id: 1, method: 'thread/list' }), true);
  assert.equal(isJsonRpcResponse({ id: 1, result: {} }), true);
  assert.equal(isJsonRpcResponse({ id: 1, method: 'approval/request', params: {} }), false);
});

test('parseJsonRpcFrame returns parse and invalid request errors', () => {
  const parseError = parseJsonRpcFrame('{');
  assert.equal(parseError.error.code, -32700);
  assert.equal(parseError.id, null);

  const invalid = parseJsonRpcFrame('[]');
  assert.equal(invalid.error.code, -32600);
  assert.equal(invalid.id, null);
});

test('formats JSON-RPC responses and errors', () => {
  assert.deepEqual(responseMessage('a', { ok: true }), {
    jsonrpc: '2.0',
    id: 'a',
    result: { ok: true },
  });

  assert.deepEqual(errorMessage(7, new JsonRpcError(-32601, 'Method not found')), {
    jsonrpc: '2.0',
    id: 7,
    error: {
      code: -32601,
      message: 'Method not found',
    },
  });
});

test('withJsonRpcVersion preserves existing version and adds missing version', () => {
  assert.deepEqual(withJsonRpcVersion({ method: 'turn/started' }), {
    jsonrpc: '2.0',
    method: 'turn/started',
  });
  assert.deepEqual(withJsonRpcVersion({ jsonrpc: '2.0', method: 'turn/started' }), {
    jsonrpc: '2.0',
    method: 'turn/started',
  });
});
