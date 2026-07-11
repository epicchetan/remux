import type { RemuxConnection } from '../remote/RemuxConnectionProvider';

const remuxRestartMethod = 'remux/system/restart';

export async function restartRemuxCli(
  command: RemuxConnection['command'],
): Promise<{ restartable: boolean; restarting: boolean }> {
  const response = await command<unknown>(remuxRestartMethod);
  if (!isRecord(response)) {
    throw new Error('Invalid Remux restart response');
  }

  return {
    restartable: response.restartable === true,
    restarting: response.restarting === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
