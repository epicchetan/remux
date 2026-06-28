import { useCallback, useEffect, useRef } from 'react';

import type { CodexViewHostStatus } from './ipc/types';
import { refreshActiveThreadComposerState } from './threads/composerStateStore';
import { refreshActiveThreadRuntime } from './threads/runtimeStore';
import { refreshActiveTranscriptResources } from './transcript/store';

export type CodexResumeSyncReason = 'connected' | 'pageshow' | 'visible';

type CodexResumeSyncParams = {
  activeThreadId: string | null;
  ensureThreadSummary: (threadId: string) => Promise<void>;
  loadComposerConfig: () => Promise<void>;
  loadThreadHistory: (options?: { preserveReady?: boolean }) => Promise<void>;
  reason: CodexResumeSyncReason;
};

type UseCodexResumeSyncParams = Omit<CodexResumeSyncParams, 'reason'> & {
  connectionStatus: CodexViewHostStatus;
};

const resumeSyncThrottleMs = 2500;

export async function syncCodexViewerAfterResume(params: CodexResumeSyncParams) {
  const startMs = Date.now();
  logResumeSync('start', {
    activeThreadId: params.activeThreadId,
    reason: params.reason,
  });

  const threadTasks: Array<[string, Promise<void>]> = [
    ['threadHistory', params.loadThreadHistory({ preserveReady: true })],
  ];

  if (params.activeThreadId) {
    threadTasks.push(
      ['threadSummary', params.ensureThreadSummary(params.activeThreadId)],
      ['threadRuntime', refreshActiveThreadRuntime({ preserveReady: true })],
      ['threadComposerState', refreshActiveThreadComposerState({ preserveReady: true })],
    );
  } else {
    threadTasks.push(['composerConfig', params.loadComposerConfig()]);
  }

  const threadResults = await Promise.allSettled(threadTasks.map(([, task]) => task));
  const failures = collectFailures(threadTasks, threadResults);

  if (params.activeThreadId) {
    const transcriptResult = await settlePromise(
      refreshActiveTranscriptResources({
        forceFullMeasure: false,
        preserveReady: true,
      }),
    );
    if (transcriptResult.status === 'rejected') {
      failures.push({
        message: errorMessage(transcriptResult.reason),
        task: 'transcript',
      });
    }
  }

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
  const lastSyncStartedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const pendingReasonRef = useRef<CodexResumeSyncReason | null>(null);
  const previousConnectionTypeRef = useRef(params.connectionStatus.type);
  const throttleTimerRef = useRef<number | null>(null);

  latestParamsRef.current = params;

  const clearThrottleTimer = useCallback(() => {
    if (throttleTimerRef.current !== null) {
      window.clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
  }, []);

  const runResumeSync = useCallback((reason: CodexResumeSyncReason) => {
    if (!mountedRef.current) {
      return;
    }

    const latestParams = latestParamsRef.current;
    if (latestParams.connectionStatus.type !== 'connected') {
      pendingReasonRef.current = reason;
      return;
    }

    if (inFlightRef.current) {
      pendingReasonRef.current = reason;
      return;
    }

    const elapsedMs = Date.now() - lastSyncStartedAtRef.current;
    if (elapsedMs < resumeSyncThrottleMs) {
      pendingReasonRef.current = reason;
      if (throttleTimerRef.current === null) {
        throttleTimerRef.current = window.setTimeout(() => {
          throttleTimerRef.current = null;
          const pendingReason = pendingReasonRef.current ?? reason;
          pendingReasonRef.current = null;
          runResumeSync(pendingReason);
        }, resumeSyncThrottleMs - elapsedMs);
      }
      return;
    }

    clearThrottleTimer();
    inFlightRef.current = true;
    lastSyncStartedAtRef.current = Date.now();

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
  }, [clearThrottleTimer]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      clearThrottleTimer();
    };
  }, [clearThrottleTimer]);

  useEffect(() => {
    const previousConnectionType = previousConnectionTypeRef.current;
    previousConnectionTypeRef.current = params.connectionStatus.type;

    if (params.connectionStatus.type !== 'connected') {
      return;
    }

    const pendingReason = pendingReasonRef.current;
    pendingReasonRef.current = null;
    if (pendingReason) {
      runResumeSync(pendingReason);
      return;
    }

    if (previousConnectionType !== 'connected') {
      runResumeSync('connected');
    }
  }, [params.connectionStatus.type, runResumeSync]);

  useEffect(() => {
    const handlePageShow = () => {
      runResumeSync('pageshow');
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runResumeSync('visible');
      }
    };

    window.addEventListener('pageshow', handlePageShow);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
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

async function settlePromise<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return {
      status: 'fulfilled',
      value: await promise,
    };
  } catch (reason) {
    return {
      reason,
      status: 'rejected',
    };
  }
}

function logResumeSync(label: string, payload: unknown, warn = false) {
  const method = warn ? console.warn : console.info;
  method.call(console, `[codex resume] ${label} ${JSON.stringify(payload)}`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
