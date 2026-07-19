import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  isNarrationPlaybackRate,
  type NarrationAudioDriver,
} from './audio';
import { resolveNarrationPosition } from './cues';
import { NarrationProtocolError } from './decode';
import {
  browserNarrationPreferences,
  browserNarrationScheduler,
  type NarrationLifecycle,
  type NarrationPreferences,
  type NarrationScheduler,
} from './lifecycle';
import type {
  NarrationArtifact,
  NarrationPlaybackRate,
  NarrationProgress,
  NarrationResource,
  NarrationSentence,
  NarrationSourceDocument,
  NarrationStartResponse,
  NarrationWordCue,
} from './protocol';
import type { NarrationTransport } from './transport';

export type NarrationPhase =
  | 'idle'
  | 'preparing'
  | 'buffering'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'failed';

export type NarrationFocusReason =
  | 'explicitSeek'
  | 'explicitSeekInPlace'
  | 'follow'
  | 'followReenabled';

export type NarrationFocusIntent = {
  id: number;
  reason: NarrationFocusReason;
};

export type NarrationFollowPort<TTarget> = {
  claim(target: TTarget): void;
  release(): void;
};

export type NarrationRequest<TTarget> = {
  document: NarrationSourceDocument;
  target: TTarget;
};

export type NarrationClientState<TTarget> = {
  artifact: NarrationArtifact | null;
  artifactKey: string | null;
  currentBlockId: string | null;
  currentBlockIndex: number;
  currentSample: number;
  currentSentence: NarrationSentence | null;
  currentSentenceIndex: number;
  currentWordCue: NarrationWordCue | null;
  currentWordCueIndex: number;
  error: string | null;
  followEnabled: boolean;
  followSuspendedByUser: boolean;
  focusIntent: NarrationFocusIntent | null;
  phase: NarrationPhase;
  playbackRate: NarrationPlaybackRate;
  progress: NarrationProgress | null;
  resourceRevision: string | null;
  status: NarrationResource['status'] | null;
  target: TTarget | null;

  cancel(): Promise<void>;
  close(): void;
  nextBlock(): Promise<void>;
  pause(): void;
  play(): Promise<void>;
  previousBlock(): Promise<void>;
  refresh(): Promise<void>;
  retry(): Promise<void>;
  seekToBlock(blockId: string): Promise<void>;
  setPlaybackRate(rate: number): void;
  start(request: NarrationRequest<TTarget>): Promise<void>;
  suspendFollowByUser(): void;
  toggleFollow(): void;
};

export type NarrationClient<TTarget> = {
  attach(): () => void;
  debugSnapshot(): NarrationClientDebugSnapshot;
  destroy(): void;
  store: StoreApi<NarrationClientState<TTarget>>;
};

export type NarrationClientDebugSnapshot = {
  audio: unknown;
  lifecycle: { state: string };
  refresh: NarrationRefreshDiagnostic | null;
  store: {
    artifactKey: string | null;
    currentBlockId: string | null;
    currentSample: number;
    error: string | null;
    phase: NarrationPhase;
    progress: NarrationProgress | null;
    resourceRevision: string | null;
    status: NarrationResource['status'] | null;
  };
};

type NarrationRefreshDiagnostic = {
  artifactKey: string;
  completedAt: number | null;
  error: string | null;
  sequence: number;
  startedAt: number;
  status: 'error' | 'missing' | 'notModified' | 'ok' | 'pending';
};

