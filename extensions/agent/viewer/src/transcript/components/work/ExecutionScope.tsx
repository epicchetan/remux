import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FilePenLine,
  FolderOpen,
  Loader2,
  RotateCcw,
  Search,
  TerminalSquare,
  Wrench,
} from 'lucide-react';

import {
  executionScopeResourceKey,
  operationDetailResourceKey,
  type AgentExecutionScopeResource,
  type AgentInferenceTrace,
  type AgentToolCallSummary,
  type AgentWorkUnitArtifactReference,
} from '../../../../../shared/transcript.ts';
import { useTranscriptLayoutStore } from '../../layoutStore.ts';
import { useTranscriptResourceStore } from '../../resourceStore.ts';
import { ExactContent } from '../ExactContent.tsx';
import { MarkdownBlock } from '../markdown/MarkdownBlock.tsx';
import { formatWorkDuration } from './workDuration.ts';

export function ExecutionScopeContent({
  conversationId,
  laneWidth,
  scopeId,
  turnId,
  workKey,
}: {
  conversationId: string;
  laneWidth: number;
  scopeId: string;
  turnId: string;
  workKey: string;
}) {
  const key = executionScopeResourceKey(conversationId, turnId, scopeId);
  const entry = useTranscriptResourceStore((state) => state.executionScopesByKey[key]);
  const ensureScope = useTranscriptResourceStore((state) => state.ensureExecutionScope);

  useEffect(() => {
    if (!entry) void ensureScope({ scopeId, turnId });
  }, [ensureScope, entry, scopeId, turnId]);

  if ((!entry || entry.status === 'loading') && !entry?.resource) {
    return <div className="codex-work-loading"><Loader2 className="size-3.5 animate-spin" /> Loading work…</div>;
  }
  if (!entry?.resource) {
    return (
      <div className="codex-work-error" role="alert">
        <span>Work details are unavailable.</span>
        <button onClick={() => void ensureScope({ scopeId, turnId })} type="button">
          <RotateCcw className="size-3" /> Retry
        </button>
      </div>
    );
  }
  return (
    <ExecutionScopeBody
      conversationId={conversationId}
      laneWidth={laneWidth}
      turnId={turnId}
      value={entry.resource}
      workKey={workKey}
    />
  );
}

function ExecutionScopeBody({
  conversationId,
  laneWidth,
  turnId,
  value,
  workKey,
}: {
  conversationId: string;
  laneWidth: number;
  turnId: string;
  value: AgentExecutionScopeResource;
  workKey: string;
}) {
  const ensureScope = useTranscriptResourceStore((state) => state.ensureExecutionScope);
  const firstInferenceId = value.inferences[0]?.id;
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const [scopeWidth, setScopeWidth] = useState(laneWidth);

  useLayoutEffect(() => {
    const element = scopeRef.current;
    if (!element) return;

    const publish = () => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth <= 0) return;
      setScopeWidth((current) => Math.abs(current - nextWidth) <= 0.5 ? current : nextWidth);
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, [laneWidth]);

  return (
    <div
      className="agent-execution-scope"
      data-kind={value.kind}
      data-state={value.state}
      ref={scopeRef}
    >
      <div className="agent-inference-list">
        {value.inferences.map((inference) => (
          <InferenceTrace
            conversationId={conversationId}
            inference={inference}
            key={inference.id}
            laneWidth={scopeWidth}
            scopeId={value.scopeId}
            turnId={turnId}
            workKey={workKey}
          />
        ))}
      </div>
      {value.window.hasEarlier && firstInferenceId ? (
        <button
          className="agent-scope-load-earlier"
          onClick={() => void ensureScope({
            scopeId: value.scopeId,
            turnId,
            window: {
              kind: 'around',
              inferenceId: firstInferenceId,
              before: 47,
              after: 0,
            },
          })}
          type="button"
        >
          Load earlier reasoning and tools
        </button>
      ) : null}
      {value.kind === 'workUnit' ? <WorkUnitOutcome laneWidth={scopeWidth} value={value} /> : null}
      {value.inferences.length === 0 && value.state === 'running' ? (
        <p className="agent-scope-empty">Waiting for the first model response…</p>
      ) : null}
    </div>
  );
}

