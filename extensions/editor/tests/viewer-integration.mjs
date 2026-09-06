import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createProtectedViewerBootstrapScript } from '../../../app/src/surfaces/viewer/protectedViewerTransport.ts';

const server = await createServer({
  configFile: new URL('../viewer/vite.config.ts', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const browser = await chromium.launch();
const baseUrl = server.resolvedUrls.local[0];
const token = 'b'.repeat(64);
const mermaidModuleUrl = new URL(`/@fs${new URL('../../../packages/viewer-kit/src/mermaid.ts', import.meta.url).pathname}`, baseUrl).href;

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

async function openViewer(path, line = null, pageOptions = {}) {
  const page = await browser.newPage(pageOptions);
  await page.addInitScript(({ token }) => {
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
      if (message.method === 'remux/fs/readFile') {
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
  }, { token });
  await page.addInitScript({ content: createProtectedViewerBootstrapScript(token) });
  await page.goto(viewerUrl(path, line));
  return page;
}

function readCount(page, path = null) {
  return page.evaluate(path => window.__testHost.requests.filter(request =>
    request.method === 'remux/fs/readFile' && (path === null || request.params.path === path)).length, path);
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
  await mkdir('/tmp/remux-html-preview', { recursive: true });
  await markdown.screenshot({ fullPage: true, path: '/tmp/remux-html-preview/unified-markdown-phone.png' });
  const footnoteLink = markdown.locator('a[href="#user-content-fn-proof"]');
  await footnoteLink.click();
  assert.equal(await markdown.evaluate(() => Boolean(document.getElementById(decodeURIComponent(location.hash.slice(1))))), true,
    'footnote navigation must resolve the sanitized destination ID');
  const leftLabels = await markdown.locator('.remux-extension-action-group').first().getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  assert.deepEqual(leftLabels.slice(0, 4), ['Open tabs', 'Reload file', 'Show source', 'Copy file contents']);
  const markdownEye = markdown.getByRole('button', { name: 'Show source' });
  assert.equal(await markdownEye.getAttribute('aria-pressed'), 'true');
  assert.equal(await readCount(markdown, '/doc.md'), 1);
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
  await focused.close();

  const windowed = await openViewer('/large.txt');
  const disabledCopy = windowed.getByRole('button', { name: 'Full-file copy is unavailable for paged Source' });
  await disabledCopy.waitFor();
  assert.equal(await disabledCopy.isDisabled(), true);
  assert.equal(await windowed.getByText('window page').count() > 0, true);
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
  await server.close();
}
