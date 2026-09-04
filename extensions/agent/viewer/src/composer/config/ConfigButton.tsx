import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Boxes, Check, ChevronDown, LogIn, LogOut, Minimize2, Play, RefreshCw, Server, Shield, Sparkles, Wrench } from 'lucide-react';
import { reloadHostView } from '@remux/viewer-kit/host';

import type { AgentProvidersResource, AgentRuntimeResource } from '../../../../shared/native-agent-protocol.ts';
import type { ProviderAccess } from '../../../../shared/provider-runtime.ts';
import type { ReasoningLevel } from '../../../../shared/protocol.ts';
import { preferredReasoning, reasoningLabel } from './modelSelection.ts';
import { useComposerStore } from '../store.ts';

type ConfigSection = 'providers' | 'model' | 'reasoning' | 'access';

export function ComposerConfigButton({
  disabled = false,
  conversationExists,
  onAccessChange,
  onCompact,
  onPreferenceChange,
  onProviderLogin,
  onProviderLogout,
  providers,
  runtime,
}: {
  disabled?: boolean;
  conversationExists: boolean;
  onAccessChange: (access: ProviderAccess) => Promise<void>;
  onCompact: () => Promise<void>;
  onPreferenceChange: (input: {
    providerInstanceId: string;
    modelId: string;
    reasoning: ReasoningLevel;
  }) => Promise<void>;
  onProviderLogin: (providerInstanceId: string, mode: 'device-code' | 'browser') => void;
  onProviderLogout: (providerInstanceId: string) => void;
  providers: AgentProvidersResource | null;
  runtime: AgentRuntimeResource | null;
}) {
  const modelId = useComposerStore((state) => state.modelId);
  const models = useComposerStore((state) => state.models);
  const reasoning = useComposerStore((state) => state.reasoning);
  const providerInstanceId = useComposerStore((state) => state.providerInstanceId);
  const access = useComposerStore((state) => state.access);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ConfigSection | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const allModels = models?.models ?? [];
  const selectedProviderInstanceId = runtime?.providerInstanceId
    ?? (conversationExists ? '' : providerInstanceId);
  const availableModels = selectedProviderInstanceId
    ? allModels.filter((model) => model.providerInstanceId === selectedProviderInstanceId)
    : [];
  const selectedModel = availableModels.find(({ id }) => id === modelId)
    ?? availableModels.find(({ nativeId }) => nativeId === runtime?.composer.nextTurn.model)
    ?? availableModels[0];
  const modelLocked = busy || (conversationExists && (!runtime || !runtime.composer.editable.model));
  const reasoningLocked = busy || (conversationExists && (!runtime || !runtime.composer.editable.effort));
  const accessLocked = busy || (conversationExists && (!runtime || !runtime.composer.editable.access));
  const providerLocked = conversationExists || busy;
  const selectedProvider = providers?.providers.find(({ providerInstanceId: id }) =>
    id === selectedProviderInstanceId);
  const accessPresets = conversationExists
    ? runtime?.capabilities.access.presets ?? []
    : selectedProvider?.capabilities?.access.presets ?? [];
  const compacting = runtime?.compaction.operation.state === 'running';

  const selectPreference = (nextProviderInstanceId: string, nextModelId: string, nextReasoning: ReasoningLevel) => {
    setBusy(true);
    void onPreferenceChange({
      providerInstanceId: nextProviderInstanceId,
      modelId: nextModelId,
      reasoning: nextReasoning,
    }).finally(() => setBusy(false));
  };

  const selectAccess = (nextAccess: ProviderAccess) => {
    setBusy(true);
    void onAccessChange(nextAccess).finally(() => setBusy(false));
  };

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setExpanded(null);
    }
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) {
        setOpen(false);
        setExpanded(null);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setExpanded(null);
      }
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <div className="remux-composer-config remux-composer-preferences-menu" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-label="Preferences"
        className="remux-composer-action-button"
        disabled={disabled}
        onClick={(event) => {
          event.currentTarget.blur();
          setOpen((value) => !value);
          setExpanded(null);
        }}
        type="button"
      >
        <Wrench className="size-4" />
      </button>
      {open ? (
        <div className="remux-composer-config-panel" data-remux-composer-config-panel>
          <ConfigAction
            icon={<RefreshCw className="size-4" />}
            label="Reload"
            onClick={() => {
              setOpen(false);
              void reloadHostView();
            }}
          />
          {runtime?.capabilities.compaction.manualNative ? (
            <ConfigAction
              disabled={busy || compacting}
              icon={<Minimize2 className="size-4" />}
              label={compacting ? 'Compacting…' : 'Compact context'}
              onClick={() => {
                setOpen(false);
                void onCompact();
              }}
            />
          ) : null}
          {providers?.providers.length ? (
            <ConfigRow
              expanded={expanded === 'providers'}
              icon={<Server className="size-4" />}
              label="Providers"
              onToggle={() => setExpanded((value) => value === 'providers' ? null : 'providers')}
            >
              <div className="remux-composer-provider-list">
                {providers.providers.map((provider) => (
                  <ProviderStatus
                    key={provider.providerInstanceId}
                    selected={provider.providerInstanceId === selectedProviderInstanceId}
                    selectable={!providerLocked && provider.state === 'ready'}
                    onSelect={() => {
                      const providerModels = allModels.filter(({ providerInstanceId: id }) =>
                        id === provider.providerInstanceId);
                      const sticky = provider.stickyPreference
                        ? providerModels.find(({ nativeId }) => nativeId === provider.stickyPreference?.model)
                        : undefined;
                      const nextModel = sticky ?? providerModels[0];
                      if (!nextModel) return;
                      const stickyReasoning = asReasoning(provider.stickyPreference?.effort);
                      selectPreference(
                        provider.providerInstanceId,
                        nextModel.id,
                        nextModel.supportedReasoning.includes(stickyReasoning)
                          ? stickyReasoning
                          : preferredReasoning(nextModel),
                      );
                    }}
                    onAction={() => {
                      setOpen(false);
                      setExpanded(null);
                      if (provider.state === 'ready') onProviderLogout(provider.providerInstanceId);
                      else {
                        const login = provider.capabilities?.authentication.login;
                        if (!login || login === 'none') return;
                        onProviderLogin(
                          provider.providerInstanceId,
                          login,
                        );
                      }
                    }}
                    provider={provider}
                  />
                ))}
              </div>
            </ConfigRow>
          ) : null}
          {availableModels.length ? (
            <ConfigRow
              disabled={modelLocked}
              expanded={expanded === 'model'}
              icon={<Boxes className="size-4" />}
              label={selectedModel?.name ?? modelId}
              onToggle={() => setExpanded((value) => value === 'model' ? null : 'model')}
            >
              <ConfigOptions
                onSelect={(value) => {
                  const nextModel = availableModels.find(({ id }) => id === value);
                  if (!nextModel) return;
                  selectPreference(
                    selectedProviderInstanceId,
                    nextModel.id,
                    nextModel.supportedReasoning.includes(reasoning)
                      ? reasoning
                      : preferredReasoning(nextModel),
                  );
                  setExpanded(null);
                }}
                options={availableModels.map((model) => ({
                  ...(providerLabel(providers, model.providerInstanceId)
                    ? { detail: providerLabel(providers, model.providerInstanceId)! }
                    : {}),
                  label: model.name,
                  value: model.id,
                }))}
                value={modelId}
              />
            </ConfigRow>
          ) : null}
          {selectedModel ? (
            <ConfigRow
              disabled={reasoningLocked}
              expanded={expanded === 'reasoning'}
              icon={<Sparkles className="size-4" />}
              label={reasoningLabel(reasoning)}
              onToggle={() => setExpanded((value) => value === 'reasoning' ? null : 'reasoning')}
            >
              <ConfigOptions
                onSelect={(value) => {
                  if (!selectedModel) return;
                  selectPreference(selectedProviderInstanceId, selectedModel.id, value);
                  setExpanded(null);
                }}
                options={['off' as const, ...selectedModel.supportedReasoning
                  .filter((value) => value !== 'off')]
                  .map((value) => ({ label: reasoningLabel(value), value }))}
                value={reasoning}
              />
            </ConfigRow>
          ) : null}
          {accessPresets.length ? (
            <ConfigRow
              disabled={accessLocked}
              expanded={expanded === 'access'}
              icon={<Shield className="size-4" />}
              label={accessLabel(runtime?.composer.nextTurn.access ?? access)}
              onToggle={() => setExpanded((value) => value === 'access' ? null : 'access')}
            >
              <ConfigOptions
                onSelect={(value) => {
                  selectAccess(value);
                  setExpanded(null);
                }}
                options={accessPresets.map((value) => ({ label: accessLabel(value), value }))}
                value={runtime?.composer.nextTurn.access ?? access}
              />
            </ConfigRow>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConfigAction({ active = false, disabled = false, icon, label, onClick }: {
  active?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active || undefined}
      className={`remux-composer-config-row${active ? ' is-open' : ''}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="remux-composer-config-icon">{icon}</span>
      <span className="remux-composer-config-label">{label}</span>
      <Play className="remux-composer-config-chevron" />
    </button>
  );
}

function ConfigRow({ children, disabled, expanded, icon, label, onToggle }: {
  children: ReactNode;
  disabled?: boolean;
  expanded: boolean;
  icon: ReactNode;
  label: string;
  onToggle: () => void;
}) {
  return (
    <div className="remux-composer-config-section">
      {expanded ? <div className="remux-composer-config-options">{children}</div> : null}
      <button
        aria-expanded={expanded}
        className={`remux-composer-config-row${expanded ? ' is-open' : ''}`}
        disabled={disabled}
        onClick={onToggle}
        type="button"
      >
        <span className="remux-composer-config-icon">{icon}</span>
        <span className="remux-composer-config-label">{label}</span>
        <ChevronDown className={`remux-composer-config-chevron${expanded ? ' is-open' : ''}`} />
      </button>
    </div>
  );
}

function ConfigOptions<Value extends string>({ onSelect, options, value }: {
  onSelect: (value: Value) => void;
  options: Array<{ detail?: string; label: string; value: Value }>;
  value: Value;
}) {
  return (
    <div className="remux-composer-config-option-list">
      {options.map((option) => (
        <button className="remux-composer-config-option" key={option.value} onClick={() => onSelect(option.value)} type="button">
          <span className="remux-composer-config-option-text">
            <span className="remux-composer-config-option-label">{option.label}</span>
            {option.detail ? <span className="remux-composer-config-option-detail">{option.detail}</span> : null}
          </span>
          {option.value === value ? <Check className="remux-composer-config-check" /> : <span className="remux-composer-config-check" />}
        </button>
      ))}
    </div>
  );
}

function ProviderStatus({ onAction, onSelect, provider, selectable, selected }: {
  onAction: () => void;
  onSelect: () => void;
  provider: AgentProvidersResource['providers'][number];
  selectable: boolean;
  selected: boolean;
}) {
  const canLogin = provider.state !== 'ready' &&
    provider.capabilities?.authentication.login !== undefined &&
    provider.capabilities.authentication.login !== 'none';
  const canLogout = provider.state === 'ready' && provider.capabilities?.authentication.logout;
  const action = canLogin || canLogout;
  return (
    <div className="remux-composer-provider" title={provider.message}>
      <button
        aria-pressed={selected}
        className="remux-composer-provider-select"
        disabled={!selectable}
        onClick={onSelect}
        type="button"
      >
        <span className={`remux-composer-provider-dot is-${provider.state}`} aria-hidden="true" />
        <span className="remux-composer-config-option-text">
          <span className="remux-composer-config-option-label">{provider.label}</span>
          <span className="remux-composer-config-option-detail">
            {providerStateLabel(provider.state)}
            {provider.message ? ` · ${provider.message}` : ''}
          </span>
        </span>
        {selected ? <Check className="remux-composer-config-check" /> : null}
      </button>
      {action ? (
        <button
          aria-label={`${canLogout ? 'Sign out of' : 'Sign in to'} ${provider.label}`}
          className="remux-composer-provider-action"
          onClick={onAction}
          type="button"
        >
          {canLogout ? <LogOut className="size-4" /> : <LogIn className="size-4" />}
        </button>
      ) : null}
    </div>
  );
}

function asReasoning(value: string | null | undefined): ReasoningLevel {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high'
      || value === 'xhigh' || value === 'max'
    ? value
    : 'off';
}

function accessLabel(access: ProviderAccess) {
  if (access === 'read-only') return 'Read only';
  if (access === 'full-access') return 'Full access';
  return 'Workspace write';
}

function providerLabel(providers: AgentProvidersResource | null, providerInstanceId?: string) {
  return providers?.providers.find((provider) => provider.providerInstanceId === providerInstanceId)?.label
    ?? providerInstanceId;
}

function providerStateLabel(state: AgentProvidersResource['providers'][number]['state']) {
  switch (state) {
    case 'ready': return 'Ready';
    case 'signed-out': return 'Signed out';
    case 'missing': return 'Not installed';
    case 'incompatible': return 'Incompatible';
    case 'error': return 'Unavailable';
  }
}
