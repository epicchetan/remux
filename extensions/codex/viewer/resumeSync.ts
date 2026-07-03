import { useCallback, useEffect, useRef } from 'react';

import {
  getHostStatusSnapshot,
  subscribeHostResume,
  type RemuxHostResumeReason,
} from '@remux/viewer-kit/host';

import { refreshActiveThreadComposerState } from './threads/composerStateStore';
import { refreshActiveThreadRuntime } from './threads/runtimeStore';
import { refreshActiveTranscriptResources } from './transcript/store';

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
    const unsubscribe = subscribeHostResume(runResumeSync);

    // A connect landing between the first render and this effect is
    // dispatched to nobody; catch it from the snapshot.
    if (
      !wasConnectedAtFirstRenderRef.current &&
      getHostStatusSnapshot().status.type === 'connected'
    ) {
      runResumeSync('connected');
    }

    return unsubscribe;
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
