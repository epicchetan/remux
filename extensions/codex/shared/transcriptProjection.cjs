function projectTurnToTranscriptTurn(turn) {
  const segments = [];
  const assistantAnswerIds = finalAssistantAnswerIds(turn.items ?? []);
  const compactionStatusByItemId = compactionStatusesForTurn(turn);
  let workIndex = 0;
  let sawPrimaryUserMessage = false;
  let pendingWork = [];

  function flushWork(reason = 'boundary') {
    if (pendingWork.length === 0) {
      return;
    }

    const state = workState(turn, pendingWork, reason);
    const id = `${turn.id}:work:${workIndex}`;
    segments.push({
      durationMs: turn.durationMs ?? null,
      hasDetails: pendingWork.length > 0,
      id,
      revision: revision(['work', id, state, turn.durationMs ?? '', pendingWork.map(itemRevision).join('|')]),
      state,
      type: 'work',
    });
    pendingWork = [];
    workIndex += 1;
  }

  for (const item of turn.items ?? []) {
    if (item.type === 'userMessage') {
      if (!sawPrimaryUserMessage) {
        sawPrimaryUserMessage = true;
        flushWork();
        segments.push({
          content: item.content ?? [],
          id: item.id,
          revision: revision(['user', item.id, jsonLength(item.content)]),
          type: 'userMessage',
        });
      } else if (pendingWork.length > 0 || hasUpcomingWorkItem(turn.items ?? [], item, assistantAnswerIds)) {
        pendingWork.push(item);
      } else {
        flushWork();
        segments.push({
          content: item.content ?? [],
          id: item.id,
          revision: revision(['user', item.id, jsonLength(item.content)]),
          type: 'userMessage',
        });
      }
      continue;
    }

    if (item.type === 'contextCompaction') {
      if (pendingWork.length > 0 || hasUpcomingWorkItem(turn.items ?? [], item, assistantAnswerIds)) {
        pendingWork.push(item);
      } else {
        flushWork();
        const status = compactionStatusByItemId[item.id] ?? compactionStatus(turn.status);
        pushCompactionSegment(segments, {
          id: item.id,
          revision: revision(['compaction', item.id, status]),
          status,
          type: 'compaction',
        });
      }
      continue;
    }

    if (item.type === 'agentMessage' && assistantAnswerIds.has(item.id)) {
      flushWork('finalAssistantStarted');
      if ((item.text ?? '').trim()) {
        segments.push({
          id: item.id,
          phase: item.phase ?? null,
          revision: revision(['assistant', item.id, item.phase ?? '', item.text ?? '']),
          text: item.text ?? '',
          type: 'assistantMessage',
        });
      }
      continue;
    }

    if (item.type === 'reasoning') {
      continue;
    }

    pendingWork.push(item);
  }

  flushWork('endOfTurn');

  return {
    completedAt: turn.completedAt ?? null,
    durationMs: turn.durationMs ?? null,
    error: turn.error ?? null,
    id: turn.id,
    revision: revision([
      'turn',
      turn.id,
      turn.status,
      turn.startedAt ?? '',
      turn.completedAt ?? '',
      turn.durationMs ?? '',
      segments.map((segment) => segment.revision).join('|'),
    ]),
    segments,
    startedAt: turn.startedAt ?? null,
    status: turn.status,
  };
}

