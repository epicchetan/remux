import {
  type NarrationAudioCallbacks,
  type NarrationAudioDriver,
} from './audio';
import type { NarrationArtifact, NarrationPlaybackRate } from './protocol';

export type NarrationAudioSnapshot = {
  artifactKey: string | null;
  clockRunning: boolean;
  currentTime: number | null;
  duration: number | null;
  ended: boolean | null;
  hasAudio: boolean;
  hasPendingAudio: boolean;
  lastMediaEvent: string | null;
  lastMediaEventAt: number | null;
  lastSampleChangedAt: number | null;
  loadEpoch: number;
  networkState: number | null;
  paused: boolean | null;
  playIntent: boolean;
  playbackRate: number;
  readyState: number | null;
};

export type NarrationMediaElementFactory = (url: string) => HTMLAudioElement;

const audioMetadataTimeoutMs = 15_000;
const noopCallbacks: NarrationAudioCallbacks = {
  onBuffering: () => undefined,
  onEnded: () => undefined,
  onError: () => undefined,
  onPaused: () => undefined,
  onPlaying: () => undefined,
  onSample: () => undefined,
};

export function createBrowserNarrationAudio(options: {
  createMediaElement?: NarrationMediaElementFactory;
} = {}): NarrationAudioDriver {
  return new BrowserNarrationAudio(
    options.createMediaElement ?? ((url) => new Audio(url)),
  );
}

class BrowserNarrationAudio implements NarrationAudioDriver {
  private artifact: NarrationArtifact | null = null;
  private artifactKey: string | null = null;
  private audio: HTMLAudioElement | null = null;
  private callbacks = noopCallbacks;
  private loadEpoch = 0;
  private pendingLoad: { abort: AbortController; audio: HTMLAudioElement } | null = null;
  private pendingPrepare: { artifactKey: string; promise: Promise<boolean> } | null = null;
  private lastMediaEvent: string | null = null;
  private lastMediaEventAt: number | null = null;
  private lastPublishedSample: number | null = null;
  private lastSampleChangedAt: number | null = null;
  private playIntent = false;
  private playbackRate: NarrationPlaybackRate = 1;
  private raf = 0;

  constructor(private readonly createMediaElement: NarrationMediaElementFactory) {}

  setCallbacks(callbacks: NarrationAudioCallbacks) {
    this.callbacks = callbacks;
  }

  async prepare(artifactKey: string, artifact: NarrationArtifact): Promise<boolean> {
    if (this.audio && this.artifactKey === artifactKey) return true;
    if (this.pendingPrepare?.artifactKey === artifactKey) return this.pendingPrepare.promise;
    const epoch = this.resetForLoad(artifactKey, artifact);
    this.callbacks.onBuffering();
    const promise = this.prepareUrl(epoch, artifact);
    this.pendingPrepare = { artifactKey, promise };
    try {
      return await promise;
    } finally {
      if (this.pendingPrepare?.promise === promise) this.pendingPrepare = null;
    }
  }

  private async prepareUrl(epoch: number, artifact: NarrationArtifact): Promise<boolean> {
    const audio = this.createMediaElement(resolveNarrationAudioUrl(artifact));
    const pendingLoad = { abort: new AbortController(), audio };
    this.pendingLoad = pendingLoad;
    audio.preload = 'auto';
    audio.playbackRate = this.playbackRate;
    audio.preservesPitch = true;
    try {
      await waitForAudioReady(audio, pendingLoad.abort.signal);
    } catch (error) {
      if (this.pendingLoad === pendingLoad) this.pendingLoad = null;
      disposeAudio(audio);
      throw error;
    }
    if (this.pendingLoad === pendingLoad) this.pendingLoad = null;
    if (epoch !== this.loadEpoch) {
      disposeAudio(audio);
      return false;
    }
    audio.onplaying = () => {
      if (audio !== this.audio || !this.playIntent) return;
      this.recordMediaEvent('playing');
      this.callbacks.onPlaying();
      this.startClock();
    };
    audio.onpause = () => {
      if (audio !== this.audio) return;
      this.recordMediaEvent('pause');
      this.playIntent = false;
      this.stopClock();
      this.publishSample();
      if (!audio.ended) this.callbacks.onPaused();
    };
    audio.onwaiting = () => {
      if (audio !== this.audio || !this.playIntent) return;
      this.recordMediaEvent('waiting');
      this.stopClock();
      this.callbacks.onBuffering();
    };
    audio.onstalled = () => {
      if (audio !== this.audio || !this.playIntent) return;
      this.recordMediaEvent('stalled');
      this.stopClock();
      this.callbacks.onBuffering();
    };
    audio.ontimeupdate = () => {
      if (audio !== this.audio) return;
      this.publishSample();
    };
    audio.onended = () => {
      if (audio !== this.audio) return;
      this.recordMediaEvent('ended');
      this.playIntent = false;
      this.stopClock();
      this.publishSample();
      this.callbacks.onEnded();
    };
    audio.onerror = () => {
      if (audio !== this.audio) return;
      this.recordMediaEvent('error');
      this.playIntent = false;
      this.stopClock();
      this.callbacks.onError('Narration audio could not be loaded');
    };
    this.audio = audio;
    this.recordMediaEvent('loadedmetadata');
    this.publishSample();
    return true;
  }

  async play(artifactKey: string, artifact: NarrationArtifact) {
    this.playIntent = true;
    const prepared = await this.prepare(artifactKey, artifact);
    if (!prepared || this.artifactKey !== artifactKey || !this.playIntent || !this.audio) return;
    const audio = this.audio;
    if (audio.ended) audio.currentTime = 0;
    audio.playbackRate = this.playbackRate;
    audio.preservesPitch = true;
    await audio.play();
    if (audio === this.audio && this.playIntent && !audio.paused) {
      this.callbacks.onPlaying();
      this.startClock();
    }
  }

