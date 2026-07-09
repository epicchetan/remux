import type { ThreadTokenUsage } from '../../../shared/protocol/v2/ThreadTokenUsage';
import { useThreadComposerStateStore } from '../../threads/composerStateStore';
import { useComposerStore } from '../store';
import type { ComposerIntelligence } from '../config/types';

export function ComposerInlineStatus() {
  const intelligence = useComposerStore((state) => state.intelligence);
  const speed = useComposerStore((state) => state.speed);
  const model = useThreadComposerStateStore((state) => state.effective?.model ?? null);
  const tokenUsage = useThreadComposerStateStore((state) => state.tokenUsage);
  const left = [
    modelLabel(model),
    thinkingLabel(intelligence),
    ...(speed === 'fast' ? ['Fast'] : []),
  ];
  const right = tokenUsageLabels(tokenUsage);

  return (
    <div className="remux-composer-inline-status" data-remux-no-composer-focus>
      <div className="remux-composer-status-group">
        {left.map((item, index) => (
          <StatusSegment index={index} key={item}>
            {item}
          </StatusSegment>
        ))}
      </div>
      {right.length > 0 ? (
        <div className="remux-composer-status-group remux-composer-status-group-right">
          {right.map((item, index) => (
            <StatusSegment index={index} key={item}>
              {item}
            </StatusSegment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StatusSegment({ children, index }: { children: string; index: number }) {
  return (
    <>
      {index > 0 ? <span className="remux-composer-status-separator" aria-hidden="true">/</span> : null}
      <span className="truncate">{children}</span>
    </>
  );
}

function modelLabel(model: string | null) {
  if (!model) {
    return 'GPT 5.5';
  }

  return model
    .replace(/^gpt-/i, 'GPT ')
    .replace(/^codex-/i, 'Codex ')
    .replace(/-/g, ' ');
}

function thinkingLabel(effort: ComposerIntelligence) {
  switch (effort) {
    case 'none':
      return 'No thinking';
    case 'minimal':
      return 'Minimal thinking';
    case 'low':
      return 'Low thinking';
    case 'medium':
      return 'Medium thinking';
    case 'high':
      return 'High thinking';
    case 'xhigh':
      return 'Extra high thinking';
    case 'max':
      return 'Max thinking';
    case 'ultra':
      return 'Ultra thinking';
  }
}

function tokenUsageLabels(tokenUsage: ThreadTokenUsage | null) {
  if (!tokenUsage || !tokenUsage.modelContextWindow) {
    return [];
  }

  const used = Math.max(0, tokenUsage.last.inputTokens);
  const total = Math.max(1, tokenUsage.modelContextWindow);
  const usedPercent = Math.max(0, Math.min(100, Math.round((used / total) * 100)));

  return [
    `${usedPercent}% context`,
    `${compactTokenCount(used)} tokens`,
  ];
}

function compactTokenCount(value: number) {
  if (value >= 1_000_000) {
    return `${trimTrailingZero((value / 1_000_000).toFixed(1))}m`;
  }

  if (value >= 1_000) {
    return `${trimTrailingZero((value / 1_000).toFixed(1))}k`;
  }

  return String(value);
}

function trimTrailingZero(value: string) {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}