function projectTurnToTurnDetails(turn) {
  const assistantAnswerIds = finalAssistantAnswerIds(turn.items ?? []);
  const compactionStatusByItemId = compactionStatusesForTurn(turn);
  const workBySegmentId = {};
  let workIndex = 0;
  let sawPrimaryUserMessage = false;
  let pendingWork = [];

  function flushWork() {
    if (pendingWork.length === 0) {
      return;
    }

    const segmentId = `${turn.id}:work:${workIndex}`;
    const entries = buildWorkEntries(pendingWork, {
      compactionStatusByItemId,
      turnId: turn.id,
      turnStatus: turn.status,
    });
    workBySegmentId[segmentId] = {
      entries,
      revision: revision(['details', segmentId, entries.map(workEntryRevision).join('|')]),
      segmentId,
    };
    pendingWork = [];
    workIndex += 1;
  }

  for (const item of turn.items ?? []) {
    if (item.type === 'userMessage') {
      if (!sawPrimaryUserMessage) {
        sawPrimaryUserMessage = true;
        flushWork();
      } else if (pendingWork.length > 0 || hasUpcomingWorkItem(turn.items ?? [], item, assistantAnswerIds)) {
        pendingWork.push(item);
      } else {
        flushWork();
      }
      continue;
    }

    if (item.type === 'contextCompaction') {
      if (pendingWork.length > 0 || hasUpcomingWorkItem(turn.items ?? [], item, assistantAnswerIds)) {
        pendingWork.push(item);
      } else {
        flushWork();
      }
      continue;
    }

    if (item.type === 'agentMessage' && assistantAnswerIds.has(item.id)) {
      flushWork();
      continue;
    }

    if (item.type === 'reasoning') {
      continue;
    }

    pendingWork.push(item);
  }

  flushWork();

  return {
    revision: revision(['turnDetails', turn.id, Object.values(workBySegmentId).map((details) => details.revision).join('|')]),
    turnId: turn.id,
    workBySegmentId,
  };
}

function projectWorkItemsToEntries(items, options) {
  return buildWorkEntries(items, options);
}

function projectWorkItemsToGroups(items) {
  return buildWorkGroups(items);
}

function buildWorkEntries(items, options) {
  const entries = [];
  let pendingItems = [];
  let groupIndex = 0;

  function flushPendingItems() {
    if (pendingItems.length === 0) {
      return;
    }

    for (const group of buildWorkGroups(pendingItems)) {
      entries.push({
        group,
        id: `group:${groupIndex}:${group.id}`,
        type: 'group',
      });
      groupIndex += 1;
    }
    pendingItems = [];
  }

  for (const item of items) {
    if (item.type === 'agentMessage') {
      flushPendingItems();
      entries.push({
        id: item.id,
        phase: item.phase ?? null,
        text: item.text ?? '',
        type: 'message',
      });
    } else if (item.type === 'userMessage') {
      flushPendingItems();
      entries.push({
        content: item.content ?? [],
        id: item.id,
        type: 'userMessage',
      });
    } else if (item.type === 'contextCompaction') {
      flushPendingItems();
      const status = compactionEntryStatus(item, options);
      const lastEntry = entries.at(-1);
      if (lastEntry?.type === 'compaction') {
        lastEntry.status = mergeCompactionStatus(lastEntry.status, status);
      } else {
        entries.push({
          id: item.id,
          status,
          type: 'compaction',
        });
      }
    } else if (item.type !== 'remuxWorkSummary') {
      pendingItems.push(item);
    }
  }

  flushPendingItems();
  return entries;
}

function buildWorkGroups(items) {
  const files = fileChanges(items);
  const activities = workActivities(items);
  const plans = planLines(items);
  const tools = toolRows(items);
  const groups = [];

  if (files.length > 0) {
    groups.push({
      group: {
        files,
        id: 'files',
        title: summarizeFiles(files),
        type: 'files',
      },
      order: firstItemIndex(items, (item) => item.type === 'fileChange'),
    });
  }

  if (activities.length > 0) {
    groups.push({
      group: {
        activities,
        id: 'activity',
        title: summarizeActivity(activities),
        type: 'activity',
      },
      order: firstItemIndex(items, (item) => item.type === 'commandExecution' || item.type === 'webSearch'),
    });
  }

  if (plans.length > 0) {
    groups.push({
      group: {
        id: 'plans',
        lines: plans,
        title: 'Planned',
        type: 'text',
      },
      order: firstItemIndex(items, (item) => item.type === 'plan'),
    });
  }

  if (tools.length > 0) {
    groups.push({
      group: {
        id: 'tools',
        rows: tools,
        title: summarizeTools(tools),
        type: 'tools',
      },
      order: firstItemIndex(items, isToolLikeItem),
    });
  }

  return groups.sort((left, right) => left.order - right.order).map(({ group }) => group);
}

