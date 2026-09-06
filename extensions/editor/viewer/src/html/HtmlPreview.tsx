import { getHostCapabilities } from '@remux/viewer-kit/host';
import { openHostHref } from '@remux/viewer-kit/links';
import { prepareHtmlPreviewDocument, type PreparedHtmlPreviewDocument } from '@remux/viewer-kit';
import { ActionButton, ActionMenu, ActionMenuItem } from '@remux/viewer-kit/ui';
import { ExternalLink, FileText, Link as LinkIcon, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import './html.css';

export type HtmlPreviewProps = Readonly<{
  active: boolean;
  content: string;
  filePath: string;
}>;

type Preparation =
  | { document: PreparedHtmlPreviewDocument; error: null }
  | { document: null; error: string };

export function HtmlPreview({ active, content, filePath }: HtmlPreviewProps) {
  const [capabilityReady, setCapabilityReady] = useState(
    () => getHostCapabilities().protectedHtmlPreviewTransport,
  );
  const [frameError, setFrameError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const preparation = useMemo<Preparation>(() => {
    try {
      return { document: prepareHtmlPreviewDocument(content), error: null };
    } catch (error) {
      return {
        document: null,
        error: error instanceof Error ? error.message : 'The HTML document could not be prepared.',
      };
    }
  }, [content]);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);

  useEffect(() => {
    const noteCapability = () => {
      if (getHostCapabilities().protectedHtmlPreviewTransport) setCapabilityReady(true);
    };
    window.addEventListener('remux:host-capabilities-ready', noteCapability);
    noteCapability();
    return () => window.removeEventListener('remux:host-capabilities-ready', noteCapability);
  }, []);

  useEffect(() => {
    setFrameError(null);
    if (!active || !capabilityReady || !preparation.document) {
      setFrameUrl(null);
      return undefined;
    }
    try {
      const url = URL.createObjectURL(new Blob([preparation.document.html], { type: 'text/html' }));
      setFrameUrl(url);
      return () => URL.revokeObjectURL(url);
    } catch (error) {
      setFrameUrl(null);
      setFrameError(error instanceof Error ? error.message : 'The isolated HTML document could not be created.');
      return undefined;
    }
  }, [active, capabilityReady, preparation.document, retry]);

  const openLink = async (href: string) => {
    setLinkError(null);
    const result = await openHostHref(href, { baseFilePath: filePath, parseLine: true });
    if (!result.ok) setLinkError(result.kind === 'unsupported' ? result.reason : 'The link could not be opened.');
  };

  if (!capabilityReady) {
    return <PreviewMessage title="HTML preview needs an app update">
      Source remains available. Update the Remux app to use protected interactive HTML preview.
    </PreviewMessage>;
  }
  if (!preparation.document) {
    return <PreviewMessage title="Could not prepare HTML preview">{preparation.error}</PreviewMessage>;
  }
  const preparedDocument = preparation.document;
  if (!active) return <div className="remux-html-preview" data-suspended="true" />;
  if (frameError) {
    return <PreviewMessage title="HTML preview stopped" action={
      <ActionButton icon={<RotateCcw aria-hidden="true" />} label="Reload HTML preview" onClick={() => setRetry((value) => value + 1)} />
    }>{frameError}</PreviewMessage>;
  }

  return <section className="remux-html-preview" aria-label="HTML preview">
    {frameUrl ? (
      <iframe
        className="remux-html-preview-frame"
        onError={() => {
          URL.revokeObjectURL(frameUrl);
          setFrameUrl(null);
          setFrameError('The isolated HTML document failed to load.');
        }}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        src={frameUrl}
        title="Interactive HTML document"
      />
    ) : <div className="remux-html-preview-loading">Preparing HTML preview</div>}
    {preparedDocument.links.length || preparedDocument.linksTruncated ? (
      <div className="remux-html-preview-links">
        <ActionMenu align="end" icon={<LinkIcon aria-hidden="true" />} label="Open document links" panelClassName="remux-html-preview-links-panel">
          {preparedDocument.links.map((link) => {
            const external = /^https?:\/\//iu.test(link.href);
            return <ActionMenuItem
              icon={external ? <ExternalLink /> : <FileText />}
              key={link.href}
              label={`${link.label} — ${link.href}`}
              onSelect={() => { void openLink(link.href); }}
            />;
          })}
          {preparedDocument.linksTruncated ? <div className="remux-html-preview-links-note">Showing the first 100 supported links.</div> : null}
        </ActionMenu>
      </div>
    ) : null}
    {linkError ? <div className="remux-html-preview-error" role="status">{linkError}</div> : null}
  </section>;
}

function PreviewMessage({ action, children, title }: { action?: ReactNode; children: ReactNode; title: string }) {
  return <section className="remux-html-preview-message">
    <div className="remux-html-preview-message-card">
      <strong>{title}</strong>
      <span>{children}</span>
      {action}
    </div>
  </section>;
}
