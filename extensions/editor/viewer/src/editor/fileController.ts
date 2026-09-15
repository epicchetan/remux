import { rawFileUrl, type FileDescriptor, type ReadFileGitMetadata } from '@remux/viewer-kit/fs';
import { renderers, resolveRenderer, type RendererId } from '../renderers/registry.ts';

import type { EditorDocument, TextDocument, WindowedDocument } from './fileLoading';

export type EditorMode = 'preview' | 'source';
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
  descriptor: FileDescriptor | null;
  rendererId: RendererId | null;
  status: 'error' | 'idle' | 'loading' | 'ready' | 'refreshing';
};

export type EditorControllerDependencies = {
  stat: (path: string, signal?: AbortSignal) => Promise<FileDescriptor>;
  loadInitial: (path: string, signal?: AbortSignal, targetLine?: number | null) => Promise<TextDocument>;
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
    descriptor: null,
    rendererId: null,
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
      if (options.focus && (!this.state.rendererId || this.renderer()?.modes.includes('source'))) {
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
      mode: 'source',
      path,
      pendingFocus: options.focus ?? null,
      descriptor: null,
      rendererId: null,
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

  private renderer() {
    return renderers.find((renderer) => renderer.id === this.state.rendererId);
  }

  setMode(mode: EditorMode) {
    if (!this.renderer()?.modes.includes(mode)) return;
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
    const previousDocument = this.state.document;
    const previousError = this.state.status === 'error';
    return this.runDocumentLoad(async (signal, isCurrent) => {
      const descriptor = await this.dependencies.stat(path, signal);
      // Stat and byte reads share one generation. A superseded stat must never
      // install metadata or start the next read, even if it ignores abort.
      if (!isCurrent()) throw new Error('Stat superseded');
      const renderer = resolveRenderer(descriptor);
      const sameRenderer = renderer.id === this.state.rendererId;
      const mode = this.state.pendingFocus && renderer.modes.includes('source') ? 'source'
        : sameRenderer && renderer.modes.includes(this.state.mode) ? this.state.mode : renderer.modes[0];
      this.publish({ ...this.state, descriptor, rendererId: renderer.id, mode,
        pendingFocus: renderer.modes.includes('source') ? this.state.pendingFocus : null });
      if (renderer.loads === 'text') return this.dependencies.loadInitial(path, signal, pendingFocus?.line);
      if (!previousError && sameRenderer && previousDocument
        && (previousDocument.kind === 'media' || previousDocument.kind === 'binary')
        && previousDocument.version === descriptor.version) return previousDocument;
      const metadata = { mimeType: descriptor.mimeType, sizeBytes: descriptor.sizeBytes, version: descriptor.version };
      if (renderer.loads === 'none') return { kind: 'binary', ...metadata };
      const media = renderer.id === 'image' ? 'image' : renderer.id === 'pdf' ? 'pdf'
        : descriptor.mimeType?.startsWith('audio/') ? 'audio' : 'video';
      return { kind: 'media', media, url: rawFileUrl(descriptor.path, descriptor.version), ...metadata };
    });
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

  reportRendererError(message: string) {
    this.publish({ ...this.state, error: message, status: 'error' });
  }

  retire() {
    this.cancel();
    this.generation += 1;
    this.state = { ...this.state, document: null, descriptor: null, rendererId: null, error: null, path: null, status: 'idle' };
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

  private async runDocumentLoad(load: (signal: AbortSignal, isCurrent: () => boolean) => Promise<EditorDocument>) {
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
    const isCurrent = () => !controller.signal.aborted && generation === this.generation && path === this.state.path;
    try {
      const document = await load(controller.signal, isCurrent);
      if (!isCurrent()) return false;
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
      if (!isCurrent()) return false;
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

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error);
}