function fileChanges(items) {
  return items.flatMap((item) => {
    if (item.type !== 'fileChange') {
      return [];
    }

    return (item.changes ?? []).map((change) => {
      const kind = fileKind(change);
      return {
        ...diffStats(change.diff ?? '', kind),
        diff: change.diff ?? '',
        id: `${item.id}:${change.path}`,
        kind,
        path: change.path,
        status: item.status,
      };
    });
  });
}

function workActivities(items) {
  const activities = [];

  for (const item of items) {
    if (item.type === 'commandExecution') {
      for (const [index, action] of (item.commandActions ?? []).entries()) {
        const activity = commandActionActivity(item, action, index);
        if (activity) {
          activities.push(activity);
        }
      }
      if (shouldShowCommandActivity(item)) {
        activities.push(commandActivity(item));
      }
    } else if (item.type === 'webSearch') {
      activities.push({
        command: null,
        detail: item.query ?? null,
        durationMs: null,
        exitCode: null,
        id: item.id,
        kind: 'webSearch',
        output: null,
        path: null,
        status: 'completed',
        text: item.query ? `Searched web for ${item.query}` : 'Searched web',
      });
    }
  }

  return groupRepeatedReadActivities(activities);
}

function commandActivity(item) {
  return {
    command: item.command,
    detail: item.cwd,
    durationMs: item.durationMs,
    exitCode: item.exitCode,
    id: item.id,
    kind: 'command',
    output: item.aggregatedOutput,
    path: null,
    status: item.status,
    text: `${commandVerb(item.status)} ${item.command}`,
  };
}

function shouldShowCommandActivity(item) {
  if ((item.commandActions ?? []).length === 0) {
    return true;
  }

  return item.commandActions.some((action) => action.type === 'unknown');
}

function groupRepeatedReadActivities(activities) {
  const seenReadKeys = new Set();
  const grouped = [];

  for (const activity of activities) {
    if (activity.kind !== 'read') {
      grouped.push(activity);
      continue;
    }

    const key = activity.path ?? activity.text;
    if (seenReadKeys.has(key)) {
      continue;
    }

    seenReadKeys.add(key);
    grouped.push(activity);
  }

  return grouped;
}

function commandActionActivity(item, action, index) {
  switch (action.type) {
    case 'read':
      return {
        command: null,
        detail: null,
        durationMs: item.durationMs,
        exitCode: item.exitCode,
        id: `${item.id}:read:${index}`,
        kind: 'read',
        output: null,
        path: normalizePath(action.path),
        status: item.status,
        text: `Read ${action.name || formatActionPath(action.path)}`,
      };
    case 'listFiles':
      return {
        command: null,
        detail: null,
        durationMs: item.durationMs,
        exitCode: item.exitCode,
        id: `${item.id}:list:${index}`,
        kind: 'list',
        output: null,
        path: normalizePath(action.path),
        status: item.status,
        text: action.path ? `Listed files in ${formatActionPath(action.path)}` : 'Listed files',
      };
    case 'search':
      return {
        command: null,
        detail: null,
        durationMs: item.durationMs,
        exitCode: item.exitCode,
        id: `${item.id}:search:${index}`,
        kind: 'search',
        output: null,
        path: normalizePath(action.path),
        status: item.status,
        text: action.query ? `Searched "${action.query}"` : action.path ? `Searched ${formatActionPath(action.path)}` : `Searched ${action.command}`,
      };
    default:
      return null;
  }
}

function reasoningLines(items) {
  return items.flatMap((item) => item.type === 'reasoning' ? ((item.summary ?? []).length > 0 ? item.summary : item.content ?? []) : []);
}

