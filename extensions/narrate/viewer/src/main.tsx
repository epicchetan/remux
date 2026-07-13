import { initializeIpc } from '@remux/viewer-kit/ipc';
import { mountViewer } from '@remux/viewer-kit/react';

import { App } from './App';

import '@remux/viewer-kit/tokens.css';
import '@remux/viewer-kit/ui/styles.css';
import 'katex/dist/katex.min.css';
import './styles.css';

mountViewer(<App />, {
  name: 'narrate',
  initialize: initializeIpc,
});
