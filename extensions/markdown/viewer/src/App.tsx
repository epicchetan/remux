import { parseRemuxViewerRoute } from '@remux/extension-api/route';

import { MarkdownSurface } from './markdown/MarkdownSurface';

export function App() {
  const route = parseRemuxViewerRoute(window.location.href);

  return <MarkdownSurface route={route} />;
}
