import { initializeIpc } from '@remux/extension-api/ipc';
import React, { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { App } from './App';

import '@remux/extension-ui/styles.css';
import 'katex/dist/katex.min.css';
import './styles.css';

const rootLifecycleMigrationKey = 'remux-markdown-root-lifecycle-v1';

declare global {
  interface Window {
    __remuxMarkdownRoot?: Root;
  }
}

function MarkdownRemoteClient() {
  useEffect(() => {
    initializeIpc();
  }, []);

  return <App />;
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Remux markdown root element was not found.');
}

if (shouldReloadLegacyUntrackedRoot(root)) {
  window.sessionStorage.setItem(rootLifecycleMigrationKey, 'done');
  window.location.reload();
} else {
  const reactRoot = window.__remuxMarkdownRoot ?? createRoot(root);
  window.__remuxMarkdownRoot = reactRoot;

  reactRoot.render(<MarkdownRemoteClient />);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      reactRoot.unmount();
      if (window.__remuxMarkdownRoot === reactRoot) {
        delete window.__remuxMarkdownRoot;
      }
    });
  }
}

function shouldReloadLegacyUntrackedRoot(root: HTMLElement) {
  return Boolean(
    import.meta.hot &&
      !window.__remuxMarkdownRoot &&
      root.hasChildNodes() &&
      window.sessionStorage.getItem(rootLifecycleMigrationKey) !== 'done',
  );
}