  pause() {
    this.playIntent = false;
    this.audio?.pause();
    this.stopClock();
    this.publishSample();
    this.callbacks.onPaused();
  }

  async seek(artifactKey: string, sample: number, keepPlaying: boolean): Promise<boolean> {
    const artifact = this.artifact;
    const audio = this.audio;
    if (this.artifactKey !== artifactKey || !artifact || !audio) return false;
    this.playIntent = keepPlaying;
    const bounded = Math.max(0, Math.min(sample, artifact.audio.totalSamples));
    audio.currentTime = bounded / artifact.audio.sampleRate;
    this.publishSample();
    if (keepPlaying) {
      audio.playbackRate = this.playbackRate;
      await audio.play();
      if (audio === this.audio && this.playIntent && !audio.paused) {
        this.callbacks.onPlaying();
        this.startClock();
      }
    } else {
      audio.pause();
      this.stopClock();
      this.callbacks.onPaused();
    }
    return audio === this.audio && this.artifactKey === artifactKey;
  }

  setPlaybackRate(rate: NarrationPlaybackRate) {
    this.playbackRate = rate;
    if (this.audio) this.audio.playbackRate = rate;
  }

  close() {
    this.playIntent = false;
    this.loadEpoch += 1;
    this.stopClock();
    this.pendingPrepare = null;
    if (this.pendingLoad) {
      const { abort, audio } = this.pendingLoad;
      this.pendingLoad = null;
      abort.abort();
      disposeAudio(audio);
    }
    if (this.audio) {
      this.audio.onplaying = null;
      this.audio.onpause = null;
      this.audio.onwaiting = null;
      this.audio.onstalled = null;
      this.audio.ontimeupdate = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      disposeAudio(this.audio);
    }
    this.artifact = null;
    this.artifactKey = null;
    this.audio = null;
    this.lastPublishedSample = null;
  }

  snapshot(): NarrationAudioSnapshot {
    const audio = this.audio;
    return {
      artifactKey: this.artifactKey,
      clockRunning: this.raf !== 0,
      currentTime: finiteOrNull(audio?.currentTime),
      duration: finiteOrNull(audio?.duration),
      ended: audio?.ended ?? null,
      hasAudio: audio !== null,
      hasPendingAudio: this.pendingLoad !== null,
      lastMediaEvent: this.lastMediaEvent,
      lastMediaEventAt: this.lastMediaEventAt,
      lastSampleChangedAt: this.lastSampleChangedAt,
      loadEpoch: this.loadEpoch,
      networkState: audio?.networkState ?? null,
      paused: audio?.paused ?? null,
      playIntent: this.playIntent,
      playbackRate: this.playbackRate,
      readyState: audio?.readyState ?? null,
    };
  }

  private resetForLoad(artifactKey: string, artifact: NarrationArtifact) {
    const playIntent = this.playIntent;
    this.close();
    this.playIntent = playIntent;
    this.artifactKey = artifactKey;
    this.artifact = artifact;
    return this.loadEpoch;
  }

  private startClock() {
    if (this.raf !== 0) return;
    const tick = () => {
      this.raf = 0;
      this.publishSample();
      if (this.audio && !this.audio.paused && !this.audio.ended) {
        this.raf = window.requestAnimationFrame(tick);
      }
    };
    this.raf = window.requestAnimationFrame(tick);
  }

  private stopClock() {
    if (this.raf !== 0) window.cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private publishSample() {
    const artifact = this.artifact;
    if (!artifact) return;
    const sample = Math.floor((this.audio?.currentTime ?? 0) * artifact.audio.sampleRate);
    const bounded = Math.max(0, Math.min(sample, artifact.audio.totalSamples));
    if (bounded !== this.lastPublishedSample) {
      this.lastPublishedSample = bounded;
      this.lastSampleChangedAt = Date.now();
    }
    this.callbacks.onSample(bounded);
  }

  private recordMediaEvent(event: string) {
    this.lastMediaEvent = event;
    this.lastMediaEventAt = Date.now();
  }
}

export function resolveNarrationAudioUrl(artifact: NarrationArtifact) {
  const { sha256, url } = artifact.audio;
  const hash = sha256.startsWith('sha256-') ? sha256.slice('sha256-'.length) : '';
  const expectedPath = `/remux/media/sha256/${hash}`;
  if (!/^[0-9a-f]{64}$/.test(hash) || url !== expectedPath) {
    throw new Error('Narration audio URL does not match its manifest');
  }
  const resolved = new URL(url, window.location.origin);
  if (resolved.origin !== window.location.origin || resolved.search || resolved.hash) {
    throw new Error('Narration audio URL is not a same-origin media resource');
  }
  return resolved.href;
}

function waitForAudioReady(audio: HTMLAudioElement, signal: AbortSignal) {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
      audio.removeEventListener('loadedmetadata', loaded);
      audio.removeEventListener('error', failed);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Narration audio could not be decoded')); };
    const aborted = () => { cleanup(); reject(new Error('Narration audio load was cancelled')); };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Narration audio metadata timed out'));
    }, audioMetadataTimeoutMs);
    signal.addEventListener('abort', aborted, { once: true });
    audio.addEventListener('loadedmetadata', loaded, { once: true });
    audio.addEventListener('error', failed, { once: true });
    audio.load();
  });
}

function disposeAudio(audio: HTMLAudioElement) {
  audio.removeAttribute('src');
  audio.load();
}

function finiteOrNull(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
