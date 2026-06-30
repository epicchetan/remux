export type RemuxDebugEntry = {
  detail?: unknown;
  label: string;
  timestamp: string;
};

type RemuxDebugSink = (entry: RemuxDebugEntry) => void;

const highVolumeLabels = new Set([
  'rpc:request',
  'rpc:result',
  'socket:message',
]);

let debugSink: RemuxDebugSink | null = null;

export function setRemuxDebugSink(sink: RemuxDebugSink | null) {
  debugSink = sink;
}

export function logRemuxDebug(label: string, detail?: unknown) {
  if (!isVerboseDebugEnabled() && highVolumeLabels.has(label)) {
    return;
  }

  const entry = {
    detail: normalizeDetail(detail),
    label,
    timestamp: new Date().toISOString(),
  };

  if (isDevRuntime() && detail === undefined) {
    console.log(`[remux] ${label}`);
  } else if (isDevRuntime()) {
    console.log(`[remux] ${label}`, detail);
  }

  if (debugSink && shouldForwardToCli(label)) {
    try {
      debugSink(entry);
    } catch {
    }
  }
}

function isDevRuntime() {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

function isVerboseDebugEnabled() {
  return isDevRuntime() && (
    globalThis as typeof globalThis & { __REMUX_VERBOSE_DEBUG__?: boolean }
  ).__REMUX_VERBOSE_DEBUG__ === true;
}

function shouldForwardToCli(label: string) {
  if (label === 'socket:message') {
    return false;
  }

  return label.startsWith('app:')
    || label.startsWith('client:')
    || label.startsWith('connection:')
    || label.startsWith('notifications:')
    || label.startsWith('socket:')
    || label.startsWith('surface:')
    || label.startsWith('webview:');
}

function normalizeDetail(detail: unknown) {
  if (detail === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(detail));
  } catch {
    return String(detail);
  }
}
