import { create } from 'zustand';

import { getHostViewportMetrics, subscribeHostViewportMetrics } from './host';
import {
  getIpcStatusSnapshot,
  initializeIpc,
  subscribeIpcStatus,
} from './client';
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
  connectionStatus: getIpcStatusSnapshot().status,
  error: getIpcStatusSnapshot().error,
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
    const status = getIpcStatusSnapshot();
    set({
      connectionStatus: status.status,
      error: status.error,
    });

    subscribeIpcStatus((status) => {
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
