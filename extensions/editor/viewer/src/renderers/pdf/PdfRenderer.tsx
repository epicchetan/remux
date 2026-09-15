import type { RendererProps } from '../registry';
import { Component as BinaryRenderer } from '../binary/BinaryRenderer';

export function Component(props: RendererProps) {
  if (/Android/iu.test(navigator.userAgent)) return <BinaryRenderer {...props} />;
  const { document, descriptor } = props;
  return document.kind === 'media'
    ? <iframe className="remux-editor-pdf" src={document.url} title={descriptor.name} /> : null;
}
