import { HtmlPreview } from '../../html/HtmlPreview';
import { Component as SourceRenderer } from '../source/SourceRenderer';
import type { RendererProps } from '../registry';

export function Component(props: RendererProps) {
  if (props.mode === 'source') return <SourceRenderer {...props} />;
  const { document, active = true } = props;
  return document.kind === 'full' ? <HtmlPreview key={document.revision} active={active} content={document.text} /> : null;
}
