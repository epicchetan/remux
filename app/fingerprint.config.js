/** @type {import('expo/fingerprint').Config} */
const config = {
  fileHookTransform(source, chunk, isEndOfFile) {
    if (source.type !== 'contents' || source.id !== 'expoConfig') {
      return chunk;
    }

    if (!isEndOfFile || typeof chunk !== 'string') {
      return chunk;
    }

    const expoConfig = JSON.parse(chunk);
    if (
      expoConfig.extra
      && typeof expoConfig.extra === 'object'
      && !Array.isArray(expoConfig.extra)
    ) {
      delete expoConfig.extra.updateMessage;
    }

    return JSON.stringify(expoConfig);
  },
};

module.exports = config;
