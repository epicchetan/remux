import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Code, Copy, Eye } from 'lucide-react';
import { getHostTheme, subscribeHostTheme } from '@remux/viewer-kit/host';
import { renderMermaid } from '@remux/viewer-kit/mermaid';
import { markdownMetrics, type MarkdownLayoutBlock } from './markdownModel';
import { DiagramViewport } from './DiagramViewport';
import { publishDiagramMetrics } from './diagramMetrics';
import './diagram.css';

type RenderState = { status: 'loading' } | { status: 'error'; message: string }
  | { status: 'ready'; url: string; width: number; height: number };

export function DiagramBlock({ block, style }: {
  block: Extract<MarkdownLayoutBlock, { type: 'diagram' }>;
  style: CSSProperties;
}) {
  const controlsRef = useRef<HTMLSpanElement | null>(null);
  const [theme, setTheme] = useState(getHostTheme);
  const [state, setState] = useState<RenderState>({ status: 'loading' });
  const [source, setSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => subscribeHostTheme(setTheme), []);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setState({ status: 'loading' });
    void renderMermaid(block.text, { theme, signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
      publishDiagramMetrics(block.text, { width: result.width, height: result.height });
      setState({ status: 'ready', url, width: result.width, height: result.height });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [block.text, theme]);

  async function copy() {
    try {
      await copySource(block.text);
      setCopied(true);
      setCopyFailed(false);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch { setCopyFailed(true); }
  }
  const imageError = () => setState({ status: 'error', message: 'The diagram image could not be displayed.' });
  return (
    <div className="codex-md-block agent-diagram" data-diagram-state={state.status} style={{
      ...style,
      '--diagram-toolbar-height': `${markdownMetrics.diagram.toolbarHeight}px`,
      '--diagram-padding': `${markdownMetrics.diagram.padding}px`,
    } as CSSProperties}>
      <div className="agent-diagram-toolbar">
        <span>{copyFailed ? 'Could not copy' : 'Diagram'}</span>
        <span ref={controlsRef} />
        <button type="button" aria-label={source ? 'Show diagram' : 'Show diagram source'} aria-pressed={source} onClick={() => setSource(!source)}>{source ? <Eye /> : <Code />}</button>
        <button type="button" aria-label={copied ? 'Diagram source copied' : 'Copy diagram source'} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</button>
      </div>
      <div className={`agent-diagram-scroll${!source && state.status === 'ready' ? ' agent-diagram-preview' : ''}`} tabIndex={0} aria-label={source || state.status === 'error' ? 'Diagram source' : 'Diagram preview'}>
        {source || state.status === 'error' ? <>
          {state.status === 'error' && <p className="agent-diagram-message" role="status">{state.message}</p>}
          <pre><code>{block.text}</code></pre>
        </> : state.status === 'ready'
          ? <DiagramViewport controlsRef={controlsRef} src={state.url} imageWidth={state.width} imageHeight={state.height} identity={`${block.text}\0${theme}`} onImageError={imageError} />
          : <p className="agent-diagram-message" role="status">Rendering diagram…</p>}
      </div>
    </div>
  );
}

async function copySource(text: string) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* WebViews can expose Clipboard API while denying access. */ }
  const previousFocus = document.activeElement;
  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(input);
  input.select();
  try { if (!document.execCommand('copy')) throw new Error('Copy failed'); }
  finally { input.remove(); if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true }); }
}
