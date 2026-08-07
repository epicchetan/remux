import { create } from 'zustand';

import {
  getHostStatusSnapshot,
  getHostViewportMetrics,
  subscribeHostStatus,
  subscribeHostViewportMetrics,
} from '@remux/viewer-kit/host';
import type { AgentViewHostStatus, RemuxHostViewportMetrics } from './types';

type HostStoreState = {
  connectionStatus: AgentViewHostStatus;
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
    if (initialized) return;
    const status = getHostStatusSnapshot();
    set({ connectionStatus: status.status, error: status.error });
    subscribeHostStatus((next) => {
      set({ connectionStatus: next.status, error: next.error });
    });
    subscribeHostViewportMetrics((hostViewportMetrics) => {
      set({ hostViewportMetrics });
    });
    initialized = true;
  },
}));
