import { useCallback, useEffect, useRef } from 'react';
import {
  getHostLifecycleSnapshot,
  getHostStatusSnapshot,
  subscribeHostLifecycle,
  subscribeHostResume,
  type RemuxHostResumeReason,
} from '@remux/viewer-kit/host';

import {
  refreshActiveTranscriptResources,
  setTranscriptLifecycleState,
} from './transcript/resourceStore';
import { getTranscriptViewportState, setTranscriptViewportLifecycleState } from './transcript/viewportStore';

export type AgentResumeSyncReason = RemuxHostResumeReason;

export function useAgentResumeSync(refreshResources: () => Promise<void>) {
  const refreshRef = useRef(refreshResources);
  const inFlight = useRef(false);
  const pending = useRef<AgentResumeSyncReason | null>(null);
  refreshRef.current = refreshResources;

  const run = useCallback((reason: AgentResumeSyncReason) => {
    if (
      getHostStatusSnapshot().status.type !== 'connected' ||
      getHostLifecycleSnapshot().state !== 'active'
    ) return;
    if (inFlight.current) {
      pending.current = reason;
      return;
    }
    inFlight.current = true;
    void Promise.allSettled([
      refreshRef.current(),
      refreshActiveTranscriptResources({
        forceFullMeasure: false,
        preserveReady: true,
        windowPolicy: getTranscriptViewportState().autoScrollMode.type === 'bottom' ? 'tail' : 'preserve',
      }),
    ]).finally(() => {
      inFlight.current = false;
      const next = pending.current;
      pending.current = null;
      if (next) run(next);
    });
  }, []);

  useEffect(() => {
    const unsubscribeResume = subscribeHostResume(run);
    const unsubscribeLifecycle = subscribeHostLifecycle((lifecycle) => {
      setTranscriptLifecycleState(lifecycle.state);
      setTranscriptViewportLifecycleState(lifecycle.state);
    });
    return () => {
      unsubscribeLifecycle();
      unsubscribeResume();
    };
  }, [run]);
}
