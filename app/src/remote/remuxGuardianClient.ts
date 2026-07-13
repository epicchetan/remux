import { guardianOrigin } from './remuxEndpoints';

export type GuardianStatus = {
  consecutiveBootFailures: number;
  nextRetryAtMs: number | null;
  protected: boolean;
  protecting: boolean;
  reasons: string[];
  workerHeartbeatAgeMs: number | null;
  workerPid: number | null;
  workerState: 'backingOff' | 'ready' | 'starting' | 'stopped' | 'unknown';
};

export type GuardianExtension = {
  active: boolean;
  error: string | null;
  id: string;
  name: string;
  state: 'invalid' | 'valid';
};

export type GuardianConnection =
  | { state: 'unknown' | 'probing' }
  | { error: string | null; state: 'unavailable' }
  | { state: 'available'; status: GuardianStatus | null };

export async function probeGuardian(
  runtimeOrigin: string,
  token: string | null,
): Promise<GuardianConnection> {
  const origin = guardianOrigin(runtimeOrigin);
  const health = await guardianFetch(origin, '/healthz', token, false);
  if (!health.ok) {
    return { error: health.error, state: 'unavailable' };
  }

  const status = await guardianFetch(origin, '/control/v1/status', token, true);
  return {
    state: 'available',
    status: status.ok ? parseGuardianStatus(status.value) : null,
  };
}

export async function readGuardianExtensions(
  runtimeOrigin: string,
  token: string | null,
): Promise<GuardianExtension[]> {
  const result = await guardianFetch(
    guardianOrigin(runtimeOrigin),
    '/control/v1/extensions',
    token,
    true,
  );
  if (!result.ok) {
    throw new Error(result.error ?? 'Guardian extension inventory failed');
  }
  if (!isRecord(result.value) || !Array.isArray(result.value.extensions)) {
    throw new Error('Invalid guardian extension inventory');
  }
  return result.value.extensions.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      return [];
    }
    return [{
      active: entry.active === true,
      error: typeof entry.error === 'string' ? entry.error : null,
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      state: entry.state === 'invalid' ? 'invalid' as const : 'valid' as const,
    }];
  });
}

export async function runGuardianAction(
  runtimeOrigin: string,
  token: string | null,
  action: string,
) {
  const result = await guardianFetch(
    guardianOrigin(runtimeOrigin),
    `/control/v1/${action}`,
    token,
    true,
    'POST',
  );
  if (!result.ok) {
    throw new Error(result.error ?? 'Guardian operation failed');
  }
  return result.value;
}

type GuardianFetchResult =
  | { ok: true; value: unknown }
  | { error: string | null; ok: false };

async function guardianFetch(
  origin: string,
  path: string,
  token: string | null,
  authenticated: boolean,
  method: 'GET' | 'POST' = 'GET',
): Promise<GuardianFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`${origin}${path}`, {
      cache: 'no-store',
      headers: {
        ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
        ...(method === 'POST'
          ? { 'X-Remux-Operation-Id': `phone:${path}:${Date.now()}` }
          : {}),
      },
      method,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { error: `Guardian request failed (${response.status})`, ok: false };
    }
    return { ok: true, value: await response.json() as unknown };
  } catch (error) {
    return {
      error: controller.signal.aborted ? 'Guardian request timed out' : errorMessage(error),
      ok: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseGuardianStatus(value: unknown): GuardianStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  const workerState = value.workerState;
  return {
    consecutiveBootFailures: numberOrZero(value.consecutiveBootFailures),
    nextRetryAtMs: nullableNumber(value.nextRetryAtMs),
    protected: value.protected === true,
    protecting: value.protecting === true,
    reasons: Array.isArray(value.reasons)
      ? value.reasons.filter((reason): reason is string => typeof reason === 'string')
      : [],
    workerHeartbeatAgeMs: nullableNumber(value.workerHeartbeatAgeMs),
    workerPid: nullableNumber(value.workerPid),
    workerState: workerState === 'backingOff'
      || workerState === 'ready'
      || workerState === 'starting'
      || workerState === 'stopped'
      ? workerState
      : 'unknown',
  };
}

function nullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
