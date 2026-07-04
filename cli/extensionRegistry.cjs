const { existsSync, readdirSync } = require('node:fs');
const { delimiter, join } = require('node:path');

const {
  loadExtensionManifest,
  manifestFilename,
} = require('./extensionManifest.cjs');
const {
  loadRemuxConfig,
  resolveExtensionRoots,
} = require('./config.cjs');

function discoverExtensions({ config, env = process.env, rootDir = process.cwd() } = {}) {
  const extensions = [];

  for (const extensionsDir of extensionRoots({ config, env, rootDir })) {
    if (!existsSync(extensionsDir)) {
      continue;
    }

    for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const manifestPath = join(extensionsDir, entry.name, manifestFilename);
      if (!existsSync(manifestPath)) {
        continue;
      }

      extensions.push(loadExtensionManifest(manifestPath));
    }
  }

  return extensions.sort((left, right) => left.id.localeCompare(right.id));
}

function extensionRoots({ config, env = process.env, rootDir = process.cwd() } = {}) {
  const raw = env.REMUX_EXTENSION_ROOTS;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.split(delimiter).filter((candidate) => candidate.length > 0);
  }

  const loadedConfig = config ?? loadRemuxConfig({ rootDir });
  if (Array.isArray(loadedConfig.extensionRoots) && loadedConfig.extensionRoots.length > 0) {
    return resolveExtensionRoots(loadedConfig.extensionRoots, rootDir);
  }

  return [join(rootDir, 'extensions')];
}

module.exports = {
  discoverExtensions,
  extensionRoots,
};
