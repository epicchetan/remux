import type { FileDescriptor } from '@remux/viewer-kit/fs';
import type { ComponentType } from 'react';
import type { EditorDocument } from '../editor/fileLoading';

export type RendererId = 'source' | 'markdown' | 'html' | 'image' | 'pdf' | 'media' | 'binary';
export type RendererProps = {
  document: EditorDocument;
  descriptor: FileDescriptor;
  mode: 'preview' | 'source';
  active?: boolean;
  visible?: boolean;
  pendingLine?: number | null;
  onFocusApplied?: () => void;
  baseContent?: string | null;
  onShowSource?: () => void;
  onInfo?: (text: string) => void;
  onReload?: () => void;
  onError?: (message: string) => void;
  onDownload?: () => void;
  canDownload?: boolean;
};
export type RendererComponent = ComponentType<RendererProps>;
export type RendererDefinition = {
  id: RendererId;
  match(descriptor: FileDescriptor): number;
  modes: Array<'preview' | 'source'>;
  loads: 'text' | 'url' | 'none';
  load(): Promise<{ Component: RendererComponent }>;
  capabilities(descriptor: FileDescriptor, document: EditorDocument | null): { copy: boolean; diff: boolean };
};

function cached(load: RendererDefinition['load']): RendererDefinition['load'] {
  let promise: ReturnType<RendererDefinition['load']> | undefined;
  return () => promise ??= load().catch((error) => { promise = undefined; throw error; });
}
const textCapabilities: RendererDefinition['capabilities'] = (_, document) => ({
  copy: document?.kind === 'full',
  diff: document?.kind === 'full' && !document.lightweight,
});
const noTextCapabilities = () => ({ copy: false, diff: false });
const extension = (descriptor: FileDescriptor) => descriptor.name.split('.').at(-1)?.toLowerCase() ?? '';

export const renderers: RendererDefinition[] = [
  { id: 'markdown', match: (d) => ['md', 'markdown', 'mdown'].includes(extension(d)) ? 10 : 0,
    modes: ['preview', 'source'], loads: 'text', capabilities: textCapabilities,
    load: cached(() => import('./markdown/MarkdownRenderer')) },
  { id: 'html', match: (d) => ['html', 'htm'].includes(extension(d)) ? 10 : 0,
    modes: ['preview', 'source'], loads: 'text', capabilities: textCapabilities,
    load: cached(() => import('./html/HtmlRenderer')) },
  { id: 'image', match: (d) => d.mimeType?.startsWith('image/') ? 10 : 0,
    modes: ['preview'], loads: 'url', capabilities: noTextCapabilities,
    load: cached(() => import('./image/ImageRenderer')) },
  { id: 'pdf', match: (d) => d.mimeType === 'application/pdf' ? 10 : 0,
    modes: ['preview'], loads: 'url', capabilities: noTextCapabilities,
    load: cached(() => import('./pdf/PdfRenderer')) },
  { id: 'media', match: (d) => /^(audio|video)\//u.test(d.mimeType ?? '') ? 10 : 0,
    modes: ['preview'], loads: 'url', capabilities: noTextCapabilities,
    load: cached(() => import('./media/MediaRenderer')) },
  { id: 'source', match: (d) => d.isBinary === false ? 1 : 0,
    modes: ['source'], loads: 'text', capabilities: textCapabilities,
    load: cached(() => import('./source/SourceRenderer')) },
  { id: 'binary', match: () => 0.5,
    modes: ['preview'], loads: 'none', capabilities: noTextCapabilities,
    load: cached(() => import('./binary/BinaryRenderer')) },
];

export function resolveRenderer(descriptor: FileDescriptor): RendererDefinition {
  if (descriptor.kind !== 'file' && !(descriptor.kind === 'symlink' && descriptor.targetKind === 'file')) {
    return renderers.find((renderer) => renderer.id === 'binary')!;
  }
  return renderers.reduce((best, renderer) => renderer.match(descriptor) > best.match(descriptor) ? renderer : best);
}
