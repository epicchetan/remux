import type { NarrationClientState } from '@remux/narration-client';

import type { MarkdownNarrationTarget } from './client';

export function narrationStatusText(
  state: NarrationClientState<MarkdownNarrationTarget>,
  fallback: string | null,
) {
  const { artifact, currentBlockIndex, currentSample, error, phase, progress } = state;
  if (phase === 'idle') {
    return fallback;
  }
  if (phase === 'failed') {
    return error ?? 'Narration could not be prepared';
  }
  if (phase === 'preparing') {
    return preparationStatus(progress);
  }
  if (phase === 'buffering') {
    return 'Loading narration audio';
  }
  if (!artifact) {
    return fallback;
  }
  if (error) {
    return error;
  }

  const elapsed = formatSampleTime(currentSample, artifact.audio.sampleRate);
  const total = formatSampleTime(artifact.audio.totalSamples, artifact.audio.sampleRate);
  const blockPosition = artifact.blocks.length > 0
    ? `Block ${Math.max(0, currentBlockIndex) + 1} of ${artifact.blocks.length}`
    : null;
  const position = [blockPosition, `${elapsed} / ${total}`].filter(Boolean).join(' · ');
  if (phase === 'ready') {
    return `Narration ready · ${total}`;
  }
  if (phase === 'paused') {
    return `Paused · ${position}`;
  }
  return position;
}

function preparationStatus(progress: NarrationClientState<MarkdownNarrationTarget>['progress']) {
  switch (progress?.stage) {
    case 'languagePlanning': {
      const completed = progress.auditWindowsCompleted + progress.transcriptWindowsCompleted;
      const total = progress.auditWindowsTotal + progress.transcriptWindowsTotal;
      return total > 0 ? `Preparing speech ${completed} of ${total}` : 'Preparing speech';
    }
    case 'planning':
      return 'Planning natural speech chunks';
    case 'loadingModel':
      return 'Loading the voice model';
    case 'synthesizing': {
      const percent = progress.chunksTotal > 0
        ? Math.round((progress.chunksCompleted / progress.chunksTotal) * 100)
        : null;
      return percent === null ? 'Synthesizing audio' : `Synthesizing audio ${percent}%`;
    }
    case 'finalizing':
      return 'Finishing audio';
    case 'ready':
      return 'Narration ready';
    case 'baseline':
    default:
      return 'Building pronunciation baseline';
  }
}

function formatSampleTime(sample: number, sampleRate: number) {
  const seconds = Number.isFinite(sample) && Number.isFinite(sampleRate) && sampleRate > 0
    ? Math.max(0, Math.floor(sample / sampleRate))
    : 0;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}
