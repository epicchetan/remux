import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Archive, Boxes, Check, ChevronDown, Gauge, Loader2, Play, RefreshCw, Shield, Sparkles, Wrench } from 'lucide-react';

import { applyCodexResourceInvalidations } from '../../ipc/resourceInvalidations';
import { compactThread } from '../../ipc/threadCommands';
import { reloadHostView } from '@remux/viewer-kit/host';
import { useThreadsStore } from '../../threads/store';
import { useComposerStore } from '../store';
import type { CodexModelOption, ComposerIntelligence, ComposerReviewMode, ComposerSpeed } from './types';

type ConfigSection = 'model' | 'intelligence' | 'speed' | 'review';

const defaultIntelligenceOptions: Array<{ label: string; value: ComposerIntelligence }> = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Extra High', value: 'xhigh' },
];

const intelligenceLabels: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

const speedOptions: Array<{ detail: string; label: string; value: ComposerSpeed }> = [
  { detail: 'Normal usage', label: 'Default', value: 'default' },
  { detail: 'Higher priority', label: 'Fast', value: 'fast' },
];

const reviewOptions: Array<{ label: string; value: ComposerReviewMode }> = [
  { label: 'Auto-review', value: 'auto-review' },
  { label: 'Default', value: 'default' },
  { label: 'Full access', value: 'full-access' },
];

export function ComposerConfigButton({ disabled = false }: { disabled?: boolean }) {
  const activeThreadId = useThreadsStore((state) => state.activeThreadId);
  const intelligence = useComposerStore((state) => state.intelligence);
  const model = useComposerStore((state) => state.model);
  const models = useComposerStore((state) => state.models);
  const reviewMode = useComposerStore((state) => state.reviewMode);
  const speed = useComposerStore((state) => state.speed);
  const loadModels = useComposerStore((state) => state.loadModels);
  const setIntelligence = useComposerStore((state) => state.setIntelligence);
  const setModel = useComposerStore((state) => state.setModel);
  const setReviewMode = useComposerStore((state) => state.setReviewMode);
  const setSpeed = useComposerStore((state) => state.setSpeed);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ConfigSection | null>(null);
  const [compactPending, setCompactPending] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const compactDisabled = Boolean(
    disabled ||
      compactPending ||
      !activeThreadId,
  );

  const handleReload = () => {
    setOpen(false);
    setExpanded(null);
    void reloadHostView();
  };

  const handleCompact = () => {
    if (!activeThreadId || compactDisabled) {
      return;
    }

    const threadId = activeThreadId;
    setCompactError(null);
    setExpanded(null);
    setCompactPending(true);
    void compactThread({ threadId })
      .then((response) => {
        applyCodexResourceInvalidations(response.invalidations);
        setOpen(false);
      })
      .catch((error) => {
        setCompactError(formatCompactError(error));
      })
      .finally(() => {
        setCompactPending(false);
      });
  };

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setExpanded(null);
      setCompactError(null);
    }
  }, [disabled]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (compactPending) {
        return;
      }

      const target = event.target;

      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
      setExpanded(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (compactPending) {
        return;
      }

      if (event.key === 'Escape') {
        setOpen(false);
        setExpanded(null);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [compactPending, open]);

  const panelBlocked = compactPending;
  const selectedModel = selectedModelOption(models, model);
  const selectedModelId = selectedModelIdValue(models, model);
  const intelligenceOptions = intelligenceOptionsForModel(selectedModel);

  return (
    <div className="remux-composer-config remux-composer-preferences-menu" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-label="Preferences"
        className="remux-composer-action-button"
        disabled={disabled}
        onClick={(event) => {
          event.currentTarget.blur();
          if (disabled || panelBlocked) {
            return;
          }

          setOpen((current) => {
            const next = !current;
            if (next) {
              void loadModels();
            }
            return next;
          });
          setExpanded(null);
          setCompactError(null);
        }}
        type="button"
      >
        <Wrench className="size-4" />
      </button>

      {open ? (
        <div className="remux-composer-config-panel" data-remux-composer-config-panel>
          <ConfigAction
            disabled={panelBlocked}
            icon={<RefreshCw className="size-4" />}
            label="Reload"
            onClick={handleReload}
            trailing={<Play className="remux-composer-config-chevron" />}
          />

          <ConfigAction
            disabled={compactDisabled}
            icon={compactPending ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />}
            label="Compact"
            onClick={handleCompact}
            trailing={<Play className="remux-composer-config-chevron" />}
          />

          {compactError ? (
            <div className="remux-composer-config-error" role="alert">
              {compactError}
            </div>
          ) : null}

          {models && models.length > 0 ? (
            <ConfigRow
              disabled={panelBlocked}
              expanded={expanded === 'model'}
              icon={<Boxes className="size-4" />}
              label={selectedModel?.displayName ?? model ?? selectedModelId}
              onToggle={() => setExpanded((current) => (current === 'model' ? null : 'model'))}
            >
              <ConfigOptionList
                disabled={panelBlocked}
                onSelect={(value) => {
                  setModel(value, activeThreadId);
                  setExpanded(null);
                  setCompactError(null);
                }}
                options={models.map((model) => ({
                  detail: model.description,
                  label: model.displayName,
                  value: model.id,
                }))}
                value={selectedModelId}
              />
            </ConfigRow>
          ) : null}

          <ConfigRow
            disabled={panelBlocked}
            expanded={expanded === 'intelligence'}
            icon={<Sparkles className="size-4" />}
            label={optionLabel(intelligenceOptions, intelligence)}
            onToggle={() => setExpanded((current) => (current === 'intelligence' ? null : 'intelligence'))}
          >
            <ConfigOptionList
              disabled={panelBlocked}
              onSelect={(value) => {
                setIntelligence(value, activeThreadId);
                setExpanded(null);
                setCompactError(null);
              }}
              options={intelligenceOptions}
              value={intelligence}
            />
          </ConfigRow>

          <ConfigRow
            disabled={panelBlocked}
            expanded={expanded === 'speed'}
            icon={<Gauge className="size-4" />}
            label={optionLabel(speedOptions, speed)}
            onToggle={() => setExpanded((current) => (current === 'speed' ? null : 'speed'))}
          >
            <ConfigOptionList
              disabled={panelBlocked}
              onSelect={(value) => {
                setSpeed(value, activeThreadId);
                setExpanded(null);
                setCompactError(null);
              }}
              options={speedOptions}
              value={speed}
            />
          </ConfigRow>

          <ConfigRow
            disabled={panelBlocked}
            expanded={expanded === 'review'}
            icon={<Shield className="size-4" />}
            label={optionLabel(reviewOptions, reviewMode)}
            onToggle={() => setExpanded((current) => (current === 'review' ? null : 'review'))}
          >
            <ConfigOptionList
              disabled={panelBlocked}
              onSelect={(value) => {
                setReviewMode(value, activeThreadId);
                setExpanded(null);
                setCompactError(null);
              }}
              options={reviewOptions}
              value={reviewMode}
            />
          </ConfigRow>
        </div>
      ) : null}
    </div>
  );
}

