import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { measureNaturalWidth, prepareWithSegments } from '@chenglou/pretext';
import { Folder, Laptop, Loader2, X } from 'lucide-react';

import { searchComposerMentionFiles } from '../../ipc/files';
import { useThreadHistoryStore } from '../../threads/historyStore';
import { useThreadsStore } from '../../threads/store';
import { FileTypeIcon } from '../../transcript/components/file/fileTypeIcons';
import { cn } from '@remux/viewer-kit/shadcn';
import { KeyboardPickerFrame, KeyboardPickerList, KeyboardPickerRow } from '../../ui/KeyboardPicker';
import {
  fileExtension,
  parseComposerMentionQuery,
  type ComposerMentionItem,
} from './mentionSearch';
import type { ComposerMentionSession } from './mentionSession';

const maxMentionRows = 40;
const mentionControlSelector = '[data-remux-mention-control="true"]';
const mentionRowGap = 8;
const mentionRowIconWidth = 22;
const mentionRowMinimumPathWidth = 42;
const searchDebounceMs = 60;

export function ComposerMentionPicker({ session }: { session: ComposerMentionSession }) {
  const activeThreadId = useThreadsStore((state) => state.activeThreadId);
  const activeThreadCwd = useThreadHistoryStore((state) =>
    activeThreadId ? state.threadsById[activeThreadId]?.cwd ?? null : null);
  const draftCwd = useThreadsStore((state) =>
    state.activeDraftId && state.draft?.id === state.activeDraftId ? state.draft.cwd : null);
  const pickerRef = useRef<HTMLElement | null>(null);
  const query = useMemo(() => parseComposerMentionQuery(session.query), [session.query]);
  const searchRoot = draftCwd ?? activeThreadCwd ?? undefined;
  const [rows, setRows] = useState<ComposerMentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const visibleRows = rows.slice(0, maxMentionRows);
  const isEmptyQuery = query.normalizedQuery.length === 0;

  useNonFocusableMentionControls(pickerRef);

  const selectRow = useCallback(
    (row: ComposerMentionItem | null) => {
      if (!row) {
        return;
      }

      session.selectFile(row);
    },
    [session],
  );

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setError(null);
    setRows([]);

    if (!query.normalizedQuery) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = window.setTimeout(() => {
      void searchComposerMentionFiles(query.normalizedQuery, searchRoot)
        .then((files) => {
          if (requestIdRef.current !== requestId) {
            return;
          }

          setRows(files);
        })
        .catch((searchError) => {
          if (requestIdRef.current !== requestId) {
            return;
          }

          setRows([]);
          setError(searchError instanceof Error ? searchError.message : 'Files could not be searched');
        })
        .finally(() => {
          if (requestIdRef.current === requestId) {
            setLoading(false);
          }
        });
    }, searchDebounceMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [query.normalizedQuery, searchRoot]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.isComposing) {
        return;
      }

      switch (event.key) {
        case 'Enter':
        case 'Tab':
          event.preventDefault();
          event.stopPropagation();
          selectRow(visibleRows[0] ?? null);
          break;
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          session.close();
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [selectRow, session, visibleRows]);

  const showEmpty = !isEmptyQuery && !loading && !error && visibleRows.length === 0;

  return (
    <KeyboardPickerFrame
      className="remux-file-mention-picker"
      laneClassName="remux-file-mention-lane"
      ref={pickerRef}
    >
      <div className="remux-file-mention-header">
        <div className="remux-file-mention-title">
          <Laptop className="size-4" />
          <span className="remux-file-mention-title-path" title="Workspace files">Workspace files</span>
        </div>
        <div className="remux-file-mention-header-actions">
          <MentionHeaderControl
            aria-label="Close file picker"
            onActivate={session.removeTrigger}
          >
            <X className="size-4" />
          </MentionHeaderControl>
        </div>
      </div>
      <KeyboardPickerList className="remux-file-mention-list">
        {visibleRows.map((row, index) => (
          <FileMentionRow
            active={index === 0}
            key={row.id}
            onSelect={() => selectRow(row)}
            row={row}
          />
        ))}
        {loading ? (
          <div className="remux-file-mention-status">
            <Loader2 className="size-4 animate-spin" />
            Searching files
          </div>
        ) : null}
        {showEmpty ? (
          <div className="remux-file-mention-status">
            No matching files
          </div>
        ) : null}
        {error ? (
          <div className="remux-file-mention-status remux-file-mention-error">{error}</div>
        ) : null}
      </KeyboardPickerList>
    </KeyboardPickerFrame>
  );
}

