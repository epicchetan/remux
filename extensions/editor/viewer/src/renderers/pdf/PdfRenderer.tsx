import { useEffect, useRef } from 'react';
import { dismissHostPdf, getHostCapabilities, presentHostPdf } from '@remux/viewer-kit/host';
import type { RendererProps } from '../registry';
import { Component as BinaryRenderer } from '../binary/BinaryRenderer';

// The native app draws PDFs itself, over the rectangle this renderer measures,
// so the file gets the platform's PDF view instead of a subframe drawn at one
// PDF point per pixel. Browser hosts frame the raw url; Android has no PDF view.
export function Component(props: RendererProps) {
  const { document, descriptor, onError } = props;
  if (document.kind !== 'media') return null;
  if (getHostCapabilities().pdfPresent) {
    return <HostPdf path={descriptor.path} version={document.version} onError={onError} />;
  }
  if (/Android/iu.test(navigator.userAgent)) return <BinaryRenderer {...props} />;
  return <iframe className="remux-editor-pdf" src={document.url} title={descriptor.name} />;
}

function HostPdf({ path, version, onError }: { path: string; version: string | null; onError?: (message: string) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    let frame = 0;
    const present = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      void presentHostPdf({ path, version, frame: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } })
        .then((result) => { if (!result.ok) report.current?.(result.reason ?? 'Could not show PDF'); })
        .catch((error: unknown) => report.current?.(error instanceof Error ? error.message : 'Could not show PDF'));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(present); };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    schedule();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      void dismissHostPdf().catch(() => undefined);
    };
  }, [path, version]);
  return <div ref={stage} className="remux-editor-pdf-stage" data-remux-pdf-path={path} />;
}
