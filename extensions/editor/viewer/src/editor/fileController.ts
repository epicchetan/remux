import type { ReadFileGitMetadata } from '@remux/viewer-kit/fs';

import type { EditorDocument, WindowedDocument } from './fileLoading';

export type EditorMode = 'preview' | 'source';
export type PreviewKind = 'html' | 'markdown' | null;
export type PendingFocus = { line: number; nonce: string | null };
export type GitState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { message: string; status: 'error' }
  | { metadata: ReadFileGitMetadata; status: 'ready' };

export type EditorControllerState = {
  diffVisible: boolean;
  document: EditorDocument | null;
  error: string | null;
  git: GitState;
  hostGeneration: number | null;
  mode: EditorMode;
  path: string | null;
  pendingFocus: PendingFocus | null;
  previewKind: PreviewKind;
  status: 'error' | 'idle' | 'loading' | 'ready' | 'refreshing';
};

export type EditorControllerDependencies = {
  loadInitial: (path: string, signal?: AbortSignal, targetLine?: number | null) => Promise<EditorDocument>;
  loadWindow: (path: string, options: {
    expectedVersion?: string;
    offset?: number;
    signal?: AbortSignal;
    targetLine?: number;
  }) => Promise<WindowedDocument>;
  readGit: (path: string, options: { includeBase: boolean; signal?: AbortSignal }) => Promise<ReadFileGitMetadata>;
};

export class EditorFileController {
  private abortController: AbortController | null = null;
  private generation = 0;
  private receivedHostGeneration = false;
  private gitAbortController: AbortController | null = null;
  private readonly listeners = new Set<(state: EditorControllerState) => void>();
  private readonly dependencies: EditorControllerDependencies;
  private state: EditorControllerState = {
    diffVisible: false,
    document: null,
    error: null,
    git: { status: 'idle' },
    hostGeneration: null,
    mode: 'source',
    path: null,
    pendingFocus: null,
    previewKind: null,
    status: 'idle',
  };

  constructor(dependencies: EditorControllerDependencies) {
    this.dependencies = dependencies;
  }

  snapshot = () => this.state;

