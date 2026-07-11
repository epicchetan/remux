import type { RemuxConnection } from '../remote/RemuxConnectionProvider';

const extensionStatusMethod = 'remux/extensions/status';
const extensionStartMethod = 'remux/extensions/start';
const extensionStopMethod = 'remux/extensions/stop';
const extensionRestartMethod = 'remux/extensions/restart';
const extensionWatchStartMethod = 'remux/extensions/watch/start';
const extensionWatchStopMethod = 'remux/extensions/watch/stop';
const extensionServerBuildMethod = 'remux/extensions/server/build';
const extensionViewsBuildMethod = 'remux/extensions/views/build';
const extensionLogsMethod = 'remux/extensions/logs';
const extensionLogsSubscribeMethod = 'remux/extensions/logs/subscribe';
const extensionLogsUnsubscribeMethod = 'remux/extensions/logs/unsubscribe';
const codexAppServerStatusMethod = 'remux/codex/app-server/status/read';

export const extensionDidChangeStatusMethod = 'remux/extensions/didChangeStatus';
export const extensionLogsDidAppendMethod = 'remux/extensions/logs/didAppend';

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

/** Watch is a facet of extension status, not a lifecycle state. */
export type ExtensionWatchState = 'stopped' | 'running' | 'failed';

export type ExtensionViewsFacet = {
  /** Views with a declared build; 0 means the facet is inert. */
  declared: number;
  built: boolean;
  lastBuildAtMs: number | null;
};

export type ExtensionWatchFacet = {
  declared: boolean;
  state: ExtensionWatchState;
  pid: number | null;
  startedAtMs: number | null;
  restartCount: number;
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
  /**
   * View-build-watch additive facets; defaulted against a pass-2 runtime so
   * every new control hides itself (`hasServer: true`, `views.declared: 0`,
   * `watch.declared: false`).
   */
  hasServer: boolean;
  /** `server.build` specifically — gates the server Build button. */
  hasServerBuild: boolean;
  views: ExtensionViewsFacet;
  watch: ExtensionWatchFacet;
};

export type ExtensionLogLine = {
  ts: string;
  stream: string;
  line: string;
  area: 'server' | 'viewer';
  componentId: string;
  source: 'lifecycle' | 'process' | 'connection' | 'build' | 'watch' | 'update';
  channel: 'stdout' | 'stderr' | null;
  level: 'info' | 'warn' | 'error' | null;
  viewId: string | null;
};

export type CodexAppServerState = 'running' | 'stopped' | 'starting' | 'stopping' | 'failed';

export type CodexAppServerStatus = {
  state: CodexAppServerState;
  socketPath: string | null;
  managedCodexPath: string | null;
  installedVersion: string | null;
  runningVersion: string | null;
  restartRequired: boolean;
  lastError: string | null;
  activeTurnIds: string[];
};

export type CodexAppServerAction = 'start' | 'stop' | 'restart' | 'update';
export type JobAdmission = {
  accepted: boolean;
  operationId: string;
  revision: number;
};

export async function readExtensionServerStatuses(
  query: RemuxConnection['query'],
): Promise<ExtensionServerStatus[]> {
  const response = await query<unknown>(extensionStatusMethod, undefined, {
    resourceKey: 'extension-statuses',
  });
  if (!isRecord(response) || !Array.isArray(response.extensions)) {
    throw new Error('Invalid extension status response');
  }

  return response.extensions.flatMap((entry) => {
    const status = parseExtensionServerStatus(entry);
    return status ? [status] : [];
  });
}

export async function restartExtensionServer(
  startJob: RemuxConnection['startJob'],
  extensionId: string,
  options?: { rebuild?: boolean },
): Promise<JobAdmission> {
  const rebuild = options?.rebuild === true;
  const response = await startJob<unknown>(
    extensionRestartMethod,
    { extensionId, ...(rebuild ? { rebuild: true } : {}) },
    { operationId: newOperationId(`extension:${extensionId}:restart`) },
  );
  return parseJobAdmission(response);
}

export async function setExtensionServerRunning(
  startJob: RemuxConnection['startJob'],
  extensionId: string,
  running: boolean,
  options?: { rebuild?: boolean },
): Promise<JobAdmission> {
  const rebuild = running && options?.rebuild === true;
  const method = running ? extensionStartMethod : extensionStopMethod;
  const response = await startJob<unknown>(
    method,
    { extensionId, ...(rebuild ? { rebuild: true } : {}) },
    { operationId: newOperationId(`extension:${extensionId}:${running ? 'start' : 'stop'}`) },
  );
  return parseJobAdmission(response);
}

