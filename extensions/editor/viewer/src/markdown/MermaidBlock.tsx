import {
  getHostTheme,
  subscribeHostTheme,
  type RemuxHostTheme,
} from '@remux/viewer-kit/host';
import { renderMermaid } from '@remux/viewer-kit/mermaid';
import { useEffect, useState } from 'react';

type MermaidBlockProps = {
  source: string;
};

type MermaidRenderState =
  | { status: 'loading' }
  | { height: number; status: 'ready'; url: string; width: number }
  | { message: string; status: 'error' };

export function MermaidBlock({ source }: MermaidBlockProps) {
  const [theme, setTheme] = useState<RemuxHostTheme>(() => getHostTheme());
  const [state, setState] = useState<MermaidRenderState>({ status: 'loading' });

  useEffect(() => subscribeHostTheme(setTheme), []);

  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    setState({ status: 'loading' });

    void renderMermaid(source, { signal: controller.signal, theme })
      .then(({ height, svg, width }) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        setState({ height, status: 'ready', url, width });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            message: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        }
      });

    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, theme]);

  if (state.status === 'loading') {
    return (
      <div
        className="remux-viewer-markdown-mermaid-card"
      >
        <div className="remux-viewer-markdown-spinner" aria-hidden="true" />
        <div className="remux-viewer-markdown-mermaid-muted">Rendering diagram</div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div
        className="remux-viewer-markdown-mermaid-card remux-viewer-markdown-mermaid-error"
      >
        <div className="remux-viewer-markdown-mermaid-title">Could not render Mermaid</div>
        <div className="remux-viewer-markdown-mermaid-muted">{state.message}</div>
        <pre><code>{source}</code></pre>
      </div>
    );
  }

  return (
    <div
      className="remux-viewer-markdown-mermaid-card"
    >
      <div
        className="remux-viewer-markdown-mermaid-diagram"
      >
        <img
          alt="Mermaid diagram"
          height={state.height}
          onError={() => setState({ message: 'The rendered Mermaid image could not be displayed.', status: 'error' })}
          src={state.url}
          width={state.width}
        />
      </div>
    </div>
  );
}
