import type { ContextInspectorValue, ConversationValue } from '../../../../shared/protocol.ts';
import { reasoningLabel, resolveModel } from '../config/modelSelection.ts';
import { useComposerStore } from '../store.ts';
import { ContextArtifactButton } from './ContextArtifactButton.tsx';

export function ComposerInlineStatus({
  conversation,
  contextInspector,
}: {
  conversation: ConversationValue | null;
  contextInspector: ContextInspectorValue | null;
}) {
  const configuredModel = useComposerStore((state) => state.modelId);
  const models = useComposerStore((state) => state.models);
  const configuredReasoning = useComposerStore((state) => state.reasoning);
  const modelId = conversation?.modelId ?? configuredModel;
  const reasoning = conversation?.reasoning ?? configuredReasoning;
  const model = resolveModel(models, modelId);

  return (
    <div className="remux-composer-inline-status" data-remux-no-composer-focus>
      <div className="remux-composer-status-group">
        <span className="truncate">{model?.name ?? (modelId || 'Loading models')}</span>
        <span className="remux-composer-status-separator" aria-hidden="true">/</span>
        <span className="truncate">{reasoningLabel(reasoning)} reasoning</span>
      </div>
      {conversation ? (
        <div className="remux-composer-status-actions">
          {contextInspector ? <ContextInspector value={contextInspector} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function ContextInspector({ value }: { value: ContextInspectorValue }) {
  const tokens = (kind: ContextInspectorValue['layers'][number]['kind']) =>
    value.layers.find((layer) => layer.kind === kind)?.estimatedTokens ?? 0;
  return (
    <details className="agent-context-inspector" data-testid="context-inspector">
      <summary>
        dialogue {formatTokens(tokens('selected_dialogue'))} · full {formatTokens(tokens('selected_full_turns'))} · active {formatTokens(tokens('active_scope'))} · {value.scopeKind === 'work_unit' ? 'work unit' : 'turn'}
      </summary>
      <section className="agent-context-inspector-panel" aria-label="Inference context inspector">
        <header>
          <strong>Actual inference context</strong>
          <span>{value.buildDurationMs} ms</span>
        </header>
        <section className="agent-context-inspector-section">
          <div className="agent-context-inspector-heading">
            <strong>Selected turn context</strong>
            <span>{value.transportMode} transport</span>
          </div>
          <div className="agent-context-inspector-metrics">
            <span>{formatTokens(value.estimatedInputTokens)} estimated</span>
            <span>{value.messageCount} messages / {value.turnCount} turns</span>
            <span>latest {value.requestedPlan.automaticDialogueTurns} dialogue</span>
            <span>{value.requestedPlan.overrides.length} explicit override{value.requestedPlan.overrides.length === 1 ? '' : 's'}</span>
          </div>
          <ContextArtifactButton
            artifact={value.manifestArtifact}
            label="Open selection manifest"
            title="Durable inference context manifest"
          />
        </section>
        <div className="agent-context-inspector-blocks">
          {value.layers.map((layer) => (
            <div key={`${layer.kind}:${layer.hash}`} title={layer.sources.join('\n')}>
              <span>{layerLabel(layer.kind)}</span>
              <span>{formatTokens(layer.estimatedTokens)}</span>
              <span>{layer.sourceCount} source{layer.sourceCount === 1 ? '' : 's'}</span>
            </div>
          ))}
        </div>
        <section className="agent-context-inspector-section">
          <div className="agent-context-inspector-heading">
            <strong>Selected prior turns</strong>
            <span>{value.selectedTurns.length} included</span>
          </div>
          <div className="agent-context-actual-groups">
            <div>
              <span>system + tool contracts</span>
              <code>{shortHash(value.fixedContractsHash)}</code>
            </div>
            {value.selectedTurns.map((selection) => {
              const group = value.groups.find(({ turnId }) => turnId === selection.turnId);
              return (
                <div key={selection.turnId} title={group?.source}>
                  <span>{selection.resolution} · turn {shortHash(selection.turnId)}</span>
                  <span>{selection.origin} · {formatTokens(selection.estimatedTokens)}</span>
                </div>
              );
            })}
          </div>
          <ContextArtifactButton
            artifact={value.dispatchArtifact}
            label="Open captured request context"
            title="Captured harness-visible request context"
          />
        </section>
        <section className="agent-context-inspector-section">
          <div className="agent-context-inspector-heading">
            <strong>Disposition</strong>
            <span>{value.omissions.length ? 'retrievable omissions' : 'no omissions'}</span>
          </div>
          {value.omissions.length ? (
            <div className="agent-context-omissions">
              {value.omissions.map((omission) => (
                <div key={`${omission.source}:${omission.reason}`}>
                  <span>{omission.count} × {omission.reason}</span>
                  <code title={omission.retrieval}>{compactSource(omission.retrieval)}</code>
                </div>
              ))}
            </div>
          ) : <p>No completed-turn material was omitted from this frame.</p>}
        </section>
        <footer>
          <span>frame <code>{shortHash(value.frameId)}</code> · basis {value.basisSequence}</span>
          <span>manifest <code>{shortHash(value.manifestArtifact.hash)}</code></span>
        </footer>
      </section>
    </details>
  );
}

function formatTokens(value: number) {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

function shortHash(value: string) {
  return value.slice(0, 10);
}

function compactSource(source: string) {
  return source.length > 38 ? `…${source.slice(-37)}` : source;
}

function layerLabel(kind: ContextInspectorValue['layers'][number]['kind']) {
  switch (kind) {
    case 'selected_dialogue':
      return 'dialogue turns';
    case 'selected_full_turns':
      return 'full turns';
    case 'active_scope':
      return 'current work';
  }
}
