const { JsonRpcError } = require('../jsonRpc.cjs');
const {
  createFsCore,
  readDirectoriesMethod,
  readDirectoryMethod,
  readFileMethod,
} = require('./fs.cjs');

function createCoreRouter({ rootDir = process.cwd() } = {}) {
  const fsCore = createFsCore({ rootDir });

  return {
    fs: fsCore,
    async handleRpc(request) {
      if (isCoreMethod(request.method)) {
        return fsCore.handleRpc(request);
      }

      throw new JsonRpcError(-32601, `Method not found: ${request.method}`);
    },
  };
}

function isCoreMethod(method) {
  return isCoreFsMethod(method);
}

function isCoreFsMethod(method) {
  return typeof method === 'string' && method.startsWith('remux/fs/');
}

module.exports = {
  createCoreRouter,
  isCoreMethod,
  readDirectoriesMethod,
  readDirectoryMethod,
  readFileMethod,
};