function InferenceTrace({
  conversationId,
  inference,
  laneWidth,
  scopeId,
  turnId,
  workKey,
}: {
  conversationId: string;
  inference: AgentInferenceTrace;
  laneWidth: number;
  scopeId: string;
  turnId: string;
  workKey: string;
}) {
  const items = inference.actionGroup
    ? actionTraceItems(scopeId, inference.actionGroup.id, inference.actionGroup.calls)
    : [];
  const childCalls = items.filter((item) => item.kind === 'scope').map((item) => item.call);
  const childKeys = childCalls.map((call) =>
    executionScopeResourceKey(conversationId, turnId, call.childScopeId!));
  const actionKeys = items.filter((item) => item.kind === 'actions').map((item) => item.key);
  const contentOrder = inferenceContentOrder(inference);
  return (
    <section className="agent-inference" data-state={inference.state}>
      {contentOrder.map((kind) => {
        if (kind === 'reasoning' && inference.reasoning) {
          return (
            <div className="agent-reasoning-block codex-work-entry codex-work-entry-block" data-state={inference.reasoning.state} key={kind}>
              <MarkdownBlock density="work" width={laneWidth}>
                {inference.reasoning.text}
              </MarkdownBlock>
              <ExactContent
                content={inference.reasoning.content}
                preview={inference.reasoning.text}
                title="reasoning"
              />
            </div>
          );
        }
        if (kind === 'commentary' && inference.commentary) {
          return (
            <div className="agent-commentary-block codex-work-entry codex-work-entry-block" data-state={inference.commentary.state} key={kind}>
              <MarkdownBlock density="work" width={laneWidth}>{inference.commentary.text}</MarkdownBlock>
              <ExactContent
                content={inference.commentary.content}
                preview={inference.commentary.text}
                title="progress update"
              />
            </div>
          );
        }
        if (kind === 'actions' && items.length) {
          return (
            <div className="agent-action-sequence" data-state={inference.actionGroup?.status} key={kind}>
              {items.map((item) => item.kind === 'scope' ? (
                <ExecutionScopeDisclosure
                  conversationId={conversationId}
                  fallbackTitle={item.call.childBoundary ?? 'Focused work unit'}
                  fallbackDurationMs={item.call.childDurationMs}
                  fallbackOperationCount={item.call.childOperationCount}
                  fallbackArtifactCount={item.call.childArtifactCount}
                  fallbackState={item.call.childState ?? item.call.status}
                  key={item.call.id}
                  laneWidth={laneWidth}
                  scopeId={item.call.childScopeId!}
                  siblingKeys={childKeys}
                  turnId={turnId}
                  workKey={workKey}
                />
              ) : (
                <ActionRun
                  calls={item.calls}
                  conversationId={conversationId}
                  disclosureKey={item.key}
                  key={item.key}
                  scopeId={scopeId}
                  siblingKeys={actionKeys}
                  turnId={turnId}
                  workKey={workKey}
                />
              ))}
            </div>
          );
        }
        return null;
      })}
    </section>
  );
}

function inferenceContentOrder(
  inference: AgentInferenceTrace,
): Array<'reasoning' | 'commentary' | 'actions'> {
  const present = {
    actions: Boolean(inference.actionGroup),
    commentary: Boolean(inference.commentary),
    reasoning: Boolean(inference.reasoning),
  };
  const order: Array<'reasoning' | 'commentary' | 'actions'> = [];
  const add = (kind: 'reasoning' | 'commentary' | 'actions') => {
    if (present[kind] && !order.includes(kind)) order.push(kind);
  };
  for (const kind of inference.contentOrder ?? []) add(kind);
  // Additive transcript fields can be absent while viewer and server reload independently.
  add('reasoning');
  add('commentary');
  add('actions');
  return order;
}

type ActionTraceItem =
  | { kind: 'actions'; key: string; calls: AgentToolCallSummary[] }
  | { kind: 'scope'; call: AgentToolCallSummary };

