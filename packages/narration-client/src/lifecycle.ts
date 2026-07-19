export type NarrationLifecycleState = 'active' | 'background' | 'inactive';

export type NarrationLifecycle = {
  snapshot(): { state: NarrationLifecycleState };
  subscribe(listener: (state: NarrationLifecycleState) => void): () => void;
  subscribeResume(listener: () => void): () => void;
};

export type NarrationPreferences = {
  readPlaybackRate(): number | null;
  writePlaybackRate(rate: number): void;
};

export type NarrationScheduler = {
  clearTimeout(handle: unknown): void;
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
};

export const browserNarrationPreferences: NarrationPreferences = {
  readPlaybackRate: () => {
    if (typeof localStorage === 'undefined') return null;
    const value = Number.parseFloat(localStorage.getItem('narrationPlaybackRate') ?? '');
    return Number.isFinite(value) ? value : null;
  },
  writePlaybackRate: (rate) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('narrationPlaybackRate', String(rate));
    }
  },
};

export const browserNarrationScheduler: NarrationScheduler = {
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
};
