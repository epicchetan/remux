import assert from 'node:assert/strict';

import { EditorFileController } from '../viewer/src/editor/fileController.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, reject, resolve };
}

function full(path, text = 'hello') {
  return { kind: 'full', lightweight: false, name: path.split('/').at(-1), path, revision: 'r1', sizeBytes: text.length, text };
}
function windowed(path, overrides = {}) {
  return {
    continuation: { endsMidLine: true, startsMidLine: false }, eof: false, kind: 'windowed',
    name: path.split('/').at(-1), nextOffset: 4, path, previousOffset: null,
    range: { endByte: 4, startByte: 0 }, targetLine: null, text: 'page',
    totalSizeBytes: 1_000_000, version: 'v1', ...overrides,
  };
}

const loads = [];
const windows = [];
const gitLoads = [];
const controller = new EditorFileController({
  loadInitial(path) { const load = deferred(); loads.push({ load, path }); return load.promise; },
  loadWindow(path, options) { windows.push({ options, path }); return Promise.resolve(windowed(path, { range: { startByte: options.offset ?? 20, endByte: (options.offset ?? 20) + 4 }, targetLine: options.targetLine ? { byteOffset: 20, lineNumber: options.targetLine } : null })); },
  readGit() { const load = deferred(); gitLoads.push(load); return load.promise; },
});

controller.retarget('/report.md');
assert.equal(controller.snapshot().mode, 'preview');
const firstLoad = controller.load();
controller.setHostGeneration(1);
assert.equal(controller.snapshot().status, 'loading', 'the first host generation must not cancel the initial read');
loads[0].load.resolve(full('/report.md'));
assert.equal(await firstLoad, true);
const retained = controller.snapshot().document;
controller.setMode('source');
controller.retarget('/report.md');
assert.equal(controller.snapshot().mode, 'source');
assert.equal(controller.snapshot().document, retained);

const abandonedDiff = controller.showDiff();
controller.setMode('preview');
gitLoads[0].resolve({ base: null, repoRoot: null, status: null });
assert.equal(await abandonedDiff, false);
assert.equal(controller.snapshot().diffVisible, false);
assert.equal(controller.snapshot().git.status, 'idle');

const supersededDiff = controller.showDiff();
const currentDiff = controller.showDiff();
gitLoads[1].reject(new Error('superseded'));
gitLoads[2].resolve({ base: null, repoRoot: null, status: null });
assert.equal(await supersededDiff, false);
assert.equal(await currentDiff, true);
assert.equal(controller.snapshot().diffVisible, true);
await controller.showDiff();
assert.equal(controller.snapshot().diffVisible, false);

const refresh = controller.reload();
assert.equal(controller.snapshot().git.status, 'idle');
loads[1].load.reject(new Error('refresh failed'));
assert.equal(await refresh, false);
assert.equal(controller.snapshot().status, 'error');
assert.equal(controller.snapshot().document, retained);

const successfulReload = controller.reload();
loads[2].load.resolve(full('/report.md'));
assert.equal(await successfulReload, true);
assert.notEqual(controller.snapshot().document.revision, retained.revision);

const stale = controller.reload();
controller.setHostGeneration(2);
assert.equal(controller.snapshot().document, null, 'later host generations retire stale documents');
controller.retarget('/other.txt');
const current = controller.load();
loads[3].load.resolve(full('/report.md', 'stale'));
loads[4].load.resolve(windowed('/other.txt'));
assert.equal(await stale, false);
assert.equal(await current, true);
assert.equal(controller.snapshot().document.path, '/other.txt');

await controller.loadNext();
assert.equal(windows.at(-1).options.expectedVersion, 'v1');
assert.equal(windows.at(-1).options.offset, 4);
controller.retarget('/other.txt', { focus: { line: 900, nonce: 'nav-1' } });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(controller.snapshot().mode, 'source');
assert.equal(windows.at(-1).options.targetLine, 900);
assert.equal(controller.snapshot().pendingFocus.nonce, 'nav-1');
controller.acknowledgeFocus('older');
assert.equal(controller.snapshot().pendingFocus.nonce, 'nav-1');
controller.acknowledgeFocus('nav-1');
assert.equal(controller.snapshot().pendingFocus, null);

const lineLoads = [];
const lineWindows = [];
const lineController = new EditorFileController({
  loadInitial() { const load = deferred(); lineLoads.push(load); return load.promise; },
  loadWindow(path, options) { lineWindows.push(options); return Promise.resolve(windowed(path, { targetLine: { byteOffset: 40, lineNumber: options.targetLine } })); },
  readGit() { throw new Error('unused'); },
});
lineController.retarget('/large.md', { focus: { line: 10, nonce: 'old' } });
const oldTargetLoad = lineController.load();
lineController.retarget('/large.md', { focus: { line: 20, nonce: 'latest' } });
lineLoads[0].resolve(windowed('/large.md', { targetLine: { byteOffset: 20, lineNumber: 10 } }));
await oldTargetLoad;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(lineWindows.at(-1).targetLine, 20);
assert.equal(lineController.snapshot().pendingFocus.nonce, 'latest');

lineController.setHostGeneration(7);
lineController.setHostGeneration(null);
assert.equal(lineController.snapshot().hostGeneration, null);

process.stdout.write(`${JSON.stringify({ diffIntentFenced: true, failedRefreshRetains: true, pagingVersionFenced: true, racesFenced: true, reloadResetsGit: true, sameFileModePreserved: true, targetNoncePreserved: true })}\n`);