function planLines(items) {
  return items.flatMap((item) => item.type === 'plan' ? String(item.text ?? '').split('\n').map((line) => line.trim()).filter(Boolean) : []);
}

function toolRows(items) {
  return items.flatMap((item) => {
    switch (item.type) {
      case 'mcpToolCall':
        if (isSuppressedToolName(item.tool)) {
          return [];
        }
        return {
          category: toolCategory(item),
          detail: toolDetail(`${item.server}.${item.tool}`, item.arguments),
          id: item.id,
          label: `${toolVerb(item.status)} ${toolDisplayName(item.tool)}`,
          media: [],
          result: item.error?.message ?? contentText(item.result?.content) ?? compactJson(item.result?.structuredContent ?? null),
          status: item.status,
        };
      case 'dynamicToolCall':
        if (isSuppressedToolName(item.tool)) {
          return [];
        }
        return {
          category: toolCategory(item),
          detail: toolDetail(`${item.namespace ? `${item.namespace}.` : ''}${item.tool}`, item.arguments),
          id: item.id,
          label: `${toolVerb(item.status)} ${toolDisplayName(item.tool)}`,
          media: [],
          result: item.success === false ? 'failed' : outputText(item.contentItems),
          status: item.status,
        };
      case 'collabAgentToolCall':
        return {
          category: 'generic',
          detail: item.prompt ?? ((item.receiverThreadIds ?? []).join(', ') || item.tool),
          id: item.id,
          label: `${toolVerb(item.status)} agent ${item.tool}`,
          media: [],
          result: null,
          status: item.status,
        };
      case 'imageGeneration':
        return {
          category: 'image',
          detail: item.savedPath ?? item.revisedPrompt ?? 'Generated image',
          id: item.id,
          label: item.status === 'inProgress' ? 'Generating image' : 'Generated image',
          media: [],
          result: null,
          status: item.status,
        };
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        return {
          category: 'generic',
          detail: item.review,
          id: item.id,
          label: item.type === 'enteredReviewMode' ? 'Entered review mode' : 'Exited review mode',
          media: [],
          result: null,
          status: 'completed',
        };
      case 'hookPrompt':
        return {
          category: 'generic',
          detail: (item.fragments ?? []).map((fragment) => fragment.text).join('\n'),
          id: item.id,
          label: 'Ran hook',
          media: [],
          result: null,
          status: 'completed',
        };
      default:
        return [];
    }
  });
}

function isToolLikeItem(item) {
  return ['mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'imageView', 'imageGeneration', 'enteredReviewMode', 'exitedReviewMode', 'hookPrompt'].includes(item.type);
}

function toolCategory(item) {
  const normalized = toolDisplayName(item.tool ?? '').toLowerCase();
  if (item.type === 'mcpToolCall') {
    const server = toolDisplayName(item.server ?? '').toLowerCase();
    if (server === 'node repl' || server === 'node-repl' || server === 'node_repl' || item.tool === 'js') {
      return 'nodeRepl';
    }
  }
  if (normalized.includes('browser') || item.namespace === 'browser') {
    return 'browser';
  }
  return 'generic';
}

function summarizeTools(rows) {
  const running = rows.filter((row) => row.status === 'inProgress').length;
  if (running > 0) {
    return `Using ${formatCount(running, 'connector')}`;
  }
  return `Used ${formatCount(rows.length, 'connector')}`;
}

function workState(turn, items, reason = 'boundary') {
  if (turn.status === 'interrupted') {
    return 'interrupted';
  }
  if (turn.status === 'failed') {
    return 'failed';
  }
  if (items.some((item) => itemStatus(item) === 'inProgress')) {
    return 'running';
  }
  if (turn.status === 'inProgress' && reason === 'endOfTurn') {
    return 'running';
  }
  return 'completed';
}

function itemStatus(item) {
  if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'collabAgentToolCall' || item.type === 'imageGeneration') {
    return item.status;
  }
  return null;
}

