import { create } from 'zustand';

import type { RemuxConnection } from '../remote/RemuxConnectionProvider';
import {
  readRemuxDirectories,
  readRemuxDirectory,
  type RemuxReadDirectoryResponse,
} from './filesApi';
import type { FileTreeEntry, VisibleFileTreeRow } from './filesTypes';

type DirectoryRefreshStatus = 'error' | 'idle' | 'loading' | 'refreshing';

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
  loadDirectory: (request: RemuxConnection['request'], path?: string | null) => Promise<void>;
  loadRootDirectory: (request: RemuxConnection['request']) => Promise<void>;
  navigateToDirectory: (
    request: RemuxConnection['request'],
    path: string,
    parentPath: string | null,
  ) => Promise<void>;
  navigateToParentDirectory: (request: RemuxConnection['request']) => Promise<void>;
  preloadDirectories: (request: RemuxConnection['request'], paths: string[]) => Promise<void>;
  toggleFolder: (request: RemuxConnection['request'], path: string) => Promise<void>;
};

export const filesRootKey = '__root__';
const maxConcurrentPreloadDirectories = 4;
const directoryStaleMs = 5000;

let directoryRequestId = 0;

export const useFilesStore = create<FilesStore>((set, get) => ({
  currentPath: null,
  directoriesByPath: {},
  expandedPaths: {},
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
    const rootRecord = state.directoriesByPath[filesRootKey];
    if (state.currentPath || isDirectoryFetching(rootRecord)) {
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
    }));

    if (record?.entries) {
      if (shouldRefreshDirectory(record)) {
        void refreshDirectory({ force: true, get, path, request, set, visible: false });
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
    set({ currentPath: parentPath });

    if (parentRecord?.entries) {
      if (shouldRefreshDirectory(parentRecord)) {
        void refreshDirectory({ force: true, get, path: parentPath, request, set, visible: false });
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
        void refreshDirectory({ force: true, get, path, request, set, visible: false });
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
    const isDirectory = entry.kind === 'directory';
    const isExpanded = Boolean(expandedPaths[entry.path]);
    const children = directoriesByPath[entry.path]?.entries ?? null;
    const childrenLoaded = Array.isArray(children);
    const row: VisibleFileTreeRow = {
      ...entry,
      childrenLoaded,
      depth,
      hasChildren: isDirectory && (!childrenLoaded || children.length > 0),
      isExpanded,
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

async function refreshDirectory({
  force,
  get,
  path,
  request,
  set,
  visible,
}: {
  force: boolean;
  get: () => FilesStore;
  path: string;
  request: RemuxConnection['request'];
  set: (
    partial: FilesStore | Partial<FilesStore> | ((state: FilesStore) => FilesStore | Partial<FilesStore>),
    replace?: false,
  ) => void;
  visible: boolean;
}) {
  const record = get().directoriesByPath[path];
  if (isDirectoryFetching(record)) {
    return;
  }

  const requestId = nextDirectoryRequestId();
  const hasEntries = Boolean(record?.entries);
  set((state) => ({
    directoriesByPath: {
      ...state.directoriesByPath,
      [path]: {
        ...(record ?? emptyDirectoryRecord()),
        error: visible ? null : record?.error ?? null,
        requestId,
        refreshStatus: hasEntries ? 'refreshing' : 'loading',
      },
    },
  }));

  try {
    const response = await readRemuxDirectory(request, path, { force });
    set((state) => applyDirectoryResult(state, response, {
      requestId,
      requestKey: path,
    }));
  } catch (error) {
    set((state) => applyDirectoryError(state, path, requestId, error, { visible }));
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

function promoteDirectoryLoading(
  set: (
    partial: FilesStore | Partial<FilesStore> | ((state: FilesStore) => FilesStore | Partial<FilesStore>),
    replace?: false,
  ) => void,
  path: string,
) {
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
