const { resolve } = require('node:path');

const { createRemuxServer } = require('./httpServer.cjs');
const { createCoreRouter } = require('./core/coreRouter.cjs');
const { createFsRelay } = require('./fsRelay.cjs');
const { createRpcRouter } = require('./rpcRouter.cjs');
const { createExtensionProcess } = require('./extensionProcess.cjs');
const { discoverExtensions } = require('./extensionRegistry.cjs');
const { createRemuxLogger } = require('./logger.cjs');
const { createNotificationManager } = require('./notifications.cjs');
const { attachRemuxWebSocketServer, remuxWebSocketPath } = require('./wsServer.cjs');
const { createViewerProvider } = require('./viewerProvider.cjs');
const { remuxRestartExitCode } = require('./restart.cjs');

const restartForceExitDelayMs = 2000;

async function start({ env = process.env, rootDir = process.cwd() } = {}) {
  const runtimeRootDir = resolve(rootDir);
  const log = createRemuxLogger({ rootDir: runtimeRootDir });
  const runtime = loadRuntimeValues(env);
  const extensions = discoverExtensions({ env, rootDir: runtimeRootDir });
  const defaultExtension = defaultLaunchExtension(extensions);
  const notifications = createNotificationManager({ log, rootDir: runtimeRootDir });

  if (!defaultExtension) {
    throw new Error('No Remux extensions found under extensions/*');
  }

  const extensionServers = new Map(
    extensions
      .filter((extension) => extension.server)
      .map((extension) => [
        extension.id,
        createExtensionProcess({ extension, log }),
      ]),
  );
  const coreRouter = createCoreRouter({ rootDir: runtimeRootDir });
  const fsWatch = createFsRelay({ log });
  coreRouter.fs.subscribe(fsWatch.onDirectoryServed);
  const router = createRpcRouter({
    coreRouter,
    defaultExtensionId: defaultExtension.id,
    extensionServers,
    system: {
      async info() {
        return {
          cwd: runtimeRootDir,
        };
      },
      restart: async () => {
        setTimeout(() => {
          const forceExitTimer = setTimeout(() => {
            process.exit(remuxRestartExitCode);
          }, restartForceExitDelayMs);
          forceExitTimer.unref?.();
          void shutdown(remuxRestartExitCode)
            .catch((error) => {
              console.warn(`[remux] restart shutdown failed: ${errorMessage(error)}`);
            })
            .finally(() => {
              clearTimeout(forceExitTimer);
              process.exit(remuxRestartExitCode);
            });
        }, 200);
      },
    },
    log,
  });
  const viewerProviders = await Promise.all(
    extensions.map((extension) => createViewerProvider({ extension })),
  );
  const server = createRemuxServer({ defaultExtension, extensions, viewerProviders });
  let remuxWs = null;
  let shuttingDown = false;

  logStartConfig({ defaultExtension, extensions, log, runtime, viewerProviders });

  try {
    for (const provider of viewerProviders) {
      await provider.start?.(server);
    }

    remuxWs = attachRemuxWebSocketServer({
      fsWatch,
      onFatal: (reason, code = 1) => {
        log.error(reason);
        void shutdown(code).then(() => process.exit(code));
      },
      log,
      notifications,
      router,
      server,
    });
    fsWatch.start({ broadcast: remuxWs.broadcast, fs: coreRouter.fs });

    await router.start(remuxWs.ctx);
    await listen(server, runtime, log);
  } catch (error) {
    fsWatch.close();
    remuxWs?.close();
    await router.stop();
    await stopViewerProviders(viewerProviders, server);
    await closeServer(server);
    throw error;
  }

  process.on('SIGINT', () => {
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });

  async function shutdown(exitCode) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    fsWatch.close();
    remuxWs?.close();
    await router.stop();
    await stopViewerProviders(viewerProviders, server);
    await closeServer(server);
    process.exitCode = exitCode;
  }
}

function loadRuntimeValues(env = process.env) {
  return {
    host: env.REMUX_HOST || '0.0.0.0',
    port: parsePort(env.REMUX_PORT || '48123', 'REMUX_PORT'),
  };
}

function defaultLaunchExtension(extensions) {
  return extensions.find((extension) => Array.isArray(extension.launchers) && extension.launchers.length > 0) ?? extensions[0];
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }

  return port;
}

function listen(server, runtime, log = console) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      log.error?.(`remux failed to listen on ${bindDisplayUrl(runtime.host, runtime.port)}`);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      log.log?.(`remux listening on ${bindDisplayUrl(runtime.host, runtime.port)}`);
      resolve();
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(runtime.port, runtime.host);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function stopViewerProviders(viewerProviders, server) {
  await Promise.all(viewerProviders.map(async (provider) => {
    try {
      await provider.stop?.(server);
    } catch (error) {
      console.warn(`[remux] viewer provider stop failed: ${errorMessage(error)}`);
    }
  }));
}

function logStartConfig({ defaultExtension, extensions, log, runtime, viewerProviders }) {
  log.event({
    detail: {
      extensions: extensions.map((extension) => extension.id),
      http: bindDisplayUrl(runtime.host, runtime.port),
      viewer: {
        extensionId: defaultExtension.id,
        route: defaultExtension.views.main.route,
      },
      viewers: viewerProviders.map((provider) => ({
        extensionId: provider.id,
        route: provider.route,
      })),
      websocket: `ws://${runtime.host}:${runtime.port}${remuxWebSocketPath}`,
    },
    label: 'start:config',
    message: 'Remux',
    terminal: 'silent',
  });
  log.log('Remux');
  log.log(`  http:       ${bindDisplayUrl(runtime.host, runtime.port)}`);
  log.log(`  websocket:  ws://${runtime.host}:${runtime.port}${remuxWebSocketPath}`);
  log.log(`  viewer:     ${defaultExtension.id} ${defaultExtension.views.main.route}`);
  log.log(`  extensions: ${extensions.map((extension) => extension.id).join(', ')}`);
  log.log(`  viewers:    ${viewerProviders.map((provider) => `${provider.id} ${provider.route}`).join(', ')}`);
  log.log('');
}

function bindDisplayUrl(host, port) {
  if (host === '0.0.0.0') {
    return `http://0.0.0.0:${port} (all IPv4 interfaces)`;
  }

  if (host === '::') {
    return `http://[::]:${port} (all IPv6 interfaces)`;
  }

  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${displayHost}:${port}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  bindDisplayUrl,
  defaultLaunchExtension,
  loadRuntimeValues,
  start,
};
