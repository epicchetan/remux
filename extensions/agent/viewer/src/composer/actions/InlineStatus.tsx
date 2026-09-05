import type { AgentProvidersResource, AgentRuntimeResource } from '../../../../shared/native-agent-protocol.ts';
import { reasoningLabel, resolveModel } from '../config/modelSelection.ts';
import { useComposerStore } from '../store.ts';
import { compactTokenCount } from '../usage/UsageTray.tsx';

export function ComposerInlineStatus({ expanded, onToggle, providers, runtime }: {
  expanded: boolean;
  onToggle: () => void;
  providers: AgentProvidersResource | null;
  runtime: AgentRuntimeResource | null;
}) {
  const configuredModel = useComposerStore((state) => state.modelId);
  const models = useComposerStore((state) => state.models);
  const configuredReasoning = useComposerStore((state) => state.reasoning);
  const model = resolveModel(models, configuredModel);
  const providerInstanceId = runtime?.providerInstanceId ?? model?.providerInstanceId;
  const provider = providers?.providers.find(({ providerInstanceId: id }) => id === providerInstanceId);
  const context = runtime?.usage.context;
  const canInspect = Boolean(context || (provider?.capabilities?.usage.plan !== 'none'));
  const contextTone = context && context.percent >= 90
    ? ' is-critical'
    : context && context.percent >= 75 ? ' is-warning' : '';

  return (
    <button
      aria-expanded={expanded}
      aria-label={expanded ? 'Hide usage details' : 'Show usage details'}
      className="remux-composer-inline-status"
      data-remux-no-composer-focus
      data-remux-usage-surface
      disabled={!canInspect}
      onClick={onToggle}
      type="button"
    >
      <div className="remux-composer-status-group">
        {provider ? (
          <span className={`remux-composer-provider-mark is-${provider.provider}`} title={provider.label}>
            {providerMark(provider.provider)}
          </span>
        ) : null}
        <span className="truncate">{model?.name ?? (configuredModel || 'Loading models')}</span>
        {configuredReasoning !== null ? <>
          <span className="remux-composer-status-separator" aria-hidden="true">/</span>
          <span className="truncate">{reasoningLabel(configuredReasoning)} reasoning</span>
        </> : null}
      </div>
      {context ? (
        <span className="remux-composer-status-group remux-composer-status-group-right">
          <span
            className={`remux-composer-context-percent${contextTone}`}
            title={`${context.usedTokens.toLocaleString()} of ${context.windowTokens.toLocaleString()} context tokens`}
          >
            {Math.round(context.percent)}% context
          </span>
          <span className="remux-composer-status-separator" aria-hidden="true">/</span>
          <span>{compactTokenCount(context.usedTokens)} tokens</span>
        </span>
      ) : canInspect ? (
        <span className="remux-composer-status-group remux-composer-status-group-right">Usage</span>
      ) : null}
    </button>
  );
}

function providerMark(provider: AgentProvidersResource['providers'][number]['provider']) {
  if (provider === 'claude-code') return 'C';
  if (provider === 'codex') return 'O';
  return 'A';
}
