import { initializeIpc } from '@remux/viewer-kit/ipc';
import { mountViewer } from '@remux/viewer-kit/react';

import { App } from './App';
import { viewerFramePolicy } from './framePolicy';

import '@remux/viewer-kit/tokens.css';
import '@remux/viewer-kit/ui/styles.css';
import './styles.css';

const framePolicy = document.createElement('meta');
framePolicy.httpEquiv = 'Content-Security-Policy';
framePolicy.content = viewerFramePolicy(location.origin);
document.head.appendChild(framePolicy);

mountViewer(<App />, {
  name: 'editor',
  initialize: () => initializeIpc({ requireProtectedTransport: true }),
});
