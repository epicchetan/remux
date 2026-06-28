import type { CodexThreadSummary } from '../../shared/threads';
import { formatHomePath } from '../utils/path';

export function threadTitle(thread: CodexThreadSummary) {
  return thread.title || thread.name?.trim() || thread.preview.split('\n')[0]?.slice(0, 48) || 'Untitled thread';
}

export function shortenPath(path: string | null) {
  return path ? formatHomePath(path) : '';
}

export function formatRelativeTime(seconds: number) {
  const elapsed = Math.max(0, nowSeconds() - seconds);

  if (elapsed < 60) {
    return 'now';
  }
  if (elapsed < 3600) {
    return `${Math.floor(elapsed / 60)}m`;
  }
  if (elapsed < 86400) {
    return `${Math.floor(elapsed / 3600)}h`;
  }
  return `${Math.floor(elapsed / 86400)}d`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
