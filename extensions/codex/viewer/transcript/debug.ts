import type { CodexResourceInvalidation } from '../../shared/threadCommands';
import type {
  CodexTranscriptSegment,
  CodexTranscriptTurn,
  CodexWorkDetails,
  CodexWorkEntry,
  CodexWorkItem,
} from '../../shared/transcript';

const maxDebugArrayItems = 40;
const maxDebugDepth = 8;
const maxDebugObjectKeys = 80;
const maxDebugPayloadLength = 8000;
const maxDebugPayloadPreviewLength = 4000;
const maxDebugStringLength = 500;

export function transcriptDebugEnabled() {
  const globalOverride = (globalThis as { __REMUX_CODEX_TRANSCRIPT_DEBUG__?: unknown })
    .__REMUX_CODEX_TRANSCRIPT_DEBUG__;
  if (typeof globalOverride === 'boolean') {
    return globalOverride;
  }
  if (globalOverride === '1' || globalOverride === 'true') {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    return (
      params.has('codexTranscriptDebug') ||
      window.localStorage.getItem('remux.codex.transcriptDebug') === '1'
    );
  } catch {
    return false;
  }
}

export function logTranscriptDebug(
  label: string,
  payload: unknown,
  options: { warn?: boolean } = {},
) {
  if (!transcriptDebugEnabled()) {
    return;
  }

  const method = options.warn ? console.warn : console.info;
  method.call(console, `[codex transcript] ${label} ${formatTranscriptDebugPayload(payload)}`);
}

function formatTranscriptDebugPayload(payload: unknown) {
  const normalized = normalizeDebugValue(payload, 0, new WeakSet<object>());
  let serialized: string;
  try {
    serialized = JSON.stringify(normalized) ?? String(normalized);
  } catch (error) {
    serialized = JSON.stringify({
      serializationError: error instanceof Error ? error.message : String(error),
    }) ?? '{"serializationError":"unknown"}';
  }

  if (serialized.length <= maxDebugPayloadLength) {
    return serialized;
  }

  return JSON.stringify({
    originalLength: serialized.length,
    preview: serialized.slice(0, maxDebugPayloadPreviewLength),
    truncated: true,
  });
}

function normalizeDebugValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    if (value.length <= maxDebugStringLength) {
      return value;
    }

    return `${value.slice(0, maxDebugStringLength)}...<truncated ${value.length - maxDebugStringLength} chars>`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }

  if (typeof value === 'symbol' || typeof value === 'function') {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack ? summarizeDebugStack(value.stack) : undefined,
    };
  }

  if (depth >= maxDebugDepth) {
    return '[MaxDepth]';
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const normalizedItems = value
        .slice(0, maxDebugArrayItems)
        .map((item) => normalizeDebugValue(item, depth + 1, seen));

      if (value.length > maxDebugArrayItems) {
        normalizedItems.push({
          truncatedItems: value.length - maxDebugArrayItems,
        });
      }

      return normalizedItems;
    }

    const entries = Object.entries(value);
    const normalizedObject: Record<string, unknown> = {};
    for (const [key, entryValue] of entries.slice(0, maxDebugObjectKeys)) {
      normalizedObject[key] = normalizeDebugValue(entryValue, depth + 1, seen);
    }

    if (entries.length > maxDebugObjectKeys) {
      normalizedObject.truncatedKeys = entries.length - maxDebugObjectKeys;
    }

    return normalizedObject;
  } finally {
    seen.delete(value);
  }
}

function summarizeDebugStack(stack: string) {
  return stack.split('\n').slice(0, 8).join('\n');
}

export function duplicateStrings(ids: readonly string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    } else {
      seen.add(id);
    }
  }
  return Array.from(duplicates);
}

export function summarizeInvalidations(invalidations: readonly CodexResourceInvalidation[]) {
  const types = new Map<string, number>();
  const workItems: Array<{ itemId: string; key: string; reason: string; threadId: string; turnId: string }> = [];

  for (const invalidation of invalidations) {
    types.set(invalidation.type, (types.get(invalidation.type) ?? 0) + 1);
    if (invalidation.type === 'workItem') {
      workItems.push({
        itemId: invalidation.itemId,
        key: invalidation.key,
        reason: invalidation.reason,
        threadId: invalidation.threadId,
        turnId: invalidation.turnId,
      });
    }
  }

  return {
    count: invalidations.length,
    duplicateWorkItemKeys: duplicateStrings(workItems.map((item) => item.key)),
    duplicateWorkItemResourceIds: duplicateStrings(workItems.map((item) =>
      `${item.threadId}:${item.turnId}:${item.itemId}`)),
    types: Object.fromEntries(types),
    workItems,
  };
}

