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
};

/**
 * Latest sample, or `null` against a pass-1 runtime (unknown method) — the
 * caller hides the System section in that case.
 */
export async function readSystemResources(
  request: RemuxConnection['request'],
): Promise<SystemResourcesSample | null> {
  let response: unknown;
  try {
    response = await request<unknown>(systemResourcesMethod, undefined, 8_000);
  } catch (error) {
    if (isMethodNotFound(error)) {
      return null;
    }
    throw error;
  }
  return parseSystemResourcesSample(response);
}

export async function subscribeSystemResources(request: RemuxConnection['request']): Promise<void> {
  await request<unknown>(systemResourcesSubscribeMethod, undefined, 8_000);
}

export async function unsubscribeSystemResources(request: RemuxConnection['request']): Promise<void> {
  await request<unknown>(systemResourcesUnsubscribeMethod, undefined, 8_000);
}

export function parseSystemResourcesSample(raw: unknown): SystemResourcesSample | null {
  if (!isRecord(raw) || typeof raw.sampledAtMs !== 'number') {
    return null;
  }
  const system = isRecord(raw.system) ? raw.system : {};
  const runtime = isRecord(raw.runtime) ? raw.runtime : {};
  const extensions = Array.isArray(raw.extensions) ? raw.extensions : [];

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
  }];
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
