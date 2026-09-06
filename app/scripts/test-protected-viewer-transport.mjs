import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

import {
  PROTECTED_VIEWER_PAYLOAD_MAX_CHARS,
  createProtectedViewerBootstrapScript,
  createProtectedViewerToken,
  isProtectedViewerBlobNavigation,
  unwrapProtectedViewerMessage,
} from '../src/surfaces/viewer/protectedViewerTransport.ts';
import { isTrustedHostMessageEvent } from '../../packages/viewer-kit/src/ipcSenderPolicy.ts';

globalThis.expo = { uuidv4: () => crypto.randomUUID() };
const firstToken = createProtectedViewerToken();
const secondToken = createProtectedViewerToken();
assert.match(firstToken, /^[0-9a-f]{64}$/u);
assert.notEqual(firstToken, secondToken);
assert.equal(isProtectedViewerBlobNavigation('blob:https://viewer.test/123', 'https://viewer.test/editor'), true);
assert.equal(isProtectedViewerBlobNavigation('blob:null/123', 'https://viewer.test/editor'), false);
assert.equal(isProtectedViewerBlobNavigation('blob:https://other.test/123', 'https://viewer.test/editor'), false);

const payload = JSON.stringify({ id: 'request:1', method: 'host/file/open', type: 'remux/request' });
const envelope = JSON.stringify({ payload, token: firstToken, type: 'remux/protected-viewer-v1' });
assert.equal(unwrapProtectedViewerMessage(envelope, firstToken), payload);
assert.equal(unwrapProtectedViewerMessage(payload, firstToken), null, 'raw native calls must be rejected');
assert.equal(unwrapProtectedViewerMessage(envelope, secondToken), null, 'stale document token must be rejected');
assert.equal(unwrapProtectedViewerMessage(JSON.stringify({
  payload: 'x'.repeat(PROTECTED_VIEWER_PAYLOAD_MAX_CHARS + 1),
  token: firstToken,
  type: 'remux/protected-viewer-v1',
}), firstToken), null);

const parentWindow = {};
const childWindow = {};
globalThis.window = { parent: parentWindow };
assert.equal(isTrustedHostMessageEvent({ source: null }), true, 'native messages have no DOM sender');
assert.equal(isTrustedHostMessageEvent({ source: parentWindow }), true, 'browser host parent is trusted');
assert.equal(isTrustedHostMessageEvent({ source: childWindow }), false, 'child postMessage must be rejected');
globalThis.window = undefined;

const androidNativeSource = await readFile(
  new URL('../../node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebView.java', import.meta.url),
  'utf8',
);
assert.match(androidNativeSource, /boolean isMainFrame/u, 'installed Android listener reports frame metadata');
assert.match(androidNativeSource, /onMessage\(message\.getData\(\), sourceOrigin\.toString\(\)\)/u, 'installed Android wrapper discards frame metadata');
assert.match(androidNativeSource, /addJavascriptInterface\(fallbackBridge, JAVASCRIPT_INTERFACE\)/u, 'installed Android fallback exposes the raw child bridge');

const appleNativeSource = await readFile(
  new URL('../../node_modules/react-native-webview/apple/RNCWebViewImpl.m', import.meta.url),
  'utf8',
);
assert.match(appleNativeSource, /forMainFrameOnly:_injectedJavaScriptBeforeContentLoadedForMainFrameOnly/u);
assert.match(appleNativeSource, /forMainFrameOnly:YES/u, 'installed Apple messaging shim is top-frame-only');

const extensionHostSource = await readFile(
  new URL('../src/surfaces/viewer/ExtensionWebView.tsx', import.meta.url),
  'utf8',
);
for (const marker of [
  "tab.extensionId === 'editor'",
  'unwrapProtectedViewerMessage(rawMessage, protectedTransportToken)',
  'injectedJavaScriptBeforeContentLoadedForMainFrameOnly',
  'injectedJavaScriptForMainFrameOnly: true',
]) {
  assert.ok(extensionHostSource.includes(marker), `native host is missing protected transport marker: ${marker}`);
}
const editorMainSource = await readFile(
  new URL('../../extensions/editor/viewer/src/main.tsx', import.meta.url),
  'utf8',
);
assert.match(editorMainSource, /initializeIpc\(\{ requireProtectedTransport: true \}\)/u);
const ipcSource = await readFile(
  new URL('../../packages/viewer-kit/src/ipc.ts', import.meta.url),
  'utf8',
);
assert.match(ipcSource, /legacyTransportEstablished/u, 'older hosts must retain Source and Markdown IPC');
assert.match(ipcSource, /remux:host-capabilities-ready/u, 'protected queue must flush from wrapper readiness');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__nativeMessages = [];
    window.ReactNativeWebView = {
      postMessage(message) { window.__nativeMessages.push(message); },
    };
  });
  await page.goto('data:text/html,<iframe srcdoc="child"></iframe>');
  await page.evaluate(createProtectedViewerBootstrapScript(firstToken, 'https://viewer.test/trusted'));
  assert.equal(await page.evaluate(() => window.__REMUX_HOST_CAPABILITIES__), undefined, 'unexpected top documents never acquire the capability');
  await page.evaluate(createProtectedViewerBootstrapScript(firstToken));
  const topResult = await page.evaluate((innerPayload) => {
    window.__REMUX_PROTECTED_POST_MESSAGE__(innerPayload);
    return {
      capabilities: window.__REMUX_HOST_CAPABILITIES__,
      messages: window.__nativeMessages,
      wrapperSource: String(window.__REMUX_PROTECTED_POST_MESSAGE__),
    };
  }, payload);
  assert.equal(topResult.capabilities.protectedHtmlPreviewTransport, true);
  assert.equal(topResult.messages.length, 1);
  assert.equal(unwrapProtectedViewerMessage(topResult.messages[0], firstToken), payload);
  assert.equal(topResult.wrapperSource.includes(firstToken), false, 'capability token stays in the closure');

  const child = page.frames().find((frame) => frame !== page.mainFrame());
  assert.ok(child);
  const childResult = await child.evaluate((innerPayload) => {
    window.ReactNativeWebView.postMessage(innerPayload);
    return {
      capabilities: window.__REMUX_HOST_CAPABILITIES__,
      messages: window.__nativeMessages,
    };
  }, payload);
  assert.equal(childResult.capabilities, undefined);
  assert.equal(childResult.messages.length, 1);
  assert.equal(unwrapProtectedViewerMessage(childResult.messages[0], firstToken), null);

  const delayedPage = await browser.newPage();
  await delayedPage.goto('data:text/html,delayed');
  await delayedPage.evaluate(createProtectedViewerBootstrapScript(secondToken));
  await delayedPage.waitForTimeout(30);
  await delayedPage.evaluate(() => {
    window.__nativeMessages = [];
    window.ReactNativeWebView = {
      postMessage(message) { window.__nativeMessages.push(message); },
    };
  });
  await delayedPage.waitForFunction(() => window.__REMUX_HOST_CAPABILITIES__?.protectedHtmlPreviewTransport === true);
  const delayedEnvelope = await delayedPage.evaluate((innerPayload) => {
    window.__REMUX_PROTECTED_POST_MESSAGE__(innerPayload);
    return window.__nativeMessages[0];
  }, payload);
  assert.equal(unwrapProtectedViewerMessage(delayedEnvelope, secondToken), payload);
} finally {
  await browser.close();
}

process.stdout.write(`${JSON.stringify({
  boundedEnvelope: true,
  childRawNativeRejected: true,
  mainFrameClosure: true,
  ok: true,
  staleTokenRejected: true,
})}\n`);
