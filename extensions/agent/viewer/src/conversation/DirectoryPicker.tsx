import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, FolderOpen, Loader2, Search } from 'lucide-react';
import { rpc } from '@remux/viewer-kit';

import { KeyboardPickerFrame, KeyboardPickerList, KeyboardPickerRow } from '../ui/KeyboardPicker.tsx';
import { useConversationStore } from './store.ts';

type DirectoryEntry = { name: string; path: string };

export function AgentDirectoryPicker() {
  const close = useConversationStore((state) => state.closeDirectoryPicker);
  const path = useConversationStore((state) => state.directoryPickerPath);
  const setPath = useConversationStore((state) => state.setDirectoryPickerPath);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);

  useEffect(() => {
    if (!path) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    setQuery('');
    void rpc.query<{
      entries: Array<{ kind: string; name: string; path: string; targetKind?: string | null }>;
      path: string;
    }>('remux/fs/readDirectory', { path })
      .then((result) => {
        if (requestRef.current !== requestId) return;
        setPath(result.path);
        setEntries(result.entries
          .filter((entry) => entry.kind === 'directory' || (entry.kind === 'symlink' && entry.targetKind === 'directory'))
          .map((entry) => ({ name: entry.name, path: entry.path }))
          .sort((left, right) => left.name.localeCompare(right.name)));
      })
      .catch((reason) => {
        if (requestRef.current !== requestId) return;
        setEntries([]);
        setError(reason instanceof Error ? reason.message : 'Directory could not be read');
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false);
      });
  }, [path, setPath]);

  const visibleEntries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(normalized))
      : entries;
  }, [entries, query]);

  if (!path) return null;

  return (
    <KeyboardPickerFrame className="remux-file-mention-picker remux-directory-picker" laneClassName="remux-file-mention-lane">
      <div className="remux-directory-picker-header">
        <div className="remux-file-mention-title"><FolderOpen className="size-4" />Pick working directory</div>
        <div className="remux-directory-picker-description" title={path}>{path}</div>
      </div>
      <div className="remux-directory-picker-search">
        <Search className="size-4 shrink-0" />
        <input
          aria-label="Filter directories"
          autoCapitalize="none"
          autoCorrect="off"
          className="remux-directory-picker-search-input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter this directory"
          ref={inputRef}
          spellCheck={false}
          type="search"
          value={query}
        />
      </div>
      <KeyboardPickerList className="remux-file-mention-list">
        {visibleEntries.map((entry, index) => (
          <KeyboardPickerRow
            active={index === 0 && Boolean(query.trim())}
            aria-label={`${entry.name}/`}
            className="remux-file-mention-row remux-directory-picker-row"
            key={entry.path}
            onActivate={() => {
              setPath(entry.path);
              window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
            }}
          >
            <span className="remux-file-mention-icon remux-directory-picker-row-icon"><Folder className="size-5" /></span>
            <span className="remux-directory-picker-row-content"><span className="remux-directory-picker-row-name">{entry.name}</span></span>
          </KeyboardPickerRow>
        ))}
        {loading ? <div className="remux-file-mention-status"><Loader2 className="size-4 animate-spin" />Reading directory</div> : null}
        {!loading && visibleEntries.length === 0 && !error ? <div className="remux-file-mention-status">No matching directories</div> : null}
        {error ? <div className="remux-file-mention-status remux-file-mention-error">{error}</div> : null}
      </KeyboardPickerList>
    </KeyboardPickerFrame>
  );
}
