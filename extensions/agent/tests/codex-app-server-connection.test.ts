import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodexJsonRpcPeer,
  CodexRequestError,
} from '../server/src/providers/codex/codex-app-server-connection.ts';

const handlers = {
  onNotification: () => undefined,
  onServerRequest: async () => ({}),
  onExit: () => undefined,
};

test('Codex request serializes before its exact synchronous hook and writes afterward', async () => {
  const order: string[] = [];
  const writes: string[] = [];
  const peer = new CodexJsonRpcPeer(handlers, {
    write: (encoded) => { order.push('write'); writes.push(encoded); },
    close: async () => undefined,
  });
  const pending = peer.request('turn/start', { prompt: 'bounded' }, 1_000, (method, requestId) => {
    order.push('hook');
    assert.equal(method, 'turn/start');
    assert.equal(requestId, 1);
  });
  assert.deepEqual(order, ['hook', 'write']);
  assert.deepEqual(JSON.parse(writes[0]!), {
    jsonrpc: '2.0', id: 1, method: 'turn/start', params: { prompt: 'bounded' },
  });
  peer.receiveText(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { turn: { id: 'native-1' } } }));
  assert.deepEqual(await pending, { turn: { id: 'native-1' } });
  peer.receiveText(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'late' } }));
  await peer.close();
});

test('Codex serialization and hook failures are not-sent and perform zero writes', async () => {
  const writes: string[] = [];
  const peer = new CodexJsonRpcPeer(handlers, {
    write: (encoded) => writes.push(encoded), close: async () => undefined,
  });
  await assert.rejects(peer.request('bad/serialize', { value: 1n }), (error: unknown) => {
    assertRequestError(error, 'not-sent', 'bad/serialize', 1);
    return true;
  });
  let hookIdentity: [string, number] | undefined;
  await assert.rejects(peer.request('bad/hook', {}, 1_000, (method, requestId) => {
    hookIdentity = [method, requestId];
    throw new Error('marker transaction failed');
  }), (error: unknown) => {
    assertRequestError(error, 'not-sent', 'bad/hook', 2);
    assert.match((error as Error).message, /marker transaction failed/u);
    return true;
  });
  assert.deepEqual(hookIdentity, ['bad/hook', 2]);
  assert.deepEqual(writes, []);
  await peer.close();
  await assert.rejects(peer.request('after/close', {}), (error: unknown) => {
    assertRequestError(error, 'not-sent', 'after/close', 3);
    return true;
  });
});

test('Codex reentrant close or exit before write remains not-sent with zero writes', async () => {
  for (const action of ['close-in-hook', 'exit-in-hook', 'close-in-serialization'] as const) {
    const writes: string[] = [];
    let peer!: CodexJsonRpcPeer;
    peer = new CodexJsonRpcPeer(handlers, {
      write: (encoded) => writes.push(encoded), close: async () => undefined,
    });
    const params = action === 'close-in-serialization'
      ? { toJSON: () => { void peer.close(); return { serialized: true }; } }
      : {};
    const request = peer.request(`request/${action}`, params, 1_000, action === 'close-in-serialization'
      ? undefined
      : () => {
          if (action === 'close-in-hook') void peer.close();
          else peer.transportExited(new Error('transport exited inside hook'));
        });
    await assert.rejects(request, (error: unknown) => {
      assertRequestError(error, 'not-sent', `request/${action}`, 1);
      return true;
    });
    assert.deepEqual(writes, [], action);
  }
});

test('Codex write, timeout, close, and exit failures remain possibly-sent', async () => {
  let enteredWrite = false;
  const throwing = new CodexJsonRpcPeer(handlers, {
    write: () => { enteredWrite = true; throw new Error('partial pipe write'); },
    close: async () => undefined,
  });
  await assert.rejects(throwing.request('write/fails', {}), (error: unknown) => {
    assertRequestError(error, 'possibly-sent', 'write/fails', 1);
    assert.match((error as Error).message, /partial pipe write/u);
    return true;
  });
  assert.equal(enteredWrite, true);

  const timeoutPeer = inertPeer();
  await assert.rejects(timeoutPeer.request('request/times-out', {}, 1), (error: unknown) => {
    assertRequestError(error, 'possibly-sent', 'request/times-out', 1);
    assert.match((error as Error).message, /timed out after 1 ms/u);
    return true;
  });

  const closePeer = inertPeer();
  const closed = closePeer.request('request/closes', {});
  await closePeer.close();
  await assert.rejects(closed, (error: unknown) => {
    assertRequestError(error, 'possibly-sent', 'request/closes', 1);
    assert.match((error as Error).message, /connection closed/u);
    return true;
  });

  const exitPeer = inertPeer();
  const exited = exitPeer.request('request/exits', {});
  exitPeer.transportExited(new Error('transport exited midway'));
  await assert.rejects(exited, (error: unknown) => {
    assertRequestError(error, 'possibly-sent', 'request/exits', 1);
    assert.match((error as Error).message, /transport exited midway/u);
    return true;
  });
});

test('Codex native errors retain numeric code and identity without arbitrary payload', async () => {
  const peer = inertPeer();
  const pending = peer.request('turn/start', {});
  peer.receiveText(JSON.stringify({ jsonrpc: '2.0', id: 1, error: {
    code: -32042, message: 'native validation failed', data: { secret: 'must-not-escape' },
  } }));
  await assert.rejects(pending, (error: unknown) => {
    assertRequestError(error, 'possibly-sent', 'turn/start', 1);
    assert.equal((error as CodexRequestError).nativeCode, -32042);
    assert.match((error as Error).message, /native validation failed/u);
    assert.doesNotMatch((error as Error).message, /must-not-escape/u);
    return true;
  });
  await peer.close();
});

function inertPeer() {
  return new CodexJsonRpcPeer(handlers, { write: () => undefined, close: async () => undefined });
}

function assertRequestError(error: unknown, phase: 'not-sent' | 'possibly-sent',
  method: string, requestId: number) {
  assert.ok(error instanceof CodexRequestError);
  assert.equal(error.phase, phase);
  assert.equal(error.method, method);
  assert.equal(error.requestId, requestId);
}
