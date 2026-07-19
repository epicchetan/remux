import {
  ActionButton,
  ActionMenu,
  ActionMenuItem,
} from '@remux/viewer-kit/ui';
import {
  AudioLines,
  Check,
  Gauge,
  LoaderCircle,
  LocateFixed,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react';

import type { MarkdownNarrationModel } from '../markdown/narrationModel';
import { useNarrationStore } from './client';

const rates = [0.75, 1, 1.25, 1.5, 2] as const;

type NarratableFile = {
  modifiedAtMs: number | null;
  path: string;
};

export function NarrationActions({
  bindingReady,
  file,
  model,
}: {
  bindingReady: boolean;
  file: NarratableFile | null;
  model: MarkdownNarrationModel | null;
}) {
  const artifact = useNarrationStore((state) => state.artifact);
  const cancel = useNarrationStore((state) => state.cancel);
  const close = useNarrationStore((state) => state.close);
  const currentBlockIndex = useNarrationStore((state) => state.currentBlockIndex);
  const followSuspendedByUser = useNarrationStore((state) => state.followSuspendedByUser);
  const followEnabled = useNarrationStore((state) => state.followEnabled);
  const nextBlock = useNarrationStore((state) => state.nextBlock);
  const pause = useNarrationStore((state) => state.pause);
  const phase = useNarrationStore((state) => state.phase);
  const play = useNarrationStore((state) => state.play);
  const playbackRate = useNarrationStore((state) => state.playbackRate);
  const previousBlock = useNarrationStore((state) => state.previousBlock);
  const retry = useNarrationStore((state) => state.retry);
  const setPlaybackRate = useNarrationStore((state) => state.setPlaybackRate);
  const start = useNarrationStore((state) => state.start);
  const toggleFollow = useNarrationStore((state) => state.toggleFollow);
  const blocks = artifact?.blocks ?? [];
  const hasPreviousBlock = currentBlockIndex > 0;
  const hasNextBlock = currentBlockIndex >= 0 && currentBlockIndex + 1 < blocks.length;

  const reclaimFollow = () => {
    if (followSuspendedByUser) {
      toggleFollow();
    }
  };

  if (phase === 'idle') {
    const canStart = Boolean(file && model && model.blocks.length > 0 && bindingReady);
    return (
      <ActionButton
        disabled={!canStart}
        icon={<AudioLines aria-hidden="true" />}
        label="Narrate markdown"
        onClick={() => {
          if (!file || !model || !canStart) {
            return;
          }
          void start({
            document: model.document,
            target: {
              filePath: file.path,
              modifiedAtMs: file.modifiedAtMs,
              sourceHash: model.sourceHash,
            },
          });
        }}
        tone="primary"
      />
    );
  }

  if (phase === 'preparing') {
    return (
      <>
        <ActionButton
          busy
          disabled
          icon={<LoaderCircle className="remux-narration-spin" aria-hidden="true" />}
          label="Preparing narration"
        />
        <ActionButton
          icon={<X aria-hidden="true" />}
          label="Cancel narration preparation"
          onClick={() => {
            void cancel();
          }}
        />
      </>
    );
  }

  if (phase === 'failed') {
    return (
      <>
        <ActionButton
          icon={<RotateCcw aria-hidden="true" />}
          label="Retry narration"
          onClick={() => {
            void retry();
          }}
          tone="primary"
        />
        <ActionButton
          icon={<X aria-hidden="true" />}
          label="Close narration error"
          onClick={close}
        />
      </>
    );
  }

  const buffering = phase === 'buffering';
  const playing = phase === 'playing';
  return (
    <>
      <ActionButton
        className={followEnabled ? 'remux-markdown-narration-follow-active' : undefined}
        icon={<LocateFixed aria-hidden="true" />}
        label={followEnabled ? 'Disable narration auto-scroll' : 'Enable narration auto-scroll'}
        onClick={toggleFollow}
      />
      <ActionButton
        disabled={!hasPreviousBlock}
        icon={<SkipBack aria-hidden="true" />}
        label="Previous narrated block"
        onClick={() => {
          reclaimFollow();
          void previousBlock();
        }}
      />
      <ActionButton
        busy={buffering}
        disabled={buffering || !artifact}
        icon={buffering
          ? <LoaderCircle className="remux-narration-spin" aria-hidden="true" />
          : playing
            ? <Pause className="remux-narration-filled-icon" aria-hidden="true" />
            : <Play className="remux-narration-filled-icon" aria-hidden="true" />}
        label={buffering ? 'Loading narration audio' : playing ? 'Pause narration' : 'Play narration'}
        onClick={playing
          ? pause
          : () => {
              reclaimFollow();
              void play();
            }}
        tone="primary"
      />
      <ActionButton
        disabled={!hasNextBlock}
        icon={<SkipForward aria-hidden="true" />}
        label="Next narrated block"
        onClick={() => {
          reclaimFollow();
          void nextBlock();
        }}
      />
      <ActionMenu
        align="end"
        icon={<span className="remux-narration-rate-label">{formatRate(playbackRate)}</span>}
        label={`Narration speed ${formatRate(playbackRate)}`}
      >
        {rates.map((rate) => (
          <ActionMenuItem
            icon={rate === playbackRate ? <Check /> : <Gauge />}
            key={rate}
            label={formatRate(rate)}
            onSelect={() => setPlaybackRate(rate)}
          />
        ))}
      </ActionMenu>
      <ActionButton
        icon={<X aria-hidden="true" />}
        label="Close narration"
        onClick={close}
      />
    </>
  );
}

function formatRate(rate: number) {
  return `${rate}x`;
}
