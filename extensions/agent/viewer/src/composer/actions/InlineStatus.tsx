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
      {contextInspector ? <ContextInspector value={contextInspector} /> : null}
    </div>
  );
}

function ContextInspector({ value }: { value: ContextInspectorValue }) {
  const stateful = value.actual?.mode === 'stateful-frame';
  return (
    <details className="agent-context-inspector" data-testid="context-inspector">
      <summary>
        {stateful ? 'frame' : 'history'} {formatTokens(value.activeEstimatedInputTokens)} · next frame {formatTokens(value.candidateEstimatedInputTokens)} · {decisionLabel(value.decision.kind)}
      </summary>
      <section className="agent-context-inspector-panel" aria-label="Inference context inspector">
        <header>
          <strong>Inference context</strong>
          <span>{value.buildDurationMs} ms</span>
        </header>
        <ContextActual value={value} />
        <section className="agent-context-inspector-section">
          <div className="agent-context-inspector-heading">
            <strong>Compiled context frame</strong>
            <span>{stateful ? 'authoritative on rollover' : 'diagnostic control'}</span>
          </div>
          <div className="agent-context-inspector-metrics">
            <span>{formatTokens(value.candidateEstimatedInputTokens)} estimated</span>
            <span>{decisionLabel(value.decision.kind)}</span>
          </div>
          <ContextArtifactButton
            artifact={value.bootstrapArtifact}
            label="Open exact candidate bootstrap"
            title="Exact context-frame bootstrap"
          />
        </section>
        {'reason' in value.decision ? <p>{value.decision.reason}</p> : null}
        <div className="agent-context-inspector-blocks">
          {value.blocks.map((block) => (
            <div key={`${block.kind}:${block.hash}`} title={block.sources.join('\n')}>
              <span>{block.kind}</span>
              <span>{formatTokens(block.estimatedTokens)}</span>
              <span>{block.sourceCount} source{block.sourceCount === 1 ? '' : 's'}</span>
            </div>
          ))}
        </div>
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
          ) : <p>Everything selected by the candidate policy is represented.</p>}
        </section>
        <footer>
          <span>inference <code>{shortHash(value.inferenceId)}</code> · basis {value.basisSequence}</span>
          <span>manifest <code>{shortHash(value.manifestArtifact.hash)}</code></span>
        </footer>
      </section>
    </details>
  );
}

function ContextActual({ value }: { value: ContextInspectorValue }) {
  const actual = value.actual;
  return (
    <section className="agent-context-inspector-section">
      <div className="agent-context-inspector-heading">
        <strong>Actual last request</strong>
        <span>{actual ? `${actual.transportMode} transport` : 'legacy snapshot'}</span>
      </div>
      <div className="agent-context-inspector-metrics">
        <span>{actual?.mode === 'stateful-frame' ? `stateful frame ${actual.frameOrdinal ?? 0}` : 'full history'} · {formatTokens(value.activeEstimatedInputTokens)} estimated</span>
        <span>{actual ? `${actual.messageCount} messages / ${actual.turnCount} turns` : 'dispatch not captured'}</span>
      </div>
      {actual ? (
        <>
          <div className="agent-context-actual-groups">
            <div>
              <span>system + tool contracts</span>
              <code>{shortHash(actual.fixedContractsHash)}</code>
            </div>
            {actual.groups.map((group) => (
              <div key={group.turnId} title={group.source}>
                <span>turn {shortHash(group.turnId)}</span>
                <span>{formatRoles(group.roles)} · {formatTokens(group.estimatedTokens)}</span>
              </div>
            ))}
          </div>
          {actual.groupsTruncated ? <p>Showing the newest 64 durable turns.</p> : null}
          <ContextArtifactButton
            artifact={actual.dispatchArtifact}
            label="Open captured request context"
            title="Captured harness-visible request context"
          />
        </>
      ) : <p>Send another message to capture the exact provider dispatch with the v2 inspector.</p>}
    </section>
  );
}

function formatTokens(value: number) {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

function shortHash(value: string) {
  return value.slice(0, 10);
}

function formatRoles(roles: { user: number; assistant: number; tool: number }) {
  return [
    roles.user ? `${roles.user} user` : '',
    roles.assistant ? `${roles.assistant} assistant` : '',
    roles.tool ? `${roles.tool} tool` : '',
  ].filter(Boolean).join(' · ');
}

function compactSource(source: string) {
  return source.length > 38 ? `…${source.slice(-37)}` : source;
}

function decisionLabel(kind: ContextInspectorValue['decision']['kind']) {
  return kind === 'append' ? 'continue' : kind === 'block' ? 'blocked' : 'roll';
}