function MentionHeaderControl({
  children,
  onActivate,
  ...props
}: {
  'aria-label': string;
  children: ReactNode;
  onActivate: () => void;
}) {
  const lastActivationMsRef = useRef(0);
  const activateOnce = useCallback(() => {
    const now = performance.now();
    if (now - lastActivationMsRef.current < 350) {
      return;
    }

    lastActivationMsRef.current = now;
    onActivate();
  }, [onActivate]);

  return (
    <div
      {...props}
      className="remux-file-mention-header-button"
      data-remux-mention-control="true"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        event.stopPropagation();
        activateOnce();
      }}
      onTouchEnd={(event) => {
        event.preventDefault();
        event.stopPropagation();
        activateOnce();
      }}
      role="button"
    >
      {children}
    </div>
  );
}

function useNonFocusableMentionControls(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    function cancelFocusTransfer(event: Event) {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(mentionControlSelector)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    }

    element.addEventListener('touchstart', cancelFocusTransfer, { capture: true, passive: false });
    element.addEventListener('mousedown', cancelFocusTransfer, { capture: true });
    element.addEventListener('pointerdown', cancelFocusTransfer, { capture: true });

    return () => {
      element.removeEventListener('touchstart', cancelFocusTransfer, { capture: true });
      element.removeEventListener('mousedown', cancelFocusTransfer, { capture: true });
      element.removeEventListener('pointerdown', cancelFocusTransfer, { capture: true });
    };
  }, [ref]);
}

function FileMentionRow({
  active,
  onSelect,
  row,
}: {
  active: boolean;
  onSelect: () => void;
  row: ComposerMentionItem;
}) {
  const label = useMeasuredMentionRowLabel(row);
  const nameStyle = label.showPath
    ? ({
        maxWidth: `${label.nameWidth}px`,
        width: `${label.nameWidth}px`,
      } satisfies CSSProperties)
    : undefined;
  const pathStyle = label.showPath
    ? ({
        maxWidth: `${label.pathWidth}px`,
      } satisfies CSSProperties)
    : undefined;

  return (
    <KeyboardPickerRow
      active={active}
      className={cn('remux-file-mention-row', active && 'remux-file-mention-row-active')}
      onActivate={onSelect}
      ref={label.rowRef}
    >
      <span className="remux-file-mention-icon">
        {row.kind === 'directory' ? (
          <Folder className="size-[17px]" />
        ) : (
          <FileTypeIcon extension={fileExtension(row.name)} fileName={row.name} />
        )}
      </span>
      <span className="remux-file-mention-name" ref={label.nameRef} style={nameStyle} title={row.name}>
        {row.name}
      </span>
      <span
        className="remux-file-mention-path"
        data-visible={label.showPath}
        ref={label.pathRef}
        style={pathStyle}
        title={row.parentPath}
      >
        {label.pathLabel}
      </span>
    </KeyboardPickerRow>
  );
}

