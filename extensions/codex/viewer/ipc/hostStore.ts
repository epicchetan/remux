import { create } from 'zustand';

import {
  getHostStatusSnapshot,
  getHostViewportMetrics,
  subscribeHostStatus,
  subscribeHostViewportMetrics,
} from '@remux/viewer-kit/host';
import { initializeIpc } from '@remux/viewer-kit/ipc';
import type { CodexViewHostStatus, RemuxHostViewportMetrics } from './types';

type HostStoreState = {
  connectionStatus: CodexViewHostStatus;
  error: string | null;
  hostViewportMetrics: RemuxHostViewportMetrics | null;
  getHostViewportMetrics: () => Promise<RemuxHostViewportMetrics>;
  initialize: () => void;
};

let initialized = false;

export const useHostStore = create<HostStoreState>((set) => ({
  connectionStatus: getHostStatusSnapshot().status,
  error: getHostStatusSnapshot().error,
  hostViewportMetrics: null,
  async getHostViewportMetrics() {
    const metrics = await getHostViewportMetrics();
    set({ hostViewportMetrics: metrics });
    return metrics;
  },
  initialize() {
    if (initialized) {
      return;
    }

    initializeIpc();
    const status = getHostStatusSnapshot();
    set({
      connectionStatus: status.status,
      error: status.error,
    });

    subscribeHostStatus((status) => {
      set({
        connectionStatus: status.status,
        error: status.error,
      });
    });

    subscribeHostViewportMetrics((hostViewportMetrics) => {
      set({ hostViewportMetrics });
    });

    initialized = true;
  },
}));
