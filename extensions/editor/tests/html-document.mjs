import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { parse } from 'parse5';

import {
  HTML_PREVIEW_CONTENT_SECURITY_POLICY,
  HTML_PREVIEW_LINK_LIMIT,
  prepareHtmlPreviewDocument,
} from '../../../packages/viewer-kit/src/htmlPreview.ts';

const HTML_PREVIEW_DOCUMENT_URL = 'https://preview-test.invalid/document';

function elements(node, tagName, output = []) {
  if (node?.tagName === tagName) output.push(node);
  for (const child of node?.childNodes ?? []) elements(child, tagName, output);
  return output;
}

const fixture = await readFile(new URL('./fixtures/interactive-hostile.html', import.meta.url), 'utf8');
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
  nativeDeviceIsolationVerified: false,
})}\n`);
