import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { build, createServer, preview } from 'vite';
import { createProtectedViewerBootstrapScript } from '../../../app/src/surfaces/viewer/protectedViewerTransport.ts';

const configFile = new URL('../viewer/vite.config.ts', import.meta.url).pathname;
// Serve production assets (including lazy chunks); a separate dev server exposes
// the existing shared Mermaid helper contract for its direct API assertions.
await build({ configFile, logLevel: 'silent' });
const helperServer = await createServer({ configFile, server: { host: '127.0.0.1', port: 0 } });
await helperServer.listen();
const rawFixtures = Object.fromEntries(await Promise.all([
  ['pixel.png', 'image/png'], ['pixel.svg', 'image/svg+xml'], ['minimal.pdf', 'application/pdf'],
  ['tiny.webm', 'video/webm'], ['random.bin', 'application/octet-stream'],
].map(async ([name, mimeType]) => [`/${name}`, { mimeType, bytes: await readFile(new URL(`./fixtures/${name}`, import.meta.url)) }])));
const rawRequests = [];
let failNextImage = false;
const server = await preview({
  configFile,
  preview: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'raw-file-fixtures', configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url, 'http://fixture.test');
      if (url.pathname !== '/remux/fs/raw') return next();
      const path = url.searchParams.get('path');
      rawRequests.push({ path, version: url.searchParams.get('v') });
      const fixture = rawFixtures[path];
      response.setHeader('Content-Security-Policy', 'sandbox');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'private, no-cache');
      if (!fixture || (path === '/pixel.png' && failNextImage)) {
        failNextImage = false;
        response.statusCode = 404;
        return response.end('not found');
      }
      response.setHeader('Content-Type', fixture.mimeType);
      response.setHeader('Content-Length', fixture.bytes.length);
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Content-Disposition', fixture.mimeType === 'image/svg+xml' || fixture.mimeType === 'application/octet-stream' ? 'attachment' : 'inline');
      response.end(fixture.bytes);
    });
  } }],
});
const browser = await chromium.launch();
const baseUrl = server.resolvedUrls.local[0];
const token = 'b'.repeat(64);
const mermaidModuleUrl = new URL(`/@fs${new URL('../../../packages/viewer-kit/src/mermaid.ts', import.meta.url).pathname}`, helperServer.resolvedUrls.local[0]).href;
const fixtureDescriptors = Object.fromEntries(Object.entries(rawFixtures).map(([path, fixture]) => [path, {
  path, name: path.slice(1), kind: 'file', targetKind: null, mimeType: fixture.mimeType,
  isBinary: fixture.mimeType !== 'image/svg+xml', sizeBytes: fixture.bytes.length, modifiedAtMs: 100, version: 'fixture-v1',
}]));

function viewerUrl(path, line = null) {
  const url = new URL(baseUrl);
  url.searchParams.set('remuxResourceKind', 'file');
  url.searchParams.set('remuxResourceId', path);
  url.searchParams.set('remuxTabId', `tab:${path}`);
  if (line !== null) {
    url.searchParams.set('remuxFocusKind', 'line');
    url.searchParams.set('remuxFocusId', String(line));
  }
  return url.href;
}

