import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileDiff,
  FileText,
  Loader2,
  RotateCcw,
  Wrench,
} from 'lucide-react';

import { cn, Separator } from '@remux/viewer-kit/shadcn';
import {
  workEntryDetailResourceKey,
  workGroupResourceKey,
  type AgentWorkGroupTimelineEntry,
  type AgentWorkRenderSegment,
  type AgentWorkRowSummary,
} from '../../../../../shared/transcript';
import { DiffBlock } from '../diff/DiffBlock';
import { MarkdownBlock } from '../markdown/MarkdownBlock';
import { ExactContent } from '../ExactContent';
import {
  transcriptWorkDisclosureKey,
  useTranscriptLayoutStore,
} from '../../layoutStore';
import { useTranscriptResourceStore } from '../../resourceStore';
import { WorkingDuration } from './WorkingDuration';
import { formatWorkDuration } from './workDuration';

export function WorkSection({
  conversationId,
  laneWidth,
  rowId,
  segment,
  turnId,
}: {
  conversationId: string;
  laneWidth: number;
  rowId: string;
  segment: AgentWorkRenderSegment;
  turnId: string;
}) {
  const workKey = transcriptWorkDisclosureKey(turnId, segment.id);
  const openWork = useTranscriptLayoutStore((state) => state.disclosure.openWorkByKey[workKey]);
  const toggleWork = useTranscriptLayoutStore((state) => state.toggleWorkDisclosure);
  const setAdditionalHeight = useTranscriptLayoutStore((state) => state.setOpenWorkAdditionalHeight);
  const ensureWorkResources = useTranscriptResourceStore((state) => state.ensureWorkResources);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const isOpen = Boolean(openWork);

  useEffect(() => {
    if (isOpen) void ensureWorkResources({ segmentId: segment.id, turnId });
  }, [ensureWorkResources, isOpen, segment.id, turnId]);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || !isOpen) return;
    const publish = () => setAdditionalHeight(workKey, rowId, element.getBoundingClientRect().height);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, [isOpen, rowId, setAdditionalHeight, workKey]);

  const completed = segment.state !== 'running';
  const reasoning = segment.timeline.filter((entry) => entry.type === 'text');
  const workGroups = segment.timeline.filter((entry) => entry.type === 'group');
  return (
    <section className="codex-work-section" data-state={segment.state}>
      <button
        aria-expanded={isOpen}
        className="codex-work-header"
        data-remux-no-composer-focus
        onClick={(event) => {
          event.currentTarget.blur();
          toggleWork({ rowId, segmentId: segment.id, turnId });
        }}
        type="button"
      >
        <span className="codex-work-header-chevron">
          {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
        <span className="codex-work-header-title">
          {completed && segment.durationMs !== null
            ? <>Worked for <span className="tabular-nums">{formatWorkDuration(segment.durationMs)}</span></>
            : <WorkingDuration completed={completed} turnId={turnId} />}
        </span>
        <span className="codex-work-header-status">{segment.state}</span>
      </button>
      <Separator className="codex-work-separator" />
      {isOpen ? (
        <div className="codex-work-content" ref={contentRef}>
          <ReasoningDisclosure
            entries={reasoning}
            laneWidth={laneWidth}
            running={segment.state === 'running'}
          />
          {workGroups.map((entry) => (
            <WorkGroup
              conversationId={conversationId}
              group={entry}
              key={entry.id}
              laneWidth={laneWidth}
              segmentId={segment.id}
              turnId={turnId}
              workKey={workKey}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ReasoningDisclosure({
  entries,
  laneWidth,
  running,
}: {
  entries: Extract<AgentWorkRenderSegment['timeline'][number], { type: 'text' }>[];
  laneWidth: number;
  running: boolean;
}) {
  if (entries.length === 0) return null;
  const latest = reasoningPreview(entries.at(-1)?.text ?? '');
  return (
    <details className="agent-reasoning-disclosure">
      <summary>
        <span className="agent-reasoning-label">Reasoning</span>
        <span className="agent-reasoning-count">
          {entries.length} {entries.length === 1 ? 'update' : 'updates'}
        </span>
        {running && latest ? <span className="agent-reasoning-preview">{latest}</span> : null}
        <ChevronRight aria-hidden="true" className="agent-reasoning-chevron size-3.5" />
      </summary>
      <div className="agent-reasoning-content">
        {entries.map((entry) => (
          <div className="agent-reasoning-entry" key={entry.id}>
            <MarkdownBlock density="work" width={laneWidth}>
              {entry.text}
            </MarkdownBlock>
            <ExactContent content={entry.content} preview={entry.text} title="reasoning" />
          </div>
        ))}
      </div>
    </details>
  );
}

function reasoningPreview(value: string) {
  return value
    .replace(/[*_`#>]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function WorkGroup({
  conversationId,
  group,
  laneWidth,
  segmentId,
  turnId,
  workKey,
}: {
  conversationId: string;
  group: AgentWorkGroupTimelineEntry;
  laneWidth: number;
  segmentId: string;
  turnId: string;
  workKey: string;
}) {
  const key = workGroupResourceKey(conversationId, turnId, segmentId, group.id);
  const entry = useTranscriptResourceStore((state) => state.workGroupsByKey[key]);
  const ensureGroup = useTranscriptResourceStore((state) => state.ensureWorkGroup);
  const loadMore = useTranscriptResourceStore((state) => state.loadMoreWorkGroup);

  useEffect(() => {
    if (!entry) void ensureGroup({ groupId: group.id, segmentId, turnId });
  }, [ensureGroup, entry, group.id, segmentId, turnId]);

  return (
    <section className="codex-work-group" data-group-type={group.groupType}>
      <div className="codex-work-group-heading">
        <strong>{group.title}</strong>
        <span>{group.rowCount}</span>
      </div>
      {(!entry || entry.status === 'loading') && !entry?.resource ? (
        <div className="codex-work-loading"><Loader2 className="size-3.5 animate-spin" /> Loading…</div>
      ) : null}
      {entry?.status === 'error' || entry?.status === 'missing' ? (
        <div className="codex-work-error" role="alert">
          <span>{entry.errorCode === 'staleCursor'
            ? 'Work changed while the next page was loading.'
            : 'Work details are unavailable.'}</span>
          <button
            onClick={() => void ensureGroup({ groupId: group.id, segmentId, turnId })}
            type="button"
          >
            <RotateCcw className="size-3" /> Retry
          </button>
        </div>
      ) : null}
      {entry?.resource?.rows.map((row) => (
        <WorkRow
          conversationId={conversationId}
          groupId={group.id}
          key={row.id}
          laneWidth={laneWidth}
          row={row}
          segmentId={segmentId}
          turnId={turnId}
          workKey={workKey}
        />
      ))}
      {entry?.status === 'ready' && entry.resource.nextCursor ? (
        <button
          className="codex-work-load-more"
          onClick={() => void loadMore({ groupId: group.id, segmentId, turnId })}
          type="button"
        >
          Load more
        </button>
      ) : null}
    </section>
  );
}

function WorkRow({
  conversationId,
  groupId,
  laneWidth,
  row,
  segmentId,
  turnId,
  workKey,
}: {
  conversationId: string;
  groupId: string;
  laneWidth: number;
  row: AgentWorkRowSummary;
  segmentId: string;
  turnId: string;
  workKey: string;
}) {
  const detailKey = workEntryDetailResourceKey(
    conversationId,
    turnId,
    segmentId,
    groupId,
    row.id,
  );
  const detail = useTranscriptResourceStore((state) => state.workEntryDetailsByKey[detailKey]);
  const ensureDetail = useTranscriptResourceStore((state) => state.ensureWorkEntryDetail);
  const open = useTranscriptLayoutStore((state) =>
    state.disclosure.openWorkByKey[workKey]?.openChildByKey[detailKey] ?? false);
  const setOnlyOpen = useTranscriptLayoutStore((state) => state.setOnlyOpenWorkChildDisclosure);
  const openKeys = useTranscriptResourceStore((state) => {
    const groupKey = workGroupResourceKey(conversationId, turnId, segmentId, groupId);
    return state.workGroupsByKey[groupKey]?.resource?.rows
      .filter((candidate) => candidate.hasDetail)
      .map((candidate) => workEntryDetailResourceKey(
        conversationId,
        turnId,
        segmentId,
        groupId,
        candidate.id,
      )) ?? [];
  }, sameStrings);

  const canOpen = row.hasDetail;
  useEffect(() => {
    if (open && !detail) {
      void ensureDetail({ groupId, rowId: row.id, segmentId, turnId });
    }
  }, [detail, ensureDetail, groupId, open, row.id, segmentId, turnId]);
  return (
    <div className={cn('codex-work-row-frame', open && 'is-open')}>
      <button
        aria-expanded={canOpen ? open : undefined}
        className="codex-work-row"
        disabled={!canOpen}
        onClick={() => {
          if (!canOpen) return;
          setOnlyOpen(workKey, openKeys, open ? null : detailKey);
          if (!open) {
            void ensureDetail({ groupId, rowId: row.id, segmentId, turnId });
          }
        }}
        type="button"
      >
        <span className="codex-work-row-icon"><WorkRowIcon row={row} /></span>
        <span className="codex-work-row-copy">
          <span className="codex-work-row-title">{workRowTitle(row)}</span>
          <span className="codex-work-row-meta">{workRowMeta(row)}</span>
        </span>
        {canOpen ? (open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />) : null}
      </button>
      {open ? (
        <div className="codex-work-row-detail">
          {(!detail || detail.status === 'loading') && !detail?.resource ? (
            <div className="codex-work-loading"><Loader2 className="size-3.5 animate-spin" /> Loading detail…</div>
          ) : null}
          {detail?.status === 'error' || detail?.status === 'missing' ? (
            <div className="codex-work-error" role="alert">
              <span>Detail is unavailable.</span>
              <button
                onClick={() => void ensureDetail({ groupId, rowId: row.id, segmentId, turnId })}
                type="button"
              >
                <RotateCcw className="size-3" /> Retry
              </button>
            </div>
          ) : null}
          {detail?.resource ? (
            <WorkDetail
              content={detail.resource.content}
              detail={detail.resource.detail}
              laneWidth={laneWidth}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function WorkDetail({
  content,
  detail,
  laneWidth,
}: {
  content?: import('../../../../../shared/transcript').AgentWorkEntryDetailResource['content'];
  detail: NonNullable<import('../../../../../shared/transcript').AgentWorkEntryDetailResource['detail']>;
  laneWidth: number;
}) {
  if (detail.type === 'fileChange') return <DiffBlock diff={detail.diff} />;
  const primary = detail.detail;
  const output = detail.type === 'activity' ? detail.output : detail.result;
  return (
    <div className="codex-work-detail-copy">
      {primary ? <MarkdownBlock density="work" width={laneWidth}>{primary}</MarkdownBlock> : null}
      <ExactContent content={content?.detail} preview={primary ?? ''} title="tool input" />
      {output ? <pre className="codex-work-output">{output}</pre> : null}
      <ExactContent content={content?.output} preview={output ?? ''} title="tool output" />
    </div>
  );
}

function WorkRowIcon({ row }: { row: AgentWorkRowSummary }) {
  if (row.type === 'fileChange') return <FileDiff className="size-4" />;
  if (row.type === 'tool') return <Wrench className="size-4" />;
  return <FileText className="size-4" />;
}

function workRowTitle(row: AgentWorkRowSummary) {
  if (row.type === 'fileChange') return row.path;
  if (row.type === 'tool') return row.label;
  return row.text;
}

function workRowMeta(row: AgentWorkRowSummary) {
  if (row.type === 'fileChange') return `${row.kind} · +${row.additions} −${row.deletions}`;
  if (row.type === 'activity') {
    const duration = row.durationMs === null ? '' : ` · ${formatWorkDuration(row.durationMs)}`;
    return `${row.status}${duration}${row.path ? ` · ${row.path}` : ''}`;
  }
  if (row.type === 'tool') return row.detailPreview ?? row.status;
  return '';
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
