import { create } from 'zustand';

import type { RemuxConnection } from '../remote/RemuxConnectionProvider';
import {
  readRemuxDirectories,
  readRemuxDirectory,
  type RemuxFsDidChangeParams,
  type RemuxReadDirectoryResponse,
} from './filesApi';
import { isDirectoryLikeEntry, type FileTreeEntry, type VisibleFileTreeRow } from './filesTypes';

type DirectoryRefreshStatus = 'error' | 'idle' | 'loading' | 'refreshing';

type SetFilesStore = (
  partial: FilesStore | Partial<FilesStore> | ((state: FilesStore) => FilesStore | Partial<FilesStore>),
  replace?: false,
) => void;

export type DirectoryRecord = {
  entries: FileTreeEntry[] | null;
  error: string | null;
  loadedAt: number | null;
  parentPath: string | null;
  requestId: number;
  refreshStatus: DirectoryRefreshStatus;
  version: string | null;
};

type FilesStore = {
  currentPath: string | null;
  directoriesByPath: Record<string, DirectoryRecord>;
  expandedPaths: Record<string, boolean>;
  isRefreshingAll: boolean;
  refreshError: string | null;
  applyFsDidChange: (request: RemuxConnection['request'], params: RemuxFsDidChangeParams) => void;
  loadDirectory: (request: RemuxConnection['request'], path?: string | null) => Promise<void>;
  loadRootDirectory: (request: RemuxConnection['request']) => Promise<void>;
  navigateToDirectory: (
    request: RemuxConnection['request'],
    path: string,
    parentPath: string | null,
  ) => Promise<void>;
  navigateToParentDirectory: (request: RemuxConnection['request']) => Promise<void>;
  preloadDirectories: (request: RemuxConnection['request'], paths: string[]) => Promise<void>;
  refreshVisibleDirectories: (
    request: RemuxConnection['request'],
    options?: { spinner?: boolean },
  ) => Promise<void>;
  toggleFolder: (request: RemuxConnection['request'], path: string) => Promise<void>;
};

export const filesRootKey = '__root__';
const maxConcurrentPreloadDirectories = 4;
const directoryStaleMs = 5000;
const fsDirtyRefreshDelayMs = 300;

let directoryRequestId = 0;
let dirtyRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const pendingDirtyRefreshPaths = new Set<string>();

