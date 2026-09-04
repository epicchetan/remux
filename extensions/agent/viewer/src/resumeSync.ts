import { useCallback, useEffect, useRef } from 'react';
import {
  getHostLifecycleSnapshot,
  getHostStatusSnapshot,
  subscribeHostLifecycle,
  subscribeHostResume,
  type RemuxHostResumeReason,
} from '@remux/viewer-kit/host';

import {
  recoverActiveTranscriptResources,
  setTranscriptLifecycleState,
} from './transcript/resourceStore';
import { setTranscriptViewportLifecycleState } from './transcript/viewportStore';

export type AgentResumeSyncReason = RemuxHostResumeReason;

export function useAgentResumeSync(
  refreshResources: (reason: AgentResumeSyncReason) => Promise<void>,
) {
  const refreshRef = useRef(refreshResources);
  const inFlight = useRef(false);
  const mounted = useRef(true);
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
    const startedAt = Date.now();
    console.info(`[agent resume] start ${JSON.stringify({ reason })}`);
    void Promise.allSettled([
      refreshRef.current(reason),
      recoverActiveTranscriptResources({
        attempts: 4,
        forceFullMeasure: false,
        preserveReady: true,
        revalidateDetails: true,
        // Resume is an authoritative catch-up after a period where order-changing
        // invalidations may have been lost. A preserved old range cannot reveal
        // turns appended while the WebView was suspended.
        windowPolicy: 'tail',
      }),
    ]).then(([resourceResult, transcriptResult]) => {
      const failures = [
        ...(resourceResult.status === 'rejected'
          ? [{ message: errorMessage(resourceResult.reason), task: 'resources' }]
          : []),
        ...(transcriptResult.status === 'rejected'
          ? [{ message: errorMessage(transcriptResult.reason), task: 'transcript' }]
          : []),
      ];
      console.info(`[agent resume] done ${JSON.stringify({
        durationMs: Date.now() - startedAt,
        failures,
        reason,
        recovered: transcriptResult.status === 'fulfilled' && transcriptResult.value,
      })}`);
    }).finally(() => {
      inFlight.current = false;
      if (!mounted.current) return;
      const next = pending.current;
      pending.current = null;
      if (next) run(next);
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribeResume = subscribeHostResume(run);
    const unsubscribeLifecycle = subscribeHostLifecycle((lifecycle) => {
      setTranscriptLifecycleState(lifecycle.state);
      setTranscriptViewportLifecycleState(lifecycle.state);
    });
    return () => {
      mounted.current = false;
      unsubscribeLifecycle();
      unsubscribeResume();
    };
  }, [run]);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
