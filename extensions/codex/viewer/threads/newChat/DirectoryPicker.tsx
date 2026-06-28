import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ChevronRight, Folder, FolderOpen, Loader2, Search } from 'lucide-react';

import { readDirectory, readDirectoryStats, searchDirectories } from '../../ipc/files';
import { KeyboardPickerFrame, KeyboardPickerList, KeyboardPickerRow } from '../../ui/KeyboardPicker';
import { useThreadsStore } from '../store';

const searchDebounceMs = 80;
const directoryDetailsConcurrency = 4;

type DirectoryRow = {
  id: string;
  itemCount?: number | null;
  label: string;
  modifiedAtMs?: number | null;
  path: string;
  type: 'directory' | 'search';
};

export function NewChatDirectoryPicker() {
  const directoryPickerPath = useThreadsStore((state) => state.directoryPickerPath);
  const draft = useThreadsStore((state) => state.draft);
  const setDirectoryPickerPath = useThreadsStore((state) => state.setDirectoryPickerPath);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const currentPath = directoryPickerPath ?? draft?.initialCwd ?? '';
  const [entries, setEntries] = useState<DirectoryRow[]>([]);
  const [query, setQuery] = useState('');
  const [searchRows, setSearchRows] = useState<DirectoryRow[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);
  const normalizedQuery = query.trim();
  const rows = normalizedQuery ? searchRows : entries;
  const loading = normalizedQuery ? loadingSearch : loadingEntries;
  const focusSearchInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    if (!directoryPickerPath && draft?.initialCwd) {
      setDirectoryPickerPath(draft.initialCwd);
    }
  }, [directoryPickerPath, draft?.initialCwd, setDirectoryPickerPath]);

  useEffect(() => {
    setQuery('');
  }, [currentPath]);

  useEffect(() => {
    if (!currentPath) {
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setError(null);
    setLoadingEntries(true);

    void readDirectory(currentPath)
      .then((response) => {
        if (requestIdRef.current !== requestId) {
          return;
        }

        const childRows = response.entries
          .filter((entry) => entry.isDirectory)
          .sort(compareDirectoryEntryNames)
          .map((entry): DirectoryRow => {
            const path = joinPath(currentPath, entry.fileName);
            return {
              id: `directory:${path}`,
              label: entry.fileName,
              path,
              type: 'directory',
            };
          });

        setEntries(childRows);
        void hydrateDirectoryRowDetails({
          rows: childRows,
          setRows: setEntries,
          shouldContinue: () => requestIdRef.current === requestId,
        });
      })
      .catch((readError) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setEntries([]);
        setError(readError instanceof Error ? readError.message : 'Directory could not be read');
      })
      .finally(() => {
        if (requestIdRef.current === requestId) {
          setLoadingEntries(false);
        }
      });
  }, [currentPath]);

  useEffect(() => {
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setSearchRows([]);

    if (!normalizedQuery || !currentPath) {
      setLoadingSearch(false);
      return;
    }

    setError(null);
    setLoadingSearch(true);
    const timer = window.setTimeout(() => {
      void searchDirectories(normalizedQuery, currentPath)
        .then((directories) => {
          if (searchRequestIdRef.current !== requestId) {
            return;
          }

          const childRows = directories.slice(0, 40).map((directory): DirectoryRow => ({
            id: `search:${directory.absolutePath}`,
            label: directory.name,
            path: directory.absolutePath,
            type: 'search',
          }));

          setSearchRows(childRows);
          void hydrateDirectoryRowDetails({
            rows: childRows,
            setRows: setSearchRows,
            shouldContinue: () => searchRequestIdRef.current === requestId,
          });
        })
        .catch((searchError) => {
          if (searchRequestIdRef.current !== requestId) {
            return;
          }
          setError(searchError instanceof Error ? searchError.message : 'Directories could not be searched');
        })
        .finally(() => {
          if (searchRequestIdRef.current === requestId) {
            setLoadingSearch(false);
          }
        });
    }, searchDebounceMs);

    return () => window.clearTimeout(timer);
  }, [currentPath, normalizedQuery]);

  if (!draft) {
    return null;
  }

  return (
    <KeyboardPickerFrame
      className="remux-file-mention-picker remux-directory-picker"
      laneClassName="remux-file-mention-lane"
    >
      <div className="remux-directory-picker-header">
        <div className="remux-file-mention-title">
          <FolderOpen className="size-4" />
          <div className="remux-directory-picker-title">Pick working directory</div>
        </div>
        <div className="remux-directory-picker-description" title={currentPath}>
          {currentPath}
        </div>
      </div>

      <div className="remux-directory-picker-search">
        <Search className="size-4 shrink-0" />
        <input
          autoCapitalize="none"
          autoCorrect="off"
          className="remux-directory-picker-search-input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search directories"
          ref={inputRef}
          spellCheck={false}
          type="search"
          value={query}
        />
      </div>

      <KeyboardPickerList className="remux-file-mention-list">
        {rows.map((row, index) => (
          <DirectoryPickerRow
            active={index === 0 && Boolean(normalizedQuery)}
            key={row.id}
            onOpen={() => {
              setDirectoryPickerPath(row.path);
              setQuery('');
              focusSearchInput();
            }}
            row={row}
          />
        ))}
        {loading ? (
          <div className="remux-file-mention-status">
            <Loader2 className="size-4 animate-spin" />
            {normalizedQuery ? 'Searching directories' : 'Reading directory'}
          </div>
        ) : null}
        {!loading && normalizedQuery && rows.length === 0 && !error ? (
          <div className="remux-file-mention-status">No matching directories</div>
        ) : null}
        {error ? <div className="remux-file-mention-status remux-file-mention-error">{error}</div> : null}
      </KeyboardPickerList>
    </KeyboardPickerFrame>
  );
}

