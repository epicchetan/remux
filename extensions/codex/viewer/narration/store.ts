import { create } from 'zustand';
import { subscribeIpcEvents } from '@remux/viewer-kit/ipc';

import type {
  CodexNarrationCue,
  CodexNarrationProgress,
  CodexNarrationResource,
  CodexNarrationSourceDocument,
  CodexNarrationSourceTarget,
  CodexNarrationStartParams,
  CodexNarrationTarget,
  CodexNarrationTimeline,
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
  sourceText: string;
  target: CodexNarrationTarget;
};

type NarrationStoreState = {
  activeTargets: CodexNarrationSourceTarget[];
  artifactKey: string | null;
  cancel: () => Promise<void>;
  close: () => void;
  currentBlockId: string | null;
  currentCue: CodexNarrationCue | null;
  currentCueIndex: number;
  currentTargetIds: string[];
  currentUnitIndex: number;
  error: string | null;
  followEnabled: boolean;
  focusIntent: { id: number; reason: NarrationFocusReason } | null;
  followSuspendedByUser: boolean;
  manifest: CodexNarrationTimeline | null;
  nextBlock: () => Promise<void>;
  pause: () => void;
  phase: NarrationPhase;
  play: () => Promise<void>;
  playbackRate: number;
  previousBlock: () => Promise<void>;
  progress: CodexNarrationProgress | null;
  refresh: () => Promise<void>;
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
let pendingFocusReason: 'explicitSeek' | 'explicitSeekInPlace' | 'followReenabled' | null = null;
let focusIntentId = 0;

const audioEngine = new NarrationAudioEngine({
  onBuffering: () => undefined,
  onEnded: () => undefined,
  onError: () => undefined,
  onPlaying: () => undefined,
  onTime: () => undefined,
});

export const useNarrationStore = create<NarrationStoreState>((set, get) => ({
  activeTargets: [],
  artifactKey: null,
  async cancel() {
    clearRefreshTimer();
    const artifactKey = get().artifactKey;
    if (artifactKey) {
      try { await cancelNarration({ artifactKey }); } catch { /* Best effort. */ }
    }
    audioEngine.close();
    releaseNarrationScrollOwnership();
    set(idleState());
  },
  close() {
    clearRefreshTimer();
    const artifactKey = get().artifactKey;
    if (artifactKey && get().status && get().status !== 'ready') {
      void cancelNarration({ artifactKey }).catch(() => undefined);
    }
    audioEngine.close();
    releaseNarrationScrollOwnership();
    set(idleState());
  },
  currentBlockId: null,
  currentCue: null,
  currentCueIndex: -1,
  currentTargetIds: [],
  currentUnitIndex: 0,
  error: null,
  followEnabled: true,
  focusIntent: null,
  followSuspendedByUser: false,
  manifest: null,
  async nextBlock() { await seekBlock(1, get); },
  pause() {
    audioEngine.pause();
    set({ phase: 'paused' });
  },
  phase: 'idle',
  async play() {
    const { artifactKey, followEnabled, manifest } = get();
    if (!artifactKey || !manifest) return;
    if (followEnabled) claimNarrationScrollOwnership();
    try {
      await audioEngine.play(artifactKey, manifest);
    } catch (error) {
      set({ error: errorMessage(error), phase: 'ready' });
    }
  },
  playbackRate: defaultRate,
  async previousBlock() { await seekBlock(-1, get); },
  progress: null,
  async refresh() {
    const { artifactKey } = get();
    if (!artifactKey) return;
    try {
      const response = await readNarration({ artifactKey });
      if (response.status === 'ok' && response.resource) applyResource(response.resource, set, get);
    } catch (error) {
      set({ error: errorMessage(error), phase: 'failed', status: 'failed' });
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
    lastRequest = request;
    set({
      ...idleState(),
      phase: 'preparing',
      status: 'planning',
      target: request.target,
    });
    try {
      const response = await startNarration(request satisfies CodexNarrationStartParams);
      set({ artifactKey: response.artifactKey });
      applyResource(response.resource, set, get);
    } catch (error) {
      set({ error: errorMessage(error), phase: 'failed', status: 'failed' });
    }
  },
  status: null,
  target: null,
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
      activeTargets: [],
      currentCue: null,
      currentCueIndex: -1,
      currentTargetIds: [],
      phase: state.error ? 'failed' : 'paused',
    });
  },
  onError: (error) => useNarrationStore.setState({ error, phase: 'ready' }),
  onPlaying: () => useNarrationStore.setState({ error: null, phase: 'playing' }),
  onTime: (globalTime) => applyAudioTime(globalTime),
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
  return subscribeIpcEvents((events) => {
    const artifactKey = useNarrationStore.getState().artifactKey;
    if (!artifactKey) return;
    if (events.some((event) =>
      event.method === 'remux/narrate/narration/updated' &&
      event.params &&
      typeof event.params === 'object' &&
      (event.params as { artifactKey?: unknown }).artifactKey === artifactKey
    )) void useNarrationStore.getState().refresh();
  });
}

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
  if (resource.status === 'cancelled') {
    clearRefreshTimer();
    audioEngine.close();
    releaseNarrationScrollOwnership();
    set(idleState());
    return;
  }

  const timeline = timelineFromResource(resource);
  const hadTimeline = Boolean(get().manifest);
  const playWhenAvailable = !hadTimeline && get().phase === 'preparing';
  const terminalFailure = resource.status === 'failed';
  const error = terminalFailure
    ? resource.error ?? 'Narration stopped before it was complete'
    : null;

  if (timeline) {
    const position = resolveNarrationPosition(timeline, timeline.units[0]?.start ?? 0);
    set({
      activeTargets: get().currentCue ? get().activeTargets : position.targets,
      currentBlockId: get().currentBlockId ?? position.unit?.blockId ?? null,
      currentCue: get().currentCue ?? position.cue,
      currentCueIndex: get().currentCueIndex >= 0 ? get().currentCueIndex : position.cueIndex,
      currentTargetIds: get().currentTargetIds.length ? get().currentTargetIds : position.targetIds,
      currentUnitIndex: get().currentUnitIndex || position.unitIndex,
      error,
      focusIntent: get().focusIntent ?? nextFocusIntent('follow'),
      manifest: timeline,
      progress: resource.progress,
      status: resource.status,
      target: resource.target,
    });
    const artifactKey = resource.artifactKey;
    if (playWhenAvailable) {
      if (get().followEnabled) claimNarrationScrollOwnership();
      void audioEngine.play(artifactKey, timeline).catch((cause) => {
        useNarrationStore.setState({ error: errorMessage(cause), phase: 'ready' });
      });
    } else {
      void audioEngine.update(artifactKey, timeline).catch((cause) => {
        useNarrationStore.setState({ error: errorMessage(cause), phase: 'ready' });
      });
    }
  } else {
    set({
      error,
      phase: terminalFailure ? 'failed' : 'preparing',
      progress: resource.progress,
      status: resource.status,
      target: resource.target,
    });
  }

  if (resource.status === 'ready' || terminalFailure) clearRefreshTimer();
  else scheduleRefresh();
}

