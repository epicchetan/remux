import type { RemuxConnection } from '../remote/RemuxConnectionProvider';

const agentRuntimesReadMethod = 'remux/agent/runtimes/read';
const agentRuntimeUpdateMethod = 'remux/agent/runtime/update';
const agentRuntimeRestartMethod = 'remux/agent/runtime/restart';

export type AgentHarnessSessionVersion = { version: string; sessions: number };

export type AgentHarnessRuntime = {
  providerInstanceId: string;
  provider: 'codex' | 'claude-code' | 'fixture';
  label: string;
  readiness: 'ready' | 'signed-out' | 'missing' | 'incompatible' | 'error';
  readinessMessage: string | null;
  topology: 'shared-daemon' | 'session-process' | 'fixture';
  runtimeState: 'running' | 'idle' | 'stopped' | 'starting' | 'stopping' | 'failed' | 'unknown';
  configuredExecutable: string | null;
  resolvedExecutable: string | null;
  installedVersion: string | null;
  runningVersion: string | null;
  sessionVersions: AgentHarnessSessionVersion[];
  availableVersion: string | null;
  updateCheckedAt: number | null;
  adapterVersion: string | null;
  sdkVersion: string | null;
  restartRequired: boolean;
  supportsUpdate: boolean;
  supportsRestart: boolean;
  activeSessions: number;
  lastError: string | null;
};

export type AgentHarnessRuntimes = {
  runtimes: AgentHarnessRuntime[];
  observedAt: number;
};

export async function readAgentHarnessRuntimes(
  query: RemuxConnection['query'],
): Promise<AgentHarnessRuntimes | null> {
  try {
    const response = await query<unknown>(agentRuntimesReadMethod, undefined, {
      resourceKey: 'agent-runtimes',
    });
    return parseAgentHarnessRuntimes(response);
  } catch (error) {
    if (isMethodNotFound(error)) return null;
    throw error;
  }
}

export function parseAgentHarnessRuntimes(value: unknown): AgentHarnessRuntimes {
  if (!isRecord(value) || !Array.isArray(value.runtimes) || !isFiniteNumber(value.observedAt)) {
    throw new Error('Invalid Agent runtime status response');
  }
  const runtimes = value.runtimes.map((entry, index) => parseRuntime(entry, index));
  return { runtimes, observedAt: value.observedAt };
}

function parseRuntime(value: unknown, index: number): AgentHarnessRuntime {
  if (!isRecord(value)) throw new Error(`Invalid Agent runtime at index ${index}`);
  const provider = member(value.provider, ['codex', 'claude-code', 'fixture']);
  const readiness = member(value.readiness, ['ready', 'signed-out', 'missing', 'incompatible', 'error']);
  const topology = member(value.topology, ['shared-daemon', 'session-process', 'fixture']);
  const runtimeState = member(value.runtimeState, [
    'running', 'idle', 'stopped', 'starting', 'stopping', 'failed', 'unknown',
  ]);
  if (
    !provider || !readiness || !topology || !runtimeState
    || !nonempty(value.providerInstanceId) || !nonempty(value.label)
    || !nullableString(value.readinessMessage)
    || !nullableString(value.configuredExecutable)
    || !nullableString(value.resolvedExecutable)
    || !nullableString(value.installedVersion)
    || !nullableString(value.runningVersion)
    || !nullableString(value.availableVersion)
    || !(value.updateCheckedAt === null || isFiniteNumber(value.updateCheckedAt))
    || !nullableString(value.adapterVersion)
    || !nullableString(value.sdkVersion)
    || typeof value.restartRequired !== 'boolean'
    || typeof value.supportsUpdate !== 'boolean'
    || typeof value.supportsRestart !== 'boolean'
    || !Number.isSafeInteger(value.activeSessions) || Number(value.activeSessions) < 0
    || !nullableString(value.lastError)
  ) throw new Error(`Invalid Agent runtime at index ${index}`);
  return {
    providerInstanceId: value.providerInstanceId,
    provider,
    label: value.label,
    readiness,
    readinessMessage: value.readinessMessage,
    topology,
    runtimeState,
    configuredExecutable: value.configuredExecutable,
    resolvedExecutable: value.resolvedExecutable,
    installedVersion: value.installedVersion,
    runningVersion: value.runningVersion,
    sessionVersions: parseSessionVersions(value.sessionVersions, index),
    availableVersion: value.availableVersion,
    updateCheckedAt: value.updateCheckedAt === null ? null : Number(value.updateCheckedAt),
    adapterVersion: value.adapterVersion,
    sdkVersion: value.sdkVersion,
    restartRequired: value.restartRequired,
    supportsUpdate: value.supportsUpdate,
    supportsRestart: value.supportsRestart,
    activeSessions: Number(value.activeSessions),
    lastError: value.lastError,
  };
}

function parseSessionVersions(value: unknown, index: number): AgentHarnessSessionVersion[] {
  if (!Array.isArray(value)) throw new Error(`Invalid Agent runtime at index ${index}`);
  return value.map((entry) => {
    if (!isRecord(entry) || !nonempty(entry.version) || !Number.isSafeInteger(entry.sessions)
      || Number(entry.sessions) < 0) {
      throw new Error(`Invalid Agent runtime session versions at index ${index}`);
    }
    return { version: entry.version, sessions: Number(entry.sessions) };
  });
}

/**
 * Installs the newest harness release. Safe with turns in flight — a running
 * session holds the binary it already exec'd — so this never waits for idle.
 */
export async function updateAgentHarnessRuntime(
  command: RemuxConnection['command'],
  providerInstanceId: string,
): Promise<{ runtime: AgentHarnessRuntime; log: string[] }> {
  // Installing can run for minutes, and the phone's socket may be replaced
  // mid-flight: an operationId makes this a durable command, so a reconnect
  // replays the original result instead of installing twice.
  const response = await command<unknown>(agentRuntimeUpdateMethod, { providerInstanceId }, {
    operationId: `agent-runtime-update:${providerInstanceId}:${Date.now()}`,
  });
  if (!isRecord(response)) throw new Error('Invalid Agent runtime update response');
  return {
    runtime: parseRuntime(response.runtime, 0),
    log: Array.isArray(response.log) ? response.log.filter((line): line is string => typeof line === 'string') : [],
  };
}

/**
 * Moves idle sessions onto the installed binary; anything with a turn in
 * flight keeps running and the response log says so.
 */
export async function restartAgentHarnessRuntime(
  command: RemuxConnection['command'],
  providerInstanceId: string,
): Promise<{ runtime: AgentHarnessRuntime; log: string[] }> {
  const response = await command<unknown>(agentRuntimeRestartMethod, { providerInstanceId }, {
    operationId: `agent-runtime-restart:${providerInstanceId}:${Date.now()}`,
  });
  if (!isRecord(response)) throw new Error('Invalid Agent runtime restart response');
  return {
    runtime: parseRuntime(response.runtime, 0),
    log: Array.isArray(response.log) ? response.log.filter((line): line is string => typeof line === 'string') : [],
  };
}

function member<const T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === 'string' && values.includes(value as T) ? value as T : null;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMethodNotFound(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('-32601') || message.toLowerCase().includes('method not found');
}
