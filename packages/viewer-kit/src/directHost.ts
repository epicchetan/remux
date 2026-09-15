import type { RemuxHostViewportMetrics } from './host.ts';
import type { IpcStatusSnapshot, JsonRpcId, RemuxViewHostStatus, WebViewRequest } from './ipc.ts';
import { parseRemuxViewerRoute, serializedResourceKey } from './route.ts';

declare global {
  interface Window {
    /** Read-only diagnostics for disposable browser helpers. */
    __REMUX_DIRECT_HOST__?: Readonly<IpcStatusSnapshot>;
  }
}

type BrowserWindow = Window & typeof globalThis;
type RpcFrame = Record<string, unknown>;
const handshakeTimeoutMs = 10_000;

/** Owns the host side of viewer IPC in a standalone browser page. */
export function installDirectHost(target: BrowserWindow = window) {
  const initialUrl = new URL(target.location.href);
  const segments = initialUrl.pathname.split('/').filter(Boolean);
  const extensionId = segments[0] === 'viewers' ? decodeURIComponent(segments[1] ?? '') : '';
  const routeView = segments[2];
  // _bundle/<revision> is a deployment URL, not a view id. All current
  // manifests use /viewers/<extension> for their main view.
  const viewId = routeView && routeView !== '_bundle' && !routeView.includes('.')
    ? decodeURIComponent(routeView) : 'main';
  const uuid = createUuid(target.crypto);
  const tabId = parseRemuxViewerRoute(initialUrl.href).tabId || `direct:${uuid}`;
  const theme = target.matchMedia('(prefers-color-scheme: dark)');
  const queue: WebViewRequest[] = [];
  let socket: WebSocket | null = null;
  let timer: number | undefined;
  let disposed = false;
  let attempt = 0;
  let generation = 0;
  let epoch = 0;
  let handshakeId = 0;

  const dispatch = (message: unknown) => {
    target.dispatchEvent(new target.MessageEvent('message', { data: JSON.stringify(message) }));
  };
  const event = (method: string, params: unknown) => dispatch({
    type: 'remux/event', message: { method, params },
  });
  const status = (value: RemuxViewHostStatus, error: string | null = null) => {
    target.__REMUX_DIRECT_HOST__ = { status: value, error };
    dispatch({ type: 'remux/status', status: value, error });
  };
  const respond = (id: JsonRpcId, result: unknown) => dispatch({ type: 'remux/response', id, result });
  const reject = (id: JsonRpcId, message: string, code = -32000) => dispatch({
    type: 'remux/error', id, error: { code, message },
  });
  const viewport = (): RemuxHostViewportMetrics => ({
    hostControlInsetLeft: 0,
    keyboardHeight: 0,
    keyboardVisible: false,
    safeAreaBottom: 0,
    safeAreaLeft: 0,
    safeAreaRight: 0,
    safeAreaTop: 0,
    visibleBottom: target.innerHeight,
    visibleTop: 0,
    viewportHeight: target.innerHeight,
    viewportWidth: target.innerWidth,
  });
  const onResize = () => event('host/viewport/changed', viewport());
  const onTheme = () => event('host/theme', { theme: theme.matches ? 'dark' : 'light' });

  function send(frame: RpcFrame) {
    socket!.send(JSON.stringify(frame));
  }

  function disconnect(candidate: WebSocket | null, reason: string) {
    if (disposed || socket !== candidate) return;
    target.clearTimeout(timer);
    socket = null;
    candidate?.close();
    // Nothing is replayed from the disconnected socket, including requests
    // waiting for its handshake. IPC rejects its entire pending set on closed.
    queue.splice(0);
    status({ type: 'closed', reason }, reason);
    attempt += 1;
    status({ type: 'reconnecting', attempt }, reason);
    timer = target.setTimeout(connect, Math.min(250 * 2 ** Math.min(attempt - 1, 5), 5_000));
  }

  function connect() {
    if (disposed) return;
    let candidate: WebSocket;
    try {
      candidate = new target.WebSocket(`${target.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${target.location.host}/ws`);
    } catch (error) {
      disconnect(null, errorMessage(error));
      return;
    }
    socket = candidate;
    const pingId = `remux-direct-host:${uuid}:${++handshakeId}:ping`;
    const infoId = `remux-direct-host:${uuid}:${handshakeId}:info`;
    let phase: 'ping' | 'info' | 'connected' = 'ping';
    timer = target.setTimeout(() => disconnect(candidate, 'Direct host handshake timed out'), handshakeTimeoutMs);
    candidate.addEventListener('open', () => {
      if (socket !== candidate) return;
      // Ping runs in the runtime's liveness lane; its wire contract is query,
      // exactly as in the app's RemuxRpcClient.ping().
      send({ jsonrpc: '2.0', id: pingId, method: 'remux/system/ping', remuxContract: { kind: 'query', resourceKey: 'system-ping' } });
    });
    candidate.addEventListener('message', (incoming) => {
      if (socket !== candidate) return;
      let frame: RpcFrame;
      try {
        const parsed: unknown = JSON.parse(String(incoming.data));
        if (!isRecord(parsed)) throw new Error('Expected a JSON-RPC object');
        frame = parsed;
      } catch {
        disconnect(candidate, 'Direct host received an invalid JSON-RPC frame');
        return;
      }
      if (!('id' in frame)) {
        dispatch({ type: 'remux/event', message: frame });
        return;
      }
      if ('method' in frame) {
        send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `Direct host does not support runtime requests: ${String(frame.method)}` } });
        return;
      }
      if (frame.id === pingId || frame.id === infoId) {
        if (frame.error) {
          disconnect(candidate, `Direct host handshake failed: ${isRecord(frame.error) ? String(frame.error.message) : 'RPC error'}`);
          return;
        }
        if (phase === 'ping' && frame.id === pingId) {
          phase = 'info';
          send({ jsonrpc: '2.0', id: infoId, method: 'remux/system/info', remuxContract: { kind: 'query', resourceKey: 'system-info' } });
        } else if (phase === 'info' && frame.id === infoId) {
          const info = frame.result;
          if (!isRecord(info) || (info.cwd !== null && typeof info.cwd !== 'string')) {
            disconnect(candidate, 'Direct host received invalid remux/system/info');
            return;
          }
          target.clearTimeout(timer);
          phase = 'connected';
          attempt = 0;
          generation = Math.max(generation + 1, typeof info.generation === 'number' && Number.isFinite(info.generation) ? info.generation : 0);
          status({ type: 'connected', cwd: info.cwd, generation });
          event('host/connection', { generation, status: 'connected' });
          event('host/active', { active: true });
          dispatch({ type: 'remux/lifecycle', lifecycle: { epoch: ++epoch, inactiveForMs: 0, reason: 'connect', state: 'active' } });
          for (const message of queue.splice(0)) postMessage(message);
        }
        return;
      }
      dispatch(frame.error
        ? { type: 'remux/error', id: frame.id, error: frame.error }
        : { type: 'remux/response', id: frame.id, result: frame.result });
    });
    candidate.addEventListener('close', (closed) => disconnect(candidate, closed.reason || 'Direct host WebSocket closed'));
    candidate.addEventListener('error', () => disconnect(candidate, 'Direct host WebSocket error'));
  }

  async function hostCall(message: Extract<WebViewRequest, { type: 'remux/request' }>) {
    const { id, method } = message;
    const params = isRecord(message.params) ? message.params : {};
    switch (method) {
      case 'host/viewport/get':
      case 'host/keyboard/dismiss':
        respond(id, viewport());
        return;
      case 'host/theme/get':
        respond(id, { theme: theme.matches ? 'dark' : 'light' });
        return;
      case 'host/preview/invalidate':
        respond(id, { ok: true });
        return;
      case 'host/tab/update': {
        if (typeof params.title === 'string' || params.title === null) target.document.title = params.title ?? '';
        const url = updateRoute(new URL(target.location.href), params);
        target.history.replaceState(target.history.state, '', url);
        respond(id, { ok: true });
        return;
      }
      case 'host/clipboard/read': {
        let text = '';
        try { text = await target.navigator.clipboard.readText(); } catch { /* Permission denied or unavailable. */ }
        if (!disposed) respond(id, { text });
        return;
      }
      case 'host/view/reload':
        respond(id, { ok: true });
        target.setTimeout(() => target.location.reload(), 0);
        return;
      case 'host/navigate':
        respond(id, { ok: true });
        target.setTimeout(() => target.location.assign(updateRoute(new URL(target.location.href), params).href), 0);
        return;
      case 'host/link/open': {
        let url: URL;
        try {
          url = new URL(typeof params.url === 'string' ? params.url.trim() : '');
          if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
        } catch {
          reject(id, 'Invalid link open params', -32602);
          return;
        }
        respond(id, open(url));
        return;
      }
      case 'host/file/open': {
        if (typeof params.path !== 'string' || !params.path.trim() || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(params.path)) {
          reject(id, 'Invalid file open params', -32602);
          return;
        }
        const url = new URL('/viewers/editor/', target.location.href);
        url.searchParams.set('remuxResourceKind', 'file');
        url.searchParams.set('remuxResourceId', params.path);
        if (typeof params.line === 'number' && Number.isFinite(params.line)) {
          url.searchParams.set('remuxFocusKind', 'line');
          url.searchParams.set('remuxFocusId', String(Math.max(1, Math.floor(params.line))));
        }
        respond(id, open(url));
        return;
      }
      default:
        reject(id, `Direct host does not support ${method}`, -32601);
    }
  }

  function open(url: URL) {
    return target.open(url.href, '_blank') ? { ok: true } : { ok: false, reason: 'unavailable' };
  }

  function postMessage(message: WebViewRequest) {
    if (disposed) throw new Error('Direct host is disposed');
    if (message.type === 'remux/ready') return;
    if (message.type === 'remux/request' && message.method.startsWith('host/')) {
      void hostCall(message).catch((error) => reject(message.id, errorMessage(error)));
      return;
    }
    if (message.type === 'remux/notify' && message.method === 'host/preview/invalidate') return;
    if (message.type === 'remux/cancel') {
      const queued = queue.findIndex((entry) => entry.type === 'remux/request' && entry.id === message.id);
      if (queued !== -1) queue.splice(queued, 1);
      else if (target.__REMUX_DIRECT_HOST__?.status.type === 'connected') send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: message.id } });
      return;
    }
    // Health pongs and WebView console envelopes have no direct-host consumer.
    if (message.type !== 'remux/request' && message.type !== 'remux/notify') return;
    if (target.__REMUX_DIRECT_HOST__?.status.type !== 'connected') {
      if (queue.length >= 64) throw new Error('Direct host request admission is full');
      queue.push(message);
      return;
    }
    if (message.type === 'remux/notify') {
      send({ jsonrpc: '2.0', method: message.method, params: message.params });
      return;
    }
    const route = parseRemuxViewerRoute(target.location.href);
    send({
      jsonrpc: '2.0', id: message.id, method: message.method, params: message.params,
      remuxContract: message.contract,
      remuxContext: { tabId, resourceKey: serializedResourceKey({ ...route, extensionId, viewId }) },
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    target.clearTimeout(timer);
    target.removeEventListener('resize', onResize);
    target.removeEventListener('pagehide', dispose);
    theme.removeEventListener('change', onTheme);
    queue.splice(0);
    socket?.close();
    socket = null;
    status({ type: 'closed', reason: 'Direct host disposed' });
  }

  target.addEventListener('resize', onResize);
  target.addEventListener('pagehide', dispose);
  theme.addEventListener('change', onTheme);
  status({ type: 'connecting' });
  connect();
  return { postMessage, dispose };
}

function updateRoute(url: URL, params: Record<string, unknown>) {
  for (const [key, query] of Object.entries({
    focusId: 'remuxFocusId', focusKind: 'remuxFocusKind', handlerId: 'remuxHandler',
    launch: 'remuxLaunch', resourceId: 'remuxResourceId', resourceKind: 'remuxResourceKind',
  })) {
    if (params[key] === null) url.searchParams.delete(query);
    else if (typeof params[key] === 'string') url.searchParams.set(query, params[key]);
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createUuid(crypto: Crypto) {
  // getRandomValues also works on plain HTTP hosts outside localhost.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
