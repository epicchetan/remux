import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  FilePenLine,
  FolderOpen,
  ImageIcon,
  ListChecks,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wrench,
  XCircle,
} from 'lucide-react';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type {
  CodexActivityWorkGroup,
  CodexFileChange,
  CodexMediaPreview,
  CodexToolRow,
  CodexWorkActivity,
  CodexWorkDetails,
  CodexWorkEntry,
  CodexWorkGroup,
  CodexWorkGroupRef,
  CodexWorkItem,
  CodexWorkSegment,
} from '../../../../shared/transcript';
import { imageSourceLabel, inferImageMime } from './mediaTypes';
import { readLocalFileBase64 } from '../../../ipc/media';
import { DiffBlock } from '../diff/DiffBlock';
import { MarkdownBlock } from '../markdown/MarkdownBlock';
import { Separator, cn } from '@remux/viewer-kit/shadcn';
import { transcriptWorkDisclosureKey, useTranscriptLayoutStore } from '../../layoutStore';
import { useTranscriptResourceStore, workItemResourceKey } from '../../resourceStore';
import { Compaction } from '../compaction';
import { UserMessage } from '../userMessage';
import { WorkingDuration } from './WorkingDuration';
import { formatWorkDuration } from './workDuration';

type LocalDisclosure = {
  isOpen: (id: string, defaultOpen?: boolean) => boolean;
  setOnlyOpen: (ids: string[], openId: string | null) => void;
  toggle: (id: string, defaultOpen?: boolean) => void;
};

const LocalDisclosureContext = createContext<LocalDisclosure | null>(null);

export function WorkSection({
  details,
  rowId,
  segment,
  threadId,
  turnId,
  width,
}: {
  details: CodexWorkDetails | null;
  rowId: string;
  segment: CodexWorkSegment;
  threadId: string | null;
  turnId: string;
  width: number;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const heightRafRef = useRef<number | null>(null);
  const pendingHeightRef = useRef<number | null>(null);
  const workKey = transcriptWorkDisclosureKey(turnId, segment.id);
  const openWork = useTranscriptLayoutStore((state) => state.disclosure.openWorkByKey[workKey]);
  const setOnlyOpenWorkChildDisclosure = useTranscriptLayoutStore((state) => state.setOnlyOpenWorkChildDisclosure);
  const setOpenWorkAdditionalHeight = useTranscriptLayoutStore((state) => state.setOpenWorkAdditionalHeight);
  const toggleWorkChildDisclosure = useTranscriptLayoutStore((state) => state.toggleWorkChildDisclosure);
  const toggleWorkDisclosure = useTranscriptLayoutStore((state) => state.toggleWorkDisclosure);
  const ensureWorkDetails = useTranscriptResourceStore((state) => state.ensureWorkDetails);
  const entries = details?.entries ?? [];
  const workOpen = openWork?.rowId === rowId && openWork.segmentId === segment.id && openWork.turnId === turnId;
  const waitingForDetails = workOpen && segment.hasDetails && !details;
  const disclosure = useMemo<LocalDisclosure>(
    () => ({
      isOpen(id, defaultOpen = false) {
        return openWork?.openChildByKey[id] ?? defaultOpen;
      },
      setOnlyOpen(ids, openId) {
        setOnlyOpenWorkChildDisclosure(workKey, ids, openId);
      },
      toggle(id, defaultOpen = false) {
        toggleWorkChildDisclosure(workKey, id, defaultOpen);
      },
    }),
    [openWork?.openChildByKey, setOnlyOpenWorkChildDisclosure, toggleWorkChildDisclosure, workKey],
  );

  useEffect(() => {
    if (!workOpen || !segment.hasDetails || details) {
      return;
    }

    void ensureWorkDetails({ segmentId: segment.id, turnId });
  }, [details, ensureWorkDetails, segment.hasDetails, segment.id, turnId, workOpen]);

  useLayoutEffect(() => {
    if (!workOpen) {
      return;
    }

    const scheduleHeightUpdate = (height: number) => {
      pendingHeightRef.current = height;
      if (heightRafRef.current !== null) {
        return;
      }

      heightRafRef.current = window.requestAnimationFrame(() => {
        heightRafRef.current = null;
        const pendingHeight = pendingHeightRef.current;
        pendingHeightRef.current = null;
        if (pendingHeight !== null) {
          setOpenWorkAdditionalHeight(workKey, rowId, pendingHeight);
        }
      });
    };

    if (!details) {
      scheduleHeightUpdate(0);
      return () => {
        if (heightRafRef.current !== null) {
          window.cancelAnimationFrame(heightRafRef.current);
          heightRafRef.current = null;
        }
        pendingHeightRef.current = null;
      };
    }

    const node = bodyRef.current;
    if (!node) {
      return;
    }

    const updateHeight = () => {
      scheduleHeightUpdate(Math.max(0, Math.ceil(node.getBoundingClientRect().height)));
    };

    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (heightRafRef.current !== null) {
        window.cancelAnimationFrame(heightRafRef.current);
        heightRafRef.current = null;
      }
      pendingHeightRef.current = null;
    };
  }, [details, rowId, setOpenWorkAdditionalHeight, workKey, workOpen]);

  return (
    <LocalDisclosureContext.Provider value={disclosure}>
      <section
        className="codex-work-section"
        data-turn-id={turnId}
        data-work-section-id={segment.id}
      >
        <button
          className="codex-work-header-button"
          data-testid={`work-section-${segment.id}`}
          onClick={() => toggleWorkDisclosure({ rowId, segmentId: segment.id, turnId })}
          type="button"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 truncate">
              <WorkTitle segment={segment} turnId={turnId} />
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {segment.state === 'running' || waitingForDetails ? (
              <Loader2 aria-hidden="true" className="size-3 animate-spin text-muted-foreground" />
            ) : null}
            {workOpen ? <ChevronDown className="size-5 shrink-0" /> : <ChevronRight className="size-5 shrink-0" />}
          </span>
        </button>
        <Separator className="mt-1" />

        {workOpen && details ? (
          <div className="codex-work-section-body" ref={bodyRef}>
            <WorkEntries entries={entries} threadId={threadId} turnId={turnId} width={width} workId={segment.id} />
          </div>
        ) : null}
      </section>
    </LocalDisclosureContext.Provider>
  );
}