async function openViewer(path, line = null, pageOptions = {}, fileDownload = false) {
  const page = await browser.newPage(pageOptions);
  await page.addInitScript(({ token, fixtureDescriptors }) => {
    if (window.top !== window) return;
    const fixtures = {
      '/doc.md': `# Heading

| Name | Value |
| --- | ---: |
| GFM | 42 |

- [x] shipped
- [ ] follow-up

Footnote reference.[^proof]

[^proof]: Footnote detail.

Inline math $E=mc^2$.

\`\`\`mermaid
graph TD
  A[Start] --> B[Done]
\`\`\`

[Local document](./next.md#L7)

![Local pixel](./assets/pixel.svg)

<script id="unsafe-script">window.__unsafeMarkdown = true</script>
<button id="unsafe-button" onclick="window.__unsafeMarkdown = true">Unsafe handler</button>
`,
      '/doc.html': '<!doctype html><button id="increment">Increment</button><output id="value">0</output><script>let value=0;document.querySelector("#increment").onclick=()=>document.querySelector("#value").textContent=String(++value)<\/script>',
      '/lines.txt': Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n'),
      '/scroll.md': `# Scroll regression\n\n${Array.from({ length: 180 }, (_, index) => `Paragraph ${index + 1}: enough text to occupy a visible line in the preview.`).join('\n\n')}\n\n## Bottom marker\n`,
    };
    window.__testHost = {
      copied: null,
      failNextRead: false,
      version: 'fixture-v1',
      downloadReason: null,
      fixtures,
      requests: [],
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText(text) { window.__testHost.copied = text; return Promise.resolve(); } },
    });
    const dispatch = message => window.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify(message),
    }));
    const reply = (id, result) => setTimeout(() => dispatch({ id, result, type: 'remux/response' }), 0);
    const fail = (id, message) => setTimeout(() => dispatch({
      error: { code: -32011, message }, id, type: 'remux/error',
    }), 0);
    const fileResult = (path, content) => {
      const bytes = new TextEncoder().encode(content);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        content: null,
        dataBase64: btoa(binary),
        encoding: 'base64',
        isBinary: false,
        modifiedAtMs: 100,
        name: path.split('/').at(-1),
        path,
        sizeBytes: bytes.length,
        tooLarge: false,
      };
    };
    window.ReactNativeWebView = { postMessage(raw) {
      const envelope = JSON.parse(raw);
      if (envelope.token !== token || typeof envelope.payload !== 'string') return;
      const message = JSON.parse(envelope.payload);
      if (message.type === 'remux/ready') {
        setTimeout(() => {
          dispatch({ error: null, status: { type: 'connected' }, type: 'remux/status' });
          dispatch({ message: { method: 'host/connection', params: { generation: 1, status: 'connected' } }, type: 'remux/event' });
          dispatch({ message: { method: 'host/active', params: { active: true } }, type: 'remux/event' });
        }, 0);
        return;
      }
      if (message.type === 'remux/cancel' || message.type === 'remux/notify') return;
      if (message.type !== 'remux/request') return;
      window.__testHost.requests.push({ method: message.method, params: message.params });
      if (message.method === 'remux/fs/stat') {
        const path = message.params.path;
        reply(message.id, { ...(fixtureDescriptors[path] ?? {
          path, name: path.split('/').at(-1), kind: 'file', targetKind: null,
          mimeType: 'text/plain', isBinary: false, sizeBytes: fixtures[path]?.length ?? 10, modifiedAtMs: 100,
        }), version: window.__testHost.version });
      } else if (message.method === 'host/file/download') {
        reply(message.id, window.__testHost.downloadReason ? { ok: false, reason: window.__testHost.downloadReason } : { ok: true });
      } else if (message.method === 'remux/fs/readFile') {
        if (window.__testHost.failNextRead) {
          window.__testHost.failNextRead = false;
          fail(message.id, 'fixture refresh failed');
        } else if (message.params.path === '/large.txt') {
          reply(message.id, {
            content: null, encoding: null, isBinary: false, modifiedAtMs: 100,
            name: 'large.txt', path: '/large.txt', sizeBytes: 6 * 1024 * 1024, tooLarge: true,
          });
        } else if (message.params.path === '/assets/pixel.svg') {
          reply(message.id, {
            content: null, dataBase64: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iNDAiPjxyZWN0IHdpZHRoPSIxMjAiIGhlaWdodD0iNDAiIHJ4PSI2IiBmaWxsPSIjMjJjNTVlIi8+PHRleHQgeD0iNjAiIHk9IjI1IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjMDUyZTE2IiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMTQiPkxvY2FsIGltYWdlPC90ZXh0Pjwvc3ZnPg==',
            encoding: 'base64', isBinary: true, mimeType: 'image/svg+xml', modifiedAtMs: 100,
            name: 'pixel.svg', path: '/assets/pixel.svg', sizeBytes: 232, tooLarge: false,
          });
        } else if (message.params.path === '/long.txt') {
          reply(message.id, fileResult('/long.txt', 'x'.repeat(5 * 1024 * 1024)));
        } else if (message.params.path === '/large.md') {
          reply(message.id, fileResult('/large.md', `# Large\n\n${'x'.repeat(512_001)}`));
        } else {
          reply(message.id, fileResult(message.params.path, fixtures[message.params.path]));
        }
      } else if (message.method === 'remux/fs/readFileWindow') {
        reply(message.id, {
          content: 'window page\n', continuation: { endsMidLine: false, startsMidLine: false },
          encoding: 'utf8', eof: false, nextOffset: 12, path: '/large.txt', previousOffset: null,
          range: { endByte: 12, startByte: 0 }, targetLine: null,
          totalSizeBytes: 6 * 1024 * 1024, version: 'file-v1:test',
        });
      } else if (message.method === 'remux/fs/readFileGit') {
        reply(message.id, { base: null, repoRoot: null, status: null });
      } else {
        reply(message.id, { ok: true });
      }
    } };
  }, { token, fixtureDescriptors });
  await page.addInitScript({ content: createProtectedViewerBootstrapScript(token).replace('fileDownload: true, ', fileDownload ? 'fileDownload: true, ' : '') });
  page.on('pageerror', error => { throw error; });
  await page.goto(viewerUrl(path, line));
  return page;
}