function DirectoryPickerRow({
  active,
  onOpen,
  row,
}: {
  active: boolean;
  onOpen: () => void;
  row: DirectoryRow;
}) {
  return (
    <KeyboardPickerRow
      active={active}
      className={`remux-file-mention-row remux-directory-picker-row${
        active ? ' remux-file-mention-row-active' : ''
      }`}
      focusable
      onActivate={onOpen}
    >
      <span className="remux-file-mention-icon remux-directory-picker-row-icon">
        <Folder className="size-5" />
      </span>
      <span className="remux-directory-picker-row-content">
        <span className="remux-directory-picker-row-name">{row.label}</span>
      </span>
      <span className="remux-directory-picker-row-meta">{formatDirectoryRowMeta(row)}</span>
      <ChevronRight className="remux-directory-picker-row-chevron size-4" />
    </KeyboardPickerRow>
  );
}

async function hydrateDirectoryRowDetails({
  rows,
  setRows,
  shouldContinue,
}: {
  rows: DirectoryRow[];
  setRows: Dispatch<SetStateAction<DirectoryRow[]>>;
  shouldContinue: () => boolean;
}) {
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < rows.length && shouldContinue()) {
      const row = rows[nextIndex++];
      const details = await readDirectoryStats(row.path).catch(() => ({
        itemCount: null,
        modifiedAtMs: null,
      }));

      if (!shouldContinue()) {
        return;
      }

      setRows((currentRows) =>
        currentRows.map((currentRow) =>
          currentRow.id === row.id
            ? {
                ...currentRow,
                itemCount: details.itemCount,
                modifiedAtMs: details.modifiedAtMs,
              }
            : currentRow,
        ),
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(directoryDetailsConcurrency, rows.length) }, () => worker()));
}

function formatDirectoryRowMeta(row: DirectoryRow) {
  const parts = [
    typeof row.itemCount === 'number' ? formatItemCount(row.itemCount) : null,
    typeof row.modifiedAtMs === 'number' ? formatModifiedDate(row.modifiedAtMs) : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' · ') : '';
}

function formatItemCount(count: number) {
  return count === 1 ? '1 item' : `${count} items`;
}

function formatModifiedDate(modifiedAtMs: number) {
  const date = new Date(modifiedAtMs);
  const currentYear = new Date().getFullYear();
  const options: Intl.DateTimeFormatOptions =
    date.getFullYear() === currentYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' };

  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function compareDirectoryEntryNames(left: { fileName: string }, right: { fileName: string }) {
  const leftHidden = left.fileName.startsWith('.');
  const rightHidden = right.fileName.startsWith('.');
  if (leftHidden !== rightHidden) {
    return leftHidden ? 1 : -1;
  }

  return left.fileName.localeCompare(right.fileName, undefined, { sensitivity: 'base' });
}

function joinPath(parent: string, child: string) {
  return `${normalizePath(parent).replace(/\/+$/, '')}/${child}`.replace(/^\/\//, '/');
}

function normalizePath(path: string) {
  return path.replace(/\\/g, '/') || '/';
}
