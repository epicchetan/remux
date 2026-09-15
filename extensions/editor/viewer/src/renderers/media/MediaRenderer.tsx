import type { RendererProps } from '../registry';

export function Component({ document }: RendererProps) {
  if (document.kind !== 'media') return null;
  return <div className="remux-editor-media-stage">
    {document.mimeType?.startsWith('audio/')
      ? <audio controls preload="metadata" src={document.url} />
      : <video controls playsInline preload="metadata" src={document.url} />}
  </div>;
}
