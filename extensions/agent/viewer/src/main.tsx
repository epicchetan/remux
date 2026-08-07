import { initializeIpc } from '@remux/viewer-kit/ipc';
import { mountViewer } from '@remux/viewer-kit/react';

import { App } from './App.tsx';

import '../app.css';
import './styles.css';

mountViewer(<App />, {
  name: 'agent',
  initialize: initializeIpc,
});
