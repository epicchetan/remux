import { parseRemuxViewerRoute } from '@remux/viewer-kit/route';

import { MarkdownSurface } from './markdown/MarkdownSurface';

export function App() {
  const route = parseRemuxViewerRoute(window.location.href);

  return <MarkdownSurface route={route} />;
}