function readCount(page, path = null) {
  return page.evaluate(path => window.__testHost.requests.filter(request =>
    request.method === 'remux/fs/readFile' && (path === null || request.params.path === path)).length, path);
}

async function assertOpenTraffic(page, path, expectedReads) {
  const requests = await page.evaluate(path => window.__testHost.requests.filter(request => request.params?.path === path), path);
  assert.equal(requests.filter(request => request.method === 'remux/fs/stat').length, 1, `${path}: one stat`);
  assert.equal(requests.filter(request => request.method === 'remux/fs/readFile').length, expectedReads, `${path}: expected reads`);
  assert.equal(requests[0].method, 'remux/fs/stat', `${path}: stat first`);
}

async function checkSharedMermaidRenderer(page) {
  return page.evaluate(async ({ mermaidModuleUrl }) => {
    const { renderMermaid } = await import(mermaidModuleUrl);
    const sharedSource = 'graph TD\n  shared_start --> shared_end';
    const first = renderMermaid(sharedSource, { theme: 'light' });
    const second = renderMermaid(sharedSource, { theme: 'light' });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    if (firstResult !== secondResult) throw new Error('in-flight Mermaid renders were not deduplicated');
    if (await renderMermaid(sharedSource, { theme: 'light' }) !== firstResult) {
      throw new Error('successful Mermaid render was not reused from cache');
    }
    if (!(firstResult.width > 0 && firstResult.height > 0) || !firstResult.svg.startsWith('<svg')) {
      throw new Error('Mermaid result did not contain a standalone sized SVG');
    }

    const abortController = new AbortController();
    const abortSource = 'graph TD\n  abort_start --> abort_end';
    const aborted = renderMermaid(abortSource, { signal: abortController.signal, theme: 'light' });
    const survivor = renderMermaid(abortSource, { theme: 'light' });
    abortController.abort();
    const abortedOutcome = await aborted.then(() => 'resolved', error => error?.name);
    if (abortedOutcome !== 'AbortError') throw new Error(`aborted subscriber ${abortedOutcome}`);
    const survivorResult = await survivor;
    if (!(survivorResult.width > 0 && survivorResult.height > 0)) {
      throw new Error('shared render did not survive another subscriber aborting');
    }

    const invalidSource = 'this is not a mermaid diagram';
    const invalidError = await renderMermaid(invalidSource, { theme: 'light' }).catch(error => error);
    const cachedInvalidError = await renderMermaid(invalidSource, { theme: 'light' }).catch(error => error);
    if (!(invalidError instanceof Error) || cachedInvalidError !== invalidError) {
      throw new Error('failed Mermaid render was not reused from cache');
    }

    const rejectedInputs = [
      '%%{init: {"securityLevel": "loose"}}%%\ngraph TD\n  A --> B',
      '---\nconfig:\n  securityLevel: loose\n---\ngraph TD\n  A --> B',
      `graph TD\n  A[${'x'.repeat(20_001)}]`,
    ];
    for (const source of rejectedInputs) {
      const outcome = await renderMermaid(source, { theme: 'light' }).then(() => null, error => error);
      if (!(outcome instanceof Error)) throw new Error('unsafe or oversized Mermaid input was accepted');
    }

    const [light, dark] = await Promise.all([
      renderMermaid('graph TD\n  light_a --> light_b', { theme: 'light' }),
      renderMermaid('graph TD\n  dark_a --> dark_b', { theme: 'dark' }),
    ]);
    if (light.svg === dark.svg || !light.svg.includes('light_a') || !dark.svg.includes('dark_a')) {
      throw new Error('serialized themed Mermaid renders crossed results');
    }
    return {
      abortIsolation: true,
      cacheReuse: true,
      configAndSizeRejection: true,
      failureCacheReuse: true,
      themeSerialization: true,
    };
  }, { mermaidModuleUrl });
}

