import { openHostOverview, reloadHostView, updateHostTab } from '@remux/extension-api/host';
import type { RemuxViewerRoute } from '@remux/extension-api/route';
import {
  ExtensionActionBar,
  ExtensionActionButton,
} from '@remux/extension-ui';
import { PanelRightOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { CodeMirrorViewer } from './CodeMirrorViewer';
import { useEditorStore } from './store';

type EditorSurfaceProps = {
  route: RemuxViewerRoute;
};

export function EditorSurface({ route }: EditorSurfaceProps) {
  const filePath = route.resourceKind === 'file' ? route.resourceId : null;
  const activeFile = useEditorStore((state) => state.activeFile);
  const loadFile = useEditorStore((state) => state.loadFile);
  const fileInfo = fileInfoText({ activeFile, filePath });
  const copiedTimeoutRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const activeBase = activeFile.status === 'ready' ? activeFile.git?.base ?? null : null;
  const activeGitStatus = activeFile.status === 'ready' ? activeFile.git?.status ?? null : null;
  const diffUnavailableReason = activeGitStatus && (activeBase?.tooLarge ||
    activeBase?.isBinary ||
    (activeBase && activeBase.content == null))
    ? activeBase.unavailableReason ?? 'Base file unavailable'
    : null;
  const hasDiff = Boolean(
    activeGitStatus &&
    activeBase?.content != null &&
    !activeBase.tooLarge &&
    !activeBase.isBinary,
  );

  useEffect(() => {
    if (!filePath) {
      return;
    }

    void loadFile(filePath);
  }, [filePath, loadFile]);

  useEffect(() => {
    setShowDiff(false);
  }, [filePath]);

  useEffect(() => {
    if (!hasDiff) {
      setShowDiff(false);
    }
  }, [hasDiff]);

  useEffect(() => {
    void updateHostTab(fileTabMetadata({ activeFile, filePath })).catch(() => undefined);
  }, [activeFile, filePath]);

  useEffect(() => () => {
    if (copiedTimeoutRef.current !== null) {
      window.clearTimeout(copiedTimeoutRef.current);
    }
  }, []);

  const copyFileContents = () => {
    if (activeFile.status !== 'ready') {
      return;
    }

    void copyText(activeFile.content);
    setCopied(true);
    if (copiedTimeoutRef.current !== null) {
      window.clearTimeout(copiedTimeoutRef.current);
    }
    copiedTimeoutRef.current = window.setTimeout(() => {
      copiedTimeoutRef.current = null;
      setCopied(false);
    }, 1100);
  };

  return (
    <main className="remux-editor-shell">
      <EditorBody
        activeBaseContent={hasDiff ? activeBase?.content ?? null : null}
        activeFile={activeFile}
        filePath={filePath}
        showDiff={showDiff}
      />
      <ExtensionActionBar
        left={(
          <>
            <ExtensionActionButton
              icon={<TabsIcon />}
              label="Open tabs"
              onClick={() => {
                void openHostOverview();
              }}
            />
            <ExtensionActionButton
              icon={<ReloadIcon />}
              label="Reload viewer"
              onClick={() => {
                void reloadHostView();
              }}
            />
            <ExtensionActionButton
              disabled={activeFile.status !== 'ready'}
              icon={copied ? <CheckIcon /> : <CopyIcon />}
              label={copied ? 'Copied file contents' : 'Copy file contents'}
              onClick={copyFileContents}
            />
          </>
        )}
        right={(
          <ExtensionActionButton
            disabled={!hasDiff}
            icon={<DiffIcon />}
            label={diffUnavailableReason ?? (showDiff ? 'Hide git diff' : 'Show git diff')}
            onClick={() => {
              setShowDiff((value) => !value);
            }}
          />
        )}
        status={copied ? 'Copied' : diffUnavailableReason ?? fileInfo}
      />
    </main>
  );
}

function EditorBody({
  activeBaseContent,
  activeFile,
  filePath,
  showDiff,
}: {
  activeBaseContent: string | null;
  activeFile: ReturnType<typeof useEditorStore.getState>['activeFile'];
  filePath: string | null;
  showDiff: boolean;
}) {
  if (!filePath || activeFile.status === 'idle') {
    return (
      <section className="remux-editor-empty">
        <div className="remux-editor-empty-card">
          <div className="remux-editor-empty-title">No file selected</div>
          <div className="remux-editor-empty-copy">
            Open a text file from Files to start editing.
          </div>
        </div>
      </section>
    );
  }

  if (activeFile.status === 'loading') {
    return (
      <section className="remux-editor-empty">
        <div className="remux-editor-spinner" aria-hidden="true" />
        <div className="remux-editor-empty-copy">Reading file</div>
      </section>
    );
  }

  if (activeFile.status === 'error') {
    return (
      <section className="remux-editor-empty">
        <div className="remux-editor-empty-card">
          <div className="remux-editor-empty-title">Could not open file</div>
          <div className="remux-editor-empty-copy">{activeFile.message}</div>
        </div>
      </section>
    );
  }

  if (activeFile.status === 'unsupported') {
    return (
      <section className="remux-editor-empty">
        <div className="remux-editor-empty-card">
          <div className="remux-editor-empty-title">
            {activeFile.tooLarge ? 'File is too large' : activeFile.isBinary ? 'Binary file' : 'Unsupported file'}
          </div>
          <div className="remux-editor-empty-copy">
            {formatSize(activeFile.sizeBytes)} cannot be displayed as editable text yet.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="remux-editor-content-shell">
      <CodeMirrorViewer
        baseContent={activeBaseContent}
        content={activeFile.content}
        fileName={activeFile.name}
        showDiff={showDiff}
      />
    </section>
  );
}

function formatSize(sizeBytes: number | null | undefined) {
  if (sizeBytes == null) {
    return null;
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${Math.round(sizeBytes / 1024)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileInfoText({
  activeFile,
  filePath,
}: {
  activeFile: ReturnType<typeof useEditorStore.getState>['activeFile'];
  filePath: string | null;
}) {
  if (activeFile.status === 'ready' || activeFile.status === 'unsupported') {
    return `${activeFile.name} / ${formatSize(activeFile.sizeBytes) ?? ''}`;
  }

  if (filePath) {
    return basename(filePath);
  }

  return null;
}

function fileTabMetadata({
  activeFile,
  filePath,
}: {
  activeFile: ReturnType<typeof useEditorStore.getState>['activeFile'];
  filePath: string | null;
}) {
  if (activeFile.status === 'ready') {
    return {
      status: formatSize(activeFile.sizeBytes),
      subtitle: parentPath(activeFile.path),
      title: activeFile.name,
    };
  }

  if (activeFile.status === 'unsupported') {
    return {
      status: activeFile.tooLarge ? 'Too large' : activeFile.isBinary ? 'Binary file' : 'Unsupported',
      subtitle: parentPath(activeFile.path),
      title: activeFile.name,
    };
  }

  if (activeFile.status === 'loading') {
    return {
      status: 'Reading',
      subtitle: parentPath(activeFile.path),
      title: basename(activeFile.path),
    };
  }

  if (activeFile.status === 'error') {
    return {
      status: 'Error',
      subtitle: parentPath(activeFile.path),
      title: basename(activeFile.path),
    };
  }

  return {
    status: null,
    subtitle: filePath ? parentPath(filePath) : null,
    title: filePath ? basename(filePath) : 'Editor',
  };
}

function basename(path: string) {
  const normalized = path.replace(/[\\/]+$/u, '');
  const parts = normalized.split(/[\\/]/u);
  return parts.at(-1) || normalized;
}

function parentPath(path: string) {
  const normalized = path.replace(/[\\/]+$/u, '');
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index > 0 ? normalized.slice(0, index) : null;
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function TabsIcon() {
  return <PanelRightOpen aria-hidden="true" className="size-4" />;
}

function ReloadIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M20 12a8 8 0 1 1-2.34-5.66"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M20 4v5h-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function DiffIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M9 10h6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M12 13V7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M9 17h6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <rect
        height="13"
        rx="2"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
        width="13"
        x="8"
        y="8"
      />
      <path
        d="M4 15V5a1 1 0 0 1 1-1h10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="m5 12 4 4L19 6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
    </svg>
  );
}
