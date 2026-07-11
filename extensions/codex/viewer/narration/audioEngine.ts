import type { CodexNarrationAudioChunk, CodexNarrationManifest } from '../../shared/narration';
import { readNarrationAudio } from '../ipc/narration';

export type NarrationAudioCallbacks = {
  onEnded: () => void;
  onError: (message: string) => void;
  onTime: (globalTime: number) => void;
};

export class NarrationAudioEngine {
  private artifactKey: string | null = null;
  private audio: HTMLAudioElement | null = null;
  private callbacks: NarrationAudioCallbacks;
  private chunkIndex = 0;
  private manifest: CodexNarrationManifest | null = null;
  private objectUrls = new Map<string, string>();
  private playbackRate = 1;
  private raf = 0;

  constructor(callbacks: NarrationAudioCallbacks) {
    this.callbacks = callbacks;
  }

  setCallbacks(callbacks: NarrationAudioCallbacks) {
    this.callbacks = callbacks;
  }

  async prepare(artifactKey: string, manifest: CodexNarrationManifest) {
    if (this.artifactKey !== artifactKey || this.manifest !== manifest) {
      this.close();
      this.artifactKey = artifactKey;
      this.manifest = manifest;
      await this.loadChunk(0);
      void this.preloadChunk(1);
    } else if (!this.audio) {
      await this.loadChunk(this.chunkIndex);
    }
  }

  async play(artifactKey: string, manifest: CodexNarrationManifest) {
    await this.prepare(artifactKey, manifest);
    if (!this.audio) return;
    if (this.audio.ended) this.audio.currentTime = 0;
    this.audio.playbackRate = this.playbackRate;
    this.audio.preservesPitch = true;
    await this.audio.play();
    this.startClock();
  }

  pause() {
    this.audio?.pause();
    this.stopClock();
    this.publishTime();
  }

  async seek(globalTime: number, keepPlaying: boolean) {
    const manifest = this.manifest;
    const artifactKey = this.artifactKey;
    if (!manifest || !artifactKey) return;
    const chunkIndex = Math.max(0, manifest.chunks.findIndex((chunk, index) =>
      globalTime >= chunk.start && (globalTime < chunk.end || index === manifest.chunks.length - 1)));
    await this.loadChunk(chunkIndex);
    if (!this.audio) return;
    const chunk = manifest.chunks[chunkIndex];
    this.audio.currentTime = Math.max(0, Math.min(globalTime - chunk.start, chunk.end - chunk.start));
    this.publishTime();
    if (keepPlaying) await this.play(artifactKey, manifest);
  }

  setPlaybackRate(rate: number) {
    this.playbackRate = rate;
    if (this.audio) this.audio.playbackRate = rate;
  }

  close() {
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
    this.manifest = null;
    this.chunkIndex = 0;
  }

  private async loadChunk(index: number) {
    const manifest = this.manifest;
    const artifactKey = this.artifactKey;
    const chunk = manifest?.chunks[index];
    if (!manifest || !artifactKey || !chunk) return;
    const url = await this.chunkUrl(artifactKey, chunk);
    if (this.audio) {
      this.audio.pause();
      this.audio.onended = null;
      this.audio.onerror = null;
    }
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.playbackRate = this.playbackRate;
    audio.preservesPitch = true;
    audio.onended = () => void this.advanceChunk();
    audio.onerror = () => this.callbacks.onError('Narration audio could not be loaded');
    this.audio = audio;
    this.chunkIndex = index;
    await waitForAudioReady(audio);
    this.releaseDistantChunks(index);
    void this.preloadChunk(index + 1);
  }

  private async advanceChunk() {
    const manifest = this.manifest;
    const artifactKey = this.artifactKey;
    if (!manifest || !artifactKey || this.chunkIndex + 1 >= manifest.chunks.length) {
      this.stopClock();
      this.callbacks.onEnded();
      return;
    }
    try {
      await this.loadChunk(this.chunkIndex + 1);
      await this.play(artifactKey, manifest);
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error.message : 'Narration audio could not continue');
    }
  }

  private async preloadChunk(index: number) {
    const manifest = this.manifest;
    const artifactKey = this.artifactKey;
    const chunk = manifest?.chunks[index];
    if (manifest && artifactKey && chunk) {
      try { await this.chunkUrl(artifactKey, chunk); } catch { /* Foreground loading reports errors. */ }
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
      this.manifest?.chunks[index]?.id,
      this.manifest?.chunks[index + 1]?.id,
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
    const chunk = this.manifest?.chunks[this.chunkIndex];
    this.callbacks.onTime((chunk?.start ?? 0) + (this.audio?.currentTime ?? 0));
  }
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
