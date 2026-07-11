import type { CSSProperties } from 'react';

import { cn } from '@remux/viewer-kit/shadcn';
import { markdownMetrics } from '../markdown/markdownModel';
import { FileTypeIcon } from './fileTypeIcons';

export function FileReferenceChip({
  className,
  fileName,
  path,
}: {
  className?: string;
  fileName: string;
  path: string;
}) {
  return (
    <span
      className={cn('codex-md-file-link', className)}
      contentEditable={false}
      data-extension={fileExtensionFromName(fileName) ?? ''}
      style={fileReferenceStyle()}
      title={path}
    >
      <span className="codex-md-file-icon-frame">
        <FileTypeIcon extension={fileExtensionFromName(fileName)} fileName={fileName} />
      </span>
      <span className="codex-md-file-link-name">{fileName}</span>
    </span>
  );
}

export function fileReferenceStyle(): CSSProperties {
  return {
    '--codex-md-file-icon-baseline-shift': `${markdownMetrics.fileLink.iconBaselineShift}px`,
    '--codex-md-file-icon-gap': `${markdownMetrics.fileLink.iconGap}px`,
    '--codex-md-file-icon-size': `${markdownMetrics.fileLink.iconSize}px`,
    '--codex-md-file-link-height': `${markdownMetrics.fileLink.height}px`,
    '--codex-md-file-link-max-width': `${markdownMetrics.fileLink.maxWidth}px`,
    '--codex-md-file-link-padding-x': `${markdownMetrics.fileLink.paddingX}px`,
  } as CSSProperties;
}

function fileExtensionFromName(fileName: string) {
  const index = fileName.lastIndexOf('.');
  return index > 0 && index < fileName.length - 1 ? fileName.slice(index + 1).toLowerCase() : null;
}