  subscribe = (listener: (state: EditorControllerState) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  retarget(path: string, options: { hostGeneration?: number | null; focus?: PendingFocus | null } = {}) {
    const hostGeneration = Object.prototype.hasOwnProperty.call(options, 'hostGeneration')
      ? options.hostGeneration ?? null
      : this.state.hostGeneration;
    const sameTarget = path === this.state.path && hostGeneration === this.state.hostGeneration;
    if (sameTarget) {
      if (options.focus) {
        this.publish({ ...this.state, diffVisible: false, mode: 'source', pendingFocus: options.focus });
        if (this.state.document?.kind === 'windowed') void this.loadTargetLine(options.focus.line);
      }
      return;
    }
    this.cancel();
    this.generation += 1;
    this.publish({
      diffVisible: false,
      document: null,
      error: null,
      git: { status: 'idle' },
      hostGeneration,
      mode: options.focus ? 'source' : defaultMode(path),
      path,
      pendingFocus: options.focus ?? null,
      previewKind: previewKind(path),
      status: 'idle',
    });
  }

  setHostGeneration(hostGeneration: number | null) {
    if (hostGeneration === this.state.hostGeneration) return;
    // Initial host metadata describes the connection already serving queued reads.
    // Later changes (including disconnect/reconnect) must still retire old work.
    if (!this.receivedHostGeneration && hostGeneration !== null) {
      this.receivedHostGeneration = true;
      this.publish({ ...this.state, hostGeneration });
      return;
    }
    if (this.state.path) this.retarget(this.state.path, { hostGeneration, focus: this.state.pendingFocus });
    else this.publish({ ...this.state, hostGeneration });
  }

  setMode(mode: EditorMode) {
    if (mode === 'preview' && this.state.git.status === 'loading') {
      this.gitAbortController?.abort('preview-selected');
      this.gitAbortController = null;
      this.publish({ ...this.state, diffVisible: false, git: { status: 'idle' }, mode });
      return;
    }
    this.publish({ ...this.state, diffVisible: false, mode });
  }

  acknowledgeFocus(nonce: string | null) {
    if (this.state.pendingFocus?.nonce === nonce) this.publish({ ...this.state, pendingFocus: null });
  }

  async load() {
    const { path, pendingFocus } = this.state;
    if (!path) return false;
    return this.runDocumentLoad((signal) => this.dependencies.loadInitial(path, signal, pendingFocus?.line));
  }

  async reload() {
    return this.load();
  }

  async loadPrevious() {
    const document = this.state.document;
    if (document?.kind !== 'windowed' || document.previousOffset == null) return false;
    return this.loadWindowOffset(document.previousOffset, document.version);
  }

  async loadNext() {
    const document = this.state.document;
    if (document?.kind !== 'windowed' || document.nextOffset == null) return false;
    return this.loadWindowOffset(document.nextOffset, document.version);
  }

  async loadStart() {
    const document = this.state.document;
    if (document?.kind !== 'windowed') return false;
    return this.loadWindowOffset(0, document.version);
  }

  async loadEnd() {
    const document = this.state.document;
    if (document?.kind !== 'windowed') return false;
    return this.loadWindowOffset(Math.max(0, document.totalSizeBytes - 256 * 1024), document.version);
  }

  async loadTargetLine(line: number) {
    const document = this.state.document;
    const path = this.state.path;
    if (!path || document?.kind !== 'windowed') return false;
    return this.runDocumentLoad((signal) => this.dependencies.loadWindow(path, {
      expectedVersion: document.version,
      signal,
      targetLine: line,
    }));
  }

  async showDiff() {
    if (!this.state.path || this.state.document?.kind !== 'full') return false;
    const nextVisible = !this.state.diffVisible;
    this.setMode('source');
    if (this.state.git.status === 'ready') {
      this.publish({ ...this.state, diffVisible: nextVisible });
      return true;
    }
    this.gitAbortController?.abort('git-superseded');
    const controller = new AbortController();
    this.gitAbortController = controller;
    const generation = this.generation;
    const path = this.state.path;
    this.publish({ ...this.state, git: { status: 'loading' } });
    try {
      const metadata = await this.dependencies.readGit(path, { includeBase: true, signal: controller.signal });
      if (controller.signal.aborted || this.gitAbortController !== controller || generation !== this.generation || path !== this.state.path || this.state.mode !== 'source') return false;
      this.publish({ ...this.state, diffVisible: true, git: { metadata, status: 'ready' } });
      return true;
    } catch (error) {
      if (controller.signal.aborted || this.gitAbortController !== controller || generation !== this.generation || path !== this.state.path) return false;
      this.publish({ ...this.state, git: { message: errorMessage(error), status: 'error' } });
      return false;
    }
  }

  retire() {
    this.cancel();
    this.generation += 1;
    this.state = { ...this.state, document: null, error: null, path: null, status: 'idle' };
    this.emit();
  }

  private loadWindowOffset(offset: number, expectedVersion: string) {
    const path = this.state.path!;
    return this.runDocumentLoad((signal) => this.dependencies.loadWindow(path, {
      expectedVersion,
      offset,
      signal,
    }));
  }

  private async runDocumentLoad(load: (signal: AbortSignal) => Promise<EditorDocument>) {
    this.abortController?.abort('load-superseded');
    this.gitAbortController?.abort('document-reloading');
    this.gitAbortController = null;
    const controller = new AbortController();
    this.abortController = controller;
    const generation = ++this.generation;
    const path = this.state.path;
    this.publish({
      ...this.state,
      diffVisible: false,
      error: null,
      git: { status: 'idle' },
      status: this.state.document ? 'refreshing' : 'loading',
    });
    try {
      const document = await load(controller.signal);
      if (generation !== this.generation || path !== this.state.path) return false;
      const installedDocument = document.kind === 'full'
        ? { ...document, revision: `${document.revision}:load:${generation}` }
        : document;
      this.publish({
        ...this.state,
        diffVisible: document.kind === 'windowed' ? false : this.state.diffVisible,
        document: installedDocument,
        error: null,
        mode: document.kind === 'windowed' ? 'source' : this.state.mode,
        status: 'ready',
      });
      const latestFocus = this.state.pendingFocus?.line;
      if (
        installedDocument.kind === 'windowed'
        && latestFocus
        && installedDocument.targetLine?.lineNumber !== latestFocus
      ) {
        void this.loadTargetLine(latestFocus);
      }
      return true;
    } catch (error) {
      if (generation !== this.generation || path !== this.state.path) return false;
      this.publish({ ...this.state, error: errorMessage(error), status: 'error' });
      return false;
    }
  }

  private cancel() {
    this.abortController?.abort('target-retired');
    this.gitAbortController?.abort('target-retired');
    this.abortController = null;
    this.gitAbortController = null;
  }

  private publish(state: EditorControllerState) {
    this.state = state;
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener(this.state);
  }
}

function previewKind(path: string): PreviewKind {
  const extension = path.split('.').at(-1)?.toLowerCase();
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'md' || extension === 'markdown' || extension === 'mdown') return 'markdown';
  return null;
}

function defaultMode(path: string): EditorMode {
  return previewKind(path) ? 'preview' : 'source';
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error);
}