export function summarizeTranscriptTurns(turns: readonly CodexTranscriptTurn[]) {
  return turns.map((turn, turnIndex) => {
    const segments = turn.segments.map((segment, segmentIndex) => summarizeSegment(segment, segmentIndex));
    const workSegmentIds = segments.filter((segment) => segment.type === 'work').map((segment) => segment.id);
    return {
      duplicateSegmentIds: duplicateStrings(segments.map((segment) => segment.id)),
      duplicateWorkSegmentIds: duplicateStrings(workSegmentIds),
      revision: turn.revision,
      segmentCount: turn.segments.length,
      segments,
      status: turn.status,
      turnId: turn.id,
      turnIndex,
    };
  });
}

export function summarizeWorkDetails(details: CodexWorkDetails | null | undefined) {
  if (!details) {
    return null;
  }

  const renderItemIds = workEntryRenderItemIds(details.entries);
  const entryIds = details.entries.map((entry) => entry.id);

  return {
    duplicateEntryIds: duplicateStrings(entryIds),
    duplicateItemIds: duplicateStrings(details.itemIds),
    duplicateRenderItemIds: duplicateStrings(renderItemIds),
    entries: details.entries.map(summarizeWorkEntry),
    entryIds,
    itemIds: details.itemIds,
    renderItemIds,
    revision: details.revision,
    segmentId: details.segmentId,
  };
}

export function summarizeWorkItem(item: CodexWorkItem | null | undefined) {
  if (!item) {
    return null;
  }

  switch (item.type) {
    case 'activity':
      return {
        activityId: item.activity.id,
        command: summarizeText(item.activity.command),
        detail: summarizeText(item.activity.detail),
        id: item.id,
        kind: item.activity.kind,
        output: summarizeText(item.activity.output),
        path: item.activity.path,
        status: item.activity.status,
        text: item.activity.text,
        type: item.type,
      };
    case 'compaction':
      return {
        id: item.id,
        status: item.status,
        type: item.type,
      };
    case 'fileChanges':
      return {
        files: item.files.map((file) => ({
          id: file.id,
          kind: file.kind,
          path: file.path,
          status: file.status,
        })),
        id: item.id,
        type: item.type,
      };
    case 'message':
      return {
        id: item.id,
        phase: item.phase,
        text: summarizeText(item.text),
        type: item.type,
      };
    case 'tool':
      return {
        detail: summarizeText(item.row.detail),
        id: item.id,
        label: item.row.label,
        mediaIds: item.row.media.map((media) => media.id),
        result: summarizeText(item.row.result),
        rowId: item.row.id,
        status: item.row.status,
        type: item.type,
      };
    case 'userMessage':
      return {
        contentParts: item.content.length,
        id: item.id,
        type: item.type,
      };
  }
}

function summarizeSegment(segment: CodexTranscriptSegment, segmentIndex: number) {
  switch (segment.type) {
    case 'assistantMessage':
      return {
        id: segment.id,
        phase: segment.phase,
        revision: segment.revision,
        segmentIndex,
        text: summarizeText(segment.text),
        type: segment.type,
      };
    case 'compaction':
      return {
        id: segment.id,
        revision: segment.revision,
        segmentIndex,
        status: segment.status,
        type: segment.type,
      };
    case 'userMessage':
      return {
        contentParts: segment.content.length,
        id: segment.id,
        revision: segment.revision,
        segmentIndex,
        type: segment.type,
      };
    case 'work':
      return {
        durationMs: segment.durationMs,
        hasDetails: segment.hasDetails,
        id: segment.id,
        revision: segment.revision,
        segmentIndex,
        state: segment.state,
        type: segment.type,
      };
  }
}

function summarizeWorkEntry(entry: CodexWorkEntry) {
  if (entry.type === 'group') {
    return {
      duplicateItemIds: duplicateStrings(entry.group.itemIds),
      entryId: entry.id,
      groupId: entry.group.id,
      groupType: entry.group.type,
      itemIds: entry.group.itemIds,
      title: entry.group.title,
      type: entry.type,
    };
  }

  return {
    entryId: entry.id,
    itemId: entry.itemId,
    type: entry.type,
  };
}

function workEntryRenderItemIds(entries: readonly CodexWorkEntry[]) {
  const itemIds: string[] = [];
  for (const entry of entries) {
    if (entry.type === 'group') {
      itemIds.push(...entry.group.itemIds);
    } else {
      itemIds.push(entry.itemId);
    }
  }
  return itemIds;
}

function summarizeText(text: string | null | undefined) {
  if (!text) {
    return null;
  }

  return {
    fingerprint: fingerprintText(text),
    length: text.length,
    preview: text.slice(0, 160),
  };
}

function fingerprintText(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}