function actionTraceItems(
  scopeId: string,
  actionGroupId: string,
  calls: AgentToolCallSummary[],
): ActionTraceItem[] {
  const items: ActionTraceItem[] = [];
  let pending: AgentToolCallSummary[] = [];
  let runIndex = 0;
  const flush = () => {
    if (!pending.length) return;
    items.push({
      kind: 'actions',
      key: `action-run:${scopeId}:${actionGroupId}:${runIndex}`,
      calls: pending,
    });
    pending = [];
    runIndex += 1;
  };
  for (const call of calls) {
    if (call.childScopeId) {
      flush();
      items.push({ kind: 'scope', call });
      continue;
    }
    if (call.name === 'work_unit_finish') continue;
    pending.push(call);
  }
  flush();
  return items;
}

function summarizeActionRun(calls: AgentToolCallSummary[]) {
  const counts = { command: 0, edit: 0, read: 0, search: 0, context: 0, tool: 0 };
  const edited = new Set<string>();
  for (const call of calls) {
    counts[call.presentation.category] += 1;
    if (call.presentation.category === 'edit' && call.presentation.subject) {
      edited.add(fileName(call.presentation.subject));
    }
  }
  const editedNames = [...edited];
  const editedSummary = counts.edit === 1 && editedNames.length === 1
    ? `Edited ${editedNames[0]}`
    : counts.edit === 2 && editedNames.length === 2
      ? `Edited ${editedNames[0]} and ${editedNames[1]}`
      : counts.edit ? `Edited ${formatCount(counts.edit, 'file')}` : null;
  return joinSummaryParts([
    counts.command ? `Ran ${formatCount(counts.command, 'command')}` : null,
    editedSummary,
    counts.search ? `Searched ${formatCount(counts.search, 'time')}` : null,
    counts.read ? `Read ${formatCount(counts.read, 'file')}` : null,
    counts.context ? `Used ${formatCount(counts.context, 'context tool')}` : null,
    counts.tool ? `Used ${formatCount(counts.tool, 'tool')}` : null,
  ]) || 'Tool activity';
}

function actionRunIcon(calls: AgentToolCallSummary[]) {
  if (calls.some((call) => call.presentation.category === 'command')) return TerminalSquare;
  if (calls.some((call) => call.presentation.category === 'edit')) return FilePenLine;
  if (calls.some((call) => call.presentation.category === 'search')) return Search;
  if (calls.some((call) => call.presentation.category === 'read')) return FolderOpen;
  return Wrench;
}

function actionRunStatus(calls: AgentToolCallSummary[]): AgentToolCallSummary['status'] {
  if (calls.some((call) => call.status === 'running')) return 'running';
  if (calls.some((call) => call.status === 'failed')) return 'failed';
  if (calls.some((call) => call.status === 'interrupted')) return 'interrupted';
  return 'completed';
}

