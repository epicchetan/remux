import { parseRemuxViewerRoute } from '@remux/viewer-kit/route';
import { useEffect } from 'react';

import { MarkdownSurface } from './markdown/MarkdownSurface';
import { attachNarrationClient } from './narration/client';
import { installNarrationFollowController } from './narration/followController';
import { installNarrationPaintController } from './narration/paintController';

export function App() {
  const route = parseRemuxViewerRoute(window.location.href);
  useEffect(() => attachNarrationClient(), []);
  useEffect(() => installNarrationFollowController(), []);
  useEffect(() => installNarrationPaintController(), []);

  return <MarkdownSurface route={route} />;
}
