import { useState, type CSSProperties } from 'react';
import { Loader2, Minimize2 } from 'lucide-react';

import type {
  AgentProvidersResource,
  AgentRuntimeResource,
} from '../../../../shared/native-agent-protocol.ts';
import type { AccountUsageWindow } from '../../../../shared/provider-runtime.ts';
import { useComposerStore } from '../store.ts';
import { visibleAccountUsageWindows } from './usageWindows.ts';

export function ComposerUsageTray({ onCompact, providers, runtime }: {
  onCompact: () => Promise<void>;
  providers: AgentProvidersResource | null;
  runtime: AgentRuntimeResource | null;
}) {
  const configuredProviderInstanceId = useComposerStore((state) => state.providerInstanceId);
  const providerInstanceId = runtime?.providerInstanceId ?? configuredProviderInstanceId;
  const provider = providers?.providers.find(({ providerInstanceId: id }) => id === providerInstanceId);
  const context = runtime?.usage.context ?? null;
  const plan = provider?.accountUsage ?? null;
  const planWindows = visibleAccountUsageWindows(provider?.provider, plan?.windows ?? []);
  const compacting = runtime?.compaction.operation.state === 'running';
  const canCompact = runtime?.capabilities.compaction.manualNative === true;
  const [compactPending, setCompactPending] = useState(false);

  const compact = () => {
    setCompactPending(true);
    void onCompact().finally(() => setCompactPending(false));
  };

  return (
    <section
      aria-label="Usage details"
      className="remux-composer-usage-tray"
      data-remux-no-composer-focus
      data-remux-usage-surface
    >
      <div className="remux-composer-usage-section">
        <div className="remux-composer-usage-heading">
          <span>Context</span>
          {context ? (
            <span className={usageTone(context.percent)}>
              {formatTokenCount(context.usedTokens)} / {formatTokenCount(context.windowTokens)} · {Math.round(context.percent)}%
            </span>
          ) : <span>Not reported yet</span>}
        </div>
        {context ? (
          <UsageMeter label="Context window used" percent={context.percent} />
        ) : null}
        <div className="remux-composer-usage-footer">
          <span>{context?.freshness === 'cached' ? 'Restored from the latest native snapshot' : ''}</span>
          {canCompact ? (
            <button
              className="remux-composer-usage-compact"
              disabled={compactPending || compacting}
              onClick={compact}
              type="button"
            >
              {compactPending || compacting
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Minimize2 className="size-3.5" />}
              {compactPending || compacting ? 'Compacting…' : 'Compact'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="remux-composer-usage-section">
        <div className="remux-composer-usage-heading">
          <span>Subscription</span>
          <span>{provider?.label ?? 'Provider unavailable'}</span>
        </div>
        {plan?.availability === 'available' && planWindows.length > 0 ? (
          <div className="remux-composer-plan-windows">
            {planWindows.map((window) => <PlanWindow key={window.id} window={window} />)}
          </div>
        ) : (
          <div className="remux-composer-usage-empty">
            {plan?.availability === 'not-applicable'
              ? 'Subscription limits are unavailable for this provider.'
              : 'Usage has not been reported yet.'}
          </div>
        )}
        {plan?.availability === 'available' ? (
          <div className="remux-composer-usage-source">
            {plan.freshness === 'cached' ? 'Cached usage' : 'Live usage'} · updated {formatObservedAt(plan.observedAt)}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PlanWindow({ window }: { window: AccountUsageWindow }) {
  const label = window.model ? `${window.model} · ${window.label}` : window.label;
  return (
    <div className="remux-composer-plan-window">
      <div className="remux-composer-plan-labels">
        <span>{label}</span>
        <span className={usageTone(window.usedPercent)}>{Math.round(window.usedPercent)}% used</span>
      </div>
      <UsageMeter label={`${label} used`} percent={window.usedPercent} />
      <div className="remux-composer-plan-reset">
        {window.resetsAt === null ? 'Reset time unavailable' : `Resets ${formatResetAt(window.resetsAt)}`}
      </div>
    </div>
  );
}

function UsageMeter({ label, percent }: { label: string; percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(clamped)}
      className={`remux-composer-usage-meter${usageTone(clamped)}`}
      role="progressbar"
      style={{ '--remux-usage-percent': `${clamped}%` } as CSSProperties}
    >
      <span />
    </div>
  );
}

function usageTone(percent: number) {
  return percent >= 90 ? ' is-critical' : percent >= 75 ? ' is-warning' : '';
}

export function compactTokenCount(value: number) {
  if (value >= 1_000_000) return `${trimTrailingZero((value / 1_000_000).toFixed(1))}m`;
  if (value >= 1_000) return `${trimTrailingZero((value / 1_000).toFixed(1))}k`;
  return String(value);
}

function formatTokenCount(value: number) {
  return value.toLocaleString();
}

function trimTrailingZero(value: string) {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

function formatResetAt(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatObservedAt(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}