export function createNarrationClient<TTarget>(options: {
  audio: NarrationAudioDriver;
  follow?: NarrationFollowPort<TTarget>;
  lifecycle: NarrationLifecycle;
  preferences?: NarrationPreferences;
  scheduler?: NarrationScheduler;
  transport: NarrationTransport;
}): NarrationClient<TTarget> {
  const audio = options.audio;
  const follow = options.follow;
  const lifecycle = options.lifecycle;
  const preferences = options.preferences ?? browserNarrationPreferences;
  const scheduler = options.scheduler ?? browserNarrationScheduler;
  const transport = options.transport;
  const storedRate = preferences.readPlaybackRate();
  const defaultRate: NarrationPlaybackRate = storedRate !== null && isNarrationPlaybackRate(storedRate)
    ? storedRate
    : 1;

  let attachCount = 0;
  let destroyed = false;
  let epoch = 0;
  let refreshSequence = 0;
  let focusIntentId = 0;
  let pausedForLifecycle = false;
  let refreshTimer: unknown | null = null;
  let lastRequest: NarrationRequest<TTarget> | null = null;
  let pendingFocus: {
    artifactKey: string;
    epoch: number;
    reason: 'explicitSeek' | 'explicitSeekInPlace' | 'followReenabled';
  } | null = null;
  let missingRecovery: Promise<void> | null = null;
  let missingRecoveryEpoch: number | null = null;
  let pendingCancellation: Promise<void> | null = null;
  let pendingStart: Promise<NarrationStartResponse> | null = null;
  let subscriptions: Array<() => void> = [];
  let lastRefreshDiagnostic: NarrationRefreshDiagnostic | null = null;

  const store = createStore<NarrationClientState<TTarget>>((set, get) => ({
    ...idleState(defaultRate),
    async cancel() {
      if (destroyed) return;
      epoch += 1;
      clearRefreshTimer();
      const artifactKey = get().artifactKey;
      const start = pendingStart;
      audio.close();
      releaseFollow();
      set(idleState(get().playbackRate));
      if (artifactKey || start) {
        try { await cancelPendingNarration(start, artifactKey); } catch { /* Best effort. */ }
      }
    },
    close() {
      if (destroyed) return;
      epoch += 1;
      clearRefreshTimer();
      const { artifactKey, status } = get();
      const start = pendingStart;
      const activeArtifactKey = artifactKey && isActiveStatus(status) ? artifactKey : null;
      if (activeArtifactKey || start) {
        void cancelPendingNarration(start, activeArtifactKey).catch(() => undefined);
      }
      audio.close();
      releaseFollow();
      set(idleState(get().playbackRate));
    },
    async nextBlock() { await seekBlock(1); },
    pause() {
      if (destroyed) return;
      audio.pause();
      set({ phase: 'paused' });
    },
    async play() {
      if (destroyed) return;
      const { artifact, artifactKey, followEnabled, target } = get();
      if (!artifactKey || !artifact) return;
      const playEpoch = epoch;
      pausedForLifecycle = false;
      if (followEnabled && target) follow?.claim(target);
      try {
        await audio.play(artifactKey, artifact);
      } catch (error) {
        if (destroyed || playEpoch !== epoch || get().artifactKey !== artifactKey) return;
        set({
          error: pausedForLifecycle ? null : errorMessage(error),
          phase: pausedForLifecycle ? 'paused' : 'ready',
        });
      }
    },
    async previousBlock() { await seekBlock(-1); },
    async refresh() {
      if (destroyed) return;
      const { artifactKey, resourceRevision } = get();
      if (!artifactKey) return;
      const refreshEpoch = epoch;
      const sequence = ++refreshSequence;
      lastRefreshDiagnostic = {
        artifactKey,
        completedAt: null,
        error: null,
        sequence,
        startedAt: scheduler.now(),
        status: 'pending',
      };
      try {
        const response = await transport.read({ artifactKey, knownRevision: resourceRevision });
        if (
          destroyed
          || refreshEpoch !== epoch
          || get().artifactKey !== artifactKey
          || sequence !== refreshSequence
        ) return;
        lastRefreshDiagnostic = {
          ...lastRefreshDiagnostic,
          completedAt: scheduler.now(),
          status: response.status,
        };
        if (response.status === 'ok' && response.resource) {
          applyResource(response.resource);
        } else if (response.status === 'missing') {
          await recoverMissingNarration(artifactKey, refreshEpoch);
        } else if (isActiveStatus(get().status)) {
          scheduleRefresh();
        }
      } catch (error) {
        if (destroyed || refreshEpoch !== epoch || get().artifactKey !== artifactKey) return;
        lastRefreshDiagnostic = {
          ...lastRefreshDiagnostic,
          completedAt: scheduler.now(),
          error: errorMessage(error),
          status: 'error',
        };
        if (error instanceof NarrationProtocolError) {
          clearRefreshTimer();
          set({ error: error.message, phase: 'failed', status: 'failed' });
          return;
        }
        set({ error: errorMessage(error) });
        if (isActiveStatus(get().status)) scheduleRefresh();
      }
    },
    async retry() {
      if (!destroyed && lastRequest) await get().start(lastRequest);
    },
    async seekToBlock(blockId) { await seekToBlockId(blockId); },
    setPlaybackRate(rate) {
      if (destroyed || !isNarrationPlaybackRate(rate)) return;
      preferences.writePlaybackRate(rate);
      audio.setPlaybackRate(rate);
      set({ playbackRate: rate });
    },
    async start(request) {
      if (destroyed) return;
      const startEpoch = ++epoch;
      missingRecoveryEpoch = null;
      clearRefreshTimer();
      const previous = get();
      const previousStart = pendingStart;
      audio.close();
      releaseFollow();
      pausedForLifecycle = lifecycle.snapshot().state !== 'active';
      lastRequest = request;
      set({
        ...idleState(previous.playbackRate),
        phase: 'preparing',
        status: 'preparing',
        target: request.target,
      });
      try {
        if (pendingCancellation) await pendingCancellation;
        const uncancelledStart = previousStart === pendingStart ? previousStart : null;
        const activeArtifactKey = previous.artifactKey && isActiveStatus(previous.status)
          ? previous.artifactKey
          : null;
        if (uncancelledStart || activeArtifactKey) {
          await cancelPendingNarration(uncancelledStart, activeArtifactKey);
        }
        if (destroyed || startEpoch !== epoch) return;
        const start = transport.start({ document: request.document });
        pendingStart = start;
        let response: NarrationStartResponse;
        try {
          response = await start;
        } finally {
          if (pendingStart === start) pendingStart = null;
        }
        if (destroyed || startEpoch !== epoch) return;
        set({ artifactKey: response.artifactKey });
        applyResource(response.resource);
      } catch (error) {
        if (destroyed || startEpoch !== epoch) return;
        set({ error: errorMessage(error), phase: 'failed', status: 'failed' });
      }
    },
    suspendFollowByUser() {
      if (destroyed) return;
      const state = get();
      if (!['buffering', 'paused', 'playing', 'ready'].includes(state.phase)) return;
      if (!state.followEnabled) return;
      releaseFollow();
      set({ followEnabled: false, followSuspendedByUser: true });
    },
    toggleFollow() {
      if (destroyed) return;
      const state = get();
      const enabled = !state.followEnabled;
      if (enabled && state.target) follow?.claim(state.target);
      else if (!enabled) releaseFollow();
      set({
        focusIntent: enabled ? nextFocusIntent('followReenabled') : null,
        followEnabled: enabled,
        followSuspendedByUser: false,
      });
    },
  }));

  audio.setCallbacks({
    onBuffering: () => {
      if (!destroyed) store.setState({ phase: 'buffering' });
    },
    onEnded: () => {
      if (destroyed) return;
      const state = store.getState();
      store.setState({
        currentBlockId: null,
        currentBlockIndex: -1,
        currentSentence: null,
        currentSentenceIndex: -1,
        currentWordCue: null,
        currentWordCueIndex: -1,
        phase: state.error ? 'failed' : 'paused',
      });
    },
    onError: (error) => {
      if (!destroyed) store.setState({ error, phase: 'ready' });
    },
    onPaused: () => {
      if (destroyed) return;
      const state = store.getState();
      if (state.artifact && (state.phase === 'buffering' || state.phase === 'playing')) {
        store.setState({ phase: 'paused' });
      }
    },
    onPlaying: () => {
      if (!destroyed) store.setState({ error: null, phase: 'playing' });
    },
    onSample: (sample) => {
      if (!destroyed) applyAudioSample(sample);
    },
  });
  audio.setPlaybackRate(defaultRate);

  function attach() {
    if (destroyed) return () => undefined;
    attachCount += 1;
    if (attachCount === 1) {
      subscriptions = [
        transport.subscribeUpdated((event) => {
          if (event.artifactKey === store.getState().artifactKey) {
            void store.getState().refresh();
          }
        }),
        lifecycle.subscribe((state) => {
          if (destroyed || state === 'active') return;
          pausedForLifecycle = true;
          const current = store.getState();
          if (!current.artifact) return;
          audio.pause();
          if (current.phase === 'buffering' || current.phase === 'playing') {
            store.setState({ phase: 'paused' });
          }
        }),
        lifecycle.subscribeResume(() => {
          if (destroyed) return;
          const current = store.getState();
          if (current.artifactKey) void current.refresh();
        }),
      ];
    }
    let detached = false;
    return () => {
      if (detached || destroyed) return;
      detached = true;
      attachCount = Math.max(0, attachCount - 1);
      if (attachCount === 0) removeSubscriptions();
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    epoch += 1;
    attachCount = 0;
    clearRefreshTimer();
    removeSubscriptions();
    audio.close();
    releaseFollow();
  }

  function debugSnapshot(): NarrationClientDebugSnapshot {
    const state = store.getState();
    return {
      audio: audio.snapshot(),
      lifecycle: lifecycle.snapshot(),
      refresh: lastRefreshDiagnostic,
      store: {
        artifactKey: state.artifactKey,
        currentBlockId: state.currentBlockId,
        currentSample: state.currentSample,
        error: state.error,
        phase: state.phase,
        progress: state.progress,
        resourceRevision: state.resourceRevision,
        status: state.status,
      },
    };
  }

  function removeSubscriptions() {
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  }

  function applyResource(resource: NarrationResource) {
    const current = store.getState();
    if (current.artifactKey && resource.artifactKey !== current.artifactKey) return;
    if (isOlderRevision(resource.revision, current.resourceRevision)) return;
    if (resource.status === 'cancelled') {
      clearRefreshTimer();
      audio.close();
      releaseFollow();
      store.setState(idleState(current.playbackRate));
      return;
    }

    const terminalFailure = resource.status === 'failed';
    const error = terminalFailure
      ? resource.error ?? 'Narration stopped before it was complete'
      : null;
    if (resource.manifest) {
      const artifact = resource.manifest;
      if (current.artifact) {
        store.setState({
          artifact,
          error,
          progress: resource.progress,
          resourceRevision: resource.revision,
          status: resource.status,
        });
        clearRefreshTimer();
        return;
      }
      const firstSample = artifact.blocks[0]?.startSample ?? 0;
      const position = resolveNarrationPosition(artifact, firstSample);
      const latest = store.getState();
      const shouldPlay = latest.phase === 'preparing'
        && !pausedForLifecycle
        && lifecycle.snapshot().state === 'active';
      store.setState({
        artifact,
        currentBlockId: position.block?.blockId ?? position.sentence?.blockId ?? null,
        currentBlockIndex: position.blockIndex,
        currentSample: firstSample,
        currentSentence: position.sentence,
        currentSentenceIndex: position.sentenceIndex,
        currentWordCue: position.wordCue,
        currentWordCueIndex: position.wordCueIndex,
        error,
        focusIntent: latest.focusIntent ?? nextFocusIntent('follow'),
        phase: shouldPlay ? 'buffering' : latest.phase === 'preparing' ? 'ready' : latest.phase,
        progress: resource.progress,
        resourceRevision: resource.revision,
        status: resource.status,
      });
      if (shouldPlay) {
        const afterInstall = store.getState();
        if (afterInstall.followEnabled && afterInstall.target) follow?.claim(afterInstall.target);
        const playEpoch = epoch;
        void audio.play(resource.artifactKey, artifact).catch((cause) => {
          if (
            destroyed
            || playEpoch !== epoch
            || store.getState().artifactKey !== resource.artifactKey
          ) return;
          store.setState({
            error: pausedForLifecycle ? null : errorMessage(cause),
            phase: pausedForLifecycle ? 'paused' : 'ready',
          });
        });
      }
    } else {
      store.setState({
        error,
        phase: terminalFailure ? 'failed' : 'preparing',
        progress: resource.progress,
        resourceRevision: resource.revision,
        status: resource.status,
      });
    }

    if (resource.status === 'ready' || terminalFailure) clearRefreshTimer();
    else scheduleRefresh();
  }

  function applyAudioSample(sample: number) {
    const state = store.getState();
    if (!state.artifact) return;
    const position = resolveNarrationPosition(state.artifact, sample);
    if (
      position.blockIndex === state.currentBlockIndex
      && position.sentenceIndex === state.currentSentenceIndex
      && position.wordCueIndex === state.currentWordCueIndex
    ) {
      if (sample !== state.currentSample) store.setState({ currentSample: sample });
      return;
    }
    const reason = pendingFocus
      && pendingFocus.epoch === epoch
      && pendingFocus.artifactKey === state.artifactKey
      ? pendingFocus.reason
      : state.followEnabled ? 'follow' : null;
    pendingFocus = null;
    store.setState({
      currentBlockId: position.block?.blockId ?? position.sentence?.blockId ?? null,
      currentBlockIndex: position.blockIndex,
      currentSample: sample,
      currentSentence: position.sentence,
      currentSentenceIndex: position.sentenceIndex,
      currentWordCue: position.wordCue,
      currentWordCueIndex: position.wordCueIndex,
      focusIntent: reason ? nextFocusIntent(reason) : null,
    });
  }

  async function seekToBlockId(blockId: string) {
    const { artifact, artifactKey, currentBlockIndex, phase } = store.getState();
    if (!artifactKey || !artifact) return;
    const destination = artifact.blocks.findIndex((block) => block.blockId === blockId);
    if (destination === -1) return;
    await seekToSample({
      artifact,
      artifactKey,
      currentBlockIndex,
      destination,
      keepPlaying: phase === 'playing' || phase === 'buffering',
      reason: 'explicitSeekInPlace',
    });
  }

  async function seekBlock(direction: -1 | 1) {
    const { artifact, artifactKey, currentBlockIndex, phase } = store.getState();
    if (!artifactKey || !artifact || artifact.blocks.length === 0) return;
    const current = currentBlockIndex >= 0 ? currentBlockIndex : 0;
    const destination = Math.max(0, Math.min(artifact.blocks.length - 1, current + direction));
    await seekToSample({
      artifact,
      artifactKey,
      currentBlockIndex: current,
      destination,
      keepPlaying: phase === 'playing' || phase === 'buffering',
      reason: 'explicitSeek',
    });
  }

  async function seekToSample({
    artifact,
    artifactKey,
    currentBlockIndex,
    destination,
    keepPlaying,
    reason,
  }: {
    artifact: NarrationArtifact;
    artifactKey: string;
    currentBlockIndex: number;
    destination: number;
    keepPlaying: boolean;
    reason: 'explicitSeek' | 'explicitSeekInPlace';
  }) {
    const seekEpoch = epoch;
    const focus = { artifactKey, epoch: seekEpoch, reason } as const;
    try {
      const prepared = await audio.prepare(artifactKey, artifact);
      if (!prepared || destroyed || seekEpoch !== epoch || store.getState().artifactKey !== artifactKey) return;
      pendingFocus = focus;
      const sought = await audio.seek(
        artifactKey,
        artifact.blocks[destination].startSample,
        keepPlaying,
      );
      if (!sought || destroyed || seekEpoch !== epoch || store.getState().artifactKey !== artifactKey) return;
      if (destination === currentBlockIndex) {
        if (pendingFocus === focus) pendingFocus = null;
        store.setState({ focusIntent: nextFocusIntent(reason) });
      }
    } catch (error) {
      if (destroyed || seekEpoch !== epoch || store.getState().artifactKey !== artifactKey) return;
      if (pendingFocus === focus) pendingFocus = null;
      store.setState({
        error: pausedForLifecycle ? null : errorMessage(error),
        phase: pausedForLifecycle ? 'paused' : 'ready',
      });
    }
  }

  function nextFocusIntent(reason: NarrationFocusReason) {
    focusIntentId += 1;
    return { id: focusIntentId, reason } as const;
  }

  function releaseFollow() {
    follow?.release();
  }

  async function recoverMissingNarration(artifactKey: string, recoveryEpoch: number) {
    if (missingRecovery) return missingRecovery;
    if (missingRecoveryEpoch === recoveryEpoch) {
      store.setState({
        error: 'Narration state was lost after the service restarted. Start narration again.',
        phase: 'failed',
        status: 'failed',
      });
      return;
    }
    const request = lastRequest;
    if (!request) {
      store.setState({
        error: 'Narration state was lost after the service restarted. Start narration again.',
        phase: 'failed',
        status: 'failed',
      });
      return;
    }
    missingRecoveryEpoch = recoveryEpoch;
    missingRecovery = (async () => {
      const start = transport.start({ document: request.document });
      pendingStart = start;
      let response: NarrationStartResponse;
      try {
        response = await start;
      } finally {
        if (pendingStart === start) pendingStart = null;
      }
      if (destroyed || recoveryEpoch !== epoch || store.getState().artifactKey !== artifactKey) return;
      const resetArtifact = response.artifactKey !== artifactKey || !response.resource.manifest;
      if (resetArtifact) audio.close();
      store.setState({
        ...(resetArtifact ? {
          artifact: null,
          currentBlockId: null,
          currentBlockIndex: -1,
          currentSample: 0,
          currentSentence: null,
          currentSentenceIndex: -1,
          currentWordCue: null,
          currentWordCueIndex: -1,
        } : {}),
        artifactKey: response.artifactKey,
        resourceRevision: null,
      });
      applyResource(response.resource);
    })().finally(() => {
      missingRecovery = null;
    });
    try {
      await missingRecovery;
    } catch (error) {
      if (destroyed || recoveryEpoch !== epoch || store.getState().artifactKey !== artifactKey) return;
      if (error instanceof NarrationProtocolError) {
        clearRefreshTimer();
        store.setState({ error: error.message, phase: 'failed', status: 'failed' });
        return;
      }
      store.setState({ error: errorMessage(error) });
      scheduleRefresh();
    }
  }

  async function waitForNarrationToStop(artifactKey: string) {
    const deadline = scheduler.now() + 10_000;
    while (scheduler.now() < deadline) {
      const response = await transport.read({ artifactKey });
      if (
        response.status === 'missing'
        || (response.status === 'ok' && response.resource && !isActiveStatus(response.resource.status))
      ) return;
      await schedulerDelay(scheduler, 100);
    }
    throw new Error('The previous narration is still stopping. Please retry.');
  }

  function cancelPendingNarration(
    start: Promise<NarrationStartResponse> | null,
    artifactKey: string | null,
  ) {
    const previous = pendingCancellation;
    const cancellation = (async () => {
      if (previous) {
        try { await previous; } catch { /* Continue with the latest cancellation. */ }
      }
      const artifactKeys = new Set<string>();
      if (start) {
        try { artifactKeys.add((await start).artifactKey); } catch { /* No server job was accepted. */ }
      }
      if (artifactKey) artifactKeys.add(artifactKey);
      for (const key of artifactKeys) {
        await transport.cancel({ artifactKey: key });
        await waitForNarrationToStop(key);
      }
    })();
    pendingCancellation = cancellation;
    void cancellation.finally(() => {
      if (pendingCancellation === cancellation) pendingCancellation = null;
    }).catch(() => undefined);
    return cancellation;
  }

  function scheduleRefresh() {
    if (refreshTimer !== null || destroyed) return;
    refreshTimer = scheduler.setTimeout(() => {
      refreshTimer = null;
      if (!destroyed) void store.getState().refresh();
    }, 1000);
  }

  function clearRefreshTimer() {
    if (refreshTimer !== null) scheduler.clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  return { attach, debugSnapshot, destroy, store };
}

function idleState<TTarget>(playbackRate: NarrationPlaybackRate): Pick<
  NarrationClientState<TTarget>,
  | 'artifact'
  | 'artifactKey'
  | 'currentBlockId'
  | 'currentBlockIndex'
  | 'currentSample'
  | 'currentSentence'
  | 'currentSentenceIndex'
  | 'currentWordCue'
  | 'currentWordCueIndex'
  | 'error'
  | 'followEnabled'
  | 'focusIntent'
  | 'followSuspendedByUser'
  | 'phase'
  | 'playbackRate'
  | 'progress'
  | 'resourceRevision'
  | 'status'
  | 'target'
> {
  return {
    artifact: null,
    artifactKey: null,
    currentBlockId: null,
    currentBlockIndex: -1,
    currentSample: 0,
    currentSentence: null,
    currentSentenceIndex: -1,
    currentWordCue: null,
    currentWordCueIndex: -1,
    error: null,
    followEnabled: true,
    focusIntent: null,
    followSuspendedByUser: false,
    phase: 'idle',
    playbackRate,
    progress: null,
    resourceRevision: null,
    status: null,
    target: null,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Narration request failed';
}

function isActiveStatus(status: NarrationResource['status'] | null) {
  return status === 'preparing' || status === 'synthesizing' || status === 'finalizing';
}

function isOlderRevision(candidate: string, current: string | null) {
  if (current === null) return false;
  if (candidate === current) return true;
  if (/^\d+$/.test(candidate) && /^\d+$/.test(current)) {
    return BigInt(candidate) < BigInt(current);
  }
  return false;
}

function schedulerDelay(scheduler: NarrationScheduler, delayMs: number) {
  return new Promise<void>((resolve) => {
    scheduler.setTimeout(resolve, delayMs);
  });
}
