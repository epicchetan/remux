import type { RemuxConnection } from '../remote/RemuxConnectionProvider';

const extensionStatusMethod = 'remux/extensions/status';
const extensionStartMethod = 'remux/extensions/start';
const extensionStopMethod = 'remux/extensions/stop';
const extensionRestartMethod = 'remux/extensions/restart';
const extensionLogsMethod = 'remux/extensions/logs';
const extensionLogsSubscribeMethod = 'remux/extensions/logs/subscribe';
const extensionLogsUnsubscribeMethod = 'remux/extensions/logs/unsubscribe';

export const extensionDidChangeStatusMethod = 'remux/extensions/didChangeStatus';
export const extensionLogsDidAppendMethod = 'remux/extensions/logs/didAppend';

/** A rebuild runs the manifest build phase; allow it the runtime's 10min. */
const rebuildTimeoutMs = 600_000;

export type ExtensionServerState =
  | 'stopped'
  | 'building'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'backingOff'
  | 'failed';

export type ExtensionServerLastExit = {
  code: number | null;
  signal: string | null;
  at: number | null;
  reason: string | null;
};

export type ExtensionServerStatus = {
  extensionId: string;
  restartable: boolean;
  running: boolean;
  /** Pass-2 additive fields; defaulted when talking to a pass-1 runtime. */
  state: ExtensionServerState;
  pid: number | null;
  startedAtMs: number | null;
  restartCount: number;
  lastExit: ExtensionServerLastExit | null;
  hasBuild: boolean;
};

export type ExtensionLogLine = {
  ts: string;
  stream: string;
  line: string;
};

export async function readExtensionServerStatuses(
  request: RemuxConnection['request'],
): Promise<ExtensionServerStatus[]> {
  const response = await request<unknown>(extensionStatusMethod, undefined, 8_000);
  if (!isRecord(response) || !Array.isArray(response.extensions)) {
    throw new Error('Invalid extension status response');
  }

  return response.extensions.flatMap((entry) => {
    const status = parseExtensionServerStatus(entry);
    return status ? [status] : [];
  });
}

export async function restartExtensionServer(
  request: RemuxConnection['request'],
  extensionId: string,
  options?: { rebuild?: boolean },
): Promise<ExtensionServerStatus & { restarted: boolean }> {
  const rebuild = options?.rebuild === true;
  const response = await request<unknown>(
    extensionRestartMethod,
    { extensionId, ...(rebuild ? { rebuild: true } : {}) },
    rebuild ? rebuildTimeoutMs : 30_000,
  );
  const status = parseExtensionServerStatus(response);
  if (!status || !isRecord(response)) {
    throw new Error('Invalid extension restart response');
  }

  return {
    ...status,
    restarted: response.restarted === true,
  };
}

export async function setExtensionServerRunning(
  request: RemuxConnection['request'],
  extensionId: string,
  running: boolean,
  options?: { rebuild?: boolean },
): Promise<ExtensionServerStatus & { changed: boolean }> {
  const rebuild = running && options?.rebuild === true;
  const response = await request<unknown>(
    running ? extensionStartMethod : extensionStopMethod,
    { extensionId, ...(rebuild ? { rebuild: true } : {}) },
    rebuild ? rebuildTimeoutMs : 30_000,
  );
  const status = parseExtensionServerStatus(response);
  if (!status || !isRecord(response)) {
    throw new Error(`Invalid extension ${running ? 'start' : 'stop'} response`);
  }

  return {
    ...status,
    changed: response.started === true || response.stopped === true,
  };
}

export async function readExtensionLogs(
  request: RemuxConnection['request'],
  extensionId: string,
  lines = 500,
): Promise<ExtensionLogLine[]> {
  const response = await request<unknown>(extensionLogsMethod, { extensionId, lines }, 8_000);
  if (!isRecord(response) || !Array.isArray(response.lines)) {
    throw new Error('Invalid extension logs response');
  }

  return response.lines.flatMap(parseExtensionLogLine);
}

export async function subscribeExtensionLogs(
  request: RemuxConnection['request'],
  extensionId: string,
): Promise<void> {
  await request<unknown>(extensionLogsSubscribeMethod, { extensionId }, 8_000);
}

export async function unsubscribeExtensionLogs(
  request: RemuxConnection['request'],
  extensionId: string,
): Promise<void> {
  await request<unknown>(extensionLogsUnsubscribeMethod, { extensionId }, 8_000);
}

/** Params of a `remux/extensions/logs/didAppend` notification. */
export function parseExtensionLogsDidAppend(
  params: unknown,
): { extensionId: string; lines: ExtensionLogLine[] } | null {
  if (!isRecord(params) || typeof params.extensionId !== 'string' || !Array.isArray(params.lines)) {
    return null;
  }

  return {
    extensionId: params.extensionId,
    lines: params.lines.flatMap(parseExtensionLogLine),
  };
}

/**
 * Parses a management response or `didChangeStatus` params object. Pass-2
 * fields degrade gracefully against a pass-1 runtime (state derived from
 * `running`, counters zeroed).
 */
export function parseExtensionServerStatus(raw: unknown): ExtensionServerStatus | null {
  if (!isRecord(raw) || typeof raw.extensionId !== 'string') {
    return null;
  }

  const running = raw.running === true;
  return {
    extensionId: raw.extensionId,
    restartable: raw.restartable === true,
    running,
    state: parseServerState(raw.state) ?? (running ? 'running' : 'stopped'),
    pid: typeof raw.pid === 'number' ? raw.pid : null,
    startedAtMs: typeof raw.startedAtMs === 'number' ? raw.startedAtMs : null,
    restartCount: typeof raw.restartCount === 'number' ? raw.restartCount : 0,
    lastExit: parseLastExit(raw.lastExit),
    hasBuild: raw.hasBuild === true,
  };
}

function parseServerState(value: unknown): ExtensionServerState | null {
  switch (value) {
    case 'stopped':
    case 'building':
    case 'starting':
    case 'running':
    case 'stopping':
    case 'backingOff':
    case 'failed':
      return value;
    default:
      return null;
  }
}

function parseLastExit(value: unknown): ExtensionServerLastExit | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    code: typeof value.code === 'number' ? value.code : null,
    signal: typeof value.signal === 'string' ? value.signal : null,
    at: typeof value.at === 'number' ? value.at : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
  };
}

function parseExtensionLogLine(raw: unknown): ExtensionLogLine[] {
  if (!isRecord(raw) || typeof raw.line !== 'string') {
    return [];
  }

  return [{
    ts: typeof raw.ts === 'string' ? raw.ts : '',
    stream: typeof raw.stream === 'string' ? raw.stream : 'stderr',
    line: raw.line,
  }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
