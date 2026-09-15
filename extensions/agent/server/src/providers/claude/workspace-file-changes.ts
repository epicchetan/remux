import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export type WatchedFileChange = {
  path: string;
  kind: 'add' | 'delete' | 'update';
  turnId: string;
  nativeTurnId: string;
};

/** Git checks a whole burst, including its index so tracked ignored files survive. */
export async function ignoredWorkspacePaths(cwd: string, paths: readonly string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const ignored = await symlinkedWorkspacePaths(cwd, paths);
  const candidates = paths.filter((path) => !ignored.has(path));
  for (const path of await gitIgnoredPaths(cwd, candidates, 0)) ignored.add(path);
  return ignored;
}

/**
 * Paths that reach their file through a symbolic link (a workspace package
 * link such as `node_modules/@remux/agent`) duplicate the real path and make
 * `git check-ignore` abort the whole batch, so they are dropped up front.
 */
async function symlinkedWorkspacePaths(cwd: string, paths: readonly string[]): Promise<Set<string>> {
  const root = await realpath(cwd).catch(() => resolve(cwd));
  const resolvedDirectories = new Map<string, Promise<string | null>>();
  const resolveDirectory = (directory: string) => {
    let pending = resolvedDirectories.get(directory);
    if (!pending) {
      pending = realpath(directory).catch(() => null);
      resolvedDirectories.set(directory, pending);
    }
    return pending;
  };
  const symlinked = new Set<string>();
  await Promise.all(paths.map(async (path) => {
    const absolute = resolve(cwd, path);
    let directory = dirname(absolute);
    let real: string | null = null;
    // Deleted files have no realpath; the nearest existing ancestor decides.
    while (real === null && directory.startsWith(root) && directory !== root) {
      real = await resolveDirectory(directory);
      if (real === null) directory = dirname(directory);
    }
    if (real === null || real === directory) return;
    const expected = resolve(root, relative(resolve(cwd), directory));
    if (real !== expected) symlinked.add(path);
  }));
  return symlinked;
}

const GIT_CHECK_IGNORE_MAX_DEPTH = 12;

async function gitIgnoredPaths(cwd: string, paths: readonly string[], depth: number): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const result = await runGitCheckIgnore(cwd, paths);
  if (result.kind === 'ok') return result.ignored;
  if (result.kind === 'no-repository') return new Set(); // Non-Git workspaces retain genuine changes.
  // A fatal pathspec error names no path. Bisect so one bad path cannot let a
  // whole build burst through, and treat the unresolvable path itself as ignored.
  if (paths.length === 1 || depth >= GIT_CHECK_IGNORE_MAX_DEPTH) return new Set(paths);
  const middle = Math.ceil(paths.length / 2);
  const [left, right] = await Promise.all([
    gitIgnoredPaths(cwd, paths.slice(0, middle), depth + 1),
    gitIgnoredPaths(cwd, paths.slice(middle), depth + 1),
  ]);
  return new Set([...left, ...right]);
}

type GitCheckIgnoreResult =
  | { kind: 'ok'; ignored: Set<string> }
  | { kind: 'no-repository' }
  | { kind: 'fatal' };

function runGitCheckIgnore(cwd: string, paths: readonly string[]): Promise<GitCheckIgnoreResult> {
  return new Promise((resolveResult) => {
    const child = spawn('git', ['check-ignore', '-z', '--stdin'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5_000,
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4_096) stderr += chunk.toString('utf8'); });
    child.stdin.on('error', () => undefined);
    child.on('error', () => resolveResult({ kind: 'no-repository' }));
    child.on('close', (code) => resolveResult(code === 0 || code === 1
      ? { kind: 'ok', ignored: new Set(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean)) }
      : /not a git repository/iu.test(stderr) ? { kind: 'no-repository' } : { kind: 'fatal' }));
    child.stdin.end(`${paths.join('\0')}\0`);
  });
}

const WATCHED_TURN_HISTORY = 8;
/** A turn that touches more distinct files than this is a build, not an edit. */
export const MAX_WATCHED_CHANGES_PER_TURN = 1_000;

/** Bounded, per-turn coalescing. Explicit edit-tool events bypass this queue. */
export class WorkspaceFileChanges {
  private readonly pending = new Map<string, WatchedFileChange>();
  /** Last emitted kind per path for recent turns, so build churn cannot repeat a change. */
  private readonly emitted = new Map<string, Map<string, WatchedFileChange['kind']>>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private closed = false;
  private readonly cwd: string;
  private readonly emit: (changes: readonly WatchedFileChange[]) => void;
  private readonly ignore: typeof ignoredWorkspacePaths;
  constructor(cwd: string, emit: (changes: readonly WatchedFileChange[]) => void,
    ignore = ignoredWorkspacePaths) {
    this.cwd = cwd; this.emit = emit; this.ignore = ignore;
  }

  async add(change: WatchedFileChange): Promise<void> {
    if (this.closed || change.path.includes('\0')) return;
    const path = relative(this.cwd, resolve(this.cwd, change.path));
    if (!path || isAbsolute(path) || path === '..' || path.startsWith('../') ||
        path.split('/').includes('.git')) return;
    const key = `${change.turnId}\0${path}`;
    // Apply backpressure to the hook instead of growing an unbounded event log.
    while (this.pending.size >= 512 && !this.pending.has(key)) await this.flush();
    if (this.closed) return;
    const previous = this.pending.get(key);
    this.pending.set(key, { ...change, path,
      kind: previous?.kind === 'add' && change.kind === 'update' ? 'add' : change.kind });
    this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush(); }, 75);
    this.timer.unref?.();
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending.values()];
    this.pending.clear();
    if (!batch.length) return Promise.resolve();
    this.flushing = (async () => {
      const ignored = await this.ignore(this.cwd, [...new Set(batch.map(({ path }) => path))]);
      const fresh = batch.filter((change) => !ignored.has(change.path) && this.recordEmitted(change));
      if (fresh.length) this.emit(fresh);
    })().finally(() => {
      this.flushing = undefined;
      if (this.pending.size && !this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 75);
        this.timer.unref?.();
      }
    });
    return this.flushing;
  }

  /** One report per (path, kind) per turn, bounded per turn; false when the change is redundant. */
  private recordEmitted(change: WatchedFileChange) {
    let turn = this.emitted.get(change.turnId);
    if (!turn) {
      turn = new Map();
      this.emitted.set(change.turnId, turn);
      while (this.emitted.size > WATCHED_TURN_HISTORY) this.emitted.delete(this.emitted.keys().next().value!);
    }
    if (turn.get(change.path) === change.kind) return false;
    if (!turn.has(change.path) && turn.size >= MAX_WATCHED_CHANGES_PER_TURN) return false;
    turn.set(change.path, change.kind);
    return true;
  }

  async drain() {
    await this.flush();
    while (this.pending.size) await this.flush();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async close() {
    this.closed = true;
    await this.drain();
  }
}
