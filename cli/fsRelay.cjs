const nodeFs = require('node:fs');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const { isPathWithin } = require('./core/fs.cjs');

const execFileAsync = promisify(execFile);

const fsDidChangeMethod = 'remux/fs/didChange';
const defaultDebounceMs = 250;
const defaultMinIntervalMs = 1_000;
const defaultPollIntervalMs = 2_500;
const defaultMaxWatchedDirectories = 256;
const defaultWatchIdleMs = 10 * 60_000;

// Server-originated change feed for the files tab. Three detection layers:
//   1. Non-recursive fs.watch per served directory (instant, listing-level).
//   2. A `.git` watcher per known repo root (commits/stages/branch switches).
//   3. A git-status poller per repo root while clients are connected, which is
//      the only layer that sees worktree edits deep under unloaded directories.
// Dirty paths are debounced, then broadcast at most once per minIntervalMs
// with a trailing send. The fs core cache is invalidated before each broadcast
// so racing non-force reads cannot re-serve stale listings.
function createFsRelay({
  debounceMs = defaultDebounceMs,
  log = console,
  maxWatchedDirectories = defaultMaxWatchedDirectories,
  minIntervalMs = defaultMinIntervalMs,
  pollIntervalMs = defaultPollIntervalMs,
  runGitStatus = defaultRunGitStatus,
  watchIdleMs = defaultWatchIdleMs,
  watchPath = defaultWatchPath,
} = {}) {
  const directoryWatchers = new Map();
  const repoWatchers = new Map();
  const pendingChangedPaths = new Set();
  const pendingGitDirtyRoots = new Set();

  let broadcast = null;
  let clientCount = 0;
  let closed = false;
  let debounceTimer = null;
  let fsCore = null;
  let lastBroadcastAt = 0;
  let pollBusy = false;
  let pollTimer = null;
  let started = false;
  let trailingTimer = null;

  function onDirectoryServed(event) {
    if (closed || !event || typeof event.path !== 'string') {
      return;
    }

    registerDirectoryWatcher(event.path);
    if (typeof event.repoRoot === 'string' && event.repoRoot) {
      registerRepoRoot(event.repoRoot);
    }
  }

  function registerDirectoryWatcher(directoryPath) {
    const existing = directoryWatchers.get(directoryPath);
    const now = Date.now();
    if (existing) {
      existing.touchedAt = now;
      return;
    }

    evictDirectoryWatchers(now);

    let watcher;
    try {
      watcher = watchPath(
        directoryPath,
        () => {
          onDirectoryEvent(directoryPath);
        },
        () => {
          dropDirectoryWatcher(directoryPath);
        },
      );
    } catch (error) {
      log.warn?.(`[remux] fs relay could not watch ${directoryPath}: ${errorText(error)}`);
      return;
    }

    directoryWatchers.set(directoryPath, { touchedAt: now, watcher });
  }

  function evictDirectoryWatchers(now) {
    if (directoryWatchers.size < maxWatchedDirectories) {
      return;
    }

    for (const [directoryPath, entry] of directoryWatchers) {
      if (now - entry.touchedAt > watchIdleMs) {
        dropDirectoryWatcher(directoryPath);
      }
    }

    while (directoryWatchers.size >= maxWatchedDirectories) {
      let oldestPath = null;
      let oldestTouchedAt = Infinity;
      for (const [directoryPath, entry] of directoryWatchers) {
        if (entry.touchedAt < oldestTouchedAt) {
          oldestPath = directoryPath;
          oldestTouchedAt = entry.touchedAt;
        }
      }

      if (oldestPath === null) {
        return;
      }

      dropDirectoryWatcher(oldestPath);
    }
  }

  function dropDirectoryWatcher(directoryPath) {
    const entry = directoryWatchers.get(directoryPath);
    if (!entry) {
      return;
    }

    directoryWatchers.delete(directoryPath);
    closeWatcher(entry.watcher);
  }

  function onDirectoryEvent(directoryPath) {
    const entry = directoryWatchers.get(directoryPath);
    if (entry) {
      entry.touchedAt = Date.now();
    }

    const repoRoot = repoRootForPath(directoryPath);
    markDirty({
      changedPaths: [directoryPath],
      gitDirtyRoots: repoRoot ? [repoRoot] : [],
    });
  }

  function registerRepoRoot(repoRoot) {
    if (repoWatchers.has(repoRoot)) {
      return;
    }

    const state = {
      confirmTimer: null,
      lastStatusKey: null,
      watcher: null,
    };
    repoWatchers.set(repoRoot, state);

    const gitDirPath = path.join(repoRoot, '.git');
    try {
      state.watcher = watchPath(
        gitDirPath,
        (eventType, filename) => {
          if (filename === null || filename === 'HEAD' || filename === 'index') {
            scheduleGitConfirm(repoRoot);
          }
        },
        () => {
          state.watcher = null;
        },
      );
    } catch (error) {
      log.warn?.(`[remux] fs relay could not watch ${gitDirPath}: ${errorText(error)}`);
    }

    // Seed the status baseline at registration so layers 2/3 can diff against
    // the state the client just saw, not against whenever the first poll runs.
    void seedStatusBaseline(repoRoot);
  }

  async function seedStatusBaseline(repoRoot) {
    const state = repoWatchers.get(repoRoot);
    if (!state || closed) {
      return;
    }

    const output = await runGitStatus(repoRoot);
    if (output !== null && state.lastStatusKey === null) {
      state.lastStatusKey = output;
    }
  }

  function repoRootForPath(targetPath) {
    let bestRoot = null;
    for (const repoRoot of repoWatchers.keys()) {
      if (isPathWithin(repoRoot, targetPath) && (bestRoot === null || repoRoot.length > bestRoot.length)) {
        bestRoot = repoRoot;
      }
    }

    return bestRoot;
  }

  // Layer-3 confirm for a `.git` event: only emit when the porcelain snapshot
  // actually changed, so index churn without status impact stays silent.
  function scheduleGitConfirm(repoRoot) {
    const state = repoWatchers.get(repoRoot);
    if (!state || state.confirmTimer !== null || closed) {
      return;
    }

    state.confirmTimer = setTimeout(() => {
      state.confirmTimer = null;
      void confirmGitDirty(repoRoot);
    }, debounceMs);
  }

  async function confirmGitDirty(repoRoot) {
    const state = repoWatchers.get(repoRoot);
    if (!state || closed) {
      return;
    }

    const output = await runGitStatus(repoRoot);
    if (output === null) {
      return;
    }

    const changed = state.lastStatusKey === null || state.lastStatusKey !== output;
    state.lastStatusKey = output;
    if (changed) {
      markDirty({ gitDirtyRoots: [repoRoot] });
    }
  }

  function ensurePoller() {
    if (!started || closed || clientCount <= 0 || pollTimer !== null) {
      return;
    }

    pollTimer = setInterval(() => {
      void pollRepoRoots();
    }, pollIntervalMs);
    pollTimer.unref?.();
  }

  function stopPoller() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollRepoRoots() {
    if (pollBusy || closed) {
      return;
    }

    pollBusy = true;
    try {
      for (const [repoRoot, state] of repoWatchers) {
        if (closed) {
          return;
        }

        const output = await runGitStatus(repoRoot);
        if (output === null) {
          continue;
        }

        if (state.lastStatusKey === null) {
          state.lastStatusKey = output;
          continue;
        }

        if (state.lastStatusKey === output) {
          continue;
        }

        const changedPaths = changedStatusDirectories(repoRoot, state.lastStatusKey, output);
        state.lastStatusKey = output;
        markDirty({
          changedPaths,
          gitDirtyRoots: [repoRoot],
        });
      }
    } finally {
      pollBusy = false;
    }
  }

  function markDirty({ changedPaths = [], gitDirtyRoots = [] }) {
    if (closed) {
      return;
    }

    for (const changedPath of changedPaths) {
      pendingChangedPaths.add(changedPath);
    }
    for (const repoRoot of gitDirtyRoots) {
      pendingGitDirtyRoots.add(repoRoot);
    }

    if (pendingChangedPaths.size === 0 && pendingGitDirtyRoots.size === 0) {
      return;
    }

    if (debounceTimer === null) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        flushDirty();
      }, debounceMs);
      debounceTimer.unref?.();
    }
  }

  function flushDirty() {
    if (closed || !broadcast) {
      return;
    }

    if (pendingChangedPaths.size === 0 && pendingGitDirtyRoots.size === 0) {
      return;
    }

    const now = Date.now();
    const waitMs = lastBroadcastAt + minIntervalMs - now;
    if (waitMs > 0) {
      if (trailingTimer === null) {
        trailingTimer = setTimeout(() => {
          trailingTimer = null;
          flushDirty();
        }, waitMs);
        trailingTimer.unref?.();
      }
      return;
    }

    const changedPaths = Array.from(pendingChangedPaths).sort();
    const gitDirtyRoots = Array.from(pendingGitDirtyRoots).sort();
    pendingChangedPaths.clear();
    pendingGitDirtyRoots.clear();
    lastBroadcastAt = now;

    try {
      fsCore?.invalidate?.({ paths: changedPaths, underRoots: gitDirtyRoots });
    } catch (error) {
      log.warn?.(`[remux] fs relay cache invalidation failed: ${errorText(error)}`);
    }

    broadcast({
      method: fsDidChangeMethod,
      params: {
        changedPaths,
        gitDirtyRoots,
      },
    });
  }

  return {
    close() {
      if (closed) {
        return;
      }
      closed = true;

      stopPoller();
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (trailingTimer !== null) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }

      for (const directoryPath of Array.from(directoryWatchers.keys())) {
        dropDirectoryWatcher(directoryPath);
      }
      for (const state of repoWatchers.values()) {
        if (state.confirmTimer !== null) {
          clearTimeout(state.confirmTimer);
          state.confirmTimer = null;
        }
        closeWatcher(state.watcher);
      }
      repoWatchers.clear();
      pendingChangedPaths.clear();
      pendingGitDirtyRoots.clear();
    },
    onClientCountChanged(count) {
      clientCount = typeof count === 'number' ? count : 0;
      if (clientCount > 0) {
        ensurePoller();
      } else {
        stopPoller();
      }
    },
    onDirectoryServed,
    start({ broadcast: nextBroadcast, fs: nextFsCore }) {
      broadcast = nextBroadcast;
      fsCore = nextFsCore;
      started = true;
      ensurePoller();
      if (pendingChangedPaths.size > 0 || pendingGitDirtyRoots.size > 0) {
        markDirty({});
      }
    },
  };
}