export const useFilesStore = create<FilesStore>((set, get) => ({
  currentPath: null,
  directoriesByPath: {},
  expandedPaths: {},
  isRefreshingAll: false,
  refreshError: null,
  applyFsDidChange: (request, { changedPaths, gitDirtyRoots }) => {
    const state = get();
    const changedPathSet = new Set(changedPaths);
    const dirtyPaths = Object.keys(state.directoriesByPath).filter((path) => {
      if (!state.directoriesByPath[path]?.entries) {
        return false;
      }

      return (
        changedPathSet.has(path) ||
        gitDirtyRoots.some((root) => isPathWithinServerPath(root, path))
      );
    });

    if (dirtyPaths.length === 0) {
      return;
    }

    const renderablePaths = new Set(
      state.currentPath ? collectExpandedSubtreePaths(state, state.currentPath) : [],
    );
    const renderableDirty = dirtyPaths.filter((path) => renderablePaths.has(path));
    const backgroundDirty = dirtyPaths.filter((path) => !renderablePaths.has(path));

    if (backgroundDirty.length > 0) {
      set((current) => ({
        directoriesByPath: backgroundDirty.reduce((directoriesByPath, path) => {
          const record = directoriesByPath[path];
          if (!record) {
            return directoriesByPath;
          }

          return {
            ...directoriesByPath,
            [path]: {
              ...record,
              loadedAt: null,
            },
          };
        }, current.directoriesByPath),
      }));
    }

    if (renderableDirty.length > 0) {
      scheduleDirtyPathsRefresh({ get, paths: renderableDirty, request, set });
    }
  },
  loadDirectory: async (request, path = null) => {
    const key = path ?? filesRootKey;
    const state = get();
    const record = state.directoriesByPath[key] ?? emptyDirectoryRecord();
    const requestId = nextDirectoryRequestId();
    const hasEntries = Boolean(record.entries);

    set((state) => ({
      directoriesByPath: {
        ...state.directoriesByPath,
        [key]: {
          ...record,
          error: null,
          requestId,
          refreshStatus: hasEntries ? 'refreshing' : 'loading',
        },
      },
    }));

    try {
      const response = await readRemuxDirectory(request, path, { force: hasEntries });
      set((state) => applyDirectoryResult(state, response, {
        requestId,
        requestKey: key,
        setCurrentPath: !path,
      }));
    } catch (error) {
      set((state) => applyDirectoryError(state, key, requestId, error, {
        visible: true,
      }));
    }
  },
  loadRootDirectory: async (request) => {
    const state = get();
    if (state.currentPath) {
      await get().refreshVisibleDirectories(request);
      return;
    }

    if (isDirectoryFetching(state.directoriesByPath[filesRootKey])) {
      return;
    }

    await get().loadDirectory(request, null);
  },
  navigateToDirectory: async (request, path, parentPath) => {
    const state = get();
    const record = state.directoriesByPath[path];

    set((current) => ({
      currentPath: path,
      directoriesByPath: {
        ...current.directoriesByPath,
        [path]: {
          ...(current.directoriesByPath[path] ?? emptyDirectoryRecord()),
          parentPath,
        },
      },
      refreshError: null,
    }));

    if (record?.entries) {
      if (shouldRefreshDirectory(record)) {
        void refreshDirectoryPaths({
          get,
          paths: collectExpandedSubtreePaths(get(), path),
          request,
          set,
        });
      }
      return;
    }

    if (isDirectoryFetching(record)) {
      promoteDirectoryLoading(set, path);
      return;
    }

    await get().loadDirectory(request, path);
  },
  navigateToParentDirectory: async (request) => {
    const state = get();
    const currentPath = state.currentPath;
    const parentPath = currentPath ? state.directoriesByPath[currentPath]?.parentPath : null;

    if (!parentPath) {
      return;
    }

    const parentRecord = state.directoriesByPath[parentPath];
    set({ currentPath: parentPath, refreshError: null });

    if (parentRecord?.entries) {
      if (shouldRefreshDirectory(parentRecord)) {
        void refreshDirectoryPaths({
          get,
          paths: collectExpandedSubtreePaths(get(), parentPath),
          request,
          set,
        });
      }
      return;
    }

    if (isDirectoryFetching(parentRecord)) {
      promoteDirectoryLoading(set, parentPath);
      return;
    }

    await get().loadDirectory(request, parentPath);
  },
  preloadDirectories: async (request, paths) => {
    const state = get();
    const pendingPaths = Array.from(new Set(paths)).filter((path) => {
      const record = state.directoriesByPath[path];
      return !record?.entries && !isDirectoryFetching(record);
    });

    if (pendingPaths.length === 0) {
      return;
    }

    const batch = pendingPaths.slice(0, maxConcurrentPreloadDirectories);
    const requestIds = Object.fromEntries(batch.map((path) => [path, nextDirectoryRequestId()]));

    set((state) => ({
      directoriesByPath: batch.reduce((directoriesByPath, path) => {
        const record = directoriesByPath[path] ?? emptyDirectoryRecord();
        return {
          ...directoriesByPath,
          [path]: {
            ...record,
            requestId: requestIds[path],
            refreshStatus: 'refreshing',
          },
        };
      }, state.directoriesByPath),
    }));

    try {
      const response = await readRemuxDirectories(request, batch);
      set((state) => response.results.reduce((nextState, result) => {
        if (result.ok) {
          return applyDirectoryResult(nextState, result.value, {
            requestId: requestIds[result.path],
            requestKey: result.path,
          });
        }

        return applyDirectoryError(nextState, result.path, requestIds[result.path], result.message, {
          visible: false,
        });
      }, state));
    } catch (error) {
      set((state) => batch.reduce((nextState, path) => applyDirectoryError(
        nextState,
        path,
        requestIds[path],
        error,
        { visible: false },
      ), state));
    }
  },
  refreshVisibleDirectories: async (request, options = {}) => {
    const spinner = options.spinner === true;
    const state = get();
    if (!state.currentPath || (spinner && state.isRefreshingAll)) {
      return;
    }

    const paths = collectExpandedSubtreePaths(state, state.currentPath);
    if (paths.length === 0) {
      return;
    }

    if (spinner) {
      set({ isRefreshingAll: true });
    }

    try {
      const { failedCount, requestedCount } = await refreshDirectoryPaths({
        get,
        paths,
        request,
        set,
      });
      if (requestedCount > 0) {
        set({
          refreshError: failedCount === 0
            ? null
            : `Couldn't refresh ${failedCount} of ${requestedCount} ${requestedCount === 1 ? 'directory' : 'directories'}`,
        });
      }
    } finally {
      if (spinner) {
        set({ isRefreshingAll: false });
      }
    }
  },
  toggleFolder: async (request, path) => {
    const state = get();
    const record = state.directoriesByPath[path];
    const isExpanded = Boolean(state.expandedPaths[path]);

    set((current) => ({
      expandedPaths: {
        ...current.expandedPaths,
        [path]: !isExpanded,
      },
    }));

    if (isExpanded) {
      return;
    }

    if (record?.entries) {
      if (shouldRefreshDirectory(record)) {
        void refreshDirectoryPaths({
          get,
          paths: collectExpandedSubtreePaths(get(), path),
          request,
          set,
        });
      }
      return;
    }

    if (isDirectoryFetching(record)) {
      promoteDirectoryLoading(set, path);
      return;
    }

    await get().loadDirectory(request, path);
  },
}));

