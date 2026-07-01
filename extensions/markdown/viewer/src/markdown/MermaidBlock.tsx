import {
  getHostTheme,
  subscribeHostTheme,
  type RemuxHostTheme,
} from '@remux/viewer-kit/host';
import { useEffect, useMemo, useState } from 'react';

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
  const id = useMemo(() => `remux-mermaid-${theme}-${hashString(source)}`, [source, theme]);

  useEffect(() => subscribeHostTheme(setTheme), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    void loadMermaid()
      .then((mermaidModule) => {
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
      <div className="remux-markdown-mermaid-card">
        <div className="remux-markdown-spinner" aria-hidden="true" />
        <div className="remux-markdown-mermaid-muted">Rendering diagram</div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="remux-markdown-mermaid-card remux-markdown-mermaid-error">
        <div className="remux-markdown-mermaid-title">Could not render Mermaid</div>
        <div className="remux-markdown-mermaid-muted">{state.message}</div>
        <pre><code>{source}</code></pre>
      </div>
    );
  }

  return (
    <div className="remux-markdown-mermaid-card">
      <div
        className="remux-markdown-mermaid-diagram"
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
    startOnLoad: false,
    ...mermaidThemeConfigs[theme],
  });
}

function hashString(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}
