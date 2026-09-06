import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Code, Copy, Eye, Maximize2, X } from 'lucide-react';
import { getHostTheme, subscribeHostTheme } from '@remux/viewer-kit/host';
import { renderMermaid } from '@remux/viewer-kit/mermaid';
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from '@remux/viewer-kit/shadcn';
import { markdownMetrics, type MarkdownLayoutBlock } from './markdownModel';
import './diagram.css';

type RenderState = { status: 'loading' } | { status: 'error'; message: string }
  | { status: 'ready'; url: string; width: number; height: number };

export function DiagramBlock({ block, style }: {
  block: Extract<MarkdownLayoutBlock, { type: 'diagram' }>;
  style: CSSProperties;
}) {
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
  const scale = state.status === 'ready'
    ? Math.min(1, (block.contentHeight - markdownMetrics.diagram.toolbarHeight - 2 * markdownMetrics.diagram.padding - 2) / state.height)
    : 1;
  return (
    <div className="codex-md-block agent-diagram" data-diagram-state={state.status} style={{
      ...style,
      '--diagram-toolbar-height': `${markdownMetrics.diagram.toolbarHeight}px`,
      '--diagram-padding': `${markdownMetrics.diagram.padding}px`,
    } as CSSProperties}>
      <div className="agent-diagram-toolbar">
        <span>{copyFailed ? 'Could not copy' : 'Diagram'}</span>
        <button type="button" aria-label={source ? 'Show diagram' : 'Show diagram source'} aria-pressed={source} onClick={() => setSource(!source)}>{source ? <Eye /> : <Code />}</button>
        <button type="button" aria-label={copied ? 'Diagram source copied' : 'Copy diagram source'} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</button>
        <Sheet>
          <SheetTrigger asChild><button type="button" aria-label="Expand diagram" disabled={state.status !== 'ready'}><Maximize2 /></button></SheetTrigger>
          <SheetContent side="bottom" className="agent-diagram-expanded" aria-describedby={undefined}>
            <div className="agent-diagram-toolbar">
              <SheetTitle>Diagram</SheetTitle>
              <SheetClose asChild><button type="button" aria-label="Close diagram"><X /></button></SheetClose>
            </div>
            <div className="agent-diagram-scroll" tabIndex={0} aria-label="Expanded diagram">
              {state.status === 'ready' && <img alt="Mermaid diagram" src={state.url} width={state.width} height={state.height} onError={imageError} />}
            </div>
          </SheetContent>
        </Sheet>
      </div>
      <div className="agent-diagram-scroll" tabIndex={0} aria-label={source || state.status === 'error' ? 'Diagram source' : 'Diagram preview'}>
        {source || state.status === 'error' ? <>
          {state.status === 'error' && <p className="agent-diagram-message" role="status">{state.message}</p>}
          <pre><code>{block.text}</code></pre>
        </> : state.status === 'ready'
          ? <img alt="Mermaid diagram" src={state.url} width={state.width * scale} height={state.height * scale} onError={imageError} />
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
