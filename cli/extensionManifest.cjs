const { readFileSync } = require('node:fs');
const { dirname, isAbsolute, join } = require('node:path');

const manifestFilename = 'remux-extension.json';

function loadExtensionManifest(manifestPath) {
  const rootDir = dirname(manifestPath);
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));

  validateManifest(raw, manifestPath);

  const views = parseViews({ extensionId: raw.id, rawViews: raw.views, rootDir });
  const display = isRecord(raw.display) ? raw.display : {};
  const extension = {
    display: {
      icon: typeof display.icon === 'string' ? resolveManifestPath(rootDir, display.icon) : null,
      iconDark: typeof display.iconDark === 'string' ? resolveManifestPath(rootDir, display.iconDark) : null,
      title: typeof display.title === 'string' && display.title.trim().length > 0
        ? display.title
        : raw.name || raw.id,
    },
    id: raw.id,
    name: raw.name || raw.id,
    rootDir,
    server: parseServer({ rawServer: raw.server, rootDir }),
    fileHandlers: parseFileHandlers({
      extensionDisplay: display,
      rawHandlers: raw.fileHandlers,
      rootDir,
      views,
    }),
    launchers: parseLaunchers({
      extensionDisplay: display,
      extensionId: raw.id,
      rawLaunchers: raw.launchers,
      rootDir,
      views,
    }),
    views,
  };

  return extension;
}

function validateManifest(manifest, manifestPath = '(unknown)') {
  if (!isRecord(manifest)) {
    throw new Error(`Invalid Remux extension at ${manifestPath}: manifest must be an object`);
  }

  if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
    throw new Error(`Invalid Remux extension at ${manifestPath}: id must be a non-empty string`);
  }

  if (manifest.version !== 1) {
    throw new Error(`Invalid Remux extension ${manifest.id}: version must be 1`);
  }

  if (manifest.name !== undefined && typeof manifest.name !== 'string') {
    throw new Error(`Invalid Remux extension ${manifest.id}: name must be a string`);
  }

  validateServer(manifest);
  validateMainView(manifest);
  validateDisplay(manifest);
  validateLaunchers(manifest);
  validateFileHandlers(manifest);
}

function validateServer(manifest) {
  const server = manifest.server;
  if (server === undefined) {
    return;
  }

  if (!isRecord(server)) {
    throw new Error(`Invalid Remux extension ${manifest.id}: server must be an object`);
  }

  if (server.transport !== 'stdio') {
    throw new Error(`Invalid Remux extension ${manifest.id}: server.transport must be stdio`);
  }

  if (typeof server.command !== 'string' || server.command.length === 0) {
    throw new Error(`Invalid Remux extension ${manifest.id}: server.command must be a non-empty string`);
  }

  if (server.args !== undefined && !isStringArray(server.args)) {
    throw new Error(`Invalid Remux extension ${manifest.id}: server.args must be an array of strings`);
  }

  if (server.cwd !== undefined && typeof server.cwd !== 'string') {
    throw new Error(`Invalid Remux extension ${manifest.id}: server.cwd must be a string`);
  }
}

function validateMainView(manifest) {
  if (!isRecord(manifest.views) || !isRecord(manifest.views.main)) {
    throw new Error(`Invalid Remux extension ${manifest.id}: views.main must be an object`);
  }

  for (const [viewId, view] of Object.entries(manifest.views)) {
    if (!isRecord(view)) {
      throw new Error(`Invalid Remux extension ${manifest.id}: views.${viewId} must be an object`);
    }

    if (view.route !== undefined && (typeof view.route !== 'string' || !view.route.startsWith('/'))) {
      throw new Error(`Invalid Remux extension ${manifest.id}: views.${viewId}.route must start with /`);
    }

    if (typeof view.entry !== 'string' || view.entry.length === 0) {
      throw new Error(`Invalid Remux extension ${manifest.id}: views.${viewId}.entry must be a non-empty string`);
    }

    if (view.dev !== undefined) {
      throw new Error(`Invalid Remux extension ${manifest.id}: views.${viewId}.dev is not supported`);
    }
  }
}

function parseServer({ rawServer, rootDir }) {
  if (rawServer === undefined) {
    return null;
  }

  return {
    args: rawServer.args || [],
    command: rawServer.command,
    cwd: resolveManifestPath(rootDir, rawServer.cwd || '.'),
    transport: rawServer.transport,
  };
}

