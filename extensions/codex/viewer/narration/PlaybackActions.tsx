import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, LocateFixed, Pause, Play, X } from 'lucide-react';

import { ComposerActionKey, type ComposerAction } from '../composer/actions/ActionKey';
import { useNarrationStore } from './store';

const rates = [0.75, 1, 1.25, 1.5, 2] as const;

export function NarrationPlaybackActions() {
  const close = useNarrationStore((state) => state.close);
  const currentUnitIndex = useNarrationStore((state) => state.currentUnitIndex);
  const followEnabled = useNarrationStore((state) => state.followEnabled);
  const manifest = useNarrationStore((state) => state.manifest);
  const nextBlock = useNarrationStore((state) => state.nextBlock);
  const pause = useNarrationStore((state) => state.pause);
  const phase = useNarrationStore((state) => state.phase);
  const play = useNarrationStore((state) => state.play);
  const previousBlock = useNarrationStore((state) => state.previousBlock);
  const toggleFollow = useNarrationStore((state) => state.toggleFollow);
  const units = manifest?.units ?? [];
  const playing = phase === 'playing' || phase === 'buffering';
  const currentBlockId = units[currentUnitIndex]?.blockId;
  const hasPreviousBlock = units.slice(0, Math.max(0, currentUnitIndex)).some((unit) => unit.blockId !== currentBlockId);
  const hasNextBlock = units.slice(currentUnitIndex + 1).some((unit) => unit.blockId !== currentBlockId);

  const followAction: ComposerAction = {
    className: followEnabled ? 'is-active' : undefined,
    icon: <LocateFixed className="size-4" />,
    label: followEnabled ? 'Disable narration auto-scroll' : 'Enable narration auto-scroll',
    onClick: toggleFollow,
  };
  const previousAction: ComposerAction = {
    disabled: !hasPreviousBlock,
    icon: <ArrowUp className="size-4" />,
    label: 'Previous narrated block',
    onClick: () => void previousBlock(),
  };
  const nextAction: ComposerAction = {
    disabled: !hasNextBlock,
    icon: <ArrowDown className="size-4" />,
    label: 'Next narrated block',
    onClick: () => void nextBlock(),
  };
  const playbackAction: ComposerAction = {
    icon: playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />,
    label: playing ? 'Pause narration' : 'Play narration',
    onClick: playing ? pause : () => void play(),
    tone: 'send',
  };
  const closeAction: ComposerAction = {
    icon: <X className="size-4" />,
    label: 'Close narration',
    onClick: close,
  };

  return (
    <>
      <ComposerActionKey action={followAction} />
      <ComposerActionKey action={previousAction} />
      <ComposerActionKey action={nextAction} />
      <ComposerActionKey action={playbackAction} />
      <NarrationSpeedMenu />
      <ComposerActionKey action={closeAction} />
    </>
  );
}

function NarrationSpeedMenu() {
  const [open, setOpen] = useState(false);
  const playbackRate = useNarrationStore((state) => state.playbackRate);
  const setPlaybackRate = useNarrationStore((state) => state.setPlaybackRate);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div className="remux-composer-config remux-narration-speed" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Narration speed ${formatRate(playbackRate)}`}
        className="remux-composer-action-button remux-narration-rate-button"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {formatRate(playbackRate)}
      </button>
      {open ? (
        <div className="remux-composer-config-panel remux-narration-speed-panel" role="menu">
          <div className="remux-composer-config-option-list">
            {rates.map((rate) => (
              <button
                className="remux-composer-config-option"
                key={rate}
                onClick={() => {
                  setPlaybackRate(rate);
                  setOpen(false);
                }}
                role="menuitemradio"
                type="button"
              >
                <span className="remux-composer-config-check">
                  {playbackRate === rate ? <Check className="size-3.5" /> : null}
                </span>
                <span className="remux-composer-config-option-label">{formatRate(rate)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatRate(rate: number) {
  return `${rate}×`;
}
