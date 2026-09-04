import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Loader2,
  RotateCcw,
} from 'lucide-react';

import {
  executionScopeResourceKey,
  operationDetailResourceKey,
  type AgentExecutionScopeResource,
  type AgentInferenceBlock,
  type AgentInferenceTrace,
  type AgentToolCallSummary,
  type AgentExecutionArtifactReference,
} from '../../../../../shared/transcript.ts';
import { useTranscriptLayoutStore } from '../../layoutStore.ts';
import { useTranscriptResourceStore } from '../../resourceStore.ts';
import { ExactContent } from '../ExactContent.tsx';
import { CompactionDivider } from '../CompactionDivider.tsx';
import { ArtifactDiff } from '../diff/ArtifactDiff.tsx';
import { MarkdownBlock } from '../markdown/MarkdownBlock.tsx';
import { LiveActivity } from './LiveActivity.tsx';
import { formatWorkDuration } from './workDuration.ts';
import { executionScopeIsWaitingForContent } from './workActivityState.ts';
import { actionRunActivityKind, summarizeActionRun } from './workPresentation.ts';

export function ExecutionScopeContent({
  conversationId,
  isRunning = false,
  laneWidth,
  responseStarted = false,
  scopeId,
  turnId,
  workKey,
}: {
  conversationId: string;
  isRunning?: boolean;
  laneWidth: number;
  responseStarted?: boolean;
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
    if (isRunning && !responseStarted) {
      return <LiveActivity className="agent-thinking-placeholder" kind="thinking" label="Thinking" />;
    }
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
      responseStarted={responseStarted}
      turnId={turnId}
      value={entry.resource}
      workKey={workKey}
    />
  );
}

