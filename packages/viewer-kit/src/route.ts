export type RemuxViewerRoute = {
  focusId: string | null;
  focusKind: string | null;
  handlerId: string | null;
  launch: string | null;
  resourceId: string | null;
  resourceKind: string | null;
  tabId: string | null;
};

export function parseRemuxViewerRoute(url: string): RemuxViewerRoute {
  const params = new URL(url).searchParams;

  return {
    focusId: params.get('remuxFocusId'),
    focusKind: params.get('remuxFocusKind'),
    handlerId: params.get('remuxHandler'),
    launch: params.get('remuxLaunch'),
    resourceId: params.get('remuxResourceId'),
    resourceKind: params.get('remuxResourceKind'),
    tabId: params.get('remuxTabId'),
  };
}

type ResourceKeyInput = {
  extensionId?: string | null;
  resourceId?: string | null;
  resourceKind?: string | null;
  viewId?: string | null;
};

export type NormalizedResourceKey = {
  extensionId: string;
  resourceId: string | null;
  resourceKind: string | null;
  viewId: string;
};

export function normalizeResourceKey(input: ResourceKeyInput): NormalizedResourceKey {
  return {
    extensionId: input.extensionId?.trim() ?? '',
    resourceId: input.resourceId?.trim() || null,
    resourceKind: input.resourceKind?.trim() || null,
    viewId: input.viewId?.trim() || 'main',
  };
}

export function serializedResourceKey(input: ResourceKeyInput): string | null {
  const key = normalizeResourceKey(input);
  if (!key.extensionId || !key.resourceKind || !key.resourceId) {
    return null;
  }

  return JSON.stringify([key.extensionId, key.viewId, key.resourceKind, key.resourceId]);
}

export function sameSerializedResourceKey(left: ResourceKeyInput, right: ResourceKeyInput) {
  const leftKey = serializedResourceKey(left);
  return leftKey !== null && leftKey === serializedResourceKey(right);
}
