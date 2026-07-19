import type { NarrationArtifact, NarrationPlaybackRate } from './protocol';

export type NarrationAudioCallbacks = {
  onBuffering(): void;
  onEnded(): void;
  onError(message: string): void;
  onPaused(): void;
  onPlaying(): void;
  onSample(sample: number): void;
};

export type NarrationAudioDriver = {
  close(): void;
  pause(): void;
  play(artifactKey: string, artifact: NarrationArtifact): Promise<void>;
  prepare(artifactKey: string, artifact: NarrationArtifact): Promise<boolean>;
  seek(artifactKey: string, sample: number, play: boolean): Promise<boolean>;
  setCallbacks(callbacks: NarrationAudioCallbacks): void;
  setPlaybackRate(rate: NarrationPlaybackRate): void;
  snapshot(): unknown;
};

export const narrationPlaybackRates = [0.75, 1, 1.25, 1.5, 2] as const;

export function isNarrationPlaybackRate(value: number): value is NarrationPlaybackRate {
  return narrationPlaybackRates.some((rate) => rate === value);
}
