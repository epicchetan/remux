import type { RemuxConnection } from '../remote/RemuxConnectionProvider';

const extensionStatusMethod = 'remux/extensions/status';
const extensionStartMethod = 'remux/extensions/start';
const extensionStopMethod = 'remux/extensions/stop';
const extensionRestartMethod = 'remux/extensions/restart';

export type ExtensionServerStatus = {
  extensionId: string;
  restartable: boolean;
  running: boolean;
};

export async function readExtensionServerStatuses(
  request: RemuxConnection['request'],
): Promise<ExtensionServerStatus[]> {
  const response = await request<unknown>(extensionStatusMethod, undefined, 8_000);
  if (!isRecord(response) || !Array.isArray(response.extensions)) {
    throw new Error('Invalid extension status response');
  }

  return response.extensions.flatMap(parseExtensionServerStatus);
}

export async function restartExtensionServer(
  request: RemuxConnection['request'],
  extensionId: string,
): Promise<ExtensionServerStatus & { restarted: boolean }> {
  const response = await request<unknown>(extensionRestartMethod, { extensionId }, 30_000);
  const status = parseExtensionServerStatus(response)[0];
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
): Promise<ExtensionServerStatus & { changed: boolean }> {
  const response = await request<unknown>(
    running ? extensionStartMethod : extensionStopMethod,
    { extensionId },
    30_000,
  );
  const status = parseExtensionServerStatus(response)[0];
  if (!status || !isRecord(response)) {
    throw new Error(`Invalid extension ${running ? 'start' : 'stop'} response`);
  }

  return {
    ...status,
    changed: response.started === true || response.stopped === true,
  };
}

function parseExtensionServerStatus(raw: unknown): ExtensionServerStatus[] {
  if (!isRecord(raw) || typeof raw.extensionId !== 'string') {
    return [];
  }

  return [{
    extensionId: raw.extensionId,
    restartable: raw.restartable === true,
    running: raw.running === true,
  }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
