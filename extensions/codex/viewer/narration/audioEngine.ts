import type { CodexNarrationAudioChunk, CodexNarrationTimeline } from '../../shared/narration';
import { readNarrationAudio } from '../ipc/narration';

export type NarrationAudioCallbacks = {
  onBuffering: () => void;
  onEnded: () => void;
  onError: (message: string) => void;
  onPlaying: () => void;
  onTime: (globalTime: number) => void;
};

export class NarrationAudioEngine {
  private artifactKey: string | null = null;
  private audio: HTMLAudioElement | null = null;
  private callbacks: NarrationAudioCallbacks;
  private chunkIndex = 0;
  private complete = false;
  private loadEpoch = 0;
  private objectUrls = new Map<string, string>();
  private playIntent = false;
  private playbackRate = 1;
  private raf = 0;
  private timeline: CodexNarrationTimeline | null = null;

  constructor(callbacks: NarrationAudioCallbacks) {
    this.callbacks = callbacks;
  }

  setCallbacks(callbacks: NarrationAudioCallbacks) {
    this.callbacks = callbacks;
  }

  async update(artifactKey: string, timeline: CodexNarrationTimeline) {
    if (this.artifactKey !== artifactKey) {
      const playIntent = this.playIntent;
      this.close();
      this.playIntent = playIntent;
      this.artifactKey = artifactKey;
    } else if (this.timeline && !isImmutablePrefix(this.timeline, timeline)) {
      throw new Error('Narration segment prefix changed after publication');
    }
    const previousLength = this.timeline?.chunks.length ?? 0;
    this.timeline = timeline;
    this.complete = timeline.complete;

    if (!this.audio && timeline.chunks.length > 0 && (this.chunkIndex === 0 || previousLength === 0)) {
      await this.loadChunk(this.chunkIndex);
      if (this.playIntent) await this.resumeLoadedAudio();
    } else if (
      this.audio?.ended &&
      this.playIntent &&
      this.chunkIndex + 1 < timeline.chunks.length
    ) {
      await this.loadChunk(this.chunkIndex + 1);
      await this.resumeLoadedAudio();
    }
    void this.preloadChunk(this.chunkIndex + 1);
  }

  async prepare(artifactKey: string, timeline: CodexNarrationTimeline) {
    await this.update(artifactKey, timeline);
    if (!this.audio && timeline.chunks[this.chunkIndex]) await this.loadChunk(this.chunkIndex);
  }

  async play(artifactKey: string, timeline: CodexNarrationTimeline) {
    this.playIntent = true;
    await this.prepare(artifactKey, timeline);
    if (!this.playIntent) return;
    if (!this.audio) {
      this.callbacks.onBuffering();
      return;
    }
    if (this.audio.ended && this.chunkIndex + 1 >= timeline.chunks.length) {
      this.audio.currentTime = 0;
    }
    await this.resumeLoadedAudio();
  }

  pause() {
    this.playIntent = false;
    this.audio?.pause();
    this.stopClock();
    this.publishTime();
  }

  async seek(globalTime: number, keepPlaying: boolean) {
    const timeline = this.timeline;
    if (!timeline || !this.artifactKey || timeline.chunks.length === 0) return;
    this.playIntent = keepPlaying;
    const bounded = Math.max(0, Math.min(globalTime, timeline.durationSeconds));
    const found = timeline.chunks.findIndex((chunk, index) =>
      bounded >= chunk.start && (bounded < chunk.end || index === timeline.chunks.length - 1));
    const chunkIndex = Math.max(0, found);
    const audio = await this.loadChunk(chunkIndex);
    if (!audio || this.audio !== audio) return;
    const chunk = timeline.chunks[chunkIndex];
    audio.currentTime = Math.max(0, Math.min(bounded - chunk.start, chunk.end - chunk.start));
    this.publishTime();
    if (keepPlaying) await this.resumeLoadedAudio();
  }

  setPlaybackRate(rate: number) {
    this.playbackRate = rate;
    if (this.audio) this.audio.playbackRate = rate;
  }

