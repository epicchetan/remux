const { createReadStream, existsSync } = require('node:fs');
const { dirname, extname, join, normalize, relative } = require('node:path');

function createViewerProvider({ extension }) {
  const route = normalizeRoute(extension?.views?.main?.route);

  return {
    id: extension.id,
    route,

    async start() {
    },

    handle(request, response) {
      if (!isViewerRequest(route, request.url)) {
        return false;
      }

      serveStaticViewer({ extension, request, response, route });
      return true;
    },

    async stop() {
    },
  };
}

function isViewerRequest(route, requestUrl) {
  if (!requestUrl) {
    return false;
  }

  const pathname = new URL(requestUrl, 'http://remux.local').pathname;
  return pathname === route || pathname.startsWith(`${route}/`);
}

function serveStaticViewer({ extension, request, response, route }) {
  const entry = extension.views.main.entry;
  const assetPath = staticAssetPath({ entry, requestUrl: request.url, route });
  const filePath = existsSync(assetPath) ? assetPath : entry;

  if (!existsSync(filePath)) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Viewer asset not found.');
    return;
  }

  response.writeHead(200, { 'content-type': contentType(filePath) });
  createReadStream(filePath).pipe(response);
}

function staticAssetPath({ entry, requestUrl, route }) {
  const pathname = new URL(requestUrl || '/', 'http://remux.local').pathname;
  if (pathname !== route && !pathname.startsWith(`${route}/`)) {
    return entry;
  }

  if (pathname === route || pathname === `${route}/`) {
    return entry;
  }

  const root = dirname(entry);
  const relativePath = pathname.slice(route.length).replace(/^\/+/u, '');
  const candidate = normalize(join(root, relativePath));

  return relative(root, candidate).startsWith('..') ? entry : candidate;
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

function normalizeRoute(route) {
  if (typeof route !== 'string' || !route.startsWith('/')) {
    throw new Error(`Invalid viewer route: ${route}`);
  }

  return route.endsWith('/') ? route.slice(0, -1) : route;
}

module.exports = {
  contentType,
  createViewerProvider,
  isViewerRequest,
  staticAssetPath,
};
