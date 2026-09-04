export function shortenPath(path: string | null) {
  if (!path) return '';

  const normalized = path.replace(/\\/gu, '/');
  const home = homeDirectory();
  if (home && (normalized === home || normalized.startsWith(`${home}/`))) {
    return `~${normalized.slice(home.length)}`;
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `…/${parts.slice(-3).join('/')}`;
}

export function parentDirectory(path: string | null) {
  if (!path) return null;
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '') || '/';
  if (normalized === '/') return null;
  const separator = normalized.lastIndexOf('/');
  return separator <= 0 ? '/' : normalized.slice(0, separator);
}

export function formatRelativeTime(timestampMs: number) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1_000));
  if (elapsedSeconds < 60) return 'now';
  if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)}m`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)}h`;
  return `${Math.floor(elapsedSeconds / 86_400)}d`;
}

function homeDirectory() {
  if (typeof document === 'undefined') return null;
  const cwd = document.documentElement.dataset.remuxHome;
  return cwd?.replace(/\\/gu, '/').replace(/\/+$/u, '') || null;
}
