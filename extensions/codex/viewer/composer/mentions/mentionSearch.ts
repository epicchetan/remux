export type ComposerMentionItem = {
  absolutePath: string;
  id: string;
  kind: 'directory' | 'file';
  name: string;
  parentPath: string;
  path: string;
  score: number;
};

export type ComposerMentionQuery = {
  normalizedQuery: string;
};

export function parseComposerMentionQuery(query: string): ComposerMentionQuery {
  return {
    normalizedQuery: normalizeMentionQueryPath(query.replace(/^@+/, '')).trim(),
  };
}

export function fileExtension(fileName: string) {
  const normalized = fileName.toLowerCase();
  const dotIndex = normalized.lastIndexOf('.');

  if (dotIndex <= 0 || dotIndex === normalized.length - 1) {
    return null;
  }

  return normalized.slice(dotIndex + 1);
}

function normalizeMentionQueryPath(path: string) {
  return normalizePathSeparators(path).replace(/^\/+/, '');
}

function normalizePathSeparators(path: string) {
  return path.replace(/\\/g, '/');
}
