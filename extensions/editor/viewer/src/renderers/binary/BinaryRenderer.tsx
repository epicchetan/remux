import type { RendererProps } from '../registry';

export function Component({ descriptor, onDownload, canDownload }: RendererProps) {
  const regularFile = descriptor.kind === 'file' || (descriptor.kind === 'symlink' && descriptor.targetKind === 'file');
  return <section className="remux-editor-empty"><div className="remux-editor-empty-card remux-editor-binary">
    <h1 className="remux-editor-empty-title">{descriptor.name}</h1>
    <p className="remux-editor-empty-copy">{regularFile ? 'This file cannot be previewed.'
      : descriptor.kind === 'directory' || descriptor.targetKind === 'directory' ? 'Directories cannot be previewed.'
        : 'This entry is not a regular file and cannot be previewed.'}</p>
    <dl><dt>Type</dt><dd>{descriptor.mimeType ?? 'Unknown'}</dd>
      <dt>Size</dt><dd>{descriptor.sizeBytes == null ? 'Unknown' : `${descriptor.sizeBytes} B`}</dd>
      <dt>Version</dt><dd>{descriptor.version ?? 'Unknown'}</dd></dl>
    <button className="remux-editor-primary-button" disabled={!canDownload} onClick={onDownload}
      aria-label={canDownload ? 'Download file' : 'Update the app to download files'}>
      {canDownload ? 'Download file' : 'Update the app to download files'}
    </button>
  </div></section>;
}
