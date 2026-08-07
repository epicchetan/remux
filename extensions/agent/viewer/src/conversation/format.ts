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

function homeDirectory() {
  const cwd = document.documentElement.dataset.remuxHome;
  return cwd?.replace(/\\/gu, '/').replace(/\/+$/u, '') || null;
}
