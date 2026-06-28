const assert = require('node:assert/strict');
const test = require('node:test');

const { main } = require('../main.cjs');

test('main starts the runtime for the start command', async () => {
  const calls = [];

  main(['start'], {
    start: async () => {
      calls.push('start');
    },
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ['start']);
});

test('main rejects unsupported commands with start usage', () => {
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const errors = [];

  console.error = (message) => {
    errors.push(message);
  };
  process.exitCode = undefined;

  try {
    main(['serve-dev'], {
      start: async () => {
        throw new Error('should not start');
      },
    });

    assert.deepEqual(errors, ['Usage: remux start']);
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
});