function finalAssistantAnswerIds(items) {
  const lastWorkItemIndex = items.reduce((lastIndex, item, index) => {
    if (item.type === 'userMessage' || item.type === 'contextCompaction') {
      return lastIndex;
    }
    if (item.type === 'agentMessage' && isFinalAnswer(item)) {
      return lastIndex;
    }
    return index;
  }, -1);

  return new Set(items.flatMap((item, index) => item.type === 'agentMessage' && isFinalAnswer(item) && index > lastWorkItemIndex ? item.id : []));
}

function hasUpcomingWorkItem(items, currentItem, assistantAnswerIds) {
  const startIndex = items.indexOf(currentItem) + 1;
  for (let index = startIndex; index < items.length; index += 1) {
    const item = items[index];
    if (item.type === 'userMessage') {
      return false;
    }
    if (item.type === 'agentMessage' && assistantAnswerIds.has(item.id)) {
      return false;
    }
    if (item.type === 'reasoning') {
      continue;
    }
    if (item.type !== 'contextCompaction') {
      return true;
    }
  }
  return false;
}

function isFinalAnswer(item) {
  return item.phase === 'final_answer' || item.phase === null;
}

function pushCompactionSegment(segments, segment) {
  const last = segments.at(-1);
  if (last?.type === 'compaction') {
    last.status = mergeCompactionStatus(last.status, segment.status);
    last.revision = revision(['compaction', last.id, last.status]);
    return;
  }
  segments.push(segment);
}

function compactionStatus(turnStatus) {
  if (turnStatus === 'inProgress') {
    return 'compacting';
  }
  if (turnStatus === 'interrupted' || turnStatus === 'failed') {
    return 'cancelled';
  }
  return 'compacted';
}

function compactionStatusesForTurn(turn) {
  const statuses = {};
  const items = turn.items ?? [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.type !== 'contextCompaction') {
      continue;
    }

    statuses[item.id] = compactionStatusForPosition(turn.status, items, index);
  }
  return statuses;
}

function compactionStatusForPosition(turnStatus, items, index) {
  if (hasLaterMaterialItem(items, index)) {
    return 'compacted';
  }
  return compactionStatus(turnStatus);
}

function hasLaterMaterialItem(items, startIndex) {
  for (let index = startIndex + 1; index < items.length; index += 1) {
    const item = items[index];
    if (item.type === 'reasoning' || item.type === 'remuxWorkSummary') {
      continue;
    }
    return true;
  }
  return false;
}

function compactionEntryStatus(item, options) {
  return options?.compactionStatusByItemId?.[item.id] ?? compactionStatus(options?.turnStatus);
}

function mergeCompactionStatus(left, right) {
  if (left === 'compacting' || right === 'compacting') {
    return 'compacting';
  }
  if (left === 'cancelled' || right === 'cancelled') {
    return 'cancelled';
  }
  return 'compacted';
}

function fileKind(change) {
  switch (change.kind?.type) {
    case 'add':
      return 'added';
    case 'delete':
      return 'deleted';
    case 'update':
      return change.kind.move_path ? 'moved' : 'edited';
    default:
      return 'edited';
  }
}

function diffStats(diff, kind) {
  const stats = diff.split('\n').reduce((result, line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      result.additions += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      result.deletions += 1;
    }
    return result;
  }, { additions: 0, deletions: 0 });
  if (stats.additions > 0 || stats.deletions > 0 || kind === 'edited' || kind === 'moved') {
    return stats;
  }
  const lineCount = diff.split('\n').filter(Boolean).length;
  return kind === 'added' ? { additions: lineCount, deletions: 0 } : kind === 'deleted' ? { additions: 0, deletions: lineCount } : stats;
}

