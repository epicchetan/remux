import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  htmlPreviewModeForTarget,
  htmlPreviewPath,
} from '../src/surfaces/html-preview/htmlPreviewControllerHook.ts';
import { htmlPreviewAvailability } from '../src/surfaces/html-preview/htmlPreviewAvailability.ts';

assert.deepEqual(htmlPreviewAvailability('ios'), { enabled: true, reason: null });
assert.deepEqual(htmlPreviewAvailability('android'), { enabled: true, reason: null });
assert.equal(htmlPreviewAvailability('web').enabled, false);

const htmlTab = {
  extensionId: 'editor',
  resourceId: '/workspace/report.HTM',
  resourceKind: 'file',
  viewId: 'main',
};
assert.equal(htmlPreviewPath(htmlTab), '/workspace/report.HTM');
assert.equal(htmlPreviewPath({ ...htmlTab, extensionId: 'other' }), null);
assert.equal(htmlPreviewPath({ ...htmlTab, resourceId: '/workspace/report.html.txt' }), null);
assert.equal(htmlPreviewPath({ ...htmlTab, resourceKind: 'draft' }), null);

assert.equal(htmlPreviewModeForTarget({
  currentMode: 'source',
  focusKind: null,
  nextPath: '/workspace/report.html',
  previousPath: '/workspace/report.html',
}), 'source', 'same-file reopen preserves mode');
assert.equal(htmlPreviewModeForTarget({
  currentMode: 'source',
  focusKind: null,
  nextPath: '/workspace/next.html',
  previousPath: '/workspace/report.html',
}), 'preview', 'retarget defaults to Preview');
assert.equal(htmlPreviewModeForTarget({
  currentMode: 'preview',
  focusKind: 'line',
  nextPath: '/workspace/report.html',
  previousPath: '/workspace/report.html',
}), 'source', 'line focus selects Source');

const viewerSource = await readFile(new URL('../src/surfaces/viewer/ViewerSurface.tsx', import.meta.url), 'utf8');
assert.match(viewerSource, /state\.path !== path \|\| state\.connectionGeneration !== connectionGeneration/u, 'HTML wrapper must gate stale documents');
assert.match(viewerSource, /function HtmlFileSurface/u, 'HTML controller hooks stay in the HTML-only wrapper');
assert.match(viewerSource, /pendingLineNonce/u, 'line navigation mode changes are keyed by nonce');
assert.match(viewerSource, /SafeAreaInsetsContext\.Provider value=\{\{ \.\.\.safeAreaInsets, top: 0 \}\}/u, 'nested Source rebases its top safe area');
assert.match(viewerSource, /pendingNavigation=\{tab\.pendingNavigation\}/u, 'Source must receive pending line navigation');
assert.match(viewerSource, /onNavigationDelivered=\{\(nonce\) => clearPendingNavigation/u, 'Source must own navigation acknowledgement');

const previewSource = await readFile(new URL('../src/surfaces/html-preview/HtmlFilePreview.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(previewSource, /onMessage=/u, 'trusted controls must not add a document bridge');
assert.match(previewSource, /hostFileHrefInfoFromHref/u, 'companion files use shared path rules');

process.stdout.write(`${JSON.stringify({ ok: true, p2Integration: true })}\n`);
