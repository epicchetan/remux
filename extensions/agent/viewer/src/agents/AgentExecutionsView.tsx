import { useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Loader2,
  RotateCcw,
  Square,
} from 'lucide-react';

import type {
  AgentExecutionResource,
  AgentProvidersResource,
} from '../../../shared/native-agent-protocol.ts';
import { agentCommands } from '../ipc/agentCommands.ts';
import { nativeExecutionScopeId } from '../nativeTranscriptViewModel.ts';
import { ExecutionScopeContent } from '../transcript/components/work/ExecutionScope.tsx';
import type { AgentExecutionTree } from './useAgentExecutions.ts';

export function AgentExecutionsView({
  conversationId,
  error,
  executions,
  loading,
  onClose,
  onRefresh,
  onSelect,
  providers,
  selectedExecutionId,
}: AgentExecutionTree & {
  conversationId: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onSelect: (executionId: string | null) => void;
  providers: AgentProvidersResource | null;
  selectedExecutionId: string | null;
}) {
  const selected = executions.find(({ executionId }) => executionId === selectedExecutionId) ?? null;
  if (selected) {
    return (
      <AgentExecutionDetail
        conversationId={conversationId}
        execution={selected}
        onBack={() => onSelect(null)}
        onRefresh={onRefresh}
        providers={providers}
      />
    );
  }

  return (
    <section className="agent-executions-view" data-remux-no-composer-focus>
      <header className="agent-executions-header">
        <button aria-label="Back to chat" className="agent-executions-back" onClick={onClose} type="button">
          <ArrowLeft className="size-4" />
        </button>
        <div>
          <h1>Agents</h1>
          <p>{executions.length === 1 ? '1 subagent' : `${executions.length} subagents`}</p>
        </div>
      </header>
      <div className="agent-executions-list">
        {executions.map((execution) => (
          <button
            className="agent-execution-row"
            key={execution.executionId}
            onClick={() => onSelect(execution.executionId)}
            type="button"
          >
            <ExecutionStateIcon execution={execution} />
            <span className="agent-execution-row-copy">
              <span className="agent-execution-row-title">{execution.title ?? 'Subagent'}</span>
              <span className="agent-execution-row-summary">
                {execution.summary ?? executionMeta(execution)}
              </span>
              <span className="agent-execution-row-meta">
                {executionMeta(execution)} · {formatElapsed(execution.startedAt, execution.completedAt)}
              </span>
            </span>
            <ChevronRight className="agent-execution-row-chevron size-4" />
          </button>
        ))}
        {executions.length === 0 && !loading ? (
          <div className="agent-executions-empty">
            <Bot className="size-5" />
            <p>No subagents have been started in this conversation.</p>
          </div>
        ) : null}
        {loading ? (
          <div className="agent-executions-loading"><Loader2 className="size-4 animate-spin" /> Loading agents…</div>
        ) : null}
        {error ? (
          <div className="agent-executions-error" role="alert">
            <span>{error}</span>
            <button onClick={() => void onRefresh()} type="button"><RotateCcw className="size-3.5" /> Retry</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AgentExecutionDetail({
  conversationId,
  execution,
  onBack,
  onRefresh,
  providers,
}: {
  conversationId: string;
  execution: AgentExecutionResource;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  providers: AgentProvidersResource | null;
}) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const [laneWidth, setLaneWidth] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = execution.state === 'running' || execution.state === 'recovering';
  const canInterrupt = running && providers?.providers.some((provider) =>
    provider.providerInstanceId === execution.providerInstanceId &&
    provider.capabilities?.collaboration.childInterrupt === true) === true;

  useLayoutEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const publish = () => setLaneWidth(lane.getBoundingClientRect().width);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(lane);
    return () => observer.disconnect();
  }, []);

  const stop = async () => {
    setStopping(true);
    setError(null);
    try {
      await agentCommands.interruptExecution(conversationId, execution.executionId);
      await onRefresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setStopping(false);
    }
  };

  return (
    <section className="agent-executions-view" data-remux-no-composer-focus>
      <header className="agent-executions-header agent-execution-detail-header">
        <button aria-label="Back to agents" className="agent-executions-back" onClick={onBack} type="button">
          <ArrowLeft className="size-4" />
        </button>
        <div className="agent-execution-detail-heading">
          <h1>{execution.title ?? 'Subagent'}</h1>
          <p>{executionMeta(execution)} · {stateLabel(execution.state)}</p>
        </div>
        {canInterrupt ? (
          <button
            className="agent-execution-stop"
            disabled={stopping}
            onClick={() => void stop()}
            type="button"
          >
            {stopping ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5 fill-current" />}
            {stopping ? 'Stopping' : 'Stop'}
          </button>
        ) : null}
      </header>
      <div className="agent-execution-detail-scroll">
        <div className="agent-execution-detail-lane" ref={laneRef}>
          {execution.summary ? (
            <section className="agent-execution-assignment">
              <span>Latest update</span>
              <p>{execution.summary}</p>
            </section>
          ) : null}
          {execution.transcriptAvailable && execution.rootTurnId && laneWidth > 0 ? (
            <ExecutionScopeContent
              conversationId={conversationId}
              isRunning={running}
              laneWidth={laneWidth}
              scopeId={nativeExecutionScopeId(execution.executionId)}
              turnId={execution.rootTurnId}
              workKey={`agent:${execution.executionId}`}
            />
          ) : (
            <div className="agent-execution-transcript-unavailable">
              <Bot className="size-5" />
              <p>{execution.summary
                ? 'This provider exposes subagent progress and results, but not its full internal transcript.'
                : 'This provider has not exposed a transcript for this subagent.'}</p>
            </div>
          )}
          {error ? <div className="agent-executions-error" role="alert">{error}</div> : null}
        </div>
      </div>
    </section>
  );
}

function ExecutionStateIcon({ execution }: { execution: AgentExecutionResource }) {
  if (execution.state === 'running' || execution.state === 'recovering') {
    return <Loader2 className="agent-execution-state is-running size-4 animate-spin" />;
  }
  if (execution.state === 'idle') {
    return <CheckCircle2 className="agent-execution-state is-complete size-4" />;
  }
  return <CircleDot className="agent-execution-state is-terminal size-4" />;
}

function executionMeta(execution: AgentExecutionResource) {
  const provider = execution.provider === 'claude-code' ? 'Claude' : 'Codex';
  return [provider, execution.model].filter(Boolean).join(' · ');
}

function stateLabel(state: AgentExecutionResource['state']) {
  if (state === 'running') return 'Working';
  if (state === 'recovering') return 'Reconnecting';
  return state[0]!.toUpperCase() + state.slice(1);
}

function formatElapsed(startedAt: number, completedAt?: number) {
  const seconds = Math.max(0, Math.round(((completedAt ?? Date.now()) - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
