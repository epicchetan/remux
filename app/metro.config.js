const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');
const config = getDefaultConfig(projectRoot);

config.watchFolders = Array.from(new Set([
  ...(config.watchFolders ?? []),
  workspaceRoot,
]));

config.resolver.nodeModulesPaths = Array.from(new Set([
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
  ...(config.resolver.nodeModulesPaths ?? []),
]));
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
