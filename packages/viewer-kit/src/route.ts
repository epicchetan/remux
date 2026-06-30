export type RemuxViewerRoute = {
  handlerId: string | null;
  launch: string | null;
  resourceId: string | null;
  resourceKind: string | null;
  tabId: string | null;
};

export function parseRemuxViewerRoute(url: string): RemuxViewerRoute {
  const params = new URL(url).searchParams;

  return {
    handlerId: params.get('remuxHandler'),
    launch: params.get('remuxLaunch'),
    resourceId: params.get('remuxResourceId'),
    resourceKind: params.get('remuxResourceKind'),
    tabId: params.get('remuxTabId'),
  };
}
