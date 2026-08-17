import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Boxes, Check, ChevronDown, Layers3, LogOut, Play, RefreshCw, Sparkles, Wrench } from 'lucide-react';
import { reloadHostView } from '@remux/viewer-kit/host';

import { reasoningLabel, resolveModel } from './modelSelection.ts';
import { useComposerStore } from '../store.ts';

type ConfigSection = 'model' | 'reasoning';

export function ComposerConfigButton({
  contextOpen,
  disabled = false,
  modelLocked = false,
  onToggleContext,
  onSignOut,
}: {
  contextOpen: boolean;
  disabled?: boolean;
  modelLocked?: boolean;
  onToggleContext: () => void;
  onSignOut: () => void;
}) {
  const modelId = useComposerStore((state) => state.modelId);
  const models = useComposerStore((state) => state.models);
  const reasoning = useComposerStore((state) => state.reasoning);
  const setModelId = useComposerStore((state) => state.setModelId);
  const setReasoning = useComposerStore((state) => state.setReasoning);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ConfigSection | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedModel = resolveModel(models, modelId);

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
          <ConfigAction
            icon={<LogOut className="size-4" />}
            label="Sign out"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          />
          <ConfigAction
            active={contextOpen}
            disabled={!modelLocked}
            icon={<Layers3 className="size-4" />}
            label="Turn context"
            onClick={() => {
              setOpen(false);
              onToggleContext();
            }}
          />
          {models?.models.length ? (
            <ConfigRow
              disabled={modelLocked}
              expanded={expanded === 'model'}
              icon={<Boxes className="size-4" />}
              label={selectedModel?.name ?? modelId}
              onToggle={() => setExpanded((value) => value === 'model' ? null : 'model')}
            >
              <ConfigOptions
                onSelect={(value) => {
                  setModelId(value);
                  setExpanded(null);
                }}
                options={models.models.map((model) => ({ label: model.name, value: model.id }))}
                value={modelId}
              />
            </ConfigRow>
          ) : null}
          {selectedModel ? (
            <ConfigRow
              expanded={expanded === 'reasoning'}
              icon={<Sparkles className="size-4" />}
              label={reasoningLabel(reasoning)}
              onToggle={() => setExpanded((value) => value === 'reasoning' ? null : 'reasoning')}
            >
              <ConfigOptions
                onSelect={(value) => {
                  setReasoning(value);
                  setExpanded(null);
                }}
                options={selectedModel.supportedReasoning.map((value) => ({ label: reasoningLabel(value), value }))}
                value={reasoning}
              />
            </ConfigRow>
          ) : null}
          {modelLocked ? <div className="remux-composer-config-note">Model is fixed for this chat.</div> : null}
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
  options: Array<{ label: string; value: Value }>;
  value: Value;
}) {
  return (
    <div className="remux-composer-config-option-list">
      {options.map((option) => (
        <button className="remux-composer-config-option" key={option.value} onClick={() => onSelect(option.value)} type="button">
          <span className="remux-composer-config-option-text"><span className="remux-composer-config-option-label">{option.label}</span></span>
          {option.value === value ? <Check className="remux-composer-config-check" /> : <span className="remux-composer-config-check" />}
        </button>
      ))}
    </div>
  );
}
