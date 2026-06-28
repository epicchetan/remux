import { parseRemuxViewerRoute } from '@remux/extension-api/route';

import { TerminalSurface } from './terminal/TerminalSurface';

export function App() {
  const route = parseRemuxViewerRoute(window.location.href);

  return <TerminalSurface route={route} />;
}
