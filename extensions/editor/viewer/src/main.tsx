import { initializeIpc } from '@remux/extension-api/ipc';
import React, { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { App } from './App';

import '@remux/extension-ui/styles.css';
import './styles.css';

const rootLifecycleMigrationKey = 'remux-editor-root-lifecycle-v1';

declare global {
  interface Window {
    __remuxEditorRoot?: Root;
  }
}

function EditorRemoteClient() {
  useEffect(() => {
    initializeIpc();
  }, []);

  return <App />;
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Remux editor root element was not found.');
}

if (shouldReloadLegacyUntrackedRoot(root)) {
  window.sessionStorage.setItem(rootLifecycleMigrationKey, 'done');
  window.location.reload();
} else {
  const reactRoot = window.__remuxEditorRoot ?? createRoot(root);
  window.__remuxEditorRoot = reactRoot;

  reactRoot.render(<EditorRemoteClient />);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      reactRoot.unmount();
      if (window.__remuxEditorRoot === reactRoot) {
        delete window.__remuxEditorRoot;
      }
    });
  }
}

function shouldReloadLegacyUntrackedRoot(root: HTMLElement) {
  return Boolean(
    import.meta.hot &&
      !window.__remuxEditorRoot &&
      root.hasChildNodes() &&
      window.sessionStorage.getItem(rootLifecycleMigrationKey) !== 'done',
  );
}
