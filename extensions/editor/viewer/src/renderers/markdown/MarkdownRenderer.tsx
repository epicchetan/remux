import { MarkdownPreview } from '../../markdown/MarkdownPreview';
import { Component as SourceRenderer } from '../source/SourceRenderer';
import type { RendererProps } from '../registry';
import '../../markdown/markdown.css';
import 'katex/dist/katex.min.css';

export function Component(props: RendererProps) {
  if (props.mode === 'source') return <SourceRenderer {...props} />;
  const { document, onShowSource } = props;
  return document.kind === 'full'
    ? <MarkdownPreview key={document.revision} content={document.text} filePath={document.path} onShowSource={onShowSource} />
    : null;
}
