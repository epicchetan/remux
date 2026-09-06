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

async function openViewer(path, line = null) {
  const page = await browser.newPage();
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

try {
  const markdown = await openViewer('/doc.md');
  await markdown.getByRole('heading', { name: 'Heading' }).waitFor();
  assert.equal(await markdown.locator('table').getByText('42').count(), 1);
  assert.equal(await markdown.locator('input[type="checkbox"]:checked').count(), 1);
  assert.equal(await markdown.getByText('Footnote detail.').count(), 1);
  assert.equal(await markdown.locator('.katex').count() > 0, true);
  await markdown.locator('.remux-viewer-markdown-mermaid-diagram svg').waitFor();
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
    markdownPreviewBudget: true,
    noToggleReread: true,
    sameByteReloadResetsHtml: true,
    toolbarOrderAndPressed: true,
    windowedCopyDisabled: true,
  }));
} finally {
  await browser.close();
  await server.close();
}