export function visibleFileTreeRows({
  currentPath,
  directoriesByPath,
  expandedPaths,
}: {
  currentPath: string | null;
  directoriesByPath: Record<string, DirectoryRecord>;
  expandedPaths: Record<string, boolean>;
}) {
  if (!currentPath) {
    return [];
  }

  return flattenRows({
    depth: 0,
    directoriesByPath,
    entries: directoriesByPath[currentPath]?.entries ?? [],
    expandedPaths,
    parentPath: currentPath,
  });
}

function flattenRows({
  depth,
  directoriesByPath,
  entries,
  expandedPaths,
  parentPath,
}: {
  depth: number;
  directoriesByPath: Record<string, DirectoryRecord>;
  entries: FileTreeEntry[];
  expandedPaths: Record<string, boolean>;
  parentPath: string | null;
}): VisibleFileTreeRow[] {
  return entries.flatMap((entry) => {
    const isDirectory = isDirectoryLikeEntry(entry);
    const isExpanded = Boolean(expandedPaths[entry.path]);
    const children = directoriesByPath[entry.path]?.entries ?? null;
    const childrenLoaded = Array.isArray(children);
    const row: VisibleFileTreeRow = {
      ...entry,
      childrenLoaded,
      depth,
      hasChildren: isDirectory && (!childrenLoaded || children.length > 0),
      isExpanded,
      itemCount: entry.itemCount ?? (isDirectory && childrenLoaded ? children.length : null),
      parentPath,
    };

    if (!isDirectory || !isExpanded) {
      return [row];
    }

    return [
      row,
      ...flattenRows({
        depth: depth + 1,
        directoriesByPath,
        entries: children ?? [],
        expandedPaths,
        parentPath: entry.path,
      }),
    ];
  });
}