function validateDisplay(manifest) {
  if (manifest.display === undefined) {
    return;
  }

  if (!isRecord(manifest.display)) {
    throw new Error(`Invalid Remux extension ${manifest.id}: display must be an object`);
  }

  if (manifest.display.title !== undefined && (
    typeof manifest.display.title !== 'string' || manifest.display.title.trim().length === 0
  )) {
    throw new Error(`Invalid Remux extension ${manifest.id}: display.title must be a non-empty string`);
  }

  validateIconField({ extensionId: manifest.id, field: 'display.icon', value: manifest.display.icon });
  validateIconField({ extensionId: manifest.id, field: 'display.iconDark', value: manifest.display.iconDark });

  if (manifest.display.iconDark !== undefined && manifest.display.icon === undefined) {
    throw new Error(`Invalid Remux extension ${manifest.id}: display.iconDark requires display.icon`);
  }
}

function validateIconField({ extensionId, field, value }) {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid Remux extension ${extensionId}: ${field} must be a non-empty string`);
  }

  if (value.toLowerCase().endsWith('.svg')) {
    throw new Error(`Invalid Remux extension ${extensionId}: ${field} must be a raster image (png, jpg, or webp) — the app cannot render svg icons`);
  }
}

function validateLaunchers(manifest) {
  if (manifest.launchers === undefined) {
    return;
  }

  if (!Array.isArray(manifest.launchers)) {
    throw new Error(`Invalid Remux extension ${manifest.id}: launchers must be an array`);
  }

  validateEntryPointIds({
    extensionId: manifest.id,
    field: 'launchers',
    entries: manifest.launchers,
  });

  for (const launcher of manifest.launchers) {
    validateEntryPoint({
      defaultView: 'main',
      entry: launcher,
      extensionId: manifest.id,
      field: 'launchers',
      views: manifest.views,
    });

    if (launcher.route !== undefined) {
      validateLauncherRoute({ extensionId: manifest.id, route: launcher.route });
    }
  }
}

function validateFileHandlers(manifest) {
  if (manifest.fileHandlers === undefined) {
    return;
  }

  if (!Array.isArray(manifest.fileHandlers)) {
    throw new Error(`Invalid Remux extension ${manifest.id}: fileHandlers must be an array`);
  }

  validateEntryPointIds({
    extensionId: manifest.id,
    field: 'fileHandlers',
    entries: manifest.fileHandlers,
  });

  for (const handler of manifest.fileHandlers) {
    validateEntryPoint({
      defaultView: 'main',
      entry: handler,
      extensionId: manifest.id,
      field: 'fileHandlers',
      views: manifest.views,
    });

    if (handler.extensions !== undefined && !isStringArray(handler.extensions)) {
      throw new Error(`Invalid Remux extension ${manifest.id}: fileHandlers.extensions must be an array of strings`);
    }
  }
}

function validateEntryPoint({
  defaultView,
  entry,
  extensionId,
  field,
  views,
}) {
  if (!isRecord(entry)) {
    throw new Error(`Invalid Remux extension ${extensionId}: ${field} entries must be objects`);
  }

  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    throw new Error(`Invalid Remux extension ${extensionId}: ${field}.id must be a non-empty string`);
  }

  if (entry.view !== undefined && typeof entry.view !== 'string') {
    throw new Error(`Invalid Remux extension ${extensionId}: ${field}.view must be a string`);
  }

  const viewId = entry.view || defaultView;
  if (!isRecord(views[viewId])) {
    throw new Error(`Invalid Remux extension ${extensionId}: ${field}.view must reference an existing view`);
  }

  if (entry.label !== undefined && (typeof entry.label !== 'string' || entry.label.trim().length === 0)) {
    throw new Error(`Invalid Remux extension ${extensionId}: ${field}.label must be a non-empty string`);
  }

  validateIconField({ extensionId, field: `${field}.icon`, value: entry.icon });
  validateIconField({ extensionId, field: `${field}.iconDark`, value: entry.iconDark });

  if (entry.iconDark !== undefined && entry.icon === undefined) {
    throw new Error(`Invalid Remux extension ${extensionId}: ${field}.iconDark requires ${field}.icon`);
  }
}

function validateEntryPointIds({ entries, extensionId, field }) {
  const ids = new Set();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      continue;
    }

    if (ids.has(entry.id)) {
      throw new Error(`Invalid Remux extension ${extensionId}: ${field}.id values must be unique`);
    }
    ids.add(entry.id);
  }
}

function validateLauncherRoute({ extensionId, route }) {
  if (!isRecord(route)) {
    throw new Error(`Invalid Remux extension ${extensionId}: launchers.route must be an object`);
  }

  if (route.kind !== 'launch') {
    throw new Error(`Invalid Remux extension ${extensionId}: launchers.route.kind must be launch`);
  }

  if (route.launch !== undefined && route.launch !== null && typeof route.launch !== 'string') {
    throw new Error(`Invalid Remux extension ${extensionId}: launchers.route.launch must be a string or null`);
  }

  if (route.resourceKind !== undefined && route.resourceKind !== null && typeof route.resourceKind !== 'string') {
    throw new Error(`Invalid Remux extension ${extensionId}: launchers.route.resourceKind must be a string or null`);
  }
}

function parseViews({ extensionId, rawViews, rootDir }) {
  const views = {};

  for (const [viewId, rawView] of Object.entries(rawViews)) {
    views[viewId] = parseView({ extensionId, rawView, rootDir, viewId });
  }

  return views;
}

function parseView({ extensionId, rawView, rootDir, viewId }) {
  return {
    entry: resolveManifestPath(rootDir, rawView.entry),
    route: normalizeRoute(rawView.route || defaultViewRoute({ extensionId, viewId })),
  };
}

function defaultViewRoute({ extensionId, viewId }) {
  return viewId === 'main'
    ? `/viewers/${extensionId}`
    : `/viewers/${extensionId}/${viewId}`;
}

function parseLaunchers({
  extensionDisplay,
  extensionId,
  rawLaunchers,
  rootDir,
  views,
}) {
  if (!Array.isArray(rawLaunchers)) {
    return [];
  }

  return rawLaunchers.map((launcher) => {
    const view = launcher.view || 'main';
    return {
      ...iconPair({ entry: launcher, extensionDisplay, rootDir }),
      id: launcher.id,
      label: typeof launcher.label === 'string' && launcher.label.trim().length > 0
        ? launcher.label
        : extensionDisplay.title || extensionId,
      route: parseLauncherRoute(launcher.route),
      view,
      viewRoute: views[view].route,
    };
  });
}

function parseLauncherRoute(route) {
  if (!isRecord(route)) {
    return null;
  }

  return {
    kind: 'launch',
    launch: typeof route.launch === 'string' && route.launch.trim().length > 0
      ? route.launch
      : null,
    resourceKind: typeof route.resourceKind === 'string' && route.resourceKind.trim().length > 0
      ? route.resourceKind
      : null,
  };
}

function parseFileHandlers({
  extensionDisplay,
  rawHandlers,
  rootDir,
  views,
}) {
  if (!Array.isArray(rawHandlers)) {
    return [];
  }

  return rawHandlers.map((handler) => {
    const view = handler.view || 'main';
    return {
      extensions: Array.isArray(handler.extensions)
        ? handler.extensions.map((extension) => extension.toLowerCase())
        : [],
      ...iconPair({ entry: handler, extensionDisplay, rootDir }),
      id: handler.id,
      label: typeof handler.label === 'string' && handler.label.trim().length > 0
        ? handler.label
        : handler.id,
      view,
      viewRoute: views[view].route,
    };
  });
}

// An entry with its own icon never inherits display.iconDark — both variants
// must come from the same source so light/dark stay a matched pair.
function iconPair({ entry, extensionDisplay, rootDir }) {
  if (typeof entry.icon === 'string') {
    return {
      icon: resolveManifestPath(rootDir, entry.icon),
      iconDark: typeof entry.iconDark === 'string' ? resolveManifestPath(rootDir, entry.iconDark) : null,
    };
  }

  return {
    icon: typeof extensionDisplay.icon === 'string' ? resolveManifestPath(rootDir, extensionDisplay.icon) : null,
    iconDark: typeof extensionDisplay.iconDark === 'string' ? resolveManifestPath(rootDir, extensionDisplay.iconDark) : null,
  };
}

function normalizeRoute(route) {
  return route.endsWith('/') && route !== '/' ? route.slice(0, -1) : route;
}

function resolveManifestPath(rootDir, value) {
  return isAbsolute(value) ? value : join(rootDir, value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

module.exports = {
  loadExtensionManifest,
  manifestFilename,
  validateManifest,
};