/**
 * Starts/stops the view-watch sidecar. Start may gate on an initial view
 * build, so it gets the rebuild timeout; stop uses the standard 30s.
 */
export async function setExtensionWatchRunning(
  startJob: RemuxConnection['startJob'],
  extensionId: string,
  running: boolean,
): Promise<JobAdmission> {
  const response = await startJob<unknown>(
    running ? extensionWatchStartMethod : extensionWatchStopMethod,
    { extensionId },
    { operationId: newOperationId(`extension:${extensionId}:watch-${running ? 'start' : 'stop'}`) },
  );
  return parseJobAdmission(response);
}

/**
 * Manual builds. `server` stages a new binary without restarting a running
 * server; `views` force-runs every declared view build.
 */
export async function buildExtension(
  startJob: RemuxConnection['startJob'],
  extensionId: string,
  target: 'server' | 'views',
): Promise<JobAdmission> {
  const method = target === 'server' ? extensionServerBuildMethod : extensionViewsBuildMethod;
  const response = await startJob<unknown>(
    method,
    { extensionId },
    { operationId: newOperationId(`extension:${extensionId}:${target}-build`) },
  );
  return parseJobAdmission(response);
}

export async function readExtensionLogs(
  query: RemuxConnection['query'],
  extensionId: string,
  lines = 500,
): Promise<ExtensionLogLine[]> {
  const response = await query<unknown>(extensionLogsMethod, { extensionId, lines }, {
    resourceKey: `extension-logs:${extensionId}`,
  });
  if (!isRecord(response) || !Array.isArray(response.lines)) {
    throw new Error('Invalid extension logs response');
  }

  return response.lines.flatMap(parseExtensionLogLine);
}

export async function subscribeExtensionLogs(
  subscribeRequest: RemuxConnection['subscribeRequest'],
  extensionId: string,
): Promise<void> {
  await subscribeRequest<unknown>(extensionLogsSubscribeMethod, { extensionId }, {
    resourceKey: `extension-logs:${extensionId}`,
  });
}

export async function unsubscribeExtensionLogs(
  command: RemuxConnection['command'],
  extensionId: string,
): Promise<void> {
  await command<unknown>(extensionLogsUnsubscribeMethod, { extensionId });
}

