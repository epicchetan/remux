const http = require('node:http');
const { readFile } = require('node:fs/promises');
const { extname } = require('node:path');

function createRemuxServer({ defaultExtension, extensions = [], viewerProviders }) {
  return http.createServer((request, response) => {
    void handleRequest({
      defaultExtension,
      extensions,
      request,
      response,
      viewerProviders,
    }).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain' });
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
}

async function handleRequest({
  defaultExtension,
  extensions,
  request,
  response,
  viewerProviders,
}) {
  if (isHealthPath(request.url)) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, defaultExtension: defaultExtension.id, service: 'remux' }));
    return;
  }

  if (isExtensionCatalogPath(request.url)) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(extensionCatalog({ defaultExtension, extensions })));
    return;
  }

  const icon = iconForIconPath(request.url, extensions);
  if (icon) {
    await serveExtensionIcon({ iconPath: icon.path, response });
    return;
  }

  if (request.url === '/' || request.url === '') {
    response.writeHead(302, { location: `${defaultExtension.views.main.route}/` });
    response.end();
    return;
  }

  for (const provider of viewerProviders) {
    if (await provider.handle(request, response)) {
      return;
    }
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('Not found.');
}

function isHealthPath(url) {
  return url === '/readyz' || url === '/healthz' || url === '/health';
}

function isExtensionCatalogPath(url) {
  return pathnameOf(url) === '/remux/extensions';
}

function extensionCatalog({ defaultExtension, extensions }) {
  return {
    defaultExtensionId: defaultExtension?.id ?? null,
    extensions: extensions.map((extension) => {
      const normalizedExtension = normalizeCatalogExtension(extension);

      return {
        display: {
          iconDarkUrl: normalizedExtension.display?.iconDark ? extensionIconRoute(normalizedExtension, null, 'dark') : null,
          iconUrl: normalizedExtension.display?.icon ? extensionIconRoute(normalizedExtension) : null,
          title: normalizedExtension.display?.title ?? normalizedExtension.name,
        },
        fileHandlers: normalizedExtension.fileHandlers.map((handler) => ({
          extensionId: normalizedExtension.id,
          extensions: handler.extensions,
          iconDarkUrl: handler.iconDark ? extensionIconRoute(normalizedExtension, { id: handler.id, kind: 'fileHandler' }, 'dark') : null,
          iconUrl: handler.icon ? extensionIconRoute(normalizedExtension, { id: handler.id, kind: 'fileHandler' }) : null,
          id: handler.id,
          label: handler.label,
          view: handler.view,
        })),
        id: normalizedExtension.id,
        launchers: normalizedExtension.launchers.map((launcher) => ({
          extensionId: normalizedExtension.id,
          iconDarkUrl: launcher.iconDark ? extensionIconRoute(normalizedExtension, { id: launcher.id, kind: 'launcher' }, 'dark') : null,
          iconUrl: launcher.icon ? extensionIconRoute(normalizedExtension, { id: launcher.id, kind: 'launcher' }) : null,
          id: launcher.id,
          label: launcher.label,
          route: launcher.route,
          view: launcher.view,
        })),
        name: normalizedExtension.name,
        views: publicViews(normalizedExtension.views),
      };
    }),
    service: 'remux',
  };
}

function normalizeCatalogExtension(extension) {
  return {
    ...extension,
    fileHandlers: Array.isArray(extension.fileHandlers) ? extension.fileHandlers : [],
    launchers: Array.isArray(extension.launchers) ? extension.launchers : [],
  };
}

function iconForIconPath(url, extensions) {
  const path = pathnameOf(url);
  const match = /^\/remux\/extensions\/([^/]+)\/icon$/u.exec(path);
  if (!match) {
    return null;
  }

  const extensionId = decodePathPart(match[1]);
  if (!extensionId) {
    return null;
  }

  const extension = extensions.find((candidate) => candidate.id === extensionId);
  if (!extension) {
    return null;
  }
  const normalizedExtension = normalizeCatalogExtension(extension);

  const params = searchParamsOf(url);
  const kind = params.get('kind');
  const id = params.get('id');
  const variant = params.get('variant') === 'dark' ? 'dark' : null;

  if (kind === 'launcher' && id) {
    const launcher = normalizedExtension.launchers.find((candidate) => candidate.id === id);
    const iconPath = iconVariantPath(launcher, variant);
    return iconPath ? { path: iconPath } : null;
  }

  if (kind === 'fileHandler' && id) {
    const handler = normalizedExtension.fileHandlers.find((candidate) => candidate.id === id);
    const iconPath = iconVariantPath(handler, variant);
    return iconPath ? { path: iconPath } : null;
  }

  const displayPath = iconVariantPath(normalizedExtension.display, variant);
  return displayPath ? { path: displayPath } : null;
}

// Falls back to the light icon when a dark variant is requested but missing,
// so a stale variant URL still resolves to something renderable.
function iconVariantPath(entry, variant) {
  if (!entry) {
    return null;
  }

  const icon = typeof entry.icon === 'string' ? entry.icon : null;
  if (variant !== 'dark') {
    return icon;
  }

  return typeof entry.iconDark === 'string' ? entry.iconDark : icon;
}

async function serveExtensionIcon({ iconPath, response }) {
  try {
    const icon = await readFile(iconPath);
    response.writeHead(200, {
      'cache-control': 'no-cache',
      'content-type': contentTypeForPath(iconPath),
    });
    response.end(icon);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Extension icon not found.');
  }
}

function extensionIconRoute(extension, source, variant) {
  const iconPath = iconPathForSource(extension, source, variant);
  const format = extname(iconPath).slice(1) || 'asset';
  const params = new URLSearchParams({ format });

  if (source) {
    params.set('kind', source.kind);
    params.set('id', source.id);
  }

  if (variant === 'dark') {
    params.set('variant', 'dark');
  }

  return `/remux/extensions/${encodeURIComponent(extension.id)}/icon?${params.toString()}`;
}

function iconPathForSource(extension, source, variant) {
  if (source?.kind === 'launcher') {
    const launcher = extension.launchers.find((candidate) => candidate.id === source.id);
    return iconVariantPath(launcher, variant) ?? iconVariantPath(extension.display, variant);
  }

  if (source?.kind === 'fileHandler') {
    const handler = extension.fileHandlers.find((candidate) => candidate.id === source.id);
    return iconVariantPath(handler, variant) ?? iconVariantPath(extension.display, variant);
  }

  return iconVariantPath(extension.display, variant);
}

function publicViews(views) {
  return Object.fromEntries(
    Object.entries(views).map(([viewId, view]) => [
      viewId,
      {
        route: view.route,
      },
    ]),
  );
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function contentTypeForPath(path) {
  switch (extname(path).toLowerCase()) {
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function pathnameOf(url) {
  return new URL(url || '/', 'http://remux.local').pathname;
}

function searchParamsOf(url) {
  return new URL(url || '/', 'http://remux.local').searchParams;
}

module.exports = {
  createRemuxServer,
  extensionCatalog,
  isHealthPath,
};
