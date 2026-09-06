import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

import {
  HTML_PREVIEW_MAX_BYTES,
  HtmlPreviewLoadController,
  readHtmlPreviewFile,
} from '../src/surfaces/html-preview/htmlPreviewLoad.ts';

const expoTextDecoderSource = await readFile(
  new URL('../../node_modules/expo/src/winter/TextDecoder.ts', import.meta.url),
  'utf8',
);
const expoTextDecoderModule = await import(`data:text/javascript;base64,${Buffer.from(
  ts.transpileModule(expoTextDecoderSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText,
).toString('base64')}`);
const ExpoTextDecoder = expoTextDecoderModule.TextDecoder;
// Exercise the same decoder installed by Expo on Hermes through the actual
// loading path, including multi-megabyte inputs, rather than Node's decoder.
globalThis.TextDecoder = ExpoTextDecoder;

function response(path, bytes) {
  return {
    dataBase64: Buffer.from(bytes).toString('base64'),
    encoding: 'base64',
    isBinary: false,
    path,
    sizeBytes: bytes.length,
    tooLarge: false,
  };
}

const calls = [];
assert.equal(new ExpoTextDecoder('utf-8', { fatal: true }).decode(new Uint8Array()), '');
assert.throws(
  () => new ExpoTextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from([0xc0, 0x80])),
  /Decoder error/,
);
const sample = Buffer.from('<!doctype html><title>✓</title>');
assert.equal(await readHtmlPreviewFile(async (method, params, options) => {
  calls.push({ method, options, params });
  return response('/tmp/report.html', sample);
}, { path: '/tmp/./report.html', requestIdentity: 'tab:17' }), sample.toString());
assert.equal(calls[0].method, 'remux/fs/readFile');
assert.deepEqual(calls[0].params, { format: 'base64', path: '/tmp/./report.html' });
assert.equal(calls[0].options.resourceKey, 'tab:17:html-preview:base64');

const large = Buffer.alloc(2_200_000, 0x61);
assert.equal((await readHtmlPreviewFile(async () => response('/large.html', large), {
  path: '/large.html', requestIdentity: 'large',
})).length, large.length);

const exact = Buffer.alloc(HTML_PREVIEW_MAX_BYTES, 0x62);
assert.equal((await readHtmlPreviewFile(async () => response('/exact.html', exact), {
  path: '/exact.html', requestIdentity: 'exact',
})).length, exact.length);

await assert.rejects(
  readHtmlPreviewFile(async () => ({ ...response('/over.html', Buffer.alloc(0)), sizeBytes: HTML_PREVIEW_MAX_BYTES + 1, tooLarge: true }), {
    path: '/over.html', requestIdentity: 'over',
  }),
  /larger than the 5 MiB/,
);
await assert.rejects(
  readHtmlPreviewFile(async () => ({ ...response('/bad.html', Buffer.alloc(1)), dataBase64: 'Zh==' }), {
    path: '/bad.html', requestIdentity: 'bad-base64',
  }),
  /malformed base64/,
);
await assert.rejects(
  readHtmlPreviewFile(async () => response('/bad-utf8.html', Uint8Array.from([0xc0, 0x80])), {
    path: '/bad-utf8.html', requestIdentity: 'bad-utf8',
  }),
  /not valid UTF-8/,
);
await assert.rejects(
  readHtmlPreviewFile(async () => ({ ...response('/binary.html', Buffer.from('text')), isBinary: true }), {
    path: '/binary.html', requestIdentity: 'binary',
  }),
  /contains binary data/,
);
await assert.rejects(
  readHtmlPreviewFile(async () => ({ ...response('/short.html', Buffer.from('abc')), sizeBytes: 4 }), {
    path: '/short.html', requestIdentity: 'short',
  }),
  /truncated/,
);

const controller = new HtmlPreviewLoadController({
  connectionGeneration: 1,
  path: '/a.html',
});
const original = { html: '<html>A</html>', links: [], linksTruncated: false };
const initial = controller.beginLoad();
assert.equal(controller.snapshot().status, 'loading');
assert.equal(controller.complete(initial, original), true);
assert.equal(controller.snapshot().status, 'ready');

const refresh = controller.beginLoad();
assert.equal(controller.snapshot().status, 'refreshing');
assert.equal(controller.fail(refresh, new Error('read failed')), true);
assert.equal(controller.snapshot().status, 'error');
assert.equal(controller.snapshot().document, original);
assert.equal(controller.snapshot().error, 'read failed');

const stalePath = controller.beginLoad();
controller.retarget({ connectionGeneration: 1, path: '/b.html' });
assert.equal(controller.complete(stalePath, original), false);
assert.equal(controller.snapshot().document, null);

const staleConnection = controller.beginLoad();
controller.retarget({ connectionGeneration: 2, path: '/b.html' });
assert.equal(controller.fail(staleConnection, 'old host'), false);
assert.equal(controller.snapshot().error, null);

const staleRefresh = controller.beginLoad();
const latestRefresh = controller.beginLoad();
assert.equal(controller.complete(staleRefresh, original), false);
assert.equal(controller.complete(latestRefresh, original), true);

controller.setMode('source');
assert.equal(controller.snapshot().mode, 'source');
controller.retire();
assert.equal(controller.snapshot().document, null);
assert.equal(controller.snapshot().status, 'idle');

let finishRead;
const retiredLoad = controller.load(
  () => new Promise((resolve) => { finishRead = resolve; }),
  'retired-tab',
  () => { throw new Error('Retired document must not be parsed'); },
);
controller.retire();
finishRead(response('/b.html', sample));
assert.equal(await retiredLoad, false);
assert.equal(controller.snapshot().error, null);

process.stdout.write(`${JSON.stringify({
  exactLimitBytes: HTML_PREVIEW_MAX_BYTES,
  failedRefreshRetainedDocument: true,
  largeFixtureBytes: large.length,
  ok: true,
  staleCompletionFencing: true,
  strictBase64AndUtf8: true,
})}\n`);
