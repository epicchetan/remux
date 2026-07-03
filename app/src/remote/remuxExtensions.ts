import { currentRemuxOrigin } from './remuxSettingsStore';

export type RemuxExtensionView = {
  route: string;
  url: string;
};

export type RemuxExtension = {
  display: {
    iconDarkUrl: string | null;
    iconUrl: string | null;
    title: string;
  };
  fileHandlers: RemuxFileHandler[];
  id: string;
  launchers: RemuxExtensionLauncher[];
  name: string;
  views: Record<string, RemuxExtensionView> & {
    main: RemuxExtensionView;
  };
};

export type RemuxExtensionLauncher = {
  extensionId: string;
  iconDarkUrl: string | null;
  iconUrl: string | null;
  id: string;
  label: string;
  route: RemuxLauncherRoute | null;
  view: string;
};

export type RemuxLauncherRoute = {
  kind: 'launch';
  launch: string | null;
  resourceKind: string | null;
};

export type RemuxFileHandler = {
  extensionId: string;
  extensions: string[];
  iconDarkUrl: string | null;
  iconUrl: string | null;
  id: string;
  label: string;
  view: string;
};

export type RemuxExtensionCatalog = {
  defaultExtensionId: string | null;
  extensions: RemuxExtension[];
};

type RawExtensionCatalog = {
  defaultExtensionId?: unknown;
  extensions?: unknown;
};

type RawExtension = {
  display?: unknown;
  fileHandlers?: unknown;
  id?: unknown;
  launchers?: unknown;
  name?: unknown;
  views?: unknown;
};

type RawExtensionDisplay = {
  iconDarkUrl?: unknown;
  iconUrl?: unknown;
  title?: unknown;
};

type RawView = {
  route?: unknown;
};

type RawLauncher = {
  extensionId?: unknown;
  iconDarkUrl?: unknown;
  iconUrl?: unknown;
  id?: unknown;
  label?: unknown;
  route?: unknown;
  view?: unknown;
};

type RawFileHandler = {
  extensionId?: unknown;
  extensions?: unknown;
  iconDarkUrl?: unknown;
  iconUrl?: unknown;
  id?: unknown;
  label?: unknown;
  view?: unknown;
};

export async function fetchRemuxExtensionCatalog(origin = currentRemuxOrigin()): Promise<RemuxExtensionCatalog> {
  const response = await fetch(`${origin}/remux/extensions`);

  if (!response.ok) {
    throw new Error(`Remux extension catalog failed (${response.status})`);
  }

  return parseRemuxExtensionCatalog(await response.json(), origin);
}

function parseRemuxExtensionCatalog(raw: unknown, origin: string): RemuxExtensionCatalog {
  if (!isRecord(raw)) {
    throw new Error('Invalid Remux extension catalog');
  }

  const catalog = raw as RawExtensionCatalog;
  const rawExtensions = Array.isArray(catalog.extensions) ? catalog.extensions : [];
  const extensions = rawExtensions.flatMap((extension) => parseRemuxExtension(extension, origin));

  return {
    defaultExtensionId: typeof catalog.defaultExtensionId === 'string' ? catalog.defaultExtensionId : null,
    extensions,
  };
}

function parseRemuxExtension(raw: unknown, origin: string): RemuxExtension[] {
  if (!isRecord(raw)) {
    return [];
  }

  const extension = raw as RawExtension;
  const display = isRecord(extension.display) ? extension.display as RawExtensionDisplay : {};
  const views = isRecord(extension.views) ? extension.views : {};
  const parsedViews = parseViews(views, origin);

  if (typeof extension.id !== 'string' || typeof extension.name !== 'string' || !parsedViews) {
    return [];
  }

  return [{
    display: {
      iconDarkUrl: typeof display.iconDarkUrl === 'string' ? remuxPublicUrl(display.iconDarkUrl, origin) : null,
      iconUrl: typeof display.iconUrl === 'string' ? remuxPublicUrl(display.iconUrl, origin) : null,
      title: typeof display.title === 'string' && display.title.trim().length > 0
        ? display.title
        : extension.name,
    },
    fileHandlers: parseFileHandlers(extension.fileHandlers, extension.id, origin),
    id: extension.id,
    launchers: parseLaunchers(extension.launchers, extension.id, origin),
    name: extension.name,
    views: parsedViews,
  }];
}

