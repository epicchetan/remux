import {
  getHostLifecycleSnapshot,
  subscribeHostLifecycle,
  subscribeHostResume,
} from '@remux/viewer-kit/host';
import { rpc, subscribeIpcEvents } from '@remux/viewer-kit/ipc';

import {
  decodeNarrationCancelResponse,
  decodeNarrationReadResponse,
  decodeNarrationStartResponse,
  decodeNarrationUpdatedNotification,
} from './decode';
import type { NarrationLifecycle } from './lifecycle';
import type { NarrationStartParams } from './protocol';
import type { NarrationTransport } from './transport';

export const narrationCancelMethod = 'remux/narrate/narration/cancel';
export const narrationReadMethod = 'remux/narrate/narration/resources/read';
export const narrationStartMethod = 'remux/narrate/narration/start';
export const narrationUpdatedMethod = 'remux/narrate/narration/updated';

export function createRemuxNarrationTransport(): NarrationTransport {
  return {
    async cancel(params) {
      const response = await rpc.command<unknown>(narrationCancelMethod, params, {
        operationId: `narration:${params.artifactKey}`,
      });
      return decodeNarrationCancelResponse(response, params.artifactKey);
    },
    async read(params) {
      const response = await rpc.query<unknown>(narrationReadMethod, params, {
        resourceKey: `narration:${params.artifactKey}`,
      });
      return decodeNarrationReadResponse(response, params.artifactKey);
    },
    async start(params) {
      const response = await rpc.startJob<unknown>(narrationStartMethod, params, {
        operationId: `narration:${documentOperationKey(params)}`,
      });
      return decodeNarrationStartResponse(response);
    },
    subscribeUpdated(listener) {
      return subscribeIpcEvents((events) => {
        for (const event of events) {
          if (event.method !== narrationUpdatedMethod) continue;
          try {
            listener(decodeNarrationUpdatedNotification(event.params));
          } catch {
            // Invalid hints are ignored. The controller's polling read remains
            // authoritative and is decoded before it can mutate state.
          }
        }
      });
    },
  };
}

export function createRemuxNarrationLifecycle(): NarrationLifecycle {
  return {
    snapshot: () => ({ state: getHostLifecycleSnapshot().state }),
    subscribe: (listener) => subscribeHostLifecycle((lifecycle) => listener(lifecycle.state)),
    subscribeResume: (listener) => subscribeHostResume(() => listener()),
  };
}

function documentOperationKey(params: NarrationStartParams) {
  const value = JSON.stringify(params.document);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