function timelineFromResource(resource: CodexNarrationResource): CodexNarrationTimeline | null {
  if (resource.manifest) {
    return {
      chunks: resource.manifest.chunks,
      complete: true,
      cues: resource.manifest.cues,
      durationSeconds: resource.manifest.durationSeconds,
      segments: resource.manifest.segments,
      targets: resource.manifest.targets,
      units: resource.manifest.units,
    };
  }
  if (resource.availableSegments.length === 0 || !lastRequest) return null;
  const segments = resource.availableSegments;
  return {
    chunks: segments.map((segment) => segment.audio),
    complete: resource.status === 'failed',
    cues: segments.flatMap((segment) => segment.cues),
    durationSeconds: resource.availableDuration,
    segments,
    targets: lastRequest.document.targets,
    units: segments.flatMap((segment) => segment.units),
  };
}

function applyAudioTime(globalTime: number) {
  const state = useNarrationStore.getState();
  if (!state.manifest) return;
  const position = resolveNarrationPosition(state.manifest, globalTime);
  if (position.cueIndex === state.currentCueIndex && position.unitIndex === state.currentUnitIndex) return;
  const reason = pendingFocusReason ?? (state.followEnabled ? 'follow' : null);
  pendingFocusReason = null;
  useNarrationStore.setState({
    activeTargets: position.targets,
    currentBlockId: position.unit?.blockId ?? null,
    currentCue: position.cue,
    currentCueIndex: position.cueIndex,
    currentTargetIds: position.targetIds,
    currentUnitIndex: position.unitIndex,
    focusIntent: reason ? nextFocusIntent(reason) : null,
  });
}