// Directories whose listings may differ between two porcelain snapshots:
// the containing directory of every entry that appeared, disappeared, or
// changed status (rename records contribute both sides).
function changedStatusDirectories(repoRoot, beforeOutput, afterOutput) {
  const before = parsePorcelainRecords(beforeOutput);
  const after = parsePorcelainRecords(afterOutput);
  const changedDirectories = new Set();

  for (const [record, relativePaths] of before) {
    if (!after.has(record)) {
      addRecordDirectories(changedDirectories, repoRoot, relativePaths);
    }
  }
  for (const [record, relativePaths] of after) {
    if (!before.has(record)) {
      addRecordDirectories(changedDirectories, repoRoot, relativePaths);
    }
  }

  return Array.from(changedDirectories);
}

function addRecordDirectories(target, repoRoot, relativePaths) {
  for (const relativePath of relativePaths) {
    const relativeDir = path.posix.dirname(relativePath);
    target.add(relativeDir === '.' ? repoRoot : path.join(repoRoot, relativeDir));
  }
}

// Porcelain v1 -z records: `XY path` NUL-terminated; rename/copy records are
// followed by the original path as a bare NUL-terminated token.
function parsePorcelainRecords(output) {
  const tokens = String(output).split('\0').filter(Boolean);
  const records = new Map();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4 || token[2] !== ' ') {
      continue;
    }

    const indexStatus = token[0];
    const relativePaths = [token.slice(3)];
    if ((indexStatus === 'R' || indexStatus === 'C') && index + 1 < tokens.length) {
      index += 1;
      relativePaths.push(tokens[index]);
    }

    records.set(`${token}\0${relativePaths[1] ?? ''}`, relativePaths);
  }

  return records;
}

function defaultWatchPath(target, onEvent, onError) {
  const watcher = nodeFs.watch(target, { persistent: false }, (eventType, filename) => {
    onEvent(eventType, filename == null ? null : String(filename));
  });
  watcher.on('error', () => {
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
    onError?.();
  });
  return watcher;
}

async function defaultRunGitStatus(repoRoot) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoRoot,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

function closeWatcher(watcher) {
  try {
    watcher?.close?.();
  } catch {
    // Already closed.
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  createFsRelay,
  fsDidChangeMethod,
};
