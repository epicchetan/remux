import React, { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { App } from './App';
import { useHostStore } from './ipc/hostStore';
import { subscribeCodexResourceInvalidations } from './ipc/resourceInvalidations';

import './app.css';
import './styles.css';

const rootLifecycleMigrationKey = 'remux-codex-root-lifecycle-v1';

declare global {
  interface Window {
    __remuxCodexRoot?: Root;
    __remuxCodexResourceInvalidationsUnsubscribe?: () => void;
  }
}

function CodexRemoteClient() {
  useEffect(() => {
    useHostStore.getState().initialize();
  }, []);

  return <App />;
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Remux root element was not found.');
}

if (shouldReloadLegacyUntrackedRoot(root)) {
  window.sessionStorage.setItem(rootLifecycleMigrationKey, 'done');
  window.location.reload();
} else {
  window.__remuxCodexResourceInvalidationsUnsubscribe ??=
    subscribeCodexResourceInvalidations();
  const reactRoot = window.__remuxCodexRoot ?? createRoot(root);
  window.__remuxCodexRoot = reactRoot;

  reactRoot.render(<CodexRemoteClient />);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.__remuxCodexResourceInvalidationsUnsubscribe?.();
      delete window.__remuxCodexResourceInvalidationsUnsubscribe;
      reactRoot.unmount();
      if (window.__remuxCodexRoot === reactRoot) {
        delete window.__remuxCodexRoot;
      }
    });
  }
}

function shouldReloadLegacyUntrackedRoot(root: HTMLElement) {
  return Boolean(
    import.meta.hot &&
      !window.__remuxCodexRoot &&
      root.hasChildNodes() &&
      window.sessionStorage.getItem(rootLifecycleMigrationKey) !== 'done',
  );
}
