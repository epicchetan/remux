import { useMemo, useState } from 'react';
import { Brain, Loader2, MessageSquareText, Minus, RotateCcw, X } from 'lucide-react';

import type {
  TurnContextResolution,
} from '../../../../shared/protocol.ts';
import { useTranscriptResourceStore } from '../../transcript/resourceStore.ts';
import { useComposerStore } from '../store.ts';
import {
  createDefaultTurnContextPlan,
  effectiveTurnContextResolution,
  withTurnContextResolution,
} from './contextPlan.ts';

export function ComposerContextTray({ onClose }: { onClose: () => void }) {
  const contextPlan = useComposerStore((state) => state.contextPlan);
  const preserveContextPlan = useComposerStore((state) => state.preserveContextPlan);
  const setContextPlan = useComposerStore((state) => state.setContextPlan);
  const setPreserveContextPlan = useComposerStore((state) => state.setPreserveContextPlan);
  const turnOrder = useTranscriptResourceStore((state) => state.turnOrder);
  const turnsById = useTranscriptResourceStore((state) => state.turnResourcesById);
  const windowStartIndex = useTranscriptResourceStore((state) => state.window?.startIndex ?? 0);
  const hasEarlier = useTranscriptResourceStore((state) => state.window?.hasEarlier === true);
  const loadEarlier = useTranscriptResourceStore((state) => state.loadEarlierTranscriptResources);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const turns = useMemo(() => turnOrder.flatMap((turnId, index) => {
    const frame = turnsById[turnId]?.turn;
    if (!frame || frame.status !== 'completed') return [];
    const user = frame.segments.find((segment) => segment.type === 'userMessage');
    const assistant = [...frame.segments].reverse().find((segment) => segment.type === 'assistantMessage');
    if (!user || !assistant || user.type !== 'userMessage' || assistant.type !== 'assistantMessage') return [];
    return [{
      assistantPreview: compact(assistant.text),
      ordinal: windowStartIndex + index + 1,
      turnId,
      userPreview: compact(user.text),
    }];
  }), [turnOrder, turnsById, windowStartIndex]);
  const eligibleTurnIds = useMemo(() => turns.map(({ turnId }) => turnId), [turns]);
  const recentTurns = useMemo(() => [...turns].reverse(), [turns]);
  const selectedCount = eligibleTurnIds.filter((turnId) =>
    effectiveTurnContextResolution(contextPlan, eligibleTurnIds, turnId) !== 'off').length;
  const fullCount = eligibleTurnIds.filter((turnId) =>
    effectiveTurnContextResolution(contextPlan, eligibleTurnIds, turnId) === 'full').length;

  const select = (turnId: string, resolution: TurnContextResolution) => {
    setContextPlan(withTurnContextResolution(contextPlan, eligibleTurnIds, turnId, resolution));
  };

  return (
    <section
      aria-label="Turn context settings"
      className="agent-context-tray"
      data-remux-no-composer-focus
    >
      <header className="agent-context-tray-header">
        <div className="agent-context-tray-heading">
          <strong>Turn context</strong>
          <span>{selectedCount} included{fullCount ? ` · ${fullCount} full` : ''}</span>
        </div>
        <div className="agent-context-retention">
          <span>Keep after send</span>
          <button
            aria-checked={preserveContextPlan}
            aria-label="Keep context choices after sending"
            className="agent-context-retention-switch"
            onClick={() => setPreserveContextPlan(!preserveContextPlan)}
            role="switch"
            type="button"
          >
            <span />
          </button>
        </div>
        <button
          aria-label="Reset context choices"
          className="agent-context-tray-button"
          onClick={() => setContextPlan(createDefaultTurnContextPlan())}
          title="Reset context choices"
          type="button"
        >
          <RotateCcw className="size-4" />
        </button>
        <button
          aria-label="Close turn context settings"
          className="agent-context-tray-button"
          onClick={onClose}
          type="button"
        >
          <X className="size-4" />
        </button>
      </header>
      <div aria-label="Recent turns" className="agent-context-picker-list">
        {recentTurns.map((turn) => {
          const resolution = effectiveTurnContextResolution(contextPlan, eligibleTurnIds, turn.turnId);
          return (
            <div className="agent-context-picker-turn" data-turn-id={turn.turnId} key={turn.turnId}>
              <div className="agent-context-picker-turn-copy">
                <span>Turn {turn.ordinal}</span>
                <strong title={turn.userPreview}>{turn.userPreview || 'Untitled message'}</strong>
                {turn.assistantPreview ? <small title={turn.assistantPreview}>{turn.assistantPreview}</small> : null}
              </div>
              <ResolutionControl onSelect={(value) => select(turn.turnId, value)} value={resolution} />
            </div>
          );
        })}
        {!turns.length ? <p className="agent-context-picker-empty">No completed prior turns yet.</p> : null}
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
      </div>
    </section>
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
