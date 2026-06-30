import { parseRemuxViewerRoute } from '@remux/viewer-kit/route';

import { EditorSurface } from './editor/EditorSurface';

export function App() {
  const route = parseRemuxViewerRoute(window.location.href);

  return <EditorSurface route={route} />;
}