function WorkEntries({
  entries,
  threadId,
  turnId,
  width,
  workId,
}: {
  entries: CodexWorkEntry[];
  threadId: string | null;
  turnId: string;
  width: number;
  workId: string;
}) {
  const groupRunDisclosureIds = workGroupRunDisclosureIds(workId, entries);
  const rendered: ReactNode[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }

    if (entry.type === 'message') {
      rendered.push(<WorkItemEntry entry={entry} key={entry.id} threadId={threadId} turnId={turnId} width={width} />);
      continue;
    }

    if (entry.type === 'userMessage') {
      rendered.push(<WorkItemEntry entry={entry} key={entry.id} threadId={threadId} turnId={turnId} width={width} />);
      continue;
    }

    if (entry.type === 'compaction') {
      rendered.push(<WorkItemEntry entry={entry} key={entry.id} threadId={threadId} turnId={turnId} width={width} />);
      continue;
    }

    const groupEntries: Extract<CodexWorkEntry, { type: 'group' }>[] = [];
    while (index < entries.length && entries[index]?.type === 'group') {
      groupEntries.push(entries[index] as Extract<CodexWorkEntry, { type: 'group' }>);
      index += 1;
    }
    index -= 1;

    rendered.push(
      <WorkGroupRun
        entries={groupEntries}
        key={`${workId}:groups:${groupEntries.map((item) => item.id).join(':')}`}
        siblingDisclosureIds={groupRunDisclosureIds}
        threadId={threadId}
        turnId={turnId}
        workId={workId}
      />,
    );
  }

  return <>{rendered}</>;
}

function WorkItemEntry({
  entry,
  threadId,
  turnId,
  width,
}: {
  entry: Extract<CodexWorkEntry, { type: 'compaction' | 'message' | 'userMessage' }>;
  threadId: string | null;
  turnId: string;
  width: number;
}) {
  const item = useWorkItem(threadId, turnId, entry.itemId);

  if (entry.type === 'message') {
    return item?.type === 'message' ? <WorkMessage item={item} width={width} /> : null;
  }

  if (entry.type === 'userMessage') {
    return item?.type === 'userMessage' ? <WorkUserMessage item={item} width={width} /> : null;
  }

  return item?.type === 'compaction' ? (
    <Compaction
      density="work"
      segment={{
        id: item.id,
        revision: `${item.id}:${item.status}`,
        status: item.status,
        type: 'compaction',
      }}
    />
  ) : null;
}

