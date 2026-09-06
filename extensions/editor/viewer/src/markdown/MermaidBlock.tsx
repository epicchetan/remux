import {
  getHostTheme,
  subscribeHostTheme,
  type RemuxHostTheme,
} from '@remux/viewer-kit/host';
import { useEffect, useId, useState } from 'react';

type MermaidBlockProps = {
  source: string;
};

let mermaidModulePromise: Promise<typeof import('mermaid')> | null = null;
const mermaidThemeConfigs = {
  dark: {
    darkMode: true,
    theme: 'dark',
  },
  light: {
    darkMode: false,
    theme: 'default',
  },
} as const;

type MermaidRenderState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { message: string; status: 'error' };

export function MermaidBlock({ source }: MermaidBlockProps) {
  const [theme, setTheme] = useState<RemuxHostTheme>(() => getHostTheme());
  const [state, setState] = useState<MermaidRenderState>({ status: 'loading' });
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/gu, '');
  const id = `remux-mermaid-${instanceId}-${theme}`;

  useEffect(() => subscribeHostTheme(setTheme), []);

  useEffect(() => {
    let cancelled = false;
    if (source.length > 20_000) {
      setState({ status: 'error', message: 'This diagram is too large to preview. Its source is shown below.' });
      return;
    }
    setState({ status: 'loading' });

    void loadMermaid()
      .then((mermaidModule) => {
        if (cancelled) return { svg: '' };
        const mermaid = mermaidModule.default;
        configureMermaid(mermaid, theme);
        return mermaid.render(id, source);
      })
      .then(({ svg }) => {
        if (!cancelled) {
          setState({ status: 'ready', svg });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            message: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id, source, theme]);

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
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    </div>
  );
}

function loadMermaid() {
  mermaidModulePromise ??= import('mermaid');
  return mermaidModulePromise;
}

function configureMermaid(mermaid: typeof import('mermaid').default, theme: RemuxHostTheme) {
  mermaid.initialize({
    fontFamily: 'Arial, "Helvetica Neue", sans-serif',
    securityLevel: 'strict',
    maxTextSize: 20_000,
    maxEdges: 200,
    startOnLoad: false,
    ...mermaidThemeConfigs[theme],
  });
}
