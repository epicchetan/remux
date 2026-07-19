import { closeHostTab, openHostOverview, reloadHostView, subscribeHostNavigate, updateHostTab } from '@remux/viewer-kit/host';
import type { RemuxViewerRoute } from '@remux/viewer-kit/route';
import {
  ActionBar,
  ActionButton,
  ActionMenu,
  ActionMenuItem,
} from '@remux/viewer-kit/ui';
import { Copy, Menu, PanelRightOpen, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { MarkdownRenderer } from './MarkdownRenderer';
import {
  buildMarkdownNarrationModel,
  type MarkdownNarrationModel,
} from './narrationModel';
import { useMarkdownStore } from './store';
import { NarrationActions } from '../narration/NarrationActions';
import { useNarrationStore } from '../narration/client';
import {
  getNarrationDomSnapshot,
  subscribeNarrationDom,
} from '../narration/domIndex';
import { narrationStatusText } from '../narration/narrationStatus';

type MarkdownSurfaceProps = {
  route: RemuxViewerRoute;
};

export function MarkdownSurface({ route }: MarkdownSurfaceProps) {
  const [filePath, setFilePath] = useState(route.resourceKind === 'file' ? route.resourceId : null);
  const activeFile = useMarkdownStore((state) => state.activeFile);
  const loadFile = useMarkdownStore((state) => state.loadFile);
  const fileInfo = fileInfoText({ activeFile, filePath });
  const narrationModelResult = useMemo(() => {
    if (activeFile.status !== 'ready') {
      return { error: null, model: null };
    }
    try {
      return {
        error: null,
        model: buildMarkdownNarrationModel(activeFile.content),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        model: null,
      };
    }
  }, [activeFile]);
  const copiedTimeoutRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const narrationState = useNarrationStore((state) => state);
  const closeNarration = useNarrationStore((state) => state.close);
  const narrationDom = useSyncExternalStore(
    subscribeNarrationDom,
    getNarrationDomSnapshot,
    getNarrationDomSnapshot,
  );
  const bindingReady = Boolean(
    narrationModelResult.model
    && narrationDom.status === 'ready'
    && narrationDom.sourceHash === narrationModelResult.model.sourceHash,
  );
  const bindingError = narrationModelResult.model
    && narrationDom.sourceHash === narrationModelResult.model.sourceHash
    ? narrationDom.error
    : null;
  const actionStatus = narrationStatusText(
    narrationState,
    narrationModelResult.error ?? bindingError ?? (copied ? 'Copied' : fileInfo),
  );

  useEffect(() => {
    if (!filePath) {
      return;
    }

    void loadFile(filePath);
  }, [filePath, loadFile]);

  useEffect(() => subscribeHostNavigate((navigation) => {
    if (navigation.resourceKind === 'file' && navigation.resourceId) {
      if (navigation.resourceId !== filePath) {
        closeNarration();
      }
      setFilePath(navigation.resourceId);
    }
  }), [closeNarration, filePath]);

  useEffect(() => () => {
    if (copiedTimeoutRef.current !== null) {
      window.clearTimeout(copiedTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    void updateHostTab(fileTabMetadata({ activeFile, filePath })).catch(() => undefined);
  }, [activeFile, filePath]);

  useEffect(() => {
    if (narrationState.phase === 'idle') {
      return;
    }
    const model = narrationModelResult.model;
    const target = narrationState.target;
    const targetMatches = activeFile.status === 'ready'
      && model
      && target
      && filePath === activeFile.path
      && target.filePath === activeFile.path
      && target.modifiedAtMs === activeFile.modifiedAtMs
      && target.sourceHash === model.sourceHash;
    const modelBlockIds = new Set(model?.blocks.map((block) => block.id) ?? []);
    const artifactMatches = !narrationState.artifact || (
      narrationState.artifact.blocks.every((block) => modelBlockIds.has(block.blockId))
      && narrationState.artifact.sentences.every((sentence) => modelBlockIds.has(sentence.blockId))
      && narrationState.artifact.wordCues.every((cue) => modelBlockIds.has(cue.blockId))
    );
    const bindingInvalid = Boolean(
      targetMatches
      && narrationDom.sourceHash === model?.sourceHash
      && narrationDom.status === 'invalid',
    );
    if (!targetMatches || !artifactMatches || bindingInvalid) {
      closeNarration();
    }
  }, [
    activeFile,
    closeNarration,
    filePath,
    narrationDom.sourceHash,
    narrationDom.status,
    narrationModelResult.model,
    narrationState.artifact,
    narrationState.phase,
    narrationState.target,
  ]);

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
      <MarkdownBody
        activeFile={activeFile}
        filePath={filePath}
        narrationModel={narrationModelResult.model}
      />
      <ActionBar
        left={(
          <>
            <ActionButton
              icon={<PanelRightOpen aria-hidden="true" />}
              label="Open tabs"
              onClick={() => {
                void openHostOverview();
              }}
            />
            <ActionMenu
              align="start"
              icon={<Menu aria-hidden="true" />}
              label="Narrate menu"
            >
              <ActionMenuItem
                icon={<RefreshCw />}
                label="Reload viewer"
                onSelect={() => {
                  closeNarration();
                  void reloadHostView();
                }}
              />
              <ActionMenuItem
                disabled={activeFile.status !== 'ready'}
                icon={copied ? <CheckIcon /> : <Copy />}
                label={copied ? 'Copied markdown' : 'Copy markdown'}
                onSelect={copyMarkdown}
              />
              <ActionMenuItem
                icon={<X />}
                label="Close tab"
                onSelect={() => {
                  closeNarration();
                  void closeHostTab();
                }}
              />
            </ActionMenu>
          </>
        )}
        right={(
          <NarrationActions
            bindingReady={bindingReady}
            file={activeFile.status === 'ready' ? activeFile : null}
            model={narrationModelResult.model}
          />
        )}
        status={actionStatus}
      />
    </main>
  );
}

function MarkdownBody({
  activeFile,
  filePath,
  narrationModel,
}: {
  activeFile: ReturnType<typeof useMarkdownStore.getState>['activeFile'];
  filePath: string | null;
  narrationModel: MarkdownNarrationModel | null;
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
      <MarkdownRenderer
        content={activeFile.content}
        filePath={activeFile.path}
        narrationModel={narrationModel}
      />
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
      resourceId: filePath,
      resourceKind: filePath ? 'file' : null,
      status: formatSize(activeFile.sizeBytes),
      title: activeFile.name,
    };
  }

  if (activeFile.status === 'unsupported') {
    return {
      resourceId: filePath,
      resourceKind: filePath ? 'file' : null,
      status: activeFile.tooLarge ? 'Too large' : activeFile.isBinary ? 'Binary file' : 'Unsupported',
      title: activeFile.name,
    };
  }

  if (activeFile.status === 'loading') {
    return {
      resourceId: filePath,
      resourceKind: filePath ? 'file' : null,
      status: 'Reading',
      title: basename(activeFile.path),
    };
  }

  if (activeFile.status === 'error') {
    return {
      resourceId: filePath,
      resourceKind: filePath ? 'file' : null,
      status: 'Error',
      title: basename(activeFile.path),
    };
  }

  return {
    resourceId: filePath,
    resourceKind: filePath ? 'file' : null,
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