  close() {
    this.playIntent = false;
    this.loadEpoch += 1;
    this.stopClock();
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.audio = null;
    this.artifactKey = null;
    this.chunkIndex = 0;
    this.complete = false;
    this.timeline = null;
  }

  private async resumeLoadedAudio() {
    if (!this.audio || !this.playIntent) return;
    this.audio.playbackRate = this.playbackRate;
    this.audio.preservesPitch = true;
    await this.audio.play();
    this.callbacks.onPlaying();
    this.startClock();
  }

  private async loadChunk(index: number) {
    const chunk = this.timeline?.chunks[index];
    const artifactKey = this.artifactKey;
    if (!artifactKey || !chunk) return;
    const epoch = ++this.loadEpoch;
    const url = await this.chunkUrl(artifactKey, chunk);
    if (epoch !== this.loadEpoch) return null;
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.playbackRate = this.playbackRate;
    audio.preservesPitch = true;
    await waitForAudioReady(audio);
    if (epoch !== this.loadEpoch) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      return null;
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.onended = null;
      this.audio.onerror = null;
    }
    audio.onended = () => void this.advanceChunk();
    audio.onerror = () => this.callbacks.onError('Narration audio could not be loaded');
    this.audio = audio;
    this.chunkIndex = index;
    this.releaseDistantChunks(index);
    void this.preloadChunk(index + 1);
    return audio;
  }

  private async advanceChunk() {
    if (!this.timeline || !this.artifactKey) return;
    if (this.chunkIndex + 1 >= this.timeline.chunks.length) {
      this.stopClock();
      if (this.complete) {
        this.playIntent = false;
        this.callbacks.onEnded();
      } else {
        this.callbacks.onBuffering();
      }
      return;
    }
    try {
      await this.loadChunk(this.chunkIndex + 1);
      if (this.playIntent) await this.resumeLoadedAudio();
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error.message : 'Narration audio could not continue');
    }
  }

  private async preloadChunk(index: number) {
    const chunk = this.timeline?.chunks[index];
    if (this.artifactKey && chunk) {
      try { await this.chunkUrl(this.artifactKey, chunk); } catch { /* Foreground loading reports errors. */ }
    }
  }

  private async chunkUrl(artifactKey: string, chunk: CodexNarrationAudioChunk) {
    const cached = this.objectUrls.get(chunk.id);
    if (cached) return cached;
    const response = await readNarrationAudio({ artifactKey, chunkId: chunk.id });
    const bytes = decodeBase64(response.dataBase64);
    const url = URL.createObjectURL(new Blob([bytes], { type: response.mimeType }));
    this.objectUrls.set(chunk.id, url);
    return url;
  }

  private releaseDistantChunks(index: number) {
    const keep = new Set([
      this.timeline?.chunks[index]?.id,
      this.timeline?.chunks[index + 1]?.id,
    ].filter((id): id is string => Boolean(id)));
    for (const [chunkId, url] of this.objectUrls) {
      if (!keep.has(chunkId)) {
        URL.revokeObjectURL(url);
        this.objectUrls.delete(chunkId);
      }
    }
  }

  private startClock() {
    if (this.raf !== 0) return;
    const tick = () => {
      this.raf = 0;
      this.publishTime();
      if (this.audio && !this.audio.paused && !this.audio.ended) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopClock() {
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private publishTime() {
    const chunk = this.timeline?.chunks[this.chunkIndex];
    this.callbacks.onTime((chunk?.start ?? 0) + (this.audio?.currentTime ?? 0));
  }
}

function isImmutablePrefix(previous: CodexNarrationTimeline, next: CodexNarrationTimeline) {
  if (next.chunks.length < previous.chunks.length) return false;
  return previous.segments.every((segment, index) =>
    JSON.stringify(segment) === JSON.stringify(next.segments[index]));
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function waitForAudioReady(audio: HTMLAudioElement) {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', loaded);
      audio.removeEventListener('error', failed);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Narration audio could not be decoded')); };
    audio.addEventListener('loadedmetadata', loaded, { once: true });
    audio.addEventListener('error', failed, { once: true });
    audio.load();
  });
}
