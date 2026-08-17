import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Layers3, Loader2, MessageSquareText, Minus } from 'lucide-react';

import type {
  TurnContextPlan,
  TurnContextResolution,
} from '../../../../shared/protocol.ts';
import { useTranscriptResourceStore } from '../../transcript/resourceStore.ts';
import { useComposerStore } from '../store.ts';
import {
  effectiveTurnContextResolution,
  withTurnContextResolution,
} from './contextPlan.ts';

export function ComposerContextButton({ disabled }: { disabled: boolean }) {
  const contextPlan = useComposerStore((state) => state.contextPlan);
  const setContextPlan = useComposerStore((state) => state.setContextPlan);
  const turnOrder = useTranscriptResourceStore((state) => state.turnOrder);
  const turnsById = useTranscriptResourceStore((state) => state.turnResourcesById);
  const hasEarlier = useTranscriptResourceStore((state) => state.window?.hasEarlier === true);
  const loadEarlier = useTranscriptResourceStore((state) => state.loadEarlierTranscriptResources);
  const [open, setOpen] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const turns = useMemo(() => turnOrder.flatMap((turnId) => {
    const frame = turnsById[turnId]?.turn;
    if (!frame || frame.status !== 'completed') return [];
    const user = frame.segments.find((segment) => segment.type === 'userMessage');
    const assistant = [...frame.segments].reverse().find((segment) => segment.type === 'assistantMessage');
    if (!user || !assistant || user.type !== 'userMessage' || assistant.type !== 'assistantMessage') return [];
    return [{
      assistantPreview: compact(assistant.text),
      turnId,
      userPreview: compact(user.text),
    }];
  }), [turnOrder, turnsById]);
  const eligibleTurnIds = useMemo(() => turns.map(({ turnId }) => turnId), [turns]);
  const selectedCount = eligibleTurnIds.filter((turnId) =>
    effectiveTurnContextResolution(contextPlan, eligibleTurnIds, turnId) !== 'off').length;
  const fullCount = eligibleTurnIds.filter((turnId) =>
    effectiveTurnContextResolution(contextPlan, eligibleTurnIds, turnId) === 'full').length;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const select = (turnId: string, resolution: TurnContextResolution) => {
    setContextPlan(withTurnContextResolution(contextPlan, eligibleTurnIds, turnId, resolution));
  };

  return (
    <div className="remux-composer-config agent-context-picker" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-label="Choose prior turn context"
        className={`remux-composer-action-button${fullCount > 0 ? ' is-active' : ''}`}
        disabled={disabled}
        onClick={(event) => {
          event.currentTarget.blur();
          setOpen((value) => !value);
        }}
        type="button"
      >
        <Layers3 className="size-4" />
      </button>
      {open ? (
        <section className="agent-context-picker-panel" data-remux-no-composer-focus>
          <header className="agent-context-picker-header">
            <div>
              <strong>Context for next turn</strong>
              <span>{selectedCount} selected{fullCount ? ` · ${fullCount} full` : ''}</span>
            </div>
            <p>The latest two turns use dialogue by default. Full preserves the parent reasoning and tool trajectory.</p>
          </header>
          <div className="agent-context-picker-list">
            {[...turns].reverse().map((turn, reverseIndex) => {
              const resolution = effectiveTurnContextResolution(contextPlan, eligibleTurnIds, turn.turnId);
              const chronologicalIndex = turns.length - reverseIndex;
              return (
                <div className="agent-context-picker-turn" key={turn.turnId}>
                  <div className="agent-context-picker-turn-copy">
                    <span>Turn {chronologicalIndex}</span>
                    <strong title={turn.userPreview}>{turn.userPreview || 'Untitled message'}</strong>
                    {turn.assistantPreview ? <small title={turn.assistantPreview}>{turn.assistantPreview}</small> : null}
                  </div>
                  <ResolutionControl onSelect={(value) => select(turn.turnId, value)} value={resolution} />
                </div>
              );
            })}
            {!turns.length ? <p className="agent-context-picker-empty">No completed prior turns yet.</p> : null}
          </div>
          {hasEarlier ? (
            <button
              className="agent-context-picker-load"
              disabled={loadingEarlier}
              onClick={() => {
                setLoadingEarlier(true);
                void loadEarlier().finally(() => setLoadingEarlier(false));
              }}
              type="button"
            >
              {loadingEarlier ? <Loader2 className="size-3 animate-spin" /> : null}
              Load earlier turns
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ResolutionControl({ onSelect, value }: {
  onSelect: (value: TurnContextResolution) => void;
  value: TurnContextResolution;
}) {
  const options: Array<{
    icon: typeof Minus;
    label: string;
    value: TurnContextResolution;
  }> = [
    { icon: Minus, label: 'Off', value: 'off' },
    { icon: MessageSquareText, label: 'Dialogue', value: 'dialogue' },
    { icon: Brain, label: 'Full', value: 'full' },
  ];
  return (
    <div aria-label="Turn context resolution" className="agent-context-resolution" role="group">
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            aria-label={option.label}
            aria-pressed={value === option.value}
            className={value === option.value ? 'is-active' : undefined}
            key={option.value}
            onClick={() => onSelect(option.value)}
            title={option.label}
            type="button"
          >
            <Icon className="size-3" />
          </button>
        );
      })}
    </div>
  );
}

function compact(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
}