function useMeasuredMentionRowLabel(row: ComposerMentionItem) {
  const [rowElement, setRowElement] = useState<HTMLDivElement | null>(null);
  const [nameElement, setNameElement] = useState<HTMLSpanElement | null>(null);
  const [pathElement, setPathElement] = useState<HTMLSpanElement | null>(null);
  const [label, setLabel] = useState({
    nameWidth: 0,
    pathLabel: row.parentPath,
    pathWidth: 0,
    showPath: false,
  });

  useEffect(() => {
    if (!rowElement || !nameElement || !pathElement || !row.parentPath) {
      setMeasuredLabel({
        nameWidth: 0,
        pathLabel: row.parentPath,
        pathWidth: 0,
        showPath: false,
      });
      return;
    }

    const measuredRowElement = rowElement;
    const measuredNameElement = nameElement;
    const measuredPathElement = pathElement;

    function updateLabel() {
      const rowStyle = window.getComputedStyle(measuredRowElement);
      const paddingX = parseFloat(rowStyle.paddingLeft) + parseFloat(rowStyle.paddingRight);
      const rowWidth = measuredRowElement.getBoundingClientRect().width;
      const availableWidth = Math.max(0, rowWidth - paddingX - mentionRowIconWidth - mentionRowGap);
      const nameWidth = Math.ceil(measuredTextWidth(row.name, fontForElement(measuredNameElement)));

      if (nameWidth >= availableWidth) {
        setMeasuredLabel({
          nameWidth: 0,
          pathLabel: row.parentPath,
          pathWidth: 0,
          showPath: false,
        });
        return;
      }

      const pathWidth = Math.floor(availableWidth - nameWidth - mentionRowGap);
      if (pathWidth < mentionRowMinimumPathWidth) {
        setMeasuredLabel({
          nameWidth: 0,
          pathLabel: row.parentPath,
          pathWidth: 0,
          showPath: false,
        });
        return;
      }

      const pathFont = fontForElement(measuredPathElement);
      const pathLabel = compactPathToWidth(row.parentPath, pathWidth, pathFont);
      const measuredPathWidth = Math.ceil(measuredTextWidth(pathLabel, pathFont));
      if (measuredPathWidth > pathWidth) {
        setMeasuredLabel({
          nameWidth: 0,
          pathLabel: row.parentPath,
          pathWidth: 0,
          showPath: false,
        });
        return;
      }

      setMeasuredLabel({
        nameWidth,
        pathLabel,
        pathWidth: measuredPathWidth,
        showPath: true,
      });
    }

    function setMeasuredLabel(nextLabel: typeof label) {
      setLabel((current) =>
        current.nameWidth === nextLabel.nameWidth &&
          current.pathLabel === nextLabel.pathLabel &&
          current.pathWidth === nextLabel.pathWidth &&
          current.showPath === nextLabel.showPath
          ? current
          : nextLabel);
    }

    updateLabel();
    const resizeObserver = new ResizeObserver(updateLabel);
    resizeObserver.observe(measuredRowElement);
    window.addEventListener('resize', updateLabel);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateLabel);
    };
  }, [nameElement, pathElement, row.name, row.parentPath, rowElement]);

  return {
    nameRef: setNameElement,
    nameWidth: label.nameWidth,
    pathLabel: label.pathLabel,
    pathRef: setPathElement,
    pathWidth: label.pathWidth,
    rowRef: setRowElement,
    showPath: label.showPath,
  };
}

function compactPathToWidth(path: string, width: number, font: string) {
  if (!path || width <= 0 || measuredTextWidth(path, font) <= width) {
    return path;
  }

  for (const candidate of compactPathCandidates(path)) {
    if (measuredTextWidth(candidate, font) <= width) {
      return candidate;
    }
  }

  return compactPathCandidates(path).at(-1) ?? path;
}

function compactPathCandidates(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const isAbsolute = normalized.startsWith('/');
  const segments = normalized.split('/').filter(Boolean);

  if (segments.length === 0) {
    return [path];
  }

  const candidates: string[] = [];
  for (let startIndex = 1; startIndex < segments.length; startIndex += 1) {
    candidates.push(`.../${segments.slice(startIndex).join('/')}`);
  }

  candidates.push(`.../${segments.at(-1)}`);

  return uniqueStrings(isAbsolute ? candidates : [normalized, ...candidates]);
}

function measuredTextWidth(text: string, font: string) {
  return measureNaturalWidth(prepareWithSegments(text, font, { whiteSpace: 'normal' }));
}

function fontForElement(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  const font = style.font && style.font !== '' ? style.font : null;

  if (font) {
    return font;
  }

  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return true;
  });
}