function ConfigAction({
  disabled,
  icon,
  label,
  onClick,
  trailing,
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  trailing?: ReactNode;
}) {
  return (
    <button
      className="remux-composer-config-row"
      disabled={disabled}
      onClick={(event) => {
        event.currentTarget.blur();
        onClick?.();
      }}
      type="button"
    >
      <span className="remux-composer-config-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="remux-composer-config-label">{label}</span>
      {trailing ?? null}
    </button>
  );
}

function ConfigRow({
  children,
  disabled,
  expanded,
  icon,
  label,
  onToggle,
}: {
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
        onClick={(event) => {
          event.currentTarget.blur();
          onToggle();
        }}
        type="button"
      >
        <span className="remux-composer-config-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="remux-composer-config-label">{label}</span>
        <ChevronDown className={`remux-composer-config-chevron${expanded ? ' is-open' : ''}`} />
      </button>
    </div>
  );
}

function ConfigOptionList<Value extends string>({
  disabled,
  onSelect,
  options,
  value,
}: {
  disabled?: boolean;
  onSelect: (value: Value) => void;
  options: Array<{ detail?: string; label: string; value: Value }>;
  value: Value;
}) {
  return (
    <div className="remux-composer-config-option-list">
      {options.map((option) => (
        <button
          className="remux-composer-config-option"
          disabled={disabled}
          key={option.value}
          onClick={(event) => {
            event.currentTarget.blur();
            onSelect(option.value);
          }}
          type="button"
        >
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

function selectedModelOption(models: CodexModelOption[] | null, model: string | null) {
  if (!models || models.length === 0) {
    return null;
  }

  if (model) {
    return models.find((option) => option.id === model) ?? null;
  }

  return models.find((option) => option.isDefault) ?? models[0] ?? null;
}

function selectedModelIdValue(models: CodexModelOption[] | null, model: string | null) {
  if (model) {
    return model;
  }

  return selectedModelOption(models, null)?.id ?? '';
}

function intelligenceOptionsForModel(model: CodexModelOption | null) {
  if (!model) {
    return defaultIntelligenceOptions;
  }

  return model.supportedReasoningEfforts.map((option) => ({
    detail: option.description.trim() ? option.description : undefined,
    label: intelligenceLabels[option.reasoningEffort] ?? option.reasoningEffort,
    value: option.reasoningEffort,
  }));
}

function optionLabel<Value extends string>(options: Array<{ label: string; value: Value }>, value: Value) {
  return options.find((option) => option.value === value)?.label ?? value;
}

function formatCompactError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return 'Compact failed. Try again.';
}