function WorkMessage({ item, width }: { item: Extract<CodexWorkItem, { type: 'message' }>; width: number }) {
  if (!item.text.trim()) {
    return null;
  }

  return (
    <div className="codex-work-entry codex-work-entry-block">
      <MarkdownBlock density="work" width={width}>
        {item.text}
      </MarkdownBlock>
    </div>
  );
}

function WorkUserMessage({ item, width }: { item: Extract<CodexWorkItem, { type: 'userMessage' }>; width: number }) {
  return (
    <div className="codex-work-entry codex-work-entry-block">
      <UserMessage
        laneWidth={width}
        placement="work"
        segment={{
          content: item.content,
          id: item.id,
          isSteering: item.isSteering,
          revision: `${item.id}:${item.content.length}`,
          type: 'userMessage',
        }}
      />
    </div>
  );
}

function WorkGroupRun({
  entries,
  siblingDisclosureIds,
  threadId,
  turnId,
  workId,
}: {
  entries: Extract<CodexWorkEntry, { type: 'group' }>[];
  siblingDisclosureIds: string[];
  threadId: string | null;
  turnId: string;
  workId: string;
}) {
  const disclosure = useLocalDisclosure();
  const groups = entries.map((entry) => entry.group);
  const itemIds = workGroupItemIds(groups);
  const items = useWorkItems(threadId, turnId, itemIds);
  const materializedGroups = useMemo(
    () => groups.map((group) => materializeWorkGroup(group, items)),
    [groups, items],
  );
  const disclosureId = workGroupRunDisclosureId(workId, entries);
  const isOpen = disclosure.isOpen(disclosureId, false);
  const canOpen = groups.some((group) => group.itemIds.length > 0);
  const Icon = summaryIcon(materializedGroups);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="codex-work-group-run">
      <button
        className="codex-work-row-button codex-work-summary-button"
        data-work-group-ids={groups.map((group) => group.id).join(' ')}
        data-testid={`work-summary-${disclosureId}`}
        disabled={!canOpen}
        onClick={() => disclosure.setOnlyOpen(siblingDisclosureIds, isOpen ? null : disclosureId)}
        type="button"
      >
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{summarizeWorkGroups(materializedGroups, groups)}</span>
        {canOpen ? (
          isOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />
        ) : null}
      </button>

      {isOpen ? (
        <div className="codex-work-group-run-body">
          {entries.map((entry) => (
            <WorkGroupContent
              group={entry.group}
              groupDisclosureId={`${disclosureId}:group:${entry.group.id}`}
              items={items}
              key={entry.id}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkGroupContent({
  group,
  groupDisclosureId,
  items,
}: {
  group: CodexWorkGroupRef;
  groupDisclosureId: string;
  items: (CodexWorkItem | null)[];
}) {
  const groupItems = itemsForGroup(group, items);

  switch (group.type) {
    case 'activity':
      return (
        <div className="codex-work-group" data-work-group-type={group.type}>
          {groupItems.flatMap((item) => item?.type === 'activity' ? [item.activity] : []).map((activity) => (
            <ActivityItem
              activity={activity}
              disclosureId={`${groupDisclosureId}:activity:${activity.id}`}
              key={activity.id}
            />
          ))}
        </div>
      );
    case 'files':
      return (
        <div className="codex-work-group" data-work-group-type={group.type}>
          {groupItems.flatMap((item) => item?.type === 'fileChanges' ? item.files : []).map((file) => (
            <FileItem
              disclosureId={`${groupDisclosureId}:file:${file.id}`}
              file={file}
              key={file.id}
            />
          ))}
        </div>
      );
    case 'text':
      return (
        <div className="codex-work-group codex-work-text-group" data-work-group-type={group.type} />
      );
    case 'tools':
      return (
        <div className="codex-work-group" data-work-group-type={group.type}>
          {groupItems.flatMap((item) => item?.type === 'tool' ? [item.row] : []).map((row) => (
            <ToolItem
              disclosureId={`${groupDisclosureId}:tool:${row.id}`}
              key={row.id}
              row={row}
            />
          ))}
        </div>
      );
  }
}

function ActivityItem({
  activity,
  disclosureId,
}: {
  activity: CodexWorkActivity;
  disclosureId: string;
}) {
  const disclosure = useLocalDisclosure();
  const defaultOpen = activity.status === 'failed' || activity.status === 'inProgress';
  const isOpen = disclosure.isOpen(disclosureId, defaultOpen);
  const hasDetails = Boolean(activity.output || activity.command || activity.detail);

  return (
    <div className="codex-work-detail-group">
      <button
        className="codex-work-row-button"
        data-activity-kind={activity.kind}
        data-testid={`activity-row-${disclosureId}`}
        disabled={!hasDetails}
        onClick={() => disclosure.toggle(disclosureId, defaultOpen)}
        type="button"
      >
        <span className={cn('min-w-0 flex-1 truncate', activity.status === 'failed' && 'text-destructive')}>
          {activity.text}
        </span>
        {activity.exitCode !== null && activity.exitCode !== 0 ? (
          <span className="shrink-0 font-mono text-sm text-destructive">{activity.exitCode}</span>
        ) : null}
        {hasDetails ? (
          isOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />
        ) : null}
      </button>
      {hasDetails && isOpen ? <ActivityDetailBlock activity={activity} /> : null}
    </div>
  );
}

function ActivityDetailBlock({ activity }: { activity: CodexWorkActivity }) {
  return (
    <div className="codex-detail-panel codex-detail-panel-activity">
      {activity.command ? <div className="codex-detail-command">$ {activity.command}</div> : null}
      {activity.detail ? <div className="codex-detail-text">{activity.detail}</div> : null}
      {activity.output ? <pre className="codex-detail-output">{activity.output.trimEnd() || 'No output'}</pre> : null}
    </div>
  );
}

function FileItem({
  disclosureId,
  file,
}: {
  disclosureId: string;
  file: CodexFileChange;
}) {
  const disclosure = useLocalDisclosure();
  const isOpen = disclosure.isOpen(disclosureId, false);

  return (
    <div className="codex-work-detail-group">
      <button
        className="codex-work-row-button codex-file-row-button"
        data-testid={`file-change-${disclosureId}`}
        onClick={() => disclosure.toggle(disclosureId, false)}
        type="button"
      >
        <span className="shrink-0">{kindLabel(file.kind)}</span>
        <span className="codex-file-name" title={file.path}>{fileName(file.path)}</span>
        <span className="shrink-0 font-mono text-success">+{file.additions}</span>
        <span className="shrink-0 font-mono text-destructive">-{file.deletions}</span>
        <StatusIcon status={file.status} />
        {isOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
      </button>
      {isOpen ? <DiffBlock diff={file.diff} /> : null}
    </div>
  );
}

function ToolItem({
  disclosureId,
  row,
}: {
  disclosureId: string;
  row: CodexToolRow;
}) {
  const disclosure = useLocalDisclosure();
  const defaultOpen = row.status === 'failed' || row.status === 'inProgress';
  const isOpen = disclosure.isOpen(disclosureId, defaultOpen);
  const hasDetails = Boolean(row.detail || row.result || row.media.length > 0);

  return (
    <div className="codex-work-detail-group">
      <button
        className="codex-work-row-button"
        data-testid={`tool-row-${disclosureId}`}
        disabled={!hasDetails}
        onClick={() => disclosure.toggle(disclosureId, defaultOpen)}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        <StatusIcon status={row.status} />
        {hasDetails ? (
          isOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />
        ) : null}
      </button>
      {hasDetails && isOpen ? <ToolDetailBlock row={row} /> : null}
    </div>
  );
}

function ToolDetailBlock({ row }: { row: CodexToolRow }) {
  return (
    <div className="codex-detail-panel codex-detail-panel-tool">
      {row.detail ? <div className="codex-detail-text">{row.detail}</div> : null}
      {row.result ? <pre className="codex-detail-output">{row.result}</pre> : null}
      {row.media.map((media) => (
        <ToolMediaPreview key={media.id} media={media} />
      ))}
    </div>
  );
}

function ToolMediaPreview({ media }: { media: CodexMediaPreview }) {
  const [uri, setUri] = useState(media.source.type === 'uri' ? media.source.uri : null);
  const [failed, setFailed] = useState(false);
  const label = media.label?.trim() || imageSourceLabel(media.source);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    if (media.source.type === 'uri') {
      setUri(media.source.uri);
      return;
    }

    const path = media.source.path;
    readLocalFileBase64(path)
      .then((dataBase64) => {
        if (!cancelled) {
          setUri(`data:${inferImageMime(path)};base64,${dataBase64}`);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUri(null);
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [media.source]);

  return (
    <div className="codex-tool-media-row">
      {uri && !failed ? (
        <img
          alt={label}
          className="codex-tool-media-image"
          loading="lazy"
          onError={() => setFailed(true)}
          src={uri}
        />
      ) : (
        <div className="codex-tool-media-fallback" title={failed ? label : undefined}>
          <ImageIcon className="size-4 shrink-0" />
          <span>{failed ? 'Image unavailable' : label}</span>
        </div>
      )}
    </div>
  );
}

function WorkTitle({ segment, turnId }: { segment: CodexWorkSegment; turnId: string }) {
  if (segment.state === 'running') {
    return <WorkingDuration turnId={turnId} />;
  }

  if (segment.durationMs !== null) {
    return <>Worked for {formatWorkDuration(segment.durationMs)}</>;
  }

  return <WorkingDuration completed turnId={turnId} />;
}

function useLocalDisclosure() {
  const disclosure = useContext(LocalDisclosureContext);
  if (!disclosure) {
    throw new Error('Work disclosure must be used inside WorkSection');
  }
  return disclosure;
}

function useWorkItem(threadId: string | null, turnId: string, itemId: string) {
  return useTranscriptResourceStore((state) => {
    if (!threadId) {
      return null;
    }

    return state.workItemsByKey[workItemResourceKey(threadId, turnId, itemId)]?.item ?? null;
  });
}

function useWorkItems(threadId: string | null, turnId: string, itemIds: string[]) {
  return useTranscriptResourceStore((state) => {
    if (!threadId) {
      return itemIds.map(() => null);
    }

    return itemIds.map((itemId) =>
      state.workItemsByKey[workItemResourceKey(threadId, turnId, itemId)]?.item ?? null);
  }, sameWorkItems);
}

function sameWorkItems(left: (CodexWorkItem | null)[], right: (CodexWorkItem | null)[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function workGroupItemIds(groups: CodexWorkGroupRef[]) {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const itemId of group.itemIds) {
      if (!seen.has(itemId)) {
        seen.add(itemId);
        ids.push(itemId);
      }
    }
  }
  return ids;
}

function itemsForGroup(group: CodexWorkGroupRef, items: (CodexWorkItem | null)[]) {
  const byId = new Map(items.filter((item): item is CodexWorkItem => Boolean(item)).map((item) => [item.id, item]));
  return group.itemIds.map((itemId) => byId.get(itemId) ?? null);
}

function materializeWorkGroup(group: CodexWorkGroupRef, items: (CodexWorkItem | null)[]): CodexWorkGroup {
  const groupItems = itemsForGroup(group, items);
  switch (group.type) {
    case 'activity':
      return {
        activities: groupItems.flatMap((item) => item?.type === 'activity' ? [item.activity] : []),
        id: group.id,
        title: group.title,
        type: 'activity',
      };
    case 'files':
      return {
        files: groupItems.flatMap((item) => item?.type === 'fileChanges' ? item.files : []),
        id: group.id,
        title: group.title,
        type: 'files',
      };
    case 'text':
      return {
        id: group.id,
        lines: [],
        title: group.title,
        type: 'text',
      };
    case 'tools':
      return {
        id: group.id,
        rows: groupItems.flatMap((item) => item?.type === 'tool' ? [item.row] : []),
        title: group.title,
        type: 'tools',
      };
  }
}

function workGroupRunDisclosureIds(workId: string, entries: CodexWorkEntry[]) {
  const disclosureIds: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.type !== 'group') {
      continue;
    }

    const groupEntries: Extract<CodexWorkEntry, { type: 'group' }>[] = [];
    while (index < entries.length && entries[index]?.type === 'group') {
      groupEntries.push(entries[index] as Extract<CodexWorkEntry, { type: 'group' }>);
      index += 1;
    }

    index -= 1;
    disclosureIds.push(workGroupRunDisclosureId(workId, groupEntries));
  }

  return disclosureIds;
}

function workGroupRunDisclosureId(
  workId: string,
  entries: Extract<CodexWorkEntry, { type: 'group' }>[],
) {
  const groupIds = entries.map((entry) => entry.id).join(':');
  return `${workId}:groups:${groupIds}`;
}

function summarizeWorkGroups(groups: CodexWorkGroup[], refs: CodexWorkGroupRef[] = []) {
  if (groups.every((group) => !groupHasDetails(group))) {
    return refs.map((group) => group.title).filter(Boolean).join(', ');
  }

  const fileGroups = groups.filter((group) => group.type === 'files');
  const activityGroups = groups.filter((group) => group.type === 'activity');
  const toolGroups = groups.filter((group) => group.type === 'tools');
  const primaryGroups = [...fileGroups, ...activityGroups, ...toolGroups];
  const summaryGroups = primaryGroups.length > 0 ? primaryGroups : groups;
  const changedFilePaths = new Set(
    fileGroups.flatMap((group) => group.files.map((file) => normalizePath(file.path))),
  );

  return summaryGroups
    .map((group, index) => {
      const title =
        group.type === 'activity' && changedFilePaths.size > 0
          ? summarizeActivityWithoutChangedReads(group, changedFilePaths)
          : group.title;
      return title ? (index === 0 ? title : lowerFirst(title)) : null;
    })
    .filter((title): title is string => Boolean(title))
    .join(', ');
}

function summarizeActivityWithoutChangedReads(
  group: CodexActivityWorkGroup,
  changedFilePaths: Set<string>,
) {
  const activities = group.activities.filter(
    (activity) => activity.kind !== 'read' || !activity.path || !changedFilePaths.has(normalizePath(activity.path)),
  );
  const reads = new Set(
    activities
      .filter((activity) => activity.kind === 'read')
      .map((activity) => activity.path ?? activity.text),
  ).size;
  const lists = new Set(
    activities
      .filter((activity) => activity.kind === 'list')
      .map((activity) => activity.path ?? activity.text),
  ).size;
  const searches = activities.filter((activity) => activity.kind === 'search' || activity.kind === 'webSearch').length;
  const commands = activities.filter((activity) => activity.kind === 'command').length;
  const explored = [
    reads ? formatCount(reads, 'file') : null,
    lists ? formatCount(lists, 'list') : null,
    searches ? formatCount(searches, 'search', 'searches') : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(', ');

  return joinSummaryParts([
    explored ? `Explored ${explored}` : null,
    commands ? `Ran ${formatCount(commands, 'command')}` : null,
  ]);
}

function summaryIcon(groups: CodexWorkGroup[]) {
  const files = groups.find((group) => group.type === 'files');
  if (files) {
    return groupIcon(files);
  }

  const activity = groups.find((group) => group.type === 'activity');
  if (activity) {
    return groupIcon(activity);
  }

  const tools = groups.find((group) => group.type === 'tools');
  if (tools) {
    return groupIcon(tools);
  }

  return groupIcon(groups[0]);
}

function groupIcon(group: CodexWorkGroup | undefined) {
  if (!group) {
    return Sparkles;
  }

  switch (group.type) {
    case 'files':
      return FilePenLine;
    case 'activity':
      if (group.activities.some((activity) => activity.kind === 'approval')) {
        return ShieldCheck;
      }
      if (group.activities.some((activity) => activity.kind === 'search' || activity.kind === 'webSearch')) {
        return Search;
      }
      if (group.activities.some((activity) => activity.kind === 'list' || activity.kind === 'read')) {
        return FolderOpen;
      }
      return TerminalSquare;
    case 'text':
      return group.id === 'plans' ? ListChecks : Sparkles;
    case 'tools':
      return Wrench;
  }
}

function groupHasDetails(group: CodexWorkGroup) {
  switch (group.type) {
    case 'activity':
      return group.activities.length > 0;
    case 'files':
      return group.files.length > 0;
    case 'text':
      return group.lines.length > 0;
    case 'tools':
      return group.rows.length > 0;
  }
}

function kindLabel(kind: CodexFileChange['kind']) {
  switch (kind) {
    case 'added':
      return 'Added';
    case 'deleted':
      return 'Deleted';
    case 'moved':
      return 'Moved';
    default:
      return 'Edited';
  }
}

function fileName(path: string) {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).at(-1) ?? path;
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'failed') {
    return <XCircle className="size-4 shrink-0 text-destructive" />;
  }

  if (status === 'inProgress') {
    return <CircleSlash className="size-4 shrink-0 text-warning" />;
  }

  return <CheckCircle2 className="size-4 shrink-0 text-success" />;
}

function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function joinSummaryParts(parts: (string | null)[]) {
  return parts
    .filter((part): part is string => Boolean(part))
    .map((part, index) => (index === 0 ? part : lowerFirst(part)))
    .join(', ');
}

function lowerFirst(value: string) {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function normalizePath(path: string) {
  return path.replace(/\\/g, '/');
}