export async function readCodexAppServerStatus(
  query: RemuxConnection['query'],
): Promise<CodexAppServerStatus | null> {
  try {
    const response = await query<unknown>(codexAppServerStatusMethod, undefined, {
      resourceKey: 'codex-app-server-status',
    });
    return parseCodexAppServerStatus(response);
  } catch (error) {
    if (isMethodNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export async function runCodexAppServerAction(
  startJob: RemuxConnection['startJob'],
  action: CodexAppServerAction,
): Promise<JobAdmission> {
  const method = `remux/codex/app-server/${action}`;
  const response = await startJob<unknown>(method, undefined, {
    operationId: newOperationId(`codex-app-server:${action}`),
  });
  return parseJobAdmission(response);
}

function newOperationId(prefix: string) {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function parseJobAdmission(value: unknown): JobAdmission {
  if (
    !isRecord(value)
    || typeof value.accepted !== 'boolean'
    || typeof value.operationId !== 'string'
    || typeof value.revision !== 'number'
  ) {
    throw new Error('Invalid job admission response');
  }
  return {
    accepted: value.accepted,
    operationId: value.operationId,
    revision: value.revision,
  };
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
    hasServer: raw.hasServer !== false,
    // Pass-2 runtimes (no views facet) only ever set hasBuild for a server
    // build, so it doubles as the fallback.
    hasServerBuild: raw.hasServerBuild === true || (!isRecord(raw.views) && raw.hasBuild === true),
    views: parseViewsFacet(raw.views),
    watch: parseWatchFacet(raw.watch),
  };
}

function parseViewsFacet(value: unknown): ExtensionViewsFacet {
  if (!isRecord(value)) {
    return { declared: 0, built: false, lastBuildAtMs: null };
  }

  return {
    declared: typeof value.declared === 'number' ? value.declared : 0,
    built: value.built === true,
    lastBuildAtMs: typeof value.lastBuildAtMs === 'number' ? value.lastBuildAtMs : null,
  };
}

function parseWatchFacet(value: unknown): ExtensionWatchFacet {
  const stopped: ExtensionWatchFacet = {
    declared: false,
    state: 'stopped',
    pid: null,
    startedAtMs: null,
    restartCount: 0,
  };
  if (!isRecord(value) || value.declared !== true) {
    return stopped;
  }

  return {
    declared: true,
    state: parseWatchState(value.state),
    pid: typeof value.pid === 'number' ? value.pid : null,
    startedAtMs: typeof value.startedAtMs === 'number' ? value.startedAtMs : null,
    restartCount: typeof value.restartCount === 'number' ? value.restartCount : 0,
  };
}

function parseWatchState(value: unknown): ExtensionWatchState {
  switch (value) {
    case 'running':
    case 'failed':
      return value;
    default:
      return 'stopped';
  }
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

export function parseExtensionLogLine(raw: unknown): ExtensionLogLine[] {
  if (!isRecord(raw) || typeof raw.line !== 'string') {
    return [];
  }

  const stream = typeof raw.stream === 'string' ? raw.stream : 'stderr';
  const structuredArea = raw.area === 'server' || raw.area === 'viewer' ? raw.area : null;
  const structuredSource = parseLogSource(raw.source);
  const structuredComponent = typeof raw.componentId === 'string' && raw.componentId.length > 0
    ? raw.componentId
    : null;
  const structuredChannel = raw.channel === null
    ? null
    : raw.channel === 'stdout' || raw.channel === 'stderr'
      ? raw.channel
      : undefined;
  const structuredLevel = raw.level === null
    ? null
    : raw.level === 'info' || raw.level === 'warn' || raw.level === 'error'
      ? raw.level
      : undefined;
  const hasStructuredMetadata = structuredArea !== null
    && structuredSource !== null
    && structuredComponent !== null
    && structuredChannel !== undefined
    && structuredLevel !== undefined;
  const legacy = legacyLogMetadata(stream);

  return [{
    ts: typeof raw.ts === 'string' ? raw.ts : '',
    stream,
    line: raw.line,
    area: hasStructuredMetadata ? structuredArea : legacy.area,
    componentId: hasStructuredMetadata ? structuredComponent : legacy.componentId,
    source: hasStructuredMetadata ? structuredSource : legacy.source,
    channel: hasStructuredMetadata ? structuredChannel : legacy.channel,
    level: hasStructuredMetadata ? structuredLevel : null,
    viewId: hasStructuredMetadata && (typeof raw.viewId === 'string' || raw.viewId === null)
      ? raw.viewId
      : legacy.viewId,
  }];
}

function legacyLogMetadata(stream: string): Pick<
  ExtensionLogLine,
  'area' | 'componentId' | 'source' | 'channel' | 'viewId'
> {
  if (stream === 'watch') {
    return {
      area: 'viewer',
      componentId: 'viewer:main',
      source: 'watch',
      channel: null,
      viewId: 'main',
    };
  }
  return {
    area: 'server',
    componentId: 'extension-server',
    source: stream === 'build' ? 'build' : stream === 'lifecycle' ? 'lifecycle' : 'process',
    channel: stream === 'stderr' ? 'stderr' : null,
    viewId: null,
  };
}

function parseLogSource(value: unknown): ExtensionLogLine['source'] | null {
  switch (value) {
    case 'lifecycle':
    case 'process':
    case 'connection':
    case 'build':
    case 'watch':
    case 'update':
      return value;
    default:
      return null;
  }
}

export function parseCodexAppServerStatus(raw: unknown): CodexAppServerStatus | null {
  if (!isRecord(raw)) {
    return null;
  }
  const state = parseCodexAppServerState(raw.state);
  if (!state) {
    return null;
  }
  const installedVersion = typeof raw.installedVersion === 'string' ? raw.installedVersion : null;
  const runningVersion = typeof raw.runningVersion === 'string' ? raw.runningVersion : null;
  return {
    state,
    socketPath: typeof raw.socketPath === 'string' ? raw.socketPath : null,
    managedCodexPath: typeof raw.managedCodexPath === 'string' ? raw.managedCodexPath : null,
    installedVersion,
    runningVersion,
    restartRequired: raw.restartRequired === true
      || (installedVersion !== null && runningVersion !== null && installedVersion !== runningVersion),
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    activeTurnIds: Array.isArray(raw.activeTurnIds)
      ? raw.activeTurnIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

function parseCodexAppServerState(value: unknown): CodexAppServerState | null {
  switch (value) {
    case 'running':
    case 'stopped':
    case 'starting':
    case 'stopping':
    case 'failed':
      return value;
    default:
      return null;
  }
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof Error && /method not found/i.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
