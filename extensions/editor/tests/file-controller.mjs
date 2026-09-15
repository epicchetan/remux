import assert from 'node:assert/strict';

import { registerHooks } from 'node:module';

// Production is bundled by Vite; let Node resolve its extensionless TS imports.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error;
    return nextResolve(`${specifier}.ts`, context);
  }
} });
const { EditorFileController } = await import('../viewer/src/editor/fileController.ts');
const { resolveRenderer, renderers } = await import('../viewer/src/renderers/registry.ts');
const { rawFileUrl } = await import('../../../packages/viewer-kit/src/fs.ts');

function descriptor(path, overrides = {}) {
  return { path, name: path.split('/').at(-1), kind: 'file', targetKind: null,
    sizeBytes: 10, modifiedAtMs: 100, version: 'v1', mimeType: 'text/plain', isBinary: false, ...overrides };
}
const flushStat = () => Promise.resolve();

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
  stat: async (path) => descriptor(path),
  loadInitial(path) { const load = deferred(); loads.push({ load, path }); return load.promise; },
  loadWindow(path, options) { windows.push({ options, path }); return Promise.resolve(windowed(path, { range: { startByte: options.offset ?? 20, endByte: (options.offset ?? 20) + 4 }, targetLine: options.targetLine ? { byteOffset: 20, lineNumber: options.targetLine } : null })); },
  readGit() { const load = deferred(); gitLoads.push(load); return load.promise; },
});

controller.retarget('/report.md');
const firstLoad = controller.load();
await flushStat();
assert.equal(controller.snapshot().mode, 'preview');
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
await flushStat();
assert.equal(controller.snapshot().git.status, 'idle');
loads[1].load.reject(new Error('refresh failed'));
assert.equal(await refresh, false);
assert.equal(controller.snapshot().status, 'error');
assert.equal(controller.snapshot().document, retained);

const successfulReload = controller.reload();
await flushStat();
loads[2].load.resolve(full('/report.md'));
assert.equal(await successfulReload, true);
assert.notEqual(controller.snapshot().document.revision, retained.revision);

const stale = controller.reload();
await flushStat();
controller.setHostGeneration(2);
assert.equal(controller.snapshot().document, null, 'later host generations retire stale documents');
controller.retarget('/other.txt');
const current = controller.load();
await flushStat();
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
  stat: async (path) => descriptor(path),
  loadInitial() { const load = deferred(); lineLoads.push(load); return load.promise; },
  loadWindow(path, options) { lineWindows.push(options); return Promise.resolve(windowed(path, { targetLine: { byteOffset: 40, lineNumber: options.targetLine } })); },
  readGit() { throw new Error('unused'); },
});
lineController.retarget('/large.md', { focus: { line: 10, nonce: 'old' } });
const oldTargetLoad = lineController.load();
await flushStat();
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

// Registry scores, file symlinks, and non-file fallbacks.
for (const [path, mimeType, isBinary, id] of [
  ['/a.mdown', 'text/plain', false, 'markdown'], ['/a.htm', 'text/html', false, 'html'],
  ['/a.svg', 'image/svg+xml', false, 'image'], ['/a.pdf', 'application/pdf', true, 'pdf'],
  ['/a.mp4', 'video/mp4', true, 'media'], ['/a.wav', 'audio/wav', true, 'media'],
  ['/a.unknown', null, false, 'source'], ['/a.bin', null, true, 'binary'],
]) {
  assert.equal(resolveRenderer(descriptor(path, { mimeType, isBinary })).id, id);
  assert.equal(resolveRenderer(descriptor(path, { mimeType, isBinary, kind: 'symlink', targetKind: 'file' })).id, id);
}
for (const kind of ['directory', 'other', 'symlink']) {
  assert.equal(resolveRenderer(descriptor('/pretend.md', { kind })).id, 'binary');
}
assert.equal(rawFileUrl('/a & b.png', 'v:1 &'), '/remux/fs/raw?path=%2Fa%20%26%20b.png&v=v%3A1%20%26');
assert.equal(rawFileUrl('/a'), '/remux/fs/raw?path=%2Fa');
assert.equal(renderers.find((r) => r.id === 'source').capabilities(descriptor('/a'), windowed('/a')).copy, false);

