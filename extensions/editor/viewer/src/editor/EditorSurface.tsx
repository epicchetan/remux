import {
  closeHostTab,
  openHostOverview,
  subscribeHostActive,
  subscribeHostConnection,
  subscribeHostNavigate,
  updateHostTab,
} from '@remux/viewer-kit/host';
import type { RemuxViewerRoute } from '@remux/viewer-kit/route';
import { ActionBar, ActionButton } from '@remux/viewer-kit/ui';
import { Eye, PanelRightOpen, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { MarkdownPreview } from '../markdown/MarkdownPreview';
import { HtmlPreview } from '../html';
import { CodeMirrorViewer } from './CodeMirrorViewer';
import type { EditorDocument } from './fileLoading';
import { useEditorStore } from './store';

type EditorSurfaceProps = { route: RemuxViewerRoute };

export function EditorSurface({ route }: EditorSurfaceProps) {
  const state = useEditorStore();
  const copiedTimeoutRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [hostActive, setHostActive] = useState(true);
  const initialPath = route.resourceKind === 'file' ? route.resourceId : null;
  const initialLine = route.focusKind === 'line' ? parseLineNumber(route.focusId) : null;

  useEffect(() => {
    if (!initialPath) return;
    state.retarget(initialPath, { focus: initialLine ? { line: initialLine, nonce: null } : null });
    if (useEditorStore.getState().status === 'idle') void useEditorStore.getState().load();
  }, [initialLine, initialPath]);

  useEffect(() => subscribeHostNavigate((navigation) => {
    if (navigation.resourceKind !== 'file' || !navigation.resourceId) return;
    const line = navigation.focusKind === 'line' ? parseLineNumber(navigation.focusId) : null;
    state.retarget(navigation.resourceId, {
      focus: line ? { line, nonce: navigation.nonce } : null,
    });
    if (useEditorStore.getState().status === 'idle') void useEditorStore.getState().load();
  }), []);

  useEffect(() => subscribeHostConnection((connectionStatus, generation) => {
    state.setHostGeneration(generation);
    if (connectionStatus === 'connected' && useEditorStore.getState().status === 'idle' && useEditorStore.getState().path) {
      void useEditorStore.getState().load();
    }
  }), []);
  useEffect(() => subscribeHostActive(setHostActive), []);
  const documentIdentity = state.document?.kind === 'full'
    ? state.document.revision
    : state.document?.version ?? null;
  useEffect(() => {
    void updateHostTab(fileTabMetadata(state)).catch(() => undefined);
  }, [state.document, state.error, state.path, state.status]);
  useEffect(() => () => {
    if (copiedTimeoutRef.current !== null) window.clearTimeout(copiedTimeoutRef.current);
  }, []);

  const copyFileContents = async () => {
    if (state.document?.kind !== 'full') return;
    try {
      await copyText(state.document.text);
      setCopied(true);
      if (copiedTimeoutRef.current !== null) window.clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = window.setTimeout(() => setCopied(false), 1100);
    } catch {
      setCopied(false);
    }
  };
  const canPreview = state.previewKind !== null && state.document?.kind === 'full';
  const base = state.git.status === 'ready' ? state.git.metadata.base : null;
  const diffUnavailable = state.document?.kind === 'windowed'
    ? 'Diff is unavailable while viewing a file range.'
    : state.document?.kind === 'full' && state.document.lightweight
      ? 'Diff is unavailable for large files or long lines.'
      : state.git.status === 'error' ? state.git.message
        : state.git.status === 'ready' && state.git.metadata.base?.content == null
          ? state.git.metadata.base?.unavailableReason ?? 'No Git comparison is available.'
          : null;

  return (
    <main className="remux-editor-shell">
      <EditorBody
        key={`${state.path ?? ''}:${documentIdentity ?? ''}`}
        active={hostActive}
        baseContent={state.diffVisible ? base?.content ?? null : null}
        document={state.document}
        error={state.error}
        mode={state.mode}
        onFocusApplied={() => state.acknowledgeFocus(state.pendingFocus?.nonce ?? null)}
        pendingLine={state.pendingFocus?.line ?? null}
        previewKind={state.previewKind}
        status={state.status}
      />
      {state.document?.kind === 'windowed' ? <WindowControls document={state.document} /> : null}
      <ActionBar
        left={<>
          <ActionButton icon={<TabsIcon />} label="Open tabs" onClick={() => void openHostOverview()} />
          <ActionButton icon={<ReloadIcon />} label="Reload file" onClick={() => void state.reload()} />
          {state.previewKind ? (
            <ActionButton
              ariaPressed={state.mode === 'preview'}
              disabled={!canPreview}
              icon={<Eye aria-hidden="true" className={state.mode === 'preview' ? 'remux-editor-preview-icon-active' : ''} />}
              label={state.mode === 'preview' ? 'Show source' : 'Show preview'}
              onClick={() => state.setMode(state.mode === 'preview' ? 'source' : 'preview')}
            />
          ) : null}
          <ActionButton
            disabled={state.document?.kind !== 'full'}
            icon={copied ? <CheckIcon /> : <CopyIcon />}
            label={state.document?.kind === 'windowed' ? 'Full-file copy is unavailable for paged Source' : copied ? 'Copied file contents' : 'Copy file contents'}
            onClick={() => void copyFileContents()}
          />
        </>}
        right={<>
          <ActionButton disabled={Boolean(diffUnavailable) || state.document?.kind !== 'full'} icon={<DiffIcon />} label={diffUnavailable ?? (state.diffVisible ? 'Hide git diff' : 'Show git diff')} onClick={() => void state.showDiff()} />
          <ActionButton icon={<X aria-hidden="true" />} label="Close tab" onClick={() => void closeHostTab()} />
        </>}
        status={copied ? 'Copied' : state.error ?? fileInfoText(state.document, state.path)}
      />
    </main>
  );
}

function EditorBody({ active, baseContent, document, error, mode, onFocusApplied, pendingLine, previewKind, status }: {
  active: boolean;
  baseContent: string | null;
  document: EditorDocument | null;
  error: string | null;
  mode: 'preview' | 'source';
  onFocusApplied: () => void;
  pendingLine: number | null;
  previewKind: 'html' | 'markdown' | null;
  status: string;
}) {
  const [visitedModes, setVisitedModes] = useState<Set<'preview' | 'source'>>(() => new Set([mode]));
  useEffect(() => {
    setVisitedModes((current) => current.has(mode) ? current : new Set([...current, mode]));
  }, [mode]);
  if (!document && (status === 'loading' || status === 'refreshing')) return <Empty title="Reading file" spinner />;
  if (!document && status === 'error') return <Empty copy={error} title="Could not open file" />;
  if (!document) return <Empty copy="Open a file from Files to view it." title="No file selected" />;
  const focusLine = document.kind === 'windowed'
    ? document.targetLine?.lineNumber === pendingLine ? 1 : null
    : pendingLine;
  const lineNumberStart = document.kind === 'windowed' ? document.targetLine?.lineNumber ?? null : null;
  return (
    <section className="remux-editor-content-shell">
      {visitedModes.has('source') ? <div aria-hidden={mode !== 'source'} className={`remux-editor-renderer ${mode === 'source' ? '' : 'remux-editor-renderer-hidden'}`}>
        <CodeMirrorViewer
          key={document.kind === 'full' ? document.revision : `${document.version}:${document.range.startByte}:${document.range.endByte}`}
          baseContent={baseContent}
          content={document.text}
          fileName={document.name}
          focusLine={focusLine}
          lightweight={document.kind === 'windowed' || document.lightweight}
          lineNumberStart={lineNumberStart}
          onFocusApplied={onFocusApplied}
          showDiff={baseContent !== null}
          visible={mode === 'source'}
        />
      </div> : null}
      {visitedModes.has('preview') && document.kind === 'full' && previewKind === 'markdown' ? (
        <div aria-hidden={mode !== 'preview'} className={`remux-editor-renderer ${mode === 'preview' ? '' : 'remux-editor-renderer-hidden'}`}>
          <MarkdownPreview key={document.revision} content={document.text} filePath={document.path} onShowSource={() => useEditorStore.getState().setMode('source')} />
        </div>
      ) : null}
      {visitedModes.has('preview') && document.kind === 'full' && previewKind === 'html' ? (
        <div aria-hidden={mode !== 'preview'} className={`remux-editor-renderer ${mode === 'preview' ? '' : 'remux-editor-renderer-hidden'}`}>
          <HtmlPreview key={document.revision} active={active} content={document.text} filePath={document.path} />
        </div>
      ) : null}
    </section>
  );
}

function WindowControls({ document }: { document: Extract<EditorDocument, { kind: 'windowed' }> }) {
  const state = useEditorStore();
  return <nav aria-label="Source range" className="remux-editor-window-controls">
    <span>{formatSize(document.range.startByte)}–{formatSize(document.range.endByte)} of {formatSize(document.totalSizeBytes)}
      {document.targetLine ? ` · from line ${document.targetLine.lineNumber}` : document.range.startByte > 0 ? ' · line numbers within range' : ''}
      {document.continuation.startsMidLine ? ' · starts within a line' : ''}
      {document.continuation.endsMidLine ? ' · line continues in next range' : ''}
    </span>
    <button disabled={document.range.startByte === 0} onClick={() => void state.loadStart()}>Start</button>
    <button disabled={document.previousOffset == null} onClick={() => void state.loadPrevious()}>Previous</button>
    <button disabled={document.nextOffset == null} onClick={() => void state.loadNext()}>Next</button>
    <button disabled={document.eof} onClick={() => void state.loadEnd()}>End</button>
  </nav>;
}

function Empty({ copy, spinner, title }: { copy?: string | null; spinner?: boolean; title: string }) {
  return <section className="remux-editor-empty"><div className="remux-editor-empty-card">
    {spinner ? <div className="remux-editor-spinner" aria-hidden="true" /> : null}
    <div className="remux-editor-empty-title">{title}</div>{copy ? <div className="remux-editor-empty-copy">{copy}</div> : null}
  </div></section>;
}

function fileTabMetadata(state: ReturnType<typeof useEditorStore.getState>) {
  const document = state.document;
  return { resourceId: state.path, resourceKind: state.path ? 'file' : null, status: state.status === 'error' ? 'Error' : document ? formatSize(document.kind === 'full' ? document.sizeBytes : document.totalSizeBytes) : null, title: document?.name ?? (state.path ? basename(state.path) : 'Viewer') };
}
function fileInfoText(document: EditorDocument | null, path: string | null) { return document ? `${document.name} / ${formatSize(document.kind === 'full' ? document.sizeBytes : document.totalSizeBytes)}` : path ? basename(path) : null; }
function formatSize(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function parseLineNumber(value: string | null | undefined) { const line = Number(value); return Number.isFinite(line) && line > 0 ? Math.floor(line) : null; }
function basename(path: string) { return path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || path; }
async function copyText(text: string) { if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text); const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select(); const copied = document.execCommand('copy'); area.remove(); if (!copied) throw new Error('Copy failed'); }
function TabsIcon() { return <PanelRightOpen aria-hidden="true" className="size-4" />; }
function ReloadIcon() { return <svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>; }
function DiffIcon() { return <svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2zM9 10h6M12 13V7M9 17h6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>; }
function CopyIcon() { return <svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><rect height="13" rx="2" stroke="currentColor" strokeWidth="2" width="13" x="8" y="8" /><path d="M4 15V5a1 1 0 0 1 1-1h10" stroke="currentColor" strokeWidth="2" /></svg>; }
function CheckIcon() { return <svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2.4" /></svg>; }
