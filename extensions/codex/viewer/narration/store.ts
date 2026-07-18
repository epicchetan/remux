import { create } from 'zustand';
import { subscribeIpcEvents } from '@remux/viewer-kit/ipc';
import {
  getHostLifecycleSnapshot,
  subscribeHostLifecycle,
  subscribeHostResume,
} from '@remux/viewer-kit/host';

import type {
  CodexNarrationArtifact,
  CodexNarrationProgress,
  CodexNarrationResource,
  CodexNarrationSentence,
  CodexNarrationSourceDocument,
  CodexNarrationStartResponse,
  CodexNarrationTarget,
  CodexNarrationWordCue,
} from '../../shared/narration';
import { cancelNarration, readNarration, startNarration } from '../ipc/narration';
import {
  getTranscriptViewportState,
  subscribeTranscriptViewport,
} from '../transcript/viewportStore';
import { NarrationAudioEngine } from './audioEngine';
import { resolveNarrationPosition } from './cueResolver';

export type NarrationPhase =
  | 'buffering'
  | 'failed'
  | 'idle'
  | 'paused'
  | 'playing'
  | 'preparing'
  | 'ready';

export type NarrationFocusReason =
  | 'explicitSeek'
  | 'explicitSeekInPlace'
  | 'follow'
  | 'followReenabled';

type NarrationRequest = {
  document: CodexNarrationSourceDocument;
  target: CodexNarrationTarget;
};

type NarrationStoreState = {
  artifact: CodexNarrationArtifact | null;
  artifactKey: string | null;
  cancel: () => Promise<void>;
  close: () => void;
  currentBlockId: string | null;
  currentBlockIndex: number;
  currentSample: number;
  currentSentence: CodexNarrationSentence | null;
  currentSentenceIndex: number;
  currentWordCue: CodexNarrationWordCue | null;
  currentWordCueIndex: number;
  error: string | null;
  followEnabled: boolean;
  focusIntent: { id: number; reason: NarrationFocusReason } | null;
  followSuspendedByUser: boolean;
  nextBlock: () => Promise<void>;
  pause: () => void;
  phase: NarrationPhase;
  play: () => Promise<void>;
  playbackRate: number;
  previousBlock: () => Promise<void>;
  progress: CodexNarrationProgress | null;
  refresh: () => Promise<void>;
  resourceRevision: string | null;
  retry: () => Promise<void>;
  seekToBlock: (blockId: string) => Promise<void>;
  setPlaybackRate: (rate: number) => void;
  start: (request: NarrationRequest) => Promise<void>;
  status: CodexNarrationResource['status'] | null;
  target: CodexNarrationTarget | null;
  toggleFollow: () => void;
};

const storedRate = Number.parseFloat(localStorage.getItem('narrationPlaybackRate') ?? '1');
const defaultRate = [0.75, 1, 1.25, 1.5, 2].includes(storedRate) ? storedRate : 1;
let lastRequest: NarrationRequest | null = null;
let refreshTimer: number | null = null;
let pendingFocus: {
  artifactKey: string;
  epoch: number;
  reason: 'explicitSeek' | 'explicitSeekInPlace' | 'followReenabled';
} | null = null;
let focusIntentId = 0;
let storeEpoch = 0;
let refreshSequence = 0;
let pausedForLifecycle = false;
let missingRecovery: Promise<void> | null = null;
let pendingCancellation: Promise<void> | null = null;
let pendingStart: Promise<CodexNarrationStartResponse> | null = null;
let lastRefreshDiagnostic: {
  artifactKey: string;
  completedAt: number | null;
  error: string | null;
  sequence: number;
  startedAt: number;
  status: 'error' | 'missing' | 'notModified' | 'ok' | 'pending';
} | null = null;

const audioEngine = new NarrationAudioEngine({
  onBuffering: () => undefined,
  onEnded: () => undefined,
  onError: () => undefined,
  onPaused: () => undefined,
  onPlaying: () => undefined,
  onSample: () => undefined,
});