const stats = [];
const reads = [];
const statController = new EditorFileController({
  stat(path, signal) { const request = deferred(); stats.push({ ...request, path, signal }); return request.promise; },
  async loadInitial(path) { reads.push(path); return full(path); },
  loadWindow() { throw new Error('unexpected window read'); },
  readGit() { throw new Error('unexpected git read'); },
});
statController.retarget('/first.txt');
const pendingStat = statController.load();
assert.equal(stats.length, 1);
assert.deepEqual(reads, [], 'stat must finish before any read');
statController.retarget('/image.png');
const imageLoad = statController.load();
assert.equal(stats[0].signal.aborted, true);
stats[0].resolve(descriptor('/first.txt'));
assert.equal(await pendingStat, false, 'retarget while stat is pending discards it');
assert.deepEqual(reads, [], 'retired stat cannot trigger a read');
const imageDescriptor = descriptor('/image.png', { mimeType: 'image/png', isBinary: true });
stats[1].resolve(imageDescriptor);
assert.equal(await imageLoad, true);
const firstImage = statController.snapshot().document;
assert.deepEqual(firstImage, { kind: 'media', media: 'image', url: '/remux/fs/raw?path=%2Fimage.png&v=v1',
  mimeType: 'image/png', sizeBytes: 10, version: 'v1' });
assert.deepEqual(reads, []);
assert.equal(statController.snapshot().mode, 'preview');
assert.equal(await statController.showDiff(), false);
assert.equal(await statController.loadTargetLine(5), false);
statController.setMode('source');
assert.equal(statController.snapshot().mode, 'preview');

const unchanged = statController.reload();
stats.at(-1).resolve(imageDescriptor);
assert.equal(await unchanged, true);
assert.equal(statController.snapshot().document, firstImage, 'unchanged media retains object identity');
const changed = statController.reload();
stats.at(-1).resolve({ ...imageDescriptor, version: 'v2' });
await changed;
assert.notEqual(statController.snapshot().document, firstImage);
assert.equal(statController.snapshot().document.url.endsWith('&v=v2'), true);
const lastImage = statController.snapshot().document;
const statFailure = statController.reload();
stats.at(-1).reject(new Error('stat failed'));
assert.equal(await statFailure, false);
assert.equal(statController.snapshot().status, 'error');
assert.equal(statController.snapshot().error, 'stat failed');
assert.equal(statController.snapshot().document, lastImage);
const retry = statController.reload();
stats.at(-1).resolve({ ...imageDescriptor, version: 'v2' });
await retry;
assert.notEqual(statController.snapshot().document, lastImage, 'retry after error replaces even unchanged media');

statController.retarget('/blob.bin');
const binaryLoad = statController.load();
stats.at(-1).resolve(descriptor('/blob.bin', { mimeType: null, isBinary: true }));
await binaryLoad;
assert.deepEqual(statController.snapshot().document, { kind: 'binary', mimeType: null, sizeBytes: 10, version: 'v1' });
assert.deepEqual(reads, []);
const binaryDocument = statController.snapshot().document;
const binaryReload = statController.reload();
stats.at(-1).resolve(descriptor('/blob.bin', { mimeType: null, isBinary: true }));
await binaryReload;
assert.equal(statController.snapshot().document, binaryDocument);

statController.retarget('/missing.txt');
const missing = statController.load();
stats.at(-1).reject(new Error('not found'));
await missing;
assert.equal(statController.snapshot().status, 'error');
assert.equal(statController.snapshot().document, null);

statController.retarget('/text.txt');
const textLoad = statController.load();
stats.at(-1).resolve(descriptor('/text.txt'));
await textLoad;
assert.deepEqual(reads, ['/text.txt']);
statController.setHostGeneration(1);
const retiredByHost = statController.reload();
statController.setHostGeneration(2);
stats.at(-1).resolve(descriptor('/text.txt'));
assert.equal(await retiredByHost, false);
assert.equal(statController.snapshot().descriptor, null);
assert.deepEqual(reads, ['/text.txt']);

statController.retarget('/superseded.txt');
const older = statController.load();
const olderStat = stats.at(-1);
const newer = statController.load();
stats.at(-1).resolve(descriptor('/superseded.txt'));
await newer;
olderStat.reject(new Error('stale stat error'));
assert.equal(await older, false);
assert.equal(statController.snapshot().status, 'ready');
console.log(JSON.stringify({ statFirst: true, statRetargetFenced: true, statHostGenerationFenced: true,
  statSupersededFenced: true, statErrors: true, mediaWithoutRead: true, binaryWithoutRead: true,
  mediaReloadIdentity: true, retryReplacesMedia: true, registryMatches: true }));
