import { initializeIpc } from '@remux/viewer-kit/ipc';
import { mountViewer } from '@remux/viewer-kit/react';

import { App } from './App.tsx';
import { startAgentResourceInvalidationBridge } from './ipc/resourceInvalidations.ts';

import '../app.css';
import './styles.css';

const stopInvalidationBridge = startAgentResourceInvalidationBridge();

mountViewer(<App />, {
  name: 'agent',
  initialize: initializeIpc,
});

if (import.meta.hot) import.meta.hot.dispose(stopInvalidationBridge);
