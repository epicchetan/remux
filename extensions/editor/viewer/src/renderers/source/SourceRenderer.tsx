import { CodeMirrorViewer } from '../../editor/CodeMirrorViewer';
import type { RendererProps } from '../registry';

export function Component({ document, mode, visible = true, pendingLine, onFocusApplied, baseContent = null }: RendererProps) {
  if (document.kind !== 'full' && document.kind !== 'windowed') return null;
  const focusLine = document.kind === 'windowed'
    ? document.targetLine?.lineNumber === pendingLine ? 1 : null
    : pendingLine ?? null;
  return <CodeMirrorViewer
    key={document.kind === 'full' ? document.revision : `${document.version}:${document.range.startByte}:${document.range.endByte}`}
    baseContent={baseContent}
    content={document.text}
    fileName={document.name}
    focusLine={focusLine}
    lightweight={document.kind === 'windowed' || document.lightweight}
    lineNumberStart={document.kind === 'windowed' ? document.targetLine?.lineNumber ?? null : null}
    onFocusApplied={onFocusApplied}
    showDiff={baseContent !== null}
    visible={visible && mode === 'source'}
  />;
}
