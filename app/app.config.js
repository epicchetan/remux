// `eas update` evaluates this config and embeds the result in the update
// manifest (extra.expoClient), which is the only way `--message` reaches
// devices — scripts/eas-with-env.mjs sets REMUX_UPDATE_MESSAGE from the flag.
module.exports = ({ config }) => ({
  ...config,
  // A fingerprint policy protects normal releases. For a JS-only update to an
  // already-installed preview binary, the deploy command may explicitly name
  // that binary's proven-compatible runtime version.
  ...(process.env.REMUX_RUNTIME_VERSION
    ? { runtimeVersion: process.env.REMUX_RUNTIME_VERSION }
    : {}),
  extra: {
    ...config.extra,
    ...(process.env.REMUX_UPDATE_MESSAGE
      ? { updateMessage: process.env.REMUX_UPDATE_MESSAGE }
      : {}),
  },
});