function parseViews(rawViews: Record<string, unknown>, origin: string) {
  const parsedViews: Record<string, RemuxExtensionView> = {};

  for (const [viewId, rawView] of Object.entries(rawViews)) {
    if (!isRecord(rawView)) {
      continue;
    }

    const view = rawView as RawView;
    if (typeof view.route !== 'string') {
      continue;
    }

    parsedViews[viewId] = {
      route: view.route,
      url: remuxViewerUrl(view.route, origin),
    };
  }

  return parsedViews.main
    ? parsedViews as Record<string, RemuxExtensionView> & { main: RemuxExtensionView }
    : null;
}

function parseLaunchers(raw: unknown, fallbackExtensionId: string, origin: string): RemuxExtensionLauncher[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const launcher = item as RawLauncher;
    if (typeof launcher.id !== 'string' || typeof launcher.label !== 'string') {
      return [];
    }

    return [{
      extensionId: typeof launcher.extensionId === 'string' ? launcher.extensionId : fallbackExtensionId,
      iconDarkUrl: typeof launcher.iconDarkUrl === 'string' ? remuxPublicUrl(launcher.iconDarkUrl, origin) : null,
      iconUrl: typeof launcher.iconUrl === 'string' ? remuxPublicUrl(launcher.iconUrl, origin) : null,
      id: launcher.id,
      label: launcher.label,
      route: parseLauncherRoute(launcher.route),
      view: typeof launcher.view === 'string' ? launcher.view : 'main',
    }];
  });
}

function parseLauncherRoute(raw: unknown): RemuxLauncherRoute | null {
  if (!isRecord(raw)) {
    return null;
  }

  const kind = raw.kind;
  if (kind !== 'launch') {
    return null;
  }

  return {
    kind,
    launch: typeof raw.launch === 'string' && raw.launch.trim().length > 0 ? raw.launch : null,
    resourceKind: typeof raw.resourceKind === 'string' && raw.resourceKind.trim().length > 0
      ? raw.resourceKind
      : null,
  };
}

function parseFileHandlers(raw: unknown, fallbackExtensionId: string, origin: string): RemuxFileHandler[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const handler = item as RawFileHandler;
    if (typeof handler.id !== 'string' || typeof handler.label !== 'string') {
      return [];
    }

    return [{
      extensionId: typeof handler.extensionId === 'string' ? handler.extensionId : fallbackExtensionId,
      extensions: stringArray(handler.extensions),
      iconDarkUrl: typeof handler.iconDarkUrl === 'string' ? remuxPublicUrl(handler.iconDarkUrl, origin) : null,
      iconUrl: typeof handler.iconUrl === 'string' ? remuxPublicUrl(handler.iconUrl, origin) : null,
      id: handler.id,
      label: handler.label,
      view: typeof handler.view === 'string' ? handler.view : 'main',
    }];
  });
}

export function themedIconUrl(
  source: { iconDarkUrl: string | null; iconUrl: string | null },
  isDark: boolean,
) {
  return isDark ? source.iconDarkUrl ?? source.iconUrl : source.iconUrl;
}

function remuxViewerUrl(route: string, origin: string) {
  const normalizedRoute = route.endsWith('/') ? route : `${route}/`;
  return `${origin}${normalizedRoute}`;
}

function remuxPublicUrl(url: string, origin: string) {
  if (/^https?:\/\//u.test(url)) {
    return url;
  }

  return url.startsWith('/') ? `${origin}${url}` : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
