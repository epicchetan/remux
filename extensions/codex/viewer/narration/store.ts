import { create } from 'zustand';
import { subscribeIpcEvents } from '@remux/viewer-kit/ipc';

import type {
  CodexNarrationCue,
  CodexNarrationManifest,
  CodexNarrationResource,
  CodexNarrationSourceDocument,
  CodexNarrationSourceTarget,
  CodexNarrationStartParams,
  CodexNarrationTarget,
} from '../../shared/narration';
import { cancelNarration, readNarration, startNarration } from '../ipc/narration';
import { focusTranscriptNarration, setTranscriptNarrationManualScrollHandler } from '../transcript/viewportStore';
import { NarrationAudioEngine } from './audioEngine';
import { resolveNarrationPosition } from './cueResolver';

export type NarrationPhase = 'failed' | 'idle' | 'paused' | 'playing' | 'preparing' | 'ready';

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
  completedUnits: number | null;
  currentBlockId: string | null;
  currentCue: CodexNarrationCue | null;
  currentCueIndex: number;
  currentTargetIds: string[];
  currentUnitIndex: number;
  error: string | null;
  followEnabled: boolean;
  followSuspendedByUser: boolean;
  manifest: CodexNarrationManifest | null;
  nextBlock: () => Promise<void>;
  pause: () => void;
  phase: NarrationPhase;
  play: () => Promise<void>;
  playbackRate: number;
  previousBlock: () => Promise<void>;
  refresh: () => Promise<void>;
  retry: () => Promise<void>;
  setPlaybackRate: (rate: number) => void;
  stage: CodexNarrationResource['stage'];
  start: (request: NarrationRequest) => Promise<void>;
  target: CodexNarrationTarget | null;
  toggleFollow: () => void;
  totalUnits: number | null;
};

const storedRate = Number.parseFloat(localStorage.getItem('narrationPlaybackRate') ?? '1');
const defaultRate = [0.75, 1, 1.25, 1.5, 2].includes(storedRate) ? storedRate : 1;
let lastRequest: NarrationRequest | null = null;
let refreshTimer: number | null = null;
let pendingFocusReason: 'explicitSeek' | 'followReenabled' | null = null;

const audioEngine = new NarrationAudioEngine({
  onEnded: () => undefined,
  onError: () => undefined,
  onTime: () => undefined,
});

export const useNarrationStore = create<NarrationStoreState>((set, get) => ({
  activeTargets: [],
  artifactKey: null,
  async cancel() {
    clearRefreshTimer();
    const artifactKey = get().artifactKey;
    if (artifactKey) {
      try { await cancelNarration({ artifactKey }); } catch { /* Cancellation is best effort. */ }
    }
    audioEngine.close();
    set(idleState());
  },
  close() {
    clearRefreshTimer();
    audioEngine.close();
    set(idleState());
  },
  completedUnits: null,
  currentBlockId: null,
  currentCue: null,
  currentCueIndex: -1,
  currentTargetIds: [],
  currentUnitIndex: 0,
  error: null,
  followEnabled: true,
  followSuspendedByUser: false,
  manifest: null,
  async nextBlock() {
    await seekBlock(1, get);
  },
  pause() {
    audioEngine.pause();
    set({ phase: 'paused' });
  },
  phase: 'idle',
  async play() {
    const { artifactKey, manifest } = get();
    if (!artifactKey || !manifest) return;
    try {
      await audioEngine.play(artifactKey, manifest);
      set({ error: null, phase: 'playing' });
    } catch (error) {
      set({ error: errorMessage(error), phase: 'ready' });
    }
  },
  playbackRate: defaultRate,
  async previousBlock() {
    await seekBlock(-1, get);
  },
  async refresh() {
    const { artifactKey } = get();
    if (!artifactKey) return;
    try {
      const response = await readNarration({ artifactKey });
      if (response.status === 'ok' && response.resource) applyResource(response.resource, set, get);
    } catch (error) {
      set({ error: errorMessage(error), phase: 'failed', stage: null });
    }
  },
  async retry() {
    if (lastRequest) await get().start(lastRequest);
  },
  setPlaybackRate(rate) {
    if (![0.75, 1, 1.25, 1.5, 2].includes(rate)) return;
    localStorage.setItem('narrationPlaybackRate', String(rate));
    audioEngine.setPlaybackRate(rate);
    set({ playbackRate: rate });
  },
  stage: null,
  async start(request) {
    lastRequest = request;
    set({ ...idleState(), phase: 'preparing', stage: 'planning', target: request.target });
    try {
      const response = await startNarration(request satisfies CodexNarrationStartParams);
      set({ artifactKey: response.artifactKey });
      applyResource(response.resource, set, get);
    } catch (error) {
      set({ error: errorMessage(error), phase: 'failed', stage: null });
    }
  },
  target: null,
  toggleFollow() {
    const enabled = !get().followEnabled;
    set({ followEnabled: enabled, followSuspendedByUser: false });
    if (enabled) focusCurrentTargets('followReenabled');
  },
  totalUnits: null,
}));