function ExecutionScopeBody({
  conversationId,
  laneWidth,
  responseStarted,
  turnId,
  value,
  workKey,
}: {
  conversationId: string;
  laneWidth: number;
  responseStarted: boolean;
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
      {value.kind === 'childExecution' ? <ChildExecutionOutcome laneWidth={scopeWidth} value={value} /> : null}
      {!responseStarted && executionScopeIsWaitingForContent(value) ? (
        <LiveActivity className="agent-thinking-placeholder" kind="thinking" label="Thinking" />
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
  const items = inferenceTraceItems(scopeId, inference.blocks);
  const childCalls = items.filter((item) => item.kind === 'scope').map((item) => item.call);
  const childKeys = childCalls.map((call) =>
    executionScopeResourceKey(conversationId, turnId, call.childScopeId!));
  const actionKeys = items.filter((item) => item.kind === 'actions').map((item) => item.key);
  return (
    <section className="agent-inference" data-state={inference.state}>
      {items.map((item) => {
        if (item.kind === 'text') {
          if (item.block.type === 'notice' && item.block.code === 'context-compaction') {
            return (
              <CompactionDivider
                key={item.block.id}
                label={item.block.text}
                status={item.block.state === 'streaming'
                  ? 'compacting'
                  : item.block.state === 'partial' ? 'failed' : 'compacted'}
              />
            );
          }
          const className = item.block.type === 'reasoning'
            ? 'agent-reasoning-block'
            : item.block.type === 'notice'
              ? 'agent-notice-block'
              : 'agent-commentary-block';
          const title = item.block.type === 'reasoning'
            ? 'reasoning'
            : item.block.type === 'notice' ? 'provider notice' : 'progress update';
          return (
            <div
              className={`${className} codex-work-entry codex-work-entry-block`}
              data-kind={item.block.type}
              data-state={item.block.state}
              key={item.block.id}
            >
              {item.block.type === 'reasoning' && item.block.parts?.length ? (
                <div className="agent-reasoning-parts">
                  {item.block.parts.map((part, index) => (
                    <div className="agent-reasoning-part" key={`${item.block.id}:part:${index}`}>
                      <MarkdownBlock density="work" width={laneWidth}>{part}</MarkdownBlock>
                    </div>
                  ))}
                </div>
              ) : (
                <MarkdownBlock
                  density="work"
                  preserveSoftBreaks={item.block.type === 'reasoning'}
                  width={laneWidth}
                >
                  {item.block.text}
                </MarkdownBlock>
              )}
              <ExactContent
                content={item.block.content}
                preview={item.block.text}
                title={title}
              />
            </div>
          );
        }
        if (item.kind === 'scope') {
          return (
            <ExecutionScopeDisclosure
              conversationId={conversationId}
              fallbackTitle={item.call.childBoundary ?? 'Agent task'}
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
          );
        }
        return (
          <div className="agent-action-sequence" data-state={actionRunState(item.calls)} key={item.key}>
            <ActionRun
              calls={item.calls}
              conversationId={conversationId}
              disclosureKey={item.key}
              scopeId={scopeId}
              siblingKeys={actionKeys}
              turnId={turnId}
              workKey={workKey}
            />
          </div>
        );
      })}
    </section>
  );
}

type ActionTraceItem =
  | { kind: 'text'; block: Extract<AgentInferenceBlock, { type: 'reasoning' | 'commentary' | 'assistantText' | 'notice' }> }
  | { kind: 'actions'; key: string; calls: AgentToolCallSummary[] }
  | { kind: 'scope'; call: AgentToolCallSummary };

function inferenceTraceItems(
  scopeId: string,
  blocks: AgentInferenceBlock[],
): ActionTraceItem[] {
  const items: ActionTraceItem[] = [];
  let pending: AgentToolCallSummary[] = [];
  let runIndex = 0;
  const flush = () => {
    if (!pending.length) return;
    items.push({
      kind: 'actions',
      key: `action-run:${scopeId}:${pending[0]!.id}:${pending.at(-1)!.id}:${runIndex}`,
      calls: pending,
    });
    pending = [];
    runIndex += 1;
  };
  for (const block of blocks) {
    if (block.type !== 'action') {
      flush();
      items.push({ kind: 'text', block });
      continue;
    }
    const call = block.call;
    if (call.childScopeId) {
      flush();
      items.push({ kind: 'scope', call });
      continue;
    }
    pending.push(call);
  }
  flush();
  return items;
}

function actionRunState(calls: AgentToolCallSummary[]) {
  if (calls.some(({ status }) => status === 'running')) return 'running';
  if (calls.some(({ status }) => status === 'failed')) return 'failed';
  if (calls.some(({ status }) => status === 'interrupted')) return 'interrupted';
  return 'completed';
}

function actionRunStatus(calls: AgentToolCallSummary[]): AgentToolCallSummary['status'] {
  if (calls.some((call) => call.status === 'running')) return 'running';
  if (calls.some((call) => call.status === 'failed')) return 'failed';
  if (calls.some((call) => call.status === 'interrupted')) return 'interrupted';
  return 'completed';
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
        count + inference.blocks.filter((block) => block.type === 'action').length, 0)
    : fallbackOperationCount;
  const artifactCount = scope?.artifacts.length ?? fallbackArtifactCount;

  useEffect(() => {
    if (open && !scope) void ensureScope({ scopeId, turnId });
  }, [ensureScope, open, scope, scopeId, turnId]);

  return (
    <section className="agent-child-execution" data-state={displayStatus}>
      <button
        aria-expanded={open}
        className="agent-child-execution-header"
        data-remux-no-composer-focus="true"
        onClick={() => {
          setOnlyOpen(workKey, siblingKeys, open ? null : key);
          if (!open) void ensureScope({ scopeId, turnId });
        }}
        type="button"
      >
        <span className="agent-child-execution-copy">
          <span className="agent-child-execution-boundary">
            <LiveActivity
              animated={displayStatus === 'running'}
              className="agent-live-activity-inline"
              kind="agent"
              label={title}
            />
          </span>
          <span className="agent-child-execution-meta">
            Agent · {displayStatus}{durationMs === null || durationMs === undefined
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
        <span className="agent-child-execution-chevron">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
      </button>
      {open ? (
        <div className="agent-child-execution-content">
          <ExecutionScopeContent
            conversationId={conversationId}
            isRunning={displayStatus === 'running'}
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
        <LiveActivity
          animated={status === 'running'}
          className="agent-live-activity-inline min-w-0 flex-1"
          kind={actionRunActivityKind(calls)}
          label={summarizeActionRun(calls)}
        />
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
    if (open && !call.diffArtifactId && !detail) {
      void ensureDetail({ operationId: call.id, scopeId, turnId });
    }
  }, [call.diffArtifactId, call.id, detail, ensureDetail, open, scopeId, turnId]);
  const headerContent = (
    <>
      <span className="codex-work-row-icon"><ScopeStateIcon status={call.status} /></span>
      <span className="codex-work-row-copy">
        <span className="codex-work-row-title">{call.presentation.label}</span>
        <span className="codex-work-row-meta">
          {call.presentation.subject ? `${call.presentation.subject} · ` : ''}
          {call.name} · {call.status}
          {call.durationMs === null ? '' : ` · ${formatWorkDuration(call.durationMs)}`}
        </span>
      </span>
    </>
  );
  return (
    <section
      className="agent-tool-call codex-work-row-frame"
      data-has-diff={call.diffArtifactId ? 'true' : 'false'}
      data-state={call.status}
    >
      {call.hasDetail ? (
        <button
          aria-expanded={open}
          className="agent-tool-call-header codex-work-row"
          data-remux-no-composer-focus="true"
          onClick={() => {
            toggle(workKey, key);
            if (!open && !call.diffArtifactId) {
              void ensureDetail({ operationId: call.id, scopeId, turnId });
            }
          }}
          type="button"
        >
          {headerContent}
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      ) : (
        <div className="agent-tool-call-header codex-work-row">{headerContent}</div>
      )}
      {open && call.hasDetail ? (
        <div className="codex-work-row-detail">
          <div className="codex-work-detail-copy">
            {call.diffArtifactId ? <ArtifactDiff artifactId={call.diffArtifactId} /> : null}
            {!call.diffArtifactId && (!detail || detail.status === 'loading') && !detail?.resource ? (
              <div className="codex-work-loading">
                <Loader2 className="size-3.5 animate-spin" /> Loading detail…
              </div>
            ) : null}
            {!call.diffArtifactId && (detail?.status === 'error' || detail?.status === 'missing') ? (
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

function ChildExecutionOutcome({ laneWidth, value }: { laneWidth: number; value: AgentExecutionScopeResource }) {
  if (!value.result && !value.artifacts.length) return null;
  return (
    <div className="agent-child-execution-outcome">
      <strong>Result</strong>
      {value.result ? (
        <section><MarkdownBlock density="work" width={laneWidth}>{value.result}</MarkdownBlock></section>
      ) : null}
      {value.artifacts.length ? <ArtifactList artifacts={value.artifacts} /> : null}
    </div>
  );
}

function ArtifactList({ artifacts }: { artifacts: AgentExecutionArtifactReference[] }) {
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
  if (status === 'running') return <CircleDot className="size-4" />;
  if (status === 'completed') return <CheckCircle2 className="size-4" />;
  return <AlertCircle className="size-4" />;
}
