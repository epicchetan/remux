import type { RemuxConnection } from '../remote/RemuxConnectionProvider';
import { rpcPolicies } from '@remux/viewer-kit/rpc-policy';

const remuxRestartMethod = 'remux/system/restart';

export async function restartRemuxCli(
  request: RemuxConnection['request'],
): Promise<{ restartable: boolean; restarting: boolean }> {
  const response = await request<unknown>(rpcPolicies['system-restart']);
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