audioEngine.setCallbacks({
  onEnded: () => useNarrationStore.setState({ phase: 'paused' }),
  onError: (error) => useNarrationStore.setState({ error, phase: 'ready' }),
  onTime: (globalTime) => applyAudioTime(globalTime),
});
audioEngine.setPlaybackRate(defaultRate);

setTranscriptNarrationManualScrollHandler(() => {
  const state = useNarrationStore.getState();
  if (state.phase === 'ready' || state.phase === 'playing' || state.phase === 'paused') {
    useNarrationStore.setState({ followEnabled: false, followSuspendedByUser: true });
  }
});

export function subscribeNarrationUpdates() {
  return subscribeIpcEvents((events) => {
    const artifactKey = useNarrationStore.getState().artifactKey;
    if (!artifactKey) return;
    if (events.some((event) =>
      event.method === 'remux/codex/narration/updated' &&
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
  if (resource.status === 'ready' && resource.manifest) {
    clearRefreshTimer();
    const position = resolveNarrationPosition(resource.manifest, resource.manifest.units[0]?.start ?? 0);
    set({
      activeTargets: position.targets,
      completedUnits: resource.completedUnits,
      currentBlockId: position.unit?.blockId ?? null,
      currentCue: position.cue,
      currentCueIndex: position.cueIndex,
      currentTargetIds: position.targetIds,
      currentUnitIndex: position.unitIndex,
      error: null,
      manifest: resource.manifest,
      phase: 'ready',
      stage: null,
      totalUnits: resource.totalUnits,
    });
    window.requestAnimationFrame(() => focusCurrentTargets('follow'));
    return;
  }
  if (resource.status === 'failed') {
    clearRefreshTimer();
    set({ error: resource.error ?? 'Narration could not be prepared', phase: 'failed', stage: null });
    return;
  }
  if (resource.status === 'cancelled') {
    clearRefreshTimer();
    audioEngine.close();
    set(idleState());
    return;
  }
  set({
    completedUnits: resource.completedUnits,
    error: resource.error,
    phase: 'preparing',
    stage: resource.stage,
    totalUnits: resource.totalUnits,
  });
  scheduleRefresh();
}

function applyAudioTime(globalTime: number) {
  const state = useNarrationStore.getState();
  if (!state.manifest) return;
  const position = resolveNarrationPosition(state.manifest, globalTime);
  if (position.cueIndex === state.currentCueIndex && position.unitIndex === state.currentUnitIndex) return;
  const previousFocusKey = visualFocusTargetIds(state).join('\0');
  useNarrationStore.setState({
    activeTargets: position.targets,
    currentBlockId: position.unit?.blockId ?? null,
    currentCue: position.cue,
    currentCueIndex: position.cueIndex,
    currentTargetIds: position.targetIds,
    currentUnitIndex: position.unitIndex,
  });
  const targetsChanged = visualFocusTargetIds(useNarrationStore.getState()).join('\0') !== previousFocusKey;
  const reason = pendingFocusReason;
  pendingFocusReason = null;
  if (reason) focusCurrentTargets(reason);
  else if (targetsChanged && useNarrationStore.getState().followEnabled) focusCurrentTargets('follow');
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
  await audioEngine.seek(manifest.units[destination].start, phase === 'playing');
  if (destination === current) {
    pendingFocusReason = null;
    focusCurrentTargets('explicitSeek');
  }
}

function focusCurrentTargets(reason: 'explicitSeek' | 'follow' | 'followReenabled') {
  const state = useNarrationStore.getState();
  const targetIds = visualFocusTargetIds(state);
  if (!state.target || targetIds.length === 0) return;
  focusTranscriptNarration({
    assistantMessageId: state.target.assistantMessageId,
    reason,
    targetIds,
    threadId: state.target.threadId,
    turnId: state.target.turnId,
  });
}

function visualFocusTargetIds(state: NarrationStoreState) {
  const semanticTargets = state.activeTargets.filter((target) =>
    target.kind === 'codeLines' ||
    target.kind === 'diagramNode' ||
    target.kind === 'tableCell' ||
    target.kind === 'tableRegion');
  if (semanticTargets.length > 0) return semanticTargets.map((target) => target.id);
  const blockTarget = state.manifest?.targets.find((target) =>
    target.kind === 'block' && target.blockId === state.currentBlockId);
  return blockTarget ? [blockTarget.id] : state.currentTargetIds;
}

function idleState(): Pick<
  NarrationStoreState,
  | 'activeTargets'
  | 'artifactKey'
  | 'completedUnits'
  | 'currentBlockId'
  | 'currentCue'
  | 'currentCueIndex'
  | 'currentTargetIds'
  | 'currentUnitIndex'
  | 'error'
  | 'followEnabled'
  | 'followSuspendedByUser'
  | 'manifest'
  | 'phase'
  | 'stage'
  | 'target'
  | 'totalUnits'
> {
  return {
    activeTargets: [],
    artifactKey: null,
    completedUnits: null,
    currentBlockId: null,
    currentCue: null,
    currentCueIndex: -1,
    currentTargetIds: [],
    currentUnitIndex: 0,
    error: null,
    followEnabled: true,
    followSuspendedByUser: false,
    manifest: null,
    phase: 'idle',
    stage: null,
    target: null,
    totalUnits: null,
  };
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
