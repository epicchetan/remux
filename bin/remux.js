#!/usr/bin/env node

const { spawn } = require('node:child_process');

const remux = require('../cli/main.cjs');
const { remuxRestartExitCode } = require('../cli/restart.cjs');

if (require.main === module) {
  if (process.env.REMUX_WORKER === '1') {
    remux.main();
  } else {
    supervise(process.argv.slice(2));
  }
}

function supervise(argv) {
  const [command] = argv;
  if (command !== 'start') {
    remux.main(argv);
    return;
  }

  let child = null;
  let shuttingDown = false;

  const startWorker = () => {
    child = spawn(process.execPath, [__filename, ...argv], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REMUX_WORKER: '1',
      },
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      console.error(`remux worker failed to start: ${error.message}`);
      process.exitCode = 1;
    });

    child.on('exit', (code, signal) => {
      child = null;

      if (shuttingDown) {
        process.exitCode = code ?? 0;
        return;
      }

      if (code === remuxRestartExitCode) {
        startWorker();
        return;
      }

      if (signal) {
        process.exitCode = 1;
        return;
      }

      process.exitCode = code ?? 0;
    });
  };

  const shutdown = (signal) => {
    shuttingDown = true;
    if (child && !child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  startWorker();
}

module.exports = remux;