async function seekToBlockId(blockId: string, get: () => NarrationStoreState) {
  const { artifactKey, currentUnitIndex, manifest, phase } = get();
  if (!artifactKey || !manifest) return;
  const destination = manifest.units.findIndex((unit) => unit.blockId === blockId);
  if (destination === -1) return;
  await audioEngine.prepare(artifactKey, manifest);
  const current = Math.max(0, currentUnitIndex);
  pendingFocusReason = 'explicitSeekInPlace';
  await audioEngine.seek(blockNavigationTime(manifest, destination), phase === 'playing' || phase === 'buffering');
  if (destination === current) {
    pendingFocusReason = null;
    useNarrationStore.setState({ focusIntent: nextFocusIntent('explicitSeekInPlace') });
  }
}

async function seekBlock(direction: -1 | 1, get: () => NarrationStoreState) {
  const { artifactKey, currentUnitIndex, manifest, phase } = get();
  if (!artifactKey || !manifest || manifest.units.length === 0) return;
  await audioEngine.prepare(artifactKey, manifest);
  const current = Math.max(0, currentUnitIndex);
  const currentBlock = manifest.units[current]?.blockId;
  let destination = current;
  for (let index = current + direction; index >= 0 && index < manifest.units.length; index += direction) {
    if (manifest.units[index].blockId !== currentBlock) {
      destination = index;
      break;
    }
  }
  pendingFocusReason = 'explicitSeek';
  await audioEngine.seek(blockNavigationTime(manifest, destination), phase === 'playing' || phase === 'buffering');
  if (destination === current) {
    pendingFocusReason = null;
    useNarrationStore.setState({ focusIntent: nextFocusIntent('explicitSeek') });
  }
}

function blockNavigationTime(manifest: CodexNarrationTimeline, unitIndex: number) {
  const unit = manifest.units[unitIndex];
  if (!unit) return 0;
  const firstCue = manifest.cues.find((cue) => cue.unitId === unit.id);
  if (!firstCue) return unit.start;
  const cueStart = Math.max(unit.start, Math.min(unit.end, firstCue.start));
  const cueEnd = Math.max(cueStart, Math.min(unit.end, firstCue.end));
  return cueStart + Math.min(0.001, Math.max(0, (cueEnd - cueStart) / 2));
}

function idleState(): Pick<
  NarrationStoreState,
  | 'activeTargets'
  | 'artifactKey'
  | 'currentBlockId'
  | 'currentCue'
  | 'currentCueIndex'
  | 'currentTargetIds'
  | 'currentUnitIndex'
  | 'error'
  | 'followEnabled'
  | 'focusIntent'
  | 'followSuspendedByUser'
  | 'manifest'
  | 'phase'
  | 'progress'
  | 'status'
  | 'target'
> {
  return {
    activeTargets: [],
    artifactKey: null,
    currentBlockId: null,
    currentCue: null,
    currentCueIndex: -1,
    currentTargetIds: [],
    currentUnitIndex: 0,
    error: null,
    followEnabled: true,
    focusIntent: null,
    followSuspendedByUser: false,
    manifest: null,
    phase: 'idle',
    progress: null,
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
