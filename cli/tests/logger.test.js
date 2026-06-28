const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { createRemuxLogger } = require('../logger.cjs');

test('createRemuxLogger writes structured current and run logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'remux-logger-'));
  const terminalLines = [];
  const logger = createRemuxLogger({
    now: fixedNow(),
    rootDir: root,
    terminal: {
      error(message) {
        terminalLines.push(String(message));
      },
      log(message) {
        terminalLines.push(String(message));
      },
      warn(message) {
        terminalLines.push(String(message));
      },
    },
  });

  try {
    logger.event({
      detail: {
        nested: {
          ok: true,
        },
      },
      label: 'test:event',
      source: 'test',
      terminal: 'silent',
    });
    logger.warn('visible warning');

    const currentEntries = readJsonl(logger.currentPath);
    const runEntries = readJsonl(logger.runPath);

    assert.equal(currentEntries.length, 2);
    assert.deepEqual(currentEntries, runEntries);
    assert.equal(currentEntries[0].label, 'test:event');
    assert.equal(currentEntries[0].source, 'test');
    assert.equal(currentEntries[0].runId, logger.runId);
    assert.deepEqual(currentEntries[0].detail, { nested: { ok: true } });
    assert.equal(currentEntries[1].level, 'warn');
    assert.equal(currentEntries[1].message, 'visible warning');
    assert.deepEqual(terminalLines, ['visible warning']);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixedNow() {
  return () => new Date('2026-06-20T12:00:00.000Z');
}

function readJsonl(filePath) {
  return readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