try {
  const markdown = await openViewer('/doc.md');
  await markdown.getByRole('heading', { name: 'Heading' }).waitFor();
  assert.equal(await markdown.locator('table').getByText('42').count(), 1);
  assert.equal(await markdown.locator('input[type="checkbox"]:checked').count(), 1);
  assert.equal(await markdown.getByText('Footnote detail.').count(), 1);
  assert.equal(await markdown.locator('.katex').count() > 0, true);
  const mermaidImage = markdown.locator('.remux-viewer-markdown-mermaid-diagram img');
  await mermaidImage.waitFor();
  await mermaidImage.evaluate(image => {
    if (!(image instanceof HTMLImageElement) || !image.src.startsWith('blob:') || !image.complete || image.naturalWidth <= 0) {
      throw new Error('Mermaid Blob image did not decode');
    }
  });
  const mermaidHelper = await checkSharedMermaidRenderer(markdown);
  assert.equal(await markdown.locator('#unsafe-script').count(), 0);
  assert.equal(await markdown.locator('[onclick]').count(), 0);
  assert.equal(await markdown.evaluate(() => window.__unsafeMarkdown), undefined);
  await markdown.getByRole('link', { name: 'Local document' }).click();
  await markdown.waitForFunction(() => window.__testHost.requests.some(request =>
    request.method === 'host/file/open' && request.params.path === '/next.md' && request.params.line === 7));
  await markdown.getByRole('img', { name: 'Local pixel' }).waitFor();
  await markdown.getByRole('img', { name: 'Local pixel' }).evaluate(image => {
    if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth !== 120) {
      throw new Error('local Markdown image did not decode');
    }
  });
  assert.equal(await markdown.evaluate(() => window.__testHost.requests.some(request =>
    request.method === 'remux/fs/readFile' && request.params.path === '/assets/pixel.svg' && request.params.format === 'base64')), true);
  for (const colorScheme of ['light', 'dark']) {
    await markdown.emulateMedia({ colorScheme });
    assert.equal(await markdown.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth), true,
      `${colorScheme} desktop Markdown must not overflow the body`);
  }
  await markdown.setViewportSize({ width: 390, height: 844 });
  assert.equal(await markdown.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth), true,
    'phone Markdown must not overflow the body');
  const screenshotDir = join(tmpdir(), 'remux-html-preview');
  await mkdir(screenshotDir, { recursive: true });
  await markdown.screenshot({ fullPage: true, path: join(screenshotDir, 'unified-markdown-phone.png') });
  const footnoteLink = markdown.locator('a[href="#user-content-fn-proof"]');
  await footnoteLink.click();
  assert.equal(await markdown.evaluate(() => Boolean(document.getElementById(decodeURIComponent(location.hash.slice(1))))), true,
    'footnote navigation must resolve the sanitized destination ID');
  const leftLabels = await markdown.locator('.remux-extension-action-group').first().getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  assert.deepEqual(leftLabels.slice(0, 4), ['Open tabs', 'Reload file', 'Show source', 'Copy file contents']);
  const markdownEye = markdown.getByRole('button', { name: 'Show source' });
  assert.equal(await markdownEye.getAttribute('aria-pressed'), 'true');
  await assertOpenTraffic(markdown, '/doc.md', 1);
  await markdownEye.click();
  await markdown.locator('.cm-content').waitFor();
  assert.equal(await readCount(markdown, '/doc.md'), 1, 'Preview/Source toggle must not reread');
  const sourceEye = markdown.getByRole('button', { name: 'Show preview' });
  assert.equal(await sourceEye.getAttribute('aria-pressed'), 'false');
  await markdown.getByRole('button', { name: 'Copy file contents' }).click();
  await markdown.waitForFunction(() => window.__testHost.copied !== null);
  assert.equal(await markdown.evaluate(() => window.__testHost.copied === window.__testHost.fixtures['/doc.md']), true);
  await markdown.close();

  const scrolling = await openViewer('/scroll.md');
  const markdownScroller = scrolling.locator('.remux-viewer-markdown');
  await scrolling.getByRole('heading', { name: 'Bottom marker' }).waitFor({ state: 'attached' });
  const desktopMetrics = await markdownScroller.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert.ok(desktopMetrics.clientHeight < desktopMetrics.scrollHeight,
    `Markdown scroller must be bounded (${desktopMetrics.clientHeight} < ${desktopMetrics.scrollHeight})`);
  const toolbarTop = await scrolling.locator('.remux-extension-action-bar').evaluate(element => element.getBoundingClientRect().top);
  assert.ok(toolbarTop >= 0 && toolbarTop < (await scrolling.evaluate(() => innerHeight)), 'toolbar must be inside the viewport');
  await markdownScroller.hover();
  await scrolling.mouse.wheel(0, 1600);
  await scrolling.waitForFunction(() => document.querySelector('.remux-viewer-markdown')?.scrollTop > 0);
  const retainedScrollTop = await markdownScroller.evaluate(element => element.scrollTop);
  assert.equal(await scrolling.locator('.remux-extension-action-bar').evaluate(element => element.getBoundingClientRect().top), toolbarTop,
    'toolbar must remain fixed while Markdown scrolls');
  await scrolling.getByRole('button', { name: 'Show source' }).click();
  await scrolling.getByRole('button', { name: 'Show preview' }).click();
  assert.equal(await readCount(scrolling, '/scroll.md'), 1, 'scroll mode toggles must not reread Markdown');
  assert.equal(await markdownScroller.evaluate(element => element.scrollTop), retainedScrollTop,
    'Markdown scroll position must survive Source/Preview toggles');
  await markdownScroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  assert.equal(await scrolling.evaluate(() => {
    const scroller = document.querySelector('.remux-viewer-markdown').getBoundingClientRect();
    const marker = document.querySelector('#bottom-marker').getBoundingClientRect();
    return marker.top >= scroller.top && marker.bottom <= scroller.bottom;
  }), true, 'bottom marker must be inside the desktop scroller viewport');
  await scrolling.close();

  const touchScrolling = await openViewer('/scroll.md', null, {
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const touchScroller = touchScrolling.locator('.remux-viewer-markdown');
  await touchScrolling.getByRole('heading', { name: 'Bottom marker' }).waitFor({ state: 'attached' });
  const cdp = await touchScrolling.context().newCDPSession(touchScrolling);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 190, y: 700 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 190, y: 180 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touchScrolling.waitForFunction(() => document.querySelector('.remux-viewer-markdown')?.scrollTop > 0);
  await touchScroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  assert.equal(await touchScrolling.evaluate(() => {
    const scroller = document.querySelector('.remux-viewer-markdown').getBoundingClientRect();
    const marker = document.querySelector('#bottom-marker').getBoundingClientRect();
    return marker.top >= scroller.top && marker.bottom <= scroller.bottom;
  }), true, 'bottom marker must be inside the touch scroller viewport');
  await touchScrolling.close();

  const html = await openViewer('/doc.html');
  const frame = html.frameLocator('iframe[title="Interactive HTML document"]');
  await frame.locator('#increment').click();
  await assertOpenTraffic(html, '/doc.html', 1);
  assert.equal(await frame.locator('#value').textContent(), '1');
  await html.getByRole('button', { name: 'Show source' }).click();
  await html.getByRole('button', { name: 'Show preview' }).click();
  assert.equal(await readCount(html), 1);
  assert.equal(await frame.locator('#value').textContent(), '1', 'HTML state must survive ordinary toggles');
  await html.getByRole('button', { name: 'Reload file' }).click();
  await html.waitForFunction(() => window.__testHost.requests.filter(request => request.method === 'remux/fs/readFile').length === 2);
  await html.frameLocator('iframe[title="Interactive HTML document"]').locator('#value').filter({ hasText: '0' }).waitFor();
  assert.equal(await html.frameLocator('iframe[title="Interactive HTML document"]').locator('#value').textContent(), '0', 'successful same-byte reload must reset HTML');
  await html.frameLocator('iframe[title="Interactive HTML document"]').locator('#increment').click();
  await html.evaluate(() => { window.__testHost.failNextRead = true; });
  await html.getByRole('button', { name: 'Reload file' }).click();
  await html.getByText('fixture refresh failed').waitFor();
  assert.equal(await html.frameLocator('iframe[title="Interactive HTML document"]').locator('#value').textContent(), '1', 'failed reload must retain the prior renderer');
  await html.close();

  const focused = await openViewer('/lines.txt', 50);
  await focused.getByRole('button', { name: 'Open tabs' }).waitFor();
  assert.equal(await focused.getByRole('button', { name: 'Show preview' }).count(), 0);
  await focused.locator('.cm-line').filter({ hasText: /^line 50$/ }).waitFor({ state: 'visible' });
  await assertOpenTraffic(focused, '/lines.txt', 1);
  await focused.close();

  const windowed = await openViewer('/large.txt');
  const disabledCopy = windowed.getByRole('button', { name: 'Full-file copy is unavailable for paged Source' });
  await disabledCopy.waitFor();
  assert.equal(await disabledCopy.isDisabled(), true);
  await windowed.getByText('window page', { exact: true }).waitFor();
  assert.equal(await windowed.evaluate(() => window.__testHost.requests.filter(request => request.method === 'remux/fs/readFileWindow').length), 1);
  await windowed.close();

  const longLineStarted = performance.now();
  const longLine = await openViewer('/long.txt');
  await longLine.locator('.cm-content').waitFor();
  assert.equal(await longLine.getByRole('button', { name: 'Diff is unavailable for large files or long lines.' }).isDisabled(), true);
  assert.ok(await longLine.locator('.cm-content').evaluate(element => element.textContent.length) < 100_000,
    'a multi-megabyte source line must not become a multi-megabyte DOM text node');
  console.log(JSON.stringify({exactFiveMiBSourceReadyMs: Math.round(performance.now() - longLineStarted)}));
  await longLine.close();

  const largeMarkdown = await openViewer('/large.md');
  await largeMarkdown.getByText('This document is too large to preview').waitFor();
  assert.equal(await largeMarkdown.locator('.remux-editor-empty-card').getByRole('button', { name: 'Show source' }).count(), 1);
  await largeMarkdown.close();

  const rendererChunks = new Set();
  const image = await openViewer('/pixel.png');
  const img = image.locator('.remux-editor-image-stage img');
  await image.getByText(/pixel.png \/ .* \/ 64×32/u).waitFor();
  assert.equal(await img.evaluate(element => element.naturalWidth), 64);
  await assertOpenTraffic(image, '/pixel.png', 0);
  await img.click({ position: { x: 20, y: 20 } });
  assert.equal(await image.locator('.remux-editor-image-zoomed').count(), 1);
  const scale = await img.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
  const width = await image.locator('.remux-editor-image-stage').evaluate(element => element.clientWidth);
  assert.ok(Math.abs(scale * width - 64) < 0.1, 'tap must display natural size');
  await image.locator('.remux-editor-image-stage').click({ position: { x: 20, y: 20 } });
  assert.equal(await image.locator('.remux-editor-image-zoomed').count(), 0);
  // Two pointers pinch; lifting one must allow dragging without a tap reset.
  const imageCdp = await image.context().newCDPSession(image);
  await imageCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 100, id: 1 }, { x: 200, y: 100, id: 2 }] });
  await imageCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 100, y: 100, id: 1 }, { x: 300, y: 100, id: 2 }] });
  await imageCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: 100, y: 100, id: 1 }] });
  await imageCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 120, y: 130, id: 1 }] });
  await imageCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await image.locator('.remux-editor-image-zoomed').count(), 1);
  assert.equal(await img.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a), 2);
  await img.evaluate(element => { window.__retainedImage = element; });
  const beforeReload = rawRequests.filter(request => request.path === '/pixel.png').length;
  await image.getByRole('button', { name: 'Reload file' }).click();
  await image.waitForFunction(() => window.__testHost.requests.filter(request => request.method === 'remux/fs/stat').length === 2);
  assert.equal(await img.evaluate(element => element === window.__retainedImage), true);
  assert.equal(rawRequests.filter(request => request.path === '/pixel.png').length, beforeReload, 'unchanged reload must not refetch image');
  await image.evaluate(() => { window.__testHost.version = 'fixture-v2'; });
  await image.getByRole('button', { name: 'Reload file' }).click();
  await image.waitForFunction(() => document.querySelector('.remux-editor-image-stage img')?.getAttribute('src')?.endsWith('&v=fixture-v2'));
  assert.equal(await img.evaluate(element => element === window.__retainedImage), false);
  const chunks = await image.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /Renderer-.*\.js$/u.test(name)));
  assert.equal(chunks.some(name => name.includes('ImageRenderer-')), true);
  assert.equal(chunks.some(name => /SourceRenderer|MarkdownRenderer|HtmlRenderer/u.test(name)), false, 'image open must not fetch text renderers');
  chunks.forEach(name => rendererChunks.add(new URL(name).pathname.split('/').at(-1)));
  await image.close();

  failNextImage = true;
  const retryImage = await openViewer('/pixel.png');
  await retryImage.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  await retryImage.getByRole('button', { name: 'Retry', exact: true }).click();
  await retryImage.getByText(/pixel.png \/ .* \/ 64×32/u).waitFor();
  assert.equal(await readCount(retryImage), 0);
  await retryImage.close();

  const svg = await openViewer('/pixel.svg');
  await svg.getByText(/pixel.svg \/ .* \/ 120×40/u).waitFor();
  assert.equal(await svg.locator('.remux-editor-image-stage svg').count(), 0);
  assert.equal(await svg.evaluate(() => window.__unsafeSvg), undefined);
  await assertOpenTraffic(svg, '/pixel.svg', 0);
  await svg.close();

  const pdf = await openViewer('/minimal.pdf');
  const pdfFrame = pdf.locator('iframe[title="minimal.pdf"]');
  await pdfFrame.waitFor();
  assert.equal(await pdfFrame.getAttribute('src'), '/remux/fs/raw?path=%2Fminimal.pdf&v=fixture-v1');
  assert.equal(await pdfFrame.getAttribute('srcdoc'), null);
  assert.equal(await pdfFrame.getAttribute('sandbox'), null);
  await pdf.waitForLoadState('networkidle');
  assert.equal(rawRequests.some(request => request.path === '/minimal.pdf'), true, 'frame policy must allow the raw PDF request');
  await assertOpenTraffic(pdf, '/minimal.pdf', 0);
  await pdf.close();

  const androidPdf = await openViewer('/minimal.pdf', null, { userAgent: 'Mozilla/5.0 (Linux; Android 14)' });
  await androidPdf.getByText('This file cannot be previewed.').waitFor();
  assert.equal(await androidPdf.locator('iframe').count(), 0);
  await androidPdf.close();

  const video = await openViewer('/tiny.webm');
  await video.locator('video[controls][playsinline][preload="metadata"]').waitFor();
  await video.waitForFunction(() => document.querySelector('video')?.videoWidth === 32);
  assert.equal(await video.locator('video').getAttribute('src'), '/remux/fs/raw?path=%2Ftiny.webm&v=fixture-v1');
  await assertOpenTraffic(video, '/tiny.webm', 0);
  await video.close();

  const binary = await openViewer('/random.bin');
  await binary.getByText('This file cannot be previewed.').waitFor();
  const disabledDownload = binary.getByRole('button', { name: 'Update the app to download files' });
  assert.equal(await disabledDownload.count(), 2, 'toolbar and primary Download are mirrored');
  for (const button of await disabledDownload.all()) assert.equal(await button.isDisabled(), true);
  await assertOpenTraffic(binary, '/random.bin', 0);
  assert.equal(rawRequests.some(request => request.path === '/random.bin'), false);
  await binary.close();

  const downloadable = await openViewer('/random.bin', null, {}, true);
  const primaryDownload = downloadable.locator('.remux-editor-binary').getByRole('button', { name: 'Download file' });
  await primaryDownload.waitFor();
  assert.equal(await primaryDownload.isEnabled(), true);
  await primaryDownload.click();
  await downloadable.waitForFunction(() => window.__testHost.requests.some(request => request.method === 'host/file/download' && request.params.path === '/random.bin'));
  await downloadable.evaluate(() => { window.__testHost.downloadReason = 'fixture download failed'; });
  await downloadable.locator('.remux-extension-action-bar').getByRole('button', { name: 'Download file' }).click();
  await downloadable.getByText('fixture download failed', { exact: true }).waitFor();
  await downloadable.close();
  console.log(JSON.stringify({ builtViewerChunks: true, lazyImageChunk: [...rendererChunks],
    imageNaturalDimensions: true, imageTapPinchDrag: true, mediaReloadWithoutFlash: true, imageRetry: true,
    svgImgOnly: true, rawPdfFrame: true, androidPdfFallback: true, videoMetadata: true, binaryFallback: true,
    downloadCapabilityAndCommand: true, downloadFailureStatus: true, oneStatAtMostOneReadPerOpen: true }));

  console.log(JSON.stringify({
    copyOriginal: true,
    defaultHtmlAndMarkdownPreview: true,
    failedReloadRetains: true,
    htmlStateRetainedOnToggle: true,
    lineFocus: true,
    markdownParityAndResponsiveLayout: true,
    mermaidHelper,
    markdownPreviewBudget: true,
    markdownScrolling: true,
    noToggleReread: true,
    sameByteReloadResetsHtml: true,
    toolbarOrderAndPressed: true,
    windowedCopyDisabled: true,
  }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
  await helperServer.close();
}
