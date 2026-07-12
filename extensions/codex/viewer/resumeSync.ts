import { useCallback, useEffect, useRef } from 'react';

import {
  getHostLifecycleSnapshot,
  getHostStatusSnapshot,
  subscribeHostLifecycle,
  subscribeHostResume,
  type RemuxHostResumeReason,
} from '@remux/viewer-kit/host';

import { refreshActiveThreadComposerState } from './threads/composerStateStore';
import { refreshActiveThreadRuntime } from './threads/runtimeStore';
import { refreshActiveOperationQueue } from './threads/operationQueueStore';
import { refreshActiveTranscriptResources } from './transcript/store';
import { setTranscriptLifecycleState } from './transcript/resourceStore';

export type CodexResumeSyncReason = RemuxHostResumeReason;

type CodexResumeSyncParams = {
  activeThreadId: string | null;
  ensureThreadSummary: (threadId: string) => Promise<void>;
  loadComposerConfig: () => Promise<void>;
  loadThreadHistory: (options?: { preserveReady?: boolean }) => Promise<void>;
  reason: CodexResumeSyncReason;
};

type UseCodexResumeSyncParams = Omit<CodexResumeSyncParams, 'reason'>;

export async function syncCodexViewerAfterResume(params: CodexResumeSyncParams) {
  const startMs = Date.now();
  logResumeSync('start', {
    activeThreadId: params.activeThreadId,
    reason: params.reason,
  });

  const threadTasks: Array<[string, Promise<void>]> = [];

  if (params.activeThreadId) {
    threadTasks.push(
      ['transcript', refreshActiveTranscriptResources({
        forceFullMeasure: false,
        preserveReady: true,
      })],
      ['threadRuntime', refreshActiveThreadRuntime({ preserveReady: true })],
      ['threadHistory', params.loadThreadHistory({ preserveReady: true })],
      ['threadSummary', params.ensureThreadSummary(params.activeThreadId)],
      ['threadOperationQueue', refreshActiveOperationQueue()],
      ['threadComposerState', refreshActiveThreadComposerState({ preserveReady: true })],
    );
  } else {
    threadTasks.push(
      ['threadHistory', params.loadThreadHistory({ preserveReady: true })],
      ['composerConfig', params.loadComposerConfig()],
    );
  }

  const threadResults = await Promise.allSettled(threadTasks.map(([, task]) => task));
  const failures = collectFailures(threadTasks, threadResults);

  logResumeSync('done', {
    activeThreadId: params.activeThreadId,
    durationMs: Date.now() - startMs,
    failures,
    reason: params.reason,
  }, failures.length > 0);
}

export function useCodexResumeSync(params: UseCodexResumeSyncParams) {
  const latestParamsRef = useRef(params);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const pendingReasonRef = useRef<CodexResumeSyncReason | null>(null);
  const wasConnectedAtFirstRenderRef = useRef(
    getHostStatusSnapshot().status.type === 'connected',
  );

  latestParamsRef.current = params;

  const runResumeSync = useCallback((reason: CodexResumeSyncReason) => {
    if (!mountedRef.current) {
      return;
    }

    // Gate on the live snapshot, not React state: the 'connected' resume is
    // dispatched synchronously with the status update, before any re-render.
    // A sync skipped while disconnected needs no bookkeeping — viewer-kit
    // fires 'connected' when the socket comes back.
    if (getHostStatusSnapshot().status.type !== 'connected') {
      return;
    }
    if (getHostLifecycleSnapshot().state !== 'active') {
      return;
    }

    if (inFlightRef.current) {
      pendingReasonRef.current = reason;
      return;
    }

    inFlightRef.current = true;
    const latestParams = latestParamsRef.current;
    void syncCodexViewerAfterResume({
      activeThreadId: latestParams.activeThreadId,
      ensureThreadSummary: latestParams.ensureThreadSummary,
      loadComposerConfig: latestParams.loadComposerConfig,
      loadThreadHistory: latestParams.loadThreadHistory,
      reason,
    }).finally(() => {
      inFlightRef.current = false;
      if (!mountedRef.current) {
        return;
      }

      const pendingReason = pendingReasonRef.current;
      pendingReasonRef.current = null;
      if (pendingReason) {
        runResumeSync(pendingReason);
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // The visible/pageshow/connected triggers and their coalescing live in
    // viewer-kit (subscribeHostResume); this hook only owns what to refetch.
    const unsubscribeResume = subscribeHostResume(runResumeSync);
    let initialLifecycleSnapshot = true;
    const unsubscribeLifecycle = subscribeHostLifecycle((lifecycle) => {
      setTranscriptLifecycleState(lifecycle.state);
      if (initialLifecycleSnapshot && lifecycle.state === 'active') {
        runResumeSync(lifecycle.reason === 'tabActive' ? 'tab-active' : 'app-active');
      }
      initialLifecycleSnapshot = false;
    });

    // A connect landing between the first render and this effect is
    // dispatched to nobody; catch it from the snapshot.
    if (
      !wasConnectedAtFirstRenderRef.current &&
      getHostStatusSnapshot().status.type === 'connected'
    ) {
      runResumeSync('connected');
    }

    return () => {
      unsubscribeLifecycle();
      unsubscribeResume();
    };
  }, [runResumeSync]);
}

function collectFailures(
  tasks: Array<[string, Promise<void>]>,
  results: PromiseSettledResult<void>[],
) {
  const failures: Array<{ message: string; task: string }> = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      failures.push({
        message: errorMessage(result.reason),
        task: tasks[index]?.[0] ?? `task:${index}`,
      });
    }
  }
  return failures;
}

function logResumeSync(label: string, payload: unknown, warn = false) {
  const method = warn ? console.warn : console.info;
  method.call(console, `[codex resume] ${label} ${JSON.stringify(payload)}`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
