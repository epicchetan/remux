import { openHostOverview, reloadHostView, updateHostTab } from '@remux/extension-api/host';
import type { RemuxViewerRoute } from '@remux/extension-api/route';
import {
  ExtensionActionBar,
  ExtensionActionButton,
} from '@remux/extension-ui';
import { Copy, PanelRightOpen, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { MarkdownRenderer } from './MarkdownRenderer';
import { useMarkdownStore } from './store';

type MarkdownSurfaceProps = {
  route: RemuxViewerRoute;
};

export function MarkdownSurface({ route }: MarkdownSurfaceProps) {
  const filePath = route.resourceKind === 'file' ? route.resourceId : null;
  const activeFile = useMarkdownStore((state) => state.activeFile);
  const loadFile = useMarkdownStore((state) => state.loadFile);
  const fileInfo = fileInfoText({ activeFile, filePath });
  const copiedTimeoutRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!filePath) {
      return;
    }

    void loadFile(filePath);
  }, [filePath, loadFile]);

  useEffect(() => () => {
    if (copiedTimeoutRef.current !== null) {
      window.clearTimeout(copiedTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    void updateHostTab(fileTabMetadata({ activeFile, filePath })).catch(() => undefined);
  }, [activeFile, filePath]);

  const copyMarkdown = () => {
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
    <main className="remux-markdown-shell">
      <MarkdownBody activeFile={activeFile} filePath={filePath} />
      <ExtensionActionBar
        left={(
          <>
            <ExtensionActionButton
              icon={<PanelRightOpen aria-hidden="true" />}
              label="Open tabs"
              onClick={() => {
                void openHostOverview();
              }}
            />
            <ExtensionActionButton
              icon={<RefreshCw aria-hidden="true" />}
              label="Reload viewer"
              onClick={() => {
                void reloadHostView();
              }}
            />
            <ExtensionActionButton
              disabled={activeFile.status !== 'ready'}
              icon={copied ? <CheckIcon /> : <Copy aria-hidden="true" />}
              label={copied ? 'Copied markdown' : 'Copy markdown'}
              onClick={copyMarkdown}
            />
          </>
        )}
        status={copied ? 'Copied' : fileInfo}
      />
    </main>
  );
}

function MarkdownBody({
  activeFile,
  filePath,
}: {
  activeFile: ReturnType<typeof useMarkdownStore.getState>['activeFile'];
  filePath: string | null;
}) {
  if (!filePath || activeFile.status === 'idle') {
    return (
      <section className="remux-markdown-empty">
        <div className="remux-markdown-empty-card">
          <div className="remux-markdown-empty-title">No markdown selected</div>
          <div className="remux-markdown-empty-copy">
            Open a Markdown file from Files to start reading.
          </div>
        </div>
      </section>
    );
  }

  if (activeFile.status === 'loading') {
    return (
      <section className="remux-markdown-empty">
        <div className="remux-markdown-spinner" aria-hidden="true" />
        <div className="remux-markdown-empty-copy">Reading markdown</div>
      </section>
    );
  }

  if (activeFile.status === 'error') {
    return (
      <section className="remux-markdown-empty">
        <div className="remux-markdown-empty-card">
          <div className="remux-markdown-empty-title">Could not open markdown</div>
          <div className="remux-markdown-empty-copy">{activeFile.message}</div>
        </div>
      </section>
    );
  }

  if (activeFile.status === 'unsupported') {
    return (
      <section className="remux-markdown-empty">
        <div className="remux-markdown-empty-card">
          <div className="remux-markdown-empty-title">
            {activeFile.tooLarge ? 'File is too large' : activeFile.isBinary ? 'Binary file' : 'Unsupported file'}
          </div>
          <div className="remux-markdown-empty-copy">
            {formatSize(activeFile.sizeBytes)} cannot be displayed as Markdown yet.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="remux-markdown-content-shell">
      <MarkdownRenderer content={activeFile.content} filePath={activeFile.path} />
    </section>
  );
}

function fileInfoText({
  activeFile,
  filePath,
}: {
  activeFile: ReturnType<typeof useMarkdownStore.getState>['activeFile'];
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
  activeFile: ReturnType<typeof useMarkdownStore.getState>['activeFile'];
  filePath: string | null;
}) {
  if (activeFile.status === 'ready') {
    return {
      status: formatSize(activeFile.sizeBytes),
      title: activeFile.name,
    };
  }

  if (activeFile.status === 'unsupported') {
    return {
      status: activeFile.tooLarge ? 'Too large' : activeFile.isBinary ? 'Binary file' : 'Unsupported',
      title: activeFile.name,
    };
  }

  if (activeFile.status === 'loading') {
    return {
      status: 'Reading',
      title: basename(activeFile.path),
    };
  }

  if (activeFile.status === 'error') {
    return {
      status: 'Error',
      title: basename(activeFile.path),
    };
  }

  return {
    status: null,
    title: filePath ? basename(filePath) : 'Markdown',
  };
}

function basename(path: string) {
  const normalized = path.replace(/[\\/]+$/u, '');
  const parts = normalized.split(/[\\/]/u);
  return parts.at(-1) || normalized;
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

function CheckIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="m20 6-11 11-5-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}
