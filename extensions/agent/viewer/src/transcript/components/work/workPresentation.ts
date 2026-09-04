import type { AgentToolCallSummary } from '../../../../../shared/transcript.ts';

export function summarizeActionRun(calls: AgentToolCallSummary[]) {
  const active = [...calls].reverse().find(({ status }) => status === 'running');
  if (active) return activeActionLabel(active);

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
    counts.read ? `Read ${formatCount(counts.read, 'file')}` : null,
    editedSummary,
    counts.command ? `Ran ${formatCount(counts.command, 'command')}` : null,
    counts.search ? `Searched ${formatCount(counts.search, 'time')}` : null,
    counts.context ? `Used ${formatCount(counts.context, 'context tool')}` : null,
    counts.tool ? `Used ${formatCount(counts.tool, 'tool')}` : null,
  ]) || 'Tool activity';
}

export function actionRunActivityKind(calls: AgentToolCallSummary[]) {
  const active = [...calls].reverse().find(({ status }) => status === 'running');
  if (active) return active.presentation.category;
  if (calls.some((call) => call.presentation.category === 'command')) return 'command';
  if (calls.some((call) => call.presentation.category === 'edit')) return 'edit';
  if (calls.some((call) => call.presentation.category === 'search')) return 'search';
  if (calls.some((call) => call.presentation.category === 'read')) return 'read';
  if (calls.some((call) => call.presentation.category === 'context')) return 'context';
  return 'tool';
}

function activeActionLabel(call: AgentToolCallSummary) {
  const label = call.presentation.label.trim();
  if (/^(?:adding|deleting|editing|listing|moving|reading|running|searching|using)\b/iu.test(label)) {
    return label;
  }
  const subject = call.presentation.subject?.trim();
  switch (call.presentation.category) {
    case 'edit':
      return `Editing ${subject ? fileName(subject) : label || 'files'}`;
    case 'read':
      return `Reading ${subject ? fileName(subject) : label || 'file'}`;
    case 'search':
      return `Searching ${subject || label || 'files'}`;
    case 'command':
      return `Running ${label || 'command'}`;
    case 'context':
    case 'tool':
      return `Using ${label || 'tool'}`;
  }
}

function formatCount(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function joinSummaryParts(parts: Array<string | null>) {
  const visible = parts.filter((part): part is string => Boolean(part));
  if (visible.length <= 1) return visible[0] ?? '';
  const normalized = visible.map((part, index) => index === 0 ? part : lowerFirst(part));
  if (normalized.length === 2) return `${normalized[0]} and ${normalized[1]}`;
  return `${normalized.slice(0, -1).join(', ')}, and ${normalized.at(-1)}`;
}

function lowerFirst(value: string) {
  return value ? `${value[0]!.toLowerCase()}${value.slice(1)}` : value;
}

function fileName(path: string) {
  const segments = path.replace(/\\/gu, '/').split('/').filter(Boolean);
  return segments.at(-1) ?? path;
}
