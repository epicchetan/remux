#!/usr/bin/env node

const { start: startRuntime } = require('./start.cjs');

function main(argv = process.argv.slice(2), { start = startRuntime } = {}) {
  const [command] = argv;

  if (command !== 'start') {
    console.error('Usage: remux start');
    process.exitCode = 1;
    return;
  }

  void start().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
