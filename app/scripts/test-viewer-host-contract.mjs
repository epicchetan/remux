import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createWebViewHostLayoutScript,
  minimalHostControlInsetLeft,
  minimalHostControlSize,
} from '../src/surfaces/viewer/hostLayout.ts';

const script = createWebViewHostLayoutScript('minimal', minimalHostControlInsetLeft, {
  bottom: 34,
  left: 0,
  right: 0,
  top: 59,
});
for (const marker of [
  'data-remux-host-chrome',
  '--remux-host-control-inset-left',
  '--remux-safe-area-top',
  '--remux-safe-area-bottom',
  '"hostChrome":"minimal"',
  '"safeAreaBottom":34',
]) {
  assert.ok(script.includes(marker), `missing injected host-layout marker: ${marker}`);
}
assert.equal(minimalHostControlSize, 44);
assert.ok(minimalHostControlInsetLeft >= minimalHostControlSize);

const agentManifest = JSON.parse(
  await readFile(new URL('../../extensions/agent/remux-extension.json', import.meta.url), 'utf8'),
);
assert.equal(agentManifest.views.main.hostChrome, 'none');

const agentStyles = await readFile(
  new URL('../../extensions/agent/viewer/src/styles.css', import.meta.url),
  'utf8',
);
for (const marker of ['--remux-safe-area-top', '--remux-safe-area-bottom']) {
  assert.ok(agentStyles.includes(marker), `Agent does not consume native safe-area marker: ${marker}`);
}

const agentActions = await readFile(
  new URL('../../extensions/agent/viewer/src/composer/actions/ActionButtons.tsx', import.meta.url),
  'utf8',
);
assert.ok(agentActions.includes("openHostOverview({ section: 'tabs' })"));

const webViewSource = await readFile(
  new URL('../src/surfaces/viewer/ExtensionWebView.tsx', import.meta.url),
  'utf8',
);
for (const marker of [
  'accessibilityLabel="Open Remux tabs"',
  "hostChrome === 'minimal'",
  'safeAreaBottom',
  'safeAreaTop',
  "onOpenOverview?.('tabs')",
  "reloadLatestWebView('host-request')",
  'releaseInputFocus();',
  "checkWebViewHealth('tab-active')",
  "state !== 'active' || !activeRef.current",
]) {
  assert.ok(webViewSource.includes(marker), `missing native hosted-shell marker: ${marker}`);
}

for (const marker of [
  "message.method === 'host/file/download'",
  "message: 'Invalid file download params'",
  "onDownloadFile?.(params) ?? { ok: false, reason: 'unavailable' }",
]) {
  assert.ok(webViewSource.includes(marker), `missing host file download marker: ${marker}`);
}

// The Viewer's PDF renderer is an iframe onto the raw route; only a subframe
// may navigate there.
for (const marker of [
  "if (!isTopFrame && request.pathname === rawFileRoutePath) {",
  "const rawFileRoutePath = '/remux/fs/raw';",
]) {
  assert.ok(webViewSource.includes(marker), `missing raw-route subframe marker: ${marker}`);
}

const protectedTransportSource = await readFile(
  new URL('../src/surfaces/viewer/protectedViewerTransport.ts', import.meta.url),
  'utf8',
);
assert.ok(
  protectedTransportSource.includes('Object.freeze({ fileDownload: true, protectedHtmlPreviewTransport: true })'),
  'the native host must advertise the fileDownload capability',
);

const activeSurfaceSource = await readFile(
  new URL('../src/browser/ActiveSurface.tsx', import.meta.url),
  'utf8',
);
for (const marker of [
  'const interactive = selected && surfaceActive',
  'active={interactive}',
  'pointerEvents={interactive',
]) {
  assert.ok(activeSurfaceSource.includes(marker), `missing surface-activity boundary: ${marker}`);
}

const browserShellSource = await readFile(
  new URL('../src/browser/BrowserShell.tsx', import.meta.url),
  'utf8',
);
assert.ok(browserShellSource.includes("surfaceActive={mode === 'surface'}"));

const viewerSurfaceSource = await readFile(
  new URL('../src/surfaces/viewer/ViewerSurface.tsx', import.meta.url),
  'utf8',
);
for (const marker of [
  'await loadExtensions({ force: true })',
  'onReloadView={refreshViewerRevision}',
]) {
  assert.ok(viewerSurfaceSource.includes(marker), `missing revision-aware reload marker: ${marker}`);
}
assert.ok(
  viewerSurfaceSource.includes('onDownloadFile={downloadFile}'),
  'the Viewer surface must route host downloads to the share sheet',
);

process.stdout.write(
  `${JSON.stringify({
    ok: true, explicitSafeAreas: true, hostFileDownload: true, minimalHostChrome: true, rawRouteSubframe: true,
  })}\n`,
);
