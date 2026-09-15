import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { installDirectHost } from '../src/directHost.ts';
import { normalizeResourceKey, serializedResourceKey } from '../src/route.ts';

function harness(t: TestContext, path = '/viewers/agent/?remuxTabId=tab-1&remuxResourceKind=agentConversation&remuxResourceId=chat-1') {
  const messages: any[] = [];
  const sockets: FakeWebSocket[] = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let nextTimer = 1;
  class FakeWebSocket extends EventTarget {
    frames: any[] = [];
    url: string;
    closed = false;
    constructor(url: string) { super(); this.url = url; sockets.push(this); }
    send(raw: string) { assert.equal(this.closed, false); this.frames.push(JSON.parse(raw)); }
    open() { this.dispatchEvent(new Event('open')); }
    receive(frame: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.dispatchEvent(Object.assign(new Event('close'), { reason: 'test disconnect' }));
    }
  }
  const location = Object.assign(new URL(path, 'http://127.0.0.1:48123'), {
    assign(url: string) { location.href = url; }, reload() { reloaded += 1; },
  });
  let reloaded = 0;
  const opened: unknown[][] = [];
  const theme = Object.assign(new EventTarget(), { matches: false });
  const browser = Object.assign(new EventTarget(), {
    WebSocket: FakeWebSocket, MessageEvent, crypto: globalThis.crypto, location,
    innerWidth: 1280, innerHeight: 900, document: { title: '' },
    navigator: { clipboard: { async readText() { return 'clipboard text'; } } },
    history: { state: { preserved: true }, replaceState(_state: unknown, _title: string, url: URL) { location.href = url.href; } },
    matchMedia: () => theme,
    open(...args: unknown[]) { opened.push(args); return {}; },
    setTimeout(callback: () => void, ms: number) { const id = nextTimer++; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  browser.addEventListener('message', (event) => messages.push(JSON.parse((event as MessageEvent).data)));
  const target = browser as unknown as Window & typeof globalThis;
  const host = installDirectHost(target);
  t.after(host.dispose);
  const request = (method: string, params?: unknown, id = 'viewer:1') => host.postMessage({ type: 'remux/request', id, method, params, contract: { kind: 'query' } });
  const tick = (ms: number) => {
    const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms);
    assert.ok(entry, `Expected a ${ms}ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
  };
  const connect = (info: unknown = { cwd: '/repo', generation: 7 }) => {
    const socket = sockets.at(-1)!;
    socket.open();
    socket.receive({ id: socket.frames[0].id, result: {} });
    socket.receive({ id: socket.frames[1].id, result: info });
    return socket;
  };
  return { browser, target, theme, host, request, messages, sockets, connect, tick, timers, opened, reloaded: () => reloaded };
}

test('connect waits for ping then info and announces status, connection, active, lifecycle in order', (t) => {
  const h = harness(t);
  const ws = h.sockets[0]!;
  assert.equal(ws.url, 'ws://127.0.0.1:48123/ws');
  assert.deepEqual(h.target.__REMUX_DIRECT_HOST__, { status: { type: 'connecting' }, error: null });
  h.host.postMessage({ type: 'remux/ready' });
  h.request('agent/read', { id: 'chat-1' });
  ws.open();
  assert.equal(ws.frames.length, 1);
  assert.equal(ws.frames[0].method, 'remux/system/ping');
  assert.deepEqual(ws.frames[0].remuxContract, { kind: 'query', resourceKey: 'system-ping' });
  ws.receive({ id: ws.frames[0].id, result: {} });
  assert.equal(ws.frames.length, 2);
  assert.equal(ws.frames[1].method, 'remux/system/info');
  assert.deepEqual(ws.frames[1].remuxContract, { kind: 'query', resourceKey: 'system-info' });
  assert.equal(h.target.__REMUX_DIRECT_HOST__?.status.type, 'connecting');
  ws.receive({ id: ws.frames[1].id, result: { cwd: '/repo', generation: 12 } });
  assert.deepEqual(h.messages.slice(1), [
    { type: 'remux/status', status: { type: 'connected', cwd: '/repo', generation: 12 }, error: null },
    { type: 'remux/event', message: { method: 'host/connection', params: { generation: 12, status: 'connected' } } },
    { type: 'remux/event', message: { method: 'host/active', params: { active: true } } },
    { type: 'remux/lifecycle', lifecycle: { epoch: 1, inactiveForMs: 0, reason: 'connect', state: 'active' } },
  ]);
  assert.equal(ws.frames[2].method, 'agent/read');
  assert.equal(ws.frames.some((frame) => frame.method === 'remux/clients/register'), false);
});

test('forwards contracts, current resource context, responses, errors, notifications and cancel', (t) => {
  const h = harness(t);
  const ws = h.connect();
  h.host.postMessage({ type: 'remux/request', id: 'command', method: 'agent/update', params: { value: 1 }, contract: { kind: 'command', operationId: 'operation-1' } });
  assert.deepEqual(ws.frames.at(-1), {
    jsonrpc: '2.0', id: 'command', method: 'agent/update', params: { value: 1 },
    remuxContract: { kind: 'command', operationId: 'operation-1' },
    remuxContext: { tabId: 'tab-1', resourceKey: '["agent","main","agentConversation","chat-1"]' },
  });
  h.browser.location.searchParams.set('remuxResourceId', 'chat-2');
  h.request('agent/read');
  assert.equal(ws.frames.at(-1).remuxContext.resourceKey, '["agent","main","agentConversation","chat-2"]');
  h.host.postMessage({ type: 'remux/cancel', id: 'command', reason: 'no longer needed' });
  assert.deepEqual(ws.frames.at(-1), { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'command' } });
  const response = { jsonrpc: '2.0', id: 'viewer:1', result: { done: true } };
  ws.receive(response);
  assert.deepEqual(h.messages.at(-1), { type: 'remux/response', id: 'viewer:1', result: response.result });
  const error = { code: -32001, message: 'failed', data: { revision: 2 } };
  ws.receive({ id: 'viewer:1', error });
  assert.deepEqual(h.messages.at(-1), { type: 'remux/error', id: 'viewer:1', error });
  const notification = { jsonrpc: '2.0', method: 'agent/changed', params: { tabId: 'another-tab' } };
  ws.receive(notification);
  assert.deepEqual(h.messages.at(-1), { type: 'remux/event', message: notification });
  h.host.postMessage({ type: 'remux/notify', method: 'agent/watch', params: { id: 1 } });
  assert.deepEqual(ws.frames.at(-1), { jsonrpc: '2.0', method: 'agent/watch', params: { id: 1 } });
  const count = ws.frames.length;
  h.host.postMessage({ type: 'remux/notify', method: 'host/preview/invalidate' });
  assert.equal(ws.frames.length, count);
});

test('runtime-initiated requests get method-not-found, including id zero', (t) => {
  const h = harness(t);
  const ws = h.connect();
  const count = h.messages.length;
  ws.receive({ jsonrpc: '2.0', id: 0, method: 'runtime/request', params: {} });
  assert.deepEqual(ws.frames.at(-1), {
    jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'Direct host does not support runtime requests: runtime/request' },
  });
  assert.equal(h.messages.length, count);
});

test('close rejects outstanding work before reconnect, backs off to 5s and advances generation and epoch', (t) => {
  const h = harness(t);
  const first = h.connect();
  h.request('agent/read');
  first.close();
  assert.deepEqual(h.messages.slice(-2).map((message) => message.status.type), ['closed', 'reconnecting']);
  assert.equal(h.messages.at(-1).status.attempt, 1);
  h.request('agent/read', {}, 'queued-then-lost');
  for (const [index, delay] of [250, 500, 1000, 2000, 4000, 5000, 5000].entries()) {
    h.tick(delay);
    h.sockets.at(-1)!.close();
    assert.equal(h.messages.at(-1).status.attempt, index + 2);
  }
  h.tick(5000);
  const reconnected = h.connect({ cwd: '/repo', generation: 7 });
  assert.deepEqual(h.target.__REMUX_DIRECT_HOST__, { status: { type: 'connected', cwd: '/repo', generation: 8 }, error: null });
  assert.equal(h.messages.at(-1).lifecycle.epoch, 2);
  assert.equal(reconnected.frames.length, 2, 'old requests must not be replayed');
  first.receive({ id: 'viewer:1', result: 'stale socket response' });
  assert.equal(h.messages.at(-1).type, 'remux/lifecycle');
  reconnected.close();
  assert.equal(h.messages.at(-1).status.attempt, 1);
  h.tick(250);
});

test('queued cancellation never sends canceled work after the handshake', (t) => {
  const h = harness(t);
  h.request('agent/read');
  h.host.postMessage({ type: 'remux/cancel', id: 'viewer:1', reason: 'aborted' });
  const ws = h.connect();
  assert.equal(ws.frames.length, 2);
});

test('handshake failure and timeout stay disconnected and schedule a retry', (t) => {
  const h = harness(t);
  const ws = h.sockets[0]!;
  ws.open();
  ws.receive({ id: ws.frames[0].id, error: { message: 'unauthorized', code: -32000 } });
  assert.equal(h.target.__REMUX_DIRECT_HOST__?.status.type, 'reconnecting');
  assert.match(h.target.__REMUX_DIRECT_HOST__!.error!, /unauthorized/);
  h.tick(250);
  h.tick(10000);
  assert.match(h.target.__REMUX_DIRECT_HOST__!.error!, /timed out/);
  h.tick(500);
  h.connect({ cwd: 42 });
  assert.match(h.target.__REMUX_DIRECT_HOST__!.error!, /invalid remux\/system\/info/);
  assert.equal(h.messages.some((message) => message.status?.type === 'connected'), false);
});

test('local viewport and theme work before connection and emit changes', (t) => {
  const h = harness(t);
  h.request('host/viewport/get');
  const metrics = { hostControlInsetLeft: 0, keyboardHeight: 0, keyboardVisible: false, safeAreaBottom: 0, safeAreaLeft: 0, safeAreaRight: 0, safeAreaTop: 0, visibleBottom: 900, visibleTop: 0, viewportHeight: 900, viewportWidth: 1280 };
  assert.deepEqual(h.messages.at(-1).result, metrics);
  h.request('host/keyboard/dismiss');
  assert.deepEqual(h.messages.at(-1).result, metrics);
  h.browser.innerHeight = 700;
  h.browser.dispatchEvent(new Event('resize'));
  assert.deepEqual(h.messages.at(-1).message, { method: 'host/viewport/changed', params: { ...metrics, visibleBottom: 700, viewportHeight: 700 } });
  h.request('host/theme/get');
  assert.deepEqual(h.messages.at(-1).result, { theme: 'light' });
  h.theme.matches = true;
  h.theme.dispatchEvent(new Event('change'));
  assert.deepEqual(h.messages.at(-1).message, { method: 'host/theme', params: { theme: 'dark' } });
  h.request('host/preview/invalidate');
  assert.deepEqual(h.messages.at(-1).result, { ok: true });
});

test('tab updates rewrite resource params without losing unrelated URL or history state', (t) => {
  const h = harness(t);
  h.browser.location.searchParams.set('unrelated', 'keep');
  h.request('host/tab/update', { title: 'New title', resourceKind: 'file', resourceId: '/repo/a b.md', launch: null });
  assert.equal(h.browser.document.title, 'New title');
  assert.equal(h.browser.location.searchParams.get('remuxResourceId'), '/repo/a b.md');
  assert.equal(h.browser.location.searchParams.get('unrelated'), 'keep');
  assert.deepEqual(h.browser.history.state, { preserved: true });
  h.request('host/tab/update', { resourceId: null });
  assert.equal(h.browser.location.searchParams.has('remuxResourceId'), false);
  h.request('host/navigate', { resourceKind: 'file', resourceId: '/repo/next.md', focusKind: 'line', focusId: '3' });
  assert.deepEqual(h.messages.at(-1).result, { ok: true });
  h.tick(0);
  assert.equal(h.browser.location.searchParams.get('remuxFocusId'), '3');
  assert.equal(h.browser.location.pathname, '/viewers/agent/');
});

test('clipboard, reload, links and files preserve host result shapes; unsupported calls name the direct host', async (t) => {
  const h = harness(t);
  h.request('host/clipboard/read');
  await setImmediate();
  assert.deepEqual(h.messages.at(-1).result, { text: 'clipboard text' });
  h.browser.navigator.clipboard.readText = async () => { throw new Error('denied'); };
  h.request('host/clipboard/read');
  await setImmediate();
  assert.deepEqual(h.messages.at(-1).result, { text: '' });
  h.request('host/view/reload');
  assert.deepEqual(h.messages.at(-1).result, { ok: true });
  h.tick(0);
  assert.equal(h.reloaded(), 1);
  h.request('host/link/open', { url: 'https://example.com/path' });
  assert.deepEqual(h.opened.at(-1), ['https://example.com/path', '_blank']);
  h.request('host/link/open', { url: 'javascript:alert(1)' });
  assert.equal(h.messages.at(-1).error.code, -32602);
  h.request('host/file/open', { path: '/repo/a b.md', line: 4.9 });
  const fileUrl = new URL(h.opened.at(-1)![0] as string);
  assert.equal(fileUrl.pathname, '/viewers/editor/');
  assert.equal(fileUrl.searchParams.get('remuxResourceId'), '/repo/a b.md');
  assert.equal(fileUrl.searchParams.get('remuxFocusId'), '4');
  assert.equal(h.opened.at(-1)![1], '_blank');
  for (const method of ['host/attachments/pick', 'host/overview/open', 'host/tab/close', 'host/unknown']) {
    h.request(method);
    assert.equal(h.messages.at(-1).error.code, -32601);
    assert.match(h.messages.at(-1).error.message, /Direct host/);
  }
});

test('route identity handles generated tabs, secure origins, explicit views and bundle revisions', (t) => {
  const h = harness(t, 'https://example.com/viewers/editor/preview/_bundle/rev/?remuxResourceKind=file&remuxResourceId=a');
  const ws = h.connect({ cwd: null });
  h.request('agent/read');
  assert.equal(ws.url, 'wss://example.com/ws');
  assert.match(ws.frames.at(-1).remuxContext.tabId, /^direct:[\da-f-]{36}$/);
  assert.equal(ws.frames.at(-1).remuxContext.resourceKey, '["editor","preview","file","a"]');
  const main = harness(t, '/viewers/agent/_bundle/revision/?remuxResourceKind=agentConversation&remuxResourceId=c');
  const mainWs = main.connect();
  main.request('agent/read');
  assert.equal(mainWs.frames.at(-1).remuxContext.resourceKey, '["agent","main","agentConversation","c"]');
  const empty = harness(t, '/viewers/agent/');
  const emptyWs = empty.connect();
  empty.request('agent/read');
  assert.equal(emptyWs.frames.at(-1).remuxContext.resourceKey, null);
});

test('dispose closes the socket, removes observers and cancels reconnect timers', (t) => {
  const h = harness(t);
  h.connect();
  h.host.dispose();
  const count = h.messages.length;
  h.browser.dispatchEvent(new Event('resize'));
  h.theme.dispatchEvent(new Event('change'));
  assert.equal(h.messages.length, count);
  assert.equal(h.timers.size, 0);
  assert.equal(h.sockets[0]!.closed, true);
});

test('shared resource keys trim inputs, default main, and require complete resource identity', () => {
  assert.deepEqual(normalizeResourceKey({ extensionId: ' agent ', resourceKind: ' chat ', resourceId: ' c ' }), {
    extensionId: 'agent', viewId: 'main', resourceKind: 'chat', resourceId: 'c',
  });
  assert.equal(serializedResourceKey({ extensionId: 'agent' }), null);
  assert.equal(serializedResourceKey({ extensionId: 'agent', resourceKind: ' chat ', resourceId: ' c ' }), '["agent","main","chat","c"]');
});
