import type { RemuxConnection } from '../remote/RemuxConnectionProvider';

const agentRuntimesReadMethod = 'remux/agent/runtimes/read';

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
  adapterVersion: string | null;
  sdkVersion: string | null;
  restartRequired: boolean;
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
    || !nullableString(value.adapterVersion)
    || !nullableString(value.sdkVersion)
    || typeof value.restartRequired !== 'boolean'
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
    adapterVersion: value.adapterVersion,
    sdkVersion: value.sdkVersion,
    restartRequired: value.restartRequired,
    activeSessions: Number(value.activeSessions),
    lastError: value.lastError,
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
