import { initializeIpc } from '@remux/extension-api/ipc';
import React, { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { App } from './App';

import '@remux/extension-ui/styles.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

const rootLifecycleMigrationKey = 'remux-terminal-root-lifecycle-v1';

declare global {
  interface Window {
    __remuxTerminalRoot?: Root;
  }
}

function TerminalRemoteClient() {
  useEffect(() => {
    initializeIpc();
  }, []);

  return <App />;
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Remux terminal root element was not found.');
}

if (shouldReloadLegacyUntrackedRoot(root)) {
  window.sessionStorage.setItem(rootLifecycleMigrationKey, 'done');
  window.location.reload();
} else {
  const reactRoot = window.__remuxTerminalRoot ?? createRoot(root);
  window.__remuxTerminalRoot = reactRoot;

  reactRoot.render(<TerminalRemoteClient />);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      reactRoot.unmount();
      if (window.__remuxTerminalRoot === reactRoot) {
        delete window.__remuxTerminalRoot;
      }
    });
  }
}

function shouldReloadLegacyUntrackedRoot(root: HTMLElement) {
  return Boolean(
    import.meta.hot &&
      !window.__remuxTerminalRoot &&
      root.hasChildNodes() &&
      window.sessionStorage.getItem(rootLifecycleMigrationKey) !== 'done',
  );
}