function summarizeFiles(files) {
  const edited = files.filter((file) => file.kind === 'edited').length;
  const added = files.filter((file) => file.kind === 'added').length;
  const deleted = files.filter((file) => file.kind === 'deleted').length;
  const moved = files.filter((file) => file.kind === 'moved').length;
  const total = files.length;
  if (total > 1 && total !== edited && total !== added && total !== deleted && total !== moved) {
    return `Edited ${formatCount(total, 'file')}`;
  }
  return joinSummaryParts([
    edited ? `Edited ${formatCount(edited, 'file')}` : null,
    added ? `Added ${formatCount(added, 'file')}` : null,
    deleted ? `Deleted ${formatCount(deleted, 'file')}` : null,
    moved ? `Moved ${formatCount(moved, 'file')}` : null,
  ]);
}

function summarizeActivity(activities) {
  const reads = uniqueActivityTargetCount(activities, 'read');
  const lists = uniqueActivityTargetCount(activities, 'list');
  const searches = activities.filter((activity) => activity.kind === 'search' || activity.kind === 'webSearch').length;
  const running = activities.filter((activity) => activity.kind === 'command' && activity.status === 'inProgress').length;
  const commands = activities.filter((activity) => activity.kind === 'command').length;
  const explored = [
    reads ? formatCount(reads, 'file') : null,
    lists ? formatCount(lists, 'list') : null,
    searches ? formatCount(searches, 'search', 'searches') : null,
  ].filter(Boolean).join(', ');
  return joinSummaryParts([
    explored ? `Explored ${explored}` : null,
    running ? `Running ${formatCount(running, 'command')}` : null,
    commands && !running ? `Ran ${formatCount(commands, 'command')}` : null,
  ]);
}

function uniqueActivityTargetCount(activities, kind) {
  return new Set(activities.filter((activity) => activity.kind === kind).map((activity) => activity.path ?? activity.text)).size;
}

function firstItemIndex(items, predicate) {
  const index = items.findIndex(predicate);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function toolVerb(status) {
  return status === 'inProgress' ? 'Running' : status === 'failed' ? 'Failed' : 'Ran';
}

function commandVerb(status) {
  return status === 'inProgress' ? 'Running' : status === 'declined' ? 'Declined' : 'Ran';
}

function toolDisplayName(name) {
  return String(name ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSuppressedToolName(name) {
  const normalized = toolDisplayName(name).toLowerCase();
  return normalized === 'write stdin' || normalized === 'update plan';
}

function toolDetail(toolName, argumentsValue) {
  const formattedArguments = compactJson(argumentsValue);
  return !formattedArguments || formattedArguments === '{}' ? toolName : `${toolName} ${formattedArguments}`;
}

function outputText(items) {
  if (!Array.isArray(items)) {
    return null;
  }
  return items.map((item) => item.text ?? '').filter(Boolean).join('\n') || null;
}

function contentText(items) {
  if (!Array.isArray(items)) {
    return null;
  }
  return items.map((item) => item?.text).filter((value) => typeof value === 'string' && value).join('\n') || null;
}

function compactJson(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function formatActionPath(path) {
  if (path === '.') {
    return '.';
  }
  const parts = String(path ?? '').split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function normalizePath(path) {
  return path ? String(path).replace(/\\/g, '/') : null;
}

function formatCount(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function joinSummaryParts(parts) {
  return parts.filter(Boolean).map((part, index) => index === 0 ? part : lowerFirst(part)).join(', ');
}

function lowerFirst(value) {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function itemRevision(item) {
  return revision([item.type, item.id ?? '', item.status ?? '', item.phase ?? '', item.text ?? '', jsonLength(item)]);
}

function workEntryRevision(entry) {
  return revision([entry.type, entry.id, jsonLength(entry)]);
}

function revision(parts) {
  return parts.map((part) => String(part)).join(':');
}

function jsonLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

module.exports = {
  projectWorkItemsToEntries,
  projectWorkItemsToGroups,
  projectTurnToTranscriptTurn,
  projectTurnToTurnDetails,
};
