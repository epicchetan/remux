import { initializeIpc } from '@remux/viewer-kit/ipc';
import { mountViewer } from '@remux/viewer-kit/react';

import { App } from './App.tsx';
import { startAgentResourceInvalidationBridge } from './ipc/resourceInvalidations.ts';

import '../app.css';
import './styles.css';
import './styles/agent-theme.css';
import './styles/agent-transcript.css';
import './styles/agent-surfaces.css';
import './styles/agent-motion.css';

const stopInvalidationBridge = startAgentResourceInvalidationBridge();
const syncDocumentVisibility = () => {
  document.documentElement.toggleAttribute('data-agent-document-hidden', document.hidden);
};

syncDocumentVisibility();
document.addEventListener('visibilitychange', syncDocumentVisibility);

mountViewer(<App />, {
  name: 'agent',
  initialize: initializeIpc,
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopInvalidationBridge();
    document.removeEventListener('visibilitychange', syncDocumentVisibility);
  });
}
