import { createHash } from 'node:crypto';
import { opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

import type {
  AgentFileSearchParams,
  AgentFileSearchResponse,
  AgentFileSearchResult,
} from '../../shared/protocol.ts';

const MAX_SEARCH_ENTRIES = 12_000;
const MAX_SEARCH_DEPTH = 24;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

export async function searchAgentFiles(params: AgentFileSearchParams): Promise<AgentFileSearchResponse> {
  const root = await realpath(resolve(params.cwd));
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new TypeError('cwd must identify a directory.');
  const query = normalize(params.query);
  if (!query) return { results: [] };
  const limit = Math.max(1, Math.min(80, params.limit ?? 80));
  const pending = [{ depth: 0, path: root }];
  const matches: AgentFileSearchResult[] = [];
  let visited = 0;

  while (pending.length > 0 && visited < MAX_SEARCH_ENTRIES) {
    const current = pending.shift()!;
    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      continue;
    }
    for await (const entry of directory) {
      if (++visited > MAX_SEARCH_ENTRIES) break;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = resolve(current.path, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      const isDirectory = entry.isDirectory();
      if (isDirectory && current.depth < MAX_SEARCH_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
        pending.push({ depth: current.depth + 1, path: absolutePath });
      }
      if (!isDirectory && !entry.isFile()) continue;
      const score = fuzzyPathScore(relativePath, entry.name, query);
      if (score === null) continue;
      matches.push({
        absolutePath,
        id: createHash('sha256').update(absolutePath).digest('hex').slice(0, 24),
        kind: isDirectory ? 'directory' : 'file',
        name: entry.name || basename(absolutePath),
        parentPath: relative(root, dirname(absolutePath)).split(sep).join('/') || '.',
        path: isDirectory ? `${relativePath}/` : relativePath,
        score,
      });
    }
  }

  matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return { results: matches.slice(0, limit) };
}

function fuzzyPathScore(path: string, name: string, query: string) {
  const normalizedPath = normalize(path);
  const normalizedName = normalize(name);
  if (normalizedName === query) return 10_000 - path.length;
  if (normalizedName.startsWith(query)) return 8_000 - path.length;
  const direct = normalizedPath.indexOf(query);
  if (direct >= 0) return 6_000 - direct * 4 - path.length;

  let cursor = 0;
  let gap = 0;
  for (const character of query) {
    const index = normalizedPath.indexOf(character, cursor);
    if (index < 0) return null;
    gap += index - cursor;
    cursor = index + 1;
  }
  return 2_000 - gap * 3 - path.length;
}

function normalize(value: string) {
  return value.trim().replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
}