function formatCount(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function joinSummaryParts(parts: Array<string | null>) {
  return parts.filter(Boolean).join(' · ');
}

function fileName(path: string) {
  const segments = path.replace(/\\/gu, '/').split('/').filter(Boolean);
  return segments.at(-1) ?? path;
}

function ExecutionScopeDisclosure({
  conversationId,
  fallbackDurationMs,
  fallbackOperationCount,
  fallbackArtifactCount,
  fallbackState,
  fallbackTitle,
  laneWidth,
  scopeId,
  siblingKeys,
  turnId,
  workKey,
}: {
  conversationId: string;
  fallbackDurationMs: number | null;
  fallbackOperationCount: number;
  fallbackArtifactCount: number;
  fallbackState: AgentExecutionScopeResource['state'] | AgentToolCallSummary['status'];
  fallbackTitle: string;
  laneWidth: number;
  scopeId: string;
  siblingKeys: string[];
  turnId: string;
  workKey: string;
}) {
  const key = executionScopeResourceKey(conversationId, turnId, scopeId);
  const open = useTranscriptLayoutStore((state) =>
    state.disclosure.openWorkByKey[workKey]?.openChildByKey[key] ?? false);
  const setOnlyOpen = useTranscriptLayoutStore((state) => state.setOnlyOpenWorkChildDisclosure);
  const scope = useTranscriptResourceStore((state) => state.executionScopesByKey[key]?.resource);
  const ensureScope = useTranscriptResourceStore((state) => state.ensureExecutionScope);
  const title = scope?.boundary ?? fallbackTitle;
  const displayStatus = scope?.state ?? fallbackState;
  const durationMs = scope?.durationMs ?? fallbackDurationMs;
  const operationCount = scope
    ? scope.inferences.reduce((count, inference) =>
        count + (inference.actionGroup?.calls.filter((call) =>
          call.name !== 'work_unit_finish').length ?? 0), 0)
    : fallbackOperationCount;
  const artifactCount = scope?.artifacts.length ?? fallbackArtifactCount;

  useEffect(() => {
    if (open && !scope) void ensureScope({ scopeId, turnId });
  }, [ensureScope, open, scope, scopeId, turnId]);

  return (
    <section className="agent-work-unit" data-state={displayStatus}>
      <button
        aria-expanded={open}
        className="agent-work-unit-header"
        data-remux-no-composer-focus="true"
        onClick={() => {
          setOnlyOpen(workKey, siblingKeys, open ? null : key);
          if (!open) void ensureScope({ scopeId, turnId });
        }}
        type="button"
      >
        <span className="agent-work-unit-state"><ScopeStateIcon status={displayStatus} /></span>
        <span className="agent-work-unit-copy">
          <span className="agent-work-unit-boundary">{title}</span>
          <span className="agent-work-unit-meta">
            Work unit · {displayStatus}{durationMs === null || durationMs === undefined
              ? ''
              : ` · ${formatWorkDuration(durationMs)}`}
            {operationCount > 0
              ? ` · ${operationCount} ${operationCount === 1 ? 'call' : 'calls'}`
              : ''}
            {artifactCount > 0
              ? ` · ${artifactCount} ${artifactCount === 1 ? 'artifact' : 'artifacts'}`
              : ''}
          </span>
        </span>
        <span className="agent-work-unit-chevron">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
      </button>
      {open ? (
        <div className="agent-work-unit-content">
          <ExecutionScopeContent
            conversationId={conversationId}
            laneWidth={laneWidth}
            scopeId={scopeId}
            turnId={turnId}
            workKey={workKey}
          />
        </div>
      ) : null}
    </section>
  );
}

function ActionRun({
  calls,
  conversationId,
  disclosureKey,
  scopeId,
  siblingKeys,
  turnId,
  workKey,
}: {
  calls: AgentToolCallSummary[];
  conversationId: string;
  disclosureKey: string;
  scopeId: string;
  siblingKeys: string[];
  turnId: string;
  workKey: string;
}) {
  const open = useTranscriptLayoutStore((state) =>
    state.disclosure.openWorkByKey[workKey]?.openChildByKey[disclosureKey] ?? false);
  const setOnlyOpen = useTranscriptLayoutStore((state) => state.setOnlyOpenWorkChildDisclosure);
  const Icon = actionRunIcon(calls);
  const status = actionRunStatus(calls);
  return (
    <section className="agent-action-run" data-state={status}>
      <button
        aria-expanded={open}
        className="agent-action-run-header codex-work-row-button codex-work-summary-button"
        data-remux-no-composer-focus="true"
        data-testid={`agent-action-summary-${disclosureKey}`}
        onClick={() => setOnlyOpen(workKey, siblingKeys, open ? null : disclosureKey)}
        type="button"
      >
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{summarizeActionRun(calls)}</span>
        {status === 'running' ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : null}
        {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
      </button>
      {open ? (
        <div className="codex-work-group-run-body agent-action-run-body">
          {calls.map((call) => (
            <ToolCall
              call={call}
              conversationId={conversationId}
              key={call.id}
              scopeId={scopeId}
              turnId={turnId}
              workKey={workKey}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ToolCall({
  call,
  conversationId,
  scopeId,
  turnId,
  workKey,
}: {
  call: AgentToolCallSummary;
  conversationId: string;
  scopeId: string;
  turnId: string;
  workKey: string;
}) {
  const key = `operation:${call.id}`;
  const resourceKey = operationDetailResourceKey(conversationId, turnId, scopeId, call.id);
  const open = useTranscriptLayoutStore((state) =>
    state.disclosure.openWorkByKey[workKey]?.openChildByKey[key] ?? false);
  const toggle = useTranscriptLayoutStore((state) => state.toggleWorkChildDisclosure);
  const detail = useTranscriptResourceStore((state) => state.operationDetailsByKey[resourceKey]);
  const ensureDetail = useTranscriptResourceStore((state) => state.ensureOperationDetail);
  useEffect(() => {
    if (open && !detail) void ensureDetail({ operationId: call.id, scopeId, turnId });
  }, [call.id, detail, ensureDetail, open, scopeId, turnId]);
  return (
    <section className="agent-tool-call codex-work-row-frame" data-state={call.status}>
      <button
        aria-expanded={open}
        className="agent-tool-call-header codex-work-row"
        data-remux-no-composer-focus="true"
        onClick={() => {
          toggle(workKey, key);
          if (!open) void ensureDetail({ operationId: call.id, scopeId, turnId });
        }}
        type="button"
      >
        <span className="codex-work-row-icon"><ScopeStateIcon status={call.status} /></span>
        <span className="codex-work-row-copy">
          <span className="codex-work-row-title">{call.presentation.label}</span>
          <span className="codex-work-row-meta">
            {call.presentation.subject ? `${call.presentation.subject} · ` : ''}
            {call.name} · {call.status}
            {call.durationMs === null ? '' : ` · ${formatWorkDuration(call.durationMs)}`}
          </span>
        </span>
        <ChevronRight className="size-3.5" />
      </button>
      {open ? (
        <div className="codex-work-row-detail">
          <div className="codex-work-detail-copy">
            {(!detail || detail.status === 'loading') && !detail?.resource ? (
              <div className="codex-work-loading">
                <Loader2 className="size-3.5 animate-spin" /> Loading detail…
              </div>
            ) : null}
            {detail?.status === 'error' || detail?.status === 'missing' ? (
              <div className="codex-work-error" role="alert">
                <span>Tool detail is unavailable.</span>
                <button
                  onClick={() => void ensureDetail({ operationId: call.id, scopeId, turnId })}
                  type="button"
                >
                  <RotateCcw className="size-3" /> Retry
                </button>
              </div>
            ) : null}
            {detail?.resource?.detail ? (
              <>
                <pre className="codex-work-output">{detail.resource.detail}</pre>
                <ExactContent
                  content={detail.resource.content?.detail}
                  preview={detail.resource.detail}
                  title="tool arguments"
                />
              </>
            ) : null}
            {detail?.resource?.output ? (
              <>
                <pre className="codex-work-output">{detail.resource.output}</pre>
                <ExactContent
                  content={detail.resource.content?.output}
                  preview={detail.resource.output}
                  title="tool output"
                />
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function WorkUnitOutcome({ laneWidth, value }: { laneWidth: number; value: AgentExecutionScopeResource }) {
  if (!value.result && !value.artifacts.length) return null;
  return (
    <div className="agent-work-unit-outcome">
      <strong>Result</strong>
      {value.result ? (
        <section><MarkdownBlock density="work" width={laneWidth}>{value.result}</MarkdownBlock></section>
      ) : null}
      {value.artifacts.length ? <ArtifactList artifacts={value.artifacts} /> : null}
    </div>
  );
}

function ArtifactList({ artifacts }: { artifacts: AgentWorkUnitArtifactReference[] }) {
  return (
    <section className="agent-scope-artifacts">
      <strong>Artifacts</strong>
      {artifacts.map((artifact) => (
        <div key={artifact.snapshotRef} title={artifact.snapshotRef}>
          <code>{artifact.ref}</code>
          <small>{formatArtifactBytes(artifact.byteLength)} · exact snapshot</small>
        </div>
      ))}
    </section>
  );
}

function formatArtifactBytes(byteLength: number) {
  if (byteLength < 1024) return `${byteLength} B`;
  return `${Math.round(byteLength / 1024)} KB`;
}

function ScopeStateIcon({ status }: { status: AgentExecutionScopeResource['state'] | AgentToolCallSummary['status'] }) {
  if (status === 'running') return <CircleDot className="size-3.5" />;
  if (status === 'completed') return <CheckCircle2 className="size-3.5" />;
  return <AlertCircle className="size-3.5" />;
}
