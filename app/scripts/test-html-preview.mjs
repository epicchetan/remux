import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { parse } from 'parse5';

import {
  HTML_PREVIEW_CONTENT_SECURITY_POLICY,
  HTML_PREVIEW_DOCUMENT_URL,
  HTML_PREVIEW_LINK_LIMIT,
  prepareHtmlPreviewDocument,
} from '../src/surfaces/html-preview/prepareHtmlPreviewDocument.ts';
import { classifyHtmlPreviewNavigation } from '../src/surfaces/html-preview/htmlPreviewNavigation.ts';

function elements(node, tagName, output = []) {
  if (node?.tagName === tagName) output.push(node);
  for (const child of node?.childNodes ?? []) elements(child, tagName, output);
  return output;
}

const fixture = await readFile(new URL('../src/surfaces/html-preview/__fixtures__/interactive-hostile.html', import.meta.url), 'utf8');
const prepared = prepareHtmlPreviewDocument(fixture);
const parsed = parse(prepared.html);
const heads = elements(parsed, 'head');
assert.equal(heads.length, 1);
assert.equal(heads[0].childNodes[0].tagName, 'meta');
assert.equal(heads[0].childNodes[0].attrs.find(({ name }) => name === 'content')?.value, HTML_PREVIEW_CONTENT_SECURITY_POLICY);
assert.equal(elements(parsed, 'base').length, 0);
assert.equal(elements(parsed, 'meta').filter((node) => node.attrs.some(({ name, value }) => name === 'http-equiv' && value.toLowerCase() === 'refresh')).length, 0);
assert.match(prepared.html, /document\.querySelector\('#slider'\)/u, 'inline script text changed');
assert.match(prepared.html, /#reveal \{ opacity: var\(--reveal, 0\); \}/u, 'inline style text changed');
assert.deepEqual(prepared.links, [
  { href: '../data/results.csv', label: 'Results CSV' },
  { href: 'https://example.com/findings', label: 'Findings' },
]);
assert.equal(elements(parsed, 'a').find((node) => node.attrs.some(({ name, value }) => name === 'id' && value === 'script-link')).attrs.some(({ name }) => name === 'href'), false);

for (const source of [
  '<script>globalThis.headlessWorked = true</script><h1>Headless</h1>',
  '<table><td>malformed<script>globalThis.malformedWorked = true</script>',
  '<!doctype html><html><head><style>.x{color:red}</style></head><body>full</body></html>',
]) {
  const result = prepareHtmlPreviewDocument(source);
  assert.match(result.html, /Content-Security-Policy/u);
  assert.match(result.html, /<html/u);
}

const manyLinks = prepareHtmlPreviewDocument(Array.from({ length: HTML_PREVIEW_LINK_LIMIT + 5 }, (_, index) => `<a href="file-${index}.json">${index}</a>`).join(''));
assert.equal(manyLinks.links.length, HTML_PREVIEW_LINK_LIMIT);
assert.equal(manyLinks.linksTruncated, true);

assert.equal(classifyHtmlPreviewNavigation(HTML_PREVIEW_DOCUMENT_URL), 'allow-document');
assert.equal(classifyHtmlPreviewNavigation(`${HTML_PREVIEW_DOCUMENT_URL}#details`), 'allow-fragment');
for (const url of ['https://example.com/', 'file:///etc/passwd', 'data:text/html,test', 'javascript:alert(1)', 'https://html-preview.invalid/other']) {
  assert.equal(classifyHtmlPreviewNavigation(url), 'block');
}

const rendererSource = await readFile(new URL('../src/surfaces/html-preview/HtmlPreviewRenderer.tsx', import.meta.url), 'utf8');
for (const forbidden of ['onMessage=', 'injectedJavaScript=', 'injectedJavaScriptBeforeContentLoaded=', 'headers:', 'incognito']) {
  assert.equal(rendererSource.includes(forbidden), false, `renderer must omit ${forbidden}`);
}
for (const required of ['sharedCookiesEnabled={false}', 'thirdPartyCookiesEnabled={false}', 'allowFileAccess={false}', 'setSupportMultipleWindows={false}', 'javaScriptCanOpenWindowsAutomatically={false}']) {
  assert.ok(rendererSource.includes(required), `renderer is missing ${required}`);
}

const androidSource = await readFile(new URL('../../node_modules/react-native-webview/src/WebView.android.tsx', import.meta.url), 'utf8');
const iosSource = await readFile(new URL('../../node_modules/react-native-webview/src/WebView.ios.tsx', import.meta.url), 'utf8');
assert.match(androidSource, /messagingEnabled=\{typeof onMessageProp === 'function'\}/u);
assert.match(iosSource, /messagingEnabled=\{typeof onMessageProp === 'function'\}/u);
assert.match(rendererSource, /originWhitelist=\{\['\*'\]\}/u, 'native callback must decide navigation before React Native WebView opens an external URL');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const prohibitedRequests = [];
  await page.route('**/*', async (route) => {
    if (route.request().url() === HTML_PREVIEW_DOCUMENT_URL) {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: prepared.html });
    } else {
      prohibitedRequests.push(route.request().url());
      await route.abort();
    }
  });
  await page.goto(HTML_PREVIEW_DOCUMENT_URL);
  await page.locator('#slider').fill('75');
  assert.equal(await page.locator('#reveal').evaluate((element) => getComputedStyle(element).opacity), '0.75');
  await page.locator('#local-link').click();
  assert.equal(new URL(page.url()).hash, '#details');
  assert.equal(await page.locator('body').getAttribute('data-bridge'), 'undefined');
  await page.waitForTimeout(100);
  assert.deepEqual(prohibitedRequests, [], `CSP allowed prohibited requests: ${prohibitedRequests.join(', ')}`);

  await page.setContent(prepareHtmlPreviewDocument('<script>globalThis.headlessWorked = true</script><h1>Headless</h1>').html);
  assert.equal(await page.evaluate(() => globalThis.headlessWorked), true);
  await page.setContent(prepareHtmlPreviewDocument('<table><td>malformed<script>globalThis.malformedWorked = true</script>').html);
  assert.equal(await page.evaluate(() => globalThis.malformedWorked), true);
} finally {
  await browser.close();
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  browserBehavior: true,
  bridgeFreeRendererContract: true,
  nativeDeviceIsolationVerified: false,
})}\n`);
