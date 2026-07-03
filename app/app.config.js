// `eas update` evaluates this config and embeds the result in the update
// manifest (extra.expoClient), which is the only way `--message` reaches
// devices — scripts/eas-with-env.mjs sets REMUX_UPDATE_MESSAGE from the flag.
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    ...(process.env.REMUX_UPDATE_MESSAGE
      ? { updateMessage: process.env.REMUX_UPDATE_MESSAGE }
      : {}),
  },
});
