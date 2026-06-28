import { parseRemuxViewerRoute } from '@remux/extension-api/route';

import { EditorSurface } from './editor/EditorSurface';

export function App() {
  const route = parseRemuxViewerRoute(window.location.href);

  return <EditorSurface route={route} />;
}
