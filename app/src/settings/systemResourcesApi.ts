import type { RemuxConnection } from '../remote/RemuxConnectionProvider';

const systemResourcesMethod = 'remux/system/resources';
const systemResourcesSubscribeMethod = 'remux/system/resources/subscribe';
const systemResourcesUnsubscribeMethod = 'remux/system/resources/unsubscribe';

export const systemResourcesDidSampleMethod = 'remux/system/resources/didSample';

export type SystemResourcesSample = {
  sampledAtMs: number;
  system: {
    load1: number;
    load5: number;
    load15: number;
    memTotalBytes: number;
    memAvailableBytes: number;
    diskTotalBytes: number;
    diskFreeBytes: number;
  };
  runtime: {
    pid: number;
    cpuPercent: number;
    rssBytes: number;
    uptimeMs: number;
  };
  extensions: ExtensionResourceSample[];
  resourceProtection: {
    protectedMode: boolean;
    reasons: string[];
    reservedCpus: number[];
  } | null;
};

export type ExtensionResourceSample = {
  extensionId: string;
  state: string;
  pid: number | null;
  processCount: number;
  cpuPercent: number;
  rssBytes: number;
  uptimeMs: number | null;
  restartCount: number;
  roles: {
    server: ExtensionRoleResourceSample | null;
    watch: ExtensionRoleResourceSample | null;
  };
};

export type ExtensionRoleResourceSample = {
  pid: number;
  processCount: number;
  cpuPercent: number;
  rssBytes: number;
};

/**
 * Latest sample, or `null` against a pass-1 runtime (unknown method) — the
 * caller hides the System section in that case.
 */
export async function readSystemResources(
  query: RemuxConnection['query'],
): Promise<SystemResourcesSample | null> {
  let response: unknown;
  try {
    response = await query<unknown>(systemResourcesMethod, undefined, {
      resourceKey: 'system-resources',
    });
  } catch (error) {
    if (isMethodNotFound(error)) {
      return null;
    }
    throw error;
  }
  return parseSystemResourcesSample(response);
}

export async function subscribeSystemResources(
  subscribeRequest: RemuxConnection['subscribeRequest'],
): Promise<void> {
  await subscribeRequest<unknown>(systemResourcesSubscribeMethod, undefined, {
    resourceKey: 'system-resources',
  });
}

export async function unsubscribeSystemResources(
  command: RemuxConnection['command'],
): Promise<void> {
  await command<unknown>(systemResourcesUnsubscribeMethod);
}

export function parseSystemResourcesSample(raw: unknown): SystemResourcesSample | null {
  if (!isRecord(raw) || typeof raw.sampledAtMs !== 'number') {
    return null;
  }
  const system = isRecord(raw.system) ? raw.system : {};
  const runtime = isRecord(raw.runtime) ? raw.runtime : {};
  const extensions = Array.isArray(raw.extensions) ? raw.extensions : [];
  const protection = isRecord(raw.resourceProtection) ? raw.resourceProtection : null;

  return {
    sampledAtMs: raw.sampledAtMs,
    system: {
      load1: numberOrZero(system.load1),
      load5: numberOrZero(system.load5),
      load15: numberOrZero(system.load15),
      memTotalBytes: numberOrZero(system.memTotalBytes),
      memAvailableBytes: numberOrZero(system.memAvailableBytes),
      diskTotalBytes: numberOrZero(system.diskTotalBytes),
      diskFreeBytes: numberOrZero(system.diskFreeBytes),
    },
    runtime: {
      pid: numberOrZero(runtime.pid),
      cpuPercent: numberOrZero(runtime.cpuPercent),
      rssBytes: numberOrZero(runtime.rssBytes),
      uptimeMs: numberOrZero(runtime.uptimeMs),
    },
    extensions: extensions.flatMap(parseExtensionResourceSample),
    resourceProtection: protection
      ? {
        protectedMode: protection.protectedMode === true,
        reasons: Array.isArray(protection.reasons)
          ? protection.reasons.filter((reason): reason is string => typeof reason === 'string')
          : [],
        reservedCpus: Array.isArray(protection.reservedCpus)
          ? protection.reservedCpus.filter((cpu): cpu is number => typeof cpu === 'number')
          : [],
      }
      : null,
  };
}

function parseExtensionResourceSample(raw: unknown): ExtensionResourceSample[] {
  if (!isRecord(raw) || typeof raw.extensionId !== 'string') {
    return [];
  }

  return [{
    extensionId: raw.extensionId,
    state: typeof raw.state === 'string' ? raw.state : 'stopped',
    pid: typeof raw.pid === 'number' ? raw.pid : null,
    processCount: numberOrZero(raw.processCount),
    cpuPercent: numberOrZero(raw.cpuPercent),
    rssBytes: numberOrZero(raw.rssBytes),
    uptimeMs: typeof raw.uptimeMs === 'number' ? raw.uptimeMs : null,
    restartCount: numberOrZero(raw.restartCount),
    roles: parseExtensionResourceRoles(raw.roles),
  }];
}

function parseExtensionResourceRoles(raw: unknown): ExtensionResourceSample['roles'] {
  const roles = isRecord(raw) ? raw : {};
  return {
    server: parseExtensionRoleResourceSample(roles.server),
    watch: parseExtensionRoleResourceSample(roles.watch),
  };
}

function parseExtensionRoleResourceSample(raw: unknown): ExtensionRoleResourceSample | null {
  if (!isRecord(raw) || typeof raw.pid !== 'number') {
    return null;
  }
  return {
    pid: raw.pid,
    processCount: numberOrZero(raw.processCount),
    cpuPercent: numberOrZero(raw.cpuPercent),
    rssBytes: numberOrZero(raw.rssBytes),
  };
}

function isMethodNotFound(error: unknown) {
  return error instanceof Error && /method not found/i.test(error.message);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