// Client-side path containment over server-sent paths: compares the strings
// verbatim (the server is the canonical resolver). Includes the root itself
// and is boundary-safe ('/repo2' is not within '/repo').
export function isPathWithinServerPath(rootPath: string, targetPath: string) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}/`);
}

function scheduleDirtyPathsRefresh({
  get,
  paths,
  request,
  set,
}: {
  get: () => FilesStore;
  paths: string[];
  request: RemuxConnection['request'];
  set: SetFilesStore;
}) {
  for (const path of paths) {
    pendingDirtyRefreshPaths.add(path);
  }

  if (dirtyRefreshTimer !== null) {
    return;
  }

  dirtyRefreshTimer = setTimeout(() => {
    dirtyRefreshTimer = null;
    const batch = Array.from(pendingDirtyRefreshPaths);
    pendingDirtyRefreshPaths.clear();
    void refreshDirectoryPaths({ get, paths: batch, request, set });
  }, fsDirtyRefreshDelayMs);
}

function collectExpandedSubtreePaths(
  {
    directoriesByPath,
    expandedPaths,
  }: Pick<FilesStore, 'directoriesByPath' | 'expandedPaths'>,
  rootPath: string,
): string[] {
  const paths: string[] = [];
  const queue = [rootPath];

  while (queue.length > 0) {
    const path = queue.shift() as string;
    const record = directoriesByPath[path];
    if (!record?.entries) {
      continue;
    }

    paths.push(path);
    for (const entry of record.entries) {
      if (isDirectoryLikeEntry(entry) && expandedPaths[entry.path]) {
        queue.push(entry.path);
      }
    }
  }

  return paths;
}

async function refreshDirectoryPaths({
  get,
  paths,
  request,
  set,
}: {
  get: () => FilesStore;
  paths: string[];
  request: RemuxConnection['request'];
  set: SetFilesStore;
}): Promise<{ failedCount: number; requestedCount: number }> {
  const refreshablePaths = Array.from(new Set(paths)).filter((path) => {
    const record = get().directoriesByPath[path];
    return Boolean(record?.entries) && !isDirectoryFetching(record);
  });

  if (refreshablePaths.length === 0) {
    return { failedCount: 0, requestedCount: 0 };
  }

  const requestIds = Object.fromEntries(
    refreshablePaths.map((path) => [path, nextDirectoryRequestId()]),
  );

  set((state) => ({
    directoriesByPath: refreshablePaths.reduce((directoriesByPath, path) => {
      const record = directoriesByPath[path];
      if (!record) {
        return directoriesByPath;
      }

      return {
        ...directoriesByPath,
        [path]: {
          ...record,
          requestId: requestIds[path],
          refreshStatus: 'refreshing',
        },
      };
    }, state.directoriesByPath),
  }));

  try {
    const response = await readRemuxDirectories(request, refreshablePaths, { force: true });
    set((state) => response.results.reduce((nextState, result) => {
      if (result.ok) {
        return applyDirectoryResult(nextState, result.value, {
          requestId: requestIds[result.path],
          requestKey: result.path,
        });
      }

      return applyDirectoryError(nextState, result.path, requestIds[result.path], result.message, {
        visible: false,
      });
    }, state));
    return {
      failedCount: response.results.filter((result) => !result.ok).length,
      requestedCount: refreshablePaths.length,
    };
  } catch (error) {
    set((state) => refreshablePaths.reduce((nextState, path) => applyDirectoryError(
      nextState,
      path,
      requestIds[path],
      error,
      { visible: false },
    ), state));
    return {
      failedCount: refreshablePaths.length,
      requestedCount: refreshablePaths.length,
    };
  }
}

function applyDirectoryResult(
  state: FilesStore,
  response: RemuxReadDirectoryResponse,
  {
    requestId,
    requestKey = response.path,
    setCurrentPath = false,
  }: {
    requestId: number;
    requestKey?: string;
    setCurrentPath?: boolean;
  },
): FilesStore {
  const currentRecord = state.directoriesByPath[requestKey];
  if (currentRecord && currentRecord.requestId !== requestId) {
    return state;
  }

  const previousRecord = state.directoriesByPath[response.path] ?? currentRecord;
  const nextRecord: DirectoryRecord = {
    entries: response.entries,
    error: null,
    loadedAt: Date.now(),
    parentPath: response.parentPath,
    requestId,
    refreshStatus: 'idle',
    version: response.version,
  };
  const directoriesByPath = { ...state.directoriesByPath };

  if (previousRecord?.version === response.version && previousRecord.entries) {
    directoriesByPath[response.path] = {
      ...previousRecord,
      error: null,
      loadedAt: Date.now(),
      parentPath: response.parentPath,
      requestId,
      refreshStatus: 'idle',
    };
  } else {
    directoriesByPath[response.path] = nextRecord;
  }

  if (requestKey !== response.path) {
    delete directoriesByPath[requestKey];
  }

  return {
    ...state,
    currentPath: setCurrentPath ? response.path : state.currentPath,
    directoriesByPath,
  };
}

function applyDirectoryError(
  state: FilesStore,
  path: string,
  requestId: number,
  error: unknown,
  { visible }: { visible: boolean },
): FilesStore {
  const record = state.directoriesByPath[path];
  if (record && record.requestId !== requestId) {
    return state;
  }

  if (!visible && !record?.entries) {
    const directoriesByPath = { ...state.directoriesByPath };
    delete directoriesByPath[path];
    return {
      ...state,
      directoriesByPath,
    };
  }

  return {
    ...state,
    directoriesByPath: {
      ...state.directoriesByPath,
      [path]: {
        ...(record ?? emptyDirectoryRecord()),
        error: visible ? errorMessage(error) : record?.error ?? null,
        refreshStatus: record?.entries ? 'idle' : visible ? 'error' : 'idle',
      },
    },
  };
}

function promoteDirectoryLoading(set: SetFilesStore, path: string) {
  set((state) => {
    const record = state.directoriesByPath[path];
    if (!record || record.entries || record.refreshStatus !== 'refreshing') {
      return state;
    }

    return {
      directoriesByPath: {
        ...state.directoriesByPath,
        [path]: {
          ...record,
          refreshStatus: 'loading',
        },
      },
    };
  });
}

function emptyDirectoryRecord(): DirectoryRecord {
  return {
    entries: null,
    error: null,
    loadedAt: null,
    parentPath: null,
    requestId: 0,
    refreshStatus: 'idle',
    version: null,
  };
}

function isDirectoryFetching(record: DirectoryRecord | undefined) {
  return record?.refreshStatus === 'loading' || record?.refreshStatus === 'refreshing';
}

function shouldRefreshDirectory(record: DirectoryRecord) {
  return Boolean(record.entries) &&
    !isDirectoryFetching(record) &&
    (record.loadedAt == null || Date.now() - record.loadedAt > directoryStaleMs);
}

function nextDirectoryRequestId() {
  directoryRequestId += 1;
  return directoryRequestId;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Directory could not be read');
}