export const useNarrationStore = create<NarrationStoreState>((set, get) => ({
  ...idleState(),
  async cancel() {
    storeEpoch += 1;
    clearRefreshTimer();
    const artifactKey = get().artifactKey;
    const start = pendingStart;
    audioEngine.close();
    releaseNarrationScrollOwnership();
    set(idleState());
    if (artifactKey || start) {
      try { await cancelPendingNarration(start, artifactKey); } catch { /* Best effort. */ }
    }
  },
  close() {
    storeEpoch += 1;
    clearRefreshTimer();
    const { artifactKey, status } = get();
    const start = pendingStart;
    const activeArtifactKey = artifactKey && status && status !== 'ready' ? artifactKey : null;
    if (activeArtifactKey || start) {
      void cancelPendingNarration(start, activeArtifactKey).catch(() => undefined);
    }
    audioEngine.close();
    releaseNarrationScrollOwnership();
    set(idleState());
  },
  async nextBlock() { await seekBlock(1, get); },
  pause() {
    audioEngine.pause();
    set({ phase: 'paused' });
  },
  async play() {
    const { artifact, artifactKey, followEnabled } = get();
    if (!artifactKey || !artifact) return;
    const epoch = storeEpoch;
    pausedForLifecycle = false;
    if (followEnabled) claimNarrationScrollOwnership();
    try {
      await audioEngine.play(artifactKey, artifact);
    } catch (error) {
      if (epoch !== storeEpoch || get().artifactKey !== artifactKey) return;
      set({
        error: pausedForLifecycle ? null : errorMessage(error),
        phase: pausedForLifecycle ? 'paused' : 'ready',
      });
    }
  },
  async previousBlock() { await seekBlock(-1, get); },
  async refresh() {
    const { artifactKey, resourceRevision } = get();
    if (!artifactKey) return;
    const epoch = storeEpoch;
    const sequence = ++refreshSequence;
    lastRefreshDiagnostic = {
      artifactKey,
      completedAt: null,
      error: null,
      sequence,
      startedAt: Date.now(),
      status: 'pending',
    };
    try {
      const response = await readNarration({ artifactKey, knownRevision: resourceRevision });
      if (
        epoch !== storeEpoch
        || get().artifactKey !== artifactKey
        || sequence !== refreshSequence
      ) return;
      lastRefreshDiagnostic = {
        ...lastRefreshDiagnostic,
        completedAt: Date.now(),
        status: response.status,
      };
      if (response.status === 'ok' && response.resource) {
        applyResource(response.resource, set, get);
      } else if (response.status === 'missing') {
        await recoverMissingNarration(artifactKey, epoch, set, get);
      } else if (isActiveStatus(get().status)) {
        scheduleRefresh();
      }
    } catch (error) {
      if (epoch !== storeEpoch || get().artifactKey !== artifactKey) return;
      lastRefreshDiagnostic = {
        ...lastRefreshDiagnostic,
        completedAt: Date.now(),
        error: errorMessage(error),
        status: 'error',
      };
      // Connection and extension restarts are recoverable. Keep the last
      // truthful resource on screen and verify again instead of turning a
      // transient read failure into a terminal narration failure.
      set({ error: errorMessage(error) });
      scheduleRefresh();
    }
  },
  async retry() {
    if (lastRequest) await get().start(lastRequest);
  },
  async seekToBlock(blockId) { await seekToBlockId(blockId, get); },
  setPlaybackRate(rate) {
    if (![0.75, 1, 1.25, 1.5, 2].includes(rate)) return;
    localStorage.setItem('narrationPlaybackRate', String(rate));
    audioEngine.setPlaybackRate(rate);
    set({ playbackRate: rate });
  },
  async start(request) {
    const epoch = ++storeEpoch;
    clearRefreshTimer();
    const previous = get();
    const previousStart = pendingStart;
    audioEngine.close();
    releaseNarrationScrollOwnership();
    pausedForLifecycle = getHostLifecycleSnapshot().state !== 'active';
    lastRequest = request;
    set({
      ...idleState(),
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
      if (epoch !== storeEpoch) return;
      const start = startNarration({ document: request.document });
      pendingStart = start;
      let response: CodexNarrationStartResponse;
      try {
        response = await start;
      } finally {
        if (pendingStart === start) pendingStart = null;
      }
      if (epoch !== storeEpoch) return;
      set({ artifactKey: response.artifactKey });
      applyResource(response.resource, set, get);
    } catch (error) {
      if (epoch !== storeEpoch) return;
      set({ error: errorMessage(error), phase: 'failed', status: 'failed' });
    }
  },
  toggleFollow() {
    const enabled = !get().followEnabled;
    if (enabled) claimNarrationScrollOwnership();
    else releaseNarrationScrollOwnership();
    set({
      focusIntent: enabled ? nextFocusIntent('followReenabled') : null,
      followEnabled: enabled,
      followSuspendedByUser: false,
    });
  },
}));

audioEngine.setCallbacks({
  onBuffering: () => useNarrationStore.setState({ phase: 'buffering' }),
  onEnded: () => {
    const state = useNarrationStore.getState();
    useNarrationStore.setState({
      currentBlockId: null,
      currentBlockIndex: -1,
      currentSentence: null,
      currentSentenceIndex: -1,
      currentWordCue: null,
      currentWordCueIndex: -1,
      phase: state.error ? 'failed' : 'paused',
    });
  },
  onError: (error) => useNarrationStore.setState({ error, phase: 'ready' }),
  onPaused: () => {
    const state = useNarrationStore.getState();
    if (state.artifact && (state.phase === 'buffering' || state.phase === 'playing')) {
      useNarrationStore.setState({ phase: 'paused' });
    }
  },
  onPlaying: () => useNarrationStore.setState({ error: null, phase: 'playing' }),
  onSample: (sample) => applyAudioSample(sample),
});
audioEngine.setPlaybackRate(defaultRate);

subscribeTranscriptViewport(() => {
  const state = useNarrationStore.getState();
  if (!['buffering', 'paused', 'playing', 'ready'].includes(state.phase)) return;
  if (!state.followEnabled) return;
  if (getTranscriptViewportState().autoScrollMode.type === 'narration-follow') return;
  useNarrationStore.setState({ followEnabled: false, followSuspendedByUser: true });
});

export function subscribeNarrationUpdates() {
  const unsubscribeEvents = subscribeIpcEvents((events) => {
    const artifactKey = useNarrationStore.getState().artifactKey;
    if (!artifactKey) return;
    if (events.some((event) =>
      event.method === 'remux/narrate/narration/updated' &&
      event.params &&
      typeof event.params === 'object' &&
      (event.params as { artifactKey?: unknown }).artifactKey === artifactKey
    )) void useNarrationStore.getState().refresh();
  });
  const unsubscribeLifecycle = subscribeHostLifecycle((lifecycle) => {
    if (lifecycle.state === 'active') return;
    pausedForLifecycle = true;
    const state = useNarrationStore.getState();
    if (!state.artifact) return;
    audioEngine.pause();
    if (state.phase === 'buffering' || state.phase === 'playing') {
      useNarrationStore.setState({ phase: 'paused' });
    }
  });
  const unsubscribeResume = subscribeHostResume(() => {
    const state = useNarrationStore.getState();
    if (state.artifactKey) void state.refresh();
  });
  return () => {
    unsubscribeEvents();
    unsubscribeLifecycle();
    unsubscribeResume();
  };
}

export function getNarrationDebugSnapshot() {
  const state = useNarrationStore.getState();
  return {
    audio: audioEngine.snapshot(),
    lifecycle: getHostLifecycleSnapshot(),
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
    visibilityState: document.visibilityState,
  };
}

(globalThis as typeof globalThis & {
  __remuxNarrationDebugSnapshot?: typeof getNarrationDebugSnapshot;
}).__remuxNarrationDebugSnapshot = getNarrationDebugSnapshot;

export function narrationSourceHash(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function applyResource(
  resource: CodexNarrationResource,
  set: (state: Partial<NarrationStoreState>) => void,
  get: () => NarrationStoreState,
) {
  if (get().artifactKey && resource.artifactKey !== get().artifactKey) return;
  if (isOlderRevision(resource.revision, get().resourceRevision)) return;
  if (resource.status === 'cancelled') {
    clearRefreshTimer();
    audioEngine.close();
    releaseNarrationScrollOwnership();
    set(idleState());
    return;
  }

  const terminalFailure = resource.status === 'failed';
  const error = terminalFailure
    ? resource.error ?? 'Narration stopped before it was complete'
    : null;
  if (resource.manifest) {
    const artifact = resource.manifest;
    const hadArtifact = Boolean(get().artifact);
    if (hadArtifact) {
      set({
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
    const shouldPlay = get().phase === 'preparing'
      && !pausedForLifecycle
      && getHostLifecycleSnapshot().state === 'active';
    set({
      artifact,
      currentBlockId: position.block?.blockId ?? position.sentence?.blockId ?? null,
      currentBlockIndex: position.blockIndex,
      currentSample: firstSample,
      currentSentence: position.sentence,
      currentSentenceIndex: position.sentenceIndex,
      currentWordCue: position.wordCue,
      currentWordCueIndex: position.wordCueIndex,
      error,
      focusIntent: get().focusIntent ?? nextFocusIntent('follow'),
      phase: shouldPlay ? 'buffering' : get().phase === 'preparing' ? 'ready' : get().phase,
      progress: resource.progress,
      resourceRevision: resource.revision,
      status: resource.status,
    });
    if (shouldPlay) {
      if (get().followEnabled) claimNarrationScrollOwnership();
      const playEpoch = storeEpoch;
      void audioEngine.play(resource.artifactKey, artifact).catch((cause) => {
        if (
          playEpoch !== storeEpoch
          || useNarrationStore.getState().artifactKey !== resource.artifactKey
        ) return;
        useNarrationStore.setState({
          error: pausedForLifecycle ? null : errorMessage(cause),
          phase: pausedForLifecycle ? 'paused' : 'ready',
        });
      });
    }
  } else {
    set({
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
  const state = useNarrationStore.getState();
  if (!state.artifact) return;
  const position = resolveNarrationPosition(state.artifact, sample);
  if (
    position.blockIndex === state.currentBlockIndex &&
    position.sentenceIndex === state.currentSentenceIndex &&
    position.wordCueIndex === state.currentWordCueIndex
  ) {
    if (sample !== state.currentSample) useNarrationStore.setState({ currentSample: sample });
    return;
  }
  const reason = pendingFocus
    && pendingFocus.epoch === storeEpoch
    && pendingFocus.artifactKey === state.artifactKey
    ? pendingFocus.reason
    : state.followEnabled ? 'follow' : null;
  pendingFocus = null;
  useNarrationStore.setState({
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

async function seekToBlockId(blockId: string, get: () => NarrationStoreState) {
  const { artifact, artifactKey, currentBlockIndex, phase } = get();
  if (!artifactKey || !artifact) return;
  const destination = artifact.blocks.findIndex((block) => block.blockId === blockId);
  if (destination === -1) return;
  await seekToSample({
    artifact,
    artifactKey,
    currentBlockIndex,
    destination,
    get,
    keepPlaying: phase === 'playing' || phase === 'buffering',
    reason: 'explicitSeekInPlace',
  });
}

async function seekBlock(direction: -1 | 1, get: () => NarrationStoreState) {
  const { artifact, artifactKey, currentBlockIndex, phase } = get();
  if (!artifactKey || !artifact || artifact.blocks.length === 0) return;
  const current = currentBlockIndex >= 0 ? currentBlockIndex : 0;
  const destination = Math.max(0, Math.min(artifact.blocks.length - 1, current + direction));
  await seekToSample({
    artifact,
    artifactKey,
    currentBlockIndex: current,
    destination,
    get,
    keepPlaying: phase === 'playing' || phase === 'buffering',
    reason: 'explicitSeek',
  });
}

async function seekToSample({
  artifact,
  artifactKey,
  currentBlockIndex,
  destination,
  get,
  keepPlaying,
  reason,
}: {
  artifact: CodexNarrationArtifact;
  artifactKey: string;
  currentBlockIndex: number;
  destination: number;
  get: () => NarrationStoreState;
  keepPlaying: boolean;
  reason: 'explicitSeek' | 'explicitSeekInPlace';
}) {
  const epoch = storeEpoch;
  const focus = { artifactKey, epoch, reason } as const;
  try {
    const prepared = await audioEngine.prepare(artifactKey, artifact);
    if (!prepared || epoch !== storeEpoch || get().artifactKey !== artifactKey) return;
    pendingFocus = focus;
    const sought = await audioEngine.seek(
      artifactKey,
      artifact.blocks[destination].startSample,
      keepPlaying,
    );
    if (!sought || epoch !== storeEpoch || get().artifactKey !== artifactKey) return;
    if (destination === currentBlockIndex) {
      if (pendingFocus === focus) pendingFocus = null;
      useNarrationStore.setState({ focusIntent: nextFocusIntent(reason) });
    }
  } catch (error) {
    if (epoch !== storeEpoch || get().artifactKey !== artifactKey) return;
    if (pendingFocus === focus) pendingFocus = null;
    useNarrationStore.setState({
      error: pausedForLifecycle ? null : errorMessage(error),
      phase: pausedForLifecycle ? 'paused' : 'ready',
    });
  }
}

function idleState(): Pick<
  NarrationStoreState,
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
    playbackRate: defaultRate,
    progress: null,
    resourceRevision: null,
    status: null,
    target: null,
  };
}

function nextFocusIntent(reason: NarrationFocusReason) {
  focusIntentId += 1;
  return { id: focusIntentId, reason } as const;
}

function claimNarrationScrollOwnership() {
  getTranscriptViewportState().setAutoScrollMode({ type: 'narration-follow' });
}

function releaseNarrationScrollOwnership() {
  const viewport = getTranscriptViewportState();
  if (viewport.autoScrollMode.type === 'narration-follow') {
    viewport.setAutoScrollMode({ type: 'off' });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Narration request failed';
}

function isActiveStatus(status: CodexNarrationResource['status'] | null) {
  return status === 'preparing' || status === 'synthesizing' || status === 'finalizing';
}

function isOlderRevision(candidate: string, current: string | null) {
  if (current === null || candidate === current) return false;
  if (/^\d+$/.test(candidate) && /^\d+$/.test(current)) {
    return BigInt(candidate) < BigInt(current);
  }
  return false;
}

async function recoverMissingNarration(
  artifactKey: string,
  epoch: number,
  set: (state: Partial<NarrationStoreState>) => void,
  get: () => NarrationStoreState,
) {
  if (missingRecovery) return missingRecovery;
  const request = lastRequest;
  if (!request) {
    set({
      error: 'Narration state was lost after the service restarted. Start narration again.',
      phase: 'failed',
      status: 'failed',
    });
    return;
  }
  missingRecovery = (async () => {
    const start = startNarration({ document: request.document });
    pendingStart = start;
    let response: CodexNarrationStartResponse;
    try {
      response = await start;
    } finally {
      if (pendingStart === start) pendingStart = null;
    }
    if (epoch !== storeEpoch || get().artifactKey !== artifactKey) return;
    const resetArtifact = response.artifactKey !== artifactKey || !response.resource.manifest;
    if (resetArtifact) {
      audioEngine.close();
    }
    // A server restart begins a new revision epoch even when the deterministic
    // artifact key is unchanged. Do not compare its revision 1 against the
    // vanished process's higher in-memory revision.
    set({
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
    applyResource(response.resource, set, get);
  })().finally(() => {
    missingRecovery = null;
  });
  try {
    await missingRecovery;
  } catch (error) {
    if (epoch !== storeEpoch || get().artifactKey !== artifactKey) return;
    set({ error: errorMessage(error) });
    scheduleRefresh();
  }
}

async function waitForNarrationToStop(artifactKey: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await readNarration({ artifactKey });
    if (
      response.status === 'missing'
      || (response.status === 'ok' && response.resource && !isActiveStatus(response.resource.status))
    ) return;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw new Error('The previous narration is still stopping. Please retry.');
}

function cancelAndWaitForNarration(artifactKey: string) {
  return cancelPendingNarration(null, artifactKey);
}

function cancelPendingNarration(
  start: Promise<CodexNarrationStartResponse> | null,
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
      await cancelNarration({ artifactKey: key });
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
  if (refreshTimer !== null) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void useNarrationStore.getState().refresh();
  }, 1000);
}

function clearRefreshTimer() {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = null;
}
